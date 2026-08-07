// 1日1枚のログインボーナス(ガチャチケット)を確かめる。
//
// 見るのは
//   ・初めて開いた日に1枚もらえるか
//   ・同じ日に何度開いても増えないか
//   ・日付が変わったらまた1枚もらえるか
//   ・上のバーに枚数が出ているか
//   ・引き継ぎに枚数が載るか(端末を変えても持ち越せるか)
//
//   npx tsx test/daily_bonus_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9479;

const NAME = `db${Math.random().toString(36).slice(2, 6)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      const fn = this.waiting.get(m.id);
      if (fn) { this.waiting.delete(m.id); fn(m); }
    };
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise(res => {
      this.waiting.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }

  close(): void { this.ws.close(); }
}

// lastBonusDate を指定して仕込む。'' なら「まだ一度ももらっていない」。
function seedSave(lastBonusDate: string, tickets: number) {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
    bossRewarded: [], tickets, lastBonusDate,
  };
}

const saved = () => `
  (() => {
    const s = JSON.parse(localStorage.getItem('magic_web_game_save_v1') || '{}');
    return { tickets: s.tickets, date: s.lastBonusDate,
             shown: document.querySelector('#ticket-display')?.textContent ?? '' };
  })()
`;

interface Got { tickets: number; date: string; shown: string }

async function main(): Promise<void> {
  console.log('=== 1日1枚のログインボーナス ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-db-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  try {
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl) { check('ブラウザの起動', false); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    let seeded: any = null;
    const openWith = async (date: string, tickets: number) => {
      if (seeded) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument',
          { identifier: seeded.result?.identifier });
      }
      seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try {
          localStorage.setItem('magic_web_game_save_v1',
            ${JSON.stringify(JSON.stringify(seedSave(date, tickets)))});
          localStorage.setItem('madoken_sound_v4',
            JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        } catch {}`,
      });
      await cdp.send('Page.navigate', { url: HTTP });
      // readyState だけを見てはいけない。about:blank も「complete」なので、
      // 移動が始まる前に抜けてしまい、前の頁のまま測ることになる
      // (localStorage が読めず「Access is denied」で落ちた)。
      for (let i = 0; i < 60; i++) {
        const here = await cdp.evaluate<string>('location.href');
        if (here && !here.startsWith('about:')
          && await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
        await sleep(250);
      }
      await sleep(3500);
    };

    // ---- 1. まだ一度ももらっていない ----
    await openWith('', 0);
    let g = await cdp.evaluate<Got>(saved());
    check('★初めて開いた日に1枚もらえる', g.tickets === 1, `${g.tickets}枚`);
    check('もらった日が記録される', /^\d{4}-\d{2}-\d{2}$/.test(g.date ?? ''), g.date);
    check('★上のバーに枚数が出る', g.shown.includes('1'), g.shown);
    const today = g.date;

    // ---- 2. 同じ日に開き直しても増えない ----
    await openWith(today, 1);
    g = await cdp.evaluate<Got>(saved());
    check('★同じ日は何度開いても増えない', g.tickets === 1, `${g.tickets}枚`);

    // ---- 3. 日付が変わっていればまたもらえる ----
    await openWith('2000-01-01', 5);
    g = await cdp.evaluate<Got>(saved());
    check('★日付が変わればまた1枚もらえる', g.tickets === 6, `${g.tickets}枚`);
    check('日付が今日に更新される', g.date === today, g.date);
    check('バーの表示も追従する', g.shown.includes('6'), g.shown);

    // ---- 4. 引き継ぎに載っているか ----
    const inCloud = await cdp.evaluate<boolean>(`
      (() => {
        const s = JSON.parse(localStorage.getItem('magic_web_game_save_v1') || '{}');
        return typeof s.tickets === 'number' && typeof s.lastBonusDate === 'string';
      })()
    `);
    check('セーブに枚数と日付が入っている', inCloud);
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    try {
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, token: `tok_${NAME}` }),
      });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(400);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

// ボスのステージの部屋を直接作った時、出撃準備から戦闘までずっと
// ボスの曲が鳴り続けるかを確かめる。
//
// 報告: 「出撃準備画面だけ反映している」
// 部屋に入った時と、戦闘が始まったあとで、別の場所が曲を決めている。
// どちらかが取り残されていると、開戦した瞬間に曲が戻ってしまう。
//
// 見るのは
//   ・出撃準備の画面で何の曲を読むか
//   ・開戦したあと、曲が差し替わっていないか
//
//   npx tsx test/boss_bgm_room_check.ts
//   MADOKEN_ENDPOINT=https://madoken.onrender.com npx tsx test/boss_bgm_room_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9441;
const STAGE = 5;

const NAME = `br${Math.random().toString(36).slice(2, 6)}`;

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
  // いつ・何の曲を読みに行ったか
  readonly bgm: { t: number; name: string }[] = [];
  private t0 = Date.now();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const fn = this.waiting.get(m.id);
        if (fn) { this.waiting.delete(m.id); fn(m); }
        return;
      }
      if (m.method === 'Network.requestWillBeSent') {
        const u = String(m.params?.request?.url ?? '');
        const hit = /\/sound\/bgm\/([\w.-]+?)\.mp3/.exec(u);
        if (hit && this.bgm[this.bgm.length - 1]?.name !== hit[1]) {
          this.bgm.push({ t: (Date.now() - this.t0) / 1000, name: hit[1] });
        }
      }
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

  async click(sel: string): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        const r = e.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(400);
    return true;
  }

  close(): void { this.ws.close(); }
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { water: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 3, maxStage: STAGE, bestStage: STAGE - 1,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

// BGMは new Audio() で作った要素で鳴らしていて、DOMには入っていない。
// そのため画面から探しても見つからない。何が鳴っているかは
// 通信の記録(どのファイルを読みに行ったか)で判断する。

async function main(): Promise<void> {
  console.log('=== ボス部屋の曲(出撃準備 → 戦闘) ===');
  console.log(`対象: ${HTTP} / ステージ${STAGE}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-br-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
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
    await cdp.send('Network.enable');

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v3',
          JSON.stringify({ bgmVolume: 0.05, sfxVolume: 0, muted: false }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(3000);

    await cdp.click('#tab-online');
    await sleep(2500);
    // ステージ5を選ぶ
    await cdp.evaluate(`
      (() => {
        const s = document.querySelector('#coop-stage');
        s.value = '${STAGE}';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(600);
    check('部屋を作れた', await cdp.click('#btn-create-room'));
    await sleep(3000);

    const prep = cdp.bgm[cdp.bgm.length - 1]?.name ?? 'なし';
    console.log(`     出撃準備で最後に読んだ曲: ${prep}`);
    check('★出撃準備でボスの曲になっている', prep.startsWith('5-10_'), prep);

    const beforeFight = cdp.bgm.length;
    check('準備完了を押せた', await cdp.click('#btn-coop-ready'));
    // カウントダウン(3.6秒)を越えて、戦闘が始まってからしばらく見る
    await sleep(12_000);

    const phase = await cdp.evaluate<string>(
      'document.querySelector("#coop-waiting")?.classList.contains("hidden") ? "戦闘中" : "準備中"');
    check('戦闘が始まっている', phase === '戦闘中', phase);

    console.log(`     読みに行った順: ${cdp.bgm.map(b => `${b.t.toFixed(1)}秒:${b.name}`).join(' → ')}`);
    const after = cdp.bgm.slice(beforeFight);
    // 開戦後に別の曲へ差し替えていないこと(差し替えが無い=そのまま鳴り続けている)
    check('★開戦してもボスの曲のまま',
      after.every(b => b.name.startsWith('5-10_')),
      after.length === 0 ? '差し替えなし' : after.map(b => b.name).join(' → '));
    check('最後に鳴らしているのはボスの曲',
      (cdp.bgm[cdp.bgm.length - 1]?.name ?? '').startsWith('5-10_'),
      cdp.bgm.map(b => b.name).join(' → '));
    // ステージ番号が届く前に「ボスではない」と判断すると、通常戦闘の曲を
    // 一瞬だけ鳴らしてしまう。鳴らし始めと差し替えが重なると
    // ブラウザに再生を中断され、そのまま無音で戦うことがある。
    check('★通常戦闘の曲を一瞬も挟まない',
      !cdp.bgm.some(b => b.name === 'battle'),
      cdp.bgm.map(b => b.name).join(' → '));
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

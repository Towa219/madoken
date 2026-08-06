// 新しい絵とポーズが戦闘画面でどう見えるかを撮る(目視確認用。合否は出さない)。
//
// ソロ戦闘を始めて、待機 → 詠唱中 → 撃った直後 を続けて撮る。
// 一覧の絵では分からない「実際の大きさ・立ち位置・重なり」を確かめる。
//
//   npx tsx test/pose_shot.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9467;
const OUT = join(process.cwd(), 'tools', 'shots');

const NAME = `ps${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  readonly logs: string[] = [];

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
      if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params?.args ?? []).map((a: any) => String(a?.value ?? '')).join(' ');
        if (t) this.logs.push(t);
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

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const data = r.result?.data;
    if (!data) { console.log(`  (${name} は撮れなかった)`); return; }
    const path = join(OUT, `${name}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log(`  撮影: tools/shots/${name}.png`);
  }

  close(): void { this.ws.close(); }
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    // 詠唱の長い魔法。詠唱中の姿を撮る余裕を作る
    spells: [{
      id: 's1', name: '', recipe: { fire: 2, earth: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 4, bestStage: 3,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 戦闘画面のポーズを撮る ===');
  mkdirSync(OUT, { recursive: true });

  const profile = mkdtempSync(join(tmpdir(), 'madoken-ps-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1000,760', 'about:blank',
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
    if (!wsUrl) { console.log('  ブラウザを起動できなかった'); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);

    const loaded = cdp.logs.filter(l => l.includes('[素材]'));
    for (const l of loaded) console.log(`  ${l}`);

    await cdp.evaluate('document.querySelector("#tab-battle").click()');
    await sleep(1200);
    // ステージ4(敵が複数出る)を選ぶ
    await cdp.evaluate(`
      (() => {
        const bs = [...document.querySelectorAll('#stage-select button')];
        const b = bs.find(x => x.textContent.trim() === '4') ?? bs[bs.length - 1];
        b.click();
      })()
    `);
    await sleep(2500);
    await cdp.shot('pose_1_待機');

    // 魔法を撃つ(詠唱の途中と、撃った直後を撮る)
    await cdp.evaluate(`document.querySelector('#spell-bar .spell-btn')?.click()`);
    await sleep(500);
    await cdp.shot('pose_2_詠唱中');
    await sleep(1800);
    await cdp.shot('pose_3_発射と被弾');
    await sleep(4000);
    await cdp.shot('pose_4_乱戦');
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
    } catch { /* 消せなくても問題ない */ }
  }
  console.log('=== 撮影おわり ===');
  process.exit(0);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

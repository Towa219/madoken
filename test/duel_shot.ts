// 決闘の画面を撮る(目視確認用。合否は出さない)。
//
// 右側(slot1)のキャラがちゃんと左を向いて向かい合っているかを確かめる。
// 絵は全員右向きに描いてあるので、右側だけは入れ物ごと左右反転させている
// (src/duel.ts の sprite.scale.x = -1)。ポーズで絵を差し替えても
// 反転が外れないことも、ここで一緒に見える。
//
// ブラウザが1人、対戦相手は通信だけの相手(colyseus)で埋める。
//
//   npx tsx test/duel_shot.ts

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const WS = BASE.replace(/^http/, 'ws');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9477;
const OUT = join(process.cwd(), 'tools', 'shots');

const RUN = Math.random().toString(36).slice(2, 6);
const ME = `dm${RUN}`;
const FOE = `df${RUN}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const KIT = [{ name: '魔弾', recipe: { fire: 2 }, level: 0, rarity: 'normal' }];

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

  async shot(name: string, clip?: unknown): Promise<void> {
    const r = await this.send('Page.captureScreenshot',
      clip ? { format: 'png', clip } : { format: 'png' });
    if (!r.result?.data) { console.log(`  (${name} は撮れなかった)`); return; }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`  撮影: tools/shots/${name}.png`);
  }

  close(): void { this.ws.close(); }
}

function seedSave() {
  return {
    version: 1, nickname: ME, nickToken: `tok_${ME}`, charId: 2, researchP: 100,
    inventory: {},
    spells: [{
      id: 's1', name: '', recipe: { fire: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 2, maxStage: 3, bestStage: 2,
    bossRewarded: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 決闘の画面を撮る(右側が左を向いているか) ===');
  const profile = mkdtempSync(join(tmpdir(), 'madoken-ds-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,820', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  let foe: Room | null = null;
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
    await sleep(4500);

    await cdp.evaluate("document.querySelector('#tab-battle').click()");
    await sleep(2000);
    await cdp.evaluate("document.querySelector('#btn-duel').click()");
    await sleep(2500);

    // 相手を1人入れる(通信だけの相手。キャラは別のものにして見分ける)
    foe = await new Client(WS).joinOrCreate('duel', {
      name: FOE, spells: KIT, nickToken: `tok${FOE}`, charId: 4,
    });
    for (const t of ['dproj', 'dhit', 'dresult', 'dwait', 'dback', 'dseal',
      'dshieldhit', 'dshieldup', 'dheal', 'dward', 'ddot', 'joined']) {
      foe.onMessage(t, () => { /* 表示用 */ });
    }
    await sleep(1500);
    foe.send('ready');
    await cdp.evaluate(
      "document.querySelector('#btn-duel-ready')?.click()");
    await sleep(6000);   // カウントダウンを越える

    // 先に画面へ入れてから測る(測ってから動かすとずれた所を撮ってしまう)
    await cdp.evaluate("document.querySelector('#duel-canvas canvas')?.scrollIntoView({block:'center'})");
    await sleep(600);
    const clip = await cdp.evaluate<unknown>(`
      (() => {
        const host = document.querySelector('#duel-canvas');
        const cv = host && host.querySelector('canvas');
        if (!cv) return null;
        // 下半分が画面の外に出ていると、そこだけ黒く撮れる
        const r = cv.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
      })()
    `);
    await sleep(500);
    await cdp.shot('duel_facing', clip ?? undefined);
  } finally {
    try { void foe?.leave(); } catch { /* 切断済み */ }
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
    for (const n of [ME, FOE]) {
      try {
        await fetch(`${HTTP}/api/name/release`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: n, token: `tok_${n}` }),
        });
        await fetch(`${HTTP}/api/name/release`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: n, token: `tok${n}` }),
        });
      } catch { /* 消せなくても問題ない */ }
    }
  }
  console.log('=== 撮影おわり ===');
  process.exit(0);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

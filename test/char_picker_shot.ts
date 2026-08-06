// キャラクター選択画面を撮る(目視確認用。合否は出さない)。
//
// 5人を横に並べて見比べる唯一の画面なので、頭の大きさや向きの食い違いは
// ここで一番目につく。戦闘画面と同じ表示倍率が効いているかもここで分かる。
//
//   npx tsx test/char_picker_shot.ts

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9475;
const OUT = join(process.cwd(), 'tools', 'shots');

const NAME = `cp${Math.random().toString(36).slice(2, 6)}`;
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
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossRewarded: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== キャラクター選択画面を撮る ===');
  const profile = mkdtempSync(join(tmpdir(), 'madoken-cp-'));
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

    await cdp.evaluate("document.querySelector('#tab-settings').click()");
    await sleep(1200);
    const clip = await cdp.evaluate<unknown>(`
      (() => {
        const e = document.querySelector('#char-picker');
        if (!e) return null;
        e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect();
        return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16, scale: 2 };
      })()
    `);
    await sleep(500);
    await cdp.shot('char_picker', clip ?? undefined);
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

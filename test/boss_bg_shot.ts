// ステージごとの戦闘背景が実画面でどう見えるかを撮る(目視確認用)。
//
// ボス面(共闘専用)の背景を撮る。部屋を作って1人で始める。
// 背景だけ並べても分からない「キャラと敵が読めるか」を確かめる。
//
//   npx tsx test/boss_bg_shot.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9473;
const OUT = join(process.cwd(), 'tools', 'shots');

const NAME = `bb${Math.random().toString(36).slice(2, 6)}`;
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
    discovered: [], slots: 4, maxStage: 50, bestStage: 50,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}



// 撮るボスステージ。段階の切り替わりが分かるように選ぶ。
const TARGETS: [number, string][] = [
  [5, 'B1_ボス5'], [20, 'B4_ボス20'], [50, 'B10_ボス50'],
];

async function main(): Promise<void> {
  console.log('=== ボス面(共闘)の背景を撮る ===');
  mkdirSync(OUT, { recursive: true });

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bb-'));
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

    for (const [stage, label] of TARGETS) {
      await cdp.evaluate('document.querySelector("#tab-battle").click()');
      await sleep(900);
      const diag = await cdp.evaluate<string>(`
        (() => {
          const bs = [...document.querySelectorAll('#stage-select button')];
          if (bs.length === 0) return 'ボタンが1つも無い';
          const b = bs.find(x => (x.textContent || '').trim().split(' ')[0] === '${stage}');
          if (!b) return '数=' + bs.length + ' 見本=' + JSON.stringify(bs.slice(3,6).map(y=>y.textContent));
          b.click(); return 'OK';
        })()
      `);
      const picked = diag === 'OK';
      if (!picked) console.log('  診断: ' + diag);
      if (!picked) { console.log(`  ステージ${stage} を選べない(飛ばす)`); continue; }
      await sleep(500);
      // ボス戦は共闘部屋から。1人でも始められる。
      await cdp.evaluate("document.querySelector('#btn-create-room').click()");
      await sleep(3000);
      // 部屋の「開始」を押す
      await cdp.evaluate(`
        (() => {
          const b = [...document.querySelectorAll('button')]
            .find(x => /開始|はじめ|スタート|出撃/.test(x.textContent || '')
                       && !(x as HTMLButtonElement).disabled);
          if (b) (b as HTMLElement).click();
        })()
      `);
      await sleep(6000);      // 3→2→1 の合図を待つ
      await cdp.shot(`boss_${label}`);
      console.log(`  撮った: ${label}`);
      // 部屋を出て次へ
      await cdp.evaluate(`
        (() => {
          const b = [...document.querySelectorAll('button')]
            .find(x => /退出|抜け|やめ|閉じ|戻/.test(x.textContent || ''));
          if (b) (b as HTMLElement).click();
        })()
      `);
      await sleep(2500);
    }
    console.log('\n出力先: ' + OUT);
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
}

void main();

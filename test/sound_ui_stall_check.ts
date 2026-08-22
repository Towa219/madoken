// 音の素材(manifest.json)の読み込みが返ってこない時でも、
// 音量つまみが効いて保存されるかを確かめる。
//
//   npm run dev            … 先に開発サーバーを起こす
//   npx tsx test/sound_ui_stall_check.ts
//
// ★ なぜ要るか(2026-08-21)。
//   「音量が保存されない。バージョンが上がったあと」という指摘。
//   版が上がった直後は Render が起動し直した後で、いちばん重い
//   (無料プランはスリープから起きるのに数十秒かかる)。
//
//   src/main.ts は
//     void initSound().then(() => { initSoundUI(); ... });
//   と書いてあり、つまみに操作を結び付ける initSoundUI() が
//   「音の素材を読み終わるまで」呼ばれない。
//   読み込みが返ってこないと listener が付かないままになり、
//   つまみは動くのに何も保存されない ― まさに指摘どおりの症状になる。
//
//   fetch が失敗する(拒否される)分には try/catch が拾って先へ進む。
//   問題は「返事が来ない」場合で、これは待ち続けてしまう。
//   ここでは CDP で manifest.json の要求を止めたまま再現する。

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9498;
const PREF_KEY = 'madoken_sound_v4';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let 失敗数 = 0;
function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  // 止めっぱなしにする要求は、イベントで飛んでくるので受け皿が要る
  onEvent: ((method: string, params: any) => void) | null = null;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id === undefined) { this.onEvent?.(m.method, m.params); return; }
      const fn = this.waiting.get(m.id);
      if (fn) { this.waiting.delete(m.id); fn(m); }
    };
  }
  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise(res => { this.waiting.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }
  close(): void { this.ws.close(); }
}

function seedSave(名: string) {
  return {
    version: 1, nickname: 名, nickToken: `tok_${名}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [],
    discovered: [], slots: 2, maxStage: 1, bestStage: 0,
    bossRewarded: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 音の素材が返ってこない時でも音量つまみが効くか ===');
  const 名 = `停${Math.random().toString(36).slice(2, 6)}`;
  const profile = mkdtempSync(join(tmpdir(), 'madoken-stall-'));
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
    if (!wsUrl) { console.error('  ブラウザを起動できなかった'); process.exit(1); }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // manifest.json だけ、掴んだまま返さない。それ以外は素通しする。
    let 止めた = 0;
    cdp.onEvent = (method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const u = String(params?.request?.url ?? '');
      if (u.includes('sound/manifest.json')) { 止めた += 1; return; } // 握ったまま
      void cdp.send('Fetch.continueRequest', { requestId: params.requestId });
    };
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave(名)))});
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(9000);   // 読み終わるだけ待つ(manifest は返らないまま)

    確認(止めた > 0, '音の素材の読み込みを止められた', `${止めた}件を保留中`);

    await cdp.evaluate("(() => { const e = document.querySelector('#tab-settings'); if (e) e.click(); return true; })()");
    await sleep(900);

    const つまみがある = await cdp.evaluate<boolean>(
      "!!document.querySelector('#bgm-volume') && !!document.querySelector('#sfx-volume')");
    確認(つまみがある, '設定タブに音量つまみが出ている');

    // 人がつまみを動かした時と同じ形で動かす
    await cdp.evaluate(`(() => {
      for (const [id, v] of [['#bgm-volume', 55], ['#sfx-volume', 70]]) {
        const el = document.querySelector(id);
        if (!el) continue;
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`);
    await sleep(600);

    const 保存 = await cdp.evaluate<{ bgmVolume?: number; sfxVolume?: number } | null>(`(() => {
      const raw = localStorage.getItem('${PREF_KEY}');
      return raw ? JSON.parse(raw) : null;
    })()`);

    確認(保存 !== null,
      '素材が読めていなくても音量が保存される',
      保存 ? JSON.stringify(保存) : '(何も保存されていない ← つまみに操作が結び付いていない)');
    確認(Math.round((保存?.bgmVolume ?? -1) * 100) === 55,
      'BGMの値が保存されている', `保存値 ${保存?.bgmVolume}`);
    確認(Math.round((保存?.sfxVolume ?? -1) * 100) === 70,
      '効果音の値が保存されている', `保存値 ${保存?.sfxVolume}`);
  } finally {
    try { await cdp.send('Browser.close'); } catch { /* もう閉じている */ }
    cdp.close();
    await sleep(1200);
    chrome.kill();
  }

  console.log('');
  if (失敗数 === 0) {
    console.log('すべて合格。素材の読み込みに関係なく音量つまみは効く。');
  } else {
    console.error(`${失敗数}件 失敗。素材が読めない間、音量を変えても保存されない。`);
    process.exit(1);
  }
}

void main();

// トーストが出ている間に、タブが押せなくなっていないかを実ブラウザで確かめる。
//
//   npm run dev            … 先に開発サーバーを起こす
//   npx tsx test/toast_blocking_check.ts
//
// ★ なぜ要るか(2026-08-22)。
//   test/boss_reward_check.ts の「図鑑の案内が討伐済みに変わる」が
//   ずっと落ちていた。テストが古いのだろうと思って調べたら逆で、
//   実装の側に本物の不具合があった。
//
//   トーストは画面の上に固定で出る。文が長いと縦に伸びるため、
//   👑の討伐の知らせ(長文)では y60〜136 まで広がり、
//   y101〜135 にあるタブの列を丸ごと覆っていた。
//   pointer-events の指定が無かったので、クリックはトーストに吸われる。
//   押した人には「タブが反応しない」としか見えない ―
//   しかも 3.2秒 経つと直るので、原因に辿り着きにくい。
//
// ★ 位置や高さで避けようとしないこと。文の長さと画面の幅で変わるので、
//   いつか必ずまた重なる。当たり判定を外してあるかどうかを見る。

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9501;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 覆われやすいのは真ん中〜右のタブ。左端の研究室だけ見ても意味がない。
const タブ = ['#tab-lab', '#tab-battle', '#tab-shop', '#tab-book', '#tab-manual', '#tab-settings'];

let 失敗数 = 0;
function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

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
    return new Promise(res => { this.waiting.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value as T;
  }
  close(): void { this.ws.close(); }
}

function seedSave(名: string) {
  return {
    version: 1, nickname: 名, nickToken: `tok_${名}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [], discovered: [], slots: 2,
    maxStage: 1, bestStage: 0, bossRewarded: [], bossCleared: [],
    sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== トーストがタブを塞いでいないか ===');
  const 名 = `帯${Math.random().toString(36).slice(2, 6)}`;
  const profile = mkdtempSync(join(tmpdir(), 'madoken-toast-'));
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
    if (!wsUrl) { console.error('  ブラウザを起動できなかった'); process.exit(1); }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('magic_web_game_save_v1',${JSON.stringify(JSON.stringify(seedSave(名)))})}catch{}`,
    });
    await cdp.send('Page.navigate', { url: PAGE });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);

    // いちばん長くなる知らせを出す(討伐の知らせ+レジェンドの真名)
    await cdp.evaluate(`(() => {
      const e = document.querySelector('#toast');
      e.textContent = '👑 ステージ50のボスを討伐! '
        + '【レジェンド】「シルフィード・サラマンド・インフィニート〈火水風2土〉」を授かった!';
      e.classList.remove('hidden');
      return true;
    })()`);
    await sleep(500);

    const 見え = await cdp.evaluate<boolean>(
      "!document.querySelector('#toast').classList.contains('hidden')");
    確認(見え, 'トーストが出ている(この状態で見ないと意味がない)');

    const 帯 = await cdp.evaluate<{ y: number; h: number }>(`(() => {
      const r = document.querySelector('#toast').getBoundingClientRect();
      return { y: Math.round(r.y), h: Math.round(r.height) };
    })()`);
    console.log(`  トーストの位置 y=${帯.y} 高さ=${帯.h}`);

    // ★ 本命。タブの真ん中を指した時に、タブ自身が拾えるか。
    for (const sel of タブ) {
      const 結果 = await cdp.evaluate<{ 上にあるもの: string; 重なり: boolean } | null>(`(() => {
        const el = document.querySelector('${sel}');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const t = document.querySelector('#toast').getBoundingClientRect();
        const 上 = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const 重なり = !(t.right < r.left || t.left > r.right || t.bottom < r.top || t.top > r.bottom);
        return { 上にあるもの: 上 ? (上.id || 上.className || 上.tagName) : 'なし', 重なり };
      })()`);
      if (!結果) { 確認(false, `${sel} が見つかる`); continue; }
      const 名前 = sel.replace('#tab-', '');
      const 通った = 結果.上にあるもの !== 'toast';
      確認(通った, `${名前} タブが押せる`,
        !通った ? 'トーストに覆われて押せない'
          : 結果.重なり ? `重なってはいるが当たり判定は抜けている(上=${結果.上にあるもの})`
            : `重なっていない(上=${結果.上にあるもの})`);
    }

    // ★ 当たり判定の話で終わらせず、本物のマウスで押して画面が変わるかを見る。
    //   boss_reward_check が落ちていたのは、まさにこの経路だった。
    const 座標 = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('#tab-book').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: 座標.x, y: 座標.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(800);
    const 開いた = await cdp.evaluate<boolean>(
      "!document.querySelector('#book-screen').classList.contains('hidden')");
    確認(開いた, 'トーストが出ていても、発見図鑑タブを本物のマウスで開ける',
      開いた ? '' : 'クリックがトーストに吸われている');
  } finally {
    try { await cdp.send('Browser.close'); } catch { /* 閉じ済み */ }
    cdp.close();
    await sleep(1000);
    chrome.kill();
  }

  console.log('');
  if (失敗数 === 0) console.log('すべて合格。トーストは操作を邪魔しない。');
  else { console.error(`${失敗数}件 失敗。出ている間タブが押せない。`); process.exit(1); }
}

void main();

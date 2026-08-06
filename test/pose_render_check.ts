// ポーズの絵が本当に画面で切り替わっているかを確かめる。
//
// サーバーがポーズを配っていることは pose_sync_check.ts で確かめている。
// ここで見るのは「配られたポーズで、実際に絵が差し替わるか」。
// 中の変数ではなく、描かれた画素そのものを比べる。
//
// 見るのは
//   ・待機と詠唱中で、キャラの見た目が変わるか
//   ・撃った直後にも別の見た目が現れるか
//   ・戦っていない時に勝手に変わらないか(比べ方が雑ではないことの裏取り)
//
//   npx tsx test/pose_render_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9469;

const NAME = `pr${Math.random().toString(36).slice(2, 6)}`;

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

  // 指定した矩形だけを撮って、8x8 の明るさの列にして返す
  async sample(clip: unknown): Promise<number[] | null> {
    const r = await this.send('Page.captureScreenshot',
      { format: 'png', clip, captureBeyondViewport: false });
    const data = r.result?.data;
    if (!data) return null;
    return await this.evaluate<number[]>(toGrid(`data:image/png;base64,${data}`));
  }

  close(): void { this.ws.close(); }
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    // 詠唱の長い魔法。詠唱中の姿を捉える余裕を作る
    spells: [{
      id: 's1', name: '', recipe: { fire: 2, earth: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 4, bestStage: 3,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

// キャラのいる場所の画素を読む。
//
// canvas から直接は読めない。PixiJS は描画バッファを毎フレーム捨てる設定
// (preserveDrawingBuffer: false)で動かしているため、あとから drawImage しても
// 中身は空になる(実際に全部 0 が返ってきた)。
// そこで画面の撮影を頼み、その画像を読み込み直して画素を数える。
//
// 画面全体を比べると背景の揺らぎ・弾・ダメージ表示まで拾ってしまうので、
// キャラの立っている矩形だけを撮る。返すのは 8x8 に間引いた明るさの列。

// 画面上でのキャラの矩形(描画は 960x540 の座標系。プレイヤーは x=140・地面 y=460)
const RECT = `
  (() => {
    const host = document.querySelector('#game-canvas');
    const cv = host && (host.tagName === 'CANVAS' ? host : host.querySelector('canvas'));
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const sx = r.width / 960, sy = r.height / 540;
    return {
      x: r.x + (140 - 60) * sx, y: r.y + (460 - 150) * sy,
      width: 120 * sx, height: 155 * sy, scale: 1,
    };
  })()
`;

function toGrid(dataUrl: string): string {
  return `
    (async () => {
      const im = new Image();
      im.src = ${JSON.stringify(dataUrl)};
      await im.decode();
      const t = document.createElement('canvas');
      t.width = 8; t.height = 8;
      const g = t.getContext('2d');
      g.drawImage(im, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data;
      const out = [];
      for (let i = 0; i < d.length; i += 4) {
        out.push(Math.round((d[i] + d[i + 1] + d[i + 2]) / 3));
      }
      return out;
    })()
  `;
}

// 2つの見た目がどれだけ違うか(0=同じ)
function diff(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i] - b[i]);
  return Math.round(s / Math.min(a.length, b.length));
}

async function main(): Promise<void> {
  console.log('=== ポーズの絵が画面で切り替わる ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-pr-'));
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
    if (!wsUrl) { check('ブラウザの起動', false); return; }
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
    await sleep(4500);   // ポーズの絵は後から読み込まれるので待つ

    await cdp.evaluate('document.querySelector("#tab-battle").click()');
    await sleep(1200);
    await cdp.evaluate(`
      (() => {
        const bs = [...document.querySelectorAll('#stage-select button')];
        (bs.find(x => x.textContent.trim() === '1') ?? bs[0]).click();
      })()
    `);
    await sleep(400);
    // 選ぶだけでは始まらないので「ソロで出撃」を押す
    await cdp.evaluate(`document.querySelector('#btn-solo-go').click()`);
    await sleep(4000);   // 開戦カウントが終わるまで

    const clip = await cdp.evaluate<unknown>(RECT);
    check('キャラの居る場所を特定できた', !!clip, JSON.stringify(clip));
    if (!clip) return;

    const idle = await cdp.sample(clip);
    check('キャラの居る所を読めた', !!idle && idle.length === 64,
      idle ? `${idle.length}点` : '読めなかった');
    if (!idle) return;

    // ---- 何もしないでいる間は、見た目が大きく変わらない ----
    //
    // これを見ないと「絵が変わった」判定が、単に画面の揺れを拾っただけかも
    // しれない。落ち着いている時の差を先に測って、物差しにする。
    let calm = 0;
    for (let i = 0; i < 8; i++) {
      await sleep(150);
      const s = await cdp.sample(clip);
      if (s) calm = Math.max(calm, diff(idle, s));
    }
    console.log(`     待っているだけの時の差: 最大 ${calm}`);

    // ---- 魔法を撃たせて、その間の見た目をずっと拾う ----
    //
    // 「今どのポーズか」を画面から言い当てるのは難しい(魔法ボタンは
    // 詠唱中も再使用待ちの間も灰色のまま)。そこで見た目の並びだけを集めて、
    //   ・待機と違う姿が出たか
    //   ・その中に互いに違う姿が2つ以上あったか(詠唱と発射・被弾)
    // を見る。何ポーズ出たかを数えれば、1枚しか使っていない状態と区別できる。
    await cdp.evaluate(`document.querySelector('#spell-bar .spell-btn')?.click()`);
    const moved: number[][] = [];
    let far = 0;
    const bar = Math.max(calm * 2, 6);
    for (let i = 0; i < 45; i++) {
      await sleep(60);
      const s = await cdp.sample(clip);
      if (!s) continue;
      const d = diff(idle, s);
      if (d > bar) {
        far = Math.max(far, d);
        moved.push(s);
      }
    }
    // 待機と違う姿どうしで、いちばん離れている組
    let apart = 0;
    for (let i = 0; i < moved.length; i++) {
      for (let j = i + 1; j < moved.length; j++) {
        apart = Math.max(apart, diff(moved[i], moved[j]));
      }
    }
    console.log(`     待機と違う姿: ${moved.length}回(最大の差 ${far})`
      + ` / その中での姿どうしの差: 最大 ${apart}`);

    check('★待機とは違う姿になる', far > bar,
      `差 ${far} / 待っているだけの時 ${calm}(基準 ${bar}超)`);
    check('★違う姿が2種類以上出る(詠唱と発射・被弾)', apart > bar,
      `姿どうしの差 ${apart}(基準 ${bar}超)`);
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

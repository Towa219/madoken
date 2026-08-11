// 孵化の場面が本当に描かれているかを、絵にして確かめる。
//
//   npm run dev   … 先に開発サーバーを起こしておく
//   npx tsx test/hatch_shot.ts
//
// 出来た絵は test/out/hatch_*.png に置く。
// 目で見るためだけではなく、各段階で「画面のどこが光っているか」を
// 数字でも測る ― 真っ暗なままなら演出が出ていない。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9489;
const OUT = join(process.cwd(), 'test', 'out');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 撮る時刻。演出が始まってから何ms の時点か(積み上げの待ち時間ではない)。
//
// ★ 相対の待ち時間で書くと、通信の往復ぶんだけ少しずつ後ろへずれて、
//   光の山を通り過ぎた後に撮ってしまう(実際にそうなった)。
//
// src/pet.ts の HATCH_MS = 揺れ1400 / ひび1200 / 光900 / 表示1100 に合わせる。
//   0    揺れ始め
//   1400 ひびが開き始める
//   2600 光が弾ける(山は 2900 あたり)
//   3500 鳥が出る
//   4600 命名欄が出る
const 場面: { 名: string; 時刻: number; 期待: string }[] = [
  { 名: '01_揺れ', 時刻: 700, 期待: '卵が出ていて揺れている' },
  { 名: '02_ひび', 時刻: 2100, 期待: 'ひびが開いている' },
  { 名: '03_光', 時刻: 2900, 期待: '光があふれている' },
  { 名: '04_鳥', 時刻: 3900, 期待: '鳥が現れている' },
  { 名: '05_命名', 時刻: 5200, 期待: '名前の入力欄が出ている' },
];

async function main(): Promise<void> {
  console.log('=== 孵化の場面 ===');
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'hatch-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=900,760', 'about:blank',
  ], { stdio: 'ignore' });

  let ng = 0;
  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起きていない */ }
    }
    if (!ws) { console.log('  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const wait = new Map<number, (v: unknown) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; wait.set(i, r as (v: unknown) => void);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: false, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);

    // 孵化の場面だけを呼ぶ。await しない ― 途中を撮りたいので流したままにする。
    const 開始 = await ev<string>(
      'typeof window.__hatchDemo === "function" ? (window.__hatchDemo("owl"), "ok") : "無し"');
    if (開始 !== 'ok') { console.log('  NG  __hatchDemo が見つからない'); process.exit(1); }
    const 起点 = Date.now();

    for (const s of 場面) {
      await sleep(Math.max(0, s.時刻 - (Date.now() - 起点)));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const png = shot.result?.data as string | undefined;
      if (png) writeFileSync(join(OUT, `hatch_${s.名}.png`), Buffer.from(png, 'base64'));

      // 数字でも見る。何が画面に居るか。
      const 状況 = await ev<{
        卵: boolean; ひび: number; 光: number; 光濃さ: number;
        鳥: number; 欄: boolean; 字: string;
      }>(`(() => {
        const q = (s) => document.querySelector(s);
        const egg = q('.hatch-egg'); const crack = q('.hatch-crack');
        const flash = q('.hatch-flash'); const bird = q('.hatch-bird');
        const form = q('.hatch-form'); const cap = q('.hatch-caption');
        const 見える = (el) => {
          if (!el) return 0;
          const cs = getComputedStyle(el);
          return Number(cs.opacity) * (cs.display === 'none' ? 0 : 1);
        };
        return {
          卵: 見える(egg) > 0.05,
          // ★ getBoundingClientRect ではなく offsetWidth で測る。
          //   ひびは揺れている卵の中に居るので、傾いたぶん外接の箱が横に広がる。
          //   幅0の縦線を7度傾けただけで「幅7px」に見えてしまう(実測で判明)。
          ひび: crack ? crack.offsetWidth : -1,
          // 光は「class が付いたか」ではなく、実際にどれだけ広がって
          // どれだけ濃いかで見る。付いていても撮る時刻がずれれば写らない。
          光: flash ? Math.round(flash.getBoundingClientRect().width) : 0,
          光濃さ: Math.round(見える(flash) * 100),
          鳥: Math.round(見える(bird) * 100),
          欄: Boolean(form),
          字: cap ? cap.textContent : '',
        };
      })()`);
      console.log(`  ${s.名}(${s.時刻}ms)  卵=${状況.卵 ? '有' : '無'} ひび幅=${状況.ひび}px `
        + `光の広がり=${状況.光}px(濃さ${状況.光濃さ}%) 鳥の濃さ=${状況.鳥}% `
        + `命名欄=${状況.欄 ? '有' : '無'}`);
      if (状況.字) console.log(`         文字: ${状況.字}`);

      // 段階ごとの合否
      let ok = true;
      if (s.名 === '01_揺れ') ok = 状況.卵 && 状況.ひび === 0;
      if (s.名 === '02_ひび') ok = 状況.卵 && 状況.ひび > 20;
      // 光は画面(この検証では幅900)を覆うほど広がり、目に見える濃さがあること
      if (s.名 === '03_光') ok = 状況.光 > 900 && 状況.光濃さ > 20;
      if (s.名 === '04_鳥') ok = 状況.鳥 > 50;
      if (s.名 === '05_命名') ok = 状況.欄;
      if (!ok) { ng++; console.log(`         NG  ${s.期待}はず`); }
    }

    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  console.log(ng === 0 ? `=== 合格 (絵は ${OUT}) ===` : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();

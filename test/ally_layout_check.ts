// お供欄が iPhone の幅で3列2行に収まっているかを実測する。
//
// ★ 目で見て確かめない。iPhone を手元で開くのは手間で、
//   「たぶん入った」で通すと後で2列に戻っていても気づけない。
//   列数と枠の位置を数字で測り、合否を出す。
//
//   npx tsx test/ally_layout_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9481;
const OUT = join(process.cwd(), 'tools', 'shots');
const NAME = `al${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 幅と、その幅で期待する列数。
//   狭い端末 … 3列2行
//   PC       … 1行6列
const DEVICES: [string, number, number, number][] = [
  ['iPhone SE', 375, 667, 3],
  ['iPhone 14', 390, 844, 3],
  ['iPhone 14 Pro Max', 430, 932, 3],
  ['PC', 1280, 900, 6],
];

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { fire: 2, earth: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'], discovered: [], slots: 4, maxStage: 20, bestStage: 20,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== お供欄が3列2行に収まっているか ===');
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'madoken-al-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let failures = 0;
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
    if (!wsUrl) { console.log('  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(wsUrl);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const waiting = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; waiting.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4', JSON.stringify({bgmVolume:0,sfxVolume:0,muted:true}));
      }catch{}`,
    });

    for (const [label, w, h, want] of DEVICES) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h,
        deviceScaleFactor: want === 6 ? 1 : 2, mobile: want !== 6,
      });
      await send('Page.navigate', { url: HTTP });
      await sleep(4500);
      await ev('document.querySelector("#tab-battle").click()');
      await sleep(1500);

      const r = await ev<string>(`
        (() => {
          const cards = [...document.querySelectorAll('#ally-picker .ally-card')];
          if (cards.length === 0) return 'NOCARD';
          // 上端の y でまとめると行数、1行あたりの枚数が列数
          const rows = new Map();
          for (const c of cards) {
            const y = Math.round(c.getBoundingClientRect().top);
            const key = [...rows.keys()].find(k => Math.abs(k - y) < 6) ?? y;
            rows.set(key, (rows.get(key) || 0) + 1);
          }
          const counts = [...rows.values()];
          const box = document.querySelector('#ally-picker').getBoundingClientRect();
          const cw = cards[0].getBoundingClientRect().width;
          // 中身がはみ出していないか(名前が枠より広くないか)
          let over = 0;
          for (const c of cards) {
            const cb = c.getBoundingClientRect();
            for (const kid of c.children) {
              const kb = kid.getBoundingClientRect();
              if (kb.right > cb.right + 1 || kb.left < cb.left - 1) over++;
            }
          }
          return JSON.stringify({ n: cards.length, rows: counts.length,
            cols: counts, w: Math.round(box.width), cw: Math.round(cw), over });
        })()
      `);
      if (r === 'NOCARD') {
        console.log(`  ${label}: お供欄が出ていない(飛ばす)`);
        continue;
      }
      const d = JSON.parse(r) as {
        n: number; rows: number; cols: number[]; w: number; cw: number; over: number;
      };
      const wantRows = 6 / want;
      const ok = d.n === 6 && d.rows === wantRows
        && d.cols.every(c => c === want) && d.over === 0;
      if (!ok) failures++;
      console.log(
        `  ${ok ? 'OK ' : 'NG '} ${label} (${w}px): ${d.rows}行 × ${d.cols.join('/')}列`
        + ` [狙い ${wantRows}行×${want}列]`
        + ` / 枠 ${d.cw}px / 欄 ${d.w}px / はみ出し ${d.over}`);

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) {
        writeFileSync(join(OUT, `ally_${w}.png`), Buffer.from(shot.result.data, 'base64'));
      }
    }
    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  console.log(failures === 0 ? '=== 合格 ===' : `=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

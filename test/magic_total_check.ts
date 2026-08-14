// 研究室に出す「魔導値合計」を確かめる。
//
//   npm run dev を先に起こす
//   npx tsx test/magic_total_check.ts
//
// ★ 数字が出ているだけでは足りない。この数字はオンラインの順位を
//   決めるものなので、**順位表と同じ数え方**でなければ意味が無い。
//   数え方は2か所にある(画面=playerMagicTotal / サーバー=magicRankScore)。
//   別々に書かれている以上、一致するかを毎回確かめる。
//
// ★ 「戦闘力」と混ざっていないことも見る。あれは装備中の魔法だけを見る
//   別物で、同じ画面に並ぶので取り違えやすい。装備していない強い魔法を
//   わざと持たせて、両者が違う値になることを確かめる。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalStats, magicTotal, spellMagicValue } from '../shared/spellcraft';
import { equipLimit } from '../shared/data';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9512;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const NAME = `mt${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

const CHAR = 0;
// ★ 装備するのは弱い方だけにする。強い魔法をわざと外しておくことで、
//   「装備していない魔法も数に入る」かどうかが分かる。
const 魔法 = [
  { id: 's1', recipe: { fire: 1 }, level: 0, rarity: 'normal' },
  { id: 's2', recipe: { water: 1 }, level: 0, rarity: 'normal' },
  { id: 's3', recipe: { fire: 3 }, level: 9, rarity: 'legend' },   // 装備しない
  { id: 's4', recipe: { light: 3 }, level: 9, rarity: 'legend' },  // 装備しない
];
const 装備 = ['s1', 's2'];

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: CHAR, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: 魔法.map(m => ({ ...m, name: '', discoveries: [], stats: {}, equipCount: 1 })),
    equipped: 装備,
    discovered: [], slots: 4, maxStage: 3, bestStage: 2,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 研究室の魔導値合計 ===');
  mkdirSync(SHOTS, { recursive: true });

  // 期待値は、サーバーの順位計算と同じ式でこちらでも出す。
  const 本数 = equipLimit([]);
  const 期待 = magicTotal(
    魔法.map(m => ({ stats: finalStats(m.recipe as any, m.level, m.rarity as any, CHAR) })),
    本数,
  );
  // 戦闘力の方は装備中の2本だけ。別の値になるはず。
  const 装備ぶん = 装備
    .map(id => 魔法.find(m => m.id === id)!)
    .map(m => spellMagicValue(finalStats(m.recipe as any, m.level, m.rarity as any, CHAR)))
    .reduce((a, b) => a + b, 0);
  console.log(`  期待する合計: ${期待}(強い順に${本数}本) / 装備中の2本ぶん: ${装備ぶん}`);
  確認('装備中だけの値と、合計は別の数になる組み合わせで試している', 期待 !== 装備ぶん);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-mt-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1100,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ */ }
    }
    if (!ws) { console.log('  NG  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const 待ち = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && 待ち.has(m.id)) { 待ち.get(m.id)!(m); 待ち.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; 待ち.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await send('Page.navigate', { url: PAGE });
    await sleep(6000);
    await ev('document.getElementById("tab-lab").click()');
    await sleep(1500);

    const 本文 = await ev<string>(
      '(document.querySelector("#magic-total")?.textContent || "").replace(/\\s+/g," ").trim()');
    確認('研究室に魔導値合計が出ている', 本文.includes('魔導値合計'), `実測 「${本文.slice(0, 60)}」`);

    const 出た値 = Number((本文.match(/魔導値合計\s*(\d+)/) ?? [])[1] ?? -1);
    確認('順位表と同じ数え方になっている', 出た値 === 期待,
      `画面 ${出た値} / 期待 ${期待}`);

    確認('何本ぶんの合計かが書いてある', 本文.includes(`${本数}本`),
      `${本数}本`);
    // ★ ここが肝。装備していない魔法も入ると書いていないと、
    //   「戦闘力」と同じものだと読まれる。
    確認('装備していない魔法も入ると書いてある', 本文.includes('装備していない'));
    確認('戦闘力との違いに触れている', 本文.includes('戦闘力'));

    // 上の帯の戦闘力とは別の数字になっていること
    const 帯 = await ev<string>(
      '(document.querySelector("#power-display")?.textContent || "").trim()');
    const 帯の値 = Number((帯.match(/(\d+)/) ?? [])[1] ?? -1);
    確認('上の帯の「戦闘力」とは違う数字になっている', 帯の値 !== 出た値,
      `戦闘力 ${帯の値} / 魔導値合計 ${出た値}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(SHOTS, 'magic_total.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/magic_total.png');
    }
    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }

  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();

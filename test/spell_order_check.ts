// 魔導書の「魔導値順」が、画面に出ている数字の順になっているかを見る。
//
//   npm run dev を先に起こす
//   npx tsx test/spell_order_check.ts
//
// ★ 並べ替えの関数を呼んで確かめるだけでは足りない。
//   並べ替えは素の値、画面に出す数字は得意エレメントの上乗せ込み、
//   という食い違いがあり得る。この壊れ方は「画面に出ている数字を
//   上から読む」ことでしか捕まらない。
//
// ★ 得意エレメントの魔法を必ず混ぜること。混ぜないと上乗せが
//   全部0になり、素で並べても正しく見えてしまう(素通しになる)。

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARACTERS } from '../shared/characters';
import { ELEMENTS } from '../shared/data';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9508;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const NAME = `so${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 相棒は0番。得意エレメントの魔法とそうでない魔法を混ぜる。
const CHAR = 0;
const 得意 = CHARACTERS[CHAR].element;

// ★ この組み合わせは、素の値と上乗せ込みで順番が逆転する。
//   火2 は素137→137、雷2 は素131→142。素で並べると 137→142 と
//   下から上がってしまう(実際にそう出ていた)。
const 魔法たち: Record<string, number>[] = [
  { fire: 2 },
  { [得意]: 2 },
  { fire: 3 },
  { [得意]: 2, wind: 1 },
  { water: 2, wind: 1 },
  { earth: 3 },
];

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: CHAR, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: 魔法たち.map((recipe, i) => ({
      id: `s${i}`, name: '', recipe, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 0,
    })),
    equipped: [],
    discovered: [], slots: 4, maxStage: 3, bestStage: 2,
    bossCleared: [], sortMode: 'power', codexRewarded: false, legendRewarded: false,
  };
}

async function main(): Promise<void> {
  console.log('=== 魔導書の魔導値順 ===');
  console.log(`  相棒: ${CHARACTERS[CHAR].name}(得意 ${ELEMENTS[得意].name})`);
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'madoken-so-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1100,1200', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
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

    const 並び = await ev<string>('document.querySelector("#btn-sort-spells").textContent.trim()');
    確認('魔導値順で見ている', 並び.includes('魔導値'), `実測 「${並び}」`);

    // ★ 上から順に、画面に出ている数字をそのまま読む。
    const 数字 = await ev<number[]>(`
      [...document.querySelectorAll('#spell-list .mval')]
        .map(e => parseInt((e.textContent || '').replace(/[^0-9]/g, ''), 10))
        .filter(n => Number.isFinite(n))`);
    console.log(`     画面の魔導値(上から): ${(数字 ?? []).join(' → ')}`);
    確認('魔法が並んでいる', (数字 ?? []).length === 魔法たち.length,
      `${(数字 ?? []).length}件 / 期待 ${魔法たち.length}件`);

    const 逆転 = (数字 ?? []).findIndex((n, i) => i > 0 && n > 数字[i - 1]);
    確認('画面の数字が上から降順になっている', 逆転 < 0,
      逆転 < 0 ? ''
        : `${逆転}番目で上がっている(${数字[逆転 - 1]} → ${数字[逆転]})`);

    // ---- 装備頻度順でも同じこと ----
    //
    // ★ あちらは「装備回数が同じなら魔導値の高い方を上に」という
    //   二番目の物差しで同じ値を使う。片方だけ直すと、こちらに
    //   同じ食い違いが残る。今回は全部が未装備(回数0)なので、
    //   一覧まるごとが魔導値の降順になるはず。
    // ★ 並び替えは3段階で回る(装備頻度順 → 魔導値順 → 取得順)。
    //   1回押すだけでは狙いのモードに来ない。出てくるまで押す。
    let 並び2 = '';
    for (let i = 0; i < 4 && !並び2.includes('装備頻度'); i++) {
      await ev('document.querySelector("#btn-sort-spells").click()');
      await sleep(700);
      並び2 = await ev<string>('document.querySelector("#btn-sort-spells").textContent.trim()');
    }
    確認('装備頻度順まで切り替えられた', 並び2.includes('装備頻度'), `実測 「${並び2}」`);
    const 数字2 = await ev<number[]>(`
      [...document.querySelectorAll('#spell-list .mval')]
        .map(e => parseInt((e.textContent || '').replace(/[^0-9]/g, ''), 10))
        .filter(n => Number.isFinite(n))`);
    console.log(`     「${並び2}」の魔導値(上から): ${(数字2 ?? []).join(' → ')}`);
    if (並び2.includes('装備頻度')) {
      const 逆転2 = (数字2 ?? []).findIndex((n, i) => i > 0 && n > 数字2[i - 1]);
      確認('装備頻度順(全員未装備)でも降順になっている', 逆転2 < 0,
        逆転2 < 0 ? '' : `${逆転2}番目で上がっている(${数字2[逆転2 - 1]} → ${数字2[逆転2]})`);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(SHOTS, 'spell_order.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/spell_order.png');
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

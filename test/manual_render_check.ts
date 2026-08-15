// 説明書が実際に描けているかを見る(文章の抜けを目で確かめる代わり)。
//
//   npm run dev を先に起こす
//   npx tsx test/manual_render_check.ts
//
// ★ 「コードを直したから直っているはず」で済ませない。説明書は
//   テンプレート文字列の塊なので、定数を1つ入れ忘れただけで
//   "undefined" や空欄がそのまま画面に出る。実際に開いて中身を読む。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELEMENTS, ELEMENT_ORDER, EQUIP_BASE, EQUIP_MAX, EQUIP_UNLOCKS } from '../shared/data';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9518;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

async function main(): Promise<void> {
  console.log('=== 説明書はちゃんと描けているか ===');

  const profile = mkdtempSync(join(tmpdir(), 'madoken-man-'));
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
    const 待ち = new Map<number, (v: unknown) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && 待ち.has(m.id)) { 待ち.get(m.id)!(m); 待ち.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<{
      result?: { result?: { value?: unknown } } }>(r => {
      const i = ++id; 待ち.set(i, r as (v: unknown) => void);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    // 名前登録の画面を飛ばすため、最低限のセーブを入れておく
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', JSON.stringify({
          version: 1, nickname: 'man' + Math.random().toString(36).slice(2, 6),
          nickToken: 'tok', charId: 0, researchP: 10,
          inventory: {}, spells: [], equipped: [], discovered: [],
          slots: 2, maxStage: 1, bestStage: 0, bossCleared: [],
          sortMode: 'order', codexRewarded: false, legendRewarded: false,
          allyUnlocked: false, allyCharId: null,
        }));
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await send('Page.navigate', { url: PAGE });
    await sleep(6000);

    await ev('document.getElementById("tab-manual")?.click()');
    await sleep(1500);

    const 本文 = await ev<string>('(document.getElementById("manual-body")?.innerText ?? "")');
    確認('説明書が開いた', 本文.length > 500, `${本文.length}文字`);
    if (本文.length < 500) throw new Error('説明書を開けていない');

    // ★ 埋め込み忘れの典型。文章として出てはいけない語。
    for (const 禁 of ['undefined', 'NaN', '[object Object]']) {
      確認(`「${禁}」が出ていない`, !本文.includes(禁));
    }

    // エレメント表: 8種すべてと、消費MPの書き方
    for (const el of ELEMENT_ORDER) {
      確認(`${ELEMENTS[el].name}の説明が載っている`, 本文.includes(ELEMENTS[el].desc),
        ELEMENTS[el].desc);
    }
    確認('「MP+n」という紛らわしい書き方が残っていない',
      !/(^|[^消費])MP[+-]\d/.test(本文));

    // 今回足した「装備できる数」の節
    確認('「装備できる数」の節がある', 本文.includes('装備できる数'));
    確認(`最初は${EQUIP_BASE}本と書いてある`, 本文.includes(`${EQUIP_BASE}本`));
    for (const u of EQUIP_UNLOCKS) {
      確認(`${u.count}本目の解放条件(ステージ${u.boss})がある`,
        本文.includes(`${u.count}本目`) && 本文.includes(`ステージ${u.boss}のボス撃破`));
    }
    確認(`最大${EQUIP_MAX}本に触れている`, 本文.includes(`${EQUIP_MAX}本`));
    確認('古い「キー1〜4」が残っていない', !本文.includes('キー1〜4'));

    // 成功率と強化の説明
    確認('成功率が強化でも下がると書いてある',
      本文.includes('強化が進んでいるほど'));
    確認('強化で消費MPと再使用時間も下がると書いてある',
      本文.includes('消費MPと再使用時間'));

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

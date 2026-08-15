// ボス撃破後のコメント弾幕を実際に流して確かめる。
//
//   npm run dev を先に起こす
//   npx tsx test/danmaku_check.ts
//
// ★ 「コードを書いたから出るはず」で済ませない。弾幕は
//   ・本当に右から左へ動いているか
//   ・全員が同じ並びを見るか(種が効いているか)
//   ・操作を邪魔しないか(pointer-events)
//   ・時間が来たら消えるか
//   を見ないと確かめたことにならない。位置を2回測って動きを見る。
//
// ★ 共闘の盤面は実際にボスまで行かないと出ないので、
//   同じ大きさの canvas を置いて代わりにする。danmaku.ts は
//   #coop-canvas の canvas に重ねるだけなので、これで筋は同じ。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9519;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const 名前 = ['エーデルワイス', 'ソラ'];

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

async function main(): Promise<void> {
  console.log('=== ボス撃破後のコメント弾幕 ===');

  const profile = mkdtempSync(join(tmpdir(), 'madoken-dm-'));
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
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', JSON.stringify({
          version: 1, nickname: 'dm' + Math.random().toString(36).slice(2, 6),
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

    // ★ 先に戦闘タブを開かせる。#battle-screen が display:none のままだと
    //   配下は大きさ0になり、danmaku.ts が「まだ描かれていない」と見て
    //   何も出さない(製品側の防御は正しい)。
    await ev('document.getElementById("tab-battle")?.click()');
    await sleep(1500);

    // 盤面の代わりを置いて、弾幕の器を使えるようにする
    const 用意 = await ev<string>(`(async () => {
      const view = document.getElementById('coop-view');
      const holder = document.getElementById('coop-canvas');
      if (!view || !holder) return 'coop-view が無い';
      // ★ 先祖もたどって表に出す。#battle-screen が display:none のままだと
      //   配下は大きさ0になり、danmaku.ts が「まだ描かれていない」と判断して
      //   何も出さない(製品側の防御は正しい。試験の準備の問題)。
      for (let n = view; n && n !== document.body; n = n.parentElement) {
        n.classList.remove('hidden');
        n.style.display = '';
      }
      view.classList.remove('hidden');
      const c = document.createElement('canvas');
      c.width = 800; c.height = 480;
      c.style.width = '800px'; c.style.height = '480px';
      holder.appendChild(c);
      window.__dm = await import('/src/danmaku.ts');
      return 'ok';
    })()`);
    確認('弾幕の器を用意できた', 用意 === 'ok', 用意);
    if (用意 !== 'ok') throw new Error(用意);

    // 対象ステージ: ボス戦(5の倍数)すべて。ボスでない回では出ない。
    const 対象 = await ev<Record<string, boolean>>(`({
      s5: window.__dm.isDanmakuStage(5),
      s10: window.__dm.isDanmakuStage(10),
      s25: window.__dm.isDanmakuStage(25),
      s50: window.__dm.isDanmakuStage(50),
      s4: window.__dm.isDanmakuStage(4),
      s7: window.__dm.isDanmakuStage(7),
      s11: window.__dm.isDanmakuStage(11),
    })`);
    確認('ボス戦(5・10・25・50)では出る',
      対象.s5 && 対象.s10 && 対象.s25 && 対象.s50,
      `5=${対象.s5} 10=${対象.s10} 25=${対象.s25} 50=${対象.s50}`);
    確認('ボスでない回(4・7・11)では出ない',
      !対象.s4 && !対象.s7 && !対象.s11,
      `4=${対象.s4} 7=${対象.s7} 11=${対象.s11}`);

    // --- 1回目 ---
    await ev(`window.__dm.playDanmaku('room1:5', ${JSON.stringify(名前)})`);
    await sleep(1500);

    const 一回目 = await ev<{ 数: number; 語: string[]; x: number[]; ペン: string }>(`(() => {
      const els = [...document.querySelectorAll('#danmaku .dm-item')];
      return {
        数: els.length,
        語: els.map(e => e.textContent),
        x: els.map(e => Math.round(e.getBoundingClientRect().left)),
        ペン: getComputedStyle(document.getElementById('danmaku')).pointerEvents,
      };
    })()`);
    確認('コメントが流れている', 一回目.数 >= 3, `${一回目.数}本`);
    確認('操作を邪魔しない(pointer-events:none)', 一回目.ペン === 'none', 一回目.ペン);
    console.log(`     例: ${一回目.語.slice(0, 4).join(' / ')}`);

    // 1秒待って、左へ動いているかを見る
    await sleep(1000);
    const 後 = await ev<{ 語: string[]; x: number[] }>(`(() => {
      const els = [...document.querySelectorAll('#danmaku .dm-item')];
      return { 語: els.map(e => e.textContent), x: els.map(e => Math.round(e.getBoundingClientRect().left)) };
    })()`);
    // 同じ語の位置を突き合わせる(消えたもの・増えたものがあるため)
    let 動いた = 0; let 逆走 = 0;
    for (let i = 0; i < 一回目.語.length; i++) {
      const j = 後.語.indexOf(一回目.語[i]);
      if (j < 0) continue;
      if (後.x[j] < 一回目.x[i]) 動いた++; else 逆走++;
    }
    確認('右から左へ動いている', 動いた > 0 && 逆走 === 0,
      `左へ ${動いた}本 / 逆 ${逆走}本`);

    // ★ 本家と同じく「長さによらず渡り切る時間は同じ」= 長い文ほど速い。
    //   幅と速さを実測して確かめる。速さ = 幅の差 ÷ 経過時間。
    const 位置A = await ev<{ s: string; x: number; w: number }[]>(`(() => {
      return [...document.querySelectorAll('#danmaku .dm-item')].map(e => {
        const r = e.getBoundingClientRect();
        return { s: e.textContent, x: r.left, w: r.width };
      });
    })()`);
    const 刻み = 700;
    await sleep(刻み);
    const 位置B = await ev<{ s: string; x: number }[]>(`(() => {
      return [...document.querySelectorAll('#danmaku .dm-item')].map(e => {
        const r = e.getBoundingClientRect();
        return { s: e.textContent, x: r.left };
      });
    })()`);
    // ★ 同じ文言が2本同時に出ていることがある。文字だけで突き合わせると
    //   別の1本に当たり、あり得ない速さが出る(実際に1.88秒と出た)。
    //   どちらの標本でも1本しか無い文言だけを使う。
    const 数える = (list: { s: string }[], s: string) =>
      list.filter(x => x.s === s).length;
    const 速さ表: { 幅: number; 速さ: number; s: string }[] = [];
    for (const a of 位置A) {
      if (数える(位置A, a.s) !== 1 || 数える(位置B, a.s) !== 1) continue;
      const b = 位置B.find(x => x.s === a.s);
      if (!b) continue;
      速さ表.push({ 幅: Math.round(a.w), 速さ: (a.x - b.x) / (刻み / 1000), s: a.s });
    }
    速さ表.sort((p, q) => p.幅 - q.幅);
    if (速さ表.length >= 2) {
      const 短 = 速さ表[0];
      const 長 = 速さ表[速さ表.length - 1];
      console.log(`     短い「${短.s}」幅${短.幅}px → ${Math.round(短.速さ)}px/秒`);
      console.log(`     長い「${長.s}」幅${長.幅}px → ${Math.round(長.速さ)}px/秒`);
      確認('長い文ほど速く流れる(渡り切る時間は同じ)', 長.速さ > 短.速さ,
        `${Math.round(長.速さ)} > ${Math.round(短.速さ)} px/秒`);
      // 渡り切る時間 = (画面幅 + 文字幅) / 速さ。全部そろっているはず。
      const 時間 = 速さ表.map(r => (800 + r.幅) / r.速さ);
      const 最小 = Math.min(...時間); const 最大 = Math.max(...時間);
      確認('渡り切る時間が全部そろっている', 最大 - 最小 < 0.35,
        `${最小.toFixed(2)}〜${最大.toFixed(2)}秒`);
    } else {
      確認('速さを測れた', false, `突き合わせられたのは${速さ表.length}本`);
    }

    // ★ 同じ車線で文字が重なっていないか。
    //   速さを1本ごとに散らすと後ろが前に追いつき、読めなくなる
    //   (最初の版が実際にそうなっていた)。何度か覗いて確かめる。
    let 重なり = '';
    for (let 回 = 0; 回 < 6 && !重なり; 回++) {
      const 箱 = await ev<{ top: number; l: number; r: number; s: string }[]>(`(() => {
        return [...document.querySelectorAll('#danmaku .dm-item')].map(e => {
          const r = e.getBoundingClientRect();
          return { top: Math.round(r.top), l: r.left, r: r.right, s: e.textContent };
        });
      })()`);
      for (let i = 0; i < 箱.length && !重なり; i++) {
        for (let j = i + 1; j < 箱.length; j++) {
          if (Math.abs(箱[i].top - 箱[j].top) > 4) continue;   // 別の車線
          if (箱[i].l < 箱[j].r - 1 && 箱[j].l < 箱[i].r - 1) {
            重なり = `「${箱[i].s}」と「${箱[j].s}」`;
            break;
          }
        }
      }
      await sleep(500);
    }
    確認('同じ車線で文字が重なっていない', 重なり === '', 重なり);

    const 名前入り = 一回目.語.concat(後.語)
      .filter(s => 名前.some(n => s.includes(n)));
    確認('研究者の名前入りコメントが出ている', 名前入り.length > 0,
      名前入り[0] ?? '出ていない');

    // --- 2回目: 同じ種なら同じ並び ---
    await ev('window.__dm.stopDanmaku()');
    await sleep(200);
    await ev(`window.__dm.playDanmaku('room1:5', ${JSON.stringify(名前)})`);
    await sleep(1500);
    const 二回目 = await ev<string[]>(
      `[...document.querySelectorAll('#danmaku .dm-item')].map(e => e.textContent)`);
    const 短い = Math.min(一回目.語.length, 二回目.length);
    const 同じ = 短い > 0 && 一回目.語.slice(0, 短い).join('|') === 二回目.slice(0, 短い).join('|');
    確認('同じ種なら同じ並び(全員が同じ弾幕を見る)', 同じ,
      同じ ? `先頭${短い}本が一致` : `1回目=${一回目.語.slice(0, 3).join('/')} 2回目=${二回目.slice(0, 3).join('/')}`);

    // --- 3回目: 種が違えば並びも違う ---
    await ev('window.__dm.stopDanmaku()');
    await sleep(200);
    await ev(`window.__dm.playDanmaku('room9:5', ${JSON.stringify(名前)})`);
    await sleep(1500);
    const 三回目 = await ev<string[]>(
      `[...document.querySelectorAll('#danmaku .dm-item')].map(e => e.textContent)`);
    確認('種が違えば並びも変わる(種が効いている)',
      三回目.slice(0, 短い).join('|') !== 一回目.語.slice(0, 短い).join('|'),
      三回目.slice(0, 3).join(' / '));

    // --- 時間が来たら消えるか ---
    console.log('     出し切って消えるまで待ちます(約10秒)…');
    await sleep(11_000);
    const 残り = await ev<{ 数: number; 隠れ: boolean }>(`({
      数: document.querySelectorAll('#danmaku .dm-item').length,
      隠れ: document.getElementById('danmaku').classList.contains('hidden'),
    })`);
    確認('流し終わったら消える', 残り.数 === 0 && 残り.隠れ,
      `残り${残り.数}本 / 隠れ=${残り.隠れ}`);

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

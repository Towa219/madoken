// 瞑想(focus)の効果が、詠唱の「完了時」に出ているかを測る。
//
//   npm run dev を先に起こす
//   npx tsx test/focus_timing_check.ts
//
// ★ 「コードでは完了時に呼んでいます」では答えにならない。
//   詠唱は1.1〜1.3秒しかなく、唱えた瞬間にMPが22ほど減り、そこから
//   通常回復(毎秒6)で戻り始める。目には「もう効いている」と映る。
//   実際に上乗せが立つ時刻を測って、詠唱時間と並べて示す。
//
// ★ 測るのは「効果が立った時刻」であって「MPが増えたか」ではない。
//   MPは詠唱中も通常回復で増える。そこを混同すると、正しい実装を
//   不具合と判定してしまう。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalStats } from '../shared/spellcraft';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9516;
const NAME = `ft${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 瞑想系(氷2+光1)。攻撃魔法も1本持たせて、戦闘が成立するようにする。
const 瞑想レシピ = { ice: 2, light: 1 };
const 瞑想 = finalStats(瞑想レシピ as never, 0, 'normal');

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 2, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [
      { id: 's1', name: '', recipe: 瞑想レシピ, discoveries: [], level: 0, rarity: 'normal', stats: {}, equipCount: 1 },
      { id: 's2', name: '', recipe: { fire: 1 }, discoveries: [], level: 0, rarity: 'normal', stats: {}, equipCount: 1 },
    ],
    equipped: ['s1', 's2'],
    discovered: [], slots: 4, maxStage: 3, bestStage: 2,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
    allyUnlocked: false, allyCharId: null,
  };
}

async function main(): Promise<void> {
  console.log('=== 瞑想はいつ効き始めるか ===');
  console.log(`  瞑想の詠唱: ${瞑想.castTime.toFixed(2)}秒 / 消費MP ${瞑想.manaCost}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-ft-'));
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

    await ev('document.getElementById("tab-battle").click()');
    await sleep(1200);
    await ev('document.getElementById("btn-solo-go").click()');
    await sleep(6500);   // カウントダウンが明けるまで

    const 始め = await ev<any>('(window.__playerDebug ?? null)');
    確認('戦闘が始まっている', 始め !== null,
      始め ? `MP ${Math.round(始め.mp)}/${始め.maxMp}` : '読めない');
    if (!始め) throw new Error('戦闘に入れていない');

    // 瞑想を撃つ(1本目)。魔法は pointerdown で撃つ。
    await ev(`document.querySelector('#spell-bar .spell-btn').scrollIntoView({block:'center'})`);
    await sleep(500);
    const 位置 = await ev<{ x: number; y: number } | null>(`(() => {
      const b = document.querySelector('#spell-bar .spell-btn');
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.top > innerHeight) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    確認('瞑想のボタンが画面の中にある', 位置 !== null);
    if (!位置) throw new Error('ボタンが押せない');

    // ★ 押した瞬間から細かく刻んで取る。詠唱は1.3秒しかないので、
    //   間隔が粗いと「開始時に効いた」のか「完了時か」を分けられない。
    const 標本 = await ev<[number, number, number, number][]>(`(async () => {
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 2600) {
        const d = window.__playerDebug;
        if (d) out.push([(performance.now() - t0) / 1000, d.mp, d.mpRegenBonus ?? 0, d.castT ?? -1]);
        await new Promise(r => setTimeout(r, 40));
      }
      return out;
    })()`).catch(() => null);
    // 上の待ちを仕掛けてから押す(押してから仕掛けると詠唱の頭を取り逃す)
    void 標本;

    // 仕切り直し: 待ちを仕掛けつつ押す
    const 結果 = await new Promise<[number, number, number, number][]>(resolve => {
      void ev<[number, number, number, number][]>(`(async () => {
        const out = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
          const d = window.__playerDebug;
          if (d) out.push([(performance.now() - t0) / 1000, d.mp, d.mpRegenBonus ?? 0, d.castT ?? -1]);
          await new Promise(r => setTimeout(r, 40));
        }
        return out;
      })()`).then(resolve);
      // 少し置いてから実際に押す
      setTimeout(() => {
        void (async () => {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent',
              { type, x: 位置.x, y: 位置.y, button: 'left', clickCount: 1 });
          }
        })();
      }, 300);
    });

    const 詠唱開始 = 結果.find(r => r[3] >= 0);
    const 効いた = 結果.find(r => r[2] > 0);
    確認('詠唱が始まった', !!詠唱開始, 詠唱開始 ? `${詠唱開始[0].toFixed(2)}秒の時点` : '始まっていない');
    確認('瞑想の効果が出た', !!効いた, 効いた ? `${効いた[0].toFixed(2)}秒の時点` : '出ていない');

    if (詠唱開始 && 効いた) {
      const 差 = 効いた[0] - 詠唱開始[0];
      console.log(`     詠唱開始 ${詠唱開始[0].toFixed(2)}秒 → 効果 ${効いた[0].toFixed(2)}秒`
        + ` = ${差.toFixed(2)}秒後(詠唱時間は ${瞑想.castTime.toFixed(2)}秒)`);
      // ★ 詠唱時間ぶん待ってから効いていること。
      //   刻みが40msなので、そのぶんの誤差は見込む。
      確認('効果は詠唱が終わってから出ている', 差 >= 瞑想.castTime - 0.15,
        `${差.toFixed(2)}秒後 / 詠唱${瞑想.castTime.toFixed(2)}秒`);
      確認('詠唱開始の時点では効いていない', (詠唱開始[2] ?? 0) === 0,
        `開始時の上乗せ ${詠唱開始[2]}`);

      // 参考: 詠唱中にMPが増えていること(これが「早く見える」正体)
      const 中 = 結果.filter(r => r[3] >= 0);
      if (中.length >= 2) {
        const 増 = 中[中.length - 1][1] - 中[0][1];
        console.log(`     参考: 詠唱の間にMPは ${増 >= 0 ? '+' : ''}${増.toFixed(1)} `
          + '動いている(通常の自然回復。これが「もう効いている」に見える)');
      }
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

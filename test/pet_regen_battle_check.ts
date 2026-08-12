// ペットぶんのMP自然回復が、本当に戦闘の中で効いているかを測る。
//
//   npm run dev / npm run dev:server を先に起こしておく
//   ADMIN_KEY=test1234 npx tsx test/pet_regen_battle_check.ts
//
// ★ test/pet_regen_check.ts は式だけを確かめている。こちらは配線を見る。
//   bonusOf が正しくても、戦闘が this.mpRegen を読んでいなければ
//   画面では何も変わらない。式は合っているのに効かない、という
//   壊れ方はここでしか捕まらない。
//
// ★ 「MPが増えた」では足りない。ペットが居なくても毎秒6は戻るので、
//   居ても居なくても増える。**毎秒いくつ戻ったか**を測り、
//   6 + 鳥ぶん になっているところまで見る。
//
// ★ MPは満タンから始まる。満タンのままでは上限で頭打ちになり、
//   何を測っても0になる。先に魔法を撃って減らしてから測る。
//
// ★ ペットAPIの応答だけを差し替え、サーバーを使わない。
//   卵から出る種類は選べないので、本物のAPIだと「回復+2の鳥」を
//   狙って用意できず、測りたい道を通せない回が出る。
//   差し替えるのは応答だけで、控える処理も戦闘も本物が動く。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAYER_MP_REGEN } from '../shared/data';
import { PET_SPECIES, regenOf } from '../shared/pets';
import type { PetSpeciesId } from '../shared/pets';

const API = process.env.PET_API ?? 'http://127.0.0.1:2567';
const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const PORT = 9502;
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const NAME = `mr${Math.random().toString(36).slice(2, 6)}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

interface 覗き見 { mp: number; maxMp: number; mpRegen: number; pet: string }

// 消費MPの小さい魔法を1本だけ持たせる。撃ってMPを減らすのが目的なので
// 威力は要らない。強い魔法だと詠唱が長く、測る前に時間を食う。
function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { fire: 3 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 3, bestStage: 2,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
    allyUnlocked: false, allyCharId: null,
  };
}

async function main(): Promise<void> {
  console.log('=== 戦闘の中でMP自然回復を測る ===');
  console.log(`  自分の自然回復: 毎秒${PLAYER_MP_REGEN}`);
  mkdirSync(SHOTS, { recursive: true });

  // ---- 連れて行く鳥を決める ----
  //
  // 環境変数で種類を差し替えられる。既定はフクロウ(回復+2)。
  //   MADOKEN_PET=sparrow npx tsx test/pet_regen_battle_check.ts
  const 種類 = (process.env.MADOKEN_PET ?? 'owl') as PetSpeciesId;
  if (!PET_SPECIES[種類]) {
    console.log(`  NG  そんな鳥はいない: ${種類}`); process.exit(1);
  }
  const 期待回復 = regenOf(種類);
  console.log(`  連れて行く鳥: ${PET_SPECIES[種類].name}`
    + `(MP${PET_SPECIES[種類].mp}) → 回復+${期待回復}/秒`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-mr-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,900', 'about:blank',
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
    // 成鳥まで育った1羽。孵化から6日 = 雛(4日)を抜けて成鳥。
    // 個体値は端の値(0と100)にしておく。自然回復がここに引きずられて
    // いれば、期待値からずれて必ず気づける。
    const 偽ペット = {
      id: 'p-test', ownerName: NAME, species: 種類, name: '', sex: 'f',
      hpGene: 0, mpGene: 100, lifeGene: 50,
      warmCount: 3, lastWarmAt: 0, hatchedAt: Date.now() - 6 * 86400000,
      boarded: false, chosen: true, breedCount: 0, lastBredAt: 0,
      parents: null, bornAt: Date.now() - 9 * 86400000,
    };
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
        sessionStorage.setItem('madoken_admin_key', ${JSON.stringify(KEY)});
        // ペットAPIの応答だけ差し替える。他の通信(保存・順位)はそのまま通す。
        const 元 = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          if (url.indexOf('/api/pet/') >= 0) {
            const body = {
              ok: true, pets: [${JSON.stringify(偽ペット)}], board: [], now: Date.now(),
            };
            return Promise.resolve(new Response(JSON.stringify(body),
              { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return 元(input, init);
        };
      } catch {}`,
    });
    await send('Page.navigate', { url: PAGE });
    await sleep(6000);

    // ペットの画面を一度開く。連れている鳥を端末に控えるのはここ。
    // 開かずに戦闘へ行くと控えが空のままで、「効いていない」と誤検出する。
    await ev('document.querySelector("#tab-pet").click()');
    await sleep(2500);
    // カードの表示も見ておく。「MP回復 +2」とだけ出ていると
    // 合計+2と読まれるので、単位まで出ているかを確かめる。
    const カード = await ev<string>(`(() => {
      const p = document.querySelector('#pet-list .note');
      return p ? (p.textContent || '').trim() : '';
    })()`);
    確認('ペットの画面に回復が単位つきで出ている',
      カード.includes(`MP回復 +${期待回復}/秒`), `実測 「${カード}」`);

    // ---- 戦闘へ ----
    await ev('document.getElementById("tab-battle").click()');
    await sleep(1200);
    const 出撃できる = await ev<boolean>(
      '!!document.getElementById("btn-solo-go") && !document.getElementById("btn-solo-go").disabled');
    確認('出撃ボタンが押せる', 出撃できる);
    await ev('document.getElementById("btn-solo-go").click()');
    await sleep(6500);   // カウントダウン(3.6秒)が明けるまで待つ

    const 初回 = await ev<覗き見 | null>('(window.__playerDebug ?? null)');
    確認('戦闘が始まっている(覗き口が読める)', 初回 !== null,
      初回 ? `MP ${Math.round(初回.mp)}/${初回.maxMp}` : '読めない');
    if (!初回) { throw new Error('戦闘に入れていない'); }

    // ---- 1. 設定値そのもの ----
    const 期待値 = PLAYER_MP_REGEN + 期待回復;
    確認('自然回復の設定値に鳥ぶんが乗っている',
      Math.abs(初回.mpRegen - 期待値) < 0.001,
      `実測 毎秒${初回.mpRegen} / 期待 毎秒${期待値}(=${PLAYER_MP_REGEN}+${期待回復})`);

    // ---- 2. MPを減らす ----
    //
    // 魔法は pointerdown で撃つ(src/battle.ts の作りに合わせる)。
    // click では何も起きず、いつまでもMPが満タンのままになる。
    const 魔法の数 = await ev<number>(
      'document.querySelectorAll("#spell-bar .spell-btn").length');
    確認('魔法ボタンが出ている', 魔法の数 > 0, `${魔法の数}個`);

    // 合成イベントではなく本物のマウス操作を送る。合成の PointerEvent は
    // isTrusted が false で、作りによっては無視される(実際に無視された)。
    // ★ 先に画面内へ送り込むこと。魔法ボタンは戦闘画面の下にあり、
    //   そのままでは画面の外に居る。座標だけ測って本物のマウスを
    //   送っても、画面外なので何にも当たらない(一度これで空振りした)。
    await ev(`document.querySelector('#spell-bar .spell-btn')
      .scrollIntoView({ block: 'center' })`);
    await sleep(600);
    const 位置 = await ev<{ x: number; y: number } | null>(`(() => {
      const b = document.querySelector('#spell-bar .spell-btn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    確認('魔法ボタンが画面の中にある', 位置 !== null,
      位置 ? `(${Math.round(位置.x)}, ${Math.round(位置.y)})` : '画面の外');
    if (位置) {
      for (let i = 0; i < 3; i++) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent',
            { type, x: 位置.x, y: 位置.y, button: 'left', clickCount: 1 });
        }
        await sleep(1600);
      }
    }
    const 減った後 = await ev<覗き見>('window.__playerDebug');
    確認('魔法を撃ってMPが満タンより減った', 減った後.mp < 減った後.maxMp - 5,
      `MP ${Math.round(減った後.mp)}/${減った後.maxMp}`);
    // ★ ここで待たないこと。毎秒8で戻るので、間を空けるほど
    //   測れる区間が短くなる。減った直後から刻み始める。

    // ---- 3. 実際の戻り方を測る ----
    //
    // ★ 2点だけ取って割ってはいけない。毎秒8で戻るので、少し目を離すと
    //   その間に上限へ張り付き、傾きが0に見える(最初これで空振りした)。
    //   撃った直後から細かく刻んで取り、上限に達する前の区間だけを使う。
    const 標本 = await ev<[number, number, number][]>(`(async () => {
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 2600) {
        const d = window.__playerDebug;
        if (d) out.push([(performance.now() - t0) / 1000, d.mp, d.maxMp]);
        await new Promise(r => setTimeout(r, 60));
      }
      return out;
    })()`);

    // 上限に張り付く前・かつ詠唱で減っていない区間だけを使う。
    const 使える = (標本 ?? []).filter(([, mp, max]) => mp < max - 1);
    const 最小二乗 = (pts: [number, number, number][]): number => {
      const n = pts.length;
      const sx = pts.reduce((s, p) => s + p[0], 0);
      const sy = pts.reduce((s, p) => s + p[1], 0);
      const sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
      const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0);
      return (n * sxy - sx * sy) / (n * sxx - sx * sx);
    };
    確認('上限に達する前の標本が取れている', 使える.length >= 8,
      `${使える.length}点 / 全${(標本 ?? []).length}点`);

    const 実測 = 使える.length >= 8 ? 最小二乗(使える) : 0;
    // 端末のフレーム落ちで多少ぶれるので幅を持たせる。それでも
    // 「鳥ぶんが乗っていない場合(毎秒6)」とは確実に区別できる。
    確認('実際に毎秒 6+鳥ぶん だけ戻っている',
      使える.length >= 8 && Math.abs(実測 - 期待値) < 0.6,
      `実測 毎秒${実測.toFixed(2)} / 期待 毎秒${期待値} `
      + `(鳥なしなら毎秒${PLAYER_MP_REGEN})`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(SHOTS, 'pet_regen_battle.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/pet_regen_battle.png');
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

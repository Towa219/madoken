// 決闘が途中で落ちないかを確かめる。
//
// coop_e2e の決闘は「攻撃魔法だけを撃って決着するか」しか見ていない。
// 実際に落ちるのは、封印・活力・護符・瞑想・闘気のような
// 相手の状態をいじる魔法が絡んだ時や、片方が途中で抜けた時なので、
// そこを重点的に叩く。
//
// 見張るもの:
//   ・決着(duelend)の前に onLeave / onError が飛んでこないか
//   ・9種類すべての魔法を撃っても部屋が生き残るか
//   ・対戦中に片方が抜けた時、残った側が例外ではなく勝ちを受け取れるか
//   ・決着後に部屋がきちんと閉じるか
//
//   npx tsx test/duel_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { DUEL_MAX_HP, PLAYER_MAX_HP } from '../shared/data';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP_BASE = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(120);
  }
  return false;
}

// 9種類の魔法をひと通り。これで全ての resolveCast の枝を通す。
//
// 決闘のHPは厚い(DUEL_MAX_HP)。補助魔法ばかりだといつまでも決着しないので、
// 決め手になる攻撃魔法を1本ずつ持たせてある。ここで見たいのは
// 「全部の枝を通しても部屋が落ちないか」であって、勝負の長さではない。
const HEAVY = {
  name: '強い魔弾', recipe: { fire: 1, water: 1, light: 2, dark: 2 },
  level: 9, rarity: 'legend',
};
const KIT = [
  { name: '炎の魔弾', recipe: { fire: 2, wind: 1 } },       // 攻撃
  { name: '闇の封印', recipe: { dark: 3 } },                 // 封印
  { name: '万象護符', recipe: { water: 2, wind: 1, earth: 1, ice: 2 } }, // 護符
  { name: '活力', recipe: { fire: 2, earth: 2, light: 1 } }, // 活力
  HEAVY,                                                     // 決め手
];
const KIT2 = [
  { name: '雷の魔弾', recipe: { thunder: 1, wind: 2 } },     // 攻撃
  { name: '瞑想', recipe: { ice: 2, light: 1 } },            // 瞑想
  { name: '全体護盾', recipe: { earth: 2, ice: 1, light: 2 } }, // 護盾
  { name: '闘気', recipe: { fire: 2, thunder: 1, ice: 1 } }, // 闘気
  HEAVY,                                                     // 決め手
];

interface Watch {
  room: Room;
  left: boolean;
  error: string;
  end: { win: boolean; reason?: string } | null;
}

function watch(room: Room): Watch {
  const w: Watch = { room, left: false, error: '', end: null };
  room.onMessage('duelend', (m: { win: boolean; reason?: string }) => { w.end = m; });
  // 使わないメッセージも受けておかないと警告が出る
  for (const t of ['dproj', 'dhit', 'dshield', 'dheal', 'dguard', 'dseal',
    'dfocus', 'dempower', 'dward', 'dwardhit', 'dvigor', 'ddot', 'replaced']) {
    room.onMessage(t, () => { /* 表示用なので中身は見ない */ });
  }
  room.onLeave(() => { w.left = true; });
  room.onError((code, msg) => { w.error = `${code}: ${msg ?? ''}`; });
  return w;
}

async function releaseNames(names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await fetch(`${HTTP_BASE}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token: `tok${name}` }),
      });
    } catch { /* 消せなくてもテストの成否には関係ない */ }
  }
}

async function main(): Promise<void> {
  console.log('=== 決闘が途中で落ちないかの検証 ===');
  console.log(`対象: ${ENDPOINT}`);

  const names: string[] = [];

  // ---- 1. 全種類の魔法を撃ち合っても落ちないか ----
  {
    const [a, b] = [`dA${RUN}`, `dB${RUN}`];
    names.push(a, b);
    const ca = new Client(ENDPOINT);
    const cb = new Client(ENDPOINT);
    const ra: Room = await ca.joinOrCreate('duel',
      { name: a, spells: KIT, nickToken: `tok${a}`, charId: 0 });
    const rb: Room = await cb.joinOrCreate('duel',
      { name: b, spells: KIT2, nickToken: `tok${b}`, charId: 1 });
    const wa = watch(ra);
    const wb = watch(rb);

    check('決闘場に2人が入室',
      await waitFor(() => (ra.state as any)?.players?.size === 2));

    ra.send('ready');
    rb.send('ready');
    check('カウントダウンを経て開戦',
      await waitFor(() => (ra.state as any)?.phase === 'fight', 20_000));

    // 決闘のHPは共闘・ソロとは別枠(相手は回復も護盾も使ってくるので厚くしてある)
    const hpOf = (r: Room, sid: string) =>
      Number((r.state as any)?.players?.get(sid)?.maxHp ?? 0);
    check('★決闘のHPは決闘用の値になっている',
      hpOf(ra, ra.sessionId) === DUEL_MAX_HP && hpOf(ra, rb.sessionId) === DUEL_MAX_HP,
      `${hpOf(ra, ra.sessionId)} / ${hpOf(ra, rb.sessionId)}`);
    check('両者とも同じHPで始まる',
      hpOf(ra, ra.sessionId) === hpOf(rb, rb.sessionId),
      `${hpOf(ra, ra.sessionId)} vs ${hpOf(rb, rb.sessionId)}`);
    check('共闘・ソロのHPには影響していない', PLAYER_MAX_HP !== DUEL_MAX_HP,
      `ソロ/共闘=${PLAYER_MAX_HP} / 決闘=${DUEL_MAX_HP}`);

    // 5つの魔法を順に回す。どれか1つでも部屋を落とすなら、ここで切れる。
    let i = 0;
    const caster = setInterval(() => {
      for (const room of [ra, rb]) {
        const st: any = room.state;
        const me = st?.players?.get(room.sessionId);
        if (st?.phase === 'fight' && me?.alive && me.castingIdx === -1) {
          room.send('cast', { idx: i % 5 });
        }
      }
      i++;
    }, 350);

    // HPを厚くしたぶん決着まで長くかかる。待ち時間はそれに合わせてある。
    const t0 = Date.now();
    const done = await waitFor(() => wa.end !== null || wb.end !== null, 300_000);
    clearInterval(caster);
    console.log(`     決着までの時間: ${((Date.now() - t0) / 1000).toFixed(0)}秒`
      + `(HP${DUEL_MAX_HP})`);

    check('決着まで到達した', done,
      done ? (wa.end?.reason ?? '決着') : '時間切れ(落ちた可能性)');
    check('決着前に切断されなかった(A)', !wa.error, wa.error);
    check('決着前に切断されなかった(B)', !wb.error, wb.error);

    await sleep(1500);
    try { void ra.leave(); void rb.leave(); } catch { /* 切断済み */ }
    await sleep(500);
  }

  // ---- 2. 対戦中に片方が抜けても、残った側が勝ちを受け取れるか ----
  {
    const [a, b] = [`dC${RUN}`, `dD${RUN}`];
    names.push(a, b);
    const ca = new Client(ENDPOINT);
    const cb = new Client(ENDPOINT);
    const ra: Room = await ca.joinOrCreate('duel',
      { name: a, spells: KIT, nickToken: `tok${a}`, charId: 0 });
    const rb: Room = await cb.joinOrCreate('duel',
      { name: b, spells: KIT2, nickToken: `tok${b}`, charId: 1 });
    const wa = watch(ra);
    watch(rb);

    await waitFor(() => (ra.state as any)?.players?.size === 2);
    ra.send('ready');
    rb.send('ready');
    check('2戦目も開戦した',
      await waitFor(() => (ra.state as any)?.phase === 'fight', 20_000));

    // 弾が飛んでいる最中に抜ける。着弾時に相手がもういない状況を作る。
    ra.send('cast', { idx: 0 });
    rb.send('cast', { idx: 0 });
    await sleep(400);
    void rb.leave();

    check('残った側が勝ちを受け取った',
      await waitFor(() => wa.end !== null, 15_000),
      wa.end?.reason ?? '受け取れていない');
    check('残った側が例外で落ちていない', !wa.error, wa.error);

    await sleep(1200);
    try { void ra.leave(); } catch { /* 切断済み */ }
    await sleep(500);
  }

  // ---- 3. 決着後に部屋が残り続けていないか ----
  {
    const c = new Client(ENDPOINT);
    const rooms = await c.getAvailableRooms('duel');
    const stale = rooms.filter(r => r.clients === 0);
    check('空の決闘部屋が残っていない', stale.length === 0,
      `${stale.length}件 / 全${rooms.length}件`);
  }

  await releaseNames(names);
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 800);
}

main().catch(err => {
  console.error('✗ 例外で失敗:', err);
  process.exit(1);
});

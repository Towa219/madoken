// 共闘で「全員の画面に同じポーズが見える」ことを確かめる。
//
// ポーズを各自の画面で判断させると、通信の遅れや取りこぼしで
// 人によって違う絵が出る。サーバーが決めて配れば必ず揃う。
// そこで2人で同じ部屋に入り、両者が受け取ったポーズを突き合わせる。
//
// 見るのは
//   ・同じ時刻に、2人が同じポーズを見ているか(味方も敵も)
//   ・ポーズがちゃんと変わるか(詠唱 → 発射 → 被弾)
//   ・一瞬のポーズが出っぱなしにならないか(待機へ戻るか)
//
//   npx tsx test/pose_sync_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { poseName } from '../shared/data';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);
const STAGE = 1;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 25_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return false;
}

// 詠唱の長い攻撃(詠唱中の姿を確かめる余裕を作る)と、素早い一撃。
const KIT = [
  { name: '重い一撃', recipe: { fire: 2, earth: 1 }, level: 0, rarity: 'normal' },
  { name: '軽い一撃', recipe: { water: 2 }, level: 0, rarity: 'normal' },
];

const QUIET = ['proj', 'hit', 'eproj', 'ehit', 'phit', 'shield', 'shieldhit', 'shieldup',
  'heal', 'taunt', 'ward', 'wardhit', 'vigor', 'empower', 'focus', 'dot',
  'quake', 'stageclear', 'replaced', 'down', 'revive', 'result', 'aborted',
  'pwait', 'pback', 'mateleft', 'seal', 'eaoewarn', 'eaoehit', 'eaoestop', 'joined'];

async function release(name: string): Promise<void> {
  try {
    await fetch(`${HTTP}/api/name/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token: `tok${name}` }),
    });
  } catch { /* 消せなくてもテストの成否には関係ない */ }
}

// その時点で「画面に出る絵」を一覧にする。
//
// 番号ではなく絵の名前で突き合わせる。確かめたいのは
// 「2人に同じ絵が見えているか」であって、内部の番号が同じかではない。
function snapshot(r: Room): { players: Record<string, string>; enemies: string[] } {
  const st = r.state as any;
  const players: Record<string, string> = {};
  st?.players?.forEach((p: any, sid: string) => { players[sid] = poseName(p.pose); });
  const enemies: string[] = [];
  st?.enemies?.forEach((e: any) => { enemies.push(poseName(e.pose)); });
  return { players, enemies };
}

async function main(): Promise<void> {
  console.log('=== 共闘のポーズが全員で揃う ===');
  console.log(`対象: ${ENDPOINT} / ステージ${STAGE}`);
  const nameA = `pa${RUN}`;
  const nameB = `pb${RUN}`;

  let ra: Room | null = null;
  let rb: Room | null = null;
  try {
    const ca = new Client(ENDPOINT);
    const cb = new Client(ENDPOINT);
    ra = await ca.create('coop', {
      name: nameA, spells: KIT, stage: STAGE, maxStage: STAGE, nickToken: `tok${nameA}`,
    });
    const a = ra;
    for (const t of QUIET) a.onMessage(t, () => { /* 表示用 */ });
    await sleep(600);
    rb = await cb.joinById(a.roomId, {
      name: nameB, spells: KIT, maxStage: STAGE, nickToken: `tok${nameB}`,
    });
    const b = rb;
    for (const t of QUIET) b.onMessage(t, () => { /* 表示用 */ });

    check('2人が同じ部屋に入れた',
      await waitFor(() => (a.state as any)?.players?.size === 2
        && (b.state as any)?.players?.size === 2, 15_000),
      `A=${(a.state as any)?.players?.size} B=${(b.state as any)?.players?.size}`);

    a.send('ready');
    b.send('ready');
    check('戦闘が始まった',
      await waitFor(() => String((a.state as any)?.phase) === 'fight', 25_000));

    // ---- ずっと突き合わせながら、両者が魔法を撃ち続ける ----
    //
    // 突き合わせは「同じ瞬間に読む」ことが肝心。片方を読んでから
    // もう片方を読むまでに時間が空くと、正しく揃っていてもずれて見える。
    let compared = 0;
    let mismatch = 0;
    const firstBad: string[] = [];
    const seenP = new Set<string>();
    const seenE = new Set<string>();

    const t0 = Date.now();
    let castTick = 0;
    while (Date.now() - t0 < 30_000) {
      const sa = snapshot(a);
      const sb = snapshot(b);
      for (const sid of Object.keys(sa.players)) {
        if (!(sid in sb.players)) continue;
        compared++;
        seenP.add(sa.players[sid]);
        if (sa.players[sid] !== sb.players[sid]) {
          mismatch++;
          if (firstBad.length < 3) {
            firstBad.push(`味方 A=${sa.players[sid]} / B=${sb.players[sid]}`);
          }
        }
      }
      const n = Math.min(sa.enemies.length, sb.enemies.length);
      for (let i = 0; i < n; i++) {
        compared++;
        seenE.add(sa.enemies[i]);
        if (sa.enemies[i] !== sb.enemies[i]) {
          mismatch++;
          if (firstBad.length < 3) {
            firstBad.push(`敵 A=${sa.enemies[i]} / B=${sb.enemies[i]}`);
          }
        }
      }
      // どちらも撃ち続ける(詠唱 → 発射 → 反撃で被弾、が一巡する)
      castTick++;
      if (castTick % 6 === 0) {
        a.send('cast', { idx: castTick % 12 === 0 ? 0 : 1 });
        b.send('cast', { idx: 1 });
      }
      // 決着していたら止める(倒し切ると以降は何も動かない)
      if (String((a.state as any)?.phase) !== 'fight') break;
      await sleep(80);
    }

    console.log(`     突き合わせ ${compared}回 / 食い違い ${mismatch}回`);
    check('★2人の画面でポーズが必ず一致する', mismatch === 0,
      firstBad.join(' / ') || '食い違いなし');

    const pList = [...seenP].sort().join('・');
    const eList = [...seenE].sort().join('・');
    console.log(`     出てきた味方のポーズ: ${pList}`);
    console.log(`     出てきた敵のポーズ: ${eList}`);

    check('味方が詠唱の姿になる', seenP.has('cast'), pList);
    check('味方が撃った姿になる', seenP.has('release'), pList);
    check('味方が被弾の姿になる', seenP.has('hurt'), pList);
    check('★一瞬の姿のまま固まらない(待機に戻る)', seenP.has('idle'), pList);
    check('敵も被弾の姿になる', seenE.has('hurt'), eList);
    check('敵が攻撃の姿になる', seenE.has('release'), eList);
  } finally {
    try { void ra?.leave(); } catch { /* 切断済み */ }
    try { void rb?.leave(); } catch { /* 切断済み */ }
    await sleep(800);
    await release(nameA);
    await release(nameB);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(500);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

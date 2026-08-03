// 共闘のカウントダウン(3→2→1→開戦)を確かめる。
//
// 開戦前だけでなく、勝ち上がって次のステージへ進んだ時も同じ入り方にする。
// 数えている間は誰も動けない(敵の攻撃も詠唱も止まる)ので、
// ステージが切り替わった瞬間にいきなり殴られることがなくなる。
//
// 見るのは
//   ・準備完了のあと ready → count → fight と進むか
//   ・数えている間、敵からの攻撃が飛んでこないか
//   ・次のステージでも count を経由するか
//
//   npx tsx test/coop_countdown_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
const RUN = Math.random().toString(36).slice(2, 7);

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

// ステージ1の敵をすぐ倒せる装備(次ステージへの切り替わりを見るため)
const KIT = [{
  name: '強い魔弾', recipe: { fire: 1, water: 1, light: 2, dark: 2 },
  level: 9, rarity: 'legend',
}];

const QUIET = ['proj', 'hit', 'ehit', 'shield', 'heal', 'taunt', 'ward', 'wardhit',
  'vigor', 'empower', 'focus', 'seal', 'dot', 'quake', 'result', 'aborted',
  'replaced', 'down', 'revive', 'eaoewarn', 'eaoehit', 'pwait', 'pback', 'mateleft'];

async function main(): Promise<void> {
  console.log('=== 共闘のカウントダウン ===');
  console.log(`対象: ${ENDPOINT}`);
  const name = `cd${RUN}`;

  const c = new Client(ENDPOINT);
  let room: Room | null = null;
  try {
    room = await c.create('coop', {
      name, spells: KIT, stage: 1, maxStage: 1, nickToken: `tok${name}`,
    });
    const r = room;

    // 敵の攻撃(eproj)がいつ飛んできたかを控える
    const eproj: number[] = [];
    r.onMessage('eproj', () => { eproj.push(Date.now()); });
    let cleared = 0;
    r.onMessage('stageclear', () => { cleared++; });
    for (const t of QUIET) r.onMessage(t, () => { /* 表示用 */ });

    const phase = () => String((r.state as any)?.phase ?? '');
    const countdown = () => Number((r.state as any)?.countdown ?? -1);

    await waitFor(() => phase() === 'ready', 15_000);
    check('最初は準備中(ready)', phase() === 'ready', phase());

    r.send('ready');

    // ready のあと、いきなり fight ではなく count を通る
    const sawCount = await waitFor(() => phase() === 'count', 15_000);
    check('★準備完了のあとカウントダウンに入る', sawCount, phase());
    const startedAt = Date.now();
    const first = countdown();
    check('残り秒数が入っている', first > 0, `${first.toFixed(1)}秒`);

    // 数えている間は敵が撃ってこない
    const before = eproj.length;
    await sleep(1500);
    check('数えている間は敵が撃ってこない', eproj.length === before,
      `${eproj.length - before}発`);

    const toFight = await waitFor(() => phase() === 'fight', 15_000);
    const took = (Date.now() - startedAt) / 1000;
    check('カウントダウンのあと戦闘が始まる', toFight, phase());
    check('長さが3秒前後', took >= 2.5 && took <= 6, `${took.toFixed(1)}秒`);

    // ---- 次のステージでもカウントダウンから ----
    console.log('     (ステージ1を倒して次へ…)');
    const caster = setInterval(() => {
      const st: any = r.state;
      const me = st?.players?.get(r.sessionId);
      if (st?.phase === 'fight' && me?.alive && me.castingIdx === -1) {
        r.send('cast', { idx: 0 });
      }
    }, 300);

    const clearedOk = await waitFor(() => cleared > 0, 90_000);
    check('ステージ1をクリアした', clearedOk);

    const sawCount2 = await waitFor(() => phase() === 'count', 20_000);
    clearInterval(caster);
    check('★次のステージもカウントダウンから始まる', sawCount2, phase());
    check('ステージが進んでいる', Number((r.state as any)?.stage) >= 2,
      String((r.state as any)?.stage));

    const before2 = eproj.length;
    await sleep(1200);
    check('次ステージでも数えている間は撃たれない', eproj.length === before2,
      `${eproj.length - before2}発`);

    check('その後ちゃんと戦闘に入る',
      await waitFor(() => phase() === 'fight', 15_000), phase());
  } finally {
    try { void room?.leave(); } catch { /* 切断済み */ }
    await sleep(800);
    try {
      await fetch(`${HTTP}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token: `tok${name}` }),
      });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 600);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

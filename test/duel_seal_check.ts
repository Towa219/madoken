// 決闘の封印が「相手に何もさせないまま終わる」ほど強くないかを確かめる。
//
// 相手は敵と違って人なので、止まっている間は本当に何もできない。
// 立て続けに掛けられると一度も動けないまま決着してしまう。
//
// 見るのは
//   ・1回の封印が短くなっているか(以前の3分の1)
//   ・2回目は半分、3回目はレジストされるか(耐性が付く)
//   ・封印されている間は本当に詠唱できないか(効果自体は残っている)
//   ・決闘のHPが決闘用の値になっているか
//
//   npx tsx test/duel_seal_check.ts

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { DUEL_MAX_HP } from '../shared/data';
import { finalStats } from '../shared/spellcraft';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');
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
    await sleep(80);
  }
  return false;
}

// 封印を3本ぶん装備する。
//
// 再使用は40秒あるので、1本では連発できない。嵌めが起きるのは
// 同じ封印を複数の枠に入れた時で、枠ごとに再使用を数えるため
// 立て続けに撃てる。耐性はまさにこの形を潰すためにある。
const SEAL = { dark: 3 };
const KIT_SEAL = [
  { name: '闇の封印', recipe: SEAL, level: 0, rarity: 'normal' },
  { name: '闇の封印', recipe: SEAL, level: 0, rarity: 'normal' },
  { name: '闇の封印', recipe: SEAL, level: 0, rarity: 'normal' },
];
// 相手は普通の攻撃魔法(護符を張らせない。護符での軽減と混ざると測れない)
const KIT_ATK = [{ name: '弱い魔弾', recipe: { water: 2 }, level: 0, rarity: 'normal' }];

const QUIET = ['dproj', 'dhit', 'dshield', 'dheal', 'dguard',
  'dfocus', 'dempower', 'dward', 'dwardhit', 'dvigor', 'ddot', 'replaced'];

interface Seal { sec: number; resisted: boolean; reason: string; step: number }

async function release(name: string): Promise<void> {
  try {
    await fetch(`${HTTP}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token: `tok${name}` }),
    });
  } catch { /* 消せなくてもテストの成否には関係ない */ }
}

async function main(): Promise<void> {
  console.log('=== 決闘の封印(嵌めにならないか) ===');
  console.log(`対象: ${ENDPOINT}`);

  // 素の封印時間(共闘・ソロで使う値)。これと比べて短くなっているかを見る。
  const base = finalStats(SEAL, 0, 'normal').sealTime;
  console.log(`     素の封印時間: ${base.toFixed(1)}秒`);

  const [a, b] = [`zA${RUN}`, `zB${RUN}`];
  const ca = new Client(ENDPOINT);
  const cb = new Client(ENDPOINT);
  let ra: Room | null = null;
  let rb: Room | null = null;
  try {
    ra = await ca.joinOrCreate('duel',
      { name: a, spells: KIT_SEAL, nickToken: `tok${a}`, charId: 0 });
    rb = await cb.joinOrCreate('duel',
      { name: b, spells: KIT_ATK, nickToken: `tok${b}`, charId: 1 });
    const rA = ra;
    const rB = rb;

    const seals: Seal[] = [];
    rA.onMessage('dseal', (m: Seal) => { seals.push(m); });
    rB.onMessage('dseal', () => { /* 表示用 */ });
    for (const t of QUIET) { rA.onMessage(t, () => {}); rB.onMessage(t, () => {}); }
    rA.onMessage('duelend', () => {});
    rB.onMessage('duelend', () => {});

    check('決闘場に2人が入室',
      await waitFor(() => (rA.state as any)?.players?.size === 2));
    rA.send('ready');
    rB.send('ready');
    check('開戦した', await waitFor(() => (rA.state as any)?.phase === 'fight', 20_000));

    const meB = () => (rA.state as any)?.players?.get(rB.sessionId);
    check('★決闘のHPは決闘用の値', Number(meB()?.maxHp) === DUEL_MAX_HP,
      String(meB()?.maxHp));

    // 枠を変えながら立て続けに封印する(再使用を待たずに撃てる形)
    let slot = 0;
    const castSeal = async () => {
      const before = seals.length;
      for (let i = 0; i < 40 && seals.length === before; i++) {
        rA.send('cast', { idx: slot });
        await sleep(250);
      }
      slot++;
      return seals[seals.length - 1];
    };

    const s1 = await castSeal();
    check('1回目は封印が効く', !!s1 && s1.sec > 0, `${s1?.sec?.toFixed(1)}秒`);
    check('★1回の長さが素の3分の1以下', !!s1 && s1.sec <= base / 3 + 0.05,
      `${s1?.sec?.toFixed(1)}秒 / 素${base.toFixed(1)}秒`);

    // 封印されている間、相手は本当に詠唱できない(効果自体は残っている)
    const castingB = () => Number(meB()?.castingIdx ?? -1);
    let blocked = true;
    for (let i = 0; i < 6; i++) {
      rB.send('cast', { idx: 0 });
      await sleep(150);
      if (castingB() >= 0) { blocked = false; break; }
    }
    check('封印中は相手が詠唱できない', blocked && Boolean(meB()?.sealed));

    const s2 = await castSeal();
    check('★2回目は短くなる', !!s2 && s2.sec > 0 && s2.sec < (s1?.sec ?? 0),
      `${s1?.sec?.toFixed(1)}秒 → ${s2?.sec?.toFixed(1)}秒`);

    const s3 = await castSeal();
    check('★3回目はレジストされる', !!s3 && s3.sec <= 0 && s3.resisted === true,
      `${s3?.sec?.toFixed(1)}秒 / ${s3?.reason ?? ''}`);
    check('レジストの理由が「連発」と分かる', s3?.reason === 'repeat', s3?.reason ?? '');

    // 立て続けに封印されても、相手が動ける時間が十分に残っていること
    const totalSealed = seals.reduce((sum, s) => sum + Math.max(0, s.sec), 0);
    console.log(`     3回ぶんの封印時間の合計: ${totalSealed.toFixed(1)}秒`);
    check('★3回掛けても止められるのは合計10秒以下', totalSealed <= 10,
      `${totalSealed.toFixed(1)}秒`);
  } finally {
    try { void ra?.leave(); void rb?.leave(); } catch { /* 切断済み */ }
    await sleep(1200);
    for (const n of [a, b]) await release(n);
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 800);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

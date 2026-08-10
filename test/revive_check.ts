// 蘇生(光×6)の検証。
//
//   ① 表として正しいか  ― 光6が蘇生系になり、光3の治癒を潰していないか
//   ② 共闘で本当に起き上がるか ― 実際に人を倒れさせて、蘇生光で戻す
//
// ②が本題。倒れた仲間を戻すのは「サーバーが状態を書き換える」ことなので、
// 画面を見ても分からない。実物のルームで確かめるしかない。
//
//   npx tsx test/revive_check.ts   (サーバー起動済みであること)

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { PLAYER_MAX_HP, RECIPES, REVIVE_HP_RATE, REVIVE_MANA_FLOOR } from '../shared/data';
import { finalStats, spellMagicValue } from '../shared/spellcraft';

const ENDPOINT = process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567';
const HTTP = ENDPOINT.replace(/^ws/, 'http');

const RUN = Math.random().toString(36).slice(2, 7);
const NAME_A = `rvA${RUN}`;   // 囮(ヘイトを稼いで倒れる役)
const NAME_B = `rvB${RUN}`;   // 蘇生する役
const TOKEN_A = `tok${RUN}A`;
const TOKEN_B = `tok${RUN}B`;

// 倒れてもらうために深いところへ行く。
// 深すぎると、囮が倒れた直後に蘇生役まで倒れて全滅で終わってしまう
// (ステージ9で実際にそうなった)。囮だけが落ちる深さを選ぶ。
const STAGE = Number(process.env.MADOKEN_STAGE ?? 6);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(cond: () => boolean, sec: number): Promise<boolean> {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(200);
  }
  return false;
}

async function releaseNames(): Promise<void> {
  for (const [name, token] of [[NAME_A, TOKEN_A], [NAME_B, TOKEN_B]]) {
    try {
      const r = await fetch(`${HTTP}/api/name/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token }),
      }).then(x => x.json() as Promise<{ released?: boolean }>);
      console.log(`     後片づけ: ${name} → ${r?.released ? '消した' : '消せなかった'}`);
    } catch (err) {
      console.log(`     後片づけ: ${name} → 失敗 (${(err as Error).message})`);
    }
  }
}

// ===== ① 表 =====
function checkTable(): void {
  console.log('=== ① 表(ブラウザもサーバーも要らない) ===');

  const revive = finalStats({ light: 6 }, 0, 'normal');
  check('★光×6は蘇生になる', revive.kind === 'revive', `kind=${revive.kind}`);
  check('蘇生は全体扱い', revive.targetAll);
  check(`消費MPに下限がある(${REVIVE_MANA_FLOOR})`,
    revive.manaCost >= REVIVE_MANA_FLOOR, `MP${revive.manaCost}`);
  check('再使用が長い(30秒)', revive.coolTime >= 30, `${revive.coolTime}秒`);

  // ★ ここが本当の見張り。RECIPES は成立順に上書きするので、
  //   条件のゆるい治癒(光3)を蘇生より後ろに置くと、光3が蘇生になってしまう。
  const heal3 = finalStats({ light: 3 }, 0, 'normal');
  const jiu = finalStats({ light: 3, water: 1 }, 0, 'normal');
  check('★光×3は今までどおり治癒のまま', heal3.kind === 'heal', `kind=${heal3.kind}`);
  check('★慈雨(光3+水1)も治癒のまま', jiu.kind === 'heal' && jiu.targetAll,
    `kind=${jiu.kind} 全体=${jiu.targetAll}`);

  const hit = RECIPES.filter(r => r.check({ light: 6 })).map(r => r.id);
  check('★蘇生がいちばん後ろで効く', hit[hit.length - 1] === 'sosei', hit.join(' → '));
  check('蘇生は慈雨より魔導値が高い',
    spellMagicValue(revive) > spellMagicValue(jiu),
    `${spellMagicValue(revive)} 対 ${spellMagicValue(jiu)}`);
}

// ===== ② 共闘で本当に起き上がるか =====
async function checkCoop(): Promise<void> {
  console.log(`\n=== ② 共闘で起き上がるか(ステージ${STAGE}) ===`);

  const ca = new Client(ENDPOINT);
  const cb = new Client(ENDPOINT);
  let roomA: Room | null = null;
  let roomB: Room | null = null;

  try {
    // A は攻撃役。撃つとヘイトが溜まるので、この人が先に倒れる。
    const spellsA = [{ name: '炎の魔弾', recipe: { fire: 2, wind: 1 } }];
    // B は蘇生だけを持つ。MPを他に使わないので、いつでも撃てる。
    const spellsB = [{ name: '蘇生光', recipe: { light: 6 } }];

    roomA = await ca.create('coop', {
      name: NAME_A, spells: spellsA, stage: STAGE, maxStage: STAGE, nickToken: TOKEN_A,
    });
    await sleep(400);
    const rooms = await cb.getAvailableRooms('coop');
    if (rooms.length === 0) { check('部屋が見つかる', false); return; }
    roomB = await cb.joinById(rooms[0].roomId, {
      name: NAME_B, spells: spellsB, maxStage: STAGE, nickToken: TOKEN_B,
    });

    // 蘇生の知らせを受け取ったか(画面に出す材料が届いているか)
    let revived: { name?: string; hp?: number } | null = null;
    roomB.onMessage('revive', (m: { name?: string; hp?: number }) => { revived = m; });
    // 受け取らないと colyseus.js が毎回警告を出して、肝心の行が埋もれる
    for (const room of [roomA, roomB]) {
      for (const t of ['phit', 'eproj', 'pproj', 'ehit', 'result', 'stageclear',
        'heal', 'shieldup', 'quake', 'seal', 'empower', 'focus', 'vigor', 'ward',
        'wardhit', 'taunt', 'dot', 'mateleft', 'pose', 'enemycast']) {
        room.onMessage(t, () => { /* 見ない */ });
      }
    }

    const stA = () => roomA!.state as any;
    const stB = () => roomB!.state as any;
    const meA = () => stA()?.players?.get(roomA!.sessionId);
    const aInB = () => stB()?.players?.get(roomA!.sessionId);

    check('2人そろう', await until(() => stA()?.players?.size === 2, 15));
    roomA.send('ready');
    roomB.send('ready');
    check('戦闘が始まる', await until(() => stA()?.phase === 'fight', 20));

    // ---- 先に「誰も倒れていない時」を見る ----
    //
    // 蘇生は空振りにせず、全員を大きく回復する。
    // 満タンでは差が出ないので、囮が殴られて減るまで待ってから撃つ。
    const bInB = () => stB()?.players?.get(roomB!.sessionId);

    // A だけ撃ち続ける。ヘイトが集まり、やがて倒れる。
    const swing = setInterval(() => {
      const me = meA();
      if (stA()?.phase === 'fight' && me?.alive && me.castingIdx === -1) {
        roomA!.send('cast', { idx: 0 });
      }
    }, 500);

    // 囮が半分以下まで削られたところで、蘇生光を1発。
    // この時点では誰も倒れていないので、回復として効くはず。
    const hurt = await until(
      () => (aInB()?.alive === true) && Number(aInB()?.hp ?? 999) < PLAYER_MAX_HP * 0.6, 90);
    check('囮が削られる(回復を測るための下ごしらえ)', hurt);
    if (hurt) {
      const aBefore = Number(aInB()?.hp ?? 0);
      const bBefore = Number(bInB()?.hp ?? 0);
      roomB.send('cast', { idx: 0 });
      const healed = await until(() => Number(aInB()?.hp ?? 0) > aBefore, 20);
      check('★誰も倒れていない時は回復になる', healed,
        `囮 ${aBefore} → ${Number(aInB()?.hp ?? 0)}`);
      // 蘇生役自身も対象。減っていなければ満タンのままなので、そこは責めない
      const bAfter = Number(bInB()?.hp ?? 0);
      check('★撃った本人にも効いている(減っていれば増える)',
        bBefore >= (bInB()?.maxHp ?? 0) || bAfter > bBefore,
        `蘇生役 ${bBefore} → ${bAfter}`);
    }

    const died = await until(() => aInB()?.alive === false, 180);
    clearInterval(swing);
    check('★囮が倒れる(ここまでは前提)', died,
      died ? '' : `${STAGE}階でも倒れなかった。MADOKEN_STAGE を上げて試す`);
    if (!died) return;

    const hpWhenDead = Number(aInB()?.hp ?? -1);
    check('倒れている間はHPが0', hpWhenDead === 0, `HP${hpWhenDead}`);

    // ここで B が蘇生光を撃つ
    await until(() => (stB()?.players?.get(roomB!.sessionId)?.castingIdx ?? -1) === -1, 10);
    roomB.send('cast', { idx: 0 });

    const back = await until(() => aInB()?.alive === true, 25);
    check('★蘇生光で起き上がる', back,
      back ? '' : (stB()?.phase === 'done'
        ? '蘇生役まで倒れて全滅した。MADOKEN_STAGE を下げて試す'
        : '起き上がらなかった'));
    if (back) {
      const hp = Number(aInB()?.hp ?? 0);
      const want = Math.round(PLAYER_MAX_HP * REVIVE_HP_RATE);
      // 起き上がった直後に殴られていることがあるので、上限だけ見る
      check(`★最大HPの${Math.round(REVIVE_HP_RATE * 100)}%で戻る`,
        hp > 0 && hp <= want, `HP${hp} (想定 ${want}以下・0より大)`);
      check('★蘇生の知らせが届く', revived !== null,
        revived ? JSON.stringify(revived) : '届かなかった');
    }
  } catch (err) {
    check('例外なく通る', false, (err as Error).message);
  } finally {
    try { await roomA?.leave(); } catch { /* もう閉じている */ }
    try { await roomB?.leave(); } catch { /* もう閉じている */ }
    await sleep(400);
  }
}

async function main(): Promise<void> {
  console.log('=== 蘇生(光×6) ===');
  console.log(`対象: ${ENDPOINT}`);
  checkTable();
  await checkCoop();
  await releaseNames();
  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  await sleep(200);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

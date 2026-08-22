// 「〇〇と交配」のボタンを誰に出すかの検証。ブラウザもサーバーも要らない。
//
//   npx tsx test/breed_button_check.ts
//
// ★ なぜ要るか(2026-08-21)。
//   以前は相手を全員ぶん並べて、組めない相手のボタンを押せない状態で
//   出していた。相手は「自分の手持ち + 交配所に預けられている全員」
//   なので、預かりが増えるほど押せないボタンが積み上がり、
//   押せる相手が埋もれた。♂♀が合わないだけで必ず半分は脱落する。
//
// ★ 減らしすぎる方向の事故も見張る。1羽も出せない時に何も出ないと、
//   説明書どおり「自分の鳥のカードにある〇〇と交配を押す」を探した人が
//   見つけられず、壊れていると読む。理由が出ることを確かめる。

import {
  BOARD_SETTLE_MS, BREED_COOLDOWN_MS, BREED_MAX_COUNT, DAY_MS, PET_SPECIES,
  breedOptions, petDisplayName,
} from '../shared/pets';
import type { Pet } from '../shared/pets';

let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

const 今 = 100 * DAY_MS;
const 雛日数 = PET_SPECIES.sparrow.chickDays;

// 何もしなければ「組める成鳥」になる鳥を作る。
// 組めない条件は、呼ぶ側で1つずつ足していく。
function 鳥(id: string, sex: Pet['sex'], 上書き: Partial<Pet> = {}): Pet {
  return {
    id, ownerName: '検証者', species: 'sparrow', name: id, sex,
    hpGene: 50, mpGene: 50, lifeGene: 50,
    warmCount: PET_SPECIES.sparrow.warmNeeded, lastWarmAt: 0,
    hatchedAt: 今 - (雛日数 + 1) * DAY_MS,
    boarded: false, boardedAt: 今 - BOARD_SETTLE_MS - 1, eggAt: 0, chosen: false,
    breedCount: 0, lastBredAt: 0, parents: null, bornAt: 0,
    ...上書き,
  };
}

console.log('=== 「〇〇と交配」のボタンを誰に出すか ===');

// ---- 1. 組める相手だけが残る ----
console.log('\n-- 組める相手だけを出す --');
{
  const 自分 = 鳥('自分', 'm');
  const 相手一覧 = [
    自分,                                   // 自分自身
    鳥('ハナ', 'f'),                        // 組める
    鳥('ソラ', 'f'),                        // 組める
    鳥('カイ', 'm'),                        // ♂どうし
    鳥('リク', 'm'),                        // ♂どうし
    鳥('ヒナ', 'f', { hatchedAt: 今 }),      // まだ雛
    鳥('ユキ', 'f', { breedCount: BREED_MAX_COUNT }),        // 打ち止め
    鳥('モモ', 'f', { lastBredAt: 今 - BREED_COOLDOWN_MS / 2 }), // 休憩中
    鳥('ナギ', 'f', { boarded: true, boardedAt: 今 }),        // なじみ待ち
  ];
  const { 相手, 案内 } = breedOptions(自分, 相手一覧, 今);
  const 名前 = 相手.map(petDisplayName).sort().join('・');

  確認(相手.length === 2, 'ボタンは2つだけ', `9羽中2羽 — ${名前}`);
  確認(名前 === 'ソラ・ハナ', '出るのはハナとソラ', 名前);
  確認(!相手.some(p => p.id === '自分'), '自分自身は相手に入らない');
  確認(案内 === null, '押せる相手が居るので案内文は出さない');
}

// ---- 2. この鳥自身の事情で1羽も組めない時 ----
// 全員ぶん同じ理由になるので、その理由をそのまま出す。
console.log('\n-- 自分の事情で組めない時は理由を出す --');
{
  const 休み中 = 鳥('自分', 'm', { lastBredAt: 今 - BREED_COOLDOWN_MS / 2 });
  const { 相手, 案内 } = breedOptions(休み中, [鳥('ハナ', 'f'), 鳥('ソラ', 'f')], 今);
  確認(相手.length === 0, 'ボタンは1つも出ない');
  確認(案内 !== null, '案内文が出る(黙って消さない)');
  確認(案内?.includes('休んでいる') === true, '休憩中であることが読める', 案内 ?? '(無し)');
  確認(案内?.includes('自分') === true, 'どの鳥の話か分かる', 案内 ?? '(無し)');
}

{
  const 打ち止め = 鳥('自分', 'm', { breedCount: BREED_MAX_COUNT });
  const { 案内 } = breedOptions(打ち止め, [鳥('ハナ', 'f')], 今);
  確認(案内?.includes('もう産めない') === true,
    '打ち止めなら打ち止めと読める', 案内 ?? '(無し)');
}

// ---- 3. 相手それぞれの事情で組めない時 ----
console.log('\n-- 相手ごとに事情が違う時はまとめて一言 --');
{
  const 自分 = 鳥('自分', 'm');
  const { 相手, 案内 } = breedOptions(自分, [
    鳥('カイ', 'm'),                                  // ♂どうし
    鳥('ヒナ', 'f', { hatchedAt: 今 }),                // まだ雛
    鳥('ユキ', 'f', { breedCount: BREED_MAX_COUNT }),  // 打ち止め
  ], 今);
  確認(相手.length === 0, 'ボタンは1つも出ない');
  確認(案内 === '今は交配できる相手がいません。',
    '理由がばらばらなのでまとめて一言', 案内 ?? '(無し)');
}

// ---- 4. そもそも相手が居ない時 ----
console.log('\n-- 相手が1羽も居ない時 --');
{
  const 自分 = 鳥('自分', 'm');
  const { 相手, 案内 } = breedOptions(自分, [自分], 今);
  確認(相手.length === 0, 'ボタンは出ない');
  確認(案内 === null,
    '相手が居ないだけなら案内文も出さない(断られてはいないため)');
}

// ---- 5. 預けたままの鳥とも組める(2026-08-15の指摘を壊していないか) ----
console.log('\n-- 預けたままでも組める --');
{
  const 預け中 = 鳥('自分', 'm', { boarded: true, boardedAt: 今 - BOARD_SETTLE_MS - 1 });
  const 相手も預け中 = 鳥('ハナ', 'f', { boarded: true, boardedAt: 今 - BOARD_SETTLE_MS - 1 });
  const { 相手 } = breedOptions(預け中, [相手も預け中], 今);
  確認(相手.length === 1, '双方が交配所に預けたままでもボタンが出る');
}

console.log('');
if (失敗数 === 0) {
  console.log('すべて合格。押せる相手だけが並び、出せない時は理由が出る。');
} else {
  console.error(`${失敗数}件 失敗。`);
  process.exit(1);
}

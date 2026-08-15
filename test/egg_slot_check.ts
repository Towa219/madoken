// 鳥と卵で枠を分けた後の決まりを確かめる。
//
//   ADMIN_KEY=test1234 PORT=2571 npx tsx server/index.ts
//   ADMIN_KEY=test1234 PET_TEST_URL=http://localhost:2571 npx tsx test/egg_slot_check.ts
//
// ★ 何を守りたいか(2026-08-15に枠を分けた)。
//   卵は自分の意思と関係なく届く(ボスの卵・交配のお礼の卵)ので、
//   鳥と同じ枠だと「鳥を育てているせいで卵を取り逃す」ことになる。
//   そこで 鳥6羽 / 卵4個 の別枠にした。
//
// ★ 分けたことで新しく開く穴がこれ。
//   卵を4個ためてから一気に孵せば、鳥の上限6羽を越えられる。
//   だから孵化(最後の1回の温め)には鳥の枠の空きを要求している。
//   ここが破れると上限そのものが意味を失うので、重点的に見る。
//
// ★ 温めた回数を消費してから断ってはいけない。
//   断られたのに回数だけ減っていたら、ただの取り上げになる。

import { MAX_EGGS, MAX_PETS } from '../shared/pets';
import type { WirePet } from '../shared/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2571';
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

async function 通信(経路: string, name: string, 追加: Record<string, unknown> = {}) {
  const 応答 = await fetch(`${基点}/api/pet/${経路}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 合言葉, name, token: `tok_${name}`, ...追加 }),
  });
  return { 状態: 応答.status, データ: await 応答.json() as Record<string, unknown> };
}

const 一覧 = async (name: string) => (await 通信('list', name)).データ.pets as WirePet[];
const 卵の数 = async (name: string) =>
  (await 一覧(name)).filter(p => p.hatchedAt <= 0 && !p.boarded).length;
const 鳥の数 = async (name: string) =>
  (await 一覧(name)).filter(p => p.hatchedAt > 0 && !p.boarded).length;

// 卵を1つ孵す。孵らなければ最後の応答を返す。
async function 孵す(name: string, petId: string) {
  let 最後 = { 状態: 0, データ: {} as Record<string, unknown> };
  for (let i = 0; i < 8; i++) {
    await 通信('advance', name, { days: 1 });
    最後 = await 通信('warm', name, { petId });
    if (最後.状態 !== 200) return 最後;
    if ((最後.データ.hatched as boolean) === true) return 最後;
  }
  return 最後;
}

async function 実行(): Promise<void> {
  console.log('=== 鳥と卵の枠 ===');
  console.log(`  鳥 ${MAX_PETS}羽 / 卵 ${MAX_EGGS}個`);
  const 名 = `枠${Date.now().toString(36).slice(-5)}`;

  // ---- 1. 卵の上限 ----
  for (let i = 0; i < MAX_EGGS; i++) {
    const r = await 通信('grant', 名, { stage: 1 });
    確認(r.状態 === 200, `${i + 1}個目の卵を受け取れる`, String(r.データ.error ?? ''));
  }
  const 溢れ = await 通信('grant', 名, { stage: 1 });
  確認(溢れ.状態 === 400, `${MAX_EGGS + 1}個目は断られる`,
    `${溢れ.状態} ${String(溢れ.データ.error ?? '')}`);
  確認(await 卵の数(名) === MAX_EGGS, `卵はちょうど${MAX_EGGS}個`);

  // ---- 2. 卵を孵すと卵の枠が空き、鳥が増える ----
  const 卵たち = (await 一覧(名)).filter(p => p.hatchedAt <= 0);
  const r1 = await 孵す(名, 卵たち[0].id);
  確認((r1.データ.hatched as boolean) === true, '卵は孵る',
    String(r1.データ.error ?? ''));
  確認(await 鳥の数(名) === 1, '鳥が1羽になった');
  確認(await 卵の数(名) === MAX_EGGS - 1, `卵の枠が1つ空いた`);
  const 補充 = await 通信('grant', 名, { stage: 1 });
  確認(補充.状態 === 200, '空いた枠に新しい卵を受け取れる');

  // ---- 3. 鳥を上限まで増やす ----
  console.log(`  鳥を${MAX_PETS}羽まで増やします…`);
  while (await 鳥の数(名) < MAX_PETS) {
    let 卵 = (await 一覧(名)).find(p => p.hatchedAt <= 0 && !p.boarded);
    if (!卵) {
      const g = await 通信('grant', 名, { stage: 1 });
      if (g.状態 !== 200) break;
      卵 = g.データ.pet as WirePet;
    }
    const r = await 孵す(名, 卵.id);
    if (r.状態 !== 200) break;
  }
  確認(await 鳥の数(名) === MAX_PETS, `鳥が${MAX_PETS}羽になった`,
    `${await 鳥の数(名)}羽`);

  // ---- 4. ★本題。鳥が満杯でも卵は受け取れる ----
  const 満杯でも卵 = await 通信('grant', 名, { stage: 1 });
  確認(満杯でも卵.状態 === 200, '鳥が満杯でも卵は受け取れる(枠が別だから)',
    String(満杯でも卵.データ.error ?? ''));

  // ---- 5. ★本題。鳥が満杯なら孵らない ----
  const 孵せぬ卵 = (await 一覧(名)).find(p => p.hatchedAt <= 0 && !p.boarded)!;
  const 前の回数 = 孵せぬ卵.warmCount;
  const 結果 = await 孵す(名, 孵せぬ卵.id);
  確認(結果.状態 === 400, '鳥が満杯だと孵らない(上限をすり抜けられない)',
    `${結果.状態} ${String(結果.データ.error ?? '')}`);
  確認(String(結果.データ.error ?? '').includes('鳥がいっぱい'),
    '断る理由が「鳥がいっぱい」になっている', String(結果.データ.error ?? ''));
  確認(await 鳥の数(名) === MAX_PETS, `鳥は${MAX_PETS}羽のまま`, `${await 鳥の数(名)}羽`);

  // 断られた時に温めた回数を取り上げていないこと(最後の1回ぶんは残る)
  const 今の卵 = (await 一覧(名)).find(p => p.id === 孵せぬ卵.id)!;
  const 残り = (今の卵.hint?.warmNeeded ?? 0) - 今の卵.warmCount;
  確認(残り === 1, '断られた卵は「あと1回」で止まっている(回数を取り上げていない)',
    `あと${残り}回 / 温めた回数 ${前の回数}→${今の卵.warmCount}`);

  // ---- 6. 鳥を1羽減らすと孵せるようになる ----
  const 手放す鳥 = (await 一覧(名)).find(p => p.hatchedAt > 0 && !p.boarded)!;
  await 通信('release', 名, { petId: 手放す鳥.id });
  確認(await 鳥の数(名) === MAX_PETS - 1, '鳥を1羽手放した');
  const 再挑戦 = await 孵す(名, 孵せぬ卵.id);
  確認((再挑戦.データ.hatched as boolean) === true, '枠が空くと孵る',
    String(再挑戦.データ.error ?? ''));

  console.log(失敗数 === 0 ? '=== 合格 ===' : `=== ${失敗数}件 失敗 ===`);
  process.exit(失敗数 === 0 ? 0 : 1);
}

void 実行().catch(e => {
  console.error('検証そのものが失敗:', e);
  process.exit(1);
});

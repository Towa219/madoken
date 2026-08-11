// 同時に叩いた時に、制限をすり抜けられないかを確かめる。
//
//   ADMIN_KEY=test1234 PORT=28xx npx tsx server/index.ts
//   ADMIN_KEY=test1234 PET_TEST_URL=http://localhost:28xx npx tsx test/pet_race_check.ts
//
// ★ 「読んで、直して、書く」経路はすべて割り込まれる。
//   直列化を grant にだけ掛けても意味がない。grant は管理者専用に
//   戻ったので、むしろいちばん危険度が低い経路になっている。
//
// ★ この検証がローカル(Upstash未設定=メモリ)で通っても保証にはならない。
//   本番は Upstash への往復があり、割り込む窓がずっと広い。
//   ここで破れたら本番では確実に破れる、という向きにだけ使える。

import { MAX_PETS, PET_SPECIES, BREED_MAX_COUNT } from '../shared/pets';
import type { Pet, WirePet } from '../shared/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2567';
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
let 失敗数 = 0;

function 確認(条件: boolean, 文: string): void {
  if (条件) console.log(`合格: ${文}`);
  else { console.error(`失敗: ${文}`); 失敗数 += 1; }
}

async function 通信(経路: string, name: string, 追加: Record<string, unknown> = {}) {
  const 応答 = await fetch(`${基点}/api/pet/${経路}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 合言葉, name, token: `tok_${name}`, ...追加 }),
  });
  return { 状態: 応答.status, データ: await 応答.json() as Record<string, unknown> };
}

async function 一覧(name: string): Promise<WirePet[]> {
  return (await 通信('list', name)).データ.pets as WirePet[];
}

// 卵を1つ出して、孵るまで温める
async function 育てる(name: string): Promise<Pet> {
  let pet = (await 通信('grant', name, { stage: 1 })).データ.pet as WirePet;
  while (!pet.species) {
    await 通信('advance', name, { days: 1 });
    pet = (await 通信('warm', name, { petId: pet.id })).データ.pet as WirePet;
  }
  return pet as Pet;
}

async function 実行(): Promise<void> {
  console.log('=== 同時に叩いた時の制限のすり抜け ===');
  const 印 = Date.now().toString(36).slice(-5);

  // ---- 1. 温めを同時に叩く ----
  // 20時間に1回しか進まないはずが、同時なら複数回進むか
  const 温め名 = `温${印}`;
  const 卵 = (await 通信('grant', 温め名, { stage: 1 })).データ.pet as WirePet;
  await 通信('advance', 温め名, { days: 1 });   // 1回ぶん温められる状態にする
  const 同時温め = await Promise.all(
    Array.from({ length: 6 }, () => 通信('warm', 温め名, { petId: 卵.id })),
  );
  const 成功数 = 同時温め.filter(r => r.状態 === 200).length;
  const 後 = (await 一覧(温め名)).find(p => p.id === 卵.id);
  console.log(`実測: 同時6本 → 200が${成功数}件、温めた回数=${後?.warmCount}`);
  確認(後?.warmCount === 1,
    `1回ぶんの間隔で温めは1回だけ進む → 実測 ${後?.warmCount}回`);

  // ---- 2. 交配を同時に叩く ----
  // 生涯3回・20時間に1回のはずが、同時なら超えるか
  const 親A = `親A${印}`; const 親B = `親B${印}`;
  let 雄 = await 育てる(親A);
  while (雄.sex !== 'm') { await 通信('release', 親A, { petId: 雄.id }); 雄 = await 育てる(親A); }
  let 雌 = await 育てる(親A);
  while (雌.sex !== 'f') { await 通信('release', 親A, { petId: 雌.id }); 雌 = await 育てる(親A); }
  // 成鳥まで進める
  const 育ち = Math.max(PET_SPECIES[雄.species].chickDays, PET_SPECIES[雌.species].chickDays);
  await 通信('advance', 親A, { days: 育ち + 1 });
  const 交配前 = await 一覧(親A);
  確認(交配前.find(p => p.id === 雄.id)?.boarded === false
    && 交配前.find(p => p.id === 雌.id)?.boarded === false,
  '自分同士の両親はどちらも交配所へ預けていない');

  const 同時交配 = await Promise.all(
    Array.from({ length: 5 }, () => 通信('breed', 親A, { petId: 雄.id, partnerId: 雌.id })),
  );
  const 交配成功 = 同時交配.filter(r => r.状態 === 200).length;
  const 親一覧 = await 一覧(親A);
  const 雄後 = 親一覧.find(p => p.id === 雄.id);
  console.log(`実測: 同時5本 → 200が${交配成功}件、雄の交配回数=${雄後?.breedCount}`);
  確認(交配成功 === 1,
    `間隔20時間のため同時交配は1回しか通らない → 実測 ${交配成功}件`);
  確認(雄後?.breedCount === 1,
    `交配回数が二重に増えない → 実測 ${雄後?.breedCount}回`);

  // ---- 3. 自分どうしの交配で卵が1個だけか ----
  const 増えた = 親一覧.filter(p => p.parents !== null).length;
  console.log(`実測: 自分どうしの交配で手持ち${交配前.length}羽→${親一覧.length}羽、増えた卵=${増えた}個`);
  確認(増えた === 1 && 親一覧.length === 交配前.length + 1,
    `自分どうしの交配では卵が1個だけ増える(お礼の二重配布が無い) → 実測 ${増えた}個`);

  // ---- 4. 手放しを同時に叩く ----
  const 捨て名 = `捨${印}`;
  const 捨て卵 = (await 通信('grant', 捨て名, { stage: 1 })).データ.pet as WirePet;
  const 同時捨て = await Promise.all(
    Array.from({ length: 5 }, () => 通信('release', 捨て名, { petId: 捨て卵.id })),
  );
  console.log(`実測: 同時5本の手放し → 200が${同時捨て.filter(r => r.状態 === 200).length}件、`
    + `残り=${(await 一覧(捨て名)).length}羽`);
  確認((await 一覧(捨て名)).length === 0, '手放しを同時に叩いても壊れない');

  // ---- 5. 預け入れと引き取りを同時に叩く ----
  const 預け名 = `預${印}`;
  const 預け卵 = (await 通信('grant', 預け名, { stage: 1 })).データ.pet as WirePet;
  await Promise.all([
    ...Array.from({ length: 5 }, () => 通信('board', 預け名, { petId: 預け卵.id })),
    ...Array.from({ length: 5 }, () => 通信('unboard', 預け名, { petId: 預け卵.id })),
  ]);
  const 最終応答 = await 通信('list', 預け名);
  const 最終本体 = (最終応答.データ.pets as WirePet[]).find(p => p.id === 預け卵.id);
  const 写し数 = (最終応答.データ.board as WirePet[]).filter(p => p.id === 預け卵.id).length;
  console.log(`実測: board/unboard各5本 → 本体boarded=${最終本体?.boarded}、交配所の写し=${写し数}件`);
  確認(Boolean(最終本体?.boarded) === (写し数 === 1) && 写し数 <= 1,
    `同時預け入れ・引き取り後も本体と交配所が一致する → 写し${写し数}件`);

  console.log();
  console.log(`(上限は${MAX_PETS}羽 / 交配は生涯${BREED_MAX_COUNT}回)`);
  if (失敗数) { console.error(`検証終了: ${失敗数}件失敗しました。`); process.exit(1); }
  console.log('検証終了: 全項目に合格しました。');
}

実行().catch((err: unknown) => {
  console.error(`失敗: 検証を続けられませんでした。${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

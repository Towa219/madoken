// 公開前ペット機能の追加検証。
// ADMIN_KEY=test1234 PORT=2808 npx tsx --require ./test/tsx_userinfo_patch.cjs server/index.ts
// ADMIN_KEY=test1234 PET_TEST_URL=http://localhost:2808 npx tsx --require ./test/tsx_userinfo_patch.cjs test/pet_public_check.ts
import {
  DAY_MS, DEAD_KEEP_DAYS, MAX_PETS, PET_SPECIES, countHeld, lifetimeMsOf, shouldPurge,
} from '../shared/pets';
import type { Pet, WirePet } from '../shared/pets';
import { listPets, savePets } from '../server/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2808';
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
const 印 = Date.now().toString(36).slice(-6);
let 失敗 = 0;
function 確認(条件: boolean, 文: string): void {
  console.log(`${条件 ? '成功' : '失敗'}: ${文}`); if (!条件) 失敗++;
}
async function 通信(
  経路: string, name: string, token: string, 追加: Record<string, unknown> = {}, key?: string,
) {
  const body: Record<string, unknown> = { name, token, ...追加 };
  if (key !== undefined) body.key = key;
  const r = await fetch(`${基点}/api/pet/${経路}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { 状態: r.status, データ: await r.json() as Record<string, any> };
}
const トークン = (name: string) => `token-${name}-${印}`;
async function 管理(経路: string, name: string, 追加: Record<string, unknown> = {}) {
  return 通信(経路, name, トークン(name), 追加, 合言葉);
}
async function 玩家(経路: string, name: string, 追加: Record<string, unknown> = {}) {
  return 通信(経路, name, トークン(name), 追加);
}
async function 一覧(name: string, board = true): Promise<WirePet[]> {
  return (await 玩家('list', name, { board })).データ.pets as WirePet[];
}
async function 孵化(name: string, egg: WirePet): Promise<Pet> {
  let p = egg;
  while (p.warmCount < (p.hint?.warmNeeded ?? 3)) {
    await 管理('advance', name, { days: 1 });
    p = (await 玩家('warm', name, { petId: p.id })).データ.pet as WirePet;
  }
  return p as Pet;
}
async function 成鳥(name: string, sex?: Pet['sex']): Promise<Pet> {
  for (;;) {
    const e = (await 管理('grant', name, { stage: 1 })).データ.pet as WirePet;
    if (sex && e.sex !== sex) { await 玩家('release', name, { petId: e.id }); continue; }
    const p = await 孵化(name, e);
    await 管理('advance', name, { days: PET_SPECIES[p.species].chickDays });
    return (await 一覧(name)).find(x => x.id === p.id) as Pet;
  }
}

async function 実行(): Promise<void> {
  const 認証名 = `認証${印}`;
  await 管理('grant', 認証名, { stage: 1 });
  const 正 = await 玩家('list', 認証名);
  const 誤 = await 通信('list', 認証名, `wrong-${印}`, { board: false });
  確認(正.状態 === 200 && 誤.状態 === 403, `nickToken 正=${正.状態}、相違=${誤.状態}`);

  const board無し = await 玩家('list', 認証名, { board: false });
  const board有り = await 玩家('list', 認証名, { board: true });
  確認(Array.isArray(board無し.データ.board) && board無し.データ.board.length === 0
    && Array.isArray(board有り.データ.board), `board切替: false=${board無し.データ.board.length}件、true=${board有り.データ.board.length}件`);

  const 管理名 = `管理${印}`;
  const grant札だけ = await 玩家('grant', 管理名, { stage: 1 });
  const grant鍵 = await 管理('grant', 管理名, { stage: 1 });
  const advance札だけ = await 玩家('advance', 管理名, { days: 1 });
  const advance鍵 = await 管理('advance', 管理名, { days: 1 });
  const 巨大 = await 管理('advance', 管理名, { days: 3651 });
  確認(grant札だけ.状態 === 403 && grant鍵.状態 === 200,
    `grant はnickTokenのみ=${grant札だけ.状態}、ADMIN_KEY=${grant鍵.状態}`);
  確認(advance札だけ.状態 === 403 && advance鍵.状態 === 200,
    `advance はnickTokenのみ=${advance札だけ.状態}、ADMIN_KEY=${advance鍵.状態}`);
  確認(巨大.状態 === 400, `advance 3651日=${巨大.状態}`);

  const 同時名 = `同時${印}`;
  const 同時 = await Promise.all(Array.from({ length: 10 }, () => 管理('grant', 同時名, { stage: 1 })));
  const 同時数 = (await 一覧(同時名)).length;
  確認(同時数 === MAX_PETS && 同時.filter(r => r.状態 === 200).length === MAX_PETS,
    `grant 10件同時: 成功=${同時.filter(r => r.状態 === 200).length}件、最終=${同時数}羽`);

  const 自交名 = `自交${印}`;
  const 一 = await 成鳥(自交名);
  const 二 = await 成鳥(自交名, 一.sex === 'm' ? 'f' : 'm');
  await 玩家('board', 自交名, { petId: 二.id });
  const 前 = (await 一覧(自交名)).length;
  const 交配 = await 玩家('breed', 自交名, { petId: 一.id, partnerId: 二.id });
  const 後一覧 = await 一覧(自交名); const 後 = 後一覧.length;
  確認(交配.状態 === 200 && 後 === 前 + 1, `自分同士の交配: 前=${前}羽、後=${後}羽、増加=${後 - 前}`);
  確認(後一覧.find(p => p.id === 一.id)?.breedCount === 1
    && 後一覧.find(p => p.id === 二.id)?.breedCount === 1, '自分同士の両親へ交配回数が各1回記録された');

  const now = Date.now();
  const dead: Pet = {
    ...一, id: `dead-${印}`, ownerName: `整理${印}`, boarded: false, chosen: false,
    hatchedAt: now - lifetimeMsOf(一) - DAY_MS, bornAt: now - lifetimeMsOf(一) - DAY_MS,
  };
  確認(countHeld([dead], now) === 0, `死亡個体の使用枠=${countHeld([dead], now)}`);
  const purgeName = `整理${印}`;
  const purge: Pet = { ...dead, ownerName: purgeName,
    hatchedAt: now - lifetimeMsOf(dead) - DEAD_KEEP_DAYS * DAY_MS - 1 };
  await savePets(purgeName, [purge]);
  確認(shouldPurge(purge, now) && (await listPets(purgeName)).length === 0,
    `死亡後${DEAD_KEEP_DAYS}日経過: listPets=${(await listPets(purgeName)).length}羽`);

  // 合言葉を外す検証は必ず最後。ロック回避のため1回だけにする。
  const 合言葉無し = await 通信('grant', `鍵無し${印}`, トークン(`鍵無し${印}`), { stage: 1 });
  確認(合言葉無し.状態 === 403, `最後の合言葉なしgrant=${合言葉無し.状態}`);

  if (失敗) throw new Error(`${失敗}件の検証に失敗しました。`);
  console.log('追加検証はすべて成功しました。');
}
void 実行().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

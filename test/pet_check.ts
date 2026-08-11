// ペットAPIの検証。
//
//   ADMIN_KEY=test1234 PORT=2767 npx tsx server/index.ts   … 先にサーバーを起こす
//   ADMIN_KEY=test1234 PET_TEST_URL=http://localhost:2767 npx tsx test/pet_check.ts
//
// ★ 卵の中身が本当に伏せられているかも、ここで見る。
//   画面で隠すだけでは意味が無い(開発者ツールで JSON を覗けば読める)ので、
//   サーバーの返事そのものに species が入っていないことを確かめる。
import { BREED_JITTER, MAX_PETS, PET_SPECIES, PET_SPECIES_ORDER } from '../shared/pets';
import type { Pet, WirePet } from '../shared/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2567';
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
const 経路 = ['list', 'grant', 'warm', 'rename', 'release', 'board', 'unboard', 'breed', 'advance'];
let 失敗数 = 0;

function 合格(文: string): void { console.log(`合格: ${文}`); }
function 失敗(文: string): void { console.error(`失敗: ${文}`); 失敗数 += 1; }
function 確認(条件: boolean, 文: string): void { 条件 ? 合格(文) : 失敗(文); }

async function 通信(経路名: string, name: string, 追加: Record<string, unknown> = {}, key: string | null = 合言葉) {
  const 本文: Record<string, unknown> = { name, ...追加 };
  if (key !== null) 本文.key = key;
  const 応答 = await fetch(`${基点}/api/pet/${経路名}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(本文),
  });
  const データ = await 応答.json() as Record<string, unknown>;
  return { 状態: 応答.status, データ };
}

async function 一覧(name: string): Promise<WirePet[]> {
  return (await 通信('list', name)).データ.pets as WirePet[];
}

// 卵はサーバーが種類を伏せているので、残り回数は手がかりから数える。
function 残り温め(卵: WirePet): number {
  const 必要 = 卵.hint?.warmNeeded ?? PET_SPECIES.sparrow.warmNeeded;
  return Math.max(0, 必要 - 卵.warmCount);
}

// 孵るまで温め続ける。孵った時だけ species が返ってくる。
async function 孵化(name: string, 卵: WirePet): Promise<Pet> {
  let 今: WirePet = 卵;
  while (残り温め(今) > 0) {
    await 通信('advance', name, { days: 1 });
    const 結果 = await 通信('warm', name, { petId: 今.id });
    今 = 結果.データ.pet as WirePet;
  }
  return 今 as Pet;
}

async function 卵をひとつ(name: string): Promise<WirePet> {
  return (await 通信('grant', name, { stage: 1 })).データ.pet as WirePet;
}

async function 性別の卵(name: string, sex?: Pet['sex']): Promise<WirePet> {
  for (;;) {
    const pet = await 卵をひとつ(name);
    if (!sex || pet.sex === sex) return pet;
    await 通信('release', name, { petId: pet.id });
  }
}

async function 実行(): Promise<void> {
  console.log('ペットAPI検証を開始します。');
  for (const path of 経路) {
    const 無し = await 通信(path, '権限試験', {}, null);
    確認(無し.状態 === 403, `合言葉なし /api/pet/${path} → 実測 ${無し.状態}`);
    const 誤り = await 通信(path, '権限試験', {}, '違う合言葉');
    確認(誤り.状態 === 403, `誤った合言葉 /api/pet/${path} → 実測 ${誤り.状態}`);
  }

  // ---- 卵のうちは種類が届かない ----
  const 秘密名 = `伏せ試験${Date.now()}`;
  const 生卵 = await 卵をひとつ(秘密名);
  確認(生卵.species === null || 生卵.species === undefined,
    `出したての卵に species が入っていない → 実測 ${JSON.stringify(生卵.species)}`);
  確認(Boolean(生卵.hint), '代わりに手がかり(hint)が付いてくる');
  if (生卵.hint) {
    console.log(`     手がかり: ${生卵.hint.size}・殻は${生卵.hint.shell}・${生卵.hint.pattern}`
      + `・温め${生卵.hint.warmNeeded}回`);
  }
  const 一覧の卵 = (await 一覧(秘密名))[0];
  確認(一覧の卵?.species === null || 一覧の卵?.species === undefined,
    '一覧の返事にも卵の species が入っていない');
  // 生の本文にも文字列として現れないこと(入れ子や別名で漏れていないか)。
  // 交配所は他人の孵った鳥が並ぶ場所なので、自分の手持ちだけを見る。
  const 生本文 = JSON.stringify((await 通信('list', 秘密名)).データ.pets);
  const 漏れ = PET_SPECIES_ORDER.filter(id => 生本文.includes(`"${id}"`));
  確認(漏れ.length === 0, `返事の本文に種類名が現れない → 実測 ${漏れ.join(',') || 'なし'}`);
  await 通信('release', 秘密名, { petId: 生卵.id });

  // ---- 孵化 ----
  const 孵化名 = `孵化試験${Date.now()}`;
  const 発行 = await 通信('grant', 孵化名, { stage: 1 });
  確認(発行.状態 === 200, '正しい合言葉で卵を出せる');
  let 卵 = 発行.データ.pet as WirePet;
  const 直後 = await 通信('warm', 孵化名, { petId: 卵.id });
  確認(直後.状態 === 400, '発行直後は温める間隔不足で断られる');
  let 孵ったと言われたか = false;
  while (残り温め(卵) > 0) {
    確認((await 通信('advance', 孵化名, { days: 1 })).状態 === 200, '+1日進められる');
    const 温め = await 通信('warm', 孵化名, { petId: 卵.id });
    確認(温め.状態 === 200, '間隔後は温められる');
    卵 = 温め.データ.pet as WirePet;
    if (温め.データ.hatched === true) 孵ったと言われたか = true;
  }
  確認(孵ったと言われたか, '最後の温めで hatched: true が返る(演出の合図)');
  確認(Boolean(卵.species) && PET_SPECIES_ORDER.includes(卵.species!),
    `孵った瞬間に種類が明かされる → 実測 ${String(卵.species)}`);

  const 孵化一覧 = await 一覧(孵化名);
  確認((孵化一覧[0]?.hatchedAt ?? 0) > 0, '規定回数の温めで孵化する');
  const 段階応答 = await 通信('list', 孵化名);
  const 現在 = Number(段階応答.データ.now);
  const 孵化個体 = (段階応答.データ.pets as Pet[])[0];
  const chick = 孵化個体.hatchedAt > 0
    && 現在 - 孵化個体.hatchedAt < PET_SPECIES[孵化個体.species].chickDays * 24 * 60 * 60 * 1000;
  確認(chick, '孵化直後の段階が chick である');

  const 上限名 = `上限試験${Date.now()}`;
  for (let i = 0; i < MAX_PETS; i++) await 通信('grant', 上限名, { stage: 1 });
  確認((await 通信('grant', 上限名, { stage: 1 })).状態 === 400, 'MAX_PETSを超える卵は断られる');

  // ---- 交配 ----
  const 親一名 = `親一${Date.now()}`; const 親二名 = `親二${Date.now()}`;
  const 卵一 = await 性別の卵(親一名);
  const 卵二 = await 性別の卵(親二名, 卵一.sex === 'm' ? 'f' : 'm');
  let 親一 = await 孵化(親一名, 卵一); let 親二 = await 孵化(親二名, 卵二);
  await 通信('advance', 親一名, { days: PET_SPECIES[親一.species].chickDays });
  await 通信('advance', 親二名, { days: PET_SPECIES[親二.species].chickDays });
  親一 = (await 一覧(親一名)).find(p => p.id === 親一.id)! as Pet;
  親二 = (await 一覧(親二名)).find(p => p.id === 親二.id)! as Pet;
  確認((await 通信('board', 親二名, { petId: 親二.id })).状態 === 200, '成鳥を交配所へ預けられる');
  const 交配 = await 通信('breed', 親一名, { petId: 親一.id, partnerId: 親二.id });
  確認(交配.状態 === 200, '♂♀の成鳥を交配できる');
  const 子 = 交配.データ.pet as WirePet;
  確認(子.species === null || 子.species === undefined, '交配で出来た卵も種類が伏せられている');
  for (const 項目 of ['hpGene', 'mpGene', 'lifeGene'] as const) {
    const 中央 = (親一[項目] + 親二[項目]) / 2;
    確認(Math.abs(子[項目] - 中央) <= BREED_JITTER + 1, `子の${項目}が両親の範囲の近くにある`);
  }
  const お礼 = await 一覧(親二名);
  確認(お礼.some(p => p.parents?.includes(親一.id)), '預けた側にもお礼の卵が追加される');

  if (失敗数) { console.error(`検証終了: ${失敗数}件失敗しました。`); process.exit(1); }
  console.log('検証終了: 全項目に合格しました。');
}

実行().catch((err: unknown) => {
  console.error(`失敗: 検証を続けられませんでした。${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

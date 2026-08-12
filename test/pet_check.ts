// ペットAPIの検証。
//
//   ADMIN_KEY=test1234 PORT=2767 npx tsx server/index.ts   … 先にサーバーを起こす
//   ADMIN_KEY=test1234 PET_TEST_URL=http://localhost:2767 npx tsx test/pet_check.ts
//
// ★ 卵の中身が本当に伏せられているかも、ここで見る。
//   画面で隠すだけでは意味が無い(開発者ツールで JSON を覗けば読める)ので、
//   サーバーの返事そのものに species が入っていないことを確かめる。
import {
  BLUEBIRD_RATE, BOARD_SETTLE_HOURS, BREED_JITTER, BREED_MAX_COUNT, COMMON_SPECIES, DEAD_KEEP_DAYS,
  ELDER_DAYS, MAX_PETS,
  PET_NAMES, PET_SPECIES, PET_SPECIES_ORDER, breed, eggHintOf, eggSpeciesForBoss,
  adultDaysOf, partyBonusOf, stageOf,
} from '../shared/pets';
import type { Pet, WirePet } from '../shared/pets';
import { PLAYER_MAX_HP, PLAYER_MAX_MP } from '../shared/data';
import { Client } from 'colyseus.js';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2567';
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
let 失敗数 = 0;

// ★ 検証で使う名前は短くすること。
//   ニックネームは全角10文字(半角20文字)までで、それを超えると
//   claimName が弾く。本人確認を入れてから、`伏${印}` のような
//   名前が403になり、一覧が空で返って検証が途中で落ちた。
//   36進数の下4桁なら、全角2文字と合わせても幅8で収まる。
const 印 = Date.now().toString(36).slice(-4);

function 合格(文: string): void { console.log(`合格: ${文}`); }
function 失敗(文: string): void { console.error(`失敗: ${文}`); 失敗数 += 1; }
function 確認(条件: boolean, 文: string): void { 条件 ? 合格(文) : 失敗(文); }

async function 通信(経路名: string, name: string, 追加: Record<string, unknown> = {}, key: string | null = 合言葉) {
  // ★ token を必ず添える。公開向けの変更で list/warm/choose/release/
  //   board/unboard/breed は「名前の持ち主か」を見るようになった
  //   (server/names.ts の claimName)。合言葉だけでは通らない。
  //   これを送らないと一覧が空で返り、検証が途中で落ちる。
  const 本文: Record<string, unknown> = { name, token: `tok_${name}`, ...追加 };
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
  // ---- 卵のうちは種類が届かない ----
  const 秘密名 = `伏${印}`;
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
  const 孵化名 = `孵${印}`;
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

  // ★ 名前は孵った瞬間にサーバーが決める。持ち主には選ばせない
  //   (交配所で他人にも見えるので、入力させると不適切な名前の出口になる)。
  確認(PET_NAMES.includes(卵.name),
    `名前が一覧の中から自動で決まる → 実測 「${卵.name}」`);
  const 改名 = await 通信('rename', 孵化名, { petId: 卵.id, petName: 'すきな名前' });
  確認(改名.状態 === 400, `正しい合言葉でも名前は変えられない → 実測 ${改名.状態}`);
  確認((await 一覧(孵化名)).find(p => p.id === 卵.id)?.name === 卵.name,
    '断られた後も名前が書き換わっていない');

  const 孵化一覧 = await 一覧(孵化名);
  確認((孵化一覧[0]?.hatchedAt ?? 0) > 0, '規定回数の温めで孵化する');
  const 段階応答 = await 通信('list', 孵化名);
  const 現在 = Number(段階応答.データ.now);
  const 孵化個体 = (段階応答.データ.pets as Pet[])[0];
  const chick = 孵化個体.hatchedAt > 0
    && 現在 - 孵化個体.hatchedAt < PET_SPECIES[孵化個体.species].chickDays * 24 * 60 * 60 * 1000;
  確認(chick, '孵化直後の段階が chick である');

  // ---- 連れて行く個体と共闘ボーナス ----
  const 選択名 = `選${印}`;
  const 未孵化 = await 卵をひとつ(選択名);
  const 卵拒否 = await 通信('choose', 選択名, { petId: 未孵化.id });
  確認(卵拒否.状態 === 400 && String(卵拒否.データ.error).includes('卵'), '卵は日本語の理由付きで選べない');
  let 一羽目 = await 孵化(選択名, 未孵化);
  const 二つ目の卵 = await 卵をひとつ(選択名); let 二羽目 = await 孵化(選択名, 二つ目の卵);
  確認((await 通信('choose', 選択名, { petId: 一羽目.id })).状態 === 200, '1羽目を連れて行ける');
  await 通信('choose', 選択名, { petId: 二羽目.id });
  let 選択一覧 = await 一覧(選択名);
  確認(選択一覧.find(p => p.id === 二羽目.id)?.chosen === true
    && 選択一覧.filter(p => p.chosen).length === 1, '別の1羽を選ぶと他のchosenがfalseになる');
  const 預け拒否前 = await 通信('board', 選択名, { petId: 二羽目.id });
  確認(預け拒否前.状態 === 200 && !(await 一覧(選択名)).find(p => p.id === 二羽目.id)?.chosen,
    '連れている個体を預けるとchosenが外れる');
  const 預け拒否 = await 通信('choose', 選択名, { petId: 二羽目.id });
  確認(預け拒否.状態 === 400 && String(預け拒否.データ.error).includes('交配所'), '預けた個体は日本語の理由付きで選べない');
  await 通信('choose', 選択名, { petId: 一羽目.id });
  await 通信('release', 選択名, { petId: 一羽目.id });
  確認((await 一覧(選択名)).every(p => !p.chosen), '連れている個体を手放すとchosenが残らない');

  const 死亡名 = `死${印}`; const 死亡卵 = await 卵をひとつ(死亡名);
  let 死亡鳥 = await 孵化(死亡名, 死亡卵);
  // ★ 100日進めてはいけない。天へ行って DEAD_KEEP_DAYS(7日)を過ぎると
  //   一覧から消えるので、「選べない(400)」ではなく「見つからない(404)」
  //   になる。死んだ直後を狙う。
  const 死sp = PET_SPECIES[死亡鳥.species];
  const 寿命日 = 死sp.chickDays + adultDaysOf(死亡鳥) + ELDER_DAYS;
  await 通信('advance', 死亡名, { days: 寿命日 + 0.5 });
  const 死亡一覧 = await 一覧(死亡名);
  確認(死亡一覧.some(p => p.id === 死亡鳥.id),
    `天へ行った直後はまだ一覧に残る(${DEAD_KEEP_DAYS}日は見送れる)`);
  const 死亡拒否 = await 通信('choose', 死亡名, { petId: 死亡鳥.id });
  確認(死亡拒否.状態 === 400 && String(死亡拒否.データ.error).includes('天'),
    `死んだ個体は日本語の理由付きで選べない → 実測 ${死亡拒否.状態} ${String(死亡拒否.データ.error ?? '')}`);
  // さらに進めれば一覧から消える(枠は死んだ時点で空いている)
  await 通信('advance', 死亡名, { days: DEAD_KEEP_DAYS + 1 });
  確認((await 一覧(死亡名)).every(p => p.id !== 死亡鳥.id),
    `${DEAD_KEEP_DAYS}日過ぎると一覧から消える`);

  const 共闘名 = `共${Date.now().toString().slice(-8)}`; const 共闘卵 = await 卵をひとつ(共闘名);
  const 共闘鳥 = await 孵化(共闘名, 共闘卵);
  await 通信('choose', 共闘名, { petId: 共闘鳥.id });
  const 共闘ペット = await 一覧(共闘名) as Pet[]; const 期待 = partyBonusOf(共闘ペット, Date.now());
  // ★ 名前の持ち主を示す印は、ペットAPIと共闘で必ず同じものを使うこと。
  //   通信() が `tok_<名前>` で名前を押さえるので、ここで別の印を作ると
  //   「そのニックネームは既に他の人が使っています」で入室を断られる。
  const 登録ID = `tok_${共闘名}`;
  const ws = 基点.replace(/^http/, 'ws'); const 接続 = new Client(ws);
  const 部屋 = await 接続.create('coop', { name: 共闘名, nickToken: 登録ID, maxStage: 1, stage: 1, spells: [], charId: 0, adminKey: 合言葉 });
  let 自分: any;
  for (let i = 0; i < 20 && !自分; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    自分 = (部屋.state as any).players?.get(部屋.sessionId);
  }
  確認(自分.maxHp === PLAYER_MAX_HP + 期待.hp && 自分.maxMp === PLAYER_MAX_MP + 期待.mp
    && 自分.hp === 自分.maxHp && 自分.mp === 自分.maxMp, '共闘へ実際に入りpartyBonusOfが最大HP/MPと開始値に乗る');
  await 部屋.leave();

  const 上限名 = `上${印}`;
  for (let i = 0; i < MAX_PETS; i++) await 通信('grant', 上限名, { stage: 1 });
  確認((await 通信('grant', 上限名, { stage: 1 })).状態 === 400, 'MAX_PETSを超える卵は断られる');

  // ---- 交配 ----
  const 親一名 = `親甲${印}`; const 親二名 = `親乙${印}`;
  const 卵一 = await 性別の卵(親一名);
  const 卵二 = await 性別の卵(親二名, 卵一.sex === 'm' ? 'f' : 'm');
  let 親一 = await 孵化(親一名, 卵一); let 親二 = await 孵化(親二名, 卵二);
  await 通信('advance', 親一名, { days: PET_SPECIES[親一.species].chickDays });
  await 通信('advance', 親二名, { days: PET_SPECIES[親二.species].chickDays });
  親一 = (await 一覧(親一名)).find(p => p.id === 親一.id)! as Pet;
  親二 = (await 一覧(親二名)).find(p => p.id === 親二.id)! as Pet;
  確認((await 通信('board', 親二名, { petId: 親二.id })).状態 === 200, '成鳥を交配所へ預けられる');
  // ★ 預けた直後は交配できない(なじみ待ち)。ここを飛ばして先へ進めると、
  //   なじみ待ちが効かなくなった時に誰も気づけない。
  確認((await 通信('breed', 親一名, { petId: 親一.id, partnerId: 親二.id })).状態 === 400,
    '預けた直後は交配できない(なじみ待ち)');
  await 通信('advance', 親二名, { days: BOARD_SETTLE_HOURS / 24 });
  const 交配 = await 通信('breed', 親一名, { petId: 親一.id, partnerId: 親二.id });
  確認(交配.状態 === 200, 'なじんだあとは♂♀の成鳥を交配できる');
  const 子 = 交配.データ.pet as WirePet;
  確認(子.species === null || 子.species === undefined, '交配で出来た卵も種類が伏せられている');
  for (const 項目 of ['hpGene', 'mpGene', 'lifeGene'] as const) {
    const 中央 = (親一[項目] + 親二[項目]) / 2;
    確認(Math.abs(子[項目] - 中央) <= BREED_JITTER + 1, `子の${項目}が両親の範囲の近くにある`);
  }
  const お礼 = await 一覧(親二名);
  確認(お礼.some(p => p.parents?.includes(親一.id)), '預けた側にもお礼の卵が追加される');

  // ---- 交配の歯止め(間隔・回数・老鳥) ----
  // ★ 歯止めが無いと同じ1組から無限に卵を作れる。3方向すべて塞げているか見る。
  const 再交配 = await 通信('breed', 親一名, { petId: 親一.id, partnerId: 親二.id });
  確認(再交配.状態 === 400 && String(再交配.データ.error).includes('休んでいる'),
    `産んだ直後は間隔で断られる → 実測 ${String(再交配.データ.error)}`);

  const 親一記録 = (await 一覧(親一名)).find(p => p.id === 親一.id);
  確認(親一記録?.breedCount === 1, `交配の回数が親に記録される → 実測 ${String(親一記録?.breedCount)}`);
  const 親二記録 = (await 一覧(親二名)).find(p => p.id === 親二.id);
  確認(親二記録?.breedCount === 1,
    `預けた側の親にも回数が付く → 実測 ${String(親二記録?.breedCount)}`);
  const 交配所記録 = ((await 通信('list', 親一名)).データ.board as WirePet[])
    .find(p => p.id === 親二.id);
  確認(交配所記録?.breedCount === 1,
    `交配所に置いてある写しにも回数が移る → 実測 ${String(交配所記録?.breedCount)}`);

  // 間隔を飛ばして、回数の上限まで産ませる
  for (let i = 1; i < BREED_MAX_COUNT; i++) {
    await 通信('advance', 親一名, { days: 1 }); await 通信('advance', 親二名, { days: 1 });
    // 手持ちの空きを作る(卵が溜まると上限で断られ、回数の検証にならない)
    for (const p of await 一覧(親一名)) if (p.id !== 親一.id) await 通信('release', 親一名, { petId: p.id });
    for (const p of await 一覧(親二名)) {
      if (p.id !== 親二.id && !p.boarded) await 通信('release', 親二名, { petId: p.id });
    }
    確認((await 通信('breed', 親一名, { petId: 親一.id, partnerId: 親二.id })).状態 === 200,
      `間隔を空ければ${i + 1}回目も産める`);
  }
  await 通信('advance', 親一名, { days: 1 }); await 通信('advance', 親二名, { days: 1 });
  for (const p of await 一覧(親一名)) if (p.id !== 親一.id) await 通信('release', 親一名, { petId: p.id });
  const 打ち止め = await 通信('breed', 親一名, { petId: 親一.id, partnerId: 親二.id });
  確認(打ち止め.状態 === 400 && String(打ち止め.データ.error).includes('もう産めない'),
    `一生に${BREED_MAX_COUNT}回で打ち止めになる → 実測 ${String(打ち止め.データ.error)}`);

  // 老鳥は産めない(別の組で確かめる)
  const 老一名 = `老甲${印}`; const 老二名 = `老乙${印}`;
  const 老卵一 = await 性別の卵(老一名);
  const 老卵二 = await 性別の卵(老二名, 老卵一.sex === 'm' ? 'f' : 'm');
  const 老一 = await 孵化(老一名, 老卵一); const 老二 = await 孵化(老二名, 老卵二);
  // 老鳥の期間へ正確に入れる。
  // ★ 「lifeDays の1.3倍くらい」で当てにいくと、遺伝子(0.8〜1.2倍)次第で
  //   死んだ後まで飛んでしまい、別の理由で断られて検証にならない(実測)。
  //   その個体の adultDaysOf を使って、成鳥が終わった直後を狙う。
  for (const [n, b] of [[老一名, 老一], [老二名, 老二]] as [string, Pet][]) {
    const 老いる日 = PET_SPECIES[b.species].chickDays + adultDaysOf(b);
    await 通信('advance', n, { days: 老いる日 + 0.5 });
  }
  for (const [n, b] of [[老一名, 老一], [老二名, 老二]] as [string, Pet][]) {
    const 今 = (await 一覧(n)).find(p => p.id === b.id) as Pet;
    確認(stageOf(今, Date.now()) === 'elder',
      `${n}の鳥が老鳥になっている → 実測 ${stageOf(今, Date.now())}`);
  }
  await 通信('board', 老二名, { petId: 老二.id });
  const 老拒否 = await 通信('breed', 老一名, { petId: 老一.id, partnerId: 老二.id });
  確認(老拒否.状態 === 400 && String(老拒否.データ.error).includes('年を取りすぎ'),
    `老鳥は産めない → 実測 ${String(老拒否.データ.error)}`);

  // ---- アオイトリ(ごく稀の8種目) ----
  //
  // ★ 卵の見た目で当たりが分かってはいけない。殻を見た時点で
  //   「これは当たりだ」と分かると、孵る瞬間の見せ場が消える。
  const 青ヒント = eggHintOf('bluebird');
  for (const 他 of ['swallow', 'owl'] as const) {
    const h = eggHintOf(他);
    確認(h.size === 青ヒント.size && h.shell === 青ヒント.shell
      && h.pattern === 青ヒント.pattern && h.warmNeeded === 青ヒント.warmNeeded,
      `アオイトリの卵が${PET_SPECIES[他].name}と見分けが付かない`);
  }

  // 出る割合。乱数を差し替えて数えるので、実行のたびにぶれない。
  let 種 = 12345;
  const 疑似乱数 = () => {
    種 = (種 * 1103515245 + 12345) % 2147483648;
    return 種 / 2147483648;
  };
  let 青 = 0;
  const 回数 = 20000;
  for (let i = 0; i < 回数; i++) {
    if (eggSpeciesForBoss(10, 疑似乱数) === 'bluebird') 青 += 1;
  }
  const 割合 = 青 / 回数;
  確認(Math.abs(割合 - BLUEBIRD_RATE) < 0.01,
    `ボスの卵からアオイトリが出る割合 → 実測 ${(割合 * 100).toFixed(1)}%(狙い ${BLUEBIRD_RATE * 100}%)`);

  // 交配の突然変異でアオイトリが出過ぎないこと。
  // ★ PET_SPECIES_ORDER をそのまま変異の候補にすると8分の1で出てしまう。
  確認(!COMMON_SPECIES.includes('bluebird'),
    '交配の変異の候補にアオイトリが入っていない');
  const 親 = (species: Pet['species']): Pet => ({
    id: species, ownerName: 'x', species, name: '', sex: 'm',
    hpGene: 50, mpGene: 50, lifeGene: 50, warmCount: 0, lastWarmAt: 0,
    hatchedAt: 1, boarded: false, boardedAt: 0, eggAt: 0, chosen: false, breedCount: 0, lastBredAt: 0,
    parents: null, bornAt: 0,
  });
  let 交配青 = 0;
  for (let i = 0; i < 回数; i++) {
    if (breed(親('sparrow'), 親('dove'), 疑似乱数).species === 'bluebird') 交配青 += 1;
  }
  const 交配割合 = 交配青 / 回数;
  確認(交配割合 < BLUEBIRD_RATE * 1.6,
    `交配でもアオイトリが出過ぎない → 実測 ${(交配割合 * 100).toFixed(1)}%`);

  // ★ 底上げの上限。ここを超える鳥を足すと「ペットが無いと戦えない」になる。
  const 青の合計 = PET_SPECIES.bluebird.hp + PET_SPECIES.bluebird.mp;
  確認(青の合計 <= 30, `アオイトリの底上げ合計が30以下 → 実測 ${青の合計}`);
  for (const id of COMMON_SPECIES) {
    const t = PET_SPECIES[id].hp + PET_SPECIES[id].mp;
    確認(t <= 26, `${PET_SPECIES[id].name}の合計が26以下 → 実測 ${t}`);
  }

  // ---- 合言葉まわり(必ずいちばん最後に置くこと) ----
  //
  // ★ ここから先は、わざと合言葉を外して叩く。
  //   歯止めが効くと5回でこのIPがロックされ、以降の通信は
  //   正しい合言葉でも通らなくなる。先に置くと後続が全滅する
  //   (歯止めを直した日に実際にそうなった)。
  // ★ 公開に向けて入口を2種類に分けた。守り方が違うので、期待も分ける。
  //   プレイヤー用 … 名前の持ち主か(nickToken)。合言葉は関係ない
  //   管理者用     … 合言葉(ADMIN_KEY)。遊びを飛ばせる道具なので残す
  const プレイヤー経路 = ['list', 'warm', 'choose', 'release', 'board', 'unboard', 'breed'];
  const 管理者経路 = ['grant', 'advance', 'rename'];

  // まず「その名前の持ち主として登録済み」の状態を作る。
  // そのうえで別の印を出せば、他人が名乗っている形になる。
  const 他人名 = `他${印}`;
  await 通信('list', 他人名);          // tok_他人名 で押さえる
  for (const path of プレイヤー経路) {
    const 印なし = await fetch(`${基点}/api/pet/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 他人名 }),
    });
    確認(印なし.status === 403, `本人の印なし /api/pet/${path} → 実測 ${印なし.status}`);
    const 別印 = await fetch(`${基点}/api/pet/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 他人名, token: 'よその印', key: 合言葉 }),
    });
    確認(別印.status === 403,
      `他人の名前は合言葉があっても通らない /api/pet/${path} → 実測 ${別印.status}`);
  }
  for (const path of 管理者経路) {
    const 無し = await 通信(path, '権限試験', {}, null);
    確認(無し.状態 === 403, `合言葉なし /api/pet/${path} → 実測 ${無し.状態}`);
    const 誤り = await 通信(path, '権限試験', {}, '違う合言葉');
    確認(誤り.状態 === 403, `誤った合言葉 /api/pet/${path} → 実測 ${誤り.状態}`);
  }


  // 外し続けた結果、ロックされているはず。
  // ★ 入口ごとに数えていたら、ここで別の入口が通ってしまう。
  //   ペットの入口で外した回数が、ランキング側の入口にも効くことを見る。
  const ロック中 = await fetch(`${基点}/api/admin/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 合言葉 }),
  }).then(r => r.json()) as { ok?: boolean; error?: string };
  確認(ロック中.ok !== true && String(ロック中.error).includes('試行が多すぎます'),
    `外し続けると、正しい合言葉でも別の入口が通らなくなる → 実測 ${String(ロック中.error)}`);

  if (失敗数) { console.error(`検証終了: ${失敗数}件失敗しました。`); process.exit(1); }
  console.log('検証終了: 全項目に合格しました。');
}

実行().catch((err: unknown) => {
  console.error(`失敗: 検証を続けられませんでした。${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

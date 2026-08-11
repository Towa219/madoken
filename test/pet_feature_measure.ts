// 未検証だったペット機能を、実サーバーの応答値で測る。
// 実行後にサーバーを再起動し、pet_restart_measure.ts、pet_passwordless_last.ts の順で実行する。
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import {
  DAY_MS, ELDER_DAYS, MAX_PETS, PET_SPECIES, STAGE_POWER,
  adultDaysOf, bonusOf, stageOf,
} from '../shared/pets';
import type { Pet, PetStage, WirePet } from '../shared/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2808';
const 接続先 = 基点.replace(/^http/, 'ws');
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
const 識別 = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let 失敗数 = 0;

type 応答 = { 状態: number; データ: Record<string, unknown> };
const 待つ = (ミリ秒: number) => new Promise<void>(解決 => setTimeout(解決, ミリ秒));
function 判定(条件: boolean, 文: string): void {
  console.log(`${条件 ? '合格' : '不合格'}: ${文}`);
  if (!条件) 失敗数++;
}
async function 通信(経路: string, name: string, 追加: Record<string, unknown> = {}): Promise<応答> {
  const 応答値 = await fetch(`${基点}/api/pet/${経路}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 合言葉, name, ...追加 }),
  });
  const 文字列 = await 応答値.text();
  let データ: Record<string, unknown> = {};
  try { データ = JSON.parse(文字列) as Record<string, unknown>; }
  catch { データ = { 本文: 文字列 }; }
  return { 状態: 応答値.status, データ };
}
async function 生通信(経路: string, 本文: string): Promise<応答> {
  const 応答値 = await fetch(`${基点}/api/pet/${経路}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 本文,
  });
  const 文字列 = await 応答値.text();
  let データ: Record<string, unknown> = {};
  try { データ = JSON.parse(文字列) as Record<string, unknown>; }
  catch { データ = { 本文: 文字列 }; }
  return { 状態: 応答値.status, データ };
}
async function 一覧(name: string): Promise<{ pets: Pet[]; now: number }> {
  const r = await 通信('list', name);
  return { pets: r.データ.pets as Pet[], now: Number(r.データ.now) };
}
async function 孵化(name: string, 卵: WirePet): Promise<Pet> {
  let 現在 = 卵;
  const 必要 = 卵.hint?.warmNeeded ?? 3;
  while (現在.warmCount < 必要) {
    await 通信('advance', name, { days: 1 });
    const r = await 通信('warm', name, { petId: 現在.id });
    現在 = r.データ.pet as WirePet;
  }
  return 現在 as Pet;
}
async function 卵(name: string): Promise<WirePet> {
  return (await 通信('grant', name, { stage: 5 })).データ.pet as WirePet;
}

function 段階実測(見出し: string, pet: Pet, now: number, 期待段階: PetStage): void {
  const 段階 = stageOf(pet, now); const 加算 = bonusOf(pet, now);
  const 種 = PET_SPECIES[pet.species];
  const hp満額 = 種 ? 種.hp * (0.7 + 0.6 * pet.hpGene / 100) : 0;
  const mp満額 = 種 ? 種.mp * (0.7 + 0.6 * pet.mpGene / 100) : 0;
  const 期待 = { hp: Math.round(hp満額 * STAGE_POWER[期待段階]), mp: Math.round(mp満額 * STAGE_POWER[期待段階]) };
  判定(段階 === 期待段階 && 加算.hp === 期待.hp && 加算.mp === 期待.mp,
    `${見出し}: 段階=${段階}、倍率=${STAGE_POWER[段階]}、実測加算HP=${加算.hp}・MP=${加算.mp}、期待HP=${期待.hp}・MP=${期待.mp}`);
}

async function 生涯測定(): Promise<void> {
  console.log('【1】全生涯と段階境界の測定');
  const name = `生涯${識別}`; const e = await 卵(name);
  let s = await 一覧(name); 段階実測('卵', s.pets[0], s.now, 'egg');
  const bird = await 孵化(name, e); s = await 一覧(name); 段階実測('孵化直後', s.pets[0], s.now, 'chick');
  const 雛日 = PET_SPECIES[bird.species].chickDays;
  await 通信('advance', name, { days: 雛日 - 0.001 }); s = await 一覧(name); 段階実測('雛→成鳥の86.4秒前', s.pets[0], s.now, 'chick');
  await 通信('advance', name, { days: 0.002 }); s = await 一覧(name); 段階実測('雛→成鳥の86.4秒後', s.pets[0], s.now, 'adult');
  const 成鳥日 = adultDaysOf(s.pets[0]);
  await 通信('advance', name, { days: 成鳥日 - 0.002 }); s = await 一覧(name); 段階実測('成鳥→老鳥の86.4秒前', s.pets[0], s.now, 'adult');
  await 通信('advance', name, { days: 0.002 }); s = await 一覧(name); 段階実測('成鳥→老鳥の86.4秒後', s.pets[0], s.now, 'elder');
  await 通信('advance', name, { days: ELDER_DAYS - 0.002 }); s = await 一覧(name); 段階実測('老鳥→天への86.4秒前', s.pets[0], s.now, 'elder');
  await 通信('advance', name, { days: 0.002 }); s = await 一覧(name); 段階実測('老鳥→天への86.4秒後', s.pets[0], s.now, 'dead');
}

async function 死亡枠測定(): Promise<void> {
  console.log('【2】死亡個体の所持枠測定');
  const name = `死亡枠${識別}`;
  for (let i = 0; i < MAX_PETS; i++) await 孵化(name, await 卵(name));
  await 通信('advance', name, { days: 100 });
  const s = await 一覧(name); const 死亡数 = s.pets.filter(p => stageOf(p, s.now) === 'dead').length;
  const 追加 = await 通信('grant', name, { stage: 5 });
  console.log(`実測: 総数=${s.pets.length}、死亡数=${死亡数}、7個目の発行状態=${追加.状態}、本文=${JSON.stringify(追加.データ)}`);
  判定(s.pets.length === 6 && 死亡数 === 6 && 追加.状態 === 400, '死亡した6羽が枠を占有し、新しい卵が拒否された');
}

const 魔法 = [{ name: '検証用の強い魔弾', recipe: { fire: 1, water: 1, light: 2, dark: 2 }, level: 9, rarity: 'legend' }];
const 無音受信 = ['proj', 'hit', 'ehit', 'eproj', 'phit', 'shield', 'shieldhit', 'heal', 'taunt', 'ward', 'wardhit', 'vigor', 'empower', 'focus', 'seal', 'dot', 'quake', 'result', 'aborted', 'replaced', 'down', 'revive', 'eaoewarn', 'eaoehit', 'pwait', 'pback', 'mateleft'];
async function 名前確保(name: string, token: string): Promise<void> {
  await fetch(`${基点}/api/name/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, token }) });
}
async function ボス撃破(name: string, token: string): Promise<{ 卵通知: string; 秒: number }> {
  await 名前確保(name, token);
  const client = new Client(接続先);
  const room: Room = await client.create('coop', { name, nickToken: token, stage: 5, maxStage: 5, spells: 魔法, charId: 0, adminKey: 合言葉 });
  for (const 種類 of 無音受信) room.onMessage(種類, () => { /* 測定対象外の戦闘通知 */ });
  let 卵通知 = ''; let クリア = false;
  room.onMessage('bossegg', (m: { egg?: unknown }) => { 卵通知 = String(m.egg ?? ''); });
  room.onMessage('stageclear', () => { クリア = true; });
  room.send('ready'); const 開始 = Date.now();
  const 連射 = setInterval(() => {
    const st = room.state as any; const me = st?.players?.get(room.sessionId);
    if (st?.phase === 'fight' && me?.alive && me.castingIdx === -1) room.send('cast', { idx: 0 });
  }, 100);
  const 期限 = Date.now() + 120_000;
  while ((!クリア || !卵通知) && Date.now() < 期限) await 待つ(50);
  clearInterval(連射); const 秒 = (Date.now() - 開始) / 1000;
  await room.leave();
  判定(クリア && Boolean(卵通知), `実ボス撃破を完了: 所要=${秒.toFixed(3)}秒、bossegg=${卵通知 || '未受信'}`);
  return { 卵通知, 秒 };
}
async function ボス卵測定(): Promise<void> {
  console.log('【3】ボス撃破卵の管理者側測定');
  const 短縮 = 識別.slice(-10);
  const name = `boss${短縮}`; const token = `札${識別}`;
  const 前 = (await 一覧(name)).pets.length;
  const 一回目 = await ボス撃破(name, token); const 一回後 = (await 一覧(name)).pets.length;
  await 待つ(300); const 二回目 = await ボス撃破(name, token); const 二回後 = (await 一覧(name)).pets.length;
  console.log(`実測: 初期=${前}羽、1回目後=${一回後}羽・通知=${一回目.卵通知}、2回目後=${二回後}羽・通知=${二回目.卵通知}`);
  判定(一回目.卵通知 === 'received' && 一回後 === 前 + 1, '初回だけ卵を1個受領した');
  判定(二回目.卵通知 === 'already' && 二回後 === 一回後, '同じ段階の再撃破では増えなかった');

  const full = `full${短縮}`; const fullToken = `満杯札${識別}`;
  for (let i = 0; i < MAX_PETS; i++) await 通信('grant', full, { stage: 5 });
  const 満杯結果 = await ボス撃破(full, fullToken); const 満杯後 = (await 一覧(full)).pets.length;
  console.log(`実測: 満杯前=6羽、撃破後=${満杯後}羽、通知=${満杯結果.卵通知}`);
  判定(満杯結果.卵通知 === 'full' && 満杯後 === 6, '上限時はfullで卵が増えなかった');
}

async function 不正入力測定(): Promise<void> {
  console.log('【5】不正入力の応答測定');
  const name = `不正${識別}`; const 極長 = '長'.repeat(20_000);
  const e = await 卵(name);
  const 例: Array<[string, Promise<応答>]> = [
    ['存在しない識別子', 通信('warm', name, { petId: '存在しない' })],
    ['空の識別子', 通信('warm', name, { petId: '' })],
    ['極長識別子', 通信('warm', name, { petId: 極長 })],
    ['極長ペット名', 通信('rename', name, { petId: e.id, petName: 極長 })],
    ['負の日数', 通信('advance', name, { days: -1 })],
    ['非数の日数', 生通信('advance', JSON.stringify({ key: 合言葉, name, days: 'NaN' }))],
    ['巨大日数', 通信('advance', name, { days: 1e300 })],
    ['負の段階', 通信('grant', `負段${識別}`, { stage: -5 })],
    ['小数段階', 通信('grant', `小数段${識別}`, { stage: 5.5 })],
    ['極長ニックネーム', 通信('list', 極長)],
  ];
  for (const [項目, 約束] of 例) {
    const r = await 約束;
    console.log(`実測: ${項目} → 状態=${r.状態}、本文=${JSON.stringify(r.データ).slice(0, 300)}`);
    判定(r.状態 !== 500, `${項目}で500を返さない`);
  }
}

async function 同時発行測定(): Promise<void> {
  console.log('【6】10件同時発行の測定');
  const name = `同時${識別}`;
  const rs = await Promise.all(Array.from({ length: 10 }, () => 通信('grant', name, { stage: 5 })));
  const s = await 一覧(name); const 内訳 = rs.reduce<Record<string, number>>((a, r) => { a[r.状態] = (a[r.状態] ?? 0) + 1; return a; }, {});
  console.log(`実測: 要求=10件、応答内訳=${JSON.stringify(内訳)}、最終ペット数=${s.pets.length}、上限=${MAX_PETS}`);
  判定(s.pets.length <= MAX_PETS, `同時発行後の実数=${s.pets.length}で上限を超えない`);
}

async function 再起動用種作成(): Promise<void> {
  console.log('【4・前半】再起動前の保存測定');
  const name = `再起動保持${new URL(基点).port}`;
  const before = await 一覧(name);
  for (const p of before.pets) await 通信('release', name, { petId: p.id });
  const r = await 通信('grant', name, { stage: 5 }); const after = await 一覧(name);
  console.log(`実測: 保存名=${name}、発行状態=${r.状態}、再起動前=${after.pets.length}羽、識別子=${after.pets[0]?.id ?? 'なし'}`);
  判定(r.状態 === 200 && after.pets.length === 1, '再起動比較用の卵を1個保存した');
}

async function 実行(): Promise<void> {
  console.log(`ペット未検証領域の通常測定を開始します。対象=${基点}`);
  await 生涯測定(); await 死亡枠測定(); await ボス卵測定();
  await 不正入力測定(); await 同時発行測定(); await 再起動用種作成();
  console.log(`通常測定終了: 不合格=${失敗数}件。次はサーバー再起動後に再起動測定を実行してください。`);
  if (失敗数) process.exitCode = 1;
}
実行().catch((e: unknown) => { console.error(`測定を継続できません: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

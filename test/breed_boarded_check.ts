// 交配所に預けたままでも交配できるか、そして休憩をすり抜けられないかを見る。
//
//   ADMIN_KEY=test1234 PORT=2569 npx tsx server/index.ts
//   ADMIN_KEY=test1234 PET_TEST_URL=http://localhost:2569 npx tsx test/breed_boarded_check.ts
//
// ★ 直した中身(2026-08-15)。
//   以前は「預けていない自分の鳥」からしか交配を仕掛けられなかった。
//   そのため別々の人が♂と♀を預けると、どちらにも交配のボタンが出ず
//   手詰まりになっていた。預けたままでも仕掛けられるようにした。
//
// ★ そこで新しく効いてくるのが「交配所の写し」。
//   交配所は本体とは別に写しを持っている。交配のあと写しに書き戻さないと、
//   休憩に入ったはずの鳥と、他の人がもう一度すぐ交配できてしまう。
//   仕掛けた側も預けたままでよくなったぶん、危険な口が1つ増えている。
//   ここを重点的に確かめる。

import { BREED_MAX_COUNT, MAX_PETS } from '../shared/pets';
import type { WirePet } from '../shared/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2569';
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

const 一覧 = async (name: string) =>
  (await 通信('list', name)).データ.pets as WirePet[];

// 卵を1つ出して孵し、成鳥になるまで日を進める。
async function 成鳥を作る(name: string): Promise<WirePet> {
  let pet = (await 通信('grant', name, { stage: 1 })).データ.pet as WirePet;
  // 孵るまで温める
  while (!pet.species) {
    await 通信('advance', name, { days: 1 });
    pet = (await 通信('warm', name, { petId: pet.id })).データ.pet as WirePet;
  }
  // 雛のあいだは交配できないので、成鳥になるまで進める
  await 通信('advance', name, { days: 8 });
  return (await 一覧(name)).find(p => p.id === pet.id)!;
}

// ♂と♀が1羽ずつ要る。性別は選べないので、揃うまで作る。
async function 雌雄をそろえる(名A: string, 名B: string): Promise<{ 雄: WirePet; 雌: WirePet }> {
  for (let 回 = 0; 回 < 12; 回++) {
    const a = await 成鳥を作る(名A);
    const b = await 成鳥を作る(名B);
    if (a.sex !== b.sex) {
      return a.sex === 'm' ? { 雄: a, 雌: b } : { 雄: b, 雌: a };
    }
    // 揃わなかったぶんは手放して枠を空ける
    await 通信('release', 名A, { petId: a.id });
    await 通信('release', 名B, { petId: b.id });
  }
  throw new Error('♂と♀を揃えられなかった');
}

async function 実行(): Promise<void> {
  console.log('=== 交配所に預けたままでも交配できるか ===');
  const 印 = Date.now().toString(36).slice(-5);
  const A = `甲${印}`; const B = `乙${印}`; const C = `丙${印}`;

  const { 雄, 雌 } = await 雌雄をそろえる(A, B);
  const 雄の主 = 雄.ownerName; const 雌の主 = 雌.ownerName;
  console.log(`  ${雄の主} の♂「${雄.name}」 / ${雌の主} の♀「${雌.name}」`);

  // 二羽とも交配所へ預ける
  確認((await 通信('board', 雄の主, { petId: 雄.id })).状態 === 200, `${雄の主}が♂を預けた`);
  確認((await 通信('board', 雌の主, { petId: 雌.id })).状態 === 200, `${雌の主}が♀を預けた`);

  // なじみの3時間を待つ
  await 通信('advance', 雄の主, { days: 1 });
  await 通信('advance', 雌の主, { days: 1 });

  // ★ 本題。預けたまま、自分の♂から相手の♀へ仕掛ける。
  const 交配 = await 通信('breed', 雄の主, { petId: 雄.id, partnerId: 雌.id });
  確認(交配.状態 === 200, '預けたまま交配を仕掛けられる',
    交配.状態 === 200 ? '' : String(交配.データ.error));
  if (交配.状態 !== 200) { 締める(); return; }

  // 二人とも卵をもらえているか
  const A卵 = (await 一覧(雄の主)).filter(p => !p.species).length;
  const B卵 = (await 一覧(雌の主)).filter(p => !p.species).length;
  確認(A卵 >= 1, '仕掛けた側に卵が来た', `${A卵}個`);
  確認(B卵 >= 1, '預けたままの相手にもお礼の卵が来た', `${B卵}個`);

  // 二羽とも預けたままか(交配で勝手に引き取られていないこと)
  const board = (await 通信('list', C)).データ.board as WirePet[];
  確認(board.some(p => p.id === 雄.id), '♂は交配所に残っている');
  確認(board.some(p => p.id === 雌.id), '♀は交配所に残っている');

  // ★ 休憩のすり抜け。交配所の写しが古いままだと、ここが通ってしまう。
  const 再挑戦 = await 通信('breed', 雄の主, { petId: 雄.id, partnerId: 雌.id });
  確認(再挑戦.状態 === 400, '続けてもう一度は断られる(20時間の休憩)',
    `${再挑戦.状態} ${String(再挑戦.データ.error ?? '')}`);
  確認(String(再挑戦.データ.error ?? '').includes('休んでいる'),
    '断る理由が「休んでいる」になっている', String(再挑戦.データ.error ?? ''));

  // ★ 交配所の写しを直に見る。
  //   ここを丙の交配だけで確かめてはいけない。丙の性別は選べないので、
  //   相手が♂か♀のどちらかにしか当たらず、片方の写ししか見ないことになる。
  //   仕掛けた側(mine)の写しの書き戻しは今回新しく足したところなので、
  //   二羽ぶんはっきり見る。
  const 写し = (await 通信('list', C)).データ.board as WirePet[];
  const 雄の写し = 写し.find(p => p.id === 雄.id);
  const 雌の写し = 写し.find(p => p.id === 雌.id);
  確認((雄の写し?.breedCount ?? 0) === 1,
    '交配所の写し(♂=仕掛けた側)にも履歴が書き戻されている',
    `breedCount=${雄の写し?.breedCount}`);
  確認((雌の写し?.breedCount ?? 0) === 1,
    '交配所の写し(♀=相手)にも履歴が書き戻されている',
    `breedCount=${雌の写し?.breedCount}`);

  // 第三者から見ても休憩中でなければならない(写しが古いと通ってしまう)
  const 丙の鳥 = await 成鳥を作る(C);
  const 相手 = 丙の鳥.sex === 'm' ? 雌 : 雄;
  const 横取り = await 通信('breed', C, { petId: 丙の鳥.id, partnerId: 相手.id });
  確認(横取り.状態 === 400, '別の研究者から見ても休憩中になっている',
    `${横取り.状態} ${String(横取り.データ.error ?? '')}`);

  // 交配の回数が二羽とも減っているか
  const 雄の今 = (await 一覧(雄の主)).find(p => p.id === 雄.id);
  const 雌の今 = (await 一覧(雌の主)).find(p => p.id === 雌.id);
  確認((雄の今?.breedCount ?? 0) === 1, '♂の交配回数が1回ぶん減った',
    `あと${BREED_MAX_COUNT - (雄の今?.breedCount ?? 0)}回`);
  確認((雌の今?.breedCount ?? 0) === 1, '♀の交配回数が1回ぶん減った',
    `あと${BREED_MAX_COUNT - (雌の今?.breedCount ?? 0)}回`);

  // なじみの3時間がやり直しになっていないこと
  const 三度目 = await 通信('breed', 雄の主, { petId: 雄.id, partnerId: 雌.id });
  確認(!String(三度目.データ.error ?? '').includes('慣れていない'),
    'なじみの3時間がやり直しになっていない', String(三度目.データ.error ?? ''));

  console.log(`  (手持ちの上限は${MAX_PETS}羽。卵も1羽として数える)`);
  締める();
}

function 締める(): void {
  console.log(失敗数 === 0 ? '=== 合格 ===' : `=== ${失敗数}件 失敗 ===`);
  process.exit(失敗数 === 0 ? 0 : 1);
}

void 実行().catch(e => {
  console.error('検証そのものが失敗:', e);
  process.exit(1);
});

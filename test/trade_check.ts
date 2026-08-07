// エレメント取引(プレイヤー同士の個人取引)の検証
//   npx tsx test/trade_check.ts
//
// ① 相場が指定どおりか(基本6種は等価 / 基本6種と光闇は4:1 / 光と闇は等価)
// ② 卓の動き(誘う→受ける→出す→二人とも準備完了で成立)
// ③ 承諾のすり替えを塞げているか(出し物を変えると準備完了が外れる)
// ④ 割り込み・切断・時間切れの後始末
// ⑤ 外から来た数の消毒
// ⑥ 成立しても世界のエレメント総量が変わらないこと

import { ELEMENT_ORDER } from '../shared/data';
import {
  canAfford, checkTrade, countsValue, ELEMENT_VALUE, isRareElement,
  sanitizeCounts, TRADE_INVITE_MS, TRADE_MAX_PER_KIND,
} from '../shared/trade';
import { TradeTables } from '../server/tradeTable';
import type { ElementCounts, ElementId } from '../shared/types';

let ng = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

const NAMES: Record<ElementId, string> = {
  fire: '火', water: '水', wind: '風', earth: '土',
  thunder: '雷', ice: '氷', light: '光', dark: '闇',
};

const BASIC: ElementId[] = ['fire', 'water', 'wind', 'earth', 'thunder', 'ice'];
const RARE: ElementId[] = ['light', 'dark'];

// 「a個のA」と「b個のB」が交換できるか
function tradable(a: ElementId, an: number, b: ElementId, bn: number): boolean {
  return checkTrade({ [a]: an }, { [b]: bn }) === null;
}

// ===== ① 相場 =====

console.log('=== ① 相場 ===');

check('基本6種はすべて価値1',
  BASIC.every(id => ELEMENT_VALUE[id] === 1));
check('光・闇は価値4(基本6種の4個ぶん)',
  RARE.every(id => ELEMENT_VALUE[id] === 4));
check('希少判定は光・闇だけ',
  ELEMENT_ORDER.every(id => isRareElement(id) === RARE.includes(id)));

{
  // 基本6種どうしは1:1
  let okAll = true;
  const bad: string[] = [];
  for (const a of BASIC) {
    for (const b of BASIC) {
      if (a === b) continue;
      if (!tradable(a, 1, b, 1)) { okAll = false; bad.push(`${NAMES[a]}1↔${NAMES[b]}1`); }
      // 1:2 のような不当な比は通さない
      if (tradable(a, 1, b, 2)) { okAll = false; bad.push(`${NAMES[a]}1↔${NAMES[b]}2が通った`); }
    }
  }
  check(`基本6種どうしは1:1のみ成立(30通り)`, okAll, bad.slice(0, 3).join(' / '));
}

{
  // 基本6種 ↔ 光・闇 は 4:1
  let okAll = true;
  const bad: string[] = [];
  for (const a of BASIC) {
    for (const r of RARE) {
      if (!tradable(a, 4, r, 1)) { okAll = false; bad.push(`${NAMES[a]}4↔${NAMES[r]}1`); }
      if (!tradable(r, 1, a, 4)) { okAll = false; bad.push(`${NAMES[r]}1↔${NAMES[a]}4`); }
      for (const n of [1, 2, 3, 5, 6, 8]) {
        if (tradable(a, n, r, 1)) {
          okAll = false; bad.push(`${NAMES[a]}${n}↔${NAMES[r]}1が通った`);
        }
      }
      // 口数を重ねても比は保たれる
      if (!tradable(a, 8, r, 2)) { okAll = false; bad.push(`${NAMES[a]}8↔${NAMES[r]}2`); }
    }
  }
  check('基本6種と光・闇は4:1のみ成立(12通り)', okAll, bad.slice(0, 3).join(' / '));
}

check('光1 ↔ 闇1 は成立', tradable('light', 1, 'dark', 1));
check('闇1 ↔ 光1 は成立', tradable('dark', 1, 'light', 1));
check('光1 ↔ 闇2 は成立しない', !tradable('light', 1, 'dark', 2));

// まとめ買いも混ぜ物も、価値が合っていれば成立する
check('火2+水2 ↔ 光1 は成立(価値4=4)',
  checkTrade({ fire: 2, water: 2 }, { light: 1 }) === null);
check('火2+水1 ↔ 光1 は成立しない(価値3≠4)',
  checkTrade({ fire: 2, water: 1 }, { light: 1 }) !== null);
check('光1+火4 ↔ 闇2 は成立(価値8=8)',
  checkTrade({ light: 1, fire: 4 }, { dark: 2 }) === null);

check('片方が空だと成立しない(贈り物にはできない)',
  checkTrade({}, { fire: 1 }) !== null && checkTrade({ fire: 1 }, {}) !== null);

// ===== ⑤ 外から来た数の消毒 =====

console.log('\n=== ⑤ 消毒 ===');
{
  const dirty = sanitizeCounts({
    fire: 3, water: -5, wind: 2.7, earth: '4', thunder: NaN,
    light: 1000, poison: 9, __proto__: 1,
  });
  check('負の数は落ちる', dirty.water === undefined);
  check('小数は切り捨て', dirty.wind === 2);
  check('数字の文字列は数として通る', dirty.earth === 4);
  check('NaNは落ちる', dirty.thunder === undefined);
  check(`上限${TRADE_MAX_PER_KIND}で頭打ち`, dirty.light === TRADE_MAX_PER_KIND);
  check('知らない種類は入らない',
    !Object.keys(dirty).some(k => !(ELEMENT_ORDER as string[]).includes(k)));
  check('正しい数はそのまま', dirty.fire === 3);
}

check('手持ちを超える出し物は弾かれる',
  !canAfford({ fire: 2, water: 0, wind: 0, earth: 0, thunder: 0, ice: 0, light: 0, dark: 0 },
    { fire: 3 }));

// ===== ② 卓の動き =====

console.log('\n=== ② 卓の動き ===');

interface Msg { to: string; type: string; payload: Record<string, unknown> }

// 検証用の卓。誰に何が飛んだかを全部控える。
function newTable(members: Record<string, string>) {
  const log: Msg[] = [];
  let clock = 1_000_000;
  const tables = new TradeTables(
    (to, type, payload) => log.push({ to, type, payload: payload as Record<string, unknown> }),
    id => members[id] ?? null,
    () => clock,
  );
  return {
    tables, log,
    advance: (ms: number) => { clock += ms; },
    // 指定した相手に届いた最後のメッセージ
    last: (to: string, type: string) =>
      [...log].reverse().find(m => m.to === to && m.type === type)?.payload,
    count: (to: string, type: string) =>
      log.filter(m => m.to === to && m.type === type).length,
    clear: () => { log.length = 0; },
  };
}

{
  const t = newTable({ A: 'アオイ', B: 'ベニ' });
  t.tables.invite('A', 'B');
  check('誘うと相手に届く', t.last('B', 'trade:invited')?.name === 'アオイ');
  check('誘った側にも控えが返る', t.last('A', 'trade:sent')?.name === 'ベニ');

  t.tables.answer('B', false);
  check('断ると誘った側に伝わる', t.last('A', 'trade:declined')?.name === 'ベニ');
  check('断った時点では卓は開かない', !t.tables.isTrading('A') && !t.tables.isTrading('B'));

  t.tables.invite('A', 'B');
  t.tables.answer('B', true);
  check('受けると二人とも取引中になる',
    t.tables.isTrading('A') && t.tables.isTrading('B'));
  check('相手の名前が両方に届く',
    t.last('A', 'trade:begin')?.name === 'ベニ'
    && t.last('B', 'trade:begin')?.name === 'アオイ');

  // 火4 ⇔ 光1
  t.tables.setOffer('A', { fire: 4 });
  check('出したものが相手にも見える',
    JSON.stringify(t.last('B', 'trade:view')?.theirs) === JSON.stringify({ fire: 4 }));

  t.tables.setReady('A', true);
  check('釣り合う前は準備完了にできない',
    t.last('A', 'trade:error') !== undefined
    && t.last('A', 'trade:view')?.myReady === false);

  t.tables.setOffer('B', { light: 1 });
  t.clear();
  t.tables.setReady('A', true);
  check('釣り合えば準備完了になる', t.last('A', 'trade:view')?.myReady === true);
  check('相手にも準備完了が見える', t.last('B', 'trade:view')?.theirReady === true);
  check('片方だけでは成立しない', t.count('A', 'trade:done') === 0);

  t.tables.setReady('B', true);
  const doneA = t.last('A', 'trade:done');
  const doneB = t.last('B', 'trade:done');
  check('二人とも準備完了で成立', doneA !== undefined && doneB !== undefined);
  check('渡すものと受け取るものが入れ替わっている',
    JSON.stringify(doneA?.give) === JSON.stringify({ fire: 4 })
    && JSON.stringify(doneA?.get) === JSON.stringify({ light: 1 })
    && JSON.stringify(doneB?.give) === JSON.stringify({ light: 1 })
    && JSON.stringify(doneB?.get) === JSON.stringify({ fire: 4 }));
  check('成立したら卓は畳まれる',
    !t.tables.isTrading('A') && !t.tables.isTrading('B'));
}

// ===== ③ 承諾のすり替え =====

console.log('\n=== ③ 承諾のすり替え ===');
{
  const t = newTable({ A: 'アオイ', B: 'ベニ' });
  t.tables.invite('A', 'B');
  t.tables.answer('B', true);
  t.tables.setOffer('A', { fire: 4 });
  t.tables.setOffer('B', { light: 1 });
  t.tables.setReady('B', true);
  check('相手が先に準備完了できる', t.last('B', 'trade:view')?.myReady === true);

  // Aが中身を減らしてから成立させようとする
  t.tables.setOffer('A', { fire: 1 });
  check('出し物を変えると相手の準備完了も外れる',
    t.last('B', 'trade:view')?.myReady === false);
  t.clear();
  t.tables.setReady('A', true);
  check('釣り合わなくなった卓は準備完了にできない',
    t.last('A', 'trade:error') !== undefined);
  check('すり替えでは成立しない', t.count('A', 'trade:done') === 0);
}

// ===== ④ 割り込み・切断・時間切れ =====

console.log('\n=== ④ 割り込み・切断・時間切れ ===');
{
  const t = newTable({ A: 'アオイ', B: 'ベニ', C: 'シロ' });
  t.tables.invite('A', 'A');
  check('自分は誘えない', t.count('A', 'trade:invited') === 0);

  t.tables.invite('A', 'Z');
  check('居ない人は誘えない', t.last('A', 'trade:error') !== undefined);

  t.tables.invite('A', 'B');
  t.clear();
  t.tables.invite('C', 'B');
  check('返事待ちの人は追い越して誘えない',
    t.last('C', 'trade:error') !== undefined && t.count('B', 'trade:invited') === 0);

  t.tables.answer('B', true);
  t.clear();
  t.tables.invite('C', 'A');
  check('取引中の人は誘えない', t.last('C', 'trade:error') !== undefined);

  // 片方が居なくなる
  t.clear();
  t.tables.leave('A', '相手がロビーから居なくなった。');
  check('抜けると相手に伝わる', t.last('B', 'trade:closed') !== undefined);
  check('抜けると二人とも取引中ではなくなる',
    !t.tables.isTrading('A') && !t.tables.isTrading('B'));

  // 時間切れ
  const u = newTable({ A: 'アオイ', B: 'ベニ' });
  u.tables.invite('A', 'B');
  u.advance(TRADE_INVITE_MS + 1);
  u.clear();
  u.tables.answer('B', true);
  check('誘いは時間切れになる',
    u.last('B', 'trade:error') !== undefined && !u.tables.isTrading('B'));

  // 時間切れの後は誘い直せる
  u.clear();
  u.tables.invite('A', 'B');
  check('時間切れの後は誘い直せる', u.count('B', 'trade:invited') === 1);
}

{
  // 卓に着いていない状態の操作は弾く
  const t = newTable({ A: 'アオイ', B: 'ベニ' });
  t.tables.setOffer('A', { fire: 1 });
  check('取引していないのに出せない', t.last('A', 'trade:error') !== undefined);
  t.clear();
  t.tables.setReady('A', true);
  check('取引していないのに準備完了できない', t.last('A', 'trade:error') !== undefined);
}

// ===== ⑥ 総量の保存 =====

console.log('\n=== ⑥ 総量 ===');
{
  // 交換で世界のエレメントは増えも減りもしない。
  // 増えるようなら、取引を繰り返すだけで無限に増やせることになる。
  const t = newTable({ A: 'アオイ', B: 'ベニ' });
  const invA: Record<ElementId, number> = {
    fire: 10, water: 0, wind: 0, earth: 0, thunder: 0, ice: 0, light: 0, dark: 0,
  };
  const invB: Record<ElementId, number> = {
    fire: 0, water: 0, wind: 0, earth: 0, thunder: 0, ice: 0, light: 3, dark: 0,
  };
  const total = () => ELEMENT_ORDER.reduce(
    (s, id) => s + invA[id] + invB[id], 0);
  const value = () => ELEMENT_ORDER.reduce(
    (s, id) => s + (invA[id] + invB[id]) * ELEMENT_VALUE[id], 0);
  const before = { n: total(), v: value() };

  t.tables.invite('A', 'B');
  t.tables.answer('B', true);
  t.tables.setOffer('A', { fire: 8 });
  t.tables.setOffer('B', { light: 2 });
  t.tables.setReady('A', true);
  t.tables.setReady('B', true);

  const apply = (inv: Record<ElementId, number>, done?: Record<string, unknown>) => {
    const give = (done?.give ?? {}) as ElementCounts;
    const get = (done?.get ?? {}) as ElementCounts;
    for (const id of ELEMENT_ORDER) {
      inv[id] -= give[id] ?? 0;
      inv[id] += get[id] ?? 0;
    }
  };
  apply(invA, t.last('A', 'trade:done'));
  apply(invB, t.last('B', 'trade:done'));

  check('受け取ったものが手持ちに入る', invA.light === 2 && invB.fire === 8);
  check('出したものが手持ちから出る', invA.fire === 2 && invB.light === 1);
  check('マイナスの持ち物が生まれない',
    ELEMENT_ORDER.every(id => invA[id] >= 0 && invB[id] >= 0));
  check('総個数は変わらない', total() === before.n, `${before.n} → ${total()}`);
  check('総価値も変わらない', value() === before.v, `${before.v} → ${value()}`);
  check('価値の合計は釣り合っている',
    countsValue({ fire: 8 }) === countsValue({ light: 2 }));
}

console.log(ng === 0 ? '\nすべて合格' : `\n${ng}件 不合格`);
process.exit(ng === 0 ? 0 : 1);

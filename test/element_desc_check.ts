// エレメント表(ELEMENTS の desc)が実装と合っているかを突き合わせる。
//
//   npx tsx test/element_desc_check.ts
//
// ★ なぜ要るか(2026-08-15)。
//   desc は説明書のエレメント表と研究室のエレメントカードの両方に出るが、
//   実際の数値は computeSpell が別に持っている。片方だけ直せば静かに
//   食い違う。spellcraft.ts にも「ELEMENTS の desc も同じ数字にすること」と
//   注意書きがあったが、見張るものが無かった。
//
// ★ 実際に見つかった不備:
//   雷・光・闇だけ「MP+4」のように書かれ、「消費MP」ではなかった。
//   MPが増える(得)ように読めるが、意味は逆で消費が重くなる(損)。
//   重い属性ほど利点に見えるという、いちばん困る誤読を招いていた。
//
// ★ 数字の一致だけでなく「書き漏らし」も見る。実装で効いているのに
//   desc に無い項目は、遊ぶ人にとって存在しないのと同じ。

import { ELEMENTS, ELEMENT_ORDER } from '../shared/data';
import { computeSpell } from '../shared/spellcraft';
import type { ElementId } from '../shared/types';

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

// desc に書かれた数値を拾う。書かれていなければ null。
function 拾う(desc: string, 見出し: string): number | null {
  // 例: 「威力+8」「消費MP-4」「詠唱-0.2秒」「会心+8%」
  const m = new RegExp(`${見出し}([+-][0-9.]+)`).exec(desc);
  return m ? Number(m[1]) : null;
}

interface 項目 {
  見出し: string;
  差: (id: ElementId) => number;
  丸め?: number;   // 浮動小数の誤差を吸収する桁
}

// 素の値との差を取る。1個入れた時に何がどれだけ動くか。
const 素 = computeSpell({});
const 一個 = (id: ElementId) => computeSpell({ [id]: 1 });

const 項目一覧: 項目[] = [
  { 見出し: '威力', 差: id => 一個(id).stats.power - 素.stats.power },
  { 見出し: '消費MP', 差: id => 一個(id).stats.manaCost - 素.stats.manaCost },
  { 見出し: '詠唱', 差: id => 一個(id).stats.castTime - 素.stats.castTime, 丸め: 2 },
  { 見出し: '弾速', 差: id => 一個(id).stats.projSpeed - 素.stats.projSpeed },
  { 見出し: '会心', 差: id => 一個(id).stats.critRate - 素.stats.critRate },
  { 見出し: '鈍化', 差: id => 一個(id).stats.slow - 素.stats.slow },
  { 見出し: '吸収', 差: id => 一個(id).stats.lifesteal - 素.stats.lifesteal },
  { 見出し: '自傷', 差: id => 一個(id).stats.selfDamage - 素.stats.selfDamage },
];

console.log('=== エレメント表は実装と合っているか ===');
console.log(`  素の魔法: 威力${素.stats.power} / 消費MP${素.stats.manaCost}`
  + ` / 詠唱${素.stats.castTime}秒 / 弾速${素.stats.projSpeed} / 会心${素.stats.critRate}%`);

for (const id of ELEMENT_ORDER) {
  const e = ELEMENTS[id];
  console.log(`\n【${e.name}】${e.desc}`);

  // ★ MPは必ず「消費MP」と書く。素の「MP+4」は意味が逆に読める。
  確認('MPの増減は「消費MP」と書いている',
    !/(^|[^消費])MP[+-]/.test(e.desc),
    /(^|[^消費])MP[+-]/.test(e.desc) ? '「MP+n」のままになっている' : '');

  for (const 項 of 項目一覧) {
    const 実 = 項.丸め ? Number(項.差(id).toFixed(項.丸め)) : 項.差(id);
    const 書 = 拾う(e.desc, 項.見出し);
    if (実 === 0 && 書 === null) continue;                    // 効かないので書かない ― 正しい
    if (実 === 0 && 書 !== null) {
      確認(`${項.見出し}は効かないのに書いてある`, false, `表は ${書}`);
      continue;
    }
    if (書 === null) {
      確認(`${項.見出し}が表に書かれていない`, false, `実装では ${実 > 0 ? '+' : ''}${実}`);
      continue;
    }
    確認(`${項.見出し}`, 書 === 実,
      書 === 実 ? `${書 > 0 ? '+' : ''}${書}` : `表は${書} / 実装は${実}`);
  }

  // 範囲攻撃は数値ではなく言葉で書いてある。効くなら触れていること。
  const 半径 = 一個(id).stats.radius - 素.stats.radius;
  if (半径 > 0) {
    確認('範囲攻撃に触れている', e.desc.includes('範囲'), `半径 +${半径}`);
  } else {
    確認('効かない範囲攻撃を書いていない', !e.desc.includes('範囲'));
  }
}

console.log(ng === 0 ? '\n=== 合格 ===' : `\n=== ${ng}件 失敗 ===`);
process.exit(ng === 0 ? 0 : 1);

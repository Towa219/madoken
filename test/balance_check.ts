// 魔導値が種類によって不当に安く/高く出ていないかを見張る。
//
// 魔導値は「その魔法がどれだけ勝ちに貢献するか」を1つの数字にしたもので、
// 装備4つの合計が戦闘力として表示される。種類ごとに水準がずれていると、
// 支援や防御を選ぶこと自体が損になり、選択肢が死ぬ。
//
// 実際、以前は割合で効くもの(闘気・護符)が効果時間もパーティ人数も無視して
// 採点されていて、「全員の与ダメ+31%を戦闘中ずっと維持」が魔導値48、
// 攻撃1本(403)の1/8という評価になっていた。
//
// ここでは6個以内の全構成を作り、出来上がった種類ごとの分布を見る。
// レシピや係数を触ったら必ず通すこと。
//
//   npx tsx test/balance_check.ts

import { finalStats, spellMagicValue } from '../shared/spellcraft';
import { ELEMENT_ORDER } from '../shared/data';
import type { ElementCounts, SpellKind } from '../shared/types';

// 上位1割(現実的な「良い1本」の水準)が収まっているべき範囲
const TOP_MIN = 300;
const TOP_MAX = 470;
// 中央値(平凡な1本)が収まっているべき範囲
const MID_MIN = 140;
const MID_MAX = 340;

const KIND_JA: Record<string, string> = {
  attack: '攻撃', shield: '護盾', heal: '回復', taunt: '挑発', ward: '護符',
  vigor: '活力', seal: '封印', empower: '闘気', focus: '瞑想',
};

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// 6個以内の全構成
const all: ElementCounts[] = [];
const cur: ElementCounts = {};
const walk = (i: number, left: number): void => {
  if (i === ELEMENT_ORDER.length) { if (6 - left >= 2) all.push({ ...cur }); return; }
  const id = ELEMENT_ORDER[i];
  for (let k = 0; k <= left; k++) {
    if (k === 0) delete cur[id]; else cur[id] = k;
    walk(i + 1, left - k);
  }
  delete cur[id];
};
walk(0, 6);

const byKind = new Map<SpellKind, number[]>();
for (const c of all) {
  const s = finalStats(c, 0);
  const v = spellMagicValue(s);
  if (!Number.isFinite(v) || v < 1) {
    check(`魔導値が壊れている 〈${JSON.stringify(c)}〉`, false, String(v));
    continue;
  }
  if (!byKind.has(s.kind)) byKind.set(s.kind, []);
  byKind.get(s.kind)!.push(v);
}

console.log(`=== 魔導値の水準 (6個以内の全構成 ${all.length}通り) ===`);
console.log(`  上位1割は ${TOP_MIN}〜${TOP_MAX}、中央値は ${MID_MIN}〜${MID_MAX} に収まること\n`);

const q = (v: number[], p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))];

const tops: { kind: string; top: number }[] = [];
for (const [k, raw] of byKind) {
  const v = raw.sort((a, b) => a - b);
  const top = q(v, 0.9);
  const mid = q(v, 0.5);
  const ja = KIND_JA[k] ?? k;
  tops.push({ kind: ja, top });
  check(`${ja.padEnd(4, '　')} 上位1割 ${String(top).padStart(4)} / 中央値 ${String(mid).padStart(4)}`,
    top >= TOP_MIN && top <= TOP_MAX && mid >= MID_MIN && mid <= MID_MAX,
    `構成${v.length}通り 最小${v[0]} 最大${v[v.length - 1]}`);
}

// 種類がひとつでも欠けていたら、レシピの取りこぼしを疑う
for (const k of Object.keys(KIND_JA)) {
  if (!byKind.has(k as SpellKind)) {
    check(`${KIND_JA[k]} が1つも作れない`, false);
  }
}

// 種類どうしの開きが大きすぎないこと(最も高い種類が最も低い種類の1.6倍まで)
if (tops.length > 1) {
  const hi = tops.reduce((a, b) => (a.top > b.top ? a : b));
  const lo = tops.reduce((a, b) => (a.top < b.top ? a : b));
  const ratio = hi.top / lo.top;
  check(`種類どうしの開き ${ratio.toFixed(2)}倍`, ratio <= 1.6,
    `最高=${hi.kind}${hi.top} 最低=${lo.kind}${lo.top}`);
}

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);

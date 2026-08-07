// 品質を上げた時に消費MPがどう動くかを見る(調査用)。
//
//   npx tsx tools/mp_by_rarity.ts
//
// 消費MPは品質では上がらないのが基本。ただし回復系だけは
// 「回復量に見合ったMPを払う」下限があるので、品質で回復量が増えると
// そのぶんMPも上がる。どれくらい上がるかをここで数える。

import { finalStats } from '../shared/spellcraft';
import { ELEMENT_ORDER } from '../shared/data';
import type { ElementCounts, Rarity } from '../shared/types';

const RS: Rarity[] = ['normal', 'rare', 'epic', 'legend'];

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

const tag = (c: ElementCounts) =>
  ELEMENT_ORDER.filter(id => c[id]).map(id => id + ((c[id] ?? 0) > 1 ? String(c[id]) : '')).join('');

const byKind = new Map<string, { n: number; worst: number; ex: string }>();
let total = 0;
for (const c of all) {
  const n = finalStats(c, 0, 'normal');
  const l = finalStats(c, 0, 'legend');
  if (l.manaCost <= n.manaCost) continue;
  total++;
  const k = n.kind;
  const ratio = l.manaCost / n.manaCost;
  const e = byKind.get(k) ?? { n: 0, worst: 0, ex: '' };
  e.n++;
  if (ratio > e.worst) { e.worst = ratio; e.ex = `${tag(c)} MP${n.manaCost}→${l.manaCost}`; }
  byKind.set(k, e);
}

console.log(`全${all.length}通りのうち、レジェンドでMPが増えるのは ${total}通り`);
for (const [k, v] of byKind) {
  console.log(`  ${k.padEnd(8)} ${String(v.n).padStart(4)}通り  最大 ${v.worst.toFixed(2)}倍  例: ${v.ex}`);
}

console.log('\n代表例(消費MP / 回復量)');
const cases: [string, ElementCounts][] = [
  ['光3 治癒', { light: 3 }],
  ['光4 治癒', { light: 4 }],
  ['光3水1 慈雨', { light: 3, water: 1 }],
  ['光4水2 慈雨', { light: 4, water: 2 }],
  ['火3 爆裂', { fire: 3 }],
  ['闇3 封印', { dark: 3 }],
  ['土2氷1 護盾', { earth: 2, ice: 1 }],
];
console.log('魔法             ' + RS.map(r => r.padStart(7)).join(''));
for (const [name, c] of cases) {
  const st = RS.map(r => finalStats(c, 0, r));
  const mp = st.map(s => String(s.manaCost).padStart(7)).join('');
  const extra = st[0].kind === 'heal'
    ? `   回復 ${st[0].healPower}→${st[3].healPower}` : '';
  console.log(name.padEnd(16) + mp + extra);
}

console.log('\n強化+9まで含めた極端な例(回復量 / 消費MP / MP1あたりの回復)');
for (const [name, c] of [['光3 治癒', { light: 3 }], ['光4水2 慈雨', { light: 4, water: 2 }]] as [string, ElementCounts][]) {
  for (const [lv, r] of [[0, 'normal'], [9, 'normal'], [0, 'legend'], [9, 'legend']] as [number, Rarity][]) {
    const s = finalStats(c, lv, r);
    console.log(`  ${name} +${lv} ${r.padEnd(6)} 回復${String(s.healPower).padStart(4)} / MP${String(s.manaCost).padStart(3)}`
      + ` / ${(s.healPower / s.manaCost).toFixed(1)}`);
  }
}

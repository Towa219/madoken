// すべての系統が「実際に作れる」かを確認する。
//
// 系統は成立した順に効果を上書きするため、条件のゆるい系統を後ろに置くと
// 条件の厳しい系統が永久に発現しなくなる(聖域系が作れなかった不具合の再発防止)。

import { ELEMENT_ORDER, RECIPES } from '../shared/data';
import { computeSpell } from '../shared/spellcraft';
import type { ElementCounts, ElementId } from '../shared/types';

function allRecipes(maxSize: number): ElementCounts[] {
  const out: ElementCounts[] = [];
  const cur: ElementCounts = {};
  const walk = (idx: number, left: number): void => {
    if (idx === ELEMENT_ORDER.length) {
      if (maxSize - left >= 2) out.push({ ...cur });
      return;
    }
    const id = ELEMENT_ORDER[idx] as ElementId;
    for (let k = 0; k <= left; k++) {
      if (k === 0) delete cur[id]; else cur[id] = k;
      walk(idx + 1, left - k);
    }
    delete cur[id];
  };
  walk(0, maxSize);
  return out;
}

const combos = allRecipes(5);
let ng = 0;

for (const r of RECIPES) {
  // その系統が「最後に成立した系統」になる構成があるか(= 効果がそのまま出るか)
  const ok = combos.some(c => {
    const { matched } = computeSpell(c);
    return matched.length > 0 && matched[matched.length - 1].id === r.id;
  });
  if (!ok) {
    console.log(`✗ ${r.name}(${r.id}) はどう調合しても発現しない`);
    ng++;
  }
}

if (ng === 0) console.log(`✓ 全${RECIPES.length}系統が実際に作れる`);

// 代表例の確認: 聖域系(全体護盾)と鼓舞系(全体HP)が本当に全体効果になるか
const seiiki = computeSpell({ earth: 2, ice: 1, light: 1 }).stats;
console.log(`聖域(土2氷1光1) → kind=${seiiki.kind} 全体=${seiiki.targetAll}`);
if (seiiki.kind !== 'shield' || !seiiki.targetAll) { console.log('✗ 全体護盾になっていない'); ng++; }

const koubu = computeSpell({ earth: 2, light: 1, wind: 1 }).stats;
console.log(`鼓舞(土2光1風1) → kind=${koubu.kind} 全体=${koubu.targetAll}`);
if (koubu.kind !== 'vigor' || !koubu.targetAll) { console.log('✗ 全体HP上昇になっていない'); ng++; }

const banshou = computeSpell({ water: 2, ice: 1, wind: 1 }).stats;
console.log(`万象護符(水2氷1風1) → kind=${banshou.kind} 全体=${banshou.targetAll}`);
if (banshou.kind !== 'ward' || !banshou.targetAll) { console.log('✗ 全体耐性になっていない'); ng++; }

const jiu = computeSpell({ light: 3, water: 1 }).stats;
console.log(`慈雨(光3水1) → kind=${jiu.kind} 全体=${jiu.targetAll}`);
if (jiu.kind !== 'heal' || !jiu.targetAll) { console.log('✗ 全体回復になっていない'); ng++; }

console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件の不具合 ===`);
if (ng > 0) process.exit(1);

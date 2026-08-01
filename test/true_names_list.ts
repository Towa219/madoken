// エピック/レジェンドの真名が何通りあるかを数え、一覧を出す
import { ELEMENT_ORDER } from '../shared/data';
import { trueName } from '../shared/spellcraft';
import type { ElementCounts, ElementId } from '../shared/types';

// スロットは最大5なので、2〜5素材の全構成を列挙する
function allRecipes(maxSize: number): ElementCounts[] {
  const out: ElementCounts[] = [];
  const cur: ElementCounts = {};
  const walk = (idx: number, left: number): void => {
    if (idx === ELEMENT_ORDER.length) {
      const used = maxSize - left;
      if (used >= 2) out.push({ ...cur });
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

const recipes = allRecipes(5);
const epic = new Map<string, ElementCounts>();
const legend = new Map<string, ElementCounts>();

for (const r of recipes) {
  const e = trueName(r, 'epic');
  const l = trueName(r, 'legend');
  if (e && !epic.has(e)) epic.set(e, r);
  if (l && !legend.has(l)) legend.set(l, r);
}

console.log(`調合できる構成(2〜5素材): ${recipes.length}通り`);
console.log(`エピックの真名: ${epic.size}種類`);
console.log(`レジェンドの真名: ${legend.size}種類`);
console.log('');
console.log('=== エピックの真名 一覧 ===');
console.log([...epic.keys()].sort().join(' / '));
console.log('');
console.log('=== レジェンドの真名(先頭60件) ===');
console.log([...legend.keys()].sort().slice(0, 60).join(' / '));

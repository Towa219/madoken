// 回復魔法が「MPの自然回復だけで撃ち続けられない」ことを総当たりで検証する。
//
// 撃ち続けられてしまうと、敵の攻撃がそれを下回るステージで実質不死身になる。
// また、将来HP→MP変換の魔法を入れる際、MP1あたりの回復量が青天井だと
// HP→MP→回復→HP が増え続ける(無限ループ)ため、その上限も見張る。
//
//   npx tsx test/heal_ratio_calc.ts

import { computeSpell, finalStats, spellCooldown } from '../shared/spellcraft';
import { ELEMENT_ORDER, PLAYER_MAX_HP, PLAYER_MAX_MP } from '../shared/data';
import type { ElementCounts, ElementId, Rarity } from '../shared/types';

const MP_REGEN = 3;      // ソロ/共闘のMP自然回復(毎秒)
const MAX_ELEMENTS = 6;  // 調合台の最大スロット

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function label(c: ElementCounts): string {
  const ja: Record<ElementId, string> = {
    fire: '火', water: '水', wind: '風', earth: '地',
    thunder: '雷', ice: '氷', light: '光', dark: '闇',
  };
  return ELEMENT_ORDER.filter(id => (c[id] ?? 0) > 0)
    .map(id => ja[id] + ((c[id] ?? 0) > 1 ? String(c[id]) : '')).join('');
}

// 6スロットまでの全構成を列挙する
function* allCounts(): Generator<ElementCounts> {
  const cur: ElementCounts = {};
  function* walk(idx: number, left: number): Generator<ElementCounts> {
    if (idx === ELEMENT_ORDER.length) {
      if (MAX_ELEMENTS - left >= 2) yield { ...cur };
      return;
    }
    const id = ELEMENT_ORDER[idx];
    for (let k = 0; k <= left; k++) {
      if (k === 0) delete cur[id]; else cur[id] = k;
      yield* walk(idx + 1, left - k);
    }
    delete cur[id];
  }
  yield* walk(0, MAX_ELEMENTS);
}

console.log(`最大HP=${PLAYER_MAX_HP}  最大MP=${PLAYER_MAX_MP}  自然回復=毎秒${MP_REGEN}`);
console.log('');

interface Worst { c: ElementCounts; lv: number; value: number; detail: string }
let worstRatio: Worst | null = null;      // 通常品質だけで見た最効率
let worstAnyRatio: Worst | null = null;   // 品質も含めた最効率
let worstSustain: Worst | null = null;
let healCount = 0;

// 品質は消費MPを増やさない(増やすと上位品質ほど1回が重くなるだけになる)。
// そのぶん上位品質は「同じMPで多く回復する」= 効率が良くなるので、
// HP→MP変換を将来入れる時はこちらの数字を見ること。
const RARITIES_TO_SCAN: Rarity[] = ['normal', 'rare', 'epic', 'legend'];

for (const c of allCounts()) {
  if (computeSpell(c).stats.kind !== 'heal') continue;
  healCount++;
  for (const lv of [0, 9]) {
    for (const r of RARITIES_TO_SCAN) {
      const sr = finalStats(c, lv, r);
      const rr = sr.healPower / sr.manaCost;
      if (!worstAnyRatio || rr > worstAnyRatio.value) {
        worstAnyRatio = {
          c, lv, value: rr,
          detail: `${label(c)} +${lv} ${r}: 回復${sr.healPower} / MP${sr.manaCost}`,
        };
      }
    }
    const s = finalStats(c, lv);
    const cycle = spellCooldown(s) + s.castTime; // 1回に拘束される秒数
    const regen = MP_REGEN * cycle;              // その間に自然回復するMP
    const ratio = s.healPower / s.manaCost;
    // 余裕 = 消費MP - 自然回復。正なら撃ち続けられない
    const margin = s.manaCost - regen;

    if (!worstRatio || ratio > worstRatio.value) {
      worstRatio = {
        c, lv, value: ratio,
        detail: `${label(c)} +${lv}: 回復${s.healPower} / MP${s.manaCost}`,
      };
    }
    if (!worstSustain || margin < worstSustain.value) {
      worstSustain = {
        c, lv, value: margin,
        detail: `${label(c)} +${lv}: MP${s.manaCost} vs 自然回復${regen.toFixed(0)}`
          + `(1周${cycle.toFixed(2)}秒)`,
      };
    }
  }
}

console.log(`回復魔法になる構成: ${healCount}通り(強化+0と+9の両方を検査)`);
console.log('');
check('自然回復のMPだけでは撃ち続けられない',
  (worstSustain?.value ?? 0) > 0,
  `最も際どい構成 ${worstSustain?.detail} → 余裕 ${worstSustain?.value.toFixed(1)}MP`);

check('MP1あたりの回復量に上限がかかっている(通常品質)',
  (worstRatio?.value ?? 99) <= 2.4,
  `最効率 ${worstRatio?.value.toFixed(2)} HP/MP (${worstRatio?.detail})`);

// 品質で上がるのは「効率」であって上限そのものではない。
// レジェンドの倍率は2.0なので、通常の上限の2倍を超えたらどこかがおかしい。
check('品質を含めても、通常の上限の2倍までに収まっている',
  (worstAnyRatio?.value ?? 99) <= 2.4 * 2.0,
  `最効率 ${worstAnyRatio?.value.toFixed(2)} HP/MP (${worstAnyRatio?.detail})`);

console.log('');
console.log('=== 将来HP→MP変換を入れる場合の上限 ===');
const r = worstAnyRatio?.value ?? 1;
console.log(`回復の最効率が ${r.toFixed(2)} HP/MP なので、`);
console.log(`変換効率を ${(1 / r).toFixed(2)} 未満にすればループは成立しない。`);

console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
process.exit(failures === 0 ? 0 : 1);

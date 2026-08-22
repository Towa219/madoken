// 授かる魔法が、手持ちと同じ構成でも二重にならないかを確かめる。
// ブラウザもサーバーも要らない。
//
//   npx tsx test/grant_duplicate_check.ts
//
// ★ なぜ要るか(2026-08-22)。
//   実データで見つかった。プレイヤー「にーな」の魔導書に
//     ・光の陰陽輪・極〈水光2闇2〉 +6 (ノーマル)   … 調合で育てた本命
//     ・光の陰陽輪・極〈水光2闇2〉 +0 (レア)       … id=sp_boss30_...
//   が並んでいた。構成はどちらも 水1 光2 闇2 で同じ。
//
//   原因は、最深部の報酬(grantBossReward)と図鑑コンプの報酬
//   (grantCodexRewardIfDue)が、手持ちを見ずに addSpell していたこと。
//   調合(findSameRecipeSpell)もガチャ(gachaOutcomeFor)も
//   「同じ構成なら増やさずに強化」で揃っているのに、報酬だけが例外だった。
//
// ★ 直し方は二段構え。両方を見る。
//   ① そもそも手持ちに無い構成を選ぶ(randomComposition の avoid)
//   ② それでも当たったら、増やさずに強化+品質上げ(grantOutcomeFor)
//
// ★ 判断を1か所に集めたことも見張る。報酬の側にもう一度書くと、
//   また同じずれ方をする。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENHANCE_MAX, finalStats, randomComposition, recipesEqual } from '../shared/spellcraft';
import { applyEnhance, gachaOutcomeFor, grantOutcomeFor } from '../shared/gacha';
import { RARITIES } from '../shared/data';
import type { ElementCounts, Spell } from '../shared/types';

const ここ = dirname(fileURLToPath(import.meta.url));

let 失敗数 = 0;
function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

// にーな の実例そのまま
const 陰陽輪: ElementCounts = { water: 1, light: 2, dark: 2 };

function 魔法(recipe: ElementCounts, level: number, rarity: Spell['rarity']): Spell {
  return {
    id: `sp_${rarity}_${level}`, name: '光の陰陽輪・極〈水光2闇2〉',
    recipe, stats: finalStats(recipe, level, rarity),
    discoveries: [], level, equipCount: 0, rarity,
  } as Spell;
}

console.log('=== 授かる魔法が二重にならないか ===');

// ---- 1. にーな の実例 ----
console.log('\n-- ノーマル+6 を持っている所へ、レアのボス報酬が来た --');
{
  const 手持ち = [魔法(陰陽輪, 6, 'normal')];
  const 前の魔導値 = 手持ち[0].stats.power;
  const o = grantOutcomeFor(手持ち, 陰陽輪, 'rare');

  確認(o.kind === 'enhance', '増やさずに強化になる(2本に割れない)', `kind=${o.kind}`);
  if (o.kind === 'enhance') {
    確認(o.level === 7, '強化は +6 → +7', `+${o.level}`);
    確認(o.rarityUp === true, '品質が上がる判定になっている');
    確認(o.rarity === 'rare', '上がった先はレア', o.rarity);

    applyEnhance(o);
    const sp = 手持ち[0];
    確認(手持ち.length === 1, '手持ちは1本のまま', `${手持ち.length}本`);
    確認(sp.level === 7 && sp.rarity === 'rare',
      '手持ちが レア+7 になった', `+${sp.level} (${sp.rarity})`);
    確認(sp.stats.power > 前の魔導値,
      '性能が上がっている(品質倍率が効いている)',
      `威力 ${前の魔導値} → ${sp.stats.power}`);
  }
}

// ---- 2. 品質が下がる方向には行かない ----
console.log('\n-- すでにエピックの所へ、レアの報酬が来た --');
{
  const 手持ち = [魔法(陰陽輪, 3, 'epic')];
  const o = grantOutcomeFor(手持ち, 陰陽輪, 'rare');
  確認(o.kind === 'enhance', '強化にはなる', `kind=${o.kind}`);
  if (o.kind === 'enhance') {
    確認(o.rarityUp === false, '品質は下がらない(rarityUp が false)');
    applyEnhance(o);
    確認(手持ち[0].rarity === 'epic', 'エピックのまま', 手持ち[0].rarity);
    確認(手持ち[0].level === 4, '強化だけ +3 → +4 になる', `+${手持ち[0].level}`);
  }
}

// ---- 3. +9 で品質も上がらない時 ----
console.log('\n-- すでに +9 のレアの所へ、レアの報酬が来た --');
{
  const 手持ち = [魔法(陰陽輪, ENHANCE_MAX, 'rare')];
  const o = grantOutcomeFor(手持ち, 陰陽輪, 'rare');
  確認(o.kind === 'max', '何も変わらない扱いになる', `kind=${o.kind}`);
  確認(手持ち.length === 1, '手持ちは1本のまま', `${手持ち.length}本`);
}

// ---- 4. +9 でも品質が上がるなら受け取れる ----
console.log('\n-- +9 のノーマルの所へ、レジェンドの報酬が来た --');
{
  const 手持ち = [魔法(陰陽輪, ENHANCE_MAX, 'normal')];
  const o = grantOutcomeFor(手持ち, 陰陽輪, 'legend');
  確認(o.kind === 'enhance', '打ち止めにならない', `kind=${o.kind}`);
  if (o.kind === 'enhance') {
    確認(o.level === ENHANCE_MAX, `強化は +${ENHANCE_MAX} のまま`, `+${o.level}`);
    applyEnhance(o);
    確認(手持ち[0].rarity === 'legend', '品質だけレジェンドに上がる', 手持ち[0].rarity);
  }
}

// ---- 5. 持っていない構成なら、ふつうに新しく1本 ----
console.log('\n-- 手持ちに無い構成の報酬 --');
{
  const o = grantOutcomeFor([魔法({ fire: 3 }, 0, 'normal')], 陰陽輪, 'rare');
  確認(o.kind === 'new', '新しく1本もらえる', `kind=${o.kind}`);
}

// ---- 6. そもそも持っている構成を避けて選ぶ ----
console.log('\n-- 報酬の構成を選ぶ時に、手持ちを避けるか --');
{
  // 何を引いても手持ちにある、という極端な場合でも null で終わらせない
  const 全部持っている = () => true;
  確認(randomComposition(5, Math.random, 全部持っている) === null,
    '避けきれない時は null を返す(呼ぶ側が引き直せる)');

  // 実際に1つだけ避けさせて、その構成が選ばれないことを見る
  const 的 = randomComposition(5);
  if (!的) { 確認(false, '構成を1つ選べる'); } else {
    let 当たった = 0;
    for (let i = 0; i < 200; i++) {
      const r = randomComposition(5, Math.random, c => recipesEqual(c, 的.counts));
      if (r && recipesEqual(r.counts, 的.counts)) 当たった += 1;
    }
    確認(当たった === 0, '避けた構成は200回引いても選ばれない', `${当たった}回`);
  }
}

// ---- 7. ガチャの動きを壊していないか ----
console.log('\n-- ガチャ(同じ判断を通すようにした)が壊れていないか --');
{
  const 手持ち = [魔法(陰陽輪, 6, 'normal')];
  const o = gachaOutcomeFor(手持ち, 陰陽輪, { kind: 'spell', rarity: 'rare' } as never);
  確認(o.kind === 'enhance', 'ガチャでも重複は強化になる', `kind=${o.kind}`);
  const rp = gachaOutcomeFor(手持ち, 陰陽輪, { kind: 'rp', amount: 30 } as never);
  確認(rp.kind === 'rp' && rp.amount === 30, '研究Pの当たりはそのまま通る');
}

// ---- 8. 報酬が判断を通さず addSpell していないか ----
// ★ ここが本丸。ロジックを直しても、報酬の側でまた直に押し込めば元に戻る。
console.log('\n-- 報酬が共通の判断を通しているか(取り違え防止) --');
{
  const src = readFileSync(join(ここ, '..', 'src', 'lab.ts'), 'utf8');
  const 切り出す = (名: string): string => {
    const i = src.indexOf(`function ${名}(`);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j);
  };
  for (const 名 of ['grantBossReward', 'grantCodexRewardIfDue']) {
    const 本体 = 切り出す(名);
    確認(本体 !== '', `${名} が見つかる`);
    確認(!本体.includes('addSpell('),
      `${名} は addSpell を直に呼んでいない`,
      本体.includes('addSpell(') ? '手持ちを見ずに押し込むと2本に割れる' : '');
    確認(本体.includes('授ける('), `${名} は共通の「授ける」を通している`);
  }
  const 授ける本体 = 切り出す('授ける');
  確認(授ける本体.includes('grantOutcomeFor('),
    '「授ける」は shared/gacha.ts の判断を使っている');
  確認(授ける本体.includes('avoid') || 授ける本体.includes('手持ちにある'),
    '「授ける」は手持ちにある構成を避けている');
}

console.log('');
if (失敗数 === 0) {
  console.log('すべて合格。同じ構成の魔法が2本に割れることはない。');
} else {
  console.error(`${失敗数}件 失敗。魔導書に同じ魔法が2本並ぶ恐れがある。`);
  process.exit(1);
}

void RARITIES;

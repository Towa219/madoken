// ガチャで引いた結果の決め方(画面に依らない部分)
//
// ここには「何が起きるか」だけを置く。実際に持ち物へ入れるのは src/gacha.ts。
// 分けてあるのは、重複した時の扱いをブラウザ無しで確かめられるようにするため。

import { ENHANCE_MAX, finalStats, recipesEqual, spellNameFor } from './spellcraft';
import { RARITIES } from './data';
import type { GachaPrize } from './data';
import type { ElementCounts, Rarity, Spell } from './types';

export type GachaOutcome =
  // 研究P … 外れの受け皿。何も無い回を作らないために置いてある
  | { kind: 'rp'; amount: number }
  // 持っていない構成 … 新しく1本もらう
  | { kind: 'new'; counts: ElementCounts; rarity: Rarity }
  // 持っている構成 … 増やさずに +1 強化する
  | {
    kind: 'enhance'; owned: Spell; level: number; rarity: Rarity;
    rarityUp: boolean;
  }
  // 持っていて、もう +9 で品質も上がらない … 何も変わらない
  | { kind: 'max'; owned: Spell; rarity: Rarity };

function rankOf(r: Rarity): number { return RARITIES[r].mul; }

// 同じ構成をすでに持っているかで、新規か強化かを決める。
//
// 「同じ魔法」の物差しは調合の強化判定と同じ recipesEqual を使う。
// 別々に持つと、調合では強化になるのにガチャでは別物として増える、
// といった食い違いが出る。
//
// 品質は上書きしない。ただし引いた方が上等なら、そこだけ引き上げる ―
// レジェンドを引いたのに手持ちの通常が +1 されて終わりでは報われない。
export function gachaOutcomeFor(
  owned: readonly Spell[], counts: ElementCounts, prize: GachaPrize,
): GachaOutcome {
  if (prize.kind === 'rp') return { kind: 'rp', amount: prize.amount };
  return grantOutcomeFor(owned, counts, prize.rarity);
}

// 魔法を1本「授ける」時に、新しく増やすのか手持ちを強くするのかを決める。
//
// ★ ガチャだけでなく、最深部の報酬(grantBossReward)も
//   図鑑コンプの報酬(grantCodexRewardIfDue)も必ずここを通すこと。
//
//   2026-08-22、報酬の側だけこの判断を通しておらず、素の addSpell で
//   持ち物へ押し込んでいた。そのため、たまたま手持ちと同じ構成を
//   引き当てると同じ魔法が2本並んだ。実データで確認している ―
//   ステージ30のボス報酬(sp_boss30_...)が、すでに持っていた
//   「光の陰陽輪・極〈水光2闇2〉+6」と同じ構成を引き、
//   ノーマル+6 とレア+0 が別々に並んでいた。
//
//   調合(findSameRecipeSpell)もガチャも「同じ構成なら強化」で
//   揃っているので、報酬だけ例外にする理由が無い。
export function grantOutcomeFor(
  owned: readonly Spell[], counts: ElementCounts, rarity: Rarity,
): Exclude<GachaOutcome, { kind: 'rp' }> {
  const same = owned.find(sp => recipesEqual(sp.recipe, counts));
  if (!same) return { kind: 'new', counts, rarity };

  const rarityUp = rankOf(rarity) > rankOf(same.rarity);
  if (same.level >= ENHANCE_MAX && !rarityUp) {
    return { kind: 'max', owned: same, rarity };
  }
  return {
    kind: 'enhance',
    owned: same,
    level: Math.min(ENHANCE_MAX, same.level + 1),
    rarity,
    rarityUp,
  };
}

// 「強化」に決まった時、その魔法へ実際に反映する。
// 持ち物への出し入れは呼ぶ側(画面ごとに見せ方が違うため)。
//
// ★ 品質は上書きしない。引いた方が上等な時だけ引き上げる。
//   上げた時は名前も上位品質のものに変わる(同じ構成なら一意に決まる)。
export function applyEnhance(o: Extract<GachaOutcome, { kind: 'enhance' }>): void {
  const sp = o.owned;
  if (o.rarityUp) {
    sp.rarity = o.rarity;
    sp.name = spellNameFor(sp.recipe, sp.rarity);
  }
  sp.level = o.level;
  sp.stats = finalStats(sp.recipe, sp.level, sp.rarity);
}

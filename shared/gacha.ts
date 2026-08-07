// ガチャで引いた結果の決め方(画面に依らない部分)
//
// ここには「何が起きるか」だけを置く。実際に持ち物へ入れるのは src/gacha.ts。
// 分けてあるのは、重複した時の扱いをブラウザ無しで確かめられるようにするため。

import { ENHANCE_MAX, recipesEqual } from './spellcraft';
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
  const rarity = prize.rarity;
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

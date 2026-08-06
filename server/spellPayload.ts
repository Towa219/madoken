// クライアントから届いた魔法データの検証と再計算
// クライアントはレシピ・強化Lv・品質だけを送り、性能はサーバーが計算する。

import { ELEMENT_ORDER, EQUIP_MAX, MAX_SLOTS } from '../shared/data';
import { finalStats } from '../shared/spellcraft';
import type { ElementCounts, ElementId, Rarity, SpellStats } from '../shared/types';

const RARITY_VALUES: Rarity[] = ['normal', 'rare', 'epic', 'legend'];

// レシピを調合台に置ける範囲へ丸める。
//
// 素材の数がそのまま威力になるので、手を加えた大きなレシピを送られると
// 途方もない魔法ができてしまう。強化Lvや品質は前から丸めていたが、
// レシピの大きさは見ていなかった。
// 多い属性から順に詰めるので、正規のレシピは何も変わらない。
function clampRecipe(raw: unknown): ElementCounts {
  const src = (raw ?? {}) as Record<string, unknown>;
  const pairs: [ElementId, number][] = [];
  for (const id of ELEMENT_ORDER) {
    const n = Math.floor(Number(src[id]) || 0);
    if (n > 0) pairs.push([id, Math.min(n, MAX_SLOTS)]);
  }
  pairs.sort((a, b) => b[1] - a[1]);
  const out: ElementCounts = {};
  let left = MAX_SLOTS;
  for (const [id, n] of pairs) {
    if (left <= 0) break;
    const take = Math.min(n, left);
    out[id] = take;
    left -= take;
  }
  return out;
}

export interface ServerSpell {
  name: string;
  stats: SpellStats;
}

// charId を渡すと、そのキャラの得意エレメントを含む魔法の威力が上がる。
// 渡さなければ素の性能(ランキングの計算など、キャラを問わない場面で使う)。
export function parseSpells(raw: unknown, charId?: unknown): ServerSpell[] {
  const list = Array.isArray(raw) ? (raw as unknown[]).slice(0, EQUIP_MAX) : [];
  return list.map(s => {
    const obj = s as { name?: unknown; recipe?: unknown; level?: unknown; rarity?: unknown };
    const level = Math.max(0, Math.min(9, Math.floor(Number(obj?.level) || 0)));
    const rarity = RARITY_VALUES.includes(obj?.rarity as Rarity)
      ? (obj.rarity as Rarity)
      : 'normal';
    return {
      name: String(obj?.name ?? '魔弾').slice(0, 30),
      stats: finalStats(clampRecipe(obj?.recipe), level, rarity, charId),
    };
  });
}

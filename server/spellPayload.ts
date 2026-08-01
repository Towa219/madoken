// クライアントから届いた魔法データの検証と再計算
// クライアントはレシピ・強化Lv・品質だけを送り、性能はサーバーが計算する。

import { finalStats } from '../shared/spellcraft';
import type { ElementCounts, Rarity, SpellStats } from '../shared/types';

const RARITY_VALUES: Rarity[] = ['normal', 'rare', 'epic', 'legend'];

export interface ServerSpell {
  name: string;
  stats: SpellStats;
}

export function parseSpells(raw: unknown): ServerSpell[] {
  const list = Array.isArray(raw) ? (raw as unknown[]).slice(0, 4) : [];
  return list.map(s => {
    const obj = s as { name?: unknown; recipe?: unknown; level?: unknown; rarity?: unknown };
    const level = Math.max(0, Math.min(9, Math.floor(Number(obj?.level) || 0)));
    const rarity = RARITY_VALUES.includes(obj?.rarity as Rarity)
      ? (obj.rarity as Rarity)
      : 'normal';
    return {
      name: String(obj?.name ?? '魔弾').slice(0, 30),
      stats: finalStats((obj?.recipe ?? {}) as ElementCounts, level, rarity),
    };
  });
}

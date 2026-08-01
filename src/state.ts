import { finalStats, spellMagicValue } from '../shared/spellcraft';
import { ELEMENT_ORDER } from '../shared/data';
import type { ElementId, GameState, Spell } from '../shared/types';

const SAVE_KEY = 'magic_web_game_save_v1';

function initialState(): GameState {
  return {
    version: 1,
    nickname: '',
    researchP: 30,
    inventory: {
      fire: 4, water: 4, wind: 3, earth: 3,
      thunder: 1, ice: 1, light: 0, dark: 0,
    },
    spells: [],
    equipped: [],
    discovered: [],
    slots: 3,
    maxStage: 1,
    bestStage: 0,
    bossCleared: [],
    sortByPower: false,
  };
}

export let state: GameState = load();

function load(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as GameState;
    // 旧セーブの移行: 強化レベルが無い魔法は0で補完
    const merged = { ...initialState(), ...parsed };
    for (const sp of merged.spells) {
      if (typeof (sp as { level?: unknown }).level !== 'number') sp.level = 0;
      if (typeof (sp as { rarity?: unknown }).rarity !== 'string') sp.rarity = 'normal';
    }
    // 性能はレシピから必ず再計算する。
    // (項目を増やしたバージョンアップ後も、古い魔法が欠損値=NaNにならない。
    //  同時にバランス調整も既存の魔法へ反映される)
    for (const sp of merged.spells) {
      try {
        sp.stats = finalStats(sp.recipe ?? {}, sp.level, sp.rarity);
      } catch { /* レシピが壊れている場合は元の値のまま */ }
    }
    if (typeof merged.nickname !== 'string') merged.nickname = '';
    if (!Array.isArray(merged.bossCleared)) merged.bossCleared = [];
    if (typeof merged.sortByPower !== 'boolean') merged.sortByPower = false;
    // 素材庫の欠損も0で補う
    for (const id of ELEMENT_ORDER) {
      if (typeof merged.inventory[id] !== 'number' || !Number.isFinite(merged.inventory[id])) {
        merged.inventory[id] = 0;
      }
    }
    return merged;
  } catch {
    return initialState();
  }
}

export function save(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    // 公開版のiframe等でlocalStorageが使えない場合はセーブなしで続行
  }
}

export function resetSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch { /* 同上 */ }
  state = initialState();
  notify();
}

// ---- 変更通知(UI再描画用の簡易pubsub) ----
type Listener = () => void;
const listeners: Listener[] = [];

export function onChange(fn: Listener): void {
  listeners.push(fn);
}

export function notify(): void {
  save();
  for (const fn of listeners) fn();
}

// ---- 操作ヘルパー ----

export function addElements(drops: ElementId[]): void {
  for (const id of drops) state.inventory[id] = (state.inventory[id] ?? 0) + 1;
}

export function spendElements(counts: Partial<Record<ElementId, number>>): boolean {
  for (const [id, cnt] of Object.entries(counts) as [ElementId, number][]) {
    if ((state.inventory[id] ?? 0) < cnt) return false;
  }
  for (const [id, cnt] of Object.entries(counts) as [ElementId, number][]) {
    state.inventory[id] -= cnt;
  }
  return true;
}

export function addSpell(spell: Spell): void {
  state.spells.push(spell);
  // 空きがあれば自動装備
  if (state.equipped.length < 4) state.equipped.push(spell.id);
}

export function hasBossCleared(stage: number): boolean {
  return state.bossCleared.includes(stage);
}

export function markBossCleared(stage: number): void {
  if (!state.bossCleared.includes(stage)) state.bossCleared.push(stage);
}

export function deleteSpell(id: string): void {
  state.spells = state.spells.filter(s => s.id !== id);
  state.equipped = state.equipped.filter(e => e !== id);
}

export function toggleEquip(id: string): void {
  if (state.equipped.includes(id)) {
    state.equipped = state.equipped.filter(e => e !== id);
  } else if (state.equipped.length < 4) {
    state.equipped.push(id);
  }
}

// 装備中の魔法。並び順は魔導書での表示順に一致させる
// (戦闘バーの1〜4が、研究室で見えている上からの順番になる)
export function equippedSpells(): Spell[] {
  const eq = state.spells.filter(s => state.equipped.includes(s.id));
  if (state.sortByPower) {
    eq.sort((a, b) => spellMagicValue(b.stats) - spellMagicValue(a.stats));
  }
  return eq;
}

export function totalInventory(): number {
  return Object.values(state.inventory).reduce((a, b) => a + b, 0);
}

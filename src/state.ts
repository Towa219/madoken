import type { ElementId, GameState, Spell } from '../shared/types';

const SAVE_KEY = 'magic_web_game_save_v1';

function initialState(): GameState {
  return {
    version: 1,
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

export function equippedSpells(): Spell[] {
  return state.equipped
    .map(id => state.spells.find(s => s.id === id))
    .filter((s): s is Spell => !!s);
}

export function totalInventory(): number {
  return Object.values(state.inventory).reduce((a, b) => a + b, 0);
}

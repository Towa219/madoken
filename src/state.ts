import { finalStats, spellMagicValue, spellNameFor } from '../shared/spellcraft';
import {
  ELEMENT_ORDER, equipLimit, LOADOUT_COUNT, LOADOUT_NAME_MAX, START_SLOTS,
} from '../shared/data';
import { clampCharId } from '../shared/characters';
import type { ElementId, GameState, Loadout, Spell } from '../shared/types';

const SAVE_KEY = 'magic_web_game_save_v1';

// ニックネームの所有者を示す秘密ID。
// これを持っている端末だけがその名前を使え、初期化すると名前は解放される。
function newNickToken(): string {
  return `nt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function emptyLoadouts(): Loadout[] {
  return Array.from({ length: LOADOUT_COUNT }, (_, i) => ({
    name: `セット${i + 1}`, ids: [],
  }));
}

function initialState(): GameState {
  return {
    version: 1,
    nickname: '',
    nickToken: newNickToken(),
    charId: 0,
    researchP: 30,
    inventory: {
      fire: 4, water: 4, wind: 3, earth: 3,
      thunder: 1, ice: 1, light: 0, dark: 0,
    },
    spells: [],
    equipped: [],
    discovered: [],
    slots: START_SLOTS,
    maxStage: 1,
    bestStage: 0,
    bossCleared: [],
    sortMode: 'use',
    loadouts: emptyLoadouts(),
    legendRewarded: false,
    codexRewarded: false,
  };
}

export let state: GameState = load();

function load(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return initialState();
    return migrate(JSON.parse(raw) as Partial<GameState>);
  } catch {
    return initialState();
  }
}

// 欠損の補完と魔法の性能再計算(ローカルセーブ・クラウドセーブの両方が通る)
function migrate(parsed: Partial<GameState>): GameState {
  try {
    // 旧セーブの移行: 強化レベルが無い魔法は0で補完
    const merged = { ...initialState(), ...parsed };
    // 選んだキャラクター(古いセーブには無い・範囲外は0に丸める)
    merged.charId = clampCharId(merged.charId);
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
        // 名前もレシピから作り直す。
        // セーブに書かれた名前をそのまま使うと、命名の決まりを変えても
        // 昔に作った魔法だけ古い名前で残る(火を「炎」と書いていた頃の
        // 〈炎2風2〉が消えない、など)。名前は自動で決まるもので、
        // 本人が付けた名前ではないので作り直して構わない。
        sp.name = spellNameFor(sp.recipe ?? {}, sp.rarity);
      } catch { /* レシピが壊れている場合は元の値のまま */ }
    }
    if (typeof merged.nickname !== 'string') merged.nickname = '';
    if (typeof merged.nickToken !== 'string' || !merged.nickToken) {
      merged.nickToken = newNickToken();
    }
    if (!Array.isArray(merged.bossCleared)) merged.bossCleared = [];
    // 並び順: 旧版は「魔導値順かどうか」の真偽値だった。
    // 既定を装備頻度順に変えたので、魔導値順を選んでいた人だけその設定を引き継ぐ。
    //
    // 見るのは merged ではなく parsed(セーブの生の中身)。
    // merged は initialState() を下敷きにしているので、常に既定値が入っており
    // 「保存されていない」ことが判別できない。
    const rawSort = (parsed as { sortMode?: unknown }).sortMode;
    if (rawSort !== 'use' && rawSort !== 'power' && rawSort !== 'order') {
      merged.sortMode = merged.sortByPower === true ? 'power' : 'use';
    }
    delete merged.sortByPower;
    // 旧版の魔法には装備回数が無い。今まさに装備しているものは1回とみなす。
    for (const sp of merged.spells ?? []) {
      if (typeof sp.equipCount !== 'number' || !Number.isFinite(sp.equipCount)) {
        sp.equipCount = (merged.equipped ?? []).includes(sp.id) ? 1 : 0;
      }
    }
    // 装備セット: 数が足りない古いセーブは空きで埋め、余りは切る。
    // 中身も名前も外から来た値なので、形だけは必ずそろえておく。
    {
      const base = emptyLoadouts();
      const got = Array.isArray(merged.loadouts) ? merged.loadouts : [];
      merged.loadouts = base.map((slot, i) => {
        const g = got[i] as Partial<Loadout> | undefined;
        if (!g) return slot;
        return {
          name: typeof g.name === 'string' && g.name.trim()
            ? g.name.slice(0, LOADOUT_NAME_MAX) : slot.name,
          ids: Array.isArray(g.ids) ? g.ids.filter(x => typeof x === 'string') : [],
        };
      });
    }
    if (typeof merged.codexRewarded !== 'boolean') merged.codexRewarded = false;
    if (typeof merged.legendRewarded !== 'boolean') merged.legendRewarded = false;
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

// クラウドから取り出したデータで丸ごと置き換える(引き継ぎ)
export function applyLoadedState(loaded: Partial<GameState>): void {
  state = migrate(loaded);
  notify();
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
  if (typeof spell.equipCount !== 'number') spell.equipCount = 0;
  state.spells.push(spell);
  // 空きがあれば自動装備
  if (state.equipped.length < equipSlots()) {
    state.equipped.push(spell.id);
    spell.equipCount++;
  }
}

// 今この人が装備できる数。ボスを倒すと増える。
export function equipSlots(): number {
  return equipLimit(state.bossCleared);
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
  // 分解した魔法は二度と戻らないので、覚えてある装備セットからも外す。
  // 残しておくと、呼び出すたびに黙って1本少ないセットが組まれることになる。
  for (const lo of state.loadouts) lo.ids = lo.ids.filter(e => e !== id);
}

// ---- お気に入りの装備セット ----

// 今の装備をそのまま覚える(並び=キーの順番も含めて)
export function saveLoadout(slot: number): void {
  const lo = state.loadouts[slot];
  if (!lo) return;
  lo.ids = [...state.equipped];
}

export function renameLoadout(slot: number, name: string): void {
  const lo = state.loadouts[slot];
  if (!lo) return;
  const trimmed = name.trim().slice(0, LOADOUT_NAME_MAX);
  lo.name = trimmed || `セット${slot + 1}`;
}

// 覚えたセットを装備し直す。
// 戻り値は呼び出した結果の内訳(画面で「1本は分解済みだった」と伝えるため)。
export function applyLoadout(slot: number): {
  equipped: number; missing: number; overflow: number;
} {
  const lo = state.loadouts[slot];
  if (!lo) return { equipped: 0, missing: 0, overflow: 0 };

  // 分解された魔法は飛ばす
  const alive = lo.ids.filter(id => state.spells.some(s => s.id === id));
  const missing = lo.ids.length - alive.length;

  // 装備できる数はボスを倒すと増える。逆に、増える前に作ったセットを
  // 引き継いだ場合は入りきらないので、先頭から入るだけ入れる。
  const cap = equipSlots();
  const ids = alive.slice(0, cap);
  const overflow = alive.length - ids.length;

  // 装備し直しの回数も数える(魔導書の「装備頻度順」に効く)。
  // 既に着けているものは数えない。同じセットを繰り返し呼んでも増えない。
  for (const id of ids) {
    if (state.equipped.includes(id)) continue;
    const sp = state.spells.find(s => s.id === id);
    if (sp) sp.equipCount = (sp.equipCount ?? 0) + 1;
  }
  state.equipped = ids;
  return { equipped: ids.length, missing, overflow };
}

// 今の装備とぴったり同じセットか(並びまで一致した時だけ)
export function loadoutIsCurrent(slot: number): boolean {
  const lo = state.loadouts[slot];
  if (!lo || lo.ids.length === 0) return false;
  if (lo.ids.length !== state.equipped.length) return false;
  return lo.ids.every((id, i) => state.equipped[i] === id);
}

export function toggleEquip(id: string): void {
  if (state.equipped.includes(id)) {
    state.equipped = state.equipped.filter(e => e !== id);
  } else if (state.equipped.length < equipSlots()) {
    state.equipped.push(id);
    // 装備した回数を数える。よく使う魔法が魔導書の上に来るようにするため。
    // 外した時は減らさない(「これまで何回使ったか」を見たいので)。
    const sp = state.spells.find(s => s.id === id);
    if (sp) sp.equipCount = (sp.equipCount ?? 0) + 1;
  }
}

// 装備中の魔法。並びは「装備した順」。
//
// state.equipped は装備するたびに末尾へ足されるので、この配列の順番が
// そのまま戦闘のキー1・2・3…になる。外して付け直すと最後尾に回る。
// 魔導書の表示順(魔導値順など)とは切り離してある。並び替えるたびに
// キーの割り当てが変わってしまうと、体が覚えた操作が毎回崩れるため。
export function equippedSpells(): Spell[] {
  const out: Spell[] = [];
  for (const id of state.equipped) {
    const sp = state.spells.find(s => s.id === id);
    if (sp) out.push(sp);
  }
  return out;
}

// その魔法が戦闘の何番のキーか(装備していなければ0)
export function equipSlotNo(id: string): number {
  return state.equipped.indexOf(id) + 1;
}

// 魔導書の並び順にそろえる。研究室で見えている順が、そのまま戦闘のキー1〜6になる。
export function sortSpells(list: Spell[]): Spell[] {
  const out = [...list];
  if (state.sortMode === 'power') {
    out.sort((a, b) => spellMagicValue(b.stats) - spellMagicValue(a.stats));
  } else if (state.sortMode === 'use') {
    // 装備回数が同じなら魔導値の高い方を上に。
    // 回数が0どうし(まだ一度も装備していない)でも並びが安定する。
    out.sort((a, b) =>
      (b.equipCount ?? 0) - (a.equipCount ?? 0)
      || spellMagicValue(b.stats) - spellMagicValue(a.stats));
  }
  return out;   // order は調合した順のまま
}

export function totalInventory(): number {
  return Object.values(state.inventory).reduce((a, b) => a + b, 0);
}

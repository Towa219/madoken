// 研究室(調合・魔導書・図鑑)のDOM UI

import {
  DISASSEMBLE_RATE, DISCOVERY_BONUS_RP, ELEMENT_POOL, ELEMENTS, ELEMENT_ORDER,
  BOSS_REWARDS, bossRewardFor,
  GATHER_COST, GATHER_COUNT, LEGEND_BOSS_STAGE, LIBRARY_BONUS_MAX, LIBRARY_BONUS_START,
  libraryBonus, RARITIES, rarityMultiplier, RECIPES, rollRarity,
  LOADOUT_NAME_MAX, nextEquipUnlock,
  SLOT3_COST, SLOT4_BOSS_STAGE, SLOT4_COST, SLOT5_BOSS_STAGE, SLOT5_COST,
  SLOT6_BOSS_STAGE, SLOT6_COST,
  TRANSMUTE_COST, transmuteResult,
} from '../shared/data';
import {
  computeSpell, ENHANCE_MAX, finalStats, randomComposition, recipesEqual,
  spellDisplayName, spellMagicValue, spellNameFor, statsSummary,
} from '../shared/spellcraft';
import {
  addElements, addSpell, applyLoadout, deleteSpell, equipSlotNo, equipSlots,
  hasBossCleared, loadoutIsCurrent, notify, playerMagicTotal, renameLoadout, save, saveLoadout,
  sortSpells, spendElements, state, toggleEquip, totalInventory, withCharBonus,
} from './state';
import type { ElementCounts, ElementId, Spell, SpellSort } from '../shared/types';
import { playSfx, startSfxLoop, stopSfxLoop } from './sound';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// 調合スロットの選択状態(セーブ対象外)
let slotSel: (ElementId | null)[] = [];

// 直前に増えたエレメント(素材庫で光らせる用)。描画時に消費される
const gained = new Map<ElementId, number>();

// エレメントを入手して素材庫を光らせる(採取・分解・共闘のドロップから呼ぶ)
export function markGained(ids: ElementId[]): void {
  for (const id of ids) gained.set(id, (gained.get(id) ?? 0) + 1);
}

let toastTimer: number | undefined;
export function showToast(msg: string): void {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 3200);
}

// スロットに置いた個数(調合前のプレビュー用)
function selCounts(): ElementCounts {
  const counts: ElementCounts = {};
  for (const id of slotSel) {
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function placedOf(id: ElementId): number {
  return slotSel.filter(s => s === id).length;
}

// 魔導書に収まっている魔法の「種類」数(レシピが違えば別の種類)。
// 多いほど上位品質が生まれやすくなる。
export function spellKindCount(): number {
  const seen = new Set<string>();
  for (const sp of state.spells) {
    const key = ELEMENT_ORDER
      .map(id => `${id}${sp.recipe?.[id] ?? 0}`)
      .join('-');
    seen.add(key);
  }
  return seen.size;
}

// スロットの構成と同じレシピの既存魔法を探す(強化対象)
function findSameRecipeSpell(counts: ElementCounts): Spell | undefined {
  return state.spells.find(sp => recipesEqual(sp.recipe, counts));
}

export function initLab(): void {
  // 討伐報酬の確認用の入口。ステージ30〜50まで実際に進めるのは時間がかかるため、
  // テストからここを呼んで「初回だけ渡る」ことを確かめる。
  // 遊びの流れからは触れられない(押せるボタンはどこにも無い)。
  (window as unknown as { __madokenGrantBoss?: (stage: number) => void })
    .__madokenGrantBoss = grantBossReward;

  $('#btn-craft').addEventListener('click', craft);
  $('#btn-gather').addEventListener('click', gather);
  $('#btn-transmute').addEventListener('click', transmute);
  $('#btn-transmute-cancel').addEventListener('click', cancelTransmute);
  $('#btn-sort-spells').addEventListener('click', () => {
    // 装備頻度順 → 魔導値順 → 取得順 → 装備頻度順 …
    const order: SpellSort[] = ['use', 'power', 'order'];
    const i = order.indexOf(state.sortMode);
    state.sortMode = order[(i + 1) % order.length];
    notify();
  });
  renderLab();
}

export function renderLab(): void {
  grantCodexRewardIfDue(); // 図鑑コンプリート報酬(まだなら1回だけ)

  // スロット数が増えた場合に選択配列を追従
  while (slotSel.length < state.slots) slotSel.push(null);
  slotSel = slotSel.slice(0, state.slots);

  renderInventory();
  renderTransmute();
  renderSlots();
  renderPreview();
  renderSpellbook();
  renderRecipes();
  renderGather();
}

// ---- 素材庫 ----
function renderInventory(): void {
  const grid = $('#inv-grid');
  grid.innerHTML = '';
  for (const id of ELEMENT_ORDER) {
    const def = ELEMENTS[id];
    const have = state.inventory[id] ?? 0;
    const free = have - placedOf(id);
    const got = gained.get(id) ?? 0;
    const card = document.createElement('div');
    // 錬成の選択中は、使える素材だけを選べるようにする
    const tmOk = transmuteMode && canTransmute(id);
    const cls = 'elem-card'
      + (free <= 0 ? ' empty' : '')
      + (got > 0 ? ' elem-gained' : '')
      + (transmuteMode ? (tmOk ? ' tm-ok' : ' tm-ng') : '')
      + (transmutePick === id ? ' tm-picked' : '');
    card.className = cls;
    card.innerHTML =
      `<span class="ename" style="color:${def.cssColor}">`
      + `<span class="eemoji">${def.emoji}</span>${def.name}</span>` +
      (got > 0 ? `<span class="gain-badge">+${got}</span>` : '') +
      `<span class="ecount">×${free}</span>` +
      `<div class="edesc">${def.desc}</div>`;
    if (transmuteMode) {
      if (tmOk) card.addEventListener('click', () => pickTransmute(id));
    } else if (free > 0) {
      card.addEventListener('click', () => {
        const empty = slotSel.indexOf(null);
        if (empty === -1) return;
        slotSel[empty] = id;
        playSfx('select');
        renderLab();
      });
    }
    grid.appendChild(card);
  }
  gained.clear(); // 光らせるのは1回だけ
}

// ---- 調合スロット ----
function renderSlots(): void {
  const row = $('#slot-row');
  row.innerHTML = '';
  // 枠が増えるほど1枠が細くなる(6つでスマホだと50px前後)。
  // 説明の文字は短いものに切り替える。長いままだと枠から溢れて読めない。
  const tight = state.slots >= 5;
  const emptyLabel = tight ? '空き' : '空きスロット';
  const backLabel = tight ? '戻す' : 'クリックで戻す';
  for (let i = 0; i < state.slots; i++) {
    const id = slotSel[i];
    const slot = document.createElement('div');
    slot.className = 'slot' + (id ? ' filled' : '');
    if (id) {
      const def = ELEMENTS[id];
      slot.innerHTML =
        `<span style="color:${def.cssColor}">`
        + `<span class="eemoji">${def.emoji}</span>${def.name}</span>` +
        `<span class="slabel">${backLabel}</span>`;
      slot.style.borderColor = def.cssColor;
      slot.addEventListener('click', () => {
        slotSel[i] = null;
        playSfx('unselect');
        renderLab();
      });
    } else {
      slot.innerHTML = `<span class="slabel">${emptyLabel}</span>`;
    }
    row.appendChild(slot);
  }

  const unlock = $('#slot-unlock');
  unlock.innerHTML = '';
  // boss=0 は研究Pだけで解放できる(第3スロット)
  // 増やす時はここに1行足す。上限は MAX_SLOTS。
  const SLOT_STEPS: { need: number; next: number; cost: number; boss: number }[] = [
    { need: 2, next: 3, cost: SLOT3_COST, boss: 0 },
    { need: 3, next: 4, cost: SLOT4_COST, boss: SLOT4_BOSS_STAGE },
    { need: 4, next: 5, cost: SLOT5_COST, boss: SLOT5_BOSS_STAGE },
    { need: 5, next: 6, cost: SLOT6_COST, boss: SLOT6_BOSS_STAGE },
  ];
  const spec = SLOT_STEPS.find(s => s.need === state.slots) ?? null;
  if (spec) {
    const bossOk = spec.boss === 0 || hasBossCleared(spec.boss);
    const b = document.createElement('button');
    b.textContent = `第${spec.next}スロット解放 (研究P${spec.cost})`;
    b.disabled = !bossOk || state.researchP < spec.cost;
    b.addEventListener('click', () => {
      if (!bossOk || state.researchP < spec.cost) return;
      state.researchP -= spec.cost;
      state.slots = spec.next;
      showToast(`第${spec.next}スロットを解放した!`);
      notify();
    });
    unlock.appendChild(b);
    const cond = document.createElement('div');
    cond.className = bossOk ? 'note chance-high' : 'note chance-mid';
    cond.textContent = spec.boss === 0
      ? '条件: 研究Pのみ(3素材の系統に手が届くようになる)'
      : bossOk
        ? `条件クリア: ステージ${spec.boss}のボスを撃破済み`
        : `条件: ステージ${spec.boss}のボス撃破が必要(共闘部屋から挑戦。1人でも可)`;
    unlock.appendChild(cond);
  }
}

// ---- プレビュー ----
function renderPreview(): void {
  if (crafting) return; // 調合中はボタン・表示を上書きしない
  // 中身が変わったら確認待ちは無かったことにする(下でボタンの字も戻る)
  cancelCraftConfirm();
  const box = $('#preview-box');
  const counts = selCounts();
  const used = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  if (used < 2) {
    box.classList.add('hidden');
    const b = $<HTMLButtonElement>('#btn-craft');
    b.setAttribute('disabled', 'true');
    b.textContent = '調合する'; // 「調合中…」のまま残らないように戻す
    return;
  }
  box.classList.remove('hidden');
  const craftBtn = $<HTMLButtonElement>('#btn-craft');
  craftBtn.removeAttribute('disabled');

  const { stats, matched, autoName } = computeSpell(counts);

  // 同一レシピの既存魔法があれば「強化」モード
  const same = findSameRecipeSpell(counts);
  if (same) {
    if (same.level >= ENHANCE_MAX) {
      craftBtn.textContent = '強化上限';
      craftBtn.setAttribute('disabled', 'true');
      box.innerHTML =
        `<div class="pname">${spellDisplayName(same)}</div>` +
        `<div>${statsSummary(same.stats)}</div>` +
        `<div class="pwarn">この魔法はすでに最大強化(+${ENHANCE_MAX})に達している。</div>`;
      return;
    }
    const next = finalStats(same.recipe, same.level + 1, same.rarity);
    const ch = craftChance(counts, same.level);
    craftBtn.textContent = `強化する (+${same.level} → +${same.level + 1})`;
    box.innerHTML =
      `<div class="pname">⚗ 強化: ${spellDisplayName(same)} → ${same.name} +${same.level + 1}` +
      ` <span class="mval">魔導値 ${spellMagicValue(same.stats)} → ${spellMagicValue(next)}</span></div>` +
      `<div>${statsSummary(next)}</div>` +
      `<div class="${chanceClass(ch)}">調合成功率: ${ch}%${ch < 100 ? ' (失敗すると素材の半分を失う)' : ''}</div>` +
      `<div class="precipe">同一レシピのため、新規作成ではなくこの魔法が強化される(威力+8%・詠唱-2%/段階)。</div>`;
    return;
  }

  craftBtn.textContent = '調合する';
  const ch = craftChance(counts, 0);
  const recipeNote = matched.length > 0
    ? `<div class="precipe">★ 系統成立: ${matched.map(r =>
        state.discovered.includes(r.id) ? r.name : '???(未知の反応)').join('、')}</div>`
    : '';
  box.innerHTML =
    `<div class="pname">${autoName} <span class="mval">魔導値 ${spellMagicValue(stats)}</span></div>` +
    `<div>${statsSummary(stats)}</div>` +
    `<div class="${chanceClass(ch)}">調合成功率: ${ch}%${ch < 100 ? ' (失敗すると素材の半分を失う)' : ''}</div>` +
    rarityLine(counts) +
    recipeNote;
}

// 上位品質の出現率(素材構成と魔導書の種類数で変わる)
function rarityLine(counts: ElementCounts): string {
  const kinds = spellKindCount();
  const mul = rarityMultiplier(counts, kinds);
  const pct = (base: number) => {
    const p = Math.min(100, base * mul * 100);
    return p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
  };
  const lb = libraryBonus(kinds);
  const cap = lb >= LIBRARY_BONUS_MAX
    ? '(上限)'
    : kinds <= LIBRARY_BONUS_START
      ? `・あと${LIBRARY_BONUS_START + 1 - kinds}種でボーナス開始`
      : '';
  return `<div class="prarity">上位品質: `
    + `<span style="color:${RARITIES.rare.cssColor}">${RARITIES.rare.name} ${pct(RARITIES.rare.chance)}</span> / `
    + `<span style="color:${RARITIES.epic.cssColor}">${RARITIES.epic.name} ${pct(RARITIES.epic.chance)}</span> / `
    + `<span style="color:${RARITIES.legend.cssColor}">${RARITIES.legend.name} ${pct(RARITIES.legend.chance)}</span>`
    + ` <small>(魔導書 ${kinds}種で ×${lb.toFixed(2)}${cap})</small></div>`;
}

// ---- 調合実行(進行バー+成功率+失敗あり) ----

let crafting = false;

// 「調合する」を押した1回目は、押しただけでは何も起きない。
// ボタンが「本当に調合する」に変わり、もう一度押して初めて素材が減る。
// 素材は戻ってこない(失敗すれば半分は失う)ので、誤爆を1回ぶん遠ざける。
let confirming = false;
let confirmTimer = 0;
const CONFIRM_SEC = 6;

// 確認待ちをやめる。スロットを触った時にも呼ばれるので、
// 「別の組み合わせに変えたのに、前の確認がそのまま生きていた」が起きない。
export function cancelCraftConfirm(): void {
  if (confirmTimer) { window.clearTimeout(confirmTimer); confirmTimer = 0; }
  if (!confirming) return;
  confirming = false;
  $<HTMLButtonElement>('#btn-craft').classList.remove('confirm');
}

// 成功率: 素材が多い・光/闇使用・高強化ほど難しい(下限40%)
export function craftChance(counts: ElementCounts, enhanceLevel: number): number {
  const used = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const rare = (counts.light ?? 0) + (counts.dark ?? 0);
  const c = 100 - Math.max(0, used - 2) * 8 - rare * 5 - enhanceLevel * 5;
  return Math.max(40, Math.min(100, Math.round(c)));
}

function chanceClass(c: number): string {
  return c >= 85 ? 'chance-high' : c >= 60 ? 'chance-mid' : 'chance-low';
}

function craft(): void {
  if (crafting) return;
  const counts = selCounts();
  const used = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  if (used < 2) return;

  const same = findSameRecipeSpell(counts);
  if (same && same.level >= ENHANCE_MAX) {
    $('#craft-msg').textContent = `「${same.name}」はすでに最大強化。素材は消費していない。`;
    return;
  }
  // 素材の事前チェック(消費は完了時)
  for (const [id, cnt] of Object.entries(counts) as [ElementId, number][]) {
    if ((state.inventory[id] ?? 0) < cnt) {
      $('#craft-msg').textContent = '素材が足りない…';
      return;
    }
  }

  // ★ 1回目の押しはここで折り返す。素材にはまだ触っていない。
  if (!confirming) {
    confirming = true;
    const b = $<HTMLButtonElement>('#btn-craft');
    b.textContent = same ? '本当に強化する' : '本当に調合する';
    b.classList.add('confirm');
    const msg = $('#craft-msg');
    msg.style.color = '#ffcc66';
    msg.textContent = `もう一度押すと${same ? '強化' : '調合'}する(素材を使う)。`;
    // 押しっぱなしで放置された時は元に戻す。赤いボタンが残り続けて、
    // だいぶ経ってからうっかり押す、というのがいちばん困る。
    confirmTimer = window.setTimeout(() => {
      confirmTimer = 0;
      cancelCraftConfirm();
      $('#craft-msg').textContent = '';
      renderPreview();
    }, CONFIRM_SEC * 1000);
    return;
  }
  cancelCraftConfirm();

  crafting = true;
  startSfxLoop('crafting');
  const btn = $<HTMLButtonElement>('#btn-craft');
  btn.setAttribute('disabled', 'true');
  btn.textContent = '調合中…';
  const bar = $('#craft-bar');
  const fill = $('#craft-bar-fill');
  const msgEl = $('#craft-msg');
  msgEl.textContent = '';
  msgEl.style.color = '#88ddaa';
  bar.classList.remove('hidden');
  fill.style.width = '0%';

  const duration = 1200 + used * 250; // 素材が多いほどじっくり進む
  const start = performance.now();
  const timer = window.setInterval(() => {
    const p = Math.min(1, (performance.now() - start) / duration);
    fill.style.width = `${Math.round(p * 100)}%`;
    if (p >= 1) {
      window.clearInterval(timer);
      crafting = false;
      bar.classList.add('hidden');
      stopSfxLoop('crafting');
      resolveCraft(counts, same);
    }
  }, 30);
}

function resolveCraft(counts: ElementCounts, same: Spell | undefined): void {
  const msgEl = $('#craft-msg');
  if (!spendElements(counts)) {
    msgEl.textContent = '素材が足りない…';
    renderLab();
    return;
  }

  const chance = craftChance(counts, same ? same.level : 0);
  if (Math.random() * 100 >= chance) {
    // 失敗: 素材の半分を回収
    const refund: ElementId[] = [];
    for (const [id, cnt] of Object.entries(counts) as [ElementId, number][]) {
      for (let i = 0; i < Math.floor(cnt / 2); i++) refund.push(id);
    }
    addElements(refund);
    slotSel = slotSel.map(() => null);
    msgEl.style.color = '#ff8877';
    msgEl.textContent = `調合失敗…(成功率${chance}%) 素材の半分は回収した。`;
    showToast('💥 調合失敗…');
  playSfx('craftFail');
    notify();
    return;
  }

  // 成功: 同一レシピなら強化
  if (same) {
    same.level += 1;
    same.stats = finalStats(same.recipe, same.level, same.rarity);
    slotSel = slotSel.map(() => null);
    playSfx('craft');
    showToast(`⚗ 強化成功!「${spellDisplayName(same)}」`);
    msgEl.textContent = `「${spellDisplayName(same)}」に強化した。`;
    notify();
    return;
  }

  const { matched } = computeSpell(counts);
  const rarity = rollRarity(counts, spellKindCount());
  const stats = finalStats(counts, 0, rarity);
  // エピック/レジェンドはカタカナの真名になる
  const name = spellNameFor(counts, rarity);

  // 新発見チェック
  let bonus = 0;
  const newFound: string[] = [];
  for (const r of matched) {
    if (!state.discovered.includes(r.id)) {
      state.discovered.push(r.id);
      newFound.push(r.name);
      bonus += DISCOVERY_BONUS_RP;
    }
  }
  state.researchP += bonus;

  const spell: Spell = {
    id: `sp_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    name, recipe: counts, stats,
    discoveries: matched.map(r => r.id),
    level: 0, rarity, equipCount: 0,
  };
  addSpell(spell);

  slotSel = slotSel.map(() => null);

  playSfx(newFound.length > 0 || rarity !== 'normal' ? 'discover' : 'craft');
  if (rarity !== 'normal') {
    showToast(`🌟 ${RARITIES[rarity].name}品質の魔法が生まれた!「${name}」`);
  } else if (newFound.length > 0) {
    showToast(`✨ 新系統発見!「${newFound.join('」「')}」 (研究P+${bonus})`);
  }
  $('#craft-msg').textContent =
    `「${spellDisplayName(spell)}」を調合した。魔導書に記録済み。`;
  notify();
}

// ---- 採取 ----
let gathering = false;

function renderGather(): void {
  if (gathering) return; // 採取中はボタン表示を上書きしない
  const btn = $<HTMLButtonElement>('#btn-gather');
  const pity = canFreeGather();
  btn.textContent = pity ? '採取に出る (無料)' : `採取に出る (研究P${GATHER_COST})`;
  btn.disabled = !pity && state.researchP < GATHER_COST;
}

// 詰み防止: 素材が尽き、採取する研究Pも無いときは無料で採取できる
// (勝利以外は研究Pが入らないため、この救済がないと再起不能になる)
export function canFreeGather(): boolean {
  return totalInventory() === 0 && state.researchP < GATHER_COST;
}

// 採取(調合と同じように進行バーが進んでから完了)
function gather(): void {
  if (gathering) return;
  const pity = canFreeGather();
  if (!pity && state.researchP < GATHER_COST) return;

  gathering = true;
  startSfxLoop('gathering');
  const btn = $<HTMLButtonElement>('#btn-gather');
  btn.disabled = true;
  btn.textContent = '採取中…';
  const bar = $('#gather-bar');
  const fill = $('#gather-bar-fill');
  bar.classList.remove('hidden');
  fill.style.width = '0%';

  const duration = 1600;
  const start = performance.now();
  const timer = window.setInterval(() => {
    const p = Math.min(1, (performance.now() - start) / duration);
    fill.style.width = `${Math.round(p * 100)}%`;
    if (p >= 1) {
      window.clearInterval(timer);
      gathering = false;
      bar.classList.add('hidden');
      stopSfxLoop('gathering');
      resolveGather(pity);
    }
  }, 30);
}

function resolveGather(pity: boolean): void {
  if (!pity) {
    if (state.researchP < GATHER_COST) {
      renderGather();
      return;
    }
    state.researchP -= GATHER_COST;
  }
  // 希少な光・闇は出にくい(錬成と同じ抽選プール)
  const got: ElementId[] = [];
  for (let i = 0; i < GATHER_COUNT; i++) {
    got.push(ELEMENT_POOL[Math.floor(Math.random() * ELEMENT_POOL.length)]);
  }
  addElements(got);
  markGained(got);
  const msg = $('#craft-msg');
  msg.style.color = '#88ffaa';
  msg.textContent = `✨ 採取で ${got.map(g => ELEMENTS[g].name).join('・')} を手に入れた!`;
  showToast(`✨ ${got.map(g => ELEMENTS[g].name).join('・')} を入手`);
  playSfx('gather');
  notify();
}

// ---- エレメント錬成(余った素材3つ → ランダムな1つ) ----
//
// ※「分解」は魔法を素材に戻す機能なので、こちらは「錬成」と呼び分けている。

// 調合スロットに置いている分を除いた、実際に使える手持ち
function freeInventory(): Partial<Record<ElementId, number>> {
  const free: Partial<Record<ElementId, number>> = {};
  for (const id of ELEMENT_ORDER) {
    free[id] = Math.max(0, (state.inventory[id] ?? 0) - placedOf(id));
  }
  return free;
}

// 錬成の選択中かどうか。選択中は素材庫のクリックが「錬成する素材の選択」になる。
export let transmuteMode = false;
let transmutePick: ElementId | null = null;

// 3個以上あって錬成に使える素材か
export function canTransmute(id: ElementId): boolean {
  return (freeInventory()[id] ?? 0) >= TRANSMUTE_COST;
}

export function isTransmuteMode(): boolean {
  return transmuteMode;
}

export function transmutePicked(): ElementId | null {
  return transmutePick;
}

// 素材庫のカードが押されたとき(選択中のみ)
export function pickTransmute(id: ElementId): void {
  if (!transmuteMode || !canTransmute(id)) return;
  transmutePick = transmutePick === id ? null : id; // もう一度押すと選択解除
  renderLab();
}

function anyTransmutable(): boolean {
  return ELEMENT_ORDER.some(id => canTransmute(id));
}

function endTransmuteMode(): void {
  transmuteMode = false;
  transmutePick = null;
}

function renderTransmute(): void {
  if (transmuting) return; // 錬成中はボタン表示を上書きしない
  const btn = $<HTMLButtonElement>('#btn-transmute');
  const cancel = $<HTMLButtonElement>('#btn-transmute-cancel');
  const note = $('#transmute-note');

  // 選択中に手持ちが減って条件を満たさなくなったら選択を外す
  if (transmutePick && !canTransmute(transmutePick)) transmutePick = null;

  if (!transmuteMode) {
    cancel.classList.add('hidden');
    btn.textContent = '錬成する';
    btn.disabled = !anyTransmutable();
    note.textContent = btn.disabled
      ? `同じ素材が${TRANSMUTE_COST}個そろっていない。採取や戦闘で集めよう。`
      : `押すと、${TRANSMUTE_COST}個以上ある素材を選べるようになる。`;
    return;
  }

  cancel.classList.remove('hidden');
  if (!transmutePick) {
    btn.textContent = '決定';
    btn.disabled = true;
    note.textContent = `素材庫から、${TRANSMUTE_COST}個以上ある素材を選んでください。`;
    return;
  }
  btn.textContent = `決定 (${ELEMENTS[transmutePick].name}${TRANSMUTE_COST}個 → ランダム1個)`;
  btn.disabled = false;
  note.textContent = '選んだ種類以外のエレメントが1個できる(光・闇は出にくい)。';
}

let transmuting = false;

// 「錬成する」→ 選択開始 / 「決定」→ 実行
function transmute(): void {
  if (transmuting) return;
  if (!transmuteMode) {
    if (!anyTransmutable()) return;
    transmuteMode = true;
    transmutePick = null;
    $('#transmute-msg').textContent = '';
    renderLab();
    return;
  }
  const id = transmutePick;
  if (!id || !canTransmute(id)) return;

  // 採取・調合と同じく、進行バーが左から100%まで進んでから完了する
  transmuting = true;
  startSfxLoop('transmuting');
  const btn = $<HTMLButtonElement>('#btn-transmute');
  btn.disabled = true;
  btn.textContent = '錬成中…';
  $<HTMLButtonElement>('#btn-transmute-cancel').disabled = true;
  $('#transmute-msg').textContent = '';
  const bar = $('#transmute-bar');
  const fill = $('#transmute-bar-fill');
  bar.classList.remove('hidden');
  fill.style.width = '0%';

  const duration = 1400;
  const start = performance.now();
  const timer = window.setInterval(() => {
    const p = Math.min(1, (performance.now() - start) / duration);
    fill.style.width = `${Math.round(p * 100)}%`;
    if (p >= 1) {
      window.clearInterval(timer);
      bar.classList.add('hidden');
      stopSfxLoop('transmuting');
      resolveTransmute(id);
    }
  }, 30);
}

// バーが最後まで進んでから、実際に素材を消費して結果を出す
function resolveTransmute(id: ElementId): void {
  transmuting = false;
  $<HTMLButtonElement>('#btn-transmute-cancel').disabled = false;
  // 進行中に手持ちが変わっていたら中止する(素材だけ消えないように)
  if (!canTransmute(id)) {
    endTransmuteMode();
    renderLab();
    return;
  }
  if (!spendElements({ [id]: TRANSMUTE_COST })) {
    endTransmuteMode();
    renderLab();
    return;
  }

  const got = transmuteResult(Array(TRANSMUTE_COST).fill(id) as ElementId[]);
  addElements([got]);
  markGained([got]);

  const msg = $('#transmute-msg');
  msg.style.color = '#88ffaa';
  msg.textContent =
    `⚗ ${ELEMENTS[id].name}${TRANSMUTE_COST}個を錬成して ${ELEMENTS[got].name} になった!`;
  showToast(`⚗ ${ELEMENTS[got].name} を錬成した`);
  playSfx('transmute');
  endTransmuteMode();
  notify();
}

function cancelTransmute(): void {
  endTransmuteMode();
  $('#transmute-msg').textContent = '';
  renderLab();
}

// 装備の番号を丸数字にする。7つ以上に増えた時は素の数字に落とす。
const EQ_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
function eqMark(n: number): string {
  return EQ_MARKS[n - 1] ?? String(n);
}

// ---- お気に入りの装備セット ----
//
// 装備の並び=戦闘のキーの順番なので、順番ごと覚えて丸ごと戻せるようにする。
// ボス用・雑魚用と組み替えるたびに1本ずつ着け直すのは手間がかかるうえ、
// 着けた順でキーが決まるので「並びまで元どおり」にするのが自力では難しい。
function renderLoadouts(): void {
  const box = $('#loadouts');

  // 名前を打っている最中は作り直さない(打った字が消えてしまうため)
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement && box.contains(focused)) return;

  box.innerHTML = '';
  state.loadouts.forEach((lo, i) => {
    const card = document.createElement('div');
    card.className = 'loadout' + (loadoutIsCurrent(i) ? ' current' : '');

    const name = document.createElement('input');
    name.className = 'lo-name';
    name.value = lo.name;
    name.maxLength = LOADOUT_NAME_MAX;
    name.placeholder = `セット${i + 1}`;
    name.title = '名前を付けられる(ボス用・削り用など)';
    // 打ち終わってから覚える。1文字ごとに作り直すと入力が飛ぶ。
    name.addEventListener('change', () => { renameLoadout(i, name.value); notify(); });
    card.appendChild(name);

    const items = document.createElement('div');
    items.className = 'lo-items';
    if (lo.ids.length === 0) {
      items.innerHTML = '<span class="lo-empty">空き — 今の装備を保存できる</span>';
    } else {
      items.innerHTML = lo.ids.map((id, k) => {
        const sp = state.spells.find(s => s.id === id);
        const mark = eqMark(k + 1);
        // ここは品質や強化値まで出さない(色で分かるし、縦に伸びると
        // 魔法の一覧が画面の下へ追いやられる)。見たいのは並びと顔ぶれ。
        return sp
          ? `<span class="lo-item" style="color:${RARITIES[sp.rarity].cssColor}">`
            + `${mark}${sp.name}</span>`
          : `<span class="lo-item lo-gone">${mark}分解済み</span>`;
      }).join('');
    }
    card.appendChild(items);

    const btns = document.createElement('div');
    btns.className = 'lo-btns';

    const call = document.createElement('button');
    call.textContent = '呼び出す';
    call.disabled = lo.ids.length === 0;
    call.addEventListener('click', () => {
      const r = applyLoadout(i);
      playSfx('equip');
      const extra = [
        r.missing > 0 ? `${r.missing}本は分解済みで外した` : '',
        r.overflow > 0 ? `装備できる数を超えた${r.overflow}本は入らなかった` : '',
      ].filter(Boolean).join(' / ');
      showToast(`「${lo.name}」を装備した(${r.equipped}本)${extra ? ` — ${extra}` : ''}`);
      notify();
    });
    btns.appendChild(call);

    const store = document.createElement('button');
    store.textContent = '今の装備を保存';
    store.disabled = state.equipped.length === 0;
    store.addEventListener('click', () => {
      saveLoadout(i);
      showToast(`今の装備を「${lo.name}」に覚えた(${state.equipped.length}本)`);
      notify();
    });
    btns.appendChild(store);

    card.appendChild(btns);
    box.appendChild(card);
  });
}

// ---- 魔導書 ----
function renderSpellbook(): void {
  const sortBtn = $<HTMLButtonElement>('#btn-sort-spells');
  const sortLabel: Record<SpellSort, string> = {
    use: '装備頻度順 ▼', power: '魔導値順 ▼', order: '取得順',
  };
  sortBtn.textContent = sortLabel[state.sortMode];
  sortBtn.title = 'クリックで並び替え(装備頻度順 → 魔導値順 → 取得順)';
  sortBtn.classList.toggle('active-sort', state.sortMode !== 'order');

  // 装備できる数はボスを倒すと増えるので、見出しも案内も毎回作り直す
  const cap = equipSlots();
  $('#equip-cap').textContent = `(装備は${cap}つまで)`;
  // 魔導値合計。オンラインの順位はこの数字で競う。
  //
  // ★ 「戦闘力」と混同させないこと。あれは今装備している魔法だけを見る。
  //   こちらは**持っている魔法すべて**から強い順に cap 本ぶんを足すので、
  //   装備していない魔法も数に入る。同じ画面に別々の数字が2つ出るので、
  //   何が違うのかを必ず書き添える。
  // ★ 数え方はサーバーの順位計算(server/ranking.ts の magicRankScore)と
  //   同じものを使うこと。別々に書くと、画面の数字と順位表がずれる。
  $('#magic-total').innerHTML =
    `<b>魔導値合計 ${playerMagicTotal()}</b> ― `
    + `持っている魔法のうち<b>強い順に${cap}本</b>ぶんの合計`
    + '(装備していない魔法も数に入る)。'
    + '<span class="chance-mid">オンラインの順位はこの数字で競う。</span>'
    + '上の帯の「戦闘力」は今装備している魔法だけを見た別の数字。';

  const next = nextEquipUnlock(state.bossCleared);
  $('#equip-note').innerHTML =
    `①②③…の番号が、そのまま戦闘のキー1〜${cap}になる。`
    + '<b>装備した順に番号が付く</b>ので、'
    + '外して付け直すと最後尾に回る(並び替えでは変わらない)。'
    + (next
      ? ` <span class="chance-mid">ステージ${next.boss}のボスを倒すと`
        + `装備できる数が${next.count}つに増える。</span>`
      : ' <span class="chance-high">装備数は最大まで解放済み。</span>');

  renderLoadouts();

  const list = $('#spell-list');
  list.innerHTML = '';
  if (state.spells.length === 0) {
    list.innerHTML = '<div class="empty-note">まだ魔法がない。素材を2つ以上調合してみよう。</div>';
    return;
  }

  // 得意エレメントの上乗せを効かせて出す。
  // ここだけ素の値にすると、上の戦闘力や実際の戦闘と数字が食い違う。
  const shown = sortSpells(state.spells).map(withCharBonus);

  for (const sp of shown) {
    const equipped = state.equipped.includes(sp.id);
    const card = document.createElement('div');
    card.className = `spell-card rarity-${sp.rarity}` + (equipped ? ' equipped' : '');
    const recipeStr = (Object.entries(sp.recipe) as [ElementId, number][])
      .map(([id, cnt]) => `${ELEMENTS[id].name}×${cnt}`).join(' ');
    card.innerHTML =
      `<div class="sname">`
      + (equipped ? `<span class="eqnum">${eqMark(equipSlotNo(sp.id))}</span> ` : '') +
      `<span style="color:${RARITIES[sp.rarity].cssColor}">${spellDisplayName(sp)}</span>` +
      ` <span class="mval">魔導値 ${spellMagicValue(sp.stats)}</span>` +
      ` <small style="color:#777799">(${recipeStr})</small></div>` +
      `<div class="sstats">${statsSummary(sp.stats)}</div>`;
    const btns = document.createElement('div');
    btns.className = 'sbtns';

    const eqBtn = document.createElement('button');
    eqBtn.textContent = equipped ? '装備解除' : '装備する';
    eqBtn.disabled = !equipped && state.equipped.length >= equipSlots();
    eqBtn.addEventListener('click', () => { toggleEquip(sp.id); notify(); });
    btns.appendChild(eqBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '分解';
    delBtn.addEventListener('click', () => {
      // confirmが使えない環境(公開版のiframe等)があるため2度押し確認
      if (delBtn.dataset.arm === '1') {
        disassemble(sp);
      } else {
        delBtn.dataset.arm = '1';
        delBtn.textContent = '本当に分解?';
        setTimeout(() => {
          delBtn.dataset.arm = '';
          delBtn.textContent = '分解';
        }, 2500);
      }
    });
    btns.appendChild(delBtn);

    card.appendChild(btns);
    list.appendChild(card);
  }
}

// 分解: 使った素材が低確率で戻る(強化・品質が高いほど戻りやすい)
function disassemble(sp: Spell): void {
  const bonus = 1 + sp.level * 0.05 + (RARITIES[sp.rarity].mul - 1) * 0.5;
  const rate = Math.min(0.9, DISASSEMBLE_RATE * bonus);
  const got: ElementId[] = [];
  for (const [id, cnt] of Object.entries(sp.recipe) as [ElementId, number][]) {
    for (let i = 0; i < cnt; i++) {
      if (Math.random() < rate) got.push(id);
    }
  }
  addElements(got);
  markGained(got);
  deleteSpell(sp.id);
  const msg = $('#craft-msg');
  msg.style.color = got.length > 0 ? '#88ffaa' : '#ff8877';
  msg.textContent = got.length > 0
    ? `♻ 分解して ${got.map(g => ELEMENTS[g].name).join('・')} を回収した。`
    : '分解したが、何も回収できなかった…';
  notify();
}

// ---- 発見図鑑 ----

// 深いボスを初めて倒したら、その品質の魔法を1つだけ授ける(最深部の報酬)。
//
// どのステージで何をもらえるかは shared/data.ts の BOSS_REWARDS に集めてある。
// 系統はランダムに選び、その系統が成立する構成の中で最も魔導値が高いものを作る。
// 上位品質は調合では滅多に出ないので、深く潜った証として確実に1本渡す。
// 同じステージから2本目は出ない。
export function grantBossReward(stage: number): void {
  const reward = bossRewardFor(stage);
  if (!reward) return;
  if (state.bossRewarded.includes(stage)) return;
  state.bossRewarded.push(stage); // 先に立てて二重取得を防ぐ
  // 古い端末と行き来しても二重取得にならないよう、旧い形式にも書いておく
  if (stage === LEGEND_BOSS_STAGE) state.legendRewarded = true;

  // 系統を1つ選ぶだけでは駄目。素材の数が足りない系統を引くと構成が作れず、
  // 条件を満たしたのに何も授からずに終わる(ガチャを作った時に表面化した)。
  const picked = randomComposition(Math.max(3, state.slots));
  if (!picked) { save(); return; }
  const counts = picked.counts;

  const { matched } = computeSpell(counts);
  const rewardName = spellNameFor(counts, reward.rarity); // カタカナの真名
  const spell: Spell = {
    id: `sp_boss${stage}_${Date.now()}`,
    name: rewardName,
    recipe: counts,
    stats: finalStats(counts, 0, reward.rarity),
    discoveries: matched.map(r => r.id),
    level: 0, equipCount: 0,
    rarity: reward.rarity,
  };
  addSpell(spell);
  save();
  notify();   // 図鑑の案内・魔導書・戦闘力をその場で描き直す
  showToast(
    `👑 ステージ${stage}のボスを討伐! `
    + `【${RARITIES[reward.rarity].name}】「${rewardName}」を授かった!`,
  );
}

// 全系統を発見していたら、その証としてエピック品質の魔法を1つだけ授ける。
// 系統はランダムに選び、その系統が成立する構成の中で最も魔導値が高いものを作る。
function grantCodexRewardIfDue(): void {
  if (state.codexRewarded) return;
  if (RECIPES.some(r => !state.discovered.includes(r.id))) return;

  state.codexRewarded = true; // 先に立てて二重取得を防ぐ

  // 系統を1つ選ぶだけでは駄目。素材の数が足りない系統を引くと構成が作れず、
  // 条件を満たしたのに何も授からずに終わる(ガチャを作った時に表面化した)。
  const picked = randomComposition(Math.max(3, state.slots));
  if (!picked) { save(); return; }
  const counts = picked.counts;

  const { matched } = computeSpell(counts);
  const rewardName = spellNameFor(counts, 'epic'); // カタカナの真名
  const spell: Spell = {
    id: `sp_codex_${Date.now()}`,
    name: rewardName,
    recipe: counts,
    stats: finalStats(counts, 0, 'epic'),
    discoveries: matched.map(r => r.id),
    level: 0, equipCount: 0,
    rarity: 'epic',
  };
  addSpell(spell);
  save();
  showToast(`📚 発見図鑑コンプリート! 【${RARITIES.epic.name}】「${rewardName}」を授かった!`);
}

function renderRecipes(): void {
  const list = $('#recipe-list');
  list.innerHTML = '';
  const found = RECIPES.filter(r => state.discovered.includes(r.id)).length;
  $('#recipe-progress').textContent = `(${found} / ${RECIPES.length} 系統を発見)`;

  // コンプリート報酬の案内
  const banner = document.createElement('div');
  banner.className = 'codex-reward' + (state.codexRewarded ? ' done' : '');
  banner.innerHTML = state.codexRewarded
    ? `🏆 <b>コンプリート達成</b> — 報酬の`
      + `<span style="color:${RARITIES.epic.cssColor}">【${RARITIES.epic.name}】</span>`
      + `魔法は魔導書に収めてあります。`
    : `🎁 <b>コンプリート報酬</b> — 全${RECIPES.length}系統を発見すると、`
      + `<span style="color:${RARITIES.epic.cssColor}">【${RARITIES.epic.name}】</span>`
      + `品質の魔法(性能×${RARITIES.epic.mul})がランダムな系統で1つ贈られます。`
      + ` あと<b>${RECIPES.length - found}</b>系統。`;
  list.appendChild(banner);

  // 最深部のボスの報酬も並べて出す。存在を知らないと目標にならない。
  for (const rw of BOSS_REWARDS) {
    const got = state.bossRewarded.includes(rw.stage);
    const r = RARITIES[rw.rarity];
    const row = document.createElement('div');
    row.className = 'codex-reward' + (got ? ' done' : '');
    const chip = `<span style="color:${r.cssColor}">【${r.name}】</span>`;
    row.innerHTML = got
      ? `👑 <b>ステージ${rw.stage}のボス討伐済み</b> — 報酬の${chip}`
        + `魔法は魔導書に収めてあります。`
      : `👑 <b>最深部の報酬</b> — <b>ステージ${rw.stage}</b>のボスを倒すと、${chip}`
        + `品質の魔法(性能×${r.mul})がランダムな系統で1つ贈られます。`
        + ` 通常の調合では${(1 / r.chance).toLocaleString('ja-JP')}回に1回しか出ません。`;
    list.appendChild(row);
  }

  for (const r of RECIPES) {
    const found = state.discovered.includes(r.id);
    const row = document.createElement('div');
    row.className = 'recipe-row ' + (found ? 'found' : 'unfound');
    row.innerHTML = found
      ? `<span class="rname">${r.name}</span> — ${r.desc}`
      : `<span class="rname">???</span> — ヒント: ${r.hint}`;
    list.appendChild(row);
  }
}

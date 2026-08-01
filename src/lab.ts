// 研究室(調合・魔導書・図鑑)のDOM UI

import {
  DISCOVERY_BONUS_RP, ELEMENTS, ELEMENT_ORDER, GATHER_COST,
  RECIPES, SLOT4_COST, SLOT5_COST,
} from '../shared/data';
import {
  applyEnhance, computeSpell, ENHANCE_MAX, spellDisplayName,
  spellMagicValue, statsSummary,
} from '../shared/spellcraft';
import {
  addElements, addSpell, deleteSpell, notify, spendElements,
  state, toggleEquip, totalInventory,
} from './state';
import type { ElementCounts, ElementId, Spell } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// 調合スロットの選択状態(セーブ対象外)
let slotSel: (ElementId | null)[] = [];

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

// レシピ(エレメント構成)が完全一致か
function recipesEqual(a: ElementCounts, b: ElementCounts): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ElementId>;
  for (const id of ids) {
    if ((a[id] ?? 0) !== (b[id] ?? 0)) return false;
  }
  return true;
}

// スロットの構成と同じレシピの既存魔法を探す(強化対象)
function findSameRecipeSpell(counts: ElementCounts): Spell | undefined {
  return state.spells.find(sp => recipesEqual(sp.recipe, counts));
}

export function initLab(): void {
  $('#btn-craft').addEventListener('click', craft);
  $('#btn-gather').addEventListener('click', gather);
  renderLab();
}

export function renderLab(): void {
  // スロット数が増えた場合に選択配列を追従
  while (slotSel.length < state.slots) slotSel.push(null);
  slotSel = slotSel.slice(0, state.slots);

  renderInventory();
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
    const card = document.createElement('div');
    card.className = 'elem-card' + (free <= 0 ? ' empty' : '');
    card.innerHTML =
      `<span class="ename" style="color:${def.cssColor}">${def.name}</span>` +
      `<span class="ecount">×${free}</span>` +
      `<div class="edesc">${def.desc}</div>`;
    if (free > 0) {
      card.addEventListener('click', () => {
        const empty = slotSel.indexOf(null);
        if (empty === -1) return;
        slotSel[empty] = id;
        renderLab();
      });
    }
    grid.appendChild(card);
  }
}

// ---- 調合スロット ----
function renderSlots(): void {
  const row = $('#slot-row');
  row.innerHTML = '';
  for (let i = 0; i < state.slots; i++) {
    const id = slotSel[i];
    const slot = document.createElement('div');
    slot.className = 'slot' + (id ? ' filled' : '');
    if (id) {
      const def = ELEMENTS[id];
      slot.innerHTML = `<span style="color:${def.cssColor}">${def.name}</span>` +
        `<span class="slabel">クリックで戻す</span>`;
      slot.style.borderColor = def.cssColor;
      slot.addEventListener('click', () => { slotSel[i] = null; renderLab(); });
    } else {
      slot.innerHTML = `<span class="slabel">空きスロット</span>`;
    }
    row.appendChild(slot);
  }

  const unlock = $('#slot-unlock');
  unlock.innerHTML = '';
  if (state.slots === 3) {
    const b = document.createElement('button');
    b.textContent = `第4スロット解放 (研究P${SLOT4_COST})`;
    b.disabled = state.researchP < SLOT4_COST;
    b.addEventListener('click', () => {
      state.researchP -= SLOT4_COST;
      state.slots = 4;
      showToast('第4スロットを解放した!');
      notify();
    });
    unlock.appendChild(b);
  } else if (state.slots === 4) {
    const b = document.createElement('button');
    b.textContent = `第5スロット解放 (研究P${SLOT5_COST})`;
    b.disabled = state.researchP < SLOT5_COST;
    b.addEventListener('click', () => {
      state.researchP -= SLOT5_COST;
      state.slots = 5;
      showToast('第5スロットを解放した! 深淵の調合が可能に…');
      notify();
    });
    unlock.appendChild(b);
  }
}

// ---- プレビュー ----
function renderPreview(): void {
  if (crafting) return; // 調合中はボタン・表示を上書きしない
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
    const next = applyEnhance(computeSpell(same.recipe).stats, same.level + 1);
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
    recipeNote;
}

// ---- 調合実行(進行バー+成功率+失敗あり) ----

let crafting = false;

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

  crafting = true;
  const btn = $<HTMLButtonElement>('#btn-craft');
  btn.setAttribute('disabled', 'true');
  btn.textContent = '調合中…';
  const bar = $('#craft-bar');
  const fill = $('#craft-bar-fill');
  const msgEl = $('#craft-msg');
  msgEl.textContent = '';
  msgEl.style.color = '';
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
    notify();
    return;
  }

  // 成功: 同一レシピなら強化
  if (same) {
    same.level += 1;
    same.stats = applyEnhance(computeSpell(same.recipe).stats, same.level);
    slotSel = slotSel.map(() => null);
    showToast(`⚗ 強化成功!「${spellDisplayName(same)}」`);
    msgEl.textContent = `「${spellDisplayName(same)}」に強化した。`;
    notify();
    return;
  }

  const { stats, matched, autoName } = computeSpell(counts);
  const name = autoName;

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
    level: 0,
  };
  addSpell(spell);

  slotSel = slotSel.map(() => null);

  if (newFound.length > 0) {
    showToast(`✨ 新系統発見!「${newFound.join('」「')}」 (研究P+${bonus})`);
  }
  $('#craft-msg').textContent = `「${name}」を調合した。魔導書に記録済み。`;
  notify();
}

// ---- 採取 ----
function renderGather(): void {
  const btn = $<HTMLButtonElement>('#btn-gather');
  const pity = totalInventory() === 0 && state.spells.length === 0;
  btn.textContent = pity ? '採取に出る (無料)' : `採取に出る (研究P${GATHER_COST})`;
  btn.disabled = !pity && state.researchP < GATHER_COST;
}

function gather(): void {
  const pity = totalInventory() === 0 && state.spells.length === 0;
  if (!pity) {
    if (state.researchP < GATHER_COST) return;
    state.researchP -= GATHER_COST;
  }
  const pool: ElementId[] = [
    'fire', 'fire', 'water', 'water', 'wind', 'wind', 'earth', 'earth',
    'thunder', 'ice', 'light', 'dark',
  ];
  const got: ElementId[] = [];
  for (let i = 0; i < 3; i++) {
    got.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  addElements(got);
  $('#craft-msg').textContent =
    `採取で ${got.map(g => ELEMENTS[g].name).join('・')} を手に入れた。`;
  notify();
}

// ---- 魔導書 ----
function renderSpellbook(): void {
  const list = $('#spell-list');
  list.innerHTML = '';
  if (state.spells.length === 0) {
    list.innerHTML = '<div class="empty-note">まだ魔法がない。素材を2つ以上調合してみよう。</div>';
    return;
  }
  for (const sp of state.spells) {
    const equipped = state.equipped.includes(sp.id);
    const card = document.createElement('div');
    card.className = 'spell-card' + (equipped ? ' equipped' : '');
    const recipeStr = (Object.entries(sp.recipe) as [ElementId, number][])
      .map(([id, cnt]) => `${ELEMENTS[id].name}×${cnt}`).join(' ');
    card.innerHTML =
      `<div class="sname">${equipped ? '<span class="star">★</span> ' : ''}${spellDisplayName(sp)}` +
      ` <span class="mval">魔導値 ${spellMagicValue(sp.stats)}</span>` +
      ` <small style="color:#777799">(${recipeStr})</small></div>` +
      `<div class="sstats">${statsSummary(sp.stats)}</div>`;
    const btns = document.createElement('div');
    btns.className = 'sbtns';

    const eqBtn = document.createElement('button');
    eqBtn.textContent = equipped ? '装備解除' : '装備する';
    eqBtn.disabled = !equipped && state.equipped.length >= 4;
    eqBtn.addEventListener('click', () => { toggleEquip(sp.id); notify(); });
    btns.appendChild(eqBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '破棄';
    delBtn.addEventListener('click', () => {
      // confirmが使えない環境(公開版のiframe等)があるため2度押し確認
      if (delBtn.dataset.arm === '1') {
        deleteSpell(sp.id);
        notify();
      } else {
        delBtn.dataset.arm = '1';
        delBtn.textContent = '本当に破棄?';
        setTimeout(() => {
          delBtn.dataset.arm = '';
          delBtn.textContent = '破棄';
        }, 2500);
      }
    });
    btns.appendChild(delBtn);

    card.appendChild(btns);
    list.appendChild(card);
  }
}

// ---- 発見図鑑 ----
function renderRecipes(): void {
  const list = $('#recipe-list');
  list.innerHTML = '';
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

// 研究室(調合・魔導書・図鑑)のDOM UI

import {
  DISCOVERY_BONUS_RP, ELEMENTS, ELEMENT_ORDER, GATHER_COST,
  RECIPES, SLOT4_COST, SLOT5_COST,
} from '../shared/data';
import { computeSpell, statsSummary } from '../shared/spellcraft';
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
  const box = $('#preview-box');
  const counts = selCounts();
  const used = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  if (used < 2) {
    box.classList.add('hidden');
    $('#btn-craft').setAttribute('disabled', 'true');
    return;
  }
  box.classList.remove('hidden');
  $('#btn-craft').removeAttribute('disabled');

  const { stats, matched, autoName } = computeSpell(counts);
  const recipeNote = matched.length > 0
    ? `<div class="precipe">★ 系統成立: ${matched.map(r =>
        state.discovered.includes(r.id) ? r.name : '???(未知の反応)').join('、')}</div>`
    : '';
  box.innerHTML =
    `<div class="pname">${autoName}</div>` +
    `<div>${statsSummary(stats)}</div>` + recipeNote;
}

// ---- 調合実行 ----
function craft(): void {
  const counts = selCounts();
  const used = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  if (used < 2) return;

  if (!spendElements(counts)) {
    $('#craft-msg').textContent = '素材が足りない…';
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
      `<div class="sname">${equipped ? '<span class="star">★</span> ' : ''}${sp.name}` +
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

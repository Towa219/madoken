// 研究室(調合・魔導書・図鑑)のDOM UI

import {
  DISASSEMBLE_RATE, DISCOVERY_BONUS_RP, ELEMENTS, ELEMENT_ORDER,
  GATHER_COST, GATHER_COUNT, LIBRARY_BONUS_MAX, libraryBonus,
  RARITIES, rarityMultiplier, RECIPES, rollRarity,
  SLOT4_BOSS_STAGE, SLOT4_COST, SLOT5_BOSS_STAGE, SLOT5_COST,
} from '../shared/data';
import {
  bestCompositionFor, computeSpell, ENHANCE_MAX, finalStats, spellDisplayName,
  spellMagicValue, statsSummary,
} from '../shared/spellcraft';
import {
  addElements, addSpell, deleteSpell, hasBossCleared, notify, save,
  spendElements, state, toggleEquip, totalInventory,
} from './state';
import type { ElementCounts, ElementId, Spell } from '../shared/types';

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

// レシピ(エレメント構成)が完全一致か
function recipesEqual(a: ElementCounts, b: ElementCounts): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ElementId>;
  for (const id of ids) {
    if ((a[id] ?? 0) !== (b[id] ?? 0)) return false;
  }
  return true;
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
  $('#btn-craft').addEventListener('click', craft);
  $('#btn-gather').addEventListener('click', gather);
  $('#btn-sort-spells').addEventListener('click', () => {
    state.sortByPower = !state.sortByPower;
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
    card.className = 'elem-card' + (free <= 0 ? ' empty' : '') + (got > 0 ? ' elem-gained' : '');
    card.innerHTML =
      `<span class="ename" style="color:${def.cssColor}">${def.name}</span>` +
      (got > 0 ? `<span class="gain-badge">+${got}</span>` : '') +
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
  gained.clear(); // 光らせるのは1回だけ
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
  const spec = state.slots === 3
    ? { next: 4, cost: SLOT4_COST, boss: SLOT4_BOSS_STAGE }
    : state.slots === 4
      ? { next: 5, cost: SLOT5_COST, boss: SLOT5_BOSS_STAGE }
      : null;
  if (spec) {
    const bossOk = hasBossCleared(spec.boss);
    const b = document.createElement('button');
    b.textContent = `第${spec.next}スロット解放 (研究P${spec.cost})`;
    b.disabled = !bossOk || state.researchP < spec.cost;
    b.addEventListener('click', () => {
      if (!hasBossCleared(spec.boss) || state.researchP < spec.cost) return;
      state.researchP -= spec.cost;
      state.slots = spec.next;
      showToast(`第${spec.next}スロットを解放した!`);
      notify();
    });
    unlock.appendChild(b);
    const cond = document.createElement('div');
    cond.className = bossOk ? 'note chance-high' : 'note chance-mid';
    cond.textContent = bossOk
      ? `条件クリア: ステージ${spec.boss}のボスを撃破済み`
      : `条件: ステージ${spec.boss}のボス撃破が必要(ボスは共闘2人以上で挑戦)`;
    unlock.appendChild(cond);
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
  const cap = lb >= LIBRARY_BONUS_MAX ? '(上限)' : '';
  return `<div class="prarity">上位品質: `
    + `<span style="color:${RARITIES.rare.cssColor}">${RARITIES.rare.name} ${pct(RARITIES.rare.chance)}</span> / `
    + `<span style="color:${RARITIES.epic.cssColor}">${RARITIES.epic.name} ${pct(RARITIES.epic.chance)}</span> / `
    + `<span style="color:${RARITIES.legend.cssColor}">${RARITIES.legend.name} ${pct(RARITIES.legend.chance)}</span>`
    + ` <small>(魔導書 ${kinds}種で ×${lb.toFixed(2)}${cap})</small></div>`;
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
    same.stats = finalStats(same.recipe, same.level, same.rarity);
    slotSel = slotSel.map(() => null);
    showToast(`⚗ 強化成功!「${spellDisplayName(same)}」`);
    msgEl.textContent = `「${spellDisplayName(same)}」に強化した。`;
    notify();
    return;
  }

  const { matched, autoName } = computeSpell(counts);
  const rarity = rollRarity(counts, spellKindCount());
  const stats = finalStats(counts, 0, rarity);
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
    level: 0, rarity,
  };
  addSpell(spell);

  slotSel = slotSel.map(() => null);

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
  const pity = totalInventory() === 0 && state.spells.length === 0;
  btn.textContent = pity ? '採取に出る (無料)' : `採取に出る (研究P${GATHER_COST})`;
  btn.disabled = !pity && state.researchP < GATHER_COST;
}

// 採取(調合と同じように進行バーが進んでから完了)
function gather(): void {
  if (gathering) return;
  const pity = totalInventory() === 0 && state.spells.length === 0;
  if (!pity && state.researchP < GATHER_COST) return;

  gathering = true;
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
  // 希少な光・闇は出にくい
  const pool: ElementId[] = [
    'fire', 'fire', 'fire', 'water', 'water', 'water',
    'wind', 'wind', 'wind', 'earth', 'earth', 'earth',
    'thunder', 'thunder', 'ice', 'ice', 'light', 'dark',
  ];
  const got: ElementId[] = [];
  for (let i = 0; i < GATHER_COUNT; i++) {
    got.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  addElements(got);
  markGained(got);
  const msg = $('#craft-msg');
  msg.style.color = '#88ffaa';
  msg.textContent = `✨ 採取で ${got.map(g => ELEMENTS[g].name).join('・')} を手に入れた!`;
  showToast(`✨ ${got.map(g => ELEMENTS[g].name).join('・')} を入手`);
  notify();
}

// ---- 魔導書 ----
function renderSpellbook(): void {
  const sortBtn = $<HTMLButtonElement>('#btn-sort-spells');
  sortBtn.textContent = state.sortByPower ? '魔導値順 ▼' : '取得順';
  sortBtn.classList.toggle('active-sort', state.sortByPower);

  const list = $('#spell-list');
  list.innerHTML = '';
  if (state.spells.length === 0) {
    list.innerHTML = '<div class="empty-note">まだ魔法がない。素材を2つ以上調合してみよう。</div>';
    return;
  }

  const shown = state.sortByPower
    ? [...state.spells].sort((a, b) => spellMagicValue(b.stats) - spellMagicValue(a.stats))
    : state.spells;

  for (const sp of shown) {
    const equipped = state.equipped.includes(sp.id);
    const card = document.createElement('div');
    card.className = `spell-card rarity-${sp.rarity}` + (equipped ? ' equipped' : '');
    const recipeStr = (Object.entries(sp.recipe) as [ElementId, number][])
      .map(([id, cnt]) => `${ELEMENTS[id].name}×${cnt}`).join(' ');
    card.innerHTML =
      `<div class="sname">${equipped ? '<span class="star">★</span> ' : ''}` +
      `<span style="color:${RARITIES[sp.rarity].cssColor}">${spellDisplayName(sp)}</span>` +
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

// 全系統を発見していたら、その証としてエピック品質の魔法を1つだけ授ける。
// 系統はランダムに選び、その系統が成立する構成の中で最も魔導値が高いものを作る。
function grantCodexRewardIfDue(): void {
  if (state.codexRewarded) return;
  if (RECIPES.some(r => !state.discovered.includes(r.id))) return;

  state.codexRewarded = true; // 先に立てて二重取得を防ぐ

  const def = RECIPES[Math.floor(Math.random() * RECIPES.length)];
  const counts = bestCompositionFor(def.id, Math.max(3, state.slots));
  if (!counts) { save(); return; }

  const { autoName, matched } = computeSpell(counts);
  const spell: Spell = {
    id: `sp_codex_${Date.now()}`,
    name: autoName,
    recipe: counts,
    stats: finalStats(counts, 0, 'epic'),
    discoveries: matched.map(r => r.id),
    level: 0,
    rarity: 'epic',
  };
  addSpell(spell);
  save();
  showToast(`📚 発見図鑑コンプリート! 【${RARITIES.epic.name}】「${autoName}」を授かった!`);
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

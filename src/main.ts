// エントリポイント: 画面切替・出撃準備・戦闘結果の処理

import { BattleManager } from './battle';
import { ELEMENTS, isBossStage } from '../shared/data';
import { initLab, renderLab, showToast } from './lab';
import { renderManual } from './manual';
import {
  initOnline, coopTryCast, duelTryCast, releaseNickname, renderNickField,
} from './lobby';
import {
  combatPower, spellDisplayName, spellMagicValue, statsSummary,
} from '../shared/spellcraft';
import { BUILD_DATE, COPYRIGHT, VERSION } from '../shared/version';
import {
  addElements, equippedSpells, notify, onChange, resetSave, state,
} from './state';
import type { BattleResult } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const battle = new BattleManager();
let lastStage = 1;

// ===== タブ切替 =====

type Tab = 'lab' | 'book' | 'battle' | 'online' | 'manual';

function switchTab(tab: Tab): void {
  $('#lab-screen').classList.toggle('hidden', tab !== 'lab');
  $('#book-screen').classList.toggle('hidden', tab !== 'book');
  $('#battle-screen').classList.toggle('hidden', tab !== 'battle');
  $('#online-screen').classList.toggle('hidden', tab !== 'online');
  $('#manual-screen').classList.toggle('hidden', tab !== 'manual');
  $('#tab-lab').classList.toggle('active', tab === 'lab');
  $('#tab-book').classList.toggle('active', tab === 'book');
  $('#tab-battle').classList.toggle('active', tab === 'battle');
  $('#tab-online').classList.toggle('active', tab === 'online');
  $('#tab-manual').classList.toggle('active', tab === 'manual');
  if (tab === 'manual') renderManual();
  if (tab === 'battle' && !battle.isActive()) {
    showSetup();
  }
}

// ===== 出撃準備(ソロ) =====

function showSetup(): void {
  $('#battle-setup').classList.remove('hidden');
  $('#battle-view').classList.add('hidden');
  $('#battle-overlay').classList.add('hidden');
  renderSetup();
}

function renderSetup(): void {
  const spells = equippedSpells();
  const summary = $('#equip-summary');
  summary.innerHTML = '<h3>装備中の魔法</h3>';
  if (spells.length === 0) {
    summary.innerHTML +=
      '<div class="eq-row" style="color:#ff8877">装備中の魔法がない。研究室で調合・装備しよう。</div>';
  } else {
    for (const sp of spells) {
      summary.innerHTML +=
        `<div class="eq-row">★ ${spellDisplayName(sp)} ` +
        `<span class="mval">魔導値 ${spellMagicValue(sp.stats)}</span>` +
        ` <small>${statsSummary(sp.stats)}</small></div>`;
    }
  }

  const sel = $('#stage-select');
  sel.innerHTML = '';
  for (let i = 1; i <= state.maxStage; i++) {
    const b = document.createElement('button');
    const boss = isBossStage(i);
    b.textContent = boss ? `${i} 👑` : `${i}`;
    if (boss) {
      b.className = 'boss';
      b.disabled = true;
      b.title = 'ボス戦は共闘(2人以上)専用';
    }
    b.addEventListener('click', () => startBattle(i));
    sel.appendChild(b);
  }
  const nextIsBoss = isBossStage(state.maxStage);
  $('#setup-msg').textContent = nextIsBoss
    ? `👑 ステージ${state.maxStage}はボス戦。オンラインで2人以上の共闘でのみ挑戦できる。`
    : '';
}

async function startBattle(stage: number): Promise<void> {
  const spells = equippedSpells();
  if (spells.length === 0) {
    $('#setup-msg').textContent = '魔法を1つ以上装備しないと出撃できない。';
    return;
  }
  if (isBossStage(stage)) {
    $('#setup-msg').textContent =
      'ボス戦はソロでは挑めない。オンラインで2人以上の共闘部屋を作ろう。';
    return;
  }
  lastStage = stage;
  $('#battle-setup').classList.add('hidden');
  $('#battle-view').classList.remove('hidden');
  $('#battle-overlay').classList.add('hidden');
  await battle.start($('#game-canvas'), stage, spells, onBattleEnd);
}

// ===== 戦闘結果(ソロ) =====

function onBattleEnd(r: BattleResult): void {
  addElements(r.drops);
  state.researchP += r.rp;
  if (r.win) {
    state.bestStage = Math.max(state.bestStage, r.stage);
    state.maxStage = Math.max(state.maxStage, r.stage + 1);
  }

  const overlay = $('#battle-overlay');
  const title = r.win ? '勝利!' : (r.escaped ? '撤退した…' : '敗北…');
  const titleClass = r.win ? 'win' : 'lose';
  const dropChips = r.drops.length > 0
    ? r.drops.map(d =>
        `<span class="drop-chip" style="color:${ELEMENTS[d].cssColor}">${ELEMENTS[d].name}</span>`,
      ).join('')
    : '<span style="color:#8888aa">なし(ソロ戦ではエレメントは手に入らない)</span>';

  overlay.innerHTML =
    `<div class="result-box">` +
    `<h2 class="${titleClass}">${title}</h2>` +
    `<div>ステージ ${r.stage}</div>` +
    `<div class="drops">獲得エレメント: ${dropChips}</div>` +
    `<div style="color:#ffdd66">研究P +${r.rp}</div>` +
    `<div style="margin-top:16px; display:flex; gap:8px; justify-content:center">` +
    `<button id="btn-again">${r.win ? 'もう一度' : '再挑戦'}</button>` +
    (r.win && r.stage + 1 <= state.maxStage && !isBossStage(r.stage + 1)
      ? `<button id="btn-next">次のステージへ</button>` : '') +
    (r.win && isBossStage(r.stage + 1)
      ? `<div class="note" style="margin-top:8px">次はボス戦。共闘(2人以上)で挑もう。</div>` : '') +
    `<button id="btn-back">準備画面へ</button>` +
    `</div></div>`;
  overlay.classList.remove('hidden');

  overlay.querySelector('#btn-again')?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    void startBattle(lastStage);
  });
  overlay.querySelector('#btn-next')?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    void startBattle(lastStage + 1);
  });
  overlay.querySelector('#btn-back')?.addEventListener('click', showSetup);

  notify();
}

// ===== 初期化 =====

function updateTopbar(): void {
  $('#rp-display').textContent = `研究P: ${state.researchP}`;
  $('#power-display').textContent = `⚔ 戦闘力: ${combatPower(equippedSpells())}`;
}

function renderFooter(): void {
  $('#app-footer').innerHTML =
    `<span class="fver">魔導研究記 v${VERSION}(${BUILD_DATE} 更新)</span><br>${COPYRIGHT}`;
}

function main(): void {
  initLab();
  initOnline();

  $('#tab-lab').addEventListener('click', () => switchTab('lab'));
  $('#tab-book').addEventListener('click', () => switchTab('book'));
  $('#tab-manual').addEventListener('click', () => switchTab('manual'));
  $('#tab-battle').addEventListener('click', () => switchTab('battle'));
  $('#tab-online').addEventListener('click', () => switchTab('online'));
  const resetBtn = $('#btn-reset');
  resetBtn.addEventListener('click', () => {
    // confirmが使えない環境(公開版のiframe等)があるため2度押し確認
    if (resetBtn.dataset.arm === '1') {
      resetBtn.dataset.arm = '';
      resetBtn.textContent = '初期化';
      void releaseNickname(); // 使っていた名前を手放す(他の人が使えるようになる)
      resetSave();
      renderNickField(); // ニックネームも再登録できるようになる
      showToast('セーブデータを初期化した。ニックネームも解放され、再設定できる。');
    } else {
      resetBtn.dataset.arm = '1';
      resetBtn.textContent = '本当に初期化?';
      setTimeout(() => {
        resetBtn.dataset.arm = '';
        resetBtn.textContent = '初期化';
      }, 2500);
    }
  });

  // キーボード 1〜5 で詠唱(ソロ/共闘)
  window.addEventListener('keydown', ev => {
    const n = parseInt(ev.key, 10);
    if (!(n >= 1 && n <= 5)) return;
    if (!$('#battle-view').classList.contains('hidden')) battle.tryCast(n - 1);
    else if (!$('#coop-view').classList.contains('hidden')) coopTryCast(n - 1);
    else if (!$('#duel-view').classList.contains('hidden')) duelTryCast(n - 1);
  });

  onChange(() => {
    updateTopbar();
    renderLab();
    if (!$('#battle-setup').classList.contains('hidden')) renderSetup();
  });

  updateTopbar();
  renderLab();
  renderFooter();
}

main();

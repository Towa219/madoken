// 出撃準備の「お供」欄。
//
// 旗(ALLY_ENABLED)が false の間は何も出さない。既存の遊びは変わらない。
//
// 選べるのは自分が使っていない5人。連れて行かないことも選べる。
// 解放は研究P ― ステージ条件にしていない理由は shared/allies.ts に書いた。

import {
  ALLIES, ALLY_ENABLED, ALLY_FREE_NOW, ALLY_MAX_HP, ALLY_MAX_MP, ALLY_RP_MUL,
  ALLY_UNLOCK_RP, allyUnlockCost,
} from '../shared/allies';
import { CHARACTERS } from '../shared/characters';
import { ELEMENTS } from '../shared/data';
import { playerArtUrl } from './artwork';
import { showToast } from './lab';
import { playSfx } from './sound';
import { notify, state } from './state';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// いま連れて行くお供。連れて行かない・自分自身・未解放なら null。
export function currentAllyCharId(): number | null {
  if (!ALLY_ENABLED || !state.allyUnlocked) return null;
  const id = state.allyCharId;
  if (id === null || id === state.charId) return null;
  return ALLIES.some(a => a.charId === id) ? id : null;
}

export function renderAllyPicker(): void {
  const box = $('#ally-box');
  if (!box) return;
  if (!ALLY_ENABLED) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  const picker = $('#ally-picker');
  const note = $('#ally-note');

  if (!state.allyUnlocked) {
    const cost = allyUnlockCost();
    picker.innerHTML = '';
    const btn = document.createElement('button');
    btn.id = 'btn-ally-unlock';
    btn.className = 'primary';
    btn.textContent = cost === 0
      ? 'お供を仲間にする(体験版につき無料)'
      : `お供を仲間にする(研究P${cost})`;
    btn.disabled = state.researchP < cost;
    btn.addEventListener('click', unlock);
    picker.appendChild(btn);
    note.innerHTML =
      'ソロの出撃に、自分が使っていないキャラを1人だけ連れて行けるようになる。'
      + (cost === 0
        // 後から有料になることを先に断っておく。黙って値が付くと
        // 「前は無料だったのに」となる。
        ? `<br><b>体験版の間は無料</b>で仲間にできる`
          + `(のちのち研究P${ALLY_UNLOCK_RP}かかる予定)。`
        : `<br>研究P${cost}が必要(いまは${state.researchP})。`);
    return;
  }

  // 「連れて行かない」+ 自分以外の5人
  picker.innerHTML = '';
  picker.appendChild(makeCard(null));
  for (const a of ALLIES) {
    if (a.charId === state.charId) continue;   // 自分は連れて行けない
    picker.appendChild(makeCard(a.charId));
  }

  const id = currentAllyCharId();
  note.innerHTML = id === null
    ? '連れて行かない。研究Pは満額もらえる。'
    : `お供はHP${ALLY_MAX_HP} / MP${ALLY_MAX_MP}。`
      + '<b>倒れると復活しない</b>ので、回復も気にかけよう。'
      + `<br>連れて行くと<b>研究Pは×${ALLY_RP_MUL}</b>になる。`
      + '共闘部屋と決闘には同行しない。';
}

function makeCard(charId: number | null): HTMLElement {
  const btn = document.createElement('button');
  const on = currentAllyCharId() === charId;
  btn.className = 'ally-card' + (on ? ' selected' : '');

  if (charId === null) {
    btn.innerHTML = '<span class="ally-art none">—</span>'
      + '<span class="ally-name">連れて行かない</span>'
      + '<span class="ally-note">研究Pは満額</span>';
  } else {
    const ch = CHARACTERS[charId];
    const el = ELEMENTS[ch.element];
    const def = ALLIES.find(a => a.charId === charId)!;
    const url = playerArtUrl(charId);
    btn.innerHTML =
      (url
        ? `<span class="ally-art" style="background-image:url('${esc(url)}')"></span>`
        : '<span class="ally-art none">?</span>')
      + `<span class="ally-name">${esc(ch.name)}</span>`
      + `<span class="ally-elem" style="color:${el.cssColor}">`
      + `${el.emoji}${el.name}</span>`
      + `<span class="ally-note">${esc(def.note)}</span>`;
  }

  btn.addEventListener('click', () => {
    if (currentAllyCharId() === charId) return;
    playSfx('select');
    state.allyCharId = charId;
    notify();
    renderAllyPicker();
  });
  return btn;
}

function unlock(): void {
  if (state.allyUnlocked) return;
  const cost = allyUnlockCost();
  if (state.researchP < cost) {
    showToast(`研究Pが足りない(あと${cost - state.researchP})。`);
    return;
  }
  state.researchP -= cost;
  state.allyUnlocked = true;
  // 最初は連れて行かない状態にしておく。
  // 勝手に誰かが付いてきて、気づかず研究Pが減っていた、では困る。
  state.allyCharId = null;
  playSfx('discover');
  showToast(ALLY_FREE_NOW
    ? 'お供を連れて行けるようになった(体験版につき無料)。出撃準備で選ぼう。'
    : 'お供を連れて行けるようになった。出撃準備で選ぼう。');
  notify();
  renderAllyPicker();
}

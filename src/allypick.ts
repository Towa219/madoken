// 出撃準備の「お供」欄。
//
// 旗(ALLY_ENABLED)が false の間は何も出さない。既存の遊びは変わらない。
//
// 選べるのは自分が使っていない5人。連れて行かないことも選べる。
// 解放はしない ― 誰でも最初から選べる(理由は shared/allies.ts に書いた)。

import {
  ALLIES, ALLY_ENABLED, ALLY_MAX_HP, ALLY_MAX_MP, ALLY_MUL_MAX,
  ALLY_MUL_MIN, ALLY_REF_MAGIC, ALLY_RP_MUL, allyPowerMul,
} from '../shared/allies';
import { CHARACTERS } from '../shared/characters';
import { ELEMENTS } from '../shared/data';
import { playerArtUrl } from './artwork';
import { playSfx } from './sound';
import { notify, playerMagicTotal, state } from './state';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// いま連れて行くお供。連れて行かない・自分自身なら null。
export function currentAllyCharId(): number | null {
  if (!ALLY_ENABLED) return null;
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

  // 「連れて行かない」+ 自分以外の5人
  picker.innerHTML = '';
  picker.appendChild(makeCard(null));
  for (const a of ALLIES) {
    if (a.charId === state.charId) continue;   // 自分は連れて行けない
    picker.appendChild(makeCard(a.charId));
  }

  const id = currentAllyCharId();
  const total = playerMagicTotal();
  const mul = allyPowerMul(total);
  note.innerHTML = id === null
    ? '連れて行かない。研究Pは満額もらえる。'
    : `お供はHP${ALLY_MAX_HP} / MP${ALLY_MAX_MP}。`
      + '<b>倒れると復活しない</b>ので、回復も気にかけよう。'
      + `<br>連れて行くと<b>研究Pは×${ALLY_RP_MUL}</b>になる。`
      + '共闘部屋と決闘には同行しない。'
      // 自分が強くなればお供も強くなる、と分かるように今の値を出しておく。
      // 上限・下限に張り付いている時は、それも書かないと
      // 「魔導値を上げたのに何も変わらない」と見える。
      + `<br>お供の強さ <b>×${mul.toFixed(2)}</b>`
      + `(あなたの魔導値合計 ${total.toLocaleString()} ÷ ${ALLY_REF_MAGIC})`
      + (mul >= ALLY_MUL_MAX ? '<b>・上限</b>'
        : mul <= ALLY_MUL_MIN ? '<b>・下限</b>' : '');
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

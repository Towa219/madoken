// キャラクター選択
//
// キャラごとに得意なエレメントがあり、それを使った魔法だけ威力が上がる。
// 設定タブと初回起動のようこそ画面で同じ部品を使う。
// 画像素材(public/img/player/N.png)が無い環境でも、名前だけで選べるようにする。

import { CHARACTERS, CHAR_CHANGE_COST, CHAR_POWER_BONUS } from '../shared/characters';
import { ELEMENTS } from '../shared/data';
import { playerArtUrl } from './artwork';
import { showToast } from './lab';
import { notify, state } from './state';

const pickers = new Set<HTMLElement>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 初回(名前を決める画面)は無料。そこで決めたあとの乗り換えに研究Pがかかる。
// 無料のままだと魔法ごとに着せ替えるだけの操作になり、選ぶ意味が無くなる。
function isFirstPick(): boolean {
  return !state.nickname;
}

// 1つの選択欄を描く。押されたら state.charId を変えて全部を描き直す。
function render(box: HTMLElement): void {
  box.innerHTML = '';
  const free = isFirstPick();
  for (const ch of CHARACTERS) {
    const el = ELEMENTS[ch.element];
    const btn = document.createElement('button');
    const selected = ch.id === state.charId;
    btn.className = 'char-card' + (selected ? ' selected' : '');
    btn.title = ch.note;

    const url = playerArtUrl(ch.id);
    // 表示倍率は戦闘画面と同じものを使う。
    // ここで効かせないと、選択画面だけ倍率無しで並び、戦闘では揃っている頭が
    // 選択画面では揃っていない、という食い違いが出る(実際にそう見えていた)。
    const art = url
      ? `<span class="char-art" style="background-image:url('${esc(url)}');`
        + `background-size:auto ${Math.round(ch.scale * 100)}%"></span>`
      : '<span class="char-art none">?</span>';

    btn.innerHTML =
      art +
      `<span class="char-name">${esc(ch.name)}</span>` +
      `<span class="char-elem" style="color:${el.cssColor}">`
      + `${el.emoji}${el.name}の使い手</span>` +
      `<span class="char-note">${esc(ch.note)}</span>`;

    btn.addEventListener('click', () => {
      if (state.charId === ch.id) return;
      if (!free) {
        if (state.researchP < CHAR_CHANGE_COST) {
          showToast(`乗り換えには研究P${CHAR_CHANGE_COST}が必要(今は${state.researchP})。`);
          return;
        }
        state.researchP -= CHAR_CHANGE_COST;
        showToast(`${ch.name}に乗り換えた(研究P-${CHAR_CHANGE_COST})。`);
      }
      state.charId = ch.id;
      notify();          // ローカル保存 + クラウドへの保存予約
      renderCharPickers();
    });
    box.appendChild(btn);
  }

  const note = document.createElement('p');
  note.className = 'note char-picker-note';
  note.innerHTML = free
    ? `得意なエレメントを1個でも使った魔法は<b>威力+${Math.round(CHAR_POWER_BONUS * 100)}%</b>。`
      + 'あとから変えられます。'
    : `得意なエレメントを1個でも使った魔法は<b>威力+${Math.round(CHAR_POWER_BONUS * 100)}%</b>。`
      + `乗り換えには<b>研究P${CHAR_CHANGE_COST}</b>かかります`
      + `(今は研究P${state.researchP})。`;
  box.appendChild(note);
}

// 登録済みの選択欄をすべて描き直す(設定タブとようこそ画面で選択状態を揃える)
export function renderCharPickers(): void {
  for (const box of pickers) {
    if (box.isConnected) render(box);
    else pickers.delete(box);
  }
}

// 選択欄を設置する。素材の読み込みが後から終わっても反映されるよう、
// renderCharPickers() を呼べば描き直せるようにしてある。
export function initCharPicker(selector: string): void {
  const box = document.querySelector(selector) as HTMLElement | null;
  if (!box) return;
  pickers.add(box);
  render(box);
}

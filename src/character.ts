// キャラクター選択(見た目だけ・性能には影響しない)
//
// 設定タブと初回起動のようこそ画面で同じ部品を使う。
// 画像素材(public/img/player/N.png)が無い環境でも、名前だけで選べるようにする。

import { CHARACTERS } from '../shared/characters';
import { playerArtUrl } from './artwork';
import { notify, state } from './state';

const pickers = new Set<HTMLElement>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 1つの選択欄を描く。押されたら state.charId を変えて全部を描き直す。
function render(box: HTMLElement): void {
  box.innerHTML = '';
  for (const ch of CHARACTERS) {
    const btn = document.createElement('button');
    btn.className = 'char-card' + (ch.id === state.charId ? ' selected' : '');
    btn.title = ch.note;

    const url = playerArtUrl(ch.id);
    const art = url
      ? `<span class="char-art" style="background-image:url('${esc(url)}')"></span>`
      : '<span class="char-art none">?</span>';

    btn.innerHTML =
      art +
      `<span class="char-name">${esc(ch.name)}</span>` +
      `<span class="char-note">${esc(ch.note)}</span>`;

    btn.addEventListener('click', () => {
      if (state.charId === ch.id) return;
      state.charId = ch.id;
      notify();          // ローカル保存 + クラウドへの保存予約
      renderCharPickers();
    });
    box.appendChild(btn);
  }
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

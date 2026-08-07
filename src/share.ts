// 拡散(SNS共有)と支援リンク
//
// 共有文には自分の成果(戦闘力・発見数・到達ステージ)を入れて、
// 「自慢したくなる」形にする。個人情報は含めない。

import { RECIPES } from '../shared/data';
import { combatPower } from '../shared/spellcraft';
import {
  SITE_URL, SUPPORT_LABEL, SUPPORT_NOTE, SUPPORT_URL,
} from '../shared/links';
import { equippedSpells, state } from './state';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// 共有する文面(ニックネームは入れない=晒しを避ける)
export function shareText(): string {
  const power = combatPower(equippedSpells());
  const found = RECIPES.filter(r => state.discovered.includes(r.id)).length;
  const parts = [
    '魔導研究記《まどけん》で魔法を発明中!',
    `戦闘力${power} / ${found}系統を発見 / 最高ステージ${state.bestStage}`,
    'エレメントを混ぜて自分だけの魔法を作るWebゲーム。オンライン共闘もできる。',
  ];
  return parts.join('\n');
}

function siteUrl(): string {
  // 共有文は必ず入口(待機ページ)を指す。
  //
  // 以前は location.origin をそのまま載せていたので、本体のURLが配られていた。
  // 受け取った人が押した時にサーバーが眠っていると、Renderの起動画面に
  // 行き当たって「壊れている」と思われる。入口を挟めばそれが起きない。
  return SITE_URL;
}

export function initShare(): void {
  const box = $('#share-buttons');
  if (!box) return;

  const url = siteUrl();
  const text = shareText();
  const enc = encodeURIComponent;

  const links: { label: string; href: string; cls: string }[] = [
    {
      label: '𝕏 でポスト',
      href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}&hashtags=魔導研究記`,
      cls: 'sns-x',
    },
    {
      label: 'LINEで送る',
      href: `https://social-plugins.line.me/lineit/share?url=${enc(url)}&text=${enc(text)}`,
      cls: 'sns-line',
    },
    {
      label: 'Facebookでシェア',
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
      cls: 'sns-fb',
    },
  ];

  box.innerHTML = '';
  for (const l of links) {
    const a = document.createElement('a');
    a.className = `sns-btn ${l.cls}`;
    a.href = l.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = l.label;
    box.appendChild(a);
  }

  // スマホの共有シート(対応端末のみ)
  const nav = navigator as Navigator & { share?: (d: unknown) => Promise<void> };
  if (typeof nav.share === 'function') {
    const b = document.createElement('button');
    b.className = 'sns-btn sns-native';
    b.textContent = '他のアプリで共有';
    b.addEventListener('click', () => {
      void nav.share?.({ title: '魔導研究記《まどけん》', text, url });
    });
    box.appendChild(b);
  }

  // URLのコピー
  const copy = document.createElement('button');
  copy.className = 'sns-btn sns-copy';
  copy.textContent = 'URLをコピー';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(`${text}\n${url}`)
      .then(() => { $('#share-msg').textContent = '共有文とURLをコピーした。'; })
      .catch(() => { $('#share-msg').textContent = 'コピーできなかった。'; });
  });
  box.appendChild(copy);

  // 支援リンク(URLが設定されているときだけ出す)
  const sup = $('#support-box');
  if (SUPPORT_URL) {
    sup.classList.remove('hidden');
    sup.innerHTML =
      `<a class="support-btn" href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">`
      + `☕ ${SUPPORT_LABEL}</a>`
      + `<p class="note">${SUPPORT_NOTE}</p>`;
  } else {
    sup.classList.add('hidden');
  }
}

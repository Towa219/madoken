// 管理者モード
//
// 試験中の機能(ペットなど)を、作者だけが触れるようにするための仕組み。
//
// ★ 判定はサーバーに置く。
//   このリポジトリは公開なので、クライアント側に合言葉や判定を書くと
//   ソースを読めば誰でも突破できる。ペットは戦闘のHP/MPを上げ、
//   交配で他人とも関わるので、クライアントだけの旗では守れない。
//   合言葉は Render の環境変数(ADMIN_KEY)にだけあり、
//   /api/admin/check がそれと照合する。
//
// ★ 合言葉は sessionStorage に置く(セーブには入れない)。
//   セーブに入れると、引き継ぎコードや端末間の同期に合言葉が混ざる。
//   タブを閉じれば消える場所が、試験用の旗にはちょうどよい。
//   以後の管理者向けの通信では、この合言葉を毎回サーバーへ送って確かめる。

import { showToast } from './lab';
import { PETS_PUBLIC } from '../shared/pets';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const KEY_STORE = 'madoken_admin_key';

let adminKey = '';

// 管理者かどうかが変わった時に呼ぶ。ペット側が控えを取り直すために使う。
//
// ★ ここから pet.ts を直に呼んではいけない。pet.ts がこの admin.ts を
//   取り込んでいるので、循環参照になる。lobby.ts の
//   setBattleTabOpener と同じ形で、外から渡してもらう。
let onAdminChange: (() => void) | null = null;

export function setAdminChangeHandler(fn: () => void): void {
  onAdminChange = fn;
}

function apiBase(): string {
  return import.meta.env.DEV ? 'http://localhost:2567' : '';
}

export function isAdmin(): boolean {
  return adminKey !== '';
}

// 管理者向けの通信に添える合言葉。管理者でなければ空。
export function adminKeyForRequest(): string {
  return adminKey;
}

// 隠しコマンド: 画面下の版番号を続けて叩くと、設定に「管理者」の欄が現れる。
//
// ★ 常に見えるボタンにすると、押した人に機能の存在が知られてしまう。
//   合言葉が無ければ何も起きないとはいえ、試験中の機能は
//   そもそも気づかれないほうがよい。
// ★ 版番号を選んだ理由: どのタブでも画面下に必ずあり、指でも押せて、
//   偶然7回続けて叩くことがない。
const REVEAL_TAPS = 7;
const REVEAL_WINDOW_MS = 4000;
let taps = 0;
let firstTapAt = 0;

function onFooterTap(): void {
  const now = Date.now();
  if (now - firstTapAt > REVEAL_WINDOW_MS) { taps = 0; firstTapAt = now; }
  taps++;
  if (taps < REVEAL_TAPS) return;
  taps = 0;
  $('#admin-panel').classList.remove('hidden');
  showToast('設定の一番下に「管理者」が現れました。');
}

// 管理者かどうかで、出したり隠したりするもの。
// 「ペット」タブは管理者の間だけ現れる。
function applyAdminUi(): void {
  const on = isAdmin();
  // 公開したら誰にでも出す。それまでは管理者の間だけ。
  $('#tab-pet').classList.toggle('hidden', !(PETS_PUBLIC || on));
  // 管理者でいる間は、抜けられるように欄を出しておく
  if (on) $('#admin-panel').classList.remove('hidden');
  $('#admin-state').textContent = on
    ? '管理者モード: 入り(タブに「ペット」が出ています)'
    : '';
  $<HTMLButtonElement>('#btn-admin-off').classList.toggle('hidden', !on);
  // 入った後は入力欄を畳む
  if (on) $('#admin-form').classList.add('hidden');
  onAdminChange?.();
}

async function tryKey(key: string): Promise<void> {
  const msg = $('#admin-msg');
  msg.textContent = '確認中…';
  try {
    const res = await fetch(`${apiBase()}/api/admin/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json() as { ok?: boolean; error?: string };
    if (data.ok !== true) {
      msg.textContent = data.error ?? '合言葉が違います。';
      return;
    }
    adminKey = key;
    try { sessionStorage.setItem(KEY_STORE, key); } catch { /* 使えなくても動く */ }
    msg.textContent = '';
    applyAdminUi();
    showToast('管理者モードに入りました。タブに「ペット」が出ています。');
  } catch {
    msg.textContent = 'サーバーに繋がらない。オンラインの状態を確かめてください。';
  }
}

function adminOff(): void {
  adminKey = '';
  try { sessionStorage.removeItem(KEY_STORE); } catch { /* 無視 */ }
  $('#admin-msg').textContent = '';
  applyAdminUi();
  // 抜けたら欄ごと隠す。入り直すには、また版番号を叩いてもらう。
  $('#admin-panel').classList.add('hidden');
  $('#admin-form').classList.add('hidden');
  showToast('管理者モードを抜けました。');
}

export function initAdmin(): void {
  // 版番号は renderFooter が innerHTML ごと書き換えるので、
  // 中の要素ではなく親(#app-footer)で受ける。書き換えても外れない。
  $('#app-footer').addEventListener('click', onFooterTap);

  $('#btn-admin').addEventListener('click', () => {
    const form = $('#admin-form');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) $<HTMLInputElement>('#admin-key').focus();
  });
  $('#btn-admin-go').addEventListener('click', () => {
    void tryKey($<HTMLInputElement>('#admin-key').value.trim());
  });
  $<HTMLInputElement>('#admin-key').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') void tryKey($<HTMLInputElement>('#admin-key').value.trim());
  });
  $('#btn-admin-off').addEventListener('click', adminOff);

  // 同じタブで開き直した時のために、覚えていた合言葉をもう一度確かめる。
  // 覚えているだけで通してはいけない ― 合言葉が変わっていることがある。
  let saved = '';
  try { saved = sessionStorage.getItem(KEY_STORE) ?? ''; } catch { /* 無視 */ }
  if (saved) void tryKey(saved);
  else applyAdminUi();
}

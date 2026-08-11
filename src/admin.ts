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

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const KEY_STORE = 'madoken_admin_key';

let adminKey = '';

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

// 管理者かどうかで、出したり隠したりするもの。
// 「ペット」タブは管理者の間だけ現れる。
function applyAdminUi(): void {
  const on = isAdmin();
  $('#tab-pet').classList.toggle('hidden', !on);
  $('#admin-state').textContent = on
    ? '管理者モード: 入り(タブに「ペット」が出ています)'
    : '';
  $<HTMLButtonElement>('#btn-admin-off').classList.toggle('hidden', !on);
  // 入った後は入力欄を畳む
  if (on) $('#admin-form').classList.add('hidden');
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
  showToast('管理者モードを抜けました。');
}

export function initAdmin(): void {
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

// 起動まわり: サーバー起床の案内と、初回のニックネーム登録
//
// 無料プランのサーバーは15分遊ばれないとスリープする。
// 復帰に数十秒かかるため、黙って待たせずに状況を出す。

import {
  NICK_MAX_FULL, NICK_MAX_WIDTH, normalizeNickname, validateNickname,
} from '../shared/nickname';
import { notify, state } from './state';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function apiBase(): string {
  return import.meta.env.DEV ? 'http://localhost:2567' : '';
}

// ---- サーバー起床の案内 ----

let wakeTimer: number | undefined;
let wakeTick: number | undefined;

function showWake(seconds: number): void {
  const el = $('#wake-banner');
  el.classList.remove('hidden');
  el.innerHTML =
    '⏳ <b>プレイヤーがいなかったためサーバーをスリープしていました。</b>'
    + `ただいま起動中です、もう少しお待ちください…(経過 ${seconds}秒 / 通常30〜60秒)`;
}

function hideWake(): void {
  if (wakeTimer) window.clearTimeout(wakeTimer);
  if (wakeTick) window.clearInterval(wakeTick);
  wakeTimer = undefined;
  wakeTick = undefined;
  $('#wake-banner').classList.add('hidden');
}

// サーバーが応答するまで待つ。遅ければ「起動中」を出す。
export async function waitForServer(): Promise<boolean> {
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);

  // 1.5秒以内に返ればスリープしていないので何も出さない
  wakeTimer = window.setTimeout(() => {
    showWake(elapsed());
    wakeTick = window.setInterval(() => showWake(elapsed()), 1000);
  }, 1500);

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch(`${apiBase()}/api/status`, { cache: 'no-store' });
      if (res.ok) {
        hideWake();
        return true;
      }
    } catch {
      // まだ起きていない
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  const el = $('#wake-banner');
  el.classList.remove('hidden');
  el.innerHTML =
    '⚠ サーバーに接続できません。ソロでの調合と戦闘は遊べます。'
    + 'オンライン機能は時間をおいて試してください。';
  if (wakeTick) window.clearInterval(wakeTick);
  return false;
}

// ---- 初回のニックネーム登録 ----

let welcomeWired = false;
let welcomeDone: () => void = () => { /* 差し替えられる */ };

export function initWelcome(onDone: () => void): void {
  const overlay = $('#welcome-overlay');
  welcomeDone = onDone;
  if (state.nickname) {
    overlay.classList.add('hidden');
    onDone();
    return;
  }
  if (welcomeWired) {
    // 2回目以降(初期化した後など)は表示を戻すだけ
    overlay.classList.remove('hidden');
    $<HTMLInputElement>('#welcome-nick').value = '';
    $('#welcome-msg').textContent = '';
    $<HTMLButtonElement>('#btn-welcome-ok').disabled = false;
    $<HTMLInputElement>('#welcome-nick').focus();
    return;
  }
  welcomeWired = true;

  $('#welcome-rule').textContent =
    `全角${NICK_MAX_FULL}文字(半角${NICK_MAX_WIDTH}文字)まで。`
    + 'ひらがな・カタカナ・漢字・英数字のみ(スペースと記号は使えません)。'
    + '他の人が使っている名前は登録できません。';
  overlay.classList.remove('hidden');

  const input = $<HTMLInputElement>('#welcome-nick');
  const btn = $<HTMLButtonElement>('#btn-welcome-ok');
  const msg = $('#welcome-msg');
  input.focus();

  const submit = async (): Promise<void> => {
    const name = normalizeNickname(input.value);
    const err = validateNickname(name);
    if (err) {
      msg.textContent = err;
      return;
    }
    btn.disabled = true;
    msg.style.color = '#88bbaa';
    msg.textContent = '確認中…';
    try {
      const res = await fetch(`${apiBase()}/api/name/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token: state.nickToken }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) {
        msg.style.color = '#ff9977';
        msg.textContent = data.error ?? 'その名前は使えません。';
        btn.disabled = false;
        return;
      }
    } catch {
      msg.style.color = '#ff9977';
      msg.textContent = 'サーバーに接続できません。少し待ってからもう一度。';
      btn.disabled = false;
      return;
    }
    state.nickname = name;
    notify();
    overlay.classList.add('hidden');
    welcomeDone();
  };

  btn.addEventListener('click', () => void submit());
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') void submit();
  });
}

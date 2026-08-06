// 起動まわり: サーバー起床の案内と、初回のニックネーム登録
//
// 無料プランのサーバーは15分遊ばれないとスリープする。
// 復帰に数十秒かかるため、黙って待たせずに状況を出す。

import {
  NICK_MAX_FULL, NICK_MAX_WIDTH, normalizeNickname, validateNickname,
} from '../shared/nickname';
import { VERSION } from '../shared/version';
import { introHtml } from './intro';
import { parseTransferCode, pullCloudSave } from './cloudsave';
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

// ---- 版のずれを見張る ----
//
// この画面は一度開くと何日でもそのまま動き続ける。サーバーだけ新しくしても
// 開きっぱなしのページは古いままで、直したはずの不具合が直らないように見える。
//
// 実際に起きた例:
//   ボスの曲を3曲に分けた後も「古いBGMが鳴る」という報告が続いた。
//   古いページは起動時に読んだ古い音の一覧(boss → bgm/boss.mp3)を抱えていて、
//   サーバーにその古いファイルが残っている限り、ずっとそれを鳴らし続ける。
//
// 直しようがないので「気づける」ようにする。
const VERSION_CHECK_SEC = 300;

async function serverVersion(): Promise<string> {
  try {
    const res = await fetch(`${apiBase()}/api/status`, { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await res.json() as { version?: unknown };
    return String(data?.version ?? '');
  } catch {
    return ''; // つながらない時は黙っている(起動待ちの案内が別に出る)
  }
}

function showUpdate(latest: string): void {
  const el = $('#update-banner');
  if (!el.classList.contains('hidden')) return; // すでに出ているなら触らない
  // 「新しい版が出ています」と決めつけない。
  // 入れ替えの最中など、開いている画面の方が新しいこともある。
  el.textContent =
    `🔄 サーバー側は v${latest} です(この画面は v${VERSION})。`
    + '読み込み直すまで、直った不具合も古いまま残ります。 ';
  const btn = document.createElement('button');
  btn.textContent = '今すぐ読み込み直す';
  // 戦闘中に勝手に読み込み直すと途中で放り出すことになるので、押してもらう。
  btn.addEventListener('click', () => location.reload());
  el.appendChild(btn);
  el.classList.remove('hidden');
}

export function watchVersion(): void {
  const look = async (): Promise<void> => {
    const latest = await serverVersion();
    if (latest && latest !== VERSION) showUpdate(latest);
  };
  void look();
  window.setInterval(() => void look(), VERSION_CHECK_SEC * 1000);
  // 放置していた画面に戻ってきた時が一番ずれている。その時にも確かめる。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void look();
  });
}

// ---- 初回の登録画面(新規で始める / 別端末から引き継ぐ) ----

let welcomeWired = false;
let welcomeDone: () => void = () => { /* 差し替えられる */ };

// 入力欄とメッセージを初期状態に戻す(初期化した直後にも使う)
function resetWelcome(): void {
  $<HTMLInputElement>('#welcome-nick').value = '';
  $<HTMLInputElement>('#welcome-code').value = '';
  $('#welcome-msg').textContent = '';
  $<HTMLButtonElement>('#btn-welcome-ok').disabled = false;
  $<HTMLButtonElement>('#btn-welcome-transfer').disabled = false;
  showWelcomeMode('new');
}

// 「はじめて遊ぶ」と「データを引き継ぐ」の切り替え
function showWelcomeMode(mode: 'new' | 'transfer'): void {
  const isNew = mode === 'new';
  $('#welcome-new').classList.toggle('hidden', !isNew);
  $('#welcome-transfer').classList.toggle('hidden', isNew);
  $('#wt-new').classList.toggle('active', isNew);
  $('#wt-transfer').classList.toggle('active', !isNew);
  $('#welcome-msg').textContent = '';
  $<HTMLInputElement>(isNew ? '#welcome-nick' : '#welcome-code').focus();
}

function setWelcomeMsg(text: string, isError: boolean): void {
  const msg = $('#welcome-msg');
  msg.style.color = isError ? '#ff9977' : '#88bbaa';
  msg.textContent = text;
}

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
    resetWelcome();
    return;
  }
  welcomeWired = true;

  // 何をするゲームなのかを最初に見せる。
  // 名前を決める画面は必ず通るので、ここに置けば取りこぼしがない。
  $('#welcome-intro').innerHTML = introHtml();

  $('#welcome-rule').textContent =
    `全角${NICK_MAX_FULL}文字(半角${NICK_MAX_WIDTH}文字)まで。`
    + 'ひらがな・カタカナ・漢字・英数字のみ(スペースと記号は使えません)。'
    + '他の人が使っている名前は登録できません。';
  overlay.classList.remove('hidden');

  $('#wt-new').addEventListener('click', () => showWelcomeMode('new'));
  $('#wt-transfer').addEventListener('click', () => showWelcomeMode('transfer'));

  // --- 新しく始める ---
  const input = $<HTMLInputElement>('#welcome-nick');
  const btn = $<HTMLButtonElement>('#btn-welcome-ok');

  const submitNew = async (): Promise<void> => {
    const name = normalizeNickname(input.value);
    const err = validateNickname(name);
    if (err) {
      setWelcomeMsg(err, true);
      return;
    }
    btn.disabled = true;
    setWelcomeMsg('確認中…', false);
    try {
      const res = await fetch(`${apiBase()}/api/name/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token: state.nickToken }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) {
        setWelcomeMsg(data.error ?? 'その名前は使えません。', true);
        btn.disabled = false;
        return;
      }
    } catch {
      setWelcomeMsg('サーバーに接続できません。少し待ってからもう一度。', true);
      btn.disabled = false;
      return;
    }
    state.nickname = name;
    notify();
    overlay.classList.add('hidden');
    welcomeDone();
  };

  btn.addEventListener('click', () => void submitNew());
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') void submitNew();
  });

  // --- 別の端末から引き継ぐ ---
  // この端末にはまだ何も無いので、設定タブの復元と違って確認は挟まない。
  const codeInput = $<HTMLInputElement>('#welcome-code');
  const tBtn = $<HTMLButtonElement>('#btn-welcome-transfer');

  const submitTransfer = async (): Promise<void> => {
    const { name, token, error } = parseTransferCode(codeInput.value);
    if (error) {
      setWelcomeMsg(error, true);
      return;
    }
    tBtn.disabled = true;
    setWelcomeMsg('引き継ぎ中…', false);
    const err = await pullCloudSave(name, token);
    if (err) {
      setWelcomeMsg(err, true);
      tBtn.disabled = false;
      return;
    }
    overlay.classList.add('hidden');
    welcomeDone();
  };

  tBtn.addEventListener('click', () => void submitTransfer());
  codeInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') void submitTransfer();
  });

  input.focus();
}

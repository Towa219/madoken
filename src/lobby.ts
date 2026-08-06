// オンライン機能: 接続・ロビーチャット・共闘部屋の作成/参加

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { CoopView } from './coop';
import { DuelView } from './duel';
import { spellDisplayName } from '../shared/spellcraft';
import {
  NICK_MAX_FULL, NICK_MAX_WIDTH, normalizeNickname, validateNickname,
} from '../shared/nickname';
import { bossBgmFor, isBossStage } from '../shared/data';
import { showToast } from './lab';
import { CODE_REPLACED } from '../shared/netcodes';
import { equippedSpells, notify, state } from './state';
import { selectedStage } from './stage';
import {
  cloudNewerThanHere, pullMine, pushCloudSave, submitMagicRanking,
} from './cloudsave';
import { playBgm } from './sound';
import type { SpellPayload } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

let client: Client | null = null;
let lobbyRoom: Room | null = null;
let nick = '';
const coop = new CoopView();
const duel = new DuelView();

export function coopTryCast(i: number): void {
  coop.tryCast(i);
}

export function duelTryCast(i: number): void {
  duel.tryCast(i);
}

// APIのベースURL(開発時はサーバーが別ポート)
function apiBase(): string {
  return import.meta.env.DEV ? 'http://localhost:2567' : '';
}

// ニックネーム欄の状態を反映(一度決めたら初期化まで変更不可)
export function renderNickField(): void {
  const input = $<HTMLInputElement>('#nick-input');
  const note = $('#nick-note');
  if (state.nickname) {
    input.value = state.nickname;
    input.disabled = true;
    note.textContent =
      'ニックネームは登録済み。変更するには右上の「初期化」でキャラをリセットする必要がある。';
  } else {
    input.disabled = false;
    note.textContent =
      `最初に接続したときのニックネームが登録され、以後は変更できない。`
      + `全角${NICK_MAX_FULL}文字(半角${NICK_MAX_WIDTH}文字)まで・`
      + `使えるのはひらがな/カタカナ/漢字/英数字だけ`
      + `(スペースと記号は半角・全角とも不可)。`
      + `他の人が使っている名前は登録できない。`;
  }
}

// ニックネームを手放す(キャラ初期化時に呼ぶ)。同じ名前を他の人が使えるようになる。
export async function releaseNickname(): Promise<void> {
  const name = state.nickname;
  const token = state.nickToken;
  if (!name || !token) return;
  try {
    await fetch(`${apiBase()}/api/name/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
  } catch {
    // オフライン時は諦める(サーバー側に登録が残る)
  }
}

// プレイ中人数のハートビート(ロビー未接続でもカウントされる)
function startHeartbeat(): void {
  // ブラウザ単位のID(localStorage)。同じブラウザで何タブ開いても1人と数える
  let id: string | null = null;
  try { id = localStorage.getItem('madoken_hb_id'); } catch { /* 無視 */ }
  if (!id) {
    id = `hb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    try { localStorage.setItem('madoken_hb_id', id); } catch { /* 無視 */ }
  }
  const beat = async () => {
    try {
      const res = await fetch(`${apiBase()}/api/heartbeat?id=${encodeURIComponent(id!)}`);
      const data = await res.json() as { count: number };
      $('#online-count').textContent = `🟢 プレイ中: ${data.count}人`;
    } catch {
      $('#online-count').textContent = '🔴 サーバー未接続';
    }
  };
  void beat();
  window.setInterval(() => void beat(), 30_000);
}

export function initOnline(): void {
  $('#btn-connect').addEventListener('click', () => void connect());
  $<HTMLInputElement>('#nick-input').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') void connect();
  });
  renderNickField();
  startHeartbeat();
  $('#btn-chat-send').addEventListener('click', sendChat);
  $<HTMLInputElement>('#chat-input').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') sendChat();
  });
  $('#btn-create-room').addEventListener('click', () => void createRoom());
  $('#btn-duel').addEventListener('click', () => void joinDuel());
  $('#btn-refresh-rooms').addEventListener('click', () => {
    void refreshRooms();
    void refreshRanking();
  });

  // ニックネーム登録済みなら、ゲームを開いた時点で自動的にオンラインへ。
  // (プレイ中の人はそのまま「オンライン接続中」として扱われ、
  //  セーブも常にサーバーへ保存される)
  if (state.nickname) {
    autoConnect = true;
    void connect();
  }
}

// 共闘か決闘の画面を開いている最中か。
// ロビーの接続が切れたり繋ぎ直したりしても、この間は画面を切り替えてはいけない。
// BGMの切り替え判断にも使う(共闘中にロビー曲を流し始めないため)。
export function inBattleView(): boolean {
  return !$('#coop-view').classList.contains('hidden')
    || !$('#duel-view').classList.contains('hidden')
    || !$('#battle-view').classList.contains('hidden');
}

// ロビー側(接続欄・ロビー)の表示を今の状態に合わせる。
//
// 「戦闘」と「オンライン」を1つの画面にまとめたので、戦っている間は
// ロビーも隠す必要がある。並んだままだと、戦闘画面の下にチャットと
// 部屋一覧が伸びて、どこを見ればいいのか分からなくなる。
export function syncLobbyVisibility(): void {
  const fighting = inBattleView();
  // 出撃準備も一緒に隠す。共闘や決闘を始めても残っていて、戦闘画面の上に
  // 「ソロで出撃」「共闘部屋を作る」が並んだままになっていた。
  $('#battle-setup').classList.toggle('hidden', fighting);
  $('#online-login').classList.toggle('hidden', fighting || !!lobbyRoom);
  $('#online-lobby').classList.toggle('hidden', fighting || !lobbyRoom);
}

// 自動接続で入った場合は、切断されたら黙って繋ぎ直す
let autoConnect = false;
let reconnectTimer: number | undefined;

function scheduleReconnect(): void {
  if (!autoConnect || !state.nickname || lobbyRoom) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => void connect(), 15_000);
}

// ---- 接続 ----

let connecting = false;

async function connect(): Promise<void> {
  if (connecting || lobbyRoom) return; // 連打・二重接続ガード
  connecting = true;
  const connectBtn = $<HTMLButtonElement>('#btn-connect');
  connectBtn.disabled = true;

  // 登録済みなら保存されたニックネームを使う(変更不可)
  const isNew = !state.nickname;
  nick = state.nickname || normalizeNickname($<HTMLInputElement>('#nick-input').value);

  // 形式チェック(スペース・記号・文字数)
  const formErr = validateNickname(nick);
  if (formErr) {
    $('#online-msg').textContent = formErr;
    connecting = false;
    connectBtn.disabled = false;
    return;
  }

  // 重複チェック(サーバーの登録簿に確保する)
  $('#online-msg').textContent = 'ニックネームを確認中…';
  try {
    const res = await fetch(`${apiBase()}/api/name/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nick, token: state.nickToken }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      $('#online-msg').textContent = data.error ?? 'そのニックネームは使用できません。';
      connecting = false;
      connectBtn.disabled = false;
      return;
    }
  } catch {
    $('#online-msg').textContent =
      'サーバーに接続できない。少し待ってからもう一度試してください。';
    connecting = false;
    connectBtn.disabled = false;
    return;
  }

  if (isNew) {
    state.nickname = nick;
    notify();
    renderNickField();
  }
  $('#online-msg').textContent = '接続中…';
  try {
    const endpoint = import.meta.env.DEV
      ? 'ws://localhost:2567'
      : location.origin.replace(/^http/, 'ws');
    client = new Client(endpoint);
    lobbyRoom = await client.joinOrCreate('lobby_chat', {
      name: nick, nickToken: state.nickToken,
    });
    wireLobby(lobbyRoom);

    autoConnect = true; // 以後は切断されても自動で繋ぎ直す
    // 戦闘中に繋ぎ直した場合、ロビーを出すと戦闘画面が隠れてしまう。
    // 戦闘が終わったときに enterCoop/joinDuel の後始末がロビーを出す。
    syncLobbyVisibility();
    $('#online-msg').textContent = '';

    void refreshRooms();
    void refreshRanking();
    // 別の端末で先に進めていないかを見る。
    // 押し付け合いにならないよう、先に確認してから保存する。
    void checkOtherDevice();
    // 接続時に一度は順位を登録しておく。調合していない日でも一覧に載るように。
    void submitMagicRanking().then(() => refreshRanking());
  } catch (err) {
    console.error(err);
    const msg = (err as { message?: string })?.message;
    $('#online-msg').textContent = msg
      ? `接続できなかった: ${msg}`
      : 'サーバーに接続できない。少し待つと自動で繋ぎ直します。';
    scheduleReconnect();
  } finally {
    connecting = false;
    connectBtn.disabled = false;
  }
}

function wireLobby(room: Room): void {
  // 同じ名前で別の場所から入り直された(切断される直前に届く)。
  //
  // 本番のプロキシ越しでは、サーバーが閉じても切断がこちらに伝わらないことがある。
  // 待っていると「繋がっているつもり」のまま古い一覧を表示し続けるので、
  // 通知を受けた時点で自分から抜ける。
  let replaced = false;
  room.onMessage('replaced', () => {
    replaced = true;
    autoConnect = false;
    void room.leave();
  });

  room.onMessage('chat', (msg: { name: string; text: string }) => {
    addChatLine(msg.name, msg.text);
  });
  room.onStateChange(() => renderMembers());
  room.onLeave((code?: number) => {
    lobbyRoom = null;
    // ロビーと戦闘部屋は別々の接続。ロビーが切れても戦闘は続いているので、
    // 戦闘中は画面を切り替えない(切り替えると戦闘画面が消えて
    // 「部屋が落ちた」ように見える)。
    syncLobbyVisibility();
    // 同じ名前で別の場所から入り直された場合は、繋ぎ直すと取り合いになる
    if (replaced || code === CODE_REPLACED) {
      autoConnect = false;
      $('#online-msg').textContent =
        '同じニックネームで別の場所から接続されたため、こちらは切断しました。'
        + 'この画面で遊ぶ場合は、もう一度「接続」を押してください。';
      return;
    }
    $('#online-msg').textContent = autoConnect
      ? '切断された。自動で繋ぎ直します…'
      : '切断された。もう一度接続してください。';
    scheduleReconnect();
  });
}

// 現在オンラインのメンバー一覧
function renderMembers(): void {
  const box = $('#online-members');
  if (!lobbyRoom) {
    box.innerHTML = '';
    return;
  }
  const st = lobbyRoom.state as { players?: { forEach(cb: (p: { name: string }) => void): void } };
  const names: string[] = [];
  st?.players?.forEach(p => names.push(p.name));
  if (names.length === 0) {
    box.innerHTML = '<span class="empty-note">読み込み中…</span>';
    return;
  }
  box.innerHTML = '';
  for (const n of names) {
    const chip = document.createElement('span');
    chip.className = 'member-chip';
    chip.textContent = n;
    box.appendChild(chip);
  }
  const count = document.createElement('span');
  count.className = 'member-count';
  count.textContent = `${names.length}人`;
  box.appendChild(count);
}

// ---- チャット ----

function sendChat(): void {
  const input = $<HTMLInputElement>('#chat-input');
  const text = input.value.trim();
  if (!text || !lobbyRoom) return;
  lobbyRoom.send('chat', text);
  input.value = '';
}

function addChatLine(name: string, text: string): void {
  const log = $('#chat-log');
  const row = document.createElement('div');
  row.className = 'chat-row'
    + (name === 'システム' ? ' chat-sys' : '')
    + (name === 'お知らせ' ? ' chat-notice' : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'chat-name';
  nameEl.textContent = name;
  const textEl = document.createElement('span');
  textEl.textContent = text;
  row.append(nameEl, textEl);
  log.appendChild(row);
  while (log.children.length > 100) log.removeChild(log.firstChild!);
  log.scrollTop = log.scrollHeight;
}

// ---- 共闘部屋 ----

function spellPayload(): SpellPayload[] {
  return equippedSpells().map(sp => ({
    name: spellDisplayName(sp), recipe: sp.recipe, level: sp.level, rarity: sp.rarity,
  }));
}

// 連打で部屋がいくつも作られないようにする
let creatingRoom = false;

async function createRoom(): Promise<void> {
  if (!client || creatingRoom) return;
  const spells = spellPayload();
  if (spells.length === 0) {
    $('#lobby-msg').textContent = '先に研究室で魔法を調合・装備してから。';
    return;
  }
  // ステージは出撃準備で選んだものを使う(ソロと共通)
  const stage = selectedStage(state.maxStage);
  const btn = $<HTMLButtonElement>('#btn-create-room');
  creatingRoom = true;
  btn.disabled = true;
  try {
    const room = await client.create('coop', {
      name: nick, spells, stage, maxStage: state.maxStage,
      nickToken: state.nickToken, charId: state.charId,
    });
    enterCoop(room, stage);
  } catch (err) {
    console.error(err);
    $('#lobby-msg').textContent = '部屋を作れなかった。';
  } finally {
    creatingRoom = false;
    btn.disabled = false;
  }
}

async function joinRoom(roomId: string, roomStage: number): Promise<void> {
  if (!client) return;
  const spells = spellPayload();
  if (spells.length === 0) {
    $('#lobby-msg').textContent = '先に研究室で魔法を調合・装備してから。';
    return;
  }
  if (roomStage > state.maxStage) {
    $('#lobby-msg').textContent =
      `ステージ${roomStage}にはまだ到達していない。ソロでステージ${state.maxStage}をクリアすると挑めるようになる。`;
    return;
  }
  try {
    const room = await client.joinById(roomId, {
      name: nick, spells, maxStage: state.maxStage,
      nickToken: state.nickToken, charId: state.charId,
    });
    enterCoop(room, roomStage);
  } catch (err) {
    console.error(err);
    const msg = String((err as { message?: unknown })?.message ?? '');
    $('#lobby-msg').textContent = msg.includes('到達')
      ? `ステージ${roomStage}にはまだ到達していない。まずソロで進めよう。`
      : 'その部屋には入れなかった(満員か開始済み)。';
    void refreshRooms();
  }
}

// 別の端末に新しい記録があれば帯で知らせる。
//
// 黙って上書きも取り込みもしない。どちらの端末の記録を残すかは本人しか
// 決められないため、必ず選んでもらう。
async function checkOtherDevice(): Promise<void> {
  const banner = $('#sync-banner');
  const newerAt = await cloudNewerThanHere();
  if (newerAt === null) {
    banner.classList.add('hidden');
    void pushCloudSave(); // こちらが最新なので、そのまま保存しておく
    return;
  }

  const when = new Date(newerAt).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  banner.innerHTML = '';
  const msg = document.createElement('span');
  msg.innerHTML =
    `📱 別の端末に<b>もっと新しい記録</b>があります(${when})。`
    + 'この端末に取り込みますか?';
  const take = document.createElement('button');
  take.className = 'sync-take';
  take.textContent = '取り込む';
  const keep = document.createElement('button');
  keep.textContent = 'この端末のまま続ける';
  const note = document.createElement('span');
  note.style.color = '#8899aa';
  note.textContent = '※ 取り込むと、この端末の今の記録は消えます';
  banner.append(msg, take, keep, note);
  banner.classList.remove('hidden');

  take.addEventListener('click', () => {
    take.disabled = true;
    keep.disabled = true;
    take.textContent = '取り込み中…';
    void pullMine().then(err => {
      banner.classList.add('hidden');
      showToast(err ?? '別の端末の記録を取り込んだ。');
    });
  });
  keep.addEventListener('click', () => {
    banner.classList.add('hidden');
    // この端末を残すと決めたので、こちらでサーバーを上書きする
    void pushCloudSave(true).then(() => {
      showToast('この端末の記録でサーバーを更新した。');
    });
  });
}

// ランキング(サーバーAPIから取得)
async function refreshRanking(): Promise<void> {
  const list = $('#ranking-list');
  try {
    const res = await fetch(`${apiBase()}/api/ranking`);
    const data = await res.json() as {
      persistent: boolean;
      entries: { name: string; score: number; spells: string[]; date: string }[];
    };
    const entries = data.entries ?? [];
    const note = $('#ranking-note');
    note.textContent = data.persistent
      ? '記録は恒久保存されます(ニックネームごとに自己ベスト1件)。'
      : '※現在は一時保存。サーバー更新でリセットされます。';
    note.className = data.persistent ? 'note chance-high' : 'note chance-mid';
    if (entries.length === 0) {
      list.innerHTML =
        '<div class="empty-note">まだ記録がない。研究室で魔法を調合して最初の記録を作ろう!</div>';
      return;
    }
    list.innerHTML = '';
    entries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row';
      const medal = ['🥇', '🥈', '🥉'][i] ?? `${i + 1}位`;
      const head = document.createElement('div');
      head.className = 'rank-head';
      const medalEl = document.createElement('span');
      medalEl.className = 'rank-medal';
      medalEl.textContent = medal;
      const nameEl = document.createElement('span');
      nameEl.className = 'rank-name';
      nameEl.textContent = e.name;
      const scoreEl = document.createElement('span');
      scoreEl.className = 'rank-score';
      scoreEl.textContent = `魔導値 ${e.score}`;
      head.append(medalEl, nameEl, scoreEl);
      const spellsEl = document.createElement('div');
      spellsEl.className = 'rank-spells';
      spellsEl.textContent = e.spells.length > 0 ? e.spells.join(' / ') : '(魔法不明)';
      row.append(head, spellsEl);
      list.appendChild(row);
    });
  } catch {
    list.innerHTML = '<div class="empty-note">ランキングを取得できなかった。</div>';
  }
}

async function refreshRooms(): Promise<void> {
  if (!client) return;
  const list = $('#room-list');
  try {
    const rooms = await client.getAvailableRooms('coop');
    list.innerHTML = '';
    if (rooms.length === 0) {
      list.innerHTML = '<div class="empty-note">募集中の部屋はない。「部屋を作る」で募集しよう。</div>';
      return;
    }
    for (const r of rooms) {
      const meta = r.metadata as { stage?: number } | undefined;
      const roomStage = Number(meta?.stage ?? 1);
      const locked = roomStage > state.maxStage;
      const row = document.createElement('div');
      row.className = 'room-row' + (locked ? ' locked' : '');
      const label = document.createElement('span');
      label.textContent = locked
        ? `🔒 ステージ${roomStage} — 未到達(あなたはステージ${state.maxStage}まで)`
        : `ステージ${roomStage} — ${r.clients}/${r.maxClients}人`;
      const btn = document.createElement('button');
      btn.textContent = locked ? '参加不可' : '参加';
      btn.disabled = locked;
      btn.addEventListener('click', () => void joinRoom(r.roomId, roomStage));
      row.append(label, btn);
      list.appendChild(row);
    }
  } catch (err) {
    console.error(err);
    list.innerHTML = '<div class="empty-note">部屋一覧を取得できなかった。</div>';
  }
}

// ---- 決闘(1対1) ----

async function joinDuel(): Promise<void> {
  if (!client) return;
  const spells = spellPayload();
  if (spells.length === 0) {
    $('#lobby-msg').textContent = '先に研究室で魔法を調合・装備してから。';
    return;
  }
  try {
    const room = await client.joinOrCreate('duel', {
      name: nick, spells, nickToken: state.nickToken, charId: state.charId,
    });
    $('#lobby-msg').textContent = '';
    $('#duel-view').classList.remove('hidden');
    syncLobbyVisibility();
    playBgm('duel');
    void duel.start(room, () => {
      $('#duel-view').classList.add('hidden');
      syncLobbyVisibility();
      playBgm('lobby');
      if (lobbyRoom) void refreshRanking();
    }, async token => {
      // 通信が切れた時の復帰。サーバーは30秒だけ席を空けて待っている。
      if (!client) return null;
      return await client.reconnect(token);
    });
  } catch (err) {
    console.error(err);
    $('#lobby-msg').textContent = '決闘場に入れなかった。';
  }
}

// stage は入る前から分かっているものを渡す。
//
// room.state はまだ届いていないことがあり、そこから読むと
// 「ステージ1=ボスではない」と判断して通常戦闘の曲を一瞬鳴らしてしまう。
// すぐ共闘画面側が正しい曲に差し替えるが、鳴らし始めと差し替えが重なると
// ブラウザに再生を中断され、無音のまま戦うことがある。
function enterCoop(room: Room, stage: number): void {
  $('#lobby-msg').textContent = '';
  playBgm(isBossStage(stage) ? bossBgmFor(stage) : 'battle');
  $('#coop-view').classList.remove('hidden');
  syncLobbyVisibility();
  void coop.start(room, () => {
    $('#coop-view').classList.add('hidden');
    syncLobbyVisibility();
    playBgm('lobby');
    if (lobbyRoom) {
      void refreshRooms();
      void refreshRanking();
    }
  }, async token => {
    // 通信が切れた時の復帰。サーバーは30秒だけ席を空けて待っている。
    if (!client) return null;
    return await client.reconnect(token);
  });
}

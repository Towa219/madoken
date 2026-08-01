// オンライン機能: 接続・ロビーチャット・共闘部屋の作成/参加

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { CoopView } from './coop';
import { spellDisplayName } from '../shared/spellcraft';
import { equippedSpells, notify, state } from './state';
import type { SpellPayload } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

let client: Client | null = null;
let lobbyRoom: Room | null = null;
let nick = '';
const coop = new CoopView();

export function coopTryCast(i: number): void {
  coop.tryCast(i);
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
    note.textContent = '最初に接続したときのニックネームが登録され、以後は変更できない。';
  }
}

// プレイ中人数のハートビート(ロビー未接続でもカウントされる)
function startHeartbeat(): void {
  let id = sessionStorage.getItem('madoken_hb_id');
  if (!id) {
    id = `hb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    try { sessionStorage.setItem('madoken_hb_id', id); } catch { /* 無視 */ }
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
  $('#btn-refresh-rooms').addEventListener('click', () => {
    void refreshRooms();
    void refreshRanking();
  });
}

// ---- 接続 ----

let connecting = false;

async function connect(): Promise<void> {
  if (connecting || lobbyRoom) return; // 連打・二重接続ガード
  connecting = true;
  const connectBtn = $<HTMLButtonElement>('#btn-connect');
  connectBtn.disabled = true;
  // 登録済みなら保存されたニックネームを使う(変更不可)
  nick = state.nickname
    || $<HTMLInputElement>('#nick-input').value.trim().slice(0, 12)
    || '名無し';
  if (!state.nickname) {
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
    lobbyRoom = await client.joinOrCreate('lobby_chat', { name: nick });
    wireLobby(lobbyRoom);

    $('#online-login').classList.add('hidden');
    $('#online-lobby').classList.remove('hidden');
    $('#online-msg').textContent = '';

    renderStageOptions();
    void refreshRooms();
    void refreshRanking();
  } catch (err) {
    console.error(err);
    $('#online-msg').textContent =
      'サーバーに接続できない。サーバーが起動しているか確認してください。';
  } finally {
    connecting = false;
    connectBtn.disabled = false;
  }
}

function wireLobby(room: Room): void {
  room.onMessage('chat', (msg: { name: string; text: string }) => {
    addChatLine(msg.name, msg.text);
  });
  room.onStateChange(() => renderMembers());
  room.onLeave(() => {
    lobbyRoom = null;
    $('#online-lobby').classList.add('hidden');
    $('#coop-view').classList.add('hidden');
    $('#online-login').classList.remove('hidden');
    $('#online-msg').textContent = '切断された。もう一度接続してください。';
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

function renderStageOptions(): void {
  const sel = $<HTMLSelectElement>('#coop-stage');
  sel.innerHTML = '';
  for (let i = 1; i <= state.maxStage; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = i % 5 === 0 ? `${i} (ボス)` : String(i);
    sel.appendChild(o);
  }
  sel.value = String(state.maxStage);
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
  row.className = 'chat-row' + (name === 'システム' ? ' chat-sys' : '');
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
    name: spellDisplayName(sp), recipe: sp.recipe, level: sp.level,
  }));
}

async function createRoom(): Promise<void> {
  if (!client) return;
  const spells = spellPayload();
  if (spells.length === 0) {
    $('#lobby-msg').textContent = '先に研究室で魔法を調合・装備してから。';
    return;
  }
  const stage = Number($<HTMLSelectElement>('#coop-stage').value) || 1;
  try {
    const room = await client.create('coop', {
      name: nick, spells, stage, maxStage: state.maxStage,
    });
    enterCoop(room);
  } catch (err) {
    console.error(err);
    $('#lobby-msg').textContent = '部屋を作れなかった。';
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
    });
    enterCoop(room);
  } catch (err) {
    console.error(err);
    const msg = String((err as { message?: unknown })?.message ?? '');
    $('#lobby-msg').textContent = msg.includes('到達')
      ? `ステージ${roomStage}にはまだ到達していない。まずソロで進めよう。`
      : 'その部屋には入れなかった(満員か開始済み)。';
    void refreshRooms();
  }
}

// ランキング(サーバーAPIから取得)
async function refreshRanking(): Promise<void> {
  const list = $('#ranking-list');
  try {
    const res = await fetch(`${apiBase()}/api/ranking`);
    const entries = await res.json() as {
      name: string; score: number; spells: string[]; date: string;
    }[];
    if (entries.length === 0) {
      list.innerHTML = '<div class="empty-note">まだ記録がない。共闘で最初の記録を作ろう!</div>';
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
      scoreEl.textContent = `${e.score}pt`;
      head.append(medalEl, nameEl, scoreEl);
      const spellsEl = document.createElement('div');
      spellsEl.className = 'rank-spells';
      spellsEl.textContent = e.spells.length > 0 ? e.spells.join(' / ') : '(装備不明)';
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

function enterCoop(room: Room): void {
  $('#lobby-msg').textContent = '';
  $('#online-lobby').classList.add('hidden');
  $('#coop-view').classList.remove('hidden');
  void coop.start(room, () => {
    $('#coop-view').classList.add('hidden');
    if (lobbyRoom) {
      $('#online-lobby').classList.remove('hidden');
      renderStageOptions();
      void refreshRooms();
      void refreshRanking();
    } else {
      $('#online-login').classList.remove('hidden');
    }
  });
}

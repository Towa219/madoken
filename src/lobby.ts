// オンライン機能: 接続・ロビーチャット・共闘部屋の作成/参加

import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { CoopView } from './coop';
import { equippedSpells, state } from './state';
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

export function initOnline(): void {
  $('#btn-connect').addEventListener('click', () => void connect());
  $<HTMLInputElement>('#nick-input').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') void connect();
  });
  $('#btn-chat-send').addEventListener('click', sendChat);
  $<HTMLInputElement>('#chat-input').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') sendChat();
  });
  $('#btn-create-room').addEventListener('click', () => void createRoom());
  $('#btn-refresh-rooms').addEventListener('click', () => void refreshRooms());
}

// ---- 接続 ----

async function connect(): Promise<void> {
  nick = $<HTMLInputElement>('#nick-input').value.trim().slice(0, 12) || '名無し';
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
  } catch (err) {
    console.error(err);
    $('#online-msg').textContent =
      'サーバーに接続できない。サーバーが起動しているか確認してください。';
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
  return equippedSpells().map(sp => ({ name: sp.name, recipe: sp.recipe }));
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
    const room = await client.create('coop', { name: nick, spells, stage });
    enterCoop(room);
  } catch (err) {
    console.error(err);
    $('#lobby-msg').textContent = '部屋を作れなかった。';
  }
}

async function joinRoom(roomId: string): Promise<void> {
  if (!client) return;
  const spells = spellPayload();
  if (spells.length === 0) {
    $('#lobby-msg').textContent = '先に研究室で魔法を調合・装備してから。';
    return;
  }
  try {
    const room = await client.joinById(roomId, { name: nick, spells });
    enterCoop(room);
  } catch (err) {
    console.error(err);
    $('#lobby-msg').textContent = 'その部屋には入れなかった(満員か開始済み)。';
    void refreshRooms();
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
      const row = document.createElement('div');
      row.className = 'room-row';
      const meta = r.metadata as { stage?: number } | undefined;
      const label = document.createElement('span');
      label.textContent = `ステージ${meta?.stage ?? '?'} — ${r.clients}/${r.maxClients}人`;
      const btn = document.createElement('button');
      btn.textContent = '参加';
      btn.addEventListener('click', () => void joinRoom(r.roomId));
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
    } else {
      $('#online-login').classList.remove('hidden');
    }
  });
}

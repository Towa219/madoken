// 交易所のエレメント取引(プレイヤー同士の個人取引)
//
// ロビーに居る人を選んで申し込み、相手が受けると二人ぶんの卓が開く。
// 互いに出すものを置き、二人とも「準備完了」を押した瞬間に交換が成立する。
//
// 相場は固定(shared/trade.ts)。価値が釣り合っていない卓は準備完了を押せない。
//
// 手持ちを減らすのは成立した時だけ。卓に置いている間は素材庫から減らさず、
// 「出している分を除いた残り」を横に出す。先に減らしてしまうと、途中で
// 通信が切れた時に何も受け取れないまま消えることになる。卓は画面全体を
// ふさぐので、置いている間に他の場所で使ってしまう道は無い。

import { ELEMENT_ORDER, ELEMENTS } from '../shared/data';
import {
  BASIC_ELEMENTS, canAfford, checkTrade, countsValue, isEmptyCounts,
  RARE_ELEMENTS, RARE_VALUE, TRADE_MAX_PER_KIND,
} from '../shared/trade';
import { lobbyMembers, lobbyRoomRef, myLobbyId, onLobbyUpdate } from './lobby';
import { notify, state } from './state';
import { showToast } from './lab';
import { inBattleView } from './nozoom';
import { playSfx } from './sound';
import type { Room } from 'colyseus.js';
import type { ElementCounts, ElementId } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// ---- 今の状態 ----

let wired: Room | null = null;       // 手続きを繋いだ接続(入れ替わりを見張る)
let peerName = '';
let trading = false;
let myOffer: ElementCounts = {};
let theirOffer: ElementCounts = {};
let myReady = false;
let theirReady = false;
let invitedFrom = '';                // 誘ってきた人の名前(返事待ち)
let waitingFor = '';                 // こちらが誘って返事を待っている相手の名前

// 取引中は画面を移動させない(main.ts が見る)
export function tradeInProgress(): boolean {
  return trading;
}

// ---- 送信 ----

function send(type: string, payload: unknown): void {
  const room = lobbyRoomRef();
  if (!room) {
    setMsg('ロビーに接続していない。');
    return;
  }
  room.send(type, payload);
}

function setMsg(text: string): void {
  $('#trade-msg').textContent = text;
}

// ---- 受信 ----

function attach(room: Room): void {
  room.onMessage('trade:error', (m: { text?: string }) => {
    showToast(m?.text ?? '取引できなかった。');
    setMsg(m?.text ?? '');
    waitingFor = '';
    renderPanel();
  });

  room.onMessage('trade:sent', (m: { name?: string }) => {
    waitingFor = m?.name ?? '';
    setMsg(`${waitingFor} に取引を申し込んだ。返事を待っている…`);
    renderPanel();
  });

  room.onMessage('trade:declined', (m: { name?: string }) => {
    waitingFor = '';
    setMsg(`${m?.name ?? '相手'} は取引を断った。`);
    renderPanel();
  });

  room.onMessage('trade:invited', (m: { name?: string }) => {
    // 卓に着いている最中は割り込ませない
    if (trading) return;
    // 戦っている最中も同じ。卓は画面全体をふさぐので、戦闘中に開くと
    // 敵も魔法ボタンも見えなくなる。断って、相手にはそう伝わる。
    if (inBattleView()) {
      send('trade:answer', { ok: false });
      return;
    }
    invitedFrom = m?.name ?? '相手';
    playSfx('start');
    renderModal();
  });

  room.onMessage('trade:cancelInvite', () => {
    invitedFrom = '';
    renderModal();
  });

  room.onMessage('trade:begin', (m: { name?: string }) => {
    peerName = m?.name ?? '相手';
    trading = true;
    invitedFrom = '';
    waitingFor = '';
    myOffer = {};
    theirOffer = {};
    myReady = false;
    theirReady = false;
    setMsg('');
    playSfx('select');
    renderModal();
  });

  room.onMessage('trade:view', (m: {
    mine?: ElementCounts; theirs?: ElementCounts;
    myReady?: boolean; theirReady?: boolean;
  }) => {
    if (!trading) return;
    // 卓の中身はサーバーが持っているものが正。
    // 自分の押した結果もここで折り返してから描く(見えている卓と、
    // 成立する卓が食い違わない)。
    myOffer = m?.mine ?? {};
    theirOffer = m?.theirs ?? {};
    myReady = m?.myReady === true;
    theirReady = m?.theirReady === true;
    renderModal();
  });

  room.onMessage('trade:closed', (m: { text?: string }) => {
    const why = m?.text ?? '取引が終了した。';
    closeTable();
    setMsg(why);
    showToast(why);
  });

  room.onMessage('trade:done', (m: { give?: ElementCounts; get?: ElementCounts }) => {
    applyTrade(m?.give ?? {}, m?.get ?? {});
  });
}

// ---- 成立 ----

function applyTrade(give: ElementCounts, get: ElementCounts): void {
  const who = peerName;
  // 卓を閉じてから持ち物を動かす。notify() は素材庫を描き直すので、
  // 先に閉じておかないと消えていく卓が一瞬映る。
  closeTable();

  for (const id of ELEMENT_ORDER) {
    const out = give[id] ?? 0;
    // 卓に置ける数は手持ちが上限なので、ここで足りないのは起こらないはず。
    // それでも 0 で止める(負の数はセーブに残ると後から直せない)。
    if (out > 0) state.inventory[id] = Math.max(0, (state.inventory[id] ?? 0) - out);
    const inn = get[id] ?? 0;
    if (inn > 0) state.inventory[id] = (state.inventory[id] ?? 0) + inn;
  }
  notify();

  playSfx('discover');
  const text = `${who} との取引が成立。${describe(give)} を渡し、${describe(get)} を受け取った。`;
  setMsg(text);
  showToast(text);
}

function describe(counts: ElementCounts): string {
  const parts: string[] = [];
  for (const id of ELEMENT_ORDER) {
    const n = counts[id] ?? 0;
    if (n > 0) parts.push(`${ELEMENTS[id].emoji}${ELEMENTS[id].name}×${n}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'なし';
}

function closeTable(): void {
  trading = false;
  myOffer = {};
  theirOffer = {};
  myReady = false;
  theirReady = false;
  renderModal();
  renderPanel();
}

// ---- 操作 ----

function invite(id: string, name: string): void {
  if (trading) return;
  playSfx('click');
  waitingFor = name;
  setMsg(`${name} に取引を申し込んだ。返事を待っている…`);
  send('trade:invite', { to: id });
  renderPanel();
}

function answer(ok: boolean): void {
  playSfx(ok ? 'select' : 'unselect');
  invitedFrom = '';
  send('trade:answer', { ok });
  renderModal();
}

// 卓に出す数を変える。手持ちを超えないところで止める。
function bump(id: ElementId, delta: number): void {
  if (!trading) return;
  const have = state.inventory[id] ?? 0;
  const next = Math.max(0, Math.min(
    (myOffer[id] ?? 0) + delta, have, TRADE_MAX_PER_KIND,
  ));
  if (next === (myOffer[id] ?? 0)) return;
  playSfx(delta > 0 ? 'select' : 'unselect');
  const counts: ElementCounts = { ...myOffer };
  if (next > 0) counts[id] = next;
  else delete counts[id];
  // 見た目を先に更新しておく(返事を待つ間、押しても動かないように見えない)。
  // 正しい中身は trade:view で上書きされる。
  myOffer = counts;
  myReady = false;
  theirReady = false;
  renderModal();
  send('trade:offer', { counts });
}

function toggleReady(): void {
  if (!trading) return;
  playSfx('click');
  send('trade:ready', { ready: !myReady });
}

function quit(): void {
  playSfx('unselect');
  send('trade:leave', {});
  closeTable();
  setMsg('取引をやめた。');
}

// ---- 画面(交易所の欄) ----

// 相場の早見表と断り書き。決まりを文章だけで書くと必ず読み違えられる。
//
// 数字も種類の並びも shared/trade.ts から作る。ここに直に書くと、
// 相場を変えた時に画面だけ古いまま残る(実際に起きうる壊れ方なので、
// 見た目に出る数字はすべて RARE_VALUE から引いている)。
function renderRates(): void {
  const chip = (id: ElementId, n: number) =>
    `<span style="color:${ELEMENTS[id].cssColor}">`
    + `${ELEMENTS[id].emoji}${ELEMENTS[id].name}×${n}</span>`;
  const nameOf = (id: ElementId) =>
    `<b style="color:${ELEMENTS[id].cssColor}">${ELEMENTS[id].name}</b>`;
  const basics = BASIC_ELEMENTS.map(id => ELEMENTS[id].name).join('・');
  const rares = RARE_ELEMENTS.map(id => ELEMENTS[id].name).join('と');
  const [b1, b2] = BASIC_ELEMENTS;
  const [r1, r2] = RARE_ELEMENTS;

  $('#trade-rule').innerHTML =
    `相場は決まっている。${BASIC_ELEMENTS.map(nameOf).join('・')}`
    + `はどれも同じ価値で、${RARE_ELEMENTS.map(nameOf).join('と')}`
    + `はその<b>${RARE_VALUE}個ぶん</b>。釣り合っていない取引は成立しない。`;

  $('#trade-rates').innerHTML =
    `<div class="trade-rate">${chip(b1, 1)} ⇔ ${chip(b2, 1)}`
    + `<small>${basics}はどれも等価</small></div>`
    + `<div class="trade-rate">${chip(b1, RARE_VALUE)} ⇔ ${chip(r1, 1)}`
    + `<small>基本${BASIC_ELEMENTS.length}種と${rares}は${RARE_VALUE}対1</small></div>`
    + `<div class="trade-rate">${chip(r1, 1)} ⇔ ${chip(r2, 1)}`
    + `<small>${rares}は等価</small></div>`;
}

export function renderTradePanel(): void {
  renderPanel();
}

function renderPanel(): void {
  const box = $('#trade-partners');
  const room = lobbyRoomRef();
  box.innerHTML = '';

  if (!state.nickname) {
    box.innerHTML =
      '<span class="empty-note">取引にはニックネームが要る。'
      + '⚙設定で登録するとロビーに繋がる。</span>';
    return;
  }
  if (!room) {
    box.innerHTML = '<span class="empty-note">ロビーに接続していない。'
      + '繋がると相手が出る。</span>';
    return;
  }

  const me = myLobbyId();
  const others = lobbyMembers().filter(m => m.id !== me);
  if (others.length === 0) {
    box.innerHTML = '<span class="empty-note">今はほかに誰も居ない。'
      + '相手がロビーに入ると、ここに出る。</span>';
    return;
  }
  for (const m of others) {
    const b = document.createElement('button');
    b.className = 'trade-partner';
    b.dataset.name = m.name;   // 検証から名前で狙えるようにする
    b.textContent = m.trading ? `${m.name}(取引中)` : m.name;
    b.disabled = trading || m.trading;
    b.addEventListener('click', () => invite(m.id, m.name));
    box.appendChild(b);
  }
}

// ---- 画面(卓) ----

function renderModal(): void {
  const modal = $('#trade-modal');
  const invite$ = $('#trade-invite');
  const table$ = $('#trade-table');

  const show = trading || invitedFrom !== '';
  modal.classList.toggle('hidden', !show);
  modal.setAttribute('aria-hidden', show ? 'false' : 'true');
  invite$.classList.toggle('hidden', trading || invitedFrom === '');
  table$.classList.toggle('hidden', !trading);

  if (!trading && invitedFrom !== '') {
    $('#trade-invite-title').textContent = `${invitedFrom} が取引を申し込んでいる`;
    $('#trade-invite-note').textContent =
      '受けると取引の卓が開く。中身を決めるのはそのあとで、'
      + '断っても何も減らない。';
    return;
  }
  if (!trading) return;

  $('#trade-title').textContent = `🤝 ${peerName} との取引`;
  $('#trade-theirs-title').textContent = `${peerName} が出す`;
  renderMine();
  renderTheirs();
  renderBalance();
}

function renderMine(): void {
  const box = $('#trade-mine');
  box.innerHTML = '';
  let any = false;
  for (const id of ELEMENT_ORDER) {
    const have = state.inventory[id] ?? 0;
    const put = myOffer[id] ?? 0;
    if (have === 0 && put === 0) continue;
    any = true;

    const row = document.createElement('div');
    row.className = 'trade-row' + (put > 0 ? ' put' : '');
    row.dataset.elem = id;     // 検証から種類で狙えるようにする

    const label = document.createElement('span');
    label.className = 'trade-elem';
    label.style.color = ELEMENTS[id].cssColor;
    label.textContent = `${ELEMENTS[id].emoji}${ELEMENTS[id].name}`;
    row.appendChild(label);

    const minus = document.createElement('button');
    minus.dataset.act = 'minus';
    minus.textContent = '−';
    minus.disabled = put === 0;
    minus.addEventListener('click', () => bump(id, -1));
    row.appendChild(minus);

    const num = document.createElement('b');
    num.className = 'trade-num';
    num.textContent = String(put);
    row.appendChild(num);

    const plus = document.createElement('button');
    plus.dataset.act = 'plus';
    plus.textContent = '＋';
    plus.disabled = put >= have;
    plus.addEventListener('click', () => bump(id, 1));
    row.appendChild(plus);

    const rest = document.createElement('small');
    rest.className = 'trade-rest';
    // 「出した後に手元へ残る数」を出す。素材庫の数をそのまま出すと、
    // 何個まで置けるのかを毎回引き算することになる。
    rest.textContent = `残り${have - put}`;
    row.appendChild(rest);

    box.appendChild(row);
  }
  if (!any) {
    box.innerHTML = '<span class="empty-note">出せるエレメントが無い。</span>';
  }
}

function renderTheirs(): void {
  const box = $('#trade-theirs');
  if (isEmptyCounts(theirOffer)) {
    box.innerHTML = '<span class="empty-note">まだ何も出していない。</span>';
    return;
  }
  box.innerHTML = '';
  for (const id of ELEMENT_ORDER) {
    const n = theirOffer[id] ?? 0;
    if (n === 0) continue;
    const row = document.createElement('div');
    row.className = 'trade-row put';
    row.dataset.elem = id;
    const label = document.createElement('span');
    label.className = 'trade-elem';
    label.style.color = ELEMENTS[id].cssColor;
    label.textContent = `${ELEMENTS[id].emoji}${ELEMENTS[id].name}`;
    row.appendChild(label);
    const num = document.createElement('b');
    num.className = 'trade-num';
    num.textContent = `×${n}`;
    row.appendChild(num);
    box.appendChild(row);
  }
}

function renderBalance(): void {
  const mine = countsValue(myOffer);
  const theirs = countsValue(theirOffer);
  const bad = checkTrade(myOffer, theirOffer);
  const bar = $('#trade-balance');
  bar.className = bad ? 'ng' : 'ok';
  bar.innerHTML =
    `<span>あなた <b>${mine}</b></span>`
    + `<span class="trade-eq">${bad ? '≠' : '='}</span>`
    + `<span>${peerName} <b>${theirs}</b></span>`
    + `<small>${bad ?? '価値が釣り合っている。二人とも準備完了で成立。'}</small>`;

  const ready = $<HTMLButtonElement>('#btn-trade-ready');
  ready.disabled = bad !== null;
  ready.textContent = myReady ? '準備を取り消す' : '準備完了';
  ready.classList.toggle('primary', !myReady);

  // 手元が足りているかも見ておく。素材庫の数を上限に押しているので
  // 起こらないはずだが、ここが崩れたまま成立すると持ち物が壊れる。
  const short = !canAfford(state.inventory, myOffer);
  $('#trade-status').textContent = short
    ? '手持ちが足りない。出す数を減らそう。'
    : `${peerName}: ${theirReady ? '準備完了' : '選んでいる…'}`
      + ` / あなた: ${myReady ? '準備完了' : '選んでいる'}`;
  if (short) ready.disabled = true;
}

// ---- 組み立て ----

export function initTrade(): void {
  $('#btn-trade-yes').addEventListener('click', () => answer(true));
  $('#btn-trade-no').addEventListener('click', () => answer(false));
  $('#btn-trade-ready').addEventListener('click', toggleReady);
  $('#btn-trade-quit').addEventListener('click', quit);
  renderRates();

  // ロビーの接続が入れ替わったら手続きを繋ぎ直す。
  // 繋いだままの卓は続けられないので畳む(相手にはサーバーが伝える)。
  onLobbyUpdate(() => {
    const room = lobbyRoomRef();
    if (room !== wired) {
      wired = room;
      if (room) attach(room);
      else if (trading) {
        closeTable();
        setMsg('ロビーとの接続が切れたため、取引は中止された。');
      }
    }
    renderPanel();
  });
}

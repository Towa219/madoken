// 個人取引の卓(サーバー側)
//
// ロビーに居る二人が向かい合って交換する。掲示板ではないので、
// 相手が今そこに居ることが取引の前提になる。
//
//   誘う   → 相手に「取引しませんか」が飛ぶ(1分で失効)
//   受ける → 二人ぶんの卓ができる
//   出す   → どちらかが出し物を変えるたびに、両方の「準備完了」が外れる
//   完了   → 二人とも準備完了になった瞬間に交換が成立する
//
// 出し物を変えたら準備完了が外れるのは、承諾した後で中身をすり替える
// 手口を塞ぐため。相手が見て納得した卓と、成立する卓は必ず同じになる。
//
// 手持ちの数はサーバーでは分からない(セーブは各自の端末にある)。
// ここが受け持つのは「二人の合意」と「価値が釣り合っていること」で、
// 実際に減らす・増やすのは各自の端末が行う。
//
// Colyseus には依存させていない。送信手段を差し替えられるので、
// 部屋を立てずに検証テストから直接動かせる。

import {
  checkTrade, sanitizeCounts, TRADE_INVITE_MS,
} from '../shared/trade';
import type { ElementCounts } from '../shared/types';

export type TradeSend = (sessionId: string, type: string, payload: unknown) => void;

interface Seat {
  offer: ElementCounts;
  ready: boolean;
}

interface Table {
  seats: Map<string, Seat>;   // sessionId → 出し物
  peer: Map<string, string>;  // sessionId → 相手のsessionId
}

export class TradeTables {
  private tables = new Map<string, Table>();          // sessionId → 卓
  private invites = new Map<string, { from: string; at: number }>(); // 誘われた人 → 誘った人

  constructor(
    private send: TradeSend,
    // sessionId から表示名を引く。居なくなっていれば null。
    private nameOf: (sessionId: string) => string | null,
    private now: () => number = Date.now,
  ) {}

  isTrading(id: string): boolean {
    return this.tables.has(id);
  }

  private error(id: string, text: string): void {
    this.send(id, 'trade:error', { text });
  }

  // ---- 誘う ----

  invite(from: string, rawTo: unknown): void {
    const to = String(rawTo ?? '');
    if (!to || to === from) return;
    const toName = this.nameOf(to);
    const fromName = this.nameOf(from);
    if (!toName || !fromName) {
      this.error(from, 'その人はもうロビーに居ない。');
      return;
    }
    if (this.isTrading(from)) {
      this.error(from, 'すでに取引中。');
      return;
    }
    if (this.isTrading(to)) {
      this.error(from, `${toName} は今ほかの人と取引中。`);
      return;
    }
    // 返事待ちの誘いを追い越さない。二人から同時に誘われると、
    // どちらに返事したのか本人にも分からなくなる。
    const pending = this.invites.get(to);
    if (pending && this.now() - pending.at < TRADE_INVITE_MS) {
      this.error(from, `${toName} は今ほかの誘いに返事をしている。`);
      return;
    }
    this.invites.set(to, { from, at: this.now() });
    this.send(to, 'trade:invited', { from, name: fromName });
    this.send(from, 'trade:sent', { name: toName });
  }

  // ---- 返事 ----

  answer(me: string, ok: boolean): void {
    const inv = this.invites.get(me);
    this.invites.delete(me);
    if (!inv) {
      this.error(me, 'その誘いはもう無い。');
      return;
    }
    if (this.now() - inv.at > TRADE_INVITE_MS) {
      this.error(me, '誘いの有効時間が過ぎた。');
      return;
    }
    const fromName = this.nameOf(inv.from);
    const myName = this.nameOf(me);
    if (!fromName || !myName) {
      this.error(me, '相手がロビーから居なくなった。');
      return;
    }
    if (!ok) {
      this.send(inv.from, 'trade:declined', { name: myName });
      return;
    }
    // 返事を待っている間に、どちらかが別の取引を始めていることがある
    if (this.isTrading(me) || this.isTrading(inv.from)) {
      this.error(me, '相手は別の取引を始めてしまった。');
      this.error(inv.from, `${myName} の返事が届いたが、すでに別の取引中。`);
      return;
    }
    this.begin(inv.from, me);
  }

  private begin(a: string, b: string): void {
    const table: Table = { seats: new Map(), peer: new Map() };
    table.seats.set(a, { offer: {}, ready: false });
    table.seats.set(b, { offer: {}, ready: false });
    table.peer.set(a, b);
    table.peer.set(b, a);
    this.tables.set(a, table);
    this.tables.set(b, table);
    this.send(a, 'trade:begin', { peer: b, name: this.nameOf(b) ?? '?' });
    this.send(b, 'trade:begin', { peer: a, name: this.nameOf(a) ?? '?' });
    this.pushView(a);
  }

  // 卓の様子を二人へ配る。見えているものが必ず同じになるよう、
  // 変化のたびに両方へ送り直す。
  private pushView(anyone: string): void {
    const table = this.tables.get(anyone);
    if (!table) return;
    for (const [id, seat] of table.seats) {
      const other = table.seats.get(table.peer.get(id) ?? '');
      if (!other) continue;
      this.send(id, 'trade:view', {
        mine: seat.offer, theirs: other.offer,
        myReady: seat.ready, theirReady: other.ready,
      });
    }
  }

  // ---- 卓に出す ----

  setOffer(me: string, raw: unknown): void {
    const table = this.tables.get(me);
    const seat = table?.seats.get(me);
    if (!table || !seat) {
      this.error(me, '取引していない。');
      return;
    }
    seat.offer = sanitizeCounts(raw);
    // 中身が変わったら、二人とも準備完了をやり直す
    for (const s of table.seats.values()) s.ready = false;
    this.pushView(me);
  }

  setReady(me: string, ready: boolean): void {
    const table = this.tables.get(me);
    const seat = table?.seats.get(me);
    if (!table || !seat) {
      this.error(me, '取引していない。');
      return;
    }
    const peerId = table.peer.get(me) ?? '';
    const other = table.seats.get(peerId);
    if (!other) return;

    if (ready) {
      const bad = checkTrade(seat.offer, other.offer);
      if (bad) {
        this.error(me, bad);
        this.pushView(me);
        return;
      }
    }
    seat.ready = ready;
    if (seat.ready && other.ready) {
      this.complete(me, peerId, seat.offer, other.offer);
      return;
    }
    this.pushView(me);
  }

  private complete(
    a: string, b: string, offerA: ElementCounts, offerB: ElementCounts,
  ): void {
    // 成立の直前にもう一度確かめる。準備完了が付いたまま中身が変わる道は
    // 塞いであるが、ここを通さないと将来その道を作った時に気付けない。
    if (checkTrade(offerA, offerB)) return;
    this.close(a);
    this.send(a, 'trade:done', { give: offerA, get: offerB });
    this.send(b, 'trade:done', { give: offerB, get: offerA });
  }

  // ---- 終わり ----

  // 卓を畳む。相手には理由を伝える(黙って消えると何が起きたか分からない)。
  leave(me: string, reason: string): void {
    const table = this.tables.get(me);
    if (table) {
      const peerId = table.peer.get(me);
      this.close(me);
      if (peerId) this.send(peerId, 'trade:closed', { text: reason });
    }
    // 返事待ちの誘いも片付ける
    const inv = this.invites.get(me);
    if (inv) {
      this.invites.delete(me);
      this.send(inv.from, 'trade:declined', { name: this.nameOf(me) ?? '相手' });
    }
    for (const [to, i] of [...this.invites]) {
      if (i.from !== me) continue;
      this.invites.delete(to);
      this.send(to, 'trade:cancelInvite', {});
    }
  }

  private close(anyone: string): void {
    const table = this.tables.get(anyone);
    if (!table) return;
    for (const id of table.seats.keys()) this.tables.delete(id);
  }
}

// ロビー: 在室者リスト + チャット

// colyseus本体はCJSのためNode ESMではデフォルトimport経由、@colyseus/schemaはESMなのでnamed import
import colyseusPkg from 'colyseus';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import type { Client } from 'colyseus';
import type { IncomingMessage } from 'node:http';
import { clientIp, logConnection } from '../connlog';
import { setRoomPresence } from '../presence';
import { claimName } from '../names';
import { addLobbySink } from '../lobbyfeed';
import { TradeTables } from '../tradeTable';
import { clampNickname, nicknameKey, normalizeNickname } from '../../shared/nickname';
import { CODE_REPLACED } from '../../shared/netcodes';

const { Room } = colyseusPkg;

class LobbyPlayer extends Schema {
  declare name: string;
  declare trading: boolean;   // 個人取引の最中(誘っても断られるので一覧で分かるようにする)
}
defineTypes(LobbyPlayer, { name: 'string', trading: 'boolean' });

class LobbyState extends Schema {
  declare players: MapSchema<LobbyPlayer>;
  constructor() {
    super();
    this.players = new MapSchema<LobbyPlayer>();
  }
}
defineTypes(LobbyState, { players: { map: LobbyPlayer } });

export class LobbyChatRoom extends Room<LobbyState> {
  maxClients = 50;

  private unsubFeed?: () => void;

  // 個人取引の卓。ロビーに居る二人が向かい合って交換する。
  // 送信手段だけを渡し、卓の決まりごとは server/tradeTable.ts に置いてある。
  private trades = new TradeTables(
    (sessionId, type, payload) => {
      const target = this.clients.find(c => c.sessionId === sessionId);
      try { target?.send(type, payload); } catch { /* 既に閉じている */ }
      this.syncTradingFlags();
    },
    sessionId => this.state.players.get(sessionId)?.name ?? null,
  );

  // 在室者リストの「取引中」を実際の卓に合わせる
  private syncTradingFlags(): void {
    this.state.players.forEach((p, id) => {
      const now = this.trades.isTrading(id);
      if (p.trading !== now) p.trading = now;
    });
  }

  onCreate(): void {
    this.autoDispose = false; // 誰もいなくてもロビーは維持
    this.setState(new LobbyState());

    // 共闘部屋の作成や決闘の募集をロビーへ流す。
    //
    // ★ ロビーの席は、共闘や決闘に入っても抜けない(戦っている間も繋がったまま)。
    //   つまりここへ流せば、いまオンラインの全員に届く。
    //   種類の付いたものは 'notice' でも送り、受け取った側が
    //   チャット欄の外(呼び出しの札)に出せるようにする。
    this.unsubFeed = addLobbySink((text, kind) => {
      this.broadcast('chat', { name: 'お知らせ', text });
      if (kind) this.broadcast('notice', { kind, text });
    });

    this.onMessage('chat', (client: Client, text: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof text !== 'string') return;
      const clean = text.trim().slice(0, 200);
      if (!clean) return;
      this.broadcast('chat', { name: p.name, text: clean });
    });

    // ---- 個人取引 ----
    this.onMessage('trade:invite', (client: Client, msg: { to?: unknown }) => {
      this.trades.invite(client.sessionId, msg?.to);
    });
    this.onMessage('trade:answer', (client: Client, msg: { ok?: unknown }) => {
      this.trades.answer(client.sessionId, msg?.ok === true);
    });
    this.onMessage('trade:offer', (client: Client, msg: { counts?: unknown }) => {
      this.trades.setOffer(client.sessionId, msg?.counts);
    });
    this.onMessage('trade:ready', (client: Client, msg: { ready?: unknown }) => {
      this.trades.setReady(client.sessionId, msg?.ready === true);
    });
    this.onMessage('trade:leave', (client: Client) => {
      this.trades.leave(client.sessionId, '相手が取引をやめた。');
      this.syncTradingFlags();
    });
  }

  // ニックネームの重複を確認しつつ、接続元IPを控えて接続ログに使う
  async onAuth(
    _client: Client,
    options: { name?: unknown; nickToken?: unknown },
    request?: IncomingMessage,
  ): Promise<{ ip: string; name: string }> {
    const name = normalizeNickname(options?.name);
    const r = await claimName(name, options?.nickToken);
    if (!r.ok) throw new Error(r.error ?? 'そのニックネームは使用できません');
    return { ip: clientIp(request), name };
  }

  // 同じ名前の古い接続を閉じる。
  //
  // 通信が切れても、サーバーが切断に気づくまでには間がある(スリープや電波断だと
  // 特に長い)。その間に自動再接続すると、同じ人が在室者リストに2件並んでしまう。
  // ニックネームは1人1つなので、名前が同じ = 同じ人とみなして古い方を閉じる。
  private dropOlderSessions(name: string, keep: Client): void {
    const key = nicknameKey(name);
    for (const other of [...this.clients]) {
      if (other.sessionId === keep.sessionId) continue;
      const p = this.state.players.get(other.sessionId);
      if (!p || nicknameKey(p.name) !== key) continue;
      this.replaced.add(other.sessionId); // 「退出した」とは知らせない
      // 取引の途中なら相手に伝えて畳む。名前を引ける間に呼ぶ。
      this.trades.leave(other.sessionId, '相手の接続が入れ替わったため中止した。');
      this.state.players.delete(other.sessionId);
      // 切断コードはRenderのプロキシ越しだとクライアントに届かないことがあるため、
      // 理由はメッセージで明示的に伝えてから閉じる。
      // (届かないと相手が自動再接続し、2つの接続が互いを閉じ合い続ける)
      try { other.send('replaced', {}); } catch { /* 既に閉じている */ }
      setTimeout(() => {
        try { other.leave(CODE_REPLACED); } catch { /* 既に閉じている */ }
      }, 150);
    }
  }

  private replaced = new Set<string>();

  onJoin(client: Client, options: { name?: unknown }): void {
    const auth = client.auth as { name?: string } | undefined;
    const p = new LobbyPlayer();
    p.name = clampNickname(auth?.name || options?.name) || '名無し';
    p.trading = false;
    this.dropOlderSessions(p.name, client);
    this.state.players.set(client.sessionId, p);
    logConnection('ロビー', p.name, (client.auth as { ip?: string } | undefined)?.ip ?? '');
    this.syncPresence();
    this.broadcast('chat', { name: 'システム', text: `${p.name} がロビーに入った` });
  }

  onLeave(client: Client): void {
    // 入り直しで閉じた古い接続は、退出として扱わない(入退出が二重に流れる)
    if (this.replaced.delete(client.sessionId)) {
      this.syncPresence();
      return;
    }
    // 取引中に居なくなったら相手に伝えて畳む。
    // 名前を使うので、在室者リストから消す前に呼ぶ。
    this.trades.leave(client.sessionId, '相手がロビーから居なくなった。');
    const p = this.state.players.get(client.sessionId);
    if (p) {
      this.broadcast('chat', { name: 'システム', text: `${p.name} が退出した` });
    }
    this.state.players.delete(client.sessionId);
    this.syncTradingFlags();
    this.syncPresence();
  }

  onDispose(): void {
    this.unsubFeed?.();
  }

  private syncPresence(): void {
    const names: string[] = [];
    this.state.players.forEach(p => names.push(p.name));
    setRoomPresence(this.roomId, 'ロビー', '', names);
  }
}

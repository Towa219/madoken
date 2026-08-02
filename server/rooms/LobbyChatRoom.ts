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
import { clampNickname, nicknameKey, normalizeNickname } from '../../shared/nickname';
import { CODE_REPLACED } from '../../shared/netcodes';

const { Room } = colyseusPkg;

class LobbyPlayer extends Schema {
  declare name: string;
}
defineTypes(LobbyPlayer, { name: 'string' });

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

  onCreate(): void {
    this.autoDispose = false; // 誰もいなくてもロビーは維持
    this.setState(new LobbyState());

    // 共闘部屋の作成や決闘の募集をロビーへ流す
    this.unsubFeed = addLobbySink(text => {
      this.broadcast('chat', { name: 'お知らせ', text });
    });

    this.onMessage('chat', (client: Client, text: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof text !== 'string') return;
      const clean = text.trim().slice(0, 200);
      if (!clean) return;
      this.broadcast('chat', { name: p.name, text: clean });
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
      this.state.players.delete(other.sessionId);
      other.leave(CODE_REPLACED);
    }
  }

  private replaced = new Set<string>();

  onJoin(client: Client, options: { name?: unknown }): void {
    const auth = client.auth as { name?: string } | undefined;
    const p = new LobbyPlayer();
    p.name = clampNickname(auth?.name || options?.name) || '名無し';
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
    const p = this.state.players.get(client.sessionId);
    if (p) {
      this.broadcast('chat', { name: 'システム', text: `${p.name} が退出した` });
    }
    this.state.players.delete(client.sessionId);
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

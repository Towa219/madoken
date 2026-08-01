// ロビー: 在室者リスト + チャット

// colyseus本体はCJSのためNode ESMではデフォルトimport経由、@colyseus/schemaはESMなのでnamed import
import colyseusPkg from 'colyseus';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import type { Client } from 'colyseus';
import type { IncomingMessage } from 'node:http';
import { clientIp, logConnection } from '../connlog';

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

  onCreate(): void {
    this.autoDispose = false; // 誰もいなくてもロビーは維持
    this.setState(new LobbyState());

    this.onMessage('chat', (client: Client, text: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof text !== 'string') return;
      const clean = text.trim().slice(0, 200);
      if (!clean) return;
      this.broadcast('chat', { name: p.name, text: clean });
    });
  }

  // 接続元IPを控えて接続ログに使う
  onAuth(_client: Client, _options: unknown, request?: IncomingMessage): { ip: string } {
    return { ip: clientIp(request) };
  }

  onJoin(client: Client, options: { name?: unknown }): void {
    const p = new LobbyPlayer();
    p.name = String(options?.name ?? '名無し').slice(0, 12) || '名無し';
    this.state.players.set(client.sessionId, p);
    logConnection('ロビー', p.name, (client.auth as { ip?: string } | undefined)?.ip ?? '');
    this.broadcast('chat', { name: 'システム', text: `${p.name} がロビーに入った` });
  }

  onLeave(client: Client): void {
    const p = this.state.players.get(client.sessionId);
    if (p) {
      this.broadcast('chat', { name: 'システム', text: `${p.name} が退出した` });
    }
    this.state.players.delete(client.sessionId);
  }
}

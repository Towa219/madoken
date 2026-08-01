// PvP: 1対1の決闘ルーム(サーバー権威)
//
// 互いに詠唱して相手を攻撃する。護盾・治癒は自分に効き、
// 挑発は決闘では「次に受けるダメージを20%軽減」に読み替える。

import colyseusPkg from 'colyseus';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import type { Client } from 'colyseus';
import type { MapSchema as MapSchemaType } from '@colyseus/schema';
import type { IncomingMessage } from 'node:http';
import { DUEL_MAX_HP, DUEL_MAX_MP } from '../../shared/data';
import { spellCooldown } from '../../shared/spellcraft';
import { parseSpells } from '../spellPayload';
import { clientIp, logConnection } from '../connlog';
import { clearRoomPresence, setRoomPresence } from '../presence';
import { claimName } from '../names';
import { announce } from '../lobbyfeed';
import { clampNickname } from '../../shared/nickname';
import type { ServerSpell } from '../spellPayload';
import type { ElementId, SpellStats } from '../../shared/types';

const { Room } = colyseusPkg;

export const DUEL_XS = [140, 820]; // 左が slot0、右が slot1

class DuelPlayer extends Schema {
  declare name: string;
  declare hp: number;
  declare maxHp: number;
  declare mp: number;
  declare maxMp: number;
  declare shield: number;
  declare guard: number;      // 軽減率(%)
  declare alive: boolean;
  declare ready: boolean;
  declare slot: number;
  declare castingIdx: number;
  declare castName: string;   // 詠唱中の魔法名(相手にも見える)
  declare wardPct: number;    // 属性耐性(%)。0=なし
  declare atkBoost: number;   // 与ダメージ上昇(%)。0=なし
  declare vigorBonus: number; // 最大HP上昇。0=なし
  declare sealed: boolean;    // 封印されているか
  declare castT: number;
  declare castTotal: number;
}
defineTypes(DuelPlayer, {
  name: 'string', hp: 'number', maxHp: 'number', mp: 'number', maxMp: 'number',
  shield: 'number', guard: 'number', alive: 'boolean', ready: 'boolean',
  slot: 'number', castingIdx: 'number', castT: 'number', castTotal: 'number',
  castName: 'string', wardPct: 'number', atkBoost: 'number',
  vigorBonus: 'number', sealed: 'boolean',
});

class DuelState extends Schema {
  declare phase: string;   // ready | count | fight | done
  declare countdown: number;
  declare winner: string;  // 勝者のsessionId(引き分けは空)
  declare players: MapSchemaType<DuelPlayer>;
  constructor() {
    super();
    this.phase = 'ready';
    this.countdown = 0;
    this.winner = '';
    this.players = new MapSchema<DuelPlayer>();
  }
}
defineTypes(DuelState, {
  phase: 'string', countdown: 'number', winner: 'string',
  players: { map: DuelPlayer },
});

interface DInternal {
  spells: ServerSpell[];
  cooldowns: number[];
  shieldT: number;
  guardT: number;
  wardAttr: ElementId | null;
  wardPct: number;
  wardT: number;
  atkBoost: number;
  atkBoostT: number;
  vigorBonus: number;
  vigorT: number;
  sealedT: number;   // 封印されている残り秒(詠唱不可)
  dotDps: number;
  dotT: number;
  dotTick: number;
}

export class DuelRoom extends Room<DuelState> {
  maxClients = 2;

  private internals = new Map<string, DInternal>();
  private pending: { t: number; fn: () => void }[] = [];
  private ended = false;

  onCreate(): void {
    this.setState(new DuelState());
    this.setMetadata({ mode: 'duel' });

    this.onMessage('ready', (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (p && this.state.phase === 'ready') {
        p.ready = true;
        this.checkStart();
      }
    });

    this.onMessage('cast', (client: Client, msg: { idx?: unknown }) => {
      this.tryCast(client.sessionId, Math.floor(Number(msg?.idx)));
    });

    this.setSimulationInterval(dtMs => this.update(dtMs / 1000), 50);
  }

  // ニックネームの所有を確認しつつ、接続元IPを控えて接続ログに使う
  async onAuth(
    _client: Client,
    options: { name?: unknown; nickToken?: unknown },
    request?: IncomingMessage,
  ): Promise<{ ip: string }> {
    const r = await claimName(options?.name, options?.nickToken);
    if (!r.ok) throw new Error(r.error ?? 'そのニックネームは使用できません');
    return { ip: clientIp(request) };
  }

  onJoin(client: Client, options: { name?: unknown; spells?: unknown }): void {
    const p = new DuelPlayer();
    p.name = clampNickname(options?.name) || '名無し';
    p.maxHp = DUEL_MAX_HP; p.hp = DUEL_MAX_HP;   // 決闘は長めの読み合いにする
    p.maxMp = DUEL_MAX_MP; p.mp = DUEL_MAX_MP;
    p.shield = 0; p.guard = 0;
    p.alive = true; p.ready = false;
    p.castingIdx = -1; p.castT = 0; p.castTotal = 0; p.castName = '';
    p.wardPct = 0; p.atkBoost = 0; p.vigorBonus = 0; p.sealed = false;

    const used = new Set<number>();
    this.state.players.forEach(q => used.add(q.slot));
    p.slot = used.has(0) ? 1 : 0;

    this.state.players.set(client.sessionId, p);
    logConnection('決闘', p.name, (client.auth as { ip?: string } | undefined)?.ip ?? '');
    this.syncPresence();

    // ロビーへ募集を知らせる
    if (this.state.players.size === 1) {
      announce(`⚔ ${p.name} が決闘を求めている。相手を募集中!`);
    } else {
      const names: string[] = [];
      this.state.players.forEach(q => names.push(q.name));
      announce(`⚔ 決闘成立: ${names.join(' vs ')}`);
    }
    this.internals.set(client.sessionId, {
      spells: parseSpells(options?.spells),
      cooldowns: [0, 0, 0, 0],
      shieldT: 0, guardT: 0,
      wardAttr: null, wardPct: 0, wardT: 0,
      atkBoost: 0, atkBoostT: 0, vigorBonus: 0, vigorT: 0,
      sealedT: 0, dotDps: 0, dotT: 0, dotTick: 0,
    });
  }

  onLeave(client: Client): void {
    const leaver = this.state.players.get(client.sessionId);
    const name = leaver?.name ?? '相手';
    this.state.players.delete(client.sessionId);
    this.internals.delete(client.sessionId);
    this.syncPresence();

    if (this.state.phase === 'ready') return;
    if (this.ended) return;
    // 対戦中の離脱は残った側の勝ち
    this.ended = true;
    this.state.phase = 'done';
    for (const c of this.clients) {
      this.state.winner = c.sessionId;
      c.send('duelend', { win: true, reason: `${name} が退出した` });
    }
    setTimeout(() => { void this.disconnect(); }, 800);
  }

  private syncPresence(): void {
    const names: string[] = [];
    this.state.players.forEach(p => names.push(p.name));
    setRoomPresence(this.roomId, '決闘', '', names);
  }

  onDispose(): void {
    clearRoomPresence(this.roomId);
  }

  private checkStart(): void {
    if (this.state.phase !== 'ready') return;
    if (this.state.players.size < 2) return;
    let allReady = true;
    this.state.players.forEach(p => { if (!p.ready) allReady = false; });
    if (!allReady) return;
    this.lock();
    this.state.phase = 'count';
    this.state.countdown = 3.6;
  }

  private tryCast(sid: string, idx: number): void {
    if (this.state.phase !== 'fight') return;
    const p = this.state.players.get(sid);
    const internal = this.internals.get(sid);
    if (!p || !internal || !p.alive) return;
    const sp = internal.spells[idx];
    if (!sp) return;
    if (p.castingIdx >= 0) return;
    if (internal.sealedT > 0) return; // 封印中は詠唱できない
    if (internal.cooldowns[idx] > 0) return;
    if (p.mp < sp.stats.manaCost) return;
    p.mp -= sp.stats.manaCost;
    p.castingIdx = idx;
    p.castName = sp.name;
    p.castT = 0;
    p.castTotal = sp.stats.castTime;
  }

  private opponentOf(sid: string): { sid: string; p: DuelPlayer } | null {
    let out: { sid: string; p: DuelPlayer } | null = null;
    this.state.players.forEach((q, qsid) => {
      if (qsid !== sid) out = { sid: qsid, p: q };
    });
    return out;
  }

  private update(dt: number): void {
    this.pending = this.pending.filter(ev => {
      ev.t -= dt;
      if (ev.t <= 0) { ev.fn(); return false; }
      return true;
    });

    if (this.state.phase === 'count') {
      this.state.countdown = Math.max(0, this.state.countdown - dt);
      if (this.state.countdown <= 0) this.state.phase = 'fight';
      return;
    }
    if (this.state.phase !== 'fight') return;

    this.state.players.forEach((p, sid) => {
      const internal = this.internals.get(sid);
      if (!internal || !p.alive) return;
      p.mp = Math.min(p.maxMp, p.mp + 4 * dt);
      for (let i = 0; i < internal.cooldowns.length; i++) {
        internal.cooldowns[i] = Math.max(0, internal.cooldowns[i] - dt);
      }
      if (internal.shieldT > 0) {
        internal.shieldT -= dt;
        if (internal.shieldT <= 0) p.shield = 0;
      }
      if (internal.guardT > 0) {
        internal.guardT -= dt;
        if (internal.guardT <= 0) p.guard = 0;
      }
      if (internal.wardT > 0) {
        internal.wardT -= dt;
        if (internal.wardT <= 0) internal.wardPct = 0;
      }
      if (internal.atkBoostT > 0) {
        internal.atkBoostT -= dt;
        if (internal.atkBoostT <= 0) internal.atkBoost = 0;
      }
      if (internal.vigorT > 0) {
        internal.vigorT -= dt;
        if (internal.vigorT <= 0) {
          p.maxHp -= internal.vigorBonus;
          internal.vigorBonus = 0;
          p.hp = Math.max(1, Math.min(p.hp, p.maxHp));
        }
      }
      if (internal.sealedT > 0) {
        internal.sealedT -= dt;
        if (internal.sealedT > 0) { p.castingIdx = -1; p.castName = ''; }
      }
      // かかっている効果を相手にも見せる
      p.wardPct = internal.wardT > 0 ? Math.round(internal.wardPct) : 0;
      p.atkBoost = internal.atkBoostT > 0 ? Math.round(internal.atkBoost) : 0;
      p.vigorBonus = internal.vigorT > 0 ? Math.round(internal.vigorBonus) : 0;
      p.sealed = internal.sealedT > 0;
      // 継続ダメージ(1秒ごと)
      if (internal.dotT > 0) {
        internal.dotT -= dt;
        internal.dotTick += dt;
        if (internal.dotTick >= 1) {
          internal.dotTick -= 1;
          const d = Math.max(1, Math.round(internal.dotDps));
          this.broadcast('ddot', { sid, amount: d });
          this.damage(sid, d, true); // 継続分は護盾・軽減を通さない
        }
        if (internal.dotT <= 0) internal.dotDps = 0;
      }
      if (p.castingIdx >= 0) {
        p.castT += dt;
        const sp = internal.spells[p.castingIdx];
        if (sp && p.castT >= sp.stats.castTime) {
          const idx = p.castingIdx;
          p.castingIdx = -1;
          p.castName = '';
          p.castT = 0;
          internal.cooldowns[idx] = spellCooldown(sp.stats);
          this.resolveCast(sid, p, sp.stats);
        }
      }
    });

    if (!this.ended) {
      const dead: string[] = [];
      this.state.players.forEach((p, sid) => { if (!p.alive) dead.push(sid); });
      if (dead.length > 0) this.endDuel();
    }
  }

  private resolveCast(sid: string, p: DuelPlayer, st: SpellStats): void {
    const internal = this.internals.get(sid);
    if (!internal) return;

    if (st.selfDamage > 0) this.damage(sid, st.selfDamage, true);

    if (st.kind === 'shield') {
      p.shield = Math.max(p.shield, st.barrier);
      internal.shieldT = 10;
      this.broadcast('dshield', { sid, amount: st.barrier });
      return;
    }
    if (st.kind === 'heal') {
      p.hp = Math.min(p.maxHp, p.hp + st.healPower);
      this.broadcast('dheal', { sid, amount: st.healPower });
      return;
    }
    if (st.kind === 'taunt') {
      // 決闘では「構え」= 6秒間ダメージ20%軽減
      p.guard = 20;
      internal.guardT = 6;
      this.broadcast('dguard', { sid });
      return;
    }
    if (st.kind === 'seal') {
      const foe0 = this.opponentOf(sid);
      if (foe0) {
        const fi = this.internals.get(foe0.sid);
        if (fi) {
          fi.sealedT = Math.max(fi.sealedT, st.sealTime * 0.6); // 対人では短め
          foe0.p.castingIdx = -1;
          foe0.p.castName = '';
          this.broadcast('dseal', { sid: foe0.sid, sec: fi.sealedT });
        }
      }
      return;
    }
    if (st.kind === 'empower') {
      internal.atkBoost = st.atkBoost;
      internal.atkBoostT = 20;
      this.broadcast('dempower', { sid, pct: st.atkBoost });
      return;
    }
    if (st.kind === 'vigor') {
      p.maxHp -= internal.vigorBonus;
      p.hp = Math.min(p.hp, p.maxHp);
      internal.vigorBonus = st.hpBoost;
      internal.vigorT = 25;
      p.maxHp += internal.vigorBonus;
      p.hp += internal.vigorBonus;
      this.broadcast('dvigor', { sid, amount: st.hpBoost });
      return;
    }
    if (st.kind === 'ward') {
      internal.wardAttr = st.targetAll ? null : st.attr;
      internal.wardPct = st.wardPct;
      internal.wardT = 12;
      this.broadcast('dward', {
        sid, pct: st.wardPct, attr: st.targetAll ? '' : st.attr,
      });
      return;
    }

    const foe = this.opponentOf(sid);
    if (!foe || !foe.p.alive) return;

    const fromX = DUEL_XS[p.slot] + (p.slot === 0 ? 34 : -34);
    const toX = DUEL_XS[foe.p.slot];
    const delayMs = Math.max(80, (Math.abs(toX - fromX) / st.projSpeed) * 1000);
    this.broadcast('dproj', {
      sid, x0: fromX, targetX: toX, attr: st.attr, power: st.power, delayMs,
    });
    this.pending.push({
      t: delayMs / 1000,
      fn: () => this.applyHit(sid, foe.sid, st),
    });
  }

  private applyHit(fromSid: string, toSid: string, st: SpellStats): void {
    if (this.state.phase !== 'fight') return;
    const target = this.state.players.get(toSid);
    if (!target || !target.alive) return;

    const atkI = this.internals.get(fromSid);
    const boost = 1 + (atkI?.atkBoost ?? 0) / 100;
    let dmg = st.power * (0.9 + Math.random() * 0.2) * boost;
    const crit = Math.random() * 100 < st.critRate;
    if (crit) dmg *= 2;
    if (st.quake) dmg *= 0.75;      // 全体攻撃は対人では威力控えめ
    const final = Math.max(1, Math.round(dmg));

    // 継続ダメージを付与(上書き)
    if (st.dotTime > 0 && st.dotDps > 0) {
      const ti = this.internals.get(toSid);
      if (ti) {
        ti.dotDps = st.dotDps * boost;
        ti.dotT = st.dotTime;
        ti.dotTick = 0;
      }
    }

    this.broadcast('dhit', {
      sid: toSid, amount: final, crit, attr: st.attr, radius: st.radius,
    });
    this.damage(toSid, final, false, st.attr);

    if (st.lifesteal > 0) {
      const healer = this.state.players.get(fromSid);
      if (healer?.alive) {
        const heal = Math.round(final * st.lifesteal / 100);
        if (heal > 0) {
          healer.hp = Math.min(healer.maxHp, healer.hp + heal);
          this.broadcast('dheal', { sid: fromSid, amount: heal });
        }
      }
    }
  }

  private damage(sid: string, raw: number, self: boolean, attr?: ElementId): void {
    const p = this.state.players.get(sid);
    if (!p || !p.alive) return;
    let dmg = raw;
    const wi = this.internals.get(sid);
    if (!self && wi && wi.wardPct > 0 && (wi.wardAttr === null || wi.wardAttr === attr)) {
      const before = dmg;
      dmg = Math.max(1, Math.round(dmg * (1 - wi.wardPct / 100)));
      if (before > dmg) this.broadcast('dwardhit', { sid, amount: before - dmg });
    }
    if (!self && p.guard > 0) dmg = Math.max(1, Math.round(dmg * (1 - p.guard / 100)));
    if (!self && p.shield > 0) {
      const absorbed = Math.min(p.shield, dmg);
      p.shield -= absorbed;
      dmg -= absorbed;
      this.broadcast('dshieldhit', { sid, amount: absorbed });
      if (dmg <= 0) return;
    }
    p.hp = Math.max(0, p.hp - dmg);
    if (p.hp <= 0) {
      p.alive = false;
      p.castingIdx = -1;
      p.castName = '';
    }
  }

  private endDuel(): void {
    if (this.ended) return;
    this.ended = true;
    this.state.phase = 'done';
    this.pending = [];

    let winnerSid = '';
    this.state.players.forEach((p, sid) => { if (p.alive) winnerSid = sid; });
    this.state.winner = winnerSid;

    // 結果をロビーへ
    const win = this.state.players.get(winnerSid)?.name;
    const names: string[] = [];
    this.state.players.forEach(p => names.push(p.name));
    announce(win
      ? `🏆 決闘の決着: ${win} の勝利 (${names.join(' vs ')})`
      : `🤝 決闘は引き分け (${names.join(' vs ')})`);

    for (const client of this.clients) {
      client.send('duelend', {
        win: client.sessionId === winnerSid,
        reason: '',
      });
    }
  }
}

export type { ElementId };

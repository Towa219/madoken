// 共闘バトルルーム(最大3人・サーバー権威シミュレーション)
//
// 魔法はクライアントからレシピ(エレメント構成)だけを受け取り、
// 性能はサーバー側で computeSpell により再計算する(ステータス改竄対策)。

// colyseus本体はCJSのためNode ESMではデフォルトimport経由、@colyseus/schemaはESMなのでnamed import
import colyseusPkg from 'colyseus';
import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';
import type { Client } from 'colyseus';

const { Room } = colyseusPkg;
import { finalStats, sealResistMul, spellCooldown } from '../../shared/spellcraft';
import type { IncomingMessage } from 'node:http';
import { parseSpells } from '../spellPayload';
import { clientIp, logConnection } from '../connlog';
import { clearRoomPresence, setRoomPresence } from '../presence';
import { submitScore } from '../ranking';
import { claimName } from '../names';
import { announce } from '../lobbyfeed';
import { claimBattleSlot, releaseBattleSlot } from '../activeBattle';
import { CODE_REPLACED } from '../../shared/netcodes';
import { clampNickname } from '../../shared/nickname';
import { clampCharId } from '../../shared/characters';
import {
  affinityMul, battleRP, bossForStage, ENEMY_ATK_MUL, ENEMY_HP_MUL, isBossStage,
  pickEnemiesForStage, PLAYER_MAX_HP, PLAYER_MAX_MP, PLAYER_MP_REGEN,
  stageAtkMul, stageHpMul,
} from '../../shared/data';
import type { AffinityGrade, EnemyDef } from '../../shared/data';
import type { ElementCounts, ElementId, SpellStats } from '../../shared/types';

export const PLAYER_XS = [110, 165, 220];

// ---- 同期ステート ----

class PlayerS extends Schema {
  declare name: string;
  declare hp: number;
  declare maxHp: number;
  declare mp: number;
  declare maxMp: number;
  declare shield: number;
  declare hate: number;
  declare alive: boolean;
  declare ready: boolean;
  declare slot: number;
  declare charId: number;     // 選んだキャラクター(見た目だけ)
  declare castingIdx: number; // -1=非詠唱
  declare castName: string;   // 詠唱中の魔法名(全員に見える)
  declare wardPct: number;    // 属性耐性(%)。0=なし
  declare atkBoost: number;   // 与ダメージ上昇(%)。0=なし
  declare vigorBonus: number; // 最大HP上昇。0=なし
  declare mpRegenBonus: number; // MP自然回復の上乗せ(毎秒)。0=なし
  declare castT: number;
  declare castTotal: number;
}
defineTypes(PlayerS, {
  name: 'string', hp: 'number', maxHp: 'number', mp: 'number', maxMp: 'number',
  shield: 'number', hate: 'number', alive: 'boolean', ready: 'boolean', slot: 'number',
  charId: 'number',
  castingIdx: 'number', castT: 'number', castTotal: 'number', castName: 'string',
  wardPct: 'number', atkBoost: 'number', vigorBonus: 'number',
  mpRegenBonus: 'number',
});

class EnemyS extends Schema {
  declare defId: string;
  declare name: string;
  declare hp: number;
  declare maxHp: number;
  declare alive: boolean;
  declare x: number;
  declare frozen: boolean;
  declare sealed: boolean;   // 封印(行動不能)
  declare slowed: boolean;   // 鈍化
  declare burning: boolean;  // 継続ダメージ中
}
defineTypes(EnemyS, {
  defId: 'string', name: 'string', hp: 'number', maxHp: 'number',
  alive: 'boolean', x: 'number', frozen: 'boolean',
  sealed: 'boolean', slowed: 'boolean', burning: 'boolean',
});

class CoopState extends Schema {
  declare phase: string; // ready | fight | done
  declare stage: number;
  declare players: MapSchema<PlayerS>;
  declare enemies: ArraySchema<EnemyS>;
  constructor() {
    super();
    this.phase = 'ready';
    this.stage = 1;
    this.players = new MapSchema<PlayerS>();
    this.enemies = new ArraySchema<EnemyS>();
  }
}
defineTypes(CoopState, {
  phase: 'string', stage: 'number',
  players: { map: PlayerS }, enemies: [EnemyS],
});

// ---- 内部状態(同期しない) ----

interface PInternal {
  spells: { name: string; stats: SpellStats }[];
  cooldowns: number[];
  shieldT: number;
  hate: number;      // ヘイト(敵対心)。与ダメ/護盾/回復/挑発で増加、毎秒5%減衰
  wardAttr: ElementId | null; // 耐性の対象属性(nullなら全属性)
  wardPct: number;
  wardT: number;
  atkBoost: number;   // 与ダメージ上昇(%)
  atkBoostT: number;
  vigorBonus: number; // 最大HP上昇
  vigorT: number;
  mpRegenBonus: number; // MP自然回復の上乗せ(毎秒)
  mpRegenT: number;
  score: number;     // 戦闘スコア(クリアステージ×10+与ダメ/20)
  submitted: boolean; // ランキング送信済みか(二重送信防止)
}

interface EInternal {
  def: EnemyDef;
  atkTimer: number;
  frozenT: number;
  slowPct: number;
  slowT: number;
  dotDps: number;   // 継続ダメージ
  dotT: number;
  dotTick: number;
  dotOwner: string; // 継続ダメージの所有者(スコア加算用)
  sealedT: number;  // 封印の残り
}

export class CoopRoom extends Room<CoopState> {
  maxClients = 3;

  private internals = new Map<string, PInternal>();
  private eInternals: EInternal[] = [];
  private pending: { t: number; fn: () => void }[] = [];
  private ended = false;
  private aborting = false;

  onCreate(options: { stage?: unknown }): void {
    this.setState(new CoopState());
    this.state.stage = Math.max(1, Math.min(99, Math.floor(Number(options?.stage) || 1)));
    this.setMetadata({ stage: this.state.stage });

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

  onJoin(
    client: Client,
    options: { name?: unknown; spells?: unknown; charId?: unknown },
  ): void {
    const p = new PlayerS();
    p.name = clampNickname(options?.name) || '名無し';
    p.charId = clampCharId(options?.charId);
    p.maxHp = PLAYER_MAX_HP; p.hp = PLAYER_MAX_HP;
    p.maxMp = PLAYER_MAX_MP; p.mp = PLAYER_MAX_MP;
    p.shield = 0;
    p.hate = 0;
    p.alive = true; p.ready = false;
    p.castingIdx = -1; p.castT = 0; p.castTotal = 0; p.castName = '';
    p.wardPct = 0; p.atkBoost = 0; p.vigorBonus = 0; p.mpRegenBonus = 0;

    const used = new Set<number>();
    this.state.players.forEach(q => used.add(q.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    p.slot = Math.min(slot, PLAYER_XS.length - 1);

    this.state.players.set(client.sessionId, p);
    logConnection(
      `共闘(ステージ${this.state.stage})`, p.name,
      (client.auth as { ip?: string } | undefined)?.ip ?? '',
    );

    // 同じ人が別の戦闘部屋にいたら、そちらを閉じる(部屋の乱立を防ぐ)
    claimBattleSlot(p.name, client.sessionId, () => {
      // 同じ人が別の部屋を作った/入った場合は、こちらの接続を閉じる。
      // 残しておくと空の部屋が生き続け、一覧に自分の部屋が並んでしまう。
      try { client.send('replaced', {}); } catch { /* 既に閉じている */ }
      setTimeout(() => {
        try { client.leave(CODE_REPLACED); } catch { /* 既に閉じている */ }
      }, 150);
    });

    this.syncPresence();

    // 最初の1人 = 部屋を立てた人。ロビーに募集を知らせる
    if (this.state.players.size === 1 && this.state.phase === 'ready') {
      const boss = isBossStage(this.state.stage);
      announce(
        `⚔ ${p.name} がステージ${this.state.stage}`
        + `${boss ? 'の👑ボス戦' : ''}の共闘部屋を作った。参加者を募集中!`
        + `${boss ? '(仲間がいると有利)' : ''}`,
      );
    } else if (this.state.phase === 'ready') {
      announce(
        `👥 ステージ${this.state.stage}の部屋に ${p.name} が参加`
        + `(現在${this.state.players.size}人)`,
      );
    }

    // 魔法: レシピからサーバー側で再計算
    const spells = parseSpells(options?.spells);
    this.internals.set(client.sessionId, {
      spells, cooldowns: [0, 0, 0, 0], shieldT: 0, hate: 0,
      wardAttr: null, wardPct: 0, wardT: 0,
      atkBoost: 0, atkBoostT: 0, vigorBonus: 0, vigorT: 0,
      mpRegenBonus: 0, mpRegenT: 0,
      score: 0, submitted: false,
    });
  }

  // 到達済みステージのみ参加可(クライアント申告の maxStage を検証)
  // 合わせてニックネームの所有も確認する(他人の名前では入れない)
  async onAuth(
    _client: Client,
    options: { maxStage?: unknown; name?: unknown; nickToken?: unknown },
    request?: IncomingMessage,
  ): Promise<{ ip: string }> {
    const myMax = Math.max(1, Math.floor(Number(options?.maxStage) || 1));
    if (this.state.stage > myMax) {
      throw new Error(`ステージ${this.state.stage}にはまだ到達していない`);
    }
    const r = await claimName(options?.name, options?.nickToken);
    if (!r.ok) throw new Error(r.error ?? 'そのニックネームは使用できません');
    return { ip: clientIp(request) };
  }

  onLeave(client: Client): void {
    const leaverName = this.state.players.get(client.sessionId)?.name ?? '誰か';
    releaseBattleSlot(leaverName, client.sessionId);
    this.submitToRanking(client.sessionId); // 途中離脱でもスコアは記録
    this.state.players.delete(client.sessionId);
    this.internals.delete(client.sessionId);
    this.syncPresence();

    if (this.state.phase === 'ready') {
      this.checkStart();
      return;
    }
    // 戦闘中の離脱: 前ステージまでのクリア扱いで全員ロビーへ
    this.abortRun(leaverName);
  }

  private abortRun(leaverName: string): void {
    if (this.aborting || this.ended) return;
    this.aborting = true;
    this.ended = true;
    this.state.phase = 'done';
    this.pending = [];
    const clearedStage = this.state.stage - 1;
    for (const client of this.clients) {
      this.submitToRanking(client.sessionId);
      client.send('aborted', { name: leaverName, clearedStage });
    }
    // メッセージ到達を待ってから全員切断
    setTimeout(() => { void this.disconnect(); }, 600);
  }

  private syncPresence(): void {
    const names: string[] = [];
    this.state.players.forEach(p => names.push(p.name));
    setRoomPresence(this.roomId, '共闘', `ステージ${this.state.stage}`, names);
  }

  onDispose(): void {
    clearRoomPresence(this.roomId);
  }

  private submitToRanking(sid: string): void {
    const internal = this.internals.get(sid);
    const p = this.state.players.get(sid);
    if (!internal || !p || internal.submitted) return;
    internal.submitted = true;
    submitScore(p.name, internal.score, internal.spells.map(s => s.name));
  }

  // ---- 開始 ----

  private checkStart(): void {
    if (this.state.phase !== 'ready') return;
    const ps: PlayerS[] = [];
    this.state.players.forEach(p => ps.push(p));
    if (ps.length === 0) return;
    // ボス戦も部屋さえ作れば1人で挑める(仲間がいれば当然有利)
    if (ps.every(p => p.ready)) this.startFight();
  }

  private startFight(): void {
    this.state.phase = 'fight';
    this.lock(); // 開始後の途中参加は不可
    const names: string[] = [];
    this.state.players.forEach(p => names.push(p.name));
    announce(
      `🔥 ステージ${this.state.stage}の共闘が始まった(${names.join('・')})。`
      + 'この部屋はもう参加できない。',
    );
    this.spawnEnemies();
  }

  private spawnEnemies(): void {
    const stage = this.state.stage;
    const defs: EnemyDef[] = isBossStage(stage)
      ? [bossForStage(stage)]
      : pickEnemiesForStage(stage);
    // 敵を大きくしたぶん、右端がはみ出さないよう内側に寄せて間隔を広げた(battle.ts と同じ)
    const xs = defs.length === 1 ? [760] : defs.length === 2 ? [660, 850] : [580, 725, 865];

    // 人数に応じて敵HPを増強(1人=等倍, 2人=1.5倍, 3人=2倍)
    const playerCount = this.state.players.size;
    const hpMul = stageHpMul(stage) * ENEMY_HP_MUL * (0.5 + 0.5 * playerCount);

    defs.forEach((def, i) => {
      const e = new EnemyS();
      e.defId = def.id;
      e.name = def.name;
      e.maxHp = Math.round(def.hp * hpMul);
      e.hp = e.maxHp;
      e.alive = true;
      e.x = xs[i];
      e.frozen = false;
      e.sealed = false; e.slowed = false; e.burning = false;
      this.state.enemies.push(e);
      this.eInternals.push({
        def, atkTimer: Math.random() * def.interval * 0.7,
        frozenT: 0, slowPct: 0, slowT: 0,
        dotDps: 0, dotT: 0, dotTick: 0, dotOwner: '', sealedT: 0,
      });
    });
  }

  // ---- 詠唱 ----

  private tryCast(sid: string, idx: number): void {
    if (this.state.phase !== 'fight') return;
    const p = this.state.players.get(sid);
    const internal = this.internals.get(sid);
    if (!p || !internal || !p.alive) return;
    const sp = internal.spells[idx];
    if (!sp) return;
    if (p.castingIdx >= 0) return;
    if (internal.cooldowns[idx] > 0) return;
    if (p.mp < sp.stats.manaCost) return;

    p.mp -= sp.stats.manaCost;
    p.castingIdx = idx;
    p.castName = sp.name;
    p.castT = 0;
    p.castTotal = sp.stats.castTime;
  }

  // ---- メインループ(20Hz) ----

  private update(dt: number): void {
    // 予約イベント(弾の着弾・次ステージ移行)はクリア演出中も進める
    this.pending = this.pending.filter(ev => {
      ev.t -= dt;
      if (ev.t <= 0) { ev.fn(); return false; }
      return true;
    });

    if (this.state.phase !== 'fight') return;

    // プレイヤー
    this.state.players.forEach((p, sid) => {
      const internal = this.internals.get(sid);
      if (!internal || !p.alive) return;
      const regen = PLAYER_MP_REGEN + (internal.mpRegenT > 0 ? internal.mpRegenBonus : 0);
      p.mp = Math.min(p.maxMp, p.mp + regen * dt);
      for (let i = 0; i < internal.cooldowns.length; i++) {
        internal.cooldowns[i] = Math.max(0, internal.cooldowns[i] - dt);
      }
      if (internal.shieldT > 0) {
        internal.shieldT -= dt;
        if (internal.shieldT <= 0) p.shield = 0;
      }
      if (internal.wardT > 0) {
        internal.wardT -= dt;
        if (internal.wardT <= 0) internal.wardPct = 0;
      }
      if (internal.atkBoostT > 0) {
        internal.atkBoostT -= dt;
        if (internal.atkBoostT <= 0) internal.atkBoost = 0;
      }
      if (internal.mpRegenT > 0) {
        internal.mpRegenT -= dt;
        if (internal.mpRegenT <= 0) internal.mpRegenBonus = 0;
      }
      if (internal.vigorT > 0) {
        internal.vigorT -= dt;
        if (internal.vigorT <= 0) {
          p.maxHp -= internal.vigorBonus;
          internal.vigorBonus = 0;
          p.hp = Math.max(1, Math.min(p.hp, p.maxHp)); // バフ切れでは死なない
        }
      }
      // ヘイト減衰(毎秒5%)と同期
      internal.hate = Math.max(0, internal.hate * (1 - 0.05 * dt));
      p.hate = Math.round(internal.hate);

      // かかっている効果を全員に見せる(0なら効果なし)
      p.wardPct = internal.wardT > 0 ? Math.round(internal.wardPct) : 0;
      p.atkBoost = internal.atkBoostT > 0 ? Math.round(internal.atkBoost) : 0;
      p.vigorBonus = internal.vigorT > 0 ? Math.round(internal.vigorBonus) : 0;
      p.mpRegenBonus = internal.mpRegenT > 0 ? internal.mpRegenBonus : 0;
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

    // 敵
    this.state.enemies.forEach((e, i) => {
      if (!e.alive) return;
      const ei = this.eInternals[i];

      // 状態異常を全員に見せる(誰がかけたものでも全員の画面に出る)
      e.sealed = ei.sealedT > 0;
      e.slowed = ei.slowT > 0;
      e.burning = ei.dotT > 0;

      // 継続ダメージ(1秒ごと)
      if (ei.dotT > 0) {
        ei.dotT -= dt;
        ei.dotTick += dt;
        if (ei.dotTick >= 1) {
          ei.dotTick -= 1;
          const d = Math.max(1, Math.round(ei.dotDps));
          e.hp = Math.max(0, e.hp - d);
          const owner = this.internals.get(ei.dotOwner);
          if (owner) owner.score += d / 20;
          this.broadcast('dot', { i, amount: d });
          if (e.hp <= 0) { e.alive = false; return; }
        }
        if (ei.dotT <= 0) ei.dotDps = 0;
      }

      // 封印(行動不能)
      if (ei.sealedT > 0) {
        ei.sealedT -= dt;
        e.frozen = true;
        if (ei.sealedT > 0) return;
        e.frozen = ei.frozenT > 0;
      }

      if (ei.frozenT > 0) {
        ei.frozenT -= dt;
        e.frozen = ei.frozenT > 0;
        if (e.frozen) return;
      }
      if (ei.slowT > 0) {
        ei.slowT -= dt;
        if (ei.slowT <= 0) ei.slowPct = 0;
      }
      ei.atkTimer += dt / (1 + ei.slowPct / 100);
      if (ei.atkTimer >= ei.def.interval) {
        ei.atkTimer = 0;
        this.enemyAttack(i, ei);
      }
    });

    // 勝敗判定
    if (!this.ended) {
      let enemyAlive = false;
      this.state.enemies.forEach(e => { if (e.alive) enemyAlive = true; });
      let playerAlive = false;
      this.state.players.forEach(p => { if (p.alive) playerAlive = true; });

      if (this.state.enemies.length > 0 && !enemyAlive) this.endFight(true);
      else if (this.state.players.size > 0 && !playerAlive) this.endFight(false);
    }
  }

  // ---- 攻撃処理 ----

  private resolveCast(sid: string, p: PlayerS, st: SpellStats): void {
    if (st.selfDamage > 0) this.damagePlayer(sid, st.selfDamage);

    const casterInternal = this.internals.get(sid);

    // 封印: 敵全体を一定時間行動不能に
    if (st.kind === 'seal') {
      // 封印の効きは敵ごとに違う。属性相性がそのまま止まる時間に効く。
      let sealed = 0;
      let resisted = 0;
      this.eInternals.forEach((ei, i) => {
        const e = this.state.enemies[i];
        if (!e?.alive) return;
        const g = (ei.def.affinity[st.attr] ?? 0) as AffinityGrade;
        const sec = st.sealTime * sealResistMul(g);
        if (sec <= 0) { resisted++; return; }
        ei.sealedT = Math.max(ei.sealedT, sec);
        sealed = Math.max(sealed, sec);
      });
      this.broadcast('seal', { sid, sec: sealed, resisted });
      if (casterInternal) casterInternal.hate += sealed * 40;
      return;
    }

    // 闘気/戦鼓: 与ダメージ上昇
    if (st.kind === 'empower') {
      const apply = (qsid: string) => {
        const qi = this.internals.get(qsid);
        if (!qi) return;
        qi.atkBoost = st.atkBoost;
        qi.atkBoostT = 20;
        this.broadcast('empower', { sid: qsid, pct: st.atkBoost });
      };
      if (st.targetAll) this.state.players.forEach((q, qsid) => { if (q.alive) apply(qsid); });
      else apply(sid);
      return;
    }

    // 瞑想: MPの自然回復を一時的に引き上げる
    if (st.kind === 'focus') {
      const apply = (qsid: string) => {
        const qi = this.internals.get(qsid);
        if (!qi) return;
        qi.mpRegenBonus = st.mpRegenBonus; // 掛け直しは上書き
        qi.mpRegenT = 20;
        this.broadcast('focus', { sid: qsid, perSec: st.mpRegenBonus });
      };
      if (st.targetAll) this.state.players.forEach((q, qsid) => { if (q.alive) apply(qsid); });
      else apply(sid);
      if (casterInternal) casterInternal.hate += st.mpRegenBonus * 6;
      return;
    }

    // 活力/鼓舞: 最大HPを一時的に増やす
    if (st.kind === 'vigor') {
      const apply = (qsid: string) => {
        const q = this.state.players.get(qsid);
        const qi = this.internals.get(qsid);
        if (!q || !qi) return;
        q.maxHp -= qi.vigorBonus;            // 掛け直しは上書き
        q.hp = Math.min(q.hp, q.maxHp);
        qi.vigorBonus = st.hpBoost;
        qi.vigorT = 25;
        q.maxHp += qi.vigorBonus;
        q.hp += qi.vigorBonus;
        this.broadcast('vigor', { sid: qsid, amount: st.hpBoost });
      };
      if (st.targetAll) this.state.players.forEach((q, qsid) => { if (q.alive) apply(qsid); });
      else apply(sid);
      if (casterInternal) casterInternal.hate += st.hpBoost * 1.5;
      return;
    }

    // 護符: 属性耐性を付与(全属性版はパーティ全員)
    if (st.kind === 'ward') {
      const apply = (qsid: string) => {
        const qi = this.internals.get(qsid);
        if (!qi) return;
        qi.wardAttr = st.targetAll ? null : st.attr;
        qi.wardPct = st.wardPct;
        qi.wardT = 12;
        this.broadcast('ward', {
          sid: qsid, pct: st.wardPct, attr: st.targetAll ? '' : st.attr,
        });
      };
      if (st.targetAll) {
        this.state.players.forEach((q, qsid) => { if (q.alive) apply(qsid); });
      } else {
        apply(sid);
      }
      if (casterInternal) casterInternal.hate += st.wardPct * 3;
      return;
    }

    // 挑発: 自分のヘイトを大きく上げる
    if (st.kind === 'taunt') {
      if (casterInternal && p.alive) {
        casterInternal.hate += st.hateGain;
        this.broadcast('taunt', { sid, amount: st.hateGain });
      }
      return;
    }

    // 護盾: 自分(または全体護盾なら全員)にシールドを張る
    if (st.kind === 'shield') {
      if (!casterInternal || !p.alive) return;
      if (st.targetAll) {
        const each = Math.round(st.barrier * 0.6);
        this.state.players.forEach((q, qsid) => {
          if (!q.alive) return;
          const qi = this.internals.get(qsid);
          if (!qi) return;
          q.shield = Math.max(q.shield, each);
          qi.shieldT = 10;
          this.broadcast('shieldup', { sid: qsid, amount: each });
        });
      } else {
        p.shield = Math.max(p.shield, st.barrier);
        casterInternal.shieldT = 10;
        this.broadcast('shieldup', { sid, amount: st.barrier });
      }
      casterInternal.hate += st.barrier * 2.0;
      return;
    }

    // 治癒: 最も傷ついた味方(全体治癒なら全員)を回復
    if (st.kind === 'heal') {
      let healedTotal = 0;
      if (st.targetAll) {
        const each = Math.round(st.healPower * 0.6);
        this.state.players.forEach((q, qsid) => {
          if (!q.alive) return;
          const before = q.hp;
          q.hp = Math.min(q.maxHp, q.hp + each);
          healedTotal += q.hp - before;
          this.broadcast('heal', { sid: qsid, amount: each });
        });
      } else {
        const alive: { sid: string; p: PlayerS; ratio: number }[] = [];
        this.state.players.forEach((q, qsid) => {
          if (q.alive) alive.push({ sid: qsid, p: q, ratio: q.hp / q.maxHp });
        });
        alive.sort((a, b) => a.ratio - b.ratio);
        const target = alive[0];
        if (target) {
          const before = target.p.hp;
          target.p.hp = Math.min(target.p.maxHp, target.p.hp + st.healPower);
          healedTotal = target.p.hp - before;
          this.broadcast('heal', { sid: target.sid, amount: st.healPower });
        }
      }
      if (casterInternal) casterInternal.hate += healedTotal * 1.2;
      return;
    }

    // 地震: 弾を飛ばさず敵全体に威力75%
    if (st.quake) {
      this.broadcast('quake', { sid });
      this.pending.push({
        t: 0.25,
        fn: () => {
          this.state.enemies.forEach((e, i) => {
            if (e.alive) this.dealDamage(sid, i, st, 0.75);
          });
        },
      });
      return;
    }

    let targetIdx = -1;
    this.state.enemies.forEach((e, i) => {
      if (targetIdx === -1 && e.alive) targetIdx = i;
    });
    if (targetIdx === -1) return;

    const x0 = PLAYER_XS[p.slot] + 34;
    const target = this.state.enemies[targetIdx];
    if (!target) return;
    const delayMs = Math.max(60, ((target.x - x0) / st.projSpeed) * 1000);
    this.broadcast('proj', {
      sid, x0, targetX: target.x, attr: st.attr, power: st.power, delayMs,
    });
    this.pending.push({
      t: delayMs / 1000,
      fn: () => this.applySpellDamage(sid, st, targetIdx),
    });
  }

  private applySpellDamage(sid: string, st: SpellStats, firstIdx: number): void {
    const enemies = this.state.enemies;
    let idx = firstIdx;
    if (!enemies[idx]?.alive) {
      idx = -1;
      enemies.forEach((e, i) => { if (idx === -1 && e.alive) idx = i; });
    }
    if (idx === -1) return;
    const primary = enemies[idx];
    if (!primary) return;
    const hitSet = new Set<number>([idx]);
    this.dealDamage(sid, idx, st, 1.0);

    if (st.pierce) {
      enemies.forEach((e, i) => {
        if (e.alive && !hitSet.has(i)) { hitSet.add(i); this.dealDamage(sid, i, st, 1.0); }
      });
    }
    if (st.radius > 0) {
      enemies.forEach((e, i) => {
        if (e.alive && !hitSet.has(i) && Math.abs(e.x - primary.x) <= st.radius) {
          hitSet.add(i);
          this.dealDamage(sid, i, st, 0.7);
        }
      });
    }
    if (st.chain > 0) {
      const others: { i: number; d: number }[] = [];
      enemies.forEach((e, i) => {
        if (e.alive && !hitSet.has(i)) others.push({ i, d: Math.abs(e.x - primary.x) });
      });
      others.sort((a, b) => a.d - b.d);
      for (const o of others.slice(0, st.chain)) {
        hitSet.add(o.i);
        this.dealDamage(sid, o.i, st, 0.6);
      }
    }
  }

  private dealDamage(sid: string, idx: number, st: SpellStats, mul: number): void {
    const e = this.state.enemies[idx];
    const ei = this.eInternals[idx];
    if (!e || !e.alive) return;

    const atkInternalPre = this.internals.get(sid);
    const boost = 1 + (atkInternalPre?.atkBoost ?? 0) / 100;
    let dmg = st.power * mul * (0.9 + Math.random() * 0.2) * boost;
    // 継続ダメージを付与(上書き)
    if (st.dotTime > 0 && st.dotDps > 0) {
      ei.dotDps = st.dotDps * boost;
      ei.dotT = st.dotTime;
      ei.dotTick = 0;
      ei.dotOwner = sid;
    }
    const grade = (ei.def.affinity[st.attr] ?? 0) as AffinityGrade;
    dmg *= affinityMul(grade);
    const crit = Math.random() * 100 < st.critRate;
    if (crit) dmg *= 2;
    const final = Math.max(1, Math.round(dmg));

    e.hp = Math.max(0, e.hp - final);
    // 与ダメージ分のヘイトとスコア
    const atkInternal = this.internals.get(sid);
    if (atkInternal) {
      atkInternal.hate += final;
      atkInternal.score += final / 20;
    }
    let note = '';
    if (grade === 2) note = ' 大弱点!!';
    else if (grade === 1) note = ' 弱点!';
    else if (grade === -1) note = ' 耐性…';
    else if (grade === -2) note = ' ほぼ無効…';
    this.broadcast('hit', { i: idx, amount: final, crit, note, attr: st.attr, radius: st.radius });

    if (st.freeze > 0) { ei.frozenT = Math.max(ei.frozenT, st.freeze); e.frozen = true; }
    if (st.slow > 0) { ei.slowPct = Math.max(ei.slowPct, st.slow); ei.slowT = 4; }

    if (st.lifesteal > 0) {
      const p = this.state.players.get(sid);
      if (p && p.alive) {
        const heal = Math.round(final * st.lifesteal / 100);
        if (heal > 0) {
          p.hp = Math.min(p.maxHp, p.hp + heal);
          this.broadcast('heal', { sid, amount: heal });
        }
      }
    }

    if (e.hp <= 0) e.alive = false;
  }

  private enemyAttack(idx: number, ei: EInternal): void {
    const alive: { sid: string; hate: number }[] = [];
    this.state.players.forEach((p, sid) => {
      if (p.alive) alive.push({ sid, hate: this.internals.get(sid)?.hate ?? 0 });
    });
    if (alive.length === 0) return;
    // ヘイト制: 70%で最高ヘイトを、30%でヘイト比例の抽選
    let target: { sid: string; hate: number };
    if (Math.random() < 0.7) {
      target = alive.reduce((a, b) => (b.hate > a.hate ? b : a));
    } else {
      const total = alive.reduce((sum, a) => sum + a.hate + 1, 0);
      let r = Math.random() * total;
      target = alive[alive.length - 1];
      for (const a of alive) {
        r -= a.hate + 1;
        if (r <= 0) { target = a; break; }
      }
    }
    const delayMs = 500;
    this.broadcast('eproj', { i: idx, targetSid: target.sid, delayMs });
    const dmg = Math.round(
      ei.def.atk * ENEMY_ATK_MUL * stageAtkMul(this.state.stage) * (0.9 + Math.random() * 0.2),
    );
    this.pending.push({
      t: delayMs / 1000,
      fn: () => {
        if (this.state.phase === 'fight') {
          this.damagePlayer(target.sid, dmg, ei.def.attackAttr);
        }
      },
    });
  }

  private damagePlayer(sid: string, dmg: number, attr?: ElementId): void {
    const p = this.state.players.get(sid);
    if (!p || !p.alive) return;
    // 属性耐性で軽減
    const wi = this.internals.get(sid);
    if (wi && wi.wardPct > 0 && (wi.wardAttr === null || wi.wardAttr === attr)) {
      const before = dmg;
      dmg = Math.max(1, Math.round(dmg * (1 - wi.wardPct / 100)));
      if (before > dmg) this.broadcast('wardhit', { sid, amount: before - dmg });
    }
    // 護盾が先にダメージを受け止める
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, dmg);
      p.shield -= absorbed;
      dmg -= absorbed;
      this.broadcast('shieldhit', { sid, amount: absorbed });
      if (dmg <= 0) return;
    }
    p.hp = Math.max(0, p.hp - dmg);
    this.broadcast('phit', { sid, amount: dmg });
    if (p.hp <= 0) {
      p.alive = false;
      p.castingIdx = -1;
      p.castName = '';
    }
  }

  // ---- 終了 ----

  private endFight(win: boolean): void {
    const stage = this.state.stage;
    this.pending = []; // 飛んでいる弾・攻撃予約は破棄

    if (win) {
      // ステージクリア: 報酬を配って4秒後に自動で次ステージへ
      this.state.phase = 'clear';
      const rp = battleRP(stage, true);
      const boss = isBossStage(stage);
      for (const client of this.clients) {
        const internal = this.internals.get(client.sessionId);
        if (internal) internal.score += stage * 10; // クリアスコア
        // エレメントはボス撃破時のみ手に入る
        const drops: ElementId[] = [];
        if (boss) {
          const pool = this.eInternals[0]?.def.drops ?? [];
          const count = 2 + Math.floor(Math.random() * 2);
          for (let i = 0; i < count && pool.length > 0; i++) {
            drops.push(pool[Math.floor(Math.random() * pool.length)]);
          }
        }
        client.send('stageclear', { stage, drops, rp, boss });
      }
      this.pending.push({ t: 4, fn: () => this.nextStage() });
      return;
    }

    // 全滅: ここで終了。スコアをランキングへ記録
    this.ended = true;
    this.state.phase = 'done';
    const rp = battleRP(stage, false);
    for (const client of this.clients) {
      this.submitToRanking(client.sessionId);
      client.send('result', { win: false, drops: [], rp });
    }
  }

  // 次ステージへ(生存者25%回復・死亡者は50%で復活・MP全快)
  private nextStage(): void {
    if (this.ended || this.clients.length === 0) return;
    this.state.stage += 1;
    this.setMetadata({ stage: this.state.stage });

    this.state.players.forEach((p, sid) => {
      const internal = this.internals.get(sid);
      if (internal) {
        internal.cooldowns = internal.cooldowns.map(() => 0);
        internal.shieldT = 0;
        internal.atkBoost = 0; internal.atkBoostT = 0;
        internal.mpRegenBonus = 0; internal.mpRegenT = 0;
        internal.wardPct = 0; internal.wardT = 0;
        p.maxHp -= internal.vigorBonus; // バフはステージ間で解除
        internal.vigorBonus = 0; internal.vigorT = 0;
      }
      if (!p.alive) {
        p.alive = true;
        p.hp = Math.round(p.maxHp * 0.5);
      } else {
        p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25));
      }
      p.mp = p.maxMp;
      p.shield = 0;
      p.castingIdx = -1;
      p.castName = '';
      p.castT = 0;
    });

    this.state.enemies.splice(0, this.state.enemies.length);
    this.eInternals = [];
    this.spawnEnemies();
    this.state.phase = 'fight';
  }
}

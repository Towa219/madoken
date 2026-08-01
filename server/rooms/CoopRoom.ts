// 共闘バトルルーム(最大3人・サーバー権威シミュレーション)
//
// 魔法はクライアントからレシピ(エレメント構成)だけを受け取り、
// 性能はサーバー側で computeSpell により再計算する(ステータス改竄対策)。

// colyseus本体はCJSのためNode ESMではデフォルトimport経由、@colyseus/schemaはESMなのでnamed import
import colyseusPkg from 'colyseus';
import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';
import type { Client } from 'colyseus';

const { Room } = colyseusPkg;
import { computeSpell, spellCooldown } from '../../shared/spellcraft';
import {
  affinityMul, BOSS, ENEMIES, stageAtkMul, stageHpMul,
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
  declare castingIdx: number; // -1=非詠唱
  declare castT: number;
  declare castTotal: number;
}
defineTypes(PlayerS, {
  name: 'string', hp: 'number', maxHp: 'number', mp: 'number', maxMp: 'number',
  shield: 'number', hate: 'number', alive: 'boolean', ready: 'boolean', slot: 'number',
  castingIdx: 'number', castT: 'number', castTotal: 'number',
});

class EnemyS extends Schema {
  declare defId: string;
  declare name: string;
  declare hp: number;
  declare maxHp: number;
  declare alive: boolean;
  declare x: number;
  declare frozen: boolean;
}
defineTypes(EnemyS, {
  defId: 'string', name: 'string', hp: 'number', maxHp: 'number',
  alive: 'boolean', x: 'number', frozen: 'boolean',
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
  hate: number; // ヘイト(敵対心)。与ダメ/護盾/回復/挑発で増加、毎秒5%減衰
}

interface EInternal {
  def: EnemyDef;
  atkTimer: number;
  frozenT: number;
  slowPct: number;
  slowT: number;
}

export class CoopRoom extends Room<CoopState> {
  maxClients = 3;

  private internals = new Map<string, PInternal>();
  private eInternals: EInternal[] = [];
  private pending: { t: number; fn: () => void }[] = [];
  private ended = false;

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

  onJoin(client: Client, options: { name?: unknown; spells?: unknown }): void {
    const p = new PlayerS();
    p.name = String(options?.name ?? '名無し').slice(0, 12) || '名無し';
    p.maxHp = 120; p.hp = 120;
    p.maxMp = 100; p.mp = 100;
    p.shield = 0;
    p.hate = 0;
    p.alive = true; p.ready = false;
    p.castingIdx = -1; p.castT = 0; p.castTotal = 0;

    const used = new Set<number>();
    this.state.players.forEach(q => used.add(q.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    p.slot = Math.min(slot, PLAYER_XS.length - 1);

    this.state.players.set(client.sessionId, p);

    // 魔法: レシピからサーバー側で再計算
    const raw = Array.isArray(options?.spells) ? (options.spells as unknown[]).slice(0, 4) : [];
    const spells = raw.map(s => {
      const obj = s as { name?: unknown; recipe?: unknown };
      return {
        name: String(obj?.name ?? '魔弾').slice(0, 20),
        stats: computeSpell((obj?.recipe ?? {}) as ElementCounts).stats,
      };
    });
    this.internals.set(client.sessionId, {
      spells, cooldowns: [0, 0, 0, 0], shieldT: 0, hate: 0,
    });
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.internals.delete(client.sessionId);
    if (this.state.phase === 'ready') this.checkStart();
  }

  // ---- 開始 ----

  private checkStart(): void {
    if (this.state.phase !== 'ready') return;
    const ps: PlayerS[] = [];
    this.state.players.forEach(p => ps.push(p));
    if (ps.length === 0) return;
    if (ps.every(p => p.ready)) this.startFight();
  }

  private startFight(): void {
    this.state.phase = 'fight';
    this.lock(); // 開始後の途中参加は不可
    this.spawnEnemies();
  }

  private spawnEnemies(): void {
    const stage = this.state.stage;
    let defs: EnemyDef[];
    if (stage % 5 === 0) {
      defs = [BOSS];
    } else {
      const count = Math.min(3, 1 + Math.floor((stage - 1) / 2));
      defs = [];
      for (let i = 0; i < count; i++) {
        defs.push(ENEMIES[Math.floor(Math.random() * ENEMIES.length)]);
      }
    }
    const xs = defs.length === 1 ? [770] : defs.length === 2 ? [690, 860] : [630, 755, 875];

    // 人数に応じて敵HPを増強(1人=等倍, 2人=1.5倍, 3人=2倍)
    const playerCount = this.state.players.size;
    const hpMul = stageHpMul(stage) * (0.5 + 0.5 * playerCount);

    defs.forEach((def, i) => {
      const e = new EnemyS();
      e.defId = def.id;
      e.name = def.name;
      e.maxHp = Math.round(def.hp * hpMul);
      e.hp = e.maxHp;
      e.alive = true;
      e.x = xs[i];
      e.frozen = false;
      this.state.enemies.push(e);
      this.eInternals.push({
        def, atkTimer: Math.random() * def.interval * 0.7,
        frozenT: 0, slowPct: 0, slowT: 0,
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
      p.mp = Math.min(p.maxMp, p.mp + 5 * dt);
      for (let i = 0; i < internal.cooldowns.length; i++) {
        internal.cooldowns[i] = Math.max(0, internal.cooldowns[i] - dt);
      }
      if (internal.shieldT > 0) {
        internal.shieldT -= dt;
        if (internal.shieldT <= 0) p.shield = 0;
      }
      // ヘイト減衰(毎秒5%)と同期
      internal.hate = Math.max(0, internal.hate * (1 - 0.05 * dt));
      p.hate = Math.round(internal.hate);
      if (p.castingIdx >= 0) {
        p.castT += dt;
        const sp = internal.spells[p.castingIdx];
        if (sp && p.castT >= sp.stats.castTime) {
          const idx = p.castingIdx;
          p.castingIdx = -1;
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

    let dmg = st.power * mul * (0.9 + Math.random() * 0.2);
    const grade = (ei.def.affinity[st.attr] ?? 0) as AffinityGrade;
    dmg *= affinityMul(grade);
    const crit = Math.random() * 100 < st.critRate;
    if (crit) dmg *= 2;
    const final = Math.max(1, Math.round(dmg));

    e.hp = Math.max(0, e.hp - final);
    // 与ダメージ分のヘイト
    const atkInternal = this.internals.get(sid);
    if (atkInternal) atkInternal.hate += final;
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
      ei.def.atk * stageAtkMul(this.state.stage) * (0.9 + Math.random() * 0.2),
    );
    this.pending.push({
      t: delayMs / 1000,
      fn: () => {
        if (this.state.phase === 'fight') this.damagePlayer(target.sid, dmg);
      },
    });
  }

  private damagePlayer(sid: string, dmg: number): void {
    const p = this.state.players.get(sid);
    if (!p || !p.alive) return;
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
    }
  }

  // ---- 終了 ----

  private endFight(win: boolean): void {
    const stage = this.state.stage;
    this.pending = []; // 飛んでいる弾・攻撃予約は破棄

    if (win) {
      // ステージクリア: 報酬を配って4秒後に自動で次ステージへ
      this.state.phase = 'clear';
      const rp = 12 + 6 * stage + (stage % 5 === 0 ? 30 : 0);
      for (const client of this.clients) {
        const drops: ElementId[] = [];
        for (const ei of this.eInternals) {
          const count = 1 + (Math.random() < 0.5 ? 1 : 0);
          for (let i = 0; i < count; i++) {
            drops.push(ei.def.drops[Math.floor(Math.random() * ei.def.drops.length)]);
          }
        }
        if (stage % 5 === 0) drops.push('light', 'dark');
        client.send('stageclear', { stage, drops, rp });
      }
      this.pending.push({ t: 4, fn: () => this.nextStage() });
      return;
    }

    // 全滅: ここで終了
    this.ended = true;
    this.state.phase = 'done';
    const rp = 4 + 2 * stage;
    for (const client of this.clients) {
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
      p.castT = 0;
    });

    this.state.enemies.splice(0, this.state.enemies.length);
    this.eInternals = [];
    this.spawnEnemies();
    this.state.phase = 'fight';
  }
}

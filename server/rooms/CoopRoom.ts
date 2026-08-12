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
import { claimName } from '../names';
import { announce } from '../lobbyfeed';
import { claimBattleSlot, releaseBattleSlot } from '../activeBattle';
import { CODE_REPLACED } from '../../shared/netcodes';
import { clampNickname } from '../../shared/nickname';
import { clampCharId } from '../../shared/characters';
import {
  affinityMul, battleRP, BOSS_AOE_WARN_SEC, bossForStage, bossHpMul,
  ENEMY_ATK_MUL, ENEMY_HP_MUL,
  isBossStage,
  pickEnemiesForStage, POSE_CAST, POSE_HURT, POSE_HURT_SEC, POSE_IDLE,
  POSE_RELEASE, POSE_RELEASE_SEC,
  RECONNECT_SEC, PLAYER_MAX_HP, PLAYER_MAX_MP, PLAYER_MP_REGEN, REVIVE_HP_RATE,
  stageAtkMul, stageHpMul,
} from '../../shared/data';
import type { AffinityGrade, EnemyDef } from '../../shared/data';
import type { ElementCounts, ElementId, SpellStats } from '../../shared/types';
import { chosenPetOf, partyBonusOf } from '../../shared/pets';
import { grantBossEggOnce, hasBossEggRecord, listPets } from '../pets';

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
  declare charId: number;     // 選んだキャラクター(得意エレメントで威力が変わる)
  declare petSpecies: string; // 連れている鳥。いなければ空文字
  declare castingIdx: number; // -1=非詠唱
  declare castName: string;   // 詠唱中の魔法名(全員に見える)
  declare wardPct: number;    // 属性耐性(%)。0=なし
  declare atkBoost: number;   // 与ダメージ上昇(%)。0=なし
  declare vigorBonus: number; // 最大HP上昇。0=なし
  declare mpRegenBonus: number; // MP自然回復の上乗せ(毎秒)。0=なし
  declare castT: number;
  declare castTotal: number;
  declare pose: number;       // 見た目のポーズ(全員の画面で同じ絵になる)
}
defineTypes(PlayerS, {
  name: 'string', hp: 'number', maxHp: 'number', mp: 'number', maxMp: 'number',
  shield: 'number', hate: 'number', alive: 'boolean', ready: 'boolean', slot: 'number',
  charId: 'number', petSpecies: 'string',
  castingIdx: 'number', castT: 'number', castTotal: 'number', castName: 'string',
  wardPct: 'number', atkBoost: 'number', vigorBonus: 'number',
  mpRegenBonus: 'number', pose: 'number',
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
  declare pose: number;      // 見た目のポーズ(全員の画面で同じ絵になる)
}
defineTypes(EnemyS, {
  defId: 'string', name: 'string', hp: 'number', maxHp: 'number',
  alive: 'boolean', x: 'number', frozen: 'boolean',
  sealed: 'boolean', slowed: 'boolean', burning: 'boolean', pose: 'number',
});

class CoopState extends Schema {
  declare phase: string; // ready | count | fight | done
  declare countdown: number; // 3→2→1→開戦 の残り秒(phase='count' の間)
  declare stage: number;
  declare players: MapSchema<PlayerS>;
  declare enemies: ArraySchema<EnemyS>;
  constructor() {
    super();
    this.phase = 'ready';
    this.countdown = 0;
    this.stage = 1;
    this.players = new MapSchema<PlayerS>();
    this.enemies = new ArraySchema<EnemyS>();
  }
}
defineTypes(CoopState, {
  phase: 'string', countdown: 'number', stage: 'number',
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
  petRegen: number; // 連れている鳥ぶんのMP自然回復(毎秒)。0=居ない
  mpRegenBonus: number; // MP自然回復の上乗せ(毎秒)
  mpRegenT: number;
  score: number;     // 戦闘スコア(クリアステージ×10+与ダメ/20)
  submitted: boolean; // ランキング送信済みか(二重送信防止)
  poseT: number;      // 一瞬のポーズ(撃った・被弾)の残り時間
  petAdmin: boolean;  // 正しい管理者合言葉で参加した人だけ卵を受け取れる
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
  atkCount: number; // 何回攻撃したか(全体攻撃の周期に使う)
  poseT: number;    // 一瞬のポーズ(撃った・被弾)の残り時間
}

export class CoopRoom extends Room<CoopState> {
  maxClients = 3;

  private internals = new Map<string, PInternal>();
  private eInternals: EInternal[] = [];
  private pending: { t: number; fn: () => void }[] = [];
  private ended = false;
  private aborting = false;
  // 復帰待ちの仲間。待っている間は敵に狙われず、生存判定からも外す。
  // (決闘と違って時間は止めない。他の人まで待たせるのは酷なので)
  private waiting = new Set<string>();
  // 決着(全滅・中断)の控え。
  //
  // 決着の知らせはその時つながっている人にしか届かない。倒れたまま通信が切れ、
  // その間に仲間が退出して戦闘が終わると、戻ってきた人には何も届かない。
  // 画面は戦闘のまま・魔法ボタンは全部灰色で、退出以外に何もできなくなる。
  // 「共闘中に誰か退出されて復帰できなくなる」の正体がこれ。
  private outcome: { type: string; payload: unknown } | null = null;

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

    // 部屋に入り直した人が「留守の間に決着していないか」を聞いてくる。
    // サーバーから勝手に送ると、相手がまだ受け取り口を用意し終える前に
    // 着いてしまって取りこぼすので、受け取れるようになった側から聞かせる。
    this.onMessage('catchup', (client: Client) => {
      if (this.outcome) client.send(this.outcome.type, this.outcome.payload);
    });

    this.setSimulationInterval(dtMs => this.update(dtMs / 1000), 50);
  }

  async onJoin(
    client: Client,
    options: { name?: unknown; spells?: unknown; charId?: unknown; adminKey?: unknown },
  ): Promise<void> {
    const p = new PlayerS();
    p.name = clampNickname(options?.name) || '名無し';
    p.charId = clampCharId(options?.charId);
    p.petSpecies = '';
    const petAdmin = Boolean(process.env.ADMIN_KEY)
      && String(options?.adminKey ?? '') === process.env.ADMIN_KEY;
    let hpBonus = 0; let mpBonus = 0; let regenBonus = 0;
    if (petAdmin || await hasBossEggRecord(p.name)) {
      const pets = await listPets(p.name); const now = Date.now();
      const bonus = partyBonusOf(pets, now);
      hpBonus = bonus.hp; mpBonus = bonus.mp; regenBonus = bonus.regen;
      p.petSpecies = chosenPetOf(pets, now)?.species ?? '';
    }
    p.maxHp = PLAYER_MAX_HP + hpBonus; p.hp = p.maxHp;
    p.maxMp = PLAYER_MAX_MP + mpBonus; p.mp = p.maxMp;
    p.shield = 0;
    p.hate = 0;
    p.alive = true; p.ready = false;
    p.castingIdx = -1; p.castT = 0; p.castTotal = 0; p.castName = '';
    p.wardPct = 0; p.atkBoost = 0; p.vigorBonus = 0; p.mpRegenBonus = 0;
    // 最初から入れておく。未設定のまま配ると、受け取った側で「まだ何も
    // 決まっていない」状態になり、人によって別の絵が出る余地が残る。
    p.pose = POSE_IDLE;

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
    const spells = parseSpells(options?.spells, options?.charId);
    this.internals.set(client.sessionId, {
      spells, cooldowns: [0, 0, 0, 0], shieldT: 0, hate: 0,
      wardAttr: null, wardPct: 0, wardT: 0,
      atkBoost: 0, atkBoostT: 0, vigorBonus: 0, vigorT: 0,
      petRegen: regenBonus,
      mpRegenBonus: 0, mpRegenT: 0,
      score: 0, submitted: false, poseT: 0, petAdmin,
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


  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const leaverName = this.state.players.get(client.sessionId)?.name ?? '誰か';

    // 戦闘中に通信が切れただけなら、少しの間だけ戻りを待つ。
    // 待たずに abortRun していたため、1人の電波が一瞬途切れただけで
    // 部屋にいる全員のランが強制終了していた。
    if (!consented && !this.ended && this.state.phase !== 'ready') {
      this.waiting.add(client.sessionId);
      this.broadcast('pwait',
        { sid: client.sessionId, name: leaverName, sec: RECONNECT_SEC });
      try {
        await this.allowReconnection(client, RECONNECT_SEC);
        this.waiting.delete(client.sessionId);
        this.broadcast('pback', { sid: client.sessionId, name: leaverName });
        return; // 戻ってきたので続行
      } catch {
        this.waiting.delete(client.sessionId); // 戻ってこなかった
      }
    }

    releaseBattleSlot(leaverName, client.sessionId);
    this.submitToRanking(client.sessionId); // 途中離脱でもスコアは記録
    this.state.players.delete(client.sessionId);
    this.internals.delete(client.sessionId);
    this.syncPresence();

    if (this.state.phase === 'ready') {
      this.checkStart();
      return;
    }

    // 誰か残っていれば、そのまま続ける。
    // 以前は1人抜けただけで部屋全員のランを終わらせていたので、
    // 誰か1人の回線が不調なだけで巻き添えが大きかった。
    let left = 0;
    this.state.players.forEach(() => left++);
    if (left > 0) {
      this.broadcast('mateleft', { name: leaverName });
      return;
    }

    // 全員いなくなった時だけ、前ステージまでのクリア扱いで終える
    this.abortRun(leaverName);
  }

  private abortRun(leaverName: string): void {
    if (this.aborting || this.ended) return;
    this.aborting = true;
    this.ended = true;
    this.state.phase = 'done';
    this.pending = [];
    const clearedStage = this.state.stage - 1;
    this.outcome = { type: 'aborted', payload: { name: leaverName, clearedStage } };
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

  // ランキングは魔導値で競うものに変わったので、共闘の結果は送らない。
  // 部屋の中で出るスコア表示(クリアステージ×10+与ダメージ/20)はそのまま残す。
  private submitToRanking(sid: string): void {
    const internal = this.internals.get(sid);
    if (!internal || internal.submitted) return;
    internal.submitted = true;
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

  // 3→2→1→開戦 の長さ。ソロ・決闘と揃えてある。
  private static readonly COUNTDOWN_SEC = 3.6;

  private startFight(): void {
    this.beginCountdown();
    this.lock(); // 開始後の途中参加は不可
    const names: string[] = [];
    this.state.players.forEach(p => names.push(p.name));
    announce(
      `🔥 ステージ${this.state.stage}の共闘が始まった(${names.join('・')})。`
      + 'この部屋はもう参加できない。',
    );
    this.spawnEnemies();
  }

  // 敵を出してからカウントダウンに入る。数えている間は誰も動けない。
  // 次のステージへ進んだ時も同じ入り方にして、いきなり殴られないようにする。
  private beginCountdown(): void {
    this.state.phase = 'count';
    this.state.countdown = CoopRoom.COUNTDOWN_SEC;
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
    // ボスは厚みの付け方が別(ステージ成長を掛けず、専用の倍率で厚くする)
    const base = isBossStage(stage) ? bossHpMul() : stageHpMul(stage) * ENEMY_HP_MUL;
    const hpMul = base * (0.5 + 0.5 * playerCount);

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
      e.pose = POSE_IDLE;
      this.state.enemies.push(e);
      this.eInternals.push({
        def, atkTimer: Math.random() * def.interval * 0.7,
        frozenT: 0, slowPct: 0, slowT: 0,
        dotDps: 0, dotT: 0, dotTick: 0, dotOwner: '', sealedT: 0, atkCount: 0,
        poseT: 0,
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

    // カウントダウン中は誰も動かない(敵の攻撃も詠唱も止まる)
    if (this.state.phase === 'count') {
      this.state.countdown = Math.max(0, this.state.countdown - dt);
      if (this.state.countdown <= 0) this.state.phase = 'fight';
      return;
    }

    if (this.state.phase !== 'fight') return;

    // プレイヤー
    this.state.players.forEach((p, sid) => {
      const internal = this.internals.get(sid);
      if (!internal || !p.alive) return;
      const regen = PLAYER_MP_REGEN + internal.petRegen
        + (internal.mpRegenT > 0 ? internal.mpRegenBonus : 0);
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
          // 魔法が完成した瞬間の姿(撃つ・張る)を少しの間見せる
          this.flashPlayerPose(sid, POSE_RELEASE, POSE_RELEASE_SEC);
          this.resolveCast(sid, p, sp.stats);
        }
      }
      this.stepPlayerPose(p, internal, dt);
    });

    // 敵
    this.state.enemies.forEach((e, i) => {
      if (!e.alive) return;
      const ei = this.eInternals[i];

      // ポーズはこの下の早期 return より前に進める。
      // 封印や凍結で抜ける道があるので、後ろに置くとその間だけ姿が固まる。
      this.stepEnemyPose(e, ei, dt);

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
      // 復帰待ちの人も「生きている」と数える。
      // 外してしまうと、1人だけの部屋でその人の通信が切れた瞬間に
      // 全滅と判定され、戦闘が終わってしまう。本人には終了の知らせも
      // 届かない(接続が切れているので)ため、戻ってきても魔法が撃てない
      // 戦闘画面に取り残される。
      // 復帰待ちの人は敵に狙われないので、全員が待機中なら戦闘は
      // 進まずに止まる。それが正しい。
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

    // 蘇生: 倒れている仲間を全員よみがえらせる
    //
    // 光を6つ使う魔法だけが持つ効果。共闘でしか意味を持たないので、
    // 倒れている人が一人もいなければ回復に化ける(空振りで終わらせない)。
    //
    // ★ 撃った本人が倒れていることはない(倒れている間は詠唱できない)。
    if (st.kind === 'revive') {
      const back: string[] = [];
      this.state.players.forEach((q, qsid) => {
        if (q.alive) return;
        q.alive = true;
        q.hp = Math.max(1, Math.round(q.maxHp * REVIVE_HP_RATE));
        const qi = this.internals.get(qsid);
        if (qi) qi.hate = 0;          // 戻った直後に狙われ続けないように
        back.push(q.name);
        this.broadcast('revive', { sid: qsid, hp: q.hp, name: q.name });
      });
      if (back.length > 0) {
        announce(`✨ ${p.name} の蘇生光 — ${back.join('・')} が戦線に戻った`);
        if (casterInternal) casterInternal.hate += back.length * 60;
      } else {
        // 誰も倒れていない = 全員を大きく回復する。
        // 空振りにしないための受け皿だが、撃ち時を選べば
        // 「倒れる前に立て直す」使い方もできる。
        const heal = Math.round(PLAYER_MAX_HP * REVIVE_HP_RATE);
        let healedTotal = 0;
        this.state.players.forEach((q, qsid) => {
          if (!q.alive) return;
          const before = q.hp;
          q.hp = Math.min(q.maxHp, q.hp + heal);
          healedTotal += q.hp - before;
          this.broadcast('heal', { sid: qsid, amount: q.hp - before });
        });
        if (casterInternal) casterInternal.hate += healedTotal * 1.2;
      }
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
    this.flashEnemyPose(idx, POSE_HURT, POSE_HURT_SEC);
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
      // 復帰待ちの人は操作できないので狙わない。放置して倒すのは酷。
      if (p.alive && !this.waiting.has(sid)) {
        alive.push({ sid, hate: this.internals.get(sid)?.hate ?? 0 });
      }
    });
    if (alive.length === 0) return;

    ei.atkCount++;
    const base = ei.def.atk * ENEMY_ATK_MUL * stageAtkMul(this.state.stage);

    // ボスは何回かに一度、狙いを定めず全員を巻き込む一撃を放つ。
    // 予告してから着弾するので、回復や護盾を挟む余裕がある。
    if (ei.def.aoeEvery && ei.atkCount % ei.def.aoeEvery === 0) {
      const dmg = Math.round(base * (ei.def.aoeMul ?? 1.5) * (0.9 + Math.random() * 0.2));
      this.broadcast('eaoewarn', {
        i: idx, name: ei.def.name, attr: ei.def.attackAttr, sec: BOSS_AOE_WARN_SEC,
      });
      // 予告の間はずっと溜めている姿にする(予告と絵が一致する)
      this.flashEnemyPose(idx, POSE_CAST, BOSS_AOE_WARN_SEC);
      this.pending.push({
        t: BOSS_AOE_WARN_SEC,
        fn: () => {
          if (this.state.phase !== 'fight') return;
          // 予告中に倒されたら不発。避けきったご褒美になる。
          if (!this.state.enemies[idx]?.alive) return;
          // 封印されていたら不発。
          //
          // 封印中のボスはそもそも殴ってこない(update の敵の処理で止まる)ので、
          // 抜け道は予告から着弾までの間だけだった。ここを塞がないと
          // 「予告を見てから封印しても全体攻撃だけは飛んでくる」ことになり、
          // 封印を持ち込んだ意味が薄い。次の全体攻撃までは周期ぶん間が空く。
          //
          // 凍結は止めない。氷の攻撃魔法にもれなく付いてくるので、
          // これで止まると封印を用意して臨む意味が無くなる。
          if (this.eInternals[idx]?.sealedT > 0) {
            this.broadcast('eaoestop', { i: idx, name: ei.def.name });
            return;
          }
          this.broadcast('eaoehit', { i: idx, attr: ei.def.attackAttr });
          this.flashEnemyPose(idx, POSE_RELEASE, POSE_RELEASE_SEC);
          this.state.players.forEach((p, sid) => {
            if (p.alive && !this.waiting.has(sid)) {
              this.damagePlayer(sid, dmg, ei.def.attackAttr);
            }
          });
        },
      });
      return;
    }
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
    this.flashEnemyPose(idx, POSE_RELEASE, POSE_RELEASE_SEC);
    const dmg = Math.round(base * (0.9 + Math.random() * 0.2));
    this.pending.push({
      t: delayMs / 1000,
      fn: () => {
        if (this.state.phase === 'fight') {
          this.damagePlayer(target.sid, dmg, ei.def.attackAttr);
        }
      },
    });
  }

  // ---- ポーズ(見た目だけ) ----
  //
  // 「今どんな格好をしているか」を各自の画面に判断させると、通信の遅れや
  // 取りこぼしで人によって違う絵が出る。サーバーが決めて配れば必ず揃う。
  //
  // 詠唱中のように状態から分かるものは毎回計算し、撃った・被弾のように
  // 一瞬で終わるものは残り時間を持たせて、その間だけ上書きする。

  private flashPlayerPose(sid: string, pose: number, sec: number): void {
    const p = this.state.players.get(sid);
    const internal = this.internals.get(sid);
    if (!p || !internal) return;
    p.pose = pose;
    internal.poseT = sec;
  }

  private flashEnemyPose(idx: number, pose: number, sec: number): void {
    const e = this.state.enemies[idx];
    const ei = this.eInternals[idx];
    if (!e || !ei) return;
    e.pose = pose;
    ei.poseT = sec;
  }

  private stepPlayerPose(p: PlayerS, internal: PInternal, dt: number): void {
    if (internal.poseT > 0) {
      internal.poseT -= dt;
      if (internal.poseT > 0) return; // 一瞬のポーズを見せている間は動かさない
    }
    p.pose = p.alive && p.castingIdx >= 0 ? POSE_CAST : POSE_IDLE;
  }

  private stepEnemyPose(e: EnemyS, ei: EInternal, dt: number): void {
    if (ei.poseT > 0) {
      ei.poseT -= dt;
      if (ei.poseT > 0) return;
    }
    e.pose = POSE_IDLE;
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
    this.flashPlayerPose(sid, POSE_HURT, POSE_HURT_SEC);
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
        // ★ クリアの知らせは、卵の保存を待たずに先に送る。
        //   待たせると、Upstash が遅い時に素材と研究Pの表示が届かないまま
        //   4秒後の自動送りが来てしまう。卵は後から別便で知らせればよい。
        client.send('stageclear', { stage, drops, rp, boss });
        if (boss && stage > 0 && stage % 5 === 0) {
          const who = this.state.players.get(client.sessionId)?.name ?? '';
          void grantBossEggOnce(who, stage)
            .then(egg => { try { client.send('bossegg', { stage, egg }); } catch { /* 抜けた後 */ } })
            .catch(() => { try { client.send('bossegg', { stage, egg: 'error' }); } catch { /* 同上 */ } });
        }
      }
      this.pending.push({ t: 4, fn: () => this.nextStage() });
      return;
    }

    // 全滅: ここで終了。スコアをランキングへ記録
    this.ended = true;
    this.state.phase = 'done';
    const rp = battleRP(stage, false);
    this.outcome = { type: 'result', payload: { win: false, drops: [], rp } };
    for (const client of this.clients) {
      this.submitToRanking(client.sessionId);
      client.send('result', { win: false, drops: [], rp });
    }
  }

  // 次ステージへ(生存者25%回復・死亡者は50%で復活・MP全快)
  private nextStage(): void {
    // 見るのは「席が残っているか」であって「今つながっているか」ではない。
    //
    // 全員の通信が同時に切れている一瞬に当たると this.clients は空になる。
    // そこで打ち切ると次ステージへの移行がその場で消え、部屋はクリア表示の
    // まま永久に止まる。戻ってきても敵はいない・ボタンは灰色で何もできない。
    // 復帰待ちの人の席は state.players に残っているので、そちらで数える。
    if (this.ended || this.state.players.size === 0) return;
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
    this.beginCountdown();
  }
}

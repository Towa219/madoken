// 戦闘シーン(PixiJS・横視点・セミリアルタイム詠唱+クールダウン制)
//
// ※キャラの見た目は makePlayerSprite / makeEnemySprite / makeProjectileGfx に分離。
//   public/img/ に画像を置くと自動でそちらが使われる(src/artwork.ts を参照)。

import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import {
  affinityMul, affinitySymbol, battleRP, bossForStage, ELEMENTS, ELEMENT_ORDER,
  bossHpMul, ENEMY_ATK_MUL, ENEMY_HP_MUL, ENEMY_SCALE, enemyTopY, isBossStage,
  pickEnemiesForStage, POSE_HURT_SEC, POSE_RELEASE_SEC,
  PLAYER_MAX_HP, PLAYER_MAX_MP, PLAYER_MP_REGEN, REVIVE_HP_RATE,
  SPRITE_SCALE, stageAtkMul, stageHpMul,
} from '../shared/data';
import type { AffinityGrade, EnemyDef } from '../shared/data';
import {
  applyPoseTexture, backgroundArt, enemyArt, enemyPoseTexture, playerArt,
  playerPoseTexture, projectileArt,
} from './artwork';
import type { Pose } from './artwork';
import { characterName, characterScale } from '../shared/characters';
import {
  ALLY_DMG_MUL, ALLY_HATE_SHARE, ALLY_HEAL_MUL, ALLY_SEAL_MUL, ALLY_TAUNT_SHARE,
  ALLY_MAX_HP, ALLY_MAX_MP, allyPowerMul,
} from '../shared/allies';
import { Ally } from './ally';
import type { AllySight } from '../shared/allies';
import { sealResistMul, spellCooldown, spellDisplayName } from '../shared/spellcraft';
import { playerMagicTotal, state } from './state';
import { playSfx, startSfxLoop, stopSfxLoop } from './sound';
import type { BattleResult, ElementId, Spell, SpellStats } from '../shared/types';

const W = 960;
const H = 540;
const GROUND_Y = 460;
const PLAYER_X = 196;
// お供はプレイヤーの後ろ斜め。
//
// 初めは横に66だけずらしていたが、絵の幅がそれぞれ100前後あるので
// 重なって「二人が同じ場所に立っている」ように見えていた。
// 前後を出すのに要るのは3つ ― 離す・持ち上げる・小さくする。
//   離す   : PLAYER_X との差を66→132に(絵の幅より広げる)
//   持ち上げ: 横視点では「奥にいる=画面の上」。地面ごと上げる
//   小さく  : 奥にいるものは小さい
const ALLY_X = 64;
const ALLY_LIFT = 26;
const ALLY_SCALE = 0.76;

// 開始カウントダウンの見た目(ソロ・決闘で共通)。
//
// UI用のゴシック体を大きく出すと素っ気ないので、明朝体+金の縁取りにして
// 「魔導書の見出し」らしい重みを出す。明朝体が無い環境でも serif に落ちる。
export const START_LABEL = '開戦';
export const COUNT_FONT =
  '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "MS Mincho", "Noto Serif JP", serif';

export const COUNT_STYLE = {
  fill: 0xffeab8,
  fontSize: 104,
  fontFamily: COUNT_FONT,
  fontWeight: 'bold' as const,
  letterSpacing: 14,
  stroke: { color: 0x2a1240, width: 13, join: 'round' as const },
  dropShadow: {
    color: 0x8866ff, blur: 16, distance: 0, alpha: 0.85, angle: 0,
  },
};

// プレイヤーまわりの座標は SPRITE_SCALE と一緒に動かす。
// cy(n) = 地面からn(拡大前)だけ上、cs(n) = 長さnを拡大した値。
// 検証から覗くための控え(window.__allyDebug)
interface AllyDebug {
  casted: number; roles: string[];
  hp: number; maxHp: number; alive: boolean;
  shield: number; warded: boolean; atkBoost: number; mpRegenBonus: number;
  powerMul: number; power0: number;   // 倍率と、1本目の威力(効いているかの証)
}

const cy = (n: number) => GROUND_Y - n * SPRITE_SCALE;
// お供まわりの高さ。お供は一段奥に立っているので、地面ごと持ち上げる。
// 数字や光もこれで一緒に上がる ― 片方だけ cy のままだと足元から離れる。
const ay = (n: number) => cy(n) - ALLY_LIFT;
const cs = (n: number) => n * SPRITE_SCALE;

interface EnemyUnit {
  def: EnemyDef;
  hp: number;
  maxHp: number;
  x: number;
  cont: Container;
  body: Graphics | Sprite;
  hpBar: Graphics;
  atkTimer: number;
  interval: number;
  frozen: number;
  slowPct: number;
  slowTimer: number;
  alive: boolean;
  flash: number;
  bobPhase: number;
  dotDps: number;   // 継続ダメージ
  dotT: number;
  dotTick: number;
  sealed: number;   // 封印(行動不能)の残り秒
  pose: Pose;       // 見た目のポーズ
  poseT: number;    // 一瞬のポーズ(撃った・被弾)の残り時間
}

interface Proj {
  g: Container;
  x: number;
  y: number;
  speed: number;      // 右向き正
  from: 'player' | 'enemy' | 'ally';
  // 敵弾が誰を狙っているか。弾は横に飛ぶので、お供を狙う弾は
  // 手前のプレイヤーを素通りさせる必要がある。
  at?: 'player' | 'ally';
  spell?: SpellStats;
  dmg?: number;       // 敵弾用
  attr: ElementId;    // 弾の属性(見た目・軌跡の色)
  r: number;          // 弾の半径(軌跡サイズ)
  trailT: number;     // 軌跡の発生タイマー
  hit: Set<EnemyUnit>;
  dead: boolean;
}

interface Popup { t: Text; vy: number; life: number; }
interface Fx { g: Graphics; life: number; maxLife: number; grow?: boolean; }

export class BattleManager {
  private app: Application | null = null;
  private root: Container | null = null;
  private entityLayer!: Container;
  private projLayer!: Container;
  private fxLayer!: Container;
  private uiLayer!: Container;

  private enemies: EnemyUnit[] = [];
  private projs: Proj[] = [];
  private popups: Popup[] = [];
  private fxs: Fx[] = [];

  private active = false;
  private endTimer = -1;      // 勝敗確定後の余韻タイマー
  private endResult: { win: boolean; escaped: boolean } | null = null;

  private stage = 1;
  private spells: Spell[] = [];
  private onEnd: ((r: BattleResult) => void) | null = null;

  private maxHp = PLAYER_MAX_HP;
  private hp = PLAYER_MAX_HP;
  private maxMp = PLAYER_MAX_MP;
  private mp = PLAYER_MAX_MP;
  private mpRegen = PLAYER_MP_REGEN;
  private shield = 0;
  private shieldTimer = 0;
  // 属性耐性(ward): attr=null なら全属性
  private ward: { attr: ElementId | null; pct: number; timer: number } | null = null;
  // 最大HP上昇(vigor)
  private vigorBonus = 0;
  private vigorTimer = 0;
  // 与ダメージ上昇(empower)
  private atkBoost = 0;
  private atkBoostTimer = 0;
  // MP自然回復の上乗せ(focus)
  private mpRegenBonus = 0;
  private mpRegenTimer = 0;

  private casting: { spell: Spell; t: number } | null = null;
  // 見た目のポーズ。ソロは自分の画面だけなので、ここで決めて描くだけでよい
  // (共闘・決闘はサーバーが決める。全員の画面で揃える必要があるため)。
  private poseT = 0;
  private cooldowns = new Map<string, number>();
  private countdown = 0;      // 開始前カウントダウン(秒)
  private prevCount = -99;    // 直前に鳴らしたカウント(毎フレーム鳴らさないため)
  private countText!: Text;

  private playerCont!: Container;
  private barsG!: Graphics;
  private stageText!: Text;
  private infoText!: Text;
  private allyText!: Text;
  private shake = 0;
  private hitFlash = 0;
  private time = 0;
  private defeated: EnemyDef[] = [];

  private spellBtns: HTMLButtonElement[] = [];

  // ---- お供AI ----
  //
  // 連れて行かない時は null。旗(ALLY_ENABLED)が false の間は
  // 出撃準備に選択欄が出ないので、ここも常に null のまま。
  private ally: Ally | null = null;
  private allyCont: Container | null = null;
  private allyPoseT = 0;

  async ensureApp(mount: HTMLElement): Promise<void> {
    if (this.app) return;
    const app = new Application();
    await app.init({
      width: W, height: H, backgroundColor: 0x0b0b18, antialias: true,
    });
    mount.appendChild(app.canvas);
    app.ticker.add(t => this.tick(Math.min(t.deltaMS / 1000, 0.1)));
    this.app = app;
  }

  isActive(): boolean {
    return this.active;
  }

  async start(
    mount: HTMLElement, stage: number, spells: Spell[],
    onEnd: (r: BattleResult) => void, allyCharId: number | null = null,
  ): Promise<void> {
    await this.ensureApp(mount);
    this.stage = stage;
    this.spells = spells;
    this.onEnd = onEnd;
    // お供。連れて行かない時は null のまま(今までどおりのソロ)。
    // お供の強さは、出撃する時のあなたの魔導値合計で決まる(戦闘中は変わらない)
    this.ally = allyCharId === null
      ? null
      : new Ally(allyCharId, allyPowerMul(playerMagicTotal()));
    this.allyPoseT = 0;
    // 前の戦いの控えを消す。残しておくと、お供を連れて行かなかった回に
    // 前回のお供の値が居座り、検証が「居ないはずのお供」を見てしまう。
    delete (window as unknown as { __allyDebug?: unknown }).__allyDebug;
    if (this.ally) this.noteAllyState();

    this.maxHp = PLAYER_MAX_HP;
    this.vigorBonus = 0;
    this.vigorTimer = 0;
    this.atkBoost = 0;
    this.atkBoostTimer = 0;
    this.mpRegenBonus = 0;
    this.mpRegenTimer = 0;
    this.hp = this.maxHp;
    this.mp = this.maxMp;
    this.shield = 0;
    this.shieldTimer = 0;
    this.ward = null;
    this.casting = null;
    this.cooldowns.clear();
    this.enemies = [];
    this.projs = [];
    this.popups = [];
    this.fxs = [];
    this.defeated = [];
    this.shake = 0;
    this.hitFlash = 0;
    this.time = 0;
    this.endTimer = -1;
    this.endResult = null;
    this.countdown = 3.6; // 3→2→1→開戦
    this.prevCount = -99;

    this.buildScene();
    this.buildSpellBar();
    this.buildEnemyStatus();
    this.active = true;
  }

  // ===== 敵ステータスカード(DOM) =====

  private statusEls: { card: HTMLElement; hpFill: HTMLElement; hpText: HTMLElement }[] = [];

  private buildEnemyStatus(): void {
    const box = document.querySelector('#enemy-status') as HTMLElement;
    box.innerHTML = '';
    this.statusEls = [];
    for (const e of this.enemies) {
      const card = document.createElement('div');
      card.className = 'enemy-card';
      const chips = ELEMENT_ORDER.map(id => {
        const g = (e.def.affinity[id] ?? 0) as AffinityGrade;
        const cls = g > 0 ? 'aff-weak' : g < 0 ? 'aff-resist' : 'aff-neutral';
        return `<span class="aff ${cls}">` +
          `<span style="color:${ELEMENTS[id].cssColor}">${ELEMENTS[id].name}</span>` +
          `${affinitySymbol(g)}</span>`;
      }).join('');
      const atk = ELEMENTS[e.def.attackAttr];
      card.innerHTML =
        `<div class="ecard-head"><span class="ecard-name">${e.def.name}</span>` +
        `<span class="ecard-hp"></span></div>` +
        `<div class="ecard-hpbar"><div class="ecard-hpfill"></div></div>` +
        `<div class="ecard-atk">攻撃属性: ` +
        `<span style="color:${atk.cssColor}">${atk.name}</span></div>` +
        `<div class="ecard-affs">${chips}</div>`;
      box.appendChild(card);
      this.statusEls.push({
        card,
        hpFill: card.querySelector('.ecard-hpfill') as HTMLElement,
        hpText: card.querySelector('.ecard-hp') as HTMLElement,
      });
    }
    const legend = document.createElement('div');
    legend.id = 'aff-legend';
    legend.textContent = '相性: ◎=2.0倍 ○=1.5倍 −=1.0倍 △=0.6倍 ✕=0.25倍 (魔法の属性で判定)';
    box.appendChild(legend);
    this.updateEnemyStatus();
  }

  private updateEnemyStatus(): void {
    this.enemies.forEach((e, i) => {
      const s = this.statusEls[i];
      if (!s) return;
      s.hpFill.style.width = `${Math.max(0, (e.hp / e.maxHp)) * 100}%`;
      s.hpText.textContent = `HP ${Math.max(0, Math.ceil(e.hp))}/${e.maxHp}`;
      s.card.classList.toggle('dead', !e.alive);
    });
  }

  // ===== シーン構築 =====

  private buildScene(): void {
    const app = this.app!;
    if (this.root) {
      app.stage.removeChild(this.root);
      this.root.destroy({ children: true });
    }
    const root = new Container();
    app.stage.addChild(root);
    this.root = root;

    // 背景(画像素材があればそれを敷く)
    const bgArt = backgroundArt(W, H);
    if (bgArt) root.addChild(bgArt);
    const bg = new Graphics();
    if (!bgArt) {
      bg.rect(0, 0, W, H).fill(0x0b0b18);
      bg.circle(780, 90, 42).fill({ color: 0xddddff, alpha: 0.85 }); // 月
      bg.circle(766, 82, 34).fill(0x0b0b18);                          // 三日月に削る
      for (let i = 0; i < 40; i++) {                                  // 星
        const sx = (i * 137 + 61) % W;
        const sy = (i * 89 + 23) % (GROUND_Y - 120);
        bg.circle(sx, sy, (i % 3 === 0) ? 1.6 : 1).fill({ color: 0xffffff, alpha: 0.5 });
      }
      bg.rect(0, GROUND_Y, W, H - GROUND_Y).fill(0x1c1c30);           // 地面
      bg.rect(0, GROUND_Y, W, 4).fill(0x33335a);
      root.addChild(bg);
    }

    this.entityLayer = new Container();
    this.projLayer = new Container();
    this.fxLayer = new Container();
    this.uiLayer = new Container();
    root.addChild(this.entityLayer, this.projLayer, this.fxLayer, this.uiLayer);

    // お供(居れば)。プレイヤーより先に足すと後ろに描かれる ―
    // 後ろ斜めに立たせたいので、この順でないと手前に被る。
    this.allyCont = null;
    if (this.ally) {
      const c = makePlayerSprite(this.ally.charId);
      c.position.set(ALLY_X, GROUND_Y - ALLY_LIFT);
      c.scale.set(ALLY_SCALE);
      this.entityLayer.addChild(c);
      this.allyCont = c;
      setPlayerSpritePose(c, this.ally.charId, 'idle');
    }

    // プレイヤー
    this.playerCont = makePlayerSprite(state.charId);
    this.playerCont.position.set(PLAYER_X, GROUND_Y);
    this.entityLayer.addChild(this.playerCont);

    // 敵配置
    const defs = this.pickEnemies();
    // 敵を大きくしたぶん、右端がはみ出さないよう内側に寄せて間隔を広げた
    const xs = defs.length === 1 ? [760]
      : defs.length === 2 ? [660, 850]
      : [580, 725, 865];
    defs.forEach((def, i) => {
      const { cont, body } = makeEnemySprite(def);
      cont.position.set(xs[i], GROUND_Y);
      this.entityLayer.addChild(cont);

      const hpBar = new Graphics();
      cont.addChild(hpBar);

      const nameT = new Text({
        text: def.name,
        style: { fill: 0xccccdd, fontSize: 12, fontFamily: 'Meiryo, sans-serif' },
      });
      nameT.anchor.set(0.5);
      nameT.position.set(0, enemyTopY(def) - 30);
      cont.addChild(nameT);

      // ボスは厚みの付け方が別(ステージ成長を掛けない)
      const hpMul = isBossStage(this.stage)
        ? bossHpMul()
        : stageHpMul(this.stage) * ENEMY_HP_MUL;
      const unit: EnemyUnit = {
        def,
        hp: Math.round(def.hp * hpMul),
        maxHp: Math.round(def.hp * hpMul),
        x: xs[i],
        cont, body, hpBar,
        atkTimer: Math.random() * def.interval * 0.7,
        interval: def.interval,
        frozen: 0, slowPct: 0, slowTimer: 0,
        alive: true, flash: 0,
        bobPhase: Math.random() * Math.PI * 2,
        dotDps: 0, dotT: 0, dotTick: 0, sealed: 0,
        pose: 'idle', poseT: 0,
      };
      this.drawEnemyHpBar(unit);
      this.enemies.push(unit);
    });

    // UI
    this.barsG = new Graphics();
    this.uiLayer.addChild(this.barsG);

    this.stageText = new Text({
      text: this.stage % 5 === 0 ? `ステージ ${this.stage} — ボス戦` : `ステージ ${this.stage}`,
      style: { fill: 0xbb99ff, fontSize: 18, fontFamily: 'Meiryo, sans-serif', fontWeight: 'bold' },
    });
    this.stageText.anchor.set(0.5, 0);
    this.stageText.position.set(W / 2, 12);
    this.uiLayer.addChild(this.stageText);

    this.infoText = new Text({
      text: '',
      style: { fill: 0x8888aa, fontSize: 12, fontFamily: 'Meiryo, sans-serif' },
    });
    this.infoText.position.set(16, 64);
    this.uiLayer.addChild(this.infoText);

    // お供の数字。連れて行かない時は隠す。
    this.allyText = new Text({
      text: '',
      style: { fill: 0x88aa99, fontSize: 11, fontFamily: 'Meiryo, sans-serif' },
    });
    this.allyText.position.set(16, 106);
    this.allyText.visible = false;
    this.uiLayer.addChild(this.allyText);

    this.countText = new Text({ text: '', style: { ...COUNT_STYLE } });
    this.countText.anchor.set(0.5);
    this.countText.position.set(W / 2, H / 2 - 30);
    this.uiLayer.addChild(this.countText);
  }

  private pickEnemies(): EnemyDef[] {
    if (isBossStage(this.stage)) return [bossForStage(this.stage)];
    return pickEnemiesForStage(this.stage);
  }

  // ===== 魔法バー(DOM) =====

  private buildSpellBar(): void {
    const bar = document.querySelector('#spell-bar') as HTMLElement;
    bar.innerHTML = '';
    this.spellBtns = [];
    this.spells.forEach((sp, i) => {
      const b = document.createElement('button');
      b.className = 'spell-btn';
      b.innerHTML =
        `<span class="key">${i + 1}</span>${spellDisplayName(sp)}` +
        `<span class="cost">MP${sp.stats.manaCost} / 詠唱${sp.stats.castTime.toFixed(2)}秒</span>` +
        `<div class="cd-overlay"></div>`;
      // ダブルタップ拡大よけで2回目のタップの click が消えるので、
      // 魔法は pointerdown で撃つ(src/nozoom.ts と対で見ること)。
      b.addEventListener('pointerdown', ev => {
        if (ev.button === 0) this.tryCast(i);
      });
      bar.appendChild(b);
      this.spellBtns.push(b);
    });
    // 撤退は魔法ボタンと同じ行に置くと押し間違えるので、下の段に分ける
    const escRow = document.createElement('div');
    escRow.className = 'escape-row';
    const esc = document.createElement('button');
    esc.id = 'btn-escape';
    esc.textContent = '撤退';
    esc.addEventListener('click', () => {
      if (this.active && this.endResult === null) this.beginEnd(false, true);
    });
    escRow.appendChild(esc);
    bar.appendChild(escRow);
  }

  private updateSpellBar(): void {
    this.spells.forEach((sp, i) => {
      const b = this.spellBtns[i];
      if (!b) return;
      const cd = this.cooldowns.get(sp.id) ?? 0;
      const total = spellCooldown(sp.stats);
      const overlay = b.querySelector('.cd-overlay') as HTMLElement;
      overlay.style.width = cd > 0 ? `${(cd / total) * 100}%` : '0%';
      b.disabled =
        !!this.casting || cd > 0 || this.mp < sp.stats.manaCost
        || this.endResult !== null || this.countdown > 0;
    });
  }

  tryCast(i: number): void {
    if (!this.active || this.endResult !== null || this.countdown > 0) return;
    const sp = this.spells[i];
    if (!sp) return;
    if (this.casting) return;
    if ((this.cooldowns.get(sp.id) ?? 0) > 0) return;
    if (this.mp < sp.stats.manaCost) return;
    this.mp -= sp.stats.manaCost;
    this.casting = { spell: sp, t: 0 };
    startSfxLoop('casting');
  }

  // ===== メインループ =====

  private tick(dt: number): void {
    if (!this.active) return;
    this.time += dt;

    // 勝敗確定後の余韻
    if (this.endResult !== null) {
      this.endTimer -= dt;
      this.updateFx(dt);
      this.updatePopups(dt);
      this.updateShake(dt);
      if (this.endTimer <= 0) this.finish();
      return;
    }

    // 開始前カウントダウン(この間は敵味方とも行動しない)
    if (this.countdown > 0) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      if (n !== this.prevCount) {
        this.prevCount = n;
        playSfx(n > 0 ? 'countdown' : 'start');
      }
      this.countText.text = n > 0 ? String(n) : START_LABEL;
      const frac = (this.countdown - 0.6) - Math.floor(this.countdown - 0.6);
      if (n > 0) {
        // 数字は大きく現れて縮む
        this.countText.scale.set(1 + (1 - frac) * 0.35);
        this.countText.alpha = 1;
      } else {
        // 「開戦」は逆に押し広がりながら薄れて消える
        const t = Math.max(0, Math.min(1, this.countdown / 0.6));
        this.countText.scale.set(1.05 + (1 - t) * 0.35);
        this.countText.alpha = 0.15 + t * 0.85;
      }
      this.drawBars();
      this.updateSpellBar();
      return;
    }
    this.countText.text = '';

    // MP回復(瞑想がかかっている間は上乗せされる)
    this.mp = Math.min(this.maxMp, this.mp + (this.mpRegen + this.mpRegenBonus) * dt);

    // クールダウン
    for (const [id, cd] of this.cooldowns) {
      if (cd > 0) this.cooldowns.set(id, Math.max(0, cd - dt));
    }

    // 詠唱
    if (this.casting) {
      this.casting.t += dt;
      const st = this.casting.spell.stats;
      if (this.casting.t >= st.castTime) {
        const sp = this.casting.spell;
        this.casting = null;
        stopSfxLoop('casting');
        playSfx('cast');
        this.setPlayerPose('release', POSE_RELEASE_SEC);
        this.cooldowns.set(sp.id, spellCooldown(sp.stats));
        if (st.selfDamage > 0) {
          this.hp -= st.selfDamage;
          this.addPopup(PLAYER_X, cy(100), `-${st.selfDamage}`, 0xbb77ee);
        }
        if (st.kind === 'taunt') {
          // ソロでは挑発は小さな護盾に変わる
          const small = Math.round(st.power * 1.2);
          this.shield = Math.max(this.shield, small);
          this.shieldTimer = 5;
          this.addPopup(PLAYER_X, cy(115), `咆哮! 護盾+${small}`, 0xffaa66);
        } else if (st.kind === 'shield') {
          playSfx('shield');
          const buddy = this.sharedAlly(st);
          // 全体護盾は一人ぶんが6割になる(共闘と同じ勘定)。
          // 一人で撃つ時は今までどおり満額。
          const each = buddy ? Math.round(st.barrier * 0.6) : st.barrier;
          this.shield = Math.max(this.shield, each);
          this.shieldTimer = 10;
          this.addPopup(PLAYER_X, cy(115), `護盾+${each}`, 0x88ccff);
          if (buddy) {
            buddy.shield = Math.max(buddy.shield, each);
            buddy.shieldTimer = 10;
            this.addPopup(ALLY_X, ay(115), `護盾+${each}`, 0x88ccff);
          }
        } else if (st.kind === 'heal') {
          playSfx('heal');
          const buddy = this.sharedAlly(st);
          const heal = buddy ? Math.round(st.healPower * 0.6) : st.healPower;
          this.hp = Math.min(this.maxHp, this.hp + heal);
          this.addPopup(PLAYER_X, cy(115), `+${heal}`, 0x88ddaa);
          if (buddy) {
            this.addPopup(ALLY_X, ay(115), `+${buddy.heal(heal)}`, 0x88ddaa);
          }
        } else if (st.kind === 'revive') {
          // 蘇生は共闘のためのもの。ソロには起こす相手がいないので、
          // 大きな回復に化ける(挑発をソロで護盾に読み替えているのと同じ扱い)。
          // ★ お供は起こせない ―「倒れると復活しない」を崩さないため。
          //   ただし生きているお供は、他の全体魔法と同じように癒される。
          playSfx('heal');
          const heal = Math.round(this.maxHp * REVIVE_HP_RATE);
          const before = this.hp;
          this.hp = Math.min(this.maxHp, this.hp + heal);
          this.addPopup(PLAYER_X, cy(115), `+${this.hp - before}`, 0x88ddaa);
          const buddy = this.sharedAlly(st);
          if (buddy) this.addPopup(ALLY_X, ay(115), `+${buddy.heal(heal)}`, 0x88ddaa);
        } else if (st.kind === 'seal') {
          // 封印の効きは敵ごとに違う。属性相性がそのまま止まる時間に効く。
          let sealed = 0;
          let resisted = 0;
          for (const e of this.enemies) {
            if (!e.alive) continue;
            const g = (e.def.affinity[st.attr] ?? 0) as AffinityGrade;
            const sec = st.sealTime * sealResistMul(g);
            if (sec <= 0) { resisted++; continue; }
            e.sealed = Math.max(e.sealed, sec);
            e.frozen = 0;
            sealed = Math.max(sealed, sec);
          }
          if (sealed > 0) {
            this.addPopup(W / 2, cy(150), `封印! ${sealed.toFixed(1)}秒`, 0xbb77ee);
          }
          if (resisted > 0) {
            this.addPopup(W / 2, cy(178), `レジスト ${resisted}体`, 0xff9977);
          }
        } else if (st.kind === 'empower') {
          playSfx('buff');
          this.atkBoost = st.atkBoost;
          this.atkBoostTimer = 20;
          this.addPopup(PLAYER_X, cy(130), `与ダメ+${st.atkBoost}%`, 0xff8844);
          const buddy = this.sharedAlly(st);
          if (buddy) {
            buddy.atkBoost = Math.max(buddy.atkBoost, st.atkBoost);
            buddy.atkBoostTimer = 20;
            this.addPopup(ALLY_X, ay(130), `与ダメ+${st.atkBoost}%`, 0xff8844);
          }
        } else if (st.kind === 'focus') {
          playSfx('buff');
          // 掛け直しは上書き(重ねがけで際限なく伸びないように)
          this.mpRegenBonus = st.mpRegenBonus;
          this.mpRegenTimer = 20;
          this.addPopup(
            PLAYER_X, cy(136),
            `瞑想 MP回復+${st.mpRegenBonus.toFixed(1)}/秒`, 0x88ccff,
          );
          const buddy = this.sharedAlly(st);
          if (buddy) {
            // お供のMPは自力ではほとんど戻らないので、共鳴はここがいちばん効く
            buddy.mpRegenBonus = st.mpRegenBonus;
            buddy.mpRegenTimer = 20;
            this.addPopup(ALLY_X, ay(136),
              `MP回復+${st.mpRegenBonus.toFixed(1)}/秒`, 0x88ccff);
          }
        } else if (st.kind === 'vigor') {
          // 掛け直しは上書き(重ねがけで無限に増えないように)
          this.maxHp -= this.vigorBonus;
          this.hp = Math.min(this.hp, this.maxHp);
          this.vigorBonus = st.hpBoost;
          this.vigorTimer = 25;
          this.maxHp += this.vigorBonus;
          this.hp += this.vigorBonus;
          this.addPopup(PLAYER_X, cy(122), `最大HP+${st.hpBoost}`, 0xffcc66);
          const buddy = this.sharedAlly(st);
          if (buddy) {
            buddy.applyVigor(st.hpBoost, 25);
            this.addPopup(ALLY_X, ay(122), `最大HP+${st.hpBoost}`, 0xffcc66);
          }
        } else if (st.kind === 'ward') {
          this.ward = {
            attr: st.targetAll ? null : st.attr,
            pct: st.wardPct,
            timer: 12,
          };
          this.addPopup(
            PLAYER_X, cy(115),
            st.targetAll ? `全属性耐性${st.wardPct}%` : `${ELEMENTS[st.attr].name}耐性${st.wardPct}%`,
            0x88ffcc,
          );
          const buddy = this.sharedAlly(st);
          if (buddy) {
            buddy.ward = { attr: null, pct: st.wardPct, timer: 12 };
            this.addPopup(ALLY_X, ay(115), `全属性耐性${st.wardPct}%`, 0x88ffcc);
          }
        } else if (st.quake) {
          this.castQuake(st);
        } else {
          this.firePlayerProj(sp.stats);
        }
        if (this.hp <= 0) { this.hp = 0; this.beginEnd(false, false); }
      }
    }

    // 護盾・耐性の持続時間
    if (this.shieldTimer > 0) {
      this.shieldTimer -= dt;
      if (this.shieldTimer <= 0) this.shield = 0;
    }
    if (this.ward) {
      this.ward.timer -= dt;
      if (this.ward.timer <= 0) this.ward = null;
    }
    if (this.atkBoostTimer > 0) {
      this.atkBoostTimer -= dt;
      if (this.atkBoostTimer <= 0) this.atkBoost = 0;
    }
    if (this.mpRegenTimer > 0) {
      this.mpRegenTimer -= dt;
      if (this.mpRegenTimer <= 0) this.mpRegenBonus = 0;
    }
    if (this.vigorTimer > 0) {
      this.vigorTimer -= dt;
      if (this.vigorTimer <= 0) {
        this.maxHp -= this.vigorBonus;
        this.vigorBonus = 0;
        this.hp = Math.min(this.hp, this.maxHp);
        if (this.hp <= 0) { this.hp = 1; } // バフ切れでは死なない
      }
    }

    // 自分の姿(詠唱中・撃った直後・被弾)
    this.stepPlayerPose(dt);

    // お供AI。撃つと決まったら、プレイヤーと同じ経路で効果を出す。
    this.stepAlly(dt);

    // 敵の行動
    for (const e of this.enemies) {
      if (!e.alive) continue;
      // 浮遊アニメ
      e.cont.y = GROUND_Y + Math.sin(this.time * 2.2 + e.bobPhase) * 3;
      // ポーズはこの下の continue より前に進める。
      // 封印や凍結で抜ける道があるので、後ろに置くとその間だけ姿が固まる。
      this.stepEnemyPose(e, dt);

      // 継続ダメージ(1秒ごと)
      if (e.dotT > 0) {
        e.dotT -= dt;
        e.dotTick += dt;
        if (e.dotTick >= 1) {
          e.dotTick -= 1;
          const d = Math.max(1, Math.round(e.dotDps));
          e.hp -= d;
          this.addPopup(e.x, GROUND_Y + enemyTopY(e.def) - 6, `${d}`, 0x99ee66);
          if (e.hp <= 0) {
            e.alive = false; e.hp = 0;
            this.defeated.push(e.def);
            e.cont.alpha = 0.25; e.hpBar.clear();
            continue;
          }
          this.drawEnemyHpBar(e);
        }
        if (e.dotT <= 0) e.dotDps = 0;
      }

      // 封印(闇の行動不能)
      if (e.sealed > 0) {
        e.sealed -= dt;
        e.body.tint = 0x8855bb;
        continue;
      }
      if (e.flash > 0) {
        e.flash -= dt;
        e.body.alpha = 0.45;
      } else {
        e.body.alpha = 1;
      }
      if (e.frozen > 0) {
        e.frozen -= dt;
        e.body.tint = 0x88ccff;
        continue;
      }
      e.body.tint = 0xffffff;
      if (e.slowTimer > 0) {
        e.slowTimer -= dt;
        if (e.slowTimer <= 0) e.slowPct = 0;
      }
      e.atkTimer += dt / (1 + e.slowPct / 100);
      if (e.atkTimer >= e.interval) {
        e.atkTimer = 0;
        this.setEnemyPose(e, 'release', POSE_RELEASE_SEC);
        this.fireEnemyProj(e);
      }
    }

    // 弾の移動と命中
    for (const p of this.projs) {
      if (p.dead) continue;
      p.x += p.speed * dt;
      p.g.position.set(p.x, p.y);

      // 軌跡(属性色の残光)
      p.trailT -= dt;
      if (p.trailT <= 0) {
        p.trailT = 0.05;
        const tr = new Graphics();
        tr.circle(0, 0, Math.max(2, p.r * 0.5))
          .fill({ color: ELEMENTS[p.attr].color, alpha: 0.45 });
        tr.position.set(p.x, p.y);
        this.fxLayer.addChild(tr);
        this.fxs.push({ g: tr, life: 0.22, maxLife: 0.22 });
      }

      if (p.from === 'player' || p.from === 'ally') {
        for (const e of this.enemies) {
          if (!e.alive || p.hit.has(e)) continue;
          if (Math.abs(p.x - e.x) < 26) {
            p.hit.add(e);
            this.onSpellHit(p, e);
            if (!p.spell!.pierce) { p.dead = true; break; }
          }
        }
        if (p.x > W + 40) p.dead = true;
      } else if (p.at === 'ally') {
        // お供を狙う弾。プレイヤーの横を素通りして後ろまで飛ぶ。
        if (p.x <= ALLY_X + cs(12)) {
          p.dead = true;
          this.onAllyHit(p.dmg!, p.attr);
        }
        if (p.x < -40) p.dead = true;
      } else {
        if (p.x <= PLAYER_X + cs(12)) {
          p.dead = true;
          this.onPlayerHit(p.dmg!, p.attr);
        }
        if (p.x < -40) p.dead = true;
      }
    }
    this.projs = this.projs.filter(p => {
      if (p.dead) { p.g.destroy(); return false; }
      return true;
    });

    this.updateFx(dt);
    this.updatePopups(dt);
    this.updateShake(dt);
    this.drawBars();
    this.updateSpellBar();
    this.updateEnemyStatus();

    // 勝利判定
    if (this.enemies.every(e => !e.alive)) {
      this.beginEnd(true, false);
    }
  }

  private updateShake(dt: number): void {
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.shake > 0) {
      this.shake -= dt * 30;
      this.root!.position.set(
        (Math.random() - 0.5) * this.shake,
        (Math.random() - 0.5) * this.shake,
      );
    } else {
      this.root!.position.set(0, 0);
    }
  }

  private updateFx(dt: number): void {
    this.fxs = this.fxs.filter(fx => {
      fx.life -= dt;
      if (fx.life <= 0) { fx.g.destroy(); return false; }
      fx.g.alpha = fx.life / fx.maxLife;
      if (fx.grow) {
        fx.g.scale.x += 2.2 * dt;
        fx.g.scale.y += 1.2 * dt;
      }
      return true;
    });
  }

  private updatePopups(dt: number): void {
    this.popups = this.popups.filter(p => {
      p.life -= dt;
      if (p.life <= 0) { p.t.destroy(); return false; }
      p.t.y += p.vy * dt;
      p.t.alpha = Math.min(1, p.life / 0.4);
      return true;
    });
  }

  // ===== 弾・命中処理 =====

  // ===== お供AI =====

  // プレイヤーが撃った支援を、お供にも配るか。
  //
  // 配るのは〈全体(targetAll)〉と名の付くものだけ ― 聖域盾・慈雨・
  // 万象護符・鼓舞・戦鼓・魔力共鳴の6系統。単体版は今までどおり自分だけ。
  // 「全体」と名乗る以上、ソロでも隣に立っている者には届くべき、という線引き。
  //
  // お供が倒れていれば誰も居ないのと同じ扱いにする(効果は満額で自分へ)。
  private sharedAlly(st: SpellStats): Ally | null {
    if (!st.targetAll) return null;
    return this.ally && this.ally.alive ? this.ally : null;
  }

  // いまの状況をお供に見せる。お供はこれだけを見て次の手を決める。
  private allySight(): AllySight {
    const a = this.ally!;
    let weak: ElementId | null = null;
    // 弱点(◎○)を突ける属性を1つ探す。複数の敵がいる時は最初に見つけたもの。
    for (const e of this.enemies) {
      if (!e.alive) continue;
      for (const [attr, grade] of Object.entries(e.def.affinity)) {
        if ((grade as number) >= 1) { weak = attr as ElementId; break; }
      }
      if (weak) break;
    }
    return {
      myHpPct: a.hp / a.maxHp,
      playerHpPct: this.hp / this.maxHp,
      myMpPct: a.mp / a.maxMp,
      enemiesAlive: this.enemies.filter(e => e.alive).length,
      shielded: a.shield > 0,
      warded: a.ward !== null,
      empowered: a.atkBoost > 0,
      taunting: a.tauntTimer > 0,
      weakAttr: weak,
    };
  }

  private stepAlly(dt: number): void {
    const a = this.ally;
    if (!a) return;

    // ★ 倒れていても控えは書き出す。
    //   ここを早期returnの後ろに置いていた時は、お供が倒れた瞬間から
    //   控えが止まり、alive=true と死ぬ直前のHPが残り続けた。
    //   強さの測定(ally_power_check)が「お供HP 7」と報告していたのは
    //   その値で、本当は0(倒れている)だった。
    this.noteAllyState();

    if (!a.alive) {
      if (this.allyCont) this.allyCont.alpha = 0.3;
      return;
    }

    const fired = a.step(dt, () => this.allySight());

    // 姿。プレイヤーと同じ決まり(一瞬の姿は残り時間で上書き)。
    if (this.allyPoseT > 0) {
      this.allyPoseT -= dt;
    } else if (this.allyCont) {
      setPlayerSpritePose(this.allyCont, a.charId, a.casting ? 'cast' : 'idle');
    }

    if (!fired) return;
    this.noteAllyCast(fired.role);
    this.applyAllyCast(fired.spell.stats, fired.role);
  }

  // お供が何をしたかの控え。外から覗ける所に置いてある ―
  // Pixi の中身は検証から見えないので、これが唯一の手がかりになる
  // (test/ally_battle_check.ts が window.__allyDebug を読む)。
  private noteAllyCast(role: string): void {
    const d = this.allyDebug();
    d.casted++;
    d.roles.push(role);
  }

  // お供の今の様子。毎フレーム書き出す。
  //
  // 強さの測定(test/ally_power_check.ts)が残りHPを見るのと、
  // 全体魔法がお供に届いたか(test/ally_share_check.ts)を見るのに使う ―
  // Pixi の中身は外から覗けないので、これが唯一の手がかりになる。
  private noteAllyState(): void {
    const a = this.ally;
    const d = this.allyDebug();
    if (!a) return;
    d.hp = Math.round(a.hp);
    d.maxHp = Math.round(a.maxHp);
    d.alive = a.alive;
    d.shield = Math.round(a.shield);
    d.warded = a.ward !== null;
    d.atkBoost = a.atkBoost;
    d.mpRegenBonus = a.mpRegenBonus;
    d.powerMul = a.powerMul;
    d.power0 = Math.round(a.spells[0]?.stats.power ?? 0);
  }

  private allyDebug(): AllyDebug {
    const w = window as unknown as { __allyDebug?: AllyDebug };
    if (!w.__allyDebug) {
      w.__allyDebug = {
        casted: 0, roles: [], hp: ALLY_MAX_HP, maxHp: ALLY_MAX_HP, alive: true,
        shield: 0, warded: false, atkBoost: 0, mpRegenBonus: 0,
        powerMul: 1, power0: 0,
      };
    }
    return w.__allyDebug;
  }

  // お供が撃った魔法を効かせる。
  // 弾・音・ポーズはプレイヤーと同じものを使う(演出を直せば両方に効く)。
  private applyAllyCast(st: SpellStats, role: string): void {
    const a = this.ally!;
    playSfx('cast');
    this.setAllyPose('release', POSE_RELEASE_SEC);

    if (st.selfDamage > 0) {
      a.hp = Math.max(1, a.hp - st.selfDamage);   // 自傷では倒れない
      this.addPopup(ALLY_X, ay(100), `-${st.selfDamage}`, 0xbb77ee);
    }

    if (role === 'taunt') {
      // 挑発は敵の狙いをお供へ集める。ソロのプレイヤーとは効き方が違う
      // (プレイヤーは一人なので護盾に変えているが、お供は本来の意味で働く)。
      this.addPopup(ALLY_X, ay(115), '咆哮!', 0xffaa66);
      return;
    }
    if (st.kind === 'shield') {
      playSfx('shield');
      a.shield = Math.max(a.shield, st.barrier);
      a.shieldTimer = 10;
      this.addPopup(ALLY_X, ay(115), `護盾+${st.barrier}`, 0x88ccff);
      return;
    }
    if (st.kind === 'ward') {
      a.ward = { attr: st.targetAll ? null : st.attr, pct: st.wardPct, timer: 12 };
      this.addPopup(ALLY_X, ay(115), `耐性${st.wardPct}%`, 0xaaddff);
      return;
    }
    if (st.kind === 'heal') {
      playSfx('heal');
      // 減っているほうを癒す。両方減っていればプレイヤーを優先する
      // (プレイヤーが倒れたらその場で終わるため)。
      const playerLack = this.maxHp - this.hp;
      const allyLack = a.maxHp - a.hp;
      const power = Math.round(st.healPower * ALLY_HEAL_MUL);   // お供の癒しは控えめ
      if (playerLack >= allyLack) {
        const healed = Math.min(playerLack, power);
        this.hp += healed;
        this.addPopup(PLAYER_X, cy(115), `+${healed}`, 0x88ddaa);
      } else {
        const healed = a.heal(power);
        this.addPopup(ALLY_X, ay(115), `+${healed}`, 0x88ddaa);
      }
      return;
    }
    if (st.kind === 'empower') {
      // 鼓舞は二人ぶんに効かせる(共闘でも全員に掛かる)
      playSfx('buff');
      this.atkBoost = Math.max(this.atkBoost, st.atkBoost);
      this.atkBoostTimer = 15;
      a.atkBoost = Math.max(a.atkBoost, st.atkBoost);
      a.atkBoostTimer = 15;
      this.addPopup(ALLY_X, ay(115), `与ダメ+${st.atkBoost}%`, 0xffcc66);
      return;
    }
    if (st.kind === 'focus') {
      a.mpRegenBonus = Math.max(a.mpRegenBonus, st.mpRegenBonus);
      a.mpRegenTimer = 15;
      this.addPopup(ALLY_X, ay(115), `MP回復+${st.mpRegenBonus}`, 0x99ccff);
      return;
    }
    if (st.kind === 'vigor') {
      a.applyVigor(st.hpBoost, 25);   // 掛け直しは上書き(際限なく伸びない)
      this.addPopup(ALLY_X, ay(115), `最大HP+${st.hpBoost}`, 0xffaacc);
      return;
    }
    if (st.kind === 'seal') {
      let sealed = 0;
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const g = (e.def.affinity[st.attr] ?? 0) as AffinityGrade;
        // お供の封印は人の半分しか続かない。ここを人と同じにしていた時は、
        // 蒼氷が敵を止め続けて、プレイヤーが何もしなくても勝ってしまった。
        const sec = st.sealTime * sealResistMul(g) * ALLY_SEAL_MUL;
        if (sec <= 0) continue;
        e.sealed = Math.max(e.sealed, sec);
        sealed++;
      }
      this.addPopup(ALLY_X, ay(115), sealed > 0 ? `封印 ${sealed}体` : '効かない',
        sealed > 0 ? 0xcc99ff : 0x888899);
      return;
    }
    if (st.quake) {
      // 地震は弾を飛ばさず全体を叩く。プレイヤーと同じ扱い。
      this.shake = 14;
      playSfx('quake');
      for (const e of this.enemies) {
        if (e.alive) this.dealDamage(e, st, 0.75, a.atkBoost, true);
      }
      return;
    }
    this.fireAllyProj(st);
  }

  private fireAllyProj(st: SpellStats): void {
    const r = 5 + Math.min(10, st.power / 25);
    const g = makeProjectileGfx(st.attr, st.power);
    const y = ay(58);
    g.position.set(ALLY_X + cs(30), y);
    this.projLayer.addChild(g);
    this.projs.push({
      g, x: ALLY_X + cs(30), y, speed: st.projSpeed,
      from: 'ally', spell: st, attr: st.attr, r, trailT: 0,
      hit: new Set(), dead: false,
    });
  }

  private setAllyPose(pose: Pose, sec: number): void {
    this.allyPoseT = sec;
    if (this.allyCont && this.ally) {
      setPlayerSpritePose(this.allyCont, this.ally.charId, pose);
    }
  }

  private firePlayerProj(st: SpellStats): void {
    const r = 5 + Math.min(10, st.power / 25);
    const g = makeProjectileGfx(st.attr, st.power);
    const y = cy(64);
    g.position.set(PLAYER_X + cs(34), y);
    this.projLayer.addChild(g);
    this.projs.push({
      g, x: PLAYER_X + cs(34), y, speed: st.projSpeed,
      from: 'player', spell: st, attr: st.attr, r, trailT: 0,
      hit: new Set(), dead: false,
    });
  }

  // 地震: 弾を飛ばさず敵全体にダメージ+画面と大地を揺らす
  // ---- ポーズ(見た目だけ) ----
  //
  // 一瞬で終わるもの(撃った・被弾)は残り時間で上書きし、
  // 切れたら「詠唱中か、そうでないか」に戻す。
  // 共闘・決闘はサーバーが同じ考え方で決めて全員に配る。

  private setPlayerPose(pose: Pose, sec: number): void {
    this.poseT = sec;
    setPlayerSpritePose(this.playerCont, state.charId, pose);
  }

  private stepPlayerPose(dt: number): void {
    if (this.poseT > 0) {
      this.poseT -= dt;
      if (this.poseT > 0) return;
    }
    setPlayerSpritePose(this.playerCont, state.charId,
      this.casting ? 'cast' : 'idle');
  }

  private setEnemyPose(e: EnemyUnit, pose: Pose, sec: number): void {
    e.pose = pose;
    e.poseT = sec;
    setEnemySpritePose(e.body, e.def, pose);
  }

  private stepEnemyPose(e: EnemyUnit, dt: number): void {
    if (e.poseT > 0) {
      e.poseT -= dt;
      if (e.poseT > 0) return;
    }
    if (e.pose !== 'idle') {
      e.pose = 'idle';
      setEnemySpritePose(e.body, e.def, 'idle');
    }
  }

  private castQuake(st: SpellStats): void {
    this.shake = 18;
    playSfx('quake');
    for (let k = 0; k < 3; k++) {
      const fx = new Graphics();
      fx.ellipse(0, 0, 60 + k * 45, 10 + k * 5)
        .stroke({ width: 3, color: 0xcc9955, alpha: 0.85 });
      fx.position.set(W / 2 + 120, GROUND_Y + 8);
      this.fxLayer.addChild(fx);
      this.fxs.push({ g: fx, life: 0.5 + k * 0.15, maxLife: 0.5 + k * 0.15, grow: true });
    }
    for (const e of this.enemies) {
      if (e.alive) this.dealDamage(e, st, 0.75);
    }
  }

  private fireEnemyProj(e: EnemyUnit): void {
    playSfx('enemyCast');
    const attr = e.def.attackAttr;
    const g = makeProjectileGfx(attr, 14);
    const y = GROUND_Y + enemyTopY(e.def) * 0.55;
    g.position.set(e.x - 20, y);
    this.projLayer.addChild(g);
    const dmg = Math.round(
      e.def.atk * ENEMY_ATK_MUL * stageAtkMul(this.stage) * (0.9 + Math.random() * 0.2),
    );
    // 誰を狙うか。お供が居れば一定の割合で引き受け、
    // 挑発を撃った直後はその割合が跳ね上がる。
    const share = this.ally
      ? this.ally.hateShare(ALLY_HATE_SHARE, ALLY_TAUNT_SHARE) : 0;
    const at: 'player' | 'ally' = Math.random() < share ? 'ally' : 'player';
    this.projs.push({
      g, x: e.x - 20, y, speed: -230,
      from: 'enemy', at, dmg, attr, r: 6, trailT: 0,
      hit: new Set(), dead: false,
    });
  }

  private onSpellHit(p: Proj, target: EnemyUnit): void {
    const st = p.spell!;
    // 与ダメ上昇は撃った本人のものを使う(プレイヤーとお供で別々に持っている)
    const byAlly = p.from === 'ally';
    const boost = byAlly ? (this.ally?.atkBoost ?? 0) : this.atkBoost;
    this.dealDamage(target, st, 1.0, boost, byAlly);

    // 爆発(範囲)
    if (st.radius > 0) {
      const fx = new Graphics();
      fx.circle(0, 0, st.radius).fill({ color: ELEMENTS[st.attr].color, alpha: 0.4 });
      fx.position.set(target.x, cy(30));
      this.fxLayer.addChild(fx);
      this.fxs.push({ g: fx, life: 0.35, maxLife: 0.35 });
      for (const e of this.enemies) {
        if (!e.alive || e === target || p.hit.has(e)) continue;
        if (Math.abs(e.x - target.x) <= st.radius) {
          p.hit.add(e);
          this.dealDamage(e, st, 0.7, boost, byAlly);
        }
      }
    }

    // 連鎖
    if (st.chain > 0) {
      const others = this.enemies
        .filter(e => e.alive && e !== target)
        .sort((a, b) => Math.abs(a.x - target.x) - Math.abs(b.x - target.x))
        .slice(0, st.chain);
      let fromX = target.x;
      const fromY = cy(40);
      for (const e of others) {
        const zap = new Graphics();
        zap.moveTo(fromX, fromY)
          .lineTo((fromX + e.x) / 2, fromY - 30)
          .lineTo(e.x, cy(40))
          .stroke({ width: 3, color: 0xffee66 });
        this.fxLayer.addChild(zap);
        this.fxs.push({ g: zap, life: 0.25, maxLife: 0.25 });
        this.dealDamage(e, st, 0.6, boost, byAlly);
        fromX = e.x;
      }
    }
  }

  // boost は「撃った本人の与ダメ上昇」。省くとプレイヤーのものを使う。
  // お供の戦鼓とプレイヤーの戦鼓は別々に持っているので、ここで取り違えると
  // 片方だけ掛かっている時に数字が合わなくなる。
  //
  // byAlly はお供が撃ったかどうか。お供の一撃は ALLY_DMG_MUL ぶん軽い ―
  // 継続ダメージにも同じだけ掛ける(ここを忘れると延焼だけ手加減が効かない)。
  private dealDamage(
    e: EnemyUnit, st: SpellStats, mul: number, boost?: number, byAlly = false,
  ): void {
    const bst = boost ?? this.atkBoost;
    const hand = byAlly ? ALLY_DMG_MUL : 1;
    let dmg = st.power * mul * hand * (0.9 + Math.random() * 0.2) * (1 + bst / 100);
    // 継続ダメージを付与(上書き)
    if (st.dotTime > 0 && st.dotDps > 0) {
      e.dotDps = st.dotDps * hand * (1 + bst / 100);
      e.dotT = st.dotTime;
      e.dotTick = 0;
    }
    const grade = (e.def.affinity[st.attr] ?? 0) as AffinityGrade;
    dmg *= affinityMul(grade);
    let effNote = '';
    if (grade === 2) effNote = ' 大弱点!!';
    else if (grade === 1) effNote = ' 弱点!';
    else if (grade === -1) effNote = ' 耐性…';
    else if (grade === -2) effNote = ' ほぼ無効…';
    const crit = Math.random() * 100 < st.critRate;
    if (crit) dmg *= 2;
    const final = Math.max(1, Math.round(dmg));

    e.hp -= final;
    e.flash = 0.15;
    this.setEnemyPose(e, 'hurt', POSE_HURT_SEC);
    playSfx(crit ? 'crit' : 'hit');
    // 着弾リング(属性色)
    const ring = new Graphics();
    ring.circle(0, 0, 10).stroke({ width: 3, color: ELEMENTS[st.attr].color, alpha: 0.9 });
    ring.position.set(e.x, cy(40 * e.def.size));
    this.fxLayer.addChild(ring);
    this.fxs.push({ g: ring, life: 0.25, maxLife: 0.25, grow: true });
    const color = crit ? 0xffdd44 : (grade > 0 ? 0xff8855 : (grade < 0 ? 0x8899bb : 0xffffff));
    this.addPopup(
      e.x, GROUND_Y + enemyTopY(e.def) - 22,
      `${final}${crit ? ' 会心!' : ''}${effNote}`, color,
    );

    if (st.freeze > 0) e.frozen = Math.max(e.frozen, st.freeze);
    if (st.slow > 0) { e.slowPct = Math.max(e.slowPct, st.slow); e.slowTimer = 4; }

    if (st.lifesteal > 0) {
      const heal = Math.round(final * st.lifesteal / 100);
      if (heal > 0) {
        this.hp = Math.min(this.maxHp, this.hp + heal);
        this.addPopup(PLAYER_X, cy(110), `+${heal}`, 0x88ddaa);
      }
    }

    if (e.hp <= 0 && e.alive) {
      e.alive = false;
      e.hp = 0;
      playSfx('defeat');
      this.defeated.push(e.def);
      e.cont.alpha = 0.25;
      e.hpBar.clear();
    } else {
      this.drawEnemyHpBar(e);
    }
  }

  private onPlayerHit(dmg: number, attr?: ElementId): void {
    if (this.endResult !== null) return;
    // 属性耐性で軽減
    if (this.ward && (this.ward.attr === null || this.ward.attr === attr)) {
      const before = dmg;
      dmg = Math.max(1, Math.round(dmg * (1 - this.ward.pct / 100)));
      if (before > dmg) {
        this.addPopup(PLAYER_X, cy(128), `耐性 -${before - dmg}`, 0x88ffcc);
      }
    }
    // 護盾が先にダメージを受け止める
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
      this.addPopup(PLAYER_X, cy(115), `盾-${absorbed}`, 0x88ccff);
      if (dmg <= 0) { this.shake = 3; return; }
    }
    this.hp -= dmg;
    this.shake = 8;
    this.hitFlash = 0.2;
    this.setPlayerPose('hurt', POSE_HURT_SEC);
    playSfx('damage');
    this.addPopup(PLAYER_X, cy(100), `-${dmg}`, 0xff7755);
    if (this.hp <= 0) {
      this.hp = 0;
      this.beginEnd(false, false);
    }
  }

  // お供が殴られた時。プレイヤーと同じ見せ方をする。
  private onAllyHit(dmg: number, attr: ElementId): void {
    const a = this.ally;
    if (!a || !a.alive) return;
    const r = a.takeHit(dmg, attr);
    if (r.absorbed > 0) {
      this.addPopup(ALLY_X, ay(115), `盾-${r.absorbed}`, 0x88ccff);
    }
    if (r.dealt > 0) {
      playSfx('damage');
      this.setAllyPose('hurt', POSE_HURT_SEC);
      this.addPopup(ALLY_X, ay(100), `-${r.dealt}`, 0xff7755);
    }
    if (r.died) {
      // 倒れたら二度と起き上がらない。守る理由を作るため。
      playSfx('defeat');
      this.addPopup(ALLY_X, ay(125), '倒れた…', 0xff9977);
      if (this.allyCont) this.allyCont.alpha = 0.3;
    }
  }

  private addPopup(x: number, y: number, text: string, color: number): void {
    const t = new Text({
      text,
      style: {
        fill: color, fontSize: 16, fontFamily: 'Meiryo, sans-serif', fontWeight: 'bold',
        stroke: { color: 0x000000, width: 3 },
      },
    });
    t.anchor.set(0.5);
    t.position.set(x + (Math.random() - 0.5) * 20, y);
    this.uiLayer.addChild(t);
    this.popups.push({ t, vy: -40, life: 0.9 });
  }

  // ===== 描画(毎フレーム) =====

  private drawEnemyHpBar(e: EnemyUnit): void {
    const w = 56;
    const top = enemyTopY(e.def) - 14;
    e.hpBar.clear();
    e.hpBar.rect(-w / 2, top, w, 7).fill(0x222238);
    e.hpBar.rect(-w / 2, top, w * (e.hp / e.maxHp), 7).fill(0xdd5566);
  }

  private drawBars(): void {
    const g = this.barsG;
    g.clear();
    // HP
    g.rect(16, 16, 220, 16).fill(0x222238);
    g.rect(16, 16, 220 * (this.hp / this.maxHp), 16).fill(0x55cc66);
    // MP
    g.rect(16, 38, 220, 12).fill(0x222238);
    g.rect(16, 38, 220 * (this.mp / this.maxMp), 12).fill(0x5588ee);
    // 護盾(HPバーの上に水色の細バー+プレイヤーを囲む障壁)
    if (this.shield > 0) {
      g.rect(16, 10, 220 * Math.min(1, this.shield / this.maxHp), 4).fill(0x88ccff);
      g.circle(PLAYER_X, cy(50), cs(52))
        .stroke({ width: 3, color: 0x88ccff, alpha: 0.35 + 0.15 * Math.sin(this.time * 6) });
    }
    // お供のHP/MPと詠唱。プレイヤーの数字(y=64)の下に小さく並べる。
    // ★ 最初 y=56 に置いたら「HP 260/260 MP 150/150」の文字と重なった。
    //   プレイヤーの表示より下から始めること。
    const a = this.ally;
    if (a) {
      g.rect(16, 84, 150, 10).fill(0x222238);
      g.rect(16, 84, 150 * (a.hp / a.maxHp), 10)
        .fill(a.alive ? 0x55cc66 : 0x664444);
      g.rect(16, 96, 150, 7).fill(0x222238);
      g.rect(16, 96, 150 * (a.mp / a.maxMp), 7).fill(0x5588ee);
      if (a.shield > 0) {
        g.rect(16, 79, 150 * Math.min(1, a.shield / a.maxHp), 3).fill(0x88ccff);
        g.circle(ALLY_X, ay(46), cs(46))
          .stroke({ width: 2, color: 0x88ccff, alpha: 0.3 + 0.15 * Math.sin(this.time * 6) });
      }
      // 挑発中は光らせる。なぜ敵がお供を狙っているのかが伝わる。
      if (a.tauntTimer > 0) {
        g.circle(ALLY_X, ay(46), cs(50))
          .stroke({ width: 3, color: 0xffaa66, alpha: 0.45 + 0.2 * Math.sin(this.time * 9) });
      }
      // お供の詠唱バー。人間の共闘と同じく、何かしているのが見える。
      if (a.casting) {
        const ast = a.casting.spell.stats;
        const ap = Math.min(1, a.casting.t / ast.castTime);
        g.rect(ALLY_X - cs(32), ay(118), cs(64), 6).fill(0x222238);
        g.rect(ALLY_X - cs(32), ay(118), cs(64) * ap, 6).fill(0xffdd66);
        g.circle(ALLY_X + cs(26), ay(60), cs(3 + ap * 8))
          .fill({ color: ELEMENTS[ast.attr].color, alpha: 0.5 });
      }
    }

    // 詠唱バー+杖先の属性グロー
    if (this.casting) {
      const st = this.casting.spell.stats;
      const p = Math.min(1, this.casting.t / st.castTime);
      g.rect(PLAYER_X - cs(40), cy(130), cs(80), 8).fill(0x222238);
      g.rect(PLAYER_X - cs(40), cy(130), cs(80) * p, 8).fill(0xffdd66);
      g.circle(PLAYER_X + cs(29), cy(67), cs(4 + p * 11))
        .fill({ color: ELEMENTS[st.attr].color, alpha: 0.5 });
    }
    // 被弾フラッシュ
    if (this.hitFlash > 0) {
      g.rect(0, 0, W, H).fill({ color: 0xff3333, alpha: this.hitFlash * 0.8 });
    }
    this.infoText.text =
      `HP ${Math.ceil(this.hp)}/${this.maxHp}   MP ${Math.floor(this.mp)}/${this.maxMp}`;

    // お供の数字。誰のバーか分かるよう名前を添える。
    if (this.ally) {
      const a2 = this.ally;
      this.allyText.visible = true;
      this.allyText.text = a2.alive
        ? `${characterName(a2.charId)}  HP ${Math.ceil(a2.hp)}/${a2.maxHp}`
          + `  MP ${Math.floor(a2.mp)}/${a2.maxMp}`
        : `${characterName(a2.charId)}  倒れた`;
      this.allyText.style.fill = a2.alive ? 0x88aa99 : 0x996666;
    } else {
      this.allyText.visible = false;
    }
  }

  // ===== 終了処理 =====

  private beginEnd(win: boolean, escaped: boolean): void {
    if (this.endResult !== null) return;
    this.endResult = { win, escaped };
    stopSfxLoop('casting');
    playSfx(escaped ? 'escape' : (win ? 'win' : 'lose'));
    this.endTimer = win ? 0.8 : 0.6;
    this.casting = null;
    this.updateSpellBar();
  }

  private finish(): void {
    const { win, escaped } = this.endResult!;
    this.active = false;
    this.endResult = null;

    // ソロ戦ではエレメントは手に入らない(研究Pのみ)
    const drops: ElementId[] = [];
    const rp = battleRP(this.stage, win, escaped);

    const result: BattleResult = { win, escaped, stage: this.stage, drops, rp };
    this.onEnd?.(result);
  }
}

// 属性ごとに形の違う弾を生成(プレイヤー・敵共用)
export function makeProjectileGfx(attr: ElementId, power: number): Container {
  const r = 5 + Math.min(10, power / 25);
  // 画像素材があればそれを使う
  const art = projectileArt(attr, (r + 6) * 2);
  if (art) return art;
  const g = new Graphics();
  const color = ELEMENTS[attr].color;
  switch (attr) {
    case 'fire': // 火球(芯が白熱)
      g.circle(0, 0, r + 5).fill({ color, alpha: 0.25 });
      g.circle(0, 0, r).fill(color);
      g.circle(2, -1, r * 0.45).fill(0xffeeaa);
      break;
    case 'water': // 水滴
      g.ellipse(0, 0, r + 3, r * 0.7).fill({ color, alpha: 0.9 });
      g.ellipse(-2, -2, (r + 3) * 0.4, r * 0.3).fill(0xddffff);
      break;
    case 'wind': // 風の刃
      g.ellipse(0, 0, r + 6, r * 0.45).fill({ color, alpha: 0.7 });
      g.ellipse(-4, 0, r + 2, r * 0.3).fill({ color: 0xffffff, alpha: 0.5 });
      break;
    case 'earth': // 岩塊
      g.poly([
        -r, 0, -r * 0.4, -r, r * 0.6, -r * 0.8,
        r, 0, r * 0.5, r * 0.9, -r * 0.5, r * 0.8,
      ]).fill(color);
      g.poly([-r * 0.3, -r * 0.4, r * 0.3, -r * 0.5, r * 0.2, 0]).fill(0xeebb77);
      break;
    case 'thunder': // 稲妻
      g.poly([-r - 5, -2, 0, -2, -2, -r - 2, r + 5, 2, 0, 2, 2, r + 2]).fill(color);
      break;
    case 'ice': // 氷晶
      g.poly([0, -r - 3, r * 0.7, 0, 0, r + 3, -r * 0.7, 0]).fill(color);
      g.poly([0, -r, r * 0.4, 0, 0, r, -r * 0.4, 0]).fill(0xffffff);
      break;
    case 'light': // 光星
      g.poly([
        0, -r - 4, r * 0.35, -r * 0.35, r + 4, 0, r * 0.35, r * 0.35,
        0, r + 4, -r * 0.35, r * 0.35, -r - 4, 0, -r * 0.35, -r * 0.35,
      ]).fill(color);
      break;
    default: // 闇球(暗い芯+紫の輪)
      g.circle(0, 0, r + 6).stroke({ width: 2, color: 0x6633aa, alpha: 0.8 });
      g.circle(0, 0, r).fill(0x221133);
      g.circle(0, 0, r * 0.55).fill(color);
      break;
  }
  return g;
}

// ===== プレースホルダー描画(将来ここを画像Spriteに差し替える) =====

// charId = 選んだキャラクター。共闘/決闘では相手の番号を渡す。
export function makePlayerSprite(charId = 0): Container {
  const c = new Container();
  // 画像素材があればそれを使う(無ければ従来の図形)
  const art = playerArt(cs(100), charId);
  if (art) {
    c.addChild(art);
    return c;
  }
  const g = new Graphics();
  // ローブ
  g.poly([-20, 0, 20, 0, 7, -48, -7, -48]).fill(0x5533aa);
  // 顔
  g.circle(0, -56, 11).fill(0xffddbb);
  // 帽子
  g.poly([-16, -62, 16, -62, 0, -92]).fill(0x7744cc);
  g.ellipse(0, -62, 18, 4).fill(0x7744cc);
  // 杖
  g.moveTo(15, -8).lineTo(28, -62).stroke({ width: 3, color: 0xaa8855 });
  g.circle(29, -67, 6).fill(0x88eeff);
  g.circle(29, -67, 9).fill({ color: 0x88eeff, alpha: 0.25 });
  g.scale.set(SPRITE_SCALE); // 図形描画のときも画像と同じ大きさに揃える
  c.addChild(g);
  return c;
}

// ===== ポーズの差し替え =====
//
// 絵が無い環境(図形描画)では何もしない。図形で4ポーズを描き分けるのは
// 割に合わないので、ポーズは画像素材がある時だけの表現にしてある。
//
// ソロ・共闘・決闘の3画面から同じ関数を呼ぶ。高さの決め方(キャラごとの倍率、
// 敵ごとの大きさ)がここにしか無いため、ここに置いて共有する。

export function setPlayerSpritePose(
  cont: Container, charId: number, pose: Pose,
): void {
  const sp = cont.children[0];
  if (!(sp instanceof Sprite)) return;
  applyPoseTexture(sp, playerPoseTexture(charId, pose),
    cs(100) * characterScale(charId));
}

export function setEnemySpritePose(
  body: Graphics | Sprite, def: EnemyDef, pose: Pose,
): void {
  if (!(body instanceof Sprite)) return;
  applyPoseTexture(body, enemyPoseTexture(def.shape, pose),
    Math.abs(enemyTopY(def)));
}

export function makeEnemySprite(def: EnemyDef): { cont: Container; body: Graphics | Sprite } {
  const cont = new Container();
  // 画像素材があればそれを使う(bodyは凍結時に色を変える対象。Spriteでもtintが効く)
  const art = enemyArt(def.shape, Math.abs(enemyTopY(def)));
  if (art) {
    cont.addChild(art);
    return { cont, body: art };
  }
  const body = new Graphics();
  const c = def.color;
  switch (def.shape) {
    case 'blob': // ぷるぷるした不定形
      body.ellipse(0, -16, 22, 17).fill(c);
      body.ellipse(-6, -22, 7, 4).fill({ color: 0xffffff, alpha: 0.35 });
      body.circle(-7, -20, 3).fill(0x113311);
      body.circle(7, -20, 3).fill(0x113311);
      break;
    case 'imp': // 角の生えた小鬼
      body.poly([-15, 0, 15, 0, 0, -38]).fill(c);
      body.poly([-8, -34, -14, -46, -4, -38]).fill(c);
      body.poly([8, -34, 14, -46, 4, -38]).fill(c);
      body.circle(-4, -22, 2.5).fill(0x330011);
      body.circle(4, -22, 2.5).fill(0x330011);
      break;
    case 'golem': // 岩の巨体
      body.roundRect(-19, -42, 38, 42, 6).fill(c);
      body.roundRect(-13, -56, 26, 18, 4).fill(c);
      body.circle(0, -48, 4).fill(0xffdd44);
      body.rect(-19, -26, 38, 3).fill({ color: 0x000000, alpha: 0.25 });
      break;
    case 'wisp': // 漂う光球
      body.circle(0, -24, 18).fill({ color: c, alpha: 0.3 });
      body.circle(0, -24, 11).fill(c);
      body.circle(0, -24, 4).fill(0xffffff);
      break;
    case 'orb': // 魔導核(ボス)
      body.circle(0, -34, 30).fill({ color: c, alpha: 0.35 });
      body.circle(0, -34, 22).fill(c);
      body.circle(0, -34, 26).stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
      body.circle(0, -34, 8).fill(0xffffff);
      break;
    case 'beast': // 四足獣
      body.ellipse(0, -22, 24, 14).fill(c);
      body.circle(-17, -30, 10).fill(c);
      body.poly([-24, -36, -20, -46, -14, -36]).fill(c);
      body.poly([-12, -36, -8, -45, -4, -36]).fill(c);
      body.rect(-16, -10, 5, 10).fill(c);
      body.rect(10, -10, 5, 10).fill(c);
      body.poly([22, -26, 34, -34, 24, -20]).fill(c);
      body.circle(-20, -31, 2.5).fill(0x221100);
      break;
    case 'bird': // 翼を広げた鳥
      body.ellipse(0, -30, 12, 16).fill(c);
      body.poly([-10, -34, -34, -46, -8, -24]).fill({ color: c, alpha: 0.85 });
      body.poly([10, -34, 34, -46, 8, -24]).fill({ color: c, alpha: 0.85 });
      body.poly([0, -46, 8, -38, -8, -38]).fill(c);
      body.poly([0, -40, 10, -36, 0, -34]).fill(0xffaa33);
      body.circle(-3, -40, 2).fill(0x221100);
      break;
    case 'plant': // 花・樹木
      body.rect(-4, -30, 8, 30).fill(0x66884a);
      body.poly([-4, -18, -22, -26, -4, -12]).fill(0x77aa55);
      body.poly([4, -20, 22, -28, 4, -14]).fill(0x77aa55);
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * 2 * i) / 6;
        body.ellipse(Math.cos(a) * 13, -40 + Math.sin(a) * 13, 8, 6).fill(c);
      }
      body.circle(0, -40, 7).fill(0xffdd66);
      break;
    case 'undead': // 骸骨
      body.rect(-3, -34, 6, 34).fill(0xddddcc);
      body.rect(-14, -30, 28, 4).fill(0xddddcc);
      body.circle(0, -46, 12).fill(c);
      body.circle(-4, -48, 3).fill(0x110000);
      body.circle(4, -48, 3).fill(0x110000);
      body.rect(-5, -40, 10, 3).fill(0x110000);
      break;
    case 'knight': // 鎧の戦士
      body.poly([-16, 0, 16, 0, 12, -40, -12, -40]).fill(c);
      body.rect(-20, -40, 40, 6).fill(c);
      body.circle(0, -50, 11).fill(c);
      body.rect(-8, -52, 16, 4).fill(0x221100);
      body.poly([-2, -62, 2, -62, 0, -74]).fill(0xffdd66);
      body.rect(18, -44, 4, 44).fill(0xaaaacc);
      body.poly([16, -44, 24, -44, 20, -62]).fill(0xccccee);
      break;
    case 'serpent': // 蛇・竜
      body.ellipse(0, -20, 26, 12).fill(c);
      body.ellipse(-20, -34, 14, 10).fill(c);
      body.poly([-30, -40, -24, -52, -18, -38]).fill(c);
      body.poly([8, -28, 24, -50, 14, -24]).fill({ color: c, alpha: 0.8 });
      body.poly([20, -20, 38, -14, 20, -12]).fill(c);
      body.circle(-24, -35, 2.5).fill(0xffee00);
      break;
    case 'insect': // 多脚の虫
      body.ellipse(0, -18, 16, 12).fill(c);
      body.circle(-12, -22, 8).fill(c);
      for (let i = 0; i < 3; i++) {
        body.moveTo(-4 + i * 7, -14).lineTo(-12 + i * 9, 0).stroke({ width: 2, color: c });
        body.moveTo(-4 + i * 7, -22).lineTo(-12 + i * 9, -34).stroke({ width: 2, color: c });
      }
      body.circle(-15, -24, 2.5).fill(0xff3333);
      body.circle(-9, -25, 2.5).fill(0xff3333);
      break;
    case 'eye': // 単眼の異形
      body.circle(0, -26, 20).fill(c);
      body.circle(0, -26, 12).fill(0xffffff);
      body.circle(0, -26, 6).fill(0x110011);
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8;
        body.moveTo(Math.cos(a) * 20, -26 + Math.sin(a) * 20)
          .lineTo(Math.cos(a) * 30, -26 + Math.sin(a) * 30)
          .stroke({ width: 2, color: c });
      }
      break;
    default: // fish
      body.ellipse(0, -20, 20, 12).fill(c);
      body.poly([18, -20, 32, -30, 32, -10]).fill(c);
      body.poly([-4, -30, 4, -30, 0, -40]).fill({ color: c, alpha: 0.85 });
      body.circle(-11, -23, 3).fill(0xffffff);
      body.circle(-11, -23, 1.5).fill(0x110011);
      break;
  }
  // 図形描画も画像と同じ大きさに揃える(片方だけ小さいと差し替え時に破綻する)
  body.scale.set(def.size * SPRITE_SCALE * ENEMY_SCALE);
  cont.addChild(body);
  return { cont, body };
}

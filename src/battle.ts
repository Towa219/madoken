// 戦闘シーン(PixiJS・横視点・セミリアルタイム詠唱+クールダウン制)
//
// ※キャラの見た目は makePlayerSprite / makeEnemySprite に分離してある。
//   将来 assets/ の画像(Sprite)に差し替える場合はこの2関数だけ変更すればよい。

import { Application, Container, Graphics, Text } from 'pixi.js';
import {
  affinityMul, affinitySymbol, BOSS, ELEMENTS, ELEMENT_ORDER, ENEMIES,
  stageAtkMul, stageHpMul,
} from '../shared/data';
import type { AffinityGrade, EnemyDef } from '../shared/data';
import { spellCooldown, spellDisplayName } from '../shared/spellcraft';
import type { BattleResult, ElementId, Spell, SpellStats } from '../shared/types';

const W = 960;
const H = 540;
const GROUND_Y = 460;
const PLAYER_X = 140;

interface EnemyUnit {
  def: EnemyDef;
  hp: number;
  maxHp: number;
  x: number;
  cont: Container;
  body: Graphics;
  hpBar: Graphics;
  atkTimer: number;
  interval: number;
  frozen: number;
  slowPct: number;
  slowTimer: number;
  alive: boolean;
  flash: number;
  bobPhase: number;
}

interface Proj {
  g: Graphics;
  x: number;
  y: number;
  speed: number;      // 右向き正
  from: 'player' | 'enemy';
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

  private maxHp = 120;
  private hp = 120;
  private maxMp = 100;
  private mp = 100;
  private mpRegen = 5;
  private shield = 0;
  private shieldTimer = 0;

  private casting: { spell: Spell; t: number } | null = null;
  private cooldowns = new Map<string, number>();

  private playerCont!: Container;
  private barsG!: Graphics;
  private stageText!: Text;
  private infoText!: Text;
  private shake = 0;
  private hitFlash = 0;
  private time = 0;
  private defeated: EnemyDef[] = [];

  private spellBtns: HTMLButtonElement[] = [];

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
    onEnd: (r: BattleResult) => void,
  ): Promise<void> {
    await this.ensureApp(mount);
    this.stage = stage;
    this.spells = spells;
    this.onEnd = onEnd;

    this.hp = this.maxHp;
    this.mp = this.maxMp;
    this.shield = 0;
    this.shieldTimer = 0;
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
      card.innerHTML =
        `<div class="ecard-head"><span class="ecard-name">${e.def.name}</span>` +
        `<span class="ecard-hp"></span></div>` +
        `<div class="ecard-hpbar"><div class="ecard-hpfill"></div></div>` +
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

    // 背景
    const bg = new Graphics();
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

    this.entityLayer = new Container();
    this.projLayer = new Container();
    this.fxLayer = new Container();
    this.uiLayer = new Container();
    root.addChild(this.entityLayer, this.projLayer, this.fxLayer, this.uiLayer);

    // プレイヤー
    this.playerCont = makePlayerSprite();
    this.playerCont.position.set(PLAYER_X, GROUND_Y);
    this.entityLayer.addChild(this.playerCont);

    // 敵配置
    const defs = this.pickEnemies();
    const xs = defs.length === 1 ? [770]
      : defs.length === 2 ? [690, 860]
      : [630, 755, 875];
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
      nameT.position.set(0, -70 * def.size - 26);
      cont.addChild(nameT);

      const hpMul = stageHpMul(this.stage);
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
  }

  private pickEnemies(): EnemyDef[] {
    if (this.stage % 5 === 0) return [BOSS];
    const count = Math.min(3, 1 + Math.floor((this.stage - 1) / 2));
    const defs: EnemyDef[] = [];
    for (let i = 0; i < count; i++) {
      defs.push(ENEMIES[Math.floor(Math.random() * ENEMIES.length)]);
    }
    return defs;
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
      b.addEventListener('click', () => this.tryCast(i));
      bar.appendChild(b);
      this.spellBtns.push(b);
    });
    const esc = document.createElement('button');
    esc.id = 'btn-escape';
    esc.textContent = '撤退';
    esc.addEventListener('click', () => {
      if (this.active && this.endResult === null) this.beginEnd(false, true);
    });
    bar.appendChild(esc);
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
        !!this.casting || cd > 0 || this.mp < sp.stats.manaCost || this.endResult !== null;
    });
  }

  tryCast(i: number): void {
    if (!this.active || this.endResult !== null) return;
    const sp = this.spells[i];
    if (!sp) return;
    if (this.casting) return;
    if ((this.cooldowns.get(sp.id) ?? 0) > 0) return;
    if (this.mp < sp.stats.manaCost) return;
    this.mp -= sp.stats.manaCost;
    this.casting = { spell: sp, t: 0 };
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

    // MP回復
    this.mp = Math.min(this.maxMp, this.mp + this.mpRegen * dt);

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
        this.cooldowns.set(sp.id, spellCooldown(sp.stats));
        if (st.selfDamage > 0) {
          this.hp -= st.selfDamage;
          this.addPopup(PLAYER_X, GROUND_Y - 100, `-${st.selfDamage}`, 0xbb77ee);
        }
        if (st.kind === 'taunt') {
          // ソロでは挑発は小さな護盾に変わる
          const small = Math.round(st.power * 1.2);
          this.shield = Math.max(this.shield, small);
          this.shieldTimer = 5;
          this.addPopup(PLAYER_X, GROUND_Y - 115, `咆哮! 護盾+${small}`, 0xffaa66);
        } else if (st.kind === 'shield') {
          this.shield = Math.max(this.shield, st.barrier);
          this.shieldTimer = 10;
          this.addPopup(PLAYER_X, GROUND_Y - 115, `護盾+${st.barrier}`, 0x88ccff);
        } else if (st.kind === 'heal') {
          const heal = st.healPower;
          this.hp = Math.min(this.maxHp, this.hp + heal);
          this.addPopup(PLAYER_X, GROUND_Y - 115, `+${heal}`, 0x88ddaa);
        } else if (st.quake) {
          this.castQuake(st);
        } else {
          this.firePlayerProj(sp.stats);
        }
        if (this.hp <= 0) { this.hp = 0; this.beginEnd(false, false); }
      }
    }

    // 護盾の持続時間
    if (this.shieldTimer > 0) {
      this.shieldTimer -= dt;
      if (this.shieldTimer <= 0) this.shield = 0;
    }

    // 敵の行動
    for (const e of this.enemies) {
      if (!e.alive) continue;
      // 浮遊アニメ
      e.cont.y = GROUND_Y + Math.sin(this.time * 2.2 + e.bobPhase) * 3;
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

      if (p.from === 'player') {
        for (const e of this.enemies) {
          if (!e.alive || p.hit.has(e)) continue;
          if (Math.abs(p.x - e.x) < 26) {
            p.hit.add(e);
            this.onSpellHit(p, e);
            if (!p.spell!.pierce) { p.dead = true; break; }
          }
        }
        if (p.x > W + 40) p.dead = true;
      } else {
        if (p.x <= PLAYER_X + 12) {
          p.dead = true;
          this.onPlayerHit(p.dmg!);
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

  private firePlayerProj(st: SpellStats): void {
    const r = 5 + Math.min(10, st.power / 25);
    const g = makeProjectileGfx(st.attr, st.power);
    const y = GROUND_Y - 64;
    g.position.set(PLAYER_X + 34, y);
    this.projLayer.addChild(g);
    this.projs.push({
      g, x: PLAYER_X + 34, y, speed: st.projSpeed,
      from: 'player', spell: st, attr: st.attr, r, trailT: 0,
      hit: new Set(), dead: false,
    });
  }

  // 地震: 弾を飛ばさず敵全体にダメージ+画面と大地を揺らす
  private castQuake(st: SpellStats): void {
    this.shake = 18;
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
    const attr = e.def.attackAttr;
    const g = makeProjectileGfx(attr, 14);
    const y = GROUND_Y - 40 * e.def.size;
    g.position.set(e.x - 20, y);
    this.projLayer.addChild(g);
    const dmg = Math.round(e.def.atk * stageAtkMul(this.stage) * (0.9 + Math.random() * 0.2));
    this.projs.push({
      g, x: e.x - 20, y, speed: -230,
      from: 'enemy', dmg, attr, r: 6, trailT: 0,
      hit: new Set(), dead: false,
    });
  }

  private onSpellHit(p: Proj, target: EnemyUnit): void {
    const st = p.spell!;
    this.dealDamage(target, st, 1.0);

    // 爆発(範囲)
    if (st.radius > 0) {
      const fx = new Graphics();
      fx.circle(0, 0, st.radius).fill({ color: ELEMENTS[st.attr].color, alpha: 0.4 });
      fx.position.set(target.x, GROUND_Y - 30);
      this.fxLayer.addChild(fx);
      this.fxs.push({ g: fx, life: 0.35, maxLife: 0.35 });
      for (const e of this.enemies) {
        if (!e.alive || e === target || p.hit.has(e)) continue;
        if (Math.abs(e.x - target.x) <= st.radius) {
          p.hit.add(e);
          this.dealDamage(e, st, 0.7);
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
      const fromY = GROUND_Y - 40;
      for (const e of others) {
        const zap = new Graphics();
        zap.moveTo(fromX, fromY)
          .lineTo((fromX + e.x) / 2, fromY - 30)
          .lineTo(e.x, GROUND_Y - 40)
          .stroke({ width: 3, color: 0xffee66 });
        this.fxLayer.addChild(zap);
        this.fxs.push({ g: zap, life: 0.25, maxLife: 0.25 });
        this.dealDamage(e, st, 0.6);
        fromX = e.x;
      }
    }
  }

  private dealDamage(e: EnemyUnit, st: SpellStats, mul: number): void {
    let dmg = st.power * mul * (0.9 + Math.random() * 0.2);
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
    // 着弾リング(属性色)
    const ring = new Graphics();
    ring.circle(0, 0, 10).stroke({ width: 3, color: ELEMENTS[st.attr].color, alpha: 0.9 });
    ring.position.set(e.x, GROUND_Y - 40 * e.def.size);
    this.fxLayer.addChild(ring);
    this.fxs.push({ g: ring, life: 0.25, maxLife: 0.25, grow: true });
    const color = crit ? 0xffdd44 : (grade > 0 ? 0xff8855 : (grade < 0 ? 0x8899bb : 0xffffff));
    this.addPopup(
      e.x, GROUND_Y - 70 * e.def.size - 10,
      `${final}${crit ? ' 会心!' : ''}${effNote}`, color,
    );

    if (st.freeze > 0) e.frozen = Math.max(e.frozen, st.freeze);
    if (st.slow > 0) { e.slowPct = Math.max(e.slowPct, st.slow); e.slowTimer = 4; }

    if (st.lifesteal > 0) {
      const heal = Math.round(final * st.lifesteal / 100);
      if (heal > 0) {
        this.hp = Math.min(this.maxHp, this.hp + heal);
        this.addPopup(PLAYER_X, GROUND_Y - 110, `+${heal}`, 0x88ddaa);
      }
    }

    if (e.hp <= 0 && e.alive) {
      e.alive = false;
      e.hp = 0;
      this.defeated.push(e.def);
      e.cont.alpha = 0.25;
      e.hpBar.clear();
    } else {
      this.drawEnemyHpBar(e);
    }
  }

  private onPlayerHit(dmg: number): void {
    if (this.endResult !== null) return;
    // 護盾が先にダメージを受け止める
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
      this.addPopup(PLAYER_X, GROUND_Y - 115, `盾-${absorbed}`, 0x88ccff);
      if (dmg <= 0) { this.shake = 3; return; }
    }
    this.hp -= dmg;
    this.shake = 8;
    this.hitFlash = 0.2;
    this.addPopup(PLAYER_X, GROUND_Y - 100, `-${dmg}`, 0xff7755);
    if (this.hp <= 0) {
      this.hp = 0;
      this.beginEnd(false, false);
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
    const top = -70 * e.def.size - 12;
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
      g.circle(PLAYER_X, GROUND_Y - 50, 52)
        .stroke({ width: 3, color: 0x88ccff, alpha: 0.35 + 0.15 * Math.sin(this.time * 6) });
    }
    // 詠唱バー+杖先の属性グロー
    if (this.casting) {
      const st = this.casting.spell.stats;
      const p = Math.min(1, this.casting.t / st.castTime);
      g.rect(PLAYER_X - 40, GROUND_Y - 130, 80, 8).fill(0x222238);
      g.rect(PLAYER_X - 40, GROUND_Y - 130, 80 * p, 8).fill(0xffdd66);
      g.circle(PLAYER_X + 29, GROUND_Y - 67, 4 + p * 11)
        .fill({ color: ELEMENTS[st.attr].color, alpha: 0.5 });
    }
    // 被弾フラッシュ
    if (this.hitFlash > 0) {
      g.rect(0, 0, W, H).fill({ color: 0xff3333, alpha: this.hitFlash * 0.8 });
    }
    this.infoText.text =
      `HP ${Math.ceil(this.hp)}/${this.maxHp}   MP ${Math.floor(this.mp)}/${this.maxMp}`;
  }

  // ===== 終了処理 =====

  private beginEnd(win: boolean, escaped: boolean): void {
    if (this.endResult !== null) return;
    this.endResult = { win, escaped };
    this.endTimer = win ? 0.8 : 0.6;
    this.casting = null;
    this.updateSpellBar();
  }

  private finish(): void {
    const { win, escaped } = this.endResult!;
    this.active = false;
    this.endResult = null;

    // ドロップ計算
    const drops: ElementId[] = [];
    if (win) {
      for (const def of this.defeated) {
        const count = 1 + (Math.random() < 0.5 ? 1 : 0);
        for (let i = 0; i < count; i++) {
          drops.push(def.drops[Math.floor(Math.random() * def.drops.length)]);
        }
      }
      if (this.stage % 5 === 0) drops.push('light', 'dark'); // ボス確定ドロップ
    }
    const rp = win
      ? 12 + 6 * this.stage + (this.stage % 5 === 0 ? 30 : 0)
      : 4 + 2 * this.stage;

    const result: BattleResult = { win, escaped, stage: this.stage, drops, rp };
    this.onEnd?.(result);
  }
}

// 属性ごとに形の違う弾を生成(プレイヤー・敵共用)
export function makeProjectileGfx(attr: ElementId, power: number): Graphics {
  const g = new Graphics();
  const color = ELEMENTS[attr].color;
  const r = 5 + Math.min(10, power / 25);
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

export function makePlayerSprite(): Container {
  const c = new Container();
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
  c.addChild(g);
  return c;
}

export function makeEnemySprite(def: EnemyDef): { cont: Container; body: Graphics } {
  const cont = new Container();
  const body = new Graphics();
  switch (def.id) {
    case 'slime':
      body.ellipse(0, -16, 22, 17).fill(def.color);
      body.circle(-7, -20, 3).fill(0x113311);
      body.circle(7, -20, 3).fill(0x113311);
      break;
    case 'imp':
      body.poly([-15, 0, 15, 0, 0, -38]).fill(def.color);
      body.poly([-8, -34, -14, -46, -4, -38]).fill(def.color);
      body.poly([8, -34, 14, -46, 4, -38]).fill(def.color);
      body.circle(-4, -22, 2.5).fill(0x330011);
      body.circle(4, -22, 2.5).fill(0x330011);
      break;
    case 'golem':
      body.roundRect(-19, -42, 38, 42, 6).fill(def.color);
      body.roundRect(-13, -56, 26, 18, 4).fill(def.color);
      body.circle(0, -48, 4).fill(0xffdd44);
      break;
    case 'wisp':
      body.circle(0, -24, 18).fill({ color: def.color, alpha: 0.3 });
      body.circle(0, -24, 11).fill(def.color);
      body.circle(0, -24, 4).fill(0xffffff);
      break;
    default: // core(ボス)
      body.circle(0, -34, 30).fill({ color: def.color, alpha: 0.35 });
      body.circle(0, -34, 22).fill(def.color);
      body.circle(0, -34, 26).stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
      body.circle(0, -34, 8).fill(0xffffff);
      break;
  }
  body.scale.set(def.size);
  cont.addChild(body);
  return { cont, body };
}

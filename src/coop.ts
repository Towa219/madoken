// 共闘バトル画面(サーバー状態の描画専用。判定はすべてサーバー側)

import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Room } from 'colyseus.js';
import {
  affinitySymbol, ALL_ENEMIES, backgroundKeyForStage, bossBgmFor, ELEMENTS,
  ELEMENT_ORDER, enemyTopY, poseName, SPRITE_SCALE,
} from '../shared/data';
import type { AffinityGrade, EnemyDef } from '../shared/data';
import {
  EQUIP_MAX, LEGEND_BOSS_STAGE, RECONNECT_TRIES, RECONNECT_WAIT_MS,
} from '../shared/data';
import {
  COUNT_STYLE, makeEnemySprite, makePlayerSprite, makeProjectileGfx,
  setEnemySpritePose, setPlayerSpritePose, START_LABEL,
} from './battle';
import { backgroundArt, petArt } from './artwork';
import { clampCharId } from '../shared/characters';
import { spellCooldown, spellDisplayName } from '../shared/spellcraft';
import { grantBossReward, markGained, showToast } from './lab';
import { addElements, equippedSpells, markBossCleared, notify, state } from './state';
import type { ElementId, Spell } from '../shared/types';
import { playBgm, playSfx, startSfxLoop, stopAllSfxLoops, stopSfxLoop } from './sound';
import { PET_SPECIES } from '../shared/pets';
import { dropReason, noteDrop } from './droplog';
import { askConfirm } from './confirm';

const W = 960;
const H = 540;
const GROUND_Y = 460;

// キャラまわりの座標は SPRITE_SCALE と一緒に動かす(battle.ts と同じ考え方)。
const cy = (n: number) => GROUND_Y - n * SPRITE_SCALE;
const cs = (n: number) => n * SPRITE_SCALE;
const PLAYER_XS = [95, 195, 295];

const DEF_BY_ID: Record<string, EnemyDef> = {};
for (const d of ALL_ENEMIES) DEF_BY_ID[d.id] = d;

interface Anim {
  g: Container;
  x0: number; y0: number; x1: number; y1: number;
  t: number; dur: number;
  attr: ElementId; r: number; trailT: number;
}
interface Popup { t: Text; vy: number; life: number; }
interface Fx { g: Graphics; life: number; maxLife: number; grow?: boolean; }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class CoopView {
  private app: Application | null = null;
  private root: Container | null = null;
  private entityLayer!: Container;
  private projLayer!: Container;
  private fxLayer!: Container;
  private uiLayer!: Container;
  private barsG!: Graphics;
  private stageText!: Text;
  // 背景の絵を敷く層。ステージが分かってから中身を入れる。
  private bgLayer!: Container;
  private bgKey = '';       // いま敷いてある背景の名前(空=まだ敷いていない)
  // 3→2→1→開戦
  private countText!: Text;
  private prevCount = -99;
  // 今どのステージを描いているか(切り替わりを見つけるため)
  private prevStage = -1;

  private room: Room | null = null;
  private mySid = '';
  private spells: Spell[] = [];
  private onExit: (() => void) | null = null;
  private exited = true;
  // 切れた時に共闘へ戻るための手段。ロビー側から渡してもらう。
  private reconnect: ((token: string) => Promise<Room | null>) | null = null;
  private token = '';
  private reconnecting = false;

  // art / def はポーズの差し替えに使う。
  // どのポーズを取るかはサーバーが決めて配るので、誰の画面でも同じ絵になる。
  private pViews = new Map<
    string,
    { cont: Container; art: Container; nameT: Text; castT: Text; buffT: Text;
      petBox: Container; petKey: string }
  >();
  private eViews: {
    cont: Container; body: Graphics | Sprite; def: EnemyDef;
  }[] = [];
  // 今表示している敵の顔ぶれ。変わったら絵と表示を作り直す目印
  private enemySig = '';
  private anims: Anim[] = [];
  private popups: Popup[] = [];
  private fxs: Fx[] = [];

  private cds = [0, 0, 0, 0];
  private shakeT = 0;
  // ボスの全体攻撃の予告
  private warnG!: Graphics;
  private warnText!: Text;
  private warnT = 0;      // 着弾までの残り秒
  private warnTotal = 0;
  private prevCastingIdx = -1;
  private prevCastTotal = 0;
  private spellBtns: HTMLButtonElement[] = [];
  private statusEls: { card: HTMLElement; hpFill: HTMLElement; hpText: HTMLElement }[] = [];
  private statusBuilt = false;
  private waitingHtml = '';
  // 中断/決着の通知を受け取ったか。受け取らずに切れた場合は通信不良。
  private toldWhy = false;
  // 部屋が終わっているのに何も知らされないまま経った秒数
  private doneT = 0;

  private $(sel: string): HTMLElement {
    return document.querySelector(sel) as HTMLElement;
  }

  private async ensureApp(): Promise<void> {
    if (this.app) return;
    const app = new Application();
    await app.init({ width: W, height: H, backgroundColor: 0x0b0b18, antialias: true });
    this.$('#coop-canvas').appendChild(app.canvas);
    app.ticker.add(t => this.tick(Math.min(t.deltaMS / 1000, 0.1)));
    this.app = app;
  }

  async start(
    room: Room, onExit: () => void,
    reconnect?: (token: string) => Promise<Room | null>,
  ): Promise<void> {
    await this.ensureApp();
    this.room = room;
    this.mySid = room.sessionId;
    this.onExit = onExit;
    this.reconnect = reconnect ?? null;
    this.token = room.reconnectionToken;
    this.reconnecting = false;
    this.exited = false;
    this.spells = equippedSpells().slice(0, EQUIP_MAX);
    this.cds = [0, 0, 0, 0];
    this.prevCastingIdx = -1;
    this.pViews.clear();
    this.eViews = [];
    this.enemySig = '';
    this.warnT = 0;
    this.prevCount = -99;
    this.prevStage = -1;
    this.anims = [];
    this.popups = [];
    this.fxs = [];
    this.statusBuilt = false;
    this.waitingHtml = '';
    this.toldWhy = false;
    this.doneT = 0;
    this.$('#coop-enemy-status').innerHTML = '';
    this.$('#coop-overlay').classList.add('hidden');

    this.buildScene();
    this.buildBar();
    this.wireRoom(room);
  }

  tryCast(i: number): void {
    if (!this.room || this.exited) return;
    if (this.cds[i] > 0) return;
    this.room.send('cast', { idx: i });
  }

  // ---- シーン ----

  private buildScene(): void {
    const app = this.app!;
    if (this.root) {
      app.stage.removeChild(this.root);
      this.root.destroy({ children: true });
    }
    const root = new Container();
    app.stage.addChild(root);
    this.root = root;

    // 背景。素材があればステージ段階ごとの絵を敷く。
    //
    // ★ ここではまだステージが分からない。共闘のステージは部屋の状態
    //   (room.state.stage)で届くので、届いた時点で applyBackground() が
    //   敷き直す。図形の背景は素材が無い環境のための下地として残す。
    const bg = new Graphics();
    bg.rect(0, 0, W, H).fill(0x0b0b18);
    bg.circle(780, 90, 42).fill({ color: 0xddddff, alpha: 0.85 });
    bg.circle(766, 82, 34).fill(0x0b0b18);
    for (let i = 0; i < 40; i++) {
      const sx = (i * 137 + 61) % W;
      const sy = (i * 89 + 23) % (GROUND_Y - 120);
      bg.circle(sx, sy, (i % 3 === 0) ? 1.6 : 1).fill({ color: 0xffffff, alpha: 0.5 });
    }
    bg.rect(0, GROUND_Y, W, H - GROUND_Y).fill(0x1c1c30);
    bg.rect(0, GROUND_Y, W, 4).fill(0x33335a);
    root.addChild(bg);
    this.bgLayer = new Container();
    root.addChild(this.bgLayer);
    this.bgKey = '';

    this.entityLayer = new Container();
    this.projLayer = new Container();
    this.fxLayer = new Container();
    this.uiLayer = new Container();
    root.addChild(this.entityLayer, this.projLayer, this.fxLayer, this.uiLayer);

    this.barsG = new Graphics();
    this.uiLayer.addChild(this.barsG);

    this.stageText = new Text({
      text: '共闘',
      style: { fill: 0xbb99ff, fontSize: 18, fontFamily: 'Meiryo, sans-serif', fontWeight: 'bold' },
    });
    this.stageText.anchor.set(0.5, 0);
    this.stageText.position.set(W / 2, 12);
    this.uiLayer.addChild(this.stageText);

    this.countText = new Text({ text: '', style: { ...COUNT_STYLE } });
    this.countText.anchor.set(0.5);
    this.countText.position.set(W / 2, H / 2 - 30);
    this.uiLayer.addChild(this.countText);

    // ボスの全体攻撃の予告。画面全体を赤く染めて、中央に警告を出す。
    // 見落とすと全員が一気に削られるので、目立たせることを優先している。
    this.warnG = new Graphics();
    this.warnG.visible = false;
    this.uiLayer.addChild(this.warnG);

    this.warnText = new Text({
      text: '',
      style: {
        fill: 0xffdd55, fontSize: 34, fontFamily: 'Meiryo, sans-serif', fontWeight: 'bold',
        stroke: { color: 0x330000, width: 6 },
        align: 'center',
      },
    });
    this.warnText.anchor.set(0.5);
    this.warnText.position.set(W / 2, H / 2 - 40);
    this.warnText.visible = false;
    this.uiLayer.addChild(this.warnText);
  }

  // ステージ段階に応じた背景を敷く。同じ段階なら何もしない。
  private applyBackground(stage: number): void {
    if (!Number.isFinite(stage) || stage <= 0) return;
    // ★ 「いま敷いてある段階」を数値で持ってはいけない。
    //   初期値0を backgroundKeyForStage に渡すと B1 が返る(0 % 5 === 0 のため)。
    //   ステージ5のボス戦で「もう敷いてある」と誤判定し、敷き替えを飛ばす。
    const key = backgroundKeyForStage(stage);
    if (key === this.bgKey) return;
    this.bgKey = key;
    this.bgLayer.removeChildren().forEach(c => c.destroy());
    const art = backgroundArt(W, H, stage);
    if (art) this.bgLayer.addChild(art);
  }

  private buildBar(): void {
    const bar = this.$('#coop-bar');
    bar.innerHTML = '';
    this.spellBtns = [];
    this.spells.forEach((sp, i) => {
      const b = document.createElement('button');
      b.className = 'spell-btn';
      b.innerHTML =
        `<span class="key">${i + 1}</span>${esc(spellDisplayName(sp))}` +
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
    // 退出は魔法ボタンと同じ行に置くと押し間違えるので、下の段に分ける
    const escRow = document.createElement('div');
    escRow.className = 'escape-row';
    const esc2 = document.createElement('button');
    esc2.id = 'btn-escape';
    esc2.textContent = '退出';
    esc2.addEventListener('click', () => { void this.confirmExit(); });
    escRow.appendChild(esc2);
    bar.appendChild(escRow);
    bar.classList.remove('hidden');
  }

  // 退出の手前で一度聞く。
  //
  // ★ 退出ボタンは魔法ボタンのすぐ下にある。戦っている最中に押し間違えると
  //   そこまでの戦果が消え、仲間がいれば残された側にも影響する。
  // ★ 決着がついた後(done)は聞かない。もう失うものが無いのに毎回聞くと、
  //   ただの邪魔になる。
  // ★ 聞いている間も戦闘は止めない。止めると「窓を開けているあいだは
  //   無敵」になり、危なくなったら開いて凌ぐ手が生まれる。
  //   そのぶん、止まらないことを窓の中に必ず書く。
  private async confirmExit(): Promise<void> {
    const 相 = (this.room?.state as { phase?: string } | undefined)?.phase;
    if (this.exited || !this.room || 相 === 'done' || 相 === undefined) {
      this.exitNow(); return;
    }
    const ok = await askConfirm({
      title: '共闘から退出する?',
      body: 'ここまでの戦果は記録されません。仲間がいる場合、'
        + '残った人はそのまま続きます。<br>'
        + '<b>確かめている間も戦闘は止まりません。</b>',
      yes: '退出する', danger: true,
    });
    if (ok) this.exitNow();
  }

  // どんな状態でも確実に共闘画面から抜ける(サーバーへのleaveは投げっぱなし)
  private exitNow(理由 = '自分で退出'): void {
    try { void this.room?.leave(); } catch { /* 切断済みでも無視 */ }
    this.handleExit(理由);
  }

  private buildEnemyStatus(enemies: { defId: string; name: string }[]): void {
    const box = this.$('#coop-enemy-status');
    box.innerHTML = '';
    this.statusEls = [];
    for (const e of enemies) {
      const def = DEF_BY_ID[e.defId];
      const card = document.createElement('div');
      card.className = 'enemy-card';
      const chips = ELEMENT_ORDER.map(id => {
        const g = (def?.affinity[id] ?? 0) as AffinityGrade;
        const cls = g > 0 ? 'aff-weak' : g < 0 ? 'aff-resist' : 'aff-neutral';
        return `<span class="aff ${cls}">` +
          `<span style="color:${ELEMENTS[id].cssColor}">${ELEMENTS[id].name}</span>` +
          `${affinitySymbol(g)}</span>`;
      }).join('');
      const atk = def ? ELEMENTS[def.attackAttr] : null;
      card.innerHTML =
        `<div class="ecard-head"><span class="ecard-name">${esc(e.name)}</span>` +
        `<span class="ecard-hp"></span></div>` +
        `<div class="ecard-hpbar"><div class="ecard-hpfill"></div></div>` +
        (atk ? `<div class="ecard-atk">攻撃属性: ` +
          `<span style="color:${atk.cssColor}">${atk.name}</span></div>` : '') +
        `<div class="ecard-affs">${chips}</div>`;
      box.appendChild(card);
      this.statusEls.push({
        card,
        hpFill: card.querySelector('.ecard-hpfill') as HTMLElement,
        hpText: card.querySelector('.ecard-hp') as HTMLElement,
      });
    }
    this.statusBuilt = true;
  }

  // ---- サーバーイベント ----

  private wireRoom(room: Room): void {
    room.onMessage('proj', (m: { x0: number; targetX: number; attr: ElementId; power: number; delayMs: number }) => {
      const r = 5 + Math.min(10, m.power / 25);
      const g = makeProjectileGfx(m.attr, m.power);
      this.projLayer.addChild(g);
      this.anims.push({
        g, x0: m.x0, y0: cy(64), x1: m.targetX, y1: cy(40),
        t: 0, dur: m.delayMs / 1000, attr: m.attr, r, trailT: 0,
      });
    });

    room.onMessage('eproj', (m: { i: number; targetSid: string; delayMs: number }) => {
      playSfx('enemyCast');
      const st: any = room.state;
      const e = st?.enemies?.[m.i];
      const p = st?.players?.get(m.targetSid);
      if (!e || !p) return;
      const attr = DEF_BY_ID[e.defId]?.attackAttr ?? 'fire';
      const g = makeProjectileGfx(attr, 14);
      this.projLayer.addChild(g);
      this.anims.push({
        g, x0: e.x - 20, y0: cy(40), x1: PLAYER_XS[p.slot] ?? 110, y1: cy(50),
        t: 0, dur: m.delayMs / 1000, attr, r: 6, trailT: 0,
      });
    });

    // 地震: 画面を揺らし、大地に波紋を走らせる
    // ボスの全体攻撃の予告 → 着弾
    room.onMessage('eaoewarn', (m: { name: string; sec: number }) => {
      playSfx('countdown');
      this.warnTotal = Math.max(0.3, Number(m.sec) || 1.8);
      this.warnT = this.warnTotal;
      this.warnText.text = `⚠ ${m.name} の全体攻撃!
全員に来る — 備えろ`;
      this.warnText.visible = true;
      this.warnG.visible = true;
    });
    // 封印で全体攻撃を止めた。予告の赤い画面をその場で解く。
    room.onMessage('eaoestop', (m: { name: string }) => {
      playSfx('shield');
      this.warnT = 0;
      this.warnText.visible = false;
      this.warnG.visible = false;
      this.addPopup(W / 2, cy(150), `封印! ${m.name} の全体攻撃を止めた`, 0xbb77ee);
    });
    room.onMessage('eaoehit', () => {
      playSfx('quake');
      this.shakeT = 0.7;
      this.warnT = 0;
      this.warnText.visible = false;
      this.warnG.visible = false;
      this.addPopup(W / 2, cy(150), '全体攻撃!', 0xff6644);
    });

    room.onMessage('quake', () => {
      playSfx('quake');
      this.shakeT = 0.6;
      for (let k = 0; k < 3; k++) {
        const fx = new Graphics();
        fx.ellipse(0, 0, 60 + k * 45, 10 + k * 5)
          .stroke({ width: 3, color: 0xcc9955, alpha: 0.85 });
        fx.position.set(W / 2 + 120, GROUND_Y + 8);
        this.fxLayer.addChild(fx);
        this.fxs.push({ g: fx, life: 0.5 + k * 0.15, maxLife: 0.5 + k * 0.15, grow: true });
      }
    });

    room.onMessage('hit', (m: { i: number; amount: number; crit: boolean; note: string; attr: ElementId; radius: number }) => {
      playSfx(m.crit ? 'crit' : 'hit');
      const st: any = room.state;
      const e = st?.enemies?.[m.i];
      if (!e) return;
      const eDef = DEF_BY_ID[e.defId];
      const color = m.crit ? 0xffdd44 : (m.note.includes('弱点') ? 0xff8855 : 0xffffff);
      this.addPopup(
        e.x, GROUND_Y + (eDef ? enemyTopY(eDef) : -70) - 22,
        `${m.amount}${m.crit ? ' 会心!' : ''}${m.note}`, color,
      );
      // 着弾リング(属性色)
      const ring = new Graphics();
      ring.circle(0, 0, 10).stroke({ width: 3, color: ELEMENTS[m.attr]?.color ?? 0xffffff, alpha: 0.9 });
      ring.position.set(e.x, cy(40));
      this.fxLayer.addChild(ring);
      this.fxs.push({ g: ring, life: 0.25, maxLife: 0.25, grow: true });
      if (m.radius > 0) {
        const fx = new Graphics();
        fx.circle(0, 0, m.radius).fill({ color: ELEMENTS[m.attr]?.color ?? 0xffffff, alpha: 0.4 });
        fx.position.set(e.x, cy(30));
        this.fxLayer.addChild(fx);
        this.fxs.push({ g: fx, life: 0.35, maxLife: 0.35 });
      }
    });

    room.onMessage('phit', (m: { sid: string; amount: number }) => {
      if (m.sid === this.mySid) playSfx('damage');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(100), `-${m.amount}`, 0xff7755);
    });

    room.onMessage('heal', (m: { sid: string; amount: number }) => {
      playSfx('heal');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(110), `+${m.amount}`, 0x88ddaa);
    });

    // 蘇生(光6の魔法)。倒れていた人がその場で立ち上がる。
    // 見逃されると「何が起きたのか分からない」ので、名前も出す。
    room.onMessage('revive', (m: { sid: string; hp: number; name: string }) => {
      playSfx('discover');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      const x = PLAYER_XS[p?.slot] ?? 110;
      this.addPopup(x, cy(140), '✨ 蘇生!', 0xffee99);
      this.addPopup(x, cy(110), `HP ${m.hp}`, 0x88ddaa);
      showToast(`✨ ${m.name} がよみがえった`);
    });

    room.onMessage('shieldup', (m: { sid: string; amount: number }) => {
      playSfx('shield');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(115), `護盾+${m.amount}`, 0x88ccff);
    });

    room.onMessage('taunt', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(120), `咆哮! ヘイト+${m.amount}`, 0xffaa66);
    });

    room.onMessage('ward', (m: { sid: string; pct: number; attr: string }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      const label = m.attr
        ? `${ELEMENTS[m.attr as ElementId]?.name ?? ''}耐性${m.pct}%`
        : `全属性耐性${m.pct}%`;
      this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(128), label, 0x88ffcc);
    });

    room.onMessage('wardhit', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(128), `耐性 -${m.amount}`, 0x88ffcc);
    });

    room.onMessage('seal', (m: { sec: number; resisted?: number }) => {
      // 闇に強い敵にはレジストされるので、効いた分と弾かれた分を両方出す
      if (m.sec > 0) {
        this.addPopup(W / 2, cy(150), `封印! ${m.sec.toFixed(1)}秒`, 0xbb77ee);
      }
      if (m.resisted && m.resisted > 0) {
        this.addPopup(W / 2, cy(178), `レジスト ${m.resisted}体`, 0xff9977);
      }
    });
    room.onMessage('empower', (m: { sid: string; pct: number }) => {
      playSfx('buff');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(136), `与ダメ+${m.pct}%`, 0xff8844);
    });
    room.onMessage('focus', (m: { sid: string; perSec: number }) => {
      playSfx('buff');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) {
        this.addPopup(
          PLAYER_XS[p.slot] ?? 110, cy(142),
          `瞑想 MP+${m.perSec.toFixed(1)}/秒`, 0x88ccff,
        );
      }
    });
    room.onMessage('vigor', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(122), `最大HP+${m.amount}`, 0xffcc66);
    });
    room.onMessage('dot', (m: { i: number; amount: number }) => {
      const st: any = room.state;
      const e = st?.enemies?.[m.i];
      if (!e) return;
      const eDef = DEF_BY_ID[e.defId];
      this.addPopup(e.x, GROUND_Y + (eDef ? enemyTopY(eDef) : -70) - 6, `${m.amount}`, 0x99ee66);
    });

    room.onMessage('shieldhit', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      this.addPopup(PLAYER_XS[p.slot] ?? 110, cy(115), `盾-${m.amount}`, 0x88ccff);
    });

    // ステージクリア: 報酬を受け取り、自動で次ステージへ(サーバー主導)
    // ボスの卵は、クリアの知らせとは別便で遅れて届く(保存を待たせないため)
    room.onMessage('bossegg', (m: { egg?: 'received' | 'already' | 'full' | 'error' }) => {
      if (m.egg === 'received') showToast('ボスが卵を落とした！ ペットの欄で温められます。');
      else if (m.egg === 'full') showToast('手持ちが上限のため、ボスの卵を受け取れませんでした。');
      else if (m.egg === 'error') showToast('ボスの卵を受け取れませんでした。');
    });

    room.onMessage('stageclear', (m: {
      stage: number; drops: ElementId[]; rp: number; boss?: boolean;
    }) => {
      addElements(m.drops);
      markGained(m.drops);
      state.researchP += m.rp;
      state.bestStage = Math.max(state.bestStage, m.stage);
      state.maxStage = Math.max(state.maxStage, m.stage + 1);
      if (m.boss) {
        markBossCleared(m.stage);
        // 最深部のボスは初回だけレジェンドを授ける
        grantBossReward(m.stage); // 深いボスなら討伐報酬(初回だけ)
      }
      notify();
      const dropStr = m.drops.length > 0
        ? ` 素材:${m.drops.map(d => ELEMENTS[d].name).join('・')}`
        : '';
      showToast(
        `${m.boss ? '👑 ボス撃破!' : '⚔'} ステージ${m.stage}クリア! 研究P+${m.rp}${dropStr}`,
      );
    });

    // 誰かが離脱 → 前ステージまでのクリア扱いで全員ロビーへ
    room.onMessage('aborted', (m: { name: string; clearedStage: number }) => {
      this.toldWhy = true;
      // ★ 記録に残す。全員が切れた時にサーバーがこれを送って部屋を畳むので、
      //   「一人落ちてから残りも続けて落ちた」時の最後の1人がここを通る。
      noteDrop(`共闘中断 ${m.name} の離脱 ステージ${m.clearedStage}まで`);
      const overlay = this.$('#coop-overlay');
      overlay.innerHTML =
        `<div class="result-box">` +
        `<h2 class="lose">共闘中断</h2>` +
        `<div>${esc(m.name)} が退出したため、この共闘は終了。</div>` +
        `<div style="margin-top:6px">ステージ${Math.max(0, m.clearedStage)}までのクリアが記録された。</div>` +
        `<div class="note" style="margin-top:10px">まもなくロビーに戻ります…</div>` +
        `</div>`;
      overlay.classList.remove('hidden');
    });

    room.onMessage('result', (m: { win: boolean; drops: ElementId[]; rp: number }) => {
      this.toldWhy = true;
      playSfx(m.win ? 'win' : 'lose');
      this.showResult(m);
    });

    // 同じ名前で別の戦闘部屋に入った(部屋の乱立を防ぐためサーバーが閉じる)。
    // 本番のプロキシ越しでは切断が伝わらないことがあるので、通知を受けた時点で抜ける。
    room.onMessage('replaced', () => {
      this.toldWhy = true;
      showToast('別の部屋に入ったため、こちらの部屋からは退出した。');
      void room.leave();
      this.handleExit('別の部屋に入った(replaced)');
    });
    // 仲間が切れた/戻ってきた
    // 自分のことは出さない。自分には「復帰を試みている」を別に出しており、
    // これを上書きしてしまうと、戻れたのかどうかが分からなくなる。
    room.onMessage('pwait', (m: { sid: string; name: string; sec: number }) => {
      if (m.sid === this.mySid) return;
      showToast(`${m.name} の通信が切れた。${m.sec}秒だけ復帰を待つ…`);
    });
    room.onMessage('pback', (m: { sid: string; name: string }) => {
      if (m.sid === this.mySid) return;
      showToast(`${m.name} が戻ってきた。`);
    });
    // 戻ってこなかった仲間がいても、残った人はそのまま続けられる
    room.onMessage('mateleft', (m: { name: string }) => {
      showToast(`${m.name} が離脱した。残りの人数で続行する。`);
    });

    // ★ 理由(コード)を捨てないこと。捨てていたせいで、遊んでいる人から
    //   「サーバー切断で落ちる」と言われても、回線なのかサーバーなのか
    //   プロキシなのかを分ける手掛かりが何も残らなかった。
    //   1000=正常 / 1001=サーバーが閉じた / 1006=前触れなく切断(回線・プロキシ)
    //   4000番台=Colyseusの都合。ここが分かれば見る場所が決まる。
    room.onLeave((code: number) => void this.handleDisconnect(dropReason(code)));
    room.onError((code: number, msg?: string) =>
      void this.handleDisconnect(`エラー ${code}${msg ? ` ${msg}` : ''}`));

    // 留守の間に決着していないかをサーバーに聞く。
    // 受け取り口を用意し終えてから聞くので、取りこぼしがない。
    // 初回の入室でも投げるが、決着はまだ無いので何も返ってこない。
    try { room.send('catchup'); } catch { /* 送れなくても致命的ではない */ }
  }

  // 決着の知らせが何も届かないまま部屋が終わっていた時の逃げ道。
  // サーバー側で取りこぼしは塞いだが、ここが最後の砦。
  // これが無いと、戦闘画面に取り残されて退出しか押せない状態になる。
  private showEnded(): void {
    const overlay = this.$('#coop-overlay');
    overlay.innerHTML =
      `<div class="result-box">` +
      `<h2 class="lose">共闘終了</h2>` +
      `<div>離れているあいだにこの共闘は終わっていた。</div>` +
      `<div class="note" style="margin-top:10px">ここまでの記録は保存されている。</div>` +
      `<div style="margin-top:16px">` +
      `<button id="btn-coop-back">ロビーへ戻る</button>` +
      `</div></div>`;
    overlay.classList.remove('hidden');
    overlay.querySelector('#btn-coop-back')?.addEventListener('click', () => this.exitNow());
  }

  private showResult(m: { win: boolean; drops: ElementId[]; rp: number }): void {
    const st: any = this.room?.state;
    const stage = Number(st?.stage ?? 1);

    // 報酬をローカルセーブへ反映
    addElements(m.drops);
    state.researchP += m.rp;
    if (m.win) {
      state.bestStage = Math.max(state.bestStage, stage);
      state.maxStage = Math.max(state.maxStage, stage + 1);
    }
    notify();

    const overlay = this.$('#coop-overlay');
    const dropChips = m.drops.length > 0
      ? m.drops.map(d =>
          `<span class="drop-chip" style="color:${ELEMENTS[d].cssColor}">${ELEMENTS[d].name}</span>`,
        ).join('')
      : '<span style="color:#8888aa">なし</span>';
    overlay.innerHTML =
      `<div class="result-box">` +
      `<h2 class="${m.win ? 'win' : 'lose'}">${m.win ? '共闘勝利!' : '全滅…'}</h2>` +
      `<div>${m.win ? `ステージ ${stage}` : `ステージ ${stage} まで到達`}</div>` +
      `<div class="drops">獲得エレメント: ${dropChips}</div>` +
      (m.rp > 0
        ? `<div style="color:#ffdd66">研究P +${m.rp}</div>`
        : `<div style="color:#8888aa">全滅したため研究Pは得られない。</div>`) +
      `<div style="margin-top:16px">` +
      `<button id="btn-coop-back">ロビーへ戻る</button>` +
      `</div></div>`;
    overlay.classList.remove('hidden');
    overlay.querySelector('#btn-coop-back')?.addEventListener('click', () => {
      this.exitNow();
    });
  }

  // 決着も退出の知らせも無いまま切れた場合。
  // 電波が一瞬途切れただけのことが多いので、まず共闘へ戻ることを試みる。
  // 以前はここで即座に退出しており、しかもサーバー側は1人の離脱で
  // 部屋全員のランを終わらせていたため、巻き添えが大きかった。
  private async handleDisconnect(理由 = ''): Promise<void> {
    // ★ 決着を伝えたあとに接続が閉じるのは正常な動き。部屋が畳まれる
    //   ときに一緒に閉じるだけで、不具合ではない。「切断」と書くと
    //   何ともないことで驚かせるので、正常だと分かる書き方にする
    //   (2026-08-13、実際に「落ちた」と報告を受けたが決着後だった)。
    // ★ それでも記録は残す。決着の前後どちらで切れたかを分けられることが、
    //   本当に落ちた時の手掛かりになる。
    if (this.exited || this.toldWhy) {
      noteDrop(`決着後に部屋が閉じた(正常) ${理由}`);
      this.handleExit('決着後'); return;
    }
    if (this.reconnecting) return;
    this.reconnecting = true;
    noteDrop(`戦闘中に切断 ${理由}`);
    showToast(`通信が切れた(${理由 || '理由不明'})。共闘への復帰を試みている…`);

    const back = await this.tryReconnect();
    this.reconnecting = false;
    if (back) {
      noteDrop('復帰した');
      showToast('共闘に復帰した。');
      return;
    }
    noteDrop(`復帰できなかった ${理由}`);
    showToast(`共闘に復帰できなかった(${理由 || '理由不明'})。`
      + 'ロビーから入り直してほしい。設定の下に記録が残ります。');
    this.handleExit('復帰を諦めた');
  }

  // 少し間を置いて何度か試す。
  //
  // 粘る時間はサーバーが席を空けて待つ秒数(RECONNECT_SEC)に合わせること。
  // 以前は2.5秒×6回=15秒で諦めていて、サーバーはまだ30秒待つ気なのに
  // クライアントが先に投げ出していた。回線が20秒切れただけで戻れなくなる。
  private async tryReconnect(): Promise<boolean> {
    if (!this.reconnect || !this.token) return false;

    // 画面が隠れている間、ブラウザはタイマーを大きく間引く。
    // スマホで画面を消すと再試行がほとんど進まないまま待ち時間だけ過ぎるので、
    // 画面が戻った瞬間に待ちを打ち切って、すぐ次の試行に入る。
    let wake: (() => void) | null = null;
    const onVisible = () => {
      if (!document.hidden && wake) { const w = wake; wake = null; w(); }
    };
    document.addEventListener('visibilitychange', onVisible);

    try {
      for (let i = 0; i < RECONNECT_TRIES; i++) {
        await new Promise<void>(resolve => {
          const timer = window.setTimeout(() => { wake = null; resolve(); },
            RECONNECT_WAIT_MS);
          wake = () => { window.clearTimeout(timer); resolve(); };
        });
        if (this.exited) return false;
        try {
          const room = await this.reconnect(this.token);
          if (!room) continue;
          this.room = room;
          this.mySid = room.sessionId;
          this.token = room.reconnectionToken;
          this.wireRoom(room);
          return true;
        } catch (err) {
          // 失敗理由は残しておく。利用者からの報告を追えるようにするため。
          console.warn('[共闘] 復帰に失敗:', (err as { message?: string })?.message ?? err);
        }
      }
      return false;
    } finally {
      document.removeEventListener('visibilitychange', onVisible);
    }
  }

  // ★ 誰が退出させたかを必ず残すこと。
  //   2026-08-14、切断から5秒で「復帰できなかった」と出た。復帰は90秒
  //   粘る設計なので、途中で this.exited が立って打ち切られている。
  //   どこで立ったのかは、記録が無ければ延々と当てずっぽうになる。
  private handleExit(理由 = '(不明)'): void {
    if (this.exited) return;
    noteDrop(`共闘の画面を閉じた: ${理由}`);
    this.exited = true;
    stopAllSfxLoops();
    this.room = null;
    this.$('#coop-bar').innerHTML = '';
    this.$('#coop-bar').classList.remove('hidden');
    this.$('#coop-enemy-status').innerHTML = '';
    this.$('#coop-waiting').classList.add('hidden');
    this.$('#coop-overlay').classList.add('hidden');
    this.onExit?.();
  }

  // ---- 毎フレーム描画(サーバー状態のポーリング) ----

  private tick(dt: number): void {
    if (!this.room || this.exited) return;
    const st: any = this.room.state;
    if (!st || !st.players) return;

    // ステージが切り替わったら、こちら側の再使用時間も戻す。
    // サーバーは nextStage で0にしているが、画面側の残り時間はそのままだった。
    // そのため次のステージが始まっても魔法ボタンが灰色のまま押せなかった。
    const stage = Number(st.stage);
    if (stage !== this.prevStage) {
      this.prevStage = stage;
      this.cds = this.cds.map(() => 0);
      this.prevCastingIdx = -1;
    }
    // 背景も段階ごとに敷き替える。
    // ★ buildScene の時点ではステージが分からない(部屋の状態で届く)ので、
    //   ここで敷く。共闘はボス戦の唯一の入口なので、ここを抜かすと
    //   ボス面だけ背景が変わらないままになる(2026-08-11に実際そうなった)。
    this.applyBackground(stage);

    // 部屋は終わっているのに決着の知らせが来ない = 留守の間に終わっていた。
    // 少しだけ待つのは、知らせが状態の更新より僅かに遅れて届くことがあるため。
    if (st.phase === 'done' && !this.toldWhy) {
      this.doneT += dt;
      if (this.doneT > 2) { this.toldWhy = true; this.showEnded(); }
    } else {
      this.doneT = 0;
    }

    const bossFight = stage % 5 === 0;
    this.stageText.text = `ステージ ${st.stage}${bossFight ? ' — ボス戦' : ''} (共闘)`;
    // ボス戦かどうかで曲を変える。
    // 部屋に入る時だけ選んでいたため、勝ち上がってボスのステージに来ても
    // 通常戦闘の曲のままだった。毎回呼んでも、同じ曲なら playBgm 側で無視される。
    //
    // ただしステージ番号が届く前は決めない。
    // 未着だと stage が NaN になり「ボスではない」と判断して通常戦闘の曲を
    // 一瞬鳴らしてしまう。鳴らし始めと差し替えが重なるとブラウザに再生を
    // 中断され、そのまま無音で戦うことがある。1フレーム待てば正しく決まる。
    if (Number.isFinite(stage) && stage >= 1) {
      playBgm(bossFight ? bossBgmFor(stage) : 'battle');
    }

    this.syncPlayers(st);
    this.syncEnemies(st);
    this.updateWaiting(st);
    this.updateBar(st, dt);
    this.drawBars(st);

    // カウントダウン(開戦前・次ステージへ進んだ時の両方)
    if (st.phase === 'count') {
      const left = Number(st.countdown);
      const n = Math.ceil(left - 0.6);
      if (n !== this.prevCount) {
        this.prevCount = n;
        playSfx(n > 0 ? 'countdown' : 'start');
      }
      this.countText.text = n > 0 ? String(n) : START_LABEL;
      if (n > 0) {
        const frac = (left - 0.6) - Math.floor(left - 0.6);
        this.countText.scale.set(1 + (1 - frac) * 0.35);
        this.countText.alpha = 1;
      } else {
        // 「開戦」は押し広がりながら薄れて消える
        const t = Math.max(0, Math.min(1, left / 0.6));
        this.countText.scale.set(1.05 + (1 - t) * 0.35);
        this.countText.alpha = 0.15 + t * 0.85;
      }
    } else {
      this.countText.text = '';
      this.prevCount = -99;
    }

    // 全体攻撃の予告。着弾が近づくほど赤く、速く点滅する。
    if (this.warnT > 0) {
      this.warnT -= dt;
      const left = Math.max(0, this.warnT);
      const near = 1 - left / this.warnTotal;          // 0=予告直後 1=着弾直前
      const blink = 0.35 + 0.65 * Math.abs(Math.sin(left * (6 + near * 14)));
      this.warnG.clear();
      this.warnG.rect(0, 0, W, H).fill({ color: 0xff2200, alpha: 0.10 + 0.22 * near * blink });
      // 上下から迫る帯。見ていなくても視界の端で気づける。
      const band = 10 + 46 * near;
      this.warnG.rect(0, 0, W, band).fill({ color: 0xff4422, alpha: 0.30 + 0.4 * blink });
      this.warnG.rect(0, H - band, W, band).fill({ color: 0xff4422, alpha: 0.30 + 0.4 * blink });
      this.warnText.alpha = blink;
      this.warnText.scale.set(1 + near * 0.18);
      if (this.warnT <= 0) {
        this.warnText.visible = false;
        this.warnG.visible = false;
      }
    }

    // 画面揺れ(地震)
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      this.root?.position.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
    } else {
      this.root?.position.set(0, 0);
    }

    // 弾アニメ(+属性色の軌跡)
    this.anims = this.anims.filter(a => {
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      a.g.position.set(a.x0 + (a.x1 - a.x0) * k, a.y0 + (a.y1 - a.y0) * k);
      a.trailT -= dt;
      if (a.trailT <= 0 && k < 1) {
        a.trailT = 0.05;
        const tr = new Graphics();
        tr.circle(0, 0, Math.max(2, a.r * 0.5))
          .fill({ color: ELEMENTS[a.attr]?.color ?? 0xffffff, alpha: 0.45 });
        tr.position.set(a.g.position.x, a.g.position.y);
        this.fxLayer.addChild(tr);
        this.fxs.push({ g: tr, life: 0.22, maxLife: 0.22 });
      }
      if (k >= 1) { a.g.destroy(); return false; }
      return true;
    });
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
    this.popups = this.popups.filter(p => {
      p.life -= dt;
      if (p.life <= 0) { p.t.destroy(); return false; }
      p.t.y += p.vy * dt;
      p.t.alpha = Math.min(1, p.life / 0.4);
      return true;
    });
  }

  private syncPlayers(st: any): void {
    const seen = new Set<string>();
    st.players.forEach((p: any, sid: string) => {
      seen.add(sid);
      let v = this.pViews.get(sid);
      if (!v) {
        const cont = new Container();
        if (sid === this.mySid) {
          const ring = new Graphics();
          ring.ellipse(0, 2, cs(26), cs(7)).stroke({ width: 2, color: 0xffdd66, alpha: 0.9 });
          cont.addChild(ring);
        }
        const art = makePlayerSprite(clampCharId(p.charId));
        cont.addChild(art);
        const nameT = new Text({
          text: p.name,
          style: { fill: sid === this.mySid ? 0xffdd66 : 0xccccdd, fontSize: 12, fontFamily: 'Meiryo, sans-serif' },
        });
        nameT.anchor.set(0.5);
        nameT.position.set(0, -cs(118));
        cont.addChild(nameT);
        // 詠唱中の魔法名(味方全員に見える)
        const castT = new Text({
          text: '',
          style: { fill: 0xffdd66, fontSize: 11, fontFamily: 'Meiryo, sans-serif' },
        });
        castT.anchor.set(0.5);
        castT.position.set(0, -cs(132));
        cont.addChild(castT);
        // かかっている効果(護盾・耐性・攻撃上昇・HP上昇)
        const buffT = new Text({
          text: '',
          style: { fill: 0x88ffcc, fontSize: 10, fontFamily: 'Meiryo, sans-serif' },
        });
        buffT.anchor.set(0.5);
        buffT.position.set(0, -cs(105));
        cont.addChild(buffT);
        // 連れているペットを乗せる入れ物。中身は種類が分かってから入れる。
        const petBox = new Container();
        petBox.position.set(0, -cs(152)); cont.addChild(petBox);
        this.entityLayer.addChild(cont);
        v = { cont, art, nameT, castT, buffT, petBox, petKey: '' };
        this.pViews.set(sid, v);
      }
      v.cont.position.set(PLAYER_XS[p.slot] ?? 110, GROUND_Y);
      v.cont.alpha = p.alive ? 1 : 0.25;
      // ポーズはサーバーが決めた番号をそのまま使う。
      // 自分の画面だけで判断すると、通信の遅れで人によって違う絵になる。
      setPlayerSpritePose(v.art, clampCharId(p.charId),
        p.alive ? poseName(p.pose) : 'hurt');
      // 誰が何を詠唱しているかを表示
      v.castT.text = p.castingIdx >= 0 && p.castName ? `✦ ${p.castName}` : '';

      // かかっている効果を全員に見せる(全体魔法なら3人とも点灯する)
      const buffs: string[] = [];
      if (p.shield > 0) buffs.push('🛡');
      if (p.wardPct > 0) buffs.push(`◈${p.wardPct}%`);
      if (p.atkBoost > 0) buffs.push(`⚔+${p.atkBoost}%`);
      if (p.vigorBonus > 0) buffs.push(`♥+${p.vigorBonus}`);
      if (p.mpRegenBonus > 0) buffs.push(`✦MP+${Number(p.mpRegenBonus).toFixed(1)}`);
      v.buffT.text = buffs.join(' ');
      // 連れているペット。種類が変わった時だけ絵を作り直す
      // (毎フレーム作ると、鳥1羽のために60回/秒テクスチャを張り替えることになる)
      const species = String(p.petSpecies ?? '');
      if (species !== v.petKey) {
        v.petKey = species;
        v.petBox.removeChildren();
        const sp = species ? petArt(species, cs(32)) : null;
        if (sp) v.petBox.addChild(sp);
        else if (species && PET_SPECIES[species as keyof typeof PET_SPECIES]) {
          // 絵が無い環境では絵文字で出す(素材未導入でも動く作りに合わせる)
          const t = new Text({
            text: PET_SPECIES[species as keyof typeof PET_SPECIES].emoji,
            style: {
              fontSize: 30, fontFamily: 'Meiryo, sans-serif',
              dropShadow: { color: 0x000000, alpha: 0.9, blur: 5, distance: 0, angle: 0 },
            },
          });
          t.anchor.set(0.5); v.petBox.addChild(t);
        }
      }
      v.petBox.y = -cs(152) + Math.sin(performance.now() / 450 + p.slot) * 3;
    });
    for (const [sid, v] of this.pViews) {
      if (!seen.has(sid)) {
        v.cont.destroy({ children: true });
        this.pViews.delete(sid);
      }
    }
  }

  private syncEnemies(st: any): void {
    const enemies: any[] = [];
    st.enemies.forEach((e: any) => enemies.push(e));

    // ステージが替わって敵の顔ぶれが変わったら、絵も下の表示も作り直す。
    //
    // 以前は「数が減った時」しか作り直していなかった。ボス(1体)から
    // ステージ6(2体)へ進むと数は増えるだけなので作り直されず、
    // ボスの絵が残ったまま、HPバーの下の行も1体ぶんの古い内容が残っていた。
    // 数ではなく顔ぶれで見る。
    const sig = enemies.map((e: any) => `${String(e.defId)}/${Number(e.maxHp)}`).join(',');
    if (sig !== this.enemySig) {
      this.enemySig = sig;
      for (const v of this.eViews) v.cont.destroy({ children: true });
      this.eViews = [];
      this.statusEls = [];
      this.statusBuilt = false;
      this.$('#coop-enemy-status').innerHTML = '';
    }
    while (this.eViews.length < enemies.length) {
      const e = enemies[this.eViews.length];
      const def = DEF_BY_ID[e.defId] ?? ALL_ENEMIES[0];
      const { cont, body } = makeEnemySprite(def);
      cont.position.set(e.x, GROUND_Y);
      const nameT = new Text({
        text: e.name,
        style: { fill: 0xccccdd, fontSize: 12, fontFamily: 'Meiryo, sans-serif' },
      });
      nameT.anchor.set(0.5);
      nameT.position.set(0, enemyTopY(def) - 30);
      cont.addChild(nameT);
      this.entityLayer.addChild(cont);
      this.eViews.push({ cont, body, def });
    }
    if (!this.statusBuilt && enemies.length > 0) this.buildEnemyStatus(enemies);
    enemies.forEach((e, i) => {
      const v = this.eViews[i];
      if (!v) return;
      v.cont.alpha = e.alive ? 1 : 0.25;
      v.body.tint = e.frozen ? 0x88ccff : 0xffffff;
      setEnemySpritePose(v.body, v.def, e.alive ? poseName(e.pose) : 'hurt');
      const s = this.statusEls[i];
      if (s) {
        s.hpFill.style.width = `${Math.max(0, e.hp / e.maxHp) * 100}%`;
        s.hpText.textContent = `HP ${Math.max(0, Math.ceil(e.hp))}/${e.maxHp}`;
        s.card.classList.toggle('dead', !e.alive);
      }
    });
  }

  private updateWaiting(st: any): void {
    const waiting = this.$('#coop-waiting');
    // 準備待ち中は下の魔法バーを隠す(オーバーレイ越しに見えても押せないため)
    this.$('#coop-bar').classList.toggle('hidden', st.phase === 'ready');
    if (st.phase !== 'ready') {
      waiting.classList.add('hidden');
      this.waitingHtml = '';
      return;
    }
    const me: any = st.players.get(this.mySid);
    const rows: string[] = [];
    st.players.forEach((p: any) => {
      rows.push(`<div class="eq-row">${esc(p.name)} ${p.ready ? '— 準備完了!' : '— 待機中…'}</div>`);
    });
    const boss = Number(st.stage) % 5 === 0;
    const solo = st.players.size < 2;
    const html =
      `<div class="result-box">` +
      `<h2>出撃準備 (ステージ ${st.stage}${boss ? ' 👑ボス戦' : ''})</h2>` +
      rows.join('') +
      (boss && solo
        ? `<p class="chance-mid" style="margin:10px 0">👑 1人でも挑めるが、ボスは手強い。仲間を待つのも手。</p>`
        : `<p class="note" style="margin:10px 0">全員が準備完了になると開始。最大3人まで途中参加できる。</p>`) +
      `<div style="display:flex; gap:8px; justify-content:center">` +
      `<button id="btn-coop-ready" ${me?.ready ? 'disabled' : ''}>` +
      `${me?.ready ? '開始を待っている…' : '準備完了!'}</button>` +
      `<button id="btn-coop-leave">退出</button>` +
      `</div></div>`;
    if (html !== this.waitingHtml) {
      waiting.innerHTML = html;
      waiting.querySelector('#btn-coop-ready')?.addEventListener('click', () => {
        this.room?.send('ready');
      });
      waiting.querySelector('#btn-coop-leave')?.addEventListener('click', () => {
        this.exitNow();
      });
      this.waitingHtml = html;
    }
    waiting.classList.remove('hidden');
  }

  private updateBar(st: any, dt: number): void {
    const me: any = st.players.get(this.mySid);
    if (me) {
      if (this.prevCastingIdx >= 0 && me.castingIdx === -1) {
        const sp = this.spells[this.prevCastingIdx];
        this.cds[this.prevCastingIdx] = sp ? spellCooldown(sp.stats) : 1.2 + this.prevCastTotal * 0.5;
        stopSfxLoop('casting');
        playSfx('cast');
      } else if (this.prevCastingIdx === -1 && me.castingIdx >= 0) {
        startSfxLoop('casting');
      }
      this.prevCastingIdx = me.castingIdx;
      if (me.castingIdx >= 0) this.prevCastTotal = me.castTotal;
    }
    for (let i = 0; i < this.cds.length; i++) this.cds[i] = Math.max(0, this.cds[i] - dt);

    this.spells.forEach((sp, i) => {
      const b = this.spellBtns[i];
      if (!b) return;
      const total = spellCooldown(sp.stats);
      const overlay = b.querySelector('.cd-overlay') as HTMLElement;
      overlay.style.width = this.cds[i] > 0 ? `${(this.cds[i] / total) * 100}%` : '0%';
      b.disabled = !me || !me.alive || me.castingIdx >= 0 || this.cds[i] > 0
        || me.mp < sp.stats.manaCost || st.phase !== 'fight';
    });
  }

  private drawBars(st: any): void {
    const g = this.barsG;
    g.clear();

    const me: any = st.players.get(this.mySid);
    if (me) {
      g.rect(16, 16, 220, 16).fill(0x222238);
      g.rect(16, 16, 220 * Math.max(0, me.hp / me.maxHp), 16).fill(0x55cc66);
      g.rect(16, 38, 220, 12).fill(0x222238);
      g.rect(16, 38, 220 * Math.max(0, me.mp / me.maxMp), 12).fill(0x5588ee);
    }

    // 最もヘイトが高い(狙われやすい)プレイヤーに▼マーク
    let topSid = '';
    let topHate = 0;
    st.players.forEach((p: any, sid: string) => {
      if (p.alive && p.hate > topHate) { topHate = p.hate; topSid = sid; }
    });

    // 各プレイヤーの頭上バー
    st.players.forEach((p: any, sid: string) => {
      const x = PLAYER_XS[p.slot] ?? 110;
      if (sid === topSid && st.phase === 'fight') {
        g.poly([x - cs(7), cy(132), x + cs(7), cy(132), x, cy(121)])
          .fill(0xff8844);
      }
      g.rect(x - cs(26), cy(108), cs(52), 6).fill(0x222238);
      g.rect(x - cs(26), cy(108), cs(52) * Math.max(0, p.hp / p.maxHp), 6).fill(0x55cc66);
      // 仲間のMPも見えるようにする(誰が息切れしているか分かる)
      g.rect(x - cs(26), cy(101), cs(52), 3).fill(0x222238);
      g.rect(x - cs(26), cy(101), cs(52) * Math.max(0, p.mp / p.maxMp), 3).fill(0x5588ee);
      if (p.shield > 0) {
        g.rect(x - cs(26), cy(113), cs(52) * Math.min(1, p.shield / p.maxHp), 3).fill(0x88ccff);
        g.circle(x, cy(50), cs(46)).stroke({ width: 2, color: 0x88ccff, alpha: 0.4 });
      }
      // 耐性・攻撃上昇がかかっている間は足元の輪で示す(全員に見える)
      if (p.wardPct > 0) {
        g.circle(x, cy(50), cs(52)).stroke({ width: 2, color: 0x88ffcc, alpha: 0.35 });
      }
      if (p.atkBoost > 0) {
        g.circle(x, cy(50), cs(40)).stroke({ width: 2, color: 0xff8844, alpha: 0.4 });
      }
      if (p.castingIdx >= 0 && p.castTotal > 0) {
        const k = Math.min(1, p.castT / p.castTotal);
        g.rect(x - cs(26), cy(96), cs(52), 5).fill(0x222238);
        g.rect(x - cs(26), cy(96), cs(52) * k, 5).fill(0xffdd66);
      }
    });

    // 敵の頭上HPバー
    st.enemies.forEach((e: any) => {
      if (!e.alive) return;
      const def = DEF_BY_ID[e.defId];
      const top = GROUND_Y + (def ? enemyTopY(def) : -70) - 14;
      g.rect(e.x - 28, top, 56, 7).fill(0x222238);
      g.rect(e.x - 28, top, 56 * Math.max(0, e.hp / e.maxHp), 7).fill(0xdd5566);
      // 敵の状態異常(誰がかけたものでも全員に見える)
      const marks: number[] = [];
      if (e.sealed) marks.push(0xbb77ee);   // 封印
      if (e.frozen) marks.push(0x88ccff);   // 凍結
      if (e.slowed) marks.push(0x66ddcc);   // 鈍化
      if (e.burning) marks.push(0x99ee66);  // 継続ダメージ
      marks.forEach((c, mi) => {
        g.circle(e.x - 28 + 5 + mi * 11, top - 6, 3.5).fill(c);
      });
    });
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
}

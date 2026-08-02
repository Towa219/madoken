// 共闘バトル画面(サーバー状態の描画専用。判定はすべてサーバー側)

import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Room } from 'colyseus.js';
import {
  affinitySymbol, ALL_ENEMIES, ELEMENTS, ELEMENT_ORDER, enemyTopY, SPRITE_SCALE,
} from '../shared/data';
import type { AffinityGrade, EnemyDef } from '../shared/data';
import { makeEnemySprite, makePlayerSprite, makeProjectileGfx } from './battle';
import { clampCharId } from '../shared/characters';
import { spellCooldown, spellDisplayName } from '../shared/spellcraft';
import { markGained, showToast } from './lab';
import { addElements, equippedSpells, markBossCleared, notify, state } from './state';
import type { ElementId, Spell } from '../shared/types';
import { playSfx, startSfxLoop, stopAllSfxLoops, stopSfxLoop } from './sound';

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

  private room: Room | null = null;
  private mySid = '';
  private spells: Spell[] = [];
  private onExit: (() => void) | null = null;
  private exited = true;

  private pViews = new Map<
    string, { cont: Container; nameT: Text; castT: Text; buffT: Text }
  >();
  private eViews: { cont: Container; body: Graphics | Sprite }[] = [];
  private anims: Anim[] = [];
  private popups: Popup[] = [];
  private fxs: Fx[] = [];

  private cds = [0, 0, 0, 0];
  private shakeT = 0;
  private prevCastingIdx = -1;
  private prevCastTotal = 0;
  private spellBtns: HTMLButtonElement[] = [];
  private statusEls: { card: HTMLElement; hpFill: HTMLElement; hpText: HTMLElement }[] = [];
  private statusBuilt = false;
  private waitingHtml = '';
  // 中断/決着の通知を受け取ったか。受け取らずに切れた場合は通信不良。
  private toldWhy = false;

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

  async start(room: Room, onExit: () => void): Promise<void> {
    await this.ensureApp();
    this.room = room;
    this.mySid = room.sessionId;
    this.onExit = onExit;
    this.exited = false;
    this.spells = equippedSpells().slice(0, 4);
    this.cds = [0, 0, 0, 0];
    this.prevCastingIdx = -1;
    this.pViews.clear();
    this.eViews = [];
    this.anims = [];
    this.popups = [];
    this.fxs = [];
    this.statusBuilt = false;
    this.waitingHtml = '';
    this.toldWhy = false;
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
      b.addEventListener('click', () => this.tryCast(i));
      bar.appendChild(b);
      this.spellBtns.push(b);
    });
    // 退出は魔法ボタンと同じ行に置くと押し間違えるので、下の段に分ける
    const escRow = document.createElement('div');
    escRow.className = 'escape-row';
    const esc2 = document.createElement('button');
    esc2.id = 'btn-escape';
    esc2.textContent = '退出';
    esc2.addEventListener('click', () => this.exitNow());
    escRow.appendChild(esc2);
    bar.appendChild(escRow);
    bar.classList.remove('hidden');
  }

  // どんな状態でも確実に共闘画面から抜ける(サーバーへのleaveは投げっぱなし)
  private exitNow(): void {
    try { void this.room?.leave(); } catch { /* 切断済みでも無視 */ }
    this.handleExit();
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
    room.onMessage('stageclear', (m: {
      stage: number; drops: ElementId[]; rp: number; boss?: boolean;
    }) => {
      addElements(m.drops);
      markGained(m.drops);
      state.researchP += m.rp;
      state.bestStage = Math.max(state.bestStage, m.stage);
      state.maxStage = Math.max(state.maxStage, m.stage + 1);
      if (m.boss) markBossCleared(m.stage);
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
      this.handleExit();
    });
    room.onLeave(() => this.leftUnexpectedly());
    room.onError(() => this.leftUnexpectedly());
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

  // 中断や決着の知らせが無いまま切れた場合は、理由を伝えてから戻る
  private leftUnexpectedly(): void {
    if (!this.exited && !this.toldWhy) {
      showToast('通信が切れたため共闘から退出した。ロビーで入り直してください。');
    }
    this.handleExit();
  }

  private handleExit(): void {
    if (this.exited) return;
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

    const bossFight = Number(st.stage) % 5 === 0;
    this.stageText.text = `ステージ ${st.stage}${bossFight ? ' — ボス戦' : ''} (共闘)`;

    this.syncPlayers(st);
    this.syncEnemies(st);
    this.updateWaiting(st);
    this.updateBar(st, dt);
    this.drawBars(st);

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
        cont.addChild(makePlayerSprite(clampCharId(p.charId)));
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
        this.entityLayer.addChild(cont);
        v = { cont, nameT, castT, buffT };
        this.pViews.set(sid, v);
      }
      v.cont.position.set(PLAYER_XS[p.slot] ?? 110, GROUND_Y);
      v.cont.alpha = p.alive ? 1 : 0.25;
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
    // ステージ切替で敵が入れ替わったら表示をリセット
    if (enemies.length < this.eViews.length) {
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
      this.eViews.push({ cont, body });
    }
    if (!this.statusBuilt && enemies.length > 0) this.buildEnemyStatus(enemies);
    enemies.forEach((e, i) => {
      const v = this.eViews[i];
      if (!v) return;
      v.cont.alpha = e.alive ? 1 : 0.25;
      v.body.tint = e.frozen ? 0x88ccff : 0xffffff;
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

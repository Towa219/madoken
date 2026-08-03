// PvP 決闘画面(サーバー状態の描画専用)

import { Application, Container, Graphics, Text } from 'pixi.js';
import type { Room } from 'colyseus.js';
import { ELEMENTS, EQUIP_MAX, SPRITE_SCALE , RECONNECT_TRIES, RECONNECT_WAIT_MS } from '../shared/data';
import { clampCharId } from '../shared/characters';
import { spellCooldown, spellDisplayName } from '../shared/spellcraft';
import {
  COUNT_STYLE, makePlayerSprite, makeProjectileGfx, START_LABEL,
} from './battle';
import { showToast } from './lab';
import { equippedSpells } from './state';
import { playSfx, startSfxLoop, stopAllSfxLoops, stopSfxLoop } from './sound';
import type { ElementId, Spell } from '../shared/types';

const W = 960;
const H = 540;
const GROUND_Y = 460;

// キャラまわりの座標は SPRITE_SCALE と一緒に動かす(battle.ts と同じ考え方)。
const cy = (n: number) => GROUND_Y - n * SPRITE_SCALE;
const cs = (n: number) => n * SPRITE_SCALE;
const XS = [140, 820];

interface Anim {
  g: Container; x0: number; y0: number; x1: number; y1: number;
  t: number; dur: number; attr: ElementId; r: number; trailT: number;
}
interface Popup { t: Text; vy: number; life: number; }
interface Fx { g: Graphics; life: number; maxLife: number; grow?: boolean; }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class DuelView {
  private app: Application | null = null;
  private root: Container | null = null;
  private entityLayer!: Container;
  private projLayer!: Container;
  private fxLayer!: Container;
  private uiLayer!: Container;
  private barsG!: Graphics;
  private countText!: Text;

  private room: Room | null = null;
  private mySid = '';
  private spells: Spell[] = [];
  private onExit: (() => void) | null = null;
  // 切れた時に決闘へ戻るための手段。ロビー側から渡してもらう。
  private reconnect: ((token: string) => Promise<Room | null>) | null = null;
  private token = '';
  private reconnecting = false;
  private exited = true;
  // 決着・棄権・入れ替わりのいずれかを本人に伝えたか
  private toldWhy = false;

  private pViews = new Map<string, Container>();
  private anims: Anim[] = [];
  private popups: Popup[] = [];
  private fxs: Fx[] = [];
  private cds = [0, 0, 0, 0];
  private prevCastingIdx = -1;
  private prevCount = -99; // 直前に鳴らしたカウント
  private spellBtns: HTMLButtonElement[] = [];
  private waitingHtml = '';

  private $(sel: string): HTMLElement {
    return document.querySelector(sel) as HTMLElement;
  }

  private async ensureApp(): Promise<void> {
    if (this.app) return;
    const app = new Application();
    await app.init({ width: W, height: H, backgroundColor: 0x120b18, antialias: true });
    this.$('#duel-canvas').appendChild(app.canvas);
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
    this.toldWhy = false;
    this.spells = equippedSpells().slice(0, EQUIP_MAX);
    this.cds = [0, 0, 0, 0];
    this.prevCastingIdx = -1;
    this.prevCount = -99;
    this.pViews.clear();
    this.anims = [];
    this.popups = [];
    this.fxs = [];
    this.waitingHtml = '';
    this.$('#duel-overlay').classList.add('hidden');

    this.buildScene();
    this.buildBar();
    this.wireRoom(room);
  }

  tryCast(i: number): void {
    if (!this.room || this.exited) return;
    if (this.cds[i] > 0) return;
    this.room.send('cast', { idx: i });
  }

  private buildScene(): void {
    const app = this.app!;
    if (this.root) {
      app.stage.removeChild(this.root);
      this.root.destroy({ children: true });
    }
    const root = new Container();
    app.stage.addChild(root);
    this.root = root;

    // 決闘場(コロシアム風の背景)
    const bg = new Graphics();
    bg.rect(0, 0, W, H).fill(0x120b18);
    for (let i = 0; i < 30; i++) {
      const sx = (i * 151 + 40) % W;
      const sy = (i * 97 + 30) % (GROUND_Y - 160);
      bg.circle(sx, sy, 1.2).fill({ color: 0xffddff, alpha: 0.35 });
    }
    bg.circle(W / 2, 120, 70).fill({ color: 0x662255, alpha: 0.25 });
    bg.rect(0, GROUND_Y, W, H - GROUND_Y).fill(0x241a2c);
    bg.rect(0, GROUND_Y, W, 4).fill(0x5a3a6a);
    bg.moveTo(W / 2, GROUND_Y).lineTo(W / 2, H).stroke({ width: 2, color: 0x5a3a6a, alpha: 0.5 });
    root.addChild(bg);

    this.entityLayer = new Container();
    this.projLayer = new Container();
    this.fxLayer = new Container();
    this.uiLayer = new Container();
    root.addChild(this.entityLayer, this.projLayer, this.fxLayer, this.uiLayer);

    this.barsG = new Graphics();
    this.uiLayer.addChild(this.barsG);

    this.countText = new Text({ text: '', style: { ...COUNT_STYLE } });
    this.countText.anchor.set(0.5);
    this.countText.position.set(W / 2, H / 2 - 30);
    this.uiLayer.addChild(this.countText);
  }

  private buildBar(): void {
    const bar = this.$('#duel-bar');
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
    // 棄権は魔法ボタンと同じ行に置くと押し間違えるので、下の段に分ける
    const escRow = document.createElement('div');
    escRow.className = 'escape-row';
    const leave = document.createElement('button');
    leave.id = 'btn-escape';
    leave.textContent = '棄権';
    leave.addEventListener('click', () => this.exitNow());
    escRow.appendChild(leave);
    bar.appendChild(escRow);
  }

  private exitNow(): void {
    this.toldWhy = true;
    try { void this.room?.leave(); } catch { /* 切断済みでも無視 */ }
    this.handleExit();
  }

  // 決着も棄権も無いまま切れた場合。
  // 電波が一瞬途切れただけのことが多いので、まず決闘へ戻ることを試みる。
  private async handleDisconnect(): Promise<void> {
    if (this.exited || this.toldWhy) { this.handleExit(); return; }
    if (this.reconnecting) return;
    this.reconnecting = true;
    showToast('通信が切れた。決闘への復帰を試みている…');

    const back = await this.tryReconnect();
    this.reconnecting = false;
    if (back) {
      showToast('決闘に復帰した。');
      return;
    }
    showToast('決闘に復帰できなかった。'
      + 'サーバーが更新された可能性がある。ロビーから入り直してほしい。');
    this.handleExit();
  }

  // 少し間を置いて何度か試す。
  //
  // 粘る時間はサーバーが席を空けて待つ秒数(RECONNECT_SEC)に合わせること。
  // 以前は2.5秒×6回=15秒で諦めていて、サーバーはまだ30秒待つ気なのに
  // クライアントが先に投げ出していた。回線が20秒切れただけで戻れなくなる。
  private async tryReconnect(): Promise<boolean> {
    if (!this.reconnect || !this.token) return false;
    for (let i = 0; i < RECONNECT_TRIES; i++) {
      await new Promise(r => setTimeout(r, RECONNECT_WAIT_MS));
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
        console.warn('[決闘] 復帰に失敗:', (err as { message?: string })?.message ?? err);
      }
    }
    return false;
  }

  private handleExit(): void {
    if (this.exited) return;
    this.exited = true;
    stopAllSfxLoops();
    this.room = null;
    this.$('#duel-bar').innerHTML = '';
    this.$('#duel-waiting').classList.add('hidden');
    this.onExit?.();
  }

  private wireRoom(room: Room): void {
    room.onMessage('dproj', (m: {
      sid: string; x0: number; targetX: number; attr: ElementId;
      power: number; delayMs: number;
    }) => {
      if (m.sid !== this.mySid) playSfx('enemyCast'); // 相手の詠唱完了
      const r = 5 + Math.min(10, m.power / 25);
      const g = makeProjectileGfx(m.attr, m.power);
      if (m.x0 > m.targetX) g.scale.x = -1; // 右→左は反転
      this.projLayer.addChild(g);
      this.anims.push({
        g, x0: m.x0, y0: cy(64), x1: m.targetX, y1: cy(56),
        t: 0, dur: m.delayMs / 1000, attr: m.attr, r, trailT: 0,
      });
    });

    room.onMessage('dhit', (m: {
      sid: string; amount: number; crit: boolean; attr: ElementId; radius: number;
    }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      playSfx(m.sid === this.mySid ? 'damage' : (m.crit ? 'crit' : 'hit'));
      const x = XS[p.slot] ?? 140;
      this.addPopup(x, cy(105), `${m.amount}${m.crit ? ' 会心!' : ''}`,
        m.crit ? 0xffdd44 : 0xff7755);
      const ring = new Graphics();
      ring.circle(0, 0, 12).stroke({ width: 3, color: ELEMENTS[m.attr]?.color ?? 0xffffff, alpha: 0.9 });
      ring.position.set(x, cy(56));
      this.fxLayer.addChild(ring);
      this.fxs.push({ g: ring, life: 0.28, maxLife: 0.28, grow: true });
    });

    room.onMessage('dheal', (m: { sid: string; amount: number }) => {
      playSfx('heal');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(118), `+${m.amount}`, 0x88ddaa);
    });
    room.onMessage('dshield', (m: { sid: string; amount: number }) => {
      playSfx('shield');
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(118), `護盾+${m.amount}`, 0x88ccff);
    });
    room.onMessage('dshieldhit', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(118), `盾-${m.amount}`, 0x88ccff);
    });
    room.onMessage('dguard', (m: { sid: string }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(125), '構え! 被弾-20%', 0xffaa66);
    });
    room.onMessage('dward', (m: { sid: string; pct: number; attr: string }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      const label = m.attr
        ? `${ELEMENTS[m.attr as ElementId]?.name ?? ''}耐性${m.pct}%`
        : `全属性耐性${m.pct}%`;
      this.addPopup(XS[p.slot] ?? 140, cy(132), label, 0x88ffcc);
    });
    room.onMessage('dwardhit', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(132), `耐性 -${m.amount}`, 0x88ffcc);
    });
    room.onMessage('dseal', (m: { sid: string; sec: number; resisted?: boolean }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (!p) return;
      // 護符を張っていれば封印は弾かれる
      if (m.resisted || m.sec <= 0) {
        this.addPopup(XS[p.slot] ?? 140, cy(145), 'レジスト!', 0xff9977);
      } else {
        this.addPopup(XS[p.slot] ?? 140, cy(145), `封印! ${m.sec.toFixed(1)}秒`, 0xbb77ee);
      }
    });
    room.onMessage('dempower', (m: { sid: string; pct: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(145), `与ダメ+${m.pct}%`, 0xff8844);
    });
    room.onMessage('dfocus', (m: { sid: string; perSec: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) {
        this.addPopup(
          XS[p.slot] ?? 140, cy(152),
          `瞑想 MP+${m.perSec.toFixed(1)}/秒`, 0x88ccff,
        );
      }
    });
    room.onMessage('dvigor', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(145), `最大HP+${m.amount}`, 0xffcc66);
    });
    room.onMessage('ddot', (m: { sid: string; amount: number }) => {
      const st: any = room.state;
      const p = st?.players?.get(m.sid);
      if (p) this.addPopup(XS[p.slot] ?? 140, cy(95), `${m.amount}`, 0x99ee66);
    });

    room.onMessage('duelend', (m: { win: boolean; reason: string }) => {
      this.toldWhy = true;
      const overlay = this.$('#duel-overlay');
      overlay.innerHTML =
        `<div class="result-box">` +
        `<h2 class="${m.win ? 'win' : 'lose'}">${m.win ? '⚔ 勝利!' : '敗北…'}</h2>` +
        (m.reason ? `<div>${esc(m.reason)}</div>` : '') +
        `<div style="margin-top:16px">` +
        `<button id="btn-duel-back">ロビーへ戻る</button></div></div>`;
      overlay.classList.remove('hidden');
      overlay.querySelector('#btn-duel-back')?.addEventListener('click', () => this.exitNow());
    });

    // 同じ名前で別の戦闘部屋に入った場合(coop.ts と同じ扱い)
    room.onMessage('replaced', () => {
      this.toldWhy = true;
      showToast('同じ名前で別の戦闘に入ったため、こちらの決闘を終了した。');
      void room.leave();
      this.handleExit();
    });
    // 相手が切れた/戻ってきた
    // 自分のことは出さない(「復帰を試みている」を上書きしてしまうため)
    room.onMessage('dwait', (m: { sid: string; name: string; sec: number }) => {
      if (m.sid === this.mySid) return;
      showToast(`${m.name} の通信が切れた。${m.sec}秒だけ復帰を待つ…`);
    });
    room.onMessage('dback', (m: { sid: string; name: string }) => {
      if (m.sid === this.mySid) return;
      showToast(`${m.name} が決闘に戻ってきた。再開する。`);
    });

    // 決着も棄権も無いまま切れた場合。まず復帰を試み、駄目なら理由を伝えて戻る。
    room.onLeave(() => void this.handleDisconnect());
    room.onError(() => void this.handleDisconnect());
  }

  private tick(dt: number): void {
    if (!this.room || this.exited) return;
    const st: any = this.room.state;
    if (!st || !st.players) return;

    this.syncPlayers(st);
    this.updateWaiting(st);
    this.updateBar(st, dt);
    this.drawBars(st);

    // カウントダウン
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
    }

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
      if (fx.grow) { fx.g.scale.x += 2.2 * dt; fx.g.scale.y += 2.2 * dt; }
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
      let cont = this.pViews.get(sid);
      if (!cont) {
        cont = new Container();
        if (sid === this.mySid) {
          const ring = new Graphics();
          ring.ellipse(0, 2, cs(26), cs(7)).stroke({ width: 2, color: 0xffdd66, alpha: 0.9 });
          cont.addChild(ring);
        }
        const sprite = makePlayerSprite(clampCharId(p.charId));
        if (p.slot === 1) sprite.scale.x = -1; // 右側は向かい合わせ
        cont.addChild(sprite);
        const nameT = new Text({
          text: p.name,
          style: {
            fill: sid === this.mySid ? 0xffdd66 : 0xff9999,
            fontSize: 13, fontFamily: 'Meiryo, sans-serif',
          },
        });
        nameT.anchor.set(0.5);
        nameT.position.set(0, -cs(128));
        cont.addChild(nameT);
        // 詠唱中の魔法名(相手にも見える)
        const castT = new Text({
          text: '',
          style: { fill: 0xffdd66, fontSize: 12, fontFamily: 'Meiryo, sans-serif' },
        });
        castT.anchor.set(0.5);
        castT.position.set(0, -cs(144));
        castT.label = 'castT';
        cont.addChild(castT);
        // かかっている効果
        const buffT = new Text({
          text: '',
          style: { fill: 0x88ffcc, fontSize: 11, fontFamily: 'Meiryo, sans-serif' },
        });
        buffT.anchor.set(0.5);
        buffT.position.set(0, -cs(112));
        buffT.label = 'buffT';
        cont.addChild(buffT);
        this.entityLayer.addChild(cont);
        this.pViews.set(sid, cont);
      }
      cont.position.set(XS[p.slot] ?? 140, GROUND_Y);
      cont.alpha = p.alive ? 1 : 0.25;

      const castT = cont.getChildByLabel('castT') as Text | null;
      if (castT) {
        castT.text = p.castingIdx >= 0 && p.castName ? `✦ ${p.castName}` : '';
      }
      const buffT = cont.getChildByLabel('buffT') as Text | null;
      if (buffT) {
        const buffs: string[] = [];
        if (p.shield > 0) buffs.push('🛡');
        if (p.guard > 0) buffs.push(`構え-${p.guard}%`);
        if (p.wardPct > 0) buffs.push(`◈${p.wardPct}%`);
        if (p.atkBoost > 0) buffs.push(`⚔+${p.atkBoost}%`);
        if (p.vigorBonus > 0) buffs.push(`♥+${p.vigorBonus}`);
        if (p.mpRegenBonus > 0) buffs.push(`✦MP+${Number(p.mpRegenBonus).toFixed(1)}`);
        if (p.sealed) buffs.push('封印中');
        buffT.text = buffs.join(' ');
      }
    });
    for (const [sid, cont] of this.pViews) {
      if (!seen.has(sid)) { cont.destroy({ children: true }); this.pViews.delete(sid); }
    }
  }

  private updateWaiting(st: any): void {
    const waiting = this.$('#duel-waiting');
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
    const solo = st.players.size < 2;
    const html =
      `<div class="result-box">` +
      `<h2>⚔ 決闘の準備</h2>` +
      rows.join('') +
      (solo
        ? `<p class="chance-mid" style="margin:10px 0">対戦相手を待っている…(この部屋のURLではなく、相手も「決闘に参加」を押すと合流します)</p>`
        : `<p class="note" style="margin:10px 0">2人とも準備完了で開始。</p>`) +
      `<div style="display:flex; gap:8px; justify-content:center">` +
      `<button id="btn-duel-ready" ${me?.ready ? 'disabled' : ''}>` +
      `${me?.ready ? '相手を待っている…' : '準備完了!'}</button>` +
      `<button id="btn-duel-leave">やめる</button>` +
      `</div></div>`;
    if (html !== this.waitingHtml) {
      waiting.innerHTML = html;
      waiting.querySelector('#btn-duel-ready')?.addEventListener('click', () => {
        this.room?.send('ready');
      });
      waiting.querySelector('#btn-duel-leave')?.addEventListener('click', () => this.exitNow());
      this.waitingHtml = html;
    }
    waiting.classList.remove('hidden');
  }

  private updateBar(st: any, dt: number): void {
    const me: any = st.players.get(this.mySid);
    if (me) {
      if (this.prevCastingIdx >= 0 && me.castingIdx === -1) {
        const sp = this.spells[this.prevCastingIdx];
        if (sp) this.cds[this.prevCastingIdx] = spellCooldown(sp.stats);
        stopSfxLoop('casting');
        playSfx('cast');
      } else if (this.prevCastingIdx === -1 && me.castingIdx >= 0) {
        startSfxLoop('casting');
      }
      this.prevCastingIdx = me.castingIdx;
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
    st.players.forEach((p: any, sid: string) => {
      const mine = sid === this.mySid;
      // バーの左右は立ち位置(slot)に合わせる。
      // 「自分かどうか」で決めていたため、自分が右側(slot 1)に入った時に
      // キャラは右・バーは左となって食い違っていた。
      // 色は自分かどうかで変える(緑=自分・赤=相手)ので見分けはつく。
      const bx = p.slot === 1 ? W - 236 : 16;
      // 画面上部の大きなHP/MPバー
      g.rect(bx, 16, 220, 16).fill(0x222238);
      g.rect(bx, 16, 220 * Math.max(0, p.hp / p.maxHp), 16)
        .fill(mine ? 0x55cc66 : 0xcc5566);
      g.rect(bx, 38, 220, 10).fill(0x222238);
      g.rect(bx, 38, 220 * Math.max(0, p.mp / p.maxMp), 10).fill(0x5588ee);
      if (p.shield > 0) {
        g.rect(bx, 10, 220 * Math.min(1, p.shield / p.maxHp), 4).fill(0x88ccff);
      }

      // 足元の状態
      const x = XS[p.slot] ?? 140;
      if (p.shield > 0) {
        g.circle(x, cy(50), cs(52)).stroke({ width: 3, color: 0x88ccff, alpha: 0.4 });
      }
      if (p.guard > 0) {
        g.circle(x, cy(50), cs(46)).stroke({ width: 2, color: 0xffaa66, alpha: 0.5 });
      }
      if (p.castingIdx >= 0 && p.castTotal > 0) {
        const k = Math.min(1, p.castT / p.castTotal);
        g.rect(x - cs(40), cy(140), cs(80), 8).fill(0x222238);
        g.rect(x - cs(40), cy(140), cs(80) * k, 8).fill(0xffdd66);
      }
    });
  }

  private addPopup(x: number, y: number, text: string, color: number): void {
    const t = new Text({
      text,
      style: {
        fill: color, fontSize: 17, fontFamily: 'Meiryo, sans-serif', fontWeight: 'bold',
        stroke: { color: 0x000000, width: 3 },
      },
    });
    t.anchor.set(0.5);
    t.position.set(x + (Math.random() - 0.5) * 20, y);
    this.uiLayer.addChild(t);
    this.popups.push({ t, vy: -40, life: 0.9 });
  }
}

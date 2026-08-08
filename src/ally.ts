// お供AI 1体ぶんの中身。
//
// プレイヤーと同じ決まりで動く ― 詠唱時間があり、再使用時間があり、
// MPを使い、切れれば撃てなくなる。人間の共闘と同じ手応えにするため、
// ここは「AIだから」と簡略化しない。
//
// 画面には触らない。撃つと決めたことを戦闘側(src/battle.ts)へ返し、
// 弾やエフェクトは戦闘側がプレイヤーと同じ経路で出す。
// そうしておくと、演出を直した時にお供にも自動で効く。

import {
  ALLY_CD_MUL, ALLY_MAX_HP, ALLY_MAX_MP, ALLY_MP_REGEN, ALLY_TAUNT_SEC,
  ALLY_THINK_SEC, allyDefFor, chooseAllySpell,
} from '../shared/allies';
import { computeSpell, finalStats, spellCooldown, spellNameFor } from '../shared/spellcraft';
import type { AllyDef, AllyRole, AllySight } from '../shared/allies';
import type { ElementId, Spell } from '../shared/types';

// 撃つと決まった時に戦闘側へ渡すもの
export interface AllyCast {
  spell: Spell;
  role: AllyRole;
}

export class Ally {
  readonly def: AllyDef;
  readonly charId: number;
  readonly spells: Spell[] = [];

  maxHp = ALLY_MAX_HP;
  hp = ALLY_MAX_HP;
  maxMp = ALLY_MAX_MP;
  mp = ALLY_MAX_MP;
  alive = true;

  // 効いている支援。プレイヤー側と同じ考え方で持つ。
  shield = 0;
  shieldTimer = 0;
  ward: { attr: ElementId | null; pct: number; timer: number } | null = null;
  atkBoost = 0;
  atkBoostTimer = 0;
  mpRegenBonus = 0;
  mpRegenTimer = 0;
  vigorBonus = 0;
  vigorTimer = 0;
  tauntTimer = 0;

  casting: { spell: Spell; role: AllyRole; t: number } | null = null;
  private cooldowns: number[] = [];
  private thinkT = 0;

  constructor(charId: number) {
    const def = allyDefFor(charId);
    if (!def) throw new Error(`お供の設定が無い: charId=${charId}`);
    this.def = def;
    this.charId = charId;

    // 持ち物を組み立てる。すべてノーマル品質・強化なし。
    // キャラ補正(得意エレメント+10%)は finalStats に charId を渡して効かせる。
    this.spells = def.spells.map((s, i) => {
      const { matched } = computeSpell(s.recipe);
      return {
        id: `ally_${charId}_${i}`,
        name: spellNameFor(s.recipe, 'normal'),
        recipe: s.recipe,
        stats: finalStats(s.recipe, 0, 'normal', charId),
        discoveries: matched.map(r => r.id),
        level: 0,
        rarity: 'normal' as const,
        equipCount: 0,
      };
    });
    this.cooldowns = this.spells.map(() => 0);
  }

  get name(): string {
    return this.spells.length > 0 ? this.def.note : '';
  }

  cooldownOf(i: number): number {
    return this.cooldowns[i] ?? 0;
  }

  // ---- 毎フレーム ----
  //
  // 撃つと決まったらそれを返す。戦闘側が弾とエフェクトを出す。
  step(dt: number, sight: () => AllySight): AllyCast | null {
    if (!this.alive) return null;

    // MPの自然回復。瞑想の上乗せもプレイヤーと同じ扱い。
    this.mp = Math.min(this.maxMp, this.mp + (ALLY_MP_REGEN + this.mpRegenBonus) * dt);

    for (let i = 0; i < this.cooldowns.length; i++) {
      if (this.cooldowns[i] > 0) this.cooldowns[i] = Math.max(0, this.cooldowns[i] - dt);
    }
    this.stepBuffs(dt);

    // 詠唱中は他に何もしない(プレイヤーと同じ)
    if (this.casting) {
      this.casting.t += dt;
      if (this.casting.t >= this.casting.spell.stats.castTime) {
        const done = this.casting;
        this.casting = null;
        const i = this.spells.indexOf(done.spell);
        // 再使用時間は人より長い(ALLY_CD_MUL)。詠唱そのものは同じ長さなので、
        // 「同じ手順で戦っているが、手数だけ少ない」という見え方になる。
        if (i >= 0) this.cooldowns[i] = spellCooldown(done.spell.stats) * ALLY_CD_MUL;
        if (done.role === 'taunt') this.tauntTimer = ALLY_TAUNT_SEC;
        return { spell: done.spell, role: done.role };
      }
      return null;
    }

    // 考える間合い。毎フレーム考えても結果は変わらないし、
    // 少し間があるほうが「見てから動いた」ように見える。
    this.thinkT -= dt;
    if (this.thinkT > 0) return null;
    this.thinkT = ALLY_THINK_SEC;

    const s = sight();
    const usable = this.spells.map((sp, i) =>
      this.cooldowns[i] <= 0 && this.mp >= sp.stats.manaCost);
    const pick = chooseAllySpell(this.def, s, usable);
    if (pick < 0) return null;

    const sp = this.spells[pick];
    this.mp -= sp.stats.manaCost;
    this.casting = { spell: sp, role: this.def.spells[pick].role, t: 0 };
    return null;
  }

  private stepBuffs(dt: number): void {
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
      }
    }
    if (this.tauntTimer > 0) this.tauntTimer -= dt;
  }

  // ---- 被弾 ----
  //
  // 戻り値は実際に減った量(画面に出す数字用)。
  // 倒れたら二度と起き上がらない ― 守る理由を作るため。
  takeHit(dmg: number, attr: ElementId): { dealt: number; absorbed: number; died: boolean } {
    if (!this.alive) return { dealt: 0, absorbed: 0, died: false };
    let d = dmg;
    if (this.ward && (this.ward.attr === null || this.ward.attr === attr)) {
      d = Math.round(d * (1 - this.ward.pct / 100));
    }
    let absorbed = 0;
    if (this.shield > 0) {
      absorbed = Math.min(this.shield, d);
      this.shield -= absorbed;
      d -= absorbed;
    }
    this.hp -= d;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.casting = null;
      return { dealt: d, absorbed, died: true };
    }
    return { dealt: d, absorbed, died: false };
  }

  // 賦活/鼓舞。最大HPを一時的に増やす。
  //
  // ★ 掛け直しは必ず上書き。足すだけにしていた頃、お供が自分で撃つたびに
  //   上限が伸びて、HP150のはずが400を超えていた。
  applyVigor(amount: number, sec = 25): void {
    if (!this.alive) return;
    this.maxHp -= this.vigorBonus;
    this.hp = Math.min(this.hp, this.maxHp);
    this.vigorBonus = amount;
    this.vigorTimer = sec;
    this.maxHp += amount;
    this.hp += amount;
  }

  heal(amount: number): number {
    if (!this.alive) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }

  // 敵がこのお供を狙う割合。挑発中は跳ね上がる。
  hateShare(base: number, taunted: number): number {
    if (!this.alive) return 0;
    return this.tauntTimer > 0 ? taunted : base;
  }
}

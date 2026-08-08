// お供AIの検証
//   npx tsx test/ally_check.ts
//
// ① 持ち物が狙った系統を成立させているか(表を触った時の見張り)
// ② 得意エレメントが必ず入っているか(キャラ補正が乗らないと個性が出ない)
// ③ 状況に応じて選ぶか(回復・盾・挑発・鼓舞・弱点)
// ④ 詠唱時間と再使用時間が人間と同じ決まりで働くか
// ⑤ MPが尽きたら撃てなくなるか(息切れ)
// ⑥ 倒れたら何もしなくなるか

import {
  ALLIES, ALLY_ENABLED, ALLY_MAX_MP, ALLY_RP_MUL, ALLY_UNLOCK_RP,
  allyDefFor, chooseAllySpell, recipeMatches, roleWanted,
} from '../shared/allies';
import { Ally } from '../src/ally';
import { CHARACTERS } from '../shared/characters';
import { spellCooldown } from '../shared/spellcraft';
import type { AllySight } from '../shared/allies';

let ng = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

// 何も起きていない平時。ここから必要な所だけ崩して試す。
function calm(): AllySight {
  return {
    myHpPct: 1, playerHpPct: 1, myMpPct: 1, enemiesAlive: 1,
    shielded: false, warded: false, empowered: false, taunting: false,
    weakAttr: null,
  };
}

const ALL_USABLE = (n: number) => Array(n).fill(true);

// ===== ① 持ち物 =====

console.log('=== ① 持ち物 ===');

// 旗の状態を固定しておく。
// v0.96.0 で true にして公開した。false に戻す時は、
// それが意図した判断であることをここでも示すこと
// (寝ぼけて戻したのか、決めて戻したのかが後から分かる)。
check('旗は true(お供を公開している)', ALLY_ENABLED === true,
  `いまは ${ALLY_ENABLED}`);
check('6人ぶん揃っている', ALLIES.length === 6, `${ALLIES.length}人`);
check('番号が0〜5で重複なし',
  new Set(ALLIES.map(a => a.charId)).size === 6
  && ALLIES.every(a => a.charId >= 0 && a.charId < 6));
check('全員4本ずつ持っている', ALLIES.every(a => a.spells.length === 4),
  ALLIES.map(a => a.spells.length).join('/'));

// 狙った系統がちゃんと成立しているか。
// レシピを1つ触っただけで別物になるので、ここで固定しておく。
const WANT: Record<number, string[]> = {
  0: ['rensa', 'shippu', '', 'koubu'],
  1: ['shugo', 'gojun', 'chiyu', 'seisui'],
  2: ['shakunetsu', 'enjou', 'shakunetsu', 'chouhatsu'],
  3: ['chiyu', 'meisou', 'koubu', 'shippu'],
  4: ['chouhatsu', 'gojun', 'jishin', 'koubu'],
  5: ['fuuin', 'touketsu', 'fushoku', ''],
};
{
  const bad: string[] = [];
  for (const a of ALLIES) {
    const want = WANT[a.charId] ?? [];
    a.spells.forEach((sp, i) => {
      const id = want[i];
      if (!id) return;                       // 系統を問わない枠
      if (!recipeMatches(sp.recipe, id)) {
        bad.push(`${CHARACTERS[a.charId].name}の${i + 1}本目が${id}から外れた`);
      }
    });
  }
  check('★狙った系統が成立している', bad.length === 0, bad.slice(0, 3).join(' / '));
}

// ② 得意エレメントが入っていること。
//    入っていないとキャラ補正(+10%)が乗らず、誰が使っても同じになる。
{
  const bad: string[] = [];
  for (const a of ALLIES) {
    const el = CHARACTERS[a.charId].element;
    const n = a.spells.filter(s => (s.recipe[el] ?? 0) > 0).length;
    if (n < 2) bad.push(`${CHARACTERS[a.charId].name}(${el})は${n}本だけ`);
  }
  check('★得意エレメントを2本以上に含んでいる', bad.length === 0, bad.join(' / '));
}

check(`解放は研究P${ALLY_UNLOCK_RP}(ステージ条件にしない)`, ALLY_UNLOCK_RP > 0);
check(`連れて行くと研究Pは×${ALLY_RP_MUL}`, ALLY_RP_MUL > 0 && ALLY_RP_MUL < 1);

// ===== ③ 状況で選ぶか =====

console.log('\n=== ③ 状況で選ぶ ===');

// 役どころの条件そのもの
{
  const s = calm();
  check('平時は回復しない', !roleWanted('heal', s));
  check('半分を切ったら回復する', roleWanted('heal', { ...s, playerHpPct: 0.4 }));
  check('自分が減っても回復する', roleWanted('heal', { ...s, myHpPct: 0.4 }));
  check('敵1体では護盾を張らない', !roleWanted('shield', s));
  check('敵が2体なら護盾を張る', roleWanted('shield', { ...s, enemiesAlive: 2 }));
  check('もう護盾があるなら張り直さない',
    !roleWanted('shield', { ...s, enemiesAlive: 2, shielded: true }));
  check('敵1体では挑発しない', !roleWanted('taunt', { ...s, playerHpPct: 0.5 }));
  check('敵が複数でプレイヤーが減っていれば挑発する',
    roleWanted('taunt', { ...s, enemiesAlive: 3, playerHpPct: 0.5 }));
  check('挑発が効いている間は重ねない',
    !roleWanted('taunt', { ...s, enemiesAlive: 3, playerHpPct: 0.5, taunting: true }));
  check('MPが減ったら整える', roleWanted('focus', { ...s, myMpPct: 0.2 }));
  check('攻撃はいつでも撃てる', roleWanted('attack', s));
}

// 実際の6人が、状況どおりに選ぶか
{
  const 翠緑 = allyDefFor(3)!;
  const n = 翠緑.spells.length;
  const hurt = { ...calm(), playerHpPct: 0.3 };
  check('★翠緑はプレイヤーが減ると回復を選ぶ',
    翠緑.spells[chooseAllySpell(翠緑, hurt, ALL_USABLE(n))].role === 'heal');
  check('平時の翠緑は攻撃を選ぶ',
    翠緑.spells[chooseAllySpell(翠緑, calm(), ALL_USABLE(n))].role === 'attack');

  const 紫紺 = allyDefFor(4)!;
  const m = 紫紺.spells.length;
  const swarm = { ...calm(), enemiesAlive: 3, playerHpPct: 0.5 };
  check('★紫紺は敵が増えると挑発を選ぶ(盾役)',
    紫紺.spells[chooseAllySpell(紫紺, swarm, ALL_USABLE(m))].role === 'taunt');
  check('★紫紺は挑発が効いていれば次に護盾を選ぶ',
    紫紺.spells[chooseAllySpell(紫紺,
      { ...swarm, taunting: true }, ALL_USABLE(m))].role === 'shield');

  const 白銀 = allyDefFor(1)!;
  const k = 白銀.spells.length;
  check('★白銀は回復を最優先にする',
    白銀.spells[chooseAllySpell(白銀, hurt, ALL_USABLE(k))].role === 'heal');
  // 回復が使えない時は次の役どころへ落ちる
  const noHeal = 白銀.spells.map(s => s.role !== 'heal');
  check('回復が撃てない時は他の手を選ぶ',
    白銀.spells[chooseAllySpell(白銀, hurt, noHeal)].role !== 'heal');

  const 紅蓮 = allyDefFor(2)!;
  const f = 紅蓮.spells.length;
  check('★紅蓮は平時ひたすら攻撃する',
    紅蓮.spells[chooseAllySpell(紅蓮, calm(), ALL_USABLE(f))].role === 'attack');

  const 蒼氷 = allyDefFor(5)!;
  const i = 蒼氷.spells.length;
  check('★蒼氷は封印を先に撃つ',
    蒼氷.spells[chooseAllySpell(蒼氷, calm(), ALL_USABLE(i))].role === 'seal');
}

// 弱点を突けるものがあれば、そちらを選ぶ
{
  const 黒金 = allyDefFor(0)!;
  const n = 黒金.spells.length;
  const pick = chooseAllySpell(黒金, { ...calm(), weakAttr: 'wind' }, ALL_USABLE(n));
  check('★弱点を突ける攻撃を優先する',
    (黒金.spells[pick].recipe.wind ?? 0) > 0,
    JSON.stringify(黒金.spells[pick].recipe));
}

check('撃てるものが1つも無ければ何も選ばない',
  chooseAllySpell(ALLIES[0], calm(), [false, false, false, false]) === -1);

// ===== ④⑤⑥ 実際に動かす =====

console.log('\n=== ④ 詠唱と再使用 ===');
{
  const a = new Ally(2);   // 紅蓮
  const sight = () => calm();

  // 詠唱が終わるまでは何も返さない
  let fired = a.step(0.016, sight);
  check('考えた直後は撃たない(詠唱に入る)', fired === null && a.casting !== null);

  const sp = a.casting!.spell;
  const cast = sp.stats.castTime;
  let t = 0;
  while (t < cast - 0.05 && !fired) { fired = a.step(0.05, sight); t += 0.05; }
  check('★詠唱中は撃たない', fired === null, `${t.toFixed(2)}秒経過 / 詠唱${cast}秒`);

  while (!fired && t < cast + 1) { fired = a.step(0.05, sight); t += 0.05; }
  check('★詠唱が終わると撃つ', fired !== null,
    fired ? `${fired.spell.name}` : '撃たなかった');
  check('詠唱時間はプレイヤーと同じ値', Math.abs(t - cast) < 0.2,
    `${t.toFixed(2)}秒 / ${cast}秒`);

  const idx = a.spells.indexOf(fired!.spell);
  const cd = spellCooldown(fired!.spell.stats);
  check('★撃った直後は再使用時間が入る',
    Math.abs(a.cooldownOf(idx) - cd) < 0.01, `${a.cooldownOf(idx).toFixed(1)}秒 / ${cd}秒`);
}

console.log('\n=== ⑤ MPが尽きる ===');
{
  const a = new Ally(2);
  a.mp = 0;
  const sight = () => calm();
  let cast = false;
  for (let i = 0; i < 20; i++) {
    a.step(0.05, sight);
    if (a.casting) { cast = true; break; }
  }
  check('★MPが無ければ詠唱に入らない', !cast);
  check('MPは自然に回復する', a.mp > 0, `${a.mp.toFixed(1)}`);

  // 溜まれば撃てるようになる
  const b = new Ally(2);
  b.mp = ALLY_MAX_MP;
  let ok = false;
  for (let i = 0; i < 20; i++) { b.step(0.05, () => calm()); if (b.casting) { ok = true; break; } }
  check('MPがあれば撃てる', ok);
}

console.log('\n=== ⑥ 倒れる ===');
{
  const a = new Ally(4);   // 紫紺
  const r1 = a.takeHit(50, 'fire');
  check('殴られると減る', a.hp === a.maxHp - 50 && r1.dealt === 50 && !r1.died);

  a.shield = 30;
  a.shieldTimer = 5;
  const r2 = a.takeHit(20, 'fire');
  check('護盾が先に受け止める', r2.absorbed === 20 && r2.dealt === 0);

  const r3 = a.takeHit(9999, 'fire');
  check('★倒れる', r3.died && !a.alive && a.hp === 0);
  check('倒れたら何もしない', a.step(1, () => calm()) === null && a.casting === null);
  check('倒れたら回復も効かない', a.heal(50) === 0 && a.hp === 0);
  check('倒れたら狙われない', a.hateShare(0.4, 0.85) === 0);
}

console.log('\n=== 挑発と狙われやすさ ===');
{
  const a = new Ally(4);
  check('平時は決まった割合で狙われる', a.hateShare(0.4, 0.85) === 0.4);
  a.tauntTimer = 3;
  check('★挑発中は狙われやすくなる', a.hateShare(0.4, 0.85) === 0.85);
}

console.log(ng === 0 ? '\nすべて合格' : `\n${ng}件 不合格`);
process.exit(ng === 0 ? 0 : 1);

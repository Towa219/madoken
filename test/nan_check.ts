// 旧セーブ(項目が欠けた魔法)でも魔導値がNaNにならないかを確認する
import { finalStats, spellMagicValue, combatPower } from '../shared/spellcraft';
import type { SpellStats } from '../shared/types';

// v0.6.0より前のセーブを模した性能(dotDps/dotTime/hpBoost等が無い)
const old = {
  kind: 'attack', barrier: 0, healPower: 0, hateGain: 0, targetAll: false,
  power: 42, castTime: 1.1, manaCost: 26, projSpeed: 330,
  radius: 0, pierce: false, chain: 0, critRate: 13,
  lifesteal: 0, freeze: 0, slow: 0, selfDamage: 4, attr: 'fire',
} as unknown as SpellStats;

const v = spellMagicValue(old);
console.log('欠損セーブの魔導値:', v, Number.isFinite(v) ? 'OK' : '✗ NaN');

// レシピからの再計算(state.tsのロード時と同じ処理)
const recalced = finalStats({ fire: 3, wind: 1 }, 2, 'rare');
const v2 = spellMagicValue(recalced);
console.log('再計算後の魔導値:', v2, Number.isFinite(v2) ? 'OK' : '✗ NaN');

const cp = combatPower([{ stats: old }, { stats: recalced }]);
console.log('戦闘力:', cp, Number.isFinite(cp) ? 'OK' : '✗ NaN');

if (!Number.isFinite(v) || !Number.isFinite(v2) || !Number.isFinite(cp)) process.exit(1);
console.log('=== 合格 ===');

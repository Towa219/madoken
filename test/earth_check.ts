// 土を範囲属性にした影響を数字で確かめる。
//
//   npx tsx test/earth_check.ts
//
// ★ 半径は「敵に届くか」で意味が決まる。数字が大きいかどうかではない。
//   敵の並びは 3体[580, 725, 865](間隔145と140) / 2体[660, 850](間隔190)。
//   150未満の半径は当たり判定に一度も関与しない。

import { computeSpell, spellMagicValue } from '../shared/spellcraft';
import { ELEMENTS } from '../shared/data';
import type { ElementCounts, ElementId } from '../shared/types';

const 敵3体 = [580, 725, 865];
const 敵2体 = [660, 850];
let 失敗数 = 0;

function 確認(条件: boolean, 文: string): void {
  if (条件) console.log(`合格: ${文}`);
  else { console.error(`失敗: ${文}`); 失敗数 += 1; }
}

// 何体に当たるか(最悪の位置で数える)。
//
// ★ 半径だけで数えてはいけない。地震系(quake)は弾を撃たずに敵全体へ
//   当てるので半径0だが、当たるのは全員。半径0=単体、と決めつけると
//   「土3が3体に当たらない」と誤判定する(実際にやった)。
function 巻き込む数(s: { radius: number; quake: boolean }, 並び: number[]): number {
  if (s.quake) return 並び.length;
  let 最小 = 並び.length;
  for (const 的 of 並び) {
    const n = 並び.filter(x => Math.abs(x - 的) <= s.radius).length;
    if (n < 最小) 最小 = n;
  }
  return 最小;
}

function 組む(counts: Partial<Record<ElementId, number>>) {
  return computeSpell(counts as ElementCounts).stats;
}

function 実行(): void {
  console.log('=== 土を範囲属性にした結果 ===');
  console.log(`${'構成'.padEnd(10)}${'威力'.padStart(5)}${'半径'.padStart(6)}${'全体'.padStart(6)}`
    + `${'3体で当たる'.padStart(12)}${'2体で当たる'.padStart(12)}${'魔導値'.padStart(8)}`);

  for (const [名, c] of [
    ['土1', { earth: 1 }], ['土2', { earth: 2 }], ['土3', { earth: 3 }],
    ['土1火1', { earth: 1, fire: 1 }], ['土2闇1', { earth: 2, dark: 1 }],
    ['火3(爆裂)', { fire: 3 }], ['闇3', { dark: 3 }], ['雷3', { thunder: 3 }],
  ] as [string, Partial<Record<ElementId, number>>][]) {
    const s = 組む(c);
    console.log(`${名.padEnd(10)}${String(s.power).padStart(5)}${String(s.radius).padStart(6)}${(s.quake ? '○' : '-').padStart(6)}`
      + `${String(巻き込む数(s, 敵3体)).padStart(12)}`
      + `${String(巻き込む数(s, 敵2体)).padStart(12)}`
      + `${String(spellMagicValue(s)).padStart(8)}`);
  }

  console.log();
  // ---- 効いていることの確認 ----
  const 土1 = 組む({ earth: 1 });
  確認(土1.radius >= 150, `土1個で隣に届く半径になる → 実測 ${土1.radius}`);
  確認(巻き込む数(土1, 敵3体) >= 2, '土1個で3体並びのうち2体を巻き込む');

  const 土3 = 組む({ earth: 3 });
  確認(巻き込む数(土3, 敵3体) === 3,
    `土3個で3体すべてを巻き込む → 実測 ${土3.quake ? '地震系(敵全体)' : `半径${土3.radius}`}`);

  const 火3 = 組む({ fire: 3 });
  確認(巻き込む数(火3, 敵3体) >= 2,
    `爆裂系(火3)の爆発が隣に届く → 実測 半径${火3.radius}`);

  // ---- やりすぎていないか ----
  const 闇3 = 組む({ dark: 3 });
  確認(土3.power < 闇3.power,
    `土3の単体威力は闇3より低いまま → 実測 土${土3.power} 闇${闇3.power}`);
  const 土値 = spellMagicValue(土3);
  const 闇値 = spellMagicValue(闇3);
  確認(土値 < 闇値 * 1.6,
    `土3の魔導値が闇3を大きく超えない → 実測 土${土値} 闇${闇値}`);

  // ---- 攻撃以外に半径が付いていないか ----
  // 護盾系は土を含む構成で作れる。系統が attack でなければ半径は0のはず。
  for (const c of [{ earth: 2, water: 1 }, { earth: 1, light: 2 }, { earth: 3, water: 2 }]) {
    const s = 組む(c);
    if (s.kind === 'attack') continue;
    確認(s.radius === 0,
      `${s.kind}(土入り)に半径が付かない → 実測 ${s.radius}`);
  }

  // ---- 説明文と実装が食い違っていないか ----
  確認(ELEMENTS.earth.desc.includes('範囲'),
    `素材庫の土の説明に範囲攻撃が書いてある → 実測 「${ELEMENTS.earth.desc}」`);

  console.log();
  if (失敗数) { console.error(`検証終了: ${失敗数}件失敗しました。`); process.exit(1); }
  console.log('検証終了: 全項目に合格しました。');
}

実行();

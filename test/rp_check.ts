// 研究Pの支払い条件を確認する(勝利のみ)
import { battleRP, isBossStage } from '../shared/data';

let ng = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ng++;
}

for (const stage of [1, 3, 5, 10]) {
  const win = battleRP(stage, true);
  const lose = battleRP(stage, false);
  const esc = battleRP(stage, false, true);
  console.log(`ステージ${stage}${isBossStage(stage) ? '(ボス)' : ''}: 勝利+${win} / 敗北+${lose} / 撤退+${esc}`);
  check(win > 0, `  勝利では研究Pがもらえる`);
  check(lose === 0, `  敗北では研究Pはもらえない`);
  check(esc === 0, `  撤退では研究Pはもらえない`);
}

console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件の不具合 ===`);
if (ng > 0) process.exit(1);

// 挑戦ステージの選択(ソロと共闘で共通)
//
// 以前は「戦闘」タブのボタン列(ソロ用)と、オンラインの選択欄(共闘用)が
// 別々にあり、同じことを2か所で選ばせていた。画面を1つにまとめたので、
// 選んだステージも1か所に持たせる。
//
// セーブには入れない。次に開いた時は「まだ行ける一番深いところ」から始める。

let selected = 0;
const listeners: (() => void)[] = [];

export function onStageChange(fn: () => void): void {
  listeners.push(fn);
}

// 選ばれているステージ。まだ選んでいなければ、行ける一番深いところ。
export function selectedStage(maxStage: number): number {
  const max = Math.max(1, Math.floor(maxStage));
  if (selected < 1) return max;
  return Math.min(selected, max);
}

export function setSelectedStage(n: number): void {
  const v = Math.max(1, Math.floor(n));
  if (v === selected) return;
  selected = v;
  for (const fn of listeners) fn();
}

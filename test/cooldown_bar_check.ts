// 再使用時間の残量バーが「見える」状態を保っているかを見張る。
//
//   npx tsx test/cooldown_bar_check.ts
//
// ★ なぜ要るか(2026-08-21)。
//   封印(再使用40秒・強化しても31秒)を撃った後、あとどれくらいで
//   撃てるのかが画面から分からない、という指摘があった。
//
//   バーは出ていた。ただし二重に見えなくなっていた。
//   ・暗い被せ(rgba(0,0,0,0.55))を縮めていくだけの作りだった。
//     攻撃魔法の再使用は2秒前後なので帯が走り抜けるのが見えるが、
//     封印の40秒では170pxのボタンを毎秒4pxしか動かず、止まって見える。
//   ・そのうえ button:disabled の opacity: 0.4 は子孫にも掛かる。
//     再使用中のボタンは disabled なので、バー自身が0.4倍に沈む。
//     暗いボタンの上に、薄めた黒を置いていたことになる。
//
// ★ 特に (2) は気づきにくい。CSSの別の場所に書いてある一行が、
//   まったく関係なさそうな部品を消してしまう。opacity は文字だけでなく
//   描画結果ぜんぶに掛かるため、子だけ明るく保つことができない。
//   打ち消しを消してしまうと、バーはまた黙って見えなくなる。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ここ = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(ここ, '..', 'src', 'style.css'), 'utf8');

let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

// 指定した見出しの中身(波かっこの中)を取り出す
function 中身(見出し: string): string {
  const i = CSS.indexOf(見出し + ' {');
  if (i < 0) return '';
  const 開き = CSS.indexOf('{', i);
  const 閉じ = CSS.indexOf('}', 開き);
  return CSS.slice(開き + 1, 閉じ);
}

console.log('=== 再使用時間の残量バー ===');

// ---- (1) バーそのもの ----
console.log('\n-- バーの見た目 --');
const バー = 中身('.spell-btn .cd-overlay');
確認(バー !== '', '.spell-btn .cd-overlay の指定がある');
確認(!/background\s*:\s*rgba\(\s*0\s*,\s*0\s*,\s*0/.test(バー),
  '暗い被せ(黒)ではない',
  /background\s*:\s*rgba\(\s*0\s*,\s*0\s*,\s*0[^;]*/.exec(バー)?.[0] ?? '');
確認(/box-shadow/.test(バー), '発光(box-shadow)している');
確認(/width\s*:\s*0%/.test(バー),
  '既定は幅0%(撃てる時はバーを出さない)');

// ---- (2) 無効化の薄めがバーを消していないか ----
console.log('\n-- 無効化(disabled)との兼ね合い --');
const 全体無効 = 中身('button:disabled');
const 魔法無効 = 中身('.spell-btn:disabled');

// そもそも全体の薄めがあることが前提。無くなったならこの見張りも要らない
const 全体を薄めている = /opacity\s*:\s*0?\.\d+/.test(全体無効);
if (!全体を薄めている) {
  console.log('  --  button:disabled の opacity が無くなっている(打ち消しは不要)');
} else {
  確認(魔法無効 !== '',
    '.spell-btn:disabled の指定がある',
    魔法無効 === '' ? 'button:disabled の opacity がバーまで薄めてしまう' : '');
  確認(/opacity\s*:\s*1\b/.test(魔法無効),
    '魔法ボタンは opacity で薄めていない(バーを沈ませない)',
    /opacity\s*:[^;]*/.exec(魔法無効)?.[0]?.trim() ?? 'opacity の指定が無い');
  // 薄めない代わりに、押せないことが色で分かるようになっているか
  確認(/color\s*:/.test(魔法無効) && /background\s*:/.test(魔法無効),
    '押せないことを色で伝えている(文字色と背景色を変えている)');
}

console.log('');
if (失敗数 === 0) {
  console.log('すべて合格。再使用時間の残りが見える。');
} else {
  console.error(`${失敗数}件 失敗。あとどれくらいで撃てるか分からなくなる恐れがある。`);
  process.exit(1);
}

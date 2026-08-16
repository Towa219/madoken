// 「最近の変更点」の書き方を見張る。ブラウザもサーバーも要らない。
//
//   npx tsx test/changes_check.ts
//
// ★ なぜ要るか(2026-08-15)。
//   帯も履歴も textContent で文字を入れている。記号や引用符が入っても
//   壊れないようにする意図した作りだが、そのぶん HTML のタグを書くと
//   タグの字がそのまま画面に流れる。実際に
//   「交配所へ<b>預けたままでも交配を仕掛けられる</b>ようになりました」
//   と表示された。
//
// ★ 書いた本人が気づけない類の間違い。ソースでは強調に見えるので、
//   画面を見るまで分からない。機械に見張らせる。

import { CHANGES, TICKER_COUNT, allChanges, recentChanges } from '../src/changes';

let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

console.log('=== 最近の変更点の書き方 ===');
console.log(`  ${CHANGES.length}件`);

// ---- HTMLのタグが混ざっていないか ----
const タグ = /<\/?[a-zA-Z][^>]*>/;
for (const c of CHANGES) {
  const m = タグ.exec(c.text);
  確認(m === null, `v${c.version} にHTMLのタグが無い`,
    m ? `「${m[0]}」が入っている(画面にそのまま出る)` : '');
}

// ついでに、実体参照も出てしまうので見る
for (const c of CHANGES) {
  const m = /&(amp|lt|gt|nbsp|quot|#\d+);/.exec(c.text);
  確認(m === null, `v${c.version} に実体参照が無い`,
    m ? `「${m[0]}」が入っている` : '');
}

// ---- 中身の作法 ----
for (const c of CHANGES) {
  確認(/^\d{4}-\d{2}-\d{2}$/.test(c.date), `v${c.version} の日付の形`, c.date);
  確認(c.text.trim().length > 0, `v${c.version} の本文が空でない`);
  // 帯は1周を読み終えるまで目を離せない。長すぎるものは弾く。
  確認(c.text.length <= 160, `v${c.version} の本文が長すぎない`, `${c.text.length}文字`);
}

// ★ 同じ版が2件あるのは正しい。1回の更新で別々の変更を入れることがある
//   (v0.123.0 の「土が範囲攻撃」と「爆裂系の修正」)。ここを重複と見なす
//   検証を書いてしまったが、それはこちらの読み違いだった。

// ---- 並びと件数 ----
const 全部 = allChanges();
確認(全部.length === CHANGES.length, 'allChanges は全部返す');
let 降順 = true;
for (let i = 1; i < 全部.length; i++) {
  if (全部[i - 1].date < 全部[i].date) { 降順 = false; break; }
}
確認(降順, '新しい順に並んでいる');

const 帯 = recentChanges(new Date('2026-12-31'));
確認(帯.length <= TICKER_COUNT, `帯に流すのは${TICKER_COUNT}件まで`, `${帯.length}件`);

console.log(失敗数 === 0 ? '=== 合格 ===' : `=== ${失敗数}件 失敗 ===`);
process.exit(失敗数 === 0 ? 0 : 1);

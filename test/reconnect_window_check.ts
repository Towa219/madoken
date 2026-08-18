// 復帰の待ち時間が「端末のほうが長い」ことを見張る。ブラウザもサーバーも要らない。
//
//   npx tsx test/reconnect_window_check.ts
//
// ★ なぜ要るか(2026-08-18)。
//   端末とサーバーの待ち時間を同じ90秒にしてあった。設計コメントにも
//   「サーバーが席を空けて待つ秒数に合わせること」と書いてあった。
//   ところが両者の90秒は同じ瞬間に始まらない。
//
//     19:37:30 端末が切断を検知 → 復帰を試し始める
//     19:39:04 端末が90秒で諦める
//     19:39:09 サーバーがようやく切断に気づく ← 席が空くのはここから
//
//   回線が片側だけ死ぬと、サーバーからは接続が生きたままに見える。
//   席が埋まっている間の復帰要求は全部弾かれるので、端末の90秒は
//   まるごと無駄になり、席が空く5秒前に諦めていた。
//
// ★ 直し方は「端末を長くする」。サーバーを短くしてはいけない
//   (席を早く畳むと、本当に戻れる人まで締め出す)。

import {
  RECONNECT_CLIENT_SEC, RECONNECT_SEC, RECONNECT_TRIES, RECONNECT_WAIT_MS,
} from '../shared/data';

let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

console.log('=== 復帰の待ち時間 ===');
console.log(`  サーバーが席を空けて待つ : ${RECONNECT_SEC}秒`);
console.log(`  端末が粘る               : ${RECONNECT_CLIENT_SEC}秒`);
console.log(`  試行                     : ${RECONNECT_WAIT_MS}ms × ${RECONNECT_TRIES}回`);
console.log();

確認(RECONNECT_CLIENT_SEC > RECONNECT_SEC,
  '端末のほうがサーバーより長く粘る',
  `${RECONNECT_CLIENT_SEC}秒 > ${RECONNECT_SEC}秒`);

// サーバーが切断に気づくまでの遅れを見込む。実測で約99秒かかった例がある。
const 気づく遅れの見込み = 99;
確認(RECONNECT_CLIENT_SEC >= RECONNECT_SEC + 気づく遅れの見込み,
  'サーバーが気づくまでの遅れ + 席を空けて待つ時間 を上回る',
  `${RECONNECT_CLIENT_SEC}秒 ≧ ${RECONNECT_SEC}+${気づく遅れの見込み}=${RECONNECT_SEC + 気づく遅れの見込み}秒`);

const 実際の秒 = (RECONNECT_TRIES * RECONNECT_WAIT_MS) / 1000;
確認(実際の秒 >= RECONNECT_CLIENT_SEC,
  '試行回数が粘る秒数ぶんある', `${実際の秒}秒`);

// 刻みが粗すぎると、回線が戻ってから復帰するまで待たされる
確認(RECONNECT_WAIT_MS <= 5000, '試行の間隔が長すぎない', `${RECONNECT_WAIT_MS}ms`);

// 長すぎても困る。画面が固まったように見える上限を決めておく
確認(RECONNECT_CLIENT_SEC <= 600, '端末が粘りすぎない(10分以内)',
  `${RECONNECT_CLIENT_SEC}秒`);

console.log(失敗数 === 0 ? '=== 合格 ===' : `=== ${失敗数}件 失敗 ===`);
process.exit(失敗数 === 0 ? 0 : 1);

// 本番サーバーの再起動・停止を外から見張る。
//
//   node tools/watch_prod.mjs [間隔秒]
//
// ★ 部屋には入らない。GETで覗くだけなので、遊んでいる人の邪魔をしない。
//   ロビーに入って見張ると在室者に混ざってしまい、Discordの在室報告にも載る。
//
// ★ 見るのは process.uptime()。これが減ったら、その間にサーバーの
//   プロセスが入れ替わっている(配備・クラッシュ・プラットフォーム都合の
//   どれか)。「切れた」という report と時刻を突き合わせるために使う。
//
// ★ 応答が返らない時も記録する。落ちている最中はここが無応答になる。

const 基点 = process.env.MADOKEN_PROD ?? 'https://madoken.onrender.com';
const 間隔 = Math.max(5, Number(process.argv[2] ?? 10)) * 1000;

const 時刻 = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });

let 前の稼働 = null;
let 前の版 = null;
let 連続無応答 = 0;

console.log(`本番を見張ります: ${基点}(${間隔 / 1000}秒おき)`);
console.log('稼働時間が減ったら「★再起動」と出します。Ctrl+Cで止まります。');

async function 一回() {
  let ping = null;
  let status = null;
  try {
    const c = AbortSignal.timeout(20000);
    ping = await fetch(`${基点}/api/ping`, { signal: c }).then(r => r.json());
  } catch (e) {
    連続無応答++;
    console.log(`${時刻()}  ✖ 応答なし(${連続無応答}回連続) ${String(e.message ?? e).slice(0, 60)}`);
    return;
  }
  if (連続無応答 > 0) {
    console.log(`${時刻()}  ↩ 応答が戻った(${連続無応答}回ぶん無応答だった)`);
    連続無応答 = 0;
  }
  try {
    status = await fetch(`${基点}/api/status`, { signal: AbortSignal.timeout(20000) })
      .then(r => r.json());
  } catch { /* status は取れなくてもよい */ }

  const 稼働 = Number(ping.uptime);
  const 版 = String(ping.version);
  const 部屋 = (status?.rooms ?? [])
    .map(r => `${r.type}${r.label ? `(${r.label})` : ''}×${r.count}`).join(' ') || '部屋なし';
  const 人 = status?.online ?? '?';

  if (前の稼働 !== null && 稼働 < 前の稼働) {
    console.log(`${時刻()}  ★再起動 稼働${前の稼働}秒 → ${稼働}秒`
      + `${版 !== 前の版 ? `(版 ${前の版} → ${版}=配備)` : '(版は同じ=配備ではない)'}`);
  } else {
    console.log(`${時刻()}  稼働${稼働}秒 v${版} 在室${人}人 ${部屋}`);
  }
  前の稼働 = 稼働;
  前の版 = 版;
}

await 一回();
setInterval(() => { void 一回(); }, 間隔);

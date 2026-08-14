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
let 最大遅れ = 0;

// ★ 応答の遅さも測る。
//   Renderの無料プランは CPU 0.1 しか無い。ボス戦はサーバー側の計算が
//   一番重いので、詰まると ping の応答が返せず、Colyseus が
//   「返事が無い」と見なして接続を閉じる(pingInterval 5秒 × 5回 = 25秒)。
//   落ちた時刻に応答が遅くなっていれば、それが原因だと分かる。
const 遅い = 1000;   // これを超えたら目立たせる

// 死ぬ直前の記録。死んでから調べ始めても、その時にはもう何も残っていない。
const 直前 = [];
const 直前の数 = 40;
let 前の部屋 = '';
let 前の出力 = null;
// 同じ切断を何度も出さないための控え。
const 見た切断 = new Set();
let 初回読み込み = true;

console.log(`本番を見張ります: ${基点}(${間隔 / 1000}秒おき)`);
console.log('稼働時間が減ったら「★再起動」と出します。Ctrl+Cで止まります。');

async function 一回() {
  let ping = null;
  let status = null;
  let 遅れ = 0;
  try {
    const c = AbortSignal.timeout(20000);
    const t0 = Date.now();
    ping = await fetch(`${基点}/api/ping`, { signal: c }).then(r => r.json());
    遅れ = Date.now() - t0;
    if (遅れ > 最大遅れ) 最大遅れ = 遅れ;
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
    const 分 = Math.round(前の稼働 / 60);
    console.log('');
    console.log(`${時刻()}  ★★★ 再起動 ★★★ 稼働${前の稼働}秒(${分}分) → ${稼働}秒`);
    console.log(`  ${版 !== 前の版
      ? `版 ${前の版} → ${版} = こちらの配備`
      : '版は同じ = 配備ではない(サーバーが勝手に死んだ)'}`);
    // ★ サーバー自身が書き残した「前回の終わり方」。ここが本命。
    if (ping.lastExit) console.log(`  前回の終わり方: ${ping.lastExit}`);
    // ★ 死ぬ直前の数字を並べて出す。ここが唯一の手掛かりになる。
    //   その場で見ていなくても、あとから原因を読めるようにするため。
    console.log('  --- 死ぬ直前の記録 ---');
    for (const l of 直前) console.log(`  ${l}`);
    console.log('  ----------------------');
    console.log('');
    直前.length = 0;
  } else {
    // lag はサーバー自身の詰まり(回線が混ざらない)。peakLag は前回聞いてから
    // の最大値なので、5秒おきに聞けば取りこぼしが無い。
    const 詰まり = ping.peakLag === undefined
      ? ''
      : ` 詰まり${String(ping.peakLag).padStart(5)}ms${ping.peakLag > 2000 ? ' ★★詰まっている' : ''}`;
    // ★ メモリを見る。無料プランは512MBで、超えると問答無用で殺される。
    //   じわじわ増えて上限に当たっているなら、再起動の直前に跳ねる。
    const メモリ = ping.rssMB === undefined
      ? ''
      : ` メモリ${String(ping.rssMB).padStart(3)}MB${ping.rssMB > 400 ? ' ★★上限が近い' : ''}`;
    const 行 = `${時刻()}  稼働${稼働}秒 応答${String(遅れ).padStart(5)}ms`
      + `${遅れ > 遅い ? ' ★遅い' : ''}${詰まり}${メモリ} v${版} 在室${人}人 ${部屋}`;
    // ★ 直前の記録を持っておく。死んだ瞬間に並べて出すため。
    //   死んでから調べ始めても、その時にはもう何も残っていない。
    直前.push(行);
    if (直前.length > 直前の数) 直前.shift();
    // 毎回出すと流れ過ぎるので、様子が変わった時だけ出す。
    const 目立つ = 遅れ > 遅い || (ping.peakLag ?? 0) > 2000 || (ping.rssMB ?? 0) > 400;
    if (目立つ || 部屋 !== 前の部屋 || 稼働 - (前の出力 ?? 0) >= 300) {
      console.log(行);
      前の出力 = 稼働;
    }
    前の部屋 = 部屋;

    // ★ サーバー側から見た切れ方。ここが本命。
    //   遊んでいる人の画面は原因が何であれ 1006 になるので、
    //   サーバーが見た番号と在室秒数が無いと切り分けられない。
    for (const d of (ping.disconnects ?? []).slice().reverse()) {
      const 鍵 = `${d.at}|${d.text}`;
      if (見た切断.has(鍵)) continue;
      見た切断.add(鍵);
      if (初回読み込み) continue;   // 起動時に溜まっていたぶんは流さない
      console.log(`  ▼切断 ${d.at.slice(11, 19)} ${d.text}`);
    }
    初回読み込み = false;

    for (const c of (ping.roomCrashes ?? [])) {
      const 鍵 = `c|${c.at}|${c.text}`;
      if (見た切断.has(鍵)) continue;
      見た切断.add(鍵);
      console.log(`  ▼▼部屋の例外 ${c.at.slice(11, 19)} ${c.text}`);
    }
  }
  前の稼働 = 稼働;
  前の版 = 版;
}

await 一回();
setInterval(() => { void 一回(); }, 間隔);

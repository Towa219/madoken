// 遊んでいる人が居ないことを確かめてから push する。
//
//   node tools/safe_push.mjs
//   node tools/safe_push.mjs --force   ← どうしても今すぐ出す時だけ
//
// ★ なぜ要るか。
//   このリポジトリへの push は、そのまま Render の再配備になる。
//   再配備はサーバーの入れ替えなので、遊んでいる全員が切れる。
//   共闘のボス戦の最中でも容赦なく切れる。
//
//   2026-08-15 13:35、3人がステージ5のボス戦をしている最中に
//   push してしまい、全員を落とした。同じことを以前にもやっている。
//   「気をつける」では止められなかったので、機械に止めさせる。
//
// ★ 判断は本番の /api/status の online を見る。0人の時だけ通す。

import { execSync } from 'node:child_process';

const 基点 = process.env.MADOKEN_URL ?? 'https://madoken.onrender.com';
const 強行 = process.argv.includes('--force');

// ★ AbortSignal.timeout を使わないこと。待ち受けが残ったまま
//   process.exit すると Windows の Node が libuv の表明で落ち、
//   終了コードが 127 になる(2026-08-15に実測)。自分で片付ける。
async function 今の様子() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(`${基点}/api/status`, { signal: c.signal });
    if (!r.ok) throw new Error(`/api/status が ${r.status} を返した`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ★ process.exit ではなく exitCode を立てて戻る。
//   途中で殺すと、上と同じ理由で終了コードが化ける。
function main() { return 本体(); }

async function 本体() {
let 様子;
try {
  様子 = await 今の様子();
} catch (e) {
  console.error(`✖ 本番の様子を確かめられなかった: ${e.message}`);
  console.error('  確かめられない以上、勝手に push はしない。');
  console.error('  本当に出すなら --force を付けること。');
  if (!強行) { process.exitCode = 1; return; }
}

if (様子) {
  const 人 = Number(様子.online ?? 0);
  const 部屋 = (様子.rooms ?? [])
    .map(r => `${r.type}${r.label ? `(${r.label})` : ''}×${r.count}`)
    .join(' ') || '部屋なし';
  console.log(`本番 v${様子.version} — 在室 ${人}人 / ${部屋}`);

  if (人 > 0) {
    // 戦っている最中かどうかも出す。ボス戦中は特に落としたくない。
    const 戦闘中 = (様子.rooms ?? []).some(r => String(r.type).includes('共闘')
      || String(r.type).includes('決闘'));
    console.error('');
    console.error(`✖ ${人}人が遊んでいる。push すると全員が切断される。`);
    if (戦闘中) console.error('  しかも戦闘中の部屋がある。いま出してはいけない。');
    console.error('  誰も居なくなってから出し直すこと。');
    if (!強行) { process.exitCode = 1; return; }
    console.error('  --force が付いているので、承知のうえで続行する。');
  }
}

console.log('→ push します');
try {
  const 出力 = execSync('git push', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(出力.trim() || '(出力なし)');
  console.log('✔ push しました。Render の再配備が始まります。');
} catch (e) {
  console.error('✖ push に失敗しました:');
  console.error(String(e.stderr ?? e.message).trim());
  process.exitCode = 1;
}
}

await main();

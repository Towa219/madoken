// サーバーが眠らずに起きているか(外部cronが効いているか)を確かめる。
//   npx tsx test/awake_check.ts
//
// ★ 2026-08-09 現在、これはもう合否を見るものではない。
//   Renderから警告のメールが来たので、外から叩いて起こし続ける運用は
//   やめた。今は眠っているのが正常なので、走らせれば「眠っていた」と出る。
//   外から起こす仕組みを将来また試す時のために残してある(README参照)。
//
// 見方:
//   /api/ping が返す uptime は「このサーバーが連続で起きている秒数」。
//   起こしておく時間帯の中で呼んで、uptime が「時間帯の開始からの経過」に
//   届いていれば、その間ずっと起きていた = cron が効いている。
//   届いていなければ、途中で眠って起こし直されている = cron に穴がある。
//
// 注意: 新しい版を入れ替えるとサーバーが再起動し、uptime は0に戻る。
//       出した直後は届かなくて当たり前なので、そこだけ切り分けること。

const BASE = (process.env.MADOKEN_ENDPOINT ?? 'https://madoken.onrender.com')
  .replace(/^ws/, 'http');

// 起こしておく時間帯(日本時間)。cron側の設定と必ず揃えること。
const WAKE_FROM = 6 * 60;            // 6:00
const WAKE_TO = 25 * 60 + 30;        // 翌1:30(24時をまたぐので分で持つ)
// 眠るまでの猶予。最後に叩いてから15分は起きている。
const IDLE_MIN = 15;
// 判定の甘さ。cronが数分ずれても落とさない。
const SLACK_MIN = 12;

let ng = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

function hhmm(min: number): string {
  const h = Math.floor(min / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(Math.floor(min) % 60).padStart(2, '0')}`;
}

function dur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

async function main(): Promise<void> {
  console.log('=== サーバーが眠っていないか ===');
  console.log(`対象: ${BASE}`);
  console.log(`起こしておく時間帯: ${hhmm(WAKE_FROM)} 〜 ${hhmm(WAKE_TO)}(日本時間)`);

  const t0 = Date.now();
  let uptime = -1;
  let version = '';
  try {
    const res = await fetch(`${BASE}/api/ping`, { cache: 'no-store' });
    const data = await res.json() as { ok?: boolean; uptime?: unknown; version?: unknown };
    check('/api/ping が応答する', res.ok && data?.ok === true);
    uptime = Number(data?.uptime);
    version = String(data?.version ?? '');
  } catch (err) {
    check('/api/ping が応答する', false, (err as Error).message);
  }
  const took = Date.now() - t0;

  if (!Number.isFinite(uptime) || uptime < 0) {
    console.log(`\n=== ${ng || 1}件 失敗 ===`);
    process.exit(1);
  }

  // 応答が遅ければ、今まさに起こされたということ(＝眠っていた)
  check('★呼んだ時点で起きていた(待たされていない)', took < 5000,
    `${(took / 1000).toFixed(1)}秒`);
  console.log(`     連続で起きている時間: ${dur(uptime)} / 版 v${version}`);

  // 今が時間帯の中かどうか。0:00〜1:30 は前日の6:00から続いている扱い。
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const curAdj = cur < WAKE_TO - 24 * 60 ? cur + 24 * 60 : cur; // 深夜は+24時
  const inWindow = curAdj >= WAKE_FROM && curAdj <= WAKE_TO + IDLE_MIN;

  if (!inWindow) {
    console.log(`     いまは ${hhmm(cur)} で時間帯の外。眠っていて正常なので合否は出さない。`);
    console.log(ng === 0 ? '\n=== 合格 ===' : `\n=== ${ng}件 失敗 ===`);
    process.exit(ng === 0 ? 0 : 1);
  }

  // 時間帯の中: 開始からの経過ぶん、ずっと起きていたはず
  const wanted = (curAdj - WAKE_FROM - SLACK_MIN) * 60;
  console.log(`     時間帯の開始から ${dur((curAdj - WAKE_FROM) * 60)} 経っている`);
  check('★時間帯の間ずっと起きていた(cronが効いている)',
    uptime >= wanted,
    uptime >= wanted
      ? `連続 ${dur(uptime)}`
      : `連続 ${dur(uptime)} しかない。途中で眠ったか、`
        + 'この時間に新しい版を出した(その場合は再起動なので正常)');

  console.log(ng === 0 ? '\n=== 合格 ===' : `\n=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

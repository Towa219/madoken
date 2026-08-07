// ランキングの管理機能を確かめる。
//
// 不適切な名前が載った時に、記録を消して名前そのものを塞げること。
// 消すだけでは同じ名前で登録し直せてしまうので、そこまで見る。
//
// 見るのは
//   ・ADMIN_KEY が無い/違うと何もできないか
//   ・一覧に登録が出るか
//   ・削除できるか
//   ・禁止にすると、その名前で登録し直せなくなるか
//   ・禁止を解けば また使えるようになるか
//
// サーバーは ADMIN_KEY を設定して起動しておくこと:
//   ADMIN_KEY=testkey npm start
//
//   npx tsx test/ranking_admin_check.ts

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const KEY = process.env.ADMIN_KEY ?? 'testkey';

const RUN = Math.random().toString(36).slice(2, 6);
const NAME = `わる${RUN}`;
const TOKEN = `tok_${RUN}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${HTTP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* 本文が無いこともある */ }
  return { status: res.status, json };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${HTTP}${path}`);
  let json: any = null;
  try { json = await res.json(); } catch { /* 本文が無いこともある */ }
  return { status: res.status, json };
}

// 名前を取って、ランキングに1件載せる
async function register(name: string, token: string): Promise<boolean> {
  const claim = await post('/api/name/claim', { name, token });
  if (!claim.json?.ok) return false;
  await post('/api/ranking/submit', {
    name, nickToken: token, bossCleared: [],
    spells: [{ name: '魔弾', recipe: { dark: 3 }, level: 9, rarity: 'legend' }],
  });
  return true;
}

async function main(): Promise<void> {
  console.log('=== ランキングの管理機能 ===');
  console.log(`対象: ${HTTP} / 名前: ${NAME}`);

  try {
    // ---- 0. キーが無い・違うと弾かれる ----
    const noKey = await get('/api/admin/ranking');
    check('★キー無しでは一覧を見られない', noKey.status === 403, `HTTP ${noKey.status}`);
    const badKey = await get('/api/admin/ranking?key=まちがい');
    check('★違うキーでも見られない', badKey.status === 403, `HTTP ${badKey.status}`);
    if (noKey.status === 403 && noKey.json?.error?.includes('未設定')) {
      console.log('  -- ADMIN_KEY が未設定のサーバーです。');
      console.log('     ADMIN_KEY=testkey npm start で起動し直してから実行してください。');
      failures++;
      return;
    }

    // ---- 1. 登録して一覧に出す ----
    check('登録できた', await register(NAME, TOKEN));
    await sleep(500);
    let list = await get(`/api/admin/ranking?key=${encodeURIComponent(KEY)}`);
    check('一覧を見られる', list.status === 200, `HTTP ${list.status}`);
    const names = (list.json?.entries ?? []).map((e: { name: string }) => e.name);
    check('★登録が一覧に出る', names.includes(NAME), `${names.length}件`);

    // ---- 2. 消すだけでは取り直せてしまう ----
    await post('/api/admin/ranking/remove', { key: KEY, name: NAME });
    await sleep(500);
    list = await get(`/api/admin/ranking?key=${encodeURIComponent(KEY)}`);
    const after = (list.json?.entries ?? []).map((e: { name: string }) => e.name);
    check('★記録を消せる', !after.includes(NAME), after.length + '件');
    check('消しただけなら同じ名前で登録し直せる', await register(NAME, TOKEN));

    // ---- 3. 禁止すると登録できなくなる ----
    const ban = await post('/api/admin/ranking/remove', { key: KEY, name: NAME, ban: true });
    check('禁止にできた', ban.json?.banned === NAME, String(ban.json?.banned));
    await sleep(500);

    const claim = await post('/api/name/claim', { name: NAME, token: TOKEN });
    check('★禁止した名前は元の持ち主でも取り直せない', claim.json?.ok === false,
      claim.json?.error ?? '通ってしまった');
    const other = await post('/api/name/claim', { name: NAME, token: `${TOKEN}x` });
    check('★他の人もその名前を取れない', other.json?.ok === false,
      other.json?.error ?? '通ってしまった');
    // 事前チェックは GET(問い合わせるだけなので登録はしない)
    const pre = await get(
      `/api/name/check?name=${encodeURIComponent(NAME)}&token=${encodeURIComponent(TOKEN)}`);
    check('入力欄の事前チェックでも弾かれる', pre.json?.ok === false,
      pre.json?.error ?? '通ってしまった');

    const banned = await get(`/api/admin/ban?key=${encodeURIComponent(KEY)}`);
    check('禁止名の一覧に載る', (banned.json?.names ?? []).length > 0,
      `${banned.json?.count}件`);

    // ---- 4. 解除すれば また使える ----
    await post('/api/admin/ban', { key: KEY, name: NAME, action: 'remove' });
    await sleep(500);
    const again = await post('/api/name/claim', { name: NAME, token: TOKEN });
    check('★禁止を解けば また使える', again.json?.ok === true,
      again.json?.error ?? '');
  } finally {
    // 後片付け(禁止を解いて名前も手放す)
    try {
      await post('/api/admin/ban', { key: KEY, name: NAME, action: 'remove' });
      await post('/api/admin/ranking/remove', { key: KEY, name: NAME });
      await post('/api/name/release', { name: NAME, token: TOKEN });
    } catch { /* 消せなくても成否には関係ない */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

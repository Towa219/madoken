// クラウドセーブ(サーバー側セーブ)のE2E
// 実行: npx tsx test/cloudsave_check.ts  (MADOKEN_ENDPOINT で本番も検証可)

const BASE = (process.env.MADOKEN_ENDPOINT ?? 'ws://localhost:2567').replace(/^ws/, 'http');

const RUN = Math.random().toString(36).slice(2, 7);
const NAME = `cs${RUN}`;
const TOKEN = `tok${RUN}`;
const OTHER = `bad${RUN}`;

let ng = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ng++;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json() as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log(`対象: ${BASE} / 名前: ${NAME}`);

  // 保存前は「まだ無い」
  const empty = await post('/api/load', { name: NAME, token: TOKEN });
  check(empty.ok === false, `未保存なら読み込めない (${String(empty.error ?? '')})`);

  // 保存
  const data = { researchP: 1234, maxStage: 7, spells: [{ id: 's1', name: '炎の魔弾〈火2風〉', recipe: { fire: 2, wind: 1 }, discoveries: [], level: 3, rarity: 'rare' }] };
  const saved = await post('/api/save', { name: NAME, token: TOKEN, data, savedAt: Date.now() });
  check(saved.ok === true, '保存できた');

  // 本人は読み出せる
  const loaded = await post('/api/load', { name: NAME, token: TOKEN });
  const got = loaded.data as { researchP?: number; maxStage?: number } | undefined;
  check(loaded.ok === true && got?.researchP === 1234 && got?.maxStage === 7,
    `本人が読み出せた (研究P=${got?.researchP} ステージ=${got?.maxStage})`);

  // 他人のコードでは読めない・書けない
  const stolen = await post('/api/load', { name: NAME, token: OTHER });
  check(stolen.ok === false, `別のコードでは読み出せない (${String(stolen.error ?? '')})`);
  const hijack = await post('/api/save', { name: NAME, token: OTHER, data: { researchP: 0 }, savedAt: Date.now() });
  check(hijack.ok === false, '別のコードでは上書きできない');

  // 古いデータでの上書きは拒否
  const old = await post('/api/save', {
    name: NAME, token: TOKEN, data: { researchP: 1 }, savedAt: Date.now() - 600_000,
  });
  check(old.ok === false, `古いセーブでの上書きは拒否 (${String(old.error ?? '')})`);

  // 削除
  const del = await post('/api/save/delete', { name: NAME, token: TOKEN });
  check(del.deleted === true, '削除できた');
  const after = await post('/api/load', { name: NAME, token: TOKEN });
  check(after.ok === false, '削除後は読み出せない');

  // 後片付け(ニックネームも解放)
  await post('/api/name/release', { name: NAME, token: TOKEN });

  console.log(ng === 0 ? '=== クラウドセーブ 合格 ===' : `=== ${ng}件の不具合 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();

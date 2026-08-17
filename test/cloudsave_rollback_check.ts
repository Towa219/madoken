// クラウドセーブが進行を巻き戻さないかを確かめる。
//
//   ADMIN_KEY=test1234 PORT=2573 npx tsx server/index.ts
//   PET_TEST_URL=http://localhost:2573 npx tsx test/cloudsave_rollback_check.ts
//
// ※ 本人確認や削除など、経路そのものの検証は test/cloudsave_check.ts。
//   こちらは「進行が巻き戻らないか」だけを見る。
//
// ★ 何が起きたか(2026-08-17)。
//   同じ端末なのに「別の端末にもっと新しい記録があります」と出て、
//   取り込むと研究Pが1/4に戻り、チケットが0→5に増えた。
//   古い状態を抱えた画面が後から保存し、「中身は古いのに時刻だけ新しい」
//   記録がサーバーに残ったのが原因。savedAt を端末から受け取って、
//   その大小だけで新旧を決めていた。
//
// ★ 直したのは3点。この検証はその3点をそれぞれ突く。
//   ① 保存時刻はサーバーが打つ(端末の時計を信じない)
//   ② 新旧は版(baseSavedAt)の一致で見る
//   ③ 進み具合が後退する保存は拒む(①②をすり抜けても最後に止まる)

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2573';
let 失敗数 = 0;

function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

const 名 = `雲${Date.now().toString(36).slice(-5)}`;
const 鍵 = `tok_${名}`;

interface 応答 { ok: boolean; error?: string; savedAt?: number; data?: unknown }

async function 保存(data: unknown, baseSavedAt: number | null, force = false): Promise<応答> {
  const r = await fetch(`${基点}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 名, token: 鍵, data, baseSavedAt, force }),
  });
  return await r.json() as 応答;
}

async function 読込(): Promise<応答> {
  const r = await fetch(`${基点}/api/load`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 名, token: 鍵 }),
  });
  return await r.json() as 応答;
}

// 進んだ状態 / 遅れた状態
const 進んだ = {
  version: 1, nickname: 名, charId: 0, researchP: 4000, tickets: 0,
  inventory: {}, spells: [], equipped: [], loadouts: [],
  discovered: ['a', 'b', 'c', 'd'], slots: 5,
  maxStage: 21, bestStage: 20, bossCleared: [5, 10, 15, 20],
  sortMode: 'order', codexRewarded: false, legendRewarded: false,
};
const 遅れた = {
  ...進んだ, researchP: 1000, tickets: 5,
  discovered: ['a'], slots: 3, maxStage: 6, bestStage: 5, bossCleared: [5],
};

async function 実行(): Promise<void> {
  console.log('=== クラウドセーブが進行を巻き戻さないか ===');
  console.log(`  研究者: ${名}`);

  // ---- ① 保存時刻はサーバーが打つ ----
  const 前 = Date.now();
  const 初回 = await 保存(進んだ, null);
  const 後 = Date.now();
  確認(初回.ok === true, '初回の保存ができる', String(初回.error ?? ''));
  確認(typeof 初回.savedAt === 'number' && 初回.savedAt >= 前 && 初回.savedAt <= 後 + 5000,
    '① 保存時刻はサーバーの時計', `${初回.savedAt}`);

  // 端末が未来の時刻を送ってきても効かないこと(昔はこれで壊れた)
  const 未来 = await 保存(進んだ, 初回.savedAt ?? null);
  確認(未来.ok === true, '同じ版なら続けて保存できる', String(未来.error ?? ''));
  確認((未来.savedAt ?? 0) < Date.now() + 60_000,
    '① 未来の時刻が記録に残らない', `${未来.savedAt}`);

  const 今の版 = 未来.savedAt ?? 0;

  // ---- ② 版が食い違う保存は止まる ----
  const 古い版 = await 保存(進んだ, 初回.savedAt ?? 0);
  確認(古い版.ok === false, '② 古い版を持つ画面からの保存は止まる',
    String(古い版.error ?? '(通ってしまった)'));

  // ---- ③ 後退する保存は止まる(これが今回の事故を防ぐ本命) ----
  const 後退 = await 保存(遅れた, 今の版);
  確認(後退.ok === false, '③ 進み具合が戻る保存は止まる',
    String(後退.error ?? '(通ってしまった)'));
  確認(String(後退.error ?? '').includes('戻る'),
    '③ 断る理由が分かる文になっている', String(後退.error ?? ''));

  // 版が合っていても後退なら止まること(=①②をすり抜けても最後に止まる)
  const 現状 = await 読込();
  const d = 現状.data as typeof 進んだ;
  確認(d.researchP === 4000 && d.maxStage === 21 && d.tickets === 0,
    '事故の再現: 進んだ記録がサーバーに残っている',
    `研究P=${d.researchP} 到達=${d.maxStage} チケット=${d.tickets}`);

  // ---- 本人が選べば戻せる(force) ----
  const 承知 = await 保存(遅れた, 今の版, true);
  確認(承知.ok === true, '本人が選んだ時(force)は戻せる', String(承知.error ?? ''));
  const 戻した = await 読込();
  確認((戻した.data as typeof 遅れた).maxStage === 6,
    'force なら遅れた記録で上書きできる');

  // ---- 正常な遊びで引っかからないこと ----
  // 研究Pを使い、魔法を分解した状態(減っているが後退ではない)
  const 版2 = 戻した.savedAt ?? 0;
  const 使った = { ...進んだ, researchP: 12, tickets: 0, spells: [] };
  const r = await 保存(使った, 版2);
  確認(r.ok === true, '研究Pを使った保存は通る(減っても後退ではない)',
    String(r.error ?? ''));

  console.log(失敗数 === 0 ? '=== 合格 ===' : `=== ${失敗数}件 失敗 ===`);
  process.exit(失敗数 === 0 ? 0 : 1);
}

void 実行().catch(e => {
  console.error('検証そのものが失敗:', e);
  process.exit(1);
});

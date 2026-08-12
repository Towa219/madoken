// 最近の変更点の帯を確かめる。
//
//   npx tsx test/changes_check.ts
//
// ★ 「今は出ている」だけでは足りない。新しい変更点を足した時に、
//   古いほうが自動で押し出されることまで見る。押し出されないと
//   「最近の変更点」にひと月前の話が並ぶことになる。

import { CHANGES, TICKER_COUNT, allChanges, recentChanges } from '../src/changes';

let 失敗数 = 0;
function 確認(条件: boolean, 文: string): void {
  if (条件) console.log(`合格: ${文}`);
  else { console.error(`失敗: ${文}`); 失敗数 += 1; }
}

function 日付(base: string, 足す: number): Date {
  const d = new Date(`${base}T12:00:00`);
  d.setDate(d.getDate() + 足す);
  return d;
}

function 実行(): void {
  console.log('=== 最近の変更点 ===');
  確認(CHANGES.length > 0, `変更点が登録されている → 実測 ${CHANGES.length}件`);

  const 基準 = CHANGES[0].date;
  console.log(`  いちばん新しい変更点の日付: ${基準}(新しい方から${TICKER_COUNT}件出す)`);

  const 今日 = recentChanges(日付(基準, 0));
  確認(今日.length === Math.min(TICKER_COUNT, CHANGES.length),
    `${TICKER_COUNT}件だけ出る → 実測 ${今日.length}件`);

  // ★ 日数では消えないこと。ここが元の作り(4日で消える)との違い。
  //   間が空いた人にも直近のぶんが読めるようにするための変更なので、
  //   「時間が経っても出続ける」ことこそ確かめたい項目になる。
  確認(recentChanges(日付(基準, 60)).length === Math.min(TICKER_COUNT, CHANGES.length),
    '2か月後でも出続ける(日数では消えない)');

  // 新しい方から取れているか。並びは更新履歴と同じでなければならない。
  const 履歴 = allChanges();
  確認(今日.every((c, i) => c === 履歴[i]),
    '帯に出るのは更新履歴の上位ぶんと同じ(順番が食い違わない)');
  確認(今日.length < CHANGES.length ? !今日.includes(履歴[履歴.length - 1]) : true,
    'いちばん古い変更点は帯に出ない(押し出されている)');

  // 未来の日付を書いてしまった時に、先に出てしまわないこと
  const 前日 = recentChanges(日付(基準, -1));
  確認(!前日.some(c => c.date === 基準),
    '前日には最新ぶんが出ない(未来の日付を先に出さない)');

  // 中身が遊ぶ人向けの言葉になっているか(実装の言葉が漏れていないか)
  const 実装語 = ['radius', 'quake', 'kind', 'stats', 'commit', 'px', 'null'];
  for (const c of CHANGES) {
    const 漏れ = 実装語.filter(w => c.text.toLowerCase().includes(w));
    確認(漏れ.length === 0,
      `「${c.text.slice(0, 20)}…」に実装の言葉が無い → 実測 ${漏れ.join(',') || 'なし'}`);
  }

  console.log();
  console.log('  今日出る内容:');
  for (const c of recentChanges()) console.log(`    ${c.date}  ${c.text}`);

  console.log();
  if (失敗数) { console.error(`検証終了: ${失敗数}件失敗しました。`); process.exit(1); }
  console.log('検証終了: 全項目に合格しました。');
}

実行();

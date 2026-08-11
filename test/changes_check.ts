// 最近の変更点の帯を確かめる。
//
//   npx tsx test/changes_check.ts
//
// ★ 「今は出ている」だけでは足りない。日が経てば自動で消えることまで
//   見る。消えないと「最近の変更点」にひと月前の話が並ぶことになる。

import { CHANGES, CHANGE_DAYS, recentChanges } from '../src/changes';

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
  console.log(`  いちばん新しい変更点の日付: ${基準}(${CHANGE_DAYS}日ぶん出す)`);

  確認(recentChanges(日付(基準, 0)).length > 0, 'その日は出る');
  確認(recentChanges(日付(基準, CHANGE_DAYS - 1)).length > 0,
    `${CHANGE_DAYS - 1}日後もまだ出る`);
  確認(recentChanges(日付(基準, CHANGE_DAYS)).length === 0,
    `${CHANGE_DAYS}日後には消える(古い話が居座らない)`);
  確認(recentChanges(日付(基準, 60)).length === 0, '2か月後には何も出ない');

  // 未来の日付を書いてしまった時に、先に出てしまわないこと
  確認(recentChanges(日付(基準, -1)).length === 0,
    '前日には出ない(未来の日付を先に出さない)');

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

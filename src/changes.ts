// 最近の変更点(流れる帯)
//
// 遊んでいる人に「何が変わったか」を知らせる。仕様を変えても
// 気づかれなければ、変えた意味がその人には届かない。
//
// ★ 1件ずつ日付を持たせ、古くなったものは自動で消す。
//   手で消す作りにすると必ず消し忘れ、「最近の変更点」に
//   ひと月前の話が並ぶことになる。
//
// ★ 書くのは「遊び方がどう変わるか」。実装の話は書かない。
//   「radius を 110 + 60n にした」ではなく
//   「土を1個混ぜるだけで隣の敵まで巻き込む」と書く。

export interface ChangeNote {
  date: string;    // 'YYYY-MM-DD'(この日から数えて DAYS 日ぶん出す)
  text: string;
}

// 何日ぶん出すか。ここを伸ばすと古い話まで流れ続ける。
export const CHANGE_DAYS = 4;

// ★ 遊ぶ人が触れないものを書かないこと。
//   ペット(試験中)は管理者モードでしか開けないので、8種目の鳥を
//   足した話をここに流しても、読んだ人は確かめようがない。
//   ペットを一般に開いた日に、まとめて1件書く。
//
// 新しいものを上に足していく。
export const CHANGES: ChangeNote[] = [
  {
    date: '2026-08-11',
    text: '⛰️ 土が範囲攻撃になりました。1個混ぜるだけで隣の敵まで巻き込みます'
      + '(土2でさらに広く・土3で敵全体)。単体への威力は変わりません',
  },
  {
    date: '2026-08-11',
    text: '💥 爆裂系(火×3)の爆発が、これまで隣の敵に届いていませんでした。'
      + '届く広さに直してあります',
  },
];

// 端末の日付を 'YYYY-MM-DD' で返す(Tips と同じ考え方)
function todayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// 今日出すぶんだけを返す。新しい順。
export function recentChanges(now = new Date()): ChangeNote[] {
  const key = todayKey(now);
  return CHANGES
    .filter(c => {
      const d = daysBetween(c.date, key);
      return d >= 0 && d < CHANGE_DAYS;   // 未来の日付は出さない
    })
    .slice();
}

// 画面上部の流れる帯を作る。出すものが無ければ帯ごと隠す。
export function renderChanges(now = new Date()): void {
  const bar = document.querySelector('#changes-bar');
  if (!bar) return;
  const list = recentChanges(now);
  if (list.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  const text = `🆕 最近の変更点 ─ ${list.map(c => c.text).join('　／　')}`;
  // 同じ文を2つ並べて途切れずに流す(Tips と同じ作り)
  bar.innerHTML =
    `<div class="changes-track"><span></span><span></span></div>`;
  // ★ innerHTML に本文を差し込まないこと。変更点は手で書く文章なので、
  //   将来ここに記号や引用符が入っても壊れないよう textContent で入れる。
  for (const span of bar.querySelectorAll('span')) span.textContent = text;
}

// 1日1枚のログインボーナス(ガチャチケット)
//
// チケットの使い道(ガチャ)はまだ無い。先に配り始めておくのは、
// 実装できた時に「今日から始めた人」と「前から遊んでいる人」の差が
// つくようにするため。
//
// 日付はこの端末の時計で見ている。時計を進めれば増やせてしまうが、
// 今はまだ使い道が無いので割に合わない。使えるようにする時に
// サーバー側の日付で配り直すこと(引き継ぎでチケット数は移る)。

import { showToast } from './lab';
import { notify, state } from './state';

export const DAILY_TICKETS = 1;

// その端末での「今日」(YYYY-MM-DD)。
// toISOString() は UTC なので使えない。日本時間の午前9時までが
// 前日扱いになり、朝に配られない。
export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 日付が変わっていたら配る。同じ日に何度呼んでも1回しか配らない。
export function grantDailyBonus(): boolean {
  const today = todayKey();
  if (state.lastBonusDate === today) return false;
  state.lastBonusDate = today;
  state.tickets += DAILY_TICKETS;
  notify();
  showToast(
    `🎟 ログインボーナス: ガチャチケット +${DAILY_TICKETS}(所持 ${state.tickets}枚)`,
  );
  return true;
}

// 開きっぱなしのまま日付が変わることがある。
// 画面に戻ってきた時に見る(ずっと開いていても翌日ぶんが受け取れる)。
export function watchDailyBonus(): void {
  grantDailyBonus();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) grantDailyBonus();
  });
}

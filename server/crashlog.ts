// 部屋の計算中に出た例外を控えておく。
//
// ★ なぜ要るか(2026-08-13)
//   「ボス戦でだけ切断される」を追っていて、部屋のメインループ(20Hz)に
//   受け皿が一つも無いことに気づいた。Node は拾われない例外でプロセスごと
//   終わるので、**どこか1回の計算が失敗しただけで、サーバー全体・全部屋の
//   全員が切れる**。受け皿を置いて部屋は続行させるようにしたが、
//   握り潰しては原因が永久に分からない。ここに控えて外から読めるようにする。
//
// ★ Renderのログは手元から読めない。だから /api/status に出す。
//   「サーバーが生きているのに、いつどの部屋で何が起きたか」を、
//   遊んでいる人に頼らずこちらで確かめられるようにするためのもの。

export interface RoomCrash {
  at: string;    // ISO
  text: string;
}

const KEEP = 20;
const 控え: RoomCrash[] = [];

export function noteRoomCrash(text: string): void {
  控え.unshift({ at: new Date().toISOString(), text: text.slice(0, 300) });
  if (控え.length > KEEP) 控え.length = KEEP;
}

export function roomCrashes(): RoomCrash[] {
  return 控え.slice();
}

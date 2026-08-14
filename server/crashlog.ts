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

// ---------------------------------------------------------------- 切れ方
//
// ★ なぜサーバー側でも記録するか(2026-08-14)
//   遊んでいる人の画面には必ず code=1006 が出る。前触れなく切れると
//   閉じる挨拶が届かないので、原因が何であれ 1006 になってしまう。
//   これでは「サーバーが閉じた」のか「間の回線・プロキシで切れた」のかを
//   分けられない。サーバー側が見た番号と、在室していた秒数を残す。
//
//   ・server-code=1006 … サーバーから見ても前触れなく切れた
//                        = 間(回線・Renderのプロキシ)で切れている
//   ・1000/1001 など    … 相手がきちんと閉じた
//   ・25秒前後で毎回切れる … 返事が無いとみなして**サーバーが閉じている**
//                        (pingInterval 5秒 × pingMaxRetries 5回)

const 切れ控え: RoomCrash[] = [];

export function noteDisconnect(text: string): void {
  切れ控え.unshift({ at: new Date().toISOString(), text: text.slice(0, 300) });
  if (切れ控え.length > KEEP) 切れ控え.length = KEEP;
  console.log(`[切断] ${text}`);
}

export function disconnects(): RoomCrash[] {
  return 切れ控え.slice();
}

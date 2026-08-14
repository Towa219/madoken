// shutdown_record_check.ts が起こす子プロセス。
//
// サーバー本体を読み込んで少し待ち、SIGTERM の受け口を呼ぶ。
//
// ★ Windows では child.kill('SIGTERM') は TerminateProcess になり、
//   Node の process.on('SIGTERM') は呼ばれない。それでは終了手順を
//   試せない。
//
// ★ process.emit('SIGTERM') も駄目だった(2026-08-14に実測)。
//   tsx が自前の SIGTERM を持っていて、そちらが先に走り
//   終了コード143でプロセスごと消える。試験の道具が試験対象を
//   壊していた。
//
// ★ そこで「読み込む前にあった受け口」を控えておき、読み込んだ後に
//   増えたぶん=アプリが登録したぶんだけを順に呼ぶ。Node が本物の
//   合図で呼ぶのと同じ関数を同じ順で呼ぶので、確かめたい
//   「記録を書き終える前に死なないか」はそのまま試せる。
//   試せていないのは「OSが本当に合図を届けるか」の一点だけ。

const 元からあった = new Set(process.listeners('SIGTERM'));

await import('../server/index.ts');

setTimeout(() => {
  const 増えた = process.listeners('SIGTERM').filter(f => !元からあった.has(f));
  console.log(`[試験] アプリが登録した SIGTERM の受け口は ${増えた.length}個。順に呼びます`);
  for (const f of 増えた) (f as (s: string) => void)('SIGTERM');
}, 3000);

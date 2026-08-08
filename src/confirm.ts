// 「本当にいいか」を聞く小さな窓。
//
// 取り返しのつかない操作(研究Pを払う・素材を使い切る)の手前に置く。
// window.confirm は端末によって出ないことがあり、見た目もこの世界から浮くので、
// 卓(#trade-modal)と同じ作りの窓を自前で出す。
//
//   if (await askConfirm({ title: '…', body: '…', yes: '…' })) { 実行 }

export interface AskOptions {
  title: string;
  body?: string;      // HTML可(呼ぶ側で組み立てる)
  yes?: string;
  no?: string;
  danger?: boolean;   // 取り返しがつかない時は「はい」を赤くする
}

let open: HTMLElement | null = null;

export function askConfirm(opts: AskOptions): Promise<boolean> {
  // 二重に開かない。前の問いが残っていたら「いいえ」で閉じる。
  if (open) { open.remove(); open = null; }

  return new Promise<boolean>(resolve => {
    const back = document.createElement('div');
    back.className = 'ask-modal';
    const card = document.createElement('div');
    card.className = 'ask-card';
    card.innerHTML =
      `<h3>${opts.title}</h3>`
      + (opts.body ? `<p class="note">${opts.body}</p>` : '');

    const row = document.createElement('div');
    row.className = 'ask-actions';
    const yes = document.createElement('button');
    yes.className = opts.danger ? 'danger' : 'primary';
    yes.textContent = opts.yes ?? 'はい';
    const no = document.createElement('button');
    no.textContent = opts.no ?? 'やめる';
    row.append(yes, no);
    card.appendChild(row);
    back.appendChild(card);
    document.body.appendChild(back);
    open = back;

    const close = (v: boolean) => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      if (open === back) open = null;
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };

    yes.addEventListener('click', () => close(true));
    no.addEventListener('click', () => close(false));
    // 外側を押したら「やめる」。誤爆を防ぐのが目的なので、
    // 迷って外を押した時は必ず何も起きない側へ倒す。
    back.addEventListener('click', e => { if (e.target === back) close(false); });
    document.addEventListener('keydown', onKey);
    no.focus();
  });
}

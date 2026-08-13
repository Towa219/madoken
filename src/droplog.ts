// 切断の記録。
//
// ★ なぜ要るか
//   「ボス戦でサーバー切断で落ちる」と言われても、こちらでは再現しない。
//   手元でもRenderの本番でも、素の接続でボスを倒しきって一度も切れなかった。
//   落ちた本人の画面にしか手掛かりが無いのに、これまでは切断のコードを
//   受け取った直後に捨てていた。回線なのか、サーバーが閉じたのか、
//   間のプロキシなのかを分ける材料が何も残らない。
//
// ★ 端末に残すこと。画面に出すだけでは、読む前に戦闘選択へ戻ってしまう
//   (実際、何のメッセージも出ないまま戻ると報告されている)。
//   読み込み直しても消えないよう localStorage に置く。

const KEY = 'madoken_drops_v1';
const MAX = 30;

export interface DropNote {
  at: string;    // 'MM/DD HH:MM:SS'
  text: string;
}

function 今(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dropList(): DropNote[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as DropNote[]).filter(x => x && typeof x.text === 'string') : [];
  } catch { return []; }
}

// WebSocketの終了コードを、読める言葉にする。
//
// ★ コードそのものも必ず残すこと。言葉に直した時点で情報が減るので、
//   知らないコードが来た時に何も分からなくなる。
export function dropReason(code: number): string {
  const 表: Record<number, string> = {
    1000: '正常終了',
    1001: 'サーバーが閉じた(再起動・配備)',
    1005: '理由なしで終了',
    1006: '前触れなく切断(回線かプロキシ)',
    1011: 'サーバー内部エラー',
    1012: 'サーバー再起動',
    1013: 'サーバーが混んでいる',
    1015: 'TLSの失敗',
    4000: '部屋から退出',
    4001: '部屋が見つからない',
    4002: '部屋がいっぱい',
    4003: '入室を断られた',
  };
  const 名 = 表[code];
  return 名 ? `code=${code} ${名}` : `code=${code}`;
}

export function noteDrop(text: string): void {
  const 行 = { at: 今(), text: text.trim() };
  // 画面が消えても追えるように、開発者コンソールにも出す
  console.warn('[切断]', 行.at, 行.text);
  try {
    const list = dropList();
    list.unshift(行);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch { /* 保存できなくても致命的ではない */ }
  renderDropLog();
}

export function clearDrops(): void {
  try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
  renderDropLog();
}

// 設定の「切断の記録」を組み立てる。
export function renderDropLog(): void {
  const box = document.querySelector('#drop-log');
  if (!box) return;
  box.replaceChildren();
  const list = dropList();
  if (list.length === 0) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'まだ記録がありません(切れていません)。';
    box.append(p);
    return;
  }
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'chg-row';
    const head = document.createElement('span');
    head.className = 'chg-when';
    head.textContent = d.at;
    const body = document.createElement('span');
    body.className = 'chg-text';
    body.textContent = d.text;
    row.append(head, body);
    box.append(row);
  }
}

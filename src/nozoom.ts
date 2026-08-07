// 戦闘中の「ダブルタップで拡大」を止める(iPhone向け)
//
// CSS の touch-action: manipulation は既に全要素に効いている(戦闘中に測ると
// 580要素すべて manipulation、Pixi のキャンバスだけ none)。それでも iPhone で
// 拡大が起きるという報告があった。
//
// Safari 以外の入れ物 ― X・Discord・LINE などアプリ内ブラウザ(WKWebView)や
// 古い iOS ― では touch-action が期待どおりに効かないことがある。
// そこで最後の砦として、2回目の素早いタップの既定動作そのものを止める。
//
// 止める条件は3つとも満たした時だけ:
//   ・戦闘中である(研究室などでは拡大できたままにする)
//   ・前のタップから 350ms 以内
//   ・前のタップから 40px 以内(同じ所を2度叩いた時だけ。別のボタンは通す)
//
// ★ 2回目の既定動作を止めると、そのタップから click が作られなくなる。
//   魔法ボタンを click で撃っていると、連打の2発目が不発になる。
//   そのため魔法ボタンは pointerdown で撃つようにしてある(battle/coop/duel)。
//   ここを直す時は必ず両方セットで見ること。

const GAP_MS = 350;
const GAP_PX = 40;

let lastTime = 0;
let lastX = 0;
let lastY = 0;

// 戦闘の画面が出ているか。ソロ・共闘・決闘のどれでも止める。
function inBattle(): boolean {
  const shown = (sel: string): boolean => {
    const el = document.querySelector(sel);
    if (!el || el.classList.contains('hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return shown('#battle-view') || shown('#coop-view') || shown('#duel-view');
}

export function installNoZoom(): void {
  document.addEventListener('touchend', ev => {
    if (!inBattle()) { lastTime = 0; return; }
    const t = ev.changedTouches[0];
    if (!t) return;
    const now = ev.timeStamp || Date.now();
    const near = Math.abs(t.clientX - lastX) < GAP_PX
      && Math.abs(t.clientY - lastY) < GAP_PX;
    if (now - lastTime < GAP_MS && near) {
      // ここで止めるのは「拡大」だけではなく、このタップから作られる
      // click も含む。魔法は pointerdown で撃っているので影響しない。
      ev.preventDefault();
      lastTime = 0;      // 3回目を1回目として数え直す(連打を殺さない)
      return;
    }
    lastTime = now;
    lastX = t.clientX;
    lastY = t.clientY;
  }, { passive: false, capture: true });

  // iOS のピンチ拡大(gesture系)も戦闘中だけ止める。
  // 戦闘中に指2本で広げてしまうと、敵も魔法ボタンも画面外に出て操作できなくなる。
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(name, ev => {
      if (inBattle()) ev.preventDefault();
    }, { passive: false });
  }
}

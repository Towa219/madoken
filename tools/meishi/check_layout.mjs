// 名刺の版が、狙った位置と大きさで組めているかを実測する。
//
//   node tools/meishi/check_layout.mjs
//
// ★ なぜ要るか(2026-08-10の事故)
//   ずれ補正を「面(名刺)」と「ハサミ線」の2か所に別々に書いていて、
//   片方だけ動いていた。刷った人には「カット枠だけずれる」
//   「3mmずらしたのに1cm違う」と見え、原因にたどり着くまで
//   何度も紙を無駄にした。直したあとも、今度は両方に足してしまい
//   二重に効いた。目で見て分かる類の間違いではないので、機械に測らせる。
//
// make_pdf.mjs が最初にこれを呼ぶ。落ちたらPDFは作らない。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9485;

// build_meishi.py と同じ値。ここがずれたら、そもそも版が別物になる。
const CARD_W = 91, CARD_H = 55, MARGIN_X = 14, MARGIN_Y = 11;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 生成された HTML の数値ベイク済みCSSから、実際に使われた補正値と倍率を読む
function shiftFromHtml(file) {
  const s = fs.readFileSync(file, 'utf8');
  const size = s.match(/\.card\s*\{[\s\S]*?width:\s*(-?[\d.]+)mm;\s*height:\s*(-?[\d.]+)mm;/);
  const pos = s.match(/\.card:nth-child\(1\)\s*\{\s*left:\s*(-?[\d.]+)mm;\s*top:\s*(-?[\d.]+)mm;/);
  if (!size || !pos) throw new Error('数値ベイク済みのカード寸法・位置が見つからない');
  return { x: parseFloat(pos[1]) - MARGIN_X, y: parseFloat(pos[2]) - MARGIN_Y,
           sx: parseFloat(size[1]) / CARD_W, sy: parseFloat(size[2]) / CARD_H };
}

async function main() {
  const file = path.join(HERE, 'madoken_meishi_cut.html');
  if (!fs.existsSync(file)) {
    console.log('先に build_meishi.py を走らせること');
    process.exit(1);
  }
  const want = shiftFromHtml(file);
  console.log('=== 名刺の版を実測する ===');
  console.log(`狙い: ずれ補正 横${want.x}mm / 縦${want.y}mm / 倍率 横×${want.sx} 縦×${want.sy}`);

  const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'meishi-chk-'));
  const ch = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const l = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
        wsUrl = (l.find(t => t.type === 'page') || {}).webSocketDebuggerUrl || '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl) { check('ブラウザの起動', false); return; }

    const W = new WebSocket(wsUrl);
    await new Promise(r => { W.onopen = r; });
    let id = 0; const wait = new Map();
    W.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    };
    const send = (m, p = {}) => new Promise(r => {
      const i = ++id; wait.set(i, r); W.send(JSON.stringify({ id: i, method: m, params: p }));
    });
    const ev = async x =>
      (await send('Runtime.evaluate', { expression: x, returnByValue: true }))
        .result?.result?.value;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    await sleep(2500);

    const m = await ev(`
      (() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;width:100mm;visibility:hidden';
        document.body.appendChild(probe);
        const px = probe.getBoundingClientRect().width / 100;
        probe.remove();
        const sheet = document.querySelector('.sheet').getBoundingClientRect();
        const mm = v => +(v / px).toFixed(2);
        const cards = [...document.querySelectorAll('.card')].map(c => {
          const r = c.getBoundingClientRect();
          return { x: mm(r.left - sheet.left), y: mm(r.top - sheet.top),
                   w: mm(r.width), h: mm(r.height) };
        });
        const line = document.querySelector('.cut line');
        const lb = line.getBoundingClientRect();
        // 名刺の中身どうしが重なっていないか(1面目で見る)
        const card = document.querySelector('.card');
        const parts = ['.title','.badge','.mark','.lead','.pts','.foot','.chara','.wind']
          .map(s => ({ s, r: card.querySelector(s).getBoundingClientRect() }));
        const hit = (a,b) => !(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);
        const over = [];
        for (let i=0;i<parts.length;i++) for (let j=i+1;j<parts.length;j++)
          if (hit(parts[i].r, parts[j].r)) over.push(parts[i].s + ' × ' + parts[j].s);
        return JSON.stringify({ cards, line: mm(lb.left - sheet.left), over });
      })()
    `);
    const got = JSON.parse(m);
    W.close();

    check('10面ある', got.cards.length === 10, `${got.cards.length}面`);
    const c0 = got.cards[0];
    // 倍率を掛けた版では、版の中の1面は 91×55mm より大きい。
    // 紙の上で91mmになるのが狙いなので、ここでは倍率込みの値と突き合わせる。
    check(`1面の大きさが ${(CARD_W * want.sx).toFixed(2)}×${(CARD_H * want.sy).toFixed(2)}mm`,
      near(c0.w, CARD_W * want.sx) && near(c0.h, CARD_H * want.sy),
      `${c0.w} × ${c0.h}mm`);
    // 面付けの左上の角(14, 11)を基準に伸ばすので、その角は倍率で動かない
    const wx = MARGIN_X + want.x;
    const wy = MARGIN_Y + want.y;
    check('★1面目が狙いの位置にある',
      near(c0.x, wx, 0.2) && near(c0.y, wy, 0.2),
      `(${c0.x}, ${c0.y})mm / 狙い (${wx.toFixed(2)}, ${wy.toFixed(2)})mm`);
    // ここが本命。面と線が同じだけ動いていること。
    check('★ハサミ線が名刺の縁と一致する', near(got.line, c0.x),
      `線 ${got.line}mm / 名刺の左 ${c0.x}mm`);
    // 面と面の間隔が用紙どおり(どこか1面だけずれていないか)
    const gapX = got.cards[1].x - got.cards[0].x;
    const gapY = got.cards[2].y - got.cards[0].y;
    check(`面の間隔が ${(CARD_W * want.sx).toFixed(2)} / ${(CARD_H * want.sy).toFixed(2)}mm`,
      near(gapX, CARD_W * want.sx, 0.2) && near(gapY, CARD_H * want.sy, 0.2),
      `横${gapX} 縦${gapY}mm`);
    check('中身が重なっていない', got.over.length === 0, got.over.join(' / '));
  } finally {
    ch.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }

  console.log(failures === 0 ? '=== 合格 ===' : `=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

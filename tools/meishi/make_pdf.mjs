// 名刺のHTMLから、A4ぴったりのPDFを作る。
//
//   node tools/meishi/make_pdf.mjs
//
// ブラウザの印刷ダイアログは倍率の指定を間違えやすい。
// PDFにしておけば「実際のサイズ」で刷るだけで済む。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 線なし(エーワン 51861用)と、ハサミ線あり(普通紙用)の2種類
const JOBS = ['madoken_meishi', 'madoken_meishi_cut'];
const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9458;

// ★ PDFにする前に、版が狙いどおりに組めているかを実測して確かめる。
//   面とハサミ線が別々に動いていた事故(2026-08-10)を二度と紙にしないため。
{
  const r = spawnSync(process.execPath, [path.join(HERE, 'check_layout.mjs')],
    { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('版の確認で落ちた。PDFは作らない。');
    process.exit(1);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'madoken-pdf-'));
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
  if (!wsUrl) throw new Error('ブラウザを起動できない');

  const W = new WebSocket(wsUrl);
  await new Promise(r => { W.onopen = r; });
  let id = 0; const wait = new Map();
  W.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id; wait.set(i, r); W.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');

  for (const job of JOBS) {
    const html = path.join(HERE, job + '.html');
    const pdf = path.join(HERE, job + '.pdf');
    if (!fs.existsSync(html)) { console.log('無い:', html); continue; }

    await send('Page.navigate', { url: 'file:///' + html.replace(/\\/g, '/') });
    await sleep(3000);   // 埋め込み画像の展開を待つ

    const r = await send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27, paperHeight: 11.69,        // A4
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      preferCSSPageSize: true,                      // @page size: A4 をそのまま使う
    });
    if (!r.result?.data) throw new Error('PDFを作れなかった: ' + job);
    fs.writeFileSync(pdf, Buffer.from(r.result.data, 'base64'));
    console.log(`書き出した: ${pdf} (${Math.round(fs.statSync(pdf).size / 1024)} KB)`);
  }
  console.log('刷る時は「実際のサイズ(100%)」で。用紙に合わせて拡大縮小しないこと。');
  W.close();
} finally {
  ch.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
}

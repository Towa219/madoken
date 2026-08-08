// 名刺のHTMLから、A4ぴったりのPDFを作る。
//
//   node tools/meishi/make_pdf.mjs
//
// ブラウザの印刷ダイアログは倍率の指定を間違えやすい。
// PDFにしておけば「実際のサイズ」で刷るだけで済む。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, 'madoken_meishi.html');
const PDF = path.join(HERE, 'madoken_meishi.pdf');
const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9458;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'madoken-pdf-'));
const ch = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank',
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
  await send('Page.navigate', { url: 'file:///' + HTML.replace(/\\/g, '/') });
  await sleep(3000);   // 埋め込み画像の展開を待つ

  const r = await send('Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.27, paperHeight: 11.69,        // A4
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    preferCSSPageSize: true,                      // @page size: A4 をそのまま使う
  });
  if (!r.result?.data) throw new Error('PDFを作れなかった');
  fs.writeFileSync(PDF, Buffer.from(r.result.data, 'base64'));
  console.log('書き出した:', PDF);
  console.log('  大きさ:', Math.round(fs.statSync(PDF).size / 1024), 'KB');
  console.log('  刷る時は「実際のサイズ(100%)」で。用紙に合わせて拡大縮小しないこと。');
  W.close();
} finally {
  ch.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
}

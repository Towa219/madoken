// 設定の「更新履歴」を確かめる。
//
//   npm run dev  … 先に開発サーバーを起こす
//   npx tsx test/change_history_check.ts
//
// ★ 帯は日付で消えるが、履歴は消えない。そこが要点なので、
//   「帯に出ていないぶんも履歴には残っているか」を必ず見る。
//   ここが崩れると、読み逃した人が二度と辿れなくなる。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANGES, allChanges, recentChanges } from '../src/changes';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9499;
const OUT = join(process.cwd(), 'tools', 'shots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== 設定の更新履歴 ===');
  console.log(`  記録の総数: ${CHANGES.length}件 / 今日 帯に流れるのは ${recentChanges().length}件`);
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'ch-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1000,1100', 'about:blank',
  ], { stdio: 'ignore' });

  let ng = 0;
  try {
    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ */ }
    }
    if (!ws) { console.log('  ブラウザを起動できなかった'); process.exit(1); }

    const sock = new WebSocket(ws);
    await new Promise<void>(r => { sock.onopen = () => r(); });
    let id = 0;
    const wait = new Map<number, (v: any) => void>();
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id !== undefined && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); }
    };
    const send = (method: string, params: unknown = {}) => new Promise<any>(r => {
      const i = ++id; wait.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async <T>(x: string): Promise<T> =>
      (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))
        .result?.result?.value as T;

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);

    await ev('document.querySelector("#tab-settings").click()');
    await sleep(1500);

    const 行 = await ev<{ 日: string; 文: string }[]>(`(() => {
      return [...document.querySelectorAll('#change-history .chg-row')].map(r => ({
        日: (r.querySelector('.chg-when')?.textContent || '').trim(),
        文: (r.querySelector('.chg-text')?.textContent || '').trim(),
      }));
    })()`);

    const 件数 = (行 ?? []).length;
    const 揃い = 件数 === CHANGES.length;
    if (!揃い) ng++;
    console.log(`  ${揃い ? 'OK ' : 'NG '} 記録が全部出ている → 実測 ${件数}件 / 定義 ${CHANGES.length}件`);

    // 日付と版番号が添えてあるか
    const 添え = (行 ?? []).every(r => /^\d{4}-\d{2}-\d{2}\s+v\d+\.\d+\.\d+$/.test(r.日));
    if (!添え) ng++;
    console.log(`  ${添え ? 'OK ' : 'NG '} すべての行に日付と版番号が付いている`);

    // 新しい順か
    const 並び = (行 ?? []).map(r => r.日.split(/\s+/)[0]);
    const 降順 = 並び.every((d, i) => i === 0 || 並び[i - 1] >= d);
    if (!降順) ng++;
    console.log(`  ${降順 ? 'OK ' : 'NG '} 新しい順に並んでいる`);

    // ★ 帯から消えたものも履歴には残るか。
    //   いま全部が「今日」なら差が出ないので、その旨だけ出す。
    const 帯 = recentChanges().length;
    if (帯 < CHANGES.length) {
      const 残り = allChanges().slice(帯);
      const 残っている = 残り.every(c => (行 ?? []).some(r => r.文 === c.text));
      if (!残っている) ng++;
      console.log(`  ${残っている ? 'OK ' : 'NG '} 帯から消えた${残り.length}件も履歴に残っている`);
    } else {
      console.log('  --  今は全件が帯にも出ている(日が経てば差が出る)');
    }

    for (const r of (行 ?? []).slice(0, 4)) {
      console.log(`     ${r.日}  ${r.文.slice(0, 34)}…`);
    }

    await ev(`(() => {
      const el = document.querySelector('#history-panel');
      if (el) el.scrollIntoView();
    })()`);
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(OUT, 'change_history.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/change_history.png');
    }
    sock.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();

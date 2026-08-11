// 最近の変更点の帯が、実画面で本当に流れているかを確かめる。
//
//   npx tsx test/changes_bar_check.ts                       … 手元(2567番)
//   MADOKEN_URL=https://madoken.onrender.com npx tsx test/changes_bar_check.ts
//
// ★ 「文字が入っている」だけでは足りない。帯が隠れていないか、
//   高さがあるか、動いているかまで見る。中身があっても
//   hidden のままなら誰の目にも触れない。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentChanges } from '../src/changes';

const URL_ = process.env.MADOKEN_URL ?? 'http://localhost:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9497;
const OUT = join(process.cwd(), 'tools', 'shots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== 最近の変更点の帯 ===');
  console.log(`  見に行く先: ${URL_}`);
  console.log(`  今日出るはずの件数: ${recentChanges().length}件`);
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'cb-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1000,700', 'about:blank',
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
    const 記録: string[] = [];
    sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: any };
      if (m.id !== undefined && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') {
        const t = JSON.stringify(m.params).slice(0, 200);
        記録.push(t);
      }
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
    await sleep(8000);

    const 様子 = await ev<{
      ある: boolean; 隠れ: boolean; 高さ: number; 文: string; 動き: string;
    }>(`(() => {
      const bar = document.querySelector('#changes-bar');
      if (!bar) return { ある: false, 隠れ: true, 高さ: 0, 文: '', 動き: '' };
      const track = bar.querySelector('.changes-track');
      const cs = getComputedStyle(bar);
      return {
        ある: true,
        隠れ: bar.classList.contains('hidden') || cs.display === 'none',
        高さ: Math.round(bar.getBoundingClientRect().height),
        文: (bar.textContent || '').trim().slice(0, 60),
        動き: track ? getComputedStyle(track).animationName : '(中身が無い)',
      };
    })()`);

    // 2本の帯の位置と色を並べて出す。Tips と見分けが付くかを見る。
    const 並び = await ev<string>(`(() => {
      const 取る = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          名: sel, 上: Math.round(r.top), 高さ: Math.round(r.height),
          背景: cs.backgroundImage.slice(0, 60) || cs.backgroundColor,
          文字色: cs.color,
        };
      };
      return JSON.stringify([取る('#tips-bar'), 取る('#changes-bar')], null, 1);
    })()`);
    console.log('  2本の帯:');
    console.log(String(並び).split(String.fromCharCode(10)).map(l => '   ' + l).join(String.fromCharCode(10)));

    // ★ 速さは「秒」ではなく「1秒あたり何px流れるか」で見る。
    //   時間だけ見ても、文の長さが違えば速さは別物になる。
    const 速さ = await ev<string>(`(() => {
      const 測る = (barSel, trackSel) => {
        const bar = document.querySelector(barSel);
        const track = bar && bar.querySelector(trackSel);
        if (!track) return null;
        const 秒 = parseFloat(getComputedStyle(track).animationDuration) || 0;
        const 幅 = track.scrollWidth / 2;
        return { 名: barSel, 幅: Math.round(幅), 秒: Math.round(秒 * 10) / 10,
                 速さ: 秒 > 0 ? Math.round(幅 / 秒) : 0 };
      };
      return JSON.stringify([
        測る('#tips-bar', '.tips-track'),
        測る('#changes-bar', '.changes-track'),
      ]);
    })()`);
    console.log('  流れる速さ: ' + String(速さ));
    const 速さ表 = JSON.parse(String(速さ) || '[]') as ({ 名: string; 速さ: number } | null)[];
    const 有効 = 速さ表.filter((x): x is { 名: string; 速さ: number } => x !== null);
    const 揃い = 有効.length === 2 && Math.abs(有効[0].速さ - 有効[1].速さ) <= 8;
    if (!揃い) ng++;
    console.log(`  ${揃い ? 'OK ' : 'NG '} 2本の帯が同じ速さで流れる`);
    const 速い = 有効.every(x => x.速さ >= 40);
    if (!速い) ng++;
    console.log(`  ${速い ? 'OK ' : 'NG '} のろのろではない(1秒あたり40px以上)`);

    const 見る: [boolean, string][] = [
      [様子.ある, '帯の器が画面にある'],
      [!様子.隠れ, '帯が隠れていない'],
      [様子.高さ > 5, `帯に高さがある(${様子.高さ}px)`],
      [様子.文.length > 0, '帯に文字が入っている'],
      [様子.動き.includes('changes-scroll'), `流れる動きが付いている(${様子.動き})`],
    ];
    for (const [ok, 文] of 見る) {
      if (!ok) ng++;
      console.log(`  ${ok ? 'OK ' : 'NG '} ${文}`);
    }
    if (様子.文) console.log(`     文字: ${様子.文}…`);

    if (記録.length) {
      console.log('  画面から出た知らせ(上位3件):');
      for (const t of 記録.slice(0, 3)) console.log(`     ${t}`);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(join(OUT, 'changes_bar.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  撮影: tools/shots/changes_bar.png');
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

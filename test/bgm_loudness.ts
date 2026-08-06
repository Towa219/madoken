// BGM 6曲の実際の音量を測る(合否は出さない。数値を見るための道具)。
//
// 「ボス戦のBGMがまだ小さい」の切り分けに使う。
// 音量つまみは全曲に同じ倍率をかけるので、曲そのものの録音レベルが違うと
// つまみをいくら上げても、曲ごとの大小差はそのまま残る。
//
// ブラウザに実際に読ませて復号し、二乗平均(RMS)と最大値を出す。
//
//   npx tsx test/bgm_loudness.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9471;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      const fn = this.waiting.get(m.id);
      if (fn) { this.waiting.delete(m.id); fn(m); }
    };
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise(res => {
      this.waiting.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }

  close(): void { this.ws.close(); }
}

interface Row { id: string; file: string; rms: number; peak: number; sec: number }

async function main(): Promise<void> {
  console.log('=== BGMの音量を測る ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-bl-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars', '--window-size=800,600', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  try {
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl) { console.log('  ブラウザを起動できなかった'); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(1500);

    const rows = await cdp.evaluate<Row[]>(`
      (async () => {
        const man = await (await fetch('sound/manifest.json')).json();
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const out = [];
        for (const [id, file] of Object.entries(man.bgm ?? {})) {
          try {
            const buf = await (await fetch('sound/' + file)).arrayBuffer();
            const a = await ctx.decodeAudioData(buf);
            const d = a.getChannelData(0);
            // 全部なめると重いので等間隔に間引く(曲の平均を見るには十分)
            let sum = 0, peak = 0, n = 0;
            const step = Math.max(1, Math.floor(d.length / 400000));
            for (let i = 0; i < d.length; i += step) {
              const v = Math.abs(d[i]);
              sum += v * v; n++;
              if (v > peak) peak = v;
            }
            out.push({
              id, file,
              rms: Math.sqrt(sum / Math.max(1, n)),
              peak,
              sec: a.duration,
            });
          } catch (e) {
            out.push({ id, file, rms: -1, peak: -1, sec: 0 });
          }
        }
        return out;
      })()
    `);

    if (!rows || rows.length === 0) { console.log('  読めなかった'); return; }
    const gains = await cdp.evaluate<Record<string, number>>(
      '(async () => (await (await fetch("sound/manifest.json")).json()).bgmGain ?? {})()');
    const db = (v: number) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '---');
    const g = (id: string) => Number(gains?.[id]) > 0 ? Number(gains[id]) : 1;

    const loudest = rows.reduce((a, b) => (b.rms > a.rms ? b : a));
    console.log('');
    console.log('  曲       素の音量   最大     補正   補正後  いちばん大きい曲との差');
    let worst = 0;
    for (const r of rows) {
      const after = r.rms * g(r.id);
      const base = loudest.rms * g(loudest.id);
      const diff = after > 0 ? 20 * Math.log10(after / base) : 0;
      worst = Math.max(worst, Math.abs(diff));
      console.log(
        `  ${r.id.padEnd(8)} ${db(r.rms).padStart(6)}dB ${db(r.peak).padStart(6)}dB`
        + `  ×${g(r.id).toFixed(2)}  ${db(after).padStart(6)}dB`
        + `  ${diff.toFixed(1).padStart(6)}dB`);
    }
    console.log('');
    console.log(worst <= 1.5
      ? `  OK  補正後は全曲がそろっている(最大の差 ${worst.toFixed(1)}dB / 目安 1.5dB以内)`
      : `  NG  補正後もそろっていない(最大の差 ${worst.toFixed(1)}dB)。`
        + 'manifest.json の bgmGain を「揃えるには」の倍率に直すこと。');
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残っても害は無い */ }
  }
  console.log('\n=== 測定おわり ===');
  process.exit(0);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

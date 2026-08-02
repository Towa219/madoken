// BGMの「音楽が実際に鳴っている範囲」を測り、JSONで出す。
//
// ACE-Step は曲として終わらせるため、末尾が無音になる。そのままループすると
// 「静かになった後にいきなり頭から鳴り直す」ので、無音を切り落とす必要がある。
// MP3をローカルで展開する手段が無いので、実ブラウザにデコードさせて測る。
//
//   npx tsx tools/soundgen/measure.ts <出力先.json> <URL...>

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2];
const URLS = process.argv.slice(3);
const PORT = 9370;
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'meas-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let id = 0;
const waiting = new Map<number, (v: unknown) => void>();
let ws!: WebSocket;
function send(method: string, params: unknown = {}): Promise<any> {
  const n = ++id;
  return new Promise(res => { waiting.set(n, res as never); ws.send(JSON.stringify({ id: n, method, params })); });
}
const evaluate = (expression: string) =>
  send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then(r => r.result?.result?.value);

// 0.2秒ごとのRMSを見て、音楽が鳴っている最初と最後の時刻を求める
const SCRIPT = (url: string) => `
(async () => {
  try {
    const res = await fetch(${JSON.stringify(url)});
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(await res.arrayBuffer());
    const ch = audio.getChannelData(0);
    const win = Math.floor(audio.sampleRate * 0.2);
    const rms = [];
    for (let i = 0; i + win <= ch.length; i += win) {
      let s = 0;
      for (let k = 0; k < win; k++) s += ch[i + k] * ch[i + k];
      rms.push(Math.sqrt(s / win));
    }
    const peak = Math.max(...rms);
    const thr = peak * 0.06;          // 全体の6%未満は無音とみなす
    let a = 0, b = rms.length - 1;
    while (a < rms.length && rms[a] < thr) a++;
    while (b > a && rms[b] < thr) b--;
    return {
      duration: +audio.duration.toFixed(2),
      start: +(a * 0.2).toFixed(2),
      end: +((b + 1) * 0.2).toFixed(2),
    };
  } catch (e) { return { error: String(e) }; }
})()`;

(async () => {
  let target = '';
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
      target = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch { /* まだ */ }
  }
  ws = new WebSocket(target);
  await new Promise<void>(res => { ws.onopen = () => res(); });
  ws.onmessage = ev => {
    const m = JSON.parse(String(ev.data));
    const fn = waiting.get(m.id);
    if (fn) { waiting.delete(m.id); fn(m); }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:2567' });
  await sleep(2500);

  const out: Record<string, { start: number; end: number; duration: number }> = {};
  for (const u of URLS) {
    const r = await evaluate(SCRIPT(u));
    const name = u.split('/').pop() ?? u;
    if (!r || r.error) { console.log(`✗ ${name}: ${r?.error}`); continue; }
    out[name] = r;
    const cut = (r.duration - r.end).toFixed(2);
    console.log(`${name}: 全${r.duration}秒 → 音楽は ${r.start}〜${r.end}秒`
      + `(末尾の無音 ${cut}秒)`);
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`${OUT} に書き出した`);
  ws.close(); chrome.kill();
  process.exit(0);
})();

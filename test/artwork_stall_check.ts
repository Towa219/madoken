// 絵の素材の読み込みが返ってこない時でも、起動が止まらないかを確かめる。
//
//   npm run dev            … 先に開発サーバーを起こす
//   npx tsx test/artwork_stall_check.ts
//
// ★ なぜ要るか(2026-08-22)。
//   src/artwork.ts の loadArtwork() には、待ち続けてしまう穴が2つあった。
//     ① 目録(img/manifest.json)の fetch に上限が無い。
//        拒否されるなら catch が拾って先へ進めるが、返事が来ない場合は
//        永久に待つ。
//     ② 絵を Promise.all でまとめて待っている。24枚のうち1枚でも
//        止まると、全部が止まる。
//
//   src/main.ts は
//     void loadArtwork().then(() => renderCharPickers());
//   と書いてあるので、止まると絵の描き直しが二度と起きない。
//   2026-08-21 に音(src/sound.ts)でこれと同じ形の不具合が実際に出て、
//   音量つまみが効かなくなっていた。同じ轍を踏まないための見張り。
//
// ★ 待ち時間が長いので、このテストは1分ほどかかる(上限が10秒と15秒のため)。

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.MADOKEN_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let 失敗数 = 0;
function 確認(条件: boolean, 文: string, 補足 = ''): void {
  if (条件) console.log(`  OK  ${文}${補足 ? ` — ${補足}` : ''}`);
  else { console.error(`  NG  ${文}${補足 ? ` — ${補足}` : ''}`); 失敗数 += 1; }
}

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  onEvent: ((method: string, params: any) => void) | null = null;
  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDPに接続できない'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id === undefined) { this.onEvent?.(m.method, m.params); return; }
      const fn = this.waiting.get(m.id);
      if (fn) { this.waiting.delete(m.id); fn(m); }
    };
  }
  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise(res => { this.waiting.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value as T;
  }
  close(): void { this.ws.close(); }
}

function seedSave(名: string) {
  return {
    version: 1, nickname: 名, nickToken: `tok_${名}`, charId: 0, researchP: 100,
    inventory: {}, spells: [], equipped: [], discovered: [], slots: 2,
    maxStage: 1, bestStage: 0, bossRewarded: [], bossCleared: [],
    sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

// 何を止めるかを決めて1回動かす。
//   止める='manifest' … 目録を掴んだまま返さない
//   止める='image'    … 絵を1枚だけ掴んだまま返さない
async function 走らせる(
  止める: 'manifest' | 'image', ポート: number,
): Promise<{ 記録: string[]; 描き直した: boolean; 止めた数: number }> {
  const 名 = `絵${Math.random().toString(36).slice(2, 6)}`;
  const profile = mkdtempSync(join(tmpdir(), 'madoken-art-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${ポート}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  const cdp = new Cdp();
  const 記録: string[] = [];
  let 止めた数 = 0;
  try {
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${ポート}/json/list`)
          .then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
        wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ起動していない */ }
    }
    if (!wsUrl) throw new Error('ブラウザを起動できなかった');
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    cdp.onEvent = (method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const 文 = (params?.args ?? []).map((a: any) => String(a?.value ?? '')).join(' ');
        if (文.includes('[素材]')) 記録.push(文);
        return;
      }
      if (method !== 'Fetch.requestPaused') return;
      const u = String(params?.request?.url ?? '');
      const 対象 = 止める === 'manifest'
        ? u.includes('img/manifest.json')
        // 敵の絵を1枚だけ止める。1枚で全部が止まらないことを見たいので、
        // 止めるのは最初の1件だけにする。
        : (止めた数 === 0 && /\/img\/enemy\/.*\.png/.test(u));
      if (対象) { 止めた数 += 1; return; }        // 握ったまま返さない
      void cdp.send('Fetch.continueRequest', { requestId: params.requestId });
    };
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('magic_web_game_save_v1',${JSON.stringify(JSON.stringify(seedSave(名)))})}catch{}`,
    });
    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(6000);

    // ★ 描き直しが起きたことの証。
    //   loadArtwork() が終われば .then(renderCharPickers) が走るので、
    //   ここで空にしておけば、後で中身が戻っているかどうかで分かる。
    await cdp.evaluate(`(() => {
      const e = document.querySelector('#char-picker');
      if (e) e.innerHTML = '';
      return true;
    })()`);

    // 上限は目録10秒 / 絵15秒。過ぎるまで待つ。
    await sleep(止める === 'manifest' ? 14000 : 19000);

    const 描き直した = await cdp.evaluate<boolean>(
      "(document.querySelector('#char-picker')?.children.length ?? 0) > 0");
    return { 記録, 描き直した, 止めた数 };
  } finally {
    try { await cdp.send('Browser.close'); } catch { /* 閉じ済み */ }
    cdp.close();
    await sleep(800);
    chrome.kill();
  }
}

async function main(): Promise<void> {
  console.log('=== 絵が返ってこない時でも起動が止まらないか ===');
  console.log('  (上限が10秒と15秒あるので1分ほどかかります)');

  console.log('\n-- ① 目録(img/manifest.json)が返ってこない --');
  {
    const r = await 走らせる('manifest', 9502);
    確認(r.止めた数 > 0, '目録の読み込みを止められた', `${r.止めた数}件を保留中`);
    確認(r.描き直した,
      '打ち切って先へ進み、キャラ選択欄が描き直された',
      r.描き直した ? '' : 'loadArtwork() が終わっていない(待ち続けている)');
  }

  console.log('\n-- ② 絵が1枚だけ返ってこない --');
  {
    const r = await 走らせる('image', 9503);
    確認(r.止めた数 > 0, '絵を1枚止められた', `${r.止めた数}枚を保留中`);
    確認(r.描き直した,
      '1枚止まっても残りは読み終わり、キャラ選択欄が描き直された',
      r.描き直した ? '' : 'Promise.all が1枚に引きずられて止まっている');
    const 読んだ = r.記録.find(s => s.includes('画像を'));
    const 諦め = r.記録.find(s => s.includes('読めなかった'));
    確認(!!読んだ, '読めた枚数が記録に出ている', 読んだ ?? '(出ていない)');
    確認(!!諦め, '諦めた枚数も黙らずに記録に出ている',
      諦め ?? '(出ていない。黙って減ると原因が回線か素材か分からない)');
  }

  console.log('');
  if (失敗数 === 0) console.log('すべて合格。絵が読めなくても起動は止まらない。');
  else { console.error(`${失敗数}件 失敗。絵の読み込みで起動が止まる。`); process.exit(1); }
}

void main();

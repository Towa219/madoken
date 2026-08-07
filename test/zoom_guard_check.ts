// 戦闘中のダブルタップ拡大よけを確かめる。
//
// iPhone の実機は動かせないので、拡大そのものは測れない。
// 代わりに「拡大が起きないための条件」が揃っているかを見る:
//
//   ・戦闘中の全要素に touch-action が効いているか(manipulation か none)
//   ・viewport に user-scalable=no が入っているか(アプリ内ブラウザ向け)
//   ・戦闘中に素早い2度目のタップの既定動作が止まるか
//   ・別の場所を叩いた時は止めないか(押し間違いで無反応にならないため)
//   ・間を空けた連打は止めないか
//   ・戦闘中でなければ止めないか(研究室では拡大できてよい)
//   ・魔法ボタンが pointerdown で撃てるか
//     ← 2度目のタップを止めると click が作られなくなる。ここが click のままだと
//        連打の2発目が不発になるので、必ずセットで確かめる。
//
//   npx tsx test/zoom_guard_check.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const HTTP = BASE.replace(/^ws/, 'http');
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9489;

const NAME = `zg${Math.random().toString(36).slice(2, 6)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

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

function seedSave() {
  return {
    version: 1, nickname: NAME, nickToken: `tok_${NAME}`, charId: 0, researchP: 100,
    inventory: {}, spells: [{
      id: 's1', name: '', recipe: { fire: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'],
    discovered: [], slots: 4, maxStage: 6, bestStage: 5,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
    bossRewarded: [], tickets: 0, lastBonusDate: '',
  };
}

// 指を1本、指定した座標で touchstart→touchend する。
// 止められたかどうかは touchend の defaultPrevented で分かる。
const tap = (x: number, y: number) => `
  (() => {
    const el = document.elementFromPoint(${x}, ${y}) || document.body;
    const mk = (type) => {
      const t = new Touch({ identifier: 1, target: el, clientX: ${x}, clientY: ${y} });
      return new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t],
        targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t],
      });
    };
    el.dispatchEvent(mk('touchstart'));
    const end = mk('touchend');
    el.dispatchEvent(end);
    return end.defaultPrevented;
  })()
`;

async function main(): Promise<void> {
  console.log('=== 戦闘中のダブルタップ拡大よけ ===');
  console.log(`対象: ${HTTP}`);

  const profile = mkdtempSync(join(tmpdir(), 'madoken-zg-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=430,900', 'about:blank',
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
    if (!wsUrl) { check('ブラウザの起動', false); return; }
    await cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1',
          ${JSON.stringify(JSON.stringify(seedSave()))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await cdp.send('Page.navigate', { url: HTTP });
    for (let i = 0; i < 60; i++) {
      const here = await cdp.evaluate<string>('location.href');
      if (here && !here.startsWith('about:')
        && await cdp.evaluate<boolean>('document.readyState === "complete"')) break;
      await sleep(250);
    }
    await sleep(4000);

    // ---- 1. viewport ----
    const vp = await cdp.evaluate<string>(
      'document.querySelector("meta[name=viewport]").content');
    check('★viewport に user-scalable=no が入っている',
      vp.includes('user-scalable=no'), vp);

    // ---- 2. 研究室では止めない ----
    const labFirst = await cdp.evaluate<boolean>(tap(200, 300));
    const labSecond = await cdp.evaluate<boolean>(tap(200, 300));
    check('★戦闘中でなければ止めない(研究室)', !labFirst && !labSecond,
      `1回目=${labFirst} 2回目=${labSecond}`);

    // ---- 3. 戦闘を始める ----
    await cdp.evaluate("document.querySelector('#tab-battle').click()");
    await sleep(1200);
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('#stage-select button')]
        .find(x => parseInt(x.textContent, 10) === 3);
      b && b.click();
    })()`);
    await sleep(400);
    await cdp.evaluate("document.querySelector('#btn-solo-go').click()");
    await sleep(5000);
    const inBattle = await cdp.evaluate<boolean>(
      '!document.querySelector("#battle-view").classList.contains("hidden")');
    check('戦闘が始まった', inBattle);

    // ---- 4. touch-action ----
    const ta = await cdp.evaluate<Record<string, number>>(`(() => {
      const seen = {};
      document.querySelectorAll('*').forEach(e => {
        const v = getComputedStyle(e).touchAction;
        seen[v] = (seen[v] || 0) + 1;
      });
      return seen;
    })()`);
    const bad = Object.keys(ta).filter(k => k !== 'manipulation' && k !== 'none');
    check('★戦闘中の全要素に touch-action が効いている', bad.length === 0,
      Object.entries(ta).map(([k, v]) => `${k}:${v}`).join(' / '));

    // ---- 5. 同じ場所を素早く2度 ----
    const first = await cdp.evaluate<boolean>(tap(200, 700));
    const second = await cdp.evaluate<boolean>(tap(205, 703));
    check('1度目は止めない', !first);
    check('★同じ所を素早く2度叩くと止める', second);

    // 3度目は1度目として数え直す(連打を全部殺さない)
    const third = await cdp.evaluate<boolean>(tap(205, 703));
    check('★3度目は止めない(連打を殺さない)', !third);

    // ---- 6. 別の場所なら止めない ----
    await cdp.evaluate(tap(100, 700));
    const far = await cdp.evaluate<boolean>(tap(300, 700));
    check('★離れた所を叩いた時は止めない', !far);

    // ---- 7. 間が空いていれば止めない ----
    await cdp.evaluate(tap(200, 700));
    await sleep(500);
    const slow = await cdp.evaluate<boolean>(tap(200, 700));
    check('★間を空けた2度目は止めない', !slow);

    // ---- 8. 魔法ボタンが pointerdown で撃てる ----
    // 詠唱中は「他の魔法を撃てない」ので、魔法ボタンが全部 disabled になる。
    // これを詠唱が始まった印として使う(詠唱バーは Pixi のキャンバスに
    // 描いていて DOM からは見えない)。
    const ready = await cdp.evaluate<boolean>(
      '!!document.querySelector(".spell-btn") '
      + '&& !document.querySelector(".spell-btn").disabled');
    check('魔法ボタンが押せる状態にある', ready);

    await cdp.evaluate(`document.querySelector('.spell-btn').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))`);
    await sleep(300);
    const casting = await cdp.evaluate<boolean>(
      '!!document.querySelector(".spell-btn")?.disabled');
    check('★click を使わず pointerdown だけで詠唱が始まる', casting);
  } finally {
    cdp.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 消せなくてもよい */ }
  }

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('✗ 例外で失敗:', err); process.exit(1); });

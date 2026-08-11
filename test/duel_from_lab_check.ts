// 研究室タブにいる時に決闘を「受けて立つ」と、戦闘画面へ移るかを確かめる。
//
// ★ #duel-view は #battle-screen の中にある。hidden を外すだけでは、
//   別のタブを開いていると画面ごと隠れていて何も見えない。
//   「研究室のまま戦闘画面に入らない」の再発を止めるための検証。
//
//   npx tsx test/duel_from_lab_check.ts
//
// 2人ぶんのタブを開き、片方が決闘を呼びかけ、
// もう片方は研究室タブのまま「受けて立つ」を押す。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HTTP = process.env.MADOKEN_ENDPOINT ?? 'http://127.0.0.1:2567';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9485;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function seedSave(name: string) {
  return {
    version: 1, nickname: name, nickToken: `tok_${name}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: [{
      id: 's1', name: '', recipe: { fire: 2, earth: 2 }, discoveries: [],
      level: 0, rarity: 'normal', stats: {}, equipCount: 1,
    }],
    equipped: ['s1'], discovered: [], slots: 4, maxStage: 10, bestStage: 10,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

class Tab {
  private sock!: WebSocket;
  private id = 0;
  private wait = new Map<number, (v: any) => void>();

  async open(target: string): Promise<void> {
    this.sock = new WebSocket(target);
    await new Promise<void>(r => { this.sock.onopen = () => r(); });
    this.sock.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined && this.wait.has(m.id)) {
        this.wait.get(m.id)!(m); this.wait.delete(m.id);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const i = ++this.id;
    return new Promise(r => {
      this.wait.set(i, r);
      this.sock.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async ev<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    return r.result?.result?.value as T;
  }

  close(): void { this.sock.close(); }
}

async function newTab(name: string): Promise<Tab> {
  const res = await fetch(
    `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' },
  ).then(r => r.json()) as { webSocketDebuggerUrl: string };
  const t = new Tab();
  await t.open(res.webSocketDebuggerUrl);
  await t.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{
      localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave(name)))});
      localStorage.setItem('madoken_sound_v4', JSON.stringify({bgmVolume:0,sfxVolume:0,muted:true}));
    }catch{}`,
  });
  await t.send('Page.navigate', { url: HTTP });
  await sleep(6000);
  return t;
}

async function main(): Promise<void> {
  console.log('=== 研究室から決闘を受けられるか ===');
  const profile = mkdtempSync(join(tmpdir(), 'duel-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1100,800', 'about:blank',
  ], { stdio: 'ignore' });

  let ng = 0;
  let a: Tab | null = null;
  let b: Tab | null = null;
  try {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { /* まだ */ }
    }
    const tag = Math.random().toString(36).slice(2, 6);
    a = await newTab(`dA${tag}`);
    b = await newTab(`dB${tag}`);

    // B は研究室タブのままにしておく(ここが検証の肝)
    await b.ev('document.querySelector("#tab-lab").click()');
    await sleep(800);
    const beforeTab = await b.ev<boolean>(
      '!document.querySelector("#lab-screen").classList.contains("hidden")');
    console.log(`  受ける側は研究室にいる: ${beforeTab ? 'はい' : 'いいえ'}`);
    if (!beforeTab) ng++;

    // A が決闘を呼びかける
    await a.ev('document.querySelector("#tab-battle").click()');
    await sleep(900);
    await a.ev('document.querySelector("#btn-duel").click()');
    await sleep(3500);

    // B に呼び出しが届いたら「受けて立つ」を押す
    const called = await b.ev<boolean>(
      '!document.querySelector("#duel-call")?.classList.contains("hidden")');
    console.log(`  呼び出しが届いた: ${called ? 'はい' : 'いいえ'}`);
    if (!called) {
      console.log('  (呼び出しが来ないので判定できない)');
      ng++;
    } else {
      await b.ev('document.querySelector("#duel-call-go").click()');
      await sleep(4000);
      const r = await b.ev<string>(`JSON.stringify({
        lab: !document.querySelector('#lab-screen').classList.contains('hidden'),
        battle: !document.querySelector('#battle-screen').classList.contains('hidden'),
        duel: !document.querySelector('#duel-view').classList.contains('hidden'),
        canvas: !!document.querySelector('#duel-canvas canvas'),
      })`);
      const d = JSON.parse(r) as {
        lab: boolean; battle: boolean; duel: boolean; canvas: boolean;
      };
      const checks: [string, boolean][] = [
        ['研究室から出た', !d.lab],
        ['戦闘タブに移った', d.battle],
        ['決闘画面が出ている', d.duel],
        ['決闘の描画が始まっている', d.canvas],
      ];
      for (const [label, ok] of checks) {
        if (!ok) ng++;
        console.log(`  ${ok ? 'OK ' : 'NG '} ${label}`);
      }
    }
  } finally {
    a?.close();
    b?.close();
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 残ってもよい */ }
  }
  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();

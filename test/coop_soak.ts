// 本物のブラウザで本番の共闘に長く居座り、切れるかどうかを見る。
//
//   npx tsx test/coop_soak.ts [人数] [分]
//   MADOKEN_URL=https://madoken.onrender.com npx tsx test/coop_soak.ts 3 8
//
// ★ 素の接続(test/boss_coop_repro.ts)では一度も切れなかった。
//   実際に遊んでいる画面は、描画も音も画像の読み込みも抱えている。
//   条件を本物に寄せないと、出ない不具合は出ないままになる。
//
// ★ 切れたかどうかは端末に残る「切断の記録」から読む(src/droplog.ts)。
//   画面のトーストは数秒で消えるので、後から見に行っても間に合わない。
//
// ★ 本番へ向けた時は名前を必ず片づける。入室で名前が予約され、
//   起動時に魔導値ランキングへも載るので、放っておくと架空の
//   プレイヤーが本物の順位表に居座る(過去にやらかしている)。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTestNames } from './testnames';
import type { TestName } from './testnames';

const PAGE = process.env.MADOKEN_URL ?? 'https://madoken.onrender.com';
const API = PAGE;
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const 人数 = Math.max(1, Math.min(3, Number(process.argv[2] ?? 1)));
const 分 = Math.max(1, Number(process.argv[3] ?? 6));
const ステージ = Number(process.env.STAGE ?? 25);
const SHOTS = join(import.meta.dirname, '..', 'tools', 'shots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const 使った名前: TestName[] = [];

// 深いボスでも即死しないよう、強い魔法を4本持たせる。
// ★ 目的は「長く戦い続けること」。弱いと全滅で終わってしまい、
//   居座る時間が稼げない(ステージ25で18秒で終わった)。
const 魔法 = [
  { id: 's1', name: '', recipe: { fire: 3 }, discoveries: [], level: 9, rarity: 'legend', equipCount: 1 },
  { id: 's2', name: '', recipe: { water: 2, light: 1 }, discoveries: [], level: 9, rarity: 'legend', equipCount: 1 },
  { id: 's3', name: '', recipe: { earth: 2, wind: 1 }, discoveries: [], level: 9, rarity: 'legend', equipCount: 1 },
  { id: 's4', name: '', recipe: { light: 3 }, discoveries: [], level: 9, rarity: 'legend', equipCount: 1 },
];

function seedSave(名: string) {
  return {
    version: 1, nickname: 名, nickToken: `tok_${名}`, charId: 0, researchP: 100,
    inventory: { fire: 9, water: 9, wind: 9, earth: 9, thunder: 9, ice: 9, light: 9, dark: 9 },
    spells: 魔法, equipped: ['s1', 's2', 's3', 's4'],
    discovered: [], slots: 4, maxStage: 50, bestStage: 49,
    bossCleared: [], sortMode: 'order', codexRewarded: false, legendRewarded: false,
  };
}

class 画面 {
  名 = '';
  private sock!: WebSocket;
  private id = 0;
  private 待ち = new Map<number, (v: any) => void>();
  private chrome: any;
  private profile = '';
  readonly 例外: string[] = [];

  async 起こす(port: number, 名: string): Promise<void> {
    this.名 = 名;
    this.profile = mkdtempSync(join(tmpdir(), 'madoken-soak-'));
    this.chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--window-size=1100,900',
      '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { stdio: 'ignore' });

    let ws = '';
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`)
          .then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
        ws = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch { /* まだ */ }
    }
    if (!ws) throw new Error('ブラウザを起動できない');
    this.sock = new WebSocket(ws);
    await new Promise<void>(r => { this.sock.onopen = () => r(); });
    this.sock.onmessage = e => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: any };
      if (m.id !== undefined && this.待ち.has(m.id)) { this.待ち.get(m.id)!(m); this.待ち.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails;
        this.例外.push(String(d?.exception?.description ?? d?.text ?? '例外').slice(0, 180));
      }
    };
    await this.送る('Page.enable');
    await this.送る('Runtime.enable');
    await this.送る('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('magic_web_game_save_v1', ${JSON.stringify(JSON.stringify(seedSave(名)))});
        localStorage.setItem('madoken_sound_v4',
          JSON.stringify({ bgmVolume: 0, sfxVolume: 0, muted: true }));
      } catch {}`,
    });
    await this.送る('Page.navigate', { url: PAGE });
  }

  送る(method: string, params: unknown = {}): Promise<any> {
    const i = ++this.id;
    return new Promise(r => {
      this.待ち.set(i, r);
      this.sock.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async 評価<T>(x: string): Promise<T> {
    const r = await this.送る('Runtime.evaluate',
      { expression: x, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value as T;
  }

  async 撮る(名前: string): Promise<void> {
    const s = await this.送る('Page.captureScreenshot', { format: 'png' });
    if (s.result?.data) {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, `${名前}.png`), Buffer.from(s.result.data, 'base64'));
    }
  }

  片づける(): void {
    try { this.sock.close(); } catch { /* 済み */ }
    try { this.chrome.kill(); } catch { /* 済み */ }
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* 残ってよい */ }
  }
}

async function main(): Promise<void> {
  console.log('=== 本物のブラウザで共闘に居座る ===');
  console.log(`  ${PAGE} / ステージ${ステージ} / ${人数}人 / ${分}分`);

  const 画面たち: 画面[] = [];
  try {
    for (let i = 0; i < 人数; i++) {
      const 名 = `s${Math.random().toString(36).slice(2, 6)}`;
      使った名前.push({ name: 名, token: `tok_${名}` });
      const g = new 画面();
      await g.起こす(9520 + i, 名);
      画面たち.push(g);
      console.log(`  ${i + 1}人目を起こした: ${名}`);
    }
    await sleep(12000);   // 本番は起動と素材の読み込みに時間がかかる

    const 版 = await 画面たち[0].評価<string>(
      '(document.body.textContent.match(/v?0\\.\\d+\\.\\d+/) || ["(読めない)"])[0]');
    console.log(`  版: ${版}`);

    // ---- まずオンラインへ繋ぐ ----
    //
    // ★ ここを飛ばしてはいけない。セーブに名前が入っていても、
    //   「接続する」を押すまでロビーには入らない。飛ばしたまま
    //   部屋を作ろうとしても何も起きず、6分間まるごと空振りした。
    for (const g of 画面たち) {
      await g.評価('document.getElementById("tab-battle").click()');
      await sleep(600);
      await g.評価(`(() => {
        const b = document.getElementById('btn-connect');
        if (b && !b.disabled) b.click();
      })()`);
    }
    let 繋がった = 0;
    for (let i = 0; i < 30 && 繋がった < 画面たち.length; i++) {
      await sleep(1000);
      繋がった = 0;
      for (const g of 画面たち) {
        const ok = await g.評価<boolean>(
          '!document.getElementById("online-lobby")?.classList.contains("hidden")');
        if (ok) 繋がった++;
      }
    }
    console.log(`  ロビーに入れた: ${繋がった}/${画面たち.length}人`);
    if (繋がった < 画面たち.length) throw new Error('ロビーに入れなかった');

    // ---- 部屋を作って全員入る ----
    const 建てる = 画面たち[0];
    await 建てる.評価(`(() => {
      const bs = [...document.querySelectorAll('#stage-select button')];
      const b = bs.find(x => (x.textContent || '').trim().startsWith('${ステージ}'));
      if (b) b.click();
    })()`);
    await sleep(800);
    await 建てる.評価('document.getElementById("btn-create-room").click()');
    await sleep(6000);

    for (let i = 1; i < 画面たち.length; i++) {
      let 入れた = false;
      for (let 試行 = 0; 試行 < 10 && !入れた; 試行++) {
        入れた = await 画面たち[i].評価<boolean>(`(() => {
          const b = [...document.querySelectorAll('#room-list button')]
            .find(x => !x.disabled);
          if (!b) return false;
          b.click(); return true;
        })()`);
        if (!入れた) await sleep(1500);
      }
      console.log(`  ${i + 1}人目 参加: ${入れた ? 'できた' : '部屋が見えない'}`);
      await sleep(2500);
    }

    // ---- 準備完了 → 戦えていることを確かめる ----
    for (const g of 画面たち) {
      await g.評価(`(() => {
        const b = document.getElementById('btn-coop-ready');
        if (b) b.click();
      })()`);
    }
    let 戦えた = false;
    for (let i = 0; i < 40 && !戦えた; i++) {
      await sleep(1000);
      戦えた = await 画面たち[0].評価<boolean>(
        'document.querySelectorAll("#coop-bar .spell-btn").length > 0');
    }
    // ★ 戦えていなければ、そこで止めること。戦っていないまま6分居座っても
    //   「切れなかった」は何の証拠にもならない(一度これで空振りした)。
    if (!戦えた) {
      await 画面たち[0].撮る('coop_soak_failed');
      throw new Error('戦闘が始まらなかった(tools/shots/coop_soak_failed.png を見ること)');
    }
    console.log('  戦闘が始まりました。撃ち続けます…');

    const 終わり = Date.now() + 分 * 60_000;
    let 前回報告 = 0;
    while (Date.now() < 終わり) {
      await sleep(1200);
      for (const g of 画面たち) {
        // 魔法は pointerdown で撃つ。click では何も起きない。
        await g.評価(`(() => {
          const bs = [...document.querySelectorAll('#coop-bar .spell-btn')]
            .filter(b => !b.disabled);
          const b = bs[Math.floor(Math.random() * bs.length)];
          if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        })()`).catch(() => undefined);
      }
      const 経過 = Math.round((Date.now() - (終わり - 分 * 60_000)) / 1000);
      // ★ 戦いが終わっていないかを毎回見る。終わっていることに気づかず
      //   結果画面を眺めたまま「切れなかった」と報告しかけた(実際にやった)。
      const 終了 = await 画面たち[0].評価<string>(`(() => {
        const o = document.getElementById('coop-overlay');
        if (!o || o.classList.contains('hidden')) return '';
        return (o.textContent || '').replace(/\\s+/g, ' ').slice(0, 40);
      })()`);
      if (終了) {
        console.log(`  ${経過}秒  戦いが終わった: 「${終了}」`);
        console.log('     (これ以上居座っても意味が無いので打ち切ります)');
        break;
      }
      if (経過 - 前回報告 >= 30) {
        前回報告 = 経過;
        const 記録 = await 画面たち[0].評価<string>(
          '(localStorage.getItem("madoken_drops_v1") || "")');
        const 段 = await 画面たち[0].評価<string>(
          '(document.querySelector("#coop-enemy-status")?.textContent || "").replace(/\\s+/g," ").slice(0, 46)');
        const 本番 = await fetch(`${API}/api/ping`).then(r => r.json()).catch(() => null);
        console.log(`  ${経過}秒  稼働${本番?.uptime ?? '?'}秒  ${段 || '(HUDなし)'}`
          + `${記録 ? `  ★切断の記録あり` : ''}`);
        if (記録) break;
      }
    }

    // ---- 結果 ----
    console.log('');
    console.log('  --- 切断の記録 ---');
    let 切れた = 0;
    for (const g of 画面たち) {
      const 記録 = await g.評価<string>('(localStorage.getItem("madoken_drops_v1") || "")');
      if (記録) { 切れた++; console.log(`  ${g.名}: ${記録.slice(0, 300)}`); }
      else console.log(`  ${g.名}: 切れていない`);
      if (g.例外.length) {
        console.log(`     画面の例外 ${g.例外.length}件: ${g.例外.slice(0, 2).join(' / ')}`);
      }
    }
    await 画面たち[0].撮る('coop_soak');
    console.log('');
    console.log(切れた > 0
      ? `=> ${切れた}人が切れた。上の code が原因を指す。`
      : '=> 誰も切れなかった。');
  } finally {
    for (const g of 画面たち) g.片づける();
    await sleep(500);
    await releaseTestNames(API, 使った名前);
  }
  await sleep(500);
}

void main();

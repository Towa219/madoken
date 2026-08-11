// 全試験の最後にだけ実行する。これより後に別の試験を実行してはいけない。
// 合言葉なしで実ボス戦へ参加し、卵通知もペット追加も無いことを測る。
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2808';
const 接続先 = 基点.replace(/^http/, 'ws');
const 合言葉 = process.env.ADMIN_KEY ?? 'test1234';
const 識別 = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const 短縮 = 識別.slice(-10);
const 管理名 = `adm${短縮}`; const 無鍵名 = `nok${短縮}`;
const 管理札 = `管理札${識別}`; const 無鍵札 = `無鍵札${識別}`;
const 魔法 = [{ name: '検証用の強い魔弾', recipe: { fire: 1, water: 1, light: 2, dark: 2 }, level: 9, rarity: 'legend' }];
const 無音受信 = ['proj', 'hit', 'ehit', 'eproj', 'phit', 'shield', 'shieldhit', 'heal', 'taunt', 'ward', 'wardhit', 'vigor', 'empower', 'focus', 'seal', 'dot', 'quake', 'stageclear', 'result', 'aborted', 'replaced', 'down', 'revive', 'eaoewarn', 'eaoehit', 'pwait', 'pback', 'mateleft'];
const 待つ = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function 確保(name: string, token: string): Promise<void> {
  await fetch(`${基点}/api/name/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, token }) });
}
async function 数(name: string): Promise<number> {
  const r = await fetch(`${基点}/api/pet/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 合言葉, name }) });
  const d = await r.json() as { pets?: unknown[] }; return d.pets?.length ?? -1;
}
console.log('【3(d)・全試験の最終項目】合言葉なし参加者の実ボス撃破測定');
await 確保(管理名, 管理札); await 確保(無鍵名, 無鍵札);
const 前 = await 数(無鍵名);
const ca = new Client(接続先); const cb = new Client(接続先);
const ra: Room = await ca.create('coop', { name: 管理名, nickToken: 管理札, stage: 5, maxStage: 5, spells: 魔法, adminKey: 合言葉 });
const rb: Room = await cb.joinById(ra.roomId, { name: 無鍵名, nickToken: 無鍵札, maxStage: 5, spells: 魔法 });
for (const 種類 of 無音受信) rb.onMessage(種類, () => { /* 測定対象外の戦闘通知 */ });
for (const 種類 of 無音受信.filter(種類 => 種類 !== 'stageclear')) ra.onMessage(種類, () => { /* 測定対象外の戦闘通知 */ });
let 管理通知 = ''; let 無鍵通知数 = 0; let clear = false;
ra.onMessage('bossegg', (m: { egg?: unknown }) => { 管理通知 = String(m.egg ?? ''); });
rb.onMessage('bossegg', () => { 無鍵通知数++; }); ra.onMessage('stageclear', () => { clear = true; });
ra.send('ready'); rb.send('ready'); const 開始 = Date.now();
const 連射 = setInterval(() => {
  for (const r of [ra, rb]) { const st = r.state as any; const me = st?.players?.get(r.sessionId); if (st?.phase === 'fight' && me?.alive && me.castingIdx === -1) r.send('cast', { idx: 0 }); }
}, 100);
const 期限 = Date.now() + 120_000;
while ((!clear || !管理通知) && Date.now() < 期限) await 待つ(50);
clearInterval(連射); await 待つ(500); const 後 = await 数(無鍵名);
console.log(`実測: 撃破=${clear}、所要=${((Date.now() - 開始) / 1000).toFixed(3)}秒、管理者通知=${管理通知 || 'なし'}、合言葉なし通知数=${無鍵通知数}、合言葉なし所持数=${前}→${後}`);
const 合格 = clear && 管理通知 === 'received' && 無鍵通知数 === 0 && 前 === 0 && 後 === 0;
console.log(`${合格 ? '合格' : '不合格'}: 合言葉なし参加者には卵通知も卵追加もありません。`);
await Promise.all([ra.leave(), rb.leave()]);
console.log('最終項目を完了しました。この後に別のテストは実行していません。');
if (!合格) process.exitCode = 1;

// 共闘(サーバー判定)でも、ペットぶんのMP自然回復が効いているかを測る。
//
//   PORT=2568 ADMIN_KEY=test1234 npm run dev:server   ← 先に起こす
//   PET_TEST_URL=http://localhost:2568 ADMIN_KEY=test1234 \
//     npx tsx test/pet_regen_coop_check.ts
//
// ★ 単騎(test/pet_regen_battle_check.ts)とは道が別。
//   単騎は端末が数え、共闘はサーバーが数える。片方だけ直しても
//   もう片方は素通りするので、両方を測らないと確かめたことにならない。
//
// ★ MPは満タンから始まる。魔法を撃って減らしてから測る。
//   撃たずに測ると上限で頭打ちになり、何を測っても0になる。

import { Client } from 'colyseus.js';
import { PLAYER_MP_REGEN } from '../shared/data';
import { PET_SPECIES, regenOf } from '../shared/pets';
import type { PetSpeciesId } from '../shared/pets';

const 基点 = process.env.PET_TEST_URL ?? 'http://localhost:2568';
const KEY = process.env.ADMIN_KEY ?? 'test1234';
const NAME = `cr${Math.random().toString(36).slice(2, 6)}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let ng = 0;
function 確認(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ng++;
}

const 叩く = (path: string, extra: Record<string, unknown> = {}) =>
  fetch(`${基点}/api/pet/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, name: NAME, token: `tok_${NAME}`, ...extra }),
  }).then(r => r.json() as Promise<Record<string, any>>);

async function main(): Promise<void> {
  console.log('=== 共闘でMP自然回復を測る ===');
  console.log(`  接続先: ${基点} / 自分の自然回復: 毎秒${PLAYER_MP_REGEN}`);

  // ---- 鳥を用意する ----
  //
  // 卵から出る種類は選べないので、何羽か出して回復+2の鳥が居れば
  // それを連れて行く。居なければ+1の鳥で測る(どちらでも配線は見える)。
  //
  // ★ 時間を進めるだけでは孵らない。孵化は「温めた回数」で決まるので、
  //   間隔を空けるために日を進めながら、実際に温める必要がある
  //   (最初これを忘れて、卵のまま「鳥を用意できなかった」で止まった)。
  // ★ 進めすぎないこと。寿命(雛4日+成鳥20日前後+老鳥5日)を越えると
  //   用意したそばから天へ行ってしまう。雛を抜ける6日だけ進める。
  for (let i = 0; i < 5; i++) await 叩く('grant', { stage: (i % 5) + 1 });
  for (let 回 = 0; 回 < 4; 回++) {
    await 叩く('advance', { days: 1 });
    const 手持ち = (await 叩く('list')).pets as { id: string; species: unknown }[] | undefined;
    for (const p of (手持ち ?? []).filter(x => !x.species)) {
      await 叩く('warm', { petId: p.id });
    }
  }
  await 叩く('advance', { days: 6 });   // 雛(4日)を抜けて成鳥にする
  const 一覧 = (await 叩く('list')).pets as { id: string; species: PetSpeciesId }[] | undefined;
  const 孵った = (一覧 ?? []).filter(p => p.species);
  if (孵った.length === 0) {
    console.log('  NG  鳥を用意できなかった(サーバーか合言葉を確認)');
    process.exit(1);
  }
  const 選ぶ = 孵った.slice().sort((a, b) => regenOf(b.species) - regenOf(a.species))[0];
  const 期待回復 = regenOf(選ぶ.species);
  const 期待値 = PLAYER_MP_REGEN + 期待回復;
  await 叩く('choose', { petId: 選ぶ.id });
  console.log(`  連れて行く鳥: ${PET_SPECIES[選ぶ.species].name}`
    + `(MP${PET_SPECIES[選ぶ.species].mp}) → 回復+${期待回復}/秒`);

  // ---- 共闘へ入る ----
  //
  // ★ 名前の印はペットAPIと同じものを使うこと。別の印を作ると
  //   「そのニックネームは既に他の人が使っています」で入室を断られる。
  const 部屋 = await new Client(基点.replace(/^http/, 'ws')).create('coop', {
    name: NAME, nickToken: `tok_${NAME}`, maxStage: 1, stage: 1, charId: 0,
    adminKey: KEY,
    // 消費MPの大きい魔法を1本。撃ってMPを減らすのが目的。
    spells: [{ name: '爆炎', recipe: { fire: 3 }, level: 0, rarity: 'normal' }],
  });

  const 自分を見る = () => (部屋.state as any).players?.get(部屋.sessionId);
  let 自分: any;
  for (let i = 0; i < 40 && !自分; i++) { await sleep(50); 自分 = 自分を見る(); }
  確認('共闘部屋に入れた', !!自分, 自分 ? `MP ${自分.mp}/${自分.maxMp}` : '入れない');
  if (!自分) { process.exit(1); }

  // ---- 戦闘を始める ----
  部屋.send('ready', {});
  let 戦闘中 = false;
  for (let i = 0; i < 120 && !戦闘中; i++) {
    await sleep(100);
    戦闘中 = (部屋.state as any).phase === 'fight';
  }
  確認('戦闘が始まった', 戦闘中, `phase=${(部屋.state as any).phase}`);

  // ---- MPを減らす ----
  for (let i = 0; i < 3; i++) { 部屋.send('cast', { idx: 0 }); await sleep(1200); }
  const 減った = 自分を見る();
  確認('魔法を撃ってMPが満タンより減った', 減った.mp < 減った.maxMp - 5,
    `MP ${Math.round(減った.mp)}/${減った.maxMp}`);

  // ---- 戻り方を測る ----
  //
  // ★ 2点だけ取って割らないこと。毎秒7〜8で戻るので、少し目を離すと
  //   上限に張り付いて傾きが0に見える。細かく刻んで、上限に達する前の
  //   区間だけを使う(単騎の検証で実際にこれに引っかかった)。
  const 標本: [number, number][] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 2600) {
    const p = 自分を見る();
    if (p) 標本.push([(Date.now() - t0) / 1000, p.mp]);
    await sleep(60);
  }
  const 上限 = 自分を見る().maxMp;
  const 使える = 標本.filter(([, mp]) => mp < 上限 - 1);
  確認('上限に達する前の標本が取れている', 使える.length >= 8,
    `${使える.length}点 / 全${標本.length}点`);

  const 傾き = (pts: [number, number][]): number => {
    const n = pts.length;
    const sx = pts.reduce((s, p) => s + p[0], 0);
    const sy = pts.reduce((s, p) => s + p[1], 0);
    const sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
    const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0);
    return (n * sxy - sx * sy) / (n * sxx - sx * sx);
  };
  const 実測 = 使える.length >= 8 ? 傾き(使える) : 0;
  確認('サーバー側でも毎秒 6+鳥ぶん だけ戻っている',
    使える.length >= 8 && Math.abs(実測 - 期待値) < 0.8,
    `実測 毎秒${実測.toFixed(2)} / 期待 毎秒${期待値}(鳥なしなら毎秒${PLAYER_MP_REGEN})`);

  await 部屋.leave();
  console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件 失敗 ===`);
  process.exit(ng === 0 ? 0 : 1);
}

void main();

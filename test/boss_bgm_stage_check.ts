// ボス戦の曲が、深さに応じて3曲に分かれているかを確かめる。
//
// 同じ曲が50ステージ続くと、せっかくのボス戦がただの作業に聞こえる。
//   ステージ5・10        … 5-10_Battle01
//   ステージ15・20       … 15-20_Flame-Titan
//   ステージ25以降       … 25_Battle03_2loop
//
// 見るのは
//   ・どのボスステージがどの曲になるか(境目を1つずつ)
//   ・その名前が manifest.json に登録されているか
//   ・実際に音源のファイルが置いてあるか(名前だけ合っていても鳴らない)
//
//   npx tsx test/boss_bgm_stage_check.ts

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bossBgmFor, BOSSES, isBossStage } from '../shared/data';

const ROOT = join(import.meta.dirname, '..');
const SOUND = join(ROOT, 'public', 'sound');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  NG '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// [ステージ, 期待する曲]
const WANT: [number, string][] = [
  [5, 'boss1'], [10, 'boss1'],
  [15, 'boss2'], [20, 'boss2'],
  [25, 'boss3'], [30, 'boss3'], [50, 'boss3'],
];

function main(): void {
  console.log('=== ボス戦の曲(深さで切り替わる) ===');

  for (const [stage, want] of WANT) {
    const got = bossBgmFor(stage);
    check(`ステージ${stage} → ${want}`, got === want, got);
  }

  // 境目の外側。11〜14 はボスのステージではないが、
  // 万一ここが呼ばれても2曲目側に寄せておく(切り替えの意図どおり)。
  check('11は2曲目側(境目の内訳が入れ替わっていない)', bossBgmFor(11) === 'boss2');
  check('21は3曲目側', bossBgmFor(21) === 'boss3');

  const manifest = JSON.parse(
    readFileSync(join(SOUND, 'manifest.json'), 'utf8'),
  ) as { bgm?: Record<string, string> };
  const bgm = manifest.bgm ?? {};

  for (const id of ['boss1', 'boss2', 'boss3'] as const) {
    const file = bgm[id];
    check(`${id} が manifest.json にある`, typeof file === 'string' && file.length > 0,
      file ?? 'なし');
    if (!file) continue;
    const path = join(SOUND, file);
    const ok = existsSync(path);
    check(`${id} の音源が置いてある`, ok,
      ok ? `${file}  ${(statSync(path).size / 1048576).toFixed(1)}MB` : `${file} が無い`);
  }

  // ボス戦で鳴らす曲は、全ボスぶん必ずどれかに割り当たること
  const bossStages = BOSSES.map((_, i) => (i + 1) * 5).filter(isBossStage);
  const unmapped = bossStages.filter(s => !bgm[bossBgmFor(s)]);
  check('★どのボスステージにも曲が当たっている', unmapped.length === 0,
    unmapped.length === 0
      ? `${bossStages.length}体ぶん` : `曲が無い: ステージ${unmapped.join('・')}`);

  console.log(failures === 0 ? '\n=== 合格 ===' : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

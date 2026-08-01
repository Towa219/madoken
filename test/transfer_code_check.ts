// 「ニックネーム / 引き継ぎコード」の貼り付け解釈を確認する
import { parseTransferCode } from '../src/cloudsave';

const cases: [string, boolean][] = [
  ['ゆりパパ / nt_m7k2p1_a8f3d9c2e1', true],
  ['ゆりパパ/nt_m7k2p1_a8f3d9c2e1', true],
  ['  ゆりパパ　／　nt_m7k2p1_a8f3d9c2e1  ', true], // 全角スラッシュ・前後の空白
  ['nt_only_code', false],                          // 区切りが無い
  ['', false],
];

let ng = 0;
for (const [input, expectOk] of cases) {
  const r = parseTransferCode(input);
  const ok = !r.error;
  console.log(`${ok === expectOk ? 'OK ' : '✗ '} ${JSON.stringify(input)} → `
    + (ok ? `名前="${r.name}" コード="${r.token}"` : r.error));
  if (ok !== expectOk) ng++;
}
console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件の不具合 ===`);
if (ng > 0) process.exit(1);

// shared/version.ts の BUILD_DATE を、ビルドした時刻で書き換える。
//
// 手で書いていた頃に実際の時刻とずれていたため、自動化した。
// VERSION は触らない(こちらは意図して上げるもの)。
//
// 時刻は必ず日本時間で入れる。Render のサーバーはUTCで動くので、
// そのまま Date を使うと配信時刻が9時間ずれて表示される。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', 'shared', 'version.ts');

function nowInTokyo() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const stamp = nowInTokyo();
const src = readFileSync(file, 'utf-8');
const line = /export const BUILD_DATE = '[^']*';/;

// 「書き換わったか」ではなく「行が見つかったか」で判定する。
// 同じ分のうちに再ビルドすると値が変わらないため、内容比較では誤検知する。
if (!line.test(src)) {
  console.error('BUILD_DATE の行が見つからない。shared/version.ts を確認すること。');
  process.exit(1);
}

const next = src.replace(line, `export const BUILD_DATE = '${stamp}';`);
if (next !== src) writeFileSync(file, next, 'utf-8');
console.log(`BUILD_DATE = ${stamp}(日本時間)`);

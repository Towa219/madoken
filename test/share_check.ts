// 共有文とリンクの組み立てを確認する(ブラウザなしで検証)
import { SITE_URL, SUPPORT_URL } from '../shared/links';

const enc = encodeURIComponent;
const text = [
  '魔導研究記《まどけん》で魔法を発明中!',
  '戦闘力420 / 12系統を発見 / 最高ステージ7',
  'エレメントを混ぜて自分だけの魔法を作るWebゲーム。オンライン共闘もできる。',
].join('\n');

const links = {
  X: `https://x.com/intent/post?text=${enc(text)}&url=${enc(SITE_URL)}&hashtags=魔導研究記`,
  LINE: `https://social-plugins.line.me/lineit/share?url=${enc(SITE_URL)}&text=${enc(text)}`,
  Facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(SITE_URL)}`,
};

let ng = 0;
console.log('--- 共有文 ---');
console.log(text);
console.log(`${SITE_URL}\n`);

console.log('--- 共有リンク ---');
for (const [name, href] of Object.entries(links)) {
  let ok = false;
  try {
    const u = new URL(href);
    ok = u.protocol === 'https:' && href.includes(enc(SITE_URL));
  } catch { ok = false; }
  console.log(`${ok ? '✓' : '✗'} ${name}: ${href.slice(0, 90)}…`);
  if (!ok) ng++;
}

console.log('\n--- 支援リンク ---');
if (!SUPPORT_URL) {
  console.log('未設定のため「支援」欄は非表示(shared/links.ts の SUPPORT_URL を入れると出る)');
} else {
  try {
    const u = new URL(SUPPORT_URL);
    console.log(`${u.protocol === 'https:' ? '✓' : '✗'} ${SUPPORT_URL}`);
    if (u.protocol !== 'https:') ng++;
  } catch {
    console.log(`✗ SUPPORT_URL が不正: ${SUPPORT_URL}`);
    ng++;
  }
}

console.log(ng === 0 ? '=== 合格 ===' : `=== ${ng}件の不具合 ===`);
if (ng > 0) process.exit(1);

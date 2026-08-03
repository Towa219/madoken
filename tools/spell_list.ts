// 調合で作れる魔法の全一覧を書き出す(Excel用の元データ)。
//
// エレメント6個以内で作れる組み合わせをすべて総当たりし、
// 出来上がる魔法の性能を JSON にする。Excelへの変換は
// tools/spell_list_xlsx.py が受け持つ。
//
//   npx tsx tools/spell_list.ts
//
// 出力: tools/spell_list.json
//
// 強化レベル0・品質「通常」での値。強化すると威力が上がり、
// 再使用時間と消費MPが下がるが、組み合わせの優劣は変わらないので
// 比較にはこの状態が使いやすい。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeSpell, finalStats, spellCooldown, spellMagicValue, statsSummary,
} from '../shared/spellcraft';
import { ELEMENTS, ELEMENT_ORDER, RECIPES } from '../shared/data';
import type { ElementCounts, ElementId } from '../shared/types';

const KIND_JA: Record<string, string> = {
  attack: '攻撃', shield: '護盾', heal: '回復', taunt: '挑発', ward: '護符',
  vigor: '活力', seal: '封印', empower: '闘気', focus: '瞑想',
};

// 6個以内・2個以上のすべての組み合わせ
const all: ElementCounts[] = [];
const cur: ElementCounts = {};
const walk = (i: number, left: number): void => {
  if (i === ELEMENT_ORDER.length) { if (6 - left >= 2) all.push({ ...cur }); return; }
  const id = ELEMENT_ORDER[i];
  for (let k = 0; k <= left; k++) {
    if (k === 0) delete cur[id]; else cur[id] = k;
    walk(i + 1, left - k);
  }
  delete cur[id];
};
walk(0, 6);

// 並びは「使用エレメント順」。
// 火の数 → 水の数 → … と ELEMENT_ORDER の順に見て、多い方を先にする。
// こうすると火だけの魔法、火を多く使う魔法、と自然にまとまる。
all.sort((a, b) => {
  for (const id of ELEMENT_ORDER) {
    const d = (b[id] ?? 0) - (a[id] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
});

const rows = all.map(c => {
  const s = finalStats(c, 0);
  const { matched, autoName } = computeSpell(c);
  const counts: Record<string, number> = {};
  for (const id of ELEMENT_ORDER) counts[ELEMENTS[id].name] = c[id] ?? 0;
  const used = ELEMENT_ORDER.filter(id => (c[id] ?? 0) > 0);

  return {
    構成: used.map(id => ELEMENTS[id].name + ((c[id] ?? 0) > 1 ? String(c[id]) : '')).join(''),
    素材数: used.reduce((a, id) => a + (c[id] ?? 0), 0),
    種類数: used.length,
    ...counts,
    魔法名: autoName,
    系統: matched.map(r => r.name).join(' / ') || '(なし)',
    種類: KIND_JA[s.kind] ?? s.kind,
    属性: ELEMENTS[s.attr].name,
    魔導値: spellMagicValue(s),
    威力: s.power,
    詠唱秒: s.castTime,
    消費MP: s.manaCost,
    再使用秒: Math.round(spellCooldown(s) * 10) / 10,
    弾速: s.projSpeed,
    会心率: s.critRate,
    全体対象: s.targetAll ? '○' : '',
    自傷: s.selfDamage,
    効果: statsSummary(s),
  };
});

const out = join(import.meta.dirname, 'spell_list.json');
writeFileSync(out, JSON.stringify({
  作成日: new Date().toISOString().slice(0, 10),
  条件: '強化レベル0・品質「通常」・エレメント6個以内',
  系統数: RECIPES.length,
  件数: rows.length,
  rows,
}, null, 1), 'utf8');
console.log(`${out}  ${rows.length}件`);

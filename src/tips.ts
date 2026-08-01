// 本日のTips(日替わりで流れる一言)
//
// 「世界には〇〇という強力な魔法が存在するというが…」のように、
// 未知の魔法への興味をかき立てる話題を毎日1つ選んで流す。
// 日付から決まるので、同じ日に開けば誰が見ても同じ話題になる。

import {
  ELEMENTS, ELEMENT_ORDER, GATHER_COST, RARITIES, RECIPES,
  LIBRARY_BONUS_START, SLOT4_BOSS_STAGE,
} from '../shared/data';
import { ENHANCE_MAX, trueName } from '../shared/spellcraft';
import type { ElementCounts, ElementId } from '../shared/types';

// 日付から安定した数値を作る
function seedOf(dateKey: string): number {
  let h = 2166136261;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// その日の「幻の魔法」の構成を作る(実在しうる構成から)
function legendaryComposition(seed: number): ElementCounts {
  const counts: ElementCounts = {};
  const total = 3 + (seed % 3); // 3〜5素材
  for (let i = 0; i < total; i++) {
    const id = ELEMENT_ORDER[(seed >> (i * 3)) % ELEMENT_ORDER.length] as ElementId;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function compTag(counts: ElementCounts): string {
  return ELEMENT_ORDER
    .filter(id => (counts[id] ?? 0) > 0)
    .map(id => `${ELEMENTS[id].name}${(counts[id] ?? 0) > 1 ? counts[id] : ''}`)
    .join('と');
}

// その日のTipsを1つ返す
export function todaysTip(now: Date = new Date()): string {
  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const seed = seedOf(dateKey);

  const counts = legendaryComposition(seed);
  const legend = trueName(counts, 'legend') ?? 'エターナル';
  const epic = trueName(legendaryComposition(seed >> 5), 'epic') ?? 'イグニス';
  const recipe = RECIPES[seed % RECIPES.length];
  const elem = ELEMENTS[ELEMENT_ORDER[(seed >> 11) % ELEMENT_ORDER.length]];

  // 未知の魔法への興味をかき立てる話題(こちらを多めに出す)
  const legends: string[] = [
    `世界には「${legend}」という強力な魔法が存在するというが、それを見た者はまだ誰もいない…`,
    `古い研究書に「${epic}」の名が残っている。${RARITIES.epic.name}級の力を宿すという…`,
    `ある研究者は${compTag(counts)}を混ぜた瞬間、部屋ごと消し飛んだと伝えられる…`,
    `「${legend}」を求めて${ELEMENTS.dark.name}に手を出した研究者は、二度と戻らなかった…`,
    // ヒントの括弧内(具体的な配合)は伏せて、詩の部分だけを流す
    `未知の系統「${recipe.name}」は、${recipe.hint.replace(/\s*\(.*\)\s*$/, '')}という言い伝えがある…`,
    `${elem.name}のエレメントは${elem.desc}。組み合わせ次第で化けるという…`,
    `${RARITIES.legend.name}級の魔法は${compTag(counts)}の均衡から生まれる、と語る老魔導士がいた…`,
    `名も無き研究者の手記: 「あと一つ、あと一つ素材が違えば、あの魔法に届いたのだ」…`,
    `全ての系統を発見した者には、${RARITIES.epic.name}級の魔法が贈られるという…`,
    `伝説の「${epic}」は一度だけ世に現れ、そして誰の手にも渡らなかった…`,
  ];

  // 実用的な助言
  const advices: string[] = [
    `魔導書に${LIBRARY_BONUS_START}種を超える魔法を収めた研究者にだけ、上位品質の扉が開くという…`,
    `同じ構成を重ねて調合すれば魔法は育つ。極めた者は+${ENHANCE_MAX}の域に至るという…`,
    `採取に必要な研究P${GATHER_COST}を惜しむな。素材なくして発見なし…`,
    `ステージ${SLOT4_BOSS_STAGE}のボスを討った者だけが、第4の調合スロットを手にする…`,
    `闇のエレメントは強大な威力と引き換えに術者自身を蝕む。扱うには覚悟が要る…`,
    `水を混ぜた魔法は燃費が良い。長期戦を制するのは、いつも息の続く者だ…`,
    `敵の攻撃属性に合わせた護符を張れば、格上にも耐えられるという…`,
    `ヘイトを操る者がいれば、共闘は驚くほど安定する。挑発は臆病者の術ではない…`,
    `継続ダメージは地味だが、硬い相手ほど効く。腐蝕と延焼を侮るな…`,
  ];

  // 5日のうち3日は「幻の魔法」の話題にする。
  // 連日で同じ文が続かないよう、選ぶ桁は判定とは別のところから取る。
  const pick = Math.floor(seed / 11);
  return (seed % 5) < 3
    ? legends[pick % legends.length]
    : advices[pick % advices.length];
}

// 画面上部の流れる帯を作る
export function renderTips(): void {
  const bar = document.querySelector('#tips-bar');
  if (!bar) return;
  const text = `📜 本日のTips ─ ${todaysTip()}`;
  // 同じ文を2つ並べて途切れずに流れるようにする
  bar.innerHTML =
    `<div class="tips-track"><span>${text}</span><span>${text}</span></div>`;
}

// はじめの案内(「この世界でやること」)
//
// 初回起動の名前を決める画面と、説明書の冒頭で同じことを伝える。
// 2か所に書くと必ず食い違うので、要になる一文と手順はここ1か所から配る。
//
// 初回の画面では長い説明は読まれない。
// 「何をするゲームなのか」が一目で分かる長さに抑えること。

export const INTRO_LEAD =
  'あなたは魔法研究者です。<b>エレメントを調合して自分だけの魔法を作り</b>、'
  + 'それを装備して戦い、素材を集めてさらに強い魔法を研究します。'
  + '用意された魔法を覚えるのではなく、<b>魔法そのものを発明していく</b>のが'
  + 'このゲームの中心です。';

export const INTRO_STEPS: { icon: string; text: string }[] = [
  { icon: '⚗', text: '<b>研究室</b>で採取して、エレメントを<b>調合</b>し魔法を作る' },
  { icon: '📖', text: '<b>魔導書</b>で装備する(番号がそのまま戦闘のキーになる)' },
  { icon: '⚔', text: '<b>戦闘</b>で戦い、研究Pと素材を得る(ボスは共闘部屋から)' },
  { icon: '🔁', text: 'より深い調合へ ― の繰り返し' },
];

// 初回起動の画面に出す短い案内
export function introHtml(): string {
  const steps = INTRO_STEPS
    .map(s => `<li><span class="intro-icon">${s.icon}</span>${s.text}</li>`)
    .join('');
  return `<h3>この世界でやること</h3><p>${INTRO_LEAD}</p><ol class="intro-steps">${steps}</ol>`;
}

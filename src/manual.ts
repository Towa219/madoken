// 説明書(取説+攻略)
//
// 数値や系統一覧は shared/data.ts の定義から組み立てるので、
// バランスを変更すれば説明書の記述も自動的に追従する。

import {
  battleRP, DEFEAT_RP_RATE,
  DISASSEMBLE_RATE, DISCOVERY_BONUS_RP, ELEMENTS, ELEMENT_ORDER, ENEMIES,
  ENEMY_HP_MUL, BOSSES, DUEL_MAX_HP, GATHER_COST, GATHER_COUNT,
  LIBRARY_BONUS_FULL_KINDS, LIBRARY_BONUS_MAX, LIBRARY_BONUS_PER_KIND,
  LIBRARY_BONUS_START, libraryBonus,
  PLAYER_MAX_HP, PLAYER_MAX_MP, RARITIES, RECIPES,
  SLOT3_COST, SLOT4_BOSS_STAGE, SLOT4_COST, SLOT5_BOSS_STAGE, SLOT5_COST,
  START_SLOTS, TRANSMUTE_COST,
} from '../shared/data';
import { ENHANCE_MAX } from '../shared/spellcraft';
import { NICK_MAX_FULL, NICK_MAX_WIDTH } from '../shared/nickname';
import type { Rarity } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function elementTable(): string {
  const rows = ELEMENT_ORDER.map(id => {
    const e = ELEMENTS[id];
    return `<tr><td style="color:${e.cssColor}">${e.name}</td><td>${e.desc}</td></tr>`;
  }).join('');
  return `<table class="man-table"><thead><tr><th>エレメント</th><th>1個あたりの効果</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
}

function rarityTable(): string {
  const order: Rarity[] = ['rare', 'epic', 'legend'];
  const rows = order.map(r => {
    const d = RARITIES[r];
    return `<tr><td style="color:${d.cssColor}">${d.name}</td>`
      + `<td>性能 ×${d.mul}</td>`
      + `<td>基礎 ${(d.chance * 100).toFixed(2)}%</td>`
      + `<td>最大 ${(d.chance * LIBRARY_BONUS_MAX * 100).toFixed(2)}%`
      + `<small>(蔵書ボーナスのみ)</small></td></tr>`;
  }).join('');
  return `<table class="man-table"><thead><tr><th>品質</th><th>効果</th>`
    + `<th>出現率</th><th>蔵書上限時</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
}

export function renderManual(): void {
  $('#manual-body').innerHTML = `
<section class="man-sec">
  <h3>この世界でやること</h3>
  <p>あなたは魔法研究者です。<b>エレメントを調合して自分だけの魔法を作り</b>、
  それを装備して戦い、素材を集めてさらに強い魔法を研究します。
  用意された魔法を覚えるのではなく、<b>魔法そのものを発明していく</b>のがこのゲームの中心です。</p>
  <ol>
    <li><b>研究室</b>で採取・調合して魔法を作る</li>
    <li><b>魔導書</b>で最大4つ装備する(★印)</li>
    <li><b>戦闘</b>や<b>オンライン共闘</b>で戦い、研究Pと素材を得る</li>
    <li>より深い調合へ ― の繰り返し</li>
  </ol>
</section>

<section class="man-sec">
  <h3>エレメント</h3>
  <p>全${ELEMENT_ORDER.length}種類。組み合わせと個数で魔法の性能が決まります。</p>
  ${elementTable()}
  <p class="man-note">入手方法は3つだけです。<br>
  ① <b>採取</b>(研究P${GATHER_COST}でランダム${GATHER_COUNT}個。光・闇は出にくい)<br>
  ② <b>ボス撃破</b>(共闘のみ。まとまった数が手に入る)<br>
  ③ <b>魔法の分解</b>(素材1個につき約${Math.round(DISASSEMBLE_RATE * 100)}%で回収。強化・品質が高いほど戻りやすい)<br>
  通常ステージのクリアでは素材は手に入らず、研究Pだけが増えます。</p>
  <p class="man-note">総数は増えませんが、<b>錬成</b>で偏りを直せます。
  余った素材${TRANSMUTE_COST}個がランダムな1個に変わり、研究Pはかかりません。
  使うのは手持ちが最も多い種類で、<b>使った種類以外</b>が出ます。
  貴重な光・闇は、他の素材が尽きるまで使われません。</p>
</section>

<section class="man-sec">
  <h3>調合のしくみ</h3>
  <ul>
    <li>スロットにエレメントを置いて「調合する」。バーが100%になると完成します</li>
    <li><b>成功率</b>は素材が多いほど、光・闇を使うほど下がります(下限40%)。失敗すると素材の半分を失います</li>
    <li>特定の組み合わせで<b>系統</b>が成立します。初めて出した系統は「発見」となり研究P+${DISCOVERY_BONUS_RP}</li>
    <li><b>同じ構成をもう一度調合すると強化</b>になります(最大+${ENHANCE_MAX}。1段階ごとに威力+8%・詠唱-2%)</li>
    <li>ごく稀に上位<b>品質</b>で生まれます。素材が多く光・闇を含むほど確率が上がります</li>
    <li><b>魔導書に集めた魔法の「種類」が多いほど上位品質が出やすくなります</b>。
    ただし<b>${LIBRARY_BONUS_START}種類まではボーナス無し</b>で、
    そこを超えた分だけ1種類ごとに+${Math.round(LIBRARY_BONUS_PER_KIND * 100)}%、
    <b>${LIBRARY_BONUS_FULL_KINDS}種類で上限×${LIBRARY_BONUS_MAX}</b>に達します
    (レシピが違えば別の種類として数えます)</li>
  </ul>
  ${rarityTable()}
  <p class="man-note">実際の確率は<b>素材構成のボーナス</b>も掛かるため上表よりさらに上がります。
  今の自分の確率は<b>調合画面</b>に表示されます。</p>
  <p class="man-note">魔法名の末尾〈火2風〉はレシピそのものです。名前を見れば作り方が分かります。</p>
</section>

<section class="man-sec">
  <h3>系統(隠しレシピ)</h3>
  <p>特定の組み合わせで成立する<b>系統</b>が全${RECIPES.length}種類あります。
  一覧・ヒント・発見状況は<b>「発見図鑑」タブ</b>で確認してください。</p>
  <p class="man-note">🎁 <b>全${RECIPES.length}系統を発見すると</b>、その証として
  <b style="color:${RARITIES.epic.cssColor}">【${RARITIES.epic.name}】</b>品質の魔法(性能×${RARITIES.epic.mul})が
  ランダムな系統で1つ贈られます(1回きり)。素材は消費しません。</p>
</section>

<section class="man-sec">
  <h3>戦闘</h3>
  <ul>
    <li>3→2→1のカウントダウン後に開始。キー<b>1〜4</b>かボタンで詠唱します(順番は魔導書の並び順)</li>
    <li>自分はHP${PLAYER_MAX_HP} / MP${PLAYER_MAX_MP}。MPは毎秒3回復するので、撃ち続けると息切れします</li>
    <li>敵には<b>5段階の属性相性</b>があります: ◎2.0倍 / ○1.5倍 / −等倍 / △0.6倍 / ✕0.25倍</li>
    <li>敵カードの<b>攻撃属性</b>を見て、その属性の耐性(護符)を張ると被害を抑えられます</li>
    <li>敵は通常${ENEMIES.length}種+ボス${BOSSES.length}種。ステージが上がるほど強い種類が出ます(敵HPは基礎の${ENEMY_HP_MUL}倍から、さらにステージ補正)</li>
    <li>研究Pは<b>勝利で満額</b>(ステージ1で${battleRP(1, true)}、上がるほど増加。ボスは+25)、
    <b>敗北でも${Math.round(DEFEAT_RP_RATE * 100)}%</b>(ステージ1で${battleRP(1, false)})もらえます。
    ただし<b>撤退すると0</b>です ― 逃げるより、最後まで戦ったほうが研究は進みます</li>
    <li>素材が尽きて研究Pも足りなくなった場合だけ、<b>採取が1回無料</b>になります(詰み防止)</li>
  </ul>
</section>

<section class="man-sec">
  <h3>オンライン</h3>
  <ul>
    <li><b>共闘</b>は最大3人。全員が準備完了で開始し、<b>クリアすると自動で次のステージへ</b>進み続けます</li>
    <li>誰かが倒れても、ステージを越えればHP50%で復活します。<b>全滅すると終了</b>です</li>
    <li>戦闘中に誰かが退出すると、前のステージまでのクリア扱いで全員ロビーに戻ります</li>
    <li><b>ボス戦(5の倍数)はオンラインの共闘部屋から</b>挑みます。<b>1人でも挑戦できます</b>が、仲間がいるほど楽になります</li>
    <li><b>決闘</b>は1対1。HP${DUEL_MAX_HP}で、挑発は「構え」(被弾-20%)として働きます</li>
    <li><b>ランキング</b>はニックネームごとに自己ベスト1件。スコア = クリアステージ×10 + 与ダメージ÷20</li>
    <li>ニックネームは初回接続時に登録され、<b>初期化するまで変更できません</b>。
    全角${NICK_MAX_FULL}文字(半角${NICK_MAX_WIDTH}文字)まで・
    使えるのは<b>ひらがな/カタカナ/漢字/英数字</b>だけで、
    <b>スペースと記号は半角・全角とも使用不可</b>・
    <b>他の人が使用中の名前は登録できません</b>(初期化すると解放され、他の人が使えるようになります)</li>
  </ul>
</section>

<section class="man-sec">
  <h3>セーブと引き継ぎ</h3>
  <ul>
    <li>セーブは<b>遊んでいる端末</b>に自動保存されます</li>
    <li>オンラインに接続してニックネームを登録すると、<b>サーバーにも自動で保存</b>されます</li>
    <li>別の端末で続きから遊ぶには、<b>「⚙ 設定」タブ</b>の<b>引き継ぎコード</b>を
    その端末の「別の端末から引き継ぐ」欄に、ニックネームと一緒に入力します</li>
    <li>引き継ぎコードは<b>パスワードと同じ</b>です。他人に教えないでください</li>
    <li><b>「⚙ 設定」タブの初期化</b>を行うと、サーバー側のセーブとランキングの記録も消え、
    そのニックネームは他の人が使えるようになります</li>
  </ul>
</section>

<section class="man-sec">
  <h3>調合スロットの解放</h3>
  <p>最初は<b>${START_SLOTS}スロット</b>から始まります。2素材でも系統は成立しますが、
  多くの系統は3素材以上を必要とします。</p>
  <ul>
    <li>第3スロット: <b>研究P${SLOT3_COST}</b>のみ(最初の目標)</li>
    <li>第4スロット: <b>ステージ${SLOT4_BOSS_STAGE}のボス撃破</b> + 研究P${SLOT4_COST}</li>
    <li>第5スロット: <b>ステージ${SLOT5_BOSS_STAGE}のボス撃破</b> + 研究P${SLOT5_COST}</li>
  </ul>
  <p class="man-note">スロットが増えるほど複雑な系統に手が届きますが、成功率は下がります。</p>
</section>

<section class="man-sec">
  <h3>攻略のコツ</h3>
  <ul>
    <li><b>まずは第3スロット(研究P${SLOT3_COST})を目指す。</b>2素材だけでは作れる系統が限られます</li>
    <li><b>安い魔法を数撃つ。</b>成功率100%の構成で系統を発見していくのが序盤の近道です</li>
    <li><b>水を混ぜると燃費が良くなります。</b>火や闇だけで固めるとMPが持ちません。「主砲1本+燃費の良い1本」の組み合わせが安定します</li>
    <li><b>使わない魔法は分解を。</b>素材が貴重なので、外れた魔法は抱えず分解して次の調合に回すのが効率的です</li>
    <li><b>強化はレシピを覚えている魔法に集中投資。</b>同じ構成を作り続ければ+${ENHANCE_MAX}まで伸び、魔導値(強さの目安)が大きく上がります</li>
    <li><b>ボスは共闘部屋から。1人でも挑めます</b>が、仲間がいるほど楽です。ステージ${SLOT4_BOSS_STAGE}のボスを倒さないと第4スロットも増えません</li>
    <li><b>共闘は役割分担で伸びます。</b>挑発+護盾で敵を引き受ける人、治癒や鼓舞で支える人、火力に専念する人。敵はヘイト(与ダメ・護盾・回復で増える)が高い人を狙います</li>
    <li><b>格上に挑むときは耐性と継続ダメージ。</b>敵の攻撃属性に合わせた護符で耐え、腐蝕や延焼でじわじわ削ると安定します</li>
    <li><b>行き詰まったら図鑑のヒントを読み直す。</b>未発見の系統は必ず何かの組み合わせで出ます。
    ${RECIPES.length}系統すべて発見すればエピック魔法が手に入るので、図鑑埋めは遠回りに見えて近道です</li>
  </ul>
</section>
`;
}

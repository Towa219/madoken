# -*- coding: utf-8 -*-
"""まどけんの名刺(エーワン 51861・A4 10面)を組む。

    D:/ComfyUI/python_embeded/python.exe tools/meishi/build_meishi.py

出来るもの: tools/meishi/madoken_meishi.html (画像もQRも埋め込み済みの1枚)
ブラウザで開いて「倍率100%・余白なし・背景グラフィックあり」で印刷する。

★ 用紙の寸法(エーワン 51861 / マルチカード 名刺サイズ 10面)
    A4 210×297mm、1面 91×55mm、2列×5段、面と面の間に隙間なし。
    左右の余白 = (210 - 91*2) / 2 = 14mm
    上下の余白 = (297 - 55*5) / 2 = 11mm
  この4つの数字がずれると全部ずれるので、下の定数から動かさないこと。
"""

import base64
import io
import os
import re
import sys

from PIL import Image
import segno

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'tools', 'meishi', 'madoken_meishi.html')
# ハサミ線あり(普通紙に刷って自分で切る用)
OUT_CUT = os.path.join(ROOT, 'tools', 'meishi', 'madoken_meishi_cut.html')

# 配る先はゲーム本体ではなく入口(待機ページ)。
# サーバーが寝ていても説明が出るので、初めての人が驚かない。
URL = 'https://towa219.github.io/madoken/'
URL_SHOW = 'towa219.github.io/madoken/'

# ---- 用紙 ----
CARD_W, CARD_H = 91, 55       # mm
MARGIN_X, MARGIN_Y = 14, 11   # mm
COLS, ROWS = 2, 5

# ---- 印刷のずれ補正(mm) ----
#
# プリンタは紙送りの都合で、刷る位置が数mmずれることがある。
# 用紙そのものは正しくても、これがあるとミシン目と合わない。
#
# 「刷ったものが右に2.5mmずれている」なら X に -2.5 を入れる(左へ動かす)。
# 下にずれているなら Y に負の値。試し刷りで測って決めること。
#
# 一時的に変えて試すなら環境変数でもよい:
#   MEISHI_SHIFT_X=-2.5 MEISHI_SHIFT_Y=0 python tools/meishi/build_meishi.py
# ★ 2026-08-10、ここまでの調整はすべて無効だった。
#   面(名刺)に SHIFT を足し忘れていて、動いていたのはハサミ線だけ。
#   -2.5 → -1.2 → +1.8 → +4.8 と触った値は、線だけを動かしていた。
#   名刺は最初からずっと 14mm の位置にあった。
#
#   したがって当てになる観測は「最初の1回」だけ:
#     倍率100%で刷ったら、名刺がミシン目より 2〜3mm 右にあった
#   → 左へ 2.5mm 戻す。縦は「1mm下げて」の申告どおり +1.0mm。
#
#   次からは、面と線が同じだけ動いていることを必ず実測で確かめる
#   (tools/meishi の scratchpad にある shiftcheck の要領)。
# 面と線が一緒に動くようになってからの実測:
#   -2.5mm → まだ1mmほど左。全体に4mm右へ、との申告
#   +1.5mm → -2.5 から右へ4mm(いまここ)
SHIFT_X = float(os.environ.get('MEISHI_SHIFT_X', '1.5'))
SHIFT_Y = float(os.environ.get('MEISHI_SHIFT_Y', '1.0'))

# ---- 大きさの補正 ----
#
# プリンタによっては、等倍で刷ったつもりでも数%小さく出る。
# 版のほうを少し大きく作って、刷り上がりで実寸になるようにする。
#
# ★ 基準は紙の左上。中央ではない。
#   「上のカット線は合っているのに、下が3mm短い」という出方をした。
#   これは縮みが上端を起点にして下へ溜まっている、ということ。
#   中央を基準に伸ばすと上も動いてしまい、合っていた上までずれる。
#
# ★ 決め方(縦の例)
#   5段ぶんの高さは 55 × 5 = 275mm。下が3mm短いなら実際は272mm。
#   275 / 272 = 1.011 を入れる。
#   横も同じ。2列ぶんは 91 × 2 = 182mm。右が2mm短いなら実際は180mm。
#   182 / 180 = 1.011。縦と同じ値になった(このプリンタは縦横とも約1.1%縮む)。
SCALE_X = float(os.environ.get('MEISHI_SCALE_X', '1.011'))
SCALE_Y = float(os.environ.get('MEISHI_SCALE_Y', '1.011'))


# 8つのエレメントの色。ゲーム本体(shared/data.ts の ELEMENTS)と同じ並び・同じ色。
# 名刺を「青一色」から「遊びの色」に戻すための素。
ELEM_COLORS = [
    ('火', '#ff6644'), ('水', '#44aaff'), ('風', '#66dd99'), ('土', '#cc9955'),
    ('雷', '#ffcc33'), ('氷', '#7fdfff'), ('光', '#ffe98a'), ('闇', '#a97ae6'),
]


def elem_ribbon() -> str:
    """8色の帯。名刺の上端に細く通す。

    「8つのエレメントを調合する遊び」であることを、読む前に色で伝える。
    帯は1.1mmと細いので、10面ぶん刷ってもインクは食わない。
    """
    n = len(ELEM_COLORS)
    segs = []
    for i, (_name, col) in enumerate(ELEM_COLORS):
        segs.append(
            f'<span style="background:{col};flex:1 1 0"></span>')
    return '<span class="ribbon">' + ''.join(segs) + '</span>'


def copyright_text() -> str:
    """著作権表記は shared/version.ts から拾う。

    名刺に手で書き写すと、本体を直した時にここだけ古い年号が残る。
    画面の隅とゲーム内と紙で表記が食い違うのがいちばん恰好がつかない。
    """
    path = os.path.join(ROOT, 'shared', 'version.ts')
    with io.open(path, encoding='utf-8') as f:
        m = re.search(r"COPYRIGHT\s*=\s*'([^']+)'", f.read())
    if not m:
        raise SystemExit('shared/version.ts から COPYRIGHT を読めない')
    return m.group(1)


def title_uri() -> str:
    """題字は画面と同じ絵(public/img/title.svg)をそのまま使う。

    ★ ここで作り直さないこと。名刺だけ古い題字、が起きる。
      題字を直す時は tools/title/build_title.py を走らせてから、
      この build_meishi.py を走らせる。

    10面ぶん貼るので、SVGを直に埋めると同じ id が10組できてしまう。
    data URI の <img> にすれば中身は1つの絵として扱われ、ぶつからない。
    """
    # 紙用の版(濃い青・光なし)。画面用は淡い青と光を持つので、
    # 白い紙に置くと上半分が紙に溶ける。
    path = os.path.join(ROOT, 'tools', 'title', 'title_ink.svg')
    if not os.path.exists(path):
        raise SystemExit('題字が無い。先に tools/title/build_title.py を走らせること')
    with io.open(path, 'rb') as f:
        raw = f.read()
    return 'data:image/svg+xml;base64,' + base64.b64encode(raw).decode('ascii')


def data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


# 名刺に載せる絵。ゲームの絵をそのまま使う(描き足さない)。
#   'idle'   … 手を組んで立っている(4.png)
#   'potion' … 緑の魔法薬を手にしている(4_hurt.png)
# ★ 4_hurt は戦闘では被弾の絵だが、絵柄としては「薬を持って身構える」姿。
#   同じ絵描きの手による絵なので、手と薬の重なりが正しい ―
#   後から別の絵を合成すると、指の前後がおかしくなって嘘になる。
# 既定は idle。potion(薬を持つ姿)も試したが、名刺では不自然だった。
CHARA_POSE = os.environ.get('MEISHI_POSE', 'idle')
POSE_FILE = {'idle': '4.png', 'potion': '4_hurt.png'}


def char_art() -> str:
    """翠緑の薬導士。余白を切り詰めてから埋め込む(名刺では1mmが大きい)。"""
    name = POSE_FILE.get(CHARA_POSE, '4.png')
    im = Image.open(os.path.join(ROOT, 'public', 'img', 'player', name)).convert('RGBA')
    box = im.getbbox()
    if box:
        im = im.crop(box)
    return data_uri(im)


def qr_svg() -> str:
    """QRはベクターで入れる。印刷の解像度に左右されないため。

    誤り訂正はM(15%)。名刺は指で持つので少し汚れても読めるようにする。
    静穏帯(border)は規格どおり4マス。3マスでも手元の読み取りは通ったが、
    規格を下回ると読み取り機によっては渋る ― 紙は刷り直せないので規格に従う。
    """
    q = segno.make(URL, error='m')
    buf = io.BytesIO()   # segno はバイト列で書き出す
    q.save(buf, kind='svg', scale=1, border=4, dark='#10243f', light=None,
           svgclass=None, lineclass=None, xmldecl=False, svgns=True, omitsize=True)
    return buf.getvalue().decode('utf-8')


def cut_svg() -> str:
    """ハサミ線と、実寸を確かめるものさし。普通紙での試し刷り用。

    面と面の境目に細い線を通す。マルチカードのミシン目と同じ位置なので、
    刷った紙を用紙に重ねて光にかざせば、位置が合っているか分かる
    (エーワン用に刷る時は線なしの版を使うこと ― 縁に線が残る)。

    ★ ものさしを入れてある理由
      「印刷したら名刺より小さい」は、ほぼ倍率の設定で起きる。
      刷った紙の上で 100mm を実際に測れば、何%で出たのかが分かり、
      設定のどれが効いているのかを言い当てられる。
    """
    w = MARGIN_X * 2 + CARD_W * COLS
    h = MARGIN_Y * 2 + CARD_H * ROWS
    lines = []
    for c in range(COLS + 1):
        x = MARGIN_X + c * CARD_W
        lines.append(f'<line x1="{x}" y1="{MARGIN_Y}" '
                     f'x2="{x}" y2="{MARGIN_Y + CARD_H * ROWS}"/>')
    for r in range(ROWS + 1):
        y = MARGIN_Y + r * CARD_H
        lines.append(f'<line x1="{MARGIN_X}" y1="{y}" '
                     f'x2="{MARGIN_X + CARD_W * COLS}" y2="{y}"/>')

    # ものさし: 上の余白に 100mm。10mm ごとに目盛り、50mm だけ長く。
    # 紙の上端すれすれは刷れないプリンタがあるので、5mm 下げてある。
    ry = 10.0
    ruler = [f'<line x1="{MARGIN_X}" y1="{ry}" x2="{MARGIN_X + 100}" y2="{ry}"/>']
    for i in range(11):
        x = MARGIN_X + i * 10
        long = 3.2 if i % 5 == 0 else 1.8
        ruler.append(f'<line x1="{x}" y1="{ry}" x2="{x}" y2="{ry - long}"/>')

    return (
        f'<svg class="cut" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">'
        f'<g stroke="#adbccc" stroke-width="0.2" fill="none">' + ''.join(lines) + '</g>'
        f'<g stroke="#1b56a8" stroke-width="0.35" fill="none">' + ''.join(ruler) + '</g>'
        f'<text x="{MARGIN_X + 102}" y="{ry + 0.6}" font-size="3.2" fill="#1b56a8"'
        f' font-family="sans-serif">← ここが 100mm。定規で測って100mmなら実寸</text>'
        f'<text x="{MARGIN_X}" y="{ry + 4.6}" font-size="2.8" fill="#77869e"'
        f' font-family="sans-serif">1面の大きさは 91 × 55mm</text>'
        # ★ この紙がどの補正値で刷られたかを残す。刷り直すたびに
        #   どれがどれだか分からなくなるので、紙自身に書かせる。
        f'<text x="{MARGIN_X + 102}" y="{ry + 4.6}" font-size="2.8" fill="#77869e"'
        f' font-family="sans-serif">ずれ補正 横{SHIFT_X:+.1f}mm / 縦{SHIFT_Y:+.1f}mm'
        f' / 倍率 横×{SCALE_X:.3f} 縦×{SCALE_Y:.3f}</text>'
        '</svg>')


def card_html(art: str, qr: str, cr: str, title: str, ribbon: str) -> str:
    return f'''
  <div class="card">
    <div class="inner">
      {ribbon}
      <div class="head">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#7b5cf0"/>
                <stop offset="1" stop-color="#1b3f8f"/>
              </linearGradient>
            </defs>
            <rect x="2" y="2" width="96" height="96" rx="22" fill="url(#g)"/>
            <g class="ring">
              <circle cx="50" cy="16" r="5.4" fill="#ff7043"/>
              <circle cx="74" cy="26" r="5.4" fill="#4fc3f7"/>
              <circle cx="84" cy="50" r="5.4" fill="#aed581"/>
              <circle cx="74" cy="74" r="5.4" fill="#bcaaa4"/>
              <circle cx="50" cy="84" r="5.4" fill="#ffd54f"/>
              <circle cx="26" cy="74" r="5.4" fill="#b3e5fc"/>
              <circle cx="16" cy="50" r="5.4" fill="#fff59d"/>
              <circle cx="26" cy="26" r="5.4" fill="#9575cd"/>
            </g>
            <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
                  font-family="'Yu Mincho','MS Mincho',serif" font-size="42"
                  font-weight="bold" fill="#ffe9a8">魔</text>
          </svg>
        </span>
        <img class="title" src="{title}" alt="魔導研究記《まどけん》">
      </div>

      <p class="lead">8つのエレメントを調合して、魔法を&quot;発見&quot;する</p>
      <ul class="pts">
        <li>レシピは<b>非公開</b>。組み合わせを試して見つけ出す</li>
        <li>隠された系統は<b>28種</b>。仲間と共闘、研究者と決闘</li>
        <li>スマホでもパソコンでも、<b>ブラウザだけ</b>で遊べます</li>
      </ul>

      <div class="foot">
        <span class="qr">{qr}</span>
        <span class="url">
          <b>{URL_SHOW}</b>
          <i>QRを読むか、このアドレスへ</i>
          <small>{cr}</small>
        </span>
      </div>

      <span class="badge">無料・登録不要</span>
      <img class="chara" src="{art}" alt="翠緑の薬導士">
    </div>
  </div>'''


def build(cut: bool = False) -> None:
    art = char_art()
    qr = qr_svg()
    cr = copyright_text()
    title = title_uri()
    ribbon = elem_ribbon()
    cards = ''.join(card_html(art, qr, cr, title, ribbon)
                    for _ in range(COLS * ROWS))
    out = OUT_CUT if cut else OUT
    kind = 'ハサミ線あり(普通紙用)' if cut else 'エーワン 51861(A4 10面)'

    html = f'''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>魔導研究記 名刺({kind})</title>
<style>
  /* ===== 用紙 ===== */
  @page {{ size: A4; margin: 0; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #55556a; font-family: 'Yu Gothic UI', 'Meiryo', sans-serif; }}

  .sheet {{
    width: 210mm; height: 297mm; position: relative;
    background: #fff; margin: 8mm auto; box-shadow: 0 0 12px #0006;
  }}
  .card {{
    position: absolute; width: {CARD_W}mm; height: {CARD_H}mm; overflow: hidden;
  }}
  /* 面の位置。エーワン 51861 の実寸から出した値 */
'''
    for i in range(COLS * ROWS):
        r, c = divmod(i, COLS)
        # 位置は用紙の実寸そのまま。ここでは補正を足さない。
        #
        # ★ ずらすのは .shift の入れ物ごと1回だけ。
        #   面と線を別々にずらしていた時は、片方だけ動いて食い違い、
        #   さらに両方に足した時は二重に効いて9mmまで飛んだ。
        #   足し算の場所を1か所に限ることでしか防げない。
        html += (f'  .card:nth-child({i + 1}) {{ '
                 f'left: {MARGIN_X + c * CARD_W}mm; '
                 f'top: {MARGIN_Y + r * CARD_H}mm; }}\n')

    html += f'''
  /* ===== 名刺の中身 ===== */
  /*
     紙の端から3mmは何も置かない。マルチカードはミシン目で切り離すので、
     印刷が1mmずれても文字が切れないようにするための逃げ。
  */
  .inner {{
    position: relative; width: 100%; height: 100%;
    padding: 4.2mm 4.5mm 3.6mm;
    /* 下地は紙の白のまま。名刺の面いっぱいに色を敷くと、
       ふちまで刷れないプリンタ(特に下の段)で色が途切れて見える。
       それに10面ぶんのベタ塗りはインクを食うし、紙も波打つ。 */
    background: #ffffff;
    color: #17233f;
  }}

  /* 8エレメントの帯。名刺の上端いっぱいに通す(紙の縁から1mm内側) */
  .ribbon {{
    position: absolute; left: 0; right: 0; top: 0;
    height: 1.1mm; display: flex;
  }}

  .head {{ display: flex; align-items: center; gap: 2.2mm; }}
  .mark {{ width: 9.4mm; height: 9.4mm; flex: 0 0 auto; }}
  .mark svg {{ width: 100%; height: 100%; display: block; }}
  /* 題字は画面と同じ絵。字の輪郭が図形なので、刷っても形が変わらない */
  /* ★ 高さで決めない。右上のバッジに《まどけん》がかかったので、
     入れてよい幅を先に決めて、高さはそれに従わせる。 */
  .title {{ width: 45mm; height: auto; display: block; }}

  .lead {{
    margin-top: 1.4mm; font-size: 2.7mm; font-weight: bold; color: #6b3a17;
    background: linear-gradient(90deg, #fff2e6 0%, #eef6ff 55%, #f3ecff 100%);
    border-left: 0.8mm solid #ff8a3d;
    padding: 1mm 1.6mm; border-radius: 0 1mm 1mm 0;
    width: 53mm;
  }}

  .pts {{ list-style: none; margin-top: 1.4mm; width: 51mm; }}
  .pts li {{
    font-size: 2.35mm; line-height: 1.55; color: #3f4a63;
    padding-left: 2.6mm; position: relative;
  }}
  /* 点はエレメントの色で1つずつ変える。同じ色を並べるより、
     「いろいろある遊び」に見える */
  .pts li::before {{
    content: ''; position: absolute; left: 0.5mm; top: 1.3mm;
    width: 1.3mm; height: 1.3mm; border-radius: 50%; background: #8dc2f0;
  }}
  .pts li:nth-child(1)::before {{ background: #ff6644; }}
  .pts li:nth-child(2)::before {{ background: #ffcc33; }}
  .pts li:nth-child(3)::before {{ background: #66dd99; }}
  .pts b {{ color: #12417a; }}

  /* ===== 足元(QRとURL) ===== */
  .foot {{
    position: absolute; left: 4.5mm; bottom: 3.2mm;
    display: flex; align-items: center; gap: 2mm;
  }}
  /* 静穏帯を規格の4マスにしたぶん1マスが細るので、QR自体を少し大きくして
     1マス0.4mm以上を保つ(14mmのままだと0.378mmまで落ちる)。 */
  .qr {{ width: 17mm; height: 17mm; display: block; }}
  .qr svg {{ width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }}
  .url b {{
    display: block; font-size: 2.9mm; letter-spacing: -0.02mm;
    color: #12417a; font-weight: bold; white-space: nowrap;
  }}
  .url i {{
    display: block; font-style: normal; font-size: 2.1mm;
    color: #77869e; margin-top: 0.6mm;
  }}
  /* 著作権表記。読ませる文字ではないので、いちばん小さく淡く */
  .url small {{
    display: block; font-size: 1.9mm; color: #94a2b8; margin-top: 1.1mm;
  }}

  /* 右上の空きに、いちばん言いたいことを置く */
  .badge {{
    position: absolute; right: 3.6mm; top: 4.4mm;
    background: linear-gradient(135deg, #ff7a3d, #e8442f); color: #fff6ef;
    font-size: 2.4mm; font-weight: bold; letter-spacing: 0.15mm;
    padding: 1mm 2mm; border-radius: 9mm; white-space: nowrap;
  }}

  /* ===== 翠緑の薬導士 ===== */
  .chara {{
    position: absolute; right: 3.2mm; bottom: 3.2mm;
    height: 34mm; width: auto;
    /* 左右反転。元絵は左を向いているが、名刺では右端に立つので、
       反転すると視線と体の向きが紙の内側(文字のほう)へ向く。 */
    transform: scaleX(-1);
    filter: drop-shadow(0 0.6mm 0.8mm rgba(20,50,100,0.22));
  }}

  /* ===== 画面用の案内(印刷には出ない) ===== */
  .guide-note {{
    max-width: 210mm; margin: 6mm auto 0; padding: 3mm 4mm;
    background: #1c1c34; color: #ddddee; border-radius: 2mm;
    font-size: 3.4mm; line-height: 1.8;
  }}
  .guide-note b {{ color: #ffdd66; }}
  .guide-note code {{ color: #88ddaa; }}

  /* ハサミ線。面の上に重ねるだけなので、名刺の中身には触らない */
  .cut {{
    position: absolute; left: 0; top: 0; width: 210mm; height: 297mm;
    pointer-events: none;
  }}

  /* ★ ずれ補正はここ1か所だけ。
     面(名刺)とハサミ線を同じ入れ物に入れ、その入れ物ごと動かす。
     以前は面と線を別々にずらしていて、片方だけ動く事故を起こした
     (「3mmずらしたのに1cm違う」の正体)。 */
  .shift {{
    position: absolute; left: 0; top: 0; width: 210mm; height: 297mm;
    /* 紙の左上を基準に伸ばしてから、ずれを補正して動かす。
       基準は紙の左上。「上は合うのに下だけ短い」出方をしたので、
       縮みは上端を起点に下へ溜まっている。中央基準にすると
       合っていた上まで動いてしまう。 */
    /* 基準は面付けの左上の角。ここが合っているので、
       伸ばしてもこの角だけは動かないようにする。 */
    transform-origin: {MARGIN_X}mm {MARGIN_Y}mm;
    transform: translate({SHIFT_X}mm, {SHIFT_Y}mm) scale({SCALE_X}, {SCALE_Y});
  }}

  @media print {{
    body {{ background: #fff; }}
    .guide-note {{ display: none; }}
    .sheet {{ margin: 0; box-shadow: none; }}
  }}
</style>
</head>
<body>

<div class="guide-note">
  {'<b>ハサミ線あり(普通紙での試し刷り用)</b> — 上の余白に <b>100mmのものさし</b>が刷ってあります。'
   '刷った紙を定規で測って100mmなら実寸です。'
   if cut else
   '<b>エーワン 51861(A4 10面・91×55mm)用</b> — このまま印刷すると10枚できます。'}<br>

  <b>★ Chrome で印刷する時の設定(ここを外すと必ず小さく出ます)</b><br>
  &nbsp;&nbsp;送信先を選んだあと <b>「詳細設定」を開く</b>。<br>
  &nbsp;&nbsp;・<b>用紙サイズ = A4</b><br>
  &nbsp;&nbsp;・<b>倍率 = カスタム → 100</b>
  (「デフォルト」は<b>印刷可能な範囲に合わせて縮小</b>します。これが「小さく出る」の正体)<br>
  &nbsp;&nbsp;・<b>余白 = なし</b>(この版は余白14mm・11mmを自分で持っています)<br>
  &nbsp;&nbsp;・<b>背景のグラフィック = オン</b><br>
  &nbsp;&nbsp;・<b>「フチなし印刷」は使わない</b>(紙いっぱいに引き伸ばされて面付けがずれます)<br>

  <b>測った長さから、何が起きたか分かります</b> —
  100mmのはずが <b>96mm前後</b>なら「倍率=デフォルト」、
  <b>94mm前後</b>なら用紙がレターになっています。<br>
  1面の大きさは <b>91 × 55mm</b>。ここが合っていれば本番を刷って大丈夫です。<br>
  <b>いまのずれ補正: 横 {SHIFT_X}mm / 縦 {SHIFT_Y}mm</b>
  (刷った位置がまだずれる時は <code>build_meishi.py</code> の
  <code>SHIFT_X</code> / <code>SHIFT_Y</code> を直して作り直す。
  右にずれるなら横を小さく、下にずれるなら縦を小さくする)<br>

  アドレスを変えたい時は <code>tools/meishi/build_meishi.py</code> の <code>URL</code> を直して作り直してください(QRも一緒に変わります)。
</div>

<div class="sheet">
  <div class="shift">{cards}
{cut_svg() if cut else ''}
  </div>
</div>

</body>
</html>
'''
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('書き出した:', out)
    print('  種類  : {}'.format(kind))
    print('  アドレス: {}'.format(URL))
    print('  面付け: {}×{}面 / 1面 {}×{}mm / 余白 左右{}mm・上下{}mm'.format(
        COLS, ROWS, CARD_W, CARD_H, MARGIN_X, MARGIN_Y))
    print(f'  ずれ補正: 横 {SHIFT_X}mm / 縦 {SHIFT_Y}mm'
          f' / 倍率 横×{SCALE_X} 縦×{SCALE_Y}')
    print(f'  → 版の中の1面は {CARD_W * SCALE_X:.2f} × {CARD_H * SCALE_Y:.2f}mm'
          f'(紙の上で {CARD_W} × {CARD_H}mm になれば正しい)')
    print('  大きさ: {:.0f} KB'.format(os.path.getsize(out) / 1024))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    build(cut=False)   # エーワン 51861 用(線なし)
    build(cut=True)    # 普通紙用(ハサミ線あり)

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
#   +1.5mm → -2.5 から右へ4mm
#   +2.5mm → 普通紙(OAペーパー)では左が合っていた。倍率もここで確定させた
#   +2.5mm → ★本番のエーワン 51861 に刷ったら、全体が4mm右へずれた
#            ⇒ -1.5mm へ(2026-08-10)
#   -1.5mm → 今度は1.5mm左へ行きすぎた ⇒ 0.0mm へ
#    0.0mm → 1.5mm動かしたのに紙では0.5mmしか動かなかった。残り1.0mm
#   +1.0mm → 四隅のトンボを入れた最初の版。ほぼ合ったが0.5mm右寄り
#   +0.5mm → ★合った(2026-08-11 確定)。位置はこれで完了。
#            トンボを入れてからは、指示した量がそのまま紙に出ている。
#
#   ★ 動かした分がそのまま出ないのは、印刷ダイアログの中央合わせのせい。
#     あれは「中身の外枠」を見て位置を決める。面付けだけが中身だと、
#     面付けを右へ動かすと外枠ごと動き、中央合わせが押し戻してしまう。
#     4mm指示で5.5mm動き、1.5mm指示で0.5mmしか動かない、という
#     食い違いはこれ。⇒ corner_svg() で四隅に印を打ち、
#     中身の外枠を紙いっぱいに固定した。以後は指示どおり動くはず。
#
#   ★ 用紙が変わると送りが変わる。
#     普通紙で合わせた位置が、厚口のマルチカードでそのまま出るとは限らない。
#     位置(SHIFT)は用紙ごとに測り直すこと。
#     倍率(SCALE)は普通紙で決めた値がそのまま使えた ― 動かさない。
SHIFT_X = float(os.environ.get('MEISHI_SHIFT_X', '0.5'))
SHIFT_Y = float(os.environ.get('MEISHI_SHIFT_Y', '1.0'))

# ---- 大きさの補正 ----
#
# プリンタは等倍で刷ったつもりでも、実際には数%ずれた大きさで出る。
# 版のほうを逆向きに作っておいて、刷り上がりで実寸になるようにする。
# このプリンタは少し「伸びる」ので、版は 1 より小さい。
#
# ★ 基準は紙の左上。中央ではない。
#   「上のカット線は合っているのに、下が3mm短い」という出方をした。
#   これは縮みが上端を起点にして下へ溜まっている、ということ。
#   中央を基準に伸ばすと上も動いてしまい、合っていた上までずれる。
#
# ★ 決め方
#   2列ぶんの幅は 91 × 2 = 182mm、5段ぶんの高さは 55 × 5 = 275mm。
#   刷ったものが右へ2mm出ていたら、刷り上がりは 184mm あったということ。
#     プリンタの倍率 = 184 / (182 × いまのSCALE_X)
#     新しいSCALE_X  = 182 / プリンタの倍率 / 182
#   縦も同じ(275 と 高さ)。左と上は合っているので、位置(SHIFT)は動かさない。
#
# ★ 刷り上がりの観測(いずれも左と上は合っていた)
#   SCALE       →  刷り上がりの過不足(横 / 縦)
#   1.0166 / 1.0110 → 右へ+2.5mm、下へ+4mm
#   1.0028 / 1.0075 → 右へ+2.0mm、下へ+3mm
#   0.9919 / 0.9966 → 右が-1mm、下が-2mm     ← 下げすぎた
#   0.9974 / 1.0039 → 右へ+1mm、下へ+2mm     ← 今度は上げすぎた
#   0.9947 / 1.0002 → ★合った(2026-08-10 確定)。上の2つで挟んだ真ん中。
#
#   ★ この値は「エーワン 51861タイプ(マルチカード クリアエッジ 厚口・
#     名刺サイズ 10面)」を、いまのプリンタに Chrome から
#     「実際のサイズ(100%)」で刷った時のもの。
#     用紙かプリンタが変わったら、この4つの値は作り直すこと。
#
#   ★ 挟んで決める。
#     横は 0.9919 で 181mm(1mm足りない)、0.9974 で 183mm(1mm多い)。
#     欲しいのは 182mm ちょうどなので、間の 0.9947。
#     縦も 0.9966 で 273mm、1.0039 で 277mm、欲しいのは 275mm → 1.0002。
#
#   ★ 一度で決まらないのは、刷り上がりを定規で読む時に1〜2mmの幅が
#     出るため。182mm に対する1mmは0.55%で、この補正そのものより大きい。
#     行ったり来たりするのが普通なので、毎回この表に足していくこと。
#
# ★ ものさしを測るほうが早い。
#   紙の上端の線は、刷り上がりで 100mm になるよう引いてある。
#   100mm ちょうどなら横の倍率は当たり。99mm なら 1% 足りない。
#   カット線を測るより短い距離を読むぶん誤差は乗るが、
#   「合っているかどうか」の判断はこちらのほうが確か。
SCALE_X = float(os.environ.get('MEISHI_SCALE_X', '0.9947'))
SCALE_Y = float(os.environ.get('MEISHI_SCALE_Y', '1.0002'))


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


def wind_svg() -> str:
    """風の渦。キャラの左に小さく置く(キャラには重ねない)。

    ★ 図形で描く。AIに描かせると線の太さ・色・光の当たり方が
      既存の絵と揃わず、貼った感じになる。この大きさなら図形のほうが馴染む。
    ★ 色は風のエレメント(#66dd99)。名刺の上端の帯と同じ色を使うので、
      「これは風の魔法だ」と色だけで分かる。
    """
    g = '#66dd99'
    return (
        '<span class="wind" aria-hidden="true">'
        '<svg viewBox="0 0 100 100">'
        '<g fill="none" stroke="' + g + '" stroke-linecap="round">'
        # 外から内へ巻き込む本体
        '<path d="M8 40 C 20 22, 52 18, 66 32 C 78 44, 72 64, 56 66'
        ' C 43 68, 36 58, 42 50 C 47 43, 58 45, 58 53"'
        ' stroke-width="6"/>'
        # 添えの筋(風が流れている感じを出す)
        '<path d="M4 60 C 16 52, 30 52, 38 56" stroke-width="4.5" opacity="0.75"/>'
        '<path d="M14 76 C 24 70, 36 70, 44 73" stroke-width="3.6" opacity="0.5"/>'
        '</g>'
        # 舞う粒
        '<circle cx="80" cy="20" r="3.4" fill="' + g + '" opacity="0.85"/>'
        '<circle cx="90" cy="34" r="2.2" fill="' + g + '" opacity="0.6"/>'
        '<circle cx="26" cy="14" r="2.4" fill="' + g + '" opacity="0.6"/>'
        '</svg></span>')


def recipe_count() -> int:
    """系統の数は shared/data.ts から数える。

    名刺に数字を手で書くと、系統を足した時にここだけ古くなる。
    実際、蘇生系(光6)を足して29になったのに、名刺は28のままだった。
    """
    path = os.path.join(ROOT, 'shared', 'data.ts')
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    body = src[src.index('export const RECIPES'):]
    body = body[:body.index('\n];')]
    ids = re.findall(r"^\s*id: '([a-z0-9_]+)'", body, re.M)
    if len(ids) < 10:
        raise SystemExit('shared/data.ts から系統を数えられない')
    return len(ids)


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


# ---- 風の渦の置き場所(名刺の左上から測った mm) ----
# 「手のすぐ左下」。数字の根拠は .wind のCSSに書いてある。
WIND_X, WIND_Y, WIND_D = 65.2, 37.8, 6.5

# 絵の置き場所。CSSの .chara と同じ値でなければ、下の判定が嘘になる。
CHARA_RIGHT, CHARA_BOTTOM, CHARA_H = 3.2, 3.2, 34.0


def chara_clear() -> None:
    """風の渦が絵に重なっていないかを、絵の中身で確かめる。

    ★ 四角どうしの重なりでは判定できない。
      絵の四角(bbox)は肩から靴までを囲むので、手の左下はその中に入る。
      だが実際にはそこは透けていて、体は 73mm より右にしかない。
      なので「不透明な点があるか」で見る。

    ★ .chara は scaleX(-1) で左右反転している。
      絵の中の x をそのまま使うと、左右が逆の場所を調べてしまう。
    """
    name = POSE_FILE.get(CHARA_POSE, '4.png')
    im = Image.open(os.path.join(ROOT, 'public', 'img', 'player', name)).convert('RGBA')
    box = im.getbbox()
    if box:
        im = im.crop(box)
    w, h = im.size
    a = im.split()[3]

    # 紙の上での絵の四隅(mm)。高さ34mmから幅を割り出す。
    card_w = CARD_W * SCALE_X
    card_h = CARD_H * SCALE_Y
    art_w = CHARA_H * w / h
    right = card_w - CHARA_RIGHT
    left = right - art_w
    bottom = card_h - CHARA_BOTTOM
    top = bottom - CHARA_H

    hits = 0
    step = 0.1   # 0.1mm刻みで見る
    y = WIND_Y
    while y <= WIND_Y + WIND_D:
        x = WIND_X
        while x <= WIND_X + WIND_D:
            if left <= x <= right and top <= y <= bottom:
                # 反転を戻してから絵の中の座標へ
                px = int((right - x) / art_w * w)
                py = int((y - top) / CHARA_H * h)
                if 0 <= px < w and 0 <= py < h and a.getpixel((px, py)) > 40:
                    hits += 1
            x += step
        y += step
    if hits:
        raise SystemExit(
            f'風の渦がキャラに重なっている({hits}点)。'
            f'WIND_X/WIND_Y を左か下へ動かすこと')
    print(f'  風の渦: 手のすぐ左下 x{WIND_X}〜{WIND_X + WIND_D:.1f} / '
          f'y{WIND_Y}〜{WIND_Y + WIND_D:.1f}mm ─ キャラに重なりなし')


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


# 四隅のトンボ。紙のどこに刷られたかを直に測るための印。
CORNER_IN = 5.0    # 紙の端からの距離(mm)
CORNER_LEN = 6.0   # かぎ線の腕の長さ(mm)


def corner_svg() -> str:
    """紙の四隅に、かぎ形の印を打つ。線なし版にも入れる。

    ★ 二役ある。

    1) 版の「中身の範囲」を紙いっぱいに固定する。
       印刷ダイアログの「用紙に合わせる」「中央に配置」は、
       中身の外枠を見て動かす。中身が面付けだけだと、
       こちらが面付けを右へ1.5mm動かしても外枠ごと動くので、
       中央合わせがそれを打ち消してしまう ―
       実際、版は1.5mm動いているのに紙では0.5mmしか動かなかった。
       四隅に印があれば外枠は常に紙いっぱいで、動かした分がそのまま出る。

    2) プリンタが何をしたかを直に測れる。
       印は紙の端から 5mm(CORNER_IN)の所にある。
       刷ったものを定規で測って
         5mm なら位置は正しい / 7mm なら2mm右へ流れている。
       カット線とミシン目を見比べるより、はるかに読み取りやすい。

    印は面付けの外(左右14mm・上下11mmの余白)に収まるので、
    名刺には刷り込まれない。クリアエッジの縁は切り離して捨てる部分。
    """
    d = CORNER_IN
    L = CORNER_LEN
    W, H = 210.0, 297.0
    seg = []
    for x, sx in ((d, 1), (W - d, -1)):
        for y, sy in ((d, 1), (H - d, -1)):
            seg.append(f'<line x1="{x:.2f}" y1="{y:.2f}" '
                       f'x2="{x + L * sx:.2f}" y2="{y:.2f}"/>')
            seg.append(f'<line x1="{x:.2f}" y1="{y:.2f}" '
                       f'x2="{x:.2f}" y2="{y + L * sy:.2f}"/>')
    return (
        f'<svg class="corner" viewBox="0 0 {W:.0f} {H:.0f}" '
        f'xmlns="http://www.w3.org/2000/svg">'
        f'<g stroke="#8fa3b8" stroke-width="0.25" fill="none">'
        + ''.join(seg) +
        f'</g>'
        '</svg>')
    # ★ ここに説明の文字を添えないこと。
    #   一度 5mm より外(紙の端から2.1mm)へ字が出て、プリンタの
    #   刷れない領域(ふつう3mm)に掛かった。それだけで
    #   「用紙に合わせる」が働いて全体が縮む。印は線だけにする。


def cut_svg() -> str:
    """ハサミ線と、実寸を確かめるものさし。普通紙での試し刷り用。

    ★ 線の座標にも、面と同じ補正(SHIFT / SCALE)を数値で織り込む。
      CSSの transform でまとめて動かす書き方は、画面では効くのに
      printToPDF では落ちた(実測で確認)。紙に出るのは数値だけ。

    ★ ものさしは面の外(上の余白)に置く。
      面の中に入り込むと名刺に刷り込まれてしまう ― 一度やった。
    """
    # 面付けの実際の位置(補正込み)
    x0 = MARGIN_X + SHIFT_X
    y0 = MARGIN_Y + SHIFT_Y
    w1 = CARD_W * SCALE_X
    h1 = CARD_H * SCALE_Y

    lines = []
    for c in range(COLS + 1):
        x = x0 + c * w1
        lines.append(f'<line x1="{x:.3f}" y1="{y0:.3f}" '
                     f'x2="{x:.3f}" y2="{y0 + h1 * ROWS:.3f}"/>')
    for r in range(ROWS + 1):
        y = y0 + r * h1
        lines.append(f'<line x1="{x0:.3f}" y1="{y:.3f}" '
                     f'x2="{x0 + w1 * COLS:.3f}" y2="{y:.3f}"/>')

    # ものさし。刷り上がりで100mmになるよう、倍率ぶん長く引く。
    # 面の上端(y0)より上に収める ― 目盛りも文字も面に入れない。
    ry = max(6.0, y0 - 4.2)          # ものさしの線の高さ
    rlen = 100.0 * SCALE_X
    ruler = [f'<line x1="{x0:.3f}" y1="{ry:.2f}" x2="{x0 + rlen:.3f}" y2="{ry:.2f}"/>']
    for i in range(11):
        x = x0 + i * rlen / 10
        up = 2.6 if i % 5 == 0 else 1.5
        ruler.append(f'<line x1="{x:.3f}" y1="{ry:.2f}" '
                     f'x2="{x:.3f}" y2="{ry - up:.2f}"/>')

    # 説明はものさしの右へ1行。
    #
    # ★ 短く保つこと。長い文を置いたら紙の右へはみ出した。
    #   ものさしの右端は x0+rlen(いま約120mm)。紙は210mmしかない。
    #   全角は約2.2mm、半角は約1.2mm を目安に、90mm以内に収める。
    note = (f'← 100mm ／ ずれ{SHIFT_X:+.1f},{SHIFT_Y:+.1f} '
            f'／ 倍率{SCALE_X:.4f},{SCALE_Y:.4f}')
    # 目安の幅を出して、はみ出しそうなら作る時に知らせる
    est = sum(2.2 if ord(ch) > 0x2000 else 1.2 for ch in note)
    if x0 + rlen + 2 + est > 205:
        print(f'  ※ ものさしの説明が長い(推定 {est:.0f}mm)。'
              f'右端 {x0 + rlen + 2 + est:.0f}mm ― 紙からはみ出す')

    return (
        f'<svg class="cut" viewBox="0 0 210 297" xmlns="http://www.w3.org/2000/svg">'
        f'<g stroke="#adbccc" stroke-width="0.2" fill="none">' + ''.join(lines) + '</g>'
        f'<g stroke="#1b56a8" stroke-width="0.35" fill="none">' + ''.join(ruler) + '</g>'
        f'<text x="{x0 + rlen + 2:.3f}" y="{ry + 0.8:.2f}" font-size="2.2"'
        f' fill="#1b56a8" font-family="sans-serif">{note}</text>'
        '</svg>')


def card_html(art: str, qr: str, cr: str, title: str, ribbon: str,
              wind: str, recipes: int) -> str:
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
        <li>レシピは<b>非公開</b>。隠された<b>{recipes}系統</b>を試して見つけ出す</li>
        <li>お気に入り魔法をセットして<b>仲間と共闘や決闘</b>しよう</li>
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

      {wind}
      <span class="badge">無料・登録不要</span>
      <img class="chara" src="{art}" alt="翠緑の薬導士">
    </div>
  </div>'''


def build(cut: bool = False) -> None:
    chara_clear()
    art = char_art()
    qr = qr_svg()
    cr = copyright_text()
    title = title_uri()
    ribbon = elem_ribbon()
    wind = wind_svg()
    recipes = recipe_count()
    cards = ''.join(card_html(art, qr, cr, title, ribbon, wind, recipes)
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
    position: absolute; overflow: hidden;
    /* 刷り上がりで 91×55mm になるよう、縮むぶんだけ大きく作る */
    width: {CARD_W * SCALE_X:.3f}mm; height: {CARD_H * SCALE_Y:.3f}mm;
  }}
  /* 面の位置。エーワン 51861 の実寸から出した値 */
'''
    for i in range(COLS * ROWS):
        r, c = divmod(i, COLS)
        # ★ 補正はここで数値として織り込む。
        #   CSSの transform でまとめて動かす書き方も試したが、
        #   画面では効くのに printToPDF では落ちて、PDFには
        #   まったく反映されなかった(実測で確認)。
        #   紙に出るのはこの数値だけなので、ここで完結させる。
        html += (f'  .card:nth-child({i + 1}) {{ '
                 f'left: {MARGIN_X + SHIFT_X + c * CARD_W * SCALE_X:.3f}mm; '
                 f'top: {MARGIN_Y + SHIFT_Y + r * CARD_H * SCALE_Y:.3f}mm; }}\n')

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

  /* 幅は「絵に触れない上限」まで取る。ここが狭いと文言が折り返し、
     行が増えたぶん下の足元(QR・アドレス)に食い込む。
     倍率を下げると面が狭くなり、右寄せの絵が左へ来る(いま左端64.4mm)。
     4.5 + 58 = 62.5mm で手前に止める。
     折り返していないことは check_layout.mjs が行の高さで見張る。 */
  .pts {{ list-style: none; margin-top: 0.4mm; width: 58mm; }}
  /* 行間は QR を1.2倍にしたぶん詰めてある(1.55 → 1.42)。
     ここを戻すと箇条書きの下端が QR の上端に触れる。 */
  .pts li {{
    font-size: 2.35mm; line-height: 1.42; color: #3f4a63;
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
    display: flex; align-items: center; gap: 1.4mm;
  }}
  /* 静穏帯を規格の4マスにしたぶん1マスが細るので、QR自体を少し大きくして
     1マス0.4mm以上を保つ(14mmのままだと0.378mmまで落ちる)。 */
  /* 17mm → 20.4mm(1.2倍)。
     左と下は紙の端から3mmの決まりに当たっていて、これ以上は寄せられない。
     増えたぶんは上へ出るので、箇条書きを詰めて場所を空けてある。 */
  .qr {{ width: 20.4mm; height: 20.4mm; display: block; }}
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
    /* 上下の真ん中を、左のアイコン(と題字)の真ん中に合わせてある。
       アイコンの中心は 8.89mm、この札の高さは 5.17mm。 */
    position: absolute; right: 3.6mm; top: 6.3mm;
    background: linear-gradient(135deg, #ff7a3d, #e8442f); color: #fff6ef;
    font-size: 2.4mm; font-weight: bold; letter-spacing: 0.15mm;
    padding: 1mm 2mm; border-radius: 9mm; white-space: nowrap;
  }}

  /* 風の渦。キャラの左の空きに置く。
     ここは箇条書きの下・QRの右・キャラの左で、どれにも触れない隙間。
     重なっていないことは check_layout.mjs が実測で見張る。 */
  .wind {{
    /* 手のすぐ左下に置く。
       絵は scaleX(-1) で左右反転しているので、絵の中の座標ではなく
       紙の上の座標で決めること(反転を忘れると左右が逆の場所に置く)。
       ・組んだ手      … x72.8〜75.6 / y34.9〜38.0mm
       ・体の左の輪郭  … y37.8〜44.3 の範囲では 73.6mm より右
       ・足元(アドレス)… 右端 61.1mm
       挟まれた x61.1〜73.6 に置く。
       ★ right/bottom ではなく left/top で指定する。
         面は倍率ぶん大きい(いま91.25mm幅)ので、右からの指定は
         倍率を変えるたびに場所が動いてしまう。
       重なっていないことは build 時に chara_clear() が実測で見張る。 */
    position: absolute; left: {WIND_X}mm; top: {WIND_Y}mm;
    width: {WIND_D}mm; height: {WIND_D}mm;
  }}
  .wind svg {{ width: 100%; height: 100%; display: block; }}

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
  .cut, .corner {{
    position: absolute; left: 0; top: 0; width: 210mm; height: 297mm;
    pointer-events: none;
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

<div class="sheet">{cards}
{corner_svg()}
{cut_svg() if cut else ''}
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

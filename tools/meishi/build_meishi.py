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


def char_art() -> str:
    """翠緑の薬導士。余白を切り詰めてから埋め込む(名刺では1mmが大きい)。"""
    im = Image.open(os.path.join(ROOT, 'public', 'img', 'player', '4.png')).convert('RGBA')
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
    """ハサミ線。普通紙に刷って自分で切る時だけ使う。

    面と面の境目に細い線を通す。マルチカードのミシン目と同じ位置なので、
    「線どおりに切れば名刺の寸法になる」ことがそのまま確かめられる
    (エーワン用に刷る時は線なしの版を使うこと ― 切り離した紙の縁に
     線が残ってしまう)。
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
    return (f'<svg class="cut" viewBox="0 0 {w} {h}" '
            f'xmlns="http://www.w3.org/2000/svg">'
            f'<g stroke="#adbccc" stroke-width="0.2" fill="none">'
            + ''.join(lines) + '</g></svg>')


def card_html(art: str, qr: str, cr: str, title: str) -> str:
    return f'''
  <div class="card">
    <div class="inner">
      <div class="head">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#3f8ef0"/>
                <stop offset="1" stop-color="#12306e"/>
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
    cards = ''.join(card_html(art, qr, cr, title) for _ in range(COLS * ROWS))
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
        html += (f'  .card:nth-child({i + 1}) {{ '
                 f'left: {MARGIN_X + c * CARD_W}mm; top: {MARGIN_Y + r * CARD_H}mm; }}\n')

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

  .head {{ display: flex; align-items: center; gap: 2.2mm; }}
  .mark {{ width: 9.4mm; height: 9.4mm; flex: 0 0 auto; }}
  .mark svg {{ width: 100%; height: 100%; display: block; }}
  /* 題字は画面と同じ絵。字の輪郭が図形なので、刷っても形が変わらない */
  /* ★ 高さで決めない。右上のバッジに《まどけん》がかかったので、
     入れてよい幅を先に決めて、高さはそれに従わせる。 */
  .title {{ width: 45mm; height: auto; display: block; }}

  .lead {{
    margin-top: 1.4mm; font-size: 2.7mm; font-weight: bold; color: #17457e;
    background: #e8f2fd; border-left: 0.8mm solid #3f8ef0;
    padding: 1mm 1.6mm; border-radius: 0 1mm 1mm 0;
    width: 53mm;
  }}

  .pts {{ list-style: none; margin-top: 1.4mm; width: 51mm; }}
  .pts li {{
    font-size: 2.35mm; line-height: 1.55; color: #3f4a63;
    padding-left: 2.6mm; position: relative;
  }}
  .pts li::before {{
    content: ''; position: absolute; left: 0.5mm; top: 1.3mm;
    width: 1.2mm; height: 1.2mm; border-radius: 50%; background: #8dc2f0;
  }}
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
    background: #1b56a8; color: #eaf4ff;
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

  @media print {{
    body {{ background: #fff; }}
    .guide-note {{ display: none; }}
    .sheet {{ margin: 0; box-shadow: none; }}
  }}
</style>
</head>
<body>

<div class="guide-note">
  {'<b>ハサミ線あり(普通紙用)</b> — 普通のコピー用紙に刷って、線どおりに切ると名刺(91×55mm)になります。'
   if cut else
   '<b>エーワン 51861(A4 10面・91×55mm)用</b> — このまま印刷すると10枚できます。'}<br>
  印刷設定は <b>用紙サイズ=A4</b>／<b>倍率=100%(「実際のサイズ」。
  「ページに合わせる」「用紙に合わせて拡大縮小」は必ず外す)</b>／
  <b>背景グラフィックを印刷する</b>。<br>
  <b>「フチなし印刷」は使わないでください</b> ― 紙いっぱいに引き伸ばされて面付けがずれます
  (この版は余白11mm・14mmを見込んで組んであるので、等倍で刷れば端は切れません)。<br>
  名刺用紙は厚いので<b>手差しトレイ</b>から1枚ずつ。顔料インクは乾くまで擦らないこと。<br>
  {'切った紙の縁に線が残るのが気になる時は、線なしの版(madoken_meishi.html)を使ってください。'
   if cut else
   '1枚目は普通紙に刷って、名刺用紙に重ねて光にかざすと位置を確かめられます。'}<br>
  アドレスを変えたい時は <code>tools/meishi/build_meishi.py</code> の <code>URL</code> を直して作り直してください(QRも一緒に変わります)。
</div>

<div class="sheet">{cards}
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
    print('  大きさ: {:.0f} KB'.format(os.path.getsize(out) / 1024))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    build(cut=False)   # エーワン 51861 用(線なし)
    build(cut=True)    # 普通紙用(ハサミ線あり)

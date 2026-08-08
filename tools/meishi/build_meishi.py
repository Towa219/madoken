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
import sys

from PIL import Image
import segno

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'tools', 'meishi', 'madoken_meishi.html')

# 配る先はゲーム本体ではなく入口(待機ページ)。
# サーバーが寝ていても説明が出るので、初めての人が驚かない。
URL = 'https://towa219.github.io/madoken/'
URL_SHOW = 'towa219.github.io/madoken/'

# ---- 用紙 ----
CARD_W, CARD_H = 91, 55       # mm
MARGIN_X, MARGIN_Y = 14, 11   # mm
COLS, ROWS = 2, 5


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
    """
    q = segno.make(URL, error='m')
    buf = io.BytesIO()   # segno はバイト列で書き出す
    q.save(buf, kind='svg', scale=1, border=3, dark='#1b1035', light=None,
           svgclass=None, lineclass=None, xmldecl=False, svgns=True, omitsize=True)
    return buf.getvalue().decode('utf-8')


def card_html(art: str, qr: str) -> str:
    return f'''
  <div class="card">
    <div class="inner">
      <div class="head">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#6a3fd0"/>
                <stop offset="1" stop-color="#2a1a5e"/>
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
        <span class="title">
          <b>魔導研究記</b><i>《まどけん》</i>
        </span>
      </div>

      <p class="lead">8つのエレメントを調合して、魔法を&quot;発見&quot;する</p>
      <ul class="pts">
        <li>レシピは<b>非公開</b>。組み合わせを試して見つけ出す</li>
        <li>隠された系統は<b>28種</b>。仲間と共闘、研究者と決闘</li>
        <li><b>ブラウザで無料・登録不要</b>(スマホ可)</li>
      </ul>

      <div class="foot">
        <span class="qr">{qr}</span>
        <span class="url">
          <b>{URL_SHOW}</b>
          <i>QRを読むか、この住所へ</i>
        </span>
      </div>

      <img class="chara" src="{art}" alt="翠緑の薬導士">
    </div>
  </div>'''


def build() -> None:
    art = char_art()
    qr = qr_svg()
    cards = ''.join(card_html(art, qr) for _ in range(COLS * ROWS))

    html = f'''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>魔導研究記 名刺(エーワン 51861 / A4 10面)</title>
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
    color: #241a3d;
  }}

  .head {{ display: flex; align-items: center; gap: 1.8mm; }}
  .mark {{ width: 8.4mm; height: 8.4mm; flex: 0 0 auto; }}
  .mark svg {{ width: 100%; height: 100%; display: block; }}
  .title b {{
    display: block; font-family: 'Yu Mincho', 'MS Mincho', serif;
    font-size: 5.4mm; letter-spacing: 0.4mm; color: #2c1a63; line-height: 1.1;
  }}
  .title i {{
    display: block; font-style: normal; font-size: 2.5mm;
    letter-spacing: 0.3mm; color: #7a5bd0; margin-top: 0.4mm;
  }}

  .lead {{
    margin-top: 2.4mm; font-size: 2.7mm; font-weight: bold; color: #3a2a70;
    background: #efe9fb; border-left: 0.8mm solid #7a5bd0;
    padding: 1mm 1.6mm; border-radius: 0 1mm 1mm 0;
    width: 55mm;
  }}

  .pts {{ list-style: none; margin-top: 1.8mm; width: 52mm; }}
  .pts li {{
    font-size: 2.35mm; line-height: 1.55; color: #4a4160;
    padding-left: 2.6mm; position: relative;
  }}
  .pts li::before {{
    content: ''; position: absolute; left: 0.5mm; top: 1.3mm;
    width: 1.2mm; height: 1.2mm; border-radius: 50%; background: #b9a4ea;
  }}
  .pts b {{ color: #2c1a63; }}

  /* ===== 足元(QRとURL) ===== */
  .foot {{
    position: absolute; left: 4.5mm; bottom: 3.4mm;
    display: flex; align-items: center; gap: 2mm;
  }}
  .qr {{ width: 14mm; height: 14mm; display: block; }}
  .qr svg {{ width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }}
  .url b {{
    display: block; font-size: 2.9mm; letter-spacing: -0.02mm;
    color: #2c1a63; font-weight: bold; white-space: nowrap;
  }}
  .url i {{
    display: block; font-style: normal; font-size: 2.1mm;
    color: #8a80a5; margin-top: 0.6mm;
  }}

  /* ===== 翠緑の薬導士 ===== */
  .chara {{
    position: absolute; right: 3.4mm; bottom: 3.2mm;
    height: 34mm; width: auto;
    filter: drop-shadow(0 0.6mm 0.8mm rgba(60,40,110,0.22));
  }}

  /* ===== 画面用の案内(印刷には出ない) ===== */
  .guide-note {{
    max-width: 210mm; margin: 6mm auto 0; padding: 3mm 4mm;
    background: #1c1c34; color: #ddddee; border-radius: 2mm;
    font-size: 3.4mm; line-height: 1.8;
  }}
  .guide-note b {{ color: #ffdd66; }}
  .guide-note code {{ color: #88ddaa; }}
  @media print {{
    body {{ background: #fff; }}
    .guide-note {{ display: none; }}
    .sheet {{ margin: 0; box-shadow: none; }}
  }}
</style>
</head>
<body>

<div class="guide-note">
  <b>エーワン 51861(A4 10面・91×55mm)用</b> — このまま印刷すると10枚できます。<br>
  印刷設定は <b>用紙A4／倍率100%(「ページに合わせる」は外す)／余白なし／背景グラフィックを印刷する</b>。<br>
  1枚目は普通紙に刷って、名刺用紙に重ねて光にかざすと位置を確かめられます。<br>
  住所を変えたい時は <code>tools/meishi/build_meishi.py</code> の <code>URL</code> を直して作り直してください(QRも一緒に変わります)。
</div>

<div class="sheet">{cards}
</div>

</body>
</html>
'''
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('書き出した:', OUT)
    print('  住所 :', URL)
    print('  面付け: {}×{}面 / 1面 {}×{}mm / 余白 左右{}mm・上下{}mm'.format(
        COLS, ROWS, CARD_W, CARD_H, MARGIN_X, MARGIN_Y))
    print('  大きさ: {:.0f} KB'.format(os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    build()

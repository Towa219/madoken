# -*- coding: utf-8 -*-
"""タイトルの絵(SVG)を作る。

    D:/ComfyUI/python_embeded/python.exe tools/title/build_title.py

出来るもの: public/img/title.svg (画面の題字) と tools/title/preview.png (確認用)

★ なぜ画像にするのか
  CSSの文字でやると、端末に游明朝が無ければゴシックに落ちる。
  題字だけは「どの端末でも同じ形」で出したいので、
  字の輪郭を取り出して図形にしてしまう(フォントの有無に左右されない)。

★ なぜ絵をAIに描かせないのか
  文字を描かせると偽の字を作る。紹介動画を作った時、作品名を書かせたら
  「漉造効」のような字にならない字が出た。題字は輪郭を取るのが確実。
"""

import io
import os
import subprocess
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 本体(public/)と入口の待機ページ(docs/)の両方へ置く。
# 待機ページはサーバーが眠っていても開くので、本体の絵を参照できない。
# 同じ版を2か所に置き、ここから一度に書き出して食い違いを防ぐ。
OUTS = [
    os.path.join(ROOT, 'public', 'img', 'title.svg'),
    os.path.join(ROOT, 'docs', 'title.svg'),
]

# 游明朝 Demibold。明朝の縦横の差が「魔導書」の気配を出す。
FONT = 'C:/Windows/Fonts/yumindb.ttf'

MAIN = '魔導研究記'
SUB = '《まどけん》'

# 版面(SVGの中の座標。実際の大きさはCSS側で決める)
#
# ★ 副題は下に置かず、同じ行の右へ。
#   上下に積むと絵が縦に伸び、ヘッダーの高さに収めた時に題字が小さくなる。
#   実際、副題を下に置いた版はスマホ(高さ40px)で「まどけん」が読めなかった。
MAIN_SIZE = 100.0          # 題字の1文字の高さ
MAIN_TRACK = 9.0           # 字間
SUB_SIZE = 40.0            # 副題《まどけん》
SUB_TRACK = 1.0
SUB_GAP = 20.0             # 題字と副題のあいだ(同じ行)
PAD_X = 14.0
PAD_TOP = 16.0
PAD_BOTTOM = 16.0


def glyph_paths(font: TTFont, text: str, size: float, track: float):
    """1文字ずつ輪郭を取り出し、(パス, 送り幅) の並びと総幅を返す。"""
    upem = font['head'].unitsPerEm
    scale = size / upem
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    out = []
    x = 0.0
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f'この字がフォントに無い: {ch}')
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        d = pen.getCommands()
        adv = gs[name].width * scale
        out.append((d, x, adv))
        x += adv + track
    total = x - track if out else 0.0
    return out, total


def build() -> None:
    font = TTFont(FONT, fontNumber=0)
    upem = font['head'].unitsPerEm

    main, main_w = glyph_paths(font, MAIN, MAIN_SIZE, MAIN_TRACK)
    sub, sub_w = glyph_paths(font, SUB, SUB_SIZE, SUB_TRACK)

    w = PAD_X * 2 + main_w + SUB_GAP + sub_w
    h = PAD_TOP + MAIN_SIZE + PAD_BOTTOM

    # 字は「ベースラインを原点に、上へ伸びる」座標で来る。
    # y を反転して置くので、置き場所はベースラインの高さで指定する。
    main_base = PAD_TOP + MAIN_SIZE
    sub_base = main_base                      # 同じ行(足元を揃える)
    sub_x = PAD_X + main_w + SUB_GAP

    def group(items, size, base, cls, x0):
        s = font['head'].unitsPerEm
        parts = []
        for d, x, _adv in items:
            k = size / s
            parts.append(
                f'<path class="{cls}" d="{d}" '
                f'transform="translate({x0 + x:.2f} {base:.2f}) scale({k:.5f} {-k:.5f})"/>'
            )
        return '\n    '.join(parts)

    main_g = group(main, MAIN_SIZE, main_base, 'm', PAD_X)
    sub_g = group(sub, SUB_SIZE, sub_base, 's', sub_x)

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.1f} {h:.1f}"
     role="img" aria-label="{MAIN}{SUB}">
  <title>{MAIN}{SUB}</title>
  <defs>
    <!-- 題字の色。上から下へ、白銀→空→碧→紺。氷と魔力の青 -->
    <linearGradient id="t-blue" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"    stop-color="#f2fbff"/>
      <stop offset="0.38" stop-color="#a9e2ff"/>
      <stop offset="0.70" stop-color="#4fa8f5"/>
      <stop offset="1"    stop-color="#2b62c8"/>
    </linearGradient>
    <!-- 副題は淡い金。青一色にすると題字と溶けて読みにくい -->
    <linearGradient id="t-sub" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0"   stop-color="#ffe9b0"/>
      <stop offset="0.5" stop-color="#fff6dc"/>
      <stop offset="1"   stop-color="#ffd98a"/>
    </linearGradient>
    <!-- 青い光。暗い背景から字を浮かせる -->
    <filter id="t-glow" x="-25%" y="-40%" width="150%" height="190%">
      <feGaussianBlur stdDeviation="3.2" result="b"/>
      <feFlood flood-color="#3f8ef0" flood-opacity="0.75"/>
      <feComposite in2="b" operator="in" result="g"/>
      <feMerge>
        <feMergeNode in="g"/>
        <feMergeNode in="g"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <g filter="url(#t-glow)">
    <!-- 縁取りを先に敷いて、明るい背景でも字が潰れないようにする -->
    <g fill="none" stroke="#0d2350" stroke-width="7" stroke-linejoin="round">
      {main_g}
    </g>
    <g fill="url(#t-blue)">
      {main_g}
    </g>
  </g>

  <g>
    <g fill="none" stroke="#3a2a08" stroke-width="4.5" stroke-linejoin="round">
      {sub_g}
    </g>
    <g fill="url(#t-sub)">
      {sub_g}
    </g>
  </g>
</svg>
'''
    for out in OUTS:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write(svg)
        print(f'書き出した: {out} ({os.path.getsize(out) / 1024:.0f} KB)')
    print(f'  版面: {w:.0f} × {h:.0f} / 字はすべて図形(フォント不要)')
    print(f'  使ったフォント: {FONT} (単位em {upem})')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    build()

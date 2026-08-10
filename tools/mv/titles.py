# 動画に重ねる文字(題名・URL・著作権表示)を作る。
#
# 題名は「1コマずつ描いた連番PNG」にする。
#
# ★ なぜ連番にするか
#   最初は透過PNG1枚を ffmpeg の overlay で動かしていたが、カクついた。
#   overlay の座標は整数しか取れないので、8px を4.5秒かけて動かすと
#   0.5秒ごとに1pxずつ飛ぶ。人の目にはこの飛びがはっきり見える。
#   こちらで1コマずつ描き、拡大縮小もPILの補間に任せれば滑らかになる。
#
# ★ 書体
#   Noto Serif JP の最太(Weight 900)。明朝の抑揚が出て題字らしくなる。
#   最初はゴシック(Yu Gothic Bold)だったが、普通すぎた。
#   字間を広げてあるのも意図的で、詰まっていると安っぽく見える。
#
# 使い方:
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/titles.py

import math
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
W = int(os.environ.get('MV_W', '1280'))
H = int(os.environ.get('MV_H', '704'))
OUT_DIR = os.path.join(HERE, 'overlay_vidu' if H == 720 else 'overlay')
SEQ_DIR = os.path.join(OUT_DIR, 'title_seq')
SS = 2                 # 2倍で描いて縮める。字の縁と動きが滑らかになる。
FPS = 24

TITLE = '魔導研究記'
SUBTITLE = '《まどけん》'
TAGLINE = '調合で魔法を「発見」する、多人数の魔法研究ゲーム'

# 配るURL。入口(待機ページ)を指すこと。
# ゲーム本体(madoken.onrender.com)を直に載せてはいけない ―
# サーバーが眠っていると Render の起動画面に行き当たる。
# 予告編を見た人はまさに「初めて来る人」なので、ここが一番効く。
URL = 'https://towa219.github.io/madoken/'
COPYRIGHT = 'Copyright © 2026 YuriPapa'

SERIF = r'C:\Windows\Fonts\NotoSerifJP-VF.ttf'
GOTHIC = r'C:\Windows\Fonts\YuGothM.ttc'

# 題名の出し方(秒)
#
# ★ 尺の短いPVでは短くすること(2026-08-11)。
#   第1版は44.8秒あったので5.0秒でよかったが、第2版(26.4秒・1カット1.8秒)に
#   そのまま使うと、開幕・黒金・紅蓮の3カットにまたがって出続け、
#   いちばん派手な魔法の上に文字が乗り続けた。
#   MV_TITLE_SEC で変えられる。第2版は 3.2 で走らせている。
T_TOTAL = float(os.environ.get('MV_TITLE_SEC', '5.0'))
T_FADE_IN = (0.15, 1.05)                        # 浮かび上がる
T_FADE_OUT = (T_TOTAL - 0.95, T_TOTAL)          # 消える
SCALE_FROM, SCALE_TO = 1.055, 1.0   # ゆっくり収まる


def serif(size, weight=900):
    f = ImageFont.truetype(SERIF, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass  # 可変に対応していない環境では既定の太さで出す
    return f


def gothic(size):
    return ImageFont.truetype(GOTHIC, size)


def draw_tracked(layer, top, text, fnt, fill, track=0.0):
    """字間を広げて中央に描く。

    PIL には字間の指定が無いので1文字ずつ置く。
    詰まった題字は安っぽく見えるので、ここは手で広げる。

    ★ 基準線(ベースライン)で置くこと。
      最初は anchor='lt'(上ぞろえ)で置いたら、読点「、」と長音「ー」だけが
      浮き上がって「する｀多人数」「ゲ￣ム」と読めてしまった。
      字の高さは文字ごとに違うので、上でそろえてはいけない。
    """
    d = ImageDraw.Draw(layer)
    ascent, _ = fnt.getmetrics()
    baseline = top + ascent
    widths = [d.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + track * (len(text) - 1)
    x = (layer.width - total) / 2
    for ch, w in zip(text, widths):
        d.text((x, baseline), ch, font=fnt, fill=fill, anchor='ls')
        x += w + track


def gradient_fill(mask, top_rgb, bottom_rgb):
    """字の中を上から下へ色を流す。単色より高級に見える。"""
    w, h = mask.size
    grad = Image.new('RGB', (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(a + (b - a) * t) for a, b in zip(top_rgb, bottom_rgb))
    grad = grad.resize((w, h)).convert('RGBA')
    grad.putalpha(mask.getchannel('A'))
    return grad


def glow(layer, radius, strength=1.0):
    g = layer.filter(ImageFilter.GaussianBlur(radius))
    if strength != 1.0:
        g.putalpha(g.getchannel('A').point(lambda v: min(255, int(v * strength))))
    return g


def build_title_art():
    """題名の絵を1枚だけ作る(SS倍)。動きは後でこれを縮めて付ける。"""
    w, h = W * SS, H * SS
    f_title = serif(112 * SS, 900)
    f_sub = serif(46 * SS, 700)
    f_tag = gothic(25 * SS)

    # 本題。字間は文字サイズの 18% ほど空ける。
    mask = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw_tracked(mask, h * 0.27, TITLE, f_title, (255, 255, 255, 255), track=112 * SS * 0.18)
    body = gradient_fill(mask, (255, 255, 255), (206, 186, 255))

    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    # 光は2段。遠くの淡い光で浮かせ、近くの強い光で縁を締める。
    for g in (glow(mask, 40 * SS // 2, 0.85), glow(mask, 40 * SS // 2, 0.85),
              glow(mask, 9 * SS, 1.0)):
        out.alpha_composite(g)
    out.alpha_composite(body)

    sub = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw_tracked(sub, h * 0.27 + 150 * SS, SUBTITLE, f_sub, (222, 200, 255, 255),
                 track=46 * SS * 0.16)
    out.alpha_composite(glow(sub, 10 * SS, 0.9))
    out.alpha_composite(sub)

    tag = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw_tracked(tag, h * 0.27 + 240 * SS, TAGLINE, f_tag, (238, 238, 248, 255),
                 track=25 * SS * 0.10)
    out.alpha_composite(glow(tag, 6 * SS, 0.85))
    out.alpha_composite(tag)
    return out


def ease_out(t):
    """終わりに向けてゆっくり止まる。等速だと機械的に見える。"""
    return 1 - (1 - t) ** 3


def make_title_sequence():
    art = build_title_art()
    if os.path.isdir(SEQ_DIR):
        shutil.rmtree(SEQ_DIR)
    os.makedirs(SEQ_DIR)

    n = int(T_TOTAL * FPS)
    for i in range(n):
        t = i / FPS
        # 大きさ: 少し大きい所からゆっくり収まる
        p = min(1.0, t / 1.3)
        scale = SCALE_FROM + (SCALE_TO - SCALE_FROM) * ease_out(p)
        # 濃さ: 浮かび上がって、最後に消える
        if t < T_FADE_IN[0]:
            a = 0.0
        elif t < T_FADE_IN[1]:
            a = ease_out((t - T_FADE_IN[0]) / (T_FADE_IN[1] - T_FADE_IN[0]))
        elif t < T_FADE_OUT[0]:
            a = 1.0
        elif t < T_FADE_OUT[1]:
            a = 1.0 - ease_out((t - T_FADE_OUT[0]) / (T_FADE_OUT[1] - T_FADE_OUT[0]))
        else:
            a = 0.0

        sw, sh = int(art.width * scale), int(art.height * scale)
        f = art.resize((sw, sh), Image.LANCZOS)
        canvas = Image.new('RGBA', art.size, (0, 0, 0, 0))
        canvas.alpha_composite(f, ((art.width - sw) // 2, (art.height - sh) // 2))
        canvas = canvas.resize((W, H), Image.LANCZOS)
        if a < 1.0:
            canvas.putalpha(canvas.getchannel('A').point(
                lambda v: int(v * a)))
        canvas.save(os.path.join(SEQ_DIR, f'{i:04d}.png'))
    return n


def bottom_shade(height_ratio=0.42, strength=170):
    """画面の下に暗い帯を敷く。

    締めの絵は夜明けの光で床が明るく、白い文字がそのままだと沈む。
    光だけで浮かせようとしたら著作権表示がほとんど読めなかった。
    """
    band = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    top = int(H * (1 - height_ratio))
    px = band.load()
    for y in range(top, H):
        t = (y - top) / max(1, H - top)
        a = int(strength * (t ** 1.6))
        for x in range(W):
            px[x, y] = (0, 0, 12, a)
    return band


def make_end():
    out = bottom_shade()
    f_url = serif(44, 800)
    f_c = gothic(24)

    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw_tracked(layer, H * 0.755, URL, f_url, (255, 255, 255, 255), track=1.5)
    for g in (glow(layer, 26, 0.9), glow(layer, 8, 1.0)):
        out.alpha_composite(g)
    out.alpha_composite(layer)

    c = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw_tracked(c, H * 0.865, COPYRIGHT, f_c, (226, 226, 240, 255), track=0.8)
    for g in (glow(c, 10, 0.9), glow(c, 4, 1.0)):
        out.alpha_composite(g)
    out.alpha_composite(c)

    p = os.path.join(OUT_DIR, 'end.png')
    out.save(p)
    return p


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    n = make_title_sequence()
    print(f'✓ 題名 {n}コマ  {SEQ_DIR}')
    print('✓', make_end())

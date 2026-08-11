# OGP画像(SNSでリンクを貼った時に出るカード)を作る
#
# X・Discord・LINE などにURLを貼ると、この画像がカードとして表示される。
# 無いと素っ気ない文字だけのリンクになり、クリックされる率が大きく落ちる。
#
#   python gen_ogp.py
#
# 出力: public/img/ogp.png (1200x630 / X の推奨比 1.91:1)

import os
import sys

TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG = os.path.join(PROJECT, 'public', 'img')

W, H = 1200, 630

FONT_B = r'C:\Windows\Fonts\meiryob.ttc'
FONT_R = r'C:\Windows\Fonts\meiryo.ttc'


def font(path, size):
    return ImageFont.truetype(path, size)


def fit(im, w, h):
    """縦横比を保ったまま、指定の枠を覆うように拡大して切り抜く。"""
    r = max(w / im.width, h / im.height)
    im = im.resize((int(im.width * r), int(im.height * r)), Image.LANCZOS)
    x = (im.width - w) // 2
    y = (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def scaled(path, height):
    im = Image.open(path).convert('RGBA')
    r = height / im.height
    return im.resize((max(1, int(im.width * r)), height), Image.LANCZOS)


def radial(size):
    """中心が明るく四隅が黒い円形のマスク。四角い縁を消すのに使う。"""
    w, h = size
    m = Image.new('L', size, 0)
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, w - 1, h - 1], fill=255)
    return m.filter(ImageFilter.GaussianBlur(max(3, w // 10)))


def glow(im, color, blur=18, alpha=150):
    """素材の背後に淡い光を敷く。暗い背景で輪郭が沈むのを防ぐ。"""
    a = im.split()[3].filter(ImageFilter.GaussianBlur(blur))
    g = Image.new('RGBA', im.size, color + (0,))
    g.putalpha(a.point(lambda v: int(v * alpha / 255)))
    return g


def main():
    # 背景: ゲーム内の草原を暗く落として使う(文字を読ませるため)
    bg = fit(Image.open(os.path.join(IMG, 'bg', 'field.jpg')).convert('RGB'), W, H)
    bg = bg.filter(ImageFilter.GaussianBlur(3))
    dark = Image.new('RGB', (W, H), (10, 8, 24))
    bg = Image.blend(bg, dark, 0.62)
    canvas = bg.convert('RGBA')

    # 左側だけさらに暗くして、文字の下地を作る
    shade = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(shade)
    for x in range(0, 760):
        a = int(190 * (1 - x / 760) ** 1.2)
        d.line([(x, 0), (x, H)], fill=(8, 6, 20, a))
    canvas = Image.alpha_composite(canvas, shade)

    # 右側にキャラと敵を配置
    player = scaled(os.path.join(IMG, 'player', '1.png'), 420)
    enemy = scaled(os.path.join(IMG, 'enemy', 'golem.png'), 330)

    px, py = 660, H - 420 - 40
    ex, ey = 895, H - 330 - 58
    for im, (x, y), col in ((enemy, (ex, ey), (120, 90, 200)),
                            (player, (px, py), (150, 120, 255))):
        canvas.alpha_composite(glow(im, col), (x, y))
        canvas.alpha_composite(im, (x, y))

    # 属性の弾を散らして、魔法らしさを出す。
    # 弾の素材は暗い部分にも薄く色が残っているので、普通に重ねると四角く浮いてしまう。
    # 明るい分だけを足す合成にすると、暗い部分が背景に溶けて光だけが残る。
    layer = Image.new('RGB', canvas.size, (0, 0, 0))
    for name, (x, y), h in (('fire', (612, 96), 88), ('ice', (1016, 74), 74),
                            ('thunder', (1108, 300), 68)):
        p = scaled(os.path.join(IMG, 'proj', f'{name}.png'), h)
        # 暗い画素ほど黒へ寄せたうえ、四隅を円形に減光する。
        # 弾の素材は正方形の隅にも薄く色が残っていて、そのままだと四角い縁が出る。
        lum = p.convert('L').point(lambda v: int(255 * (v / 255) ** 0.7))
        lum = ImageChops.multiply(lum, radial(p.size))
        rgb = ImageChops.multiply(p.convert('RGB'), Image.merge('RGB', (lum, lum, lum)))
        layer.paste(ImageChops.screen(layer.crop((x, y, x + p.width, y + p.height)), rgb),
                    (x, y))
    canvas = ImageChops.screen(canvas.convert('RGB'), layer).convert('RGBA')

    canvas = canvas.convert('RGBA')
    d = ImageDraw.Draw(canvas)

    def text(xy, s, f, fill, shadow=(0, 0, 0, 210), off=3):
        d.text((xy[0] + off, xy[1] + off), s, font=f, fill=shadow)
        d.text(xy, s, font=f, fill=fill)

    text((64, 96), '魔導研究記', font(FONT_B, 92), (238, 226, 255, 255))
    text((66, 208), '《まどけん》', font(FONT_B, 52), (198, 170, 255, 255))

    # 帯を敷いた一行説明
    d.rounded_rectangle([62, 300, 700, 356], 10, fill=(28, 22, 56, 225),
                        outline=(120, 92, 200, 230), width=2)
    text((82, 311), '8つのエレメントを調合して、魔法を"発見"する',
         font(FONT_B, 27), (226, 214, 255, 255), off=2)

    f = font(FONT_R, 26)
    for i, line in enumerate([
        'レシピは非公開。組み合わせを試して見つけ出す',
        '隠された系統は29種。仲間と共闘、研究者と決闘',
    ]):
        text((66, 376 + i * 40), '　' + line, f, (200, 192, 226, 255), off=2)

    d.rounded_rectangle([62, 480, 470, 546], 12, fill=(88, 54, 168, 235),
                        outline=(186, 150, 255, 240), width=3)
    text((92, 495), 'ブラウザで無料・登録不要', font(FONT_B, 32),
         (255, 250, 255, 255), off=2)

    text((66, 566), 'madoken.onrender.com', font(FONT_B, 30),
         (176, 210, 255, 255), off=2)

    # ★ 2か所へ書き出すこと(2026-08-11)。
    #   public/img/ogp.png … ゲーム本体(madoken.onrender.com)が使う
    #   docs/ogp.png       … 入口ページ(towa219.github.io/madoken/)が使う
    #   以前は public 側だけ書き出しており、系統数を29へ直した時に
    #   入口側だけ28のまま古い絵が残った。共有で出るのは入口側なので、
    #   直したつもりで古いカードが出続けることになる。
    rgb = canvas.convert('RGB')
    for out in (os.path.join(IMG, 'ogp.png'),
                os.path.join(PROJECT, 'docs', 'ogp.png')):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        rgb.save(out, quality=95)
        print(f'{out}  {W}x{H}  {os.path.getsize(out) / 1024:.0f} KB')


if __name__ == '__main__':
    main()

# public/img/ にある画像を一覧の1枚にまとめて、目視確認しやすくする。
#   python sheet.py [出力先.png]

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG_DIR = os.path.join(PROJECT, 'public', 'img')
TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

from PIL import Image, ImageDraw  # noqa: E402

CELL = 240
PAD = 14
LABEL = 20
COLS = 6
BG = (34, 34, 48, 255)
GRID = (58, 58, 80, 255)


def collect():
    items = []
    p = os.path.join(IMG_DIR, 'player.png')
    if os.path.exists(p):
        items.append(('player', p))
    for sub, prefix in (('enemy', ''), ('proj', '')):
        d = os.path.join(IMG_DIR, sub)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.endswith('.png'):
                    items.append((f'{sub}/{f[:-4]}', os.path.join(d, f)))
    return items


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sheet.png')
    items = collect()
    if not items:
        print('public/img/ に画像がまだ無い。')
        return
    rows = (len(items) + COLS - 1) // COLS
    w = COLS * (CELL + PAD) + PAD
    h = rows * (CELL + LABEL + PAD) + PAD
    canvas = Image.new('RGBA', (w, h), BG)
    draw = ImageDraw.Draw(canvas)

    for i, (name, path) in enumerate(items):
        cx = PAD + (i % COLS) * (CELL + PAD)
        cy = PAD + (i // COLS) * (CELL + LABEL + PAD)
        draw.rectangle([cx, cy, cx + CELL, cy + CELL], outline=GRID)
        im = Image.open(path).convert('RGBA')
        s = min(CELL / im.width, CELL / im.height)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                       Image.LANCZOS)
        canvas.alpha_composite(
            im, (cx + (CELL - im.width) // 2, cy + CELL - im.height))
        draw.text((cx + 4, cy + CELL + 4), name, fill=(220, 220, 240))

    canvas.convert('RGB').save(out)
    print(f'{out} に {len(items)} 枚をまとめた。')


if __name__ == '__main__':
    main()

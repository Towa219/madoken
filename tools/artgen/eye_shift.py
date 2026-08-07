# 黒目(虹彩)だけを横にずらして、視線の向きを変える。
#
# 絵を描き直さずに視線を直したい時に使う。FLUX に視線を指示すると
# 顔の向き・体の向き・衣装まで全部引き直されてしまい、視線以外が
# 変わってしまうため(実際に「完全に右を向いてしまった」ことがある)。
#
#   python eye_shift.py player/3.png                … 黒目の幅の15%だけ右へ
#   python eye_shift.py player/3.png --dx 3         … 画素数で指定する
#   python eye_shift.py player/3.png --dry          … 書き込まずに測るだけ
#
# やっていること:
#   1. 目の色の画素をかたまりに分け、顔の位置・大きさから「目」を選ぶ
#   2. 穴(瞳孔・ハイライト)を埋めて「黒目まるごと」の形を作る
#   3. その輪郭は動かさず、中身(瞳孔・ハイライト・陰)だけを右へ寄せる
#
# 黒目まるごと動かすやり方は捨てた。この絵柄は黒目が目のほぼ全部を占めていて
# 白目が3〜5画素しか無く、動かすと目尻で黒目が削れて輪郭が欠ける。

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG_DIR = os.path.join(PROJECT, 'public', 'img')

TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

MIN_AREA = 25       # これより小さいかたまりは目ではない(髪の艶や小物)


def hsv(a):
    """RGB(0-255)の配列から 明度(0-1)と 彩度(0-1)を出す。"""
    mx = a[..., :3].max(2).astype(float)
    mn = a[..., :3].min(2).astype(float)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0.0)
    return mx / 255.0, sat


def iris_mask(a, color):
    """黒目(虹彩)の色をした画素。

    髪や衣装にも同じ系統の色が使われることがあるので、ここでは
    色だけで拾い、かたまりの大きさと位置で後から絞り込む。
    """
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    al = a[..., 3]
    _, sat = hsv(a)
    if color == 'green':
        return (al > 200) & (sat > 0.30) & (g > 60) & (r < g - 30) & (b < g - 10)
    if color == 'blue':
        return (al > 200) & (sat > 0.30) & (b > 60) & (r < b - 30) & (g < b - 10)
    if color == 'red':
        return (al > 200) & (sat > 0.30) & (r > 60) & (g < r - 30) & (b < r - 30)
    raise SystemExit(f'知らない目の色: {color}')


def label(mask):
    """4近傍のかたまり分け(scipy を使わずに済ませる)。"""
    h, w = mask.shape
    lab = np.zeros((h, w), int)
    cur = 0
    for y0 in range(h):
        for x0 in range(w):
            if not mask[y0, x0] or lab[y0, x0]:
                continue
            cur += 1
            stack = [(y0, x0)]
            lab[y0, x0] = cur
            while stack:
                y, x = stack.pop()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] \
                            and not lab[ny, nx]:
                        lab[ny, nx] = cur
                        stack.append((ny, nx))
    return lab, cur


def fill_holes(m):
    """かたまりの内側の穴を埋める(瞳孔とハイライトを黒目に含める)。

    外側から届く「穴でない所」を塗りつぶし、残りが内側の穴。
    """
    h, w = m.shape
    out = ~m
    reach = np.zeros((h, w), bool)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if out[y, x]:
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if out[y, x]:
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        if reach[y, x] or not out[y, x]:
            continue
        reach[y, x] = True
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and out[ny, nx] and not reach[ny, nx]:
                stack.append((ny, nx))
    return m | (out & ~reach)


def shift_eye(a, eye, dx):
    """黒目の輪郭は動かさず、中身(瞳孔・ハイライト・陰)だけを dx 画素ずらす。

    黒目まるごと動かすやり方は捨てた。この絵柄は黒目が目のほぼ全部を
    占めていて白目が3〜5画素しかなく、動かすと黒目が目尻で削れて
    輪郭が欠ける。境目のぼかし画素も取り残されて汚くなる。

    そこで輪郭はそのままに、中の模様だけを寄せる。行ごとに
    「黒目の左端より外を指したら左端の色を使う」で埋めるので、
    欠けもにじみも出ない。
    """
    src = a.copy()
    moved = 0
    for y in range(eye.shape[0]):
        row = np.nonzero(eye[y])[0]
        if len(row) == 0:
            continue
        left = row[0]
        for x in row:
            sx = max(left, x - dx)          # 左端より外は左端の色で埋める
            if sx != x:
                a[y, x] = src[y, sx]
                moved += 1
    return moved


def process(path, color, dx, ratio, dry):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(np.uint8).copy()
    m = iris_mask(a, color)
    lab, n = label(m)

    eyes = []
    for i in range(1, n + 1):
        blob = lab == i
        area = int(blob.sum())
        if area < MIN_AREA:
            continue
        ys, xs = np.nonzero(blob)
        eyes.append((area, blob, xs.min(), xs.max(), ys.min(), ys.max()))
    if not eyes:
        print(f'  {os.path.basename(path)}: 目が見つからない')
        return False

    # 目は上の方(顔)にある。いちばん大きいかたまりの高さを基準にして、
    # そこから離れた所にある同じ色のかたまり(衣装の飾りなど)は外す。
    eyes.sort(key=lambda e: -e[0])
    base_y = (eyes[0][4] + eyes[0][5]) / 2
    eyes = [e for e in eyes if abs((e[4] + e[5]) / 2 - base_y) <= 12][:2]

    total = 0
    for area, blob, x0, x1, y0, y1 in sorted(eyes, key=lambda e: e[2]):
        eye = fill_holes(blob)
        # 黒目の幅に対する割合でずらす。左右の目は大きさが違うので、
        # 同じ画素数だけ動かすと小さい方だけ寄りすぎて寄り目になる。
        step = dx if dx else max(1, round((x1 - x0 + 1) * ratio))
        print(f'    目 x{x0}-{x1} y{y0}-{y1} 幅{x1 - x0 + 1}px 面積{area}'
              f' → 中身を{step:+}px')
        if not dry:
            total += shift_eye(a, eye, step)

    if dry:
        return False
    Image.fromarray(a).save(path)
    print(f'  {os.path.basename(path)}: 黒目を右へずらした({total}px 描き替え)')
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+', help='public/img からの相対パス')
    ap.add_argument('--color', default='green', help='目の色 green/blue/red')
    ap.add_argument('--dx', type=int, default=0,
                    help='右へずらす画素数(0なら --ratio から決める)')
    ap.add_argument('--ratio', type=float, default=0.15,
                    help='黒目の幅に対する割合でずらす(既定 0.15)')
    ap.add_argument('--dry', action='store_true', help='測るだけで書き込まない')
    args = ap.parse_args()

    for rel in args.files:
        path = os.path.join(IMG_DIR, rel.replace('/', os.sep))
        if not os.path.exists(path):
            raise SystemExit(f'見つからない: {path}')
        print(f'  {rel}')
        process(path, args.color, args.dx, args.ratio, args.dry)


if __name__ == '__main__':
    main()

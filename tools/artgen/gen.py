# 魔導研究記 画像素材ジェネレータ
#
# ComfyUI(ローカル)で画像を生成し、背景を透過して、public/img/ に
# 所定の名前で保存する。生成できた分だけ manifest.json に登録するので、
# 途中まででも問題なく動く(登録されていないものは図形描画のまま)。
#
# 使い方(ComfyUI を起動した状態で):
#   python gen.py --only player:1        … 1枚だけ試す(1〜5)
#   python gen.py --only enemy:blob
#   python gen.py --all                  … 全24枚
#   python gen.py --manifest             … 今ある画像で manifest.json を作り直すだけ

import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG_DIR = os.path.join(PROJECT, 'public', 'img')

# rembg などは ComfyUI 本体を汚さないよう別フォルダに入れてある
TOOLS_DIR = os.environ.get('ARTGEN_TOOLS', r'D:\ComfyUI\_tools')
if os.path.isdir(TOOLS_DIR):
    sys.path.insert(0, TOOLS_DIR)

SERVER = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
CKPT = os.environ.get('COMFY_CKPT', 'animagine-xl-4.0-opt.safetensors')

# Animagine XL 4.0 の推奨設定に沿った共通指定
QUALITY = 'masterpiece, high score, great score, absurdres, very aesthetic'
NEGATIVE = (
    'lowres, bad anatomy, bad hands, text, error, missing finger, '
    'extra digits, fewer digits, cropped, worst quality, low quality, '
    'low score, bad score, average score, signature, watermark, username, '
    'blurry, jpeg artifacts, multiple views, border, frame, '
    # 背景が描き込まれると切り抜きに巻き込まれるので強く禁止する
    'scenery, detailed background, gradient background, moon, sky, clouds, '
    'landscape, indoors, outdoors, ground, floor, cast shadow, '
    # シルエットになると立ち絵として使えない
    'silhouette, backlighting, underlighting, dark, overly dark, '
    'multiple girls, multiple boys, 2girls, 2boys'
)
# 背景を確実に切り抜けるよう、単色背景で描かせる(Danbooru タグで指定するのが最も効く)
FLAT_BG = 'simple background, white background, solo, even lighting, clearly visible details'

# 弾は輪郭を持たない光のかたまりなので、キャラ用の切り抜きが効かない。
# 黒背景で描かせ、明るさをそのまま不透明度に使う(エフェクト素材の定石)。
BLACK_BG = 'black background, simple background, glowing, luminous, dark background'
PROJ_NEGATIVE = (
    'lowres, worst quality, low quality, low score, bad score, '
    'signature, watermark, username, blurry, jpeg artifacts, '
    'border, frame, text, '
    '1girl, 1boy, person, character, hands, '
    'white background, scenery, detailed background, '
    # 小さく描画するので、1発だけが大きく中央に写っている必要がある
    'multiple objects, many objects, cluster, repeated, collage, '
    'full frame effect, wide shot'
)

# 戦闘背景だけは風景を描かせたいので、専用の否定指定を使う
BG_NEGATIVE = (
    'lowres, worst quality, low quality, low score, bad score, '
    'signature, watermark, username, blurry, jpeg artifacts, '
    'border, frame, text, '
    # 背景に人物や敵がいると戦闘画面で邪魔になる
    '1girl, 1boy, person, people, character, monster, creature, '
    'simple background, white background'
)

STEPS = 28
CFG = 5.0
SAMPLER = 'euler_ancestral'
SCHEDULER = 'normal'

ENEMY_HEIGHT = 320      # 出力する敵画像の高さ(実表示の約2倍で用意して滲みを防ぐ)
PROJ_SIZE = 128         # 弾は正方形キャンバスの中央に置く


def load_subjects():
    with open(os.path.join(HERE, 'subjects.json'), encoding='utf-8') as f:
        return json.load(f)


# ===== ComfyUI API =====

def post_prompt(workflow):
    data = json.dumps({'prompt': workflow}).encode('utf-8')
    req = urllib.request.Request(
        SERVER + '/prompt', data=data,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())['prompt_id']


def wait_images(prompt_id, timeout=600):
    """生成完了を待って、画像のバイト列を返す。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                    SERVER + '/history/' + prompt_id, timeout=30) as res:
                hist = json.loads(res.read())
        except Exception:
            time.sleep(1.0)
            continue
        entry = hist.get(prompt_id)
        if entry and entry.get('outputs'):
            out = []
            for node in entry['outputs'].values():
                for im in node.get('images', []):
                    q = urllib.parse.urlencode({
                        'filename': im['filename'],
                        'subfolder': im.get('subfolder', ''),
                        'type': im.get('type', 'output'),
                    })
                    with urllib.request.urlopen(
                            SERVER + '/view?' + q, timeout=60) as r2:
                        out.append(r2.read())
            if out:
                return out
        time.sleep(1.0)
    raise TimeoutError('ComfyUI の生成が時間内に終わらなかった')


def build_workflow(prompt, width, height, seed, negative=NEGATIVE):
    return {
        '4': {'class_type': 'CheckpointLoaderSimple',
              'inputs': {'ckpt_name': CKPT}},
        '5': {'class_type': 'EmptyLatentImage',
              'inputs': {'width': width, 'height': height, 'batch_size': 1}},
        '6': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': prompt, 'clip': ['4', 1]}},
        '7': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': negative, 'clip': ['4', 1]}},
        '3': {'class_type': 'KSampler',
              'inputs': {'seed': seed, 'steps': STEPS, 'cfg': CFG,
                         'sampler_name': SAMPLER, 'scheduler': SCHEDULER,
                         'denoise': 1.0, 'model': ['4', 0],
                         'positive': ['6', 0], 'negative': ['7', 0],
                         'latent_image': ['5', 0]}},
        '8': {'class_type': 'VAEDecode',
              'inputs': {'samples': ['3', 0], 'vae': ['4', 2]}},
        '9': {'class_type': 'SaveImage',
              'inputs': {'filename_prefix': 'madoken', 'images': ['8', 0]}},
    }


# ===== 後処理 =====

_session = None


def cutout(img):
    """背景を透過する。アニメ絵に強い isnet-anime を使う。"""
    global _session
    from rembg import new_session, remove
    if _session is None:
        _session = new_session('isnet-anime')
    return remove(img, session=_session).convert('RGBA')


def luma_cutout(img):
    """黒背景で描かせた光り物を、明るさ = 不透明度として切り抜く。
    輪郭を持たない炎や稲妻でも、光の減衰がそのまま自然な半透明になる。"""
    import numpy as np
    from PIL import Image
    rgb = np.asarray(img.convert('RGB')).astype(np.float32)
    lum = rgb.max(axis=2)
    floor = 14.0  # これ以下は完全な黒 = 背景とみなす
    alpha = np.clip((lum - floor) / (255.0 - floor), 0.0, 1.0) ** 0.75
    # 暗い縁に黒がにじまないよう、色は明るさで正規化して持ち上げる
    scale = np.maximum(lum, 1.0)[..., None]
    boosted = np.clip(rgb / scale * np.maximum(lum, 40.0)[..., None], 0, 255)
    out = np.concatenate([boosted, (alpha * 255.0)[..., None]], axis=2)
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def check_cutout(img, ident):
    """切り抜きに失敗して背景の四角が残っていないか調べる。
    生成物によっては背景が subject と誤認されるので、見落とさないよう警告する。"""
    import numpy as np
    a = np.asarray(img.convert('RGBA'))[..., 3]
    opaque = float((a > 200).mean())
    corners = [a[0, 0], a[0, -1], a[-1, 0], a[-1, -1]]
    if opaque > 0.85 or sum(int(c) > 200 for c in corners) >= 3:
        print(f'  ※ 警告: {ident} は背景を切り抜けていない可能性が高い'
              f'(不透明 {opaque * 100:.0f}%)。別の seed で作り直すこと。')
        return False
    return True


def check_centered(img, ident):
    """絵が左右どちらかに寄りすぎていないか調べる。

    頭上のHPバーと名前は画像の中心に置かれる。翼を広げた鳥のように
    「本体は右端・左半分は全部翼」という構図だと、バーが本体から外れて見える。
    """
    import numpy as np
    a = np.asarray(img.convert('RGBA'))[..., 3].astype(float)
    col = a.sum(axis=0)
    if col.sum() <= 0:
        return True
    com = float((col * np.arange(len(col))).sum() / col.sum())
    off = (com - img.width / 2) / img.width  # 幅に対する割合
    if abs(off) > 0.08:
        side = '左' if off < 0 else '右'
        print(f'  ※ 警告: {ident} は絵が{side}に寄っている(中心から {off * 100:+.0f}%)。'
              'HPバーが本体からずれて見えるので、構図を変えるか seed を引き直すこと。')
        return False
    return True


def trim(img, thresh=16):
    """透明な余白を落とす。

    ※ img.getbbox() を使ってはいけない。白背景で描かせているため、
      透明部分にも RGB=白 が残っており、色を見る getbbox() は画像全体を返す。
      その結果「余白ごと目標の高さに縮小」されてキャラが小さくなり、
      さらに中身が片寄っている画像では頭上のHPバーが横にずれる。
      不透明度だけで判定すること。
    """
    import numpy as np
    a = np.asarray(img.convert('RGBA'))[..., 3]
    m = a > thresh
    rows = np.where(m.any(axis=1))[0]
    cols = np.where(m.any(axis=0))[0]
    if len(rows) == 0 or len(cols) == 0:
        return img
    return img.crop((int(cols[0]), int(rows[0]),
                     int(cols[-1]) + 1, int(rows[-1]) + 1))


def fit_height(img, target_h):
    w, h = img.size
    if h == 0:
        return img
    from PIL import Image
    return img.resize(
        (max(1, round(w * target_h / h)), target_h), Image.LANCZOS)


def center_square(img, size):
    from PIL import Image
    w, h = img.size
    scale = size / max(w, h)
    img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                     Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    return canvas


def maybe_flip(img, subj, ident):
    """向きが逆に描かれたものを左右反転する。
    プレイヤーは右向き・敵は左向きが正しい(subjects.json の flip で指定)。"""
    from PIL import Image
    if ident in subj.get('flip', []):
        print(f'  左右反転: {ident}')
        return img.transpose(Image.FLIP_LEFT_RIGHT)
    return img


def save(img, rel):
    path = os.path.join(IMG_DIR, rel.replace('/', os.sep))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if path.lower().endswith(('.jpg', '.jpeg')):
        # 背景は透過が要らないので JPEG にして軽くする(PNG の 1/7 程度になる)
        img.convert('RGB').save(path, quality=88, optimize=True)
    else:
        img.save(path)
    print(f'  保存: public/img/{rel}  ({img.width}x{img.height})')
    return path


# ===== 各種類の生成 =====

def generate(prompt, width, height, seed, negative=NEGATIVE):
    from PIL import Image
    wf = build_workflow(prompt, width, height, seed, negative)
    blobs = wait_images(post_prompt(wf))
    return Image.open(io.BytesIO(blobs[0])).convert('RGB')


def gen_player(subj, num, seed):
    """プレイヤーキャラを1体作る(num は 1〜5)。"""
    s = subj['players'][num - 1]
    print(f"プレイヤー{num}「{s.get('name', '')}」を生成中…")
    p = f"{QUALITY}, {subj['style']}, {s['prompt']}, {FLAT_BG}"
    img = generate(p, 832, 1216, seed)
    cut = cutout(img)
    check_cutout(cut, f'player:{num}')
    out = maybe_flip(fit_height(trim(cut), s.get('height', 400)),
                     subj, f'player:{num}')
    check_centered(out, f'player:{num}')
    return save(out, s['out'])


def gen_enemy(subj, key, seed):
    print(f'敵「{key}」を生成中…')
    p = f"{QUALITY}, {subj['style']}, {subj['enemies'][key]}, {FLAT_BG}"
    # 別の敵と絵柄が被るときは、その敵だけ追加で否定指定できる
    extra = subj.get('negative', {}).get(f'enemy:{key}')
    neg = f'{NEGATIVE}, {extra}' if extra else NEGATIVE
    img = generate(p, 1024, 1024, seed, neg)
    cut = cutout(img)
    check_cutout(cut, f'enemy:{key}')
    out = maybe_flip(fit_height(trim(cut), ENEMY_HEIGHT),
                     subj, f'enemy:{key}')
    check_centered(out, f'enemy:{key}')
    return save(out, f'enemy/{key}.png')


def gen_proj(subj, key, seed):
    print(f'弾「{key}」を生成中…')
    p = (f"{QUALITY}, {subj['style']}, {subj['projectiles'][key]}, "
         f'single object, one orb, centered, isolated, close-up, '
         f'magical energy effect, {BLACK_BG}')
    img = generate(p, 1024, 1024, seed, PROJ_NEGATIVE)
    return save(center_square(trim(luma_cutout(img)), PROJ_SIZE),
                f'proj/{key}.png')


def gen_background(subj, seed):
    from PIL import ImageEnhance, ImageFilter, Image
    s = subj['background']
    print('戦闘背景を生成中…')
    p = f"{QUALITY}, {subj['style']}, {s['prompt']}"
    img = generate(p, s['width'], s['height'], seed, BG_NEGATIVE)
    img = img.convert('RGB').resize(
        (s['final_width'], s['final_height']), Image.LANCZOS)

    # 背景はそのままだと明るすぎ・情報量が多すぎて、キャラとHPバーが読めなくなる。
    # 必ず暗く・少しぼかして「背景に徹する」状態にしてから使う。
    blur = float(s.get('blur', 1.4))
    if blur > 0:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    img = ImageEnhance.Color(img).enhance(float(s.get('saturation', 0.72)))
    img = ImageEnhance.Brightness(img).enhance(float(s.get('darken', 0.5)))
    img = ImageEnhance.Contrast(img).enhance(float(s.get('contrast', 0.88)))
    return save(img, s['out'])


# ===== manifest =====

def write_manifest(subj):
    """実際に置かれている画像だけを manifest.json に登録する。"""
    m = {}
    # プレイヤーは選択できるので、置かれている番号だけ順に並べる
    players = [s['out'] for s in subj['players']
               if os.path.exists(os.path.join(IMG_DIR, s['out'].replace('/', os.sep)))]
    if players:
        m['players'] = players
    bg = subj['background']['out']
    if os.path.exists(os.path.join(IMG_DIR, bg.replace('/', os.sep))):
        m['background'] = bg
    en = {k: f'enemy/{k}.png' for k in subj['enemies']
          if os.path.exists(os.path.join(IMG_DIR, 'enemy', f'{k}.png'))}
    pr = {k: f'proj/{k}.png' for k in subj['projectiles']
          if os.path.exists(os.path.join(IMG_DIR, 'proj', f'{k}.png'))}
    if en:
        m['enemies'] = en
    if pr:
        m['projectiles'] = pr
    path = os.path.join(IMG_DIR, 'manifest.json')
    if not m:
        if os.path.exists(path):
            os.remove(path)
        print('画像が1枚も無いため manifest.json は作らなかった(図形描画のまま)。')
        return
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    total = len(en) + len(pr) + len(players) + ('background' in m)
    print(f'manifest.json を更新した(登録 {total} 枚 / 全28枚)。')


# ===== main =====

def retrim_existing():
    """すでにある画像の透明な余白だけを落とす(絵は作り直さない)。

    余白が残っていると、その分キャラが小さく表示され、頭上のHPバーもずれる。
    絵柄を変えずに直せるので、作り直しより先にこれを試すこと。
    """
    from PIL import Image
    targets = []
    for sub in ('player', 'enemy', 'proj'):
        d = os.path.join(IMG_DIR, sub)
        if os.path.isdir(d):
            targets += [os.path.join(d, f) for f in sorted(os.listdir(d))
                        if f.endswith('.png')]
    for path in targets:
        if not os.path.exists(path):
            continue
        im = Image.open(path).convert('RGBA')
        cut = trim(im)
        if cut.size == im.size:
            print(f'  余白なし: {os.path.basename(path)}')
            continue
        cut.save(path)
        print(f'  余白を除去: {os.path.basename(path)}  '
              f'{im.width}x{im.height} → {cut.width}x{cut.height}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only',
                    help='player:1 / background / enemy:blob / proj:fire')
    ap.add_argument('--all', action='store_true', help='全24枚を生成')
    ap.add_argument('--manifest', action='store_true',
                    help='生成せず manifest.json だけ作り直す')
    ap.add_argument('--retrim', action='store_true',
                    help='生成せず、既存画像の透明な余白だけ落とす')
    ap.add_argument('--seed', type=int, default=1234)
    args = ap.parse_args()

    subj = load_subjects()

    if args.retrim:
        retrim_existing()
        return

    if args.manifest:
        write_manifest(subj)
        return

    if not args.only and not args.all:
        ap.error('--only か --all か --manifest を指定する')

    t0 = time.time()
    if args.only:
        k = args.only
        if k.startswith('player:'):
            gen_player(subj, int(k.split(':', 1)[1]), args.seed)
        elif k == 'background':
            gen_background(subj, args.seed)
        elif k.startswith('enemy:'):
            gen_enemy(subj, k.split(':', 1)[1], args.seed)
        elif k.startswith('proj:'):
            gen_proj(subj, k.split(':', 1)[1], args.seed)
        else:
            ap.error(f'不明な指定: {k}')
    else:
        for i in range(len(subj['players'])):
            gen_player(subj, i + 1, args.seed + i)
        gen_background(subj, args.seed + 1)
        for i, key in enumerate(subj['enemies']):
            gen_enemy(subj, key, args.seed + 10 + i)
        for i, key in enumerate(subj['projectiles']):
            gen_proj(subj, key, args.seed + 100 + i)

    write_manifest(subj)
    print(f'完了({time.time() - t0:.1f}秒)。')


if __name__ == '__main__':
    main()

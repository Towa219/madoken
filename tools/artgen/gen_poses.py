# 魔導研究記 キャラクター画像ジェネレータ(FLUX.1 schnell / ポーズ付き)
#
# 味方5体・敵14種を、1体につき4つのポーズで作る。
#
#   idle    … 何もしていない待機
#   cast    … 詠唱中(魔法陣を展開して溜めている)
#   release … 魔法が完成して撃った / 盾を張った
#   hurt    … ダメージを受けた
#
# 姿かたちの説明と seed は4枚とも同じにして、末尾のポーズ文だけを差し替える。
# こうしないと「同じキャラの別ポーズ」に見えない(FLUX は文が変わると
# 絵がまるごと変わるため、揃えられるのはここだけ)。
#
# 元の絵(Animagine XL 製)を作る gen.py には手を入れていない。
# 気に入らなければ tools\art_rollback.ps1 で丸ごと戻せる。
#
# 使い方(ComfyUI は自動で起動する):
#   python gen_poses.py --only player:1          … 1体4枚だけ試す
#   python gen_poses.py --only enemy:blob
#   python gen_poses.py --only player:1:cast     … 1枚だけ引き直す
#   python gen_poses.py --all                    … 全76枚
#   python gen_poses.py --manifest               … manifest.json だけ作り直す

import argparse
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
IMG_DIR = os.path.join(PROJECT, 'public', 'img')

sys.path.insert(0, HERE)
# 切り抜き・余白除去・中央合わせは gen.py のものをそのまま使う。
# 実績のある処理なので、書き写して劣化させない。
from gen import (  # noqa: E402
    BLACK_BG, check_centered, check_cutout, cutout, fit_height, luma_cutout,
    post_prompt, recenter, save, trim, wait_images,
)

CKPT = os.environ.get('FLUX_CKPT', 'flux1-schnell-fp8.safetensors')
STEPS = 4        # schnell は蒸留済みなので4ステップで十分
CFG = 1.0        # 1.0 固定。上げると壊れる
SAMPLER = 'euler'
SCHEDULER = 'simple'

PLAYER_W, PLAYER_H = 832, 1216
ENEMY_W, ENEMY_H = 1024, 1024
ENEMY_HEIGHT = 320   # 出力する敵画像の高さ(gen.py と揃える)
# 光り物の余白を測るときの濃さ。低いと尾を引く光まで拾って本体が豆粒になる
LUMA_TRIM = 185

POSES = ['idle', 'cast', 'release', 'hurt']


def load_subjects():
    with open(os.path.join(HERE, 'subjects_flux.json'), encoding='utf-8') as f:
        return json.load(f)


def build_workflow(prompt, width, height, seed):
    """FLUX 用のワークフロー。

    FLUX の潜在空間は 16ch なので EmptyLatentImage(4ch)は使えず、
    EmptySD3LatentImage を使う。ここを間違えると黒画像かノイズになる。
    否定指定は CFG 1.0 では効かないので空文字を渡す。
    """
    return {
        '4': {'class_type': 'CheckpointLoaderSimple',
              'inputs': {'ckpt_name': CKPT}},
        '5': {'class_type': 'EmptySD3LatentImage',
              'inputs': {'width': width, 'height': height, 'batch_size': 1}},
        '6': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': prompt, 'clip': ['4', 1]}},
        '7': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': '', 'clip': ['4', 1]}},
        '3': {'class_type': 'KSampler',
              'inputs': {'seed': seed, 'steps': STEPS, 'cfg': CFG,
                         'sampler_name': SAMPLER, 'scheduler': SCHEDULER,
                         'denoise': 1.0, 'model': ['4', 0],
                         'positive': ['6', 0], 'negative': ['7', 0],
                         'latent_image': ['5', 0]}},
        '8': {'class_type': 'VAEDecode',
              'inputs': {'samples': ['3', 0], 'vae': ['4', 2]}},
        '9': {'class_type': 'SaveImage',
              'inputs': {'filename_prefix': 'madoken_flux', 'images': ['8', 0]}},
    }


def generate(prompt, width, height, seed):
    from PIL import Image
    blobs = wait_images(post_prompt(build_workflow(prompt, width, height, seed)))
    return Image.open(io.BytesIO(blobs[0])).convert('RGB')


def maybe_flip(img, subj, ident):
    """向きが逆に描かれたものを左右反転する。

    プレイヤーは右向き・敵は左向きが正しい(向かい合わせになる)。
    FLUX は「facing to the right」と書いても従わず、ポーズごとに向きが変わる。
    そのため丸ごとではなく1枚ずつ指定できるようにしてある:

        "player:4"        … そのキャラの4枚すべて
        "player:3:cast"   … そのポーズだけ
    """
    from PIL import Image
    flips = subj.get('flip', [])
    char = ident.rsplit(':', 1)[0]      # player:3:cast → player:3
    if ident in flips or char in flips:
        print(f'  左右反転: {ident}')
        return img.transpose(Image.FLIP_LEFT_RIGHT)
    return img


# ===== 出来上がりの自己点検 =====

def check_bright(img, ident, floor=80):
    """暗すぎる絵を弾く。

    光り物(ウィスプ・魔導核)は白背景に描かせると、光ではなく影として
    描かれることがある。切り抜くと黒い塊だけが残り、戦闘画面では
    ほとんど見えない。一覧を目視するまで気づけないので数値で見る。
    """
    import numpy as np
    a = np.asarray(img.convert('RGBA')).astype(float)
    m = a[..., 3] > 32
    if not m.any():
        print(f'  ※ 警告: {ident} は中身が空になった。seed を変えて引き直すこと。')
        return False
    mean = float(a[..., :3][m].mean())
    if mean < floor:
        print(f'  ※ 警告: {ident} は暗すぎる(平均 {mean:.0f} / 目安 {floor}以上)。'
              '光り物なら subjects_flux.json で "cut": "luma" にするか、'
              'seed を変えて引き直すこと。')
        return False
    return True


def check_framing(img, base, ident, tol=0.25):
    """待機の絵と縦横比が大きくずれていないか調べる。

    ポーズによっては胸から上だけの構図で描かれることがある。
    高さを揃えて表示するので、そのままだと顔だけが巨大に映る。
    """
    from PIL import Image
    idle_path = os.path.join(IMG_DIR, base.replace('/', os.sep))
    if not os.path.exists(idle_path):
        return True
    idle = Image.open(idle_path).convert('RGBA')
    if idle.height == 0 or img.height == 0:
        return True
    a = img.width / img.height
    b = idle.width / idle.height
    off = (a - b) / b
    if abs(off) > tol:
        print(f'  ※ 警告: {ident} は待機の絵と形が違いすぎる(横幅比 {off * 100:+.0f}%)。'
              '上半身だけの構図になっている疑い。seed を変えて引き直すこと。')
        return False
    return True


def style_of(subj, luma):
    """画風の指定。背景の指定は必ずどちらか一方だけを差し込む。

    白背景の指定を残したまま黒背景を足すと、白い四角がそのまま描かれ、
    明るさ=不透明度で切り抜いた時に「白い板」として残る。
    """
    bg = BLACK_BG if luma else subj['bg_white']
    return f"{subj['style_head']}, {bg}, {subj['style_tail']}"


def pose_seed(entry, pose, override=None):
    """そのポーズに使う乱数種。

    4枚とも同じ種にするのが基本(同じキャラに見せるため)。
    ただし1枚だけ暗すぎる・構図が崩れるといったことが起きるので、
    seeds に書けばそのポーズだけ引き直した種を固定できる。
    """
    if override is not None:
        return int(override)
    return int((entry.get('seeds') or {}).get(pose, entry['seed']))


def pose_name(base, pose):
    """idle は元の名前のまま(既存の呼び出しをそのまま生かす)。"""
    if pose == 'idle':
        return base
    stem, ext = os.path.splitext(base)
    return f'{stem}_{pose}{ext}'


# ===== 生成 =====

def gen_player(subj, num, pose, seed=None):
    s = subj['players'][num - 1]
    ident = f'player:{num}:{pose}'
    print(f"プレイヤー{num}「{s.get('name', '')}」{pose} を生成中…")
    p = (f"{s['prompt']}, {subj['player_poses'][pose]}, "
         f"{subj['player_body']}, "
         f"{subj['player_view']}, {style_of(subj, False)}")
    img = generate(p, PLAYER_W, PLAYER_H, pose_seed(s, pose, seed))
    cut = cutout(img)
    check_cutout(cut, ident)
    out = maybe_flip(fit_height(recenter(trim(cut)), s.get('height', 400)),
                     subj, ident)
    check_centered(out, ident)
    check_bright(out, ident)
    if pose != 'idle':
        check_framing(out, s['out'], ident)
    return save(out, pose_name(s['out'], pose))


def gen_enemy(subj, key, pose, seed=None):
    e = subj['enemies'][key]
    ident = f'enemy:{key}:{pose}'
    print(f'敵「{key}」{pose} を生成中…')
    # 光り物は輪郭を持たないので、キャラ用の切り抜きが効かない。
    # 黒背景で描かせ、明るさをそのまま不透明度にする(弾と同じやり方)。
    # 背景の指定は必ずどちらか一方だけにする。
    # 白背景の指定を残したまま黒背景を足すと、白い四角がそのまま描かれ、
    # 明るさ=不透明度で切り抜いた時に「白い板」として残る。
    luma = e.get('cut') == 'luma'
    # 形の特殊な相手は共通のポーズ文が合わないことがある。
    # ウィスプは「前に魔法陣」と書くと、本体と離れた輪が別に描かれ、
    # 絵が片側に寄って頭上のHPバーが本体から外れる。その子だけ差し替える。
    text = (e.get('poses') or {}).get(pose, subj['enemy_poses'][pose])
    p = (f"{e['prompt']}, {text}, "
         f"{subj['enemy_view']}, {style_of(subj, luma)}")
    img = generate(p, ENEMY_W, ENEMY_H, pose_seed(e, pose, seed))
    cut = luma_cutout(img) if luma else cutout(img)
    # 光り物でも点検する。背景の指定を間違えると白い板がそのまま残るが、
    # 一覧の絵では白背景と見分けがつかず、戦闘画面に出して初めて気づく。
    check_cutout(cut, ident)
    # 光り物は尾を引く淡い光まで残る。薄い所まで拾って余白を測ると、
    # 本体が枠のごく一部になり、表示すると豆粒になる。濃い所だけで測る。
    out = maybe_flip(
        fit_height(recenter(trim(cut, LUMA_TRIM if luma else 16)), ENEMY_HEIGHT),
        subj, ident)
    check_centered(out, ident)
    check_bright(out, ident, floor=60 if luma else 80)
    if pose != 'idle':
        check_framing(out, f'enemy/{key}.png', ident)
    return save(out, pose_name(f'enemy/{key}.png', pose))


# ===== 軽量化 =====

# 使う色数。セル塗りの絵なので、この程度まで落としても見た目は変わらない。
SHRINK_COLORS = 192


def shrink_all():
    """キャラの絵を減色して軽くする(見た目はほぼ変わらない)。

    ポーズを足したことで枚数が4倍になり、絵だけで 9MB を超えた。
    起動時に読むのは待機の分だけとはいえ、残りも裏で落としてくるので、
    回線の細い端末には効いてくる。実測で 112KB → 21KB まで縮む。

    元に戻したい時は作り直せばよい(tools/artgen/art_v1 の退避も残っている)。
    """
    from PIL import Image
    total_before = 0
    total_after = 0
    n = 0
    for sub in ('player', 'enemy'):
        d = os.path.join(IMG_DIR, sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith('.png'):
                continue
            path = os.path.join(d, f)
            before = os.path.getsize(path)
            im = Image.open(path).convert('RGBA')
            q = im.quantize(colors=SHRINK_COLORS, method=Image.FASTOCTREE,
                            dither=Image.NONE)
            q.save(path, optimize=True)
            after = os.path.getsize(path)
            total_before += before
            total_after += after
            n += 1
    if n == 0:
        print('減色する絵が無い。')
        return
    print(f'{n}枚を減色した: {total_before / 1048576:.1f}MB → '
          f'{total_after / 1048576:.1f}MB'
          f'({100 - total_after * 100 // total_before}%減)')


# ===== manifest =====

def exists(rel):
    return os.path.exists(os.path.join(IMG_DIR, rel.replace('/', os.sep)))


def write_manifest(subj):
    """実際に置かれている画像だけを登録する。

    idle は今までどおり players / enemies に入れる。ポーズは別の枠に入れるので、
    ポーズ絵が1枚も無くても、これまでと同じように動く。
    """
    path = os.path.join(IMG_DIR, 'manifest.json')
    m = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            m = json.load(f)

    players = [s['out'] for s in subj['players'] if exists(s['out'])]
    if players:
        m['players'] = players
    en = {k: f'enemy/{k}.png' for k in subj['enemies']
          if exists(f'enemy/{k}.png')}
    if en:
        m['enemies'] = en

    pp = {}
    ep = {}
    for pose in POSES:
        if pose == 'idle':
            continue
        got = [pose_name(s['out'], pose) for s in subj['players']]
        got = [g for g in got if exists(g)]
        # 一部だけ揃っている状態だと、あるキャラだけ動いて見える。
        # 全員分揃った時だけ使う。
        if len(got) == len(subj['players']):
            pp[pose] = got
        eg = {k: pose_name(f'enemy/{k}.png', pose) for k in subj['enemies']}
        eg = {k: v for k, v in eg.items() if exists(v)}
        if eg:
            ep[pose] = eg
    if pp:
        m['playerPoses'] = pp
    elif 'playerPoses' in m:
        del m['playerPoses']
    if ep:
        m['enemyPoses'] = ep
    elif 'enemyPoses' in m:
        del m['enemyPoses']

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    npose = sum(len(v) for v in pp.values()) + sum(len(v) for v in ep.values())
    print(f'manifest.json を更新した(待機 {len(players) + len(en)} 枚 / '
          f'ポーズ {npose} 枚)。')


# ===== main =====

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='player:1 / enemy:blob / player:1:cast')
    ap.add_argument('--all', action='store_true', help='全76枚を生成')
    ap.add_argument('--manifest', action='store_true',
                    help='生成せず manifest.json だけ作り直す')
    ap.add_argument('--shrink', action='store_true',
                    help='生成せず、今ある絵を減色して軽くする')
    ap.add_argument('--seed', type=int,
                    help='subjects_flux.json の seed を上書きする(引き直し用)')
    args = ap.parse_args()

    subj = load_subjects()

    if args.shrink:
        shrink_all()
        return
    if args.manifest:
        write_manifest(subj)
        return
    if not args.only and not args.all:
        ap.error('--only か --all か --manifest か --shrink を指定する')

    t0 = time.time()
    done = 0
    if args.only:
        parts = args.only.split(':')
        kind = parts[0]
        key = parts[1] if len(parts) > 1 else ''
        poses = [parts[2]] if len(parts) > 2 else POSES
        for pose in poses:
            if kind == 'player':
                gen_player(subj, int(key), pose, args.seed)
            elif kind == 'enemy':
                gen_enemy(subj, key, pose, args.seed)
            else:
                ap.error(f'不明な指定: {args.only}')
            done += 1
    else:
        total = (len(subj['players']) + len(subj['enemies'])) * len(POSES)
        for i in range(len(subj['players'])):
            for pose in POSES:
                gen_player(subj, i + 1, pose)
                done += 1
                print(f'  [{done}/{total}]')
        for key in subj['enemies']:
            for pose in POSES:
                gen_enemy(subj, key, pose)
                done += 1
                print(f'  [{done}/{total}]')

    write_manifest(subj)
    print(f'完了({done}枚 / {time.time() - t0:.1f}秒)。')


if __name__ == '__main__':
    main()

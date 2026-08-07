# 静止画を1枚渡して、Wan 2.2 で動かす(image-to-video)。
#
# 紹介動画の作り方は2段構え。
#   ① FLUX で「決めカット」を静止画で作る(キャラの姿はここで固まる)
#   ② その1枚をこの道具に渡して動かす
# 文章だけから動画を作らせるとキャラの姿が毎回変わるが、
# 出来上がった1枚を渡せばその姿のまま動く。
#
# 使い方:
#   python tools/mv/wan_video.py --image 決めカット.png --prompt "..." --name cut01
#   python tools/mv/wan_video.py --image a.png --prompt "..." --seconds 4 --steps 24
#
# 実行は ComfyUI 同梱の python で:
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/wan_video.py ...

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

# Windows の既定(cp932)だと日本語や記号で落ちる。出力だけ UTF-8 に寄せる。
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

COMFY = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
COMFY_ROOT = os.environ.get('COMFY_ROOT', r'D:\ComfyUI\ComfyUI')
INPUT_DIR = os.path.join(COMFY_ROOT, 'input')
OUTPUT_DIR = os.path.join(COMFY_ROOT, 'output')

MODEL = 'wan2.2_ti2v_5B_fp16.safetensors'
CLIP = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
VAE = 'wan2.2_vae.safetensors'

FPS = 24

# 動かしたくないものを並べる。動画では静止画より崩れが目立つので強めに。
NEGATIVE = (
    'blurry, low quality, jpeg artifacts, watermark, text, subtitles, logo, '
    'extra limbs, extra fingers, deformed hands, distorted face, morphing face, '
    'flickering, jittery motion, static image, still frame, duplicate character'
)


def post(path, payload):
    req = urllib.request.Request(
        f'{COMFY}{path}',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def get(path):
    with urllib.request.urlopen(f'{COMFY}{path}', timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def build(image_name, prompt, width, height, length, steps, cfg, shift, seed, out_prefix):
    """ComfyUI の API 形式のワークフローを組む。

    画面の .json ではなく API 形式(ノード番号 → class_type + inputs)。
    画面を開かずに投げられるので、何十カットも回すのに向いている。
    """
    return {
        '1': {'class_type': 'UNETLoader',
              'inputs': {'unet_name': MODEL, 'weight_dtype': 'default'}},
        '2': {'class_type': 'CLIPLoader',
              'inputs': {'clip_name': CLIP, 'type': 'wan', 'device': 'default'}},
        '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': VAE}},
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '6': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': NEGATIVE, 'clip': ['2', 0]}},
        # 最初の1コマに渡した絵を焼き込み、そこから先を描かせる
        '7': {'class_type': 'Wan22ImageToVideoLatent',
              'inputs': {'vae': ['3', 0], 'width': width, 'height': height,
                         'length': length, 'batch_size': 1, 'start_image': ['4', 0]}},
        # shift は動きの大きさに効く。低いと固まり、高いと崩れる。
        '8': {'class_type': 'ModelSamplingSD3',
              'inputs': {'model': ['1', 0], 'shift': shift}},
        '9': {'class_type': 'KSampler',
              'inputs': {'model': ['8', 0], 'positive': ['5', 0], 'negative': ['6', 0],
                         'latent_image': ['7', 0], 'seed': seed, 'steps': steps,
                         'cfg': cfg, 'sampler_name': 'uni_pc', 'scheduler': 'simple',
                         'denoise': 1.0}},
        '10': {'class_type': 'VAEDecode', 'inputs': {'samples': ['9', 0], 'vae': ['3', 0]}},
        '11': {'class_type': 'CreateVideo', 'inputs': {'images': ['10', 0], 'fps': float(FPS)}},
        '12': {'class_type': 'SaveVideo',
               'inputs': {'video': ['11', 0], 'filename_prefix': out_prefix,
                          'format': 'mp4', 'codec': 'h264'}},
    }


def run(workflow, quiet=False):
    res = post('/prompt', {'prompt': workflow})
    pid = res['prompt_id']
    started = time.time()
    last = -1
    while True:
        time.sleep(2)
        hist = get(f'/history/{pid}')
        if pid in hist:
            h = hist[pid]
            status = h.get('status', {})
            if status.get('status_str') == 'error':
                for m in status.get('messages', []):
                    if m[0] == 'execution_error':
                        raise RuntimeError(m[1].get('exception_message', '不明な失敗'))
                raise RuntimeError('生成に失敗した')
            return h, time.time() - started
        if not quiet:
            sec = int(time.time() - started)
            if sec // 10 != last:
                last = sec // 10
                print(f'   …{sec}秒')
        if time.time() - started > 3600:
            raise RuntimeError('1時間たっても終わらない')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True, help='元にする静止画(FLUXで作った決めカット)')
    ap.add_argument('--prompt', required=True, help='どう動かすか(英語)')
    ap.add_argument('--name', default='cut', help='出来上がりの名前')
    ap.add_argument('--seconds', type=float, default=3.0, help='長さ(秒)')
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=704)
    ap.add_argument('--steps', type=int, default=20)
    ap.add_argument('--cfg', type=float, default=5.0)
    ap.add_argument('--shift', type=float, default=8.0)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--out', default='tools/mv/out', help='mp4 の置き場')
    args = ap.parse_args()

    # 長さは 4n+1 コマ。Wan は時間方向を4つまとめて圧縮するので、
    # ここが合っていないと末尾のコマが落ちる。
    length = int(round(args.seconds * FPS))
    length = max(5, ((length - 1) // 4) * 4 + 1)

    # ComfyUI は input フォルダの中しか読めないので、そこへ写しを置く
    os.makedirs(INPUT_DIR, exist_ok=True)
    image_name = f'mv_{args.name}{os.path.splitext(args.image)[1]}'
    shutil.copyfile(args.image, os.path.join(INPUT_DIR, image_name))

    seed = args.seed or int(time.time() * 1000) % (2 ** 31)
    print(f'▶ {args.name}: {args.width}x{args.height} / {length}コマ '
          f'({length / FPS:.1f}秒) / steps {args.steps} / seed {seed}')

    wf = build(image_name, args.prompt, args.width, args.height, length,
               args.steps, args.cfg, args.shift, seed, f'mv/{args.name}')
    hist, took = run(wf)

    # 出来上がりを取り出して、指定の場所へ移す
    os.makedirs(args.out, exist_ok=True)
    made = []
    for node in hist.get('outputs', {}).values():
        for v in node.get('videos', []) + node.get('images', []):
            src = os.path.join(OUTPUT_DIR, v.get('subfolder', ''), v['filename'])
            if not os.path.exists(src):
                continue
            dst = os.path.join(args.out, f'{args.name}{os.path.splitext(v["filename"])[1]}')
            shutil.copyfile(src, dst)
            made.append(dst)
    mb = sum(os.path.getsize(m) for m in made) / 1024 / 1024
    print(f'✓ {took:.0f}秒で完成 / {mb:.1f}MB')
    for m in made:
        print('  ', m)
    if not made:
        raise SystemExit('出来上がりが見つからない')


if __name__ == '__main__':
    main()

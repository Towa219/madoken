# 紹介動画の曲を ACE-Step で作る。
#
# ゲーム本編のBGM(tools/soundgen/gen_bgm.py)とは別物なので分けてある。
# 本編の曲は「何十分も流れ続けても飽きない」ことが要るが、
# こちらは40秒で起承転結を付け切る必要があり、作り方が違う。
#
# 使い方(ComfyUI を起動した状態で):
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/pv_bgm.py          … 3案を作る
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/pv_bgm.py --only B … 1案だけ
#
# 出来た3案を聴き比べて、採用したものを PICKED に書き残すこと。

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'bgm')
SERVER = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
CKPT = os.environ.get('ACE_CKPT', 'ace_step_1.5_turbo_aio.safetensors')

# 動画の実尺は 37.5秒(コマ数を 4n+1 に丸めた結果)。
# 少し長めに作って、繋ぐ時に末尾を絞る。ぴったりに作ると
# 終わりが切り落とされて、余韻の無い切れ方になる。
SECONDS = 45

STEPS = 28
CFG = 2.0

# 全案に共通で効かせる。器楽曲であること、芯のある旋律があること。
COMMON = ('instrumental, no vocals, epic cinematic game trailer, '
          'clear strong main melody, memorable theme, wide stereo, clean mix, '
          'builds from quiet to triumphant, big finish')

NEGATIVE = ('vocals, singing, voice, lyrics, applause, noise, distortion, '
            'silence, ambient drone, formless, meandering, no melody, '
            'background texture only, fade out ending, abrupt cut')

# 採用した案。聴き比べた結果をここに残す(空なら未決)。
PICKED = ''

VARIANTS = {
    'A': {
        'bpm': 140, 'keyscale': 'D minor', 'seed': 7311,
        'tags': 'epic orchestral battle trailer, taiko drums and timpani, '
                'heroic brass fanfare, driving strings ostinato, '
                'dark and tense opening, rising tension, triumphant heroic climax',
    },
    'B': {
        'bpm': 128, 'keyscale': 'A minor', 'seed': 7322,
        'tags': 'hybrid orchestral trailer, deep percussion hits, choir pads, '
                'soaring string melody, magical bell accents, '
                'mysterious quiet start, growing danger, glorious victorious ending',
    },
    'C': {
        'bpm': 150, 'keyscale': 'E minor', 'seed': 7333,
        'tags': 'fantasy adventure orchestral, fast violin melody, galloping drums, '
                'french horn counter melody, harp glissando, '
                'urgent and dramatic, sweeping heroic finale',
    },
}


def post(path, payload):
    req = urllib.request.Request(
        SERVER + path, data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def get(path):
    with urllib.request.urlopen(SERVER + path, timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def build(v, quality):
    # TextEncodeAceStepAudio1.5 は全ての項目が必須。省くと 400 で弾かれる。
    def encode(text):
        return {
            'class_type': 'TextEncodeAceStepAudio1.5',
            'inputs': {
                'clip': ['1', 1], 'tags': text, 'lyrics': '',
                'seed': int(v['seed']), 'bpm': int(v['bpm']),
                'duration': float(SECONDS), 'timesignature': '4',
                'language': 'en', 'keyscale': str(v['keyscale']),
                'generate_audio_codes': True, 'cfg_scale': 2.0,
                'temperature': 0.85, 'top_p': 0.9, 'top_k': 0, 'min_p': 0.0,
            },
        }

    return {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': CKPT}},
        '2': encode(f"{v['tags']}, {COMMON}"),
        '3': encode(NEGATIVE),
        '4': {'class_type': 'EmptyAceStep1.5LatentAudio',
              'inputs': {'seconds': float(SECONDS), 'batch_size': 1}},
        '5': {'class_type': 'KSampler',
              'inputs': {'model': ['1', 0], 'seed': int(v['seed']), 'steps': STEPS,
                         'cfg': CFG, 'sampler_name': 'euler', 'scheduler': 'simple',
                         'denoise': 1.0, 'positive': ['2', 0], 'negative': ['3', 0],
                         'latent_image': ['4', 0]}},
        '6': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['5', 0], 'vae': ['1', 2]}},
        '7': {'class_type': 'SaveAudioMP3',
              'inputs': {'audio': ['6', 0], 'filename_prefix': 'madoken_pv',
                         'quality': quality}},
    }


def quality_choice():
    """SaveAudioMP3 が受け付ける品質から良いものを選ぶ。

    紹介動画は通信量より音質を優先する(本編BGMは128kにしてある)。
    """
    try:
        info = get('/object_info/SaveAudioMP3')
        opts = info['SaveAudioMP3']['input']['required']['quality'][1]['options']
        for want in ('320k', 'V0', '128k'):
            if want in opts:
                return want
        return opts[0]
    except Exception:
        return '128k'


def run(v, name, quality):
    pid = post('/prompt', {'prompt': build(v, quality)})['prompt_id']
    started = time.time()
    last = -1
    while True:
        time.sleep(2)
        hist = get(f'/history/{pid}')
        if pid in hist:
            h = hist[pid]
            st = h.get('status', {})
            if st.get('status_str') == 'error':
                for m in st.get('messages', []):
                    if m[0] == 'execution_error':
                        raise RuntimeError(m[1].get('exception_message', '不明'))
                raise RuntimeError('失敗')
            break
        sec = int(time.time() - started)
        if sec // 20 != last:
            last = sec // 20
            if sec:
                print(f'   {name} …{sec}秒')
        if time.time() - started > 1800:
            raise RuntimeError('時間切れ')

    os.makedirs(OUT_DIR, exist_ok=True)
    made = []
    for node in h.get('outputs', {}).values():
        for a in node.get('audio', []):
            url = ('/view?filename=' + urllib.parse.quote(a['filename'])
                   + '&subfolder=' + urllib.parse.quote(a.get('subfolder', ''))
                   + '&type=' + a.get('type', 'output'))
            with urllib.request.urlopen(SERVER + url, timeout=120) as res:
                data = res.read()
            dst = os.path.join(OUT_DIR, f'pv_{name}.mp3')
            with open(dst, 'wb') as f:
                f.write(data)
            made.append(dst)
    return made, time.time() - started


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='A / B / C のどれか')
    args = ap.parse_args()

    quality = quality_choice()
    print(f'♪ 紹介動画の曲を作る({SECONDS}秒 / {quality})')
    for name, v in VARIANTS.items():
        if args.only and name != args.only:
            continue
        print(f"▶ 案{name}: BPM{v['bpm']} / {v['keyscale']}")
        made, took = run(v, name, quality)
        for m in made:
            mb = os.path.getsize(m) / 1024 / 1024
            print(f'   {took:.0f}秒  {m}  ({mb:.1f}MB)')


if __name__ == '__main__':
    main()

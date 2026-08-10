# 紹介動画の曲を ACE-Step で作る。
#
# ゲーム本編のBGM(tools/soundgen/gen_bgm.py)とは別物なので分けてある。
# 本編の曲は「何十分も流れ続けても飽きない」ことが要るが、
# こちらは40秒で起承転結を付け切る必要があり、作り方が違う。
#
# 使い方(ComfyUI を起動した状態で):
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/pv_bgm.py          … 3案を作る
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/pv_bgm.py --only B … 1案だけ
#   "D:/ComfyUI/python_embeded/python.exe" tools/mv/pv_bgm.py --set v2 … 第2版を各3テイク
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
SECONDS = float(os.environ.get('MV_BGM_SEC', '45'))

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

# 第2版(26.4秒・15カット)専用。時刻を明記し、映像の山谷を曲へ渡す。
# ACE-Stepは自然言語の時刻を厳密には保証しないため、複数テイクを作り、
# bgm_match.pyで実際の音量包絡線を全探索して採用位置を決める。
V2_VARIANTS = {
    'V1': {
        'bpm': 144, 'keyscale': 'D minor', 'seed': 26401,
        'tags': 'precisely structured 28-second orchestral trailer cue; '
                '0.0-1.8 seconds extremely quiet low sustained bass drone with one tiny bell note only; '
                '1.8-12.0 seconds rapid driving staccato string ostinato and tight taiko percussion, six escalating attacks; '
                '12.0-13.8 seconds gigantic enemy entrance with one crushing sub-bass impact; '
                '13.8-15.5 seconds tense battle continuation; '
                '15.5-17.2 seconds strong breakdown, sparse and thin, percussion drops out; '
                '17.2-20.8 seconds determined rebuild and accelerating crescendo; '
                '20.8-22.6 seconds absolute loudest climax, full brass and percussion tutti; '
                '22.6-26.4 seconds release, gentle resonance and quiet resolved ending; '
                '26.4-28.0 seconds soft reverb tail',
    },
    'V2': {
        'bpm': 136, 'keyscale': 'E minor', 'seed': 26411,
        'tags': 'time-coded 28-second fantasy action score; '
                '0.0-1.8 seconds near silence, deep pedal tone and a single delicate temple bell; '
                '1.8-12.0 seconds relentless short string pulses, toms and taiko building through six magical strikes; '
                '12.0-13.8 seconds colossal monster reveal marked by a solitary low orchestral slam; '
                '13.8-15.5 seconds urgent counterattack; '
                '15.5-17.2 seconds dramatic drop to exposed thin strings and almost no drums; '
                '17.2-20.8 seconds rising heroic sequence, faster and louder every bar; '
                '20.8-22.6 seconds maximum intensity brass fanfare and full percussion ensemble; '
                '22.6-26.4 seconds victorious release decrescendo to a calm final chord; '
                '26.4-28.0 seconds only fading natural resonance',
    },
    'V3': {
        'bpm': 152, 'keyscale': 'A minor', 'seed': 26421,
        'tags': 'compact 28-second cinematic magical battle cue with exact dramatic arc; '
                '0.0-1.8 seconds hushed ominous low drone plus exactly one small glass bell; '
                '1.8-12.0 seconds agile spiccato strings and crisp war drums surge forward in six waves; '
                '12.0-13.8 seconds massive creature arrival, isolated thunderous bass hit; '
                '13.8-15.5 seconds forceful struggle; '
                '15.5-17.2 seconds sudden restrained low-energy gap with very sparse instrumentation; '
                '17.2-20.8 seconds powerful comeback and steep ascending crescendo; '
                '20.8-22.6 seconds single loudest peak, blazing horns, brass and drums tutti; '
                '22.6-26.4 seconds open warm resolution becoming quiet; '
                '26.4-28.0 seconds clean orchestral tail',
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


def build(v, quality, seconds):
    # TextEncodeAceStepAudio1.5 は全ての項目が必須。省くと 400 で弾かれる。
    def encode(text):
        return {
            'class_type': 'TextEncodeAceStepAudio1.5',
            'inputs': {
                'clip': ['1', 1], 'tags': text, 'lyrics': '',
                'seed': int(v['seed']), 'bpm': int(v['bpm']),
                'duration': float(seconds), 'timesignature': '4',
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
              'inputs': {'seconds': float(seconds), 'batch_size': 1}},
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


def run(v, name, quality, seconds):
    pid = post('/prompt', {'prompt': build(v, quality, seconds)})['prompt_id']
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
    ap.add_argument('--set', choices=('v1', 'v2'), default='v1', help='曲案セット')
    ap.add_argument('--only', help='第1版はA/B/C、第2版はV1/V2/V3のどれか')
    ap.add_argument('--takes', type=int, help='各案の生成テイク数(第1版1、第2版3)')
    args = ap.parse_args()

    is_v2 = args.set == 'v2'
    variants = V2_VARIANTS if is_v2 else VARIANTS
    seconds = float(os.environ.get('MV_BGM_SEC', '28' if is_v2 else '45'))
    takes = args.takes if args.takes is not None else (3 if is_v2 else 1)
    if takes < 1:
        ap.error('--takesは1以上にしてください')
    if args.only and args.only not in variants:
        ap.error(f"--set {args.set}で選べる案は{'/'.join(variants)}です")

    quality = quality_choice()
    print(f'♪ 紹介動画の曲を作る({seconds}秒 / {quality} / {args.set})')
    for name, base in variants.items():
        if args.only and name != args.only:
            continue
        for take in range(1, takes + 1):
            v = dict(base)
            v['seed'] = int(base['seed']) + take - 1
            output_name = f'v2_{name}_take{take}' if is_v2 else name
            print(f"▶ 案{name} テイク{take}: BPM{v['bpm']} / {v['keyscale']} / seed={v['seed']}")
            made, took = run(v, output_name, quality, seconds)
            for m in made:
                mb = os.path.getsize(m) / 1024 / 1024
                print(f'   {took:.0f}秒  {m}  ({mb:.1f}MB)')


if __name__ == '__main__':
    main()

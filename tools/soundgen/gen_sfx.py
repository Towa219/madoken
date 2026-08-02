# 魔導研究記 効果音ジェネレータ(Stable Audio Open)
#
# ローカルの ComfyUI で効果音を作り、public/sound/sfx/_preview/ に書き出す。
# 聴き比べて良ければ sfx/ へ移す(--adopt)。
#
# ※ライセンス: Stability AI Community License。
#   商用利用は年間売上100万ドル未満なら無償だが、Stability AI への登録と
#   「Powered by Stability AI」の表示が必要。試作(評価・テスト)の段階では不要。
#
#   python gen_sfx.py --all            … 全部を _preview/ に作る
#   python gen_sfx.py --only hit
#   python gen_sfx.py --adopt          … _preview/ の音を sfx/ へ採用する
#   python gen_sfx.py --manifest       … manifest.json を作り直す

import argparse
import json
import os
import shutil
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
SOUND_DIR = os.path.join(PROJECT, 'public', 'sound')
SFX_DIR = os.path.join(SOUND_DIR, 'sfx')
PREVIEW_DIR = os.path.join(SFX_DIR, '_preview')

SERVER = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
CKPT = os.environ.get('SAO_CKPT', 'stable-audio-open-1.0.safetensors')
# Stable Audio Open のチェックポイントにはテキストエンコーダが入っていないため、
# T5 を別に読み込む(models/clip/ に置く)。
T5 = os.environ.get('SAO_T5', 't5-base.safetensors')

STEPS = 50
CFG = 6.0
SAMPLER = 'dpmpp_3m_sde_gpu'
SCHEDULER = 'exponential'


def load_conf():
    with open(os.path.join(HERE, 'sfx.json'), encoding='utf-8') as f:
        return json.load(f)


def post_prompt(workflow):
    data = json.dumps({'prompt': workflow}).encode('utf-8')
    req = urllib.request.Request(
        SERVER + '/prompt', data=data,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())['prompt_id']


def wait_files(prompt_id, timeout=900):
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
        if entry and entry.get('status', {}).get('status_str') == 'error':
            msgs = []
            for m in entry['status'].get('messages', []):
                if m[0] == 'execution_error':
                    d = m[1]
                    msgs.append(f"{d.get('node_type')}: {d.get('exception_message')}")
            raise RuntimeError('ComfyUI でエラー: ' + ('; '.join(msgs) or '詳細不明'))
        if entry and entry.get('outputs'):
            for node in entry['outputs'].values():
                for a in node.get('audio', []):
                    q = urllib.parse.urlencode({
                        'filename': a['filename'],
                        'subfolder': a.get('subfolder', ''),
                        'type': a.get('type', 'output'),
                    })
                    with urllib.request.urlopen(
                            SERVER + '/view?' + q, timeout=120) as r2:
                        return r2.read()
        time.sleep(1.0)
    raise TimeoutError('生成が時間内に終わらなかった')


def sampler_choice():
    """使えるサンプラーから手頃なものを選ぶ(環境によって顔ぶれが違う)。"""
    try:
        with urllib.request.urlopen(SERVER + '/object_info/KSampler',
                                    timeout=60) as res:
            info = json.loads(res.read())
        spec = info['KSampler']['input']['required']['sampler_name']
        opts = spec[0] if isinstance(spec[0], list) else spec[1].get('options', [])
    except Exception:
        return SAMPLER
    for want in (SAMPLER, 'dpmpp_3m_sde', 'dpmpp_2m', 'euler'):
        if want in opts:
            return want
    return opts[0]


def build_workflow(conf, item, sampler):
    prompt = f"{item['prompt']}, {conf['common']}"
    sec = float(item['seconds'])
    return {
        '0': {'class_type': 'CLIPLoader',
              'inputs': {'clip_name': T5, 'type': 'stable_audio'}},
        '1': {'class_type': 'CheckpointLoaderSimple',
              'inputs': {'ckpt_name': CKPT}},
        '2': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': prompt, 'clip': ['0', 0]}},
        '3': {'class_type': 'CLIPTextEncode',
              'inputs': {'text': conf['negative'], 'clip': ['0', 0]}},
        '4': {'class_type': 'ConditioningStableAudio',
              'inputs': {'positive': ['2', 0], 'negative': ['3', 0],
                         'seconds_start': 0.0, 'seconds_total': sec}},
        '5': {'class_type': 'EmptyLatentAudio',
              'inputs': {'seconds': sec, 'batch_size': 1}},
        '6': {'class_type': 'KSampler',
              'inputs': {'model': ['1', 0], 'seed': int(item['seed']),
                         'steps': STEPS, 'cfg': CFG, 'sampler_name': sampler,
                         'scheduler': SCHEDULER, 'denoise': 1.0,
                         'positive': ['4', 0], 'negative': ['4', 1],
                         'latent_image': ['5', 0]}},
        '7': {'class_type': 'VAEDecodeAudio',
              'inputs': {'samples': ['6', 0], 'vae': ['1', 2]}},
        '8': {'class_type': 'SaveAudioMP3',
              'inputs': {'audio': ['7', 0], 'filename_prefix': 'madoken_sfx',
                         'quality': '128k'}},
    }


def gen_one(conf, item, sampler):
    print(f"♪ {item['name']}({item['seconds']}秒)を生成中…")
    t0 = time.time()
    data = wait_files(post_prompt(build_workflow(conf, item, sampler)))
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    path = os.path.join(PREVIEW_DIR, item['out'])
    with open(path, 'wb') as f:
        f.write(data)
    print(f"  保存: sfx/_preview/{item['out']}  "
          f'({len(data) / 1024:.0f} KB / {time.time() - t0:.0f}秒)')


def adopt():
    """_preview/ の音を sfx/ へ移す(採用)。"""
    if not os.path.isdir(PREVIEW_DIR):
        print('_preview/ が無い。先に生成すること。')
        return
    os.makedirs(SFX_DIR, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(PREVIEW_DIR)):
        if not f.lower().endswith(('.mp3', '.ogg', '.wav')):
            continue
        shutil.copy(os.path.join(PREVIEW_DIR, f), os.path.join(SFX_DIR, f))
        print(f'  採用: {f}')
        n += 1
    print(f'{n}個を sfx/ へ採用した。--manifest で登録すること。')


def write_manifest():
    """置かれている音だけを manifest.json に登録する(BGMの登録は保つ)。"""
    path = os.path.join(SOUND_DIR, 'manifest.json')
    m = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            m = json.load(f)
    sfx = {}
    if os.path.isdir(SFX_DIR):
        for f in sorted(os.listdir(SFX_DIR)):
            base, ext = os.path.splitext(f)
            if ext.lower() in ('.mp3', '.ogg', '.wav', '.m4a'):
                sfx[base] = f'sfx/{f}'
    if sfx:
        m['sfx'] = sfx
    else:
        m.pop('sfx', None)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print(f'manifest.json を更新した(効果音 {len(sfx)}個)。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='hit / cast など')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--adopt', action='store_true', help='_preview/ を sfx/ へ採用')
    ap.add_argument('--manifest', action='store_true')
    args = ap.parse_args()

    if args.adopt:
        adopt()
        return
    if args.manifest:
        write_manifest()
        return

    conf = load_conf()
    if not args.only and not args.all:
        ap.error('--only か --all か --adopt か --manifest を指定する')

    sampler = sampler_choice()
    print(f'サンプラー: {sampler}')
    targets = conf['sfx']
    if args.only:
        targets = [x for x in conf['sfx']
                   if os.path.splitext(x['out'])[0] == args.only]
        if not targets:
            ap.error(f'不明な効果音: {args.only}')
    for item in targets:
        gen_one(conf, item, sampler)


if __name__ == '__main__':
    main()

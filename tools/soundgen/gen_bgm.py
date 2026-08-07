# 魔導研究記 BGMジェネレータ
#
# ローカルの ComfyUI(ACE-Step 1.5)で BGM を生成し、public/sound/bgm/ に置く。
# 画像の tools/artgen/gen.py と同じ考え方で、生成できた分だけ manifest に載る。
#
# 使い方(ComfyUI を起動した状態で):
#   python gen_bgm.py --only lobby      … 1曲だけ試す
#   python gen_bgm.py --all             … 全4曲
#   python gen_bgm.py --manifest        … 生成せず manifest.json を作り直す

import argparse
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
SOUND_DIR = os.path.join(PROJECT, 'public', 'sound')
BGM_DIR = os.path.join(SOUND_DIR, 'bgm')
SFX_DIR = os.path.join(SOUND_DIR, 'sfx')

SERVER = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
CKPT = os.environ.get('ACE_CKPT', 'ace_step_1.5_turbo_aio.safetensors')

# turbo 版は少ないステップで出る。多くしても時間が延びるだけ。
STEPS = 28
CFG = 2.0
SAMPLER = 'euler'
SCHEDULER = 'simple'
MP3_QUALITY = '128k'  # 選択肢は V0 / 128k / 320k。BGMは通信量優先で128k


def load_conf():
    with open(os.path.join(HERE, 'bgm.json'), encoding='utf-8') as f:
        return json.load(f)


# ===== ComfyUI API =====

def post_prompt(workflow):
    data = json.dumps({'prompt': workflow}).encode('utf-8')
    req = urllib.request.Request(
        SERVER + '/prompt', data=data,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())['prompt_id']


def wait_files(prompt_id, timeout=1800):
    """生成完了を待って、音声ファイルのバイト列を返す。"""
    deadline = time.time() + timeout
    last = 0.0
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                    SERVER + '/history/' + prompt_id, timeout=30) as res:
                hist = json.loads(res.read())
        except Exception:
            time.sleep(1.5)
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
            out = []
            for node in entry['outputs'].values():
                for a in node.get('audio', []):
                    q = urllib.parse.urlencode({
                        'filename': a['filename'],
                        'subfolder': a.get('subfolder', ''),
                        'type': a.get('type', 'output'),
                    })
                    with urllib.request.urlopen(
                            SERVER + '/view?' + q, timeout=120) as r2:
                        out.append(r2.read())
            if out:
                return out
        now = time.time()
        if now - last > 15:
            last = now
            print('    生成中…')
        time.sleep(1.5)
    raise TimeoutError('ComfyUI の生成が時間内に終わらなかった')


def build_workflow(conf, track, quality):
    tags = f"{track['tags']}, {conf['common_tags']}"

    # TextEncodeAceStepAudio1.5 は全ての項目が必須。省くと 400 で弾かれる。
    def encode(text):
        return {
            'class_type': 'TextEncodeAceStepAudio1.5',
            'inputs': {
                'clip': ['1', 1],
                'tags': text,
                'lyrics': '',                   # 器楽曲なので歌詞は空
                'seed': int(track['seed']),
                'bpm': int(track['bpm']),
                'duration': float(track['seconds']),
                'timesignature': str(track.get('timesignature', '4')),
                'language': 'en',
                'keyscale': str(track.get('keyscale', 'C major')),
                'generate_audio_codes': True,
                'cfg_scale': 2.0,
                'temperature': 0.85,
                'top_p': 0.9,
                'top_k': 0,
                'min_p': 0.0,
            },
        }

    return {
        '1': {'class_type': 'CheckpointLoaderSimple',
              'inputs': {'ckpt_name': CKPT}},
        '2': encode(tags),
        '3': encode(conf['negative_tags']),
        '4': {'class_type': 'EmptyAceStep1.5LatentAudio',
              'inputs': {'seconds': float(track['seconds']), 'batch_size': 1}},
        '5': {'class_type': 'KSampler',
              'inputs': {'model': ['1', 0], 'seed': int(track['seed']),
                         'steps': STEPS, 'cfg': CFG, 'sampler_name': SAMPLER,
                         'scheduler': SCHEDULER, 'denoise': 1.0,
                         'positive': ['2', 0], 'negative': ['3', 0],
                         'latent_image': ['4', 0]}},
        '6': {'class_type': 'VAEDecodeAudio',
              'inputs': {'samples': ['5', 0], 'vae': ['1', 2]}},
        '7': {'class_type': 'SaveAudioMP3',
              'inputs': {'audio': ['6', 0], 'filename_prefix': 'madoken_bgm',
                         'quality': quality}},
    }


def mp3_quality_choice():
    """SaveAudioMP3 が受け付ける品質から手頃なものを選ぶ。

    ※ COMBO の選択肢は ["COMBO", {"options": [...]}] という形。
      [0] を取ると文字列 "COMBO" の先頭文字になってしまうので注意。
    """
    try:
        with urllib.request.urlopen(SERVER + '/object_info/SaveAudioMP3',
                                    timeout=60) as res:
            info = json.loads(res.read())
        spec = info['SaveAudioMP3']['input']['required']['quality']
        opts = spec[1].get('options', []) if len(spec) > 1 else []
    except Exception:
        return MP3_QUALITY
    if not opts:
        return MP3_QUALITY
    for want in (MP3_QUALITY, 'V0', '128k', '192k'):
        if want in opts:
            return want
    return opts[0]


# ===== 生成 =====

def gen_track(conf, track, quality):
    print(f"♪ {track['name']}({track['seconds']}秒 / BPM{track['bpm']})を生成中…")
    t0 = time.time()
    blobs = wait_files(post_prompt(build_workflow(conf, track, quality)))
    os.makedirs(BGM_DIR, exist_ok=True)
    path = os.path.join(BGM_DIR, track['out'])
    with open(path, 'wb') as f:
        f.write(blobs[0])
    kb = os.path.getsize(path) / 1024
    print(f"  保存: public/sound/bgm/{track['out']}  "
          f'({kb:.0f} KB / {time.time() - t0:.0f}秒)')
    if kb > 1024:
        print('  ※ 1MBを超えている。通信量が気になる場合は seconds を短くするか'
              '品質を下げること。')
    return path


def gen_variants(conf, quality, only=None):
    """曲想の候補を _preview/ に書き出す。良かったものを bgm.json の tags に採用する。"""
    out_dir = os.path.join(BGM_DIR, '_preview')
    os.makedirs(out_dir, exist_ok=True)
    for t in conf['tracks']:
        key = os.path.splitext(t['out'])[0]
        if only and key != only:
            continue
        for label, tags in (t.get('variants') or {}).items():
            track = dict(t)
            track['tags'] = tags
            # 候補ごとに別の曲になるよう seed をずらす
            track['seed'] = int(t['seed']) + ord(label)
            print(f"♪ {t['name']} 案{label} を生成中…")
            t0 = time.time()
            blobs = wait_files(post_prompt(build_workflow(conf, track, quality)))
            path = os.path.join(out_dir, f'{key}_{label}.mp3')
            with open(path, 'wb') as f:
                f.write(blobs[0])
            print(f'  保存: bgm/_preview/{key}_{label}.mp3 '
                  f'({os.path.getsize(path) / 1024:.0f} KB / {time.time() - t0:.0f}秒)')
    print('')
    print('聴き比べて、良かった案の tags を bgm.json の "tags" に写してから')
    print('  python gen_bgm.py --all  で本番用に作り直す。')


# ===== manifest =====

def write_manifest(conf):
    """実際に置かれている音だけを manifest.json に登録する。

    今ある manifest.json を土台にする。まっさらから作り直してはいけない。
    ボスの3曲(boss1〜3)は bgm.json に無い手置きのファイルで、音量補正
    (bgmGain)も test/bgm_loudness.ts の実測から手で入れたものなので、
    作り直すと両方とも消える。実際に一度消して、ボス戦が無音になった。

    ただしファイルごと消えた曲は登録から外す。残しておくと、既に開いて
    いる画面が古い manifest を握ったまま鳴らせない曲を探しに行く。
    """
    path = os.path.join(SOUND_DIR, 'manifest.json')
    m = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            m = json.load(f)

    bgm = {k: v for k, v in (m.get('bgm') or {}).items()
           if os.path.exists(os.path.join(SOUND_DIR, str(v).replace('/', os.sep)))}
    for t in conf['tracks']:
        key = os.path.splitext(t['out'])[0]
        if os.path.exists(os.path.join(BGM_DIR, t['out'])):
            bgm[key] = f"bgm/{t['out']}"
    if bgm:
        m['bgm'] = bgm
    elif 'bgm' in m:
        del m['bgm']

    sfx = {}
    if os.path.isdir(SFX_DIR):
        for f in sorted(os.listdir(SFX_DIR)):
            base, ext = os.path.splitext(f)
            if ext.lower() in ('.mp3', '.ogg', '.wav', '.m4a'):
                # ファイル名(拡張子なし)をそのまま名前として使う
                sfx[base] = f'sfx/{f}'
    if sfx:
        m['sfx'] = sfx

    path = os.path.join(SOUND_DIR, 'manifest.json')
    if not m:
        if os.path.exists(path):
            os.remove(path)
        print('音が1つも無いため manifest.json は作らなかった(無音のまま)。')
        return
    os.makedirs(SOUND_DIR, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print(f'manifest.json を更新した(BGM {len(bgm)}曲 / 効果音 {len(sfx)}個)。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='lobby / battle / boss / duel')
    ap.add_argument('--all', action='store_true', help='全4曲を生成')
    ap.add_argument('--manifest', action='store_true',
                    help='生成せず manifest.json だけ作り直す')
    ap.add_argument('--variants', action='store_true',
                    help='候補(A/B/C)を _preview/ に書き出す。聴き比べ用')
    args = ap.parse_args()

    conf = load_conf()
    if args.manifest:
        write_manifest(conf)
        return
    if not args.only and not args.all:
        ap.error('--only か --all か --manifest を指定する')

    quality = mp3_quality_choice()
    print(f'MP3品質: {quality}')

    if args.variants:
        gen_variants(conf, quality, args.only)
        return

    targets = conf['tracks']
    if args.only:
        targets = [t for t in conf['tracks']
                   if os.path.splitext(t['out'])[0] == args.only]
        if not targets:
            ap.error(f'不明な曲: {args.only}')

    for t in targets:
        gen_track(conf, t, quality)
    write_manifest(conf)


if __name__ == '__main__':
    main()

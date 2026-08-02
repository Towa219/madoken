# BGMの前後の無音を切り落とす(ループの継ぎ目を詰める)
#
# ACE-Step は曲として終わらせるので末尾が無音になる。そのままループすると
# 「静かになった後にいきなり頭から鳴り直す」ため、鳴っている範囲だけを残す。
#
# 事前に measure.ts で範囲を測っておくこと:
#   npx tsx tools/soundgen/measure.ts tools/soundgen/_range.json \
#       http://127.0.0.1:2567/sound/bgm/lobby.mp3 ...
#   python trim_bgm.py

import json
import os
import shutil
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
BGM_DIR = os.path.join(PROJECT, 'public', 'sound', 'bgm')
RANGE_JSON = os.path.join(HERE, '_range.json')

SERVER = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
COMFY_INPUT = os.environ.get(
    'COMFY_INPUT', r'D:\ComfyUI\ComfyUI\input')

# 末尾は少しだけ残す(切りすぎると余韻が消えて不自然になる)
TAIL_KEEP = 0.15


def run(workflow, timeout=600):
    data = json.dumps({'prompt': workflow}).encode('utf-8')
    req = urllib.request.Request(
        SERVER + '/prompt', data=data,
        headers={'Content-Type': 'application/json'})
    pid = json.loads(urllib.request.urlopen(req, timeout=60).read())['prompt_id']
    deadline = time.time() + timeout
    while time.time() < deadline:
        hist = json.loads(
            urllib.request.urlopen(SERVER + '/history/' + pid, timeout=30).read())
        entry = hist.get(pid)
        if entry and entry.get('outputs'):
            for node in entry['outputs'].values():
                for a in node.get('audio', []):
                    q = urllib.parse.urlencode({
                        'filename': a['filename'],
                        'subfolder': a.get('subfolder', ''),
                        'type': a.get('type', 'output'),
                    })
                    return urllib.request.urlopen(
                        SERVER + '/view?' + q, timeout=120).read()
        time.sleep(1)
    raise TimeoutError('切り出しが終わらなかった')


def main():
    if not os.path.exists(RANGE_JSON):
        print(f'{RANGE_JSON} が無い。先に measure.ts を実行すること。')
        return
    with open(RANGE_JSON, encoding='utf-8') as f:
        ranges = json.load(f)

    for name, r in ranges.items():
        src = os.path.join(BGM_DIR, name)
        if not os.path.exists(src):
            print(f'  見つからない: {name}')
            continue
        start = float(r['start'])
        end = min(float(r['end']) + TAIL_KEEP, float(r['duration']))
        dur = end - start
        if dur <= 1 or (start < 0.05 and end > r['duration'] - 0.05):
            print(f'  切る必要なし: {name}')
            continue

        # LoadAudio は ComfyUI の input フォルダから読む
        tmp_name = f'_trim_{name}'
        shutil.copy(src, os.path.join(COMFY_INPUT, tmp_name))
        wf = {
            '1': {'class_type': 'LoadAudio', 'inputs': {'audio': tmp_name}},
            '2': {'class_type': 'TrimAudioDuration',
                  'inputs': {'audio': ['1', 0],
                             'start_index': start, 'duration': dur}},
            '3': {'class_type': 'SaveAudioMP3',
                  'inputs': {'audio': ['2', 0],
                             'filename_prefix': 'madoken_trim',
                             'quality': '128k'}},
        }
        data = run(wf)
        with open(src, 'wb') as f:
            f.write(data)
        try:
            os.remove(os.path.join(COMFY_INPUT, tmp_name))
        except OSError:
            pass
        print(f'  切り出した: {name}  {r["duration"]}秒 → {dur:.2f}秒'
              f'(前{start:.2f}秒 / 後{r["duration"] - end:.2f}秒を除去)')


if __name__ == '__main__':
    main()

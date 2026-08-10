# -*- coding: utf-8 -*-
"""台本の15カットをVidu Q3へ投稿し、動画を回収する。"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vidu_cuts

API_BASE = 'https://api.vidu.com/ent/v2'
REF_DIR = HERE / 'ref_vidu'
STILL_DIR = HERE / 'still_vidu'
OUT_DIR = HERE / 'out_vidu'
TASKS_FILE = OUT_DIR / '_tasks.json'
NORMAL_CREDITS = 24

# ★ モデルはエンドポイントごとに違う(2026-08-11に実測で判明)。
#   reference2video … viduq3 が通る。Vidu側では type=character2video として
#                     扱われ、これがキャラの同一性を保っている正体。
#   img2video       … viduq3 は 400「model is not supported」で弾かれる。
#                     使えるのは viduq3-turbo か vidu2.0(512pに落ちる)。
#   合成カットは1枚目をこちらで作り込んであるので、turbo でも
#   Vidu の仕事は「動かすだけ」。品質差の影響は小さいと判断した。
MODEL_BY_ENDPOINT = {
    'reference2video': 'viduq3',
    'text2video': 'viduq3-turbo',   # viduq3 は非対応(実測)
    'img2video': 'viduq3-turbo',    # viduq3 は非対応(実測)
}

# ★★ モデルの可否を「APIへ投げて」調べてはいけない ★★
#   2026-08-11、不正な movement_amplitude を混ぜれば弾かれるだろうと考えて
#   モデル×解像度×尺の18通りを投げた。viduq3 と viduq1 は弾いたが、
#   viduq3-turbo だけが不正値を黙って無視してタスクを6本作り、
#   192クレジットを捨てた(プロンプトは "t" の1文字で中身は使えない)。
#   取消のエンドポイントは無い(DELETE は404)。返ってこない。
#   ・弾かれるフィールドはモデルごとに違う。「無効な値なら安全」は成り立たない。
#   ・調べる時は公式ドキュメントを読むこと。APIを試し打ちの道具にしない。


def load_key():
    """APIキーを読む。ラベル付きの控えを丸ごと貼られていても拾う。

    ★ 実際、Viduの画面から「名前:…／作成日:…／鍵:vda_…」という4行の控えを
      そのまま貼られたことがある(2026-08-11)。ファイル全体を鍵として送ると
      認証に失敗するだけで、原因が分かりにくい。
      鍵は vda_ で始まるので、その語を含む行があればそこから切り出す。
    """
    key = os.environ.get('VIDU_API_KEY', '').strip()
    if not key and (HERE / '.vidu_key').exists():
        key = (HERE / '.vidu_key').read_text(encoding='utf-8').strip()
    if not key:
        raise SystemExit('APIキーが無い。tools/mv/.vidu_key に置くこと')
    if '\n' in key or 'vda_' in key:
        m = re.search(r'(vda_[A-Za-z0-9._\-]+)', key)
        if m:
            if key != m.group(1):
                print('  ※ .vidu_key にラベルが混ざっていたので、鍵の部分だけ取り出しました')
            key = m.group(1)
        elif '\n' in key:
            raise SystemExit(
                '.vidu_key が複数行です。vda_ で始まる鍵の1行だけにしてください')
    return key


def data_uri(path):
    if not path.exists():
        raise SystemExit(f'入力画像がありません: {path}')
    mime = 'image/png' if path.suffix.lower() == '.png' else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def still_name(value):
    """「lineup.py line6 ― 説明」から呼出名だけを得る。"""
    parts = value.split()
    if len(parts) < 2:
        raise SystemExit(f'still指定を解釈できません: {value}')
    return parts[1]


def build_payload(cut, dry_run=False, offpeak=False):
    paths = []
    if cut['mode'] == 'ref':
        paths = [REF_DIR / name for name in cut.get('refs', [])]
        endpoint = 'reference2video' if paths else 'text2video'
    elif cut['mode'] == 'img':
        paths = [STILL_DIR / f'{still_name(cut["still"])}.png']
        endpoint = 'img2video'
    else:
        raise SystemExit(f'不明なモードです: {cut["mode"]}')
    # dry-runでは実画像が未生成でも、枚数と送信形式を検証できる代替値にする。
    images = ([f'data:image/png;base64,<省略:{p.name}>' for p in paths]
              if dry_run else [data_uri(p) for p in paths])
    payload = {
        'model': MODEL_BY_ENDPOINT[endpoint], 'prompt': cut['prompt'],
        'resolution': '720p', 'aspect_ratio': '16:9', 'duration': cut['sec'],
        'movement_amplitude': cut['move'], 'bgm': False,
    }
    if endpoint != 'text2video':
        payload['images'] = images
    if offpeak:
        payload['off_peak'] = True
    return endpoint, payload


def api_request(method, url, key, body=None):
    raw = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=raw, method=method, headers={
        'Authorization': f'Token {key}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')
        raise SystemExit(f'APIエラー {error.code}: {detail[:800]}')


def next_output(cut_id, take, index):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base = OUT_DIR / f'{cut_id}_take{take}_{index}.mp4'
    if not base.exists():
        return base
    n = 2
    while True:
        path = OUT_DIR / f'{cut_id}_take{take}_{index}_{n}.mp4'
        if not path.exists():
            return path
        n += 1


def load_tasks():
    return json.loads(TASKS_FILE.read_text(encoding='utf-8')) if TASKS_FILE.exists() else []


def save_tasks(tasks):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    TASKS_FILE.write_text(json.dumps(tasks, ensure_ascii=False, indent=2), encoding='utf-8')


def submit_one(cut, take, key, offpeak):
    endpoint, payload = build_payload(cut, offpeak=offpeak)
    print(f'投稿中: {cut["id"]} 案{take}（画像{len(payload.get("images", []))}枚）')
    result = api_request('POST', f'{API_BASE}/{endpoint}', key, payload)
    task_id = result.get('task_id')
    if not task_id:
        raise SystemExit(f'task_idが返りませんでした: {result}')
    print(f'受付完了: task_id={task_id}')
    return task_id


def save_result(result, cut_id, take):
    saved = []
    for index, creation in enumerate(result.get('creations', []), 1):
        if not creation.get('url'):
            continue
        path = next_output(cut_id, take, index)
        with urllib.request.urlopen(creation['url'], timeout=300) as response:
            path.write_bytes(response.read())
        print(f'保存: {path}')
        saved.append(path)
    return saved


def wait_result(task_id, cut_id, take, key):
    while True:
        result = api_request('GET', f'{API_BASE}/tasks/{task_id}/creations', key)
        state = result.get('state')
        print(f'状態: {state}')
        if state == 'success':
            return save_result(result, cut_id, take)
        if state == 'failed':
            raise SystemExit(f'生成に失敗しました: {result.get("err_code", "原因不明")}')
        time.sleep(5)


def fetch_all(key):
    tasks = load_tasks()
    pending = [item for item in tasks if not item.get('done')]
    if not pending:
        print('未回収のタスクはありません')
        return
    for item in pending:
        result = api_request('GET', f'{API_BASE}/tasks/{item["task_id"]}/creations', key)
        state = result.get('state')
        print(f'{item["cut"]} 案{item["take"]}: {state}')
        if state == 'success':
            save_result(result, item['cut'], item['take'])
            item['done'] = True
        elif state == 'failed':
            print(f'失敗: {result.get("err_code", "原因不明")}')
            item['done'] = True
    save_tasks(tasks)


def credit_remain(key):
    """残高を読む。投稿の前後で必ず出して、想定どおり減ったか確かめる。"""
    try:
        res = api_request('GET', f'{API_BASE}/credits', key)
        for item in res.get('remains', []):
            return int(item.get('credit_remain', 0))
    except SystemExit:
        return None
    return None


def confirm(count, offpeak, key=None):
    per = NORMAL_CREDITS // 2 if offpeak else NORMAL_CREDITS
    now = credit_remain(key) if key else None
    if now is not None:
        print(f'いまの残高: {now}クレジット')
    print(f'投稿予定: {count}本、消費予定: 合計{count * per}クレジット'
          f'（1本{per}クレジット）')
    if input('本当に投稿しますか？ [y/N]: ').strip().lower() != 'y':
        raise SystemExit('投稿を中止しました')


def find_cut(cut_id):
    for cut in vidu_cuts.CUTS:
        if cut['id'] == cut_id:
            return cut
    raise SystemExit(f'不明なカットIDです: {cut_id}（--list で確認してください）')


def main():
    parser = argparse.ArgumentParser(description='Vidu Q3への投稿と回収を行います')
    parser.add_argument('cut', nargs='?', help='単発投稿するカットID')
    parser.add_argument('--takes', type=int, default=1, help='案数')
    parser.add_argument('--list', action='store_true', help='カット一覧')
    parser.add_argument('--submit', help='投稿だけ行うカットID（カンマ区切り）')
    parser.add_argument('--fetch-all', action='store_true', help='記録済みタスクを一括回収')
    parser.add_argument('--offpeak', action='store_true', help='半額のオフピーク投稿')
    parser.add_argument('--dry-run', action='store_true', help='送信直前の内容だけ表示')
    args = parser.parse_args()
    if args.takes < 1:
        raise SystemExit('--takes は1以上を指定してください')
    if args.list or (not args.cut and not args.submit and not args.fetch_all):
        print(f'カット一覧（{len(vidu_cuts.CUTS)}件）')
        for cut in vidu_cuts.CUTS:
            refs = len(cut.get('refs', [])) if cut['mode'] == 'ref' else 1
            print(f'{cut["id"]}　{cut["mode"]}　{cut["sec"]}秒　動き:{cut["move"]}　画像:{refs}枚')
        return
    if args.fetch_all:
        if args.dry_run:
            print('dry-run: 回収通信は行いません')
            return
        fetch_all(load_key())
        return
    ids = ([part.strip() for part in args.submit.split(',') if part.strip()]
           if args.submit else [args.cut])
    cuts_to_send = [find_cut(cut_id) for cut_id in ids]
    if args.dry_run:
        for cut in cuts_to_send:
            endpoint, payload = build_payload(cut, dry_run=True, offpeak=args.offpeak)
            print(json.dumps({'カット': cut['id'], '送信先': f'{API_BASE}/{endpoint}',
                              'ペイロード': payload}, ensure_ascii=False, indent=2))
        print('dry-run完了: Vidu APIへは送信していません')
        return
    # 鍵は確認画面より先に読む。残高を出すのに要るため。
    key = load_key()
    confirm(len(cuts_to_send) * args.takes, args.offpeak, key)
    # ★ task_id は1本ごとにその場で保存する。まとめて最後に書いてはいけない。
    #   2026-08-11、5本まとめて投げて3本目でAPIエラーになった時、
    #   成功していた2本の task_id が保存されずに消えた。
    #   タスクは課金済みで残っているのに、こちらから追う手がかりが無くなる。
    #   (この時は API のタスク一覧とプロンプトを突き合わせて拾い直した)
    queued = 0
    for cut in cuts_to_send:
        for take in range(1, args.takes + 1):
            task_id = submit_one(cut, take, key, args.offpeak)
            if args.submit:
                tasks = load_tasks()
                tasks.append({'task_id': task_id, 'cut': cut['id'],
                              'take': take, 'done': False})
                save_tasks(tasks)
                queued += 1
            else:
                wait_result(task_id, cut['id'], take, key)
    if queued:
        print(f'{queued}件のtask_idを記録しました。後で --fetch-all を実行してください')


if __name__ == '__main__':
    main()

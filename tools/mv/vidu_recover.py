# -*- coding: utf-8 -*-
r"""記録から漏れた task_id を、Vidu 側のタスク一覧から拾い直す。

    D:/ComfyUI/python_embeded/python.exe tools/mv/vidu_recover.py

★ なぜ要るか(2026-08-11)
  --submit で5本まとめて投げ、3本目でAPIエラーになった時、
  成功していた2本の task_id が保存されないまま落ちた。
  タスクは課金済みでVidu側に残っているのに、こちらから追えなくなる。
  vidu_gen.py 側は1本ごと保存に直したが、既に落ちたぶんはこれで拾う。

台本のプロンプトと、Vidu が返すタスクのプロンプトを突き合わせて
どのカットかを決める。プロンプトはカットごとに違うので一意に決まる。
"""

import json
import sys
import urllib.parse
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vidu_cuts
import vidu_gen


def main():
    key = vidu_gen.load_key()
    known = {item['task_id'] for item in vidu_gen.load_tasks()}

    # 一覧は1ページ10件で固定。pageSize を上げても効かない。
    # next_page_token を辿って集める(空文字になったら終わり)。
    tasks_api = []
    token = ''
    for _ in range(12):        # 120件まで見れば足りる
        url = f'{vidu_gen.API_BASE}/tasks?pageSize=10'
        if token:
            url += '&page_token=' + urllib.parse.quote(token)
        page = vidu_gen.api_request('GET', url, key)
        got = page.get('tasks', [])
        if not got:
            break
        tasks_api.extend(got)
        token = page.get('next_page_token') or ''
        if not token:
            break
    print(f'Vidu側のタスク {len(tasks_api)}件を見ています')
    res = {'tasks': tasks_api}

    # 台本のプロンプト冒頭 → カットIDの対応表を作る。
    # 画風と舞台の共通部分は全カットで同じなので、そこは飛ばして比べる。
    head = len(vidu_cuts.STYLE) + len(vidu_cuts.STAGE) + 2
    by_body = {cut['prompt'][head:head + 90]: cut['id'] for cut in vidu_cuts.CUTS}

    added = []
    for task in res.get('tasks', []):
        if task['id'] in known:
            continue
        cut_id = by_body.get((task.get('prompt') or '')[head:head + 90])
        if not cut_id:
            continue
        added.append({'task_id': task['id'], 'cut': cut_id,
                      'take': 1, 'done': False})
        print(f'拾った: {cut_id}  task_id={task["id"]}  状態={task["state"]}'
              f'  消費={task["credits"]}クレジット')

    if not added:
        print('拾えるものはありませんでした（漏れは無し）')
        return
    tasks = vidu_gen.load_tasks()
    tasks.extend(added)
    vidu_gen.save_tasks(tasks)
    print(f'\n{len(added)}件を記録に戻しました。'
          f'合計 {len(tasks)}件 ─ vidu_gen.py --fetch-all で回収してください')


if __name__ == '__main__':
    main()

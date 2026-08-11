# Codex が実装を終えるのを待つ。
#
#   python tools/wait_codex.py [監視する分数]
#
# ★ ログではなく成果物を見る。
#   codex_wait.py は実況ログの停止で判断するため、Codexが考え込んで
#   ログが止まっただけで鳴り、本当に終わった時には鳴らないことがある
#   (2026-08-11に、19:10に終わっていたのに気づけなかった)。
#   ここでは「追跡中のファイルが変わり、そのあと一定時間動かない」を
#   完了の合図にする。
#
# ★ シェルスクリプトで書かないこと。
#   Git Bash は日本語の変数名を受け付けず、`command not found` を
#   延々と出し続けて空回りする(同じ日に踏んだ)。

import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..'))

# 静止したとみなすまでの秒数。Codexは検証の実行中に数分黙ることがある。
STILL_SECONDS = 150
POLL = 15


def 変更一覧():
    r = subprocess.run(['git', 'status', '--short'], cwd=PROJECT,
                       capture_output=True, text=True, encoding='utf-8')
    return [l for l in (r.stdout or '').splitlines() if l.strip()]


def 印(lines):
    """変更の中身を1つの文字列にまとめる(内容が変われば必ず変わる)。"""
    出 = []
    for l in lines:
        path = l[3:].strip().strip('"')
        full = os.path.join(PROJECT, path.replace('/', os.sep))
        try:
            st = os.stat(full)
            出.append(f'{path}:{st.st_mtime_ns}:{st.st_size}')
        except OSError:
            出.append(f'{path}:消えた')
    return '|'.join(出)


def main():
    分 = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    期限 = time.time() + 分 * 60
    前 = None
    静止 = 0.0
    動いたことがある = False

    print(f'Codexの成果物を見張ります(最大{分}分・{STILL_SECONDS}秒静止で完了とみなす)')
    while time.time() < 期限:
        lines = 変更一覧()
        今 = 印(lines)
        if 今 != 前:
            前 = 今
            静止 = 0.0
            if lines:
                動いたことがある = True
                print(f'  変化あり({len(lines)}件) … {time.strftime("%H:%M:%S")}')
        else:
            静止 += POLL

        if 動いたことがある and 静止 >= STILL_SECONDS:
            print(f'CODEX_FINISHED {len(lines)}件が変更され、{int(静止)}秒静止しました')
            for l in lines:
                print('  ' + l)
            return 0
        time.sleep(POLL)

    print(f'CODEX_TIMEOUT {分}分待っても静止しませんでした')
    return 1


if __name__ == '__main__':
    sys.exit(main())

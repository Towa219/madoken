# 魔導研究記 — Phase 1 (オンライン共闘対応)

魔法を「エレメントの調合」で自作し、ソロCPU戦・オンライン共闘(最大3人)で戦う。
スタック: Vite + TypeScript + PixiJS + Colyseus。

## 起動方法(ローカル開発)

```
cd c:\Users\ai_to\Claude\magic_web_game
npm install            # 初回のみ
npm run dev:server     # ゲームサーバー(ポート2567)
npm run dev            # 別ターミナルで。http://localhost:5173 が開く
```

本番相当で動かす場合: `npm run build` → `npm start` → http://localhost:2567
(サーバーがビルド済みクライアントも配信する)

テスト: `npx tsx test/coop_e2e.ts` (サーバー起動済みで。共闘のE2E検証)

## Render(無料プラン)へのデプロイ手順

1. このフォルダをGitHubリポジトリにpushする(render.yaml同梱済み)
2. https://render.com にアカウント登録(GitHub連携)
3. ダッシュボード → New → Blueprint → リポジトリを選択 → Apply
4. 数分で `https://<名前>.onrender.com` が発行される
   (クライアント配信もWebSocketも同じURLで動く)

※無料プランは15分無アクセスでスリープする。最初のアクセスで数十秒待てば起動。

### 皆に配るURLは待機ページのほう

配るのは `https://towa219.github.io/madoken/`(GitHub Pages / `docs/`)で、
Renderの本体URLを直に配ってはいけない。

眠っている本体を直に開くと、起きるまでの30〜60秒のあいだ Render の
起動画面が出る。初めて来た人はそれを見て「壊れている」と受け取ってしまう。
そして**眠っている間、こちらのサーバーは何も動いていない**ので、
本体の中にどんな案内を書いても配れない。

待機ページは常に即座に開き、事情を伝えながら裏で本体を起こして、
起きたら自動で送る。中身は `docs/index.html` の1枚だけで、
サーバーにも外部にも一切依存させていない。

  検証: `npx tsx test/wait_page_check.ts`
  (本体への通信を塞いで「眠っている状態」を作り、踏みとどまるか見る)

GitHub Pages の設定は main ブランチの `/docs`。
`shared/links.ts` の `SITE_URL` も待機ページを指している。

### ★ 外から叩いて起こし続けるのは、やめた

一時期、遊ばれる時間帯(6:00〜翌1:30)だけ外部のcron(cron-job.org)から
10分ごとに `/api/ping` を叩き、最初の1人が来た時にはもう起きている、
という運用にしていた。月の消費は約612時間で無料枠(750時間)には収まる計算だった。

**2026-08-09、Renderから警告のメールが届いたのでやめた。**
枠の計算が合っていても、外から定期的に叩いて眠らせない使い方そのものが
無料プランの想定から外れている。止められてから慌てるより、こちらから降りる。

**いまの答えは待機ページ(docs/)だけ。**
眠っていること自体は受け入れて、待つ人が驚かないようにする方に寄せる。
配る住所を待機ページにしてあるのは、そのため。

`/api/ping` は残してある。cronのためではなく、
「本番がどの版で動いているか」「いま起きているか」を手元から確かめるため
(リリースのたびに使っている)。

`test/awake_check.ts` も残してあるが、**これはもう合否を見るものではない**。
今の運用では眠っているのが正常なので、走らせれば当然「眠っていた」と出る。
外から起こす仕組みを将来また試す時のための道具として置いてある。

## 遊び方

1. **研究室**: 素材庫のエレメントをクリックしてスロットに置き、「調合する」
   - 2個以上で調合可能。組み合わせによっては隠し系統(爆裂・連鎖など全8種)が発見される
   - 発見図鑑のヒントを頼りに未知の系統を探すのが研究の醍醐味
2. **魔導書**: 作った魔法を最大4つ装備
3. **戦闘**: ステージを選んで出撃。キー1〜4またはボタンで詠唱
   - セミリアルタイム: 詠唱時間+クールダウン制。MPは自動回復
   - 敵には弱点/耐性属性がある。5の倍数ステージはボス
4. 勝利でエレメントと研究Pを獲得 → より深い調合へ

## オンラインの仕組み

- `server/` — Colyseusサーバー。ロビーチャット(`lobby_chat`)と共闘ルーム(`coop`)
- 共闘はサーバー権威: クライアントは魔法の**レシピだけ**を送り、
  性能はサーバーが `shared/spellcraft.ts` で再計算する(ステータス改竄対策)
- 敵HPは人数でスケール(1人=等倍、2人=1.5倍、3人=2倍)
- 治癒魔法は「最も傷ついた味方」に飛ぶ。護盾は自分に張る

## 構成

- `src/data.ts` — エレメント・隠しレシピ・敵の定義(バランス調整はここ)
- `src/spellcraft.ts` — 調合ロジック(エレメント→魔法性能の変換)
- `src/state.ts` — セーブデータ(localStorage)
- `src/lab.ts` — 研究室UI(DOM)
- `src/battle.ts` — 戦闘シーン(PixiJS)。キャラ描画は
  `makePlayerSprite` / `makeEnemySprite` に分離してあり、
  画像に差し替える場合はこの2関数だけ変更すればよい
- `src/main.ts` — 画面切替・結果処理

## 画像差し替え(将来)

`assets/` フォルダに PNG を置き、`Assets.load()` + `Sprite` で
`makePlayerSprite` / `makeEnemySprite` を置き換える。
推奨サイズ: キャラ 128×128px 程度(透過PNG)。

## ランキングの管理(荒らし対応)

不適切な名前がランキングに載った時の手当て。**環境変数 `ADMIN_KEY` を設定した場合のみ**使える
(Render の Environment に足す)。設定していなければ全て 403 で拒否される。

記録を消すだけでは同じ名前で登録し直せてしまうので、名前そのものを塞ぐ手段も用意してある。
禁止にすると、**元の持ち主の端末からも**その名前は使えなくなる(名前の予約ごと外すため)。

```
# 一覧を見る(上位100件)
curl "https://madoken.onrender.com/api/admin/ranking?key=KEY"

# 記録だけ消す
curl -X POST https://madoken.onrender.com/api/admin/ranking/remove \
  -H "Content-Type: application/json" -d '{"key":"KEY","name":"名前"}'

# 記録を消して名前も塞ぐ
curl -X POST https://madoken.onrender.com/api/admin/ranking/remove \
  -H "Content-Type: application/json" -d '{"key":"KEY","name":"名前","ban":true}'

# 禁止名の一覧 / 解除
curl "https://madoken.onrender.com/api/admin/ban?key=KEY"
curl -X POST https://madoken.onrender.com/api/admin/ban \
  -H "Content-Type: application/json" -d '{"key":"KEY","name":"名前","action":"remove"}'
```

禁止名は Upstash に保存される(未設定ならメモリのみ=再起動で消える)。
判定は全角/半角・大文字小文字を揃えた形で行うので、表記を変えてのすり抜けはできない。

動作確認: `ADMIN_KEY=testkey npm start` で起動し、`npx tsx test/ranking_admin_check.ts`

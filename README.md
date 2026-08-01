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
4. 数分で `https://<名前>.onrender.com` が発行される。それが皆に配るURL
   (クライアント配信もWebSocketも同じURLで動く)

※無料プランは15分無アクセスでスリープする。最初のアクセスで数十秒待てば起動。

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

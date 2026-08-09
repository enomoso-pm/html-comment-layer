# examples — 記事のデモ一式

Qiita記事「HTML資料にFigma風コメントを後付けして、レビュー指摘をそのままAIへの修正指示にする」で
使っているデモファイルの実物です。架空のPOS刷新提案資料「Project NOVA」を、
提出前の社内レビューという設定で3人がレビューしています。

| ファイル | 何か | 記事のどこ |
|---|---|---|
| `demo-次世代POSシステム刷新プロジェクト.html` | 素の提案資料（レイヤーなし） | 「資料に差し込む」の入力 |
| `demo-次世代POSシステム刷新プロジェクト_commented.html` | コメント機能を差し込んだ直後（レビュアーに送る状態） | 「開いてもらう」 |
| `demo-次世代POSシステム刷新プロジェクト_commented_2608080631.html` | レビュー済み（指摘9件・返信3件・完了1件） | デモの本編 |
| `demo-次世代POSシステム刷新プロジェクト_AI反映後_applied.html` | AIが修正し、`--apply-state` で完了を書き戻した後 | 「開くと検算が走る」 |
| `demo-次世代POS_佐藤レビュー_merged.html` | 2人が別々にレビューして `--merge` で合流した結果 | 「複数人のレビューを…」 |
| `review-state.json` | AIが出した書き戻しファイルの実物 | 「AIは『どれを直したか』を返してくる」 |

## 触ってみる順番

1. `…_commented_2608080631.html` をブラウザで開く。ハイライトやカードを押して往復を体感する
2. サイドバーの「AIに渡す指摘をコピー」で、AIへの修正指示がどう出るかを見る
3. `…_AI反映後_applied.html` を開く。「AIが完了にした 2 件が未検算です」から「確認済みにする」までを試す
4. コマンドを再現したければ、リポジトリ直下で:

```bash
python3 scripts/add_comment_layer.py examples/demo-次世代POSシステム刷新プロジェクト.html --check
python3 scripts/add_comment_layer.py examples/demo-次世代POSシステム刷新プロジェクト_commented_2608080631.html --check
```

資料の中身（社名・数値・人名）はすべて架空です。

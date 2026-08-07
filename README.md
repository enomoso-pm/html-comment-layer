# HTML資料コメントレイヤー — 索引

既存のHTML資料に、Figma風のレビューコメント機能を後付けする。サーバもビルドも不要で、
できあがるのは1個のHTMLファイルのまま。Slackやメールで渡せば、受け取った側はブラウザで
開いてコメントを書き、コメントごと埋め込まれたHTMLを書き出して返せる。

コメントの完了・完了取り消し（完了は削除せず一覧の最下部へ）、返信スレッド、優先度
（必須 / 要望 / 軽微）、更新順と優先度順の並び替え、全コメントをMarkdownで書き出す
「AIに渡す指摘をコピー」（AI修正指示にそのまま貼れる）、未保存コメントのlocalStorageへの
自動退避・復元も備える。イラスト付きの使い方ガイド（画面左下の「使い方」で開く。自動表示はしない）
が資料に同梱されるので、受け取った人は説明なしで書き込みを始められる。

UIは**デジタル庁デザインシステム（DADS）**に準拠し、絵文字は使わず 24×24 のインラインSVG
アイコンで統一している。詳しくは `SKILL.md` の「見た目の決まり」を参照。

## 構成

- `SKILL.md` — ワークフロー本体（使い方・落とし穴・検証手順）
- `assets/` — 資料に差し込む本体
  - `comment-layer.html` … CSS・マークアップ・スクリプトを1つにまとめたドロップイン・ブロック
- `scripts/` — 実行スクリプト
  - `add_comment_layer.py` … 資料への追加／更新／除去
  - `verify.mjs` … ヘッドレスChromeでの動作確認
  - `cdp.mjs` … `verify.mjs` が使うChrome操作ドライバ（依存ゼロ）

## 最短の使い方

```bash
python3 scripts/add_comment_layer.py 資料.html      # → 資料_commented.html
node    scripts/verify.mjs 資料_commented.html      # → 全項目 passed になればOK
```

## 資料側に必要な条件

1. ページ本体が普通にスクロールすること（`body{overflow:hidden}` ＋ 内側divスクロールにしない）
2. ピンの基準にしたい要素があれば `data-comment-host` を付ける（無ければ自動選択）

条件を満たしているかは `--check` が教える。詳細と理由は `SKILL.md` の「落とし穴」を参照。

## 依存

- `add_comment_layer.py` … Python 3（標準ライブラリのみ）
- `verify.mjs` … Node 22+ ／ ローカルのChrome・Chromium。
  既定の場所以外に入れている場合は `CHROME_PATH` で指定する。

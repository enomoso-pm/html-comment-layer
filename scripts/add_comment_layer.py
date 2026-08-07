#!/usr/bin/env python3
"""HTML資料にコメントレイヤーを追加・更新・除去する。

  追加/更新 : python3 add_comment_layer.py 資料.html            (別名で書き出し)
              python3 add_comment_layer.py 資料.html --in-place
  除去      : python3 add_comment_layer.py 資料.html --strip
  検査のみ  : python3 add_comment_layer.py 資料.html --check

すでにレイヤーが入っているファイルに対しては、書き込まれたコメントデータ
(comment-store / user-master) を引き継いだままエンジンだけを差し替える。
"""
import argparse
import pathlib
import re
import shutil
import sys

ASSET = pathlib.Path(__file__).resolve().parent.parent / "assets" / "comment-layer.html"


def find_block(html):
    """既存レイヤーの (開始index, 終了index) を返す。無ければ None。"""
    i = html.find("COMMENT-LAYER")
    while i != -1:
        seg = html[i:i + 200]
        if "START" in seg:
            start = html.rfind("<!--", 0, i)
            j = html.find("COMMENT-LAYER", i + 1)
            while j != -1:
                if "END" in html[j:j + 200]:
                    end = html.find("-->", j)
                    if start != -1 and end != -1:
                        return start, end + 3
                j = html.find("COMMENT-LAYER", j + 1)
            break
        i = html.find("COMMENT-LAYER", i + 1)
    return None


def extract_store(html, store_id):
    """<script id="..." type="application/json">...</script> の中身を取り出す。"""
    m = re.search(
        r'<script[^>]*\bid=["\']%s["\'][^>]*>(.*?)</script\s*>' % re.escape(store_id),
        html, re.S | re.I)
    return m.group(1).strip() if m else None


def replace_store(block, store_id, payload):
    def sub(m):
        return m.group(1) + payload + m.group(3)
    return re.sub(
        r'(<script[^>]*\bid=["\']%s["\'][^>]*>)(.*?)(</script\s*>)' % re.escape(store_id),
        sub, block, count=1, flags=re.S | re.I)


def warn_host(html, out):
    """本文が素直にスクロールできない書き方を検出して知らせる。"""
    problems = []
    style = "\n".join(re.findall(r"<style[^>]*>(.*?)</style\s*>", html, re.S | re.I))
    # セレクタが body そのもののときだけ拾う。\b だと .bigsale-ad-body のような
    # クラス名の末尾に当たって誤検知する
    if re.search(r"(?<![-\w.#])body\s*\{[^}]*overflow\s*:\s*hidden", style, re.I | re.S):
        problems.append("body に overflow:hidden があります。ページ全体がスクロールできないと、"
                        "スペース/PageDown/矢印キーとドック上でのホイールが効きません。削除してください。")
    if re.search(r"(?<![-\w.#])html\s*\{[^}]*overflow\s*:\s*hidden", style, re.I | re.S):
        problems.append("html に overflow:hidden があります。同上。")
    if re.search(r"height\s*:\s*100vh", style, re.I):
        problems.append("100vh 指定があります。内側 div をスクロールさせる作りだとキーボード操作が効かなくなるため、"
                        "ページ本体がスクロールする作りか確認してください。")
    for p in problems:
        print("  [注意] " + p, file=out)
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("-o", "--out", help="書き出し先（既定: <元名>_commented.html）")
    ap.add_argument("--in-place", action="store_true", help="元ファイルを上書き（.bak を作る）")
    ap.add_argument("--strip", action="store_true", help="レイヤーを取り除く")
    ap.add_argument("--check", action="store_true", help="書き込まずに状態だけ表示")
    ap.add_argument("--carry-from", metavar="OLD_HTML",
                    help="旧レビュー済みHTMLからコメントとユーザーを引き継ぐ（資料をAIが丸ごと再生成した場合用。位置は開いたときの再アンカーが引き受ける）")
    args = ap.parse_args()

    src = pathlib.Path(args.target)
    if not src.exists():
        sys.exit("ファイルが見つかりません: %s" % src)
    html = src.read_text(encoding="utf-8")
    found = find_block(html)

    print("対象   : %s (%.1f KB)" % (src.name, len(html.encode()) / 1024))
    print("レイヤー: %s" % ("あり（更新します）" if found else "なし（新規追加します）"))
    # レイヤー自身のCSS（サイドバーの height:100vh など）を拾わないよう、資料側だけを見る
    warn_host(html[:found[0]] + html[found[1]:] if found else html, sys.stdout)

    if args.check:
        if found:
            store = extract_store(html[found[0]:found[1]], "comment-store") or "[]"
            print("コメント数: 約 %d 件" % store.count('"id":'))
        return

    if args.strip:
        if not found:
            sys.exit("レイヤーが見つかりません。")
        new = (html[:found[0]] + html[found[1]:]).replace("\n\n\n", "\n\n")
    else:
        block = ASSET.read_text(encoding="utf-8").rstrip("\n")
        if found:
            old = html[found[0]:found[1]]
            for sid in ("comment-store", "user-master"):
                payload = extract_store(old, sid)
                if payload:
                    block = replace_store(block, sid, payload)
        if args.carry_from:
            carry = pathlib.Path(args.carry_from)
            if not carry.exists():
                sys.exit("引き継ぎ元が見つかりません: %s" % carry)
            carry_html = carry.read_text(encoding="utf-8")
            carried = False
            for sid in ("comment-store", "user-master"):
                payload = extract_store(carry_html, sid)
                if payload:
                    block = replace_store(block, sid, payload)
                    carried = True
            if not carried:
                sys.exit("引き継ぎ元にコメントデータがありません: %s" % carry)
            store = extract_store(block, "comment-store") or "[]"
            print("引き継ぎ: %s から約 %d 件" % (carry.name, store.count('"id":')))
        if found:
            new = html[:found[0]] + block + html[found[1]:]
        elif "</body>" in html:
            new = html.replace("</body>", block + "\n\n</body>", 1)
        else:
            new = html.rstrip() + "\n" + block + "\n"

    if args.in_place:
        shutil.copy2(src, src.with_suffix(src.suffix + ".bak"))
        dst = src
    elif args.out:
        dst = pathlib.Path(args.out)
    elif args.strip:
        # 追加時と同じ命名だと 資料_commented_commented.html になってしまう。
        # かといって元名に戻すと既存の原本を黙って上書きしかねないので、_stripped で別名にする
        base = src.stem[: -len("_commented")] if src.stem.endswith("_commented") else src.stem
        dst = src.with_name(base + "_stripped.html")
    else:
        dst = src.with_name(src.stem + "_commented.html")
    dst.write_text(new, encoding="utf-8")
    print("書き出し: %s (%.1f KB)" % (dst, len(new.encode()) / 1024))


if __name__ == "__main__":
    main()

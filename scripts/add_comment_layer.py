#!/usr/bin/env python3
"""HTML資料にコメントレイヤーを追加・更新・除去する。

  追加/更新 : python3 add_comment_layer.py 資料.html            (別名で書き出し)
              python3 add_comment_layer.py 資料.html --in-place
  除去      : python3 add_comment_layer.py 資料.html --strip
  検査のみ  : python3 add_comment_layer.py 資料.html --check
  合流      : python3 add_comment_layer.py Aさん.html --merge Bさん.html

すでにレイヤーが入っているファイルに対しては、書き込まれたコメントデータ
(comment-store / user-master) を引き継いだままエンジンだけを差し替える。
"""
import argparse
import json
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


# ---------------------------------------------------------------------------
# 合流（--merge）
#
# AさんとBさんが同じ資料から別々に書いたレビューを、1つのファイルにまとめる。
# --carry-from が「丸ごと差し替え」なのに対して、こちらは ID で突き合わせた和集合。
# ---------------------------------------------------------------------------

def dump_store(obj):
    """レイヤー本体の exportHTML() の enc() と同じ書き方でJSONに戻す。

    `<` をユニコードエスケープしないと、コメント本文に閉じscriptタグを書かれた時点で
    ファイルが壊れる。COMMENT-LAYER を伏せないと、レイヤーの境界検出（find_block）が
    コメント本文に反応して --in-place での差し替えができなくなる。
    """
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace("COMMENT-LAYER", "COMMENT\\u002dLAYER")


def load_store(html, store_id):
    """埋め込みJSONを Python のオブジェクトとして取り出す。無ければ None。"""
    raw = extract_store(html, store_id)
    if raw is None or not raw.strip():
        return None
    try:
        v = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit("%s のJSONが読めません: %s" % (store_id, e))
    return v if isinstance(v, list) else None


def _mtime(o):
    """新しさの比較キー。updatedAt が無い旧データは date で比べる（ISO文字列は辞書順＝時系列）。"""
    return str((o or {}).get("updatedAt") or (o or {}).get("date") or "")


def merge_replies(a, b):
    """返信も id で和集合にする。ここを忘れると、合流したときに返信だけ消える。"""
    out, seen = [], {}
    for r in list(a or []) + list(b or []):
        rid = (r or {}).get("id")
        if not rid:
            out.append(r)
            continue
        if rid not in seen:
            seen[rid] = len(out)
            out.append(r)
        elif _mtime(r) > _mtime(out[seen[rid]]):
            out[seen[rid]] = r
    return out


def merge_comments(base, other):
    out, seen = [], {}
    for c in list(base or []) + list(other or []):
        cid = (c or {}).get("id")
        if not cid:
            out.append(c)
            continue
        if cid not in seen:
            seen[cid] = len(out)
            out.append(dict(c))
            continue
        cur = out[seen[cid]]
        # 同じ指摘を両方が触っていたら、最終更新が新しい方を採る
        merged = dict(c if _mtime(c) > _mtime(cur) else cur)
        reps = merge_replies(cur.get("replies"), c.get("replies"))
        if reps:
            merged["replies"] = reps
        else:
            merged.pop("replies", None)
        out[seen[cid]] = merged
    return out


def merge_users(base, other):
    """id で和集合。同じ id で名前・色が違うときは基準ファイル側を残す。"""
    out, seen = [], {}
    for u in list(base or []):
        uid = (u or {}).get("id")
        if uid and uid in seen:
            continue
        if uid:
            seen[uid] = True
        out.append(u)
    for u in list(other or []):
        uid = (u or {}).get("id")
        if uid and uid in seen:
            continue
        if uid:
            seen[uid] = True
        out.append(u)
    return out


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
    ap.add_argument("--merge", metavar="OTHER_HTML",
                    help="別の人がレビューした同じ資料のHTMLと、コメント・ユーザーを合流させる（IDで突き合わせた和集合）")
    args = ap.parse_args()

    if args.strip and (args.merge or args.carry_from):
        sys.exit("--strip とコメントの持ち込み（--merge / --carry-from）は同時に指定できません。")

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
        if args.merge:
            other = pathlib.Path(args.merge)
            if not other.exists():
                sys.exit("合流元が見つかりません: %s" % other)
            other_html = other.read_text(encoding="utf-8")
            other_comments = load_store(other_html, "comment-store")
            if other_comments is None:
                sys.exit("合流元にコメントデータがありません: %s" % other)
            base_comments = load_store(block, "comment-store") or []
            # レイヤーがまだ無いファイルに合流するとき、いま block に入っているユーザーは
            # アセット同梱の「レビュアー1」＝ただの初期値であってデータではない。
            # これを基準側として優先すると、同じ id を持つ相手の実名が初期値に潰される
            base_users = (load_store(block, "user-master") or []) if found else []
            other_users = load_store(other_html, "user-master") or []

            merged_comments = merge_comments(base_comments, other_comments)
            merged_users = merge_users(base_users, other_users)
            block = replace_store(block, "comment-store", dump_store(merged_comments))
            block = replace_store(block, "user-master", dump_store(merged_users))

            added = len(merged_comments) - len(base_comments)
            print("合流   : %s の %d 件を取り込み、%d 件 → %d 件（新規 %d 件・重複 %d 件）"
                  % (other.name, len(other_comments), len(base_comments),
                     len(merged_comments), added, len(other_comments) - added))
            print("         ユーザー: %d 人 → %d 人" % (len(base_users), len(merged_users)))
            # 突き合わせは id だけで行う（名前で寄せると、同姓の別人が1人に潰れる）。
            # そのぶん、AさんとBさんが「それぞれ自分を追加した」場合は同名で2人並ぶ。
            # 黙って並べると誰も気づかないので、ここで名指しして知らせる
            names = {}
            for u in merged_users:
                names.setdefault(str(u.get("name", "")).strip(), []).append(u)
            dup = [n for n, v in names.items() if n and len(v) > 1]
            if dup:
                print("  [注意] 同じ名前で別々に登録されたユーザーがいます: %s" % "、".join(dup))
                print("         それぞれが自分を追加すると、IDが違うので別人として並びます。"
                      "合流後のファイルを開き、「ユーザーを管理」で不要な方を削除してください"
                      "（書き込みは消えません）。")
            # 本文のハイライトは合流しない。合流後の本文は基準ファイル側のものなので、
            # もう片方のコメントは対象を失った状態で入り、開いたときの再アンカーが拾い直す
            print("         ※本文のハイライトは合流していません。書き出したファイルを"
                  "ブラウザで開いた時点で、引用が本文に一意に残っている指摘は位置が復元されます。")
            print("         ※復元できなかった指摘は画面上部に警告が出ますが、"
                  "コメントそのものは失われていません。")
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
    elif args.merge:
        # 合流の入力はたいてい 資料_commented.html なので、既定を _commented にすると
        # 資料_commented_commented.html になる。何をしたファイルかが名前で分かるようにする
        base = src.stem[: -len("_commented")] if src.stem.endswith("_commented") else src.stem
        dst = src.with_name(base + "_merged.html")
    else:
        dst = src.with_name(src.stem + "_commented.html")
    dst.write_text(new, encoding="utf-8")
    print("書き出し: %s (%.1f KB)" % (dst, len(new.encode()) / 1024))


if __name__ == "__main__":
    main()

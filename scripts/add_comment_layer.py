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
import datetime
import json
import pathlib
import random
import re
import shutil
import string
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


# ---------------------------------------------------------------------------
# 版の系譜（comment-meta）
#
# ブラウザ側と同じ構造を Python でも組み立てる。docId は資料の系統、revId はファイル1個。
# ★unverified / unverifiedAt を書くのはブラウザだけ。こちらは照合（引用が本文から
#   消えたか）ができないので、触ったら必ず消す。古い数字を残すと --check が
#   --apply-state 適用前の数を報告してしまう。
# ---------------------------------------------------------------------------

LINEAGE_MAX = 200


def now_iso():
    return (datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="milliseconds").replace("+00:00", "Z"))


def load_meta(html):
    """comment-meta を dict で返す。無い・壊れているなら空 dict。"""
    raw = extract_store(html, "comment-meta")
    if not raw:
        return {}
    try:
        v = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return v if isinstance(v, dict) else {}


def new_id(prefix):
    return "%s-%s" % (prefix, "".join(random.choice(string.ascii_lowercase + string.digits)
                                      for _ in range(8)))


def bump_meta(meta, op, title=None):
    """版を1つ進める。meta が空なら新規注入として組み立てる。

    ブラウザの exportHTML() と同じ手順（parentRevId ← 旧revId、revId 再生成、gen +1、
    lineage 追記）。by はCLIからは分からないので空にする（ブラウザ側が入れる）。
    """
    meta = dict(meta or {})
    at = now_iso()
    lineage = meta.get("lineage")
    if not isinstance(lineage, list):
        lineage = []
    if not meta.get("docId"):
        meta = {"schema": 1, "docId": new_id("doc"), "revId": None,
                "parentRevId": None, "gen": 0, "lineage": []}
        lineage = []
        op = "inject"
    meta["schema"] = 1
    meta["parentRevId"] = meta.get("revId") or None
    meta["revId"] = new_id("rev")
    meta["gen"] = (meta.get("gen") if isinstance(meta.get("gen"), int) else len(lineage)) + 1
    if title:
        meta["title"] = title
    meta["lineage"] = (lineage + [{"revId": meta["revId"], "at": at, "by": "", "op": op}])[-LINEAGE_MAX:]
    # ★照合できないので、ブラウザが書いた件数は必ず捨てる（古い数字で嘘をつかせない）
    meta.pop("unverified", None)
    meta.pop("unverifiedAt", None)
    return meta


def merge_lineage(a, b):
    """2本の系譜を revId で和集合にし、時刻順に並べる。"""
    out, seen = [], set()
    for e in list(a or []) + list(b or []):
        rid = (e or {}).get("revId")
        if not rid or rid in seen:
            continue
        seen.add(rid)
        out.append(e)
    out.sort(key=lambda e: str((e or {}).get("at") or ""))
    return out[-LINEAGE_MAX:]


def merge_meta(base, other):
    """--merge 用。docId は主ファイル側を維持し、lineage だけ合流させる。"""
    m = dict(base or {})
    if not m.get("docId") and (other or {}).get("docId"):
        # 主ファイルにまだレイヤーが無い場合だけ、相手の系統に乗る
        m["docId"] = other["docId"]
    m["lineage"] = merge_lineage((base or {}).get("lineage"), (other or {}).get("lineage"))
    m["gen"] = max(_gen(base), _gen(other))
    return m


def _gen(m):
    g = (m or {}).get("gen")
    return g if isinstance(g, int) and g > 0 else len(((m or {}).get("lineage") or []))


def rev_set(m):
    """そのファイルが辿ってきた版のID全部（自分自身を含む）。"""
    s = set()
    for e in ((m or {}).get("lineage") or []):
        rid = (e or {}).get("revId")
        if rid:
            s.add(rid)
    if (m or {}).get("revId"):
        s.add(m["revId"])
    return s


def guard_different_doc(base, other, base_name, other_name, force, out=sys.stdout):
    """別の資料同士のマージだけは作業前に止める。★中断してよいのはここだけ。"""
    bd, od = (base or {}).get("docId"), (other or {}).get("docId")
    if not (bd and od and bd != od):
        return
    print("  [警告] 別の資料をマージしようとしています（docIdが一致しません）。", file=out)
    print("         %s: %s" % (base_name, bd), file=out)
    print("         %s: %s" % (other_name, od), file=out)
    if not force:
        # ★「続行しますか」と聞いてはいけない。答える手段が無い
        sys.exit("         意図した操作なら --force を付けて再実行してください。")
    print("         --force が指定されているので続行します。", file=out)


def report_lineage(base, other, base_name, other_name, out=sys.stdout):
    """分岐しているのか、親子なのかを知らせる。★処理は止めない。"""
    bd, od = (base or {}).get("docId"), (other or {}).get("docId")
    brs, ors = rev_set(base), rev_set(other)
    brev, orev = (base or {}).get("revId"), (other or {}).get("revId")
    # 親子関係。分岐していないのでマージする必要が無い＝新しい方をそのまま使えばよい
    if brev and brev in ors and brev != orev:
        print("  [注意] %s は %s の祖先です。マージせず新しい方を使ってください。"
              % (base_name, other_name), file=out)
        return
    if orev and orev in brs and brev != orev:
        print("  [注意] %s は %s の祖先です。合流しても新しい指摘は増えません。"
              % (other_name, base_name), file=out)
        return
    shared = brs & ors
    if shared:
        at = {}
        for m in (base, other):
            for e in ((m or {}).get("lineage") or []):
                if (e or {}).get("revId") in shared:
                    at[e["revId"]] = str(e.get("at") or "")
        newest = sorted(shared, key=lambda r: at.get(r, ""))[-1]
        print("         系譜  : 共通の版 %s から分岐した2本" % newest, file=out)
    elif bd or od:
        # lineage を 200 件で打ち切っているので原理的には起こりうる。落ちないことだけ担保する
        print("         系譜  : 共通の版を特定できませんでした", file=out)


def drop_runtime_attr(html, attr):
    """実行時に付いた属性を落とす。★消してよいのはタグの中にある属性だけ。

    本文に同じ語が書いてあっても消してはいけない。このレイヤー自身を説明する資料は
    「書き出したファイルに data-cl-host が焼き込まれていた」のように本文へ普通に書くので、
    文書全体に `\\s+attr` を掛けると本文から語が消える（実測で踏んだ）。
    SKILL.md の「一般的な断片の部分一致で書かない」と同じ穴。
    """
    inner = re.compile(r'\s+%s(="[^"]*")?(?=[\s/>])' % re.escape(attr))
    return re.sub(r'<[a-zA-Z][^>]*>', lambda m: inner.sub("", m.group(0)), html)


def doc_title(html):
    m = re.search(r"<title[^>]*>(.*?)</title\s*>", html, re.S | re.I)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


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


# ---------------------------------------------------------------------------
# 状態の反映（--apply-state）
#
# AIが資料の本文を直したあと、「どの指摘に対応したか」を受け取って完了にする。
# AIに書かせるのは id と真偽値だけ。返信もコメントも書かせない（本文を見れば分かるので、
# AIの作文を9件並べると人間の議論が薄まる）。埋め込みJSONを直接編集させる経路も持たない
# ——ファイル破壊の防止を、AIがプロンプトを守るかどうかに賭けないため。
# ---------------------------------------------------------------------------

def apply_state(block, path, out=sys.stdout):
    """review-state.json の resolved を反映した block を返す。

    ★既に完了している指摘には一切触れない（resolvedAt も上書きしない）。
      この一点で冪等になる——同じパッチを2回流しても結果が変わらない。
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit("%s のJSONが読めません: %s" % (path.name, e))
    updates = data.get("updates") if isinstance(data, dict) else None
    if not isinstance(updates, list):
        sys.exit("%s に updates 配列がありません。" % path.name)

    comments = load_store(block, "comment-store")
    # ★None だけを見ていると到達しない。レイヤーが無いファイルでは block はアセット同梱の
    #   空配列なので load_store は [] を返し、案内の代わりに「該当なし」の警告が
    #   updates の件数ぶん並んだうえで、コメント0件のファイルを書き出してしまっていた
    if not comments:
        sys.exit("状態を反映する先のコメントがありません: %s\n"
                 "  資料をAIが丸ごと作り直した場合は、--carry-from で旧レビューHTMLを指定してください。" % path.name)

    index = {}
    for c in comments:
        cid = (c or {}).get("id")
        if cid and cid not in index:
            index[cid] = c

    at = now_iso()
    applied, warns, notes, saw_reply = 0, [], [], False
    for u in updates:
        if not isinstance(u, dict):
            warns.append("updates に辞書でない要素があります（スキップ）")
            continue
        if "reply" in u:
            saw_reply = True
        cid = u.get("id")
        c = index.get(cid)
        # AIはIDを捏造することがある。ここで全体を落とさず、1件だけ飛ばして続ける
        if c is None:
            warns.append("id=%s に該当するコメントがありません（スキップ）" % cid)
            continue
        if u.get("resolved") is not True:
            notes.append("id=%s は resolved が true ではありません（何もしません）" % cid)
            continue
        if c.get("resolved"):
            notes.append("id=%s は既に完了です（変更しません）" % cid)
            continue
        c["resolved"] = True
        c["resolvedBy"] = "AI"
        c["resolvedAt"] = at
        # ★updatedAt は動かさない。完了で並び順を変えないという既存の約束（commit の resolve と同じ）
        applied += 1

    skipped = len(updates) - applied
    print("状態反映: %s の %d 件中 %d 件を反映（完了 %d 件・スキップ %d 件）"
          % (path.name, len(updates), applied, applied, skipped), file=out)
    if saw_reply:
        warns.insert(0, "reply は受け付けません（無視しました）。返信は人が書くものです")
    for w in warns:
        print("   [警告] " + w, file=out)
    for n in notes:
        print("   [情報] " + n, file=out)
    # ★照合はしない。--apply-state の時点ではブラウザが描画していないので、
    #   反映したぶんは「全件が未検算」——推測ではなく状態の正確な記述
    if applied:
        print("   [注意] %d 件をAI完了にしました。いずれも未検算です。開いて確認してください"
              % applied, file=out)
    return replace_store(block, "comment-store", dump_store(comments))


# ---------------------------------------------------------------------------
# 検査（--check）
#
# ★これは診断コマンドなので、何があっても落ちてはいけない。いちばん壊れているファイルで
#   使えないのでは意味が無い（load_store() は JSON が壊れていると sys.exit する）。
#   壊れていること自体が最重要の所見なので、報告して終了コード0で戻る。
# ---------------------------------------------------------------------------

def report_check(block, out=sys.stdout):
    m = re.search(r"COMMENT-LAYER v([0-9][0-9.]*)", block)
    print("レイヤー: あり（v%s）" % (m.group(1) if m else "版不明"), file=out)

    raw = extract_store(block, "comment-meta")
    meta, meta_broken = {}, False
    if raw:
        try:
            v = json.loads(raw)
            meta = v if isinstance(v, dict) else {}
        except json.JSONDecodeError:
            meta_broken = True
    if meta_broken:
        print("系譜   : 読み取れません（comment-meta のJSONが壊れています）", file=out)
    elif meta.get("docId"):
        gen = meta.get("gen")
        tail = "%s代目" % gen if isinstance(gen, int) else "代数不明"
        if meta.get("parentRevId"):
            tail += "・親 %s" % meta["parentRevId"]
        else:
            tail += "・初版"
        print("系譜   : %s / %s（%s）" % (meta["docId"], meta.get("revId") or "rev不明", tail), file=out)
    else:
        print("系譜   : まだありません（開くか --in-place を通すと作られます）", file=out)

    raw = extract_store(block, "comment-store")
    try:
        comments = json.loads(raw) if raw and raw.strip() else []
        if not isinstance(comments, list):
            raise ValueError
    except (json.JSONDecodeError, ValueError):
        print("コメント: 読み取れません（comment-store のJSONが壊れています）", file=out)
        return
    done = [c for c in comments if isinstance(c, dict) and c.get("resolved")]
    print("コメント: %d 件（未対応 %d 件・完了 %d 件）"
          % (len(comments), len(comments) - len(done), len(done)), file=out)
    # ★未検算は comment-meta に書かれた値を読むだけ。照合（引用が本文から消えたか）は
    #   描画後のDOMに依存するので Python では再現できない。2実装にすると必ずズレる。
    #   Python 側の書き込み経路は unverified を消すので、ここが「不明」なのは正常。
    #   ★「まだ開いていません」とは書かない。消したから空なのか、一度も開いていないのかは
    #     区別が付かない。断定せず、次の行動だけ書く
    if isinstance(meta.get("unverified"), int):
        when = fmt_when(meta.get("unverifiedAt"))
        print("未検算  : %d 件%s" % (meta["unverified"],
              ("（%s にブラウザで開いた時点）" % when) if when else ""), file=out)
    else:
        print("未検算  : 不明（ブラウザで開いて保存すると分かります）", file=out)


def fmt_when(iso):
    try:
        d = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone()
        return d.strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return ""


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
    ap.add_argument("--apply-state", metavar="REVIEW_STATE_JSON",
                    help="AIが出力した review-state.json を読み、対応済みの指摘を完了にする")
    ap.add_argument("--force", action="store_true",
                    help="--merge で docId が一致しなくても続行する（別の資料同士のマージ）")
    args = ap.parse_args()

    if args.strip and (args.merge or args.carry_from or args.apply_state):
        sys.exit("--strip とコメントの持ち込み（--merge / --carry-from / --apply-state）は同時に指定できません。")
    # ★--check は書き込まないので、書き込む指定と一緒に渡されたら黙って捨てずに断る。
    #   無言で無視すると「反映したつもり」で先へ進まれる
    if args.check and (args.merge or args.carry_from or args.apply_state or args.in_place or args.out):
        sys.exit("--check は状態を表示するだけです。書き込む指定（--in-place / -o / --merge / "
                 "--carry-from / --apply-state）とは同時に指定できません。")

    src = pathlib.Path(args.target)
    if not src.exists():
        sys.exit("ファイルが見つかりません: %s" % src)
    html = src.read_text(encoding="utf-8")
    found = find_block(html)

    print("対象   : %s (%.1f KB)" % (src.name, len(html.encode()) / 1024))
    # --check は書き込まないので「更新します」と言ってはいけない。版は report_check が出す
    if not args.check:
        print("レイヤー: %s" % ("あり（更新します）" if found else "なし（新規追加します）"))
    elif not found:
        print("レイヤー: なし")
    # レイヤー自身のCSS（サイドバーの height:100vh など）を拾わないよう、資料側だけを見る
    warn_host(html[:found[0]] + html[found[1]:] if found else html, sys.stdout)

    if args.check:
        if found:
            report_check(html[found[0]:found[1]])
        return

    if args.strip:
        if not found:
            sys.exit("レイヤーが見つかりません。")
        new = (html[:found[0]] + html[found[1]:]).replace("\n\n\n", "\n\n")
        # v2.14.1 より前に保存されたファイルは data-cl-host が host 要素に焼き込まれたままで、
        # ブロック自体の外にあるためレイヤー除去では消えない（ピンモードの十字カーソルが
        # 無関係な要素に残る）。--strip では実行時の印として一緒に落とす
        new = drop_runtime_attr(new, "data-cl-host")
    else:
        block = ASSET.read_text(encoding="utf-8").rstrip("\n")
        # 版の系譜の起点。既存レイヤーがあればその meta を引き継ぐ（無ければ新規注入）。
        # ★comment-store / user-master と同じループに comment-meta を混ぜてはいけない。
        #   そのままコピーすると revId まで引き継がれ、別のファイルなのに同じ版になる
        base_meta = load_meta(html[found[0]:found[1]]) if found else {}
        meta_op = ("in-place" if args.in_place else "update") if found else "inject"
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
            # docId と lineage は引き継ぎ元から継承する（同じ資料の続きだから）。
            # revId は新しく振る（bump_meta が parentRevId に引き継ぎ元の revId を入れる）
            base_meta = load_meta(carry_html)
            meta_op = "carry"
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
            # ★合流の前に事故を検知する。--merge は分岐の後始末であって、
            #   「別の資料だった」「そもそも分岐していなかった」は防げていなかった
            other_meta = load_meta(other_html)
            guard_different_doc(base_meta, other_meta, src.name, other.name, args.force)
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
            report_lineage(base_meta, other_meta, src.name, other.name)
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
            # 系譜は主ファイル側を維持し、両方の lineage を時系列でマージする
            base_meta = merge_meta(base_meta, other_meta)
            meta_op = "merge"
        # ★carry / merge のあとに流す。丸ごと再生成 → 引き継ぎ → 状態反映 が1コマンドで通る
        if args.apply_state:
            state = pathlib.Path(args.apply_state)
            if not state.exists():
                sys.exit("状態ファイルが見つかりません: %s" % state)
            block = apply_state(block, state)
            # ★系譜の目的は「この版で何が起きたか」なので、AIの書き戻しはいちばん残したい op。
            #   これが無いと、ふつうの --in-place と区別が付かない。
            #   ただし op は1つしか持てないので、上書きするのは単独指定のときだけにする。
            #   --carry-from（資料を丸ごと差し替えた）と --merge（2本を合流させた）は、
            #   版の系譜としてはこちらのほうが情報量が大きいので譲らない
            if not args.carry_from and not args.merge:
                meta_op = "apply-state"
        block = replace_store(block, "comment-meta",
                              dump_store(bump_meta(base_meta, meta_op, doc_title(html))))
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
    elif args.apply_state and not args.carry_from:
        # --merge と同じ理由（入力が 資料_commented.html なので _commented_commented になる）。
        # ★--carry-from との併用時は既定のまま _commented にする。そのときの対象は
        #   AIが丸ごと再生成した素の資料で、「レイヤーを新規に入れた」が名前に出るべきだから
        base = src.stem[: -len("_commented")] if src.stem.endswith("_commented") else src.stem
        dst = src.with_name(base + "_applied.html")
    else:
        dst = src.with_name(src.stem + "_commented.html")
    dst.write_text(new, encoding="utf-8")
    print("書き出し: %s (%.1f KB)" % (dst, len(new.encode()) / 1024))


if __name__ == "__main__":
    main()

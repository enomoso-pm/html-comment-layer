#!/usr/bin/env python3
"""CLI側（add_comment_layer.py）の動作確認。

    python3 scripts/verify_cli.py ../../サンプル/demo-要件レビュー_確認用.html

ブラウザ側は verify.mjs が見る。こちらは --apply-state / --merge の判定 / --check /
comment-meta の生成と引き継ぎ、つまり「Pythonが書く側」だけを見る。
標準ライブラリのみ。一時ファイルは tempfile に作って必ず片付ける。
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "add_comment_layer.py"

_pass, _fail = 0, 0


def ok(name, cond, detail=""):
    """detail は落ちたときだけ出す。通ったぶんまで出すとログが読めなくなる。"""
    global _pass, _fail
    if cond:
        _pass += 1
        print("✅ %s" % name)
    else:
        _fail += 1
        print("❌ %s%s" % (name, ("  … " + str(detail).strip()) if detail else ""))


def run(*args):
    r = subprocess.run([sys.executable, str(SCRIPT)] + [str(a) for a in args],
                       capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def store(path, sid="comment-store"):
    h = pathlib.Path(path).read_text(encoding="utf-8")
    m = re.search(r'<script[^>]*\bid="%s"[^>]*>(.*?)</script\s*>' % sid, h, re.S)
    if not m:
        return None
    raw = m.group(1).strip()
    return json.loads(raw) if raw else None


def main():
    if len(sys.argv) < 2:
        sys.exit("使い方: python3 verify_cli.py <コメント入りのHTML>")
    src = pathlib.Path(sys.argv[1]).resolve()
    if not src.exists():
        sys.exit("ファイルが見つかりません: %s" % src)

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="cl-verify-"))
    try:
        base = tmp / "base_commented.html"
        shutil.copy2(src, base)
        run(base, "--in-place")
        comments = store(base)
        if not comments:
            sys.exit("このファイルにはコメントが入っていません。確認用のHTMLを指定してください。")
        ids = [c["id"] for c in comments]
        text_ids = [c["id"] for c in comments if c.get("type") == "text"]
        open_ids = [c["id"] for c in comments if not c.get("resolved")]
        done_ids = [c["id"] for c in comments if c.get("resolved")]

        # ---- comment-meta の生成 --------------------------------------------------
        m1 = store(base, "comment-meta")
        ok("--in-place で comment-meta が作られる", bool(m1 and m1.get("docId")), m1)
        ok("lineage が inject から始まる", (m1.get("lineage") or [{}])[0].get("op") == "inject")
        ok("ブラウザ以外は unverified を書かない", "unverified" not in m1)

        run(base, "--in-place")
        m2 = store(base, "comment-meta")
        ok("--in-place のたびに revId が変わる", m2["revId"] != m1["revId"])
        ok("parentRevId が直前の revId を指す", m2["parentRevId"] == m1["revId"])
        ok("docId は変わらない", m2["docId"] == m1["docId"])
        ok("gen が増える", m2["gen"] == m1["gen"] + 1, "%s → %s" % (m1["gen"], m2["gen"]))

        # ---- --apply-state --------------------------------------------------------
        target = open_ids[0]
        state = tmp / "review-state.json"
        state.write_text(json.dumps({"updates": [
            {"id": target, "resolved": True},
            {"id": "txt-notexist99", "resolved": True},
            {"id": target, "resolved": True, "reply": "旧形式の返信"},
        ] + ([{"id": done_ids[0], "resolved": True}] if done_ids else [])},
            ensure_ascii=False), encoding="utf-8")

        before_done = store(base)
        before_done = {c["id"]: dict(c) for c in before_done}
        code, out = run(base, "--apply-state", state, "--in-place")
        ok("--apply-state の終了コードが0（捏造IDがあっても）", code == 0, out.strip().splitlines()[-1:])
        ok("存在しないIDを名指しで警告する", "txt-notexist99" in out and "警告" in out)
        ok("reply は受け付けず警告する", "reply は受け付けません" in out)
        ok("未検算であることをCLIが伝える", "いずれも未検算です" in out)
        after = {c["id"]: c for c in store(base)}
        ok("resolved が true になる", after[target]["resolved"] is True)
        ok("resolvedBy が AI になる", after[target].get("resolvedBy") == "AI")
        ok("resolvedAt が入る", bool(after[target].get("resolvedAt")))
        ok("updatedAt は動かさない",
           after[target].get("updatedAt") == before_done[target].get("updatedAt"))
        ok("他のコメントは増減しない", len(after) == len(ids))
        if done_ids:
            d = done_ids[0]
            ok("既に完了の指摘は resolvedAt ごと不変",
               after[d].get("resolvedAt") == before_done[d].get("resolvedAt") and
               after[d].get("resolvedBy") == before_done[d].get("resolvedBy"))
        ok("--apply-state 後は unverified が消えている",
           "unverified" not in store(base, "comment-meta"))

        snapshot = json.dumps(store(base), ensure_ascii=False, sort_keys=True)
        code, out = run(base, "--apply-state", state, "--in-place")
        ok("2回流しても結果が変わらない（冪等）",
           json.dumps(store(base), ensure_ascii=False, sort_keys=True) == snapshot)
        ok("2回目は0件反映と報告する", "0 件を反映" in out, out)

        # ---- 出力名 ---------------------------------------------------------------
        code, out = run(base, "--apply-state", state)
        ok("--apply-state 単独の既定出力は _applied.html",
           (tmp / "base_applied.html").exists(), out)

        # ---- 閉じscriptタグと境界マーカーを含む返信 --------------------------------
        nasty = tmp / "nasty_commented.html"
        shutil.copy2(base, nasty)
        h = nasty.read_text(encoding="utf-8")
        cs = store(nasty)
        cs[0]["replies"] = [{"id": "rep-nasty01", "author": "山本", "color": "#c74700",
                             "date": "2026-01-01T00:00:00.000Z",
                             "text": "</script> と COMMENT-LAYER を書く"}]
        enc = (json.dumps(cs, ensure_ascii=False, separators=(",", ":"))
               .replace("<", "\\u003c").replace("COMMENT-LAYER", "COMMENT\\u002dLAYER"))
        h = re.sub(r'(<script[^>]*\bid="comment-store"[^>]*>)(.*?)(</script\s*>)',
                   lambda m: m.group(1) + enc + m.group(3), h, count=1, flags=re.S)
        nasty.write_text(h, encoding="utf-8")
        code, out = run(nasty, "--apply-state", state, "--in-place")
        raw = re.search(r'<script[^>]*\bid="comment-store"[^>]*>(.*?)</script\s*>',
                        nasty.read_text(encoding="utf-8"), re.S).group(1)
        ok("危険な返信を含むファイルでも壊れない", code == 0 and store(nasty) is not None)
        ok("閉じscriptタグが生で書き出されない", "</scr" + "ipt>" not in raw)
        ok("COMMENT-LAYER が生で書き出されない", "COMMENT-LAYER" not in raw)
        code, out = run(nasty, "--in-place")
        ok("そのあとも --in-place が効く", code == 0 and "あり（更新します）" in out, out)

        # ---- --carry-from + --apply-state -----------------------------------------
        plain = tmp / "regen.html"
        stripped = run(base, "--strip", "-o", str(plain))
        ok("--strip で素の資料に戻せる", plain.exists())
        code, out = run(plain, "--carry-from", base, "--apply-state", state)
        outfile = tmp / "regen_commented.html"
        ok("--carry-from と --apply-state を1コマンドで通せる", code == 0 and outfile.exists(), out)
        ok("--carry-from 併用時の出力名は _commented.html", outfile.exists())
        carried = store(outfile)
        ok("コメントが引き継がれる", carried is not None and len(carried) == len(ids))
        mc = store(outfile, "comment-meta")
        ok("docId が引き継がれる", mc["docId"] == m1["docId"], mc.get("docId"))
        ok("lineage に carry が積まれる", mc["lineage"][-1]["op"] == "carry")

        # ---- --merge の判定 --------------------------------------------------------
        parent = tmp / "parent_commented.html"
        shutil.copy2(base, parent)
        run(parent, "--in-place")
        a = tmp / "a_commented.html"
        bfile = tmp / "b_commented.html"
        shutil.copy2(parent, a)
        shutil.copy2(parent, bfile)
        run(a, "--in-place")
        run(bfile, "--in-place")
        code, out = run(a, "--merge", bfile)
        ok("分岐した2本で共通祖先を報告する", "共通の版" in out and "から分岐した2本" in out, out)
        code, out = run(parent, "--merge", a)
        ok("親子関係を検出して注意を出す", "の祖先です" in out, out)
        ok("親子でも処理は止めない", code == 0)

        other = tmp / "other_commented.html"
        other.write_text(pathlib.Path(a).read_text(encoding="utf-8"), encoding="utf-8")
        h = other.read_text(encoding="utf-8")
        mo = store(other, "comment-meta")
        mo["docId"] = "doc-different1"
        h = re.sub(r'(<script[^>]*\bid="comment-meta"[^>]*>)(.*?)(</script\s*>)',
                   lambda m: m.group(1) + json.dumps(mo, ensure_ascii=False) + m.group(3),
                   h, count=1, flags=re.S)
        other.write_text(h, encoding="utf-8")
        code, out = run(a, "--merge", other)
        ok("docId 不一致を検出して中断する", code != 0 and "docIdが一致しません" in out, out)
        ok("中断の文面が次の行動を示す", "--force を付けて再実行" in out)
        code, out = run(a, "--merge", other, "--force")
        ok("--force で続行できる", code == 0 and "続行します" in out, out)

        # ---- --check ---------------------------------------------------------------
        code, out = run(base, "--check")
        ok("--check がレイヤーの版を出す", re.search(r"レイヤー: あり（v[0-9]", out) is not None, out)
        ok("--check が系譜を出す", "系譜   : doc-" in out, out)
        ok("--check がコメントの内訳を出す", re.search(r"コメント: \d+ 件（未対応 \d+ 件・完了 \d+ 件）", out) is not None, out)
        ok("--check の未検算は断定しない（Pythonは照合しない）",
           "未検算  : 不明" in out and "まだ開いていません" not in out, out)
        ok("--check は書き込まない（更新しますと言わない）", "更新します" not in out)

        broken = tmp / "broken_commented.html"
        h = base.read_text(encoding="utf-8")
        h = h.replace('<script id="comment-store" type="application/json">',
                      '<script id="comment-store" type="application/json">{,,,', 1)
        h = h.replace('<script id="comment-meta" type="application/json">',
                      '<script id="comment-meta" type="application/json">{,,,', 1)
        broken.write_text(h, encoding="utf-8")
        code, out = run(broken, "--check")
        ok("壊れたJSONでも --check が落ちない", code == 0, out)
        ok("壊れていることを所見として報告する",
           "コメント: 読み取れません" in out and "系譜   : 読み取れません" in out, out)

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n%d passed / %d failed" % (_pass, _fail))
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    main()

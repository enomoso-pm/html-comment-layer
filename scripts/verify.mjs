// コメントレイヤーの動作確認。依存ゼロ（Node 22+ のネイティブ WebSocket + ローカルのChrome）
//   node verify.mjs 資料_commented.html
import { launch } from './cdp.mjs';

const FILE = process.argv[2];
if (!FILE) { console.error('使い方: node verify.mjs <target.html>'); process.exit(1); }

const b = await launch(9340);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  … ' + detail : ''}`);
};

try {
  await b.goto('file://' + encodeURI(FILE.startsWith('/') ? FILE : process.cwd() + '/' + FILE));

  const errs = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('読み込み時にJSエラーが出ない', errs.length === 0, errs.map(e => e.params.exceptionDetails.text).join(' / '));
  ok('レイヤーが起動している', await b.evalJS(`return !!window.__commentLayer`));

  const Y = () => b.evalJS(`return Math.round(window.scrollY);`);
  const rst = () => b.evalJS(`window.scrollTo({top:0,behavior:'instant'}); return 1;`);

  // 1. キーボードスクロール（内側divスクロール実装だと全滅する）
  for (const [code, key] of [[32, ' '], [34, 'PageDown'], [40, 'ArrowDown']]) {
    await rst(); await b.key(code, key, 0, code === 32 ? ' ' : undefined); await b.wait(350);
    const v = await Y();
    ok(`キーボードでスクロールできる (${key === ' ' ? 'Space' : key})`, v > 0, `scrollY=${v}`);
  }

  // 2. ドックの上にカーソルがある状態でのホイール
  await rst();
  const dock = JSON.parse(await b.evalJS(`const r=document.getElementById('cl-dock').getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});`));
  await b.wheel(dock.x, dock.y, 300); await b.wait(300);
  ok('ドックの上でもホイールが効く', (await Y()) > 0, `scrollY=${await Y()}`);

  // 3. Cmd+C でピンモードが暴発しない
  await b.key(67, 'c', 4);
  await b.wait(120);
  ok('Cmd+Cでピンモードが暴発しない', !(await b.evalJS(`return document.documentElement.classList.contains('cl-pinmode')`)));
  // 素のCキーでは切り替わる
  await b.key(67, 'c', 0, 'c'); await b.wait(120);
  const cOn = await b.evalJS(`return document.documentElement.classList.contains('cl-pinmode')`);
  await b.evalJS(`__commentLayer.setPinMode(false); return 1;`);
  ok('素のCキーではピンモードに入る', cOn);

  // 4. ★ 単一テキストノード内の選択でハイライトが付く（旧実装が取りこぼしていた経路）
  const t4 = await b.evalJS(`
    const host = document.querySelector('[data-cl-host]');
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.textContent.trim().length > 6 && __commentLayer._streamTextNodes().indexOf(n) >= 0)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const node = w.nextNode();
    const r = document.createRange();
    r.setStart(node, 1); r.setEnd(node, 5);              // 1つのテキストノードの内側だけを選ぶ
    const before = document.querySelectorAll('.comment-highlight').length;
    __commentLayer._setRange(r);
    __commentLayer.startTextComment();
    const ta = document.getElementById('cl-draft-text');
    if (ta) { ta.value = '単一ノード選択のテスト'; __commentLayer.saveDraft(); }
    return JSON.stringify({before, after: document.querySelectorAll('.comment-highlight').length,
                           saved: __commentLayer.comments.length});
  `);
  const r4 = JSON.parse(t4);
  ok('段落の途中だけを選んでもハイライトが付く', r4.after > r4.before, `ハイライト ${r4.before}→${r4.after}`);

  // 5. サイドバー開閉で読んでいた位置がずれない（幅1280で本文が折り返し直る条件）
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await b.wait(200);
  // 折り返しが変わる以上すべての要素を固定するのは不可能なので、
  //「いま見ている場所（画面中央）」が動かず、その近傍も大きく飛ばないことを見る
  const t5 = await b.evalJS(`
    __commentLayer.setSidebar(false);
    window.scrollTo({top:900,behavior:'instant'});
    // caretRangeFromPoint で「その点に実際に見えている行」を掴む。
    // 折り返しが変わる以上すべての行を固定するのは不可能なので、注視点（画面中央）が
    // 動かないこと＋近傍が半行以内に収まることを見る。
    return new Promise(res => requestAnimationFrame(() => {
      const mid  = document.caretRangeFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
      const near = document.caretRangeFromPoint(Math.round(innerWidth/3), Math.round(innerHeight/3));
      const m0 = mid.getBoundingClientRect().top, n0 = near.getBoundingClientRect().top, y0 = scrollY;
      __commentLayer.setSidebar(true);
      requestAnimationFrame(() => res(JSON.stringify({
        補正量: Math.round(scrollY - y0),
        注視点のずれ: Math.round(mid.getBoundingClientRect().top - m0),
        近傍のずれ: Math.round(near.getBoundingClientRect().top - n0)
      })));
    }));
  `);
  // 判定するのは注視点だけ。折り返しが変わる以上、離れた行が1行分ずれるのは避けようがなく、
  // そこを閾値にすると資料ごとに落ちる意味のないテストになる（近傍の値は参考として出す）。
  const r5 = JSON.parse(t5);
  ok('サイドバーを開いても見ている場所が動かない', Math.abs(r5.注視点のずれ) <= 2, JSON.stringify(r5));

  // 6. サイドバーのカードをクリックすると本文がその位置へ動く
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const t6 = await b.evalJS(`
    const c = __commentLayer.comments.filter(c => document.querySelector('.comment-highlight[data-id="'+c.id+'"]'))[0];
    if (!c) return JSON.stringify({skip:true});
    window.scrollTo({top:0,behavior:'instant'});
    __commentLayer.focusFromList(c.id);
    return new Promise(res => setTimeout(() => {
      const r = document.querySelector('.comment-highlight[data-id="'+c.id+'"]').getBoundingClientRect();
      res(JSON.stringify({見えている: r.top > 0 && r.top < window.innerHeight, top: Math.round(r.top)}));
    }, 800));
  `);
  const r6 = JSON.parse(t6);
  ok('一覧のカードから本文の該当箇所へ飛べる', r6.skip || r6.見えている, `top=${r6.top}`);

  // 7. 本文のハイライトをクリックしても本文は動かない
  const t7 = await b.evalJS(`
    const el = document.querySelector('.comment-highlight');
    __commentLayer.setSidebar(false);
    window.scrollTo({top:600,behavior:'instant'});
    return new Promise(res => requestAnimationFrame(() => {
      const y0 = window.scrollY, top0 = el.getBoundingClientRect().top;
      el.click();
      setTimeout(() => res(JSON.stringify({ずれ: Math.round(el.getBoundingClientRect().top - top0),
        開いた: document.documentElement.classList.contains('cl-open')})), 600);
    }));
  `);
  const r7 = JSON.parse(t7);
  ok('本文のハイライトを押しても本文が飛ばない', r7.開いた && Math.abs(r7.ずれ) <= 4, `ずれ ${r7.ずれ}px`);

  // 8. 書き出し時に描画済みDOMを焼き込まない
  const t8 = await b.evalJS(`
    let captured = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:test'; };
    const origConfirm = window.confirm; window.confirm = () => true;
    const a = document.createElement('a'); const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){};
    __commentLayer.exportHTML();
    URL.createObjectURL = orig; window.confirm = origConfirm; HTMLAnchorElement.prototype.click = origClick;
    return captured.text().then(t => JSON.stringify({
      size: t.length,
      一覧DOMが残っている: /class="cl-item(?! cl-draft)/.test(t),
      ピンDOMが残っている: /class="comment-pin/.test(t),
      コメント件数: (t.match(/"type":"(text|pin)"/g)||[]).length,
      ハイライト数: (t.match(/class="comment-highlight"/g)||[]).length
    }));
  `);
  const r8 = JSON.parse(t8);
  ok('書き出しに描画済みDOMが混ざらない', !r8.一覧DOMが残っている && !r8.ピンDOMが残っている, JSON.stringify(r8));
  ok('書き出しにコメントとハイライトが入っている', r8.コメント件数 > 0 && r8.ハイライト数 > 0,
     `コメント${r8.コメント件数}件 / ハイライト${r8.ハイライト数}個`);

  // 9. 対象を失ったコメントが一覧で分かる
  const t9 = await b.evalJS(`
    __commentLayer.setSidebar(true);
    const orphan = __commentLayer.comments.filter(c => c.type==='text' && !document.querySelector('.comment-highlight[data-id="'+c.id+'"]'));
    return JSON.stringify({orphan: orphan.length, 警告表示: document.querySelectorAll('.cl-orphan').length});
  `);
  const r9 = JSON.parse(t9);
  ok('対象を失ったコメントに警告が出る', r9.orphan === r9.警告表示, `対象なし${r9.orphan}件 / 警告${r9.警告表示}件`);

  const errs2 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('一連の操作でJSエラーが出ない', errs2.length === 0, errs2.map(e => e.params.exceptionDetails.text).join(' / '));

  // ===== ここから v2.1 追加分（指摘コピー・自動退避）=====
  const ABS = FILE.startsWith('/') ? FILE : process.cwd() + '/' + FILE;
  const URL0 = 'file://' + encodeURI(ABS);

  // ページ内で使う共通ヘルパ（本文から一意/重複な文字列を探し、コメントを作る）
  const PAGE_HELPERS = `
    window.__vt = (() => {
      const host = document.querySelector('[data-cl-host]');
      // 走査はレイヤー本体のものをそのまま借りる。ここに除外セレクタを書き写すと、
      // レイヤーにUIを足したときの漏れがテスト側にも伝染し、UIの文言を「本文」として
      // 拾ってしまう（実際、ラッパーの無い資料で使い方ガイドの文を掴んで落ちていた）
      const nodes = () => __commentLayer._streamTextNodes();
      const raw = () => nodes().map(n => n.textContent).join('');
      const count = (s) => { let c = 0, i = 0; const r = raw(); while ((i = r.indexOf(s, i)) >= 0) { c++; i++; } return c; };
      // 文字列の第occ出現に、いまのDOMからrangeを組み立てる。
      // 先行コメントの wrapRange が splitText でノードを割るため、
      // 事前に掴んだノード参照は使えない。毎回ここで作り直すのが正しい
      const rangeAt = (str, occ) => {
        const r = raw();
        let idx = -1, from = 0;
        for (let k = 0; k <= occ; k++) { idx = r.indexOf(str, from); if (idx < 0) return null; from = idx + 1; }
        const range = document.createRange();
        let p = 0, startSet = false;
        for (const n of nodes()) {
          const len = n.textContent.length;
          if (!startSet && idx >= p && idx < p + len) { range.setStart(n, idx - p); startSet = true; }
          if (startSet && idx + str.length > p && idx + str.length <= p + len) {
            range.setEnd(n, idx + str.length - p);
            return range;
          }
          p += len;
        }
        return null;
      };
      const mk = (str, text) => {
        const r0 = rangeAt(str, 0);
        if (!r0) return null;
        __commentLayer._setRange(r0); __commentLayer.startTextComment();
        document.getElementById('cl-draft-text').value = text;
        __commentLayer.saveDraft();
        return __commentLayer.comments[__commentLayer.comments.length - 1].id;
      };
      // 候補はかな・カナ・漢字・英数の連続に限る。©や&のような文字はDOMでは1文字でも
      // ソース上は実体参照（&copy; 等）のことがあり、後段のソース文字列置換が成立しない
      const SAFE = /^[0-9A-Za-z\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC\\u4E00-\\u9FFF]+$/;
      // 本文に1回しか出ない文字列を1ノード内から探す（backwards=trueで末尾側から）
      const uniq = (minLen, exclude, backwards) => {
        const list = backwards ? nodes().reverse() : nodes();
        for (const n of list) {
          const t = n.textContent;
          for (let s = 0; s + minLen <= t.length; s += Math.max(4, minLen)) {
            const cand = t.slice(s, s + minLen);
            if (!SAFE.test(cand)) continue;
            if (exclude.some(x => x && (x.includes(cand) || cand.includes(x)))) continue;
            if (count(cand) === 1) return cand;
          }
        }
        return null;
      };
      // 本文に2回以上出る短い文字列を探す
      const dup = (len, exclude) => {
        for (const n of nodes()) {
          const t = n.textContent;
          for (let s = 0; s + len <= t.length; s++) {
            const cand = t.slice(s, s + len);
            if (!SAFE.test(cand)) continue;
            if (exclude.some(x => x && x.includes(cand))) continue;
            if (count(cand) >= 2) return cand;
          }
        }
        return null;
      };
      return { nodes, raw, count, rangeAt, mk, uniq, dup };
    })();
    `;


  // 17. 指摘コピー：全件がMarkdown化され、HTML断片・UI文言が混ざらず、データに触れない
  const t17 = await b.evalJS(`
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { window.__copied = t; return Promise.resolve(); } }, configurable: true });
    const lenBefore = __commentLayer.comments.length;
    const md = __commentLayer.buildReviewMarkdown();
    document.getElementById('cl-copy').click();
    return new Promise(res => setTimeout(() => {
      const quotes = __commentLayer.comments.filter(c => c.type === 'text' && c.quote);
      res(JSON.stringify({
        blocks: (md.match(/^## 指摘 /gm) || []).length,
        total: lenBefore,
        after: __commentLayer.comments.length,
        htmlTag: /<[a-zA-Z][^>]*>/.test(md),
        uiText: md.indexOf('資料をダウンロード') >= 0 || md.indexOf('指摘をコピー') >= 0 || md.indexOf('コメントスレッド') >= 0,
        intro: md.indexOf('レビュー指摘です') >= 0,
        quotesIn: quotes.every(c => String(c.quote).split('\\n').every(q => md.indexOf('> ' + q) >= 0)),
        pinHasTarget: __commentLayer.comments.every(c => c.type !== 'pin') || md.indexOf('図・画面上の位置への指摘') >= 0,
        copied: window.__copied === md,
        feedback: document.getElementById('cl-copy').textContent.indexOf('コピーしました') >= 0
      }));
    }, 300));
  `);
  const r17 = JSON.parse(t17);
  ok('指摘コピーが全件をMarkdown化し、HTML断片やUI文言が混ざらない',
     r17.blocks === r17.total && r17.total === r17.after && !r17.htmlTag && !r17.uiText
       && r17.intro && r17.quotesIn && r17.pinHasTarget && r17.copied && r17.feedback,
     `blocks=${r17.blocks}/${r17.total}`);

  // 18. 自動退避 → リロード → 復元提案 → ハイライト・ピンごと戻る
  // 選択は本文に一意な静的文字列にする。動的ページではリロードで本文が変わり
  // 退避ハッシュが不一致になるが、その場合も引用照合で復元できることをここで見る
  const seeded = JSON.parse(await b.evalJS(PAGE_HELPERS + `
    const host = document.querySelector('[data-cl-host]');
    const q = __vt.uniq(12, []);
    if (!q) return JSON.stringify({ fatal: '一意な文字列が見つからない' });
    const txtId = __vt.mk(q, '退避復元テストのコメント');
    __commentLayer.setPinMode(true);
    const hr = host.getBoundingClientRect();
    const x = Math.round(hr.left + Math.min(220, hr.width / 3));
    const y = Math.round(Math.max(80, Math.min(innerHeight - 80, hr.top + 300)));
    (document.elementFromPoint(x, y) || host).dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    document.getElementById('cl-draft-text').value = '退避ピンのテスト';
    __commentLayer.saveDraft();
    const pinId = __commentLayer.comments[__commentLayer.comments.length - 1].id;
    return JSON.stringify({ txtId, pinId });
  `));
  b.dialog.log.length = 0;
  b.dialog.action = { accept: true };
  await b.goto(URL0);
  const r18 = JSON.parse(await b.evalJS(`
    return JSON.stringify({
      hasTxt: __commentLayer.comments.some(c => c.id === '${seeded.txtId}'),
      hasPin: !!document.querySelector('.comment-pin[data-id="${seeded.pinId}"]'),
      hl: !!document.querySelector('.comment-highlight[data-id="${seeded.txtId}"]')
    });
  `));
  const dlg18 = b.dialog.log.some(d => (d.message || '').includes('復元しますか'));
  ok('リロードで復元提案が出て、承諾するとハイライト・ピンごと戻る',
     dlg18 && r18.hasTxt && r18.hasPin && r18.hl,
     `dialog=${dlg18} コメント=${r18.hasTxt} ピン=${r18.hasPin} ハイライト=${r18.hl}`);

  // 19. 退避はファイルごとに分離される
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const tmpCopy = pathm.join(osm.tmpdir(), 'cl-isolation-' + Date.now().toString(36) + '.html');
  fsm.copyFileSync(ABS, tmpCopy);
  b.dialog.log.length = 0;
  await b.goto('file://' + encodeURI(tmpCopy));
  const dlg19 = b.dialog.log.some(d => (d.message || '').includes('復元しますか'));
  ok('別ファイル名で開いても復元提案が出ない', !dlg19);
  try { fsm.unlinkSync(tmpCopy); } catch {}

  // 20. ダウンロード後は提案が出ない
  b.dialog.log.length = 0;
  await b.goto(URL0);                     // ここで出る復元提案は自動承諾される
  await b.evalJS(`
    const o = URL.createObjectURL; URL.createObjectURL = () => 'blob:t';
    const oc = window.confirm; window.confirm = () => true;
    const ok2 = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; window.confirm = oc; HTMLAnchorElement.prototype.click = ok2;
    return 1;
  `);
  b.dialog.log.length = 0;
  await b.goto(URL0);
  const dlg20 = b.dialog.log.some(d => (d.message || '').includes('復元しますか'));
  ok('ダウンロード後に開き直しても復元提案が出ない', !dlg20);

  const errs3 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('追加テスト中もJSエラーが出ない', errs3.length === 0, errs3.map(e => e.params.exceptionDetails.text).join(' / '));

  // ===== ここから v2.2 追加分（版をまたぐ再アンカー）=====
  // 現在地: URL0（T20の書き出しで退避は消えている。コメントは埋め込み分のみ）。
  // 対象文字列は資料に依存しないよう、その場で探す（一意な文字列と、複数回出る文字列）。

  // 下ごしらえ: 一意な引用のA（生存確認用）とB（次版で書き換えて消す）、
  // 重複する引用のD（前後文脈で1箇所に特定できるか）を作って書き出す
  const v1 = JSON.parse(await b.evalJS(PAGE_HELPERS + `
    const used = [];
    const a = __vt.uniq(12, used); used.push(a);
    const ou = __vt.uniq(12, used); used.push(ou);              // 旧形式・一意用（コメント化はしない）
    const d = __vt.dup(3, used); used.push(d);
    const bp = __vt.uniq(12, used, true);                        // 消す対象は末尾側から選び、AやDの文脈と離す
    if (!a || !bp) return JSON.stringify({ fatal: '一意な文字列が見つからない' });
    const aId = __vt.mk(a, '版またぎA（残る）');
    const dId = d ? __vt.mk(d, '版またぎD（重複引用＋文脈）') : null;
    const bId = __vt.mk(bp, '版またぎB（次版で消える）');
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const oc = window.confirm; window.confirm = () => true;
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; window.confirm = oc; HTMLAnchorElement.prototype.click = k;
    return cap.text().then(t => JSON.stringify({
      aId, bId, dId, bQuote: bp, oldUniqQuote: ou, ambQuote: d, html: t }));
  `));
  if (v1.fatal) throw new Error(v1.fatal);

  // 次の版を偽造する: 全ハイライトを剥がし（丸ごと再生成を模擬）、Bの引用文を書き換え、
  // 旧形式コメント（prefix/suffixなし）を混ぜる。本文の置換は comment-store より手前だけに掛ける
  const unwrapAll = (h) => h
    .replace(/<span class="comment-highlight"[^>]*>([\s\S]*?)<\/span>/g, '$1')
    .replace(/<tspan class="comment-highlight"[^>]*>([\s\S]*?)<\/tspan>/g, '$1');
  const replaceInBody = (h, from, to) => {
    const cut = h.indexOf('<script id="comment-store"');
    const head = h.slice(0, cut), tail = h.slice(cut);
    const i = head.indexOf(from);
    if (i < 0) throw new Error('本文置換に失敗: ' + from.slice(0, 20));
    return head.slice(0, i) + to + head.slice(i + from.length) + tail;
  };
  const storeRe = /(<script id="comment-store"[^>]*>)([\s\S]*?)(<\/script>)/;
  const enc = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/COMMENT-LAYER/g, 'COMMENT\\u002dLAYER');
  let htmlV2 = unwrapAll(unwrapAll(v1.html));
  htmlV2 = replaceInBody(htmlV2, v1.bQuote, '（この箇所は次の版で改稿済み）');
  {
    const m = htmlV2.match(storeRe);
    const arr = JSON.parse(m[2]);
    if (v1.oldUniqQuote) arr.push({ id: 'txt-olduniq', type: 'text', text: '旧形式・一意', author: 'PM',
      color: '#0084A3', date: '2026-02-11T00:00:00.000Z', quote: v1.oldUniqQuote });
    if (v1.ambQuote) arr.push({ id: 'txt-oldamb', type: 'text', text: '旧形式・曖昧', author: 'PM',
      color: '#0084A3', date: '2026-02-11T00:00:00.000Z', quote: v1.ambQuote });
    htmlV2 = htmlV2.replace(storeRe, (s, a2, _, c2) => a2 + enc(arr) + c2);
  }
  const tmpV2 = pathm.join(osm.tmpdir(), 'cl-nextver-' + Date.now().toString(36) + '.html');
  fsm.writeFileSync(tmpV2, htmlV2);
  b.dialog.log.length = 0;
  await b.goto('file://' + encodeURI(tmpV2));
  const r22 = JSON.parse(await b.evalJS(`
    const hl = id => document.querySelectorAll('.comment-highlight[data-id="' + id + '"]').length;
    return JSON.stringify({
      a: hl('${v1.aId}'),
      b: hl('${v1.bId}'),
      bInStore: __commentLayer.comments.some(c => c.id === '${v1.bId}'),
      d: ${v1.dId ? `(() => {
        // 選択がテキストノードを跨ぐと同一idのspanが複数になるのは正常。
        // 「1箇所に特定」の検証は、復元されていて連結テキストが引用と一致することで行う
        const els = [...document.querySelectorAll('.comment-highlight[data-id="${v1.dId}"]')];
        return { n: els.length, text: els.map(e => e.textContent).join('').replace(/\\s+/g, ' ') };
      })()` : 'null'},
      oldUniq: ${v1.oldUniqQuote ? "hl('txt-olduniq')" : 'null'},
      oldAmb: ${v1.ambQuote ? "hl('txt-oldamb')" : 'null'},
      warnText: [...document.querySelectorAll('.cl-orphan')].some(el => el.textContent.indexOf('書き換わった') >= 0)
    });
  `));
  ok('版またぎ: 未変更箇所への指摘がハイライトごと復元される',
     r22.a >= 1 && (r22.oldUniq === null || r22.oldUniq >= 1),
     `A=${r22.a} 旧形式一意=${r22.oldUniq}`);
  ok('版またぎ: 書き換えられた箇所の指摘は誤爆せず新文言の警告に落ちる',
     r22.bInStore && r22.b === 0 && r22.warnText,
     `store=${r22.bInStore} 誤爆=${r22.b} 文言=${r22.warnText}`);
  const dOk = r22.d === null
    || (r22.d.n >= 1 && r22.d.text === v1.ambQuote.replace(/\s+/g, ' '));
  ok('曖昧時の抑制: 文脈なしの重複引用は貼らず、文脈ありは1箇所に特定される',
     (r22.oldAmb === null || r22.oldAmb === 0) && dOk,
     `曖昧=${r22.oldAmb}件 文脈あり=${r22.d === null ? 'なし' : r22.d.n + '個(" ' + r22.d.text + ' ")'}`);
  try { fsm.unlinkSync(tmpV2); } catch {}

  // 退避ハッシュ: 本文が書き換わったファイルでは、旧オフセットではなく引用照合で復元される
  const tmpV3 = pathm.join(osm.tmpdir(), 'cl-hash-' + Date.now().toString(36) + '.html');
  fsm.copyFileSync(ABS, tmpV3);
  b.dialog.log.length = 0;
  await b.goto('file://' + encodeURI(tmpV3));
  const s25 = JSON.parse(await b.evalJS(PAGE_HELPERS + `
    const used = [];
    const e = __vt.uniq(12, used); used.push(e);
    const g = __vt.uniq(12, used, true);   // 消す対象は末尾側から選び、Eの文脈と離す
    if (!e || !g) return JSON.stringify({ fatal: '一意な文字列が見つからない' });
    const eId = __vt.mk(e, '退避E（引用は次の版にも残る）');
    const gId = __vt.mk(g, '退避G（引用は次の版で消える）');
    return JSON.stringify({ eId, gId, eQuote: e, gQuote: g });
  `));
  if (s25.fatal) throw new Error(s25.fatal);
  {
    // 同じパスのファイルを「次の版」で上書きする（Gの引用を長さの違う文へ差し替え、
    // 本文ハッシュを不一致にしつつオフセットもずらす）
    let h = fsm.readFileSync(tmpV3, 'utf-8');
    h = replaceInBody(h, s25.gQuote, '（この箇所は次の版で削除されました。前の記述は残っていません）');
    fsm.writeFileSync(tmpV3, h);
  }
  b.dialog.log.length = 0;
  b.dialog.action = { accept: true };
  await b.goto('file://' + encodeURI(tmpV3));
  const r25 = JSON.parse(await b.evalJS(`
    const e = document.querySelector('.comment-highlight[data-id="${s25.eId}"]');
    return JSON.stringify({
      eText: e ? e.textContent.replace(/\\s+/g, ' ') : null,
      gInStore: __commentLayer.comments.some(c => c.id === '${s25.gId}'),
      gHl: document.querySelectorAll('.comment-highlight[data-id="${s25.gId}"]').length
    });
  `));
  const dlg25 = b.dialog.log.some(d => (d.message || '').includes('復元しますか'));
  const eExpected = s25.eQuote.replace(/\s+/g, ' ');
  ok('退避ハッシュ: 本文が変わったファイルでは引用照合で正しい位置に復元される',
     dlg25 && r25.eText === eExpected && r25.gInStore && r25.gHl === 0,
     `提案=${dlg25} E一致=${r25.eText === eExpected} G本文救済=${r25.gInStore} G誤爆=${r25.gHl}`);
  try { fsm.unlinkSync(tmpV3); } catch {}

  const errs4 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('版またぎテスト中もJSエラーが出ない', errs4.length === 0, errs4.map(e => e.params.exceptionDetails.text).join(' / '));

  // ===== ここから v2.3 追加分（完了・並び順・返信・ラベル・J/K）=====
  // 退避の影響を受けないよう、未使用のファイル名で開き直してから積む
  const tmpV4 = pathm.join(osm.tmpdir(), 'cl-v23-' + Date.now().toString(36) + '.html');
  fsm.copyFileSync(ABS, tmpV4);
  b.dialog.action = { accept: true };
  b.dialog.log.length = 0;
  await b.goto('file://' + encodeURI(tmpV4));

  // A は本文の前方、C は後方から選ぶ（更新順と文書順が別物になる並びを作るため）
  const s26 = JSON.parse(await b.evalJS(PAGE_HELPERS + `
    const used = [];
    const q1 = __vt.uniq(12, used); used.push(q1);
    const q2 = __vt.uniq(12, used, true); used.push(q2);
    if (!q1 || !q2) return JSON.stringify({ fatal: '一意な文字列が見つからない' });
    __commentLayer.setSidebar(true);
    __commentLayer.setSort('updated');
    const a = __vt.mk(q1, 'v23-A 先に書いた指摘');
    const c = __vt.mk(q2, 'v23-C 後に書いた指摘');
    return JSON.stringify({ a, c });
  `));
  if (s26.fatal) throw new Error(s26.fatal);

  const IDS = `const ids = () => [...document.querySelectorAll('.cl-item')].map(e => e.id.replace('cl-item-',''));
               const at = id => __commentLayer.comments.filter(x => x.id === id)[0];`;

  // 26. 完了 → 最下部へ／取り消し → 元の位置へ。完了では updatedAt を動かさない
  const r26 = JSON.parse(await b.evalJS(IDS + `
    __commentLayer.setSort('updated');
    const before = ids(), upd0 = at('${s26.a}').updatedAt;
    __commentLayer.toggleResolve('${s26.a}');
    const c1 = at('${s26.a}');
    // 完了中にしか出ない要素は、取り消す前にここで見ておく
    const snap = { resolved: c1.resolved, by: c1.resolvedBy, at: c1.resolvedAt, upd: c1.updatedAt,
                   divider: !!document.querySelector('.cl-divider'),
                   doneCard: !!document.querySelector('#cl-item-${s26.a}.cl-done') };
    const after = ids();
    __commentLayer.toggleResolve('${s26.a}');
    const c2 = at('${s26.a}');
    return JSON.stringify({
      最下部: after[after.length - 1] === '${s26.a}',
      残っている: __commentLayer.comments.some(x => x.id === '${s26.a}'),
      区切り: snap.divider && snap.doneCard,
      完了者と日時: !!(snap.resolved && snap.by && snap.at),
      完了でupdatedAt不変: snap.upd === upd0,
      取消で戻る: c2.resolved === false && c2.resolvedAt === undefined && JSON.stringify(ids()) === JSON.stringify(before)
    });
  `));
  ok('完了でカードが最下部へ移り、取り消すと元の位置へ戻る',
     r26.最下部 && r26.残っている && r26.区切り && r26.完了者と日時 && r26.取消で戻る,
     JSON.stringify(r26));
  ok('完了・取り消しでは最終更新（並び順）を動かさない', r26.完了でupdatedAt不変);

  // 27. Cmd+Enter の保存で updatedAt が進み、一覧の先頭に来る（作成日時 date は保つ）
  const r27 = JSON.parse(await b.evalJS(IDS + `
    __commentLayer.setSort('updated');
    const c0 = at('${s26.a}');
    const before = { date: c0.date, upd: c0.updatedAt, top: ids()[0] };
    __commentLayer.editComment('${s26.a}');
    const ta = document.getElementById('cl-draft-text');
    if (!ta) return JSON.stringify({ fatal: '編集欄が出ない' });
    ta.value = 'v23-A 改訂';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    const c1 = at('${s26.a}');
    return JSON.stringify({
      本文が変わった: c1.text === 'v23-A 改訂',
      作成日時を保つ: c1.date === before.date,
      更新が進んだ: c1.updatedAt > before.upd,
      先頭に来た: ids()[0] === '${s26.a}',
      元は先頭でなかった: before.top !== '${s26.a}'
    });
  `));
  if (r27.fatal) throw new Error(r27.fatal);
  ok('Cmd+Enterでの保存だけが最終更新を進め、そのカードが先頭に来る',
     r27.本文が変わった && r27.作成日時を保つ && r27.更新が進んだ && r27.先頭に来た && r27.元は先頭でなかった,
     JSON.stringify(r27));

  // 28. 優先度の巡回（must → want → nit → なし）。優先度の変更では並び順を動かさない。
  //     保存値は must/want/nit のまま（過去データとの互換）、画面表示だけ日本語であること
  const r28 = JSON.parse(await b.evalJS(`
    const at = id => __commentLayer.comments.filter(x => x.id === id)[0];
    const upd0 = at('${s26.a}').updatedAt, seq = [], ja = [];
    for (let i = 0; i < 4; i++) {
      __commentLayer.cycleLabel('${s26.a}');
      seq.push(at('${s26.a}').label || 'なし');
      const chip = document.querySelector('#cl-item-${s26.a} .cl-chip');
      ja.push(chip ? chip.textContent.trim() : '(なし)');
    }
    return JSON.stringify({ seq, ja, chip: !!document.querySelector('.cl-chip'),
      英語が残っていない: ja.every(t => !/must|want|nit/i.test(t)),
      updatedAt不変: at('${s26.a}').updatedAt === upd0 });
  `));
  ok('優先度が 必須 → 要望 → 軽微 → なし と巡回し、並び順は動かない',
     JSON.stringify(r28.seq) === JSON.stringify(['must', 'want', 'nit', 'なし']) && r28.chip && r28.updatedAt不変,
     JSON.stringify(r28.seq));
  ok('優先度チップの表示は日本語で、英語（must/want/nit）が画面に出ない',
     JSON.stringify(r28.ja) === JSON.stringify(['必須', '要望', '軽微', '優先度']) && r28.英語が残っていない,
     JSON.stringify(r28.ja));

  // 29. 返信：Cmd+Enter で保存され、親スレッドの最終更新が進む
  const r29 = JSON.parse(await b.evalJS(IDS + `
    __commentLayer.setSort('updated');
    const upd0 = at('${s26.c}').updatedAt;
    __commentLayer.startReply('${s26.c}', null);
    const rta = document.getElementById('cl-reply-text');
    if (!rta) return JSON.stringify({ fatal: '返信欄が出ない' });
    rta.value = '直しました';
    rta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    const c = at('${s26.c}');
    return JSON.stringify({
      保存された: (c.replies || []).length === 1 && c.replies[0].text === '直しました',
      著者と日時: !!(c.replies[0] && c.replies[0].author && c.replies[0].date),
      表示された: !!document.querySelector('#cl-item-${s26.c} .cl-reply'),
      親が進んだ: c.updatedAt > upd0,
      先頭に来た: ids()[0] === '${s26.c}'
    });
  `));
  if (r29.fatal) throw new Error(r29.fatal);
  ok('返信が保存・表示され、そのスレッドが先頭に上がる',
     r29.保存された && r29.著者と日時 && r29.表示された && r29.親が進んだ && r29.先頭に来た,
     JSON.stringify(r29));

  // 30. J / K でコメント間を移動し、Shift 併用で完了を飛ばす
  const r30 = JSON.parse(await b.evalJS(IDS + `
    __commentLayer.setSort('updated');
    const active = () => { const e = document.querySelector('.cl-item.cl-active'); return e ? e.id.replace('cl-item-','') : null; };
    const send = (key, shift) => document.dispatchEvent(new KeyboardEvent('keydown',
      { key: shift ? key.toUpperCase() : key, shiftKey: !!shift, bubbles: true, cancelable: true }));
    __commentLayer.focusFromList(ids()[0]);
    const a0 = active(); send('j'); const a1 = active(); send('k'); const a2 = active();
    // 末尾を完了にして、素のJは届くが Shift+J は飛ばすことを見る
    const all0 = ids();
    __commentLayer.toggleResolve(all0[all0.length - 1]);
    const doneId = ids()[ids().length - 1];
    __commentLayer.focusFromList(ids()[0]);
    for (let i = 0; i < 12; i++) send('j');
    const 素のJで完了に届く = active() === doneId;
    __commentLayer.focusFromList(ids()[0]);
    for (let i = 0; i < 12; i++) send('j', true);
    const Shiftで完了に入った = active() === doneId;
    __commentLayer.toggleResolve(doneId);
    return JSON.stringify({ a0, a1, a2, 進んだ: a1 !== a0, 戻った: a2 === a0,
                            素のJで完了に届く, Shiftで完了に入った });
  `));
  ok('J / K でコメント間を移動でき、Shift併用は完了を飛ばす',
     r30.進んだ && r30.戻った && r30.素のJで完了に届く && !r30.Shiftで完了に入った, JSON.stringify(r30));

  // 30b. レビュアーの改名・色変更に、コメントだけでなく返信も追従する
  const r30b = JSON.parse(await b.evalJS(`
    const at = id => __commentLayer.comments.filter(x => x.id === id)[0];
    const uid = 'u-rename-test';
    __commentLayer.commit({ type:'user-add', user:{ id:uid, name:'改名前', color:'#123456' } });
    __commentLayer.setActiveUser(uid);
    __commentLayer.startReply('${s26.c}', null);
    document.getElementById('cl-reply-text').value = '改名テストの返信';
    __commentLayer.saveReply();
    const rp = () => at('${s26.c}').replies.filter(r => r.text === '改名テストの返信')[0];
    const before = { name: rp().author, color: rp().color };
    __commentLayer.commit({ type:'user-update', id:uid, field:'name',  value:'改名後' });
    __commentLayer.commit({ type:'user-update', id:uid, field:'color', value:'#654321' });
    const after = { name: rp().author, color: rp().color };
    const shown = [...document.querySelectorAll('#cl-item-${s26.c} .cl-rmeta')]
      .some(e => e.textContent.indexOf('改名後') >= 0);
    __commentLayer.commit({ type:'reply-delete', id:'${s26.c}', replyId: rp().id });
    __commentLayer.commit({ type:'user-delete', id:uid });
    if (__commentLayer.users.length) __commentLayer.setActiveUser(__commentLayer.users[0].id);
    return JSON.stringify({ before, after, shown });
  `));
  ok('レビュアーを改名・色変更すると返信の著者名・色も追従する',
     r30b.before.name === '改名前' && r30b.after.name === '改名後'
       && r30b.after.color === '#654321' && r30b.shown,
     JSON.stringify(r30b));

  // 31. 並び順の切り替え：更新順 ↔ 優先度順。
  //     優先度順は 必須 → 要望 → 軽微 → なし の順で、同じ優先度の中は更新順のまま。
  //     完了はどちらの並びでも最下部（v2.5 で「文書順」は廃止した）
  const r31 = JSON.parse(await b.evalJS(IDS + `
    const setLabel = (id, want) => {
      const at = () => __commentLayer.comments.filter(x => x.id === id)[0].label || '';
      for (let i = 0; i < 5 && at() !== want; i++) __commentLayer.cycleLabel(id);
      return at();
    };
    // 更新順で先頭に居るものを「軽微」、後ろのものを「必須」にして、
    // 優先度順にすると順番が入れ替わることを見る
    __commentLayer.setSort('updated');
    const u = ids().filter(id => !__commentLayer.comments.filter(x => x.id === id)[0].resolved);
    const first = u[0], last = u[u.length - 1];
    setLabel(first, 'nit');
    setLabel(last, 'must');
    __commentLayer.setSort('priority');
    const p = ids();
    const rank = id => { const l = __commentLayer.comments.filter(x => x.id === id)[0].label;
      return ['must','want','nit'].indexOf(l) < 0 ? 3 : ['must','want','nit'].indexOf(l); };
    const open = p.filter(id => !__commentLayer.comments.filter(x => x.id === id)[0].resolved);
    let 単調 = true;
    for (let i = 1; i < open.length; i++) if (rank(open[i]) < rank(open[i - 1])) 単調 = false;
    const 完了は最下部 = p.every((id, i) =>
      !__commentLayer.comments.filter(x => x.id === id)[0].resolved ||
      p.slice(i).every(j => __commentLayer.comments.filter(x => x.id === j)[0].resolved));
    __commentLayer.setSort('updated');
    return JSON.stringify({
      優先度の高い順: 単調,
      必須が軽微より上: p.indexOf(last) < p.indexOf(first),
      並びが変わる: JSON.stringify(u) !== JSON.stringify(open),
      完了は最下部,
      docは無効: (__commentLayer.setSort('doc'), __commentLayer.sortMode === 'updated')
    });
  `));
  ok('並び順を優先度順へ切り替えると 必須 → 要望 → 軽微 → なし の順になる',
     r31.優先度の高い順 && r31.必須が軽微より上 && r31.並びが変わる, JSON.stringify(r31));
  ok('優先度順でも完了は最下部にまとまり、廃止した「文書順」は指定しても無視される',
     r31.完了は最下部 && r31.docは無効, JSON.stringify(r31));

  // 32. 指摘コピー：完了・ラベル・返信が明示され、書き出しJSONにも完了状態が残る
  const r32 = JSON.parse(await b.evalJS(`
    const labOf = id => __commentLayer.comments.filter(x => x.id === id)[0].label || '';
    for (let i = 0; i < 5 && labOf('${s26.a}') !== 'must'; i++) __commentLayer.cycleLabel('${s26.a}');
    if (__commentLayer.comments.filter(x => x.id === '${s26.c}')[0].resolved) __commentLayer.toggleResolve('${s26.c}');
    __commentLayer.toggleResolve('${s26.c}');                    // Cを完了にする
    const md = __commentLayer.buildReviewMarkdown();
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const oc = window.confirm; window.confirm = () => true;
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; window.confirm = oc; HTMLAnchorElement.prototype.click = k;
    return cap.text().then(t => {
      const store = JSON.parse(t.match(/<script id="comment-store"[^>]*>([\\s\\S]*?)<\\/script>/)[1]
        .replace(/\\\\u003c/g, '<').replace(/\\\\u002d/g, '-'));
      const c = store.filter(x => x.id === '${s26.c}')[0], a = store.filter(x => x.id === '${s26.a}')[0];
      return JSON.stringify({
        md未対応: md.indexOf('状態: 未対応') >= 0,
        md完了: md.indexOf('状態: 完了') >= 0 && md.indexOf('修正不要') >= 0,
        mdラベル: md.indexOf('[必須]') >= 0 && !/\\[(must|want|nit)\\]/.test(md),
        md返信: md.indexOf('返信:') >= 0 && md.indexOf('直しました') >= 0,
        md件数: (md.match(/^## 指摘 /gm) || []).length === store.length,
        mdにHTML断片なし: !/<[a-zA-Z][^>]*>/.test(md),
        json完了: c.resolved === true && !!c.resolvedAt && typeof c.resolvedBy === 'string',
        json未完了も明示: a.resolved === false,
        json返信: Array.isArray(c.replies) && c.replies.length === 1,
        json作成と更新: !!a.date && !!a.updatedAt && a.updatedAt > a.date
      });
    });
  `));
  ok('指摘コピーで完了・ラベル・返信が明示される',
     r32.md未対応 && r32.md完了 && r32.mdラベル && r32.md返信 && r32.md件数 && r32.mdにHTML断片なし,
     JSON.stringify(r32));
  ok('書き出しJSONに完了状態（resolved / resolvedAt / resolvedBy）と返信が残る',
     r32.json完了 && r32.json未完了も明示 && r32.json返信 && r32.json作成と更新,
     JSON.stringify(r32));
  // 33. 使い方ガイド：自動では出ない／押すと出る／ページ送り／閉じる
  const r33 = JSON.parse(await b.evalJS(`
    const open = () => document.documentElement.classList.contains('cl-guide-open');
    const shown = () => [...document.querySelectorAll('#cl-guide .cl-g-step')].filter(e => e.classList.contains('on')).length;
    const idx = () => [...document.querySelectorAll('#cl-guide .cl-g-step')].findIndex(e => e.classList.contains('on'));
    const 初期は閉じている = !open();
    document.querySelector('[data-cl="guide"]').click();
    const 押すと開く = open() && shown() === 1 && idx() === 0;
    const 総ページ数 = document.querySelectorAll('#cl-guide .cl-g-step').length;
    const ドット数 = document.querySelectorAll('#cl-guide .cl-g-dot').length;
    const 戻るが無効 = document.getElementById('cl-g-prev').disabled;
    document.getElementById('cl-g-next').click();
    const 次へで進む = idx() === 1 && shown() === 1 && !document.getElementById('cl-g-prev').disabled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true }));
    const 矢印で進む = idx() === 2;
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowLeft', bubbles:true, cancelable:true }));
    const 矢印で戻る = idx() === 1;
    document.querySelectorAll('#cl-guide .cl-g-dot')[総ページ数 - 1].click();
    const ドットで飛ぶ = idx() === 総ページ数 - 1;
    const 最後は閉じるボタン = document.getElementById('cl-g-next').textContent.indexOf('閉じる') >= 0;
    // ガイドを開いている間、資料側のショートカット（C）は効かない
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'c', bubbles:true, cancelable:true }));
    const ショートカット遮断 = !document.documentElement.classList.contains('cl-pinmode');
    document.getElementById('cl-g-next').click();
    const 最後で閉じる = !open();
    document.querySelector('[data-cl="guide"]').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
    const Escで閉じる = !open();
    // ガイドの文言が本文テキストとして拾われていないか（拾うと引用照合・退避が壊れる）。
    // 判定はレイヤー本体が「資料の本文」と見なしているテキストそのもので行う
    const raw = __commentLayer._streamText();
    return JSON.stringify({ 初期は閉じている, 押すと開く, 総ページ数, ドット数, 戻るが無効, 次へで進む,
      矢印で進む, 矢印で戻る, ドットで飛ぶ, 最後は閉じるボタン, ショートカット遮断, 最後で閉じる, Escで閉じる,
      本文に混入しない: raw.indexOf('ショートカット一覧') < 0 && raw.indexOf('この資料は、そのまま書き込めます') < 0 });
  `));
  ok('使い方ガイドは押したときだけ開き、ページ送り・ドット・Escが効く',
     r33.初期は閉じている && r33.押すと開く && r33.総ページ数 === r33.ドット数 && r33.戻るが無効
       && r33.次へで進む && r33.矢印で進む && r33.矢印で戻る && r33.ドットで飛ぶ
       && r33.最後は閉じるボタン && r33.最後で閉じる && r33.Escで閉じる,
     JSON.stringify(r33));
  ok('ガイドを開いている間は資料側のショートカットが効かない', r33.ショートカット遮断);
  ok('ガイドの文言が本文テキストとして拾われない（引用照合・退避を汚さない）', r33.本文に混入しない);

  // 33b. ガイドのモーダルは、どのページでも大きさが変わらない。
  //      ページごとに伸び縮みすると「次へ」が毎回動いて押しにくくなる。
  //      中身が多いページは、モーダルではなく中身側がスクロールする
  const r33b = JSON.parse(await b.evalJS(`
    document.querySelector('[data-cl="guide"]').click();
    const panel = document.querySelector('#cl-guide .cl-g-panel');
    const body = document.querySelector('#cl-guide .cl-g-body');
    const n = document.querySelectorAll('#cl-guide .cl-g-step').length;
    const sizes = [];
    let スクロールするページ = 0;
    for (let i = 0; i < n; i++) {
      __commentLayer.guideGo(i);
      const r = panel.getBoundingClientRect();
      sizes.push(Math.round(r.width) + 'x' + Math.round(r.height));
      if (body.scrollHeight > body.clientHeight + 1) スクロールするページ++;
    }
    __commentLayer.setGuide(false);
    const r0 = sizes[0].split('x').map(Number);
    return JSON.stringify({ sizes, 全ページ同じ: new Set(sizes).size === 1,
      スクロールするページ, 幅: r0[0], 高さ: r0[1],
      画面に収まる: r0[1] <= window.innerHeight && r0[0] <= window.innerWidth });
  `));
  ok('使い方ガイドのモーダルは、どのページでも大きさが変わらない',
     r33b.全ページ同じ, JSON.stringify(r33b.sizes));
  ok('モーダルは画面に収まり、中身が多いページはモーダルではなく中身側がスクロールする',
     r33b.画面に収まる && r33b.スクロールするページ > 0, JSON.stringify(r33b));

  // 34. 書き出しにガイドの表示状態が焼き込まれない（開いたまま書き出しても閉じた状態で保存される）
  const r34 = JSON.parse(await b.evalJS(`
    __commentLayer.setGuide(true);
    __commentLayer.guideGo(4);
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const oc = window.confirm; window.confirm = () => true;
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; window.confirm = oc; HTMLAnchorElement.prototype.click = k;
    return cap.text().then(t => JSON.stringify({
      開いた状態が残らない: t.indexOf('cl-guide-open') < 0 || !/<html[^>]*class="[^"]*cl-guide-open/.test(t),
      先頭ページに戻る: (t.match(/class="cl-g-step on"/g) || []).length === 1
        && t.indexOf('<div class="cl-g-step on">') < t.indexOf('<div class="cl-g-step">'),
      ガイドが含まれる: t.indexOf('id="cl-guide"') >= 0,
      ページ数: (t.match(/class="cl-g-step/g) || []).length
    }));
  `));
  ok('書き出したファイルにガイドが1ページ目・閉じた状態で入る',
     r34.開いた状態が残らない && r34.先頭ページに戻る && r34.ガイドが含まれる && r34.ページ数 === r33.総ページ数,
     JSON.stringify(r34));
  try { fsm.unlinkSync(tmpV4); } catch {}

  const errs5 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('完了・返信テスト中もJSエラーが出ない', errs5.length === 0, errs5.map(e => e.params.exceptionDetails.text).join(' / '));

  // ===== ここから v2.4 追加分（操作中ユーザーのコンボ化・⌘S/⌘⇧C・独立した使い方ボタン・保存後の共有促し）=====
  const tmpV5 = pathm.join(osm.tmpdir(), 'cl-v24-' + Date.now().toString(36) + '.html');
  fsm.copyFileSync(ABS, tmpV5);
  b.dialog.action = { accept: true };
  b.dialog.log.length = 0;
  await b.goto('file://' + encodeURI(tmpV5));

  // 35. ⌘/Ctrl+S で、確認ダイアログを挟まずに保存が実行され、ブラウザ既定の保存ダイアログは止める
  const r35 = JSON.parse(await b.evalJS(`
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    const notPrevented = document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 's', metaKey: true, bubbles: true, cancelable: true }));
    URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
    return JSON.stringify({ 既定動作を止めた: !notPrevented, 保存が呼ばれた: !!cap });
  `));
  ok('⌘/Ctrl+Sで保存が実行され、確認ダイアログを挟まない',
     r35.既定動作を止めた && r35.保存が呼ばれた && b.dialog.log.length === 0, JSON.stringify(r35));

  // 36. ⌘/Ctrl+Shift+S で「指摘をコピー」が実行される。
  //     ここは判定順序の罠がある。⌘+S（保存）の判定を先に置くと ⌘+Shift+S がそこで吸われ、
  //     コピーが一生動かないまま「保存された」ので通ってしまう。保存が走っていないことも見る。
  //     （v2.4 までの ⌘+Shift+C は Chrome の「要素を検証」に取られていて、
  //      dispatchEvent のテストだけが通り実機では動かなかった）
  const r36 = JSON.parse(await b.evalJS(`
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { window.__copied36 = t; return Promise.resolve(); } }, configurable: true });
    // コピー対象が0件だと copyReview() は何もせず抜けるので、判定用に1件だけ仕込む
    __commentLayer.commit({ type: 'add', comment: { id: 'seed-36', type: 'text', text: 'シード',
      author: 'seed', color: '#008299', quote: 'x', date: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', resolved: false } });
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    const notPrevented = document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'S', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
    return new Promise(res => setTimeout(() => res(JSON.stringify({
      既定動作を止めた: !notPrevented,
      コピーされた: typeof window.__copied36 === 'string' && window.__copied36.length > 0,
      保存は走らない: !cap,
      ピンモードは入らない: !document.documentElement.classList.contains('cl-pinmode')
    })), 200));
  `));
  ok('⌘/Ctrl+Shift+Sで指摘のコピーが実行され、保存やピンモードに横取りされない',
     r36.既定動作を止めた && r36.コピーされた && r36.保存は走らない && r36.ピンモードは入らない, JSON.stringify(r36));

  // 36b. L でコメント一覧が開閉する（コメントスレッドのショートカット）
  const r36b = JSON.parse(await b.evalJS(`
    const open = () => document.documentElement.classList.contains('cl-open');
    const send = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    __commentLayer.setSidebar(false);
    send(); const a = open();
    send(); const b2 = open();
    // 入力中は効かない（コメント本文に l と打てなくなると困る）
    __commentLayer.setSidebar(true);
    const ta = document.createElement('textarea'); document.body.appendChild(ta); ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    const c = open(); ta.remove();
    return JSON.stringify({ 開く: a, 閉じる: !b2, 入力中は無反応: c });
  `));
  ok('Lキーでコメント一覧を開閉でき、入力中は反応しない',
     r36b.開く && r36b.閉じる && r36b.入力中は無反応, JSON.stringify(r36b));

  // 37. 使い方ボタンはドックから独立し、画面左下の単独ボタンになっている
  const r37 = JSON.parse(await b.evalJS(`
    const fab = document.getElementById('cl-guide-fab');
    const dock = document.getElementById('cl-dock');
    return JSON.stringify({
      存在する: !!fab,
      ドックの外: !!(fab && dock && !dock.contains(fab)),
      data属性: !!(fab && fab.getAttribute('data-cl') === 'guide'),
      左寄り: fab ? fab.getBoundingClientRect().left < window.innerWidth / 2 : false
    });
  `));
  ok('使い方ボタンはドックから独立した、左下の単独ボタンになっている',
     r37.存在する && r37.ドックの外 && r37.data属性 && r37.左寄り, JSON.stringify(r37));

  // 38. 操作中のユーザーはコンボボックス（プルダウン＋絞り込み）で「選ぶ」だけ。
  //     v2.4 までは一覧にない名前を打つとその場で人が増えたが、打ち間違い・表記ゆれが
  //     そのまま別人になるので廃止した。ここでは「増えないこと」を明示的に見る。
  const r38 = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    // 候補を増やしてから絞り込みを試す
    __commentLayer.commit({ type: 'user-add', user: { id: 'u-t1', name: '検証太郎', color: '#c74700' } });
    __commentLayer.commit({ type: 'user-add', user: { id: 'u-t2', name: '検証花子', color: '#5c10be' } });
    const before = __commentLayer.users.length;

    __commentLayer.setCombo(true);
    const opened = !document.getElementById('cl-user-pop').hidden;
    const 全件出る = document.querySelectorAll('#cl-user-list .cl-opt').length === before;

    const input = document.getElementById('cl-user');
    input.value = '花子';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const 絞り込める = document.querySelectorAll('#cl-user-list .cl-opt').length === 1;

    // 一覧にない名前を打っても、Enterで人は増えない
    input.value = 'この名前は存在しない';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const 空表示 = !document.getElementById('cl-user-empty').hidden;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const 増えない = __commentLayer.users.length === before;

    return JSON.stringify({ opened, 全件出る, 絞り込める, 空表示, 増えない, before });
  `));
  ok('操作中のユーザーはプルダウンで開き、名前で絞り込める',
     r38.opened && r38.全件出る && r38.絞り込める, JSON.stringify(r38));
  ok('一覧にない名前を打ってEnterしても、ユーザーはその場で増えない',
     r38.空表示 && r38.増えない, JSON.stringify(r38));

  // 38b. キーボード操作：上/左で1つ上、下/右で1つ下、Enterで決定、Escapeで取り消し。
  //      マウスを重ねたらそれが最優先になる
  const r38b = JSON.parse(await b.evalJS(`
    const input = document.getElementById('cl-user');
    const idxOn = () => [...document.querySelectorAll('#cl-user-list .cl-opt')].findIndex(e => e.classList.contains('cl-opt-on'));
    const send = key => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    __commentLayer.setCombo(true);
    const i0 = idxOn();
    send('ArrowDown'); const 下 = idxOn();
    send('ArrowUp');   const 上 = idxOn();
    send('ArrowRight'); const 右 = idxOn();
    send('ArrowLeft');  const 左 = idxOn();

    // マウスを重ねた項目が最優先
    const opts = document.querySelectorAll('#cl-user-list .cl-opt');
    opts[opts.length - 1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const ホバー優先 = idxOn() === opts.length - 1;

    // Enter でその人に決まる
    const targetId = __commentLayer.users[__commentLayer.users.length - 1].id;
    send('Enter');
    const 決定 = __commentLayer.activeUserId === targetId && document.getElementById('cl-user-pop').hidden;

    // Escape では変わらない
    const keep = __commentLayer.activeUserId;
    __commentLayer.setCombo(true);
    send('ArrowDown');
    send('Escape');
    const 取り消し = __commentLayer.activeUserId === keep && document.getElementById('cl-user-pop').hidden;

    // 表示名も追従している
    const 表示名 = document.getElementById('cl-user-name').textContent
      === __commentLayer.users.filter(u => u.id === __commentLayer.activeUserId)[0].name;
    return JSON.stringify({ i0, 下, 上, 右, 左, ホバー優先, 決定, 取り消し, 表示名 });
  `));
  ok('コンボボックスは 上/左 で1つ上、下/右 で1つ下へ動き、ホバーが最優先になる',
     r38b.下 === r38b.i0 + 1 && r38b.上 === r38b.i0 && r38b.右 === r38b.i0 + 1 && r38b.左 === r38b.i0
       && r38b.ホバー優先, JSON.stringify(r38b));
  ok('Enterで操作中のユーザーが決まり、Escapeでは変わらない',
     r38b.決定 && r38b.取り消し && r38b.表示名, JSON.stringify(r38b));

  // 38c. 追加は「ユーザーを管理」だけの仕事。押したら新規名の入力欄にフォーカスが入り、
  //      Enter でも追加でき、書いたコメントにはその名前が乗る
  const r38c = JSON.parse(await b.evalJS(PAGE_HELPERS + `
    __commentLayer.setMaster(false);
    document.querySelector('[data-cl="master"]').click();
    const 開いた = document.getElementById('cl-master').classList.contains('open');
    return new Promise(res => requestAnimationFrame(() => {
      const フォーカス = document.activeElement === document.getElementById('cl-new-name');
      const n = document.getElementById('cl-new-name');
      const before = __commentLayer.users.length;
      n.value = '追加二郎';
      n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const created = __commentLayer.users.filter(u => u.name === '追加二郎')[0];
      const q = __vt.uniq(12, []);
      const cid = q ? __vt.mk(q, 'ユーザー追加のテスト') : null;
      const authored = cid ? __commentLayer.comments.filter(c => c.id === cid)[0].author === '追加二郎' : false;
      res(JSON.stringify({ 開いた, フォーカス,
        追加された: !!created && __commentLayer.users.length === before + 1,
        切り替わった: !!created && __commentLayer.activeUserId === created.id,
        authored, 欄が空に戻る: n.value === '' }));
    }));
  `));
  ok('「ユーザーを管理」を押すと開いて、新しい名前の入力欄にカーソルが入る',
     r38c.開いた && r38c.フォーカス, JSON.stringify(r38c));
  ok('新しい名前はEnterで追加され、その人に切り替わる',
     r38c.追加された && r38c.切り替わった && r38c.欄が空に戻る, JSON.stringify(r38c));
  ok('操作中のユーザーで書いたコメントは、その名前で保存される', r38c.authored, JSON.stringify(r38c));

  // 38d. すでにコメントを書いている人を消すときは確認を挟む（書き込みは残るが名前が一覧から消えるため）
  const r38d = JSON.parse(await b.evalJS(`
    const target = __commentLayer.users.filter(u => u.name === '追加二郎')[0];
    const before = __commentLayer.users.length;
    let asked = null;
    const oc = window.confirm;
    window.confirm = m => { asked = m; return false; };       // まず「やめる」
    __commentLayer.deleteUser(target.id);
    const 中止できる = __commentLayer.users.length === before;
    window.confirm = m => { asked = m; return true; };        // 次は「消す」
    __commentLayer.deleteUser(target.id);
    const 消せる = __commentLayer.users.length === before - 1;
    // コメントを1件も書いていない人は、確認なしで消える
    __commentLayer.commit({ type: 'user-add', user: { id: 'u-t9', name: '無投稿さん', color: '#618e00' } });
    let asked2 = false;
    window.confirm = () => { asked2 = true; return true; };
    __commentLayer.deleteUser('u-t9');
    window.confirm = oc;
    return JSON.stringify({ asked, 中止できる, 消せる,
      件数を知らせる: !!asked && /件のコメント/.test(asked),
      無投稿は確認なし: !asked2 && !__commentLayer.users.some(u => u.id === 'u-t9') });
  `));
  ok('コメントを書いている人を削除するときは、件数を示して確認する',
     r38d.件数を知らせる && r38d.中止できる && r38d.消せる, JSON.stringify(r38d));
  ok('まだ何も書いていない人は、確認なしで削除できる', r38d.無投稿は確認なし, JSON.stringify(r38d));

  // 39. 保存ボタンを押すと、確認は挟まず保存が実行され、保存後に共有を促す通知が出る
  const r39 = JSON.parse(await b.evalJS(`
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('cl-export').click();
    URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
    const toast = document.getElementById('cl-toast');
    const r = toast.getBoundingClientRect();
    return JSON.stringify({
      保存が呼ばれた: !!cap,
      表示された: toast.classList.contains('show'),
      保存の文言: toast.textContent.indexOf('保存') >= 0,
      共有を促す文言: toast.textContent.indexOf('送って') >= 0,
      // 保存の案内は画面上部に出す。最下部だと、押した直後の視線から外れて素通りされる
      画面上部: r.top < window.innerHeight / 3,
      画面内に収まる: r.top >= 0 && r.bottom <= window.innerHeight
    });
  `));
  ok('保存ボタンは確認ダイアログを挟まず、保存後にファイル共有を促す通知を出す',
     r39.保存が呼ばれた && r39.表示された && r39.保存の文言 && r39.共有を促す文言, JSON.stringify(r39));
  ok('保存の通知は画面上部の見える位置に出る',
     r39.画面上部 && r39.画面内に収まる, JSON.stringify(r39));

  // 40. カードの操作：完了はボタンのまま、編集・削除・完了は「…」メニューに集約されている
  const r40 = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    const id = __commentLayer.comments[0].id;
    const card = () => document.getElementById('cl-item-' + id);
    const 完了ボタン = !!card().querySelector('[data-cl="resolve"]');
    const メニュー前に編集なし = !card().querySelector('[data-cl="edit"]');
    const メニュー前に削除なし = !card().querySelector('[data-cl="del"]');
    card().querySelector('[data-cl="menu"]').click();
    const menu = card().querySelector('.cl-menu');
    const items = menu ? [...menu.querySelectorAll('.cl-menu-item')].map(e => e.textContent.trim()) : [];
    return JSON.stringify({ 完了ボタン, メニュー前に編集なし, メニュー前に削除なし, items,
      メニューはカードの中: !!(menu && card().contains(menu)) });
  `));
  ok('カードは完了だけをボタンで出し、編集・担当者・削除・完了は「…」に集約されている',
     r40.完了ボタン && r40.メニュー前に編集なし && r40.メニュー前に削除なし
       && r40.items.length === 4 && r40.items[0] === '編集' && r40.items[1] === '担当者を変更'
       && r40.items[2] === '削除' && /完了/.test(r40.items[3]) && r40.メニューはカードの中,
     JSON.stringify(r40));

  // 41. 担当者の付け替え。書き直させないための修正なので、本文も最終更新も動かさない
  const r41 = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    // 直前のテストが「…」を開いたままなので、閉じてから始める
    if (__commentLayer.openMenuId) {
      document.querySelector('[data-cl="menu"][data-id="' + __commentLayer.openMenuId + '"]').click();
    }
    // 付け替え先のユーザーを用意する
    __commentLayer.commit({ type:'user-add', user:{ id:'u-as', name:'付替先さん', color:'#aa00aa' } });
    // 本文にハイライトが残っているテキストコメントを選ぶ。
    // 対象を失ったコメントを選ぶと、色の追従を確かめようがない
    const target = __commentLayer.comments.filter(c =>
      c.type === 'text' && document.querySelector('.comment-highlight[data-id="' + c.id + '"]'))[0];
    if (!target) return JSON.stringify({ fatal: 'ハイライトの残ったコメントが無い' });
    const id = target.id;
    // いまの担当を登録済みユーザーに揃えてから測る（消えた人が担当のままだと印は付かない＝正しい挙動）
    const first = __commentLayer.users[0].id;
    __commentLayer.reassign(id, first);
    const base = __commentLayer.comments.filter(c => c.id === id)[0];
    const before = { author: base.author, color: base.color, text: base.text, upd: base.updatedAt };

    // 「…」→「担当者を変更」で、同じポップアップが担当者一覧に切り替わる
    const card = () => document.getElementById('cl-item-' + id);
    card().querySelector('[data-cl="menu"]').click();
    card().querySelector('[data-cl="assign"]').click();
    const 一覧に切替 = __commentLayer.menuMode === 'assign';
    const 候補数 = card().querySelectorAll('[data-cl="assign-to"]').length;
    const 印の位置 = card().querySelector('[data-cl="assign-to"][aria-checked="true"]');
    const 現在の担当に印 = !!印の位置 && 印の位置.getAttribute('data-uid') === first;
    const 戻れる = !!card().querySelector('[data-cl="menu-back"]');

    // 付け替えを実行
    const uid = 'u-as';
    card().querySelector('[data-cl="assign-to"][data-uid="' + uid + '"]').click();
    const after = __commentLayer.comments.filter(c => c.id === id)[0];
    // 本文のハイライトの色も追従しているか
    const hl = document.querySelector('.comment-highlight[data-id="' + id + '"]');
    const hlColor = hl ? (hl.style.backgroundColor || hl.style.fill) : null;

    return JSON.stringify({
      一覧に切替, 候補数, 現在の担当に印, 戻れる,
      担当者が変わった: after.author === '付替先さん',
      色も変わった: after.color.toLowerCase() === '#aa00aa',
      本文は変わらない: after.text === before.text,
      最終更新は動かない: after.updatedAt === before.upd,
      元の担当と違う: before.author !== after.author,
      ハイライトも追従: !!hlColor && /170|aa/i.test(hlColor),
      メニューは閉じる: __commentLayer.openMenuId === null,
      表示も更新: (card().textContent || '').indexOf('付替先さん') >= 0
    });
  `));
  if (r41.fatal) throw new Error(r41.fatal);
  ok('「…」から担当者一覧に切り替わり、いまの担当に印が付いて戻ることもできる',
     r41.一覧に切替 && r41.候補数 > 1 && r41.現在の担当に印 && r41.戻れる, JSON.stringify(r41));
  ok('担当者を付け替えると、名前・色・本文のハイライトが追従する',
     r41.担当者が変わった && r41.色も変わった && r41.元の担当と違う && r41.ハイライトも追従
       && r41.表示も更新 && r41.メニューは閉じる, JSON.stringify(r41));
  ok('担当者の付け替えでは、本文も最終更新（並び順）も動かない',
     r41.本文は変わらない && r41.最終更新は動かない, JSON.stringify(r41));

  // 41b. 返信も同じ形で付け替えられる（返信の操作も「…」に集約されている）
  const r41b = JSON.parse(await b.evalJS(`
    // 前のテストで返信付きのコメントが残っているとは限らないので、無ければ自分で1件作る
    let c = __commentLayer.comments.filter(x => (x.replies || []).length > 0)[0];
    if (!c) {
      c = __commentLayer.comments[0];
      if (!c) return JSON.stringify({ fatal: 'コメントが1件も無い' });
      __commentLayer.commit({ type:'reply-add', id: c.id, reply: {
        id: 'rep-verify41b', text: '付け替え確認用の返信', author: '検証用',
        color: '#0066be', date: '2026-01-01T00:00:00.000Z' } });
      c = __commentLayer.comments.filter(x => x.id === c.id)[0];
    }
    const rid = c.replies[0].id;
    const before = c.replies[0].author;
    const wrap = () => document.querySelector('#cl-item-' + c.id + ' .cl-rmenu');
    const アイコン直置きなし = !document.querySelector('#cl-item-' + c.id + ' .cl-rmeta [data-cl="reply-edit"]');
    wrap().querySelector('[data-cl="reply-menu"]').click();
    const items = [...wrap().querySelectorAll('.cl-menu-item')].map(e => e.textContent.trim());
    wrap().querySelector('[data-cl="assign"]').click();
    wrap().querySelector('[data-cl="assign-to"][data-uid="u-as"]').click();
    const after = __commentLayer.comments.filter(x => x.id === c.id)[0].replies[0];
    return JSON.stringify({ アイコン直置きなし, items, before,
      付け替わった: after.author === '付替先さん' && after.color.toLowerCase() === '#aa00aa',
      完了は出ない: !items.some(t => /完了/.test(t)) });
  `));
  if (r41b.fatal) throw new Error(r41b.fatal);
  {
    ok('返信の操作も「…」に集約され、編集・担当者を変更・削除が並ぶ',
       r41b.アイコン直置きなし && r41b.items.length === 3
         && r41b.items[0] === '編集' && r41b.items[1] === '担当者を変更' && r41b.items[2] === '削除'
         && r41b.完了は出ない, JSON.stringify(r41b));
    ok('返信の担当者も付け替えられる', r41b.付け替わった, JSON.stringify(r41b));
  }

  // 41c. 「…」メニューは一覧の中に置いてあるので、下端のカードで開くと見切れる。
  //      下に入らなければ上向きに開き、それでも入らなければ一覧を送って全体を見せる
  const r41c = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    if (__commentLayer.openMenuId) {
      const bt = document.querySelector('[data-cl="menu"][data-id="' + __commentLayer.openMenuId + '"]');
      if (bt) bt.click();
    }
    const list = document.getElementById('cl-list');
    // 一覧をいちばん下まで送って、最後のカードで開く（いちばん見切れやすい状況）
    list.scrollTop = list.scrollHeight;
    const cards = [...list.querySelectorAll('.cl-item')];
    const last = cards[cards.length - 1];
    const id = last.id.replace('cl-item-', '');
    last.querySelector('[data-cl="menu"]').click();
    const menu = document.querySelector('#cl-list .cl-menu');
    const mr = menu.getBoundingClientRect(), lr = list.getBoundingClientRect();
    const res = {
      メニューが出た: !!menu,
      上下が一覧に収まる: mr.top >= lr.top - 1 && mr.bottom <= lr.bottom + 1,
      高さ: Math.round(mr.height), 一覧の高さ: Math.round(lr.height)
    };
    // 担当者一覧（項目数が増えるほう）でも収まるか
    document.querySelector('#cl-item-' + id + ' [data-cl="assign"]').click();
    const m2 = document.querySelector('#cl-list .cl-menu').getBoundingClientRect();
    res.担当者一覧も収まる = m2.top >= lr.top - 1 && m2.bottom <= lr.bottom + 1;
    document.querySelector('#cl-item-' + id + ' [data-cl="menu-back"]').click();
    document.querySelector('#cl-item-' + id + ' [data-cl="menu"]').click();
    return JSON.stringify(res);
  `));
  ok('一覧の下端で「…」を開いてもメニューが見切れない',
     r41c.メニューが出た && r41c.上下が一覧に収まる && r41c.担当者一覧も収まる, JSON.stringify(r41c));

  // 42. 新規ユーザーの色は「いま使われている色から最も遠い色」を選ぶ。
  //     v2.5 までは配列の先頭から順に配っていたので、3人目で1人目とほぼ同じ色になっていた
  //     （OKLab距離 0.116。0.15 を下回ると、ハイライトを見ても誰の指摘か分からない）
  const r42 = JSON.parse(await b.evalJS(`
    const D = (a, b) => __commentLayer._colorDistance(a, b);
    // 実際に人を増やしながら、追加時点の「既存で最も近い色との距離」を記録する
    const sim = () => {
      const used = [__commentLayer.users[0].color];
      const mins = [];
      const added = [];
      for (let i = 0; i < 7; i++) {
        const c = __commentLayer._nextUserColor();
        mins.push(Math.min(...used.map(u => D(c, u))));
        added.push(c);
        __commentLayer.commit({ type:'user-add', user:{ id:'u-sim'+i, name:'仮'+i, color:c } });
        used.push(c);
      }
      added.forEach((_, i) => __commentLayer.commit({ type:'user-delete', id:'u-sim'+i }));
      return { mins, added };
    };
    // 検証用にユーザーを1人だけにしてから測る
    const keep = __commentLayer.users[0].id;
    __commentLayer.users.slice(1).forEach(u => __commentLayer.commit({ type:'user-delete', id:u.id }));
    const s = sim();
    return JSON.stringify({
      mins: s.mins.map(v => +v.toFixed(3)),
      added: s.added,
      三人目まで: Math.min(...s.mins.slice(0, 2)),
      五人目まで: Math.min(...s.mins.slice(0, 4)),
      重複なし: new Set(s.added).size === s.added.length
    });
  `));
  ok('新規ユーザーの色は、既存の色から十分に離れた色が選ばれる（3人目で旧実装の2倍以上）',
     r42.三人目まで > 0.24 && r42.五人目まで > 0.15 && r42.重複なし,
     `3人目まで=${r42.三人目まで}（旧0.116） 5人目まで=${r42.五人目まで}（旧0.111） 距離=${JSON.stringify(r42.mins)}`);

  const errs6 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('v2.4のテスト中もJSエラーが出ない', errs6.length === 0, errs6.map(e => e.params.exceptionDetails.text).join(' / '));
  try { fsm.unlinkSync(tmpV5); } catch {}

  // ===== ここから v2.4.1 追加分（host が body に落ちる資料）=====
  // 検査対象の資料が .wrap 等を持っていると、ドック外のUI（使い方ボタン・トースト）は
  // host の外側に居るので、除外し忘れても何も起きない。レイヤーにUIを足したときの
  // 取りこぼしはこの経路でしか出ないため、ラッパーの無い資料をここで別途組み立てる。
  {
    const bare = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>ラッパー無し資料</title>
<style>body{margin:0 auto;max-width:820px;padding:60px 40px 200px;font-family:system-ui,sans-serif;line-height:1.9}</style>
</head><body>
<h1>ラッパー無しの資料</h1>
<p>この資料には wrap も main も article も無いので、ピンの基準は body になる。</p>
<p>連携は日次のファイルで行い、結果は担当者へメールで共有する想定である。</p>
<p>移行判定の基準は、並行稼働の二週目までに差分がゼロになっていることとする。</p>
</body></html>`;
    // レイヤーのブロックだけを、いま検査しているファイルから借りてくる
    const src = fsm.readFileSync(ABS, 'utf-8');
    const s0 = src.indexOf('<!-- ==='), s1 = src.lastIndexOf('COMMENT-LAYER');
    const blockEnd = src.indexOf('-->', s1) + 3;
    const block = src.slice(src.lastIndexOf('<!--', s0 + 1), blockEnd);
    const tmpBare = pathm.join(osm.tmpdir(), 'cl-bare-' + Date.now().toString(36) + '.html');
    fsm.writeFileSync(tmpBare, bare.replace('</body>', block + '\n</body>'));
    b.dialog.log.length = 0;
    b.dialog.action = { accept: true };
    await b.goto('file://' + encodeURI(tmpBare));

    // 判定はレイヤー本体の streamText() をそのまま呼ぶ。テスト側に除外セレクタを書き写すと、
    // UIを足したときの漏れがテストにも同じように伝染して、素通りしてしまう
    const r51 = JSON.parse(await b.evalJS(`
      const host = document.querySelector('[data-cl-host]');
      const grab = () => __commentLayer._streamText();
      const before = grab();
      let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
      const oc = window.confirm; window.confirm = () => true;
      const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
      __commentLayer.exportHTML();                     // 1回目でトーストが出る
      __commentLayer.exportHTML();                     // 2回目：前回の文面が残っていないか
      URL.createObjectURL = o; window.confirm = oc; HTMLAnchorElement.prototype.click = k;
      const after = grab();
      return cap.text().then(t => JSON.stringify({
        hostがbody: host.tagName === 'BODY',
        使い方ボタンがhost内: host.contains(document.getElementById('cl-guide-fab')),
        本文に使い方の文言: before.indexOf('使い方') >= 0 || after.indexOf('使い方') >= 0,
        本文にトーストの文言: after.indexOf('パソコンの中だけ') >= 0,
        本文の長さが保存で変わる: before.length !== after.length,
        // 同じ文言は使い方ガイドの本文にも載っている（静的マークアップなので常に入っている）。
        // 焼き込みの判定は、トースト要素そのものの中身が空かどうかで見る
        書き出しのトースト要素の中身: (t.match(/<div id="cl-toast"[^>]*>([\\s\\S]*?)<\\/div>/) || [null, '(見つからず)'])[1]
      }));
    `));
    ok('host が body の資料でも、レイヤーのUI文言が本文テキストに混ざらない',
       r51.hostがbody && r51.使い方ボタンがhost内 && !r51.本文に使い方の文言
         && !r51.本文にトーストの文言 && !r51.本文の長さが保存で変わる,
       JSON.stringify(r51));
    ok('保存の通知文が書き出したHTMLに焼き込まれない', r51.書き出しのトースト要素の中身 === '',
       '中身=' + JSON.stringify(r51.書き出しのトースト要素の中身));

    // ピンモード中にドック外のUI（使い方ボタン）を押しても、ピンが落ちない
    await b.goto('file://' + encodeURI(tmpBare));
    const fabPt = JSON.parse(await b.evalJS(`
      __commentLayer.setPinMode(true);
      const r = document.getElementById('cl-guide-fab').getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    `));
    await b.click(fabPt.x, fabPt.y);
    await b.wait(400);
    const r53 = JSON.parse(await b.evalJS(`return JSON.stringify({
      ガイドが開いた: document.documentElement.classList.contains('cl-guide-open'),
      ピンが落ちた: !!document.querySelector('#cl-pins .comment-pin'),
      入力欄が開いた: !!document.getElementById('cl-draft-text')
    });`));
    ok('ピンモード中に使い方ボタンを押してもピンが落ちない',
       r53.ガイドが開いた && !r53.ピンが落ちた && !r53.入力欄が開いた, JSON.stringify(r53));
    try { fsm.unlinkSync(tmpBare); } catch {}
  }

  const errs7 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('ラッパー無し資料のテスト中もJSエラーが出ない', errs7.length === 0, errs7.map(e => e.params.exceptionDetails.text).join(' / '));

} catch (e) {
  fail++; console.log('❌ 実行エラー: ' + e.message);
} finally {
  b.close();
}
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);

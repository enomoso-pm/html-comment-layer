// コメントレイヤーの動作確認。依存ゼロ（Node 22+ のネイティブ WebSocket + ローカルのChrome）
//   node verify.mjs 資料_commented.html
import { launch } from './cdp.mjs';

const FILE = process.argv[2];
if (!FILE) { console.error('使い方: node verify.mjs <target.html>'); process.exit(1); }

const b = await launch(9340);
let pass = 0, fail = 0;

// レイヤーは DOMContentLoaded で起動する。外部リソースを参照している資料では load が
// 来ないので cdp.mjs が待ち切らずに進むが、そのまま評価すると boot() の前に踏み込んで
// host が null のまま _streamTextNodes() を呼び、TreeWalker が例外を投げる。
// 「1回だけ落ちて再実行で通る」の正体はこれなので、起動を待ってから先へ進む
const goto = async (url) => {
  await b.goto(url);
  for (let i = 0; i < 80; i++) {
    // ★起動の合図に [data-cl-host] を使わない。v2.14.0 までの書き出しはこの印を
    //   ファイルに焼き込んでいたので、保存済みファイルでは「起動前から印だけある」。
    //   そこで素通りすると、host も pinBox も null のまま評価してしまう
    //   （host null → _streamTextNodes() が createTreeWalker で落ちる／
    //     pinBox null → exportHTML() が parentNode で落ちる）。
    //   #cl-pins は書き出し前に必ず外されるので、これがあるのは起動した証拠になる。
    if (await b.evalJS(`return !!(window.__commentLayer && document.getElementById('cl-pins'));`)) return;
    await b.wait(100);
  }
  console.log('  （レイヤーの起動を待てませんでした: ' + url + '）');
};
const tmpGens = [];   // 世代テストで作る一時ファイル
const ok = (name, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  … ' + detail : ''}`);
};

try {
  await goto('file://' + encodeURI(FILE.startsWith('/') ? FILE : process.cwd() + '/' + FILE));

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
    // ★ピンを刺す点は「host の見えている範囲」から採る。
    //   以前は max(80, min(innerHeight-80, hr.top+300)) だったが、host がページ最上部から
    //   始まる資料でスクロールしていると hr.top が大きな負になり、下限の 80 に丸められる。
    //   y=80 は画面最上部＝レイヤー自身のトースト（#cl-toast）が出る場所なので、
    //   クリックがトーストに当たり、レイヤーは「本文の外」と正しく判断してピンを作らない。
    //   テストはそのあと下書き欄を触って null 参照で落ちていた（実測: hit=DIV#cl-toast.show）。
    const y = Math.round((Math.max(0, hr.top) + Math.min(innerHeight, hr.bottom)) / 2);
    (document.elementFromPoint(x, y) || host).dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    document.getElementById('cl-draft-text').value = '退避ピンのテスト';
    __commentLayer.saveDraft();
    const pinId = __commentLayer.comments[__commentLayer.comments.length - 1].id;
    return JSON.stringify({ txtId, pinId });
  `));
  b.dialog.log.length = 0;
  b.dialog.action = { accept: true };
  await goto(URL0);
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
  await goto('file://' + encodeURI(tmpCopy));
  const dlg19 = b.dialog.log.some(d => (d.message || '').includes('復元しますか'));
  ok('別ファイル名で開いても復元提案が出ない', !dlg19);
  try { fsm.unlinkSync(tmpCopy); } catch {}

  // 20. ダウンロード後は提案が出ない
  b.dialog.log.length = 0;
  await goto(URL0);                     // ここで出る復元提案は自動承諾される
  await b.evalJS(`
    const o = URL.createObjectURL; URL.createObjectURL = () => 'blob:t';
    const oc = window.confirm; window.confirm = () => true;
    const ok2 = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; window.confirm = oc; HTMLAnchorElement.prototype.click = ok2;
    return 1;
  `);
  b.dialog.log.length = 0;
  await goto(URL0);
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
      aId, bId, dId, aQuote: a, bQuote: bp, oldUniqQuote: ou, ambQuote: d, html: t }));
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
  await goto('file://' + encodeURI(tmpV2));

  // 資料側のスクリプトが開くたびにDOMを組み立て直す資料（実サイトの保存ページなど）では、
  // 書き出して開き直した時点で本文が二重になり、どの引用も一意でなくなる。
  // これはレイヤーの不具合ではなく資料側の性質で、レイヤーは「特定できないものは貼らない」を
  // 正しく守っているだけ。ここを普通に判定すると、二重描画の出方しだいで
  // 落ちたり通ったりする（＝オオカミ少年になる）ので、条件を検出して明示的に飛ばす。
  const selfRebuild = JSON.parse(await b.evalJS(PAGE_HELPERS + `
    return JSON.stringify({ aCount: __vt.count(${JSON.stringify(v1.aQuote)}) });
  `));
  if (selfRebuild.aCount !== 1) {
    console.log(`⏭️  版またぎ再アンカーの検査を飛ばす … この資料は開くたびに中身を組み立て直すため、` +
      `書き出して開き直すと引用が ${selfRebuild.aCount} 箇所に増える（一意に特定できる資料でのみ検査できる）`);
    try { fsm.unlinkSync(tmpV2); } catch {}
  } else {
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

  // 22b. 貼れなかった理由を取り違えない。
  //      「本文から消えた（＝指摘が反映された）」と「同じ文が複数あって特定できない」は
  //      利用者にとって意味がまったく違う。後者を前者の文言で出すと、
  //      直っていないのに「対応済み」と読まれる
  const r22b = JSON.parse(await b.evalJS(`
    const reason = __commentLayer.anchorReason;
    const bId = '${v1.bId}';
    const ambId = ${v1.ambQuote ? "'txt-oldamb'" : 'null'};
    const cardText = id => {
      const el = document.querySelector('#cl-item-' + id + ' .cl-orphan');
      return el ? el.textContent : null;
    };
    return JSON.stringify({
      消えた側の理由: reason[bId] || null,
      消えた側の文言: cardText(bId),
      曖昧側の理由: ambId ? (reason[ambId] || null) : null,
      曖昧側の文言: ambId ? cardText(ambId) : null,
      通知が出た: ambId ? document.getElementById('cl-toast').classList.contains('show') : null,
      通知の種類: document.getElementById('cl-toast').getAttribute('data-type')
    });
  `));
  ok('本文から消えた指摘は「書き換わった可能性」として案内される',
     r22b.消えた側の理由 === 'none' && /書き換わった/.test(r22b.消えた側の文言 || ''),
     JSON.stringify(r22b));
  if (r22b.曖昧側の理由 !== null) {
    ok('特定できなかった指摘は「反映されたわけではない」と明示され、別の文言になる',
       r22b.曖昧側の理由 === 'ambiguous'
         && /複数/.test(r22b.曖昧側の文言 || '')
         && /反映されたわけではありません/.test(r22b.曖昧側の文言 || '')
         && !/指摘が反映された）可能性/.test(r22b.曖昧側の文言 || ''),
       JSON.stringify(r22b));
    ok('特定できなかったときは、コメントが無事であることをまとめて通知する',
       r22b.通知が出た === true && r22b.通知の種類 === 'warn', JSON.stringify(r22b));
  }
  try { fsm.unlinkSync(tmpV2); } catch {}
  }

  // 退避ハッシュ: 本文が書き換わったファイルでは、旧オフセットではなく引用照合で復元される
  const tmpV3 = pathm.join(osm.tmpdir(), 'cl-hash-' + Date.now().toString(36) + '.html');
  fsm.copyFileSync(ABS, tmpV3);
  b.dialog.log.length = 0;
  await goto('file://' + encodeURI(tmpV3));
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
  await goto('file://' + encodeURI(tmpV3));
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
  await goto('file://' + encodeURI(tmpV4));

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

  // 31b. 優先度順は「セレクタを操作した瞬間」の表示順で凍結される（v2.15）。
  //      凍結後にチップで優先度を変えても位置は動かない。新規コメントは先頭に置く。
  const r31b = JSON.parse(await b.evalJS(IDS + `
    __commentLayer.setSort('updated');
    __commentLayer.setSort('priority');           // ここで凍結される
    const undone0 = ids().filter(id => !at(id).resolved);
    const target = undone0[undone0.length - 1];   // 優先度を変えても動かないことを見る対象
    const before = ids();
    const labBefore = at(target).label || '';
    __commentLayer.cycleLabel(target);             // 優先度が変わる（updatedAtは動かない）
    const labAfter = at(target).label || '';
    const afterLabelChange = ids();
    __commentLayer.commit({ type: 'add', comment: { id: 'sort-frozen-new', type: 'text', text: '凍結後の新規',
      author: 'seed', color: '#008299', quote: 'x', date: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', resolved: false } });
    const afterAdd = ids();
    __commentLayer.commit({ type: 'delete', id: 'sort-frozen-new' });
    __commentLayer.setSort('updated');
    return JSON.stringify({
      ラベルが変わった: labBefore !== labAfter,
      優先度を変えても位置が同じ: JSON.stringify(before) === JSON.stringify(afterLabelChange),
      新規は先頭: afterAdd[0] === 'sort-frozen-new',
      件数が1増えた: afterAdd.length === before.length + 1
    });
  `));
  ok('優先度順のとき、優先度を変えてもカードの位置が動かない（並び替えはセレクタ操作時だけ）',
     r31b.ラベルが変わった && r31b.優先度を変えても位置が同じ, JSON.stringify(r31b));
  ok('凍結後に追加した新規コメントは先頭に置かれる',
     r31b.新規は先頭 && r31b.件数が1増えた, JSON.stringify(r31b));

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
    // ★文言の部分一致で見ない。以前は 'ショートカット一覧' 等を探していたが、
    //   このレイヤー自身を説明する資料は本文に同じ語を普通に書くので誤検知する
    //   （実測: レビュー依頼のブリーフが「10ページ目のショートカット一覧は…」で引っかかった）。
    //   ノードの帰属を直接見れば、資料の中身に一切左右されない。
    const guide = document.getElementById('cl-guide');
    const 本文に混入しない = !__commentLayer._streamTextNodes().some(n => guide.contains(n));
    return JSON.stringify({ 初期は閉じている, 押すと開く, 総ページ数, ドット数, 戻るが無効, 次へで進む,
      矢印で進む, 矢印で戻る, ドットで飛ぶ, 最後は閉じるボタン, ショートカット遮断, 最後で閉じる, Escで閉じる,
      本文に混入しない });
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
      const cur = document.querySelectorAll('#cl-guide .cl-g-step')[i];
      if (cur.scrollHeight > cur.clientHeight + 1) スクロールするページ++;
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
      // 送りアニメ用のクラスは実行時に付くもの。焼き込まれると受け取った側で毎回1ページだけ動く
      // 「on」が先頭ページ以外に付いたまま焼き込まれていないか
      先頭以外にonが残らない: (t.match(/class="cl-g-step on"/g) || []).length <= 1,
      先頭ページに戻る: (t.match(/class="cl-g-step on"/g) || []).length === 1
        && t.indexOf('<div class="cl-g-step on">') < t.indexOf('<div class="cl-g-step">'),
      ガイドが含まれる: t.indexOf('id="cl-guide"') >= 0,
      ページ数: (t.match(/class="cl-g-step/g) || []).length
    }));
  `));
  ok('書き出したファイルで現在ページの印が1つだけになる', r34.先頭以外にonが残らない, JSON.stringify(r34));

  // 34b. ページ送りはブラウザ標準の横スクロール＋スナップに任せている。
  //      自前で「何px動いたら1ページ」を判定する作りは、トラックパッドの慣性の長さが
  //      振り方しだいで決まらないため、一振りで2ページ送るか次の一振りを取りこぼすかしかない
  const r34b = JSON.parse(await b.evalJS(`
    __commentLayer.setGuide(true);
    const body = document.querySelector('#cl-guide .cl-g-body');
    const step = document.querySelector('#cl-guide .cl-g-step');
    const cb = getComputedStyle(body), cst = getComputedStyle(step);
    const res = {
      横に並んでいる: cst.flexBasis === '100%' || Math.abs(step.clientWidth - body.clientWidth) <= 1,
      横スクロールする: cb.overflowX === 'auto' || cb.overflowX === 'scroll',
      スナップする: /x/.test(cb.scrollSnapType) && /mandatory/.test(cb.scrollSnapType),
      一度に1枚まで: cst.scrollSnapStop === 'always',
      各ページが縦に読める: cst.overflowY === 'auto',
      全ページが並ぶ: document.querySelectorAll('#cl-guide .cl-g-step').length
    };
    // ボタンでの移動がスクロール位置に反映される
    __commentLayer.guideGo(3);
    return new Promise(r => setTimeout(() => {
      res.ボタンで動く = Math.round(body.scrollLeft / body.clientWidth) === 3;
      // 指で動かした場合は、止まってからページ番号が追いつく
      body.scrollLeft = body.clientWidth * 6;
      // 滑らかな移動が終わる時刻は環境しだいなので、固定で待たずに落ち着くまで見る
      const started = Date.now();
      const poll = () => {
        const done = __commentLayer.guideStep === 6;
        if (done || Date.now() - started > 3000) {
          res._位置 = body.scrollLeft; res._step = __commentLayer.guideStep;
          res.スクロールに追従 = done;
          res.ドットも追従 = [...document.querySelectorAll('#cl-guide .cl-g-dot')]
            .findIndex(e => e.classList.contains('on')) === 6;
          __commentLayer.setGuide(false);
          r(JSON.stringify(res));
        } else setTimeout(poll, 60);
      };
      poll();
    }, 420));
  `));
  ok('ページ送りは横スクロール＋スナップで、勢いよく振っても一度に1枚しか進まない',
     r34b.横に並んでいる && r34b.横スクロールする && r34b.スナップする && r34b.一度に1枚まで,
     JSON.stringify(r34b));
  ok('ボタンでも指でも同じ位置に着き、ページ番号とドットが追従する',
     r34b.ボタンで動く && r34b.スクロールに追従 && r34b.ドットも追従 && r34b.各ページが縦に読める,
     JSON.stringify(r34b));

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

  // 41d. 人数が増えてもユーザー管理が破綻しない。
  //      v2.6.0 までは人数ぶん素直に伸びていたので、12人で「新しいユーザーを追加」の行が
  //      画面外へ出て、追加そのものができなくなっていた（袋小路）
  const r41d = JSON.parse(await b.evalJS(`
    const res = {};
    const setUsers = n => {
      while (__commentLayer.users.length > 1)
        __commentLayer.commit({ type:'user-delete', id: __commentLayer.users[__commentLayer.users.length-1].id });
      for (let i = __commentLayer.users.length; i < n; i++)
        __commentLayer.commit({ type:'user-add', user:{ id:'u-sc'+i, name:'負荷レビュアー'+(i+1), color:'#008299' } });
    };
    __commentLayer.setSidebar(true);
    for (const n of [5, 12, 30]) {
      setUsers(n);
      __commentLayer.setMaster(false);
      const listClosed = Math.round(document.getElementById('cl-list').getBoundingClientRect().height);
      __commentLayer.setMaster(true);
      const sb = document.getElementById('cl-sidebar').getBoundingClientRect();
      const foot = document.querySelector('#cl-sidebar .cl-foot').getBoundingClientRect();
      const panel = document.getElementById('cl-master').getBoundingClientRect();
      const addRow = document.querySelector('.cl-master-add').getBoundingClientRect();
      const listOpen = Math.round(document.getElementById('cl-list').getBoundingClientRect().height);
      const ml = document.getElementById('cl-master-list');
      res['n' + n] = {
        追加欄が画面内: addRow.bottom <= sb.bottom + 1 && addRow.top >= sb.top - 1,
        // 重ねて出す＝開いてもコメント一覧の高さは1pxも変わらない
        一覧の高さが変わらない: listClosed === listOpen,
        一覧の高さ: listOpen,
        パネルが浮いている: getComputedStyle(document.getElementById('cl-master')).position === 'absolute',
        パネルが保存帯に被らない: panel.bottom <= foot.top + 1,
        パネルの高さ: Math.round(panel.height),
        管理一覧がスクロールする: ml.scrollHeight > ml.clientHeight + 1,
        絞り込みが出る: !document.getElementById('cl-master-filter').hidden
      };
    }
    // 絞り込みが効くか（30人の状態のまま）
    const q = document.getElementById('cl-master-q');
    q.value = 'レビュアー30';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    res.絞り込み後の件数 = document.querySelectorAll('#cl-master-list .cl-master-item').length;
    q.value = 'そんな名前はいない';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    res.該当なし表示 = !!document.querySelector('#cl-master-list .cl-master-empty');
    q.value = '';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    res.戻せる = document.querySelectorAll('#cl-master-list .cl-master-item').length === 30;
    __commentLayer.setMaster(false);
    return JSON.stringify(res);
  `));
  ok('ユーザーが増えても「新しいユーザーを追加」は常に押せる位置に残る',
     r41d.n5.追加欄が画面内 && r41d.n12.追加欄が画面内 && r41d.n30.追加欄が画面内, JSON.stringify(r41d));
  ok('ユーザー管理はコメントの上に重ねて開き、一覧の高さを奪わない',
     [5, 12, 30].every(n => r41d['n' + n].パネルが浮いている && r41d['n' + n].一覧の高さが変わらない),
     [5, 12, 30].map(n => `${n}人:一覧${r41d['n' + n].一覧の高さ}px`).join(' '));
  ok('重ねたパネルは保存ボタンの帯に被らず、はみ出したぶんは中がスクロールする',
     [5, 12, 30].every(n => r41d['n' + n].パネルが保存帯に被らない) && r41d.n30.管理一覧がスクロールする,
     [5, 12, 30].map(n => `${n}人:パネル${r41d['n' + n].パネルの高さ}px`).join(' '));
  ok('絞り込みは人数が増えたときだけ出て、名前で絞り込める',
     !r41d.n5.絞り込みが出る && r41d.n12.絞り込みが出る
       && r41d.絞り込み後の件数 === 1 && r41d.該当なし表示 && r41d.戻せる, JSON.stringify(r41d));

  // 41e. 担当者一覧も、人数が増えたら同じ作法（絞り込み＋矢印キー）で選べる。
  //      コンボボックスには作り替えない（ポップアップの中にポップアップを開くことになるため）
  const r41e = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    const card = () => document.querySelector('#cl-list .cl-item');
    const open = () => {
      if (__commentLayer.openMenuId) card().querySelector('[data-cl="menu"]').click();
      card().querySelector('[data-cl="menu"]').click();
      card().querySelector('[data-cl="assign"]').click();
    };
    open();
    const 絞り込みが出る = !!document.getElementById('cl-assign-q');
    const rows = () => [...document.querySelectorAll('#cl-list [data-cl="assign-to"]')].filter(e => !e.hidden);
    const onIdx = () => rows().findIndex(e => e.classList.contains('on'));
    const send = k => document.dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true }));

    const 件数 = rows().length;
    send('ArrowDown'); const 下 = onIdx();
    send('ArrowRight'); const 右 = onIdx();
    send('ArrowUp'); const 上 = onIdx();
    send('ArrowLeft'); const 左 = onIdx();   // 先頭からさらに上へ→末尾へ回り込む

    // 絞り込むと候補が減り、矢印は隠れた行を飛ばす
    const q = document.getElementById('cl-assign-q');
    q.value = 'レビュアー30';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const 絞り込み後 = rows().length;
    send('ArrowDown');
    const 絞り込み後に選べる = onIdx() === 0;

    // Enter で決定できる
    const uid = rows()[0].getAttribute('data-uid');
    const name = __commentLayer.users.filter(u => u.id === uid)[0].name;
    const cid = card().id.replace('cl-item-','');
    send('Enter');
    const 決定 = __commentLayer.comments.filter(c => c.id === cid)[0].author === name;

    // Esc は1段ずつ：担当者一覧 → 元のメニュー → 閉じる
    open();
    send('Escape'); const 一段目 = __commentLayer.menuMode === 'main' && __commentLayer.openMenuId !== null;
    send('Escape'); const 二段目 = __commentLayer.openMenuId === null;
    return JSON.stringify({ 絞り込みが出る, 件数, 下, 右, 上, 左, 絞り込み後, 絞り込み後に選べる, 決定, 一段目, 二段目 });
  `));
  ok('担当者一覧でも 上/左・下/右 の矢印キーで選べ、Enterで決定できる',
     r41e.下 === 0 && r41e.右 === 1 && r41e.上 === 0 && r41e.左 === r41e.件数 - 1
       && r41e.決定, JSON.stringify(r41e));
  ok('担当者一覧の絞り込みが効き、隠れた候補は矢印で飛ばされる',
     r41e.絞り込みが出る && r41e.絞り込み後 === 1 && r41e.絞り込み後に選べる, JSON.stringify(r41e));
  ok('担当者一覧のEscは1段ずつ戻る（一覧 → 元のメニュー → 閉じる）',
     r41e.一段目 && r41e.二段目, JSON.stringify(r41e));

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

  // 8b. 保存して開き直すのを繰り返しても、レイヤーの器が増えない。
  //     v2.7 まで #cl-pins（ピンの器）は中身だけ空にして器を残していたため、
  //     世代ごとに1個ずつ増え、idが重複したファイルが出回っていた
  const r8b = await (async () => {
    let cur = ABS, gens = [];
    for (let g = 0; g <= 3; g++) {
      await goto('file://' + encodeURI(cur));
      gens.push(JSON.parse(await b.evalJS(`
        // 数えるのはレイヤーが持ち込んだものだけ。実サイトの保存ページは資料側の
        // スクリプトが要素もidも増やすので、全体を数えると資料の性質を測ることになる
        const ids = {};
        document.querySelectorAll('[id^="cl-"]').forEach(e => { ids[e.id] = (ids[e.id]||0)+1; });
        return JSON.stringify({
          pins: document.querySelectorAll('[id="cl-pins"]').length,
          要素数: document.querySelectorAll('[id^="cl-"]').length,
          重複id: Object.keys(ids).filter(k => ids[k] > 1)
        });`)));
      if (g === 3) break;
      const out = await b.evalJS(`
        let cap=null; const o=URL.createObjectURL; URL.createObjectURL=x=>{cap=x;return 'blob:t';};
        const oc=window.confirm; window.confirm=()=>true;
        const k=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){};
        __commentLayer.exportHTML();
        URL.createObjectURL=o; window.confirm=oc; HTMLAnchorElement.prototype.click=k;
        return cap.text();`);
      cur = pathm.join(osm.tmpdir(), `cl-gen${g + 1}-` + Date.now().toString(36) + '.html');
      fsm.writeFileSync(cur, out);
      tmpGens.push(cur);
    }
    return gens;
  })();
  ok('保存して開き直すのを繰り返しても、ピンの器が増えない',
     r8b.every(g => g.pins === 1),
     r8b.map(g => g.pins + '個').join(' → '));
  ok('保存を繰り返してもレイヤーのidが重複しない',
     r8b.every(g => g.重複id.length === 0),
     r8b.map(g => g.重複id.join('/') || 'なし').join(' → '));
  ok('保存を繰り返してもレイヤーぶんの要素が増え続けない',
     r8b[3].要素数 <= r8b[0].要素数,
     r8b.map(g => g.要素数).join(' → '));
  // 以降のテストのために元のファイルへ戻す
  await goto('file://' + encodeURI(ABS));

  // 検査中のファイルからレイヤーのブロックだけを借りる。以降の「その場で組み立てる資料」で使う
  const LAYER_BLOCK = (() => {
    const src = fsm.readFileSync(ABS, 'utf-8');
    const s0 = src.indexOf('<!-- ==='), s1 = src.lastIndexOf('COMMENT-LAYER');
    const blockEnd = src.indexOf('-->', s1) + 3;
    return src.slice(src.lastIndexOf('<!--', s0 + 1), blockEnd);
  })();
  const mkDoc = (name, body) => {
    const p = pathm.join(osm.tmpdir(), `cl-${name}-` + Date.now().toString(36) + '.html');
    fsm.writeFileSync(p, body.replace('</body>', LAYER_BLOCK + '\n</body>'));
    tmpGens.push(p);
    return p;
  };

  // ===== ここから v2.12.0 追加分（ピンの比率化・完了を隠す・キーボード）=====
  // ピンの検査には「幅がウィンドウに追従する資料」が要る。中央寄せの固定幅コンテナだと
  // 幅を変えても host の幅が変わらず、比率で持てているかどうかが表に出ない。
  // v2.11 までピン座標は host 左上からの絶対pxだったので、相手のウィンドウ幅が違うと
  // ピンが本文からずれた（＝資料側に「中央寄せの固定幅」を注文していた理由）
  const FLUID = mkDoc('fluid', `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>幅可変の資料</title>
<style>body{margin:0;padding:40px 4% 400px;font-family:system-ui,sans-serif;line-height:1.9}
h1{font-size:24px}p{margin:0 0 18px}</style>
</head><body>
<h1>幅可変の資料</h1>
<p>この資料は最大幅を持たないので、ウィンドウ幅がそのまま本文の幅になる。</p>
<p>連携は日次のファイルで行い、結果は担当者へメールで共有する想定である。</p>
<p>移行判定の基準は、並行稼働の二週目までに差分がゼロになっていることとする。</p>
<p>投資回収期間は四年程度を見込んでおり、五年目以降は保守費のみとなる。</p>
</body></html>`);

  b.dialog.action = { accept: true };
  await b.setViewport(1440, 900);
  await goto('file://' + encodeURI(FLUID));

  // 43. ピンを刺し、そのあとウィンドウ幅を変えても、本文に対する同じ位置に居続ける
  const p43a = JSON.parse(await b.evalJS(`
    __commentLayer.setPinMode(true);
    const host = document.querySelector('[data-cl-host]');
    const hr = host.getBoundingClientRect();
    const x = Math.round(hr.left + hr.width * 0.4), y = 260;
    (document.elementFromPoint(x, y) || host).dispatchEvent(
      new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    document.getElementById('cl-draft-text').value = '幅に追従するピン';
    __commentLayer.saveDraft();
    const c = __commentLayer.comments[__commentLayer.comments.length - 1];
    // xr を持たない旧データも並べて置き、こちらは動かないことを確かめる
    __commentLayer.commit({ type: 'add', comment: { id: 'pin-legacy', type: 'pin', text: '旧データのピン',
      author: '旧', color: '#008299', date: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', resolved: false, x: 123, y: 320 } });
    const left = id => parseFloat(document.querySelector('.comment-pin[data-id="' + id + '"]').style.left);
    return JSON.stringify({ id: c.id, x: c.x, xr: c.xr, hostW: __commentLayer._hostWidth(),
                            left: left(c.id), legacyLeft: left('pin-legacy') });
  `));
  await b.setViewport(1000, 900);
  await b.wait(400);
  const p43b = JSON.parse(await b.evalJS(`
    const left = id => parseFloat(document.querySelector('.comment-pin[data-id="' + id + '"]').style.left);
    return JSON.stringify({ hostW: __commentLayer._hostWidth(),
                            left: left('${p43a.id}'), legacyLeft: left('pin-legacy') });
  `));
  const ratio = (l, w) => +(l / w).toFixed(4);
  // 比率は「クリックした瞬間の幅」で取る。saveDraft の時点ではサイドバーが開いていて
  // host が細くなっているので、x / いまの幅 とは一致しない。描画位置が xr に従うことを見る
  ok('ピンの横位置が host 幅に対する比率（xr）で保存される',
     p43a.xr > 0 && p43a.xr < 1 && p43a.x > 0
       && Math.abs(p43a.left - p43a.xr * p43a.hostW) < 0.01,
     `xr=${p43a.xr} x=${p43a.x} hostW=${p43a.hostW} left=${p43a.left}`);
  ok('幅の違うウィンドウで開いてもピンが本文の同じ位置に来る',
     Math.abs(p43a.hostW - p43b.hostW) > 20 && Math.abs(p43a.left - p43b.left) > 5
       && Math.abs(ratio(p43a.left, p43a.hostW) - ratio(p43b.left, p43b.hostW)) < 0.002,
     `${p43a.hostW}px→${p43b.hostW}px / left ${Math.round(p43a.left)}→${Math.round(p43b.left)} / 比率 ${ratio(p43a.left, p43a.hostW)}→${ratio(p43b.left, p43b.hostW)}`);
  ok('xr を持たない旧データは従来どおり絶対pxのまま出る',
     p43a.legacyLeft === 123 && p43b.legacyLeft === 123,
     `${p43a.legacyLeft} → ${p43b.legacyLeft}`);

  // 43b. ドラッグで動かしたら xr も更新される。ここを忘れると、動かした瞬間に旧方式へ戻る
  const p43c = JSON.parse(await b.evalJS(`
    const el = document.querySelector('.comment-pin[data-id="${p43a.id}"]');
    const r = el.getBoundingClientRect();
    const sx = Math.round(r.left + r.width / 2), sy = Math.round(r.top + r.height / 2);
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + 80, clientY: sy + 30, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: sx + 80, clientY: sy + 30, bubbles: true }));
    const c = __commentLayer.comments.filter(x => x.id === '${p43a.id}')[0];
    return JSON.stringify({ x: c.x, xr: c.xr, hostW: __commentLayer._hostWidth(), 動いた: c.x - ${p43b.left} });
  `));
  ok('ドラッグで動かすと xr も追従する（旧方式に戻らない）',
     Math.abs(p43c.動いた - 80) < 2 && Math.abs(p43c.xr - p43c.x / p43c.hostW) < 1e-6,
     JSON.stringify(p43c));

  // 43c. 書き出して、別の幅で開き直しても位置が保たれる
  const exported43 = await b.evalJS(`
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
    return cap.text();`);
  const FLUID2 = pathm.join(osm.tmpdir(), 'cl-fluid2-' + Date.now().toString(36) + '.html');
  fsm.writeFileSync(FLUID2, exported43);
  tmpGens.push(FLUID2);
  await b.setViewport(1300, 900);
  await goto('file://' + encodeURI(FLUID2));
  const p43d = JSON.parse(await b.evalJS(`
    const c = __commentLayer.comments.filter(x => x.id === '${p43a.id}')[0];
    const el = document.querySelector('.comment-pin[data-id="${p43a.id}"]');
    return JSON.stringify({ hostW: __commentLayer._hostWidth(), left: parseFloat(el.style.left), xr: c.xr,
                            legacy: parseFloat(document.querySelector('.comment-pin[data-id="pin-legacy"]').style.left) });
  `));
  ok('動かしたピンは、保存して別の幅で開き直しても本文の同じ位置に出る',
     Math.abs(p43d.hostW - p43c.hostW) > 20
       && Math.abs(ratio(p43d.left, p43d.hostW) - p43c.xr) < 0.002 && p43d.legacy === 123,
     `${p43c.hostW}px→${p43d.hostW}px / 比率 ${p43c.xr.toFixed(4)}→${ratio(p43d.left, p43d.hostW)}`);
  // 43d. ピンは押した場所に立つ。host に枠線があると、border ボックスで測った座標と
  //      ピンの器（padding ボックス）の座標系が枠線ぶんずれる。v2.11 は作成時が前者・
  //      ドラッグ後の保存が後者で、基準そのものが食い違っていた
  {
    const BORDERED = mkDoc('bordered', `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>枠線のある資料</title>
<style>body{margin:0;border-left:40px solid #ccc;border-top:24px solid #ccc;
padding:40px 32px 400px;font-family:system-ui,sans-serif;line-height:1.9}</style>
</head><body>
<h1>枠線のある資料</h1>
<p>host（body）に太い枠線がある。ピンの器は padding ボックスの左上に置かれる。</p>
<p>投資回収期間は四年程度を見込んでおり、五年目以降は保守費のみとなる。</p>
</body></html>`);
    await goto('file://' + encodeURI(BORDERED));
    const r43e = JSON.parse(await b.evalJS(`
      // 先にサイドバーを開いておく。開いていない状態で刺すと、直後に開くぶん本文が
      // 折り返し直り、比率で持っているピンも一緒に動く（＝仕様どおり）。
      // ここで見たいのは座標系の食い違いなので、レイアウトが動かない条件で測る
      __commentLayer.setSidebar(true);
      __commentLayer.setPinMode(true);
      const host = document.querySelector('[data-cl-host]');
      const cs = getComputedStyle(host);
      const x = 300, y = 220;
      (document.elementFromPoint(x, y) || host).dispatchEvent(
        new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
      document.getElementById('cl-draft-text').value = '枠線のある資料へのピン';
      __commentLayer.saveDraft();
      const c = __commentLayer.comments[__commentLayer.comments.length - 1];
      // 立った場所を画面座標に戻して、押した場所と突き合わせる（transform で先端が中心下）
      const el = document.querySelector('.comment-pin[data-id="' + c.id + '"]');
      const r = el.getBoundingClientRect();
      // ドラッグで保存される値と、作成で保存される値が同じ座標系か
      const before = c.x;
      el.dispatchEvent(new MouseEvent('mousedown', { clientX: Math.round(r.left + r.width/2),
        clientY: Math.round(r.top + r.height/2), bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.round(r.left + r.width/2) + 50,
        clientY: Math.round(r.top + r.height/2), bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: Math.round(r.left + r.width/2) + 50,
        clientY: Math.round(r.top + r.height/2), bubbles: true }));
      return JSON.stringify({
        枠線: cs.borderLeftWidth + '/' + cs.borderTopWidth,
        押した: { x, y },
        立った: { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom) },
        作成のx: before, ドラッグ後のx: __commentLayer.comments.filter(z => z.id === c.id)[0].x
      });
    `));
    ok('host に枠線があっても、ピンは押した場所に立つ',
       Math.abs(r43e.立った.x - r43e.押した.x) <= 1 && Math.abs(r43e.立った.y - r43e.押した.y) <= 1,
       `枠線=${r43e.枠線} 押した=(${r43e.押した.x},${r43e.押した.y}) 立った=(${r43e.立った.x},${r43e.立った.y})`);
    ok('ピンの作成とドラッグが同じ座標系で保存される',
       Math.abs((r43e.ドラッグ後のx - r43e.作成のx) - 50) <= 1,
       `作成 ${r43e.作成のx} → ドラッグ後 ${r43e.ドラッグ後のx}（+50 のはず）`);
  }

  // ===== 縦（yr）: 幅が変わると本文の折り返しが変わり、下の内容が押し下げられる。
  //      絶対pxのピンは下へ行くほど本文から離れる。総高さに対する比率なら追従する。
  //      ただし「幅は同じまま本文が編集された」場合は比率のほうが不利なので、
  //      刺したときの幅（hw）と同じ間は px を使う。両方まとめてここで見る
  {
    const para = (i) => `<p>段落${i}。受付から審査までの所要日数は、現行の運用で平均四営業日となっている。` +
      `連携は日次のファイルで行い、結果は担当者へメールで共有する想定である。` +
      `移行判定の基準は、並行稼働の二週目までに差分がゼロになっていることとする。</p>`;
    const before = Array.from({ length: 30 }, (_, i) => para(i + 1)).join('\n');
    const after = Array.from({ length: 15 }, (_, i) => para(i + 31)).join('\n');
    const TALL = mkDoc('tall', `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>幅可変の長い資料</title>
<style>body{margin:0;padding:40px 4% 300px;font-family:system-ui,sans-serif;line-height:1.9;font-size:16px}
h1{font-size:26px}p{margin:0 0 18px}#cl-mark{background:#ffe}</style>
</head><body>
<h1>幅可変の長い資料</h1>
${before}
<p id="cl-mark">目印の段落。ここにピンを刺し、幅を変えたあとも同じ段落を指しているかを見る。</p>
${after}
</body></html>`);

    await b.setViewport(1440, 900);
    await goto('file://' + encodeURI(TALL));
    // 目印の段落の先頭にピンを刺す。サイドバーは先に開いておく（刺した直後に開くと
    // 本文が細くなって、比率で持っているぶん一緒に動くのが混ざるため）
    const y1 = JSON.parse(await b.evalJS(`
      __commentLayer.setSidebar(true);
      __commentLayer.setPinMode(true);
      const rel = el => Math.round(el.getBoundingClientRect().top
        - document.getElementById('cl-pins').getBoundingClientRect().top);
      const mark = document.getElementById('cl-mark');
      const mr = mark.getBoundingClientRect();
      const x = Math.round(mr.left + 40), y = Math.round(mr.top + 4);
      (document.elementFromPoint(x, y) || mark).dispatchEvent(
        new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
      document.getElementById('cl-draft-text').value = '目印の段落へのピン';
      __commentLayer.saveDraft();
      const c = __commentLayer.comments[__commentLayer.comments.length - 1];
      // yr / hw を持たない旧データも並べる。こちらは幅を変えても動いてはいけない
      __commentLayer.commit({ type:'add', comment:{ id:'pin-oldy', type:'pin', text:'旧データのピン',
        author:'旧', color:'#008299', date:'2026-01-01T00:00:00.000Z',
        updatedAt:'2026-01-01T00:00:00.000Z', resolved:false, x:100, y:c.y } });
      return JSON.stringify({ id: c.id, y: c.y, yr: c.yr, hw: c.hw,
        hostW: Math.round(__commentLayer._hostWidth()), hostH: Math.round(__commentLayer._hostHeight()),
        markTop: rel(mark), pinTop: Math.round(__commentLayer._pinTop(c.id)),
        旧pinTop: Math.round(__commentLayer._pinTop('pin-oldy')) });
    `));
    ok('ピンの縦位置も比率（yr）と、刺したときの幅（hw）を持って保存される',
       y1.yr > 0 && y1.yr < 1 && y1.hw === y1.hostW
         && Math.abs(y1.yr - y1.y / y1.hostH) < 1e-5 && Math.abs(y1.pinTop - (y1.markTop + 4)) <= 2,
       `y=${y1.y} yr=${y1.yr} hw=${y1.hw} 目印=${y1.markTop}`);

    // ★ 幅が同じまま本文が伸びた（＝編集された）場合は比率を使わない。
    //   使ってしまうと、末尾に1章足しただけで上のほうのピンまで比例して下がる。
    //   刺した幅のままここで見る（幅を変えたあとに見ると、当然 hw と違うので意味がない）
    const y3 = JSON.parse(await b.evalJS(`
      const host = document.querySelector('[data-cl-host]');
      const before = Math.round(__commentLayer._pinTop('${y1.id}'));
      const h0 = Math.round(__commentLayer._hostHeight());
      const pad = document.createElement('div');
      pad.style.height = '900px';
      host.appendChild(pad);                       // 末尾に1章ぶん足したのと同じ状態
      const after = Math.round(__commentLayer._pinTop('${y1.id}'));
      const 描画 = Math.round(parseFloat(document.querySelector('.comment-pin[data-id="${y1.id}"]').style.top));
      const h1 = Math.round(__commentLayer._hostHeight());
      const 同じ幅 = __commentLayer._sameWidthAsPlaced('${y1.id}');
      pad.remove();
      return JSON.stringify({ before, after, 描画, h0, h1, 同じ幅 });
    `));
    ok('幅が同じままなら、本文が伸びてもピンは動かない（編集に強い）',
       y3.h1 - y3.h0 >= 800 && y3.同じ幅 === true && y3.before === y3.after && y3.描画 === y3.before,
       `総高さ ${y3.h0}→${y3.h1}px でもピンは ${y3.before}px のまま（同じ幅=${y3.同じ幅}）`);

    // 幅を縮めて本文を折り返し直させる
    await b.setViewport(1000, 900);
    await b.wait(450);
    const y2 = JSON.parse(await b.evalJS(`
      const rel = el => Math.round(el.getBoundingClientRect().top
        - document.getElementById('cl-pins').getBoundingClientRect().top);
      const mark = document.getElementById('cl-mark');
      const el = document.querySelector('.comment-pin[data-id="${y1.id}"]');
      return JSON.stringify({
        hostW: Math.round(__commentLayer._hostWidth()), hostH: Math.round(__commentLayer._hostHeight()),
        markTop: rel(mark),
        pinTop: Math.round(__commentLayer._pinTop('${y1.id}')),
        描画のtop: Math.round(parseFloat(el.style.top)),
        旧pinTop: Math.round(__commentLayer._pinTop('pin-oldy')),
        保存値y: __commentLayer.comments.filter(c => c.id === '${y1.id}')[0].y });
    `));
    const 目標 = y2.markTop + 4;
    const 新誤差 = Math.abs(y2.pinTop - 目標);
    const 旧誤差 = Math.abs(y1.y - 目標);              // 絶対pxのままだった場合の誤差
    ok('幅が変わって本文が流れても、ピンが目印の段落を指し続ける',
       旧誤差 > 200 && 新誤差 < 旧誤差 / 5 && 新誤差 < 120 && y2.描画のtop === y2.pinTop,
       `本文が ${y1.hostH}px→${y2.hostH}px に伸び、目印は ${y1.markTop}px→${y2.markTop}px へ。` +
       `ずれ: 絶対pxなら ${旧誤差}px → 比率なら ${新誤差}px`);
    ok('yr を持たない旧データは、幅が変わっても動かない',
       y2.旧pinTop === y1.旧pinTop, `${y1.旧pinTop} → ${y2.旧pinTop}`);

    // 書き出して別の幅で開き直しても、比率と hw が生きている
    const outY = await b.evalJS(`
      let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
      const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
      __commentLayer.exportHTML();
      URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
      return cap.text();`);
    const TALL2 = pathm.join(osm.tmpdir(), 'cl-tall2-' + Date.now().toString(36) + '.html');
    fsm.writeFileSync(TALL2, outY); tmpGens.push(TALL2);
    await b.setViewport(1240, 900);
    await goto('file://' + encodeURI(TALL2));
    const y4 = JSON.parse(await b.evalJS(`
      const rel = el => Math.round(el.getBoundingClientRect().top
        - document.getElementById('cl-pins').getBoundingClientRect().top);
      const c = __commentLayer.comments.filter(x => x.id === '${y1.id}')[0];
      return JSON.stringify({ yr: c.yr, hw: c.hw, markTop: rel(document.getElementById('cl-mark')),
        pinTop: Math.round(__commentLayer._pinTop('${y1.id}')),
        hostW: Math.round(__commentLayer._hostWidth()) });
    `));
    ok('保存して別の幅で開き直しても、縦位置が目印を指したままになる',
       y4.yr === y1.yr && y4.hw === y1.hw && Math.abs(y4.pinTop - (y4.markTop + 4)) < 120,
       `幅 ${y4.hostW}px / 目印 ${y4.markTop}px / ピン ${y4.pinTop}px（差 ${Math.abs(y4.pinTop - (y4.markTop + 4))}px）`);
  }

  await goto('file://' + encodeURI(FLUID2));
  await b.clearViewport();
  await b.wait(200);

  // 44. 完了を隠すトグル。区切り線そのものが取っ手で、畳んでも件数は全件のまま出る
  const r44 = JSON.parse(await b.evalJS(`
    const ids = () => [...document.querySelectorAll('.cl-item')].map(e => e.id.replace('cl-item-',''));
    __commentLayer.setHideDone(false);
    __commentLayer.setSidebar(true);
    const all = __commentLayer.comments.map(c => c.id);
    __commentLayer.toggleResolve(all[0]);
    const openCount = document.getElementById('cl-count').textContent;
    const divider = document.querySelector('.cl-divider');
    const 見えている = ids().length;
    divider.click();                                  // 畳む
    const 畳んだ = {
      件数表示: document.getElementById('cl-count').textContent,
      カード数: ids().length,
      完了カードが消えた: !document.getElementById('cl-item-' + all[0]),
      区切りは残る: !!document.querySelector('.cl-divider'),
      区切りの文言: (document.querySelector('.cl-divider') || {}).textContent,
      aria: (document.querySelector('.cl-divider') || {}).getAttribute
              ? document.querySelector('.cl-divider').getAttribute('aria-expanded') : null,
      保存値: localStorage.getItem('cl-hide-done')
    };
    // J / K は隠した完了を飛ばす
    __commentLayer.focusFromList(ids()[0]);
    const seen = [];
    for (let i = 0; i < 6; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
      const a = document.querySelector('.cl-item.cl-active');
      seen.push(a ? a.id.replace('cl-item-','') : null);
    }
    document.querySelector('.cl-divider').click();    // 開き直す
    const 開いた = { カード数: ids().length, aria: document.querySelector('.cl-divider').getAttribute('aria-expanded') };
    return JSON.stringify({ openCount, 見えている, 畳んだ, 開いた, 完了id: all[0],
      Jが完了へ行かない: seen.every(id => id !== all[0]) });
  `));
  ok('「完了済み N件」の区切りを押すと完了カードが畳まれ、区切り自体は取っ手として残る',
     r44.畳んだ.完了カードが消えた && r44.畳んだ.区切りは残る && r44.畳んだ.カード数 === r44.見えている - 1
       && r44.畳んだ.aria === 'false' && /完了済み 1件/.test(r44.畳んだ.区切りの文言 || ''),
     JSON.stringify(r44.畳んだ));
  ok('畳んでいる間も件数表示は全件のまま（消えたのではないと分かる）',
     r44.畳んだ.件数表示 === r44.openCount && /全 \d+ 件/.test(r44.openCount),
     `${r44.openCount} / ${r44.畳んだ.件数表示}`);
  ok('J / K は畳んだ完了を飛ばす', r44.Jが完了へ行かない, JSON.stringify(r44));
  ok('もう一度押すと完了カードが戻る',
     r44.開いた.カード数 === r44.見えている && r44.開いた.aria === 'true', JSON.stringify(r44.開いた));

  // 44c. 区切りは左右の罫線を ::before / ::after で描いている。同じ要素に data-cl-tip を
  //      足すと [data-cl-tip]::after と潰し合い、content は罫線が勝つのに
  //      position:absolute だけが残って**右側の罫線が消える**（実際そうなっていた）
  const r44line = JSON.parse(await b.evalJS(`
    const d = document.querySelector('.cl-divider');
    const w = s => parseFloat(getComputedStyle(d, s).width) || 0;
    const p = s => getComputedStyle(d, s).position;
    return JSON.stringify({ 左: Math.round(w('::before')), 右: Math.round(w('::after')),
      左の配置: p('::before'), 右の配置: p('::after'),
      幅: Math.round(d.getBoundingClientRect().width) });
  `));
  ok('完了済みの区切りは、左右とも罫線が引かれる（ツールチップと潰し合っていない）',
     r44line.左 > 20 && r44line.右 > 20 && Math.abs(r44line.左 - r44line.右) <= 2
       && r44line.左の配置 === 'static' && r44line.右の配置 === 'static',
     JSON.stringify(r44line));

  // 44b. 並び順と同じく「読み手の都合」なので localStorage に持ち、書き出したHTMLには焼かない
  const r44b = await b.evalJS(`
    __commentLayer.setHideDone(true);
    let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    __commentLayer.exportHTML();
    URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
    return cap.text();`);
  // 判定に "cl-hide-done" の有無は使えない。localStorage のキー名としてレイヤーの
  // スクリプト本体に書いてあるので、書き出したHTMLには必ず現れる。
  // 見るべきは「畳んだという状態」がファイルに入っていないこと
  ok('「完了を隠す」設定は書き出したHTMLに焼き込まれない（並び順と同じく localStorage 止まり）',
     r44b.indexOf('class="cl-divider"') < 0 && !/<html[^>]*cl-hide/.test(r44b)
       && !/"hideDone"/.test(r44b) && r44.畳んだ.保存値 === '1',
     `区切りの焼き込みなし=${r44b.indexOf('class="cl-divider"') < 0} localStorage=${r44.畳んだ.保存値}`);
  // 開き直しても設定が残る（同じファイルなので localStorage が効く）。
  // 完了そのものは書き出していないので、開いたあとにもう一度完了にして確かめる
  await goto('file://' + encodeURI(FLUID2));
  const r44c = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    const 設定 = __commentLayer.hideDone;
    const id = __commentLayer.comments[0].id;
    __commentLayer.toggleResolve(id);
    return JSON.stringify({ 設定,
      完了が即畳まれる: !document.getElementById('cl-item-' + id)
        && !!document.querySelector('.cl-divider[aria-expanded="false"]'),
      消えたのではないと伝える: /畳む設定/.test(document.getElementById('cl-toast').textContent) });
  `));
  ok('「完了を隠す」設定は開き直しても残る（localStorage）',
     r44c.設定 === true && r44c.完了が即畳まれる, JSON.stringify(r44c));
  ok('畳む設定のまま完了にすると、カードが消えたのではないことをその場で伝える',
     r44c.消えたのではないと伝える, JSON.stringify(r44c));

  // 44d. 畳むのは一覧だけ。本文のピンとハイライトは残るので、そこから飛べてしまう。
  //      飛んだ先で一覧に何も出ないと「押しても無反応」にしか見えないので、畳みを解いて出す
  const r44d = JSON.parse(await b.evalJS(`
    const id = __commentLayer.comments.filter(c => c.resolved)[0].id;
    const 畳む前 = { 畳んでいる: __commentLayer.hideDone, カードなし: !document.getElementById('cl-item-' + id) };
    const el = document.querySelector('.comment-pin[data-id="' + id + '"], .comment-highlight[data-id="' + id + '"]');
    if (!el) return JSON.stringify({ fatal: '完了した指摘が本文に残っていない' });
    el.click();
    return JSON.stringify({ 畳む前,
      本文には残っている: true,
      押すと開いて選ばれる: !!document.querySelector('#cl-item-' + id + '.cl-active'),
      畳みが解ける: __commentLayer.hideDone === false });
  `));
  if (r44d.fatal) throw new Error(r44d.fatal);
  ok('畳んでいても、本文のピン・ハイライトから飛べば開いて選ばれる（押して無反応にならない）',
     r44d.畳む前.畳んでいる && r44d.畳む前.カードなし && r44d.押すと開いて選ばれる && r44d.畳みが解ける,
     JSON.stringify(r44d));
  await b.evalJS(`__commentLayer.setHideDone(false); return 1;`);

  // 45. キーボード操作。v2.11 まで tabindex がどこにも無く、カードは J / K でしか辿れなかった
  const r45 = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    const cards = [...document.querySelectorAll('.cl-item:not(.cl-draft)')];
    const first = cards[0];
    first.focus();
    const フォーカスできる = document.activeElement === first;
    // カードにフォーカスがある状態でも、単キーのショートカットは効く
    const send = key => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    send('j'); const jが効く = !!document.querySelector('.cl-item.cl-active');
    send('c'); const cが効く = document.documentElement.classList.contains('cl-pinmode');
    __commentLayer.setPinMode(false);
    // Space は奪わない（一覧のスクロールに残す）。押しても選択は動かず、既定動作も止めない
    const other = cards[1] || cards[0];
    __commentLayer.focusFromList(cards[0].id.replace('cl-item-',''));
    other.focus();
    const sp = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    other.dispatchEvent(sp);
    const spaceは奪わない = !sp.defaultPrevented && !other.classList.contains('cl-active');
    // Enter で本文へ飛ぶ（クリックと同じ）
    first.focus();
    const en = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    first.dispatchEvent(en);
    return JSON.stringify({
      全カードがtabindex0: cards.every(e => e.getAttribute('tabindex') === '0'),
      フォーカスできる, jが効く, cが効く, spaceは奪わない,
      Enterで選ばれる: first.classList.contains('cl-active') && en.defaultPrevented,
      現在地が読み上げに出る: first.getAttribute('aria-current') === 'true',
      現在地はひとつだけ: document.querySelectorAll('#cl-list [aria-current]').length === 1
    });
  `));
  ok('コメントカードを Tab で辿れ、Enter で本文へ飛ぶ',
     r45.全カードがtabindex0 && r45.フォーカスできる && r45.Enterで選ばれる, JSON.stringify(r45));
  ok('カードは Space を奪わない（スペースはスクロールのまま残す）',
     r45.spaceは奪わない, JSON.stringify(r45));
  ok('カードにフォーカスがあっても J / C などの単キーが効く', r45.jが効く && r45.cが効く, JSON.stringify(r45));
  ok('いま選んでいるカードが aria-current で1つだけ示される',
     r45.現在地が読み上げに出る && r45.現在地はひとつだけ, JSON.stringify(r45));

  // 45b. ガイドはモーダル（aria-modal="true"）なので、開いている間 Tab を外へ出さない。
  //      サイドバーは違う。モーダルではないので閉じ込めるのは誤り
  await b.evalJS(`
    __commentLayer.setSidebar(true);
    document.querySelector('.cl-item:not(.cl-draft)').focus();
    window.__before = document.activeElement.id;
    document.getElementById('cl-guide-fab').click();
    return 1;`);
  await b.wait(300);
  // 閉じる + ドット9つ + 「次へ」で11個（「戻る」は1ページ目なので disabled）。
  // 一周して先頭へ戻るところまで回す
  const tabWalk = [];
  for (let i = 0; i < 13; i++) {
    await b.key(9, 'Tab', 0);
    await b.wait(60);
    tabWalk.push(JSON.parse(await b.evalJS(`return JSON.stringify({
      中にいる: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#cl-guide')),
      どこ: (document.activeElement && (document.activeElement.id || document.activeElement.className)) || '(body)',
      ページ: __commentLayer.guideStep });`)));
  }
  await b.key(9, 'Tab', 8);   // Shift+Tab（戻り側も外へ出ない）
  await b.wait(60);
  const backTab = JSON.parse(await b.evalJS(`return JSON.stringify({
    中にいる: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#cl-guide')),
    ページ: __commentLayer.guideStep });`));
  ok('ガイドを開いている間、Tab がパネルの外へ出ない',
     tabWalk.every(t => t.中にいる) && backTab.中にいる,
     tabWalk.map(t => t.どこ).join(' → '));
  ok('ガイド内の Tab 移動でページが勝手に送られない',
     tabWalk.every(t => t.ページ === 0) && backTab.ページ === 0,
     tabWalk.map(t => t.ページ).join(','));

  const r45c = JSON.parse(await b.evalJS(`
    __commentLayer.setGuide(false);
    return JSON.stringify({
      戻り先: (document.activeElement && document.activeElement.id) || '(body)',
      期待: window.__before,
      閉じた: !document.documentElement.classList.contains('cl-guide-open') });
  `));
  ok('ガイドを閉じると、開く前に触っていた要素へフォーカスが戻る',
     r45c.閉じた && r45c.戻り先 === r45c.期待 && /^cl-item-/.test(r45c.期待 || ''),
     JSON.stringify(r45c));

  // 45d. サイドバーには閉じ込めを入れない（モーダルではないため）
  await goto('file://' + encodeURI(FLUID2));
  await b.evalJS(`__commentLayer.setSidebar(true); document.getElementById('cl-copy').focus(); return 1;`);
  const outWalk = [];
  for (let i = 0; i < 5; i++) {
    await b.key(9, 'Tab', 0);
    await b.wait(50);
    outWalk.push(await b.evalJS(`return !!(document.activeElement && document.activeElement.closest
      && document.activeElement.closest('#cl-sidebar'));`));
  }
  ok('サイドバーはモーダルではないので Tab で外へ出られる', outWalk.some(v => v === false),
     outWalk.map(v => v ? '中' : '外').join(' → '));

  const errs8 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('ピン・完了・キーボードのテスト中もJSエラーが出ない', errs8.length === 0,
     errs8.map(e => e.params.exceptionDetails.text).join(' / '));

  // 46. --merge：AさんとBさんが別々に書いたレビューを1つにまとめる
  {
    const cpm = await import('node:child_process');
    const urlm = await import('node:url');
    const PY = pathm.join(pathm.dirname(urlm.fileURLToPath(import.meta.url)), 'add_comment_layer.py');

    // 46a. 合流の規則そのもの（新しい方を採る・返信は和集合・ユーザーは基準側を優先）
    const unit = cpm.execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(PY)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
A = [{"id":"t1","text":"古い","updatedAt":"2026-01-01T00:00:00.000Z",
      "replies":[{"id":"r1","text":"Aの返信","date":"2026-01-01T00:00:00.000Z"}]},
     {"id":"t2","text":"Aだけ","updatedAt":"2026-01-01T00:00:00.000Z"}]
B = [{"id":"t1","text":"新しい","updatedAt":"2026-02-01T00:00:00.000Z",
      "replies":[{"id":"r2","text":"Bの返信","date":"2026-01-05T00:00:00.000Z"}]},
     {"id":"t3","text":"Bだけ","updatedAt":"2026-01-01T00:00:00.000Z"}]
c = m.merge_comments(A, B)
u = m.merge_users([{"id":"u1","name":"A側","color":"#111111"}],
                  [{"id":"u1","name":"B側","color":"#222222"},{"id":"u2","name":"Bさん","color":"#333333"}])
# 名前では寄せない（同姓の別人が1人に潰れる方が害が大きい）。同名別IDは2人のまま残る
dupname = m.merge_users([{"id":"u1","name":"田中","color":"#111111"}],
                        [{"id":"u9","name":"田中","color":"#222222"}])
t1 = [x for x in c if x["id"] == "t1"][0]
print(json.dumps({
  "件数": len(c), "id": [x["id"] for x in c],
  "新しい方を採る": t1["text"], "返信の和集合": sorted(r["id"] for r in t1["replies"]),
  "返信キーは無ければ出ない": "replies" not in [x for x in c if x["id"] == "t2"][0],
  "ユーザー": [(x["id"], x["name"]) for x in u],
  "同名別IDは潰さない": len(dupname) == 2,
  "閉じscriptを伏せる": "<" not in m.dump_store([{"t": "</script>"}]),
  "境界マーカーを伏せる": "COMMENT-LAYER" not in m.dump_store([{"t": "COMMENT-LAYER"}]),
}, ensure_ascii=False))
`], { encoding: 'utf-8' }).trim();
    const r46a = JSON.parse(unit);
    ok('--merge：同じIDは最終更新が新しい方を採り、返信は両方から集まる',
       r46a.件数 === 3 && r46a.新しい方を採る === '新しい'
         && JSON.stringify(r46a.返信の和集合) === JSON.stringify(['r1', 'r2'])
         && r46a.返信キーは無ければ出ない,
       JSON.stringify(r46a));
    ok('--merge：ユーザーはIDで和集合にし、同じIDは基準ファイル側を残す',
       r46a.ユーザー.length === 2 && r46a.ユーザー[0][1] === 'A側', JSON.stringify(r46a.ユーザー));
    ok('--merge：同名でもIDが違えば別人として残す（同姓の別人を潰さない）',
       r46a.同名別IDは潰さない, JSON.stringify(r46a.ユーザー));
    ok('--merge：書き出しは exportHTML と同じエスケープ（閉じscript・境界マーカー）',
       r46a.閉じscriptを伏せる && r46a.境界マーカーを伏せる, JSON.stringify(r46a));

    // 46b. 実際に2人ぶんのファイルを作って合流させ、開き直して位置が復元されるところまで見る。
    //      土台は検査対象の資料ではなく、その場で組み立てた静的な資料にする。
    //      実サイトの保存ページのように「開くたびに中身を組み立て直す」資料を土台にすると、
    //      合流の可否ではなく資料側の二重描画を測ることになる（既知の性質＝SKILL.md 参照）
    const MERGE_DOC = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>合流テストの資料</title>
<style>body{margin:0 auto;max-width:820px;padding:48px 32px 240px;font-family:system-ui,sans-serif;line-height:1.9}</style>
</head><body>
<h1>合流テストの資料</h1>
<p>受付から審査までの所要日数は、現行の運用で平均四営業日となっている。</p>
<p>連携は日次のファイルで行い、結果は担当者へメールで共有する想定である。</p>
<p>移行判定の基準は、並行稼働の二週目までに差分がゼロになっていることとする。</p>
<p>投資回収期間は四年程度を見込んでおり、五年目以降は保守費のみとなる。</p>
</body></html>`;
    const write2 = async (tag, note) => {
      const p = mkDoc(tag, MERGE_DOC);
      b.dialog.log.length = 0;
      await goto('file://' + encodeURI(p));
      const info = JSON.parse(await b.evalJS(PAGE_HELPERS + `
        const q = __vt.uniq(12, ${JSON.stringify(note.exclude || [])}, ${note.backwards ? 'true' : 'false'});
        if (!q) return JSON.stringify({ fatal: '一意な文字列が見つからない' });
        const id = __vt.mk(q, ${JSON.stringify(note.text)});
        ${note.reply ? `__commentLayer.commit({ type:'reply-add', id: id, reply: { id:'rep-${tag}',
            text: ${JSON.stringify(note.reply)}, author:'${tag}', color:'#008299', date: new Date().toISOString() } });` : ''}
        let cap = null; const o = URL.createObjectURL; URL.createObjectURL = x => { cap = x; return 'blob:t'; };
        const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
        __commentLayer.exportHTML();
        URL.createObjectURL = o; HTMLAnchorElement.prototype.click = k;
        return cap.text().then(t => JSON.stringify({ id, q, html: t }));
      `));
      if (info.fatal) throw new Error(info.fatal);
      fsm.writeFileSync(p, info.html);
      return { path: p, id: info.id, q: info.q };
    };
    const A = await write2('mergeA', { text: 'Aさんの指摘', reply: 'Aさんの返信' });
    const B = await write2('mergeB', { text: 'Bさんの指摘', exclude: [], backwards: true });
    const MERGED = pathm.join(osm.tmpdir(), 'cl-merged-' + Date.now().toString(36) + '.html');
    tmpGens.push(MERGED);
    const out46 = cpm.execFileSync('python3', [PY, A.path, '--merge', B.path, '-o', MERGED], { encoding: 'utf-8' });

    b.dialog.log.length = 0;
    await goto('file://' + encodeURI(MERGED));
    const r46b = JSON.parse(await b.evalJS(`
      const at = id => __commentLayer.comments.filter(c => c.id === id)[0];
      const a = at('${A.id}'), bb = at('${B.id}');
      return JSON.stringify({
        両方入っている: !!a && !!bb,
        A本文: a ? a.text : null, B本文: bb ? bb.text : null,
        Aの返信: a && (a.replies || []).length === 1,
        Aのハイライト: !!document.querySelector('.comment-highlight[data-id="${A.id}"]'),
        Bのハイライト: !!document.querySelector('.comment-highlight[data-id="${B.id}"]'),
        JSONエラーなし: !!window.__commentLayer
      });
    `));
    ok('--merge で2人ぶんのコメントが全件そろい、返信も残る',
       r46b.両方入っている && r46b.A本文 === 'Aさんの指摘' && r46b.B本文 === 'Bさんの指摘' && r46b.Aの返信,
       JSON.stringify(r46b));
    ok('--merge の結果を開くと、引用が一意な指摘はハイライトが復元される',
       r46b.Aのハイライト && r46b.Bのハイライト, JSON.stringify(r46b));
    // 46c. まだレビューしていない資料に合流する場合、基準側の user-master は
    //      アセット同梱の初期値（無記名）であってデータではない。
    //      これを「基準側優先」で残すと、同じ id を持つ相手の実名が初期値に潰される
    {
      const plain = pathm.join(osm.tmpdir(), 'cl-plain-' + Date.now().toString(36) + '.html');
      tmpGens.push(plain);
      fsm.writeFileSync(plain, `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>まだレビューしていない資料</title></head><body><h1>未レビュー</h1>
<p>投資回収期間は四年程度を見込んでいる。</p></body></html>`);
      // ★ 相手側の u1 を改名しておく。初期値と同じ名前のままだと、潰れても潰れなくても
      //   同じ結果になり、判定が素通りする（＝意味のない検査になる）
      const RENAMED = '合流元で改名した人';
      const bRenamed = pathm.join(osm.tmpdir(), 'cl-brenamed-' + Date.now().toString(36) + '.html');
      tmpGens.push(bRenamed);
      fsm.writeFileSync(bRenamed, fsm.readFileSync(B.path, 'utf-8').replace(
        /(<script[^>]*\bid="user-master"[^>]*>)([\s\S]*?)(<\/script\s*>)/,
        (m0, a, body, c) => a + body.replace(/"name":"[^"]*"/, `"name":"${RENAMED}"`) + c));
      const outPlain = pathm.join(osm.tmpdir(), 'cl-plainmerged-' + Date.now().toString(36) + '.html');
      tmpGens.push(outPlain);
      cpm.execFileSync('python3', [PY, plain, '--merge', bRenamed, '-o', outPlain], { encoding: 'utf-8' });
      const src = fsm.readFileSync(outPlain, 'utf-8');
      const grab = (id) => JSON.parse(
        (src.match(new RegExp('<script[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</script\\s*>')) || [null, '[]'])[1]);
      const got = grab('user-master'), gotC = grab('comment-store');
      ok('--merge：レイヤーの無い資料に合流しても、相手のユーザーが初期値に潰されない',
         gotC.length >= 1 && got.some(g => g.name === RENAMED)
           && !got.some(g => g.name === '無記名'),
         `結果=${JSON.stringify(got.map(u => [u.id, u.name]))}`);
    }

    ok('--merge の完了メッセージが、位置の復元と「コメントは失われていない」ことを伝える',
       /ハイライトは合流していません/.test(out46) && /位置が復元されます/.test(out46)
         && /失われていません/.test(out46),
       out46.split('\n').filter(l => l.indexOf('※') >= 0).join(' / '));
  }

  const errs9 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('合流テスト中もJSエラーが出ない', errs9.length === 0, errs9.map(e => e.params.exceptionDetails.text).join(' / '));
  await goto('file://' + encodeURI(ABS));

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
    const tmpBare = mkDoc('bare', bare);
    b.dialog.log.length = 0;
    b.dialog.action = { accept: true };
    await goto('file://' + encodeURI(tmpBare));

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
    await goto('file://' + encodeURI(tmpBare));
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

  /* ========================================================================
     46. v2.14: AIによる完了の書き戻しと、その検算 / 版の系譜
     ここで守りたいのは1つだけ——「AIが完了と言った」を無条件で信じないこと。
     検算は resolvedBy が AI のときだけ働き、人が完了にしたものには出ない。
     ★条件は「ハイライトが在るか」ではなく「引用が消えたことを確認できたか」で書く。
       前者だと ambiguous（同じ文が複数）と pin型 がそのまま素通りする。
     ======================================================================== */
  await goto(URL0);
  // ページを開き直すと window.__vt は消える。ヘルパは毎回入れ直す
  await b.evalJS(PAGE_HELPERS + 'return 1;');
  b.events.length = 0;

  const f46 = JSON.parse(await b.evalJS(`
    __commentLayer.setSidebar(true);
    // 既存のコメントは消してから作る（サンプルによって初期状態が違うため）
    __commentLayer.comments.slice().forEach(c => __commentLayer.commit({type:'delete', id:c.id}));
    const used = [];
    const qA = __vt.uniq(12, used); used.push(qA);   // AI完了・引用が残る → 未検算
    const qB = __vt.uniq(12, used); used.push(qB);   // 人が完了      → 検算の対象外
    const qD = __vt.uniq(12, used); used.push(qD);   // AI完了・その場で書き換え → 検算通過
    const idA = __vt.mk(qA, 'AIが直したと言っている指摘');
    const idB = __vt.mk(qB, '人が完了にした指摘');
    const idD = __vt.mk(qD, 'AIが本文を書き換えた指摘');
    // ピンは commit で直接足す（座標を選ぶUIを経由しなくてよい）
    const idC = 'pin-vt46';
    const now = new Date().toISOString();
    __commentLayer.commit({type:'add', comment:{id:idC, type:'pin', text:'図の余白がずれています',
      author:'田中（企画）', color:'#c74700', date:now, updatedAt:now, resolved:false,
      x:120, y:160, xr:0.2, yr:0.1, hw:Math.round(__commentLayer._hostWidth())}});
    // AI完了は --apply-state と同じ形で作る（resolvedBy に "AI" が入る）
    [idA, idC, idD].forEach(id => __commentLayer.commit({type:'resolve', id, by:'AI'}));
    __commentLayer.commit({type:'resolve', id: idB, by:'山本（技術リード）'});
    // D だけ、AIが本文をその場で書き換えた状況にする（span は残り、中身だけ変わる）
    const hd = document.querySelector('.comment-highlight[data-id="' + idD + '"]');
    if (hd) hd.textContent = '（この箇所はAIが書き換えました）';
    // E: 要素をまたぐ引用。★これが無いと検算のいちばん普通の経路を1件も通らない。
    //    quote は savedRange.toString()＝要素の隙間の空白を含み、span の連結には含まれない
    //    （wrapRange が空白だけのノードを弾く）。左右で空白の扱いを揃えないと、
    //    見出し＋次の行・箇条書き2項目・段落2つ が全部「変わった」と誤判定されて素通りする
    const els = [...document.querySelector('[data-cl-host]')
      .querySelectorAll('h1,h2,h3,p,li,td,dd,dt')]
      .filter(e => !e.closest('#cl-sidebar,#cl-dock,#cl-guide,#cl-guide-fab,#cl-toast')
                && e.firstChild && e.firstChild.nodeType === 3
                && e.firstChild.textContent.trim().length > 8
                && !e.querySelector('.comment-highlight'));
    let idE = null, eSpans = 0;
    for (let i = 0; i + 1 < els.length && !idE; i++) {
      const r = document.createRange();
      r.setStart(els[i].firstChild, Math.max(0, els[i].firstChild.textContent.length - 6));
      r.setEnd(els[i + 1].firstChild, 6);
      if (!r.toString().trim()) continue;
      __commentLayer._setRange(r); __commentLayer.startTextComment();
      document.getElementById('cl-draft-text').value = '要素をまたぐ引用への指摘';
      __commentLayer.saveDraft();
      const c = __commentLayer.comments[__commentLayer.comments.length - 1];
      eSpans = document.querySelectorAll('.comment-highlight[data-id="' + c.id + '"]').length;
      if (eSpans >= 2) { idE = c.id; __commentLayer.commit({type:'resolve', id: idE, by:'AI'}); }
      else __commentLayer.commit({type:'delete', id: c.id});
    }
    __commentLayer.render();
    return JSON.stringify({idA, idB, idC, idD, idE, eSpans, qA});
  `));

  const r46 = JSON.parse(await b.evalJS(`
    const md = __commentLayer.buildReviewMarkdown();
    const ids = __commentLayer.comments.map(c => c.id);
    const blocks = md.split(/^## 指摘 /m).slice(1);
    const stateOf = (id) => {
      const blk = blocks.filter(x => x.indexOf('ID: ' + id) >= 0)[0] || '';
      const m = blk.match(/^状態: .*$/m);
      return m ? m[0] : '';
    };
    return JSON.stringify({
      全件にIDが出る: ids.every(id => md.indexOf('\\nID: ' + id + '\\n') >= 0),
      IDと件数が1対1: (md.match(/^ID: /gm) || []).length === ids.length,
      IDは状態の直前: blocks.every(x => /^ID: [^\\n]+\\n状態: /m.test(x)),
      A_未検算の文言: stateOf('${f46.idA}'),
      B_人の完了: stateOf('${f46.idB}'),
      C_ピンの文言: stateOf('${f46.idC}'),
      D_書き換え済み: stateOf('${f46.idD}'),
      手順節がある: md.indexOf('## 修正後の手順（必須）') >= 0,
      形式例がある: md.indexOf('"updates"') >= 0 && md.indexOf('"resolved": true') >= 0,
      禁止事項が2つ: (md.split('### 禁止事項')[1] || '').split('\\n').filter(l => l.startsWith('- ')).length === 2,
      直接編集の手順が無い: md.indexOf('u003c') < 0 && md.indexOf('COMMENT\\\\u002d') < 0,
      HTML断片が無い: !/<[a-zA-Z][^>]*>/.test(md)
    });
  `));
  ok('Markdown: 全指摘に ID が出て、コメントと1対1で対応する',
     r46.全件にIDが出る && r46.IDと件数が1対1, JSON.stringify(r46));
  ok('Markdown: ID は必ず 状態 の直前に出る（完了済みにも出る）', r46.IDは状態の直前, JSON.stringify(r46));
  ok('Markdown: AI完了で引用が残っていると「修正不要」を出さない',
     r46.A_未検算の文言.indexOf('修正不要') < 0 && r46.A_未検算の文言.indexOf('人の確認待ち') >= 0,
     r46.A_未検算の文言);
  // ★「引用が残っている」から「直っていない」へ推論を跨がない。跨ぐと、引用文を変えない
  //   修正（注記の追加など）とピンで、AI側から解除できないまま毎周直され続ける
  ok('Markdown: 未検算をAIに再修正させない（確認は人の仕事）',
     r46.A_未検算の文言.indexOf('再修正しないでください') >= 0 &&
     r46.A_未検算の文言.indexOf('本文を修正してください') < 0, r46.A_未検算の文言);
  ok('Markdown: 人が完了にしたものは従来どおり「修正不要」',
     r46.B_人の完了.indexOf('修正不要') >= 0, r46.B_人の完了);
  ok('Markdown: ピンのAI完了は「照合できない」と書く',
     r46.C_ピンの文言.indexOf('人の確認待ち') >= 0 && r46.C_ピンの文言.indexOf('確認できません') >= 0,
     r46.C_ピンの文言);
  ok('Markdown: AIが本文を書き換えた指摘は検算を通過して「修正不要」',
     r46.D_書き換え済み.indexOf('修正不要') >= 0, r46.D_書き換え済み);
  ok('Markdown: 書き戻し手順と review-state.json の形式が載る',
     r46.手順節がある && r46.形式例がある, JSON.stringify(r46));
  ok('Markdown: 禁止事項は2つで、埋め込みJSONを直接編集させる手順が無い',
     r46.禁止事項が2つ && r46.直接編集の手順が無い, JSON.stringify(r46));
  ok('Markdown: 手順を足してもHTML断片は混ざらない', r46.HTML断片が無い);

  const u46 = JSON.parse(await b.evalJS(`
    const card = id => document.getElementById('cl-item-' + id);
    const warnOf = id => { const e = card(id).querySelector('.cl-unverified'); return e ? e.textContent.replace(/\\s+/g,' ').trim() : null; };
    const badge = document.getElementById('cl-unver');
    return JSON.stringify({
      未検算: __commentLayer.unverified,
      A警告: warnOf('${f46.idA}'), B警告: warnOf('${f46.idB}'),
      C警告: warnOf('${f46.idC}'), D警告: warnOf('${f46.idD}'),
      E警告: ${f46.idE ? "warnOf('" + f46.idE + "')" : 'null'},
      期待件数: ${f46.idE ? 3 : 2},
      完了に従来警告が出ていない: document.querySelectorAll('.cl-item.cl-done .cl-orphan:not(.cl-unverified)').length === 0,
      バッジ: badge.hidden ? null : badge.textContent.trim(),
      確認済みボタン数: document.querySelectorAll('[data-cl="ack"]').length
    });
  `));
  ok('カード: AI完了で引用が残っていると未検算の警告が出る',
     !!u46.A警告 && u46.A警告.indexOf('変わっていません') >= 0, u46.A警告);
  ok('カード: 人が完了にしたものには警告を出さない', u46.B警告 === null, u46.B警告);
  ok('カード: ピンのAI完了も未検算として拾う',
     !!u46.C警告 && u46.C警告.indexOf('照合ができません') >= 0, u46.C警告);
  ok('カード: AIが本文を書き換えたものは警告を出さない', u46.D警告 === null, u46.D警告);
  ok('カード: 完了済みに「対応済みの可能性」を重ねて出さない', u46.完了に従来警告が出ていない);
  ok('バッジ: 未検算の件数だけを数える（AI完了の件数ではない）',
     u46.未検算.length === u46.期待件数 && new RegExp(u46.期待件数 + ' 件').test(u46.バッジ || ''),
     JSON.stringify(u46));
  // ★要素をまたぐ引用。本文に手を付けていないので必ず未検算に残らなければならない。
  //   ここが通らないなら、見出し＋次の行のような普通の選択が全部素通りしている
  ok('検算: 要素をまたぐ引用（複数span）でも、本文が無変更なら未検算として拾う',
     f46.idE ? (u46.E警告 && u46.E警告.indexOf('変わっていません') >= 0) : false,
     f46.idE ? String(u46.E警告) : '要素をまたぐ引用を作れる資料ではありません（span数=' + f46.eSpans + '）');
  ok('バッジ: 未検算カードには必ず「確認済み」がある',
     u46.確認済みボタン数 === u46.期待件数, u46.確認済みボタン数);

  const k46 = JSON.parse(await b.evalJS(`
    __commentLayer.setHideDone(true);
    const badge = document.getElementById('cl-unver');
    const 畳んでも見える = !badge.hidden;
    const 一覧から消えた = !document.getElementById('cl-item-${f46.idA}');
    badge.click();
    return JSON.stringify({畳んでも見える, 一覧から消えた,
      押すと開き直せる: !!document.getElementById('cl-item-${f46.idA}'),
      選ばれた: document.getElementById('cl-item-${f46.idA}').classList.contains('cl-active')});
  `));
  ok('バッジ: 完了を畳んでいても見え、押すと畳みが解けて該当カードへ飛ぶ',
     k46.畳んでも見える && k46.一覧から消えた && k46.押すと開き直せる && k46.選ばれた, JSON.stringify(k46));

  const a46 = JSON.parse(await b.evalJS(`
    const before = __commentLayer.unverified.length;
    document.querySelector('#cl-item-${f46.idA} [data-cl="ack"]').click();
    const c = __commentLayer.comments.filter(x => x.id === '${f46.idA}')[0];
    const ev = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(ev);
    const badge = document.getElementById('cl-unver');
    return JSON.stringify({before, after: __commentLayer.unverified.length,
      完了者が自分になった: c.resolvedBy === __commentLayer.users.filter(u=>u.id===__commentLayer.activeUserId)[0].name,
      まだ完了のまま: c.resolved === true,
      警告が消えた: !document.querySelector('#cl-item-${f46.idA} .cl-unverified'),
      バッジ: badge.hidden ? null : badge.textContent.trim(),
      未保存になった: ev.defaultPrevented});
  `));
  ok('確認済み: 押すと完了者が自分になり、完了は保たれる',
     a46.完了者が自分になった && a46.まだ完了のまま, JSON.stringify(a46));
  ok('確認済み: 警告が消えてバッジが1減り、未保存フラグが立つ',
     a46.警告が消えた && a46.after === a46.before - 1 && a46.未保存になった, JSON.stringify(a46));

  const m46 = JSON.parse(await b.evalJS(`
    const meta0 = JSON.parse(JSON.stringify(__commentLayer.meta));
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
    __commentLayer.exportHTML();
    const m1 = JSON.parse(JSON.stringify(__commentLayer.meta));
    const badgeAtSave = __commentLayer.unverified.length;
    // 残りも確認済みにしてから保存 → 焼かれる数が減っていること（キャッシュを使っていない証拠）
    // ★1回押すと再描画でカードが作り直される。静的な NodeList を回すと2件目以降は
    //   DOMから外れたボタンを押すことになり、委譲リスナに届かない
    for (let i = 0; i < 20; i++) {
      const btn = document.querySelector('[data-cl="ack"]');
      if (!btn) break;
      btn.click();
    }
    __commentLayer.exportHTML();
    const m2 = JSON.parse(JSON.stringify(__commentLayer.meta));
    HTMLAnchorElement.prototype.click = k;
    return JSON.stringify({
      revIdが変わる: m1.revId !== meta0.revId,
      親が直前を指す: m1.parentRevId === meta0.revId,
      連続保存が直列: m2.parentRevId === m1.revId,
      genが増える: m2.gen === m1.gen + 1 && m1.gen === meta0.gen + 1,
      docIdは不変: m1.docId === meta0.docId && m2.docId === meta0.docId,
      保存時のunverifiedがバッジと一致: m1.unverified === badgeAtSave,
      確認後の保存で減る: m2.unverified === 0,
      unverifiedAtがある: !!m2.unverifiedAt
    });
  `));
  ok('系譜: 保存のたびに revId が変わり、parentRevId が直前を指す',
     m46.revIdが変わる && m46.親が直前を指す, JSON.stringify(m46));
  ok('系譜: 同じタブで2回保存しても直列になる（分岐に見えない）', m46.連続保存が直列, JSON.stringify(m46));
  ok('系譜: gen が増え、docId は変わらない', m46.genが増える && m46.docIdは不変, JSON.stringify(m46));
  ok('系譜: 保存時の unverified が、そのときのバッジと一致する',
     m46.保存時のunverifiedがバッジと一致, JSON.stringify(m46));
  ok('系譜: 確認済みにしてから保存すると、減ったあとの数が焼かれる（キャッシュしていない）',
     m46.確認後の保存で減る && m46.unverifiedAtがある, JSON.stringify(m46));

  const g46 = JSON.parse(await b.evalJS(`
    const before = __commentLayer.meta.gen;
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
    for (let i = 0; i < 205; i++) __commentLayer.exportHTML();
    HTMLAnchorElement.prototype.click = k;
    const m = __commentLayer.meta;
    return JSON.stringify({lineage: m.lineage.length, genの増分: m.gen - before,
      先頭が捨てられた: m.lineage[0].op !== 'inject'});
  `));
  ok('系譜: lineage は 200 件で打ち切られ、それでも gen は正しい',
     g46.lineage === 200 && g46.genの増分 === 205 && g46.先頭が捨てられた, JSON.stringify(g46));

  // 版の系譜のUI（#cl-rev 一式）は v2.15 で撤去した。lineage は comment-meta に
  // 持ち続け、分岐の検知は --merge（guard_different_doc() / report_lineage()）が
  // 担う——UIはその表示に過ぎず、消しても検知機能そのものは失われない。
  // ★直前の g46 が lineage を200件の上限まで埋めている。生の配列長では伸びを測れない
  //   （上限に張り付いたまま先頭が捨てられるだけ）ので、gen と末尾エントリで見る
  const v46 = JSON.parse(await b.evalJS(`
    const genBefore = __commentLayer.meta.gen;
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
    __commentLayer.exportHTML();
    HTMLAnchorElement.prototype.click = k;
    const m = __commentLayer.meta, lin = m.lineage;
    return JSON.stringify({
      UIが無い: document.getElementById('cl-rev') === null,
      genが進んだ: m.gen === genBefore + 1,
      末尾がいまの版: lin[lin.length - 1].revId === m.revId
    });
  `));
  ok('版の系譜はUIに出ないが、保存すると comment-meta に積まれ続ける（分岐の検知は --merge に残る）',
     v46.UIが無い && v46.genが進んだ && v46.末尾がいまの版, JSON.stringify(v46));

  const t46 = JSON.parse(await b.evalJS(`
    const k = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
    __commentLayer.exportHTML();
    HTMLAnchorElement.prototype.click = k;
    const toast = document.getElementById('cl-toast').textContent;
    return JSON.stringify({送り返しの念押し: toast.indexOf('あなたのパソコンの中だけ') >= 0,
      名前の話が混ざっていない: toast.indexOf('名前') < 0});
  `));
  ok('保存トーストは従来どおり（送り返しの念押しを名前の話で薄めない）',
     t46.送り返しの念押し && t46.名前の話が混ざっていない, JSON.stringify(t46));

  const kb46 = JSON.parse(await b.evalJS(`
    const cards = [...document.querySelectorAll('.cl-item:not(.cl-draft)')];
    return JSON.stringify({
      全カードがtabindex0: cards.every(e => e.getAttribute('tabindex') === '0'),
      確認済みはボタン: [...document.querySelectorAll('[data-cl="ack"]')].every(e => e.tagName === 'BUTTON'),
      本文へ飛ぶ主導線より後ろ: [...document.querySelectorAll('.cl-item')].every(card => {
        const ack = card.querySelector('[data-cl="ack"]');
        if (!ack) return true;
        const body = card.querySelector('.cl-body');
        return !!(body && (body.compareDocumentPosition(ack) & Node.DOCUMENT_POSITION_FOLLOWING));
      })
    });
  `));
  ok('キーボード: 確認済みは button で、カード内では本文より後ろに置かれている',
     kb46.全カードがtabindex0 && kb46.確認済みはボタン && kb46.本文へ飛ぶ主導線より後ろ, JSON.stringify(kb46));

  const errs46 = b.events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('v2.14 のテスト中もJSエラーが出ない', errs46.length === 0,
     errs46.map(e => e.params.exceptionDetails.text).join(' / '));

} catch (e) {
  fail++; console.log('❌ 実行エラー: ' + e.message);
} finally {
  for (const f of tmpGens) { try { fsm.unlinkSync(f); } catch {} }
  b.close();
}
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);

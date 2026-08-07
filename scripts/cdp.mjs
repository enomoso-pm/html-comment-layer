// 依存ゼロの CDP ドライバ (Node 22+ のネイティブ WebSocket を利用)
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CANDIDATES[process.platform] || []) if (existsSync(p)) return p;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const found = execFileSync(lookup, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split(/\r?\n/)[0];
      if (found) return found;
    } catch { /* 次の候補へ */ }
  }
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH に実行ファイルのパスを指定してください。');
}

export async function launch(port = 9333) {
  const CHROME = resolveChrome();
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900', '--allow-file-access-from-files', '--hide-scrollbars=false',
    'about:blank',
  ], { stdio: 'ignore' });

  // 中断（Ctrl-C・タイムアウト）で Chrome が孤児になるとポートを掴んだまま残り、
  // 次回の起動が古いブラウザに繋がって固まる。必ず道連れにする
  const reap = () => { try { proc.kill('SIGKILL'); } catch {} };
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { reap(); process.exit(130); });
  }

  let target = null;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch {}
  }
  if (!target) { proc.kill(); throw new Error('Chrome 起動失敗'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  // confirm/alert はページのJS実行を止めるので、開いた瞬間に自動応答する。
  // 応答内容はテスト側から dialog.action で変えられる（既定: OK）。開いた記録は dialog.log に残る。
  const dialog = { action: { accept: true }, log: [] };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      dialog.log.push({ type: msg.params.type, message: msg.params.message });
      events.push(msg);
      send('Page.handleJavaScriptDialog', {
        accept: !!(dialog.action && dialog.action.accept),
        promptText: (dialog.action && dialog.action.promptText) || '',
      }).catch(() => {});
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const api = {
    send, events, dialog,
    // 外部リソースを参照している資料（実サイトの保存ページなど）は load が永遠に来ないことが
    // ある。DOMContentLoaded でレイヤーは起動するので、そこまで来たら待ち切らずに進む。
    async goto(url, { timeoutMs = 20000, settleMs = 250 } = {}) {
      const loaded = new Promise(res => {
        const started = Date.now();
        const t = setInterval(() => {
          const done = events.some(e => e.method === 'Page.loadEventFired');
          const dom = events.some(e => e.method === 'Page.domContentEventFired');
          if (done || (dom && Date.now() - started > 3000) || Date.now() - started > timeoutMs) {
            clearInterval(t);
            if (!done) console.log(`  （load完了を待たずに続行: ${dom ? 'DOMContentLoaded到達' : 'タイムアウト'}）`);
            res();
          }
        }, 50);
      });
      events.length = 0;
      await send('Page.navigate', { url });
      await loaded;
      await api.wait(settleMs);
    },
    // ページが遷移すると評価コンテキストごと消えて応答が永久に返らない。
    // 黙って固まるより、時間で打ち切って何が起きたか分かるようにする
    async evalJS(expr, timeoutMs = 30000) {
      const r = await Promise.race([
        send('Runtime.evaluate', {
          expression: `(() => { ${expr} })()`,
          returnByValue: true, awaitPromise: true,
        }),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`evalJS が ${timeoutMs}ms 応答なし（ページ遷移や未解決のPromiseの可能性）`)), timeoutMs)),
      ]);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
      return r.result.value;
    },
    wait: (ms) => new Promise(r => setTimeout(r, ms)),
    async key(code, key, mods = 0, text) {
      const base = { windowsVirtualKeyCode: code, key, modifiers: mods, code: key };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async wheel(x, y, dy) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', clickCount: 0 });
    },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    close() { try { ws.close(); } catch {} proc.kill(); },
  };
  return api;
}

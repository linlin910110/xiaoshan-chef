/* 双模式 UI 检查（不发 API 请求）：切换模式后空状态、侧栏、设置项是否跟着变。
 * 运行：node test/ui-mode.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP = 'http://127.0.0.1:8137/';
const PORT = 9334;
const PROFILE = join(tmpdir(), 'xiaoshan-mode-' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--window-size=1360,1200',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  APP
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    const list = await res.json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8137'));
    if (target) break;
  } catch (e) { /* not up yet */ }
}
if (!target) {
  console.error('CDP target not found');
  edge.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};

function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); }
    }, 30000);
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const checks = [];
function check(name, cond, extra) {
  checks.push({ name, cond: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra)));
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(800);

  await evaluate(`localStorage.setItem('xiaoshan.key', 'sk-test-dummy');
    localStorage.setItem('xiaoshan.verified', '0');
    localStorage.setItem('xiaoshan.mode', 'health'); 'ok'`);
  await send('Page.reload');
  await sleep(1200);

  /* 健康模式：空状态与侧栏 */
  check('health empty visible', await evaluate("(() => { const n = document.getElementById('emptyHealth'); return !n.hidden && n.offsetParent !== null; })()"));
  check('home empty hidden', await evaluate("document.getElementById('emptyHome').hidden === true"));
  check('health sidebar visible', await evaluate("document.getElementById('sideHealth').offsetParent !== null && document.getElementById('sideHome').hidden === true"));
  check('health chips visible', await evaluate("document.getElementById('chipsHealth').offsetParent !== null && document.getElementById('chipsHome').hidden === true"));
  check('health placeholder', (await evaluate("document.getElementById('searchInput').placeholder")).includes('想吃什么'));

  /* 切到家常模式 */
  await evaluate(`document.querySelector('.mode-btn[data-mode="home"]').click(); 'ok'`);
  await sleep(400);
  check('body mode attr', (await evaluate('document.body.dataset.mode')) === 'home');
  check('home empty visible', await evaluate("(() => { const n = document.getElementById('emptyHome'); return !n.hidden && n.offsetParent !== null; })()"));
  check('health empty hidden', await evaluate("document.getElementById('emptyHealth').hidden === true"));
  check('home sidebar visible', await evaluate("document.getElementById('sideHome').offsetParent !== null && document.getElementById('sideHealth').hidden === true"));
  check('home chips visible', await evaluate("document.getElementById('chipsHome').offsetParent !== null && document.getElementById('chipsHealth').hidden === true"));
  check('home placeholder', (await evaluate("document.getElementById('searchInput').placeholder")).includes('想学什么菜'));
  check('chat greeting is laozao', (await evaluate("document.getElementById('chatLog').innerText")).includes('老灶'));
  check('mode persisted', (await evaluate("localStorage.getItem('xiaoshan.mode')")) === 'home');
  check('mode button active', await evaluate("document.querySelector('.mode-btn[data-mode=\"home\"]').classList.contains('is-active')"));

  /* 设置弹窗在家庭模式下隐藏健康专用项 */
  await evaluate("document.getElementById('btnOpenSettings').click(); 'ok'");
  await sleep(300);
  check('health-only fields hidden in home', await evaluate("document.getElementById('healthOnlyFields').hidden === true"));
  check('key field still visible', await evaluate("document.getElementById('keyInput').offsetParent !== null"));

  /* 切回健康模式 */
  await evaluate(`document.querySelector('.mode-btn[data-mode="health"]').click(); 'ok'`);
  await sleep(300);
  check('back to health empty', await evaluate("(() => { const n = document.getElementById('emptyHealth'); return !n.hidden && n.offsetParent !== null; })()"));
  check('health-only fields back', await evaluate("document.getElementById('healthOnlyFields').hidden === false"));
  check('chat greeting is xiaoshan', (await evaluate("document.getElementById('chatLog').innerText")).includes('小膳'));

  const failed = checks.filter((c) => !c.cond).length;
  console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch (e) { /* ignore */ }
  edge.kill();
  await sleep(400);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

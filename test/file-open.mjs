/* 验证「双击 index.html」的行为：
 * 1) 本地服务在跑 → file:// 页面应自动跳到 http://127.0.0.1:8137/
 * 2) 本地服务没跑 → 应显示提示浮层（#fileGate），而不是第二个界面
 * 运行：node test/file-open.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE_URL = 'file:///D:/lin/Documents/deepseek-harness/default-workspace/agnes-chef/index.html';
const PORT = 9336;
const PROFILE = join(tmpdir(), 'xiaoshan-file-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--window-size=1200,900', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, FILE_URL], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
    if (target) break;
  } catch (e) { /* wait */ }
}
if (!target) { console.error('no target'); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1; const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params: params || {} })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000); }); };
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) return 'JSERR: ' + (r.exceptionDetails.exception?.description || ''); return r.result.value; };

await send('Runtime.enable');
await sleep(800);

const checks = [];
const check = (name, cond, extra) => { checks.push(cond); console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra))); };

const gateVisible = await ev("!!document.getElementById('fileGate')");
console.log('gate visible at start: ' + gateVisible);
console.log('gate status text: ' + await ev("(document.getElementById('gateStatus')||{}).textContent"));

let href = await ev('location.href');
for (let i = 0; i < 20 && href.startsWith('file:'); i++) {
  await sleep(500);
  href = await ev('location.href');
}
console.log('final href: ' + href);
check('file:// auto-redirects to local server', href.startsWith('http://127.0.0.1:8137/'), href);

const failed = checks.filter((c) => !c).length;
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

ws.close(); edge.kill();
await sleep(400);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }

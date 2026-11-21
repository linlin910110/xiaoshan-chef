/* 验证「本地服务没起来」时的兜底：file:// 页显示提示浮层；服务一起来就自动跳过去。
 * 前提：8137 端口此刻是空的（脚本自己起停服务）。
 * 运行：node test/file-gate.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE_URL = 'file:///D:/lin/Documents/deepseek-harness/default-workspace/agnes-chef/index.html';
const DIR = 'D:\\lin\\Documents\\deepseek-harness\\default-workspace\\agnes-chef';
const PORT = 9337;
const PROFILE = join(tmpdir(), 'xiaoshan-gate-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const r = await fetch('http://127.0.0.1:8137/__ping.png');
    return r.ok;
  } catch (e) { return false; }
}

if (await alive()) {
  console.log('SKIP: 8137 上已有服务在跑，先停掉再测');
  process.exit(2);
}

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
const send = (method, params) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params: params || {} })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')); } }, 20000); }); };
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) return 'JSERR'; return r.result.value; };

await send('Runtime.enable');
await sleep(4000);

const checks = [];
const check = (name, cond, extra) => { checks.push(cond); console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra))); };

check('server is down before test', !(await alive()));
check('gate overlay shown', await ev("!!document.getElementById('fileGate')"));
const statusText = await ev("(document.getElementById('gateStatus')||{}).textContent || ''");
check('gate explains not detected', statusText.includes('还没检测到'), statusText);
check('still on file:// (no redirect)', (await ev('location.protocol')) === 'file:');

const server = spawn(process.execPath, ['serve.mjs', '8137', '--no-open'], { cwd: DIR, stdio: 'ignore', detached: false });
let href = await ev('location.href');
for (let i = 0; i < 24 && href.startsWith('file:'); i++) {
  await sleep(500);
  href = await ev('location.href').catch(() => 'navigated');
}
console.log('final href: ' + href);
check('auto-redirects once server is up', String(href).startsWith('http://127.0.0.1:8137/'), href);

const failed = checks.filter((c) => !c).length;
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

server.kill();
ws.close();
edge.kill();
await sleep(600);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }

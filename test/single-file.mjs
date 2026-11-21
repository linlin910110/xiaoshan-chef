/* 验证单文件版（小膳.html）：样式内联后在任何地方打开都该是「有样式」的样子。
 * 运行：node test/single-file.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE_URL = 'file:///D:/lin/Documents/deepseek-harness/default-workspace/agnes-chef/%E5%B0%8F%E8%86%B3.html';
const OUT = 'D:\\lin\\Documents\\deepseek-harness\\default-workspace\\agnes-chef\\shots\\shot-standalone.png';
const PORT = 9339;
const PROFILE = join(tmpdir(), 'xiaoshan-single-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--window-size=1280,900', '--remote-debugging-port=' + PORT,
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error('x')) : p.res(m.result); } };
const send = (method, params) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params: params || {} })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')); } }, 20000); }); };
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) return 'JSERR: ' + (r.exceptionDetails.exception?.description || ''); return r.result.value; };

await send('Page.enable');
await send('Runtime.enable');
await sleep(1200);

const checks = [];
const check = (name, cond, extra) => { checks.push(cond); console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra))); };

check('no external stylesheet request needed', await ev("document.styleSheets.length >= 1"));
check('styles applied (topbar is sticky)', await ev("getComputedStyle(document.querySelector('.topbar')).position === 'sticky'"));
check('body has themed background', await ev("getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'"));
check('no file:// gate overlay', await ev("!document.getElementById('fileGate')"));
check('app booted (core loaded)', await ev("typeof window.ChefCore === 'object'"));
check('mode switch works', await ev("(document.querySelector('.mode-btn[data-mode=\"home\"]').click(), document.body.dataset.mode === 'home')"));
check('home empty state shown', await ev("(() => { const n = document.getElementById('emptyHome'); return !n.hidden && n.offsetParent !== null; })()"));

const r = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(r.data, 'base64'));
console.log('shot: ' + OUT);

const failed = checks.filter((c) => !c).length;
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

ws.close(); edge.kill();
await sleep(400);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }

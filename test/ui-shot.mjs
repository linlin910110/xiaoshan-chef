/* UI 截图验证：用 CDP 驱动 headless Edge，真实走一遍「填 Key → 生成菜单 → 加入菜单」。
 * 运行：node test/ui-shot.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP = 'http://127.0.0.1:8137/';
const PORT = 9333;
const PROFILE = join(tmpdir(), 'xiaoshan-cdp-' + Date.now());
const KEY = process.env.AGNES_KEY || '';
if (!KEY) {
  console.error('请先设置环境变量 AGNES_KEY 再跑真机走查（会真的调用 Agnes 接口）。');
  process.exit(2);
}
const OUT = 'D:\\lin\\Documents\\deepseek-harness\\default-workspace\\agnes-chef\\shots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
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
  } catch (e) { /* 还没起来 */ }
}
if (!target) {
  console.error('CDP target not found');
  edge.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

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
    }, 90000);
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

async function shot(name, full) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full !== false });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('shot: ' + file);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(800);

  /* 注入 Key 与设置 */
  await evaluate(`localStorage.setItem('xiaoshan.key', ${JSON.stringify(KEY)});
    localStorage.setItem('xiaoshan.model', 'agnes-2.5-flash');
    localStorage.setItem('xiaoshan.goal', '均衡维持，每天 1800 大卡左右');
    localStorage.setItem('xiaoshan.avoid', '香菜');
    localStorage.setItem('xiaoshan.verified', '1'); 'ok'`);

  await send('Page.reload');
  await sleep(1500);

  console.log('status text: ' + await evaluate("document.getElementById('connText').textContent"));
  await shot('shot-top.png', false);

  /* 生成菜单 */
  await evaluate("document.getElementById('btnMenu').click(); 'clicked'");
  let cards = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    cards = await evaluate("document.querySelectorAll('#board .card').length");
    if (cards > 0) break;
  }
  console.log('cards rendered: ' + cards);
  if (!cards) {
    console.log('board text: ' + (await evaluate("document.getElementById('board').innerText")).slice(0, 400));
    throw new Error('no cards rendered');
  }
  await shot('shot-menu.png');

  /* 加入两道到今日菜单 */
  await evaluate(`(() => { const b = document.querySelectorAll('#board .card .btn.primary'); b[0] && b[0].click(); b[2] && b[2].click(); return 'added'; })()`);
  await sleep(600);
  console.log('menu items: ' + await evaluate("document.querySelectorAll('#menuList .menu-item').length"));
  await shot('shot-menu-added.png');

  /* 搜索 */
  await evaluate(`(() => {
    const inp = document.getElementById('searchInput');
    inp.value = '番茄和鸡蛋，快手';
    document.getElementById('searchForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'searching';
  })()`);
  let found = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    found = await evaluate("document.querySelectorAll('#board .cards .card').length");
    if (found > 0) break;
  }
  console.log('search cards: ' + found);
  await shot('shot-search.png');

  /* 家常模式：切换 → 按菜系出菜 → 收进菜谱本 */
  await evaluate(`document.querySelector('.mode-btn[data-mode="home"]').click(); 'home'`);
  await sleep(700);
  console.log('mode: ' + await evaluate("document.body.dataset.mode"));
  await shot('shot-home.png', false);

  await evaluate(`document.querySelector('#chipsHome .chip[data-cuisine="川菜"]').click(); 'cuisine'`);
  let homeCards = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    homeCards = await evaluate("document.querySelectorAll('#board .cards .card').length");
    if (homeCards > 0) break;
  }
  console.log('home cards: ' + homeCards);
  console.log('first card text: ' + (await evaluate("document.querySelector('#board .cards .card').innerText")).slice(0, 120));
  await shot('shot-home-cards.png');

  await evaluate(`(() => { const b = document.querySelectorAll('#board .cards .card .btn.primary'); b[0] && b[0].click(); b[1] && b[1].click(); return 'book'; })()`);
  await sleep(600);
  console.log('book items: ' + await evaluate("document.querySelectorAll('#bookList .menu-item').length"));
  await shot('shot-home-book.png');

  /* 切回健康模式，确认上一屏内容还在 */
  await evaluate(`document.querySelector('.mode-btn[data-mode="health"]').click(); 'health'`);
  await sleep(600);
  console.log('back mode: ' + await evaluate("document.body.dataset.mode") + ', health cards: ' + await evaluate("document.querySelectorAll('#board .cards .card').length"));

  /* 设置弹窗 */
  await evaluate("document.getElementById('btnOpenSettings').click(); 'open'");
  await sleep(500);
  await shot('shot-settings.png');

  /* 控制台是否有报错 */
  console.log('DONE');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch (e) { /* ignore */ }
  edge.kill();
  await sleep(500);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

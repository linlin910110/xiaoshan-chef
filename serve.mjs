/**
 * 小膳 · 本地静态服务器（零依赖）
 * 用法：node serve.mjs [端口] [--no-open]
 * 默认 http://127.0.0.1:8137 ，启动后自动打开浏览器（--no-open 或 NO_OPEN=1 则不打开）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8137);
const OPEN = !ARGS.includes('--no-open') && process.env.NO_OPEN !== '1';
const URL_BASE = 'http://127.0.0.1:' + PORT + '/';

/* 1x1 透明 PNG：给「双击 index.html」的那一页做存活探测（图片不受 CORS 限制） */
const PING_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/__ping.png') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(PING_PNG);
      return;
    }

    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = resolve(join(ROOT, pathname));
    if (!target.startsWith(ROOT + sep) && target !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: pathname + '/' }).end();
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + (err && err.message));
    }
  }
});

function openBrowser() {
  if (!OPEN) return;
  try {
    spawn('cmd', ['/c', 'start', '', URL_BASE], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) { /* 打不开就算了 */ }
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('端口 ' + PORT + ' 已经在跑了，直接打开： ' + URL_BASE);
    openBrowser();
    process.exit(0);
  }
  console.error('启动失败：' + (err && err.message));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('小膳已启动： ' + URL_BASE);
  console.log('（Ctrl+C 停止。双击 index.html 会自动跳到这里，不用记地址）');
  openBrowser();
});

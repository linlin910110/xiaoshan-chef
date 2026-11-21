/* 静态一致性检查：app.js 引用的 DOM id 是否都在 index.html 里 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const core = fs.readFileSync(path.join(dir, 'core.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([
  ...[...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
]);

const missing = [...used].filter((id) => !htmlIds.has(id));
const unused = [...htmlIds].filter((id) => !used.has(id));

console.log('html ids: ' + htmlIds.size);
console.log('referenced by app.js: ' + used.size);
console.log('missing in html: ' + (missing.length ? missing.join(', ') : '(none)'));
console.log('declared but unused: ' + (unused.length ? unused.join(', ') : '(none)'));

/* 脚本引用顺序 */
const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
console.log('script order: ' + order.join(' -> '));
if (order[0] !== 'core.js' || order[1] !== 'app.js') {
  console.error('script order wrong');
  process.exit(1);
}

/* app.js 用到的 ChefCore 方法是否都存在 */
const coreExports = [...core.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
const usedCore = [...app.matchAll(/C\.(\w+)/g)].map((m) => m[1]);
const missingCore = [...new Set(usedCore)].filter((k) => !coreExports.includes(k));
console.log('core keys: ' + coreExports.length + ', used by app.js: ' + new Set(usedCore).size);
console.log('missing core exports: ' + (missingCore.length ? missingCore.join(', ') : '(none)'));

if (missing.length || missingCore.length) process.exit(1);
console.log('STATIC CHECK OK');

/* 把小膳打包成「单个 HTML 文件」：样式与脚本全部内联。
 * 用途：某些预览器 / 聊天窗口只允许加载 HTML 本身，外链的 styles.css、core.js 一律被拦，
 *      结果就是「打开了但没样式」。单文件版在任何地方打开都长一样。
 * 运行：node build.mjs  →  生成 小膳.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const read = (name) => readFileSync(resolve(DIR, name), 'utf8');

let html = read('index.html');
const css = read('styles.css');
const core = read('core.js');
const app = read('app.js');

const before = html;
/* 单文件版不需要「探测本地服务再跳转」那段：它就是给人直接双击/预览用的 */
const gateStart = html.indexOf('<!-- file-gate:start');
const gateEnd = html.indexOf('<!-- file-gate:end -->');
if (gateStart > -1 && gateEnd > gateStart) {
  html = html.slice(0, gateStart) + html.slice(gateEnd + '<!-- file-gate:end -->'.length);
}
html = html.replace('<link rel="stylesheet" href="styles.css" />', '<style>\n' + css + '\n</style>');
html = html.replace('<script src="core.js"></script>', '<script>\n' + core + '\n</script>');
html = html.replace('<script src="app.js"></script>', '<script>\n' + app + '\n</script>');

if (html === before) throw new Error('没有替换到任何外链，检查 index.html 结构');
for (const leftover of ['styles.css"', 'core.js"', 'app.js"']) {
  if (html.includes(leftover)) throw new Error('仍有外链未内联：' + leftover);
}
if (html.includes('</script>\n</style>')) throw new Error('内联顺序异常');

const gone = html.match(/<script src=|<link rel="stylesheet"/g);
if (gone) throw new Error('仍有外部引用：' + gone.join(','));

const out = resolve(DIR, '小膳.html');
writeFileSync(out, html, 'utf8');
console.log('已生成：' + out);
console.log('大小：' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) + ' KB（原 index.html ' + (Buffer.byteLength(before, 'utf8') / 1024).toFixed(1) + ' KB）');

/* 端到端验证：用应用真实的 core.js 组装请求，打到 Agnes，验证解析链路。
 * 运行： set AGNES_KEY=sk-...  &&  node test/e2e.js
 */
'use strict';
const C = require('../core.js');

const KEY = process.env.AGNES_KEY || '';
if (!KEY) {
  console.error('请先设置环境变量 AGNES_KEY，例如：\n  PowerShell:  $env:AGNES_KEY = "sk-..."\n  bash:        AGNES_KEY=sk-... node test/e2e.js');
  process.exit(2);
}
const MODEL = process.env.AGNES_MODEL || C.DEFAULT_MODEL;

async function call(messages, maxTokens) {
  const body = C.buildBody({ model: MODEL, messages, jsonMode: true, maxTokens });
  const t0 = Date.now();
  const res = await fetch(C.chatEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.error('HTTP ' + res.status + ' ' + text.slice(0, 300));
    process.exit(1);
  }
  const data = JSON.parse(text);
  return { content: data.choices[0].message.content, ms, tokens: data.usage };
}

(async () => {
  /* 1. 菜单 */
  const menu = await call([
    { role: 'system', content: C.PERSONA },
    { role: 'user', content: C.menuUserPrompt({ date: C.dateLabel(), goal: '均衡维持，每天 1800 大卡左右', avoid: '香菜' }) }
  ], 2400);
  const parsedMenu = C.normalizeMenu(C.extractJson(menu.content));
  if (!parsedMenu) {
    console.error('MENU PARSE FAIL:\n' + menu.content.slice(0, 600));
    process.exit(1);
  }
  console.log('MENU  ok  ' + menu.ms + 'ms  tokens=' + (menu.tokens && menu.tokens.completion_tokens) +
    '  "' + parsedMenu.title + '"  total=' + parsedMenu.totalKcal + 'kcal  meals=' + parsedMenu.meals.length);
  parsedMenu.meals.forEach((m) => {
    console.log('      - ' + m.slot + ' | ' + m.name + ' | ' + m.kcal + 'kcal/' + m.protein + 'g | 食材' + m.ingredients.length + ' 步骤' + m.steps.length);
  });

  /* 2. 搜索 */
  const found = await call([
    { role: 'system', content: C.PERSONA },
    { role: 'user', content: C.searchUserPrompt({ query: '番茄和鸡蛋', filters: ['快手'] }) }
  ], 2400);
  const recipes = C.normalizeRecipes(C.extractJson(found.content));
  if (!recipes.length) {
    console.error('SEARCH PARSE FAIL:\n' + found.content.slice(0, 600));
    process.exit(1);
  }
  console.log('SEARCH ok ' + found.ms + 'ms  n=' + recipes.length + '  ' + recipes.map((r) => r.name + '(' + r.kcal + ')').join(' / '));

  /* 3. 流式（取前 3 段增量，然后中断） */
  const sbody = C.buildBody({ model: MODEL, messages: C.buildMessages([], '用一句话推荐一道早餐'), stream: true });
  const ctrl = new AbortController();
  const res = await fetch(C.chatEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(sbody),
    signal: ctrl.signal
  });
  if (!res.ok) {
    console.error('STREAM HTTP ' + res.status);
    process.exit(1);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pieces = 0;
  let out = '';
  while (pieces < 4) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (d) { out += d; pieces++; }
      } catch (e) { /* 半个 chunk，忽略 */ }
    }
  }
  ctrl.abort();
  console.log('STREAM ok  pieces=' + pieces + '  text="' + out + '"');

  console.log('\nALL E2E PASSED');
})().catch((e) => {
  console.error('ERROR', e && e.message);
  process.exit(1);
});

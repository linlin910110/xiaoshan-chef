/* 小膳 · 核心逻辑单元测试（零依赖）： node test/core.test.js */
'use strict';

const C = require('../core.js');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

function eq(name, actual, expected) {
  ok(name + ' (got ' + JSON.stringify(actual) + ')', JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ---- extractJson ---- */

eq('extractJson plain object', C.extractJson('{"a":1}'), { a: 1 });
eq('extractJson fenced', C.extractJson('```json\n{"a":2}\n```'), { a: 2 });
eq('extractJson with prose prefix', C.extractJson('好的，菜单如下：\n{"a":3}\n希望你喜欢'), { a: 3 });
eq('extractJson array', C.extractJson('```\n[{"a":4}]\n```'), [{ a: 4 }]);
eq('extractJson nested + brace in string', C.extractJson('prefix {"a":{"b":"}"},"c":5} suffix'), { a: { b: '}' }, c: 5 });
eq('extractJson invalid', C.extractJson('完全不是 JSON'), null);
eq('extractJson empty', C.extractJson(''), null);
eq('extractJson non-string', C.extractJson(null), null);

/* ---- 数值与列表 ---- */

eq('toNum from text', C.toNum('480 大卡', 0), 480);
eq('toNum decimal', C.toNum('12.5g', 0), 12.5);
eq('toNum thousands', C.toNum('1,234', 0), 1234);
eq('toNum fallback', C.toNum(undefined, 7), 7);
eq('toList newline separated', C.toList('1. 洗菜\n2. 切菜'), ['洗菜', '切菜']);
eq('toList object items', C.toList([{ text: '盐 2g' }, '油 5ml']), ['盐 2g', '油 5ml']);
eq('toList empty', C.toList(null), []);

/* ---- 菜谱归一化 ---- */

const recipes = C.normalizeRecipes({
  recipes: [
    { name: '番茄炒蛋', kcal: '320 大卡', protein: '18g', time: '10分钟', tags: ['快手'], ingredients: ['番茄 2 个'], steps: ['切块', '下锅'], why: '优质蛋白' },
    { title: '蒜蓉西兰花', calories: 120, protein_g: 6, ingredients: '西兰花 300g\n蒜 3 瓣', method: ['焯水', '快炒'] },
    { name: '' },
    null
  ]
});
eq('normalizeRecipes count', recipes.length, 2);
eq('normalizeRecipes name', recipes[0].name, '番茄炒蛋');
eq('normalizeRecipes kcal parsed', recipes[0].kcal, 320);
eq('normalizeRecipes protein parsed', recipes[0].protein, 18);
eq('normalizeRecipes title alias', recipes[1].name, '蒜蓉西兰花');
eq('normalizeRecipes string ingredients', recipes[1].ingredients, ['西兰花 300g', '蒜 3 瓣']);
eq('normalizeRecipes method alias', recipes[1].steps, ['焯水', '快炒']);

const menu = C.normalizeMenu({
  title: '周一家常菜单',
  summary: '荤素搭配',
  meals: [
    { slot: '早餐', name: '燕麦牛奶', kcal: 350, protein: 15 },
    { slot: '午餐', name: '糙米饭 + 清蒸鲈鱼', kcal: 600, protein: 40 },
    { slot: '加餐', name: '苹果', kcal: 80, protein: 0 },
    { slot: '晚餐', name: '番茄豆腐汤 + 蒜蓉西兰花', kcal: 420, protein: 25 }
  ],
  tips: ['多喝水']
});
eq('normalizeMenu meals', menu.meals.length, 4);
eq('normalizeMenu totalKcal computed', menu.totalKcal, 1450);
eq('normalizeMenu tips', menu.tips, ['多喝水']);
eq('normalizeMenu slot kept', menu.meals[2].slot, '加餐');
eq('normalizeMenu rejects empty', C.normalizeMenu({ title: 'x' }), null);
eq('normalizeMenu rejects null', C.normalizeMenu(null), null);

/* ---- 错误映射 ---- */

ok('formatError 401', C.formatError(401, {}).includes('401'));
ok('formatError 429', C.formatError(429, {}).includes('429'));
ok('formatError network', C.formatError(0, {}).includes('网络'));
ok('formatError 400 message', C.formatError(400, { error: { message: 'invalid model' } }).includes('invalid model'));
ok('formatError 500', C.formatError(503, {}).includes('503'));

/* ---- 请求体 ---- */

const body = C.buildBody({ model: 'agnes-2.5-flash', messages: [{ role: 'user', content: 'hi' }], jsonMode: true });
eq('buildBody model', body.model, 'agnes-2.5-flash');
eq('buildBody response_format', body.response_format, { type: 'json_object' });
ok('buildBody no stream by default', body.stream === undefined);
eq('buildBody stream', C.buildBody({ stream: true }).stream, true);
eq('buildBody default model', C.buildBody({}).model, C.DEFAULT_MODEL);

/* ---- 消息构造 ---- */

const msgs = C.buildMessages(
  [
    { role: 'user', content: '午饭吃鱼' },
    { role: 'assistant', content: '好的' },
    { role: 'system', content: '注入' },
    { role: 'user', content: '   ' }
  ],
  '换个简单的'
);
eq('buildMessages length', msgs.length, 4);
eq('buildMessages first is system', msgs[0].role, 'system');
ok('buildMessages drops stray system', msgs.filter((m) => m.role === 'system').length === 1);
eq('buildMessages last is user', msgs[msgs.length - 1].content, '换个简单的');

/* ---- 模型列表 ---- */

const models = C.listChatModels({
  data: [
    { id: 'agnes-2.5-flash' },
    { id: 'agnes-3.0-flash' },
    { id: 'agnes-image-2.5-flash' },
    { id: 'agnes-video-2.5' },
    { id: 'gpt-4o' }
  ]
});
eq('listChatModels filters', models.map((m) => m.id), ['agnes-2.5-flash', 'agnes-3.0-flash']);
eq('listChatModels empty payload', C.listChatModels(null), []);

/* ---- 汇总与提示词 ---- */

eq('summarize', C.summarize([{ kcal: 350, protein: 15 }, { kcal: 600, protein: 40 }]), { kcal: 950, protein: 55, count: 2 });
eq('summarize empty', C.summarize([]), { kcal: 0, protein: 0, count: 0 });

const mp = C.menuUserPrompt({ date: '11月21日 周五', goal: '减脂', avoid: '香菜' });
ok('menuPrompt has goal', mp.includes('减脂'));
ok('menuPrompt has avoid', mp.includes('香菜'));
ok('menuPrompt demands JSON only', mp.includes('只输出 JSON'));
ok('menuPrompt lists slots', mp.includes('早餐'));
ok('menuPrompt keeps human date', mp.includes('11月21日 周五'));

const sp = C.searchUserPrompt({ query: '番茄鸡蛋', filters: ['快手'] });
ok('searchPrompt has query', sp.includes('番茄鸡蛋'));
ok('searchPrompt has filters', sp.includes('快手'));
ok('searchPrompt demands recipes', sp.includes('"recipes"'));

ok('dateLabel formats', /^\d{1,2}月\d{1,2}日 周[一二三四五六日]$/.test(C.dateLabel(new Date('2026-11-21T10:00:00+08:00'))), C.dateLabel(new Date('2026-11-21T08:00:00Z')));
ok('chat system prompt mentions JSON block', C.chatSystemPrompt().includes('recipes'));
ok('endpoints', C.chatEndpoint().endsWith('/v1/chat/completions') && C.modelsEndpoint().endsWith('/v1/models'));

/* ---- 双模式 ---- */

ok('default persona is health', C.personaFor().includes('小膳'));
ok('health persona explicit', C.personaFor('health').includes('营养师'));
ok('home persona is laozao', C.personaFor('home').includes('老灶'));
ok('home persona mentions cuisines', C.personaFor('home').includes('川') && C.personaFor('home').includes('粤'));
eq('persona names', C.PERSONA_NAMES, { health: '小膳', home: '老灶' });

const homeSystem = C.chatSystemPrompt('home');
ok('home system prompt has 老灶', homeSystem.includes('老灶'));
ok('home system prompt asks cuisine', homeSystem.includes('cuisine'));
ok('home system prompt asks tip', homeSystem.includes('tip'));
ok('home system prompt warns JSON only', homeSystem.includes('JSON'));
ok('health system prompt unaffected', C.chatSystemPrompt('health').includes('小膳'));

const homeMsgs = C.buildMessages([], '鱼香肉丝怎么做', 'home');
ok('buildMessages home system is laozao', homeMsgs[0].content.includes('老灶'));
ok('buildMessages health system is xiaoshan', C.buildMessages([], 'hi', 'health')[0].content.includes('小膳'));

const hp = C.homeSearchPrompt({ query: '回锅肉', cuisine: '川菜', difficulty: '简单' });
ok('homeSearchPrompt has query', hp.includes('回锅肉'));
ok('homeSearchPrompt has cuisine', hp.includes('川菜'));
ok('homeSearchPrompt has difficulty', hp.includes('简单'));
ok('homeSearchPrompt demands recipes', hp.includes('"recipes"'));
ok('homeSearchPrompt asks key step', hp.includes('关键一步'));
ok('homeSearchPrompt asks heat control', hp.includes('火候'));

const homeDish = C.normalizeRecipe({
  name: '回锅肉',
  cuisine: '川菜',
  flavor: '咸鲜微辣',
  difficulty: '中等',
  time: '25分钟',
  ingredients: ['五花肉 300g'],
  steps: ['煮肉', '炒豆瓣'],
  tip: '豆瓣酱要小火炒出红油'
});
eq('normalizeRecipe cuisine', homeDish.cuisine, '川菜');
eq('normalizeRecipe flavor', homeDish.flavor, '咸鲜微辣');
eq('normalizeRecipe difficulty', homeDish.difficulty, '中等');
eq('normalizeRecipe tip', homeDish.tip, '豆瓣酱要小火炒出红油');
eq('normalizeRecipe alt keys', C.normalizeRecipe({ name: 'x', region: '粤菜', taste: '清鲜', level: '简单', keyStep: '大火快炒' }).cuisine, '粤菜');
eq('health recipe has empty cuisine', C.normalizeRecipe({ name: '番茄炒蛋', kcal: 320 }).cuisine, '');

/* ---- 结果 ---- */

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

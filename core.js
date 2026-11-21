/*!
 * 小膳 · 核心逻辑
 * 纯函数，无 DOM 依赖：浏览器里挂到 window.ChefCore，Node 里可 require 做单元测试。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChefCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 常量 ---------- */

  var BASE_URL = 'https://api.agnes-ai.cn/v1';
  var DEFAULT_MODEL = 'agnes-2.5-flash';
  var CHAT_TIMEOUT_MS = 120000;
  var TEST_TIMEOUT_MS = 30000;
  var NON_CHAT_MODEL = /(image|video|embedding|rerank|tts|whisper|moderation)/i;

  var PERSONA_HEALTH = [
    '你是「小膳」，一位注册营养师，也是一名擅长家常菜的中餐厨师。',
    '你的任务：帮用户搭配每天吃得下、做得出来、营养均衡的菜谱。',
    '',
    '规则：',
    '1. 落地：只用中国菜市场或超市常见的食材，单道菜 30 分钟内能做完，写清大致份量。',
    '2. 均衡：每天总热量 1600–2000 kcal（用户有目标时以用户为准），三餐加一次加餐；每餐都要有优质蛋白，每天蔬菜不少于 300 g，主食粗细搭配。',
    '3. 少油少盐少糖：优先蒸、煮、炖、烤、快炒、凉拌，避免油炸和深加工食品。',
    '4. 说人话：先给结论，再给一句理由；不要用“综上所述”“总而言之”这类套话。',
    '5. 边界：不承诺疗效、不做疾病诊断；遇到孕期、哺乳期、儿童、糖尿病、肾病等特殊情况，提醒对方咨询医生或注册营养师。',
    '6. 始终使用简体中文，语气像一个靠谱又随和的厨师朋友。'
  ].join('\n');

  var PERSONA_HOME = [
    '你是「老灶」，一位走南闯北的家常菜师傅：川、鲁、粤、苏、浙、湘、闽、徽八大菜系，加上东北、西北、云贵、京津和港式家常，都亲手做过。',
    '你的任务：教用户做出地道、好吃、家里灶台能复现的家常菜。',
    '',
    '规则：',
    '1. 地道优先：按菜系本来的做法来。该用郫县豆瓣就用，该吊汤就吊汤，该油炸就油炸；不要为了“健康”擅自改配方，也不要写成餐厅摆盘菜。',
    '2. 家用可复现：普通炒锅、家用燃气灶、超市能买到的调料；除炖菜外 40 分钟内完成，写清火候（大火/中火/小火）、油温、下锅顺序和调味比例。',
    '3. 每道菜给一条“关键一步”：新手最容易翻车的那一下，比如“豆瓣酱一定要小火炒出红油再下料”。',
    '4. 讲人话：先给做法，再点一句原理；不堆砌“鲜香扑鼻”“唇齿留香”这类空话。',
    '5. 语言：简体中文。'
  ].join('\n');

  var PERSONA = PERSONA_HEALTH;

  function personaFor(mode) {
    return mode === 'home' ? PERSONA_HOME : PERSONA_HEALTH;
  }

  var JSON_ONLY = '只输出 JSON，不要 markdown 代码块，不要任何解释或前后缀。';

  var RECIPE_FIELDS = '"name"（菜名）、"kcal"（热量，数字）、"protein"（蛋白质克数，数字）、"time"（预计耗时，如"15分钟"）、"tags"（标签数组，如"高蛋白""快手""低卡"）、"ingredients"（食材数组，每项带份量）、"steps"（做法步骤数组）、"why"（一句话营养理由）';

  var RECIPE_FIELDS_HOME = '"name"（菜名）、"cuisine"（菜系，如"川菜""粤菜""东北菜"）、"flavor"（口味，如"咸鲜微辣"）、"difficulty"（难度：简单/中等/有点难）、"time"（预计耗时，如"25分钟"）、"ingredients"（食材数组，每项带份量）、"steps"（做法步骤数组，写清火候与顺序）、"tip"（关键一步）';

  /* ---------- 提示词 ---------- */

  function dateLabel(d) {
    var date = d instanceof Date ? d : new Date();
    var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
    return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + week;
  }

  function menuUserPrompt(opts) {
    opts = opts || {};
    var lines = [];
    lines.push('帮我搭配今天的健康菜单。');
    lines.push('- 日期：' + (opts.date || dateLabel()));
    lines.push('- 目标：' + (opts.goal || '日常均衡、吃饱不胖'));
    if (opts.avoid) lines.push('- 忌口/不吃：' + opts.avoid);
    lines.push('');
    lines.push(JSON_ONLY);
    lines.push('JSON 结构：');
    lines.push('{');
    lines.push('  "title": "菜单标题",');
    lines.push('  "summary": "一句话总结今天的搭配思路",');
    lines.push('  "totalKcal": 1800,');
    lines.push('  "meals": [');
    lines.push('    { "slot": "早餐", "name": "", "kcal": 0, "protein": 0, "time": "", "ingredients": [], "steps": [], "why": "" }');
    lines.push('  ],');
    lines.push('  "tips": ["一条可执行的小建议"]');
    lines.push('}');
    lines.push('要求：meals 必须有 4 条，slot 依次为“早餐”“午餐”“加餐”“晚餐”；每道菜的 ingredients 4–8 项且带份量，steps 3–5 步，why 一句话；totalKcal 等于四餐热量之和。');
    return lines.join('\n');
  }

  function searchUserPrompt(opts) {
    opts = opts || {};
    var q = (opts.query || '').trim();
    var filters = Array.isArray(opts.filters) ? opts.filters.filter(Boolean) : [];
    var lines = [];
    if (q) lines.push('在菜谱库里搜索：' + q);
    else lines.push('在菜谱库里给我一些推荐。');
    if (filters.length) lines.push('筛选条件：' + filters.join('、'));
    lines.push('');
    lines.push(JSON_ONLY);
    lines.push('JSON 结构：{"recipes":[{ ' + RECIPE_FIELDS + ' }],"note":"一句话推荐语"}');
    lines.push('要求：返回 4–6 道最符合的菜；如果条件太苛刻没有完全匹配的，返回最接近的，并在 note 里说明取舍。');
    return lines.join('\n');
  }

  function searchUserPrompt(opts) {
    opts = opts || {};
    var q = (opts.query || '').trim();
    var filters = Array.isArray(opts.filters) ? opts.filters.filter(Boolean) : [];
    var lines = [];
    if (q) lines.push('在菜谱库里搜索：' + q);
    else lines.push('在菜谱库里给我一些推荐。');
    if (filters.length) lines.push('筛选条件：' + filters.join('、'));
    lines.push('');
    lines.push(JSON_ONLY);
    lines.push('JSON 结构：{"recipes":[{ ' + RECIPE_FIELDS + ' }],"note":"一句话推荐语"}');
    lines.push('要求：返回 4–6 道最符合的菜；如果条件太苛刻没有完全匹配的，返回最接近的，并在 note 里说明取舍。');
    return lines.join('\n');
  }

  function homeSearchPrompt(opts) {
    opts = opts || {};
    var q = (opts.query || '').trim();
    var cuisine = (opts.cuisine || '').trim();
    var difficulty = (opts.difficulty || '').trim();
    var lines = [];
    lines.push(q ? '我想学做：' + q : '随便给我推荐几道家常菜。');
    lines.push('- 菜系偏好：' + (cuisine || '不限（尽量覆盖不同菜系）'));
    if (difficulty) lines.push('- 难度：' + difficulty);
    lines.push('');
    lines.push(JSON_ONLY);
    lines.push('JSON 结构：{"recipes":[{ ' + RECIPE_FIELDS_HOME + ' }],"note":"一句话点评"}');
    lines.push('要求：返回 4–6 道地道家常菜；每道都要写清菜系、口味、难度；ingredients 带份量；steps 4–6 步，写明火候（大火/中火/小火）、油温和下锅顺序；tip 必须是"最容易翻车的那一步"，不要泛泛而谈。');
    lines.push('如果用户指定了菜系，就全部给该菜系；没指定时尽量分布在 3 个以上菜系。');
    return lines.join('\n');
  }

  function chatSystemPrompt(mode) {
    if (mode === 'home') {
      return [
        PERSONA_HOME,
        '',
        '对话要求：',
        '1. 回答控制在 200 字以内，信息密度高，不寒暄。',
        '2. 只要聊到具体做法（推荐、替换、纠正火候），就在文字最后追加一个 JSON 代码块，内容为：',
        '{"recipes":[{ ' + RECIPE_FIELDS_HOME + ' }]}',
        '   一次给 1–2 道；不涉及具体菜时不要输出 JSON。',
        '3. 用户问“为什么”时解释原理：为什么要焯水、为什么要宽油、为什么最后勾芡。',
        '4. 用户说“太麻烦”“少放油”“没有这个调料”时，给可执行的替代方案，不要反问太多。'
      ].join('\n');
    }
    return [
      PERSONA_HEALTH,
      '',
      '对话要求：',
      '1. 回答控制在 200 字以内，信息密度高，不寒暄。',
      '2. 只要聊到具体菜品（新的推荐、替换、改做法），就在文字最后追加一个 JSON 代码块，内容为：',
      '{"recipes":[{ ' + RECIPE_FIELDS + ' }]}',
      '   一次给 1–3 道；不需要具体菜谱时不要输出 JSON。',
      '3. 用户说“换一道”“太油了”“想加个汤”这类要求时，直接给替代方案，不要反问太多。'
    ].join('\n');
  }

  function buildMessages(history, userText, mode) {
    var msgs = [{ role: 'system', content: chatSystemPrompt(mode) }];
    (history || []).forEach(function (m) {
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
        msgs.push({ role: m.role, content: m.content });
      }
    });
    msgs.push({ role: 'user', content: String(userText || '') });
    return msgs;
  }

  function buildBody(opts) {
    opts = opts || {};
    var body = {
      model: opts.model || DEFAULT_MODEL,
      messages: opts.messages || [],
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
      max_tokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : 1600
    };
    if (opts.stream) body.stream = true;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    return body;
  }

  /* ---------- JSON 抽取与归一化 ---------- */

  function tryParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function extractJson(text) {
    if (typeof text !== 'string') return null;
    var s = text.trim();
    if (!s) return null;

    var fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      var inner = tryParse(fenced[1].trim());
      if (inner) return inner;
    }

    var direct = tryParse(s);
    if (direct) return direct;

    var start = s.search(/[{[]/);
    if (start < 0) return null;
    var open = s.charAt(start);
    var close = open === '{' ? '}' : ']';
    var depth = 0;
    var inStr = false;
    var esc = false;
    for (var i = start; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          var cand = s.slice(start, i + 1);
          var parsed = tryParse(cand);
          if (parsed) return parsed;
          break;
        }
      }
    }
    return null;
  }

  function toNum(v, fallback) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      var m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return fallback;
  }

  function toList(v) {
    if (Array.isArray(v)) {
      return v
        .map(function (x) {
          if (x === null || x === undefined) return '';
          if (typeof x === 'string') return x.trim();
          if (typeof x === 'object') return String(x.text || x.name || x.step || '').trim();
          return String(x);
        })
        .filter(Boolean);
    }
    if (typeof v === 'string' && v.trim()) {
      return v.split(/\r?\n|[；;]/).map(function (s) { return s.replace(/^\s*[-*\d.、]+/, '').trim(); }).filter(Boolean);
    }
    return [];
  }

  function toText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('；');
    if (typeof v === 'object') return String(v.text || v.name || v.content || '').trim();
    return String(v);
  }

  function normalizeRecipe(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = toText(raw.name || raw.title || raw.dish);
    if (!name) return null;
    return {
      name: name,
      kcal: Math.round(toNum(raw.kcal || raw.calories || raw.energy, 0)),
      protein: Math.round(toNum(raw.protein || raw.protein_g, 0)),
      time: toText(raw.time || raw.duration || raw.cookTime),
      tags: toList(raw.tags || raw.labels).slice(0, 6),
      ingredients: toList(raw.ingredients || raw.materials),
      steps: toList(raw.steps || raw.method || raw.instructions),
      why: toText(raw.why || raw.reason || raw.benefit || raw.note),
      slot: toText(raw.slot || raw.meal || raw.mealTime),
      cuisine: toText(raw.cuisine || raw.style || raw.region),
      flavor: toText(raw.flavor || raw.taste),
      difficulty: toText(raw.difficulty || raw.level),
      tip: toText(raw.tip || raw.keyStep || raw.key || raw.trick)
    };
  }

  function normalizeRecipes(raw) {
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.recipes)) list = raw.recipes;
    else if (raw && Array.isArray(raw.items)) list = raw.items;
    else if (raw && raw.name) list = [raw];
    var out = [];
    list.forEach(function (item) {
      var r = normalizeRecipe(item);
      if (r) out.push(r);
    });
    return out;
  }

  function normalizeMenu(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var mealsRaw = Array.isArray(raw.meals) ? raw.meals : [];
    var meals = [];
    mealsRaw.forEach(function (m) {
      var r = normalizeRecipe(m);
      if (r) meals.push(r);
    });
    if (!meals.length) return null;
    var sum = meals.reduce(function (a, m) { return a + (m.kcal || 0); }, 0);
    return {
      title: toText(raw.title) || '今日健康菜单',
      summary: toText(raw.summary || raw.intro),
      totalKcal: Math.round(toNum(raw.totalKcal || raw.total_kcal, sum) || sum),
      meals: meals,
      tips: toList(raw.tips || raw.notes)
    };
  }

  /* ---------- 错误与格式化 ---------- */

  function formatError(status, payload) {
    var msg = '';
    if (payload && payload.error) {
      msg = toText(payload.error.message || payload.error);
    } else if (typeof payload === 'string') {
      msg = payload.slice(0, 300);
    }
    if (status === 0) return '网络请求失败，可能是断网、代理拦截或接口超时。' + (msg ? '（' + msg + '）' : '');
    if (status === 401) return 'API Key 无效或已过期（401）。请到 platform.agnes-ai.cn 重新生成。';
    if (status === 403) return '这个 Key 没有该模型的调用权限（403）。';
    if (status === 404) return '接口或模型不存在（404）：' + (msg || '检查 baseURL 与模型 id');
    if (status === 429) return '请求太频繁或额度用尽（429），稍等一会儿再试。';
    if (status === 400) return '请求被拒绝（400）：' + (msg || '参数不合法');
    if (status >= 500) return '服务端错误（' + status + '），Agnes 那边暂时不稳定，稍后重试。';
    return '请求失败（' + status + '）' + (msg ? '：' + msg : '');
  }

  function summarize(items) {
    var kcal = 0;
    var protein = 0;
    (items || []).forEach(function (x) {
      kcal += toNum(x && x.kcal, 0);
      protein += toNum(x && x.protein, 0);
    });
    return { kcal: Math.round(kcal), protein: Math.round(protein), count: (items || []).length };
  }

  function listChatModels(payload) {
    var data = payload && Array.isArray(payload.data) ? payload.data : [];
    var out = [];
    data.forEach(function (m) {
      var id = toText(m && m.id);
      if (!id) return;
      if (!/^agnes-/i.test(id)) return;
      if (NON_CHAT_MODEL.test(id)) return;
      out.push({ id: id, name: id });
    });
    return out;
  }

  function modelLabel(id) {
    var map = {
      'agnes-2.5-flash': 'Agnes 2.5 Flash · 快而免费',
      'agnes-3.0-flash': 'Agnes 3.0 Flash · 新一代免费',
      'agnes-2.5-pro': 'Agnes 2.5 Pro · 更强，按量计费',
      'agnes-2.5-pro-beta': 'Agnes 2.5 Pro Beta',
      'agnes-2.5-pro-theta': 'Agnes 2.5 Pro Theta'
    };
    return map[id] || id;
  }

  return {
    BASE_URL: BASE_URL,
    DEFAULT_MODEL: DEFAULT_MODEL,
    CHAT_TIMEOUT_MS: CHAT_TIMEOUT_MS,
    TEST_TIMEOUT_MS: TEST_TIMEOUT_MS,
    PERSONA: PERSONA,
    PERSONA_HEALTH: PERSONA_HEALTH,
    PERSONA_HOME: PERSONA_HOME,
    PERSONA_NAMES: { health: '小膳', home: '老灶' },
    personaFor: personaFor,
    chatEndpoint: function () { return BASE_URL + '/chat/completions'; },
    modelsEndpoint: function () { return BASE_URL + '/models'; },
    dateLabel: dateLabel,
    menuUserPrompt: menuUserPrompt,
    searchUserPrompt: searchUserPrompt,
    homeSearchPrompt: homeSearchPrompt,
    chatSystemPrompt: chatSystemPrompt,
    buildMessages: buildMessages,
    buildBody: buildBody,
    extractJson: extractJson,
    normalizeRecipe: normalizeRecipe,
    normalizeRecipes: normalizeRecipes,
    normalizeMenu: normalizeMenu,
    formatError: formatError,
    summarize: summarize,
    listChatModels: listChatModels,
    modelLabel: modelLabel,
    toList: toList,
    toText: toText,
    toNum: toNum
  };
});

/*!
 * 小膳 · 交互层
 * 依赖 core.js（window.ChefCore）。所有网络请求直接发往 https://api.agnes-ai.cn/v1。
 */
(function () {
  'use strict';

  var C = window.ChefCore;
  if (!C) {
    document.body.innerHTML = '<p style="padding:32px;font-family:sans-serif">core.js 没有加载成功，请确认两个文件放在同一目录。</p>';
    return;
  }

  var LS = {
    key: 'xiaoshan.key',
    model: 'xiaoshan.model',
    goal: 'xiaoshan.goal',
    avoid: 'xiaoshan.avoid',
    menu: 'xiaoshan.menu',
    book: 'xiaoshan.book',
    mode: 'xiaoshan.mode',
    verified: 'xiaoshan.verified'
  };

  var DEFAULT_GOAL = '均衡维持，每天 1800 大卡左右';

  var CUISINES = ['川菜', '粤菜', '鲁菜', '苏菜', '湘菜', '浙菜', '闽菜', '徽菜', '东北菜', '西北菜', '云贵菜', '港式家常'];

  var state = {
    key: '',
    model: C.DEFAULT_MODEL,
    goal: DEFAULT_GOAL,
    avoid: '',
    menu: [],
    book: [],
    mode: 'health',
    histories: { health: [], home: [] },
    view: { health: null, home: null },
    verified: false,
    busy: false,
    lastModels: []
  };

  function isHome() { return state.mode === 'home'; }

  var el = {};

  /* ---------- 工具 ---------- */

  function ApiError(message, status) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status || 0;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function $(id) { return document.getElementById(id); }

  function storageGet(k, fb) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? fb : v;
    } catch (e) {
      return fb;
    }
  }

  function storageSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ }
  }

  function storageDel(k) {
    try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
  }

  var toastTimer = null;
  function toast(msg, ms) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, ms || 3200);
  }

  function btnLoad(btn, loading) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = !!loading;
    btn.textContent = loading ? '处理中…' : btn.dataset.label;
  }

  /* ---------- 网络 ---------- */

  function headers(key) {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key
    };
  }

  async function request(path, opts) {
    opts = opts || {};
    var key = opts.key || state.key;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || C.CHAT_TIMEOUT_MS);
    var res;
    try {
      res = await fetch(C.BASE_URL + path, {
        method: opts.method || 'GET',
        headers: headers(key),
        body: opts.body,
        signal: ctrl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new ApiError('请求超时，检查网络后重试（' + Math.round((opts.timeout || C.CHAT_TIMEOUT_MS) / 1000) + ' 秒）。', 0);
      }
      throw new ApiError(C.formatError(0, err && err.message), 0);
    }
    clearTimeout(timer);

    var text = await res.text();
    var data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!res.ok) {
      if (res.status === 401) {
        state.verified = false;
        storageDel(LS.verified);
      }
      updateStatus();
      throw new ApiError(C.formatError(res.status, data || text), res.status);
    }
    return data;
  }

  async function callChat(messages, opts) {
    opts = opts || {};
    var body = C.buildBody({
      model: opts.model || state.model,
      messages: messages,
      jsonMode: !!opts.jsonMode,
      maxTokens: opts.maxTokens || 1600,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7
    });
    var data = await request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      key: opts.key,
      timeout: opts.timeout
    });
    var choice = data && data.choices && data.choices[0];
    var content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ApiError('模型返回了空内容，请再试一次。', 0);
    }
    return content;
  }

  async function streamChat(messages, onDelta) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, C.CHAT_TIMEOUT_MS);
    var res;
    try {
      res = await fetch(C.chatEndpoint(), {
        method: 'POST',
        headers: headers(state.key),
        body: JSON.stringify(C.buildBody({ model: state.model, messages: messages, stream: true, maxTokens: 1200 })),
        signal: ctrl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new ApiError('请求超时，稍后重试。', 0);
      throw new ApiError(C.formatError(0, err && err.message), 0);
    }

    if (!res.ok) {
      clearTimeout(timer);
      var t = await res.text();
      var d = null;
      try { d = JSON.parse(t); } catch (e) { d = null; }
      throw new ApiError(C.formatError(res.status, d || t), res.status);
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var full = '';
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          var line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          var json = null;
          try { json = JSON.parse(payload); } catch (e) { continue; }
          var delta = json.choices && json.choices[0] && json.choices[0].delta;
          var piece = delta && delta.content;
          if (typeof piece === 'string' && piece) {
            full += piece;
            onDelta(piece);
          }
        }
      }
    } finally {
      clearTimeout(timer);
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
    return full;
  }

  /* ---------- 状态 ---------- */

  function updateStatus() {
    if (!el.connPill) return;
    el.connPill.dataset.state = state.verified ? 'ok' : (state.key ? 'idle' : 'bad');
    el.connText.textContent = state.verified
      ? '已连接 · ' + state.model
      : (state.key ? '已填 Key · 未验证' : '未连接 · 点此设置');
    el.connPill.title = state.key ? '点击打开 API 设置' : '先填写 Agnes API Key';
  }

  function ensureKey() {
    if (state.key) return true;
    toast('先填一下 Agnes API Key，才能让小膳开始做菜。');
    openSettings();
    setTimeout(function () { if (el.keyInput) el.keyInput.focus(); }, 120);
    return false;
  }

  /* ---------- 渲染：菜谱卡片 ---------- */

  function statChip(text) {
    var s = document.createElement('span');
    s.className = 'stat';
    s.textContent = text;
    return s;
  }

  function section(title, items, ordered) {
    if (!items || !items.length) return null;
    var wrap = document.createElement('div');
    wrap.className = 'card-section';
    var h = document.createElement('h4');
    h.textContent = title;
    wrap.appendChild(h);
    var list = document.createElement(ordered ? 'ol' : 'ul');
    if (ordered) list.style.paddingLeft = '18px';
    items.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      list.appendChild(li);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function recipeCard(recipe, mode) {
    var home = mode === 'home';
    var card = document.createElement('article');
    card.className = 'card' + (home ? ' card-home' : '');

    var top = document.createElement('div');
    top.className = 'card-top';
    var h3 = document.createElement('h3');
    h3.textContent = recipe.name;
    top.appendChild(h3);
    var badgeText = home ? (recipe.cuisine || '家常菜') : recipe.slot;
    if (badgeText) {
      var badge = document.createElement('span');
      badge.className = 'slot-badge' + (home ? ' cuisine' : '');
      badge.textContent = badgeText;
      top.appendChild(badge);
    }
    card.appendChild(top);

    var stats = document.createElement('div');
    stats.className = 'card-stats';
    if (home) {
      if (recipe.difficulty) stats.appendChild(statChip('🍳 ' + recipe.difficulty));
      if (recipe.time) stats.appendChild(statChip('⏱ ' + recipe.time));
      if (recipe.flavor) stats.appendChild(statChip('🌶 ' + recipe.flavor));
    } else {
      if (recipe.kcal) stats.appendChild(statChip('🔥 ' + recipe.kcal + ' 大卡'));
      if (recipe.protein) stats.appendChild(statChip('💪 蛋白 ' + recipe.protein + ' g'));
      if (recipe.time) stats.appendChild(statChip('⏱ ' + recipe.time));
    }
    (recipe.tags || []).slice(0, 3).forEach(function (t) { stats.appendChild(statChip('#' + t)); });
    if (stats.children.length) card.appendChild(stats);

    if (home && recipe.tip) {
      var tip = document.createElement('p');
      tip.className = 'card-tip';
      tip.textContent = '🔑 关键一步：' + recipe.tip;
      card.appendChild(tip);
    }

    if (!home && recipe.why) {
      var why = document.createElement('p');
      why.className = 'card-why';
      why.textContent = recipe.why;
      card.appendChild(why);
    }

    var ing = section('食材', recipe.ingredients, false);
    if (ing) card.appendChild(ing);
    var steps = section('做法', recipe.steps, true);
    if (steps) card.appendChild(steps);

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn small primary';
    addBtn.textContent = home ? '收进菜谱本' : '加入今日菜单';
    addBtn.addEventListener('click', function () {
      var ok = home ? addToBook(recipe) : addToMenu(recipe);
      if (ok) {
        addBtn.textContent = '已收藏 ✓';
        addBtn.disabled = true;
      }
    });
    actions.appendChild(addBtn);

    var tweakBtn = document.createElement('button');
    tweakBtn.type = 'button';
    tweakBtn.className = 'btn small ghost';
    tweakBtn.textContent = home ? '问问老灶' : '让小膳改改';
    tweakBtn.addEventListener('click', function () {
      if (!ensureKey()) return;
      document.getElementById('chatInput').value = home
        ? '「' + recipe.name + '」我照着做总是差一点，火候和调味上最容易错在哪？'
        : '把「' + recipe.name + '」改成更简单、食材更好买的版本，热量别变太多。';
      document.getElementById('chatInput').focus();
      document.querySelector('.chat').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    actions.appendChild(tweakBtn);

    card.appendChild(actions);
    return card;
  }

  function showSkeleton(n) {
    clearView();
    var wrap = document.createElement('div');
    wrap.className = 'cards';
    for (var i = 0; i < (n || 4); i++) {
      var d = document.createElement('div');
      d.className = 'skeleton';
      wrap.appendChild(d);
    }
    el.cardsHost.appendChild(wrap);
  }

  function clearView() {
    el.emptyHealth.hidden = true;
    el.emptyHome.hidden = true;
    el.cardsHost.innerHTML = '';
  }

  function renderRecipes(recipes, opts) {
    opts = opts || {};
    var mode = opts.mode || state.mode;
    if (!opts.replay) state.view[mode] = { recipes: recipes, opts: opts };
    clearView();

    if (opts.hero) {
      var hero = document.createElement('div');
      hero.className = 'menu-hero';
      var h2 = document.createElement('h2');
      h2.textContent = opts.hero.title;
      hero.appendChild(h2);
      if (opts.hero.summary) {
        var p = document.createElement('p');
        p.textContent = opts.hero.summary;
        hero.appendChild(p);
      }
      var meta = document.createElement('div');
      meta.className = 'meta';
      if (opts.hero.totalKcal) {
        var t1 = document.createElement('span');
        t1.className = 'tag';
        t1.textContent = '合计 ' + opts.hero.totalKcal + ' 大卡';
        meta.appendChild(t1);
      }
      if (opts.note) {
        var t2 = document.createElement('span');
        t2.className = 'tag warm';
        t2.textContent = opts.note;
        meta.appendChild(t2);
      }
      if (meta.children.length) hero.appendChild(meta);
      el.cardsHost.appendChild(hero);
    } else if (opts.note) {
      var note = document.createElement('p');
      note.className = 'card-why';
      note.style.padding = '0 2px';
      note.textContent = opts.note;
      el.cardsHost.appendChild(note);
    }

    var grid = document.createElement('div');
    grid.className = 'cards';
    recipes.forEach(function (r) { grid.appendChild(recipeCard(r, mode)); });
    el.cardsHost.appendChild(grid);

    if (opts.tips && opts.tips.length) {
      var tipBox = document.createElement('div');
      tipBox.className = 'menu-hero';
      var tipTitle = document.createElement('h2');
      tipTitle.textContent = mode === 'home' ? '老灶的提醒' : '今天的小建议';
      tipBox.appendChild(tipTitle);
      var ul = document.createElement('ul');
      ul.style.marginTop = '8px';
      opts.tips.forEach(function (t) {
        var li = document.createElement('li');
        li.className = 'card-why';
        li.textContent = '· ' + t;
        ul.appendChild(li);
      });
      tipBox.appendChild(ul);
      el.cardsHost.appendChild(tipBox);
    }
  }

  /* ---------- 今日菜单 ---------- */

  function addToMenu(recipe) {
    var exists = state.menu.some(function (m) { return m.name === recipe.name; });
    if (exists) {
      toast('「' + recipe.name + '」已经在菜单里了。');
      return false;
    }
    state.menu.push({
      name: recipe.name,
      kcal: recipe.kcal || 0,
      protein: recipe.protein || 0,
      slot: recipe.slot || ''
    });
    persistMenu();
    renderMenu();
    toast('已加入「' + recipe.name + '」');
    return true;
  }

  function renderMenu() {
    if (!el.menuList) return;
    el.menuList.innerHTML = '';
    state.menu.forEach(function (item, index) {
      var li = document.createElement('li');
      li.className = 'menu-item';

      var left = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'mi-name';
      name.textContent = (item.slot ? item.slot + ' · ' : '') + item.name;
      left.appendChild(name);

      var sub = document.createElement('div');
      sub.className = 'mi-sub';
      sub.textContent = (item.kcal || 0) + ' 大卡 · 蛋白 ' + (item.protein || 0) + ' g';
      left.appendChild(sub);
      li.appendChild(left);

      var del = document.createElement('button');
      del.type = 'button';
      del.title = '从菜单移除';
      del.textContent = '✕';
      del.addEventListener('click', function () {
        state.menu.splice(index, 1);
        persistMenu();
        renderMenu();
      });
      li.appendChild(del);
      el.menuList.appendChild(li);
    });

    var sum = C.summarize(state.menu);
    el.menuCount.textContent = String(sum.count);
    el.menuEmpty.hidden = sum.count > 0;
    if (sum.count > 0) {
      el.menuTotals.hidden = false;
      el.menuTotals.innerHTML = '';
      var a = document.createElement('span');
      a.innerHTML = '总热量 <strong>' + sum.kcal + '</strong> 大卡';
      var b = document.createElement('span');
      b.innerHTML = '蛋白质 <strong>' + sum.protein + '</strong> g';
      el.menuTotals.appendChild(a);
      el.menuTotals.appendChild(b);
    } else {
      el.menuTotals.hidden = true;
    }
  }

  function persistMenu() {
    storageSet(LS.menu, JSON.stringify(state.menu));
  }

  /* ---------- 菜谱本（家常模式） ---------- */

  function addToBook(recipe) {
    var exists = state.book.some(function (m) { return m.name === recipe.name; });
    if (exists) {
      toast('「' + recipe.name + '」已经在本子里了。');
      return false;
    }
    state.book.push({
      name: recipe.name,
      cuisine: recipe.cuisine || '家常菜',
      difficulty: recipe.difficulty || '',
      time: recipe.time || ''
    });
    persistBook();
    renderBook();
    toast('已收进菜谱本：' + recipe.name);
    return true;
  }

  function renderBook() {
    if (!el.bookList) return;
    el.bookList.innerHTML = '';
    state.book.forEach(function (item, index) {
      var li = document.createElement('li');
      li.className = 'menu-item';

      var left = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'mi-name';
      name.textContent = item.name;
      left.appendChild(name);

      var sub = document.createElement('div');
      sub.className = 'mi-sub';
      sub.textContent = [item.cuisine, item.difficulty, item.time].filter(Boolean).join(' · ');
      left.appendChild(sub);
      li.appendChild(left);

      var del = document.createElement('button');
      del.type = 'button';
      del.title = '从菜谱本移除';
      del.textContent = '×';
      del.addEventListener('click', function () {
        state.book.splice(index, 1);
        persistBook();
        renderBook();
      });
      li.appendChild(del);
      el.bookList.appendChild(li);
    });

    el.bookCount.textContent = String(state.book.length);
    el.bookEmpty.hidden = state.book.length > 0;
    if (state.book.length) {
      var set = {};
      state.book.forEach(function (b) { set[b.cuisine] = 1; });
      var cuisines = Object.keys(set).length;
      el.bookSummary.hidden = false;
      el.bookSummary.innerHTML = '';
      var a = document.createElement('span');
      a.innerHTML = '共 <strong>' + state.book.length + '</strong> 道菜';
      var b = document.createElement('span');
      b.innerHTML = '覆盖 <strong>' + cuisines + '</strong> 个菜系';
      el.bookSummary.appendChild(a);
      el.bookSummary.appendChild(b);
    } else {
      el.bookSummary.hidden = true;
    }
  }

  function persistBook() {
    storageSet(LS.book, JSON.stringify(state.book));
  }

  /* ---------- 模式切换 ---------- */

  var GREETING = {
    health: '我是小膳 👨‍🍳 今天想吃点什么？可以直接点上面的「生成今日菜单」，或者告诉我你想吃什么、手边有什么食材。',
    home: '我是老灶 👨‍🍳 想学哪道家常菜？点上面的菜系标签看看，或者直接写菜名（比如「鱼香肉丝」「东北乱炖」），我把火候和顺序讲清楚。'
  };

  function greeting() {
    var base = GREETING[state.mode];
    if (state.key) return base;
    return '先点右上角「API 设置」填一个 Agnes API Key（sk- 开头），两种模式共用一个 Key，填一次就行。';
  }

  function showEmpty() {
    var home = isHome();
    clearView();
    el.emptyHealth.hidden = home;
    el.emptyHome.hidden = !home;
  }

  function replayView() {
    var v = state.view[state.mode];
    if (!v) { showEmpty(); return; }
    var opts = {};
    Object.keys(v.opts).forEach(function (k) { opts[k] = v.opts[k]; });
    opts.mode = state.mode;
    opts.replay = true;
    renderRecipes(v.recipes, opts);
  }

  function renderChat() {
    el.chatLog.innerHTML = '';
    var h = state.histories[state.mode];
    if (!h.length) {
      appendMessage('chef', greeting());
      return;
    }
    h.forEach(function (m) {
      appendMessage(m.role === 'user' ? 'user' : 'chef', m.role === 'user'
        ? m.content
        : (m.content.replace(/```(?:json)?[\s\S]*?```/gi, '').trim() || '（菜谱见下方卡片）'));
    });
  }

  function setMode(next, opts) {
    opts = opts || {};
    if (next !== 'home' && next !== 'health') next = 'health';
    if (next === state.mode && !opts.force) return;
    state.mode = next;
    storageSet(LS.mode, next);

    document.body.dataset.mode = next;
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === next;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    el.chipsHealth.hidden = next === 'home';
    el.chipsHome.hidden = next !== 'home';
    el.sideHealth.hidden = next === 'home';
    el.sideHome.hidden = next !== 'home';
    el.healthOnly.hidden = next === 'home';
    el.searchInput.placeholder = next === 'home'
      ? '想学什么菜？例如「鱼香肉丝」「可乐鸡翅」「东北乱炖」'
      : '想吃什么？例如：高蛋白低脂的鸡胸肉、15 分钟快手菜、控糖晚餐';
    el.chatHint.textContent = next === 'home'
      ? '比如「鱼香肉丝为什么不出红油」「换成不辣的版本」「教我做糖醋排骨」'
      : '比如「午餐想吃鱼」「换一道更简单的早餐」「帮我改成带饭版」';
    el.brandSub.textContent = next === 'home' ? '一周不重样 · 八大菜系家常菜' : '每日健康菜谱 · 营养师 × 厨师';

    if (opts.keepBoard !== true) replayView();
    renderChat();
    if (opts.toast !== false) {
      toast(next === 'home' ? '已切到家常模式：学做各地家常菜' : '已切回健康模式：配每日营养菜单');
    }
  }

  /* ---------- 生成菜单 ---------- */

  async function generateMenu() {
    if (isHome()) return;
    if (!ensureKey()) return;
    if (state.busy) return;
    state.busy = true;
    showSkeleton(4);
    var menuBtn = document.getElementById('btnMenu');
    btnLoad(menuBtn, true);
    setBusyState(true);

    var prompt = C.menuUserPrompt({ goal: state.goal, avoid: state.avoid, date: C.dateLabel() });
    var messages = [
      { role: 'system', content: C.PERSONA },
      { role: 'user', content: prompt }
    ];

    try {
      var content = await callChat(messages, { jsonMode: true, maxTokens: 2400 });
      var json = C.extractJson(content);
      var menu = C.normalizeMenu(json);
      if (!menu) {
        content = await callChat(messages.concat([
          { role: 'assistant', content: content },
          { role: 'user', content: '上面的输出不是合法的菜谱 JSON。请严格只输出 JSON 对象，不要任何解释。' }
        ]), { jsonMode: true, maxTokens: 2400 });
        menu = C.normalizeMenu(C.extractJson(content));
      }
      if (!menu) throw new ApiError('模型的输出没能解析成菜谱，再点一次试试。', 0);

      renderRecipes(menu.meals, {
        hero: { title: menu.title, summary: menu.summary, totalKcal: menu.totalKcal },
        tips: menu.tips
      });
      el.board.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      clearView();
      var box = document.createElement('div');
      box.className = 'board-empty';
      box.innerHTML = '<div class="empty-emoji">🥲</div>';
      var h = document.createElement('h2');
      h.textContent = '这一顿没配出来';
      box.appendChild(h);
      var p = document.createElement('p');
      p.textContent = err.message || String(err);
      box.appendChild(p);
      el.cardsHost.appendChild(box);
    } finally {
      state.busy = false;
      btnLoad(menuBtn, false);
      setBusyState(false);
    }
  }

  /* ---------- 搜索 ---------- */

  async function search(query, opts) {
    opts = opts || {};
    if (!ensureKey()) return;
    if (state.busy) return;
    state.busy = true;
    showSkeleton(4);
    setBusyState(true);
    var mode = state.mode;
    var home = mode === 'home';
    var prompt = home
      ? C.homeSearchPrompt({ query: query, cuisine: opts.cuisine || '', difficulty: opts.difficulty || '' })
      : C.searchUserPrompt({ query: query, filters: opts.filters || [] });
    var system = C.personaFor(mode);

    try {
      var content = await callChat([
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ], { jsonMode: true, maxTokens: 2400 });

      var json = C.extractJson(content);
      var recipes = C.normalizeRecipes(json);
      if (!recipes.length) {
        content = await callChat([
          { role: 'system', content: system },
          { role: 'user', content: prompt },
          { role: 'assistant', content: content },
          { role: 'user', content: '输出不是合法 JSON。请只输出 {"recipes":[...]}，不要任何解释。' }
        ], { jsonMode: true, maxTokens: 2400 });
        json = C.extractJson(content);
        recipes = C.normalizeRecipes(json);
      }
      if (!recipes.length) throw new ApiError('没解析出菜谱，换个说法再搜一次。', 0);

      renderRecipes(recipes, { note: json && json.note ? String(json.note) : '', mode: mode });
      el.board.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      clearView();
      var box = document.createElement('div');
      box.className = 'board-empty';
      box.innerHTML = '<div class="empty-emoji">🥲</div>';
      var h = document.createElement('h2');
      h.textContent = '这次没搜到';
      box.appendChild(h);
      var p = document.createElement('p');
      p.textContent = err.message || String(err);
      box.appendChild(p);
      el.cardsHost.appendChild(box);
    } finally {
      state.busy = false;
      setBusyState(false);
    }
  }

  function randomCuisine() {
    return CUISINES[Math.floor(Math.random() * CUISINES.length)];
  }

  async function recommendDish() {
    if (!isHome()) return;
    var cuisine = randomCuisine();
    el.searchInput.value = cuisine;
    toast('今天给你挑：' + cuisine + ' —— 想到什么做什么');
    await search('', { cuisine: cuisine });
  }

  function setBusyState(busy) {
    if (!el.connPill) return;
    if (busy) {
      el.connPill.dataset.state = 'busy';
      el.connText.textContent = '正在准备…';
    } else {
      updateStatus();
    }
  }

  /* ---------- 对话 ---------- */

  function appendMessage(role, text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? '🙋' : '👨‍🍳';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    el.chatLog.appendChild(wrap);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    return bubble;
  }

  function appendChatCards(recipes, mode) {
    if (!recipes.length) return;
    var home = mode === 'home';
    var wrap = document.createElement('div');
    wrap.className = 'msg chef';
    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '👨‍🍳';
    var holder = document.createElement('div');
    var strip = document.createElement('div');
    strip.className = 'chat-cards';
    recipes.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'mini-card';
      var b = document.createElement('b');
      b.textContent = r.name;
      card.appendChild(b);
      var span = document.createElement('span');
      span.textContent = home
        ? [r.cuisine, r.difficulty, r.time].filter(Boolean).join(' · ')
        : (r.kcal || 0) + ' 大卡' + (r.protein ? ' · 蛋白 ' + r.protein + 'g' : '');
      card.appendChild(span);
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'link-btn';
      add.textContent = home ? '收进菜谱本' : '加入菜单';
      add.addEventListener('click', function () {
        if (home) addToBook(r); else addToMenu(r);
      });
      card.appendChild(add);
      strip.appendChild(card);
    });
    holder.appendChild(strip);
    wrap.appendChild(avatar);
    wrap.appendChild(holder);
    el.chatLog.appendChild(wrap);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  async function sendChat(text) {
    var msg = String(text || '').trim();
    if (!msg) return;
    if (!ensureKey()) return;
    if (state.busy) return;

    var mode = state.mode;
    state.busy = true;
    appendMessage('user', msg);
    el.chatInput.value = '';
    var bubble = appendMessage('chef', '');
    bubble.classList.add('thinking');
    bubble.textContent = (mode === 'home' ? '老灶正在想…' : '小膳正在想…');

    var messages = C.buildMessages(state.histories[mode], msg, mode);
    var acc = '';
    var started = false;

    try {
      await streamChat(messages, function (delta) {
        if (!started) {
          started = true;
          bubble.classList.remove('thinking');
          bubble.textContent = '';
        }
        acc += delta;
        bubble.textContent = acc;
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
      });
    } catch (err) {
      // 流式失败（个别网关不支持）就退回整段请求
      try {
        acc = await callChat(messages, { maxTokens: 1200 });
        bubble.classList.remove('thinking');
        bubble.textContent = acc;
      } catch (err2) {
        bubble.classList.remove('thinking');
        bubble.textContent = '出错了：' + (err2.message || String(err2));
        state.busy = false;
        return;
      }
    }

    if (!acc.trim()) acc = '（这次没说出话，再问一次试试。）';
    bubble.textContent = acc.replace(/```(?:json)?[\s\S]*?```/gi, '').trim() || '（菜谱见下方卡片）';

    var json = C.extractJson(acc);
    var recipes = C.normalizeRecipes(json);
    appendChatCards(recipes, mode);

    var hist = state.histories[mode];
    hist.push({ role: 'user', content: msg });
    hist.push({ role: 'assistant', content: acc });
    if (hist.length > 12) state.histories[mode] = hist.slice(-12);

    state.busy = false;
  }

  /* ---------- 设置 ---------- */

  function openSettings() {
    if (!el.settingsDialog) return;
    el.keyInput.value = state.key;
    el.modelSelect.value = state.model;
    el.goalSelect.value = state.goal;
    el.avoidInput.value = state.avoid;
    el.testResult.textContent = state.verified ? '上次测试：连接正常' : '还没测试';
    el.testResult.className = 'test-result';
    if (typeof el.settingsDialog.showModal === 'function') el.settingsDialog.showModal();
    else el.settingsDialog.setAttribute('open', '');
  }

  function closeSettings() {
    if (typeof el.settingsDialog.close === 'function') el.settingsDialog.close();
    else el.settingsDialog.removeAttribute('open');
  }

  async function testConnection() {
    var key = el.keyInput.value.trim();
    var model = el.modelSelect.value;
    if (!key) {
      el.testResult.className = 'test-result bad';
      el.testResult.textContent = '请先填入 API Key';
      return;
    }

    btnLoad(el.btnTest, true);
    el.testResult.className = 'test-result';
    el.testResult.textContent = '正在连接 Agnes…';

    var t0 = performance.now();
    try {
      var models = await request('/models', { key: key, timeout: C.TEST_TIMEOUT_MS });
      var list = C.listChatModels(models);
      var t1 = performance.now();
      state.lastModels = list;

      if (list.length) {
        var keep = el.modelSelect.value;
        el.modelSelect.innerHTML = '';
        list.forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = C.modelLabel(m.id);
          el.modelSelect.appendChild(opt);
        });
        el.modelSelect.value = list.some(function (m) { return m.id === keep; }) ? keep : list[0].id;
      }

      var t2 = performance.now();
      await callChat([{ role: 'user', content: '只回复两个字：可以' }], {
        key: key,
        model: model,
        maxTokens: 16,
        temperature: 0,
        timeout: C.TEST_TIMEOUT_MS
      });
      var t3 = performance.now();

      el.testResult.className = 'test-result ok';
      el.testResult.textContent = '✓ 连通正常 · 可用模型 ' + list.length + ' 个 · 列表 ' + Math.round(t1 - t0) + ' ms · 对话 ' + Math.round(t3 - t2) + ' ms';
      state.verified = true;
      state.key = key;
      state.model = el.modelSelect.value;
      storageSet(LS.key, state.key);
      storageSet(LS.model, state.model);
      storageSet(LS.verified, '1');
      updateStatus();
      toast('连接成功，可以用啦 🎉');
    } catch (err) {
      state.verified = false;
      updateStatus();
      el.testResult.className = 'test-result bad';
      el.testResult.textContent = '✗ ' + (err.message || String(err));
    } finally {
      btnLoad(el.btnTest, false);
    }
  }

  function saveSettings(e) {
    if (e) e.preventDefault();
    var key = el.keyInput.value.trim();
    state.key = key;
    state.model = el.modelSelect.value || C.DEFAULT_MODEL;
    state.goal = el.goalSelect.value || DEFAULT_GOAL;
    state.avoid = el.avoidInput.value.trim();
    storageSet(LS.key, state.key);
    storageSet(LS.model, state.model);
    storageSet(LS.goal, state.goal);
    storageSet(LS.avoid, state.avoid);
    updateStatus();
    closeSettings();
    toast(state.key ? '设置已保存' : '已保存，但还没有填 Key');
  }

  /* ---------- 绑定 ---------- */

  function cacheEls() {
    el = {
      connPill: $('connPill'),
      connText: $('connText'),
      connDot: $('connDot'),
      chatLog: $('chatLog'),
      chatInput: $('chatInput'),
      chatForm: $('chatForm'),
      btnChatSend: $('btnChatSend'),
      board: $('board'),
      searchForm: $('searchForm'),
      searchInput: $('searchInput'),
      btnSearch: $('btnSearch'),
      menuList: $('menuList'),
      menuCount: $('menuCount'),
      menuEmpty: $('menuEmpty'),
      menuTotals: $('menuTotals'),
      btnClearMenu: $('btnClearMenu'),
      chipsHealth: $('chipsHealth'),
      chipsHome: $('chipsHome'),
      sideHealth: $('sideHealth'),
      sideHome: $('sideHome'),
      emptyHealth: $('emptyHealth'),
      emptyHome: $('emptyHome'),
      cardsHost: $('cardsHost'),
      healthOnly: $('healthOnlyFields'),
      bookList: $('bookList'),
      bookCount: $('bookCount'),
      bookEmpty: $('bookEmpty'),
      bookSummary: $('bookSummary'),
      btnClearBook: $('btnClearBook'),
      chatHint: $('chatHint'),
      brandSub: $('brandSub'),
      settingsDialog: $('settingsDialog'),
      settingsForm: $('settingsForm'),
      keyInput: $('keyInput'),
      keyToggle: $('keyToggle'),
      modelSelect: $('modelSelect'),
      goalSelect: $('goalSelect'),
      avoidInput: $('avoidInput'),
      btnTest: $('btnTest'),
      testResult: $('testResult'),
      btnClearKey: $('btnClearKey'),
      btnSaveSettings: $('btnSaveSettings'),
      toast: $('toast')
    };
  }

  function bind() {
    el.connPill.addEventListener('click', openSettings);
    $('btnOpenSettings').addEventListener('click', openSettings);

    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });

    el.keyToggle.addEventListener('click', function () {
      var hidden = el.keyInput.type === 'password';
      el.keyInput.type = hidden ? 'text' : 'password';
      el.keyToggle.textContent = hidden ? '隐藏' : '显示';
    });

    el.btnTest.addEventListener('click', testConnection);

    el.settingsForm.addEventListener('submit', function (e) {
      var submitter = e.submitter;
      if (submitter && submitter.value === 'cancel') {
        e.preventDefault();
        closeSettings();
        return;
      }
      saveSettings(e);
    });

    el.btnClearKey.addEventListener('click', function () {
      state.key = '';
      state.verified = false;
      storageDel(LS.key);
      storageDel(LS.verified);
      el.keyInput.value = '';
      el.testResult.className = 'test-result';
      el.testResult.textContent = '已清除本机 Key';
      updateStatus();
    });

    el.searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = el.searchInput.value.trim();
      if (!q) {
        toast(isHome() ? '写个菜名试试，比如「鱼香肉丝」' : '先写点想吃的，比如「番茄鸡蛋」');
        return;
      }
      search(q, {});
    });

    document.querySelectorAll('.chip[data-q]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var q = chip.getAttribute('data-q');
        el.searchInput.value = q;
        search(q, {});
      });
    });

    document.querySelectorAll('.chip[data-cuisine]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var cuisine = chip.getAttribute('data-cuisine');
        el.searchInput.value = cuisine;
        search('', { cuisine: cuisine });
      });
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var act = e.target.closest('[data-action="menu"], [data-action="dish"], [data-cuisine], [data-q]');
      if (!act) return;
      var action = act.getAttribute('data-action');
      if (action === 'menu') {
        e.preventDefault();
        generateMenu();
      } else if (action === 'dish') {
        e.preventDefault();
        recommendDish();
      } else if (act.hasAttribute('data-cuisine') && !act.classList.contains('chip')) {
        e.preventDefault();
        var c = act.getAttribute('data-cuisine');
        el.searchInput.value = c;
        search('', { cuisine: c });
      } else if (act.hasAttribute('data-q') && !act.classList.contains('chip')) {
        e.preventDefault();
        var q = act.getAttribute('data-q');
        el.searchInput.value = q;
        search(q, { filters: [q] });
      }
    });

    el.btnClearMenu.addEventListener('click', function () {
      if (!state.menu.length) return;
      state.menu = [];
      persistMenu();
      renderMenu();
      toast('菜单已清空');
    });

    el.btnClearBook.addEventListener('click', function () {
      if (!state.book.length) return;
      state.book = [];
      persistBook();
      renderBook();
      toast('菜谱本已清空');
    });

    el.chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      sendChat(el.chatInput.value);
    });
  }

  function load() {
    state.key = storageGet(LS.key, '');
    state.model = storageGet(LS.model, C.DEFAULT_MODEL) || C.DEFAULT_MODEL;
    state.goal = storageGet(LS.goal, DEFAULT_GOAL) || DEFAULT_GOAL;
    state.avoid = storageGet(LS.avoid, '');
    state.mode = storageGet(LS.mode, 'health') === 'home' ? 'home' : 'health';
    state.verified = storageGet(LS.verified, '') === '1' && !!state.key;
    try {
      var raw = storageGet(LS.menu, '[]');
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) state.menu = parsed;
    } catch (e) {
      state.menu = [];
    }
    try {
      var rawBook = storageGet(LS.book, '[]');
      var parsedBook = JSON.parse(rawBook);
      if (Array.isArray(parsedBook)) state.book = parsedBook;
    } catch (e) {
      state.book = [];
    }
  }

  function init() {
    cacheEls();
    load();
    bind();
    renderMenu();
    renderBook();
    updateStatus();
    setMode(state.mode, { force: true, toast: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

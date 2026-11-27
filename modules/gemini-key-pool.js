// ============================================================
// 谷歌直连 Key 池：多 Key 轮询 + 失败自动换 Key + 超时上限
// [2026-11-26] v0.1.0 第一版只做 Key 轮询；模型轮询等 Key 轮询跑通再加
// [2026-11-26] v0.2.0 语义改成「一目了然」（用户拍板）：
//     开关打开 → 主聊天【直接走谷歌轮询】，不管主 API 原来选的是哪个渠道；
//     开关关闭 → 主 API 走你选择的渠道（= 改造前的老行为，一字未改）。
//   所以池开着的时候，地址和模型都归池管 —— 只换 Key 不换模型会 400
//   （拿 gpt-4o 去打谷歌）。其它槽位（副/后台/识图/情侣空间）保持老规矩：
//   自己走谷歌直连 + 自己的 Key 已在池里才接管。
//
// 设计要点：
//  1. 池成员 = 用户在设置页勾选的「API 预设」（一个预设一个 Key），不手填 Key。
//  2. 故障转移靠 fetch 拦截器实现 —— 全部 Gemini 调用点（100 处 / 19 文件）
//     都是非流式的 `fetch(geminiConfig.url, geminiConfig.data)`，
//     拦截器改 header 里的 x-goog-api-key 即可，调用点一行都不用改。
//     因为是「拿完整 body 才渲染」，换 Key 重试绝不会重复输出。
//  3. 总开关关闭时，拦截器只放行不重试 —— 行为与改造前完全一致，可一键回退。
//  4. 游标只能有一个推 —— 槽位解析只【看】不推（advance=false），
//     真正发请求的拦截器推。否则一次请求走两格，每个 Key 被跳过一半。
// ============================================================
(function () {
  'use strict';

  const CONFIG_KEY = 'geminiKeyPoolV1';
  const STATE_KEY = 'geminiKeyPoolStateV1';
  const GEMINI_HOST = 'generativelanguage.googleapis.com';
  const CACHE_TTL_MS = 15000;

  const DEFAULT_CONFIG = {
    enabled: false,          // 总开关：关 = 行为与改造前完全一致
    presetIds: [],           // 池成员 = 勾选的 API 预设 id
    model: '',               // 轮询模型（回显用；真正生效的是主 API 的模型输入框）
    attemptTimeoutMs: 40000, // 单个 Key 多久没反应就换下一个
    totalTimeoutMs: 240000,  // 整轮故障转移上限
    cooldownBaseMs: 60000,   // 失败后冷却基数（越失败越久，指数退避）
    cooldownMaxMs: 600000,   // 冷却封顶 10 分钟
    quarantineMs: 900000     // 401/403 隔离 15 分钟
  };

  // ============================================================
  // 配置
  // ============================================================
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const cfg = Object.assign({}, DEFAULT_CONFIG, (parsed && typeof parsed === 'object') ? parsed : {});
      if (!Array.isArray(cfg.presetIds)) cfg.presetIds = [];
      cfg.presetIds = cfg.presetIds.map(Number).filter(n => !Number.isNaN(n));
      return cfg;
    } catch (e) {
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  function saveConfig(patch) {
    const cfg = Object.assign(loadConfig(), patch || {});
    if (!Array.isArray(cfg.presetIds)) cfg.presetIds = [];
    cfg.presetIds = cfg.presetIds.map(Number).filter(n => !Number.isNaN(n));
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
    invalidatePoolCache();
    return cfg;
  }

  // ============================================================
  // 运行时状态（按 Key 指纹存，不把完整密钥写进 localStorage）
  // ============================================================
  function fingerprint(key) {
    const s = String(key || '');
    if (s.length <= 12) return s.slice(0, 4) + '…';
    return s.slice(0, 6) + '…' + s.slice(-4);
  }

  function loadStates() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveStates(states) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(states || {})); } catch (e) {}
  }

  function getKeyState(fp) {
    const states = loadStates();
    return states[fp] || null;
  }

  function isCooling(fp, now) {
    const s = getKeyState(fp);
    return !!(s && s.coolingUntil && s.coolingUntil > now);
  }

  function isQuarantined(fp, now) {
    const s = getKeyState(fp);
    return !!(s && s.quarantinedUntil && s.quarantinedUntil > now);
  }

  function coolingLeftMs(fp, now) {
    const s = getKeyState(fp);
    if (!s) return 0;
    if (s.quarantinedUntil && s.quarantinedUntil > now) return s.quarantinedUntil - now;
    if (s.coolingUntil && s.coolingUntil > now) return s.coolingUntil - now;
    return 0;
  }

  function clearKeyState(fp) {
    const states = loadStates();
    if (states[fp]) {
      delete states[fp].coolingUntil;
      delete states[fp].quarantinedUntil;
      states[fp].fails = 0;
      states[fp].lastAt = Date.now();
    }
    saveStates(states);
  }

  // ============================================================
  // 池成员（从 API 预设展开）
  // ============================================================
  let poolCache = { keys: [], at: 0, promise: null };

  function invalidatePoolCache() {
    poolCache = { keys: [], at: 0, promise: null };
  }

  function isGeminiNativeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.indexOf('/v1beta/models') >= 0 && url.indexOf('/v1beta/openai') < 0;
  }

  // 谷歌原生地址的标准形态 —— 主槽位被池强制接管时用它
  const GEMINI_NATIVE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  // 池里没选模型、其它线索也指不出一个谷歌模型时的兜底
  const FALLBACK_GEMINI_MODEL = 'gemini-2.5-flash';

  function looksLikeGeminiModel(model) {
    return /gemini/i.test(String(model || ''));
  }

  // 把一个地址说成人话，给「生效范围」那行字用
  function describeChannel(url) {
    const u = String(url || '').trim();
    if (!u) return '没配';
    if (isGeminiNativeUrl(u)) return '谷歌直连';
    const m = u.match(/^https?:\/\/([^/]+)/i);
    return m ? m[1] : u;
  }

  function modelSourceText(src) {
    if (src === 'pool') return '池里选的';
    if (src === 'main') return '跟着主 API 的模型';
    if (src === 'preset') return '来自预设默认模型';
    return '兜底默认';
  }

  async function getPoolKeys() {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.presetIds.length) return [];
    const now = Date.now();
    if (poolCache.keys.length && now - poolCache.at < CACHE_TTL_MS) return poolCache.keys;
    if (!poolCache.promise) {
      poolCache.promise = (async () => {
        try {
          if (typeof db === 'undefined' || !db || !db.apiPresets) {
            poolCache.promise = null;
            return [];
          }
          const presets = await db.apiPresets.toArray();
          const ids = new Set(cfg.presetIds.map(Number));
          const keys = [];
          (presets || []).forEach(p => {
            if (!ids.has(Number(p.id))) return;
            String(p.apiKey || '').split(',').map(s => s.trim()).filter(Boolean).forEach(k => {
              if (!keys.includes(k)) keys.push(k);
            });
          });
          poolCache = { keys: keys, at: Date.now(), promise: null };
          return keys;
        } catch (e) {
          poolCache.promise = null;
          return [];
        }
      })();
    }
    return poolCache.promise;
  }

  // 池成员预设本身（要拿到它们的地址和默认模型，不只是 Key）
  async function getPoolPresets() {
    const cfg = loadConfig();
    if (!cfg.presetIds.length) return [];
    if (typeof db === 'undefined' || !db || !db.apiPresets) return [];
    try {
      const all = await db.apiPresets.toArray();
      const ids = new Set(cfg.presetIds.map(Number));
      return (all || []).filter(p => ids.has(Number(p.id)));
    } catch (e) {
      return [];
    }
  }

  // ============================================================
  // 池开启时主聊天的「强制目标」：地址 + 模型
  // ------------------------------------------------------------
  // 用户 2026-11-26 拍板的语义：
  //   轮询开关打开 → 主聊天直接走谷歌轮询，不管主 API 原来选的是哪个渠道；
  //   轮询开关关闭 → 主 API 走你选择的渠道（老行为一字未改）。
  // 所以池开着的时候，地址和模型都得由池说了算 —— 只换 Key 不换模型会 400
  // （拿 gpt-4o 去打谷歌）。
  // ============================================================
  async function resolvePoolMainTarget(currentModel) {
    const cfg = loadConfig();
    const presets = await getPoolPresets();

    // 地址：池里第一个「谷歌直连」的预设地址；都没有就用官方地址
    let proxyUrl = '';
    for (const p of presets) {
      const u = String((p && p.proxyUrl) || '').trim();
      if (u && isGeminiNativeUrl(u)) { proxyUrl = u; break; }
    }
    if (!proxyUrl) proxyUrl = GEMINI_NATIVE_BASE;

    // 模型：池里选的轮询模型 → 主 API 当前的模型（是 gemini 才认）→ 预设默认模型 → 兜底
    let model = String(cfg.model || '').trim();
    let modelSource = model ? 'pool' : '';
    if (!model) {
      const cur = String(currentModel || '').trim();
      if (looksLikeGeminiModel(cur)) {
        model = cur;
        modelSource = 'main';
      } else {
        for (const p of presets) {
          const dm = String((p && (p.defaultModel || p.model)) || '').trim();
          if (looksLikeGeminiModel(dm)) { model = dm; modelSource = 'preset'; break; }
        }
      }
    }
    if (!model) {
      model = FALLBACK_GEMINI_MODEL;
      modelSource = 'fallback';
    }
    return { proxyUrl: proxyUrl, model: model, modelSource: modelSource };
  }

  // ============================================================
  // Key 选择（顺序轮询 + 跳过冷却/隔离）
  // ------------------------------------------------------------
  // ⚠️ advance=false = 【只看不拿】：返回当前游标位置的可用 Key，但不动游标。
  //   槽位解析用这个模式 —— 因为真正发请求的是 fetch 拦截器，
  //   它自己会 pick 一次并推进游标。两边都推进的话游标一次请求走 2 格，
  //   结果就是【每个 Key 被跳过一半】（10 个 Key 实际只用 5 个）。
  // ============================================================
  function pickHealthyKey(keys, exclude, advance) {
    if (!keys || !keys.length) return null;
    const now = Date.now();
    const states = loadStates();
    const n = keys.length;
    let cursor = Number(states.__cursor) || 0;
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    for (let i = 0; i < n; i++) {
      const idx = (cursor + i) % n;
      const key = keys[idx];
      if (exclude && exclude.has(key)) continue;
      const fp = fingerprint(key);
      if (isQuarantined(fp, now)) continue;
      if (isCooling(fp, now)) continue;
      if (advance !== false) {
        states.__cursor = (idx + 1) % n;
        saveStates(states);
      }
      return key;
    }
    return null;
  }

  function earliestRecoveryDelay(keys) {
    if (!keys || !keys.length) return null;
    const now = Date.now();
    let best = null;
    keys.forEach(k => {
      const left = coolingLeftMs(fingerprint(k), now);
      if (left > 0 && (best === null || left < best)) best = left;
    });
    return best;
  }

  // ============================================================
  // 失败/成功记录
  // ============================================================
  let errorLog = [];

  function pushErrorLog(entry) {
    errorLog.unshift(entry);
    if (errorLog.length > 30) errorLog.pop();
    try { console.warn('[Key池]', entry.status, entry.fingerprint, entry.error); } catch (e) {}
  }

  function reportFailure(key, status, errorText) {
    const cfg = loadConfig();
    const states = loadStates();
    const fp = fingerprint(key);
    const prev = states[fp] || {};
    const fails = (Number(prev.fails) || 0) + 1;
    const now = Date.now();
    const next = {
      fails: fails,
      lastStatus: status || 0,
      lastError: String(errorText || '').slice(0, 600),
      lastAt: now
    };
    if (status === 401 || status === 403) {
      next.quarantinedUntil = now + (Number(cfg.quarantineMs) || DEFAULT_CONFIG.quarantineMs);
    } else {
      const base = Number(cfg.cooldownBaseMs) || DEFAULT_CONFIG.cooldownBaseMs;
      const max = Number(cfg.cooldownMaxMs) || DEFAULT_CONFIG.cooldownMaxMs;
      next.coolingUntil = now + Math.min(base * Math.pow(2, fails - 1), max);
    }
    states[fp] = next;
    saveStates(states);
    pushErrorLog({ at: now, fingerprint: fp, status: status || 0, error: next.lastError });
    return next;
  }

  function reportSuccess(key) {
    const states = loadStates();
    const fp = fingerprint(key);
    const prev = states[fp];
    if (prev) {
      prev.fails = 0;
      prev.coolingUntil = 0;
      prev.lastStatus = 200;
      prev.lastAt = Date.now();
      saveStates(states);
    }
  }

  // ============================================================
  // 错误体解析
  // ============================================================
  function parseGeminiError(bodyText) {
    const text = String(bodyText || '');
    try {
      const data = JSON.parse(text);
      const err = data && data.error;
      if (err) {
        return {
          code: err.code || '',
          status: err.status || '',
          message: err.message || text.slice(0, 300)
        };
      }
    } catch (e) { /* 非 JSON，落到下面 */ }
    return { code: '', status: '', message: text.slice(0, 300) || '未知错误' };
  }

  function buildPoolErrorMessage(keys, tried, status, message) {
    const total = (keys && keys.length) || 0;
    const used = (tried && tried.size) || 0;
    return `API 请求失败: ${status || 0} - ${message || '未知错误'}（Key 池已尝试 ${used}/${total} 个 Key）`;
  }

  // 全部 Key 都在冷却时，最多只等这么久；再久就直接报错告诉用户要等几秒
  const MAX_WAIT_FOR_RECOVERY_MS = 10000;

  function buildAllCoolingMessage(keys, tried, waitMs, status, message) {
    const total = (keys && keys.length) || 0;
    const used = (tried && tried.size) || 0;
    const tail = (waitMs === null || waitMs === undefined)
      ? ''
      : `（全部 Key 冷却中，最近 ${Math.ceil(waitMs / 1000)} 秒后恢复）`;
    return `API 请求失败: ${status || 0} - ${message || '所有 Key 都不可用'}${tail}（Key 池已尝试 ${used}/${total} 个 Key）`;
  }

  function rebuildResponse(response, bodyText) {
    try {
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (e) {
      return response;
    }
  }

  function makeAbortError() {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(makeAbortError()); return; }
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
      function onAbort() { cleanup(); reject(makeAbortError()); }
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }

  function readHeaders(raw) {
    const out = {};
    if (!raw) return out;
    if (typeof raw.forEach === 'function' && typeof raw.get === 'function') {
      raw.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
      return out;
    }
    if (Array.isArray(raw)) {
      raw.forEach(pair => {
        if (!pair) return;
        const k = String(pair[0] || '').toLowerCase();
        if (k) out[k] = pair[1];
      });
      return out;
    }
    if (typeof raw === 'object') {
      Object.keys(raw).forEach(k => { out[String(k).toLowerCase()] = raw[k]; });
    }
    return out;
  }

  // ============================================================
  // 池循环
  // ============================================================
  async function poolFetch(originalFetch, input, init, headers, keys, cfg) {
    const attemptTimeout = Math.max(1000, Number(cfg.attemptTimeoutMs) || DEFAULT_CONFIG.attemptTimeoutMs);
    const totalTimeout = Math.max(attemptTimeout, Number(cfg.totalTimeoutMs) || DEFAULT_CONFIG.totalTimeoutMs);
    const deadline = Date.now() + totalTimeout;
    const tried = new Set();
    const externalSignal = (init && init.signal) || null;
    const bodyReusable = !(init && init.body) || typeof init.body === 'string';

    let lastStatus = 0;
    let lastMessage = '';

    while (Date.now() < deadline) {
      if (externalSignal && externalSignal.aborted) throw makeAbortError();

      const key = pickHealthyKey(keys, tried);
      if (!key) {
        if (!bodyReusable) {
          throw new Error(buildPoolErrorMessage(keys, tried, lastStatus, lastMessage));
        }
        const wait = earliestRecoveryDelay(keys);
        // 只有「马上就恢复」才等一等；否则立刻报错并告诉用户还要等几秒
        if (wait === null || wait > MAX_WAIT_FOR_RECOVERY_MS || Date.now() + wait > deadline) {
          throw new Error(buildAllCoolingMessage(keys, tried, wait, lastStatus, lastMessage));
        }
        await sleep(wait, externalSignal);
        continue;
      }
      tried.add(key);

      const attemptHeaders = Object.assign({}, headers);
      attemptHeaders['x-goog-api-key'] = key;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, attemptTimeout);
      let onExternalAbort = null;
      if (externalSignal) {
        onExternalAbort = () => controller.abort();
        externalSignal.addEventListener('abort', onExternalAbort);
      }

      let response = null;
      try {
        const options = Object.assign({}, init || {}, {
          headers: attemptHeaders,
          signal: controller.signal
        });
        response = await originalFetch(input, options);
      } catch (err) {
        clearTimeout(timer);
        if (onExternalAbort && externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        // 用户主动停止生成 → 原样抛出，不换 Key
        if (externalSignal && externalSignal.aborted) throw err;
        const msg = timedOut
          ? `超时（${Math.round(attemptTimeout / 1000)} 秒无响应）`
          : ((err && err.message) || String(err));
        reportFailure(key, 0, msg);
        lastStatus = 0;
        lastMessage = msg;
        if (!bodyReusable) throw err;
        continue;
      }

      clearTimeout(timer);
      if (onExternalAbort && externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

      if (response.ok) {
        reportSuccess(key);
        return response;
      }

      const status = response.status;
      let bodyText = '';
      try { bodyText = await response.text(); } catch (e) { bodyText = ''; }
      const parsed = parseGeminiError(bodyText);
      lastStatus = status;
      lastMessage = parsed.message;
      reportFailure(key, status, parsed.message || bodyText);

      // 400/404 = 请求本身有问题（模型名写错等），换 Key 也没用，原样交回调用方
      if (status === 400 || status === 404) {
        return rebuildResponse(response, bodyText);
      }

      if (!bodyReusable) {
        return rebuildResponse(response, bodyText);
      }

      if (tried.size >= keys.length) {
        throw new Error(buildPoolErrorMessage(keys, tried, status, parsed.message));
      }
      // 其余状态（401/403/429/5xx/网络错）→ 换下一个 Key
    }

    throw new Error(buildPoolErrorMessage(keys, tried, lastStatus, lastMessage));
  }

  // ============================================================
  // fetch 拦截器
  // ============================================================
  // 关键约束：本项目里 js/mcp-tool-bridge.js 也会包装 window.fetch。
  //   · 加载顺序：deferred 脚本先跑（本文件），DOMContentLoaded 之后 bridge 才装 hook
  //     → 所以本拦截器在链底，bridge 在链顶：应用请求 → bridge → 池 → 原生 fetch，
  //       bridge 内部自己发的请求也走池，故障转移对两条路都生效。
  //   · 绝不能在 bridge 之后再套一层：bridge 捕获的 originalFetch 就是本包装，
  //     再套一层会变成 池→bridge→池→bridge… 死循环。
  // 所以这里的规则是「只在链底装一次；发现别人叠在我们上面就保持现状」。
  // ============================================================
  let poolWrapper = null;
  let poolBaseFetch = null;
  let firstInstallBase = null;

  function installInterceptor() {
    if (typeof window.fetch !== 'function') return;
    if (!poolWrapper) {
      poolWrapper = async function (input, init) {
        const url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (!url || url.indexOf(GEMINI_HOST) < 0) {
          return await poolBaseFetch(input, init);
        }
        const cfg = loadConfig();
        if (!cfg.enabled) {
          return await poolBaseFetch(input, init);
        }
        // [2026-11-26] 「拉取模型」这条路自己负责逐个 Key 试 + 准确记谁失败，
        // 所以给它开了个旁路 —— 否则内层循环和拦截器各换一轮 Key，
        // 失败归属就乱了（同一次失败被记两遍，退避翻倍过快）。
        if (window.__geminiKeyPoolBypass) {
          return await poolBaseFetch(input, init);
        }
        // Request 对象（body 不可重用）不参与故障转移
        if (typeof Request !== 'undefined' && input instanceof Request) {
          return await poolBaseFetch(input, init);
        }
        const headers = readHeaders(init && init.headers);
        const requestKey = headers['x-goog-api-key'];
        if (!requestKey) {
          return await poolBaseFetch(input, init);
        }
        const keys = await getPoolKeys();
        if (!keys.length || keys.indexOf(requestKey) < 0) {
          return await poolBaseFetch(input, init);
        }
        return await poolFetch(poolBaseFetch, input, init, headers, keys, cfg);
      };
    }
    if (window.fetch === poolWrapper) return;
    // 已经有人在链里叠在我们上面（典型：MCP bridge）→ 保持现状，别再套一层
    if (poolBaseFetch && window.fetch !== firstInstallBase) return;
    poolBaseFetch = window.fetch.bind(window);
    if (!firstInstallBase) firstInstallBase = window.fetch;
    window.fetch = poolWrapper;
    window.__geminiKeyPoolInterceptorInstalled = true;
  }

  // ============================================================
  // 供槽位解析使用：池开启时给槽位下发 Key（主槽位还会被强制改地址/模型）
  // ============================================================
  async function getSlotKeyOverride(ctx) {
    const cfg = loadConfig();
    if (!cfg.enabled) return null;
    const info = ctx || {};
    const keys = await getPoolKeys();
    if (!keys.length) return null;

    // ---- 主槽位：池开启 = 主聊天【强制】走谷歌直连轮询 ----
    // 语义（用户 2026-11-26 拍板）：
    //   开关打开 → 主聊天直接走谷歌轮询，不管主 API 原来选的是哪个渠道；
    //   开关关闭 → 主 API 走你选择的渠道（这里直接 return null，老行为一字未改）。
    // 地址 + 模型一起换：只换 Key 不换模型会 400（拿 gpt-4o 去打谷歌）。
    if (info.slot === 'main') {
      const target = await resolvePoolMainTarget(info.currentModel || '');
      const key = pickHealthyKey(keys, null, false);
      return {
        key: key || keys[0],
        poolSize: keys.length,
        proxyUrl: target.proxyUrl,
        model: target.model,
        modelSource: target.modelSource,
        forced: true
      };
    }

    // ---- 其它槽位（副 API / 后台 / 识图 / 情侣空间）----
    // 只有「自己走谷歌直连 + 自己的 Key 已在池里」才接管；
    // 走别的渠道的、或 Key 不在池里的，保持自己的原样，不被硬塞。
    if (!isGeminiNativeUrl(info.proxyUrl)) return null;
    const own = String(info.ownApiKey || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!own.length || !own.some(k => keys.indexOf(k) >= 0)) return null;
    const key = pickHealthyKey(keys, null, false);
    return { key: key || keys[0], poolSize: keys.length };
  }

  // ============================================================
  // 设置页 UI
  // ============================================================
  const UI = {
    bound: false,

    init() {
      if (this.bound) return;
      const enabledEl = document.getElementById('gemini-pool-enabled');
      if (!enabledEl) return;
      this.bound = true;

      enabledEl.addEventListener('change', () => {
        saveConfig({ enabled: !!enabledEl.checked });
        this.refresh();
        if (typeof showToast === 'function') {
          showToast(enabledEl.checked ? 'Key 池已启用' : 'Key 池已关闭', 'success');
        }
      });

      const attemptEl = document.getElementById('gemini-pool-attempt-timeout');
      const totalEl = document.getElementById('gemini-pool-total-timeout');
      const coolEl = document.getElementById('gemini-pool-cooldown');
      [attemptEl, totalEl, coolEl].forEach(el => {
        if (!el) return;
        el.addEventListener('change', () => {
          const patch = {};
          if (attemptEl) patch.attemptTimeoutMs = Math.max(5, Number(attemptEl.value) || 40) * 1000;
          if (totalEl) patch.totalTimeoutMs = Math.max(10, Number(totalEl.value) || 240) * 1000;
          if (coolEl) patch.cooldownBaseMs = Math.max(5, Number(coolEl.value) || 60) * 1000;
          saveConfig(patch);
          this.refresh();
        });
      });

      const fetchBtn = document.getElementById('gemini-pool-fetch-models-btn');
      if (fetchBtn) {
        fetchBtn.addEventListener('click', () => this.fetchModels(fetchBtn));
      }

      const modelSel = document.getElementById('gemini-pool-model-select');
      if (modelSel) {
        modelSel.addEventListener('change', () => {
          if (modelSel.value) this.applyModel(modelSel.value);
        });
      }

      const errToggle = document.getElementById('gemini-pool-error-toggle');
      if (errToggle) {
        errToggle.addEventListener('click', () => {
          const box = document.getElementById('gemini-pool-error-log');
          if (box) box.style.display = (box.style.display === 'none' || !box.style.display) ? 'block' : 'none';
        });
      }

      // ---- 池成员：多选下拉（触发按钮 + 浮层勾选框） ----
      const trigger = document.getElementById('gemini-pool-preset-trigger');
      if (trigger) {
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          this.togglePanel();
        });
      }
      document.addEventListener('click', (e) => {
        const panel = document.getElementById('gemini-pool-preset-panel');
        if (!panel || panel.style.display === 'none' || !panel.style.display) return;
        const multi = document.getElementById('gemini-pool-multi');
        if (multi && multi.contains(e.target)) return;
        this.togglePanel(false);
      });

      const allBtn = document.getElementById('gemini-pool-select-all');
      if (allBtn) {
        allBtn.addEventListener('click', () => {
          saveConfig({ presetIds: (this._nativeIds || []).slice() });
          this.renderPresetList(loadConfig());
          this.renderStatus(loadConfig());
        });
      }
      const noneBtn = document.getElementById('gemini-pool-select-none');
      if (noneBtn) {
        noneBtn.addEventListener('click', () => {
          saveConfig({ presetIds: [] });
          this.renderPresetList(loadConfig());
          this.renderStatus(loadConfig());
        });
      }

      this.refresh();
    },

    togglePanel(force) {
      const panel = document.getElementById('gemini-pool-preset-panel');
      const trigger = document.getElementById('gemini-pool-preset-trigger');
      if (!panel) return;
      const isOpen = !(panel.style.display === 'none' || !panel.style.display);
      const open = (typeof force === 'boolean') ? force : !isOpen;
      panel.style.display = open ? 'block' : 'none';
      if (trigger) trigger.classList.toggle('open', open);
    },

    updateSummary() {
      const el = document.getElementById('gemini-pool-preset-summary');
      if (!el) return;
      const ids = loadConfig().presetIds.map(Number);
      const map = this._presetNameMap || {};
      const names = ids.map(id => map[id] || ('#' + id));
      if (!names.length) {
        el.textContent = '未选择预设（点开挑）';
        el.title = '';
        return;
      }
      const short = names.length <= 3
        ? names.join('、')
        : (names.slice(0, 2).join('、') + '…');
      el.textContent = '已选 ' + names.length + ' 个预设（' + short + '）';
      el.title = names.join('、');
    },

    async refresh() {
      const cfg = loadConfig();
      const enabledEl = document.getElementById('gemini-pool-enabled');
      if (enabledEl) enabledEl.checked = !!cfg.enabled;

      const attemptEl = document.getElementById('gemini-pool-attempt-timeout');
      if (attemptEl) attemptEl.value = Math.round((cfg.attemptTimeoutMs || 40000) / 1000);
      const totalEl = document.getElementById('gemini-pool-total-timeout');
      if (totalEl) totalEl.value = Math.round((cfg.totalTimeoutMs || 240000) / 1000);
      const coolEl = document.getElementById('gemini-pool-cooldown');
      if (coolEl) coolEl.value = Math.round((cfg.cooldownBaseMs || 60000) / 1000);

      await this.renderPresetList(cfg);
      this.renderModelSelect(cfg);
      await this.renderScope(cfg);
      this.renderStatus(cfg);
      this.renderErrorLog();
    },

    // 池到底在给谁干活 —— 开着池却没人走池，是最容易懵的情况，必须写出来
    async renderScope(cfg) {
      const box = document.getElementById('gemini-pool-scope');
      if (!box) return;
      const SLOTS = [
        { name: '副 API', slot: 'secondary' },
        { name: '后台', slot: 'background' },
        { name: '识图', slot: 'vision' },
        { name: '情侣空间', slot: 'couplespace' }
      ];
      const resolver = (typeof window !== 'undefined') ? window.resolveApiSlotConfig : null;
      if (typeof resolver !== 'function') {
        box.textContent = '（读不到功能位配置）';
        return;
      }
      const keys = await getPoolKeys();
      const lines = [];

      // 主 API 你自己选的是什么（池关掉时走的就是它）
      let mainRaw = null;
      try { mainRaw = await resolver('main', { applyPool: false }); } catch (e) { /* 读不到就跳过 */ }
      const mainName = describeChannel(mainRaw && mainRaw.proxyUrl);

      if (!cfg.enabled) {
        lines.push('🔕 池已关闭 —— 主 API 走你自己选的渠道（' + mainName + '），所有功能位都按各自的预设走。');
        lines.push('打开上面的开关，主聊天就会改成走谷歌直连轮询。');
        box.textContent = lines.join('\n');
        return;
      }

      if (!keys.length) {
        lines.push('⚠️ 池已开启，但一个预设都没勾 —— 没有可轮询的 Key。');
        lines.push('在下面「池成员」里勾几个谷歌直连的站点预设，主聊天就会走它们轮询。');
        box.textContent = lines.join('\n');
        return;
      }

      const target = await resolvePoolMainTarget(mainRaw ? mainRaw.model : '');
      lines.push('✅ 池已开启 —— 主聊天【强制走谷歌直连轮询】：' + keys.length +
        ' 个 Key 轮着来，模型 ' + target.model + '（' + modelSourceText(target.modelSource) + '）。');
      if (mainRaw && mainRaw.proxyUrl && !isGeminiNativeUrl(mainRaw.proxyUrl)) {
        lines.push('你给主 API 选的「' + mainName + '」现在不生效（池开着就以池为准），关掉池自动切回去。');
      }
      if (!looksLikeGeminiModel(target.model)) {
        lines.push('⚠️ 模型「' + target.model + '」不是 gemini-* 的名字，谷歌大概率报 400 —— 点「拉取模型」换一个。');
      }

      const others = [];
      for (const s of SLOTS) {
        try {
          const r = await resolver(s.slot, { applyPool: false });
          if (!r || !r.proxyUrl) continue;
          if (!isGeminiNativeUrl(r.proxyUrl)) {
            others.push(s.name + '（走自己的渠道，不参与轮询）');
            continue;
          }
          const own = String(r.apiKey || '').split(',').map(x => x.trim()).filter(Boolean);
          if (own.some(k => keys.indexOf(k) >= 0)) others.push(s.name + '（Key 在池里 → 走轮询）');
          else others.push(s.name + '（Key 不在池里 → 用自己的）');
        } catch (e) { /* 读不到就跳过 */ }
      }
      if (others.length) lines.push('其它功能位：' + others.join('；') + '。');
      lines.push('影院 / 读书屋的聊天也走主 API，所以同样吃这个轮询。');
      box.textContent = lines.join('\n');
    },

    renderModelSelect(cfg) {
      const sel = document.getElementById('gemini-pool-model-select');
      if (!sel) return;
      // 已经拉过模型列表就别覆盖（用户可能正在挑）
      if (sel.dataset.filled === '1') return;
      sel.innerHTML = '';
      const cur = String(cfg.model || '').trim();
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = cur || '（没选 → 自动用主 API 的模型）';
      sel.appendChild(opt);
      sel.value = cur;
    },

    async renderPresetList(cfg) {
      const box = document.getElementById('gemini-pool-preset-list');
      if (!box) return;
      box.innerHTML = '';
      let presets = [];
      try {
        if (typeof db === 'undefined' || !db || !db.apiPresets) return;
        presets = await db.apiPresets.toArray();
      } catch (e) {
        box.textContent = '读取预设失败：' + (e && e.message ? e.message : e);
        return;
      }
      const usable = (presets || [])
        .filter(p => p.proxyUrl && p.apiKey)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

      this._presetNameMap = {};
      this._nativeIds = [];
      usable.forEach(p => {
        this._presetNameMap[Number(p.id)] = p.name || ('预设 #' + p.id);
        if (isGeminiNativeUrl(p.proxyUrl)) this._nativeIds.push(Number(p.id));
      });

      const selected = new Set((cfg.presetIds || []).map(Number));
      if (!usable.length) {
        box.textContent = '还没有可用的 API 预设。请先在上面「API 站点预设库」里新建几个（每个预设填一个谷歌直连地址和一个 Key）。';
        this.updateSummary();
        return;
      }

      usable.forEach(p => {
        const row = document.createElement('label');
        row.className = 'gemini-pool-preset-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(Number(p.id));
        const native = isGeminiNativeUrl(p.proxyUrl);

        cb.addEventListener('change', () => {
          const next = new Set(loadConfig().presetIds.map(Number));
          if (cb.checked) next.add(Number(p.id));
          else next.delete(Number(p.id));
          saveConfig({ presetIds: Array.from(next) });
          this.updateSummary();
          this.renderStatus(loadConfig());
        });

        const name = document.createElement('span');
        name.className = 'gemini-pool-preset-name';
        name.textContent = p.name || `预设 #${p.id}`;

        const info = document.createElement('span');
        info.className = 'gemini-pool-preset-info';
        info.textContent = native
          ? fingerprint(String(p.apiKey).split(',')[0].trim())
          : '非谷歌直连地址，不会被池接管';

        row.appendChild(cb);
        row.appendChild(name);
        row.appendChild(info);
        box.appendChild(row);
      });
      this.updateSummary();
    },

    renderStatus(cfg) {
      const box = document.getElementById('gemini-pool-status-list');
      if (!box) return;
      box.innerHTML = '';
      getPoolKeys().then(keys => {
        box.innerHTML = '';
        if (!keys.length) {
          box.textContent = cfg.enabled ? '池已开启但还没勾选任何预设。' : '池未启用。';
          return;
        }
        const now = Date.now();
        keys.forEach(key => {
          const fp = fingerprint(key);
          const st = getKeyState(fp);
          const row = document.createElement('div');
          row.className = 'gemini-pool-status-row';

          let text = '可用';
          if (isQuarantined(fp, now)) {
            const s = getKeyState(fp);
            text = `已隔离（${s.lastStatus || 401/403}），还剩 ${Math.ceil((s.quarantinedUntil - now) / 1000)} 秒`;
          } else if (isCooling(fp, now)) {
            const left = coolingLeftMs(fp, now);
            text = `冷却中，还剩 ${Math.ceil(left / 1000)} 秒`;
          } else if (st && st.lastStatus) {
            text = `可用（上次 ${st.lastStatus}）`;
          }

          const label = document.createElement('span');
          label.textContent = `${fp} — ${text}`;
          row.appendChild(label);

          if (coolingLeftMs(fp, now) > 0) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-mini-btn';
            btn.textContent = '立即恢复';
            btn.addEventListener('click', () => {
              clearKeyState(fp);
              this.renderStatus(loadConfig());
            });
            row.appendChild(btn);
          }
          box.appendChild(row);
        });
      });
    },

    renderErrorLog() {
      const box = document.getElementById('gemini-pool-error-log');
      if (!box) return;
      box.innerHTML = '';
      if (!errorLog.length) {
        box.textContent = '暂无错误记录。';
        return;
      }
      errorLog.forEach(e => {
        const time = new Date(e.at).toLocaleTimeString();
        const row = document.createElement('div');
        row.className = 'gemini-pool-error-row';
        row.textContent = `[${time}] ${e.fingerprint} → ${e.status} ${e.error}`;
        box.appendChild(row);
      });
    },

    async applyModel(model) {
      saveConfig({ model: model });
      // ⚠️ 池的模型和主 API 的模型现在是【两套】：
      //   池开着 → 主聊天用池的模型；池关掉 → 主聊天用主 API 的模型。
      // 所以这里【不】再往 #model-input / state.apiConfig.model 写 ——
      // 写了的话，池一关主 API 还停在 gemini 模型上（打中转站必 400）。
      this.refresh();
      if (typeof showToast === 'function') {
        showToast('轮询模型已设为：' + model + '（只影响 Key 池，不改主 API 的模型）', 'success');
      }
    },

    async fetchModels(btn) {
      const sel = document.getElementById('gemini-pool-model-select');
      const keys = await getPoolKeys();
      if (!keys.length) {
        if (typeof showToast === 'function') showToast('池里还没有勾选任何预设', 'error');
        return;
      }
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '拉取中…';
      let lastMsg = '';
      try {
        // 顺序：池列表原序，但【正在冷却/隔离的 Key 往后排】——
        // 免得每次都先撞那个刚坏掉的。
        const now = Date.now();
        const busy = (k) => isCooling(fingerprint(k), now) || isQuarantined(fingerprint(k), now);
        const ordered = keys.slice().sort((a, b) => (busy(a) ? 1 : 0) - (busy(b) ? 1 : 0));

        for (const key of ordered) {
          try {
            // 旁路池的故障转移：本循环自己逐个试，失败归属才准
            window.__geminiKeyPoolBypass = true;
            let resp;
            try {
              resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
                method: 'GET',
                headers: { 'x-goog-api-key': key }
              });
            } finally {
              window.__geminiKeyPoolBypass = false;
            }
            if (!resp.ok) {
              const body = await resp.text().catch(() => '');
              const parsed = parseGeminiError(body);
              reportFailure(key, resp.status, parsed.message || body);
              lastMsg = `${fingerprint(key)} → ${resp.status} ${parsed.message || ''}`;
              continue;
            }
            const data = await resp.json();
            const list = (data.models || [])
              .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.indexOf('generateContent') >= 0)
              .map(m => String(m.name || '').replace(/^models\//, ''))
              .filter(Boolean)
              .sort();
            reportSuccess(key);
            if (sel) {
              sel.innerHTML = '';
              list.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                sel.appendChild(opt);
              });
              sel.dataset.filled = '1';
              const cfg = loadConfig();
              if (cfg.model && list.indexOf(cfg.model) >= 0) sel.value = cfg.model;
            }
            if (typeof showToast === 'function') {
              showToast(`已从 ${fingerprint(key)} 拉取 ${list.length} 个模型`, 'success');
            }
            return;
          } catch (e) {
            reportFailure(key, 0, (e && e.message) || String(e));
            lastMsg = `${fingerprint(key)} → ${(e && e.message) || String(e)}`;
          }
        }
        if (typeof showToast === 'function') {
          showToast(`${ordered.length} 个 Key 全部拉取失败。最近错误：${lastMsg}`, 'error');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  };

  // ============================================================
  // 对外接口
  // ============================================================
  window.GeminiKeyPool = {
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    getPoolKeys: getPoolKeys,
    invalidatePoolCache: invalidatePoolCache,
    getSlotKeyOverride: getSlotKeyOverride,
    getErrorLog: () => errorLog.slice(),
    clearKeyState: clearKeyState,
    fingerprint: fingerprint,
    installInterceptor: installInterceptor
  };
  window.GeminiKeyPoolUI = UI;

  installInterceptor();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UI.init());
  } else {
    UI.init();
  }
})();

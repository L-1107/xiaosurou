// ============================================================
// 谷歌直连 Key 池：多 Key 轮询 + 失败自动换 Key + 超时上限
// [2026-11-26] v0.1.0 第一版只做 Key 轮询；模型轮询等 Key 轮询跑通再加
//
// 设计要点：
//  1. 池成员 = 用户在设置页勾选的「API 预设」（一个预设一个 Key），不手填 Key。
//  2. 池开启时只接管「谷歌直连地址 + 用主 API 预设」的槽位，其余槽位原样放行。
//  3. 故障转移靠 fetch 拦截器实现 —— 全部 Gemini 调用点（100 处 / 19 文件）
//     都是非流式的 `fetch(geminiConfig.url, geminiConfig.data)`，
//     拦截器改 header 里的 x-goog-api-key 即可，调用点一行都不用改。
//     因为是「拿完整 body 才渲染」，换 Key 重试绝不会重复输出。
//  4. 总开关关闭时，拦截器只放行不重试 —— 行为与改造前完全一致，可一键回退。
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

  // ============================================================
  // Key 选择（顺序轮询 + 跳过冷却/隔离）
  // ============================================================
  function pickHealthyKey(keys, exclude) {
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
      states.__cursor = (idx + 1) % n;
      saveStates(states);
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
  // 供槽位解析使用：池开启时给主槽位下发一个当前可用的 Key
  // ============================================================
  async function getSlotKeyOverride(ctx) {
    const cfg = loadConfig();
    if (!cfg.enabled) return null;
    const info = ctx || {};
    if (!isGeminiNativeUrl(info.proxyUrl)) return null;
    if (!info.presetId || info.presetId !== info.mainPresetId) return null;
    const keys = await getPoolKeys();
    if (!keys.length) return null;
    const key = pickHealthyKey(keys, null);
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

      this.refresh();
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
      this.renderStatus(cfg);
      this.renderErrorLog();
    },

    renderModelSelect(cfg) {
      const sel = document.getElementById('gemini-pool-model-select');
      if (!sel) return;
      // 已经拉过模型列表就别覆盖（用户可能正在挑）
      if (sel.dataset.filled === '1') return;
      sel.innerHTML = '';
      const cur = String(cfg.model
        || (typeof state !== 'undefined' && state.apiConfig && state.apiConfig.model)
        || '').trim();
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = cur || '（点右边「拉取模型」选一个）';
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

      if (!usable.length) {
        box.textContent = '还没有可用的 API 预设。请先在上面「API 站点预设库」里新建几个（每个预设填一个谷歌直连地址和一个 Key）。';
        return;
      }

      const selected = new Set((cfg.presetIds || []).map(Number));
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
      const input = document.getElementById('model-input');
      if (input) input.value = model;
      try {
        if (typeof state !== 'undefined' && state.apiConfig) {
          state.apiConfig.model = model;
          if (typeof db !== 'undefined' && db && db.apiConfig) {
            await db.apiConfig.put(state.apiConfig);
          }
        }
      } catch (e) { /* 存失败不影响本次使用 */ }
      if (typeof showToast === 'function') {
        showToast(`轮询模型已设为：${model}`, 'success');
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
      try {
        for (const key of keys) {
          try {
            const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
              method: 'GET',
              headers: { 'x-goog-api-key': key }
            });
            if (!resp.ok) {
              const body = await resp.text().catch(() => '');
              const parsed = parseGeminiError(body);
              reportFailure(key, resp.status, parsed.message || body);
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
              showToast(`已拉取 ${list.length} 个模型`, 'success');
            }
            return;
          } catch (e) {
            reportFailure(key, 0, (e && e.message) || String(e));
          }
        }
        if (typeof showToast === 'function') {
          showToast(`${keys.length} 个 Key 全部拉取失败，详见「最近错误」`, 'error');
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

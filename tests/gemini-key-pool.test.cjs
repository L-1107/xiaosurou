// ============================================================
// tests/gemini-key-pool.test.cjs
// 谷歌直连 Key 池：多 Key 轮询 + 失败自动换 Key + 超时上限
//
// 跑法: node tests/gemini-key-pool.test.cjs
//
// 【背景】(2026-11-26)
//   用户的谷歌直连 503 极其频繁，且每个 key 报错后要「歇一阵」才能再用，
//   手动在预设之间来回切太麻烦（10 个 key）。
//   根因：modules/ai-response.js:1069 用 getRandomValue(apiKey) 随机抽一个 key，
//   抽到坏 key 就直接 throw，没有任何重试/换 key/失败记忆。
//
// 【本测试守着什么】
//   ① 池关闭 → 行为与改造前完全一致（只发一次、header 原样、错误照抛）
//   ② 503 → 自动换下一个 key，直到成功
//   ③ 401/403 → 隔离该 key，之后的请求直接跳过它
//   ④ 单个 key 超时 → 换下一个
//   ⑤ 用户主动停止（AbortError）→ 不换 key，原样抛出
//   ⑥ 400 → 请求本身有问题，不换 key，且 body 仍能读出来
//   ⑦ 全部 key 都在冷却 → 报错并说明还要等几秒
//   ⑧ 槽位解析：池开启时主槽位拿到池里的 key；关掉时拿预设原 key
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const POOL_PATH = path.join(ROOT, 'modules', 'gemini-key-pool.js');
const PRESETS_MODULE_PATH = path.join(ROOT, 'modules', 'api-endpoint-presets.js');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_CHAT = GEMINI_BASE + '/gemini-2.5-flash:generateContent';

const KEY_A = 'AIzaTESTAAAA0000000000000000AAAAAA';
const KEY_B = 'AIzaTESTBBBB1111111111111111BBBBB';
const KEY_C = 'AIzaTESTCCCC2222222222222222CCCCC';

let passed = 0;
let failed = 0;
function ok(name, detail) {
  passed++;
  console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''));
}
function fail(name, detail) {
  failed++;
  console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''));
}
function check(name, cond, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

// ============================================================
// 沙箱零件
// ============================================================
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

function makeFetchStub(handlers) {
  const calls = [];
  const stub = async function (input, init) {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    const raw = (init && init.headers) || {};
    const headers = {};
    if (raw && typeof raw.forEach === 'function' && typeof raw.get === 'function') {
      raw.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
    } else {
      Object.keys(raw || {}).forEach(k => { headers[String(k).toLowerCase()] = raw[k]; });
    }
    const key = headers['x-goog-api-key'];
    calls.push({ url, key, headers, init });

    const h = (handlers[key] !== undefined) ? handlers[key] : handlers['*'];
    if (!h) {
      throw new Error('stub: 没有为 ' + key + ' 准备响应');
    }
    if (h.hang) {
      // 一直不返回，直到被 abort
      return await new Promise((resolve, reject) => {
        const signal = init && init.signal;
        const onAbort = () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort);
        }
      });
    }
    if (h.networkError) {
      throw new Error('模拟网络错误');
    }
    const status = h.status || 200;
    const body = (h.body !== undefined)
      ? h.body
      : JSON.stringify(status === 200
        ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
        : { error: { code: status, message: h.message || ('模拟 ' + status), status: h.statusText || 'UNAVAILABLE' } });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
  stub.calls = calls;
  return stub;
}

function makeSandbox(opts) {
  const options = opts || {};
  const presets = new Map(options.presets || []);
  const storage = makeLocalStorage();
  const fetchStub = makeFetchStub(options.handlers || {});

  const db = {
    apiPresets: {
      async get(id) { return presets.get(Number(id)); },
      async toArray() { return Array.from(presets.values()); },
    },
    apiConfig: {
      async get() { return undefined; },
      async put() { },
    },
  };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Promise: Promise,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    Set: Set,
    Map: Map,
    RegExp: RegExp,
    Error: Error,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    AbortController: AbortController,
    Request: Request,
    Response: Response,
    Headers: Headers,
    localStorage: storage,
    fetch: fetchStub,
    document: {
      readyState: 'complete',
      addEventListener: () => { },
      getElementById: () => null,
      createElement: () => ({ value: '', textContent: '', appendChild() { }, options: [] }),
    },
    state: options.state || { apiConfig: {}, globalSettings: {} },
    db: db,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(POOL_PATH, 'utf8'), sandbox, { filename: 'gemini-key-pool.js' });
  if (options.loadPresetsModule) {
    vm.runInContext(fs.readFileSync(PRESETS_MODULE_PATH, 'utf8'), sandbox, { filename: 'api-endpoint-presets.js' });
  }
  return { sandbox, presets, storage, fetchStub };
}

function geminiFetch(sandbox, key, extra) {
  const init = Object.assign({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  }, extra || {});
  return sandbox.window.fetch(GEMINI_CHAT, init);
}

const PRESET_A = { id: 1, name: '谷歌A', proxyUrl: GEMINI_BASE, apiKey: KEY_A, defaultModel: 'gemini-2.5-flash' };
const PRESET_B = { id: 2, name: '谷歌B', proxyUrl: GEMINI_BASE, apiKey: KEY_B, defaultModel: 'gemini-2.5-flash' };
const PRESET_C = { id: 3, name: '谷歌C', proxyUrl: GEMINI_BASE, apiKey: KEY_C, defaultModel: 'gemini-2.5-flash' };

function enablePool(sandbox, presetIds, extra) {
  return sandbox.window.GeminiKeyPool.saveConfig(Object.assign({
    enabled: true,
    presetIds: presetIds,
    attemptTimeoutMs: 1000,
    totalTimeoutMs: 8000,
    cooldownBaseMs: 200,
    cooldownMaxMs: 600000,
    quarantineMs: 900000,
  }, extra || {}));
}

// ============================================================
// 用例
// ============================================================
async function main() {
  console.log('========================================');
  console.log(' 谷歌直连 Key 池 · 故障转移回归测试');
  console.log('========================================');

  // ------------------------------------------------------------
  section('① 池关闭 → 行为跟改造前完全一致');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: { [KEY_A]: { status: 503, message: 'boom' } },
    });
    let resp = null;
    let err = null;
    try {
      resp = await geminiFetch(sandbox, KEY_A);
    } catch (e) { err = e; }
    check('池关闭时只发 1 次请求', fetchStub.calls.length === 1, 'calls=' + fetchStub.calls.length);
    check('池关闭时 header 原样带 keyA', fetchStub.calls[0] && fetchStub.calls[0].key === KEY_A);
    // 注意：fetch 本身不会因为 503 抛错（是调用点 response.ok 判断后自己抛），
    // 所以这里要验的是「响应原样返回，池没插手」。
    check('池关闭时 503 响应原样返回', resp && resp.status === 503 && resp.ok === false,
      resp ? ('status=' + resp.status) : 'err=' + (err && err.message));
    check('池关闭时池没有记录任何错误', sandbox.window.GeminiKeyPool.getErrorLog().length === 0,
      'logs=' + sandbox.window.GeminiKeyPool.getErrorLog().length);
  }

  // ------------------------------------------------------------
  section('② 503 → 自动换下一个 key，直到成功');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { status: 503, message: 'The model is overloaded' },
        [KEY_B]: { status: 200 },
      },
    });
    enablePool(sandbox, [1, 2]);
    const resp = await geminiFetch(sandbox, KEY_A);
    check('发了 2 次（第 1 次 keyA 失败，第 2 次换 keyB）', fetchStub.calls.length === 2, 'calls=' + fetchStub.calls.length);
    check('第 1 次用 keyA', fetchStub.calls[0] && fetchStub.calls[0].key === KEY_A);
    check('第 2 次换成 keyB', fetchStub.calls[1] && fetchStub.calls[1].key === KEY_B);
    check('最终拿到成功响应', resp && resp.ok === true);
  }

  // ------------------------------------------------------------
  section('③ 连续多个 key 都报错 → 挨个试到成功');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B], [3, PRESET_C]],
      handlers: {
        [KEY_A]: { status: 503, message: '503 a' },
        [KEY_B]: { status: 429, message: '429 b' },
        [KEY_C]: { status: 200 },
      },
    });
    enablePool(sandbox, [1, 2, 3]);
    const resp = await geminiFetch(sandbox, KEY_A);
    check('试了 3 次才成功', fetchStub.calls.length === 3, 'calls=' + fetchStub.calls.length);
    check('依次是 A → B → C',
      fetchStub.calls[0].key === KEY_A && fetchStub.calls[1].key === KEY_B && fetchStub.calls[2].key === KEY_C);
    check('最终成功', resp && resp.ok === true);
  }

  // ------------------------------------------------------------
  section('④ 401 → 隔离该 key，之后的请求直接跳过它');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { status: 401, message: 'API key not valid' },
        [KEY_B]: { status: 200 },
      },
    });
    enablePool(sandbox, [1, 2]);
    const r1 = await geminiFetch(sandbox, KEY_A);
    check('第一次：keyA 401 → 换 keyB 成功', fetchStub.calls.length === 2 && r1.ok === true);

    const r2 = await geminiFetch(sandbox, KEY_A);
    check('第二次请求直接跳过被隔离的 keyA', fetchStub.calls.length === 3 && fetchStub.calls[2].key === KEY_B,
      'calls=' + fetchStub.calls.length + ' 第3次key=' + (fetchStub.calls[2] && fetchStub.calls[2].key));
    check('第二次也成功', r2 && r2.ok === true);
  }

  // ------------------------------------------------------------
  section('⑤ 单个 key 一直没反应 → 超时后换下一个');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { hang: true },
        [KEY_B]: { status: 200 },
      },
    });
    enablePool(sandbox, [1, 2], { attemptTimeoutMs: 1000, totalTimeoutMs: 8000 });
    const t0 = Date.now();
    const resp = await geminiFetch(sandbox, KEY_A);
    const cost = Date.now() - t0;
    check('超时后换了 key 并成功', resp && resp.ok === true, '耗时 ' + cost + 'ms');
    check('确实等到了超时才换（>=900ms）', cost >= 900, 'cost=' + cost);
    check('发了 2 次', fetchStub.calls.length === 2, 'calls=' + fetchStub.calls.length);
  }

  // ------------------------------------------------------------
  section('⑥ 用户主动停止生成 → 不换 key，原样抛 AbortError');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { hang: true },
        [KEY_B]: { status: 200 },
      },
    });
    enablePool(sandbox, [1, 2]);
    const ctrl = new AbortController();
    const p = geminiFetch(sandbox, KEY_A, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 60);
    let err = null;
    try { await p; } catch (e) { err = e; }
    check('抛的是 AbortError', !!err && err.name === 'AbortError', err ? (err.name + ': ' + err.message) : '没抛错');
    check('没有换 key（只发 1 次）', fetchStub.calls.length === 1, 'calls=' + fetchStub.calls.length);
  }

  // ------------------------------------------------------------
  section('⑦ 400（请求本身有问题）→ 不换 key，body 仍能读');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { status: 400, message: '模型名不存在' },
        [KEY_B]: { status: 200 },
      },
    });
    enablePool(sandbox, [1, 2]);
    const resp = await geminiFetch(sandbox, KEY_A);
    check('没有换 key（只发 1 次）', fetchStub.calls.length === 1, 'calls=' + fetchStub.calls.length);
    check('状态码原样传回 400', resp && resp.status === 400, 'status=' + (resp && resp.status));
    check('response.ok === false', resp && resp.ok === false);
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    check('body 还能被读出来（调用点的 json() 不炸）', !!data && data.error && data.error.message === '模型名不存在',
      JSON.stringify(data));
  }

  // ------------------------------------------------------------
  section('⑧ 全部 key 都 503 → 报错并说明已试了几个');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { status: 503, message: '503 a' },
        [KEY_B]: { status: 503, message: '503 b' },
      },
    });
    enablePool(sandbox, [1, 2]);
    let err = null;
    try { await geminiFetch(sandbox, KEY_A); } catch (e) { err = e; }
    check('抛错了', !!err, err ? err.message : '没抛错');
    check('错误信息带上「已尝试 2/2」', !!err && err.message.indexOf('Key 池已尝试 2/2') >= 0, err ? err.message : '');
    check('错误信息保持原来的「API 请求失败: 503」前缀', !!err && err.message.indexOf('API 请求失败: 503') >= 0);
    check('两个 key 都试过了', fetchStub.calls.length === 2, 'calls=' + fetchStub.calls.length);
  }

  // ------------------------------------------------------------
  section('⑨ 全部 key 都在冷却 → 立刻报错并告诉用户还要等几秒');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        [KEY_A]: { status: 503, message: '503 a' },
        [KEY_B]: { status: 503, message: '503 b' },
      },
    });
    enablePool(sandbox, [1, 2], { cooldownBaseMs: 60000 });
    try { await geminiFetch(sandbox, KEY_A); } catch (e) { /* 第一轮预期失败 */ }

    let err = null;
    try { await geminiFetch(sandbox, KEY_A); } catch (e) { err = e; }
    check('第二次请求立刻报错（没干等 60 秒）', !!err, err ? err.message : '没抛错');
    check('错误信息说明「全部 Key 冷却中」', !!err && err.message.indexOf('全部 Key 冷却中') >= 0, err ? err.message : '');
    check('第二次请求一个 key 都没再试', fetchStub.calls.length === 2, 'calls=' + fetchStub.calls.length);
  }

  // ------------------------------------------------------------
  section('⑩ 槽位解析：池开启时主槽位拿到池里的 key');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      state: { apiConfig: { mainEndpointPresetId: 1, model: 'gemini-2.5-flash' }, globalSettings: {} },
      loadPresetsModule: true,
    });

    let resolved = await sandbox.window.resolveApiSlotConfig('main');
    check('池关闭时用预设自己的 key', resolved.apiKey === KEY_A, 'apiKey=' + resolved.apiKey);

    enablePool(sandbox, [1, 2]);
    resolved = await sandbox.window.resolveApiSlotConfig('main');
    check('池开启时换成池里的某个 key', resolved.apiKey === KEY_A || resolved.apiKey === KEY_B, 'apiKey=' + resolved.apiKey);
    check('下发的必须是单个 key（不能是逗号串）', resolved.apiKey.indexOf(',') < 0, 'apiKey=' + resolved.apiKey);
    check('地址是谷歌直连', resolved.proxyUrl === GEMINI_BASE, 'proxyUrl=' + resolved.proxyUrl);
    check('标记为「被池接管」', resolved.poolForced === true, 'poolForced=' + resolved.poolForced);
  }

  // ------------------------------------------------------------
  section('⑪ 池开启 → 主聊天【强制】走谷歌轮询，哪怕主 API 选的是 OpenAI 中转站');
  {
    const OPENAI_PRESET = { id: 9, name: '中转站', proxyUrl: 'https://api.example.com/v1', apiKey: 'sk-xxx' };
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [9, OPENAI_PRESET]],
      state: { apiConfig: { mainEndpointPresetId: 9, model: 'gpt-4o' }, globalSettings: {} },
      loadPresetsModule: true,
    });

    // 池关着：中转站原样
    let resolved = await sandbox.window.resolveApiSlotConfig('main');
    check('池关闭时走中转站', resolved.proxyUrl === 'https://api.example.com/v1', 'proxyUrl=' + resolved.proxyUrl);
    check('池关闭时用中转站自己的 key', resolved.apiKey === 'sk-xxx', 'apiKey=' + resolved.apiKey);
    check('池关闭时模型也是中转站的', resolved.model === 'gpt-4o', 'model=' + resolved.model);
    check('池关闭时没有「被接管」标记', resolved.poolForced === false);

    // 池开着：强制改成谷歌轮询
    enablePool(sandbox, [1]);
    resolved = await sandbox.window.resolveApiSlotConfig('main');
    check('池开启后地址被强制改成谷歌直连', resolved.proxyUrl === GEMINI_BASE, 'proxyUrl=' + resolved.proxyUrl);
    check('池开启后 key 换成池里的', resolved.apiKey === KEY_A, 'apiKey=' + resolved.apiKey);
    check('池开启后模型也换成了谷歌模型（不能还是 gpt-4o）', resolved.model === 'gemini-2.5-flash', 'model=' + resolved.model);
    check('池开启后标了「被接管」', resolved.poolForced === true);
  }

  // ------------------------------------------------------------
  section('⑫ 池关闭 → 主 API 完全回到自己选的渠道（老行为一字未改）');
  {
    const OPENAI_PRESET = { id: 9, name: '中转站', proxyUrl: 'https://api.example.com/v1', apiKey: 'sk-xxx' };
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [9, OPENAI_PRESET]],
      state: { apiConfig: { mainEndpointPresetId: 9, model: 'gpt-4o' }, globalSettings: {} },
      loadPresetsModule: true,
    });
    // 池开着 → 强制谷歌
    enablePool(sandbox, [1]);
    let r = await sandbox.window.resolveApiSlotConfig('main');
    check('先确认池开着时是谷歌', r.proxyUrl === GEMINI_BASE, 'proxyUrl=' + r.proxyUrl);
    // 关掉 → 立刻回到中转站
    sandbox.window.GeminiKeyPool.saveConfig({ enabled: false });
    r = await sandbox.window.resolveApiSlotConfig('main');
    check('关掉池后地址回到中转站', r.proxyUrl === 'https://api.example.com/v1', 'proxyUrl=' + r.proxyUrl);
    check('关掉池后 key 回到中转站的', r.apiKey === 'sk-xxx', 'apiKey=' + r.apiKey);
    check('关掉池后模型回到 gpt-4o', r.model === 'gpt-4o', 'model=' + r.model);
  }

  // ------------------------------------------------------------
  section('⑬ 「拉取模型」走自己的循环，不被池的故障转移接管');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      handlers: {
        // 线路A 连模型列表都拉不到（503），线路B 正常
        [KEY_A]: { status: 503, message: 'quota exceeded' },
        [KEY_B]: { status: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }) },
      },
    });
    enablePool(sandbox, [1, 2]);

    const btn = { textContent: '拉取模型', disabled: false };
    await sandbox.window.GeminiKeyPoolUI.fetchModels(btn);

    check('正好发 2 次请求（没被拦截器额外再换一轮 Key）', fetchStub.calls.length === 2,
      'calls=' + fetchStub.calls.length);
    check('第 1 次用线路A的 Key', fetchStub.calls[0] && fetchStub.calls[0].key === KEY_A,
      fetchStub.calls[0] && fetchStub.calls[0].key);
    check('第 2 次用线路B的 Key', fetchStub.calls[1] && fetchStub.calls[1].key === KEY_B,
      fetchStub.calls[1] && fetchStub.calls[1].key);
    check('两次请求的都是模型列表接口',
      fetchStub.calls.every(c => c.url.indexOf('/v1beta/models') >= 0));

    // 失败归属必须准：线路A 只该被记 1 次失败（记两遍会让退避翻倍过快）
    const log = sandbox.window.GeminiKeyPool.getErrorLog();
    check('线路A 的失败只被记了 1 次', log.length === 1, 'log=' + log.length +
      ' ' + JSON.stringify(log.map(e => e.fingerprint + ':' + e.status)));
    check('记的就是线路A 的 503',
      log.length === 1 && log[0].status === 503 && log[0].error.indexOf('quota exceeded') >= 0,
      JSON.stringify(log[0] || {}));
    check('按钮文案还原了', btn.textContent === '拉取模型', btn.textContent);
    check('按钮重新可点', btn.disabled === false);
  }

  // ------------------------------------------------------------
  section('⑭ 主 API 被强制接管；谷歌直连的其它功能位照常走池');
  {
    const OPENAI_PRESET = { id: 9, name: '中转站', proxyUrl: 'https://api.example.com/v1', apiKey: 'sk-xxx' };
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B], [9, OPENAI_PRESET]],
      state: {
        apiConfig: {
          mainEndpointPresetId: 9,        // 主 API 选的是 OpenAI 中转站
          visionEndpointPresetId: 1,      // 识图走谷歌直连，且 Key 在池里
          model: 'gpt-4o',
          visionModel: 'gemini-2.5-flash'
        },
        globalSettings: {}
      },
      loadPresetsModule: true,
    });
    enablePool(sandbox, [1, 2]);

    const main = await sandbox.window.resolveApiSlotConfig('main');
    check('主 API 被强制改成谷歌直连', main.proxyUrl === GEMINI_BASE, 'proxyUrl=' + main.proxyUrl);
    check('主 API 的 key 换成了池里的', main.apiKey === KEY_A || main.apiKey === KEY_B, 'apiKey=' + main.apiKey);
    check('主 API 的模型换成了谷歌模型', main.model === 'gemini-2.5-flash', 'model=' + main.model);

    const vision = await sandbox.window.resolveApiSlotConfig('vision');
    check('识图（谷歌直连 + Key 在池里）由池接管',
      vision.apiKey === KEY_A || vision.apiKey === KEY_B, 'apiKey=' + vision.apiKey);
    check('识图地址不变', vision.proxyUrl === GEMINI_BASE, 'proxyUrl=' + vision.proxyUrl);
    check('识图模型不变（它不是主槽位，池不改它的模型）',
      vision.model === 'gemini-2.5-flash', 'model=' + vision.model);
  }

  // ------------------------------------------------------------
  section('⑮ 池外的 Key（没被勾进池的谷歌直连）在【其它功能位】保持自己的 Key');
  {
    const OUTSIDE_KEY = 'AIzaOUTSIDE999999999999999999ZZZZ';
    const OUTSIDE_PRESET = { id: 7, name: '池外谷歌', proxyUrl: GEMINI_BASE, apiKey: OUTSIDE_KEY };
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [7, OUTSIDE_PRESET]],
      state: {
        apiConfig: { mainEndpointPresetId: 7, visionEndpointPresetId: 7, model: 'm', visionModel: 'm' },
        globalSettings: {}
      },
      loadPresetsModule: true,
    });
    enablePool(sandbox, [1]);

    const vision = await sandbox.window.resolveApiSlotConfig('vision');
    check('池外的谷歌直连功能位保持自己的 Key', vision.apiKey === OUTSIDE_KEY, 'apiKey=' + vision.apiKey);

    const main = await sandbox.window.resolveApiSlotConfig('main');
    check('主槽位则是强制接管（主聊天一律走池）', main.apiKey === KEY_A, 'apiKey=' + main.apiKey);
  }

  // ------------------------------------------------------------
  section('⑯ 轮询不跳号：每个 Key 都会被轮到（回归：槽位和拦截器各推一次游标 → 跳一半）');
  {
    const { sandbox, fetchStub } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B], [3, PRESET_C]],
      handlers: {
        [KEY_A]: { status: 200 },
        [KEY_B]: { status: 200 },
        [KEY_C]: { status: 200 },
      },
      state: { apiConfig: { mainEndpointPresetId: 1, model: 'gemini-2.5-flash' }, globalSettings: {} },
      loadPresetsModule: true,
    });
    enablePool(sandbox, [1, 2, 3]);

    // 真实链路是「先解析槽位拿配置 → 再发请求」，这里照着走一遍
    for (let i = 0; i < 3; i++) {
      const cfg = await sandbox.window.resolveApiSlotConfig('main');
      await geminiFetch(sandbox, cfg.apiKey);
    }
    const used = fetchStub.calls.map(c => c.key);
    check('3 次请求正好用了 3 个不同的 Key',
      new Set(used).size === 3, 'used=' + used.map(k => k.slice(6, 10)).join(','));
    check('按 A → B → C 顺序轮询（没有跳号）',
      used[0] === KEY_A && used[1] === KEY_B && used[2] === KEY_C,
      'used=' + used.map(k => k.slice(6, 10)).join(','));
  }

  // ------------------------------------------------------------
  section('⑰ 模型兜底：主 API 是 gpt-4o、预设也没默认模型时，不能把 gpt-4o 发给谷歌');
  {
    const OPENAI_PRESET = { id: 9, name: '中转站', proxyUrl: 'https://api.example.com/v1', apiKey: 'sk-xxx' };
    const NO_MODEL_PRESET = { id: 1, name: '谷歌A', proxyUrl: GEMINI_BASE, apiKey: KEY_A };
    const { sandbox } = makeSandbox({
      presets: [[1, NO_MODEL_PRESET], [9, OPENAI_PRESET]],
      state: { apiConfig: { mainEndpointPresetId: 9, model: 'gpt-4o' }, globalSettings: {} },
      loadPresetsModule: true,
    });
    enablePool(sandbox, [1]);
    const resolved = await sandbox.window.resolveApiSlotConfig('main');
    check('模型不是 gpt-4o', resolved.model !== 'gpt-4o', 'model=' + resolved.model);
    check('兜底成 gemini-2.5-flash', resolved.model === 'gemini-2.5-flash', 'model=' + resolved.model);
  }

  // ------------------------------------------------------------
  section('⑱ 池的模型不污染主 API 的模型（池一关，主 API 还是自己那个模型）');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      state: { apiConfig: { mainEndpointPresetId: 1, model: 'gpt-4o' }, globalSettings: {} },
      loadPresetsModule: true,
    });
    enablePool(sandbox, [1, 2]);
    await sandbox.window.GeminiKeyPoolUI.applyModel('gemini-2.5-pro');
    check('池的模型存进了池自己的配置',
      sandbox.window.GeminiKeyPool.loadConfig().model === 'gemini-2.5-pro',
      'model=' + sandbox.window.GeminiKeyPool.loadConfig().model);
    check('主 API 的模型没被改（还是 gpt-4o）',
      sandbox.state.apiConfig.model === 'gpt-4o', 'model=' + sandbox.state.apiConfig.model);
  }

  // ------------------------------------------------------------
  console.log('\n========================================');
  console.log(' 通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});

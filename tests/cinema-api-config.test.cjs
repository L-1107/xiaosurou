// ============================================================
// tests/cinema-api-config.test.cjs
// 影院陪聊拿主 API 配置的回归测试 (2026-10-27)
//
// 跑法: node tests/cinema-api-config.test.cjs
//
// 【背景】(用户 2026-10-26 实测)
//   影院里想聊天 → 报错「聊天失败：主 API 没配好（地址 / API Key / 模型缺一个）」。
//
// 【真因】
//   影院跑在 iframe 沙盒 (cinema-sandbox/index.html) 里, 那个页面只加载了
//   dexie / live-client / cinema-storage / cinema-img / cinema-room /
//   cinema-live / cinema-chat 七个文件 —— 【没有 api-endpoint-presets.js】,
//   所以沙盒里 window.resolveApiSlotConfig 不存在; 沙盒自己的库是
//   CinemaSandboxDB, 里面也没有 db.apiPresets 表。
//   → 沙盒自己解析不出主 API 的 地址/Key/模型。
//   → modules/cinema-chat.js 的 getMainApiConfig() 三件套全空 → 抛那句话。
//
//   而宿主传过去的 payload (cinema-room.js currentChatPayload) 里也没有它。
//
// 【修法】
//   宿主用 resolveApiSlotConfig('main') 实时解析 (预设模式下 state.apiConfig
//   里的地址/密钥本来就被清空了, 不能直接读), 随 payload / 补发消息交给沙盒,
//   沙盒写进 window.state.apiConfig。
//
// 【本测试守什么】
//   ① 宿主: 用 resolveApiSlotConfig('main') 解析, payload 里有 apiConfig,
//      并且解析是异步的 → 要有补发通道
//   ② 沙盒: window.state 里有 apiConfig, 且认 'cinema:apiConfig' 这条消息
//   ③ cinema-chat.js: 三种拿法都能用 (宿主有 resolveApiSlotConfig /
//      沙盒有 state.apiConfig / 宿主晚点才送到 → 等它)
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
// 允许用环境变量指向别的副本 (反向验证时用临时还原出来的 bug 版本跑)
const ROOM_PATH = process.env.CINEMA_ROOM_PATH || path.join(ROOT, 'modules', 'cinema-room.js');
const CHAT_PATH = process.env.CINEMA_CHAT_PATH || path.join(ROOT, 'modules', 'cinema-chat.js');
const SANDBOX_PATH = process.env.CINEMA_SANDBOX_PATH || path.join(ROOT, 'cinema-sandbox', 'index.html');

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

// 抠出一个【顶层函数声明】(边界 = 下一个同缩进的声明)
// 注意: async function 的 "async " 在 "function " 前面, 抠的时候要带上,
//       否则 await 会报 "only valid in async functions"。
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const rest = src.slice(start + 1);
  const m = rest.match(/\n  (?:function |const |let |var |window\.)/);
  if (!m) return src.slice(start);
  return src.slice(start, start + 1 + m.index);
}

// ============================================================
// 抠出 getMainApiConfig / waitForApiConfig, 在沙箱里跑
// ============================================================
function makeChatSandbox(stateObj, opts) {
  const o = opts || {};
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    Promise: Promise,
    // 测试里把这个上限调小
    API_CONFIG_WAIT_MS: o.waitMs === undefined ? 500 : o.waitMs,
    getState: function () { return stateObj; },
    logWarn: function () {}
  };
  sandbox.window = sandbox;
  if (o.withResolver) {
    sandbox.resolveApiSlotConfig = async function (slot) {
      return { slot: slot, proxyUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' };
    };
  }
  vm.createContext(sandbox);

  const src = fs.readFileSync(CHAT_PATH, 'utf8');
  const code = [extractFn(src, 'waitForApiConfig'), extractFn(src, 'getMainApiConfig')].join('\n\n');
  vm.runInContext(code, sandbox, { filename: 'cinema-chat-extracted.js' });

  return sandbox;
}

// ============================================================
async function main() {
  // ------------------------------------------------------------
  section('① 宿主 (cinema-room.js) 负责解析主 API 配置');
  {
    const room = fs.readFileSync(ROOM_PATH, 'utf8');
    check('有 resolveMainApiConfig', /function resolveMainApiConfig\(\)/.test(room));
    check('走的是 resolveApiSlotConfig(\'main\')', /resolveApiSlotConfig\('main'\)/.test(room));
    check('解析出来的三件套是 proxyUrl/apiKey/model',
      /proxyUrl:\s*String\(cfg\.proxyUrl\)/.test(room) &&
      /apiKey:\s*String\(cfg\.apiKey\)/.test(room) &&
      /model:\s*String\(cfg\.model\)/.test(room));
    check('payload 里带上了 apiConfig', /apiConfig:\s*_mainApiCfg\s*\|\|\s*null/.test(room));
    check('有补发通道 cinema:apiConfig', /type:\s*'cinema:apiConfig'/.test(room));
    check('sendChat 会把配置也发过去',
      /function sendChat\(\)[\s\S]{0,400}pushMainApiConfig\(\)/.test(room));
    check('不是直接读 state.apiConfig 当答案',
      !/const cfg = \(options && options\.config\) \|\| state\.apiConfig/.test(room));
  }

  // ------------------------------------------------------------
  section('② 沙盒 (cinema-sandbox/index.html) 收下配置');
  {
    const sb = fs.readFileSync(SANDBOX_PATH, 'utf8');
    check('window.state 里有 apiConfig', /apiConfig:\s*hostApiConfig/.test(sb));
    check('有 applyApiConfig', /function applyApiConfig\(cfg\)/.test(sb));
    check('applyApiConfig 写进 window.state.apiConfig',
      /window\.state\.apiConfig\s*=\s*hostApiConfig/.test(sb));
    check('认 cinema:apiConfig 这条消息', /d\.type\s*===\s*'cinema:apiConfig'/.test(sb));
    check('init 里带来的 apiConfig 也认', /d\.chat\.apiConfig/.test(sb));
    check('沙盒没加载 api-endpoint-presets.js (它自己解析不了)',
      !/<script[^>]*api-endpoint-presets/.test(sb));
  }

  // ------------------------------------------------------------
  section('③ cinema-chat.js: 三种拿法');
  {
    // (a) 宿主有 resolveApiSlotConfig → 直接用
    const stateA = { apiConfig: { proxyUrl: 'https://old/v1', apiKey: 'old', model: 'old' } };
    const sa = makeChatSandbox(stateA, { withResolver: true });
    const cfgA = await sa.getMainApiConfig();
    check('宿主有 resolveApiSlotConfig 时用它',
      cfgA.proxyUrl === 'https://api.example.com/v1' && cfgA.apiKey === 'sk-test' &&
      cfgA.model === 'test-model', JSON.stringify(cfgA));
  }
  {
    // (b) 沙盒: 没有 resolveApiSlotConfig, 但 state.apiConfig 有值
    const stateB = { apiConfig: { proxyUrl: 'https://sb/v1', apiKey: 'sk-sb', model: 'sb-model' } };
    const sb2 = makeChatSandbox(stateB);
    const cfgB = await sb2.getMainApiConfig();
    check('沙盒里 state.apiConfig 有值时直接用',
      cfgB.proxyUrl === 'https://sb/v1' && cfgB.apiKey === 'sk-sb' && cfgB.model === 'sb-model',
      JSON.stringify(cfgB));
  }
  {
    // (c) 宿主还没送到 → 等它
    const stateC = { apiConfig: null };
    const sc = makeChatSandbox(stateC, { waitMs: 2000 });
    setTimeout(function () {
      stateC.apiConfig = { proxyUrl: 'https://late/v1', apiKey: 'sk-late', model: 'late-model' };
    }, 250);
    // 这一条必须自己扛住异常 —— 不然还原成 bug 版时测试是【崩掉】而不是【报红】,
    // 后面的人就看不出是哪条断言挂的。
    let cfgC = null, errC = null;
    try { cfgC = await sc.getMainApiConfig(); } catch (e) { errC = e; }
    check('宿主晚点送到时等得到', !!cfgC && cfgC.proxyUrl === 'https://late/v1',
      errC ? ('抛错: ' + errC.message) : JSON.stringify(cfgC));
  }
  {
    // (d) 真的什么都没有 → 抛人话
    const stateD = { apiConfig: null };
    const sd = makeChatSandbox(stateD, { waitMs: 300 });
    let thrown = null;
    try { await sd.getMainApiConfig(); } catch (e) { thrown = e; }
    check('什么都没有时抛的是那句人话', !!thrown &&
      String(thrown.message).indexOf('主 API 没配好') >= 0,
      thrown ? String(thrown.message) : '没抛');
  }

  // ------------------------------------------------------------
  section('④ 模块导出');
  {
    const chat = fs.readFileSync(CHAT_PATH, 'utf8');
    check('导出了 getMainApiConfig (给测试/排查用)',
      /getMainApiConfig:\s*getMainApiConfig/.test(chat));
  }

  // ------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n测试崩了:', e);
  process.exit(1);
});

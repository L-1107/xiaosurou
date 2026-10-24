// ============================================================
// tests/cinema-chat.test.cjs
// 影院陪聊改走主 API 的回归测试
//
// 跑法: node tests/cinema-chat.test.cjs
//
// 【背景】(2026-10-23)
//   用户报: 影院里陪你看剧的观影模型 "Gemini 3.8 Live 又要看视频又要回话实在太蠢了,
//   性格也和外面聊天的不适配"。
//   真因有两层:
//     ① Live 3.8 的 responseModalities 只有 AUDIO —— 文字全靠 outputTranscription
//        转写回来, 音频直接丢弃 (live-client.js)。
//     ② 它的 system prompt 是 cinema-live.js 自己手写的一套 (buildSystemPrompt),
//        只塞了 chat.settings.aiPersona, 【没有】用主聊天那套提示词预设。
//
//   改法: Live 只保留"看画面 + 写剧情记忆", 陪聊改走【主聊天的主 API】。
//   上文按用户点名的清单: 人设 ✅ 长期记忆 ✅ 外面聊天框的正常上文 ✅
//                        影院全部剧情记忆 ✅ 世界书 ❌
//
// 【本测试守什么】
//   ① 剥掉主聊天提示词里的【JSON 指令系统】—— 结构上删, 不是"跟模型说别输出 JSON"
//   ② 上下文清单: 世界书空 / 长期记忆有值 / 人设有值
//   ③ 影院剧情记忆块: 提要 / 各集 / 各段 / 此刻实况 一个都不能少
//   ④ cinema-live.js: Live 的字不再进气泡 / 陪聊改走 CinemaChat /
//      Live 没就绪也不挡聊天 / 剧情记忆与气泡 UI 有导出
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'modules', 'cinema-chat.js');
const LIVE_PATH = path.join(ROOT, 'modules', 'cinema-live.js');
const AI_RESPONSE_PATH = path.join(ROOT, 'modules', 'ai-response.js');
const PRESETS_PATH = path.join(ROOT, 'modules', 'settings-presets.js');

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
// 工具
// ============================================================
// 从源码里抠出一个【顶层函数声明】的完整源码。
// 不能用括号配平 —— 正则字面量里也有 {} (比如 /\{\{([^{}]+)\}\}/g)。
// 所以改成: 从下一个同缩进的顶层声明开始, 那就是它的结尾。
function extractTopLevelFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  const rest = src.slice(start + 1);
  const m = rest.match(/\n  (function |const |let |var |window\.)/);
  if (!m) throw new Error('找不到函数 ' + name + ' 的结尾');
  return src.slice(start, start + 1 + m.index);
}

// 从 settings-presets.js 里抠出"默认单聊提示词"模板
function extractDefaultSinglePrompt() {
  const src = fs.readFileSync(PRESETS_PATH, 'utf8');
  const i = src.indexOf("if (chatType === 'single') {");
  if (i < 0) throw new Error('没找到默认单聊提示词');
  const seg = src.slice(i, i + 30000);
  const start = seg.indexOf('return `') + 'return `'.length;
  const end = seg.indexOf('`;', start);
  if (start < 7 || end < 0) throw new Error('默认单聊提示词模板抠不出来');
  return seg.slice(start, end);
}

function makeSandbox(extraWin) {
  const win = { console: console };
  Object.assign(win, extraWin || {});
  win.window = win;

  const sandbox = { console: console, window: win };
  // 生产环境里 `state` 是全局变量 (不只是 window.state) ——
  // ai-response.js 的 replaceTemplateVars 直接用裸的 `state.xxx`。
  sandbox.state = win.state;
  vm.createContext(sandbox);

  // 抠出 ai-response.js 里真实的 replaceTemplateVars, 在沙箱里跑
  const aiSrc = fs.readFileSync(AI_RESPONSE_PATH, 'utf8');
  const fnSrc = extractTopLevelFunction(aiSrc, 'replaceTemplateVars');
  vm.runInContext(
    fnSrc + '\n;this.replaceTemplateVars = replaceTemplateVars; this.window.replaceTemplateVars = replaceTemplateVars;',
    sandbox, { filename: 'replaceTemplateVars' });

  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox, { filename: MODULE_PATH });

  return { sandbox: sandbox, win: win, api: win.CinemaChat };
}

// ============================================================
async function main() {
  const chat = {
    id: 'chat-1',
    name: '角色名',
    originalName: '原名',
    settings: {
      aiPersona: '人设正文',
      myPersona: '用户人设',
      myNickname: '小北',
      maxMemory: 20
    }
  };

  const defaultPrompt = extractDefaultSinglePrompt();

  const { api } = makeSandbox({
    state: { chats: { 'chat-1': chat }, globalSettings: {}, activeChatId: 'chat-1' },
    getActiveChatPrompt: function () { return defaultPrompt; },
    getMemoryContextForPrompt: function () { return '普通记忆正文'; }
  });

  // ------------------------------------------------------------
  section('① 模块本身加载正常');
  {
    check('window.CinemaChat 挂上了', !!api);
    check('导出了 send', api && typeof api.send === 'function');
    check('导出了 stripInstructionSystem', api && typeof api.stripInstructionSystem === 'function');
    check('导出了 buildSystemPrompt', api && typeof api.buildSystemPrompt === 'function');
    check('导出了 buildCinemaPlotBlock', api && typeof api.buildCinemaPlotBlock === 'function');
  }

  // ------------------------------------------------------------
  section('② 剥掉主聊天提示词里的【JSON 指令系统】');
  {
    const stripped = api.stripInstructionSystem(defaultPrompt);

    check('原提示词本来就有 thought_chain', defaultPrompt.indexOf('thought_chain') >= 0);
    check('剥完没有 thought_chain', stripped.indexOf('thought_chain') < 0);
    check('剥完没有 "type": 指令样例', stripped.indexOf('"type":') < 0);
    check('剥完没有「输出格式铁律」', stripped.indexOf('输出格式铁律') < 0);
    check('剥完没有「可选指令列表」', stripped.indexOf('可选指令列表') < 0);
    check('剥完没有「行为与指令系统」(Part 3)', stripped.indexOf('行为与指令系统') < 0);
    check('剥完没有「可用资源库」(Part 4)', stripped.indexOf('可用资源库') < 0);
    check('剥完没有「当前情景」(Part 2 那一节)', stripped.indexOf('Part 2') < 0);
    check('剥完没有「严格遵守JSON格式」', stripped.indexOf('严格遵守JSON格式') < 0);
    check('剥完没有「世界观融合」', stripped.indexOf('世界观融合') < 0);

    check('剥完还留「核心设定」(人设那节)', stripped.indexOf('核心设定') >= 0);
    check('剥完还留「长期记忆」', stripped.indexOf('长期记忆') >= 0);
    check('剥完还留「关键关系」', stripped.indexOf('关键关系') >= 0);
    check('剥完还留「最高指令」', stripped.indexOf('最高指令') >= 0);
  }

  // ------------------------------------------------------------
  section('③ 上下文清单（用户点名的）');
  {
    const ctx = api.buildContextMap(chat, '长期记忆正文');
    check('世界书是空的（用户明确不要）', ctx.worldBookContent === '', 'worldBookContent=' + JSON.stringify(ctx.worldBookContent));
    check('长期记忆有值', ctx.memoryContextForPrompt === '长期记忆正文');
    check('长期记忆(另一个变量名)也有值', ctx.longTermMemoryContext === '长期记忆正文');
    check('人设有值', ctx.aiPersona === '人设正文');
    check('昵称有值', ctx.myNickname === '小北');
    check('角色名有值', ctx['chat.name'] === '角色名');
    check('用户人设有值', ctx.myPersona === '用户人设');
    check('联系人/动态这些外面上下文是空的', ctx.contactsList === '' && ctx.postsContext === '' && ctx.groupContext === '');
  }

  // ------------------------------------------------------------
  section('④ 影院剧情记忆块');
  {
    const block = api.buildCinemaPlotBlock({
      kind: 'series',
      title: '某部剧',
      lastEp: 3,
      recap: '跨场提要正文',
      recapText: '',
      anchor: '',
      episodes: [{ ep: 1, text: '第一集剧情' }, { ep: 2, text: '第二集剧情' }],
      segments: [],
      liveNow: { text: '此刻镜头里是谁', at: Date.now() }
    });
    check('含剧名', block.indexOf('某部剧') >= 0);
    check('含看到第几集', block.indexOf('第 3 集') >= 0);
    check('含跨场提要', block.indexOf('跨场提要正文') >= 0);
    check('含各集剧情', block.indexOf('第一集剧情') >= 0 && block.indexOf('第二集剧情') >= 0);
    check('含此刻实况', block.indexOf('此刻镜头里是谁') >= 0);
    check('实况标了「多少秒前」', /秒前你看到的/.test(block));
    check('实况标题是「此刻画面」', block.indexOf('## 此刻画面') >= 0);

    // 长剧: 锚 + 提要 + 各段
    const filmBlock = api.buildCinemaPlotBlock({
      kind: 'film',
      title: '一部长剧',
      lastEp: 0,
      segCount: 2,
      recap: '',
      recapText: '整部剧的提要',
      anchor: '目前的剧情进度',
      episodes: [],
      segments: [{ ep: 1, text: '第一段剧情' }, { ep: 2, text: '第二段剧情' }],
      liveNow: { text: '', at: 0 }
    });
    check('长剧含滚动锚', filmBlock.indexOf('目前的剧情进度') >= 0);
    check('长剧含整部剧提要', filmBlock.indexOf('整部剧的提要') >= 0);
    check('长剧含各段剧情', filmBlock.indexOf('第一段剧情') >= 0 && filmBlock.indexOf('第二段剧情') >= 0);
    check('长剧不含「第 N 集」', filmBlock.indexOf('第 1 集') < 0);
  }

  // ------------------------------------------------------------
  section('⑤ 整条 system prompt');
  {
    const sys = await api.buildSystemPrompt(chat, '长期记忆正文', {
      kind: 'series', title: '某部剧', lastEp: 2,
      recap: '提要正文', recapText: '', anchor: '',
      episodes: [{ ep: 1, text: '第一集剧情' }], segments: [],
      liveNow: { text: '此刻是谁', at: Date.now() }
    });
    check('不含 thought_chain', sys.indexOf('thought_chain') < 0);
    check('不含 "type": 指令样例', sys.indexOf('"type":') < 0);
    check('含人设占位已填成人设正文', sys.indexOf('人设正文') >= 0);
    check('含长期记忆正文', sys.indexOf('长期记忆正文') >= 0);
    check('含影院场景块', sys.indexOf('你们在一起看剧') >= 0);
    check('含剧情记忆', sys.indexOf('第一集剧情') >= 0);
    check('含实况', sys.indexOf('此刻是谁') >= 0);
    check('没有残留 {{占位符}}', !/\{\{[^{}]*\}\}/.test(sys));
    check('没有「世界书」字样(带内容那节)', sys.indexOf('世界观法则') < 0);
  }

  // ------------------------------------------------------------
  section('⑥ cinema-live.js —— Live 不再管陪聊');
  {
    const live = fs.readFileSync(LIVE_PATH, 'utf8');

    check('handleModelText 里不再调 renderGeminiBubble',
      extractFunctionBody(live, 'handleModelText').indexOf('renderGeminiBubble') < 0);
    check('handleModelText 里不再写 bubbleText',
      extractFunctionBody(live, 'handleModelText').indexOf('bubbleText +=') < 0);

    const doSend = extractFunctionBody(live, 'doSendUserText');
    check('doSendUserText 走 window.CinemaChat.send', doSend.indexOf('window.CinemaChat') >= 0);
    check('doSendUserText 不再无条件 S.client.sendUserText',
      doSend.indexOf('S.client.sendUserText(t)') >= 0 ||
      doSend.indexOf("S.client.sendUserText(t)") >= 0,
      '(旧路径保留作兜底)');

    const handle = extractFunctionBody(live, 'handleUserMessage');
    check('handleUserMessage 有 CinemaChat 分支', handle.indexOf('window.CinemaChat') >= 0);
    const chatIdx = handle.indexOf('window.CinemaChat');
    const readyIdx = handle.indexOf('isReady()');
    check('Live 没就绪的拦截排在 CinemaChat 分支【后面】(即不再挡聊天)',
      readyIdx < 0 || chatIdx < readyIdx,
      'CinemaChat@' + chatIdx + ' isReady@' + readyIdx);

    check('导出 getCinemaContext', /getCinemaContext:\s*function/.test(live));
    check('导出气泡 UI', /renderAssistantBubble:\s*renderGeminiBubble/.test(live));
    check('导出 appendUserBubble', /appendUserBubble:\s*appendUserBubble/.test(live));
    check('导出 recordAssistant', /recordAssistant:\s*recordAssistantFinal/.test(live));
    check('watchSession 里有 liveNow 字段', /liveNow:\s*\{\s*text:\s*''/.test(live));
    check('实况通道存在', /function requestLiveNow\(\)/.test(live) && /function tickLiveNow\(\)/.test(live));
    check('实况默认 30 秒', /LIVE_NOW_INTERVAL_MS\s*=\s*30\s*\*\s*1000/.test(live));
    check('实况是覆盖式单条 (不是数组)', /watchSession\.liveNow\s*=\s*\{\s*text:\s*t,\s*at:\s*Date\.now\(\)/.test(live));
    check('实况跟帧循环同生命周期', /startLiveNowLoop\(\);/.test(live) && /stopLiveNowLoop\(\);/.test(live));
  }

  // ------------------------------------------------------------
  section('⑦ ai-response.js 导出');
  {
    const ai = fs.readFileSync(AI_RESPONSE_PATH, 'utf8');
    check('导出了 replaceTemplateVars', /window\.replaceTemplateVars\s*=\s*replaceTemplateVars/.test(ai));
    check('导出了 toGeminiRequestData', /window\.toGeminiRequestData\s*=\s*toGeminiRequestData/.test(ai));
    check('导出了 fetchStreamingResponse', /window\.fetchStreamingResponse\s*=\s*fetchStreamingResponse/.test(ai));
  }

  // ------------------------------------------------------------
  section('⑧ 页面挂载');
  {
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('index.html 挂了 modules/cinema-chat.js', /modules\/cinema-chat\.js\?v=/.test(idx));
    check('cinema-live.js 的 ?v= 已 bump', /modules\/cinema-live\.js\?v=1\.9\.7/.test(idx));

    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    check('sw.js 预缓存了 modules/cinema-chat.js', /'\.\/modules\/cinema-chat\.js'/.test(sw));
    // 【2026-10-23 改】原来这里写死 'v0.2.67.0', 后面任何一次 CACHE_VERSION bump
    // (比如宠物屋上线 bump 到 v0.2.68.0) 都会把这个测试弄红 —— 但那不是回归。
    // 本意是「加 cinema-chat 时 bump 过 CACHE_VERSION, 不能是加它之前的旧版本」,
    // 所以改成比版本号, 以后再 bump 也不会误报。
    const m = sw.match(/const CACHE_VERSION\s*=\s*'v(\d+)\.(\d+)\.(\d+)\.(\d+)'/);
    const ver = m ? [+m[1], +m[2], +m[3], +m[4]] : null;
    // 版本号逐段比：先比到第一段不一样的为止，那段大就够新
    const atLeast = (v, min) => {
      if (!v) return false;
      for (let i = 0; i < min.length; i++) {
        if (v[i] > min[i]) return true;
        if (v[i] < min[i]) return false;
      }
      return true;
    };
    check('CACHE_VERSION 已 bump（>= v0.2.67.0）', atLeast(ver, [0, 2, 67, 0]),
      ver ? 'v' + ver.join('.') : 'not found');
  }

  // ------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

// 抠出某个函数的函数体 (只用来做源码级断言, 不需要精确配平)
function extractFunctionBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const m = rest.match(/\n  (function |const |let |var |window\.|\/\/ =)/);
  if (!m) return src.slice(start);
  return src.slice(start, start + 1 + m.index);
}

main().catch((e) => {
  console.error('\n测试崩了:', e);
  process.exit(1);
});

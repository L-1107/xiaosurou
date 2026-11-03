// ============================================================
// modules/cinema-chat.js
// 影院陪聊 —— 走【主聊天的主 API】, 不再走 Gemini Live
//
// 【为什么换】(2026-10-23 用户决定)
//   原来: 影院聊天是 Gemini 3.8 Live 一个模型同时干两件事 —— 看画面 + 回话。
//     · Live 3.8 的 responseModalities 只有 AUDIO (官方不支持 TEXT 输出),
//       文字全靠 outputTranscription 转写回来, 音频直接丢弃。
//     · 它的 system prompt 是 cinema-live.js 自己手写的一套 (buildSystemPrompt),
//       只塞了 chat.settings.aiPersona, 【没有】用主聊天那套提示词预设。
//       所以"性格跟外面聊天不适配"不是错觉 —— 是代码就这么写的。
//   现在: Live 只干"看画面 + 写剧情记忆", 陪聊交给主 API。
//     人设 / 长期记忆 / 历史 / 说话方式全部跟主聊天一致。
//
// 【职责边界】
//   ✅ cinema-chat.js : 组上文 → 调主 API → 流式回填气泡 → 落进主聊天历史
//   ✅ cinema-live.js  : 抽帧 / 写摘要 / 写单集剧情 / 提供"此刻画面"实况
//   ❌ 不碰 Live 的 WebSocket 协议层 (那是 live-client.js 的事)
//
// 【上文里装了什么】(用户 2026-10-23 点名要的清单)
//   · 主 API 的人设        —— 主聊天的提示词预设, 但【剥掉 JSON 指令系统】
//   · 长期记忆            —— 主聊天同一套 (向量记忆优先, 回落普通/结构化记忆)
//   · 外面聊天框的正常上文 —— 主聊天最近 N 条历史
//   · 影院总结的全部剧情记忆 —— 跨场提要 / 长剧滚动锚 / 短剧各集剧情 /
//                        长剧各段剧情 / 此刻实况
//   · 世界书              —— 【不要】(用户明确说的)
//
// 【为什么必须剥掉 JSON 指令系统】
//   主聊天的默认提示词是【指令式角色扮演】: 输出必须是一个 JSON 数组,
//   第一项是 thought_chain, 后面是 text / sticker / ai_image / transfer …
//   影院气泡显示的是纯文字, 那些指令在影院里一条也执行不了。
//   所以不是"跟模型说别输出 JSON"(那要靠模型听话, 不稳 ——
//   M3 那类模型会照抄占位符), 而是【结构上】把那一整节从提示词里删掉:
//   删完模型根本看不到 JSON 的样例。
// ============================================================

(function () {
  'use strict';

  var LOG = '[Cinema-Chat] ';
  var REQUEST_TIMEOUT_MS = 90000;

  var S = {
    busy: false,
    controller: null,
    lastError: ''
  };

  function log(msg, extra) {
    console.log(LOG + msg, extra === undefined ? '' : extra);
  }
  function logWarn(msg, extra) {
    console.warn(LOG + '⚠️ ' + msg, extra === undefined ? '' : extra);
  }
  function logError(msg, extra) {
    console.error(LOG + '✖ ' + msg, extra === undefined ? '' : extra);
  }

  // ============================================================
  // 宿主上下文通道 (2026-10-28 新增)
  //
  // 【为什么必须有这条通道】
  //   影院跑在 iframe 沙盒 (cinema-sandbox/index.html) 里, 那个页面只加载了
  //   7 个文件: dexie / live-client / cinema-storage / cinema-img /
  //   cinema-room / cinema-live / cinema-chat。
  //   【没有】 message-store.js (外面聊天框的历史)、memory-summary.js (长期记忆)、
  //   settings-presets.js (提示词预设)、ai-response.js (变量替换)。
  //   → 沙盒自己拿不到这些, 所以【全部由宿主算好, 通过 postMessage 发过来】。
  //
  // 【上下文里有什么】
  //   promptText —— 主聊天的提示词预设(已渲染好变量, 但还没剥 JSON 指令系统)
  //   history    —— 外面聊天框最近 N 条(已格式化成 "(时间) 名字: 内容")
  //   memoryText —— 长期记忆正文(向量记忆优先, 跟主聊天同一套)
  //
  // 【为什么发之前还要再问一次】
  //   外面聊天框的历史会变(影院的对话也会被宿主写进主聊天历史),
  //   长期记忆又是按 query 检索的 → 每发一条之前问宿主要一份最新的。
  //   最多等 HOST_CONTEXT_TIMEOUT_MS, 拿不到就用手上这份旧的,
  //   绝不因为等上下文把聊天卡死。
  // ============================================================
  var HOST_CONTEXT_TIMEOUT_MS = 2500;
  // ⚠️【2026-10-29】谷歌原生直连要请宿主代打 → 它的超时比"要上下文"长得多
  //   （那是一次完整的模型请求，不是本地读一下上下文）
  var HOST_GEMINI_TIMEOUT_MS = 120000;
  var HOST = {
    ctx: null,          // 宿主给的最新上下文
    pending: {},        // requestId -> resolve
    seq: 0
  };

  /** 有没有宿主可以对话 (在 iframe 沙盒里才有) */
  function canPostToHost() {
    try {
      return !!(window.parent && window.parent !== window &&
        typeof window.parent.postMessage === 'function');
    } catch (e) { return false; }
  }

  function postToHost(msg) {
    if (!canPostToHost()) return false;
    try {
      window.parent.postMessage(msg, '*');
      return true;
    } catch (e) {
      logWarn('发给宿主失败:', e && e.message);
      return false;
    }
  }

  /** 宿主把上下文送过来了 (init 时) 或者刚问完要来的 */
  function setHostContext(ctx) {
    HOST.ctx = (ctx && typeof ctx === 'object') ? ctx : null;
    if (HOST.ctx) {
      log('收到宿主上下文 (历史 ' + ((HOST.ctx.history || []).length) + ' 条 / 记忆 ' +
        String(HOST.ctx.memoryText || '').length + ' 字 / 提示词 ' +
        String(HOST.ctx.promptText || '').length + ' 字)');
    } else {
      log('宿主上下文是空的');
    }
    return HOST.ctx;
  }

  /**
   * 问宿主要一份最新的上下文。
   * @returns {Promise<Object|null>} 拿不到就返回手上这份旧的 (可能是 null)
   */
  function requestHostContext(queryText) {
    return new Promise(function (resolve) {
      if (!canPostToHost()) { resolve(HOST.ctx); return; }
      var reqId = 'ctx_' + (++HOST.seq) + '_' + Date.now();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        delete HOST.pending[reqId];
        resolve(HOST.ctx);
      }, HOST_CONTEXT_TIMEOUT_MS);
      HOST.pending[reqId] = function (ctx) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        delete HOST.pending[reqId];
        resolve(ctx || HOST.ctx);
      };
      postToHost({ type: 'cinema:needContext', requestId: reqId, query: String(queryText || '') });
    });
  }

  // 宿主的回包在这里接 (沙盒页面自己也监听 message, 但只认它那几种类型)
  // ⚠️ 必须先判断 addEventListener 存在 —— node 里的单测用的是个假 window,
  //   没有它会直接抛 "window.addEventListener is not a function" (2026-10-28 踩过)。
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', function (e) {
      var d = e.data || {};
      if (!d || typeof d !== 'object') return;
      if (d.type === 'cinema:context') {
        if (d.context) setHostContext(d.context);
        var cb = HOST.pending[d.requestId];
        if (cb) cb(d.context || HOST.ctx);
      }
      // ⚠️【2026-10-29】宿主代打谷歌原生请求的回包
      else if (d.type === 'cinema:geminiResponse') {
        var gcb = HOST.pending[d.requestId];
        if (gcb) gcb({ ok: !!d.ok, text: d.text || '', error: d.error || '' });
      }
    });
  }

  /**
   * 请宿主【代打谷歌原生请求】
   *
   * 【为什么不能沙盒自己打】影院跑在 iframe 沙盒里, 沙盒只加载 7 个文件 ——
   *   没有 ai-response.js / utils.js → 沙盒里【没有】toGeminiRequestData,
   *   也没有 getGeminiResponseText。而谷歌原生地址要的是 Gemini 格式
   *   (contents / inline_data / x-goog-api-key), 不是 OpenAI 兼容那套
   *   /chat/completions → 沙盒自己拼必然 404。
   *   → 请求交给宿主发, 宿主把文本回传 (见 modules/cinema-room.js 的
   *     handleCinemaGeminiRequest)。
   *
   * 【图也能带】messages 里那张【阅后即焚】的图是 OpenAI 格式的 image_url,
   *   宿主的 toGeminiRequestData 会把它转成 inline_data。
   */
  function callGeminiViaHost(cfg, systemPrompt, messages, onDelta) {
    return new Promise(function (resolve, reject) {
      if (!canPostToHost()) {
        reject(new Error('主 API 是谷歌原生地址，需要宿主代打，但这里联系不上宿主'));
        return;
      }
      var reqId = 'gem_' + (++HOST.seq) + '_' + Date.now();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        delete HOST.pending[reqId];
        reject(new Error('谷歌直连超时（' + Math.round(HOST_GEMINI_TIMEOUT_MS / 1000) + ' 秒没回）'));
      }, HOST_GEMINI_TIMEOUT_MS);
      HOST.pending[reqId] = function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        delete HOST.pending[reqId];
        if (res && res.ok) {
          var text = String(res.text || '');
          if (onDelta && text) onDelta(text);
          resolve(text);
        } else {
          reject(new Error((res && res.error) || '谷歌直连失败'));
        }
      };
      var sent = postToHost({
        type: 'cinema:geminiRequest',
        requestId: reqId,
        systemPrompt: String(systemPrompt || ''),
        messages: Array.isArray(messages) ? messages : []
      });
      if (!sent) {
        done = true;
        clearTimeout(timer);
        delete HOST.pending[reqId];
        reject(new Error('发给宿主的请求没能送出去'));
      }
    });
  }

  // ============================================================
  // 基础工具
  // ============================================================
  function getState() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (e) { /* noop */ }
    return window.state || null;
  }

  /** 当前影院绑着哪个主聊天 —— 由 CinemaLive.setChat 记着 */
  function getChat() {
    var st = getState();
    var live = window.CinemaLive;
    if (!st || !st.chats || !live) return null;
    var chatId = (typeof live.getChatId === 'function') ? live.getChatId() : null;
    if (!chatId) return null;
    return st.chats[chatId] || null;
  }

  /** 影院这边的剧情记忆 + 此刻实况 (由 cinema-live.js 提供) */
  function getCinemaContext() {
    var live = window.CinemaLive;
    if (!live || typeof live.getCinemaContext !== 'function') return null;
    try { return live.getCinemaContext(); } catch (e) { return null; }
  }

  /** 昵称。默认「我」的时候改用「用户」—— 跟 cinema-live.js 的 buildSystemPrompt 同一口径 */
  function userRefOf(chat) {
    var raw = (chat && chat.settings && chat.settings.myNickname) || '';
    return (!raw || raw === '我') ? '用户' : ('「' + raw + '」');
  }

  function formatTs(ts) {
    try {
      var d = new Date(Number(ts) || Date.now());
      var p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return '(' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
        p(d.getHours()) + ':' + p(d.getMinutes()) + ')';
    } catch (e) { return ''; }
  }

  // ============================================================
  // 主 API 配置
  // ============================================================
  // ⚠️ 铁律五: state.apiConfig 里的地址/密钥只是【启动时的快照】,
  //   换预设之后不会自动更新。所以这里必须走 resolveApiSlotConfig('main')
  //   实时解析, 拿不到才回落快照 —— 跟项目里其它功能一致。
  //
  // 🔴 2026-10-27: 影院跑在 iframe 沙盒里, 沙盒【没有】api-endpoint-presets.js,
  //   也没有 db.apiPresets → 沙盒里 resolveApiSlotConfig 不存在, 只能靠宿主
  //   解析后把 {proxyUrl, apiKey, model} 塞进 window.state.apiConfig。
  //   宿主那条消息是异步的 (要读库), 用户可能比它先发消息 → 这里等一小会儿。
  var API_CONFIG_WAIT_MS = 8000;

  /** 等宿主把主 API 配置送过来 (沙盒场景)。返回 null = 等超时了。 */
  function waitForApiConfig(maxMs) {
    function cur() {
      var st = getState();
      var c = st && st.apiConfig;
      return (c && c.proxyUrl && c.apiKey && c.model) ? c : null;
    }
    var first = cur();
    if (first) return Promise.resolve(first);
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 150;
        var c = cur();
        if (c || waited > maxMs) {
          clearInterval(iv);
          resolve(c);
        }
      }, 150);
    });
  }

  async function getMainApiConfig() {
    var st = getState();
    var cfg = null;
    if (typeof window.resolveApiSlotConfig === 'function') {
      try {
        cfg = await window.resolveApiSlotConfig('main');
      } catch (e) { logWarn('resolveApiSlotConfig 失败, 回落快照', e); }
    }
    if (!cfg) cfg = (st && st.apiConfig) || null;
    // 沙盒场景: 配置可能还在路上 (宿主解析要读库) → 等一小会儿再判失败
    if (!cfg || !cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      var waited = await waitForApiConfig(API_CONFIG_WAIT_MS);
      if (waited) cfg = waited;
    }
    var proxyUrl = String((cfg && cfg.proxyUrl) || '').trim();
    var apiKey = String((cfg && cfg.apiKey) || '').trim();
    var model = String((cfg && cfg.model) || '').trim();
    if (!proxyUrl || !apiKey || !model) {
      throw new Error('主 API 没配好（地址 / API Key / 模型缺一个）');
    }
    // ⚠️【2026-10-29 用户要求】「影院主 API 聊天不能走谷歌直连吗？加上」
    //   是不是谷歌原生地址, 优先用宿主判好的标记 (沙盒里没有 isGeminiNativeUrl),
    //   独立打开页面时才有那个函数 → 自己判。
    var isGeminiNative = !!(cfg && cfg.isGeminiNative);
    if (!isGeminiNative && typeof window.isGeminiNativeUrl === 'function') {
      try { isGeminiNative = !!window.isGeminiNativeUrl(proxyUrl); } catch (e) { /* noop */ }
    }
    return { proxyUrl: proxyUrl, apiKey: apiKey, model: model, isGeminiNative: isGeminiNative };
  }

  // ============================================================
  // 长期记忆 —— 主聊天同一套
  // ============================================================
  async function buildMemoryContext(chat, queryText, hostCtx) {
    var s = (chat && chat.settings) || {};
    var memMode = s.memoryMode || (s.enableStructuredMemory ? 'structured' : 'diary');
    // ① 宿主给的 —— 跟主聊天同一套(向量记忆优先), 沙盒自己算不了
    if (hostCtx && hostCtx.memoryText && String(hostCtx.memoryText).trim()) {
      return String(hostCtx.memoryText);
    }
    // ② 沙盒里如果刚好有这些能力(独立打开沙盒页时的兜底)
    try {
      if (window.vectorMemoryManager && typeof window.vectorMemoryManager.buildMemoryContext === 'function') {
        var v = await window.vectorMemoryManager.buildMemoryContext(chat, memMode, queryText || '');
        if (v && String(v).trim()) return String(v);
      }
    } catch (e) { logWarn('向量记忆失败, 回落普通记忆', e); }
    try {
      if (typeof getMemoryContextForPrompt === 'function') {
        return String(getMemoryContextForPrompt(chat) || '');
      }
    } catch (e) { logWarn('普通记忆失败', e); }
    return '';
  }

  // ============================================================
  // 剥掉主聊天提示词里的【JSON 指令系统】
  // ============================================================
  // 做法: 按 markdown 小节切, 丢掉标题命中黑名单的整节; 再做一遍行级清理。
  // 为什么按小节切而不是"跟模型说别输出 JSON":
  //   跟模型说 = 靠它听话, 不稳; 结构上删掉 = 模型根本看不到 JSON 的样例, 稳。
  //
  // 只按 "#" / "## " 切 —— "### " 留在所属的 "## " 节里, 跟着一起被删。
  var DROP_SECTION_KEYWORDS = [
    '输出格式', '思维链', '可选指令', '行为与指令', '指令列表',
    '资源库', '表情包', '头像库', '能力', '当前情景', '世界观法则'
  ];

  var DROP_LINE_PATTERNS = [
    /严格遵守\s*JSON/i,
    /世界观融合/,
    /thought_chain/,
    /"type"\s*:/,
    /```json/i
  ];

  function splitSections(text) {
    var lines = String(text || '').split(/\r?\n/);
    var sections = [];
    var cur = { title: '', lines: [] };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^#{1,2}\s/.test(ln)) {
        if (cur.title || cur.lines.length) sections.push(cur);
        cur = { title: String(ln).replace(/^#{1,2}\s*/, '').trim(), lines: [ln] };
      } else {
        cur.lines.push(ln);
      }
    }
    if (cur.title || cur.lines.length) sections.push(cur);
    return sections;
  }

  function isDroppedSection(title) {
    var t = String(title || '');
    for (var i = 0; i < DROP_SECTION_KEYWORDS.length; i++) {
      if (t.indexOf(DROP_SECTION_KEYWORDS[i]) >= 0) return true;
    }
    return false;
  }

  function stripInstructionSystem(prompt) {
    var text = String(prompt || '');
    if (!text.trim()) return '';
    var sections = splitSections(text);
    var kept = [];
    for (var i = 0; i < sections.length; i++) {
      if (isDroppedSection(sections[i].title)) continue;
      kept.push(sections[i].lines.join('\n'));
    }
    var lines = kept.join('\n').split(/\r?\n/);
    var clean = [];
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      var drop = false;
      for (var k = 0; k < DROP_LINE_PATTERNS.length; k++) {
        if (DROP_LINE_PATTERNS[k].test(ln)) { drop = true; break; }
      }
      if (!drop) clean.push(ln);
    }
    return clean.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ============================================================
  // 提示词变量表
  // ============================================================
  // 用户点名的清单: 人设 ✅ 长期记忆 ✅ 正常上文 ✅ 影院剧情记忆 ✅ 世界书 ❌
  // 其余变量一律留空 —— 那些是"外面的生活上下文"(天气/联系人/动态/Q区…),
  // 影院里没有, 留着只会占位置, 还可能把模型往"生活记事"上带。
  function buildContextMap(chat, memoryCtx) {
    var s = (chat && chat.settings) || {};
    var charName = (chat && (chat.name || chat.originalName)) || '角色';
    var userNick = s.myNickname || '我';
    var mem = memoryCtx || '';
    return {
      // ---- 人设 / 身份 ----
      'aiPersona': s.aiPersona || '',
      'aiAgeContext': '',
      'myPersona': s.myPersona || '',
      'myNickname': userNick,
      'chat.name': charName,
      'chat.originalName': (chat && chat.originalName) || charName,
      'char_name': charName,
      'char_remark': charName,
      'user_name': userNick,
      'user_nickname': userNick,
      'char_avatar': s.aiAvatar || '',
      'user_avatar': s.myAvatar || '',

      // ---- 世界书: 用户明确不要 ----
      'worldBookContent': '',

      // ---- 长期记忆 ----
      'memoryContextForPrompt': mem,
      'longTermMemoryContext': mem,
      'getMemoryContextForPrompt': mem,
      'linkedMemoryContext': '',
      'multiLayeredSummaryContext': '',
      'periodSummaryContext': '',
      'todoListContext': '',

      // ---- 关系 / 状态 ----
      'userStatus': '在线',
      'userProfileContext': '',
      'nameHistoryContext': '',
      'latestThoughtContext': '',
      'thoughtsPrompt': '',

      // ---- 外面的生活上下文: 影院不需要, 全空 ----
      'timePerceptionContext': '',
      'weatherContext': '',
      'timeContext': '',
      'musicContextStr': '',
      'readingContextStr': '',
      'contactsList': '',
      'postsContext': '',
      'groupContext': '',
      'sharedContext': '',
      'callTranscriptContext': '',
      'synthMusicInstruction': '',
      'narratorInstruction': '',
      'kinshipContext': '',
      'coupleSpaceContext': '',
      'stickerContext': '',
      'aiAvatarLibrary': '',
      'myAvatarLibrary': '',
      'novelAiImageContext': '',
      'googleImagenContext': '',
      'qzoneActionsPrompt': '',
      'viewMyPhonePrompt': '',
      'crossChatInstruction': '',
      'todoInstruction': '',
      'bilingualModeContext': '',
      'bilingualAlertText': '',
      'bilingualAlertVoice': '',
      'currencyExchangeContext': '',
      'proactiveCooldownMinutes': '30',
      'presetContext': '',
      'formatRules': '',
      'historySliceStr': '',
      'memoryModeContext': ''
    };
  }

  // ============================================================
  // 影院场景块 + 剧情记忆块
  // ============================================================
  function buildCinemaSceneBlock(chatRef) {
    var lines = [];
    lines.push('');
    lines.push('# 【现在的情况：你们在一起看剧】');
    lines.push('');
    lines.push('你和' + chatRef + '正在家里的家庭影院一起看电视剧。');
    lines.push('你【看不见】画面 —— 你只能通过下面「你们已经知道的剧情」知道正在演什么。');
    lines.push(chatRef + '就坐在你旁边，跟你一起看。');
    lines.push('电视里的人、剧情，都跟你和' + chatRef + '没有关系，别往' + chatRef + '身上套。');
    lines.push('');
    lines.push('# 【怎么回复】');
    lines.push('');
    lines.push('· 像坐在沙发上一起看剧时随口聊天那样，用【普通文字】说话。');
    lines.push('· 一次说一两句就好，不要长篇大论，不要分条罗列。');
    // 2026-11-03 用户实测: "AI 一开始没有加换行符, 还是一整段输出"。
    //   界面是【按空行把回复拆成多个气泡】的 (见 cinema-live.js 的 finalizeAssistantBubble),
    //   模型不分段就只能挤在一个气泡里。所以这里必须明确要它分段。
    lines.push('· 【要分段】如果要说的话有两层以上的意思，每层单独一段，段与段之间空一行。');
    lines.push('  （不要用 1. 2. 3. 或 - 这类列表符号，是像说话一样自然分段。）');
    // 2026-11-03 用户实测: "我不需要 AI 每句都输出时间戳"。
    //   历史是 "(2026-11-03 20:43) 名字: 内容" 这种格式, 模型会照着模仿。
    //   主聊天靠"必须输出 JSON"把这种模仿挡住了; 这边是纯文字, 只能在提示词里明说。
    lines.push('· 【不要加时间戳】不要输出 "(2026-11-03 20:43)" 这类时间，也不要写「名字: 内容」这种前缀。');
    lines.push('  你在聊天窗里说话，不是在填通话记录 —— 直接说你说的话就行。');
    lines.push('· 你不知道画面细节的时候直说不知道，别编。');
    lines.push('');
    return lines.join('\n');
  }

  function buildCinemaPlotBlock(ctx) {
    var L = [];
    L.push('');
    L.push('# 【你们已经知道的剧情】');
    L.push('');
    if (!ctx) {
      L.push('（还没有剧情记录。）');
      return L.join('\n');
    }

    var head = [];
    if (ctx.title) head.push('正在看《' + ctx.title + '》');
    if (ctx.kind === 'series' && ctx.lastEp) head.push('已经看到第 ' + ctx.lastEp + ' 集');
    else if (ctx.kind === 'film' && ctx.segCount) head.push('已经看了 ' + ctx.segCount + ' 段');
    if (head.length) L.push(head.join('，') + '。');

    var recap = String(ctx.recap || '').trim();
    if (recap) {
      L.push('');
      L.push('## 之前看过的剧情提要');
      L.push(recap);
    }
    var recapText = String(ctx.recapText || '').trim();
    if (recapText && recapText !== recap) {
      L.push('');
      L.push('## 整部剧的提要');
      L.push(recapText);
    }

    var anchor = String(ctx.anchor || '').trim();
    if (anchor) {
      L.push('');
      L.push('## 目前的剧情进度');
      L.push(anchor);
    }

    var eps = ctx.episodes || [];
    if (eps.length) {
      L.push('');
      L.push('## 各集剧情');
      for (var i = 0; i < eps.length; i++) {
        L.push('第 ' + eps[i].ep + ' 集：' + eps[i].text);
      }
    }

    var segs = ctx.segments || [];
    if (segs.length) {
      L.push('');
      L.push('## 各段剧情');
      for (var j = 0; j < segs.length; j++) {
        L.push('第 ' + segs[j].ep + ' 段：' + segs[j].text);
      }
    }

    // 最近一段剧情结束时的那张画面 (2026-10-29) —— 单条, 覆盖式 (不是数组)。
    //   带时间戳, 免得模型把它当成"刚刚发生的事"。
    //   图本身在 messages 里以多模态形式附上 (见 send), 这里只给一句定位说明。
    var live = ctx.liveNow;
    if (live && (String(live.text || '').trim() || live.image)) {
      var ago = live.at ? Math.max(0, Math.round((Date.now() - live.at) / 1000)) : 0;
      L.push('');
      L.push('## 最近一段的画面');
      L.push('（' + ago + ' 秒前, 剧情走到这里的画面' + (live.image ? '，图见下面' : '') + '）');
    }

    return L.join('\n');
  }

  // ============================================================
  // 主聊天历史 → messages
  // ============================================================
  async function buildHistoryMessages(chat, hostCtx) {
    var st = getState();
    var maxMemory = parseInt((chat.settings && chat.settings.maxMemory), 10) ||
      (st && st.globalSettings && parseInt(st.globalSettings.maxMemory, 10)) || 30;

    // ① 宿主给的 —— 外面聊天框的真实历史(已格式化成 "(时间) 名字: 内容")
    //    这是唯一能拿到"外面聊过什么"的路: 沙盒没有 message-store。
    if (hostCtx && Array.isArray(hostCtx.history) && hostCtx.history.length) {
      var fromHost = [];
      for (var h = 0; h < hostCtx.history.length; h++) {
        var item = hostCtx.history[h];
        // 兼容两种: 纯字符串(旧格式) / {role, content}(新格式, 角色不能丢)
        if (typeof item === 'string') {
          if (item.trim()) fromHost.push({ role: 'user', content: item });
          continue;
        }
        if (item && typeof item.content === 'string' && item.content.trim()) {
          fromHost.push({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: item.content
          });
        }
      }
      if (fromHost.length) return fromHost;
    }

    var history = [];
    try {
      if (window.messageStore && typeof window.messageStore.getRecentContextMessages === 'function') {
        history = await window.messageStore.getRecentContextMessages(chat.id, {
          limit: maxMemory,
          excludeHidden: true,
          excludeExcluded: true
        });
      } else if (Array.isArray(chat.history)) {
        history = chat.history.filter(function (m) { return !m.isHidden && !m.isExcluded; }).slice(-maxMemory);
      }
    } catch (e) {
      logWarn('读主聊天历史失败, 回落内存副本', e);
      history = Array.isArray(chat.history) ? chat.history.slice(-maxMemory) : [];
    }
    if (!history || !history.length) return [];

    // "不要发送"规则过滤 —— 主聊天同款
    try {
      if (typeof window.filterHistoryWithDoNotSendRules === 'function') {
        history = await window.filterHistoryWithDoNotSendRules(history, chat.id);
      }
    } catch (e) { logWarn('历史过滤失败, 用原样', e); }

    var out = [];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      if (!m) continue;
      // 只取纯文字 —— 多模态数组在影院里用不上
      if (typeof m.content !== 'string' || !m.content.trim()) continue;

      // 🔴 2026-11-03 修一个真 bug: 宠物说的话被当成了"用户"说的。
      //   宠物消息是 role='system' + type='pet_say' (见 modules/pet-speech.js 的 persistToChat),
      //   而下面原来只判 assistant / 其他, role='system' 直接落到 else →
      //   sender 取 myNickname → 宠物的话在 AI 眼里变成了【用户说的】。
      //   主聊天 (ai-response.js) 是有专门处理的, 这里漏了 → 这里必须跟主聊天一个口径:
      //   转成「[宠物 啾啾] 内容」, role 给 user (主聊天也是这么给)。
      if (m.type === 'pet_say') {
        var petWho = m.petName || m.senderName || '宠物';
        out.push({
          role: 'user',
          content: formatTs(m.timestamp) + ' [宠物 ' + petWho + '] ' + m.content
        });
        continue;
      }
      // 其余 system 消息 (旁白/系统提示) 也标出来, 别让它冒充用户
      if (m.role === 'system') {
        out.push({
          role: 'user',
          content: formatTs(m.timestamp) + ' [系统] ' + m.content
        });
        continue;
      }

      var role = (m.role === 'assistant') ? 'assistant' : 'user';
      var sender = (role === 'assistant')
        ? (m.senderName || chat.name)
        : (chat.settings.myNickname || '我');
      out.push({
        role: role,
        content: formatTs(m.timestamp) + ' ' + sender + ': ' + m.content
      });
    }
    return out;
  }

  // ============================================================
  // 组 system prompt
  // ============================================================
  /**
   * 渲染主聊天的提示词预设 (模板 + 变量替换) —— 【不加影院块, 不剥指令】。
   *
   * 宿主也会调它 (宿主那边才有 getActiveChatPrompt / replaceTemplateVars),
   * 渲好之后发给沙盒, 沙盒那边再剥 JSON 指令系统。
   *
   * ⚠️ 没有 replaceTemplateVars 就【渲染不了】(沙盒里就是这个情况) ——
   *   这时候返回空字符串, 让调用方走兜底最小人设。
   *   绝不能发一份变量全被抹空的提示词给模型(看着像提示词, 其实是空的)。
   */
  async function renderPromptText(chat, memoryCtx) {
    var template = '';
    try {
      if (typeof window.getActiveChatPrompt === 'function') {
        template = window.getActiveChatPrompt('single') || '';
      }
    } catch (e) { logWarn('读提示词预设失败', e); }
    if (!String(template).trim()) return '';
    if (typeof window.replaceTemplateVars !== 'function') return '';
    var ctx = buildContextMap(chat, memoryCtx);
    var filled = '';
    try {
      filled = window.replaceTemplateVars(template, ctx);
    } catch (e) {
      logWarn('提示词变量替换失败, 用原样', e);
      filled = template;
    }
    // 剩下的 {{xxx}} 一律抹掉 —— 影院里没有的那些上下文不要留占位符
    return String(filled).replace(/\{\{[^{}]*\}\}/g, '');
  }

  async function buildSystemPrompt(chat, memoryCtx, cinemaCtx, hostCtx) {
    var chatRef = userRefOf(chat);
    var out = '';

    // ① 宿主渲染好的提示词 (人设 / 关键关系 / 说话方式全在里面)
    var promptText = (hostCtx && hostCtx.promptText) ? String(hostCtx.promptText) : '';
    if (!promptText.trim()) promptText = await renderPromptText(chat, memoryCtx);
    if (promptText.trim()) {
      out = stripInstructionSystem(promptText);
    }

    // 兜底: 连提示词预设都没有 → 自己拼一份最小人设
    //
    // ⚠️ 这里必须自己 join('\n') —— 不能把【数组】直接赋给 out。
    //   out 下面还要 += 影院场景块, 数组被字符串化时走的是 Array.toString(),
    //   元素之间用【逗号】连接, 那些故意留的空行就变成了 ",,":
    //     "# 你是谁,,你就是「测试角色」。,,人设标记ZZZ,"
    //   排版全毁, 模型读到的提示词也一塌糊涂。
    if (!out.trim()) {
      var s = (chat && chat.settings) || {};
      var fb = ['# 你是谁', '', '你就是「' + ((chat && (chat.name || chat.originalName)) || '角色') + '」。'];
      if (s.aiPersona) { fb.push(''); fb.push(s.aiPersona); }
      fb.push('');
      out = fb.join('\n');
    }

    out += buildCinemaSceneBlock(chatRef);
    out += buildCinemaPlotBlock(cinemaCtx || getCinemaContext());
    return out;
  }

  // ============================================================
  // 调主 API
  // ============================================================
  async function streamChat(url, apiKey, payload, onDelta, signal) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
      signal: signal
    });
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('主 API ' + res.status + ' ' + String(errText).slice(0, 200));
    }
    if (!res.body || !res.body.getReader) {
      var all = await res.text();
      if (all) onDelta(all);
      return all;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var full = '';
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      var parts = buf.split('\n');
      buf = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        var line = String(parts[i]).trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        var delta = '';
        try {
          var obj = JSON.parse(data);
          var ch = obj.choices && obj.choices[0];
          delta = (ch && ch.delta && ch.delta.content) || '';
        } catch (e) { continue; }
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    }
    return full;
  }

  async function callMainApi(cfg, systemPrompt, messages, onDelta) {
    var st = getState();
    var gs = (st && st.globalSettings) || {};
    var isGemini = !!cfg.isGeminiNative ||
      ((typeof isGeminiNativeUrl === 'function')
        ? isGeminiNativeUrl(cfg.proxyUrl)
        : false);
    var streaming = gs.enableStreaming === true && !isGemini;
    var signal = S.controller ? S.controller.signal : undefined;

    var payload = {
      model: cfg.model,
      messages: [{ role: 'system', content: systemPrompt }].concat(messages),
      temperature: gs.apiTemperature || 0.8,
      top_p: gs.apiTopP !== undefined ? gs.apiTopP : 1.0,
      presence_penalty: gs.apiPresencePenalty !== undefined ? gs.apiPresencePenalty : 0.0,
      frequency_penalty: gs.apiFrequencyPenalty !== undefined ? gs.apiFrequencyPenalty : 0.0
    };

    if (isGemini) {
      // Gemini 原生格式 —— 主聊天同一套转换
      // ⚠️【2026-10-29】影院跑在 iframe 沙盒里, 沙盒【没有】ai-response.js /
      //   utils.js → 没有 toGeminiRequestData → 谷歌原生地址必须【请宿主代打】。
      //   (以前沙盒把 isGemini 判成 false, 拿 OpenAI 兼容的 /chat/completions
      //    打到谷歌原生地址上 → 必 404。)
      if (typeof window.toGeminiRequestData !== 'function') {
        return await callGeminiViaHost(cfg, systemPrompt, messages, onDelta);
      }
      var g = window.toGeminiRequestData(cfg.model, cfg.apiKey, systemPrompt, messages);
      var gres = await fetch(g.url, g.data);
      if (!gres.ok) {
        var gerr = await gres.text().catch(function () { return ''; });
        throw new Error('主 API ' + gres.status + ' ' + String(gerr).slice(0, 200));
      }
      var gdata = await gres.json();
      var gtxt = (typeof getGeminiResponseText === 'function')
        ? getGeminiResponseText(gdata)
        : (((gdata.candidates && gdata.candidates[0] && gdata.candidates[0].content && gdata.candidates[0].content.parts) || [])
          .map(function (p) { return p.text || ''; }).join(''));
      if (onDelta && gtxt) onDelta(gtxt);
      return gtxt;
    }

    // ⚠️ 铁律一: 站点地址用户自己填全 (通常带 /v1), 程序【只补 /chat/completions】
    var url = cfg.proxyUrl.replace(/\/+$/, '') + '/chat/completions';

    if (streaming) {
      try {
        var sp = {};
        for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) sp[k] = payload[k];
        sp.stream = true;
        return await streamChat(url, cfg.apiKey, sp, onDelta, signal);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        logWarn('流式失败, 回退非流式', e);
      }
    }

    // 非流式 —— 开了「主 API 代理」就走后端代理 (跟主聊天一致)
    var useProxy = typeof window.fetchViaOpenAICompatibleProxy === 'function'
      && typeof window.isMainApiProxyEnabled === 'function'
      && window.isMainApiProxyEnabled();
    var np = {};
    for (var k2 in payload) if (Object.prototype.hasOwnProperty.call(payload, k2)) np[k2] = payload[k2];
    np.stream = false;

    var res;
    if (useProxy) {
      res = await window.fetchViaOpenAICompatibleProxy({
        baseUrl: cfg.proxyUrl,
        targetPath: '/chat/completions',
        apiKey: cfg.apiKey,
        payload: np,
        method: 'POST',
        signal: signal
      });
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(np),
        signal: signal
      });
    }
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('主 API ' + res.status + ' ' + String(errText).slice(0, 200));
    }
    var json = await res.json();
    var content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    if (onDelta && content) onDelta(content);
    return content;
  }

  // ============================================================
  // 落进主聊天历史
  // ============================================================
  // 用户原话: "影院的会话就是要主聊天知道啊, 不存在污染" ——
  //   影院里说的话进主聊天历史, 外面聊天框接着就能看到, 主聊天也接得上茬。
  async function persistToMainChat(chat, msg) {
    // ① 宿主通道 —— 影院的对话要真的进主聊天历史
    //    (用户原话: "影院的会话就是要主聊天知道啊, 不存在污染")
    //    沙盒里没有 message-store, 以前只能往本地那个假 db 上写,
    //    结果退出影院这段对话就没了, 外面也看不见。
    try {
      if (canPostToHost()) {
        postToHost({
          type: 'cinema:chatMessage',
          message: {
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp || Date.now(),
            senderName: msg.senderName || ''
          }
        });
        return true;
      }
    } catch (e) { logWarn('写进主聊天历史失败 (宿主通道)', e); }

    // ② 兜底: 本地内存副本
    try {
      if (window.messageStore && typeof window.messageStore.addMessageToChat === 'function') {
        await window.messageStore.addMessageToChat(chat, msg);
        return true;
      }
      if (!Array.isArray(chat.history)) chat.history = [];
      chat.history.push(msg);
      if (window.db && window.db.chats && typeof window.db.chats.put === 'function') {
        await window.db.chats.put(chat);
      }
      return true;
    } catch (e) {
      logWarn('写进主聊天历史失败 (不影响聊天本身)', e);
      return false;
    }
  }

  // ============================================================
  // 对外: 发一条
  // ============================================================
  async function send(text) {
    var msg = String(text || '').trim();
    if (!msg) return false;
    if (S.busy) {
      logWarn('上一句还没回完, 这次没发出去');
      var uiBusy = window.CinemaLive;
      if (uiBusy && typeof uiBusy.appendSystemLine === 'function') {
        uiBusy.appendSystemLine('⏳ 上一句还没回完，稍等一下。');
      }
      return false;
    }

    var chat = getChat();
    if (!chat) {
      logError('拿不到当前聊天对象');
      // ⚠️ 以前这里只 logError, 界面上一点动静都没有 ——
      //   用户看到的就是"打了字没反应", 会以为是模型断了。
      //   陪聊跟 Live 是两条独立的路, 这里失败跟 Gemini 连不连得上无关。
      var uiNoChat = window.CinemaLive;
      if (uiNoChat && typeof uiNoChat.appendSystemLine === 'function') {
        uiNoChat.appendSystemLine('⚠️ 陪聊用不了：没绑上聊天角色（回退到外面再进一次影院试试）。');
      }
      return false;
    }

    S.busy = true;
    S.lastError = '';
    S.controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (S.controller) { try { S.controller.abort(); } catch (e) { /* noop */ } }
    }, REQUEST_TIMEOUT_MS);

    try {
      var ui = window.CinemaLive;
      if (ui && typeof ui.resetBubble === 'function') ui.resetBubble();
      if (ui && typeof ui.appendUserBubble === 'function') ui.appendUserBubble(msg);

      // ① 先问宿主要一份最新的上下文 (外面聊天框的历史 + 长期记忆 + 提示词)
      //    沙盒自己算不了这些 —— message-store / memory-summary 都不在沙盒里。
      var hostCtx = await requestHostContext(msg);

      // ⚠️ 顺序很重要: 先读历史, 再落库。
      //   反过来的话, 刚落库的那句会在历史里出现一次, 我们又手动拼一次 → 重复。
      var history = await buildHistoryMessages(chat, hostCtx);
      var memoryCtx = await buildMemoryContext(chat, msg, hostCtx);
      var cinemaCtx = getCinemaContext();
      var systemPrompt = await buildSystemPrompt(chat, memoryCtx, cinemaCtx, hostCtx);

      await persistToMainChat(chat, { role: 'user', content: msg, timestamp: Date.now() });

      var cfg = await getMainApiConfig();
      var messages = history.concat([{ role: 'user', content: msg }]);

      // 🔴 2026-10-29: 附上【最近一段剧情结束时的那张画面】(阅后即焚)。
      //   主 API 靠文字剧情总结聊天, 偶尔能看见这张图就够了 ——
      //   不再让 Live 每 30 秒写一句「此刻画面」(那会把 Live 的串行 turn 队列占满,
      //    摘要被挤到后面撞超时 → 一句剧情总结都没写)。
      var shot = cinemaCtx && cinemaCtx.liveNow && cinemaCtx.liveNow.image;
      var withShot = !!shot;
      if (withShot) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: '（这是刚才那段剧情结束时的画面）' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot } }
          ]
        });
      }

      var full = '';
      var answer = null;
      try {
        answer = await callMainApi(cfg, systemPrompt, messages, function (delta) {
          full += delta;
          if (ui && typeof ui.renderAssistantBubble === 'function') ui.renderAssistantBubble(full);
        });
      } catch (e) {
        // 主 API 不支持识图 → 带图请求会 400 → 自动重试一次不带图的, 陪聊照常
        if (!withShot) throw e;
        logWarn('带图请求失败, 回落成纯文字重试一次:', (e && e.message) || e);
        messages = messages.filter(function (m) {
          return !(Array.isArray(m.content) && m.content.some(function (p) { return p.type === 'image_url'; }));
        });
        answer = await callMainApi(cfg, systemPrompt, messages, function (delta) {
          full += delta;
          if (ui && typeof ui.renderAssistantBubble === 'function') ui.renderAssistantBubble(full);
        });
      } finally {
        // 🔴 2026-10-29: 【阅后即焚】—— 图用完立刻烧掉, 不留在任何地方。
        //   主 API 那头已经看过了; 再留着只会越堆越多 (内存/备份/导出都跟着涨)。
        if (withShot) {
          try {
            if (window.CinemaLive && typeof window.CinemaLive.burnLiveNowImage === 'function') {
              window.CinemaLive.burnLiveNowImage();
            }
          } catch (e2) { /* noop */ }
        }
      }

      full = String(answer || full || '').trim();
      if (!full) throw new Error('主 API 返回了空内容');

      // 收尾渲染: 优先走 finalizeAssistantBubble —— 它会把整段按段落拆成多个气泡,
      // 观感跟主聊天一致 (主聊天 AI 一次会显示好几条)。没有就回退原来的单气泡。
      if (ui && typeof ui.finalizeAssistantBubble === 'function') {
        ui.finalizeAssistantBubble(full);
      } else if (ui && typeof ui.renderAssistantBubble === 'function') {
        ui.renderAssistantBubble(full);
      }
      if (ui && typeof ui.recordAssistant === 'function') ui.recordAssistant(full);

      await persistToMainChat(chat, {
        role: 'assistant',
        content: full,
        senderName: chat.name,
        timestamp: Date.now()
      });
      return true;
    } catch (e) {
      S.lastError = (e && e.message) || String(e);
      logError('陪聊失败: ' + S.lastError, e);
      var ui2 = window.CinemaLive;
      if (ui2 && typeof ui2.appendSystemLine === 'function') {
        ui2.appendSystemLine('⚠️ 聊天失败：' + S.lastError);
      }
      return false;
    } finally {
      clearTimeout(timer);
      S.busy = false;
      S.controller = null;
    }
  }

  // ============================================================
  window.CinemaChat = {
    send: send,
    isBusy: function () { return S.busy; },
    lastError: function () { return S.lastError; },
    // 暴露给测试用
    buildSystemPrompt: buildSystemPrompt,
    buildContextMap: buildContextMap,
    buildCinemaPlotBlock: buildCinemaPlotBlock,
    buildCinemaSceneBlock: buildCinemaSceneBlock,
    buildHistoryMessages: buildHistoryMessages,
    buildMemoryContext: buildMemoryContext,
    renderPromptText: renderPromptText,
    stripInstructionSystem: stripInstructionSystem,
    splitSections: splitSections,
    userRefOf: userRefOf,
    // 宿主上下文通道 (宿主 ↔ 沙盒)
    setHostContext: setHostContext,
    getHostContext: function () { return HOST.ctx; },
    // ⚠️【2026-10-29】暴露给测试用: 谷歌原生直连的「请宿主代打」往返
    callGeminiViaHost: callGeminiViaHost,
    requestHostContext: requestHostContext,
    canPostToHost: canPostToHost,
    // 暴露给测试用: 主 API 配置是怎么拿到的 (沙盒场景靠宿主下发)
    getMainApiConfig: getMainApiConfig
  };

  log('已加载 (影院陪聊走主 API; Gemini Live 只负责看画面 + 写剧情记忆)');
})();

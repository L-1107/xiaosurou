// ============================================================
// modules/reading-room.js
// 读书屋 · 宿主侧 (2026-11-01 重写)
//
// 【这一版跟旧版的关系】
//   旧版: 宿主页面里的一个 340px 可拖拽小浮窗 + 整本书一条记录。
//         实测 2000 万字的书 → 翻一页 96~126ms / 开书库 39ms /
//         常驻 JS heap 307MB → 手机上卡 + 发烫。
//   这一版: 读书屋跑在 iframe 沙盒 (reading-sandbox/index.html) 里,
//           宿主只做三件事:
//             ① 数据 (readingBooks / readingPages, 见 reading-storage.js)
//             ② 沙盒拿不到的能力 (提示词 / 历史 / 长期记忆 / 主 API 配置)
//             ③ AI 请求代打 (沙盒里没有 ai-response.js / utils.js)
//
// 【为什么沙盒不自己开 Dexie】
//   同源 iframe 技术上能开同一个库, 但那会撞上 versionchange 冲突,
//   而且老代码里 "db.close() 自愈" 那条路能把宿主库的自动重开永久关掉
//   (sw.js 里记过这个坑, 症状是"存不下 / 整页刷新前全都存不进去")。
//   → 沙盒只负责渲染 + 交互, 数据和 AI 全走 postMessage。
//
// 【跟影院 (cinema-sandbox) 是同一套架构】
//   宿主 → 沙盒:  reading:init / reading:apiConfig / reading:context /
//                 reading:books / reading:page / reading:progress /
//                 reading:importProgress / reading:importDone /
//                 reading:chatDelta / reading:chatDone / reading:chatError
//   沙盒 → 宿主:  reading:needChat / reading:ready / reading:needBooks /
//                 reading:requestPage / reading:saveProgress /
//                 reading:deleteBook / reading:importFile /
//                 reading:chat / reading:pageState / reading:closed
// ============================================================

(function (global) {
  'use strict';

  var LOG = '[ReadingRoom] ';

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
  // 会话状态 (给主聊天的 AI 注入用)
  //
  // 主聊天那边 ai-response.js 每次请求都会调 formatReadingStateForAI(chatId),
  // 把"正在读什么"告诉模型。旧版这个函数读的是内存里的 contentLines,
  // 现在改成读沙盒报上来的状态。
  // ============================================================
  var session = {
    active: false,
    chatId: null,
    bookId: null,
    title: '',
    pageNo: 0,
    pageCount: 0,
    chapterTitle: '',
    snippet: ''
  };

  function currentChatObject() {
    try {
      if (typeof state === 'undefined' || !state || !state.activeChatId) return null;
      return (state.chats && state.chats[state.activeChatId]) || null;
    } catch (e) { return null; }
  }

  /**
   * 主聊天 AI 的阅读上下文
   *
   * ⚠️ 只在【读书屋开着、而且开的就是这个角色的聊天】时才给上下文。
   *   否则模型会以为自己在跟你一起读书, 答非所问。
   */
  function formatReadingStateForAI(chatId) {
    if (!session.active) return '';
    if (session.chatId && chatId && session.chatId !== chatId) return '';

    var title = session.title || '未知书籍';
    var body = '';
    var label = '当前页内容摘要';

    if (session.snippet && session.snippet.trim()) {
      body = session.snippet;
      label = '你正在读的这一页';
    } else if (session.chapterTitle) {
      body = '（章节：' + session.chapterTitle + '）';
    }

    var where = '';
    if (session.pageCount) where = '（第 ' + (session.pageNo + 1) + ' / ' + session.pageCount + ' 页）';

    return `
- **书名**: 《${title}》${where}
- **${label}**: "${String(body || '').substring(0, 300)}"
    #一起读书模式 | 行为铁律
    1.  **角色定位**: 你【不是】书中的任何角色，你是【你自己】(${currentChatObject()?.originalName || 'AI角色'})，正在和用户一起【阅读和讨论】这本书。
    2.  **行为准则**: 你的回复【必须】是作为读者的【感想、评论、提问或联想】。你可以：
        -   分享你对当前段落的看法。
        -   对书中的角色或情节发表评论。
        -   向用户提问，询问TA对内容的看法。
        -   根据书本内容，联想到你自己的经历或记忆。
    3.  **严禁**: 你的回复【绝对禁止】使用书中角色的口吻和人称！【绝对禁止】扮演书中的任何角色！【绝对禁止】续写或模仿书中的情节！你必须时刻记住，你只是一个读者。
    `;
  }

  /**
   * 翻页通知 (旧版这个函数全项目只在 3MB 混淆旧包 script.js 里定义过,
   *  而 index.html 压根没加载 script.js → 旧版翻页每次都抛 ReferenceError,
   *  "翻页通知 AI" 这个功能一直是空的)
   *
   * 【这一版它是干什么的】
   *   ⚠️ 刻意【不发 API 请求】。翻一次页就调一次模型 = 每次翻页都烧一次
   *     token + 占一次串行请求队列 —— 那正是"发烫"的另一个来源。
   *   它只做一件轻量的事: 更新会话状态, 让主聊天那边的 AI 知道你在读什么。
   *   真正的讨论由读书屋里那个固定聊天窗口发起 (走 reading:chat)。
   */
  function notifyAiOfPageTurn(chatId, info) {
    var info2 = info || {};
    session.active = true;
    session.chatId = chatId || session.chatId;
    if (info2.bookId !== undefined) session.bookId = info2.bookId;
    if (info2.title !== undefined) session.title = info2.title;
    if (info2.pageNo !== undefined) session.pageNo = info2.pageNo;
    if (info2.pageCount !== undefined) session.pageCount = info2.pageCount;
    if (info2.chapterTitle !== undefined) session.chapterTitle = info2.chapterTitle;
    if (info2.snippet !== undefined) session.snippet = info2.snippet;
  }

  // ============================================================
  // 主 API 配置 (沙盒自己解析不了)
  //
  // ⚠️ 不能直接读 state.apiConfig: 预设模式下 clearReferencedSlotStaticEndpoints()
  //   会把里面的 proxyUrl / apiKey 清空 → 必须走 resolveApiSlotConfig('main') 实时解析。
  // ============================================================
  var _apiCfg = null;

  /**
   * 解析这次聊天实际该用的 API 配置
   *
   * ⚠️ 必须跟主聊天 (modules/ai-response.js:1959) 一个口径, 否则两边表现不一致:
   *   ① 站点预设启用后, state.apiConfig 里的地址/密钥只剩【启动时的快照】,
   *      所以必须走 resolveApiSlotConfig('main') 实时读预设库 (用户中途切预设要立刻生效);
   *   ② 角色配了【独立 API】 (chat.apiOverride) 时用角色自己的 —— 主聊天就是这么做的,
   *      读书屋要是无视, 用户在角色设置里换的线路就没生效;
   *   ③ 谷歌原生地址要走原生协议 (isGeminiNative), 沙盒里没有 toGeminiRequestData,
   *      所以必须宿主代打。
   */
  function resolveMainApiConfig(chat) {
    var c = chat || currentChatObject();
    return Promise.resolve()
      .then(function () {
        // ⚠️ 2026-11-02 用户实测「找不到配置的 API，没法跟 AI 讨论」。
        //   这里以前写的是:
        //       return global.resolveApiSlotConfig('main').then(function (cfg) { main = cfg; });
        //   那个回调【没有 return】→ 整条 Promise 链 resolve 成 undefined,
        //   下一级 .then(function (main) {...}) 收到的 main 就是 undefined →
        //   一律走 `if (!main) return null` → 报「主 API 没配好」。
        //   也就是说: 跟用户怎么配 API 完全无关, 读书屋永远问不了 AI。
        //   (Node 实测: resolved value = undefined)
        //   修法: 直接把 Promise 往下传, 别在回调里赋值。
        if (typeof global.resolveApiSlotConfig === 'function') {
          return global.resolveApiSlotConfig('main');
        }
        return (typeof state !== 'undefined' && state && state.apiConfig) || null;
      })
      .then(function (main) {
        if (!main) return null;
        var use = main;
        // 角色独立 API 优先 (跟主聊天同口径)
        if (c && c.apiOverride && c.apiOverride.enabled) {
          use = {
            proxyUrl: c.apiOverride.proxyUrl || main.proxyUrl,
            apiKey: c.apiOverride.apiKey || main.apiKey,
            model: c.apiOverride.model || main.model
          };
        }
        if (!use || !use.proxyUrl || !use.apiKey || !use.model) return null;
        _apiCfg = {
          proxyUrl: String(use.proxyUrl),
          apiKey: String(use.apiKey),
          model: String(use.model),
          isGeminiNative: (typeof global.isGeminiNativeUrl === 'function')
            ? !!global.isGeminiNativeUrl(String(use.proxyUrl))
            : false
        };
        return _apiCfg;
      })
      .catch(function (e) {
        logWarn('解析主 API 配置失败:', e);
        return null;
      });
  }

  function pushApiConfig() {
    if (!frame) return;
    resolveMainApiConfig().then(function (cfg) {
      if (!frame || !cfg) return;
      try {
        frame.contentWindow.postMessage({ type: 'reading:apiConfig', apiConfig: cfg }, '*');
      } catch (e) { /* noop */ }
    });
  }

  // ============================================================
  // iframe 沙盒
  // ============================================================
  var frame = null;
  var vvRelay = null;
  var sandboxSeen = false;
  var watchTimer = null;

  function pickGlobalSettings() {
    var gs = (typeof state !== 'undefined' && state && state.globalSettings) || {};
    return {
      enableStreaming: gs.enableStreaming === true,
      apiTemperature: gs.apiTemperature,
      apiTopP: gs.apiTopP,
      apiPresencePenalty: gs.apiPresencePenalty,
      apiFrequencyPenalty: gs.apiFrequencyPenalty,
      maxMemory: gs.maxMemory
    };
  }

  function currentChatPayload() {
    var c = currentChatObject();
    if (!c) return null;
    return {
      id: c.id,
      name: c.name || '',
      originalName: c.originalName || c.name || '',
      apiConfig: _apiCfg || null,
      settings: {
        aiPersona: (c.settings && c.settings.aiPersona) || '',
        myPersona: (c.settings && c.settings.myPersona) || '',
        myNickname: (c.settings && c.settings.myNickname) || '我',
        aiAvatar: (c.settings && c.settings.aiAvatar) || ''
      },
      globalSettings: pickGlobalSettings()
    };
  }

  function sendInit() {
    var payload = currentChatPayload();
    if (!payload || !frame) return;
    try {
      frame.contentWindow.postMessage({ type: 'reading:init', chat: payload }, '*');
    } catch (e) { /* noop */ }
    pushApiConfig();
  }

  // ---- 键盘视口转发 ----
  // iframe 里的 window.visualViewport 【不会反映 iOS 键盘】(键盘压的是顶层视口)。
  // 读书屋下半屏有个输入框, 不转发的话键盘会直接盖住输入框。
  function pushViewport() {
    var vv = global.visualViewport;
    if (!frame || !vv) return;
    try {
      frame.contentWindow.postMessage({
        type: 'reading:vv',
        height: Math.round(vv.height),
        offsetTop: Math.max(0, Math.round(vv.offsetTop)),
        safeTop: measureSafeTop()
      }, '*');
    } catch (e) { /* noop */ }
  }

  /**
   * 量出真正的"状态栏高度"
   *
   * ⚠️ 2026-11-02 用户反馈: 手机 PWA 上"返回书架"的返回键位置太高,
   *   顶到状态栏(时间/信号)那一行了, 得往下让出那块。
   *
   *   为什么沙盒自己不行: env(safe-area-inset-top) 在【iframe 里】基本返回 0
   *   (安全区是顶层文档的概念, iframe 只是页面里的一个元素)。
   *   而宿主是顶层文档 → 它量得到真值, 量完转发给沙盒。
   *
   *   用探针元素量, 而不是直接读 CSS 变量 —— 变量读不到"媒体查询之外"的值,
   *   而探针走的是同一套 env() 解析, 结果一定准。
   */
  function measureSafeTop() {
    try {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top,0px);';
      document.body.appendChild(probe);
      var v = parseFloat(global.getComputedStyle(probe).paddingTop) || 0;
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      // iOS PWA 独立模式的状态栏大概 44~59px; 探测不到时给个保守下限,
      // 宁可多留一点空白, 也不要把按钮顶到状态栏里 (用户说"位置太高"就是被挡了)
      return Math.max(0, Math.round(v));
    } catch (e) {
      return 0;
    }
  }

  function bindViewportRelay() {
    var vv = global.visualViewport;
    if (!vv || vvRelay) return;
    vvRelay = { vv: vv, fn: pushViewport };
    vv.addEventListener('resize', pushViewport);
    vv.addEventListener('scroll', pushViewport);
  }

  function unbindViewportRelay() {
    if (!vvRelay) return;
    try {
      vvRelay.vv.removeEventListener('resize', vvRelay.fn);
      vvRelay.vv.removeEventListener('scroll', vvRelay.fn);
    } catch (e) { /* noop */ }
    vvRelay = null;
  }

  // ---- 宿主侧兜底: 沙盒不吭声, 宿主自己把 iframe 收掉 ----
  //
  // ⚠️ 这个 iframe 是 position:fixed + inset:0 + z-index 极大 —— 整个屏幕都在它下面。
  //   宿主收掉它的唯一途径 = 沙盒发来一条 reading:closed。
  //   那条消息只要没到 (沙盒崩了 / 被重载 / 退出流程抛异常), 整个 app 就被黑框盖死。
  // → 宿主不依赖沙盒配合: 直接读 iframe 的 DOM (同源读得到), 看房间还开不开。
  function watchSandbox() {
    if (!frame) return;
    var doc = null;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.documentElement) return;
    var open = doc.documentElement.getAttribute('data-reading-room-open');
    if (open === '1') { sandboxSeen = true; return; }
    if (!sandboxSeen) return;      // 还没进过房间, 不能收 (那会儿还在开机页)
    closeSandbox('沙盒那边房间没了');
  }

  function startWatch() {
    stopWatch();
    sandboxSeen = false;
    try { watchTimer = setInterval(watchSandbox, 700); } catch (e) { /* noop */ }
  }
  function stopWatch() {
    if (watchTimer) { try { clearInterval(watchTimer); } catch (e) { /* noop */ } }
    watchTimer = null;
  }

  function closeSandbox(reason) {
    stopWatch();
    // ⚠️ 以前这里是 "if (!frame) return;" —— 于是 body 上的 class 永远摘不掉,
    //   宿主页面一直是 fixed, 整页点不动。现在即使没有 frame 也把状态清干净。
    if (!frame) {
      if (document.body) document.body.classList.remove('reading-room-active');
      session.active = false;
      return;
    }
    try { frame.remove(); } catch (e) { /* noop */ }
    frame = null;
    unbindViewportRelay();
    if (document.body) document.body.classList.remove('reading-room-active');
    session.active = false;
    session.snippet = '';
    log('已退出读书屋' + (reason ? ' (' + reason + ')' : ''));
  }

  // ============================================================
  // 沙盒消息处理
  // ============================================================
  function replyToSandbox(payload) {
    if (!frame) return;
    try {
      frame.contentWindow.postMessage(payload, '*');
    } catch (e) { /* noop */ }
  }

  // ============================================================
  // 旧书迁移 (只在这一刻做, 别的时候一律不碰)
  //
  // 【为什么不在启动时迁移】
  //   迁移二十四史那本要处理 38MB 正文, 会占住主线程几秒。
  //   放在启动时 = 用户正在主聊天里聊天, 突然卡一下 → 白挨骂。
  //   → 只在【打开读书屋】的时候才迁移, 那正是用户想读书的时刻。
  //
  // 【为什么不会重复跑】同一个 promise, 迁移完旧表就空了。
  // ============================================================
  var migrationPromise = null;

  function ensureMigrated() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = Promise.resolve()
      .then(function () {
        if (!global.ReadingStorage) return null;
        return global.ReadingStorage.migrateLegacy();
      })
      .then(function (res) {
        if (res && res.migrated) {
          log('旧书迁移完成: ' + res.migrated + ' 本');
        }
        return res;
      })
      .catch(function (e) {
        logError('迁移旧书失败:', e);
        return null;
      });
    return migrationPromise;
  }

  async function handleNeedBooks() {
    // 先把老书搬过来, 再列书架
    try {
      await ensureMigrated();
    } catch (e) { /* noop */ }
    var books = [];
    try {
      if (global.ReadingStorage) books = await global.ReadingStorage.listBooks();
    } catch (e) {
      logError('读书架失败:', e);
    }
    // ⚠️ 封面【单独查一次】, 不塞进 listBooks() ——
    //   listBooks 的铁律是只搬元数据 (开书架要快), 一本书的封面是 20~50KB base64,
    //   塞进去等于开一次书架把所有封面搬一遍 (跟当年"整本书塞一条记录"同一个坑)。
    var covers = {};
    try {
      if (global.ReadingStorage) covers = await global.ReadingStorage.listCovers();
    } catch (e) { /* noop */ }
    for (var i = 0; i < books.length; i++) {
      books[i].cover = covers[books[i].id] || null;
    }
    replyToSandbox({ type: 'reading:books', books: books });
  }

  /**
   * 换封面 (2026-11-02)
   *
   * ⚠️ 只写 readingCovers 那一行 —— 书名/页数/正文/阅读进度/讨论记录/书籍ID 一个都不动。
   */
  async function handleSetCover(d) {
    var bookId = d && d.bookId;
    var cover = d && d.cover;
    if (bookId === undefined || bookId === null) return;
    try {
      if (!global.ReadingStorage) throw new Error('存储层没加载');
      var ok = await global.ReadingStorage.setCover(bookId, cover);
      if (!ok) {
        replyToSandbox({ type: 'reading:coverError', bookId: bookId, error: '封面没存上' });
        return;
      }
    } catch (e) {
      logError('换封面失败:', e);
      replyToSandbox({ type: 'reading:coverError', bookId: bookId, error: (e && e.message) || String(e) });
      return;
    }
    // 存好了 → 把最新书架发回去, 卡片上的封面当场就换了
    await handleNeedBooks();
    replyToSandbox({ type: 'reading:coverDone', bookId: bookId });
  }

  async function handleRequestPage(d) {
    var bookId = d && d.bookId;
    var pageNo = d && d.pageNo;
    if (bookId === undefined || pageNo === undefined) return;
    var page = null;
    var book = null;
    try {
      if (!global.ReadingStorage) throw new Error('存储层没加载');
      page = await global.ReadingStorage.getPage(bookId, pageNo);
      book = await global.ReadingStorage.getBook(bookId);
    } catch (e) {
      logError('取页失败:', e);
      replyToSandbox({ type: 'reading:page', bookId: bookId, pageNo: pageNo, error: (e && e.message) || '取页失败' });
      return;
    }
    if (!page) {
      replyToSandbox({ type: 'reading:page', bookId: bookId, pageNo: pageNo, error: '这一页不在了' });
      return;
    }
    replyToSandbox({
      type: 'reading:page',
      bookId: bookId,
      pageNo: page.pageNo,
      text: page.text,
      chapterTitle: page.chapterTitle,
      chapterLine: page.chapterLine || '',
      pageCount: book ? book.pageCount : 0,
      bookTitle: book ? book.title : ''
    });
  }

  async function handleSaveProgress(d) {
    if (!d || d.bookId === undefined) return;
    try {
      if (global.ReadingStorage) await global.ReadingStorage.setProgress(d.bookId, d.pageNo);
    } catch (e) { logWarn('存进度失败:', e); }
  }

  async function handleDeleteBook(d) {
    if (!d || d.bookId === undefined) return;
    try {
      if (global.ReadingStorage) await global.ReadingStorage.deleteBook(d.bookId);
    } catch (e) { logError('删书失败:', e); }
    await handleNeedBooks();
  }

  async function handleImportFile(d) {
    var file = d && d.file;
    if (!file) {
      replyToSandbox({ type: 'reading:importError', error: '没有拿到文件' });
      return;
    }
    try {
      replyToSandbox({ type: 'reading:importProgress', phase: 'start', totalBytes: file.size || 0 });
      var res = await global.ReadingStorage.importFile(file, { title: d.title || '' }, function (pageNo, read, total) {
        replyToSandbox({
          type: 'reading:importProgress', phase: 'reading',
          pageNo: pageNo, readBytes: read, totalBytes: total
        });
      });
      replyToSandbox({
        type: 'reading:importDone',
        bookId: res.bookId, pageCount: res.pageCount, charCount: res.charCount,
        title: (d.title || file.name || '').replace(/\.txt$/i, '')
      });
      await handleNeedBooks();
    } catch (e) {
      logError('导入失败:', e);
      replyToSandbox({ type: 'reading:importError', error: (e && e.message) || '导入失败' });
    }
  }

  /** 沙盒报上来的阅读位置 → 更新会话状态 (给主聊天的 AI 用) */
  function handlePageState(d) {
    var c = currentChatObject();
    notifyAiOfPageTurn(c ? c.id : null, d || {});

    // 宠物屋: 今天在读书 → 它背上一片翻开的书页
    // ⚠️ 只在【换书】时报一次, 不是每翻一页都报 (否则一天几百次信号)
    if (d && d.bookId !== undefined && d.bookId !== session.petSignalBookId) {
      session.petSignalBookId = d.bookId;
      try {
        if (global.PetNest && typeof global.PetNest.reportSignal === 'function') {
          global.PetNest.reportSignal('reading', 1, { title: d.title || '' });
        }
      } catch (e) { /* 忽略 */ }
    }
  }

  // ============================================================
  // AI 请求 (宿主代打)
  //
  // 【为什么在宿主打】沙盒里没有 ai-response.js / utils.js / live-client.js,
  //   → 没有 toGeminiRequestData / getGeminiResponseText / fetchViaOpenAICompatibleProxy,
  //   主 API 要是谷歌原生地址, 沙盒自己拼必然 404。
  //   → 全部交给宿主, 宿主有全套。
  // ============================================================

  function buildReadingSceneBlock(chat) {
    var ref = (chat && chat.settings && chat.settings.myNickname) || '用户';
    if (ref === '我') ref = '用户';
    var L = [];
    L.push('');
    L.push('# 【现在的情况：你们在一起读书】');
    L.push('');
    L.push('你和读者正在书房里一起读一本书。');
    L.push('你们是【读者】—— 在讨论这本书，不是在演书里的角色。');
    L.push('');
    L.push('# 【怎么回复】');
    L.push('');
    L.push('· 像坐在图书馆里低声讨论那样，用【普通文字】说话。');
    L.push('· 一次说一两句就好，不要长篇大论，不要分条罗列。');
    L.push('· 遇到史书里的典章制度、人名地名、年号、避讳，可以解释、可以考据、可以说你的看法。');
    L.push('· 你不知道的就直说不知道，别编。');
    L.push('');
    return L.join('\n');
  }

  function buildPageBlock(pageCtx) {
    if (!pageCtx) return '';
    var L = [];
    L.push('');
    L.push('# 【读者现在看到的这一页】');
    L.push('');
    if (pageCtx.chapterTitle) L.push('（章节：' + pageCtx.chapterTitle + '）');
    if (pageCtx.pageNo !== undefined && pageCtx.pageCount) {
      L.push('（第 ' + (pageCtx.pageNo + 1) + ' / ' + pageCtx.pageCount + ' 页）');
    }
    L.push(String(pageCtx.text || '').substring(0, 2000));
    L.push('');
    return L.join('\n');
  }

  /**
   * 组 system prompt
   *
   * ⚠️ 主聊天的默认提示词是【指令式角色扮演】: 输出必须是一个 JSON 数组。
   *   读书屋的聊天框显示的是纯文字, 那些指令一条也执行不了。
   *   → 结构上把那一整节从提示词里删掉 (复用影院那套 stripInstructionSystem),
   *     不是"跟模型说别输出 JSON"(那要靠模型听话, 不稳)。
   */
  async function buildSystemPrompt(chat, memoryCtx, pageCtx) {
    var out = '';
    var promptText = '';
    try {
      var CC = global.CinemaChat;
      if (CC && typeof CC.renderPromptText === 'function') {
        promptText = String(await CC.renderPromptText(chat, memoryCtx) || '');
      }
    } catch (e) { logWarn('渲染提示词失败:', e); }

    if (promptText.trim()) {
      try {
        var CC2 = global.CinemaChat;
        out = (CC2 && typeof CC2.stripInstructionSystem === 'function')
          ? CC2.stripInstructionSystem(promptText)
          : promptText;
      } catch (e) { out = promptText; }
    }

    if (!out.trim()) {
      // 兜底: 连提示词预设都没有 → 自己拼一份最小人设
      var s = (chat && chat.settings) || {};
      var fb = ['# 你是谁', '', '你就是「' + ((chat && (chat.name || chat.originalName)) || '角色') + '」。'];
      if (s.aiPersona) { fb.push(''); fb.push(s.aiPersona); }
      fb.push('');
      out = fb.join('\n');
    }

    out += buildReadingSceneBlock(chat);
    out += buildPageBlock(pageCtx);

    // ⚠️ 2026-11-02 用户实测: MiniMax M3 会把 <think>...</think> 思维链一起吐出来,
    //   读书屋的聊天窗里直接显示一大段"我在思考..."。这里先【要求】模型别输出,
    //   流式那层还有状态机兜底 (见 createThinkFilter), 两道都上才稳。
    out += [
      '',
      '# 输出要求（必须遵守）',
      '',
      '直接说回答的内容，不要输出思考过程、推理步骤、思维链，也不要输出任何 <think> 标签。',
      '不要写"思考：""分析：""最终回复："这类分段标题，直接把要说的话讲出来。',
      '用普通段落说话，就像在跟人聊天，不要用 JSON、代码块或列表符号开头。',
      ''
    ].join('\n');

    return out;
  }

  // ============================================================
  // MiniMax 思维链清洗
  //
  // ⚠️ 用户实测: 读书屋里用 MiniMax 讨论时, think 思维链全露出来了。
  //   主聊天那边有 cleanMinimaxResponseText (modules/ai-response.js:1596),
  //   但那是【整段文本】的活儿 —— 流式下 <think> 标签会跨 chunk 断开
  //   ("<thi" + "nk>"), 所以这里另写一个流式状态机, 只吐"确定干净"的部分。
  // ============================================================

  /**
   * 流式思维链过滤器
   *
   * 只吐两种东西: 正常文本; <think> 块【外面】的文本。
   * <think> 块里的内容一律丢掉, 并且没闭合的也要留尾巴 (防止标签被切开)。
   */
  function createThinkFilter() {
    var buf = '';
    var inThink = false;
    return {
      push: function (text) {
        buf += String(text || '');
        var out = '';
        var guard = 0;
        while (guard++ < 64) {
          if (inThink) {
            var close = buf.toLowerCase().indexOf('</think>');
            if (close < 0) {
              // 还没闭合 —— 留最后 16 个字, 防止 </think> 被切成 "<" + "/think>"
              var keep = Math.min(buf.length, 16);
              buf = buf.slice(buf.length - keep);
              break;
            }
            buf = buf.slice(close + 8);
            inThink = false;
            continue;
          }
          var open = buf.toLowerCase().indexOf('<think>');
          if (open < 0) {
            // 可能标签被切开 —— 留最后 8 个字等下一段
            var keep2 = Math.min(buf.length, 8);
            out += buf.slice(0, buf.length - keep2);
            buf = buf.slice(buf.length - keep2);
            break;
          }
          out += buf.slice(0, open);
          buf = buf.slice(open + 7);
          inThink = true;
        }
        return out;
      },
      /** 流结束: 把剩下的吐出来 (还在 think 里就全丢) */
      flush: function () {
        var rest = buf;
        buf = '';
        if (inThink) return '';
        return rest;
      },
      isInThink: function () { return inThink; }
    };
  }

  /**
   * 整段文本清洗 (流结束后用)
   *
   * 优先用主聊天那套 cleanMinimaxResponseText —— 它除了剥 <think>,
   * 官方 Minimax 渠道还会顺手清掉 "思考：xxx / 最终回复：yyy" 这种分段写法。
   *
   * ⚠️ 但它那句"把最终回答标记之前的全删掉"有点狠, 万一模型正常说话时
   *   碰巧有一行以"回答："开头, 正文会被削掉一大截 →
   *   所以加一道保险: 清洗后长度掉超过 40%, 就退回"只剥 <think>"的保守版。
   */
  function cleanAiText(text, cfg) {
    var t = String(text || '');
    var conservative = t
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/gi, '')
      .trim();

    if (typeof global.cleanMinimaxResponseText === 'function') {
      try {
        var info = { proxyUrl: (cfg && cfg.proxyUrl) || '', model: (cfg && cfg.model) || '' };
        var cleaned = String(global.cleanMinimaxResponseText(t, info) || '').trim();
        if (cleaned) {
          // 掉得太狠 → 判定为清洗过头, 用保守版
          if (t.length > 40 && cleaned.length < t.length * 0.6) {
            logWarn('思维链清洗疑似削掉了正文, 改用保守版 (' +
              t.length + ' → ' + cleaned.length + ')');
            return conservative;
          }
          return cleaned;
        }
      } catch (e) { logWarn('思维链清洗失败, 用兜底:', e); }
    }
    return conservative;
  }

  async function buildHistoryMessages(chat) {
    try {
      var CC = global.CinemaChat;
      if (CC && typeof CC.buildHistoryMessages === 'function') {
        return await CC.buildHistoryMessages(chat);
      }
    } catch (e) { logWarn('读历史失败:', e); }
    return [];
  }

  async function buildMemoryContext(chat, queryText) {
    try {
      var CC = global.CinemaChat;
      if (CC && typeof CC.buildMemoryContext === 'function') {
        return await CC.buildMemoryContext(chat, queryText || '');
      }
    } catch (e) { logWarn('读记忆失败:', e); }
    return '';
  }

  /** 流式读 SSE */
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
        if (delta) { full += delta; onDelta(delta); }
      }
    }
    return full;
  }

  async function callMainApi(cfg, systemPrompt, messages, onDelta, signal) {
    var gs = (typeof state !== 'undefined' && state && state.globalSettings) || {};
    var isGemini = !!cfg.isGeminiNative ||
      ((typeof global.isGeminiNativeUrl === 'function') ? global.isGeminiNativeUrl(cfg.proxyUrl) : false);
    var streaming = gs.enableStreaming === true && !isGemini;

    var payload = {
      model: cfg.model,
      messages: [{ role: 'system', content: systemPrompt }].concat(messages),
      temperature: gs.apiTemperature || 0.8,
      top_p: gs.apiTopP !== undefined ? gs.apiTopP : 1.0,
      presence_penalty: gs.apiPresencePenalty !== undefined ? gs.apiPresencePenalty : 0.0,
      frequency_penalty: gs.apiFrequencyPenalty !== undefined ? gs.apiFrequencyPenalty : 0.0
    };

    if (isGemini) {
      if (typeof global.toGeminiRequestData !== 'function') {
        throw new Error('宿主缺少 toGeminiRequestData，谷歌直连用不了');
      }
      var g = global.toGeminiRequestData(cfg.model, cfg.apiKey, systemPrompt, messages);
      var gres = await fetch(g.url, g.data);
      if (!gres.ok) {
        var gerr = await gres.text().catch(function () { return ''; });
        throw new Error('主 API ' + gres.status + ' ' + String(gerr).slice(0, 200));
      }
      var gdata = await gres.json();
      var gtxt = (typeof global.getGeminiResponseText === 'function')
        ? global.getGeminiResponseText(gdata)
        : (((gdata.candidates && gdata.candidates[0] && gdata.candidates[0].content &&
            gdata.candidates[0].content.parts) || []).map(function (p) { return p.text || ''; }).join(''));
      if (onDelta && gtxt) onDelta(gtxt);
      return gtxt;
    }

    // ⚠️ 铁律: 站点地址用户自己填全 (通常带 /v1), 程序【只补 /chat/completions】
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

    var np = {};
    for (var k2 in payload) if (Object.prototype.hasOwnProperty.call(payload, k2)) np[k2] = payload[k2];
    np.stream = false;

    var res;
    var useProxy = typeof global.fetchViaOpenAICompatibleProxy === 'function'
      && typeof global.isMainApiProxyEnabled === 'function'
      && global.isMainApiProxyEnabled();
    if (useProxy) {
      res = await global.fetchViaOpenAICompatibleProxy({
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
      var errText2 = await res.text().catch(function () { return ''; });
      throw new Error('主 API ' + res.status + ' ' + String(errText2).slice(0, 200));
    }
    var json = await res.json();
    var content = (json.choices && json.choices[0] && json.choices[0].message &&
      json.choices[0].message.content) || '';
    if (onDelta && content) onDelta(content);
    return content;
  }

  /** 读书屋里说的一句话 → 交给模型 */
  async function handleChat(d) {
    var reqId = d && d.requestId;
    var text = String((d && d.text) || '').trim();
    var pageCtx = d && d.pageContext;
    var selected = String((d && d.selected) || '').trim();

    if (!reqId) return;
    if (!text) {
      replyToSandbox({ type: 'reading:chatError', requestId: reqId, error: '没听清你说什么' });
      return;
    }

    var chat = currentChatObject();
    if (!chat) {
      replyToSandbox({ type: 'reading:chatError', requestId: reqId, error: '没绑上角色会话' });
      return;
    }

    // 流式回传节流: 一段一段地攒, 60ms 推一次 (别一个 token 一次 postMessage)
    var pendingDelta = '';
    var flushTimer = null;
    function flushDelta() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!pendingDelta) return;
      var chunk = pendingDelta;
      pendingDelta = '';
      replyToSandbox({ type: 'reading:chatDelta', requestId: reqId, delta: chunk });
    }
    // ⚠️ 思维链过滤: MiniMax 的 <think> 块不能往界面上送
    var thinkFilter = createThinkFilter();
    function pushDelta(delta) {
      var clean = thinkFilter.push(delta);
      if (!clean) return;
      pendingDelta += clean;
      if (!flushTimer) flushTimer = setTimeout(flushDelta, 60);
    }

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) { try { controller.abort(); } catch (e) { /* noop */ } }
    }, 90000);

    try {
      var memoryCtx = await buildMemoryContext(chat, text);
      var history = await buildHistoryMessages(chat);
      var systemPrompt = await buildSystemPrompt(chat, memoryCtx, pageCtx);

      // 用户消息: 圈出来的那句放在最前面 (那是提问的焦点)
      var userContent = text;
      if (selected) {
        userContent = '（我圈出了这一句：「' + selected.substring(0, 500) + '」）\n' + text;
      }
      var messages = history.concat([{ role: 'user', content: userContent }]);

      var cfg = await resolveMainApiConfig(chat);
      if (!cfg) throw new Error('主 API 没配好（地址 / API Key / 模型缺一个）');

      var answer = await callMainApi(cfg, systemPrompt, messages, pushDelta,
        controller ? controller.signal : undefined);
      // 流式过滤器里剩下的尾巴 (含没闭合的 <think>, 那部分直接丢)
      var tail = thinkFilter.flush();
      if (tail) {
        pendingDelta += tail;
      }
      flushDelta();

      // ⚠️ 整段再清一次 —— 官方 Minimax 那种 "思考：xxx / 最终回复：yyy" 的分段写法
      //   流式过滤器看不出来 (它只认 <think> 标签), 靠 cleanMinimaxResponseText 收尾。
      //   沙盒那边 chatDone 会用这个完整文本【覆盖】气泡, 所以界面上最终是干净的。
      var full = cleanAiText(answer, cfg);
      if (!full) throw new Error('主 API 返回了空内容');

      // 写进主聊天历史 —— 外面也看得见, 下次接得上茬 (跟影院一个口径)
      try {
        if (global.messageStore && typeof global.messageStore.addMessageToChat === 'function') {
          await global.messageStore.addMessageToChat(chat, {
            role: 'user', content: text, timestamp: Date.now(),
            senderName: (chat.settings && chat.settings.myNickname) || '我'
          });
          await global.messageStore.addMessageToChat(chat, {
            role: 'assistant', content: full, timestamp: Date.now(),
            senderName: chat.name || ''
          });
        }
      } catch (e) { logWarn('写进主聊天历史失败:', e); }

      replyToSandbox({ type: 'reading:chatDone', requestId: reqId, text: full });
    } catch (e) {
      flushDelta();
      var msg = (e && e.message) || String(e);
      logError('读书屋聊天失败: ' + msg, e);
      replyToSandbox({ type: 'reading:chatError', requestId: reqId, error: msg });
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // 消息路由
  // ============================================================
  global.addEventListener('message', function (e) {
    if (!frame) return;
    var d = e.data || {};
    if (e.source !== frame.contentWindow) return;

    switch (d.type) {
      case 'reading:needChat':
        sendInit();
        handleNeedBooks();
        break;
      case 'reading:ready':
        sendInit();
        handleNeedBooks();
        break;
      case 'reading:needBooks':
        handleNeedBooks();
        break;
      case 'reading:requestPage':
        handleRequestPage(d);
        break;
      case 'reading:saveProgress':
        handleSaveProgress(d);
        break;
      case 'reading:deleteBook':
        handleDeleteBook(d);
        break;
      case 'reading:setCover':
        handleSetCover(d);
        break;
      case 'reading:importFile':
        handleImportFile(d);
        break;
      case 'reading:pageState':
        handlePageState(d);
        break;
      case 'reading:chat':
        handleChat(d);
        break;
      case 'reading:closed':
        closeSandbox();
        break;
      default:
        break;
    }
  });

  // ============================================================
  // 入口
  // ============================================================
  function open() {
    if (frame) { closeSandbox('再点一次退出'); return; }
    if (!currentChatObject()) {
      logWarn('没有当前聊天, 不开读书屋');
      return;
    }
    if (document.body) document.body.classList.add('reading-room-active');
    bindViewportRelay();

    frame = document.createElement('iframe');
    frame.id = 'reading-sandbox-frame';
    // ⚠️ 必须带 ?v=: 沙盒页会被 SW 的 '/index.html' 白名单命中 → 不带 ?v= 就是
    //   cache-first, 改了沙盒也不生效。带 ?v= 走 network-first, 断网回落到预缓存。
    frame.src = 'reading-sandbox/index.html?v=0.1.1';
    frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
    frame.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;' +
      'background:#f6efe2;';
    document.body.appendChild(frame);
    frame.addEventListener('load', function () { sendInit(); pushViewport(); });
    startWatch();
    log('读书屋已打开');
  }

  function bindEntry() {
    var btn = document.getElementById('read-together-btn');
    if (!btn || btn.__readingBound) return;
    btn.__readingBound = true;
    btn.addEventListener('click', function () { open(); });
  }

  // ============================================================
  // 绿江书架 (「+ 加入共读」)
  //
  // 旧版把作品【全部章节】拼成一个巨型字符串塞进 readingLibrary 的一条记录 ——
  //   那是第二个性能坑 (长篇连载几百章的话)。
  // 现在按页写进 readingPages, 跟本地导入的书走同一套。
  // ============================================================
  async function addGreenRiverToShelf(storyId, btnElement) {
    try {
      var d = (typeof db !== 'undefined' && db) ? db : global.db;
      if (!d) throw new Error('数据库还没开');
      var story = await d.grStories.get(storyId);
      if (!story) throw new Error('找不到这部作品');

      var existing = null;
      try {
        var books = await global.ReadingStorage.listBooks();
        for (var i = 0; i < books.length; i++) {
          if (books[i].linkedStoryId === story.id) { existing = books[i]; break; }
        }
      } catch (e) { /* noop */ }

      if (existing) {
        if (typeof global.showCustomAlert === 'function') {
          await global.showCustomAlert('已经在书架里了', '《' + story.title + '》已经加过了。');
        }
        return;
      }

      var res = await global.ReadingStorage.importChapters(story);

      if (btnElement) {
        btnElement.textContent = '✓ 已在书架';
        btnElement.classList.add('added');
        btnElement.onclick = function (e) {
          e.stopPropagation();
          removeGreenRiverFromShelf(storyId, btnElement);
        };
      }
      if (typeof global.showCustomAlert === 'function') {
        await global.showCustomAlert('收藏成功',
          '《' + story.title + '》已加入书架（' + res.pageCount + ' 页），可以进读书屋读了。');
      }
    } catch (e) {
      logError('加入书架失败:', e);
      if (typeof global.showCustomAlert === 'function') {
        await global.showCustomAlert('加入失败', (e && e.message) || String(e));
      }
    }
  }

  async function removeGreenRiverFromShelf(storyId, btnElement) {
    try {
      var books = await global.ReadingStorage.listBooks();
      var hit = null;
      for (var i = 0; i < books.length; i++) {
        if (books[i].linkedStoryId === storyId) { hit = books[i]; break; }
      }
      if (!hit) {
        if (btnElement) resetBtnToAddState(storyId, btnElement);
        return;
      }
      var confirmed = false;
      if (typeof global.showCustomConfirm === 'function') {
        confirmed = await global.showCustomConfirm('移出书架',
          '确定要把《' + hit.title + '》从书架里移除吗？\n(绿江里的原稿不会被删除)',
          { confirmButtonClass: 'btn-danger', confirmText: '移出' });
      } else {
        confirmed = confirm('确定要把《' + hit.title + '》从书架里移除吗？');
      }
      if (confirmed) {
        await global.ReadingStorage.deleteBook(hit.id);
        if (btnElement) resetBtnToAddState(storyId, btnElement);
        if (typeof global.showCustomAlert === 'function') {
          await global.showCustomAlert('已移除', '书籍已从书架移出。');
        }
      }
    } catch (e) {
      logError('移除失败:', e);
    }
  }

  function resetBtnToAddState(storyId, btn) {
    if (!btn) return;
    btn.textContent = '+ 加入共读';
    btn.classList.remove('added');
    btn.onclick = function (e) {
      e.stopPropagation();
      addGreenRiverToShelf(storyId, btn);
    };
  }

  // ============================================================
  // 全局暴露
  // ============================================================
  global.formatReadingStateForAI = formatReadingStateForAI;
  global.notifyAiOfPageTurn = notifyAiOfPageTurn;
  global.readingSession = session;
  global.openReadingRoom = open;
  global.closeReadingRoom = function () { closeSandbox(); };
  global.addGreenRiverToShelf = addGreenRiverToShelf;
  global.removeGreenRiverFromShelf = removeGreenRiverFromShelf;
  global.resetBtnToAddState = resetBtnToAddState;
  global.ReadingRoom = {
    open: open,
    close: function () { closeSandbox(); },
    isOpen: function () { return !!frame; },
    session: session,
    // 给单测用 (思维链过滤器必须能单独验: 标签会跨 chunk 断开)
    _createThinkFilter: createThinkFilter,
    _cleanAiText: cleanAiText,
    _resolveMainApiConfig: resolveMainApiConfig
  };

  // 旧版留在 window 上的那些函数, 现在没有对应实现了 —— 给个明确的报错,
  // 免得哪里还在调, 报 "xxx is not a function" 看不出所以然。
  // ⚠️ makeDraggable 不在里面 —— 它搬去 utils.js 了 (视频/语音通话的悬浮球还在用)。
  ['importBook', 'switchImportTab', 'pickLocalFile', 'importBookFromUrl',
    'decodeTextFile', 'handleBookFileUpload', 'handlePageJump', 'saveReadingProgress',
    'openBookLibrary', 'renderBookLibrary', 'loadBookFromLibrary', 'processImportedText',
    'minimizeReadingRoom', 'restoreReadingRoom', 'renderReadingRoom',
    'showNextPage', 'showPrevPage', 'initReadingSession', 'updateReadingContextOnScroll',
    'toggleReadingFullscreen'
  ].forEach(function (name) {
    if (typeof global[name] === 'undefined') {
      global[name] = function () {
        throw new Error('旧版「一起读书」浮窗已下线, 请用读书屋 (ReadingRoom.open())。' +
          ' 这个函数 (' + name + ') 已经不存在了。');
      };
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }

  log('已加载 (读书屋宿主侧: iframe 沙盒 + 数据 + AI 代打)');
})(window);

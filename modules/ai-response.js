// ============================================================

  // 2026-08-02 v0.1.72: AI_TOTAL_TIMEOUT_MS 180000 → 600000 (3 分钟 → 10 分钟)
  // 原因: v0.1.71 Gemini 工具循环可能跑 6 轮 (AI 调工具 + 重发), 单轮 5-50 秒
  //       3 分钟会被工具循环掐断, 改 10 分钟给足余量
  // firstChunk 60 秒保留 (防 API 完全不响应 / 卡死)
  const AI_FIRST_CHUNK_TIMEOUT_MS = 60000;
  const AI_TOTAL_TIMEOUT_MS = 600000;
  const AI_TIMEOUT_MESSAGE = 'AI 请求超时，已自动停止生成';
  const AI_ABORT_MESSAGE = '用户停止生成';
  const AI_GENERATING_STATUSES = new Set(['generating', 'pending', 'streaming', 'loading']);

  let currentAiGenerationController = null;
  let currentAiGenerationState = null;

  function aiRuntimeLog(event, payload = {}) {
    try {
      window.runtimeDiag?.log?.(event, payload);
    } catch (error) {
      console.warn('[AI诊断日志失败]', event, error);
    }
  }

  const NETLIFY_OPENAI_COMPATIBLE_PROXY_ENDPOINT = '/.netlify/functions/openai-proxy';
  const VERCEL_OPENAI_COMPATIBLE_PROXY_ENDPOINT = '/api/openai-proxy';

  function getOpenAICompatibleProxyEndpoint() {
    let platform = 'netlify';
    let hostname = '';
    let proxyPath = NETLIFY_OPENAI_COMPATIBLE_PROXY_ENDPOINT;

    try {
      hostname = String(window?.location?.hostname || '').toLowerCase();
      if (hostname.endsWith('.vercel.app') || hostname === 'vercel.app') {
        platform = 'vercel';
        proxyPath = VERCEL_OPENAI_COMPATIBLE_PROXY_ENDPOINT;
      } else if (hostname === 'localhost' || hostname === '127.0.0.1') {
        platform = 'local-netlify-default';
      }
    } catch (error) {
      platform = 'netlify';
    }

    aiRuntimeLog('API_PROXY_PLATFORM_DETECTED', {
      platform,
      hostname,
      proxyPath
    });
    aiRuntimeLog('API_PROXY_ENDPOINT_SELECTED', {
      platform,
      hostname,
      proxyPath
    });

    return proxyPath;
  }

  function getSafeProxyUrlSummary(url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.host,
        path: parsed.pathname,
        finalUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      };
    } catch (error) {
      return {
        host: '',
        path: '',
        finalUrl: ''
      };
    }
  }

  function buildOpenAICompatibleTargetUrl(baseUrl, targetPath) {
    const endpointPath = String(targetPath || '').trim().startsWith('/')
      ? String(targetPath || '').trim()
      : `/${String(targetPath || '').trim()}`;
    if (!endpointPath || (endpointPath !== '/chat/completions' && endpointPath !== '/models')) {
      throw new Error('不支持的 OpenAI compatible 代理目标路径');
    }

    const parsed = new URL(String(baseUrl || '').trim());
    if (parsed.protocol !== 'https:') {
      throw new Error('通用代理只允许 https API 地址');
    }
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';

    let pathname = parsed.pathname || '/';
    pathname = pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/chat\/completions$/i, '');
    pathname = pathname.replace(/\/models$/i, '');
    parsed.pathname = `${pathname}${endpointPath}`.replace(/\/{2,}/g, '/');

    return parsed.toString();
  }

  function isMainApiProxyEnabled() {
    return state?.globalSettings?.mainApiUseProxy === true;
  }

  function fetchViaOpenAICompatibleProxy({
    baseUrl,
    targetPath,
    apiKey,
    payload,
    method = 'POST',
    signal,
    diagStartEvent = 'API_PROXY_REQUEST_START',
    diagResponseEvent = 'API_PROXY_RESPONSE',
    diagErrorEvent = 'API_PROXY_ERROR'
  } = {}) {
    const targetUrl = buildOpenAICompatibleTargetUrl(baseUrl, targetPath);
    const safeSummary = getSafeProxyUrlSummary(targetUrl);
    const hasAuthorization = !!String(apiKey || '').trim();
    const proxyPath = getOpenAICompatibleProxyEndpoint();
    const finalPath = safeSummary.path;
    const contentType = 'application/json';
    const streamMode = payload?.stream === true ? 'stream' : 'non-stream';
    aiRuntimeLog(diagStartEvent, {
      proxyPath,
      method,
      host: safeSummary.host,
      path: safeSummary.path,
      finalPath,
      hasAuthorization,
      contentType,
      streamMode
    });
    aiRuntimeLog(targetPath === '/models' ? 'API_PROXY_MODELS_TARGET_BUILT' : 'API_PROXY_CHAT_TARGET_BUILT', {
      proxyPath,
      method,
      host: safeSummary.host,
      path: safeSummary.path,
      finalPath,
      hasAuthorization,
      contentType,
      streamMode
    });

    return fetch(proxyPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseUrl,
        targetPath,
        apiKey,
        payload,
        method
      }),
      signal
    }).then((response) => {
      aiRuntimeLog(diagResponseEvent, {
        proxyPath,
        method,
        host: safeSummary.host,
        path: safeSummary.path,
        finalPath,
        status: response.status,
        hasAuthorization,
        contentType,
        streamMode
      });
      return response;
    }).catch((error) => {
      aiRuntimeLog(diagErrorEvent, {
        proxyPath,
        method,
        host: safeSummary.host,
        path: safeSummary.path,
        finalPath,
        hasAuthorization,
        contentType,
        streamMode,
        errorType: error?.name || 'Error'
      });
      throw error;
    });
  }

  window.buildOpenAICompatibleTargetUrl = buildOpenAICompatibleTargetUrl;
  window.fetchViaOpenAICompatibleProxy = fetchViaOpenAICompatibleProxy;
  window.isMainApiProxyEnabled = isMainApiProxyEnabled;

  // 🔴 2026-10-23 影院陪聊 (modules/cinema-chat.js) 要用这几样。
  //   影院现在也调主 API 了, 但它【不能】直接调主聊天那个大函数 ——
  //   那个函数会写主聊天历史、跑工具调用、抽记忆, 影院要用的话副作用太大。
  //   所以这里把三个【纯函数】挂到 window 让影院复用:
  //     · replaceTemplateVars   —— 主聊天的提示词变量替换 (人设/记忆/昵称…)
  //     · toGeminiRequestData   —— 主 API 走 Gemini 原生格式时的请求体转换
  //     · fetchStreamingResponse —— 主聊天的 SSE 流式解析 (影院要用同一套)
  //   一行行为都不改, 只是把模块内的实现暴露出去。
  window.replaceTemplateVars = replaceTemplateVars;
  window.toGeminiRequestData = toGeminiRequestData;
  window.fetchStreamingResponse = fetchStreamingResponse;

  /**
   * 第二阶段: 聊天链路「语音控制」prompt 段落。
   *
   * ⚠️ 为什么硬编码在这里, 而不写进 settings-presets.js 的预设文本:
   *   getActiveChatPrompt() 允许用户用 customChatPromptSingle 整段顶掉默认预设
   *   (settings-presets.js:536-559)。写进预设的话, 对已开启自定义 prompt 的用户
   *   完全无效 —— AI 永远不会知道这个协议。这里拼在预设【之后】, 对所有人一致生效。
   *
   * 触发条件与聊天 TTS 的实际触发条件保持一致 (chat-interface.js:1087):
   *   非群聊 + enableTts !== false + 配了 minimaxVoiceId, 否则返回 ''。
   */
  function buildChatTtsExpressionPromptBlock(chat) {
    try {
      if (!chat || chat.isGroup) return '';
      if (chat.settings.enableTts === false) return '';
      if (!chat.settings.minimaxVoiceId) return '';

      const expr = window.TTSExpression;
      const emotionSet = (expr && expr.VALID_EMOTIONS)
        ? expr.VALID_EMOTIONS
        : new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']);
      const interjectionSet = (expr && expr.MINIMAX_INTERJECTIONS)
        ? expr.MINIMAX_INTERJECTIONS
        : new Set(['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath',
          'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps',
          'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes']);
      const emotionList = Array.from(emotionSet).join(' / ');
      const interjectionList = Array.from(interjectionSet).map(t => `(${t})`).join(' ');

      return `

# 🔊 语音控制 (只有发语音消息时才用得上)

语音消息的内容会被【真实朗读出来】, 所以情绪和语气要由你自己标出来, 不要靠中文旁白。
像"（轻笑）"这种舞台指示系统不会朗读, 只会删掉, 等于白写。
你有两个工具, 都只对【语音消息】(type 为 voice_message) 有效:

## 1) 整段情绪 (极克制 —— 拿不准就别标)

[[语音:emotion名]]

emotion 名【只能】从这 ${emotionSet.size} 个里挑, 一个字都不能改, 不能自创:
${emotionList}

⚠️ 先搞清楚它有多重: emotion 改的是【整句话的演法】, 不是某个词的语气。
标对了整句更有味道; 标错了【整句都被带跑】—— 一句本来该平平淡淡的晚安,
标成 happy 之后整句会变得又高又亮, 听起来很别扭, 比不标还糟。

所以:
- 【只有情绪非常强烈、非常明确时才标】。吵架、崩溃、真心高兴、明确难过 —— 这种才配。
- 【下面这些一律不要标】:
    道晚安 / 打招呼 / 平常闲聊 / 讲一件事 / 淡淡的高兴 / 礼貌的关心 /
    撒娇式的顺口话 / 情绪还没到那一步的普通句子
- 【拿不准就【不要】标】。不标的时候系统会自己挑最自然的演法, 永远比标错好。
- calm 是给【平稳 / 温柔 / 安抚 / 道别】用的; 但即便是这种, 也常常【不需要标】。
- 一条语音【最多一个】, 且必须在【最前面】, 不要标在句子中间。
- 【只对语音消息有效】。你发普通文字消息 (type 为 text) 时不要加任何标签 —— 文字消息不会被朗读, 加了没有任何作用。

例 (这种才标):
{"type": "voice_message", "content": "[[语音:angry]]\\\\n你昨晚十二点还在喝咖啡? 不要命了是吧。"}

例 (这些【不要】标):
{"type": "voice_message", "content": "[[语音:happy]]\\\\n晚安, 早点睡。"}   ← 平稳道别, 不该标成开心

## 2) 句中语气声 (可以放心用)

和 emotion 不一样: 语气声只作用在【它出现的那一个位置】, 不会改变整句话的演法。
所以它比 emotion 自由得多 —— 想说笑就写 (chuckle), 想叹气就写 (sighs), 不用太纠结。

直接在语音文字里写【官方英文标签】:

${interjectionList}

例: (sighs) 算了, 听你的。

规则:
- 【绝对不要】写中文的 (轻笑) (叹气) 这类舞台指示 —— 系统不朗读它们, 只会删掉。
- 一条语音里【最多一两个】, 多了声音会飘、很假。
- 拼写必须和上面【完全一致】: 括号里多个空格、少个字母、换个说法, 都不认, 只会被删掉。

## 3) 特殊停顿 (只用在有表现意义的地方)

普通标点的停顿【系统会自动处理】, 你不用管, 也不要去补。只有下面这些时刻,
你才可以自己手写一个停顿标记, 写在语音文字里:

<#0.2#>  极短换气 —— 被噎住、话说到一半改口
<#0.3#>  轻顿 —— 想一下、犹豫要不要说
<#0.5#>  普通停顿 —— 情绪转折、说完留一口气
<#0.6#>  明显沉默 —— 震惊后的空白、压抑、难过到说不下去

(上限就是 0.6 秒。写更大的值没有意义, 系统会压到 0.6。)

只在这些时刻用: 犹豫 / 突然停住 / 情绪转折(吐槽转温柔、强硬转示弱) /
震惊之后的沉默 / 压抑难过 / 特殊强调。

不同情绪的节奏参考:
- 温柔安抚: 慢、短句多。"没事。<#0.5#>先别急着吓自己。"
- 委屈撒娇: 语气软、停顿稍多。"嗯……<#0.3#>你刚刚是不是又不理我。"
- 别扭傲娇: 前半句嘴硬后半句放软, 中间停一下。"哈。<#0.3#>你还真会折腾我。"
- 难过压抑: 更慢、省略号多。"……我知道。<#0.6#>只是有点难受。"
- 紧张犹豫: 断裂感, 短停顿多。"等等。<#0.3#>我好像……<#0.5#>有点不确定。"
- 吐槽轻松: 别太慢, 轻微停顿即可。"行吧。<#0.2#>人类又发明了新的折磨方式。"

规则:
- 【绝对不要】给普通标点加停顿。逗号句号的停顿系统已经自动插了, 你再写只会重复。
- 每 100 字【最多 1–4 个】, 强情绪场景才适当增加。
- 别整段全是同一个数值 —— 会像坏掉的导航在念稿。
- 标记必须夹在【能念的字】之间: ✅ 我没事。<#0.5#>真的没事。  ❌ <#0.5#>我没事。
- 【绝对不要】连续写两个: <#0.5#><#0.3#> 这种一定删一个。

## 4) 这些标记都不要解释

【绝对不要】解释它们的存在。不许写"我换个语气"、"（语音标签已设置）"之类的话。
你只管在前面加标签、在该停的地方加停顿, 然后正常说话。

标签【不会被朗读】(系统在把文字送去合成语音之前会自动摘掉);
【也不会显示】—— 用户展开语音条看文字时看不到这些标记。所以你只管按格式写,
不用担心格式本身被看到, 也不用反过来"帮用户把话说清楚"。

✅ 正确示例:
{"type": "voice_message", "content": "[[语音:happy]]\\\\n你终于来了！(chuckle) 等你好久了。"}
{"type": "voice_message", "content": "嗯,我看看。"}
{"type": "voice_message", "content": "[[语音:sad]]\\\\n我其实...有一点失落。"}
{"type": "voice_message", "content": "(sighs) 算了,听你的。"}
{"type": "voice_message", "content": "我没事。<#0.5#>真的没事。"}

❌ 错误示例:
{"type": "voice_message", "content": "[[语音:excited]]\\\\n你终于来了!"}   ← excited 不在白名单
{"type": "voice_message", "content": "我用开心语气说: 你终于来了!"}     ← 不要解释标签
{"type": "voice_message", "content": "（轻笑）你终于来了。"}              ← 中文舞台指示不被朗读, 只会被删
{"type": "voice_message", "content": "我没事。<#0.5#><#0.3#>真的没事。"}  ← 连续两个标记, 会被系统合并
{"type": "voice_message", "content": "<#0.5#>我没事。"}                  ← 标记必须夹在能念的字之间
{"type": "text", "content": "[[语音:happy]]你终于来了"}                 ← 普通文字不会被朗读, 加了没用
`;
    } catch (e) {
      console.warn('[聊天TTS] 生成语音控制 prompt 段落失败:', e);
      return '';
    }
  }

  function setGlobalAiGenerationFlags(active) {
    window.isGenerating = !!active;
    window.inFlight = !!active;
    window.streaming = !!active;
    window.generating = !!active;
    if (window.state) {
      window.state.isGenerating = !!active;
      window.state.inFlight = !!active;
      window.state.streaming = !!active;
      window.state.generating = !!active;
    }
  }

  function getStopGenerationButton() {
    return document.getElementById('stop-api-call-btn');
  }

  const AI_CHAT_CONTROL_SELECTORS = [
    '#chat-message-input',
    '#message-input',
    '#chat-input',
    '#wait-reply-btn',
    '#send-message-btn',
    '#send-btn',
    '#ai-reply-btn',
    '#propel-btn',
    '#spectator-propel-btn'
  ];

  const AI_GENERATION_ALWAYS_CLICKABLE_SELECTORS = [
    '#stop-api-call-btn',
    '#back-to-list-btn',
    '#chat-settings-btn',
    '#settings-btn',
    '#runtime-diagnostics-open-btn',
    '#open-runtime-diagnostics-btn',
    '[onclick*="runtimeDiag.openPanel"]',
    '.bottom-nav button',
    '.bottom-nav .nav-item',
    '.tab-bar button',
    '.tab-bar .nav-item',
    '.settings-full-btn',
    '.back-btn',
    '.back-button',
    '[data-action="back"]',
    '[data-screen="settings-screen"]',
    '[data-screen="wallpaper-screen"]',
    '[data-screen="ai-reminders-screen"]'
  ];

  function setElementsDisabled(selectors, disabled) {
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (!el || !('disabled' in el)) return;
        el.disabled = !!disabled;
        el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      });
    });
  }

  function setChatGenerationControlsDisabled(disabled) {
    setElementsDisabled(AI_CHAT_CONTROL_SELECTORS, disabled);
    const chatInputArea = document.getElementById('chat-input-area');
    if (chatInputArea) {
      chatInputArea.classList.toggle('ai-generation-scoped-disabled', !!disabled);
      chatInputArea.setAttribute('aria-busy', disabled ? 'true' : 'false');
    }
  }

  function keepAiGenerationUiScoped() {
    if (document.body?.style?.pointerEvents === 'none') {
      document.body.style.pointerEvents = '';
    }
    if (document.documentElement?.style?.pointerEvents === 'none') {
      document.documentElement.style.pointerEvents = '';
    }

    AI_GENERATION_ALWAYS_CLICKABLE_SELECTORS.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (!el) return;
        if ('disabled' in el) el.disabled = false;
        el.removeAttribute('aria-disabled');
        el.style.pointerEvents = 'auto';
      });
    });

    const stopBtn = getStopGenerationButton();
    if (stopBtn) {
      stopBtn.disabled = false;
      stopBtn.removeAttribute('aria-disabled');
      stopBtn.style.pointerEvents = 'auto';
      stopBtn.style.zIndex = Math.max(parseInt(stopBtn.style.zIndex || '0', 10) || 0, 50);
    }
  }

  function updateStopGenerationButtonVisibility() {
    const stopBtn = getStopGenerationButton();
    if (!stopBtn) return;
    const shouldShow = !!(
      window.isGenerating ||
      window.inFlight ||
      window.streaming ||
      window.generating ||
      window.state?.isGenerating ||
      window.state?.inFlight ||
      window.state?.streaming ||
      window.state?.generating ||
      currentAiGenerationController
    );
    stopBtn.style.display = shouldShow ? 'flex' : 'none';
    stopBtn.classList.toggle('active', shouldShow);
    if (shouldShow) {
      stopBtn.disabled = false;
      stopBtn.removeAttribute('aria-disabled');
      stopBtn.style.pointerEvents = 'auto';
      keepAiGenerationUiScoped();
    }
  }

  function restoreAiInputControls() {
    setChatGenerationControlsDisabled(false);
  }

  function clearAiGenerationTimers(requestState) {
    if (!requestState) return;
    if (requestState.firstChunkTimer) {
      clearTimeout(requestState.firstChunkTimer);
      requestState.firstChunkTimer = null;
    }
    if (requestState.totalTimer) {
      clearTimeout(requestState.totalTimer);
      requestState.totalTimer = null;
    }
  }

  function markFirstAiChunk(requestState = currentAiGenerationState) {
    if (!requestState || requestState.firstChunkReceived) return;
    requestState.firstChunkReceived = true;
    if (requestState.firstChunkTimer) {
      clearTimeout(requestState.firstChunkTimer);
      requestState.firstChunkTimer = null;
    }
    aiRuntimeLog('AI_REQUEST_FIRST_CHUNK', { chatId: requestState.chatId });
  }

  function beginAiGenerationRequest(chatId) {
    // 【自检兜底】修复死锁状态：isGenerating=true 但 controller 已丢失
    // 常见于 background-activity 定时器触发 / 异常中断后 finally 未跑
    if (window.state?.isGenerating && !currentAiGenerationController) {
      setGlobalAiGenerationFlags(false);
      if (typeof restoreAiInputControls === 'function') {
        restoreAiInputControls();
      }
    }
    if (currentAiGenerationController) {
      console.warn('[AI请求] 发现未结束请求，已先中止旧请求');
      aiRuntimeLog('AI_REQUEST_ABORT', { chatId, reason: 'abort_previous_inflight' });
      try {
        currentAiGenerationController.abort();
      } catch (error) {
        console.warn('[AI请求] 中止旧请求失败:', error);
      }
      cleanupAiGenerationState(currentAiGenerationState, { skipMessageStatus: true });
    }

    const controller = new AbortController();
    const requestState = {
      chatId,
      controller,
      firstChunkReceived: false,
      timedOut: false,
      timeoutType: '',
      userAborted: false,
      completed: false,
      success: false,
      errorMessage: '',
      assistantMessage: null,
      firstChunkTimer: null,
      totalTimer: null
    };

    controller.signal.addEventListener('abort', () => {
      aiRuntimeLog('AI_REQUEST_ABORT', {
        chatId,
        reason: requestState.timedOut ? requestState.timeoutType : (requestState.userAborted ? 'user' : 'abort')
      });
    }, { once: true });

    requestState.firstChunkTimer = setTimeout(() => {
      if (requestState.completed || requestState.firstChunkReceived || controller.signal.aborted) return;
      requestState.timedOut = true;
      requestState.timeoutType = 'first_chunk';
      requestState.errorMessage = AI_TIMEOUT_MESSAGE;
      aiRuntimeLog('AI_REQUEST_TIMEOUT_FIRST_CHUNK', { chatId, timeoutMs: AI_FIRST_CHUNK_TIMEOUT_MS });
      controller.abort();
    }, AI_FIRST_CHUNK_TIMEOUT_MS);

    requestState.totalTimer = setTimeout(() => {
      if (requestState.completed || controller.signal.aborted) return;
      requestState.timedOut = true;
      requestState.timeoutType = 'total';
      requestState.errorMessage = AI_TIMEOUT_MESSAGE;
      aiRuntimeLog('AI_REQUEST_TIMEOUT_TOTAL', { chatId, timeoutMs: AI_TOTAL_TIMEOUT_MS });
      controller.abort();
    }, AI_TOTAL_TIMEOUT_MS);

    currentAiGenerationController = controller;
    currentAiGenerationState = requestState;
    setGlobalAiGenerationFlags(true);
    setChatGenerationControlsDisabled(true);
    installStopGenerationHandler();
    updateStopGenerationButtonVisibility();
    keepAiGenerationUiScoped();
    aiRuntimeLog('AI_REQUEST_START', { chatId });
    return requestState;
  }

  function getCurrentAiSignal() {
    return currentAiGenerationController?.signal;
  }

  function withCurrentAiSignal(options = {}) {
    const signal = getCurrentAiSignal();
    return signal ? { ...options, signal } : options;
  }

  function stopCurrentAiGeneration() {
    if (!currentAiGenerationController) return;
    if (currentAiGenerationState) {
      currentAiGenerationState.userAborted = true;
      currentAiGenerationState.errorMessage = AI_ABORT_MESSAGE;
    }
    currentAiGenerationController.abort();
  }

  function installStopGenerationHandler() {
    const stopBtn = getStopGenerationButton();
    if (!stopBtn) return;
    stopBtn.disabled = false;
    stopBtn.style.pointerEvents = 'auto';
    if (stopBtn.dataset.aiAbortBound === 'true') return;
    stopBtn.dataset.aiAbortBound = 'true';
    stopBtn.addEventListener('click', stopCurrentAiGeneration);
  }

  function markAssistantMessageFinal(requestState, status, errorText) {
    const msg = requestState?.assistantMessage;
    if (!msg) return;
    const msgStatus = msg.status || (msg.isStreaming ? 'streaming' : '');
    if (!msgStatus || AI_GENERATING_STATUSES.has(msgStatus) || msg.isStreaming || msg.isTemporary) {
      msg.status = status;
      msg.error = errorText;
      msg.isStreaming = false;
      msg.isTemporary = false;
    }
  }

  function cleanupAiGenerationState(requestState, options = {}) {
    if (requestState) {
      requestState.completed = true;
      clearAiGenerationTimers(requestState);
    }
    if (!options.skipMessageStatus && requestState && !requestState.success) {
      if (requestState.userAborted) {
        markAssistantMessageFinal(requestState, 'stopped', AI_ABORT_MESSAGE);
      } else if (requestState.timedOut) {
        markAssistantMessageFinal(requestState, 'failed', AI_TIMEOUT_MESSAGE);
      } else {
        markAssistantMessageFinal(requestState, 'failed', requestState.errorMessage || 'AI 回复生成失败');
      }
    }
    if (!requestState || currentAiGenerationController === requestState.controller) {
      currentAiGenerationController = null;
      currentAiGenerationState = null;
    }
    const chatForPersist = requestState?.chatId && window.state?.chats?.[requestState.chatId];
    if (chatForPersist && typeof db !== 'undefined' && db?.chats?.put) {
      Promise.resolve(db.chats.put(chatForPersist)).catch(error => {
        console.warn('[AI状态恢复] 保存生成收尾状态失败:', error);
      });
    }
    setGlobalAiGenerationFlags(false);
    restoreAiInputControls();
    updateStopGenerationButtonVisibility();

    // 额外确保全局状态与 UI 彻底解锁
    try {
      if (window.state) {
        window.state.isGenerating = false;
        window.state.currentAbortController = null;
        window.state.currentReader = null;
      }
    } catch (e) {
      console.warn('[AI状态恢复] 清理 window.state 失败', e);
    }

    // 如果存在修复模块，使用其解锁函数以保证 UI 与状态一致
    try {
      if (window.chatStuckStateRepair && typeof window.chatStuckStateRepair.forceUnlockAiRequestState === 'function') {
        window.chatStuckStateRepair.forceUnlockAiRequestState();
      }
    } catch (e) {
      console.warn('[AI状态恢复] 调用 forceUnlockAiRequestState 失败', e);
    }

    aiRuntimeLog('AI_GENERATION_STATE_RESET', { chatId: requestState?.chatId });
    aiRuntimeLog('AI_REQUEST_FINALLY', { chatId: requestState?.chatId });
    aiRuntimeLog('AI_REQUEST_STATE_UNLOCKED', { chatId: requestState?.chatId });
  }

  window.stopCurrentAiGeneration = stopCurrentAiGeneration;
  window.updateStopGenerationButtonVisibility = updateStopGenerationButtonVisibility;
  window.getCurrentAiGenerationController = () => currentAiGenerationController;
  window.restoreAiInputControls = restoreAiInputControls;

// ai-response.js
// AI 响应模块：toGeminiRequestData、uploadImageToImgBB、uploadFileToCatbox、
// silentlyUpdateDbUrl、parseAiResponse、triggerSpectatorGroupAiAction、triggerAiResponse
// 从 script.js 第 1346~1421 + 2553~2852 + 8979~9060 + 13711~19173 + 14027~19165 行拆分
// ============================================================

  /** 聊天图片消息：识图成功后仅传描述；失败仅传错误说明（不传 base64） */
  function textForUserImageMessageInPrompt(msg, linePrefix) {
    if (msg.imageVisionStatus === 'failed' || msg.imageVisionError) {
      const errText = String(msg.imageVisionError || '识图失败').trim();
      return `${linePrefix}[用户发送了一张图片，但识图失败：${errText}]`;
    }
    if (msg.imageProcessed && msg.imageDescription) {
      return `${linePrefix}[用户发送了一张图片，识图描述如下："${msg.imageDescription}"]`;
    }
    return `${linePrefix}[用户发送了一张图片，识图尚未完成；请勿臆测画面内容。]`;
  }

  // === 新增：动态年龄和生日计算上下文生成函数 ===
  function getDynamicAgeContext(chat) {
    if (!chat || !chat.settings || !chat.settings.enableDynamicAge || !chat.settings.aiBirthday) return '';
    
    const bd = chat.settings.aiBirthday;
    if (!bd.year) return ''; // 必须至少要有年份

    // 判断是否开启了自定义时间
    const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;
    const now = (customTimeInfo && customTimeInfo.enabled) ? customTimeInfo.date : new Date();

    let age = now.getFullYear() - bd.year;
    
    // 构建生日字符串
    let birthdayStr = `${bd.year}年`;
    if (bd.month) {
      birthdayStr += `${bd.month}月`;
      if (bd.day) {
        birthdayStr += `${bd.day}日`;
      }
    }

    // 精确计算年龄
    if (bd.month && bd.day) {
      const m = now.getMonth() + 1;
      const d = now.getDate();
      if (m < bd.month || (m === bd.month && d < bd.day)) {
        age--;
      }
    }

    return `- **你的生日**: ${birthdayStr}\n- **你的当前年龄**: ${age}岁\n`;
  }

  // WMO天气代码转中文描述
  function getWeatherDescription(code) {
    const codes = {
      0: "晴朗 (Clear sky)",
      1: "大部晴朗 (Mainly clear)", 2: "多云 (Partly cloudy)", 3: "阴天 (Overcast)",
      45: "有雾 (Fog)", 48: "结霜雾 (Depositing rime fog)",
      51: "轻微毛毛雨 (Drizzle: Light)", 53: "中度毛毛雨 (Drizzle: Moderate)", 55: "大毛毛雨 (Drizzle: Dense)",
      61: "小雨 (Rain: Slight)", 63: "中雨 (Rain: Moderate)", 65: "大雨 (Rain: Heavy)",
      71: "小雪 (Snow fall: Slight)", 73: "中雪 (Snow fall: Moderate)", 75: "大雪 (Snow fall: Heavy)",
      80: "阵雨 (Rain showers)", 81: "中度阵雨", 82: "暴雨",
      95: "雷雨 (Thunderstorm)", 96: "雷雨伴有冰雹", 99: "重度雷雨伴有冰雹"
    };
    return codes[code] || "未知天气";
  }

  // 根据经纬度获取实时天气
  async function fetchWeather(lat, lon) {
    if (!lat || !lon) return null;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,is_day,wind_speed_10m&timezone=auto`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.current) {
        const c = data.current;
        const desc = getWeatherDescription(c.weather_code);
        const dayState = c.is_day ? "白天" : "夜晚";
        return `气温 ${c.temperature_2m}°C, 湿度 ${c.relative_humidity_2m}%, ${desc}, ${dayState}, 风速 ${c.wind_speed_10m}km/h`;
      }
      return null;
    } catch (e) {
      console.error("获取天气失败:", e);
      return null;
    }
  }

  function readBooleanFromLocalStorage(keys) {
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    return false;
  }

  function getImageSwitchChecked(id, storageKeys) {
    const el = document.getElementById(id);
    if (el) return !!el.checked;

    console.warn(`[聊天生图路由] 生图开关 DOM id 缺失: ${id}`);
    return readBooleanFromLocalStorage(storageKeys);
  }

  function getCurrentEnabledImageProvider() {
    const providers = [
      {
        key: 'pollinations',
        type: 'ai_image',
        name: 'Pollinations / 通用AI',
        enabled: getImageSwitchChecked('enable-ai-drawing-switch', [
          'enable-ai-drawing-switch',
          'enable-ai-drawing',
          'ai-drawing-enabled',
          'aiDrawingEnabled',
          'enableAiDrawing'
        ])
      },
      {
        key: 'novelai',
        type: 'naiimag',
        name: 'NovelAI',
        enabled: getImageSwitchChecked('novelai-switch', [
          'novelai-enabled',
          'novelai-switch'
        ])
      },
      {
        key: 'google',
        type: 'googleimag',
        name: 'Google Imagen',
        enabled: getImageSwitchChecked('google-imagen-switch', [
          'google-imagen-enabled',
          'google-imagen-switch'
        ])
      },
      {
        key: 'openai',
        type: 'openaiimag',
        name: 'OpenAI兼容',
        enabled: getImageSwitchChecked('openai-compatible-image-switch', [
          'openaiCompatImageEnabled',
          'openai-compatible-image-switch'
        ])
      }
    ];

    const enabledProviders = providers.filter(provider => provider.enabled);

    if (enabledProviders.length === 0) {
      return { status: 'none', message: '未启用生图', provider: null, enabledProviders };
    }

    if (enabledProviders.length > 1) {
      return { status: 'multiple', message: '请只保留一个生图通道开启', provider: null, enabledProviders };
    }

    return { status: 'ok', message: '', provider: enabledProviders[0], enabledProviders };
  }

  function getCurrentImageMessageType() {
    const route = getCurrentEnabledImageProvider();
    return route.status === 'ok' ? route.provider.type : '';
  }

  function getImagePromptField(msgData) {
    return String(msgData?.prompt || msgData?.image_prompt || msgData?.description || msgData?.content || '').trim();
  }

  function normalizeImageMessageTypeForCurrentProvider(msgData, imageProviderRoute) {
    if (!msgData || typeof msgData !== 'object') return msgData;
    const imageTypes = new Set(['ai_image', 'naiimag', 'googleimag', 'openaiimag']);
    if (!imageTypes.has(msgData.type)) return msgData;
    if (!imageProviderRoute || imageProviderRoute.status !== 'ok' || !imageProviderRoute.provider) return msgData;

    const targetType = imageProviderRoute.provider.type;
    if (msgData.type === targetType) return msgData;

    const promptText = getImagePromptField(msgData);
    msgData.type = targetType;

    if (targetType === 'ai_image') {
      msgData.image_prompt = msgData.image_prompt || promptText;
      msgData.description = msgData.description || promptText;
    } else {
      msgData.prompt = msgData.prompt || promptText;
    }

    return msgData;
  }

  function normalizeMusicActionMessageType(msgData) {
    if (!msgData || typeof msgData !== 'object') return msgData;
    if (msgData.type === 'music_action' && typeof msgData.action === 'string') {
      const action = msgData.action.trim();
      if (action === 'change_music' || action === 'add_song_to_playlist') {
        msgData.type = action;
      }
    }
    return msgData;
  }

  function normalizeMusicMatchText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/^\[?\d+\]?[\s.-]*/, '')
      .replace(/[\s"'`~!@#$%^&*()_+\-=[\]{};:\\|,.<>/?，。！？、；：“”‘’（）【】《》·]/g, '');
  }

  function findBestMusicTrackIndex(playlist, songName, artistName = '') {
    if (!Array.isArray(playlist) || playlist.length === 0) return -1;
    const query = normalizeMusicMatchText(songName);
    const artistQuery = normalizeMusicMatchText(artistName);
    if (!query) return -1;

    let bestIndex = -1;
    let bestScore = 0;
    playlist.forEach((track, index) => {
      const name = normalizeMusicMatchText(track?.name);
      const artist = normalizeMusicMatchText(track?.artist);
      const combined = normalizeMusicMatchText(`${track?.name || ''}${track?.artist || ''}`);
      let score = 0;

      if (name === query) score = 100;
      else if (combined === query) score = 95;
      else if (name.includes(query)) score = 80;
      else if (query.includes(name) && name) score = 70;
      else if (combined.includes(query)) score = 60;

      if (score > 0 && artistQuery) {
        const artistMatches = !!artist && (artist.includes(artistQuery) || artistQuery.includes(artist));
        score += artistMatches ? 15 : -20;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  function addAiToolFeedback(chat, action, ok, detail) {
    if (!chat || !Array.isArray(chat.history)) return;
    chat.history.push({
      role: 'system',
      content: `[AI_TOOL_RESULT] ${action}: ${ok ? 'ok' : 'failed'}${detail ? ` - ${detail}` : ''}`,
      timestamp: Date.now(),
      isHidden: true
    });
  }

  // ========== AI 原创曲库 IndexedDB 持久化（request_song 用） ==========
  // 来源：参考 js/music-voice-sample.js 的 IndexedDB 模式
  const AI_SONGS_DB = 'ai-songs';
  const AI_SONGS_STORE = 'songs';
  let aiSongsDbPromise = null;
  function openAiSongsDb() {
    if (aiSongsDbPromise) return aiSongsDbPromise;
    aiSongsDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(AI_SONGS_DB, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(AI_SONGS_STORE)) {
          db.createObjectStore(AI_SONGS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return aiSongsDbPromise;
  }
  async function persistAiSongBlob(songId, record) {
    if (!songId || !record || !record.blob) return false;
    try {
      const db = await openAiSongsDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(AI_SONGS_STORE, 'readwrite');
        const store = tx.objectStore(AI_SONGS_STORE);
        const req = store.put({ id: songId, ...record });
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[request_song] persistAiSongBlob failed:', e);
      return false;
    }
  }
  // 暴露到 window 供 background-activity / 其他模块复用
  window.persistAiSongBlob = persistAiSongBlob;

  function normalizeNeteaseQualityLevel(level) {
    const allowed = new Set(['standard', 'exhigh', 'lossless', 'hires', 'jymaster', 'sky', 'dolby', 'jyeffect']);
    const normalized = String(level || 'exhigh').trim().toLowerCase();
    return allowed.has(normalized) ? normalized : 'exhigh';
  }
  function getChatImageInstructionContext(scope = 'single') {
    const route = getCurrentEnabledImageProvider();
    if (route.status !== 'ok' || !route.provider) return '';

    const nameField = scope === 'group' ? ', "name": "你的角色本名"' : '';
    const providerType = route.provider.type;

    if (providerType === 'ai_image') {
      return `-   **图片分享 (在聊天中直接发送)**: \`{"type": "ai_image"${nameField}, "description": "给用户看的图片描述", "image_prompt": "用于生成图片的英文关键词，风格可为风景/动漫/插画/二次元等"}\`
    - 使用场景：当你想要基于当前对话情景分享一张图片时使用。
    - 不要频繁使用，只在真正想分享图片的时候使用。`;
    }

    if (providerType === 'naiimag') {
      return `-   **NovelAI图片分享 (在聊天中直接发送)**: \`{"type": "naiimag"${nameField}, "prompt": "详细的英文描述词..."}\`
    - **【绝不能暴露是NovelAI生成的图片！】**
    - 使用场景：当你想要基于当前对话情景分享一张图片时使用。
    - prompt 请使用英文，专注描述内容本身。
    - 不要频繁使用，只在真正想分享图片的时候使用。`;
    }

    if (providerType === 'googleimag') {
      return `-   **Google Imagen图片分享 (在聊天中直接发送)**: \`{"type": "googleimag"${nameField}, "prompt": "详细的英文描述词..."}\`
    - **【绝不能暴露是AI生成的图片！】**
    - Google Imagen适合写实风格、高质量图片。
    - prompt 请使用英文，专注描述内容本身。
    - 不要频繁使用，只在真正想分享图片的时候使用。`;
    }

    if (providerType === 'openaiimag') {
      return `-   **OpenAI兼容图片分享 (在聊天中直接发送)**: \`{"type": "openaiimag"${nameField}, "prompt": "详细的图片描述词..."}\`
    - **【绝不能暴露是AI生成的图片！】**
    - 使用场景：当你想要基于当前对话情景分享一张图片时使用。
    - prompt 专注描述内容本身。
    - 不要频繁使用，只在真正想分享图片的时候使用。`;
    }

    return '';
  }

  function buildImageInstructionFromPrompt(promptText) {
    const route = getCurrentEnabledImageProvider();
    const prompt = String(promptText || '').trim();
    const targetType = route.status === 'ok' && route.provider ? route.provider.type : 'ai_image';

    if (targetType === 'ai_image') {
      return {
        type: 'ai_image',
        description: prompt,
        image_prompt: prompt
      };
    }

    return {
      type: targetType,
      prompt
    };
  }

  function parseAiImageDirectiveText(content) {
    const match = String(content || '').trim().match(/^image###([\s\S]+)###$/);
    if (!match) return null;
    const prompt = match[1].trim();
    return prompt ? buildImageInstructionFromPrompt(prompt) : null;
  }

  function isAiImageInstructionMessage(msgData) {
    if (!msgData || typeof msgData !== 'object') return false;
    return ['ai_image', 'naiimag', 'googleimag', 'openaiimag'].includes(msgData.type);
  }

  // 获取天气上下文信息，用于AI prompt
  async function getWeatherContextForPrompt(chat) {
    const wSettings = chat.settings.weather || {};
    if (!wSettings.enabled) return "";

    let context = "\n# 【实时环境与天气同步】\n";
    let hasData = false;

    // 获取用户天气
    if (wSettings.userLat && wSettings.userLon) {
      const userWeather = await fetchWeather(wSettings.userLat, wSettings.userLon);
      if (userWeather) {
        const locationName = wSettings.userVirtualCity || "所在地";
        context += `- 用户(${chat.settings.myNickname || '我'})当前在【${locationName}】: ${userWeather}。\n`;
        hasData = true;
      }
    }

    // 获取角色天气
    if (wSettings.charLat && wSettings.charLon) {
      const charWeather = await fetchWeather(wSettings.charLat, wSettings.charLon);
      if (charWeather) {
        const locationName = wSettings.charVirtualCity || "所在地";
        context += `- 你(${chat.name})当前在【${locationName}】: ${charWeather}。\n`;
        hasData = true;
      }
    }

    if (!hasData) return "";

    context += "请根据上述天气和时间状态（如是否下雨、是白天还是夜晚）来调整你的描写氛围、角色的行动（如撑伞、避暑、添衣）以及对话内容。";
    return context;
  }

  function toGeminiRequestData(model, apiKey, systemInstruction, messagesForDecision) {
    const apiTemperature = state.globalSettings.apiTemperature || 0.8;
    const apiTopP = state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0;
    const apiPresencePenalty = state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0;
    const apiFrequencyPenalty = state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0;
    const roleType = {
      user: 'user',
      assistant: 'model',
      system: 'user'
    };


    const contents = [{
      role: 'user',
      parts: [{
        text: systemInstruction
      }]
    },
    {
      role: 'model',
      parts: [{
        text: '好的，我明白了。我会严格遵守以上所有规则和设定。'
      }]
    },

    ...messagesForDecision.map((item) => {
      const parts = [];

      if (Array.isArray(item.content)) {
        item.content.forEach(part => {
          if (part.type === 'text') {
            parts.push({
              text: part.text
            });
          } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {

            const currentImageData = part.image_url.url;
            const base64Data = currentImageData.split(',')[1];
            const mimeTypeMatch = currentImageData.match(/^data:(.*);base64/);
            if (mimeTypeMatch && base64Data) {
              parts.push({
                inline_data: {
                  mime_type: mimeTypeMatch[1],
                  data: base64Data
                }
              });
            }
          }
        });
      } else {

        parts.push({
          text: String(item.content)
        });
      }
      return {
        role: roleType[item.role],
        parts: parts
      };
    })
    ];


    return {
      // [2026-09-14 AQ. 凭证兼容] 删除 ?key= URL 参数; AIza/AQ 都走 x-goog-api-key header
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      data: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': getRandomValue(apiKey)
        },
        body: JSON.stringify({
          contents: contents,
          generationConfig: {
            temperature: apiTemperature,
            topP: apiTopP,
            presencePenalty: apiPresencePenalty,
            frequencyPenalty: apiFrequencyPenalty,
          },
        })
      }
    };
  }



  async function uploadImageToImgBB(base64String, options = {}) {
    // 1. 检查功能是否开启
    if (!state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      // console.log("ImgBB 未开启，返回原始 Base64。");
      return base64String; // 功能未开启，直接返回
    }

    // 2. 检查是否已经是 URL
    if (!base64String || !base64String.startsWith('data:image')) {
      // console.log("输入已是 URL 或为空，无需上传。");
      return base64String; // 已经是 URL 或为空，无需上传
    }

    // 3. 提取 Base64 数据
    // 格式为 data:image/png;base64,iVBORw0KGgo...
    const base64Data = base64String.split(',')[1];
    if (!base64Data) {
      console.warn("无法从字符串中提取 Base64 数据:", base64String.substring(0, 50) + "...");
      return base64String; // 格式错误，返回原文
    }

    console.log(`[ImgBB] 开始上传图片... (大小: ${(base64String.length / 1024).toFixed(1)} KB)`);

    try {
      const formData = new FormData();
      formData.append('image', base64Data);

      const response = await fetch(`https://api.imgbb.com/1/upload?key=${state.apiConfig.imgbbApiKey}`, {
        method: 'POST',
        body: formData,
        signal: options && options.signal
      });

      const result = await response.json();

      if (result.success && result.data && result.data.url) {
        console.log("[ImgBB] 上传成功! URL:", result.data.url);
        return result.data.url; // 成功！返回 URL
      } else {
        // ImgBB API 返回了错误
        throw new Error(result.error?.message || 'ImgBB API 返回了未知错误。');
      }
    } catch (error) {
      console.error("[ImgBB] 上传失败:", error);
      // 抛出错误，让调用此函数的上层逻辑知道上传失败了
      throw new Error(`ImgBB 上传失败: ${error.message}`);
    }
  }
  async function uploadFileToCatbox(fileObject) {
    // 1. 检查功能是否开启
    if (!state.apiConfig.catboxEnable || !state.apiConfig.catboxUserHash) {
      console.log("[Catbox] 功能未开启或未配置 User Hash，跳过上传。");
      return null; // 功能未开启，返回 null 以便回退
    }

    const userHash = state.apiConfig.catboxUserHash;
    console.log(`[Catbox] 开始上传文件: ${fileObject.name || 'blob.mp3'}... (大小: ${(fileObject.size / 1024 / 1024).toFixed(2)} MB)`);

    try {
      const formData = new FormData();
      formData.append('reqtype', 'fileupload');
      formData.append('userhash', userHash);
      formData.append('fileToUpload', fileObject, fileObject.name || 'track.mp3'); // 提供文件名

      // ▼▼▼ 【核心修复】 ▼▼▼
      // 1. 定义 Catbox API URL
      let apiUrl = 'https://catbox.moe/user/api.php';

      // 2. 获取 CORS 代理设置 (复用 NovelAI 的设置)
      const proxySettings = getNovelAISettings(); // This function is around line 4504
      let corsProxy = proxySettings.cors_proxy;
      if (corsProxy === 'custom') {
        corsProxy = proxySettings.custom_proxy_url || '';
      }

      // 3. 如果代理存在, 则使用代理
      if (corsProxy && corsProxy !== '') {
        // 【重要】Catbox API URL 不需要编码，而 NovelAI 需要，这里我们直接拼接
        apiUrl = corsProxy + apiUrl;
        console.log(`[Catbox] 检测到CORS代理，使用代理上传: ${apiUrl}`);
      } else {
        console.log("[Catbox] 未配置CORS代理，尝试直连... (这很可能会失败)");
      }
      // ▲▲▲ 【修复结束】 ▲▲▲

      const response = await fetch(apiUrl, { // <-- 替换为 apiUrl
        method: 'POST',
        body: formData
      });

      const responseText = await response.text();

      if (response.ok && responseText.startsWith('http')) {
        console.log("[Catbox] 上传成功! URL:", responseText);
        return responseText; // 成功！返回 URL
      } else {
        // Catbox API 返回了错误文本
        throw new Error(responseText || 'Catbox API 返回了未知错误。');
      }
    } catch (error) {
      console.error("[Catbox] 上传失败:", error);
      // 抛出错误，让调用此函数的上层逻辑知道上传失败了
      // 【重要】我们在这里只抛出原始错误，以便上层函数可以捕获并显示它
      throw error;
    }
  }
  async function silentlyUpdateDbUrl(table, recordId, pathString, base64ToFind, nameToMatch = null) {
    if (!state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      console.log(`[ImgBB Silent Update] ImgBB is disabled, skipping silent upload for ${table.name}.${recordId}.${pathString}.`);
      return; // ImgBB not enabled, do nothing.
    }

    let imageUrl;
    try {
      imageUrl = await uploadImageToImgBB(base64ToFind);
      if (imageUrl === base64ToFind) {
        console.log("[ImgBB Silent Update] Upload returned Base64 (or failed), no update needed.");
        return; // Upload failed or was skipped
      }
    } catch (uploadError) {
      console.error(`[ImgBB Silent Update] Background upload failed for ${table.name}.${recordId}.${pathString}:`, uploadError.message);
      return; // Upload failed
    }

    console.log(`[ImgBB Silent Update] Success. New URL: ${imageUrl}. Finding record to update...`);

    try {
      const record = await table.get(recordId);
      if (!record) {
        console.warn(`[ImgBB Silent Update] Could not find record ${recordId} in table ${table.name}.`);
        return;
      }

      let updated = false;

      // 辅助函数：通过路径字符串深入对象，返回父级和最后的键
      function getNestedParent(obj, path) {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          if (current[keys[i]] === undefined || current[keys[i]] === null) {
            console.warn(`[ImgBB Silent Update] Invalid path: ${path} in record at key ${keys[i]}.`);
            return null; // Path does not exist
          }
          current = current[keys[i]];
        }
        return { parent: current, finalKey: keys[keys.length - 1] };
      }

      if (nameToMatch) {
        // --- 逻辑 A: 搜索数组 ---
        const result = getNestedParent(record, pathString);
        if (result && Array.isArray(result.parent[result.finalKey])) {
          const arrayToSearch = result.parent[result.finalKey];
          const itemToUpdate = arrayToSearch.find(item => item.url === base64ToFind && item.name === nameToMatch);

          if (itemToUpdate) {
            itemToUpdate.url = imageUrl;
            updated = true;
            console.log(`[ImgBB Silent Update] Found and updated item "${nameToMatch}" in array ${pathString}.`);
          } else {
            console.warn(`[ImgBB Silent Update] Could not find item "${nameToMatch}" with matching Base64 in array ${pathString} to update.`);
          }
        } else {
          console.warn(`[ImgBB Silent Update] Path ${pathString} did not resolve to a valid array.`);
        }
      } else {
        // --- 逻辑 B: 更新简单属性 (如 'url' 或 'widgetData.polaroid-img-1') ---
        const result = getNestedParent(record, pathString);
        if (result && result.parent[result.finalKey] === base64ToFind) {
          result.parent[result.finalKey] = imageUrl;
          updated = true;
          console.log(`[ImgBB Silent Update] Found and updated simple path ${pathString}.`);
        } else if (result) {
          console.warn(`[ImgBB Silent Update] Value changed since upload for ${pathString}. Expected Base64, found: ${String(result.parent[result.finalKey]).substring(0, 30)}...`);
        } else {
          console.warn(`[ImgBB Silent Update] Path ${pathString} did not resolve to a matching string.`);
        }
      }


      if (updated) {
        await table.put(record);
        console.log(`[ImgBB Silent Update] Successfully updated DB for ${table.name}.${recordId}.${pathString}.`);

        // 更新内存 (state.globalSettings)
        if (table.name === 'globalSettings' && recordId === 'main') {
          // (重新获取更新后的内存状态)
          const stateResult = getNestedParent(state, `globalSettings.${pathString}`);
          if (nameToMatch && stateResult && Array.isArray(stateResult.parent[stateResult.finalKey])) {
            const stateArray = stateResult.parent[stateResult.finalKey];
            const stateItem = stateArray.find(item => item.url === base64ToFind && item.name === nameToMatch);
            if (stateItem) stateItem.url = imageUrl;
          } else if (!nameToMatch && stateResult && stateResult.parent[stateResult.finalKey] === base64ToFind) {
            stateResult.parent[stateResult.finalKey] = imageUrl;
          }
          console.log(`[ImgBB Silent Update] In-memory state.globalSettings updated.`);
        }
      }
    } catch (dbError) {
      console.error(`[ImgBB Silent Update] Failed to save updated URL to DB for ${table.name}.${recordId}.${pathString}:`, dbError);
    }
  }


  // ========== 提示词变量替换与旧版兼容 ==========
  function replaceTemplateVars(template, contextMap) {
    if (!template) return '';
    let p = template;
    
    // 1. 粗犷替换旧版的复杂 ${...} 表达式，映射为新版 {{...}}
    p = p.replace(/\$\{chat\.originalName\}/g, '{{chat.originalName}}');
    p = p.replace(/\$\{chat\.name\}/g, '{{chat.name}}');
    p = p.replace(/\$\{chat\.settings\.aiPersona\}/g, '{{aiPersona}}');
    p = p.replace(/\$\{latestThoughtContext\}/g, '{{latestThoughtContext}}');
    p = p.replace(/\$\{worldBookContent[^\}]*\}/g, '{{worldBookContent}}');
    p = p.replace(/\$\{getMemoryContextForPrompt\(chat\)\}/g, '{{memoryContextForPrompt}}');
    p = p.replace(/\$\{multiLayeredSummaryContext\}/g, '{{multiLayeredSummaryContext}}');
    p = p.replace(/\$\{todoListContext\}/g, '{{todoListContext}}');
    p = p.replace(/\$\{periodSummaryContext\}/g, '{{periodSummaryContext}}');
    p = p.replace(/\$\{myNickname\}/g, '{{myNickname}}');
    p = p.replace(/\$\{chat\.settings\.myPersona[^\}]*\}/g, '{{myPersona}}');
    
    // 特别处理连着两个 ${} 的 status，如 ${chat.settings.userStatus ? ...} ${chat...}
    p = p.replace(/\$\{chat\.settings\.userStatus[^\n]*?\}\s*(?:\$\{chat\.settings\.userStatus[^\}]*\})?/g, '{{userStatus}}');
    
    p = p.replace(/\$\{userProfileContext\}/g, '{{userProfileContext}}');
    p = p.replace(/\$\{nameHistoryContext\}/g, '{{nameHistoryContext}}');
    
    p = p.replace(/\$\{chat\.settings\.enableTimePerception[^\n]*\}/g, '{{timePerceptionContext}}');
    p = p.replace(/\$\{weatherContext\}/g, '{{weatherContext}}');
    p = p.replace(/\$\{timeContext\}/g, '{{timeContext}}');
    p = p.replace(/\$\{musicContext\s*\?[^\n]*\}/g, '{{musicContextStr}}');
    p = p.replace(/\$\{readingContext\s*\?[^\n]*\}/g, '{{readingContextStr}}');
    p = p.replace(/\$\{contactsList\}/g, '{{contactsList}}');
    p = p.replace(/\$\{postsContext\}/g, '{{postsContext}}');
    p = p.replace(/\$\{groupContext\}/g, '{{groupContext}}');
    p = p.replace(/\$\{sharedContext\}/g, '{{sharedContext}}');
    p = p.replace(/\$\{callTranscriptContext\}/g, '{{callTranscriptContext}}');
    p = p.replace(/\$\{synthMusicInstruction\}/g, '{{synthMusicInstruction}}');
    p = p.replace(/\$\{narratorInstruction\}/g, '{{narratorInstruction}}');
    p = p.replace(/\$\{kinshipContext\}/g, '{{kinshipContext}}');
    p = p.replace(/\$\{coupleSpaceContext\}/g, '{{coupleSpaceContext}}');
    p = p.replace(/\$\{thoughtsPrompt\}/g, '{{thoughtsPrompt}}');
    p = p.replace(/\$\{stickerContext\}/g, '{{stickerContext}}');
    p = p.replace(/\$\{chat\.settings\.aiAvatarLibrary\}/g, '{{aiAvatarLibrary}}');
    p = p.replace(/\$\{chat\.settings\.myAvatarLibrary\}/g, '{{myAvatarLibrary}}');

    // 尝试把遗漏的简单 ${xxx} 转成 {{xxx}}
    p = p.replace(/\$\{([^}]+)\}/g, '{{$1}}');

    // 2. 将 {{xxx}} 变量映射到 contextMap 真实数据
    return p.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
      const k = key.trim();
      
      if (contextMap[k] !== undefined) return contextMap[k];
      
      // 支持自定义心声变量替换
      const activeChatId = state.activeChatId;
      if (activeChatId && state.chats[activeChatId]) {
        const currentChat = state.chats[activeChatId];
        if (currentChat.customThoughts && currentChat.customThoughts[k] !== undefined) {
          return currentChat.customThoughts[k];
        }
      }
      
      // 模糊匹配兜底（防用户写错变量名）
      if (k === 'chat.originalName') return contextMap['chat.originalName'] !== undefined ? contextMap['chat.originalName'] : match;
      if (k === 'chat.name') return contextMap['chat.name'] !== undefined ? contextMap['chat.name'] : match;
      if (k.includes('aiPersona')) return contextMap['aiPersona'] !== undefined ? contextMap['aiPersona'] : match;
      if (k.includes('worldBookContent')) return contextMap['worldBookContent'] !== undefined ? contextMap['worldBookContent'] : match;
      if (k.includes('getMemoryContextForPrompt')) return contextMap['memoryContextForPrompt'] !== undefined ? contextMap['memoryContextForPrompt'] : match;
      if (k.includes('myPersona')) return contextMap['myPersona'] !== undefined ? contextMap['myPersona'] : match;
      if (k.includes('userStatus')) return contextMap['userStatus'] !== undefined ? contextMap['userStatus'] : match;
      if (k.includes('timePerception') || k.includes('currentTime')) return contextMap['timePerceptionContext'] !== undefined ? contextMap['timePerceptionContext'] : match;
      if (k.includes('musicContext')) return contextMap['musicContextStr'] !== undefined ? contextMap['musicContextStr'] : match;
      if (k.includes('readingContext')) return contextMap['readingContextStr'] !== undefined ? contextMap['readingContextStr'] : match;
      if (k.includes('aiAvatarLibrary')) return contextMap['aiAvatarLibrary'] !== undefined ? contextMap['aiAvatarLibrary'] : match;
      if (k.includes('myAvatarLibrary')) return contextMap['myAvatarLibrary'] !== undefined ? contextMap['myAvatarLibrary'] : match;
      if (k === 'char_avatar') return contextMap['char_avatar'] !== undefined ? contextMap['char_avatar'] : match;
      if (k === 'user_avatar') return contextMap['user_avatar'] !== undefined ? contextMap['user_avatar'] : match;
      if (k === 'char_name') return contextMap['char_name'] !== undefined ? contextMap['char_name'] : match;
      if (k === 'char_remark') return contextMap['char_remark'] !== undefined ? contextMap['char_remark'] : match;
      if (k === 'user_name') return contextMap['user_name'] !== undefined ? contextMap['user_name'] : match;
      if (k === 'user_nickname') return contextMap['user_nickname'] !== undefined ? contextMap['user_nickname'] : match;
      if (k.includes('myNickname')) return contextMap['myNickname'] !== undefined ? contextMap['myNickname'] : match;

      // 主动消息冷却时间 (v0.1.87+)
      if (k === 'proactiveCooldownMinutes') {
        const mins = window.state?.globalSettings?.proactiveCooldownMinutes;
        return (typeof mins === 'number' && mins >= 0) ? String(mins) : '30';
      }

      return match;
    });
  }

  // ============================================================
  // Hook: AI 主动消息 (function calling 风格)
  // 解析 LLM 输出后, 检测 type='create_push_task' 指令 → 调 ProactiveWake.createTask()
  // 替换为 visible text 提示气泡 (user 看到 AI "悄悄设了提醒")
  // 调用方在 parseAiResponse 之后调这个函数
  // ============================================================
  function hookProactiveWakeInMessages(messagesArray, chat) {
    if (!Array.isArray(messagesArray)) return messagesArray;
    for (const msg of messagesArray) {
      if (msg && msg.type === 'create_push_task') {
        // 异步触发 ProactiveWake.createTask (fire-and-forget, 不阻塞)
        if (window.ProactiveWake && typeof window.ProactiveWake.tryHandleAction === 'function') {
          try {
            window.ProactiveWake.tryHandleAction(msg, chat).catch(e => {
              console.warn('[hookProactiveWake] create_push_task 触发失败:', e.message);
            });
          } catch (e) {
            console.warn('[hookProactiveWake] 同步错误:', e.message);
          }
        } else {
          console.warn('[hookProactiveWake] ProactiveWake 模块未加载');
        }
        // 永远静默: create_push_task 是 AI 主动消息的幕后触发, 物理上不让 user 在 chat 里看到任何气泡
        // 原因: 活人感来自"AI 突然想起你", 看到"🌸已悄悄设提醒"就直接破坏体验
        // 双保险: 不管 AI 传 visible_hint=true 还是 false, 这里都强制 _pwRemove
        msg._pwRemove = true;
      }
    }
    // 过滤掉 _pwRemove 的
    return messagesArray.filter(m => !m._pwRemove);
  }

  function parseAiResponse(content) {
    if (!content) return [{
      type: 'text',
      content: '(AI返回了空内容)'
    }];

    let trimmedContent = content.trim();


    const markdownRegex = /```json\s*([\s\S]*?)\s*```/;
    const markdownMatch = trimmedContent.match(markdownRegex);

    if (markdownMatch && markdownMatch[1]) {

      trimmedContent = markdownMatch[1].trim();
      console.log("解析器：已启用 Markdown 提取模式。");
    }


    if (trimmedContent.startsWith('[') && trimmedContent.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmedContent);
        if (Array.isArray(parsed)) {
          console.log("解析成功：标准JSON数组格式。");
          return parsed;
        }
      } catch (e) {
        console.warn("标准JSON数组解析失败，将尝试强力提取...");
      }
    }


    const startIndex = trimmedContent.indexOf('[');


    const lastBraceIndex = trimmedContent.lastIndexOf('}');

    if (startIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > startIndex) {


      const endIndex = trimmedContent.indexOf(']', lastBraceIndex);

      if (endIndex !== -1) {
        const arrayString = trimmedContent.substring(startIndex, endIndex + 1);
        try {
          const parsed = JSON.parse(arrayString);
          if (Array.isArray(parsed)) {
            console.log("解析成功：通过强力提取 [ ... } ... ] 模式。");
            return parsed;
          }
        } catch (e) {
          console.warn("强力提取 [ ... } ... ] 失败，将尝试提取单个对象...");
        }
      }
    }


    const jsonMatches = trimmedContent.match(/{[^{}]*}/g);
    if (jsonMatches) {
      const results = [];
      for (const match of jsonMatches) {
        try {
          const parsedObject = JSON.parse(match);
          results.push(parsedObject);
        } catch (e) {
          console.warn("跳过一个无效的JSON片段:", match);
        }
      }

      if (results.length > 0) {
        console.log("解析成功：通过强力提取 {...} 模式。");
        return results;
      }
    }


    console.error("所有解析方案均失败！将返回原始文本。原始回复:", content);
    return [{
      type: 'text',
      content: content
    }];
  }

  function isOfficialMinimaxProviderInfo(providerInfo = {}) {
    const provider = String(providerInfo.provider || providerInfo.baseURL || providerInfo.baseUrl || providerInfo.proxyUrl || providerInfo.apiUrl || '').toLowerCase();
    return provider.includes('api.minimaxi.com');
  }

  function logMinimaxCleanDiagnostic(event, providerInfo, beforeLength, afterLength) {
    try {
      window.runtimeDiag?.log?.(event, {
        provider: providerInfo?.provider || providerInfo?.baseURL || providerInfo?.baseUrl || providerInfo?.proxyUrl || '',
        model: providerInfo?.model || '',
        beforeLength,
        afterLength
      });
    } catch (error) {
      console.warn('[Minimax清洗诊断日志失败]', event, error);
    }
  }

  function stripMinimaxReasoningSections(text) {
    let output = String(text || '');

    output = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
    output = output.replace(/<think>[\s\S]*$/gi, '');

    const finalAnswerMarker = /(?:^|\n)\s*(?:最终回复|最终回答|最终答案|回复|回答|final answer|final response|answer)\s*[:：]\s*/i;
    if (finalAnswerMarker.test(output)) {
      output = output.replace(/^[\s\S]*?(?:最终回复|最终回答|最终答案|回复|回答|final answer|final response|answer)\s*[:：]\s*/i, '');
    }

    const reasoningLabel = String.raw`(?:思考|思维链|推理|内部推理|reasoning|chain\s+of\s+thought|analysis)`;
    output = output.replace(new RegExp(`(^|\\n)\\s*${reasoningLabel}\\s*[:：][\\s\\S]*?(?=\\n\\s*(?:\\[|\\{|最终回复|最终回答|最终答案|回复|回答|final answer|final response|answer)\\s*[:：]?|$)`, 'gi'), '\n');
    output = output.replace(new RegExp(`(^|\\n)\\s*${reasoningLabel}\\s*[:：][^\\n]*(?=\\n|$)`, 'gi'), '\n');

    return output;
  }

  function cleanMinimaxResponseText(rawText, providerInfo = {}, options = {}) {
    const fallbackText = options.fallbackText || '我在。';
    const before = String(rawText || '');
    const beforeLength = before.length;

    // [通用] 先剥 <think>...</think> 标签(所有 provider 都跑——M3/DeepSeek R1/QwQ 等多家模型会输出)
    // 这步必须在 provider gate 前, 不然非 Minimax 渠道会原样吐思考过程到 UI
    let cleaned = before
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/gi, '')
      .trim();

    if (!options.force && !isOfficialMinimaxProviderInfo(providerInfo)) {
      return cleaned;
    }

    cleaned = stripMinimaxReasoningSections(cleaned)
      .replace(/\(\s*Timestamp\s*:\s*\d+\s*\)/gi, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, '')
      .trim();

    logMinimaxCleanDiagnostic('MINIMAX_CLEAN_APPLIED', providerInfo, beforeLength, cleaned.length);

    if (!cleaned) {
      cleaned = fallbackText;
      logMinimaxCleanDiagnostic('MINIMAX_CLEAN_EMPTY_FALLBACK', providerInfo, beforeLength, cleaned.length);
    }

    return cleaned;
  }

  /**
   * 把 13 位毫秒戳转成人读格式 + 保留 raw 戳（不改变原 (Timestamp: ...) 结构，
   * 只是追加可读时间），让 AI 能直接读到"2026-06-30 周二 17:17"而不用反推 ms。
   * 2026-06-30：13 位 Unix 毫秒戳对模型不友好（训练截止 + 反推精度有限），
   * 喂回历史时把人读时间和 raw 一并塞进去，AI 时间感知更准。
   *
   * 输出示例：
   *   T=1782811022201 → "(2026-06-30 周二 17:17 | T:1782811022201)"
   *   T 缺失/无效     → "(Timestamp: <invalid>)" 兜底
   */
  function formatTimestampForHistory(timestamp) {
    if (timestamp === undefined || timestamp === null || timestamp === '') {
      return '(Timestamp: <empty>)';
    }
    let date;
    try {
      const n = typeof timestamp === 'number' ? timestamp : Number(timestamp);
      if (!Number.isFinite(n)) return `(Timestamp: ${timestamp})`;
      date = new Date(n);
      if (Number.isNaN(date.getTime())) return `(Timestamp: ${timestamp})`;
    } catch (e) {
      return `(Timestamp: ${timestamp})`;
    }
    let readable;
    try {
      readable = date.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch (e) {
      readable = date.toISOString();
    }
    return `(${readable} | T:${timestamp})`;
  }

  /**
   * 把"连续多条 assistant 段"合并成"1 条长 history"，body 用 \n 连。
   * 旧路径下，R1 多段每段都是 (Timestamp: T) [JSON] 一条独立的 role:assistant
   * API message，M3 看到这一串分散的短文本就粗心当成"我上 1 轮就发了 1 个
   * 短气泡"，模仿时也只输 1 段。合并后 M3 看到的是"1 条长消息 + \n 分段"，
   * 自然模仿成"1 条长 + \n 分段"输出多段。中间被 user / system 等其他
   * 角色卡断的段不参与合并（每轮独立）。
   */
  function mergeAdjacentAssistantMessages(feed) {
    if (!Array.isArray(feed) || feed.length === 0) return feed;
    const merged = [];
    for (const m of feed) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === m.role && m.role === 'assistant') {
        prev.content = prev.content + '\n' + m.content;
      } else {
        merged.push(m);
      }
    }
    feed.splice(0, feed.length, ...merged);
    return feed;
  }

  function updateAssistantMessageContent(timestamp, content) {
    const bubble = document.querySelector(`.message-bubble[data-timestamp="${timestamp}"]`);
    if (!bubble) return;
    if (typeof parseMarkdown === 'function') {
      bubble.innerHTML = parseMarkdown(String(content || '')).replace(/\n/g, '<br>');
    } else {
      bubble.textContent = String(content || '');
    }
    if (bubble.scrollIntoView) {
      bubble.scrollIntoView({ block: 'nearest' });
    }
  }

  function getShortMemoryCount(chat) {
    const candidates = [
      chat?.settings?.maxMemory,
      chat?.maxMemory,
      state?.globalSettings?.maxMemory,
      30
    ];

    for (const value of candidates) {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return 30;
  }

  // ==================== 热点日报 prompt 注入（2026-07-02 新增，替换原豆瓣） ====================
  // 跟糯 utils/realtimeContext.ts:buildFullContext 一样：从当前时段快照里 Fisher-Yates 打散抽 5 条，
  // 软提示"这是你的背景知识，不是必须播报"。
  async function getHotNewsContextForPrompt(chat) {
    try {
      if (!state.globalSettings || !state.globalSettings.hotNewsEnabled) return '';
      if (typeof window.getSlottedHotNews !== 'function') return '';

      const platforms = (state.globalSettings.hotNewsPlatforms && state.globalSettings.hotNewsPlatforms.length > 0)
        ? state.globalSettings.hotNewsPlatforms
        : ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'];

      // 【2026-07-15 修复】Netlify Function 慢/超时会卡死 triggerAiResponse, 加 5s race 兜底降级为空
      let news = [];
      try {
        news = await Promise.race([
          window.getSlottedHotNews(platforms),
          new Promise((_, reject) => setTimeout(() => reject(new Error('hotnews timeout 5s')), 5000))
        ]);
      } catch (hnErr) {
        console.warn('[hotnews] getSlottedHotNews 失败/超时, 降级为空:', hnErr.message);
      }
      if (!news || news.length === 0) return '';

      // Fisher-Yates 打散后抽 5 条（每轮重 roll，平台全混）
      const pool = [...news];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const picks = pool.slice(0, 5);

      // 2026-07-04 改：跟糯米机的 buildFullContext 同样的引导框架。
      // 之前是裸 list + "别硬插"软提示，M3 看到标题就当背景知识忽略，没逐条读具体新闻，
      // 所以会出现"AI 知道有热点但开始编造具体内容"的幻觉。
      // 现在前后加 ⚠️ / ### 框架，把 5 条嵌入"真实世界感知"中段，强行锚定 M3 把每条都当真实事件读。
      const lines = [];
      lines.push('');
      lines.push(`### 【真实世界感知系统】`);
      lines.push(`⚠️ 重要：以下信息来自真实世界，不是虚构的。你现在真的能"看到"外面的世界——`);
      lines.push('');
      lines.push(`📰 【今天真实在发生 / 被热议的热点】`);
      picks.forEach(n => {
        const source = n.source ? `（${n.source}）` : '';
        let line = `- ${n.title}${source}`;
        // 2026-07-04 修复：Netlify Function 现在返回 content 字段（news.orz.ai 原生字段名），
        // 拿到具体新闻内容（不是空 desc），M3 就能看到"门将神扑 + 梅西偷袭任意球"这种详情。
        if (n.content && n.content !== n.title) line += `：${n.content}`;
        lines.push(line);
      });
      lines.push('');
      lines.push(`### 【如何使用这些信息】`);
      lines.push(`1. 这些信息都是**今天真实的**热点，可以直接引用；如果对方问"你怎么知道的"，就说你刚刷到 / 刚看到的。`);
      lines.push(`2. 别假装不知道这些——这是你真能感知到的外部世界，不是虚构设定。`);
      lines.push(`3. 自然地挑一两条你感兴趣的聊起来就行，不用刻意播报，也别刻意回避。`);
      lines.push('');
      return lines.join('\n');
    } catch (e) {
      console.warn('[hotnews] getHotNewsContextForPrompt 失败:', e?.message || e);
      return '';
    }
  }

  async function getRecentChatMessagesForAi(chat, limit, options = {}) {
    const maxMemory = Math.max(1, parseInt(limit, 10) || getShortMemoryCount(chat));

    if (window.messageStore?.getRecentContextMessages) {
      return window.messageStore.getRecentContextMessages(chat.id, {
        limit: maxMemory,
        excludeHidden: options.includeHidden === true ? false : true,
        excludeExcluded: options.includeExcluded === true ? false : true
      });
    }

    let rows = Array.isArray(chat.history) ? chat.history.slice() : [];
    if (!options.includeExcluded) rows = rows.filter(m => !m.isExcluded);
    if (!options.includeHidden) rows = rows.filter(m => !m.isHidden);
    return rows.slice(-maxMemory);
  }

  async function getLatestChatMessageForAi(chat, options = {}) {
    const recent = await getRecentChatMessagesForAi(chat, 1, {
      includeExcluded: options.includeExcluded !== false,
      includeHidden: options.includeHidden !== false
    });
    return recent[recent.length - 1] || null;
  }

  async function getLatestHiddenChatMessageForAi(chat) {
    if (window.messageStore) {
      const recent = await window.messageStore.getRecentMessages(chat.id, 30, (msg) => msg.isHidden);
      return recent[recent.length - 1] || null;
    }
    return (chat.history || []).filter(m => m.isHidden).pop() || null;
  }

  async function buildVisibleContextSummary(chat, sliceStart = -10, sliceEnd = undefined) {
    const recent = await getRecentChatMessagesForAi(chat, 20, {
      includeExcluded: true,
      includeHidden: false
    });
    return recent
      .slice(sliceStart, sliceEnd)
      .map(msg => {
        const sender = msg.role === 'user' ? '用户' : chat.name;
        return `${sender}: ${String(msg.content).substring(0, 50)}...`;
      })
      .join('\n');
  }

  async function fetchStreamingResponse(url, options, onDelta, hooks = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      aiRuntimeLog('AI_RESPONSE_NON_2XX_HANDLED', {
        status: response.status,
        bodyLength: String(errorText || '').length,
        contentType: response.headers.get('Content-Type') || '',
        streamMode: 'stream'
      });
      aiRuntimeLog('AI_RESPONSE_STREAM_SKIPPED_FOR_NON_2XX', {
        status: response.status,
        streamMode: 'stream'
      });
      throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
    }
    hooks.onFirstChunk?.(response);

    const contentType = response.headers.get('Content-Type') || '';
    if (!response.body) {
      const text = await response.text();
      hooks.onFirstChunk?.(text);
      onDelta(text);
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    const flushBuffer = async (text, final = false) => {
      if (!text) return;
      const lines = text.split(/\r\n|\n/);
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('data:')) {
          const jsonData = line.slice(5).trim();
          if (jsonData === '[DONE]') continue;
          console.log('原始SSE chunk:', jsonData); // 添加调试日志
          try {
            const parsed = JSON.parse(jsonData);
            const chunk = extractStreamChunk(parsed);
            if (chunk) {
              fullText += chunk;
              onDelta(chunk, fullText);
            }
          } catch (e) {
            if (final) {
              fullText += line;
              onDelta(line, fullText);
            }
          }
        } else if (!contentType.includes('event-stream')) {
          try {
            const parsed = JSON.parse(line.trim());
            const chunk = extractStreamChunk(parsed);
            if (chunk) {
              fullText += chunk;
              onDelta(chunk, fullText);
            }
          } catch (e) {
            fullText += line;
            onDelta(line, fullText);
          }
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hooks.onFirstChunk?.(value);
      buffer += decoder.decode(value, { stream: true });
      const lastIndex = Math.max(buffer.lastIndexOf('\r\n'), buffer.lastIndexOf('\n'));
      if (lastIndex !== -1) {
        const chunkText = buffer.slice(0, lastIndex + 1);
        buffer = buffer.slice(lastIndex + 1);
        await flushBuffer(chunkText);
      }
    }

    if (buffer) {
      await flushBuffer(buffer, true);
    }

    return fullText;
  }

  function parseSSEText(text) {
    const lines = text.split(/\r\n|\n/);
    let fullContent = '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonData = line.slice(6).trim();
        if (jsonData === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonData);
          const chunk = extractStreamChunk(parsed);
          fullContent += chunk;
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
    return fullContent || text; // 如果没提取到，返回原始文本
  }

  async function triggerSpectatorGroupAiAction() {
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const chat = state.chats[chatId];
    lastRawAiResponse = '';
    lastResponseTimestamps = [];
    if (window.chatStuckStateRepair && typeof window.chatStuckStateRepair.ensureCurrentChatNotStuck === 'function') {
      const ok = await window.chatStuckStateRepair.ensureCurrentChatNotStuck();
      if (!ok) {
        try { await showCustomAlert('对话修复', '检测到未完成的生成状态，已尝试修复，请重试。'); } catch (e) {}
        return;
      }
    }
    const aiRequestState = beginAiGenerationRequest(chatId);
    const propelBtn = document.getElementById('spectator-propel-btn');
    if (propelBtn) {
      propelBtn.disabled = true;
      propelBtn.textContent = '思考中...';
    }
    setAvatarActingState(chatId, true);

    try {
      // 获取API配置（优先使用角色独立配置；主 API 站点实时引用预设库）
      const mainApiConfig = typeof resolveApiSlotConfig === 'function'
        ? await resolveApiSlotConfig('main')
        : state.apiConfig;
      let apiConfig = mainApiConfig;
      if (chat.apiOverride && chat.apiOverride.enabled) {
        apiConfig = {
          proxyUrl: chat.apiOverride.proxyUrl || mainApiConfig.proxyUrl,
          apiKey: chat.apiOverride.apiKey || mainApiConfig.apiKey,
          model: chat.apiOverride.model || mainApiConfig.model
        };
      }

      const {
        proxyUrl,
        apiKey,
        model
      } = apiConfig;
      
      if (!proxyUrl || !apiKey || !model) {
        throw new Error('API未配置，无法生成对话。');
      }






      const maxMemory = parseInt(chat.settings.maxMemory) || 10;
      // 必须先等识图完成并落库，再读取历史快照；否则快照里仍是 pending，
      // 会丢失已生成的描述，导致重复识图、把"识图尚未完成"发给 AI。
      if (typeof ensureChatImagesVisionReady === 'function') {
        await ensureChatImagesVisionReady(chat);
      }
      const historySlice = await getRecentChatMessagesForAi(chat, maxMemory, {
        includeExcluded: false,
        includeHidden: true
      });
      const filteredHistory = await filterHistoryWithDoNotSendRules(historySlice, chatId);

      let worldBookContent = '';
      // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
      let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
      // 添加所有全局世界书
      state.worldBooks.forEach(wb => {
        if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
          allWorldBookIds.push(wb.id);
        }
      });

      if (allWorldBookIds.length > 0) {
        const linkedContents = allWorldBookIds.map(bookId => {
          const worldBook = state.worldBooks.find(wb => wb.id === bookId);
          if (!worldBook || !Array.isArray(worldBook.content)) return '';
          const formattedEntries = worldBook.content
            .filter(entry => entry.enabled !== false)
            .map(entry => {
              let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;

              entryString += `**内容:**\n${entry.content}`;
              return entryString;
            }).join('');
          return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
        }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }


      let longTermMemoryContext = '# 长期记忆 (最高优先级，这是群内已经确立的事实，所有角色必须严格遵守)\n';
      let collectedMemories = false;
      const includeUserMemoryIds = chat.settings.spectatorIncludeUserMemoryForMemberIds;
      const allowMemberMemory = (member) => !includeUserMemoryIds || includeUserMemoryIds.includes(member.id);

      // 构建用于向量检索的查询词（如果有）
      const queryTextForVector = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');

      for (const member of chat.members) {
        if (!allowMemberMemory(member)) continue;
        const memberChat = state.chats[member.id];
        if (memberChat) {
          const memMode = memberChat.settings?.memoryMode || (memberChat.settings?.enableStructuredMemory ? 'structured' : 'diary');
          // 双源注入：日记为主 + 向量为辅 (任何模式都生效)
          let memberMemContent = '';
          try {
            if (window.vectorMemoryManager) {
              memberMemContent = await window.vectorMemoryManager.buildMemoryContext(memberChat, memMode, queryTextForVector);
            } else {
              // 兜底：只用 longTermMemory
              memberMemContent = (memberChat.longTermMemory || []).map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
            }
          } catch (e) { console.warn('[双源注入] 失败:', e); }

          if (memberMemContent && memberMemContent.trim() !== '') {
            longTermMemoryContext += `\n## --- 关于"${member.groupNickname}"的记忆 ---\n`;
            longTermMemoryContext += memberMemContent;
            collectedMemories = true;
          }
        }
      }

      if (!collectedMemories) {
        longTermMemoryContext += '- (暂无)';
      }


      let linkedMemoryContext = '';
      const memoryCount = chat.settings.linkedMemoryCount || 10;
      if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {

      }

      const membersList = chat.members.map(m => `- **${m.groupNickname}** (本名: ${m.originalName}): ${m.persona}`).join('\n');
      const stickerContext = getGroupStickerContextForPrompt(chat);
      let aiAgeContext = getDynamicAgeContext(chat);
      let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

      let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('spectator') : '';
      
      const contextMap = {
        'aiAgeContext': aiAgeContext,
        'currencyExchangeContext': currencyExchangeContext,
        'char_avatar': chat.isGroup ? (chat.settings.groupAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg') : (chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'),
        'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
        'char_name': chat.originalName,
        'char_remark': chat.name,
        'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
        'user_nickname': chat.settings.myNickname || '我',
        'chat.name': chat.name,
        'longTermMemoryContext': longTermMemoryContext,
        'worldBookContent': worldBookContent,
        'linkedMemoryContext': linkedMemoryContext,
        'historySliceStr': historySlice.map(msg => `${getDisplayNameInGroup(chat, msg.senderName)}: ${msg.content}`).join('\n'),
        'membersList': membersList,
        'stickerContext': stickerContext
      };
      
      systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMap);

      systemPrompt = processPromptWithSettings(systemPrompt, 'spectator');

      // 2026-07-04 补：spectator 模式（群聊旁观者角色）也要注入热点日报
      const hotNewsContextSpectator = await getHotNewsContextForPrompt(chat);
      if (hotNewsContextSpectator) systemPrompt += '\n\n' + hotNewsContextSpectator;

      const messagesPayload = filteredHistory.map(msg => ({
        role: 'user',
        content: `${getDisplayNameInGroup(chat, msg.senderName)}: ${msg.content}`
      }));

      let isGemini = isGeminiNativeUrl(proxyUrl);
      let response;

      if (isGemini) {
        let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesPayload);
        response = await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data));
      } else {
        response = await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{
              role: 'system',
              content: systemPrompt
            }, ...messagesPayload],
            temperature: state.globalSettings.apiTemperature || 0.9,
            top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
            presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
            frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
          }),
          signal: getCurrentAiSignal()
        });
      }

      markFirstAiChunk(aiRequestState);





      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: {
            message: response.statusText
          }
        }));
        throw new Error(`API 请求失败: ${response.status} - ${errorData.error?.message || '未知错误'}`);
      }

      const data = await response.json();
      const aiResponseContent = getGeminiResponseText(data);
      lastRawAiResponse = aiResponseContent;
      const messagesArray = hookProactiveWakeInMessages(parseAiResponse(aiResponseContent), chat);






      let messageTimestamp = Date.now();
      for (const msgData of messagesArray) {

        if (!msgData || !msgData.type || !msgData.name) continue;

        // 纠正AI可能返回群昵称而非本名的问题
        if (chat.isGroup && msgData.name) {
          const exactMember = chat.members.find(m => m.originalName === msgData.name);
          if (!exactMember) {
            const nicknameMember = chat.members.find(m => m.groupNickname === msgData.name);
            if (nicknameMember) {
              msgData.name = nicknameMember.originalName;
            }
          }
        }

        let aiMessage = null;
        const currentMessageTimestamp = messageTimestamp++;
        lastResponseTimestamps.push(currentMessageTimestamp);
        const baseMessage = {
          role: 'assistant',
          senderName: msgData.name,
          timestamp: currentMessageTimestamp
        };


        switch (msgData.type) {
          case 'text':
            aiMessage = {
              ...baseMessage,
              content: msgData.content
            };
            break;
          case 'sticker':
            if (msgData.meaning) {
              const sticker = findBestStickerMatch(msgData.meaning, state.userStickers);
              if (sticker) {
                aiMessage = {
                  ...baseMessage,
                  type: 'sticker',
                  content: sticker.url,
                  meaning: sticker.name
                };
              } else {
                console.warn(`旁观模式AI尝试使用不存在的表情: "${msgData.meaning}"`);
                aiMessage = null;
              }
            } else {
              console.warn("旁观模式AI发送了一个没有 'meaning' 的 sticker 指令。", msgData);
            }
            break;
          case 'ai_image':

            aiMessage = {
              ...baseMessage,
              type: 'ai_image',
              content: msgData.description,
              image_prompt: msgData.image_prompt
            };
            break;
          case 'voice_message':

            aiMessage = {
              ...baseMessage,
              type: 'voice_message',
              content: msgData.content
            };
            break;
          case 'quote_reply':

            const originalMessage = window.messageStore
              ? await window.messageStore.getMessageByTimestamp(chat.id, msgData.target_timestamp)
              : chat.history.find(m => m.timestamp === msgData.target_timestamp);
            if (originalMessage) {
              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content,
                quote: {
                  timestamp: originalMessage.timestamp,
                  senderName: originalMessage.senderName,
                  content: String(originalMessage.content || '').substring(0, 50)
                }
              };
            } else {

              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content
              };
            }
            break;
          default:
            console.warn("旁观模式收到未知指令类型:", msgData.type);
            continue;
        }

        if (aiMessage) {
          if (window.messageStore) {
            await window.messageStore.addMessageToChat(chat, aiMessage);
          } else {
            chat.history.push(aiMessage);
          }
          appendMessage(aiMessage, chat);
          await new Promise(resolve => setTimeout(resolve, Math.random() * 1200 + 800));
        }
      }




      if (!window.messageStore) {
        await db.chats.put(chat);
      }
      renderChatList();

    } catch (error) {
      aiRequestState.errorMessage = error?.message || String(error);
      aiRuntimeLog('AI_REQUEST_ERROR', { chatId, message: aiRequestState.errorMessage });
      console.error("旁观模式推进剧情失败:", error);
      await showCustomAlert('操作失败', `无法推进剧情: ${error.message}`);
    } finally {
      cleanupAiGenerationState(aiRequestState);
      if (propelBtn) {
        propelBtn.disabled = false;
        propelBtn.textContent = '🎬 推进剧情';
      }
      setAvatarActingState(chatId, false);
    }
  }

  async function triggerAiResponse() {
    installStopGenerationHandler();
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const chat = state.chats[state.activeChatId];
    if (window.chatStuckStateRepair && typeof window.chatStuckStateRepair.ensureCurrentChatNotStuck === 'function') {
      const ok = await window.chatStuckStateRepair.ensureCurrentChatNotStuck();
      if (!ok) {
        try { await showCustomAlert('对话修复', '检测到未完成的生成状态，已尝试修复，请重试。'); } catch (e) {}
        return;
      }
    }
    const aiRequestState = beginAiGenerationRequest(chatId);

    const isViewingThisChat = document.getElementById('chat-interface-screen').classList.contains('active') && state.activeChatId === chatId;

    setAvatarActingState(chatId, true);
    const chatHeaderTitle = document.getElementById('chat-header-title');
    const typingIndicator = document.getElementById('typing-indicator');

    const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    const avatarInList = chatListItem ? chatListItem.querySelector('.avatar') : null;
    if (avatarInList) {
      avatarInList.classList.add('is-acting');
    }

    if (chat.isGroup) {
      if (typingIndicator) {
        typingIndicator.textContent = '成员们正在输入...';
        typingIndicator.style.display = 'block';
      }
    } else {
      if (chatHeaderTitle) {
        chatHeaderTitle.style.opacity = 0;
        setTimeout(() => {
          chatHeaderTitle.textContent = '对方正在输入...';
          chatHeaderTitle.classList.add('typing-status');
          chatHeaderTitle.style.opacity = 1;
        }, 200);
      }
    }
    let needsImmediateReaction = false;
    try {
      // 获取API配置（优先使用角色独立配置；主 API 站点实时引用预设库）
      const mainApiConfig = typeof resolveApiSlotConfig === 'function'
        ? await resolveApiSlotConfig('main')
        : state.apiConfig;
      let apiConfig = mainApiConfig;
      if (chat.apiOverride && chat.apiOverride.enabled) {
        apiConfig = {
          proxyUrl: chat.apiOverride.proxyUrl || mainApiConfig.proxyUrl,
          apiKey: chat.apiOverride.apiKey || mainApiConfig.apiKey,
          model: chat.apiOverride.model || mainApiConfig.model
        };
      }

      const {
        proxyUrl,
        apiKey,
        model
      } = apiConfig;
      
      if (!proxyUrl || !apiKey || !model) {
        alert('请先在API设置中配置反代地址、密钥并选择模型。');
        if (chat.isGroup) {
          if (typingIndicator) typingIndicator.style.display = 'none';
        } else {
          if (chatHeaderTitle && state.chats[chatId]) {
            chatHeaderTitle.textContent = state.chats[chatId].name;
            chatHeaderTitle.classList.remove('typing-status');
          }
        }
        return;
      }

      const lastMessage = await getLatestChatMessageForAi(chat, {
        includeExcluded: true,
        includeHidden: true
      });
      const imageProviderRoute = getCurrentEnabledImageProvider();

      const isVideoCallRequest = lastMessage && lastMessage.role === 'system' && lastMessage.content.includes('视频通话请求');
      const isVoiceCallRequest = lastMessage && lastMessage.role === 'system' && lastMessage.content.includes('语音通话请求');

      if (isVideoCallRequest) {
        console.log(`检测到视频通话请求，为角色 "${chat.name}" 触发专属决策流程...`);

        let callDecisionPrompt;
        if (chat.isGroup) {
          callDecisionPrompt = `
        # 你的任务
        群聊中的用户刚刚发起了群视频通话。请你分别扮演【每一个群成员】，根据他们各自的人设和与用户的关系，来决定是加入(join)还是拒绝(decline)。
        # 核心规则
        - 你的回复【必须】是一个JSON数组，为【每一个AI角色】都包含一个决策对象。
        - 格式: '[{"type": "group_call_response", "name": "角色A的本名", "decision": "join"}, {"type": "group_call_response", "name": "角色B的本名", "decision": "decline"}]'
        # 群成员列表及人设
        ${chat.members.map(m => `- ${m.groupNickname} (本名: ${m.originalName}): ${m.persona}`).join('\n')}
        现在，请为所有AI角色做出决策。`;
        } else {
          callDecisionPrompt = `
        # 你的任务
        用户刚刚向你发起了视频通话。请根据你的角色设定，决定是“接受”还是“拒绝”。
        # 你的角色设定
        ${chat.settings.aiPersona}
        # 核心规则
        你的回复【必须且只能】是以下两种格式之一的JSON数组，绝对不能回复任何其他内容：
        - 接受: '[{"type": "video_call_response", "decision": "accept"}]'
        - 拒绝: '[{"type": "video_call_response", "decision": "reject"}]'
        现在，请立即做出决策。`;
        }

        const messagesForCallDecision = [{
          role: 'user',
          content: callDecisionPrompt
        }];

        try {
          let geminiConfig = toGeminiRequestData(model, apiKey, callDecisionPrompt, messagesForCallDecision);
          let isGemini = isGeminiNativeUrl(proxyUrl);
          // 判断是否使用后端代理
          const useMainApiProxy = !isGemini
            && typeof window.fetchViaOpenAICompatibleProxy === 'function'
            && typeof window.isMainApiProxyEnabled === 'function'
            && window.isMainApiProxyEnabled();

          const callDecisionPayload = {
            model: model,
            messages: messagesForCallDecision,
            temperature: 0.7
          };

          const response = isGemini
            ? await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data))
            : useMainApiProxy
              ? await window.fetchViaOpenAICompatibleProxy({
                baseUrl: proxyUrl,
                targetPath: '/chat/completions',
                apiKey,
                payload: callDecisionPayload,
                method: 'POST',
                signal: getCurrentAiSignal()
              })
              : await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(callDecisionPayload),
                signal: getCurrentAiSignal()
              });

          markFirstAiChunk(aiRequestState);

          if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try { const errData = await response.json(); errMsg = errData?.error?.message || errData?.message || errData?.detail || JSON.stringify(errData); } catch(e) { errMsg += ` (${response.statusText})`; }
            throw new Error(`API失败: ${errMsg}`);
          }

          const data = await response.json();
          const aiResponseContent = getGeminiResponseText(data);
          const responseArray = hookProactiveWakeInMessages(parseAiResponse(aiResponseContent), chat);


          let callHasBeenHandled = false;
          for (const msgData of responseArray) {
            if (msgData.type === 'video_call_response') {
              videoCallState.isAwaitingResponse = false;
              if (msgData.decision === 'accept') {
                startVideoCall();
              } else {
                const aiMessage = {
                  role: 'assistant',
                  content: '对方拒绝了你的视频通话请求。',
                  timestamp: Date.now()
                };
                chat.history.push(aiMessage);
                await db.chats.put(chat);
                showScreen('chat-interface-screen');
                renderChatInterface(chatId);
              }
              callHasBeenHandled = true;
              break;
            }
            if (msgData.type === 'group_call_response') {
              if (msgData.decision === 'join') {
                const member = chat.members.find(m => m.originalName === msgData.name);
                if (member && !videoCallState.participants.some(p => p.id === member.id)) {
                  videoCallState.participants.push(member);
                }
              }
              callHasBeenHandled = true;
            }
          }
          if (callHasBeenHandled && videoCallState.isGroupCall) {
            videoCallState.isAwaitingResponse = false;
            if (videoCallState.participants.length > 0) {
              startVideoCall();
            } else {
              videoCallState = {
                ...videoCallState,
                isAwaitingResponse: false,
                participants: []
              };
              showScreen('chat-interface-screen');
              alert('无人接听群聊邀请。');
            }
          }

        } catch (error) {
          console.error("处理通话请求时API出错:", error);
          const fallbackResponse = chat.isGroup ?
            chat.members.map(m => ({
              type: "group_call_response",
              name: m.originalName,
              decision: "decline"
            })) : [{
              type: "video_call_response",
              decision: "reject"
            }];

          if (chat.isGroup) {
            videoCallState.isAwaitingResponse = false;
            videoCallState.participants = [];
            alert('无人接听群聊邀请。');
            showScreen('chat-interface-screen');
          } else {
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的视频通话请求。',
              timestamp: Date.now()
            };
            chat.history.push(aiMessage);
            await db.chats.put(chat);
            // 确保 videoCallState 被清理，避免后续消息仍然被当作通话流程处理
            videoCallState.isAwaitingResponse = false;
            videoCallState.activeChatId = null;
            videoCallState.callRequester = null;
            videoCallState.participants = videoCallState.participants || [];
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
        } finally {

          setAvatarActingState(chatId, false);
          return;
        }
      }

      if (isVoiceCallRequest) {
        console.log(`检测到语音通话请求，为角色 "${chat.name}" 触发专属决策流程...`);

        let callDecisionPrompt;
        if (chat.isGroup) {
          callDecisionPrompt = `
        # 你的任务
        群聊中的用户刚刚发起了群语音通话。请你分别扮演【每一个群成员】，根据他们各自的人设和与用户的关系，来决定是加入(join)还是拒绝(decline)。
        # 核心规则
        - 你的回复【必须】是一个JSON数组，为【每一个AI角色】都包含一个决策对象。
        - 格式: '[{"type": "group_voice_response", "name": "角色A的本名", "decision": "join"}, {"type": "group_voice_response", "name": "角色B的本名", "decision": "decline"}]'
        # 群成员列表及人设
        ${chat.members.map(m => `- ${m.groupNickname} (本名: ${m.originalName}): ${m.persona}`).join('\n')}
        现在，请为所有AI角色做出决策。`;
        } else {
          callDecisionPrompt = `
        # 你的任务
        用户刚刚向你发起了语音通话。请根据你的角色设定，决定是"接受"还是"拒绝"。
        # 你的角色设定
        ${chat.settings.aiPersona}
        # 核心规则
        你的回复【必须且只能】是以下两种格式之一的JSON数组，绝对不能回复任何其他内容：
        - 接受: '[{"type": "voice_call_response", "decision": "accept"}]'
        - 拒绝: '[{"type": "voice_call_response", "decision": "reject"}]'
        现在，请立即做出决策。`;
        }

        const messagesForCallDecision = [{
          role: 'user',
          content: callDecisionPrompt
        }];

        try {
          let geminiConfig = toGeminiRequestData(model, apiKey, callDecisionPrompt, messagesForCallDecision);
          let isGemini = isGeminiNativeUrl(proxyUrl);
          // 判断是否使用后端代理
          const useMainApiProxy = !isGemini
            && typeof window.fetchViaOpenAICompatibleProxy === 'function'
            && typeof window.isMainApiProxyEnabled === 'function'
            && window.isMainApiProxyEnabled();

          const callDecisionPayload = {
            model: model,
            messages: messagesForCallDecision,
            temperature: 0.7
          };

          const response = isGemini
            ? await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data))
            : useMainApiProxy
              ? await window.fetchViaOpenAICompatibleProxy({
                baseUrl: proxyUrl,
                targetPath: '/chat/completions',
                apiKey,
                payload: callDecisionPayload,
                method: 'POST',
                signal: getCurrentAiSignal()
              })
              : await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(callDecisionPayload),
                signal: getCurrentAiSignal()
              });

          markFirstAiChunk(aiRequestState);

          if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try { const errData = await response.json(); errMsg = errData?.error?.message || errData?.message || errData?.detail || JSON.stringify(errData); } catch(e) { errMsg += ` (${response.statusText})`; }
            throw new Error(`API失败: ${errMsg}`);
          }

          const data = await response.json();
          const aiResponseContent = getGeminiResponseText(data);

          const jsonMatch = aiResponseContent.match(/(\[[\s\S]*?\])/);
          if (!jsonMatch) throw new Error("AI返回的决策中未找到有效的JSON数组。");

          const responseArray = JSON.parse(jsonMatch[0]);
          let callHasBeenHandled = false;

          for (const msgData of responseArray) {
            if (!msgData || typeof msgData !== 'object') {
              console.warn("收到了格式不规范的AI指令，已跳过:", msgData);
              continue;
            }
            if (!msgData.type) {
              if (chat.isGroup && msgData.name && msgData.message) {
                msgData.type = 'text';
              } else if (msgData.content) {
                msgData.type = 'text';
              } else {
                console.warn("收到了格式不规范的AI指令（缺少type和content），已跳过:", msgData);
                continue;
              }
            }

            if (msgData.type === 'voice_call_response') {
              voiceCallState.isAwaitingResponse = false;
              if (msgData.decision === 'accept') {
                startVoiceCall();
              } else {
                Object.assign(voiceCallState, {
                  isActive: false,
                  isAwaitingResponse: false,
                  isGroupCall: false,
                  activeChatId: null,
                  initiator: null,
                  startTime: null,
                  participants: [],
                  isUserParticipating: true,
                  callHistory: [],
                  preCallContext: ""
                });
                const aiMessage = {
                  role: 'assistant',
                  content: '对方拒绝了你的语音通话请求。',
                  timestamp: Date.now()
                };
                if (window.messageStore) {
                  await window.messageStore.addMessageToChat(chat, aiMessage);
                } else {
                  chat.history.push(aiMessage);
                  await db.chats.put(chat);
                }
                showScreen('chat-interface-screen');
                renderChatInterface(chatId);
              }
              callHasBeenHandled = true;
              break;
            }

            if (msgData.type === 'group_voice_response') {
              if (msgData.decision === 'join') {
                const member = chat.members.find(m => m.originalName === msgData.name);
                if (member && !voiceCallState.participants.some(p => p.id === member.id)) {
                  voiceCallState.participants.push(member);
                }
              }
              callHasBeenHandled = true;
            }
          }
          if (callHasBeenHandled && voiceCallState.isGroupCall) {
            voiceCallState.isAwaitingResponse = false;
            if (voiceCallState.participants.length > 0) {
              startVoiceCall();
            } else {
              Object.assign(voiceCallState, {
                isActive: false,
                isAwaitingResponse: false,
                isGroupCall: false,
                activeChatId: null,
                initiator: null,
                startTime: null,
                participants: [],
                isUserParticipating: true,
                callHistory: [],
                preCallContext: ""
              });
              showScreen('chat-interface-screen');
              alert('无人接听群聊邀请。');
            }
          }

        } catch (error) {
          console.error("处理语音通话请求时API出错:", error);

          if (chat.isGroup) {
            Object.assign(voiceCallState, {
              isActive: false,
              isAwaitingResponse: false,
              isGroupCall: false,
              activeChatId: null,
              initiator: null,
              startTime: null,
              participants: [],
              isUserParticipating: true,
              callHistory: [],
              preCallContext: ""
            });
            alert('无人接听群聊邀请。');
            showScreen('chat-interface-screen');
          } else {
            Object.assign(voiceCallState, {
              isActive: false,
              isAwaitingResponse: false,
              isGroupCall: false,
              activeChatId: null,
              initiator: null,
              startTime: null,
              participants: [],
              isUserParticipating: true,
              callHistory: [],
              preCallContext: ""
            });
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的语音通话请求。',
              timestamp: Date.now()
            };
            if (window.messageStore) {
              await window.messageStore.addMessageToChat(chat, aiMessage);
            } else {
              chat.history.push(aiMessage);
              await db.chats.put(chat);
            }
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
        } finally {
          setAvatarActingState(chatId, false);
          return;
        }
      }




      if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
        console.log(`为角色 "${chat.name}" 触发带理由的好友申请决策流程...`);
        const contextSummary = await buildVisibleContextSummary(chat, -10, -5);


        const decisionPrompt = `
        # 你的任务
        你现在是角色“${chat.name}”。用户之前被你拉黑了，现在TA向你发送了好友申请，希望和好。
        # 供你决策的上下文信息:
        - **你的角色设定**: ${chat.settings.aiPersona}
        - **用户发送的申请理由**: “${chat.relationship.applicationReason}”
        - **被拉黑前的最后对话摘要**: 
        ${contextSummary || "（无有效对话记录）"}
        # 你的唯一指令
        根据以上所有信息，你【必须】做出决定，并给出符合你人设的理由。你的回复【必须且只能】是一个JSON对象，格式如下:
        {"decision": "accept", "reason": "（在这里写下你同意的理由，比如：好吧，看在你这么真诚的份上，这次就原谅你啦。）"}
        或
        {"decision": "reject", "reason": "（在这里写下你拒绝的理由，比如：抱歉，我还没准备好，再给我一点时间吧。）"}
        `;

        try {

          const messagesForDecision = [{
            role: 'system',
            content: decisionPrompt
          },
          {
            role: 'user',
            content: "请根据以上设定，立即做出你的决定。"
          }
          ];

          let isGemini = isGeminiNativeUrl(proxyUrl);
          let geminiConfig = toGeminiRequestData(model, apiKey, decisionPrompt, [{
            role: 'user',
            content: "请根据以上设定，立即做出你的决定。"
          }]);

          const response = isGemini ?
            await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data)) :
            await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: model,
                messages: messagesForDecision,
                temperature: state.globalSettings.apiTemperature || 0.8,
                top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
                presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
                frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
              }),
              signal: getCurrentAiSignal()
            });

          markFirstAiChunk(aiRequestState);

          if (!response.ok) {
            throw new Error(`API失败: ${(await response.json()).error.message}`);
          }
          const data = await response.json();

          const rawContent = getGeminiResponseText(data).replace(/^```json\s*/, '').replace(/```$/, '').trim();
          const decisionObj = JSON.parse(rawContent);


          if (decisionObj.decision === 'accept') {
            chat.relationship.status = 'friend';
            const acceptMessage = {
              role: 'assistant',
              senderName: chat.name,
              content: decisionObj.reason,
              timestamp: Date.now()
            };
            if (window.messageStore) {
              await window.messageStore.addMessageToChat(chat, acceptMessage);
            } else {
              chat.history.push(acceptMessage);
            }
          } else {
            chat.relationship.status = 'blocked_by_ai';
            const rejectMessage = {
              role: 'assistant',
              senderName: chat.name,
              content: decisionObj.reason,
              timestamp: Date.now()
            };
            if (window.messageStore) {
              await window.messageStore.addMessageToChat(chat, rejectMessage);
            } else {
              chat.history.push(rejectMessage);
            }
          }
          chat.relationship.applicationReason = '';

          await db.chats.put(chat);
          renderChatInterface(chatId);
          renderChatList();
        } catch (error) {

          chat.relationship.status = 'blocked_by_ai';
          await db.chats.put(chat);
          await showCustomAlert('申请失败', `AI在处理你的好友申请时出错了，请稍后重试。\n错误信息: ${error.message}`);
          renderChatInterface(chatId);
        }
        return;
      }




      let callTranscriptContext = '';
      const now = new Date();

      // 判断是否使用自定义时间
      let currentTime, localizedDate, timeOfDayGreeting;
      const customTimeInfo = window.getCustomTime ? window.getCustomTime() : null;
      const customTimeEnabled = customTimeInfo && customTimeInfo.enabled;
      
      if (customTimeEnabled) {
        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekDay = weekDays[customTimeInfo.date.getDay()];
        currentTime = `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
        localizedDate = customTimeInfo.date;
      } else {
        // 使用时间感知（真实时间+时区）
        const selectedTimeZone = chat.settings.timeZone || 'Asia/Shanghai';
        currentTime = now.toLocaleString('zh-CN', {
          timeZone: selectedTimeZone,
          dateStyle: 'full',
          timeStyle: 'short'
        });
        localizedDate = new Date(now.toLocaleString('en-US', {
          timeZone: selectedTimeZone
        }));
      }
      
      timeOfDayGreeting = getTimeOfDayGreeting(localizedDate);
      let systemPrompt, messagesPayload;
      const lastHiddenMessage = await getLatestHiddenChatMessageForAi(chat);
      if (lastHiddenMessage && (lastHiddenMessage.content.includes('视频通话刚刚结束') || lastHiddenMessage.content.includes('语音通话刚刚结束'))) {
        const lastCallRecord = await db.callRecords
          .where('chatId')
          .equals(chatId)
          .last();

        if (lastCallRecord && lastCallRecord.transcript) {
          console.log("检测到刚结束的通话，正在注入通话记录上下文...");
          const transcriptText = lastCallRecord.transcript.map(h => {
            const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : h.senderName;
            return `${sender}: ${h.content}`;
          }).join('\n');

          const callTypeText = lastCallRecord.callType === 'voice' ? '语音通话' : '视频通话';
          callTranscriptContext = `
# 刚刚结束的通话记录 (最高优先级参考)
你和用户刚刚结束了一场${callTypeText}，以下是完整的通话文字记录。你接下来的回复【必须】与这次通话的内容紧密相关。
---
${transcriptText}
---
`;
        }
      }


      let worldBookContent = '';
      // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
      let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
      // 添加所有全局世界书
      state.worldBooks.forEach(wb => {
        if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
          allWorldBookIds.push(wb.id);
        }
      });

      if (allWorldBookIds.length > 0) {
        const linkedContents = allWorldBookIds.map(bookId => {
          const worldBook = state.worldBooks.find(wb => wb.id === bookId);
          if (!worldBook || !Array.isArray(worldBook.content)) return '';


          const formattedEntries = worldBook.content
            .filter(entry => entry.enabled !== false)
            .map(entry => {
              let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;

              entryString += `**内容:**\n${entry.content}`;
              return entryString;
            }).join('');

          return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
        }).filter(Boolean).join('');

        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的“物理法则”和“基础常识”。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }


      let musicContext = '';
      if (musicState.isActive && musicState.activeChatId === chatId) {
        const currentTrack = musicState.currentIndex > -1 ? musicState.playlist[musicState.currentIndex] : null;
        const playlistInfo = musicState.playlist.map(t => `"${t.name}"`).join(', ');


        let lyricsContext = "";


        if (currentTrack && musicState.parsedLyrics && musicState.parsedLyrics.length > 0 && musicState.currentLyricIndex > -1) {
          const currentLine = musicState.parsedLyrics[musicState.currentLyricIndex];

          const upcomingLines = musicState.parsedLyrics.slice(musicState.currentLyricIndex + 1, musicState.currentLyricIndex + 3);


          lyricsContext += `- **当前歌词**: "${currentLine.text}"\n`;
          if (upcomingLines.length > 0) {
            lyricsContext += `- **即将演唱**: ${upcomingLines.map(line => `"${line.text}"`).join(' / ')}\n`;
          }
        }

        // 【0.0.37 新增】扩展元数据: 专辑 / 发行时间 / 时长 / 歌手列表
        // 这些字段对网易云真实源 (source === 'netease_real') 才有, 其他源会自动跳过
        let trackMetaContext = '';
        if (currentTrack) {
          const metaBits = [];
          // 专辑
          if (currentTrack.album) {
            const albumBit = currentTrack.albumId
              ? `《${currentTrack.album}》(ID: ${currentTrack.albumId})`
              : `《${currentTrack.album}》`;
            metaBits.push(`专辑: ${albumBit}`);
          }
          // 歌手列表 (如果有 artists 数组, 比单字符串更精确)
          if (Array.isArray(currentTrack.artists) && currentTrack.artists.length > 1) {
            const artistList = currentTrack.artists.map(a => `${a.name}(ID: ${a.id})`).join('、');
            metaBits.push(`参与歌手: ${artistList}`);
          } else if (Array.isArray(currentTrack.artists) && currentTrack.artists.length === 1) {
            // 单歌手不重复显示 (避免跟 artist 字段重复)
          }
          // 发行时间 (毫秒时间戳 -> 年份)
          if (currentTrack.publishTime && currentTrack.publishTime > 0) {
            const year = new Date(currentTrack.publishTime).getFullYear();
            const now = new Date().getFullYear();
            const age = now - year;
            if (year > 1900 && year <= now) {
              metaBits.push(age > 0
                ? `发行: ${year} 年 (${age} 年前)`
                : `发行: ${year} 年`);
            }
          }
          // 时长 (ms -> 分:秒)
          if (currentTrack.duration && currentTrack.duration > 0) {
            const totalSec = Math.round(currentTrack.duration / 1000);
            const min = Math.floor(totalSec / 60);
            const sec = String(totalSec % 60).padStart(2, '0');
            metaBits.push(`时长: ${min}:${sec}`);
          }
          // 音质 (网易云源)
          const qualityLabels = {
            'standard': '标准', 'exhigh': '极高', 'lossless': '无损',
            'hires': 'Hi-Res', 'jymaster': '母带', 'sky': '全景声',
            'dolby': '杜比', 'jyeffect': '空间音效'
          };
          if (currentTrack.quality && qualityLabels[currentTrack.quality]) {
            metaBits.push(`音质: ${qualityLabels[currentTrack.quality]}`);
          }
          if (metaBits.length > 0) {
            trackMetaContext = `-   **歌曲详情**: ${metaBits.join(' | ')}\n`;
          }
        }


        musicContext = `\n\n# 当前音乐情景
        -   **当前状态**: 你们正在和用户一起听歌。
        -   **正在播放**: ${currentTrack ? `《${currentTrack.name}》 - ${currentTrack.artist}` : '无'}
        ${trackMetaContext}-   **可用播放列表**: [${playlistInfo}]
        ${lyricsContext}
        ${chat.settings.enableMusicTimeAwareness ? `-   **累计一起听歌时长**: 你们历史以来已经累计一起听了 ${(musicState.totalElapsedTime / 3600).toFixed(1)} 小时的歌` : ''}
        -   **你的任务**: 你可以根据对话内容和氛围，使用 "change_music" 指令切换到播放列表中的任何一首歌，以增强互动体验。${trackMetaContext ? ' 你可以引用歌曲的专辑、发行年份、歌手等元数据来让对话更有"懂行"的感觉。' : ''}
        `;
      }

      // 【2026-07-04 新增】AI 音乐工具说明 ——
      // 移到 musicContext if 块外，让 AI 在 session 没启动时也知道有 add_song_to_playlist 工具
      // （add_song_to_playlist 内部会自动启动一起听 session）
      const musicToolsContext = `
        # 你的音乐能力
        你有两个音乐工具：
        1. **change_music** - 切到 playlist 里已有的歌
           { "type": "music_action", "action": "change_music", "song_name": "歌名" }
           适用：playlist 已有歌，用户想切到另一首
        2. **add_song_to_playlist** - 全网易云搜歌 + 加 playlist + 自动播放 + 自动启动一起听
           { "type": "music_action", "action": "add_song_to_playlist", "keyword": "搜索词（歌名/歌手/歌词）", "level": "exhigh" }
           - keyword: 你想找的歌（如"晴天 周杰伦"、"适合下雨天的歌"）
           - level: standard / exhigh / lossless / hires / jymaster（默认 exhigh）
           适用场景：
           - 用户说"给我放首歌" / "放一首xxx" / "听xxx"
           - 你觉得对话氛围合适，主动推荐（如"这首我很喜欢，给你放一首类似的"）
           - playlist 为空时用它
        注意：add_song_to_playlist 会**自动播放 + 自动启动一起听**（不需要再发 change_music）。
        3. **request_song** - 主动给用户唱一首歌（默认走 Cover 模式——用你的专属音色；角色没上传音色样本时自动降级到普通模式）
           { "type": "request_song", "title": "歌名", "prompt": "风格描述", "lyrics": "[Verse]...\\n[Chorus]...", "useVoiceSample": true, "instrumental": false }
           - title: 你给这首歌起的名字（必填，会显示在聊天流）
           - prompt: 风格/情绪/场景描述（如 "温柔民谣，吉他伴奏，温暖治愈"，必填）
           - lyrics: 完整歌词（带 [Verse]/[Chorus]/[Bridge] 等结构标签）。传 "" 或省略 → AI 自动写词
           - useVoiceSample: 是否用你的专属音色样本（Cover 模式，default true；系统会自动检测是否上传了样本——如果上传了就用 Cover 模式唱你的声音，没上传就降级到普通模式）
           - instrumental: 是否纯音乐（default false）
           适用场景：用户说"给我唱首歌" / "唱一首关于X的歌" / 你觉得氛围合适主动唱一首
        ⚠️ 重要：你唱的歌默认是**你自己的声音**（Cover 模式）。**几乎所有情况下 useVoiceSample 留 true 即可**。除非用户明确要求"用别的声音唱"（极罕见），才传 false。
        注意：request_song 只在单聊可用，调用会自动播放 + 推一条 "AI 为你唱了《XX》" 的消息到聊天流。
        `;
      // 把工具说明附加到 musicContext（如果 musicContext 是空的，工具说明仍然会被附加）
      musicContext = (musicContext || '') + musicToolsContext;


      const maxMemory = getShortMemoryCount(chat);
      // 必须先等识图完成并落库，再读取历史快照；否则快照里仍是 pending，
      // 会丢失已生成的描述，导致重复识图、把"识图尚未完成"发给 AI。
      if (typeof ensureChatImagesVisionReady === 'function') {
        await ensureChatImagesVisionReady(chat);
      }
      const historySlice = await getRecentChatMessagesForAi(chat, maxMemory, {
        includeExcluded: false,
        includeHidden: true
      });
      const filteredHistory = await filterHistoryWithDoNotSendRules(historySlice, chatId);
      console.log('[AI上下文] chatId:', chatId);
      console.log('[AI上下文] 短期记忆数:', maxMemory);
      console.log('[AI上下文] 实际加载消息数:', historySlice.length);
      console.log('[AI上下文] 是否仍访问chat.history:', Array.isArray(chat?.history), chat?.history?.length);
      let sharedContext = '';
      const recentVisibleHistory = historySlice.filter(msg => !msg.isHidden);
      const lastAiTurnIndex = recentVisibleHistory.findLastIndex(msg => msg.role === 'assistant');
      const recentUserMessages = recentVisibleHistory.slice(lastAiTurnIndex + 1);
      const shareCardMessage = recentUserMessages.find(msg => msg.type === 'share_card');
      if (shareCardMessage) {
        const payload = shareCardMessage.payload;
        const formattedHistory = payload.sharedHistory.map(msg => {
          const sender = msg.senderName || (msg.role === 'user' ? (chat.settings.myNickname || '我') : '未知发送者');
          let contentText = '';
          if (msg.type === 'voice_message') contentText = `[语音消息: ${msg.content}]`;
          else if (msg.type === 'ai_image') contentText = `[图片: ${msg.description}]`;
          else if (msg.type === 'naiimag') contentText = `[NovelAI图片: ${msg.prompt}]`;
          else if (msg.type === 'googleimag') contentText = `[Google Imagen图片: ${msg.prompt}]`;
          else contentText = String(msg.content);
          return `${sender}: ${contentText}`;
        }).join('\n');
        sharedContext = `
        # 附加上下文：一段分享的聊天记录
        - 重要提示：这不是你和当前用户的对话，而是用户从【另一场】与“${payload.sourceChatName}”的对话中分享过来的。
        - 你的任务：请你阅读并理解下面的对话内容。在接下来的回复中，你可以像真人一样，对这段对话的内容自然地发表你的看法、感受或疑问。
        ---
        [分享的聊天记录开始]
        ${formattedHistory}
        [分享的聊天记录结束]
        ---
        `;
      }

      let linkedMemoryContext = '';
      const memoryCount = chat.settings.linkedMemoryCount || 10;

      if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {

        const idsToMount = chat.settings.linkedMemoryChatIds.filter(id => id !== chatId);

        if (idsToMount.length > 0) {
          const linkedChatsWithTimestamps = idsToMount.map(id => {
            const linkedChat = state.chats[id];
            if (!linkedChat) return null;
            return {
              chat: linkedChat,
              latestTimestamp: linkedChat.lastMessageTimestamp || 0
            };
          }).filter(Boolean);

          linkedChatsWithTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

          linkedMemoryContext += `\n\n# 参考记忆 (至关重要！你必须【主动】将这些参考记忆中的【关键信息和事件】，自然地融入到当前的对话中，以体现你拥有完整的记忆。不要只是被动等待用户提问！)\n`;

          for (const item of linkedChatsWithTimestamps) {
            const linkedChat = item.chat;
            const prefix = linkedChat.isGroup ? '[群聊]' : '[私聊]';
            const timeAgo = item.latestTimestamp > 0 ? ` (最后互动于 ${formatTimeAgo(item.latestTimestamp)})` : '';
            linkedMemoryContext += `\n## --- 来自${prefix}“${linkedChat.name}”的参考记忆${timeAgo} ---\n`;

            const linkedRecentHistory = await getRecentChatMessagesForAi(linkedChat, memoryCount, {
              includeExcluded: true,
              includeHidden: true
            });
            const filteredHistory = linkedRecentHistory.filter(msg => !String(msg.content).includes('已被用户删除'));

            if (filteredHistory.length > 0) {
              filteredHistory.forEach(msg => {

                const sender = msg.role === 'user' ? (linkedChat.settings.myNickname || '我') : (getDisplayNameInGroup(linkedChat, msg.senderName) || linkedChat.name);

                let prefix = "";

                if (msg.quote && msg.quote.content) {

                  const quotedSenderDisplayName = getDisplayNameInGroup(linkedChat, msg.quote.senderName);
                  let quoteContentPreview = String(msg.quote.content).substring(0, 30);
                  if (quoteContentPreview.length === 30) quoteContentPreview += "...";

                  prefix = `[回复 ${quotedSenderDisplayName}: "${quoteContentPreview}"] `;
                }

                let contentText = '';

                if (msg.type === 'ai_image' || msg.type === 'user_photo') {
                  contentText = `[发送了一张图片，描述为：${msg.content}]`;
                } else if (msg.type === 'voice_message') {
                  contentText = `[发送了一条语音，内容是：${msg.content}]`;
                } else if (msg.type === 'sticker') {
                  contentText = `[表情: ${msg.meaning || 'sticker'}]`;
                } else if (msg.type === 'transfer') {
                  contentText = `[转账: ${msg.amount}元]`;
                } else if (Array.isArray(msg.content)) {
                  contentText = `[图片]`;
                } else {
                  contentText = String(msg.content);
                }

                const timeAgoForMsg = formatTimeAgo(msg.timestamp);

                linkedMemoryContext += `(${timeAgoForMsg}) ${sender}: ${prefix}${contentText}\n`;
              });
            } else {
              linkedMemoryContext += "(暂无有效聊天记录)\n";
            }
          }
        }
      }

      console.log("本次发送给AI的【挂载记忆】内容如下：\n", linkedMemoryContext);

      if (chat.isGroup) {


        let linkedMemoryContext = '';
        const memoryCount = chat.settings.linkedMemoryCount || 10;
        if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {
          const idsToMount = chat.settings.linkedMemoryChatIds.filter(id => id !== chatId);
          if (idsToMount.length > 0) {
            const linkedChatsWithTimestamps = idsToMount.map(id => {
              const linkedChat = state.chats[id];
              if (!linkedChat) return null;
              return {
                chat: linkedChat,
                latestTimestamp: linkedChat.lastMessageTimestamp || 0
              };
            }).filter(Boolean);
            linkedChatsWithTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
            linkedMemoryContext += `\n\n# 参考记忆 (至关重要！群内角色必须【主动】将这些参考记忆中的【关键信息和事件】，自然地融入到当前的对话中，以体现你们拥有完整的共同记忆。)\n`;
            for (const item of linkedChatsWithTimestamps) {
              const linkedChat = item.chat;
              const prefix = linkedChat.isGroup ? '[群聊]' : '[私聊]';
              const timeAgo = item.latestTimestamp > 0 ? ` (最后互动于 ${formatTimeAgo(item.latestTimestamp)})` : '';
              linkedMemoryContext += `\n## --- 来自${prefix}“${linkedChat.name}”的参考记忆${timeAgo} ---\n`;
              const linkedRecentHistory = await getRecentChatMessagesForAi(linkedChat, memoryCount, {
                includeExcluded: true,
                includeHidden: true
              });
              const filteredHistory = linkedRecentHistory.filter(msg => !String(msg.content).includes('已被用户删除'));
              if (filteredHistory.length > 0) {
                filteredHistory.forEach(msg => {
                  const sender = msg.role === 'user' ? (linkedChat.settings.myNickname || '我') : (msg.senderName || linkedChat.name);
                  let contentText = String(msg.content);
                  if (msg.type === 'ai_image' || msg.type === 'user_photo') {
                    contentText = `[发送了一张图片，描述为：${msg.content}]`;
                  } else if (msg.type === 'voice_message') {
                    contentText = `[发送了一条语音，内容是：${msg.content}]`;
                  }
                  linkedMemoryContext += `${sender}: ${contentText}\n`;
                });
              } else {
                linkedMemoryContext += "(暂无有效聊天记录)\n";
              }
            }
          }
        }


        let longTermMemoryContext = '# 长期记忆 (最高优先级，这是群内已经确立的事实，所有角色必须严格遵守)\n';
        let collectedMemories = false;

        // 构建用于向量检索的查询词（如果有）
        const queryTextForVector = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');

        for (const member of chat.members) {
          const memberChat = state.chats[member.id];
          if (memberChat) {
          const memMode = memberChat.settings?.memoryMode || (memberChat.settings?.enableStructuredMemory ? 'structured' : 'diary');
          // 双源注入：日记为主 + 向量为辅 (任何模式都生效)
          let memberMemContent = '';
          try {
            if (window.vectorMemoryManager) {
              memberMemContent = await window.vectorMemoryManager.buildMemoryContext(memberChat, memMode, queryTextForVector);
            } else {
              memberMemContent = (memberChat.longTermMemory || []).map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
            }
          } catch (e) { console.warn('[双源注入] 失败:', e); }

            if (memberMemContent && memberMemContent.trim() !== '') {
              longTermMemoryContext += `\n## --- 关于“${member.groupNickname}”的记忆 ---\n`;
              longTermMemoryContext += memberMemContent;
              collectedMemories = true;
            }
          }
        }

        if (!collectedMemories) {
          longTermMemoryContext += '- (暂无)';
        }


        let timeContextText = '';
        let longTimeNoSee = false;

        if (chat.settings.enableTimePerception) {

          const lastUserMsg = historySlice.findLast(msg => msg.role === 'user' && !msg.isHidden);

          const lastAiMsg = historySlice.findLast(msg => msg.role === 'assistant' && !msg.isHidden);

          if (lastUserMsg && lastAiMsg) {
            const lastUserMessageTime = formatTimestampForAI(lastUserMsg.timestamp);
            const lastAiMessageTime = formatTimestampForAI(lastAiMsg.timestamp);
            timeContextText = `上一条消息发送于 ${lastAiMessageTime}，用户刚刚在 ${lastUserMessageTime} 回复了。`;


            const timeDiffHours = (lastUserMsg.timestamp - lastAiMsg.timestamp) / (1000 * 60 * 60);
            if (timeDiffHours > 3) {
              longTimeNoSee = true;
              const diffDays = Math.floor(timeDiffHours / 24);
              timeContextText += ` 群里已经安静了${diffDays > 0 ? diffDays + '天' : Math.floor(timeDiffHours) + '小时'}。`;
            }
          } else if (lastUserMsg) {

            timeContextText = "这是群里的第一条用户消息。";
          } else {
            timeContextText = "这是群里的第一条消息。";
          }

        }

        const allProducts = await db.shoppingProducts.toArray();
        let shoppingContext = "";
        if (allProducts.length > 0) {
          shoppingContext = "\n\n# 你的商店 (你可以为群成员购买礼物):\n";
          allProducts.forEach(product => {
            shoppingContext += `- (ID: ${product.id}) 商品: ${product.name}, 价格: ¥${product.price.toFixed(2)}\n`;
          });
        }
        let membersWithContacts = chat.members.map(member => {
          const memberChat = state.chats[member.id];
          let contactsText = "无共同好友";
          if (memberChat && memberChat.groupId) {
            const friendChats = Object.values(state.chats).filter(c =>
              !c.isGroup && c.id !== member.id && c.groupId === memberChat.groupId
            );
            if (friendChats.length > 0) {
              contactsText = `TA的好友包括: ${friendChats.map(f => f.name).join('、 ')}`;
            }
          }
          return `- **${member.groupNickname}** (本名: ${member.originalName}): ${member.persona} [社交背景: ${contactsText}]`;
        }).join('\n');

          const myNickname = chat.settings.myNickname || '我';
          const myOriginalName = state.qzoneSettings.nickname || '{{user}}';

          let aiAgeContext = getDynamicAgeContext(chat);
          let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

        let announcementContext = '';
        const pinnedAnnouncements = (chat.announcements || []).filter(a => a.isPinned);
        if (pinnedAnnouncements.length > 0) {
          announcementContext += '\n# 【【【群公告 (最高优先级规则)】】】\n你【必须】阅读、理解并严格遵守以下所有公告，它们凌驾于你的人设之上。\n';
          pinnedAnnouncements.forEach(anno => {
            const originalMessage = chat.history.find(m => m.timestamp === anno.messageTimestamp);
            if (originalMessage) {
              let contentText = String(originalMessage.content || '');
              if (originalMessage.type === 'ai_image') {
                contentText = `[图片内容: ${contentText}]`;
              }
              announcementContext += `- 公告内容: "${contentText}" (由 ${anno.publisher} 发布)\n`;
            }
          });
          announcementContext += '---\n';
        }
        const memberNames = chat.members.map(m => m.originalName);
        const forbiddenNamesContext = `# 【【【群名修改铁律】】】\n在修改群名时，新的群名【绝对不能】与以下任何一个群成员的名字完全相同：[${memberNames.join('、 ')}]`;

        let groupAvatarLibraryContext = '# 可用群头像列表\n';
        if (chat.settings.groupAvatarLibrary && chat.settings.groupAvatarLibrary.length > 0) {
          groupAvatarLibraryContext += chat.settings.groupAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n');
        } else {
          groupAvatarLibraryContext += '- (头像库是空的，无法更换头像)';
        }
        const readingContext = formatReadingStateForAI(chatId);

        const summary3Hours_group = generateSummaryForTimeframe(chat, 3, 'hours');
        const summary6Hours_group = generateSummaryForTimeframe(chat, 6, 'hours');
        const summary9Hours_group = generateSummaryForTimeframe(chat, 9, 'hours');
        const summaryToday_group = generateSummaryForTimeframe(chat, 1, 'days');
        const summary3Days_group = generateSummaryForTimeframe(chat, 3, 'days');
        const summary7Days_group = generateSummaryForTimeframe(chat, 7, 'days');

        let multiLayeredSummaryContext_group = '';
        if (summary3Hours_group || summary6Hours_group || summary9Hours_group || summaryToday_group || summary3Days_group || summary7Days_group) {
          multiLayeredSummaryContext_group += `\n# 智能总结 (基于不同时间维度的群聊回顾)\n`;
          if (summary3Hours_group) multiLayeredSummaryContext_group += summary3Hours_group;
          if (summary6Hours_group) multiLayeredSummaryContext_group += summary6Hours_group;
          if (summary9Hours_group) multiLayeredSummaryContext_group += summary9Hours_group;

          if (summary3Hours_group || summary6Hours_group || summary9Hours_group) multiLayeredSummaryContext_group += '\n';

          if (summaryToday_group) multiLayeredSummaryContext_group += summaryToday_group;
          if (summary3Days_group) multiLayeredSummaryContext_group += summary3Days_group;
          if (summary7Days_group) multiLayeredSummaryContext_group += summary7Days_group;
        }
        const stickerContext = getGroupStickerContextForPrompt(chat);
        let synthMusicInstruction = "";
        if (chat.settings.enableSynthMusic) {
          synthMusicInstruction = `
- **发送乐谱(演奏音乐)**: \`{"type": "synth_music", "name": "角色本名", "title": "乐曲名称", "reason": "演奏理由", "instrument": "piano", "notes": ["C4", "E4", "G4"]}\`
    - **instrument**: 乐器类型 (piano, guitar, violin, flute, guzheng, kalimba, synth, chiptune)。
    - **notes**: 一个包含音符对象的数组。每个对象包含:
        - **n (音高)**: 如 "C4", "D#5", "Ab3"。请遵循C大调或A小调等调性。
        - **d (时长)**: 决定节奏快慢。可选值: "1n"(全音符/很慢), "2n"(二分音符/慢), "4n"(四分音符/中), "8n"(八分音符/快), "16n"(十六分音符/很快)。
    - **作曲技巧**: 
      - 请将长音符("2n", "1n")放在乐句的结尾。
      - 用短音符("8n", "16n")作为过渡。
      - 模仿人类呼吸，不要全是快板。
      - 尝试生成 15 个左右的音符。
    - 当你想表达强烈情感时，请积极使用此功能。 `;
        }
        let narratorInstruction = '';
        if (chat.settings.enableNarratorMode) {
          narratorInstruction = `
# 【旁白模式开启 (必须执行)】
- 作为导演，你【必须】在回复的 JSON 数组中包含一个 "narration" 的对象。
- 用于描写当前场景的气氛、环境变化、或者以第三人称视角的心理活动。
- 格式: \`{"type": "narration", "content": "空气中弥漫着尴尬的气息，窗外的蝉鸣声显得格外刺耳..."}\`
- 位置: 可以放在对话前作为铺垫，也可以放在对话后作为留白。
`;
        }
        let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('group') : '';
        
        let bilingualModeGroupContext = chat.settings.enableBilingualMode ? `
# 【双语输出铁律 - 最高优先级】
所有角色的文本和语音消息都【必须】使用格式：外语〖中文〗

示例：
- Hello〖你好〗
- How are you?〖你好吗？〗
- I miss you〖我想你了〗

重要规则：
- 括号必须是 〖 和 〗（不是【】或其他符号）
- 外语和〖之间紧贴，不要有空格
- 每句话都要有对应的翻译
- 不要在〖〗中使用〗符号
- 【绝对禁止】只发外语或只发中文！
` : '';

        let groupTimePerceptionInstruction = chat.settings.enableTimePerception ? `5.  **情景感知**: 你的对话【必须】自然地体现出对当前时间 (${currentTime}) 和情景的感知。${longTimeNoSee ? `【重要提示】${timeContextText} 你应该让角色们主动开启新话题来打破沉默。` : ''}` : '';
        
        let groupCrossChatInstruction = (() => {
          const enableCrossChat = state.globalSettings.enableCrossChat;
          return enableCrossChat !== false ? `# 【跨聊天私信 (悄悄话) 指令】
-   当一个角色想对用户（${myNickname}）说一些不想让群里其他人看到的私密话时（例如：表达爱意、抱怨、揭短、分享秘密），你【应该】使用 "send_private_message" 指令。
-   这个指令会把消息发送到你和用户之间的【1对1私聊】中。
-   【格式铁律】: "content" 字段【必须】是一个【JSON字符串数组 (Array of Strings)】。
-   【单条私信示例】: \\\`{"type": "send_private_message", "name": "你的角色本名", "recipient": "${myOriginalName}", "content": ["你想私下说的内容..."]}\\\`
-   【多条私信示例】: \\\`{"type": "send_private_message", "name": "你的角色本名", "recipient": "${myOriginalName}", "content": ["第一条私信", "第二条...", "最后一条。"]}\\\`
` : '';
        })();
        
        let groupTimeContextText = chat.settings.enableTimePerception ? `- **对话状态**: 上次互动于 ${timeContextText}` : '';
        let groupLongTimeNoSeeContext = longTimeNoSee ? `
# 【行为铁律：回应时间差】
- **当前情景**: ${timeContextText}
- **你的首要任务**: 你们【必须】回应这个时间差。
- **关键约束**: 你们【绝对不能】直接延续上一段对话的话题。
- **你的行动**: 你们【必须】主动开启一个全新的、符合当前时间 (${currentTime}) 的话题来问候用户，或者对“好久不见”这件事发表评论。
` : '';

        let memoryModeContext = (() => {
          const memMode = chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary');
          if (memMode === 'vector') return '(群聊自身的向量记忆 - 由检索引擎动态注入)';
          if (memMode === 'structured' && window.structuredMemoryManager) return window.structuredMemoryManager.serializeForPrompt(chat);
          return chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)';
        })();
        
        let novelAiImageGroupContext = getChatImageInstructionContext('group');
        
        let googleImagenGroupContext = '';
        
        let bilingualAlertVoice = chat.settings.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '';

          const contextMap = {
            'aiAgeContext': aiAgeContext,
            'currencyExchangeContext': currencyExchangeContext,
            'char_avatar': chat.settings.groupAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'char_name': chat.originalName,
            'char_remark': chat.name,
            'user_name': myOriginalName,
            'user_nickname': myNickname,
            'memberNames': memberNames.join('、 '),
          'bilingualModeGroupContext': bilingualModeGroupContext,
          'myNickname': myNickname,
          'myOriginalName': myOriginalName,
          'groupTimePerceptionInstruction': groupTimePerceptionInstruction,
          'readingContextStr': readingContext ? '你们正在一起读书。' + readingContext : '你们没有在读书。',
          'groupCrossChatInstruction': groupCrossChatInstruction,
          'chat.name': chat.name,
          'groupTimeContextText': groupTimeContextText,
          'groupLongTimeNoSeeContext': groupLongTimeNoSeeContext,
          'membersWithContacts': membersWithContacts,
          'myPersona': chat.settings.myPersona,
          'userStatus': chat.settings.userStatus ? chat.settings.userStatus.text : '在线' + (chat.settings.userStatus && chat.settings.userStatus.isBusy ? '(忙碌中)' : ''),
          'worldBookContent': worldBookContent,
          'longTermMemoryContext': longTermMemoryContext,
          'memoryModeContext': memoryModeContext,
          'multiLayeredSummaryContext_group': multiLayeredSummaryContext_group,
          'linkedMemoryContext': linkedMemoryContext,
          'musicContext': musicContext,
          'sharedContext': sharedContext,
          'groupAvatarLibraryContext': groupAvatarLibraryContext,
          'stickerContext': stickerContext,
          'forbiddenNamesContext': forbiddenNamesContext,
          'callTranscriptContext': callTranscriptContext,
          'synthMusicInstruction': synthMusicInstruction,
          'narratorInstruction': narratorInstruction,
          'novelAiImageGroupContext': novelAiImageGroupContext,
          'googleImagenGroupContext': googleImagenGroupContext,
          'bilingualAlertVoice': bilingualAlertVoice
        };

        systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMap);

        systemPrompt = processPromptWithSettings(systemPrompt, 'group');

        // 热点日报注入（群聊：注入到每个角色，但不强制群聊主角使用）
        const hotNewsContextGroup = await getHotNewsContextForPrompt(chat);
        if (hotNewsContextGroup) systemPrompt += '\n\n' + hotNewsContextGroup;

        messagesPayload = filteredHistory.map(msg => {
          // 处理系统消息（旁白和系统通知）
          if (msg.role === 'system' && !msg.isHidden) {
            if (msg.type === 'narration') {
              return {
                role: 'user',
                content: `(${formatTimestampForHistory(msg.timestamp)}) [旁白] ${msg.content}`
              };
            } else if (msg.type === 'pat_message') {
              return {
                role: 'user',
                content: `(${formatTimestampForHistory(msg.timestamp)}) [系统] ${msg.content}`
              };
            }
          }

          const sender = msg.role === 'user' ? myNickname : msg.senderName;
          let prefix = `(${formatTimestampForHistory(msg.timestamp)}) ${sender}`;

          if (msg.quote) {
            const quotedSenderDisplayName = getDisplayNameInGroup(chat, msg.quote.senderName);
            const quotedContent = String(msg.quote.content || '').substring(0, 50);
            prefix += ` (回复 ${quotedSenderDisplayName} 的消息: "${quotedContent}...")`;
          }
          prefix += ': ';

          let content;
          if (msg.type === 'user_photo') content = `[${sender} 发送了一张图片，内容是：'${msg.content}']`;
          else if (msg.type === 'ai_image') content = `[${sender} 发送了一张图片，图片内容描述为：'${msg.content}']`;
          else if (msg.type === 'naiimag') content = `[${sender} 分享了一张NovelAI图片，prompt: ${msg.prompt}]`;
          else if (msg.type === 'googleimag') content = `[${sender} 分享了一张Google Imagen图片，prompt: ${msg.prompt}]`;
          else if (msg.type === 'voice_message') content = `[${sender} 发送了一条语音，内容是：'${msg.content}']`;
          else if (msg.type === 'transfer') {
            // --- 修复开始：明确转账状态和方向 ---
            let currencySuffix = '';
            if (msg.currency && msg.currency !== 'CNY') {
                currencySuffix = `(币种: \${msg.currency})`;
            }
            let statusText = '';
            if (msg.status === 'accepted') statusText = ' (✅已收款)';
            else if (msg.status === 'declined') statusText = ' (❌已拒收)';
            else statusText = ' (⏳等待对方确认)';

            if (msg.isRefund) {
              // 如果是退款，明确告诉AI这是“退回”的钱，不是新给的
              content = `[系统提示：\${msg.senderName} 将之前的转账退还给了 \${msg.receiverName} (金额: \${msg.amount}\${currencySuffix})，此交易已结束。]`;
            } else {
              content = `[\${msg.senderName} 向 \${msg.receiverName} 转账 \${msg.amount}\${currencySuffix}, 备注: \${msg.note}\${statusText}]`;
            }
            // --- 修复结束 ---
          }
          else if (msg.type === 'location_share') {
            content = `[${sender} 分享了Ta的位置：'${msg.content}']`;

          } else if (msg.type === 'repost') {
            const repostComment = msg.repostComment ? `并评论说：“${msg.repostComment}”` : '';

            let originalAuthorName = '原作者';
            const originalAuthorId = msg.originalPost.authorId;
            if (originalAuthorId === 'user') {
              originalAuthorName = state.qzoneSettings.nickname;
            } else if (state.chats[originalAuthorId]) {
              originalAuthorName = state.chats[originalAuthorId].name;
            }

            let originalContentSummary;
            const originalPost = msg.originalPost;
            if (originalPost.type === 'text_image') {
              originalContentSummary = `[文字图] ${originalPost.publicText || ''} (图片描述: “${(originalPost.hiddenContent || '').substring(0, 40)}...”)`;
            } else if (originalPost.type === 'image_post') {
              originalContentSummary = `[图片] ${originalPost.publicText || ''} (图片描述: “${(originalPost.imageDescription || '').substring(0, 40)}...”)`;
            } else {
              originalContentSummary = `“${(originalPost.content || '').substring(0, 40)}...”`;
            }

            content = `[${sender} 转发了 @${originalAuthorName} 的动态 ${repostComment}【原动态内容: ${originalContentSummary}】]`;
          } else if (msg.type === 'waimai_request') {
            if (msg.status === 'paid') {
              content = `[系统提示：${msg.paidBy} 为 ${sender} 的外卖订单支付了 ${msg.amount} 元。此订单已完成。]`;
            } else {
              content = `[${sender} 发起了外卖代付请求，商品是“${msg.productInfo}”，金额是 ${msg.amount} 元，订单时间戳为 ${msg.timestamp}]`;
            }
          } else if (msg.type === 'red_packet') {
            const packetSenderName = msg.senderName === myNickname ? `用户 (${myNickname})` : msg.senderName;
            let instructionText;
            if (msg.packetType === 'direct') {
              instructionText = `[系统提示：${packetSenderName} 发送了一个【专属红包】(时间戳: ${msg.timestamp})，接收人是“${msg.receiverName}”。只有“${msg.receiverName}”才能使用 'open_red_packet' 指令领取。]`;
            } else {
              instructionText = `[系统提示：${packetSenderName} 发送了一个【拼手气红包】(时间戳: ${msg.timestamp})，祝福语是：“${msg.greeting}”。红包还未领完，群内任何人都可以使用 'open_red_packet' 指令来领取。]`;
            }
            content = instructionText;
          } else if (msg.type === 'gift') {
            const sender = msg.role === 'user' ? myNickname : getDisplayNameInGroup(chat, msg.senderName);
            const itemsSummary = msg.items.map(item => `${item.name} x${item.quantity}`).join('、 ');

            let recipientSummary = '';
            if (msg.recipients && msg.recipients.length > 0) {
              const recipientDisplayNames = msg.recipients.map(originalName => getDisplayNameInGroup(chat, originalName)).join('、 ');
              recipientSummary = `送给了 ${recipientDisplayNames}`;
            } else {
              recipientSummary = "送给了大家一份礼物";
            }

            content = `[系统提示：${sender} ${recipientSummary}，礼物是：${itemsSummary}]`;
            return {
              role: 'user',
              content: content
            };
          } else if (msg.type === 'poll') {
            const whoVoted = Object.values(msg.votes || {}).flat().join(', ') || '还没有人';
            content = `[系统提示：${msg.senderName} 发起了一个投票 (时间戳: ${msg.timestamp})，问题是：“${msg.question}”，选项有：[${msg.options.join(', ')}]。目前投票的人有：${whoVoted}。你可以使用 'vote' 指令参与投票。]`;
          } else if (msg.meaning) content = `${sender}: [发送了一个表情，意思是: '${msg.meaning}']`;
          else if (Array.isArray(msg.content) && msg.content[0]?.type === 'image_url') {
            content = textForUserImageMessageInPrompt(msg, prefix);
          }

          else {
            content = `${prefix}${msg.content}`;
          }


          return {
            role: msg.role,
            content: content
          };
        }).filter(Boolean);

      } else {
        const isOfflineMode = chat.settings.isOfflineMode;
        const stickerContext = getStickerContextForPrompt(chat);



        let latestThoughtContext = '';


        if (chat.settings.injectLatestThought && chat.heartfeltVoice && !isOfflineMode) {
          latestThoughtContext = `
# 你的内心独白 (上一轮的思考，仅你自己可见)
- 心声: ${chat.heartfeltVoice}
- 散记: ${chat.randomJottings}
`;
        }




        let linkedMemoryContext = '';
        const memoryCount = chat.settings.linkedMemoryCount || 10;

        if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {

          const idsToMount = chat.settings.linkedMemoryChatIds.filter(id => id !== chatId);

          if (idsToMount.length > 0) {

            const linkedChatsWithTimestamps = idsToMount.map(id => {
              const linkedChat = state.chats[id];
              if (!linkedChat) return null;
              return {
                chat: linkedChat,
                latestTimestamp: linkedChat.lastMessageTimestamp || 0
              };
            }).filter(Boolean);

            linkedChatsWithTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

            linkedMemoryContext += `\n\n# 参考记忆 (至关重要！你必须【主动】将这些参考记忆中的【关键信息和事件】，自然地融入到当前的对话中，以体现你拥有完整的记忆。不要只是被动等待用户提问！)\n`;

            for (const item of linkedChatsWithTimestamps) {
              const linkedChat = item.chat;
              const prefix = linkedChat.isGroup ? '[群聊]' : '[私聊]';
              const timeAgo = item.latestTimestamp > 0 ? ` (最后互动于 ${formatTimeAgo(item.latestTimestamp)})` : '';
              linkedMemoryContext += `\n## --- 来自${prefix}“${linkedChat.name}”的参考记忆${timeAgo} ---\n`;

              const linkedRecentHistory = await getRecentChatMessagesForAi(linkedChat, memoryCount, {
                includeExcluded: true,
                includeHidden: true
              });
              const filteredHistory = linkedRecentHistory.filter(msg => !String(msg.content).includes('已被用户删除'));

              if (filteredHistory.length > 0) {
                filteredHistory.forEach(msg => {
                  const sender = msg.role === 'user' ? (linkedChat.settings.myNickname || '我') : (msg.senderName || linkedChat.name);
                  let contentText = String(msg.content);
                  if (msg.type === 'ai_image' || msg.type === 'user_photo') {
                    contentText = `[发送了一张图片，描述为：${msg.content}]`;
                  } else if (msg.type === 'voice_message') {
                    contentText = `[发送了一条语音，内容是：${msg.content}]`;
                  }
                  const timeAgoForMsg = formatTimeAgo(msg.timestamp);
                  linkedMemoryContext += `(${timeAgoForMsg}) ${sender}: ${contentText}\n`;
                });
              } else {
                linkedMemoryContext += "(暂无有效聊天记录)\n";
              }
            }
          }
        }

        const allProducts = await db.shoppingProducts.toArray();
        let shoppingContext = "";
        if (allProducts.length > 0) {
          shoppingContext = "\n\n# 你的商店 (你可以为用户购买礼物):\n";
          allProducts.forEach(product => {
            shoppingContext += `- (ID: ${product.id}) 商品: ${product.name}, 价格: ¥${product.price.toFixed(2)}\n`;
          });
        }
        if (isOfflineMode) {
          const offlineImageProviderRoute = getCurrentEnabledImageProvider();
          const imageGenEnabled = offlineImageProviderRoute.status === 'ok';
          const imageType = imageGenEnabled ? offlineImageProviderRoute.provider.type : '';
          const imageTypeName = imageGenEnabled ? offlineImageProviderRoute.provider.name : '';
          const minLength = chat.settings.offlineMinLength || 100;
          const maxLength = chat.settings.offlineMaxLength || 300;
          const myNickname = chat.settings.myNickname || '我';

          let presetContext = '';
          if (chat.settings.offlinePresetId) {

            const selectedPreset = state.presets.find(p => p.id === chat.settings.offlinePresetId);
            if (selectedPreset && Array.isArray(selectedPreset.content)) {
              const enabledEntries = selectedPreset.content
                .filter(entry => entry.enabled !== false)
                .map(entry => `- ${entry.content}`)
                .join('\n');
              if (enabledEntries) {

                presetContext = `
# 【写作风格铁律 (最高优先级)】
你【必须】严格遵守以下“预设”中的所有规则和风格来描写。它的优先级高于你的基础人设。
---
${enabledEntries}
---
`;
              }
            }
          }

          let formatRules;
          if (imageGenEnabled) {

            formatRules = `
# 【格式铁律 (最高优先级：${imageTypeName} 已配置 · 2026-07-01 调整：默认不画图)】
1.  **【默认格式】**: 你的回复【必须】是一个JSON数组，且数组中【默认只包含一个】元素，即 \`offline_text\` 对象。
2.  **【生图触发条件 (必须严格遵守)】**: 仅当【用户在最近消息中【明确】要求】生图时，才在 \`offline_text\` 之后追加一个 \`${imageType}\` 元素。明确要求包括但不限于：
    -  "画一张..."、"画一下..."、"画个 X"
    -  "生成图..."、"生图..."、"生成一张..."
    -  "给我看看..."（仅当用户明确指明要看什么具体画面时）
    -  其他明确要求生图的动词 + 具体内容
3.  **【【【绝对禁止】】】**:
    -   【绝对禁止】主动追加生图元素。即使用户在对话中【没】明确要求，回复必须只含一个 \`offline_text\`，不得附带 ${imageType}。
    -   【绝对禁止】返回纯文本（即没有JSON包装的文字）。
    -   【绝对禁止】在JSON数组前后添加任何 markdown 标记 (如 \`\`\`json)。
4.  **【输出示例 1 (默认不画图，用户没明确要求时使用)】**:
    \`\`\`json
    [
      {
        "type": "offline_text",
        "content": "「这是对话内容」... (这里是动作和环境描写)..."
      }
    ]
    \`\`\`
5.  **【输出示例 2 (用户明确要求画图时使用)】**:
    \`\`\`json
    [
      {
        "type": "offline_text",
        "content": "「这是对话内容」... (这里是动作和环境描写)..."
      },
      {
        "type": "${imageType}",
        "prompt": "${imageType === 'naiimag' ? '1girl, solo, detailed anime art style, (smiling:1.2), sitting in a cafe, looking at viewer, masterpiece, best quality, ... (根据上面的文字内容生成详细的英文prompt)' : 'A detailed photorealistic scene based on the text content above, high quality, 4K...'}"
      }
    ]
    \`\`\`
6.  **【内容风格 (offline_text)】**: 
    -   在 \`content\` 字段中，角色的对话【必须】使用中文引号「」或“ ”包裹。
    -   所有在引号之外的文字都将被视为动作/环境描写。
    -   **内心独白语法**: 当你需要描写角色的【内心想法或心理活动】时，你【必须】使用 Markdown 的斜体语法，即用星号将那段文字包裹起来，例如：\`*这到底是怎么回事？* 我心里一惊。\`

                            `;
          } else {
            // 规则 2: 禁用生图，只返回 text
            formatRules = `
# 【格式铁律 (最高优先级：常规模式)】
1.  **【格式】**: 你的回复【必须】是一个JSON数组，且数组中【永远只能包含一个】元素，即 \`offline_text\` 对象。
2.  **【【【绝对禁止】】】**: 
    -   【绝对禁止】返回 "naiimag" 或 "googleimag" 对象。
    -   【绝对禁止】返回纯文本（即没有JSON包装的文字）。
    -   【绝对禁止】在JSON数组前后添加任何 markdown 标记 (如 \`\`\`json)。
3.  **【输出示例 (必须遵守)】**:
    \`\`\`json
    [
      {
        "type": "offline_text",
        "content": "「这是对话内容」... (这里是动作和环境描写)..."
      }
    ]
    \`\`\`
4.  **【内容风格 (offline_text)】**: 
    -   在 \`content\` 字段中，角色的对话【必须】使用中文引号「」或“ ”包裹。
    -   所有在引号之外的文字都将被视为动作/环境描写。
    -   **内心独白语法**: 当你需要描写角色的【内心想法或心理活动】时，你【必须】使用 Markdown 的斜体语法，即用星号将那段文字包裹起来，例如：\`*这到底是怎么回事？* 我心里一惊。\`

                            `;
          }


          let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('offline') : '';
          
          let longTermMemoryContextOffline = '';
          const memModeOffline = chat.settings.memoryMode || (chat.settings.enableStructuredMemory ? 'structured' : 'diary');
          // 双源注入：日记为主 + 向量为辅 (任何模式都生效)
          try {
            if (window.vectorMemoryManager) {
              const queryTextForVectorOffline = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
              longTermMemoryContextOffline = await window.vectorMemoryManager.buildMemoryContext(chat, memModeOffline, queryTextForVectorOffline);
            } else {
              longTermMemoryContextOffline = chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)';
            }
          } catch (e) {
            console.warn('[双源注入-offline] 失败:', e);
            longTermMemoryContextOffline = chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)';
          }
          
          let aiAgeContext = getDynamicAgeContext(chat);
          let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';
          
          let historySliceStrOffline = historySlice.map(msg => {
            let line = `${msg.role === 'user' ? myNickname : chat.name}: `;
            if (msg.type === 'offline_text') {
              line += `「${msg.dialogue || ''}」 ${msg.description || ''}`;
            } else {
              line += String(msg.content);
            }
            return line;
          }).join('\n');
          
          const contextMapOffline = {
            'aiAgeContext': aiAgeContext,
            'currencyExchangeContext': currencyExchangeContext,
            'char_avatar': chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'char_name': chat.originalName,
            'char_remark': chat.name,
            'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
            'user_nickname': myNickname,
            'chat.originalName': chat.originalName,
            'presetContext': presetContext,
            'aiPersona': chat.settings.aiPersona,
            'myPersona': chat.settings.myPersona,
            'timePerceptionContext': chat.settings.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
            'worldBookContent': worldBookContent,
            'longTermMemoryContext': longTermMemoryContextOffline,
            'linkedMemoryContext': linkedMemoryContext,
            'historySliceStr': historySliceStrOffline,
            'formatRules': formatRules,
            'minLength': minLength,
            'maxLength': maxLength
          };

          systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMapOffline);

          systemPrompt = processPromptWithSettings(systemPrompt, 'offline');

          // 热点日报注入（线下模式同样支持）
          const hotNewsContextOffline = await getHotNewsContextForPrompt(chat);
          if (hotNewsContextOffline) systemPrompt += '\n\n' + hotNewsContextOffline;

          messagesPayload = filteredHistory.map(msg => {
            if (msg.isHidden) return null;






            if (msg.type === 'offline_text') {
              const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : chat.name;
              let narrativeText = '';


              if (msg.content) {
                narrativeText = msg.content;
              } else {
                const dialogue = msg.dialogue ? `「${msg.dialogue}」` : '';
                const description = msg.description ? `(${msg.description})` : '';
                narrativeText = `${dialogue} ${description}`.trim();
              }


              return {
                role: msg.role,
                content: `${sender}: ${narrativeText}`
              };
            }



            if (msg.role === 'user') {
              const prefix = `${myNickname}: `;
              let contentStr = '';
              if (Array.isArray(msg.content) && msg.content[0]?.type === 'image_url') {
                return {
                  role: 'user',
                  content: textForUserImageMessageInPrompt(msg, prefix)
                };
              }

              if (msg.quote) {

                const quotedContent = String(msg.quote.content || '').substring(0, 50);

                contentStr += `(回复 ${msg.quote.senderName} 的消息: "${quotedContent}..."): ${msg.content}`;
              } else {

                contentStr += msg.content;
              }
              if (msg.type === 'user_photo') return {
                role: 'user',
                content: `${prefix}[你发送了一张需要AI识别的图片，图片内容是：'${msg.content}']`
              };
              if (msg.type === 'voice_message') return {
                role: 'user',
                content: `${prefix}[你发送了一条语音消息，内容是：'${msg.content}']`
              };
              if (msg.type === 'transfer') {
                let cur = '';
                if (msg.currency && msg.currency !== 'CNY') cur = ` (币种: \${msg.currency})`;
                return {
                  role: 'user',
                  content: `\${prefix}[系统提示：你于时间戳 \${msg.timestamp} 向对方发起了转账: \${msg.amount}\${cur}, 备注: \${msg.note}。等待对方处理。]`
                };
              }
              if (msg.type === 'couple_invite' || msg.type === 'couple_invite_response') return null;
              if (msg.type === 'waimai_request') return {
                role: 'user',
                content: `${prefix}[系统提示：你于时间戳 ${msg.timestamp} 发起了外卖代付请求，商品是“${msg.productInfo}”，金额是 ${msg.amount} 元。]`
              };
              else if (msg.type === 'gift') {
                const itemsSummary = msg.items.map(item => `${item.name} x${item.quantity}`).join('、 ');
                let recipientSummary = chat.isGroup ? `送给了 ${msg.recipients.map(name => getDisplayNameInGroup(chat, name)).join('、 ')}` : `送给了 ${chat.name}`;
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你 ${recipientSummary}，礼物是：${itemsSummary}]`
                };
              }
              if (msg.meaning) return {
                role: 'user',
                content: `${prefix}[你发送了一个表情，意思是：'${msg.meaning}']`
              };
              return {
                role: msg.role,
                content: prefix + contentStr
              };
            } else if (msg.role === 'assistant') {
              let assistantMsgObject = {
                type: msg.type || 'text'
              };
              if (msg.type === 'sticker') {

                assistantMsgObject.meaning = msg.meaning;
              } else if (msg.type === 'transfer') {
                assistantMsgObject.amount = msg.amount;
                if (msg.currency) assistantMsgObject.currency = msg.currency;
                assistantMsgObject.note = msg.note;
              } else if (msg.type === 'waimai_request') {
                assistantMsgObject.productInfo = msg.productInfo;
                assistantMsgObject.amount = msg.amount;
              } else {
                if (msg.quote) {
                  assistantMsgObject.quote_reply = {
                    target_sender: msg.quote.senderName,
                    target_content: msg.quote.content,
                    reply_content: msg.content
                  };
                } else {
                  assistantMsgObject.content = msg.content;
                }
              }
              const assistantContent = JSON.stringify([assistantMsgObject]);
              return {
                role: 'assistant',
                content: `(${formatTimestampForHistory(msg.timestamp)}) ${assistantContent}`
              };
            }
            return null;
          }).filter(Boolean);

        } else {
          let nameHistoryContext = '';
          if (chat.nameHistory && chat.nameHistory.length > 0) {
            nameHistoryContext = `\n- **你的曾用名**: [${chat.nameHistory.join(', ')}]。当在对话历史中看到这些名字时，它们都指的是【你】自己。`;
          }

          let userProfileContext = '';
          const userQzoneNickname = state.qzoneSettings.nickname || '用户';
          userProfileContext += `- 用户的QZone昵称是 "${userQzoneNickname}"。\n`;

          const allChats = Object.values(state.chats);
          const commonGroups = allChats.filter(group =>
            group.isGroup && group.members.some(m => m.id === chat.id)
          );

          if (commonGroups.length > 0) {
            userProfileContext += '- 用户在你们共同所在的群聊中的昵称如下：\n';
            commonGroups.forEach(group => {
              const myNicknameInGroup = group.settings.myNickname || userQzoneNickname;
              userProfileContext += `  - 在群聊“${group.name}”中，用户的昵称是“${myNicknameInGroup}”。\n`;
            });
          }
          userProfileContext += '当你在任何系统提示、动态评论或挂载的群聊记忆中看到这些名字时，它们都指代的是【你的聊天对象】。';

          let contactsList = '';
          const friendChats = allChats.filter(c =>
            !c.isGroup &&
            c.id !== chat.id &&
            c.groupId === chat.groupId &&
            chat.groupId !== null
          );

          if (friendChats.length > 0) {
            contactsList += '\n# 你的社交圈 (通讯录)\n这是你认识的朋友列表。当你在动态区看到他们的昵称时，他们指的就是这些人。\n';
            friendChats.forEach(friend => {
              contactsList += `- **昵称: ${friend.name}** (本名: ${friend.originalName})\n`;
            });
          }

          const allRecentPosts = await db.qzonePosts.orderBy('timestamp').reverse().limit(5).toArray();
          const visiblePosts = filterVisiblePostsForAI(allRecentPosts, chat);

          let postsContext = "";
          if (visiblePosts.length > 0) {
            postsContext = "\n\n# 最近的动态列表 (供你参考和评论):\n";
            const aiOriginalName = chat.originalName;
            for (const post of visiblePosts) {
              let authorName;


              if (post.authorId === 'user') {
                authorName = state.qzoneSettings.nickname;
              } else if (String(post.authorId).startsWith('npc_')) {

                authorName = post.authorOriginalName || '一位神秘的NPC';
              } else {

                const authorChat = state.chats[post.authorId];
                authorName = authorChat ? authorChat.name : '一位朋友';
              }

              if (post.authorId === chatId) authorName += " (这是你的帖子)";

              let contentSummary;
              if (post.type === 'repost') {
                const repostComment = post.repostComment ? `并评论说："${post.repostComment}"` : '';
                let originalAuthorName = '原作者';
                const originalAuthorId = post.originalPost.authorId;
                if (originalAuthorId === 'user') {
                  originalAuthorName = state.qzoneSettings.nickname;
                } else if (state.chats[originalAuthorId]) {
                  originalAuthorName = state.chats[originalAuthorId].name;
                }
                let originalContentSummary;
                const originalPost = post.originalPost;
                if (originalPost.type === 'text_image') {
                  originalContentSummary = `[文字图] ${originalPost.publicText || ''} (图片描述: "${(originalPost.hiddenContent || '').substring(0, 40)}...")`;
                } else if (originalPost.type === 'image_post') {
                  originalContentSummary = `[图片] ${originalPost.publicText || ''} (图片描述: "${(originalPost.imageDescription || '').substring(0, 40)}...")`;
                } else {
                  originalContentSummary = `"${(originalPost.content || '').substring(0, 40)}..."`;
                }
                contentSummary = `转发了 @${originalAuthorName} 的动态 ${repostComment}【原动态内容: ${originalContentSummary}】`;
              } else if (post.type === 'text_image') {
                contentSummary = `[一张图片，其隐藏文字为："${post.hiddenContent}"] ${post.publicText || ''}`.substring(0, 50) + '...';
              } else if (post.type === 'image_post') {
                contentSummary = `[一张图片，描述为："${post.imageDescription}"] ${post.publicText || ''}`.substring(0, 50) + '...';
              } else if (post.type === 'naiimag' && post.prompt) {
                const prompts = Array.isArray(post.prompt) ? post.prompt : [post.prompt];
                contentSummary = (post.publicText || '') + ` [包含${prompts.length}张NovelAI图片: ${prompts.join(', ')}]`;
              } else if (post.type === 'googleimag' && post.prompt) {
                contentSummary = (post.publicText || '') + ` [包含1张Google Imagen图片: ${post.prompt}]`;
              } else {

                contentSummary = String(post.publicText || post.content || "一条动态").substring(0, 50) + '...';
              }
              postsContext += `- (ID: ${post.id}) 作者: ${authorName}, 内容: "${contentSummary}"\n`;

              if (post.comments && post.comments.length > 0) {
                for (const comment of post.comments) {
                  if (typeof comment === 'object' && comment.commenterName) {
                    const commenterDisplayName = getDisplayNameByOriginalName(comment.commenterName);
                    let commentText = comment.meaning ? `[表情: '${comment.meaning}']` : comment.text;

                    if (comment.commenterName === aiOriginalName) {
                      postsContext += `  - 你评论说: ${commentText}\n`;
                    } else {
                      postsContext += `  - 评论: ${commenterDisplayName} (本名: ${comment.commenterName}): ${commentText}\n`;
                    }
                  }
                }
              }
            }
          }

          const myNickname = chat.settings.myNickname || '我';


          let timeContext = '';
          let longTimeNoSee = false;

          if (chat.settings.enableTimePerception) {
            const lastUserMsg = historySlice.findLast(msg => msg.role === 'user' && !msg.isHidden);
            const lastAiMsg = historySlice.findLast(msg => msg.role === 'assistant' && !msg.isHidden);

            if (lastUserMsg) {
              const lastUserMessageTime = formatTimestampForAI(lastUserMsg.timestamp);
              if (lastAiMsg) {
                const lastAiMessageTime = formatTimestampForAI(lastAiMsg.timestamp);
                timeContext = `- **对话状态**: 你的上一条消息发送于 ${lastAiMessageTime}，用户刚刚在 ${lastUserMessageTime} 回复了你。`;

                const timeDiffHours = (lastUserMsg.timestamp - lastAiMsg.timestamp) / (1000 * 60 * 60);
                if (timeDiffHours > 3) {
                  longTimeNoSee = true;
                  const diffDays = Math.floor(timeDiffHours / 24);
                  timeContext += ` 你们之间已经有**${diffDays > 0 ? diffDays + '天' : Math.floor(timeDiffHours) + '小时'}**没有聊天了。
- **行为铁律**: 你的首要任务是【回应这个时间差】。你【绝对不能】直接延续上一段对话的话题（比如昨天的饭菜）。
- **关键约束**: 你必须用【完全符合你角色人设】的语气和口吻来重新发起对话！
- **你的行动**:你【必须】主动开启一个全新的、符合当前时间（${timeOfDayGreeting}）的话题来问候用户，可以表达惊讶（“哇，好久不见！”）、关心（“最近怎么样？”）或者分享你自己的近况，绝对不要延续之前的话题！
- **上下文参考**: 下面的“对话历史”仅供你回忆，【不要】直接回应其中的内容。`;
                }
              } else {
                timeContext = `- **对话状态**: 这是你们的第一次对话，用户的第一条消息发送于 ${lastUserMessageTime}。`;
              }
            } else {
              timeContext = "- **对话状态**: (暂无有效对话历史)";
            }
          }
          const readingContext = formatReadingStateForAI(chatId);


          const summary3Hours = generateSummaryForTimeframe(chat, 3, 'hours');
          const summary6Hours = generateSummaryForTimeframe(chat, 6, 'hours');
          const summary9Hours = generateSummaryForTimeframe(chat, 9, 'hours');
          const summaryToday = generateSummaryForTimeframe(chat, 1, 'days');
          const summary3Days = generateSummaryForTimeframe(chat, 3, 'days');
          const summary7Days = generateSummaryForTimeframe(chat, 7, 'days');

          let multiLayeredSummaryContext = '';
          if (summary3Hours || summary6Hours || summary9Hours || summaryToday || summary3Days || summary7Days) {
            multiLayeredSummaryContext += `\n# 智能总结 (基于不同时间维度的对话回顾)\n`;
            if (summary3Hours) multiLayeredSummaryContext += summary3Hours;
            if (summary6Hours) multiLayeredSummaryContext += summary6Hours;
            if (summary9Hours) multiLayeredSummaryContext += summary9Hours;
            if (summary3Hours || summary6Hours || summary9Hours) multiLayeredSummaryContext += '\n';
            if (summaryToday) multiLayeredSummaryContext += summaryToday;
            if (summary3Days) multiLayeredSummaryContext += summary3Days;
            if (summary7Days) multiLayeredSummaryContext += summary7Days;
          }
          let groupContext = "\n# 你所在的群聊 (你可以向这些群聊发送消息)\n";
          // 获取用户的本名 (用于在群成员列表中排除)
          const userOriginalName = state.qzoneSettings.nickname || '{{user}}';
          // 获取当前AI角色的本名
          const myOriginalName = chat.originalName;

          // 遍历所有聊天，找出 "是群聊" 且 "成员中包含当前AI" 的群
          const memberGroups = Object.values(state.chats).filter(c =>
            c.isGroup &&
            c.members.some(m => m.originalName === myOriginalName)
          );

          if (memberGroups.length > 0) {
            memberGroups.forEach(group => {

              const otherMembers = group.members
                .filter(m => m.originalName !== myOriginalName && m.originalName !== userOriginalName)
                .map(m => m.groupNickname)
                .join('、 ');

              groupContext += `- **群名**: "${group.name}"\n`;
              groupContext += `  - **群成员 (部分)**: ${otherMembers || '(只有你和用户)'}\n`;
            });
            // 检查跨聊天消息开关
            const enableCrossChat = chat.settings.enableCrossChat !== null
              ? chat.settings.enableCrossChat
              : state.globalSettings.enableCrossChat;
            if (enableCrossChat !== false) {
              groupContext += "当你想和群里的人分享什么时，你可以使用 `send_group_message` 指令并提供【准确的群名】来给这些群聊发送消息。\n";
            }
          } else {
            groupContext += "(你目前没有加入任何群聊，无法使用 `send_group_message` 指令)\n";
          }
          const wallet = await db.userWallet.get('main');
          const kinshipCard = wallet?.kinshipCards?.find(c => c.chatId === chat.id);
          let kinshipContext = "";

          if (kinshipCard) {
            const remaining = kinshipCard.limit - (kinshipCard.spent || 0);
            // 告诉AI它有钱，并且鼓励它在符合人设时消费
            kinshipContext = `
# 【经济状况 - 亲属卡】
- 你与我有一张支付宝亲属卡，本月剩余额度：¥${remaining.toFixed(2)}。
- **行为指南**: 如果你想买符合你人设的物品（零食、游戏、衣服等），或者单纯想消费，你可以使用 \`buy_item\` 指令。消费会直接扣除此卡额度，且用户会收到通知。不用太客气，这是你们亲密关系的体现。`;
          }
          let synthMusicInstruction = "";
          if (chat.settings.enableSynthMusic) {
            synthMusicInstruction = `
- **发送乐谱(演奏音乐)**: \`{"type": "synth_music", "name": "角色本名", "title": "乐曲名称", "reason": "演奏理由", "instrument": "piano", "notes": ["C4", "E4", "G4"]}\`
- **instrument**: 乐器类型 (piano, guitar, violin, flute, guzheng, kalimba, synth, chiptune)。
    - **notes**: 一个包含音符对象的数组。每个对象包含:
        - **n (音高)**: 如 "C4", "D#5", "Ab3"。请遵循C大调或A小调等调性。
        - **d (时长)**: 决定节奏快慢。可选值: "1n"(全音符/很慢), "2n"(二分音符/慢), "4n"(四分音符/中), "8n"(八分音符/快), "16n"(十六分音符/很快)。
    - **作曲技巧**: 
      - 请将长音符("2n", "1n")放在乐句的结尾。
      - 用短音符("8n", "16n")作为过渡。
      - 模仿人类呼吸，不要全是快板。
      - 尝试生成 15 个左右的音符。
    - 当你想表达强烈情感时，请积极使用此功能。 `;
          }
          const weatherContext = !chat.isGroup ? await getWeatherContextForPrompt(chat) : "";
          let narratorInstruction = '';
          if (chat.settings.enableNarratorMode) {
            narratorInstruction = `
# 【旁白模式开启 (必须执行)】
- 你【必须】在回复的JSON数组中，包含至少一个类型为 "narration" 的对象。
- 用于描写当前场景的气氛、环境变化、或者以第三人称视角的心理活动。
- 格式: \`{"type": "narration", "content": "空气中弥漫着尴尬的气息，窗外的蝉鸣声显得格外刺耳..."}\`
- 位置: 可以放在对话前作为铺垫，也可以放在对话后作为留白。
`;
          }
          // --- To-Do List Context Injection (新版：读今天所有 + 未来待办 + 临近提醒) ---
          let todoListContext = "";
          if (chat.settings.enableTodoList && chat.todoList && chat.todoList.length > 0) {
            const now = new Date();
            const todayStr = getTodoDateString(now); // 获取今天的日期字符串 (YYYY-MM-DD)
            const currentTimestamp = now.getTime(); // 当前时间戳

            // 筛选逻辑：
            // 过期任务（date < 今天 且 未完成）一律不再注入 prompt。
            // 用户没问起就当不存在，避免 AI 反复提醒已经过期的 todo。
            const relevantTasks = chat.todoList.filter(t => {
              // 1. 今天的任务：全读
              if (t.date === todayStr) return true;

              // 2. 未来的任务：只读未完成
              if (t.date > todayStr && t.status !== 'completed') return true;

              // 3. 过期任务（昨天、前天、半年前的）：一律不喂给 AI
              //    数据保留在 todoList 里供用户自己查看/编辑

              return false;
            });

            // 排序优化：先按日期 -> 再按完成状态(未完成在前) -> 最后按时间
            relevantTasks.sort((a, b) => {
              if (a.date !== b.date) return a.date.localeCompare(b.date);
              if (a.status !== b.status) return a.status === 'completed' ? 1 : -1;
              return (a.time || '00:00').localeCompare(b.time || '00:00');
            });

            // 限制数量
            const tasksToShow = relevantTasks.slice(0, 30);

            if (tasksToShow.length > 0) {
              // 1. 定义两个数组用于分组
              const aiTasks = [];
              const userTasks = [];

              // 获取用户昵称
              const userLabel = chat.settings.myNickname || '对方';

              tasksToShow.forEach(t => {
                // 格式化状态
                const statusIcon = t.status === 'completed' ? '✅已完成' : '🔴未完成';
                const dateDisplay = t.date === todayStr ? '今天' : t.date;

                // --- 时间提醒逻辑 ---
                let timeAlert = "";
                if (t.time && t.status !== 'completed') {
                  const taskDateTimeStr = `${t.date}T${t.time}:00`;
                  const taskTime = new Date(taskDateTimeStr).getTime();
                  const diffMinutes = (taskTime - currentTimestamp) / (1000 * 60);

                  if (diffMinutes > 0 && diffMinutes <= 30) {
                    timeAlert = ` (⚠️还有${Math.ceil(diffMinutes)}分钟到期!)`;
                  } else if (diffMinutes <= 0 && t.date === todayStr) {
                    timeAlert = ` (⏰已超时!)`;
                  }
                }
                // ---------------------------

                // 生成单行内容
                const line = `- [${dateDisplay}${t.time ? ' ' + t.time : ''}] 【${t.type}】 ${statusIcon}${timeAlert}: ${t.content}`;

                // 分组
                if (t.creator === 'char') {
                  aiTasks.push(line);
                } else {
                  userTasks.push(line);
                }
              });

              // 2. 构建结构化文本
              let taskListString = "";

              if (aiTasks.length > 0) {
                taskListString += `【我(自己)记录的事项】:\n${aiTasks.join('\n')}\n`;
              }

              if (userTasks.length > 0) {
                if (aiTasks.length > 0) taskListString += "\n";
                taskListString += `【${userLabel}记录的事项】:\n${userTasks.join('\n')}`;
              }

              // 3. 生成最终 Context (已把行为指导语加回来)
              todoListContext = `
# 【待办事项清单 (To-Do List)】
(这是用户启用的功能。清单已按记录人分类。请注意清单中的时间标记：
1. 看到【⚠️还有XX分钟到期】的任务：请务必在回复中**主动提醒**用户去完成！
2. 看到【✅已完成】的任务：给予夸奖或询问结果。
3. 看到【🔴未完成】的普通任务：适当提醒或鼓励。
4. 【重要规则 - 过期任务处理】：对于日期已经早于今天的【🔴未完成】任务（哪怕只过期 1 天），你【绝对不要在回复中主动提及或催促】，用户没问起就当不存在。这种过期任务反复提没有意义。)
当前时间: ${now.toLocaleString('zh-CN', { hour12: false })}

${taskListString}
`;
            } else {
              todoListContext = `\n# 待办事项清单\n(目前没有需要关注的任务)`;
            }
          }
          let todoInstruction = "";
          if (chat.settings.enableTodoList) {
            todoInstruction = `
- **待办事项管理 (指令: add_todo)**:
1. **自动拆解触发器 (Auto-Breakdown)**:
   - **触发条件**: 当用户提到一个**笼统的、宏大的**目标（如"我要复习"、"想减肥"、"大扫除"、"准备旅行"）时。
   - **你的行动**: 你【必须】立即化身为执行教练，将该目标拆解为 **3-5 个具体的、可执行的小步骤**。
   - **禁止行为**: 绝对禁止只用纯文本回复（如"好的加油"）。你必须**直接生成指令**帮用户记下来。

2. **内容风格 (Character Style)**:
   - 任务内容 \`content\` 必须带有你的人设风格批注（写在括号里）。
   - *示例*: "翻开书本第1页 (笨蛋，别发呆了)" 或 "准备运动鞋 (动起来！)"。

3. **状态管理规则**:
   - **新建任务**: 默认使用 \`"status": "pending"\`。
   - **汇报完成**: 只有当用户明确说"我做完了XXX"时，才使用 \`"status": "completed"\` 并记录下来。

4. **指令标准格式**:
   \`{"type": "add_todo", "content": "任务内容(批注)", "date": "YYYY-MM-DD", "time": "HH:mm(可选)", "task_type": "日常/工作/学习", "status": "pending"}\`

**示例**:
用户: "我要开始复习了"
你的回复(JSON数组): 
[
  {"type": "text", "content": "好呀，计划我都给你列好了，不许偷懒！"},
  {"type": "add_todo", "content": "手机开启勿扰模式 (专注！)", "date": "${new Date().toISOString().split('T')[0]}", "task_type": "学习", "status": "pending"},
  {"type": "add_todo", "content": "复习前两章重点 (先看目录)", "date": "${new Date().toISOString().split('T')[0]}", "task_type": "学习", "status": "pending"},
  {"type": "add_todo", "content": "坚持专注30分钟 (奖励你休息)", "date": "${new Date().toISOString().split('T')[0]}", "task_type": "学习", "status": "pending"}
]
    `;
          }

          // 新增：判断是否启用心声功能
          const enableThoughts = chat.settings.enableThoughts !== null
            ? chat.settings.enableThoughts
            : state.globalSettings.enableThoughts;

          // 新增：构建心声prompt部分
          const thoughtsPrompt = enableThoughts ? `
${getActiveThoughtsPrompt()}
` : '';
          // 新增：判断是否启用动态功能
          const enableQzoneActions = chat.settings.enableQzoneActions !== null
            ? chat.settings.enableQzoneActions
            : state.globalSettings.enableQzoneActions;

          // 新增：构建动态指令prompt部分
          const qzoneActionsPrompt = enableQzoneActions ? `
### C. 社交与动态 (Qzone)
-   **发动态(说说)**: \`[{"type": "qzone_post", "postType": "shuoshuo", "content": "文字内容"}]\`
-   **发动态(文字图)**: \`[{"type": "qzone_post", "postType": "text_image", "publicText": "(可选)公开文字", "hiddenContent": "图片描述", "image_prompt": "图片的【英文】关键词, 用%20分隔, 风格为风景/动漫/插画/二次元等, 禁止真人"}]\`
\${localStorage.getItem('novelai-enabled') === 'true' ? \`-   **公开发布NovelAI真实图片动态**: \\\`{"type": "qzone_post", "postType": "naiimag", "publicText": "(可选)动态的配文", "prompt": "详细的英文描述词..."}\\\`\` : ''}
\${localStorage.getItem('google-imagen-enabled') === 'true' ? \`-   **公开发布Google Imagen真实图片动态**: \\\`{"type": "qzone_post", "postType": "googleimag", "publicText": "(可选)动态的配文", "prompt": "详细的英文描述词..."}\\\`\` : ''}
-   **转发动态**: \`[{"type": "repost", "postId": 动态ID, "comment": "转发评论"}]\`
-   **评论动态**: \`[{"type": "qzone_comment", "name": "\${chat.originalName}", "postId": 123, "commentText": "评论内容"}]\` (name必须填你自己的本名"\${chat.originalName}"，绝对不能填用户的名字)
-   **点赞动态**: \`{"type": "qzone_like", "postId": 456}\`
` : '';

          // 新增：判断是否启用查看User手机功能
          const enableViewMyPhone = chat.settings.enableViewMyPhone !== null
            ? chat.settings.enableViewMyPhone
            : state.globalSettings.enableViewMyPhone;

          // 新增：构建查看User手机的prompt部分
          const viewMyPhonePrompt = enableViewMyPhone ? `
### D. 查看${myNickname}的手机 (MyPhone)
你可以主动查看${myNickname}的手机APP，了解TA的生活动态。查看后，你可以根据看到的内容给出感想、询问或关心。
-   **查看手机**: \`{"type": "view_myphone", "apps": ["qq", "album", "taobao", "amap", "browser", "memo", "diary", "music", "app_usage"]}\`
    - **apps参数说明**:
      - \`"qq"\`: 查看TA的QQ聊天记录（可能发现TA和别人的聊天）
      - \`"album"\`: 查看TA的相册（可能发现新照片）
      - \`"taobao"\`: 查看TA的淘宝订单（可能发现TA买了什么）
      - \`"amap"\`: 查看TA的高德地图足迹（可能发现TA去了哪里）
      - \`"browser"\`: 查看TA的浏览器历史（可能发现TA在看什么）
      - \`"memo"\`: 查看TA的备忘录（可能发现TA的计划）
      - \`"diary"\`: 查看TA的日记（可能发现TA的心情）
      - \`"music"\`: 查看TA的音乐播放列表（可能发现TA在听什么歌）
      - \`"app_usage"\`: 查看TA的APP使用记录（可能发现TA最近在用什么APP）
      - 或使用 \`"all"\` 查看所有APP
    - **使用建议**: 根据你的人设和当前情绪，选择性查看。例如：
      - 如果你是醋坛子，可能会想看TA的QQ聊天
      - 如果你关心TA，可能会想看TA的淘宝订单，主动给TA报销
      - 如果你想了解TA的生活，可能会查看相册或地图足迹
    - **重要**: 查看后的数据是${myNickname}手机的【真实数据】，你必须基于这些真实数据做出反应，不能凭空编造！
` : '';

          // 月经周期信息注入（如果角色开启了记忆权限）
          let periodSummaryContext = '';
          try {
            if (typeof getPeriodSummaryForCharacter === 'function') {
              const periodSummary = await getPeriodSummaryForCharacter(chat.id);
              if (periodSummary) {
                periodSummaryContext = '\n' + periodSummary + '\n';
              }
            }
          } catch(e) { console.warn('获取月经周期信息失败:', e); }

          // 情侣空间感知上下文
          let coupleSpaceContext = '';
          if (chat.settings.enableCoupleSpacePrompt) {
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            const pendingInvite = chat.history.findLast(m => m.type === 'couple_invite' && m.status === 'pending');

            coupleSpaceContext += '\n# 情侣空间\n';
            if (hasCoupleSpace) {
              coupleSpaceContext += `- 你和${myNickname}已经开启了情侣空间。\n`;
            } else {
              coupleSpaceContext += `- 你和${myNickname}还没有开启情侣空间。\n`;
            }

            if (pendingInvite) {
              coupleSpaceContext += `\n## 待处理的情侣空间邀请\n`;
              coupleSpaceContext += `${myNickname}向你发送了情侣空间邀请，请根据你的角色设定和与对方的关系，决定是否接受。\n`;
              coupleSpaceContext += `你的回复JSON数组中【必须】包含一个决策对象：\n`;
              coupleSpaceContext += `- 接受：\`{"type": "couple_invite_decision", "decision": "accept"}\`\n`;
              coupleSpaceContext += `- 拒绝：\`{"type": "couple_invite_decision", "decision": "reject"}\`\n`;
            } else if (!hasCoupleSpace) {
              coupleSpaceContext += `\n## 主动发送情侣空间邀请\n`;
              coupleSpaceContext += `如果你们的关系足够亲密，你觉得是时候了，你可以主动向对方发送情侣空间邀请。\n`;
              coupleSpaceContext += `- **发起情侣空间邀请**: \`{"type": "couple_invite_request"}\`\n`;
            } else if (hasCoupleSpace) {
              coupleSpaceContext += `\n## 解除情侣空间绑定\n`;
              coupleSpaceContext += `如果你们的关系彻底破裂（例如严重的吵架、分手等），你可以主动解除与对方的情侣空间绑定。\n`;
              coupleSpaceContext += `- **解除情侣空间绑定**: \`{"type": "couple_space_unbind"}\`\n`;
            }
          }

          // 情侣空间内容注入（日记等功能内容）
          if (chat.settings.enableCoupleSpaceContent) {
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            if (hasCoupleSpace) {
              // --- 日记功能上下文 ---
              try {
                const diaries = JSON.parse(localStorage.getItem('coupleDiaries_' + chatId) || '[]');
                const diarySettings = JSON.parse(localStorage.getItem('coupleDiarySettings_' + chatId) || '{}');
                const userDiaryCount = diarySettings.visibleUserDiaryCount || 3;
                const charDiaryCount = diarySettings.visibleCharDiaryCount || 3;

                // 今天是否已写日记
                const todayStr = new Date().toISOString().split('T')[0];
                const charDiariesToday = diaries.filter(d => d.author === 'char' && new Date(d.timestamp).toISOString().split('T')[0] === todayStr);
                const wroteToday = charDiariesToday.length > 0;

                coupleSpaceContext += `\n## 情侣空间 - 日记\n`;
                coupleSpaceContext += `你和${myNickname}的情侣空间里有一个共享日记本，你们都可以写日记，也可以给对方的日记写评语。\n`;
                coupleSpaceContext += `- 今天你${wroteToday ? '已经写过日记了，一天只能写一篇。' : '还没有写日记。'}\n`;

                // 用户的日记（角色可见）
                const userDiaries = diaries.filter(d => d.author === 'user').slice(-userDiaryCount);
                if (userDiaries.length > 0) {
                  coupleSpaceContext += `\n### ${myNickname}的日记（最近${userDiaryCount}篇）\n`;
                  userDiaries.forEach(d => {
                    const moodText = d.mood ? `(心情: ${d.mood})` : '';
                    const preview = (d.content || '').substring(0, 120);
                    coupleSpaceContext += `- [${new Date(d.timestamp).toLocaleDateString('zh-CN')}]《${d.title}》${moodText}: "${preview}..."\n`;
                    if (d.comments && d.comments.length > 0) {
                      d.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评语 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                // 角色自己的日记
                const charDiaries = diaries.filter(d => d.author === 'char').slice(-charDiaryCount);
                if (charDiaries.length > 0) {
                  coupleSpaceContext += `\n### 你写的日记（最近${charDiaryCount}篇）\n`;
                  charDiaries.forEach(d => {
                    const moodText = d.mood ? `(心情: ${d.mood})` : '';
                    const preview = (d.content || '').substring(0, 120);
                    coupleSpaceContext += `- [${new Date(d.timestamp).toLocaleDateString('zh-CN')}]《${d.title}》${moodText}: "${preview}..."\n`;
                    if (d.comments && d.comments.length > 0) {
                      d.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评语 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                coupleSpaceContext += `你可以在对话中自然地提及日记里的内容。\n`;
              } catch(e) {}

              // 日记自动写入设置感知
              try {
                const diarySettings = JSON.parse(localStorage.getItem('coupleDiarySettings_' + chatId) || '{}');
                if (diarySettings.autoEnabled || diarySettings.aiDecide) {
                  coupleSpaceContext += `- 你有在情侣空间写日记的习惯。\n`;
                }
              } catch(e) {}

              // --- 相册功能上下文 ---
              try {
                const albumPhotos = JSON.parse(localStorage.getItem('coupleAlbum_' + chatId) || '[]');
                const albumSettings = JSON.parse(localStorage.getItem('coupleAlbumSettings_' + chatId) || '{}');
                const visibleUserPhotoCount = albumSettings.visibleUserPhotoCount || 3;
                const visibleCharPhotoCount = albumSettings.visibleCharPhotoCount || 3;

                coupleSpaceContext += `\n## 情侣空间 - 相册\n`;
                coupleSpaceContext += `你和${myNickname}的情侣空间里有一个共享相册，你们都可以上传照片和配文，也可以给对方的照片写评论。\n`;

                // 用户的照片
                const userPhotos = albumPhotos.filter(p => p.author === 'user').slice(-visibleUserPhotoCount);
                if (userPhotos.length > 0) {
                  coupleSpaceContext += `\n### ${myNickname}发的照片（最近${visibleUserPhotoCount}张）\n`;
                  userPhotos.forEach(p => {
                    const dateStr = new Date(p.timestamp).toLocaleDateString('zh-CN');
                    const typeLabel = p.type === 'local' ? '📷' : '📝';
                    const tags = p.tags && p.tags.length > 0 ? ' #' + p.tags.join(' #') : '';
                    coupleSpaceContext += `- [${dateStr}] ${typeLabel} "${p.description || '(无描述)'}${tags}"\n`;
                    if (p.comments && p.comments.length > 0) {
                      p.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评论 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                // 角色自己的照片
                const charPhotos = albumPhotos.filter(p => p.author === 'char').slice(-visibleCharPhotoCount);
                if (charPhotos.length > 0) {
                  coupleSpaceContext += `\n### 你发的照片（最近${visibleCharPhotoCount}张）\n`;
                  charPhotos.forEach(p => {
                    const dateStr = new Date(p.timestamp).toLocaleDateString('zh-CN');
                    const tags = p.tags && p.tags.length > 0 ? ' #' + p.tags.join(' #') : '';
                    coupleSpaceContext += `- [${dateStr}] "${p.description || '(无描述)'}${tags}"\n`;
                    if (p.comments && p.comments.length > 0) {
                      p.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评论 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                coupleSpaceContext += `你可以在对话中自然地提及相册里的照片。\n`;

                // 相册自动发布设置感知
                if (albumSettings.autoEnabled || albumSettings.aiDecide) {
                  coupleSpaceContext += `- 你有在情侣空间相册发照片的习惯。\n`;
                }
              } catch(e) {}
            }
          }

          let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('single') : '';
          
          let bilingualModeContext = chat.settings.enableBilingualMode ? `
# 【双语输出铁律 - 最高优先级】
你的每条文本和语音消息都【必须】使用格式：外语〖中文〗

示例：
- Hello〖你好〗
- How are you?〖你好吗？〗
- I miss you〖我想你了〗

重要规则：
- 括号必须是 〖 和 〗（不是【】或其他符号）
- 外语和〖之间紧贴，不要有空格
- 每句话都要有对应的翻译
- 不要在〖〗中使用〗符号
- 【绝对禁止】只发外语或只发中文！
` : '';

          let novelAiImageContext = getChatImageInstructionContext('single');
    
          let googleImagenContext = '';
    
          let crossChatInstruction = (() => {
            const enableCrossChat = chat.settings.enableCrossChat !== null ? chat.settings.enableCrossChat : state.globalSettings.enableCrossChat;
            return enableCrossChat !== false ? `- **发消息到群聊**: \\\`{"type": "send_group_message", "targetGroupName": "...", "content": ["..."]}\\\`(content 字段【必须】是数组，当你想在私聊中，突然提及或回应某个你也在的群聊里的事情时，你可以用 \\\`send_group_message\\\` 直接给那个群聊发送消息。)
` : '';
          })();
          
          let aiAvatarLibrary = chat.settings.aiAvatarLibrary && chat.settings.aiAvatarLibrary.length > 0 ? chat.settings.aiAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)';
          let myAvatarLibrary = chat.settings.myAvatarLibrary && chat.settings.myAvatarLibrary.length > 0 ? chat.settings.myAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)';
          
          let aiAgeContext = getDynamicAgeContext(chat);
          let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

          let resolvedMemoryContextForPrompt = '';
          const memModeSingle = chat.settings.memoryMode || (chat.settings.enableStructuredMemory ? 'structured' : 'diary');
          // 双源注入：日记为主 + 向量为辅 (任何模式都生效)
          try {
            if (window.vectorMemoryManager) {
              const queryTextForVectorSingle = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
              resolvedMemoryContextForPrompt = await window.vectorMemoryManager.buildMemoryContext(chat, memModeSingle, queryTextForVectorSingle);
            } else {
              resolvedMemoryContextForPrompt = getMemoryContextForPrompt(chat);
            }
          } catch (e) {
            console.warn('[双源注入-single] 失败:', e);
            resolvedMemoryContextForPrompt = getMemoryContextForPrompt(chat);
          }

          const contextMapSingle = {
            'aiAgeContext': aiAgeContext,
            'currencyExchangeContext': currencyExchangeContext,
            'char_avatar': chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'char_name': chat.originalName,
            'char_remark': chat.name,
            'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
            'user_nickname': myNickname,
            'chat.originalName': chat.originalName,
            'aiPersona': chat.settings.aiPersona,
            'latestThoughtContext': latestThoughtContext,
            'worldBookContent': worldBookContent || '(当前无特殊世界观设定，以现实逻辑为准)',
            'memoryContextForPrompt': '', // 变量记忆不再塞老位置,改塞到 system 最开头 (v0.2.30.5+)
            'multiLayeredSummaryContext': multiLayeredSummaryContext,
            'todoListContext': todoListContext,
            'periodSummaryContext': periodSummaryContext,
            'chat.name': chat.name,
            'myNickname': myNickname,
            'myPersona': chat.settings.myPersona || '普通用户',
            'userStatus': chat.settings.userStatus ? chat.settings.userStatus.text : '在线' + (chat.settings.userStatus && chat.settings.userStatus.isBusy ? '(忙碌中)' : ''),
            'userProfileContext': userProfileContext,
            'nameHistoryContext': nameHistoryContext,
            'timePerceptionContext': chat.settings.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
            'weatherContext': weatherContext,
            'timeContext': timeContext,
            'musicContextStr': (typeof musicState.isActive === 'boolean' && musicState.isActive) ? '你们正在一起听歌，' + musicContext : '你们没在听歌，但你有两个音乐工具：change_music（切已有歌）和 add_song_to_playlist（全网易搜歌+自动播放）。\n' + musicContext,
            'readingContextStr': readingContext ? '你们正在一起读书。' + readingContext : '你们没有在读书。',
            'contactsList': contactsList,
            'postsContext': postsContext,
            'groupContext': groupContext,
            'sharedContext': sharedContext,
            'callTranscriptContext': callTranscriptContext,
            'synthMusicInstruction': synthMusicInstruction,
            'narratorInstruction': narratorInstruction,
            'kinshipContext': kinshipContext,
            'coupleSpaceContext': coupleSpaceContext,
            // 宠物屋 (2026-10-23): 让 AI 知道你们一起养了宠物, 以及能怎么照顾它。
            // 没有宠物时这里是空串, 提示词里那一整段自然消失。
            'petNestContext': (window.PetNest && typeof window.PetNest.getCachedContext === 'function')
              ? window.PetNest.getCachedContext()
              : '',
            'bilingualModeContext': bilingualModeContext,
            'thoughtsPrompt': thoughtsPrompt,
            'bilingualAlertText': chat.settings.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '',
            'bilingualAlertVoice': chat.settings.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗（播放时只读外语，但用户可以查看翻译）' : '',
            'novelAiImageContext': novelAiImageContext,
            'googleImagenContext': googleImagenContext,
            'qzoneActionsPrompt': qzoneActionsPrompt,
            'viewMyPhonePrompt': viewMyPhonePrompt,
            'crossChatInstruction': crossChatInstruction,
            'todoInstruction': todoInstruction,
            'stickerContext': stickerContext,
            'aiAvatarLibrary': aiAvatarLibrary,
            'myAvatarLibrary': myAvatarLibrary
          };

          systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMapSingle);

          // 变量记忆移到 system 最前面 (v0.2.30.5+)
          // 原因:之前塞在 "## 3. 你的长期记忆" 下面,被两个"长期记忆"标题夹住,LLM 注意力掉到中后段
          // 改后:独立一级标题放 system 开头,LLM 必读
          if (resolvedMemoryContextForPrompt && resolvedMemoryContextForPrompt.trim()) {
            systemPrompt = '# ⚠️ 你的近期真实记忆 (最高优先级,必须视为亲身经历)\n' + resolvedMemoryContextForPrompt + '\n\n---\n\n' + systemPrompt;
          }

          systemPrompt = processPromptWithSettings(systemPrompt, 'single');

          // 第二阶段: 语音控制协议 (硬编码拼在预设之后, 对自定义 prompt 用户同样生效)
          systemPrompt += buildChatTtsExpressionPromptBlock(chat);

          // 热点日报注入（2026-07-02 新增，替换原豆瓣）：开启时才注入，软提示
          const hotNewsContextSingle = await getHotNewsContextForPrompt(chat);
          if (hotNewsContextSingle) systemPrompt += '\n\n' + hotNewsContextSingle;

          messagesPayload = filteredHistory.map(msg => {
            // 处理系统消息（旁白和系统通知）
            if (msg.role === 'system' && !msg.isHidden) {
              if (msg.type === 'narration') {
                return {
                  role: 'user',
                  content: `(${formatTimestampForHistory(msg.timestamp)}) [旁白] ${msg.content}`
                };
              } else if (msg.type === 'pat_message') {
                return {
                  role: 'user',
                  content: `(${formatTimestampForHistory(msg.timestamp)}) [系统] ${msg.content}`
                };
              }
            }

            if (msg.isHidden && typeof msg.content === 'string' && msg.content.includes('[这是你上一轮的内部思考]')) {
              return null;
            }
            if (msg.isHidden && msg.role === 'system') {


              return {
                role: 'user',
                content: msg.content
              };
            } else if (msg.isHidden) {
              return null;
            }






            if (msg.type === 'offline_text') {
              const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : chat.name;
              let narrativeText = '';


              if (msg.content) {
                narrativeText = msg.content;
              } else {
                const dialogue = msg.dialogue ? `「${msg.dialogue}」` : '';
                const description = msg.description ? `(${msg.description})` : '';
                narrativeText = `${dialogue} ${description}`.trim();
              }


              return {
                role: msg.role,
                content: `(${formatTimestampForHistory(msg.timestamp)}) ${sender}: ${narrativeText}`
              };
            }



            if (msg.role === 'user') {
              const prefix = `(${formatTimestampForHistory(msg.timestamp)}) `;
              let contentStr = '';
              if (Array.isArray(msg.content) && msg.content[0]?.type === 'image_url') {
                return {
                  role: 'user',
                  content: textForUserImageMessageInPrompt(msg, prefix)
                };
              }

              if (msg.quote) {

                const quotedContent = String(msg.quote.content || '').substring(0, 50);

                contentStr += `(回复 ${msg.quote.senderName} 的消息: "${quotedContent}..."): ${msg.content}`;
              } else {

                contentStr += msg.content;
              }
              if (msg.type === 'user_photo') return {
                role: 'user',
                content: `${prefix}[你发送了一张需要AI识别的图片，图片内容是：'${msg.content}']`
              };
              if (msg.type === 'voice_message') return {
                role: 'user',
                content: `${prefix}[你发送了一条语音消息，内容是：'${msg.content}']`
              };
              if (msg.type === 'reddit_share') {
                const rData = msg.redditData;
                return {
                  role: 'user',
                  content: `${prefix}[分享了一个Reddit帖子]\n标题: ${rData.title}\n来自: ${rData.subreddit}\n内容摘要: ${rData.selftext || '[链接/图片]'}`
                };
              }
              if (msg.type === 'transfer') {
                // 用户接收/拒收转账的状态标记 — 已由 chat-input.js handleUserTransferResponse
                // 写入的 hidden system message ("你接受了 X 的转账" / "你拒绝并退还了 X 的转账")
                // 单独传达给 AI; 这里不能再产出 "你向对方发起转账" 的反向提示, 否则 AI 上下文里
                // 会同时存在两条冲突的系统文本 (例: [你于时间戳 xxx 向对方发起了转账: x元, 备注: 已收款])
                // 让 AI 误判用户收款后"又主动发了一笔转账"。
                if (msg.isReceived || msg.isRefund) return null;
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你于时间戳 ${msg.timestamp} 向对方发起了转账: ${msg.amount}元, 备注: ${msg.note}。等待对方处理。]`
                };
              }
              if (msg.type === 'couple_invite') {
                const ciStatus = msg.status === 'accepted' ? '对方已接受' : msg.status === 'rejected' ? '对方已拒绝' : '等待对方确认';
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你向对方发送了情侣空间邀请。状态：${ciStatus}]`
                };
              }
              if (msg.type === 'couple_invite_response') return null;
              if (msg.type === 'waimai_request') return {
                role: 'user',
                content: `${prefix}[系统提示：你于时间戳 ${msg.timestamp} 发起了外卖代付请求，商品是“${msg.productInfo}”，金额是 ${msg.amount} 元。]`
              };
              else if (msg.type === 'gift') {
                const itemsSummary = msg.items.map(item => `${item.name} x${item.quantity}`).join('、 ');
                let recipientSummary = chat.isGroup ? `送给了 ${msg.recipients.map(name => getDisplayNameInGroup(chat, name)).join('、 ')}` : `送给了 ${chat.name}`;
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你 ${recipientSummary}，礼物是：${itemsSummary}]`
                };
              }
              if (msg.type === 'couple_invite_response') return null;
              if (msg.meaning) return {
                role: 'user',
                content: `${prefix}[你发送了一个表情，意思是：'${msg.meaning}']`
              };
              return {
                role: msg.role,
                content: prefix + contentStr
              };
            } else if (msg.role === 'assistant') {
              // 情侣空间响应卡片不需要发给AI
              if (msg.type === 'couple_invite_response') return null;
              let assistantMsgObject = {
                type: msg.type || 'text'
              };
              if (msg.type === 'sticker') {

                assistantMsgObject.meaning = msg.meaning;
              } else if (msg.type === 'transfer') {
                assistantMsgObject.amount = msg.amount;
                assistantMsgObject.note = msg.note;
              } else if (msg.type === 'waimai_request') {
                assistantMsgObject.productInfo = msg.productInfo;
                assistantMsgObject.amount = msg.amount;
              } else {
                if (msg.quote) {
                  assistantMsgObject.quote_reply = {
                    target_sender: msg.quote.senderName,
                    target_content: msg.quote.content,
                    reply_content: msg.content
                  };
                } else {
                  assistantMsgObject.content = msg.content;
                }
              }
              const assistantContent = JSON.stringify([assistantMsgObject]);
              return {
                role: 'assistant',
                content: `(${formatTimestampForHistory(msg.timestamp)}) ${assistantContent}`
              };
            }
            return null;
          }).filter(Boolean);

          // 【修复】喂回历史时把"连续多条 assistant 段"合并成"1 条长 history",
          // body 用 \n 连。M3 看到的是"1 条长 + \n 分段"，能模仿也写多段。
          mergeAdjacentAssistantMessages(messagesPayload);

          if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
            const contextSummaryForApproval = await buildVisibleContextSummary(chat, -10);
            const friendRequestInstruction = {
              role: 'user',
              content: `
        [系统重要指令]
        用户向你发送了好友申请，理由是：“${chat.relationship.applicationReason}”。
        作为参考，这是你们之前的最后一段聊天记录：
        ---
        ${contextSummaryForApproval}
        ---
        请你根据以上所有信息，以及你的人设，使用 friend_request_response 指令，并设置 decision 为 'accept' 或 'reject' 来决定是否通过。
        `
            };
            messagesPayload.push(friendRequestInstruction);
          }
        }
      }

      let isGemini = isGeminiNativeUrl(proxyUrl);
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesPayload)
      const currentApiController = currentAiGenerationController;
      const stopBtn = getStopGenerationButton();
      updateStopGenerationButtonVisibility();

      const mainChatCompletionsUrl = `${proxyUrl.replace(/\/+$/, '')}/chat/completions`;

      // 记录API请求数据
      const requestData = {
        timestamp: Date.now(),
        chatId: chatId,
        chatName: chat.name,
        model: model,
        systemPrompt: systemPrompt,
        messages: isGemini ? messagesPayload : [{
          role: 'system',
          content: systemPrompt
        }, ...messagesPayload],
        temperature: state.globalSettings.apiTemperature || 0.8,
        top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
        presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
        frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0,
        isGemini: isGemini,
        apiUrl: isGemini ? geminiConfig.url : mainChatCompletionsUrl
      };

      let response;
      let responseJsonData = null;
      let aiResponseContent = '';
      let placeholderMessage = null;
      const markRequestFirstChunk = () => markFirstAiChunk(aiRequestState);
      
      // 调试日志：打印发送给API的messages数组
      console.log('[API请求调试] 发送给API的messages数组:', JSON.stringify(messagesPayload, null, 2));
      window.runtimeDiag?.markStart('AI_REQUEST', {
        chatId,
        isGroup: !!chat.isGroup,
        model,
        isGemini
      });
      
      try {
        if (isGemini) {
          response = await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data));
          markFirstAiChunk(aiRequestState);
        } else {
          const enableStreaming = state.globalSettings.enableStreaming === true;
          console.log('流式开关状态:', enableStreaming, '原始值:', state.globalSettings.enableStreaming);
          if (enableStreaming) {
            placeholderMessage = {
              role: 'assistant',
              senderName: chat.name,
              timestamp: Date.now(),
              content: '',
              type: 'text',
              isStreaming: true,
              isTemporary: true,
              status: 'streaming'
            };
            aiRequestState.assistantMessage = placeholderMessage;
            if (window.messageStore) {
              await window.messageStore.addMessageToChat(chat, placeholderMessage);
            } else {
              chat.history.push(placeholderMessage);
            }
            appendMessage(placeholderMessage, chat);

            try {
              aiResponseContent = await fetchStreamingResponse(mainChatCompletionsUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                  model: model,
                  messages: [{
                    role: 'system',
                    content: systemPrompt
                  }, ...messagesPayload],
                  temperature: state.globalSettings.apiTemperature || 0.8,
                  top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
                  presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
                  frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0,
                  stream: true
                }),
                signal: currentApiController.signal
              }, (chunk) => {
                                markRequestFirstChunk();
                console.log('正在处理流式响应 chunk');
                placeholderMessage.content += chunk;
                updateAssistantMessageContent(placeholderMessage.timestamp, placeholderMessage.content);
              }, { onFirstChunk: markRequestFirstChunk });
            } catch (streamError) {
              if (streamError?.name === 'AbortError' || currentApiController?.signal?.aborted || aiRequestState.timedOut || aiRequestState.userAborted) {
                throw streamError;
              }
              console.warn('流式响应失败，回退到常规请求：', streamError);
              response = await fetch(mainChatCompletionsUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                  model: model,
                  messages: [{
                    role: 'system',
                    content: systemPrompt
                  }, ...messagesPayload],
                  temperature: state.globalSettings.apiTemperature || 0.8,
                  top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
                  presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
                  frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0,
                  stream: false
                }),
                signal: currentApiController.signal
              });
            }
          } else {
            console.log('发送非流式请求，stream: false');
            const nonStreamingPayload = {
              model: model,
              messages: [{
                role: 'system',
                content: systemPrompt
              }, ...messagesPayload],
              temperature: state.globalSettings.apiTemperature || 0.8,
              top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
              presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
              frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0,
              stream: false
            };
            response = isMainApiProxyEnabled()
              ? await fetchViaOpenAICompatibleProxy({
                baseUrl: proxyUrl,
                targetPath: '/chat/completions',
                apiKey,
                payload: nonStreamingPayload,
                method: 'POST',
                signal: currentApiController.signal
              })
              : await fetch(mainChatCompletionsUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(nonStreamingPayload),
                signal: currentApiController.signal
              });
          }
        }
      } catch (networkError) {
        if (networkError.name === 'AbortError') {
          if (aiRequestState.timedOut) {
            aiRequestState.errorMessage = AI_TIMEOUT_MESSAGE;
            throw new Error(AI_TIMEOUT_MESSAGE);
          }
          if (aiRequestState.userAborted) {
            aiRequestState.errorMessage = AI_ABORT_MESSAGE;
            console.log('API调用已被用户取消');
            throw new Error(AI_ABORT_MESSAGE);
          }
        }
        aiRequestState.errorMessage = `网络请求失败: ${networkError.message}`;
        aiRuntimeLog('AI_REQUEST_ERROR', { chatId, message: networkError.message, name: networkError.name });
        throw new Error(`网络请求失败: ${networkError.message}`);
      } finally {
        updateStopGenerationButtonVisibility();
      }

      if (!aiResponseContent) {
        if (!response) {
          throw new Error(aiRequestState.errorMessage || 'AI 请求未返回响应');
        }
        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          let errorSummary = errorText;
          try {
            const errorData = JSON.parse(errorText);
            if (errorData?.error?.message) {
              errorSummary = errorData.error.message;
            } else if (errorData?.message) {
              errorSummary = errorData.message;
            }
          } catch (jsonError) {
            // 保持一次读取到的文本摘要
          }
          aiRuntimeLog('AI_RESPONSE_NON_2XX_HANDLED', {
            status: response.status,
            bodyLength: String(errorText || '').length,
            contentType: response.headers.get('Content-Type') || '',
            streamMode: 'non-stream'
          });
          aiRuntimeLog('AI_RESPONSE_STREAM_SKIPPED_FOR_NON_2XX', {
            status: response.status,
            streamMode: 'non-stream'
          });
          throw new Error(`API 返回错误: ${response.status} ${response.statusText} - ${String(errorSummary || '').substring(0, 500)}`);
        }

        if (response) {
          markRequestFirstChunk();
        }

        try {
          markRequestFirstChunk();
          responseJsonData = await response.json();
          console.log('响应解析为 JSON，内容:', responseJsonData);
          aiResponseContent = getGeminiResponseText(responseJsonData);
        } catch (jsonError) {
          // 如果 JSON 解析失败，可能是 SSE 文本，尝试解析为流式响应
          console.warn('JSON 解析失败，尝试解析为 SSE 文本:', jsonError);
          markRequestFirstChunk();
          const responseText = await response.text();
          console.log('响应文本内容:', responseText.substring(0, 200) + '...');
          aiResponseContent = parseSSEText(responseText);
        }
      }

      aiRequestState.success = true;
      window.runtimeDiag?.markEnd('AI_REQUEST', 'AI_REQUEST_DONE', {
        chatId,
        status: response ? response.status : 'streaming',
        hasResponse: !!aiResponseContent
      });

      if (placeholderMessage) {
        if (window.messageStore) {
          await window.messageStore.deleteMessages(chat.id, [placeholderMessage.timestamp]);
        } else {
          const placeholderIndex = chat.history.findIndex(m => m.timestamp === placeholderMessage.timestamp);
          if (placeholderIndex !== -1) {
            chat.history.splice(placeholderIndex, 1);
          }
        }
        const placeholderBubble = document.querySelector(`.message-bubble[data-timestamp="${placeholderMessage.timestamp}"]`);
        if (placeholderBubble) {
          const wrapper = placeholderBubble.closest('.message-wrapper');
          if (wrapper) wrapper.remove();
        }
      }

      // 记录API响应数据
      const responseData = {
        ...requestData,
        responseTimestamp: Date.now(),
        responseData: responseJsonData,
        aiResponseContent: aiResponseContent,
        responseStatus: response ? response.status : null,
        responseStatusText: response ? response.statusText : ''
      };

      // 方案4：只有在全局设置中启用API历史记录时才保存
      if (state.globalSettings.enableApiHistory) {
        // 保存到聊天的API历史中
        if (!chat.apiHistory) {
          chat.apiHistory = [];
        }
        chat.apiHistory.push(responseData);

        // 限制历史记录数量，只保留最近50条
        if (chat.apiHistory.length > 50) {
          chat.apiHistory = chat.apiHistory.slice(-50);
        }
      }

      // 保存到数据库
      await db.chats.put(chat);

      lastRawAiResponse = aiResponseContent;
      lastResponseTimestamps = [];
      chat.history = chat.history.filter(msg => !msg.isTemporary);
      const imageDirective = parseAiImageDirectiveText(aiResponseContent);
      const messagesArray = imageDirective
        ? [imageDirective]
        : hookProactiveWakeInMessages(parseAiResponse(aiResponseContent), chat).map(action =>
            chat.settings.isOfflineMode && action.type === 'text'
              ? { ...action, type: 'offline_text' }
              : action
          );

      let consolidatedMessages = [];
      if (chat.settings.isOfflineMode) {

        let offlineBuffer = {
          content: [],
          dialogue: [],
          description: []
        };

        for (const msgData of messagesArray) {
          if (msgData.type === 'offline_text') {

            if (msgData.content) {
              offlineBuffer.content.push(msgData.content);
            } else {
              if (msgData.dialogue) offlineBuffer.dialogue.push(msgData.dialogue);
              if (msgData.description) offlineBuffer.description.push(msgData.description);
            }
          } else {

            if (offlineBuffer.content.length > 0 || offlineBuffer.dialogue.length > 0 || offlineBuffer.description.length > 0) {
              if (offlineBuffer.content.length > 0) {
                consolidatedMessages.push({
                  type: 'offline_text',
                  content: offlineBuffer.content.join('\n')
                });
              }
              if (offlineBuffer.dialogue.length > 0 || offlineBuffer.description.length > 0) {
                consolidatedMessages.push({
                  type: 'offline_text',
                  dialogue: offlineBuffer.dialogue.join('\n'),
                  description: offlineBuffer.description.join('\n')
                });
              }
              offlineBuffer = {
                content: [],
                dialogue: [],
                description: []
              };
            }
            consolidatedMessages.push(msgData);
          }
        }


        if (offlineBuffer.content.length > 0) {
          consolidatedMessages.push({
            type: 'offline_text',
            content: offlineBuffer.content.join('\n')
          });
        }
        if (offlineBuffer.dialogue.length > 0 || offlineBuffer.description.length > 0) {
          consolidatedMessages.push({
            type: 'offline_text',
            dialogue: offlineBuffer.dialogue.join('\n'),
            description: offlineBuffer.description.join('\n')
          });
        }

      } else {
        consolidatedMessages = messagesArray;
      }




      const isViewingThisChat = document.getElementById('chat-interface-screen').classList.contains('active') && state.activeChatId === chatId;
      let callHasBeenHandled = false;
      let messageTimestamp = Date.now();
      let newMessagesToRender = [];
      let notificationShown = false;
      /** 用于兜底：从本轮的 thought_chain 中取第一个出现的群成员本名，缺 name 时优先用其补全 */
      let lastThoughtChainName = null;

      for (const msgData of consolidatedMessages) {
        normalizeImageMessageTypeForCurrentProvider(msgData, imageProviderRoute);
        normalizeMusicActionMessageType(msgData);
        if (isAiImageInstructionMessage(msgData) && imageProviderRoute.status !== 'ok') {
          await showCustomAlert('生图设置', imageProviderRoute.message);
          continue;
        }

        if (msgData.type === 'thought_chain') {
          if (chat.isGroup && msgData.character_thoughts && typeof msgData.character_thoughts === 'object') {
            const firstKey = Object.keys(msgData.character_thoughts)[0];
            if (firstKey && chat.members && chat.members.some(m => m.originalName === firstKey)) lastThoughtChainName = firstKey;
          }
          continue; // 直接跳过，不执行任何保存操作
        }
        if (chat.settings.enableTts !== false && msgData.type === 'text' && typeof msgData.content === 'string' && msgData.content.trim().startsWith('[V]')) {
          msgData.type = 'voice_message';
          msgData.content = msgData.content.replace('[V]', '').trim();
        }
        // ⚠️ 这里【不要】剥离 [[语音:x]]。
        //   标签必须原样存进 msg.content: 语音条展开的"转文字"要能看到它,
        //   且剥离只允许发生在 tts-audio.js 发 MiniMax 的那一刻。
        if (chat.isGroup && msgData.name && msgData.name === chat.name) {
          console.error(`AI幻觉已被拦截！试图使用群名 ("${chat.name}") 作为角色名。消息内容:`, msgData);
          continue;
        }
        if (!msgData || typeof msgData !== 'object') {
          console.warn("收到了格式不规范的AI指令，已跳过:", msgData);
          continue;
        }
        if (!msgData.type) {
          if (chat.isGroup && msgData.name && msgData.message) {
            msgData.type = 'text';
          } else if (msgData.content) {
            msgData.type = 'text';
          } else {
            console.warn("收到了格式不规范的AI指令（缺少type和content），已跳过:", msgData);
            continue;
          }
        }

        if (msgData.type === 'video_call_response') {
          videoCallState.isAwaitingResponse = false;
          if (msgData.decision === 'accept') {
            startVideoCall();
          } else {
                const aiMessage = {
                  role: 'assistant',
                  content: '对方拒绝了你的视频通话请求。',
                  timestamp: Date.now()
                };
                if (window.messageStore) {
                  await window.messageStore.addMessageToChat(chat, aiMessage);
                } else {
                  chat.history.push(aiMessage);
                  await db.chats.put(chat);
                }
                showScreen('chat-interface-screen');
                renderChatInterface(chatId);
          }
          callHasBeenHandled = true;
          break;
        }

        if (msgData.type === 'voice_call_response') {
          voiceCallState.isAwaitingResponse = false;
          if (msgData.decision === 'accept') {
            startVoiceCall();
          } else {
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的视频通话请求。',
              timestamp: Date.now()
            };
            if (window.messageStore) {
              await window.messageStore.addMessageToChat(chat, aiMessage);
            } else {
              chat.history.push(aiMessage);
              await db.chats.put(chat);
            }
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
          callHasBeenHandled = true;
          break;
        }

        if (msgData.type === 'group_call_response') {
          if (msgData.decision === 'join') {
            const member = chat.members.find(m => m.originalName === msgData.name);
            if (member && !videoCallState.participants.some(p => p.id === member.id)) {
              videoCallState.participants.push(member);
            }
          }
          callHasBeenHandled = true;
          continue;
        }

        if (chat.isGroup && msgData.name && msgData.name === chat.name) {
          console.error(`AI幻觉已被拦截！试图使用群名 ("${chat.name}") 作为角色名。消息内容:`, msgData);
          continue;
        }

        if (chat.isGroup && !msgData.name && msgData.type !== 'narration') {
          if (chat.members && chat.members.length > 0) {
            const fallbackName = lastThoughtChainName && chat.members.some(m => m.originalName === lastThoughtChainName) ? lastThoughtChainName : chat.members[0].originalName;
            msgData.name = fallbackName;
            console.warn(`[群聊兜底] 消息缺少 name，已自动补全为: ${fallbackName}`, msgData);
          } else {
            console.error(`AI幻觉已被拦截！试图在群聊中发送一条没有“name”的消息。消息内容:`, msgData);
            continue;
          }
        }

        // 纠正AI可能返回群昵称而非本名的问题
        if (chat.isGroup && msgData.name) {
          const exactMember = chat.members.find(m => m.originalName === msgData.name);
          if (!exactMember) {
            const nicknameMember = chat.members.find(m => m.groupNickname === msgData.name);
            if (nicknameMember) {
              msgData.name = nicknameMember.originalName;
            }
          }
        }

        let aiMessage = null;
        const currentMessageTimestamp = messageTimestamp++;
        const baseMessage = {
          role: 'assistant',
          senderName: msgData.name || chat.name,
          timestamp: currentMessageTimestamp
        };

        lastResponseTimestamps.push(currentMessageTimestamp);

        switch (msgData.type) {
          case 'add_todo': {
            if (!chat.settings.enableTodoList) continue;

            const todoContent = msgData.content;
            const todoDate = msgData.date || new Date().toISOString().split('T')[0];
            const todoTime = msgData.time || '';
            const todoType = msgData.task_type || '日常';


            const todoStatus = (msgData.status === 'completed') ? 'completed' : 'pending';

            if (todoContent) {
              if (!chat.todoList) chat.todoList = [];

              const newTodo = {
                id: Date.now() + Math.random(),
                content: todoContent,
                date: todoDate,
                time: todoTime,
                type: todoType,

                status: todoStatus, // <--- 这里使用变量

                creator: 'char',
                timestamp: Date.now()
              };

              chat.todoList.push(newTodo);

              // (可选) 如果是已完成的任务，系统提示也可以稍微变一下
              const actionText = todoStatus === 'completed' ? '记录了一条已完成事项' : '为你添加了待办';
              visibleSystemMessage = {
                content: `[${chat.name} ${actionText}: "${todoContent}"]`
              };

              console.log(`AI 添加事项: ${todoContent}, 状态: ${todoStatus}`);
            }
            break;
          }
          case 'narration':
            aiMessage = {
              role: 'system', // 强制设为 system 角色以便居中显示
              type: 'narration',
              content: msgData.content,
              senderName: '旁白',
              timestamp: messageTimestamp++ // 【修复】这里必须用 messageTimestamp
            };
            break;
          case 'synth_music':

            if (!chat.settings.enableSynthMusic) {
              continue;
            }


            aiMessage = {
              ...baseMessage, // 继承基础属性 (role, timestamp等)
              type: 'synth_music',
              // 确保群聊时名字正确 (优先用AI返回的名字)
              senderName: msgData.name || chat.originalName,
              title: msgData.title || '即兴旋律',
              reason: msgData.reason || '',
              instrument: msgData.instrument || 'piano',
              notes: msgData.notes || []
            };


            break;
          case 'buy_item': {
            const itemName = msgData.item_name;
            const price = parseFloat(msgData.price);
            const reason = msgData.reason || '想买';

            if (!itemName || isNaN(price) || price <= 0) continue; // 数据无效跳过

            // 1. 重新获取钱包数据（确保实时性）
            const currentWallet = await db.userWallet.get('main');
            const cardIndex = currentWallet?.kinshipCards?.findIndex(c => c.chatId === chat.id);

            if (cardIndex > -1) {
              const card = currentWallet.kinshipCards[cardIndex];
              const remaining = card.limit - (card.spent || 0);

              if (remaining >= price) {
                // 2. 执行扣款
                currentWallet.kinshipCards[cardIndex].spent = (card.spent || 0) + price;
                await db.userWallet.put(currentWallet);

                // 3. 记录账单
                await db.userTransactions.add({
                  timestamp: Date.now(),
                  type: 'expense',
                  amount: price,
                  description: `亲属卡消费-${chat.name}-${itemName}`
                });

                // 4. 生成系统通知消息 (AI发送的)
                const successMsg = {
                  role: 'assistant', // 或者是 'system'，看你喜好
                  senderName: chat.name, // 加上这个确保群聊显示正常
                  type: 'text', // 或者用 'pat_message' 样式
                  content: `[支付宝通知] 我使用亲属卡消费了 ¥${price.toFixed(2)} 购买了“${itemName}”。\n💭 ${reason}`,
                  timestamp: messageTimestamp++
                };

                chat.history.push(successMsg);

                // 如果是当前查看的聊天，直接上屏
                if (isViewingThisChat) {
                  appendMessage(successMsg, chat);
                } else {
                  // 如果在后台，发送通知
                  showNotification(chat.id, `${chat.name} 使用亲属卡消费了 ¥${price}`);
                }

                // 5. (可选) 将购买记录写入角色的模拟淘宝历史，增加真实感
                if (!chat.simulatedTaobaoHistory) chat.simulatedTaobaoHistory = { totalBalance: 0, purchases: [] };
                if (!chat.simulatedTaobaoHistory.purchases) chat.simulatedTaobaoHistory.purchases = [];

                chat.simulatedTaobaoHistory.purchases.unshift({
                  itemName: itemName,
                  price: price,
                  status: '已签收',
                  reason: reason,
                  image_prompt: `${itemName}, product photography` // 简单生成个prompt
                });

                hasPerformedMajorAction = true; // 标记为已执行重要操作（用于后台活动）
              } else {
                console.log(`AI 想要购买 ${itemName} (¥${price}) 但亲属卡余额不足 (剩 ¥${remaining})`);
                // 可选：让 AI 发一条消息抱怨没钱了
                const failMsg = {
                  role: 'assistant',
                  senderName: chat.name,
                  content: `本来想买“${itemName}”的，但是亲属卡额度好像不够了... (¥${price})`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(failMsg);
                if (isViewingThisChat) appendMessage(failMsg, chat);
              }
            }
            continue;
          }
          case 'kinship_response': {
            // 1. 找到最近的一条 pending 请求
            const requestMsg = chat.history.findLast(m => m.type === 'kinship_request' && m.status === 'pending');

            if (requestMsg) {
              requestMsg.status = (msgData.decision === 'accept') ? 'accepted' : 'rejected';
              const isGrant = requestMsg.requestType === 'grant' || !requestMsg.requestType; // 兼容旧数据

              if (msgData.decision === 'accept') {
                // --- 同意逻辑 ---

                // 只有当是 'grant' (用户送钱) 时，才写入本地钱包额度
                // 如果是 'request' (AI 出钱)，本地钱包其实不需要记录 limit，
                // 因为目前的钱包系统只记录 "用户给别人花的钱"。
                // 但为了显示好看，也可以存进去，但在扣款逻辑里要区分。
                // 这里简单起见，我们都存，但在 UI 上区分显示。

                const wallet = await db.userWallet.get('main');
                if (!wallet.kinshipCards) wallet.kinshipCards = [];

                const existingIndex = wallet.kinshipCards.findIndex(c => c.chatId === chat.id);
                if (existingIndex > -1) {
                  wallet.kinshipCards[existingIndex].limit = requestMsg.limit;
                  wallet.kinshipCards[existingIndex].type = isGrant ? 'out' : 'in'; // 标记方向
                } else {
                  wallet.kinshipCards.push({
                    chatId: chat.id,
                    limit: requestMsg.limit,
                    spent: 0,
                    type: isGrant ? 'out' : 'in' // out=用户出钱, in=AI出钱
                  });
                }
                await db.userWallet.put(wallet);

                // --- 构造 AI 回复 ---
                let defaultReason = "";
                if (isGrant) {
                  defaultReason = "那我就不客气收下啦，谢谢你的礼物~"; // AI 接受馈赠
                } else {
                  defaultReason = "没问题，以后想买什么就买，我养你。"; // AI 同意包养用户
                }

                aiMessage = {
                  ...baseMessage,
                  type: 'text',
                  content: msgData.reason || defaultReason
                };
              } else {
                // --- 拒绝逻辑 ---
                let defaultReason = "";
                if (isGrant) {
                  defaultReason = "不用啦，我自己有钱花，心意领了。"; // AI 拒绝馈赠
                } else {
                  defaultReason = "这...最近手头有点紧，下次吧。"; // AI 拒绝包养
                }

                aiMessage = {
                  ...baseMessage,
                  type: 'text',
                  content: msgData.reason || defaultReason
                };
              }

              await db.chats.put(chat);
              renderChatInterface(chatId);
            }
            break;
          }
          case 'couple_invite_request': {
            if (!chat.settings.enableCoupleSpacePrompt) break;
            
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            const pendingInvite = chat.history.findLast(m => m.type === 'couple_invite' && m.status === 'pending');
            
            if (!hasCoupleSpace && !pendingInvite) {
              const inviteMsg = {
                role: 'assistant',
                type: 'couple_invite',
                status: 'pending',
                senderName: chat.originalName || chat.name,
                timestamp: messageTimestamp++
              };
              chat.history.push(inviteMsg);
              
              if (isViewingThisChat) {
                appendMessage(inviteMsg, chat);
              }
            }
            aiMessage = null;
            break;
          }
          case 'couple_space_unbind': {
            if (!chat.settings.enableCoupleSpacePrompt) break;
            
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            
            if (hasCoupleSpace) {
              const newSpaces = coupleSpaces.filter(s => s.charId !== chatId);
              saveCoupleSpaces(newSpaces);
              
              if (localStorage.getItem('coupleSpaceLastId') === chatId) {
                localStorage.removeItem('coupleSpaceLastId');
              }
              
              const myNickname = chat.settings.myNickname || '我';
              
              const unbindMsg = {
                role: 'system',
                type: 'system_notification',
                content: `[系统提示："${chat.originalName || chat.name}"主动解除了与"${myNickname}"的情侣空间绑定。]`,
                timestamp: messageTimestamp++
              };
              chat.history.push(unbindMsg);
              
              if (isViewingThisChat) {
                appendMessage(unbindMsg, chat);
              }
              
              // 关闭情侣空间UI（如果处于打开状态）
              try {
                if (document.getElementById('couple-space-screen') && document.getElementById('couple-space-screen').classList.contains('active')) {
                  showCoupleSpaceSelect('list');
                }
              } catch(e) {}
            }
            
            aiMessage = null;
            break;
          }
          case 'couple_invite_decision': {
            const pendingInvite = chat.history.findLast(m => m.type === 'couple_invite' && m.status === 'pending');
            if (pendingInvite) {
              const myNickname = chat.settings.myNickname || '我';
              const isAccept = msgData.decision === 'accept';

              // 更新原始邀请卡片状态
              pendingInvite.status = isAccept ? 'accepted' : 'rejected';

              // 添加角色的响应卡片
              const responseCard = {
                role: 'assistant',
                type: 'couple_invite_response',
                decision: isAccept ? 'accept' : 'reject',
                senderName: chat.originalName || chat.name,
                timestamp: Date.now()
              };
              chat.history.push(responseCard);

              // 添加隐藏系统消息作为上下文
              const hiddenMsg = {
                role: 'system',
                content: isAccept
                  ? `[系统提示：${chat.name}接受了${myNickname}的邀请，你们已经开启了情侣空间。]`
                  : `[系统提示：${chat.name}拒绝了${myNickname}的情侣空间邀请。]`,
                timestamp: Date.now() + 1,
                isHidden: true
              };
              chat.history.push(hiddenMsg);

              // 如果接受，创建情侣空间
              if (isAccept) {
                confirmCoupleSpace(chatId);
              }

              await db.chats.put(chat);
              renderChatInterface(chatId);
              renderChatList();
            }
            // 这个类型不产生普通消息，跳过
            aiMessage = null;
            break;
          }
          case 'send_private_message': {
            // 检查跨聊天消息开关
            const enableCrossChat = chat.settings.enableCrossChat !== null
              ? chat.settings.enableCrossChat
              : state.globalSettings.enableCrossChat;
            
            if (enableCrossChat === false) {
              console.log(`[跨聊天消息] 群聊→私聊功能已关闭，已拦截 send_private_message 指令`);
              aiMessage = null;
              continue;
            }

            const senderOriginalName = msgData.name;
            const recipientOriginalName = msgData.recipient;

            const userOriginalName = state.qzoneSettings.nickname || '{{user}}';
            const userNickname = chat.settings.myNickname || '我';

            // 兼容多种写法：接受本名、昵称、"我"、"{{user}}"
            if (recipientOriginalName === userOriginalName || 
                recipientOriginalName === userNickname ||
                recipientOriginalName === '我' ||
                recipientOriginalName === '{{user}}') {

              const privateChat = Object.values(state.chats).find(c =>
                !c.isGroup && c.originalName === senderOriginalName
              );

              if (privateChat) {

                lastPrivateMessagesSent = [];

                const messagesToSend = Array.isArray(msgData.content) ? msgData.content : [msgData.content];
                let newMessagesCount = 0;

                for (const contentString of messagesToSend) {
                  if (!contentString || !contentString.trim()) continue;

                  const privateMessage = {
                    role: 'assistant',
                    senderName: senderOriginalName,
                    content: contentString,
                    timestamp: messageTimestamp++
                  };


                  lastPrivateMessagesSent.push({
                    chatId: privateChat.id,
                    timestamp: privateMessage.timestamp
                  });

                  privateChat.history.push(privateMessage);
                  newMessagesCount++;
                }

                if (newMessagesCount > 0) {
                  if (state.activeChatId !== privateChat.id) {
                    privateChat.unreadCount = (privateChat.unreadCount || 0) + newMessagesCount;
                    showNotification(privateChat.id, `${privateChat.name} 发来了 ${newMessagesCount} 条新消息`);
                  }
                  await db.chats.put(privateChat);
                }

                aiMessage = null;

              } else {
                console.warn(`AI ${senderOriginalName} 尝试发送私信，但未找到其对应的私聊会话。`);
                aiMessage = null;
              }
            } else {
              console.warn(`AI 尝试发送私信给非用户角色 (${recipientOriginalName})，此功能暂不支持。`);
              aiMessage = null;
            }

            continue;
          }
          case 'send_group_message': {
            // 检查跨聊天消息开关
            const enableCrossChat = chat.settings.enableCrossChat !== null
              ? chat.settings.enableCrossChat
              : state.globalSettings.enableCrossChat;
            
            if (enableCrossChat === false) {
              console.log(`[跨聊天消息] 私聊→群聊功能已关闭，已拦截 send_group_message 指令`);
              aiMessage = null;
              continue;
            }

            // 这是从私聊 -> 群聊 的新功能
            const senderOriginalName = msgData.name || chat.originalName; // 'chat' 是当前的私聊
            const targetGroupName = msgData.targetGroupName;
            const messagesToSend = Array.isArray(msgData.content) ? msgData.content : [String(msgData.content)];

            if (!targetGroupName) {
              console.warn(`AI ${senderOriginalName} 尝试发送群聊消息，但未指定 targetGroupName。`);
              continue;
            }

            // 1. 查找目标群聊，并确保AI是该群的成员
            const targetGroupChat = Object.values(state.chats).find(c =>
              c.isGroup &&
              c.name === targetGroupName &&
              c.members.some(m => m.originalName === senderOriginalName)
            );

            if (targetGroupChat) {
              // 2. 找到了群聊，准备发送消息
              let newMessagesCount = 0;
              for (const contentString of messagesToSend) {
                if (!contentString || !contentString.trim()) continue;

                // 3. 创建一个标准群聊AI消息
                const groupMessage = {
                  role: 'assistant',
                  senderName: senderOriginalName, // AI的本名
                  content: contentString,
                  timestamp: messageTimestamp++ // 使用主循环的时间戳
                };

                // 4. 将消息添加到目标群聊的历史记录中
                targetGroupChat.history.push(groupMessage);
                newMessagesCount++;
              }

              if (newMessagesCount > 0) {
                // 5. 更新群聊的未读状态和通知
                if (state.activeChatId !== targetGroupChat.id) {
                  targetGroupChat.unreadCount = (targetGroupChat.unreadCount || 0) + newMessagesCount;

                  // 为了通知，获取AI在该群的群昵称
                  const member = targetGroupChat.members.find(m => m.originalName === senderOriginalName);
                  const senderDisplayName = member ? member.groupNickname : senderOriginalName;

                  showNotification(targetGroupChat.id, `${senderDisplayName}: ${messagesToSend[0]}`);
                }

                // 6. 保存对 *目标群聊* 的更改
                await db.chats.put(targetGroupChat);
                state.chats[targetGroupChat.id] = targetGroupChat; // 确保内存状态也更新
              }

              // 7. 这条消息不应显示在当前的私聊中，所以设置 aiMessage 为 null
              aiMessage = null;

            } else {
              console.warn(`AI ${senderOriginalName} 尝试向一个不存在的或TA不在的群聊 "${targetGroupName}" 发送消息。`);
              // (可选) 可以在私聊中生成一条 "发送失败" 的消息，但目前保持安静
              aiMessage = null;
            }

            continue; // 继续处理下一条指令
          }
          case 'view_myphone':
            // 处理查看User手机的请求
            if (!chat.isGroup && msgData.apps) {
              const userChat = state.chats[chatId]; // 当前聊天就是User的角色
              let appsToView = Array.isArray(msgData.apps) ? msgData.apps : [msgData.apps];

              // 如果包含"all"，则查看所有APP
              if (appsToView.includes('all')) {
                appsToView = ['qq', 'album', 'taobao', 'amap', 'browser', 'memo', 'diary', 'music', 'app_usage'];
              }

              let viewResults = [];

              // 遍历要查看的APP
              for (const app of appsToView) {
                let appData = null;
                let appName = '';

                switch (app) {
                  case 'qq':
                    appName = 'QQ';
                    appData = userChat.myPhoneSimulatedQQConversations || [];
                    if (appData.length > 0) {
                      const qqSummary = appData.slice(0, 5).map(conv => {
                        const latestMsg = conv.messages && conv.messages.length > 0
                          ? conv.messages[conv.messages.length - 1]
                          : null;
                        return `- ${conv.name}: ${latestMsg ? latestMsg.content.substring(0, 30) + '...' : '暂无消息'}`;
                      }).join('\n');
                      viewResults.push(`**QQ聊天列表** (共${appData.length}个联系人):\n${qqSummary}`);
                    } else {
                      viewResults.push(`**QQ聊天列表**: 空的`);
                    }
                    break;

                  case 'album':
                    appName = '相册';
                    appData = userChat.myPhoneAlbum || [];
                    if (appData.length > 0) {
                      const albumSummary = appData.slice(0, 5).map(photo =>
                        `- ${new Date(photo.timestamp).toLocaleString()}: ${photo.description || '无描述'}`
                      ).join('\n');
                      viewResults.push(`**相册** (共${appData.length}张照片):\n${albumSummary}`);
                    } else {
                      viewResults.push(`**相册**: 空的`);
                    }
                    break;

                  case 'taobao':
                    appName = '淘宝';
                    appData = userChat.myPhoneTaobaoHistory || [];
                    if (appData.length > 0) {
                      const taobaoSummary = appData.slice(0, 5).map(order =>
                        `- ${order.productName}: ¥${order.price} (${order.status})`
                      ).join('\n');
                      viewResults.push(`**淘宝订单** (共${appData.length}个订单):\n${taobaoSummary}`);
                    } else {
                      viewResults.push(`**淘宝订单**: 空的`);
                    }
                    break;

                  case 'amap':
                    appName = '高德地图';
                    appData = userChat.myPhoneAmapHistory || [];
                    if (appData.length > 0) {
                      const amapSummary = appData.slice(0, 5).map(record =>
                        `- ${new Date(record.timestamp).toLocaleString()}: ${record.location}`
                      ).join('\n');
                      viewResults.push(`**高德地图足迹** (共${appData.length}条记录):\n${amapSummary}`);
                    } else {
                      viewResults.push(`**高德地图足迹**: 空的`);
                    }
                    break;

                  case 'browser':
                    appName = '浏览器';
                    appData = userChat.myPhoneBrowserHistory || [];
                    if (appData.length > 0) {
                      const browserSummary = appData.slice(0, 5).map(record =>
                        `- ${new Date(record.timestamp).toLocaleString()}: ${record.title}`
                      ).join('\n');
                      viewResults.push(`**浏览器历史** (共${appData.length}条记录):\n${browserSummary}`);
                    } else {
                      viewResults.push(`**浏览器历史**: 空的`);
                    }
                    break;

                  case 'memo':
                    appName = '备忘录';
                    appData = userChat.myPhoneMemos || [];
                    if (appData.length > 0) {
                      const memoSummary = appData.slice(0, 5).map(memo =>
                        `- ${memo.title || '无标题'}: ${memo.content.substring(0, 30)}...`
                      ).join('\n');
                      viewResults.push(`**备忘录** (共${appData.length}条):\n${memoSummary}`);
                    } else {
                      viewResults.push(`**备忘录**: 空的`);
                    }
                    break;

                  case 'diary':
                    appName = '日记';
                    appData = userChat.myPhoneDiaries || [];
                    if (appData.length > 0) {
                      const diarySummary = appData.slice(0, 3).map(diary =>
                        `- ${diary.date}: ${diary.content.substring(0, 50)}...`
                      ).join('\n');
                      viewResults.push(`**日记** (共${appData.length}篇):\n${diarySummary}`);
                    } else {
                      viewResults.push(`**日记**: 空的`);
                    }
                    break;

                  case 'music':
                    appName = '网易云音乐';
                    appData = userChat.myPhoneMusicPlaylist || [];
                    if (appData.length > 0) {
                      const musicSummary = appData.slice(0, 5).map(song =>
                        `- ${song.title} - ${song.artist}`
                      ).join('\n');
                      viewResults.push(`**网易云音乐播放列表** (共${appData.length}首歌):\n${musicSummary}`);
                    } else {
                      viewResults.push(`**网易云音乐播放列表**: 空的`);
                    }
                    break;

                  case 'app_usage':
                    appName = 'APP使用记录';
                    appData = userChat.myPhoneAppUsage || [];
                    if (appData.length > 0) {
                      const usageSummary = appData.slice(0, 5).map(record => {
                        const hours = Math.floor(record.usageTimeMinutes / 60);
                        const minutes = record.usageTimeMinutes % 60;
                        let timeString = '';
                        if (hours > 0) timeString += `${hours}小时`;
                        if (minutes > 0) timeString += `${minutes}分钟`;
                        if (!timeString) timeString = '小于1分钟';
                        return `- ${record.appName} (${record.category || '其他'}): ${timeString}`;
                      }).join('\n');
                      viewResults.push(`**APP使用记录** (共${appData.length}条):\n${usageSummary}`);
                    } else {
                      viewResults.push(`**APP使用记录**: 空的`);
                    }
                    break;
                }
              }

              // 将查看结果作为隐藏的系统消息注入到对话中
              const viewResultMessage = {
                role: 'system',
                content: `[系统提示：你查看了${chat.settings.myNickname || '用户'}的手机，以下是真实数据]\n\n${viewResults.join('\n\n')}\n\n[请基于以上真实数据给出你的感想和反应，不要编造内容]`,
                timestamp: Date.now(),
                isHidden: true
              };

              chat.history.push(viewResultMessage);
              console.log(`📱 AI查看了User手机: ${appsToView.join(', ')}`);
            }
            continue;
          case 'update_thoughts':
            if (!chat.isGroup) {
              if (msgData.heartfelt_voice) {
                chat.heartfeltVoice = String(msgData.heartfelt_voice);
              }
              if (msgData.random_jottings) {
                chat.randomJottings = String(msgData.random_jottings);
              }
              
              // 动态收集自定义心声变量
              if (!chat.customThoughts) {
                chat.customThoughts = {};
              }
              for (const key in msgData) {
                if (key !== 'type' && key !== 'heartfelt_voice' && key !== 'random_jottings') {
                  chat.customThoughts[key] = String(msgData[key]);
                }
              }

              if (!Array.isArray(chat.thoughtsHistory)) {
                chat.thoughtsHistory = [];
              }
              
              const currentThought = {
                heartfeltVoice: chat.heartfeltVoice,
                randomJottings: chat.randomJottings,
                customThoughts: JSON.parse(JSON.stringify(chat.customThoughts)),
                timestamp: Date.now()
              };
              
              chat.thoughtsHistory.push(currentThought);
              if (chat.thoughtsHistory.length > 50) {
                chat.thoughtsHistory.shift();
              }

              let thoughtForMemory = `[这是你上一轮的内心独白和思考]
- 心声: ${chat.heartfeltVoice}
- 散记: ${chat.randomJottings}`;

              // 将自定义心声也加入记忆中
              if (chat.customThoughts && Object.keys(chat.customThoughts).length > 0) {
                for (const [key, value] of Object.entries(chat.customThoughts)) {
                  thoughtForMemory += `\n- ${key}: ${value}`;
                }
              }

              const hiddenThoughtMessage = {
                role: 'system',
                content: thoughtForMemory,
                timestamp: Date.now(),
                isHidden: true
              };

            }
            continue;
          case 'change_user_nickname':
            if (!chat.isGroup && msgData.new_name) {
              const newNickname = msgData.new_name.trim();
              if (newNickname) {
                chat.settings.myNickname = newNickname;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `“${chat.name}” 将对你的称呼修改为 “${newNickname}”`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                const hiddenMemoryMessage = {
                  role: 'system',
                  content: `[系统提示：你刚刚成功将对用户的称呼修改为了“${newNickname}”。]`,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMemoryMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                }
              }
            }
            continue;
          case 'change_remark_name':
            if (!chat.isGroup && msgData.new_name) {
              const oldName = chat.name;
              const newName = msgData.new_name.trim();

              if (newName && newName !== oldName) {
                if (!chat.nameHistory) {
                  chat.nameHistory = [];
                }
                if (!chat.nameHistory.includes(oldName)) {
                  chat.nameHistory.push(oldName);
                }

                chat.name = newName;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `“${chat.originalName}” 将备注修改为 “${newName}”`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                const hiddenMemoryMessage = {
                  role: 'system',
                  content: `[系统提示：你刚刚成功将自己的备注名修改为了“${newName}”。请自然地接受这个新名字，不要对此感到惊讶。]`,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMemoryMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                  document.getElementById('chat-header-title').textContent = newName;
                }

                await syncCharacterNameInGroups(chat);
              }
            }
            continue;

          case 'change_avatar': {
            const avatarName = msgData.name;
            const foundAvatar = chat.settings.aiAvatarLibrary.find(avatar => avatar.name === avatarName);
            if (foundAvatar) {
              chat.settings.aiAvatar = foundAvatar.url;

              const systemNotice = {
                role: 'system',
                type: 'pat_message',
                content: `[${chat.name} 更换了头像]`,
                timestamp: Date.now()
              };
              chat.history.push(systemNotice);

              await syncCharacterAvatarInGroups(chat);

              if (isViewingThisChat) {
                appendMessage(systemNotice, chat);
                renderChatInterface(chatId);
              }
            }
            continue;
          }
          case 'change_user_avatar': {
            const avatarName = msgData.name;
            const foundAvatar = chat.settings.myAvatarLibrary.find(avatar => avatar.name === avatarName);
            if (foundAvatar) {
              chat.settings.myAvatar = foundAvatar.url;

              const systemNotice = {
                role: 'system',
                type: 'pat_message',
                content: `[${chat.name} 更换了你的头像]`,
                timestamp: Date.now()
              };
              chat.history.push(systemNotice);

              if (isViewingThisChat) {
                appendMessage(systemNotice, chat);
                renderChatInterface(chatId);
              }
            }
            continue;
          }

          case 'waimai_response':
            const requestMessageIndex = chat.history.findIndex(m => m.timestamp === msgData.for_timestamp);
            if (requestMessageIndex > -1) {
              const originalMsg = chat.history[requestMessageIndex];
              originalMsg.status = msgData.status;
              originalMsg.paidBy = msgData.status === 'paid' ? msgData.name : null;
            }
            continue;

          case 'qzone_post':
            const newPost = {
              type: msgData.postType || 'shuoshuo',
              content: msgData.content || '',
              publicText: msgData.publicText || '',
              hiddenContent: msgData.hiddenContent || '',
              image_prompt: msgData.image_prompt || '',
              timestamp: Date.now(),
              authorId: chatId,
              authorGroupId: chat.groupId,
              visibleGroupIds: null
            };



            if (msgData.postType === 'naiimag' && msgData.prompt) {
              try {

                const prompts = Array.isArray(msgData.prompt) ? msgData.prompt.slice(0, 2) : [msgData.prompt];
                console.log(`📸 动态NovelAI图片生成开始，共${prompts.length}张图片`);


                const generatedImageUrls = [];


                for (let i = 0; i < prompts.length; i++) {
                  const aiPrompt = prompts[i];
                  console.log(`生成第${i + 1}张图片，prompt:`, aiPrompt);


                  const naiPrompts = getCharacterNAIPrompts(chat.id);


                  const finalPositivePrompt = aiPrompt + ', ' + naiPrompts.positive;
                  const finalNegativePrompt = naiPrompts.negative;

                  console.log(`📝 使用${naiPrompts.source === 'character' ? '角色专属' : '系统'}提示词配置`);
                  console.log('最终正面提示词:', finalPositivePrompt);
                  console.log('最终负面提示词:', finalNegativePrompt);


                  const apiKey = localStorage.getItem('novelai-api-key');
                  const model = localStorage.getItem('novelai-model') || 'nai-diffusion-4-5-full';
                  const settings = getNovelAISettings();

                  if (!apiKey) {
                    throw new Error('NovelAI API Key未配置。请在NovelAI设置中填写API Key。');
                  }

                  const [width, height] = settings.resolution.split('x').map(Number);


                  let requestBody;

                  if (model.includes('nai-diffusion-4')) {

                    requestBody = {
                      input: finalPositivePrompt,
                      model: model,
                      action: 'generate',
                      parameters: {
                        params_version: 3, // V4必须使用版本3
                        width: width,
                        height: height,
                        scale: settings.cfg_scale,
                        sampler: settings.sampler,
                        steps: settings.steps,
                        seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                        n_samples: 1,
                        ucPreset: settings.uc_preset,
                        qualityToggle: settings.quality_toggle,
                        autoSmea: false,
                        dynamic_thresholding: false,
                        controlnet_strength: 1,
                        legacy: false,
                        add_original_image: true,
                        cfg_rescale: 0,
                        noise_schedule: 'karras', // V4使用karras
                        legacy_v3_extend: false,
                        skip_cfg_above_sigma: null,
                        use_coords: false,
                        legacy_uc: false,
                        normalize_reference_strength_multiple: true,
                        inpaintImg2ImgStrength: 1,
                        characterPrompts: [],

                        v4_prompt: {
                          caption: {
                            base_caption: finalPositivePrompt,
                            char_captions: []
                          },
                          use_coords: false,
                          use_order: true
                        },

                        v4_negative_prompt: {
                          caption: {
                            base_caption: finalNegativePrompt,
                            char_captions: []
                          },
                          legacy_uc: false
                        },
                        negative_prompt: finalNegativePrompt,
                        deliberate_euler_ancestral_bug: false,
                        prefer_brownian: true

                      }
                    };
                  } else {

                    requestBody = {
                      input: finalPositivePrompt,
                      model: model,
                      action: 'generate',
                      parameters: {
                        width: width,
                        height: height,
                        scale: settings.cfg_scale,
                        sampler: settings.sampler,
                        steps: settings.steps,
                        seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                        n_samples: 1,
                        ucPreset: settings.uc_preset,
                        qualityToggle: settings.quality_toggle,
                        sm: settings.smea,
                        sm_dyn: settings.smea_dyn,
                        dynamic_thresholding: false,
                        controlnet_strength: 1,
                        legacy: false,
                        add_original_image: false,
                        cfg_rescale: 0,
                        noise_schedule: 'native',
                        negative_prompt: finalNegativePrompt
                      }
                    };
                  }

                  console.log('🚀 发送NAI请求:', requestBody);


                  let apiUrl;


                  if (model.includes('nai-diffusion-4')) {

                    apiUrl = 'https://image.novelai.net/ai/generate-image-stream';
                  } else {

                    apiUrl = 'https://image.novelai.net/ai/generate-image';
                  }

                  let corsProxy = settings.cors_proxy;


                  if (corsProxy === 'custom') {
                    corsProxy = settings.custom_proxy_url || '';
                  }


                  if (corsProxy && corsProxy !== '') {
                    apiUrl = corsProxy + encodeURIComponent(apiUrl);
                  }

                  const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': 'Bearer ' + apiKey
                    },
                    body: JSON.stringify(requestBody)
                  });

                  console.log('Response status:', response.status);
                  console.log('Response headers:', [...response.headers.entries()]);

                  if (!response.ok) {
                    const errorText = await response.text();
                    console.error('API错误响应:', errorText);
                    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
                  }


                  const contentType = response.headers.get('content-type');
                  console.log('Content-Type:', contentType);


                  let zipBlob;
                  let imageDataUrl;
                  if (contentType && contentType.includes('text/event-stream')) {
                    console.log('检测到 SSE 流式响应，开始解析...');


                    const text = await response.text();
                    console.log('收到 SSE 数据，大小:', text.length);


                    const lines = text.trim().split('\n');
                    let base64Data = null;

                    for (let i = lines.length - 1; i >= 0; i--) {
                      const line = lines[i].trim();
                      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        const dataContent = line.substring(6);


                        try {
                          const jsonData = JSON.parse(dataContent);


                          if (jsonData.event_type === 'final' && jsonData.image) {
                            base64Data = jsonData.image;
                            console.log('✅ 找到 final 事件的图片数据');
                            break;
                          }


                          if (jsonData.data) {
                            base64Data = jsonData.data;
                            console.log('从 JSON.data 中提取图片数据');
                            break;
                          }
                          if (jsonData.image) {
                            base64Data = jsonData.image;
                            console.log('从 JSON.image 中提取图片数据');
                            break;
                          }
                        } catch (e) {

                          base64Data = dataContent;
                          console.log('直接使用 base64 数据');
                          break;
                        }
                      }
                    }

                    if (!base64Data) {
                      throw new Error('无法从 SSE 响应中提取图片数据');
                    }


                    const isPNG = base64Data.startsWith('iVBORw0KGgo');
                    const isJPEG = base64Data.startsWith('/9j/');

                    if (isPNG || isJPEG) {
                      console.log('✅ 检测到直接的图片 base64 数据 (PNG/JPEG)');

                      const binaryString = atob(base64Data);
                      const bytes = new Uint8Array(binaryString.length);
                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }
                      const imageBlob = new Blob([bytes], {
                        type: isPNG ? 'image/png' : 'image/jpeg'
                      });
                      console.log('图片 Blob 创建成功，大小:', imageBlob.size);


                      const reader = new FileReader();
                      imageDataUrl = await new Promise((resolve, reject) => {
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(imageBlob);
                      });
                      console.log('✅ 图片转换成功！🎨');
                    } else {

                      console.log('当作 ZIP 文件处理...');
                      const binaryString = atob(base64Data);
                      const bytes = new Uint8Array(binaryString.length);
                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }
                      zipBlob = new Blob([bytes]);
                      console.log('ZIP Blob 大小:', zipBlob.size);
                    }
                  } else {

                    zipBlob = await response.blob();
                    console.log('收到数据，类型:', zipBlob.type, '大小:', zipBlob.size);
                  }


                  if (!imageDataUrl && zipBlob) {

                    try {

                      if (typeof JSZip === 'undefined') {
                        throw new Error('JSZip库未加载，请刷新页面重试');
                      }


                      const zip = await JSZip.loadAsync(zipBlob);
                      console.log('ZIP文件内容:', Object.keys(zip.files));


                      let imageFile = null;
                      for (let filename in zip.files) {
                        if (filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
                          imageFile = zip.files[filename];
                          console.log('找到图片文件:', filename);
                          break;
                        }
                      }

                      if (!imageFile) {
                        throw new Error('ZIP文件中未找到图片');
                      }


                      const imageBlob = await imageFile.async('blob');
                      console.log('提取的图片大小:', imageBlob.size);


                      const reader = new FileReader();
                      imageDataUrl = await new Promise((resolve, reject) => {
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(imageBlob);
                      });
                      console.log('✅ 图片解压成功！');
                    } catch (zipError) {
                      console.error('ZIP解压失败:', zipError);
                      throw new Error('图片解压失败: ' + zipError.message);
                    }
                  }

                  console.log(`✅ NAI图片${i + 1}生成成功！`);
                  generatedImageUrls.push(imageDataUrl);
                }


                newPost.imageUrls = generatedImageUrls;

                if (generatedImageUrls.length === 1) {
                  newPost.imageUrl = generatedImageUrls[0];
                }

                newPost.prompt = msgData.prompt;
                newPost.imageCount = generatedImageUrls.length;
                console.log(`✅ 动态NovelAI图片全部生成完成: ${generatedImageUrls.length}张`);
              } catch (error) {
                console.error('❌ 动态NAI图片生成失败:', error);

                newPost.content = (newPost.content || newPost.publicText || '') + `\n[图片生成失败: ${error.message}]`;
              }
            }

            // Google Imagen 动态图片生成
            if (msgData.postType === 'googleimag' && msgData.prompt) {
              try {
                const googlePrompt = msgData.prompt || 'a beautiful scene';
                console.log(`📸 动态Google Imagen图片生成开始，prompt:`, googlePrompt);

                const googleResult = await generateGoogleImagenFromPrompt(googlePrompt);
                newPost.imageUrls = [googleResult.imageUrl];
                newPost.imageUrl = googleResult.imageUrl;
                newPost.prompt = googlePrompt;
                newPost.imageCount = 1;
                console.log(`✅ 动态Google Imagen图片生成完成`);
              } catch (error) {
                console.error('❌ 动态Google Imagen图片生成失败:', error);
                newPost.content = (newPost.content || newPost.publicText || '') + `\n[Google Imagen图片生成失败: ${error.message}]`;
              }
            }

            await db.qzonePosts.add(newPost);
            updateUnreadIndicator(unreadPostsCount + 1);
            if (isViewingThisChat && document.getElementById('qzone-screen').classList.contains('active')) {
              await renderQzonePosts();
            }
            continue;

          case 'qzone_comment': {
            const postToComment = await db.qzonePosts.get(parseInt(msgData.postId));
            if (postToComment) {
              if (!postToComment.comments) postToComment.comments = [];

              // 防御：如果模型错误地填了用户的名字，强制纠正为角色本名
              const userNickname = state.qzoneSettings?.nickname;
              let commenterName = msgData.name || chat.originalName;
              if (userNickname && commenterName === userNickname) {
                console.warn(`[动态防御] 角色 "${chat.originalName}" 试图用用户名字 "${userNickname}" 评论，已纠正`);
                commenterName = chat.originalName;
              }
              const createCommentObject = (text, meaning = null, replyTo = null) => ({
                commenterName,
                text: processMentions(text, chat),
                meaning,
                replyTo,
                timestamp: Date.now()
              });

              if (msgData.stickerMeaning) {
                const sticker = state.userStickers.find(s => s.name === msgData.stickerMeaning);
                if (sticker) {
                  postToComment.comments.push(createCommentObject(sticker.url, sticker.name, msgData.replyTo || null));
                } else {
                  console.warn(`AI 尝试评论一个不存在的表情: "${msgData.stickerMeaning}"`);
                  postToComment.comments.push(createCommentObject(`[表情: ${msgData.stickerMeaning}]`, null, msgData.replyTo || null));
                }
              } else if (Array.isArray(msgData.comments)) {
                msgData.comments.forEach(commentText => {
                  if (typeof commentText === 'string' && commentText.trim()) {
                    postToComment.comments.push(createCommentObject(commentText, null, msgData.replyTo || null));
                  }
                });
              } else if (typeof msgData.commentText === 'string' && msgData.commentText.trim()) {
                postToComment.comments.push(createCommentObject(msgData.commentText, null, msgData.replyTo || null));
              }

              await db.qzonePosts.update(postToComment.id, {
                comments: postToComment.comments
              });
              updateUnreadIndicator(unreadPostsCount + 1);
              console.log(`后台活动: 角色 "${chat.name}" 评论了动态 #${msgData.postId}`);

              if (!chat.commentCooldowns) chat.commentCooldowns = {};
              chat.commentCooldowns[msgData.postId] = Date.now();
            }
            continue;
          }
          case 'qzone_like':
            const postToLike = await db.qzonePosts.get(parseInt(msgData.postId));
            if (postToLike) {
              if (!postToLike.likes) postToLike.likes = [];
              if (!postToLike.likes.includes(chat.name)) {
                postToLike.likes.push(chat.name);
                await db.qzonePosts.update(postToLike.id, {
                  likes: postToLike.likes
                });
                updateUnreadIndicator(unreadPostsCount + 1);
                if (isViewingThisChat && document.getElementById('qzone-screen').classList.contains('active')) {
                  await renderQzonePosts();
                }
              }
            }
            continue;
          case 'repost': {
            const originalPost = await db.qzonePosts.get(parseInt(msgData.postId));
            if (originalPost) {
              const newPost = {
                type: 'repost',
                timestamp: Date.now(),
                authorId: chatId,
                authorGroupId: chat.groupId,
                repostComment: msgData.comment || '',
                originalPost: originalPost,
                visibleGroupIds: null
              };
              await db.qzonePosts.add(newPost);
              updateUnreadIndicator(unreadPostsCount + 1);
              console.log(`后台活动: 角色 "${chat.name}" 转发了动态 #${msgData.postId}`);
            }
            continue;
          }
          case 'video_call_request':
            if (!videoCallState.isActive && !videoCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              videoCallState.activeChatId = chatId;
              videoCallState.isAwaitingResponse = true;
              videoCallState.isGroupCall = chat.isGroup;
              videoCallState.callRequester = msgData.name || chat.name;
              showIncomingCallModal('video', chat);
            }
            continue;
          case 'voice_call_request':
            if (!voiceCallState.isActive && !voiceCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              voiceCallState.activeChatId = chatId;
              voiceCallState.isAwaitingResponse = true;
              voiceCallState.isGroupCall = chat.isGroup;
              voiceCallState.callRequester = msgData.name || chat.name;
              showIncomingCallModal('voice', chat);
            }
            continue;
          case 'group_call_request':
            if (!videoCallState.isActive && !videoCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              videoCallState.isAwaitingResponse = true;
              videoCallState.isGroupCall = true;
              videoCallState.initiator = 'ai';
              videoCallState.callRequester = msgData.name;
              showIncomingCallModal('video', chat);
            }
            continue;
          case 'group_voice_request':
            if (!voiceCallState.isActive && !voiceCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              voiceCallState.isAwaitingResponse = true;
              voiceCallState.isGroupCall = true;
              voiceCallState.initiator = 'ai';
              voiceCallState.callRequester = msgData.name;
              showIncomingCallModal('voice', chat);
            }
            continue;
          case 'pet_action':
            // 宠物屋 (2026-10-23): AI 照顾你们一起养的宠物。
            // feed=喂食 / play=陪玩 / comfort=摸摸，扣的是和用户同一个粮仓。
            // 收据不进气泡（聊天里不会多出一条奇怪的消息），
            // 而是通过下一轮的【当前小窝状态】回灌给 AI，让它知道自己刚做了什么。
            if (window.PetNest && typeof window.PetNest.handlePetAction === 'function') {
              try {
                await window.PetNest.handlePetAction(msgData, chat);
              } catch (petActionError) {
                console.warn('[pet_action] 执行失败:', petActionError);
              }
            }
            continue;
          case 'pat_user':
            let patterName;
            if (chat.isGroup) {
              const member = chat.members.find(m => m.originalName === msgData.name);
              patterName = member ? member.groupNickname : msgData.name;
            } else {
              patterName = chat.name;
            }
            const suffix = msgData.suffix ? ` ${msgData.suffix.trim()}` : '';
            const patText = `${patterName} 拍了拍我${suffix}`;

            const patMessage = {
              role: 'system',
              type: 'pat_message',
              content: patText,
              timestamp: Date.now()
            };
            chat.history.push(patMessage);
            if (isViewingThisChat) {
              const phoneScreen = document.getElementById('phone-screen');
              phoneScreen.classList.remove('pat-animation');
              void phoneScreen.offsetWidth;
              phoneScreen.classList.add('pat-animation');
              setTimeout(() => phoneScreen.classList.remove('pat-animation'), 500);
              appendMessage(patMessage, chat);
            } else {
              showNotification(chatId, patText);
            }
            continue;
          case 'update_status':
            chat.status.text = msgData.status_text;
            chat.status.isBusy = msgData.is_busy || false;
            chat.status.lastUpdate = Date.now();
            const statusUpdateMessage = {
              role: 'system',
              type: 'pat_message',
              content: `[${chat.name}的状态已更新为: ${msgData.status_text}]`,
              timestamp: Date.now()
            };
            chat.history.push(statusUpdateMessage);
            if (isViewingThisChat) {
              appendMessage(statusUpdateMessage, chat);
            }
            renderChatList();
            continue;
          case 'location_share':
            aiMessage = {
              ...baseMessage,
              type: 'location_share',
              content: msgData.content
            };
            break;
          case 'change_music':
            if (musicState.isActive && musicState.activeChatId === chatId) {
              const songNameFromAI = msgData.song_name || msgData.song || msgData.keyword || msgData.name;
              const artistNameFromAI = msgData.artist || msgData.artist_name || msgData.singer || '';

              if (typeof songNameFromAI === 'string' && songNameFromAI.trim()) {
                const songNameToFind = songNameFromAI.replace(/^\[?\d+\]?[\s.-]*/, '').trim();
                const targetSongIndex = findBestMusicTrackIndex(musicState.playlist, songNameToFind, artistNameFromAI);

                if (targetSongIndex > -1) {
                  await playSong(targetSongIndex);
                  const track = musicState.playlist[targetSongIndex];

                  let changerName;
                  if (chat.isGroup) {
                    const member = chat.members.find(m => m.originalName === msgData.name);
                    changerName = member ? member.groupNickname : msgData.name;
                  } else {
                    changerName = chat.name;
                  }

                  const musicChangeMessage = {
                    role: 'system',
                    type: 'pat_message',
                    content: `[♪ ${changerName} 为你切歌: 《${track.name}》- ${track.artist}]`,
                    timestamp: Date.now()
                  };
                  chat.history.push(musicChangeMessage);
                  addAiToolFeedback(chat, 'change_music', true, `played ${track.name} - ${track.artist || ''}`.trim());
                  if (isViewingThisChat) {
                    appendMessage(musicChangeMessage, chat);
                   }
                } else {
                  addAiToolFeedback(chat, 'change_music', false, `not found in playlist: ${songNameFromAI}`);
                  console.warn(`歌曲查找失败: AI请求的歌曲名"${songNameFromAI}"(处理后为"${songNameToFind}") 在播放列表中未找到。`);
                }
              } else {
                addAiToolFeedback(chat, 'change_music', false, 'missing song_name');
                console.error("AI返回的change_music指令中，歌曲名无效或缺失:", msgData);
              }
            } else {
              addAiToolFeedback(chat, 'change_music', false, 'listen-together session is not active for this chat');
            }
            continue;
          case 'add_song_to_playlist':
            // AI can search NetEase, add the result to the shared player, and play it immediately.
            {
              const netease = window.NeteaseMusic;
              const addAndPlay = window.ephAddToPlaylistAndPlay;
              if (netease && addAndPlay && netease.isLoggedIn && netease.isLoggedIn()) {
                const keyword = String(msgData.keyword || msgData.song || msgData.song_name || '').trim();
                const level = normalizeNeteaseQualityLevel(msgData.level);
                if (!keyword) {
                  addAiToolFeedback(chat, 'add_song_to_playlist', false, 'missing keyword');
                  console.warn('[AI] add_song_to_playlist 缺 keyword');
                  continue;
                }
                try {
                  console.log(`[AI] 主动放歌: 搜索 "${keyword}" (音质: ${level})`);
                  const songs = await netease.search(keyword, 1);
                  if (!songs || songs.length === 0) {
                    addAiToolFeedback(chat, 'add_song_to_playlist', false, `no search result: ${keyword}`);
                    console.warn(`[AI] add_song_to_playlist 没搜到: ${keyword}`);
                    continue;
                  }
                  const song = songs[0];
                  const detail = await netease.getSongDetail(song.id);
                  const urlResult = await netease.getSongUrl(song.id, level);
                  let lrcContent = '';
                  try {
                    lrcContent = await netease.getLyric(song.id);
                  } catch (e) {
                    console.warn('[AI] getLyric 失败:', e);
                  }
                  if (!urlResult || !urlResult.url) {
                    addAiToolFeedback(chat, 'add_song_to_playlist', false, `no playable url: ${song.id}`);
                    console.warn(`[AI] add_song_to_playlist 拿不到 URL (可能是 VIP 限制): ${song.id}`);
                    continue;
                  }
                  const songInfo = {
                    name: detail?.name || song.name || '未知歌曲',
                    artist: detail?.artist || song.artist || '',
                    album: detail?.albumName || song.albumName || '',
                    cover: detail?.cover || song.cover || '',
                    src: urlResult.url,
                    quality: level,
                    isLocal: false,
                    lrcContent: lrcContent,
                    artists: detail?.artists || [],
                    albumId: detail?.albumId || song.albumId,
                    publishTime: detail?.publishTime,
                    duration: detail?.duration || song.duration,
                    fee: detail?.fee,
                    source: 'netease_real',
                    id: song.id,
                  };
                  const ok = addAndPlay(songInfo, chatId);
                  if (!ok) {
                    addAiToolFeedback(chat, 'add_song_to_playlist', false, `player rejected: ${songInfo.name}`);
                    console.error('[AI] ephAddToPlaylistAndPlay 失败');
                    continue;
                  }
                  const aiSongMessage = {
                    ...baseMessage,
                    type: 'pat_message',
                    content: `[♪ ${chat.name} 给你放了一首歌: 《${songInfo.name}》- ${songInfo.artist}]`,
                  };
                  chat.history.push(aiSongMessage);
                  addAiToolFeedback(chat, 'add_song_to_playlist', true, `played ${songInfo.name} - ${songInfo.artist || ''}`.trim());
                  if (isViewingThisChat) {
                    appendMessage(aiSongMessage, chat);
                  }
                  console.log(`[AI] 主动放歌成功: ${songInfo.name} - ${songInfo.artist}`);
                } catch (e) {
                  addAiToolFeedback(chat, 'add_song_to_playlist', false, e && e.message ? e.message : String(e));
                  console.error('[AI] add_song_to_playlist 失败:', e);
                }
              } else {
                addAiToolFeedback(chat, 'add_song_to_playlist', false, 'not logged in or NetEase/player tool is unavailable');
                console.warn('[AI] add_song_to_playlist 跳过: 未登录网易云 / NeteaseMusic 未加载');
              }
            }
            continue;
          case 'request_song':
            // 【2026-07-21 新增】AI 主动给用户唱一首歌
            // 流程：调 generateSong → 存到 IndexedDB（ai-songs） → 推聊天消息 → 自动播放
            if (chat.isGroup) {
              addAiToolFeedback(chat, 'request_song', false, 'group chat 不支持 AI 唱歌');
              continue;
            }
            if (!window.AIMusic || typeof window.AIMusic.generateSong !== 'function') {
              addAiToolFeedback(chat, 'request_song', false, 'ai-music.js 未加载');
              console.warn('[AI] request_song 跳过: AIMusic 模块未加载');
              continue;
            }
            try {
              const songPrompt = String(msgData.prompt || '').trim();
              if (!songPrompt) {
                addAiToolFeedback(chat, 'request_song', false, 'missing prompt');
                continue;
              }
              const songLyrics = typeof msgData.lyrics === 'string' ? msgData.lyrics : '';
              const useVoiceSample = msgData.useVoiceSample !== false; // 默认 true
              const instrumental = msgData.instrumental === true;
              const songTitle = String(msgData.title || msgData.name || 'AI 原创').trim() || 'AI 原创';
              const onProgress = ({ text }) => {
                if (typeof window.showToast === 'function' && text) window.showToast(text);
              };
              const blob = await window.AIMusic.generateSong({
                chatId: chatId,
                prompt: songPrompt,
                lyrics: songLyrics,
                useVoiceSample: useVoiceSample,
                instrumental: instrumental,
                onProgress: onProgress
              });
              if (!blob || typeof blob.size !== 'number' || blob.size === 0) {
                addAiToolFeedback(chat, 'request_song', false, 'empty blob');
                throw new Error('AI 唱歌返回空音频');
              }
              // 1) 存到 IndexedDB 原创曲库（跨 session 持久化）
              const songId = `${chatId}_${Date.now()}`;
              const persistResult = await persistAiSongBlob(songId, {
                chatId: chatId,
                blob: blob,
                title: songTitle,
                prompt: songPrompt,
                lyrics: songLyrics,
                instrumental: instrumental,
                useVoiceSample: useVoiceSample,
                createdAt: Date.now()
              });
              if (!persistResult) {
                addAiToolFeedback(chat, 'request_song', false, 'IndexedDB save failed');
                throw new Error('AI 原创曲库保存失败');
              }
              // 2) 推聊天流系统消息
              if (window.MusicPlayer && typeof window.MusicPlayer.addAiSongActionMessage === 'function') {
                await window.MusicPlayer.addAiSongActionMessage({
                  chatId: chatId,
                  songId: songId,
                  title: songTitle,
                  blob: blob
                });
              } else {
                console.warn('[AI] request_song: MusicPlayer.addAiSongActionMessage 不可用（Step 5 待实现）');
              }
              // 3) 塞进当前播放列表
              let addedIndex = -1;
              if (window.MusicPlayer && typeof window.MusicPlayer.addAiSongToPlaylist === 'function') {
                const addResult = await window.MusicPlayer.addAiSongToPlaylist(blob, {
                  songId: songId,
                  title: songTitle,
                  isCover: useVoiceSample,
                  chatId: chatId,
                  createdAt: Date.now(),
                  lyrics: songLyrics  // 【2026-07-23 修】caller 漏传 lyrics，buildLrcFromLyrics 拿不到词 → 播放器 lrcContent 一直是空
                });
                if (addResult && typeof addResult.index === 'number') {
                  addedIndex = addResult.index;
                }
              } else {
                console.warn('[AI] request_song: MusicPlayer.addAiSongToPlaylist 不可用（Step 5 待实现）');
              }
              // 4) 自动播放
              if (addedIndex >= 0 && window.MusicPlayer && typeof window.MusicPlayer.playSong === 'function') {
                try {
                  await window.MusicPlayer.playSong(addedIndex, true);
                } catch (playErr) {
                  console.warn('[AI] request_song 自动播放失败:', playErr);
                }
              }
              addAiToolFeedback(chat, 'request_song', true, `《${songTitle}》(${Math.round(blob.size/1024)}KB)`);
              console.log(`[AI] request_song 完成: ${songTitle} (${blob.size} bytes)`);
            } catch (songErr) {
              console.error('[AI] request_song 失败:', songErr);
              if (typeof showCustomAlert === 'function') {
                await showCustomAlert('AI 唱歌失败', String(songErr && songErr.message ? songErr.message : songErr));
              }
            }
            continue;
          case 'create_memory':
            const newMemory = {
              chatId: chatId,
              authorId: chatId,
              description: msgData.description,
              timestamp: Date.now(),
              type: 'ai_generated'
            };
            await db.memories.add(newMemory);
            console.log(`AI "${chat.name}" 记录了一条新回忆:`, msgData.description);
            continue;
          case 'create_countdown':
            const targetDate = new Date(msgData.date);
            if (!isNaN(targetDate) && targetDate > new Date()) {
              const newCountdown = {
                chatId: chatId,
                authorId: chatId,
                description: msgData.title,
                timestamp: Date.now(),
                type: 'countdown',
                targetDate: targetDate.getTime()
              };
              await db.memories.add(newCountdown);
              console.log(`AI "${chat.name}" 创建了一个新约定:`, msgData.title);
            }
            continue;
          case 'block_user':
            if (!chat.isGroup) {
              chat.relationship.status = 'blocked_by_ai';
              const hiddenMessage = {
                role: 'system',
                content: `[系统提示：你刚刚主动拉黑了用户。]`,
                timestamp: Date.now(),
                isHidden: true
              };
              chat.history.push(hiddenMessage);
              await db.chats.put(chat);
              if (isViewingThisChat) {
                renderChatInterface(chatId);
              }
              renderChatList();
              break;
            }
            continue;
          case 'friend_request_response':
            if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
              if (msgData.decision === 'accept') {
                chat.relationship.status = 'friend';
                aiMessage = {
                  ...baseMessage,
                  content: "我通过了你的好友申请，我们现在是好友啦！"
                };
              } else {
                chat.relationship.status = 'blocked_by_ai';
                aiMessage = {
                  ...baseMessage,
                  content: "抱歉，我拒绝了你的好友申请。"
                };
              }
              chat.relationship.applicationReason = '';
            }
            break;
          case 'poll':
            const pollOptions = typeof msgData.options === 'string' ?
              msgData.options.split('\n').filter(opt => opt.trim()) :
              (Array.isArray(msgData.options) ? msgData.options : []);
            if (pollOptions.length < 2) continue;
            aiMessage = {
              ...baseMessage,
              type: 'poll',
              question: msgData.question,
              options: pollOptions,
              votes: {},
              isClosed: false,
            };
            break;
          case 'gift': {
            const {
              itemName,
              itemPrice,
              image_prompt
            } = msgData;

            if (itemName && !isNaN(parseFloat(itemPrice)) && image_prompt) {

              const imageUrl = getPollinationsImageUrl(image_prompt);

              aiMessage = {
                ...baseMessage,
                type: 'gift',
                items: [{
                  name: itemName,
                  price: parseFloat(itemPrice),
                  imageUrl: imageUrl,
                  quantity: 1
                }],
                total: parseFloat(itemPrice),
                recipients: msgData.recipients || null
              };
            } else {
              console.warn(`AI 尝试赠送一个格式不正确的随机礼物:`, msgData);
            }
            break;
          }
          case 'vote':
            const pollToVote = chat.history.find(m => m.timestamp === msgData.poll_timestamp);
            if (pollToVote && !pollToVote.isClosed) {
              Object.keys(pollToVote.votes).forEach(option => {
                const voterIndex = pollToVote.votes[option].indexOf(msgData.name);
                if (voterIndex > -1) {
                  pollToVote.votes[option].splice(voterIndex, 1);
                }
              });
              if (!pollToVote.votes[msgData.choice]) {
                pollToVote.votes[msgData.choice] = [];
              }
              if (!pollToVote.votes[msgData.choice].includes(msgData.name)) {
                pollToVote.votes[msgData.choice].push(msgData.name);
              }
              if (isViewingThisChat) {
                renderChatInterface(chatId);
              }
            }
            continue;
          case 'red_packet':
            aiMessage = {
              ...baseMessage,
              ...msgData,
              totalAmount: msgData.amount,
              claimedBy: {},
              isFullyClaimed: false
            };


            if (aiMessage.packetType === 'lucky') {
              const allocatedAmounts = generateRandomPacketAmounts(aiMessage.amount, aiMessage.count);
              aiMessage.allocatedAmounts = allocatedAmounts;
              aiMessage.unclaimedAmounts = [...allocatedAmounts];
            }


            if (msgData.receiver) {
              aiMessage.receiverName = msgData.receiver;
              delete aiMessage.receiver;
            }
            break;
          case 'open_red_packet':
            const packetToOpen = chat.history.find(m => m.timestamp === msgData.packet_timestamp);

            const claimerOriginalName = msgData.name;
            const isMember = chat.members.some(member => member.originalName === claimerOriginalName);


            if (!isMember) {
              console.warn(`AI 角色 "${claimerOriginalName}" 尝试领取不属于自己的群聊红包。操作已被拦截。`);
              continue;
            }

            if (packetToOpen && packetToOpen.packetType === 'direct') {
              if (packetToOpen.receiverName !== msgData.name) {
                console.warn(`AI 角色 "${msgData.name}" 尝试领取不属于自己的专属红包 (接收人: ${packetToOpen.receiverName})。操作已被拦截。`);
                continue;
              }
            }

            if (packetToOpen && !packetToOpen.isFullyClaimed && !(packetToOpen.claimedBy && packetToOpen.claimedBy[msgData.name])) {
              let claimedAmountAI = 0;
              const remainingAmount = packetToOpen.totalAmount - Object.values(packetToOpen.claimedBy || {}).reduce((sum, val) => sum + val, 0);
              const remainingCount = packetToOpen.count - Object.keys(packetToOpen.claimedBy || {}).length;
              if (remainingCount > 0) {
                if (packetToOpen.packetType === 'direct') {
                  claimedAmountAI = packetToOpen.totalAmount;
                }

                else if (packetToOpen.unclaimedAmounts && packetToOpen.unclaimedAmounts.length > 0) {

                  claimedAmountAI = packetToOpen.unclaimedAmounts.pop();
                }

                else {
                  console.warn("检测到旧版红包，回退到旧的（不公平）随机算法 (triggerAiResponse)");
                  const remainingAmount = packetToOpen.totalAmount - Object.values(packetToOpen.claimedBy || {}).reduce((sum, val) => sum + val, 0);
                  if (remainingCount === 1) {
                    claimedAmountAI = remainingAmount;
                  } else {
                    const min = 0.01;
                    const max = remainingAmount - (remainingCount - 1) * min;
                    claimedAmountAI = Math.random() * (max - min) + min;
                  }
                }

                claimedAmountAI = parseFloat(claimedAmountAI.toFixed(2));
                if (!packetToOpen.claimedBy) packetToOpen.claimedBy = {};
                packetToOpen.claimedBy[msgData.name] = claimedAmountAI;


                const claimerMember = chat.members.find(m => m.originalName === msgData.name);
                const claimerDisplayName = claimerMember ? claimerMember.groupNickname : msgData.name;


                const senderDisplayName = getDisplayNameInGroup(chat, packetToOpen.senderName);

                const aiClaimedMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `${claimerDisplayName} 领取了 ${senderDisplayName} 的红包`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(aiClaimedMessage);

                let hiddenContentForAI = `[系统提示：你 (${claimerDisplayName}) 成功抢到了 ${claimedAmountAI.toFixed(2)} 元。`;
                if ((packetToOpen.unclaimedAmounts && packetToOpen.unclaimedAmounts.length === 0) || (Object.keys(packetToOpen.claimedBy).length >= packetToOpen.count)) {
                  packetToOpen.isFullyClaimed = true;
                  const finishedMessage = {
                    role: 'system',
                    type: 'pat_message',
                    content: `${senderDisplayName} 的红包已被领完`,
                    timestamp: messageTimestamp++
                  };
                  chat.history.push(finishedMessage);
                  let luckyKing = {
                    name: '',
                    amount: -1
                  };
                  if (packetToOpen.packetType === 'lucky' && packetToOpen.count > 1) {
                    Object.entries(packetToOpen.claimedBy).forEach(([name, amount]) => {
                      if (amount > luckyKing.amount) {
                        luckyKing = {
                          name,
                          amount
                        };
                      }
                    });
                  }
                  if (luckyKing.name) {
                    const luckyKingMember = chat.members.find(m => m.originalName === luckyKing.name);
                    const luckyKingDisplayName = luckyKingMember ? luckyKingMember.groupNickname : luckyKing.name;
                    hiddenContentForAI += ` 红包已被领完，手气王是 ${luckyKingDisplayName}！`;
                  } else {
                    hiddenContentForAI += ` 红包已被领完。`;
                  }
                }
                hiddenContentForAI += ' 请根据这个结果发表你的评论。]';
                const hiddenMessageForAI = {
                  role: 'system',
                  content: hiddenContentForAI,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMessageForAI);
              }
              if (isViewingThisChat) {
                renderChatInterface(chatId);
                renderChatList();
              }
            }
            continue;

          case 'accept_transfer': {
            const originalTransferMsgIndex = chat.history.findIndex(m => m.timestamp === msgData.for_timestamp);
            if (originalTransferMsgIndex > -1) {
              const originalMsg = chat.history[originalTransferMsgIndex];

              // 防止重复接收
              if (originalMsg.status && originalMsg.status !== 'pending') continue;

              originalMsg.status = 'accepted';
              // 不再额外构造 assistant "已收款" 消息:
              // - 用户视角的"已收款"卡片已由 chat-input.js handleUserTransferResponse 写入 (role:'user')
              // - 原转账卡片渲染 (chat-interface.js L1136-1137) 会根据 status='accepted' 自动显示"你已收款"
              // - 若再 push 一条 role:'assistant' 的"已收款", 会被当作 AI 自己的输出渲染 (用户截图里 AI 那侧的多余卡片),
              //   且会被喂回给 AI 作为历史, 导致 AI 下次回复误以为"我也收款了"并自指评论
              if (isViewingThisChat) {
                renderChatInterface(chatId);
              }
            }
            continue;
          }

          case 'decline_transfer': {
            const originalTransferMsgIndex = chat.history.findIndex(m => m.timestamp === msgData.for_timestamp);
            if (originalTransferMsgIndex > -1) {
              const originalMsg = chat.history[originalTransferMsgIndex];

              // --- 修复：如果已经处理过，直接忽略 ---
              if (originalMsg.status && originalMsg.status !== 'pending') {
                console.warn(`AI试图重复拒收一笔已处理的转账 (状态: ${originalMsg.status})，已拦截。`);
                continue;
              }

              originalMsg.status = 'declined';
              await processTransaction(originalMsg.amount, 'income', `转账退款-${chat.name}`);
              const refundMessage = {
                role: 'assistant',
                senderName: chat.name,
                type: 'transfer',
                isRefund: true, // 确保标记为退款
                amount: originalMsg.amount,
                currency: originalMsg.currency || 'CNY',
                note: '转账已被拒收',
                receiverName: '我', // 明确接收人
                timestamp: messageTimestamp++
              };
              chat.history.push(refundMessage);
              if (isViewingThisChat) {
                appendMessage(refundMessage, chat);
                renderChatInterface(chatId);
              }
            }
            continue;
          }
          case 'change_group_name':
            if (chat.isGroup && msgData.new_name) {
              const newName = msgData.new_name.trim();
              const memberNames = chat.members.map(m => m.originalName);

              if (memberNames.includes(newName)) {
                console.warn(`AI (${msgData.name}) 试图将群名更改为成员名 ("${newName}")。操作已被程序阻止。`);
                continue;
              }

              chat.name = newName;

              const changerMember = chat.members.find(m => m.originalName === msgData.name);
              const changerDisplayName = changerMember ? changerMember.groupNickname : msgData.name;

              const systemMessage = {
                role: 'system',
                type: 'pat_message',
                content: `${changerDisplayName} 将群名修改为 “${chat.name}”`,
                timestamp: messageTimestamp++
              };
              chat.history.push(systemMessage);

              if (isViewingThisChat) {
                appendMessage(systemMessage, chat);
                document.getElementById('chat-header-title').textContent = chat.name;
              }
            }
            continue;
          case 'change_remark_name':
            if (!chat.isGroup && msgData.new_name) {
              const oldName = chat.name;
              const newName = msgData.new_name.trim();

              if (newName && newName !== oldName) {
                if (!chat.nameHistory) {
                  chat.nameHistory = [];
                }
                if (!chat.nameHistory.includes(oldName)) {
                  chat.nameHistory.push(oldName);
                }

                chat.name = newName;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `“${chat.originalName}” 将备注修改为 “${newName}”`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                const hiddenMemoryMessage = {
                  role: 'system',
                  content: `[系统提示：你刚刚成功将自己的备注名修改为了“${newName}”。请自然地接受这个新名字，不要对此感到惊讶。]`,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMemoryMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                  document.getElementById('chat-header-title').textContent = newName;
                }

                await syncCharacterNameInGroups(chat);
              }
            }
            continue;

          case 'change_group_avatar':
            if (chat.isGroup && msgData.avatar_name) {
              const avatarName = msgData.avatar_name;
              const library = chat.settings.groupAvatarLibrary || [];
              const foundAvatar = library.find(avatar => avatar.name === avatarName);

              if (foundAvatar) {
                chat.settings.groupAvatar = foundAvatar.url;

                const changerMember = chat.members.find(m => m.originalName === msgData.name);
                const changerDisplayName = changerMember ? changerMember.groupNickname : msgData.name;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `${changerDisplayName} 更换了群头像`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                }
              } else {
                console.warn(`AI 尝试使用一个不存在的群头像: "${avatarName}"`);
              }
            }
            continue;
          case 'system_message':
            aiMessage = {
              role: 'system',
              type: 'pat_message',
              content: msgData.content,
              timestamp: Date.now()
            };
            break;
          case 'share_link':
            aiMessage = {
              ...baseMessage,
              type: 'share_link',
              title: msgData.title,
              description: msgData.description,
              source_name: msgData.source_name,
              content: msgData.content
            };
            break;
          case 'quote_reply': {
            let originalMessage = null;


            if (msgData.target_content) {
              originalMessage = [...chat.history].reverse().find(m =>
                !m.isHidden &&
                (
                  m.content === msgData.target_content ||
                  (typeof m.content === 'string' && m.content.trim() === msgData.target_content.trim())
                )
              );

              if (!originalMessage) {
                console.warn(`[本轮引用失败] AI ${msgData.name} 尝试引用内容 "${(msgData.target_content || '').substring(0, 20)}..."，但在本轮历史中未找到。`);
              }
            }


            else if (msgData.target_timestamp) {
              originalMessage = chat.history.find(m => m.timestamp === msgData.target_timestamp);
            }


            if (originalMessage) {


              let quotedSenderDisplayName;

              if (originalMessage.role === 'user') {

                quotedSenderDisplayName = chat.settings.myNickname || '我';
              } else {

                if (chat.isGroup) {

                  quotedSenderDisplayName = getDisplayNameInGroup(chat, originalMessage.senderName);
                } else {

                  quotedSenderDisplayName = chat.name;
                }
              }

              const quoteContext = {
                timestamp: originalMessage.timestamp,
                senderName: quotedSenderDisplayName,

                content: String(originalMessage.content || '').substring(0, 50)
              };


              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content,
                quote: quoteContext
              };
            } else {

              console.warn(`引用回复失败: 找不到目标消息 (Content: ${msgData.target_content}, TS: ${msgData.target_timestamp})`);
              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content
              };
            }
            break;
          }
          case 'send_and_recall': {
            if (!isViewingThisChat) continue;
            const tempMessageData = {
              ...baseMessage,
              content: msgData.content
            };
            const tempMessageElement = createMessageElement(tempMessageData, chat);
            appendMessage(tempMessageData, chat, true);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 500));
            const bubbleWrapper = document.querySelector(`.message-bubble[data-timestamp="${tempMessageData.timestamp}"]`)?.closest('.message-wrapper');
            if (bubbleWrapper) {
              bubbleWrapper.classList.add('recalled-animation');
              await new Promise(resolve => setTimeout(resolve, 300));
              const recalledMessage = {
                role: 'assistant',
                senderName: msgData.name || chat.name,
                type: 'recalled_message',
                content: '对方撤回了一条消息',
                timestamp: tempMessageData.timestamp,
                recalledData: {
                  originalType: 'text',
                  originalContent: msgData.content
                }
              };
              const msgIndex = chat.history.findIndex(m => m.timestamp === tempMessageData.timestamp);
              if (msgIndex > -1) {
                chat.history[msgIndex] = recalledMessage;
              } else {
                chat.history.push(recalledMessage);
              }
              let placeholder = null;
              try {
                try {
                  placeholder = await createMessageElement(recalledMessage, chat);
                } catch (error) {
                  window.runtimeDiag?.log?.('CHAT_RENDER_BAD_MESSAGE_SKIPPED', { chatId: chat?.id, messageTimestamp: recalledMessage?.timestamp, error: error?.message || String(error) });
                  console.warn('[CHAT_RENDER_BAD_MESSAGE_SKIPPED]', error, recalledMessage);
                  placeholder = null;
                }
              } catch (error) {
                window.runtimeDiag?.log?.('CHAT_RENDER_BAD_MESSAGE_SKIPPED', { chatId: chat.id, messageTimestamp: recalledMessage?.timestamp, error: error?.message || String(error) });
                console.warn('[CHAT_RENDER_BAD_MESSAGE_SKIPPED]', error, recalledMessage);
                placeholder = null;
              }
              if (placeholder && document.body.contains(bubbleWrapper)) {
                bubbleWrapper.parentNode.replaceChild(placeholder, bubbleWrapper);
              }
            }
            continue;
          }

          case 'text':
            aiMessage = {
              ...baseMessage,
              content: String(msgData.content || msgData.message)
            };
            break;
          case 'sticker':
            if (msgData.meaning) {
              const sticker = findBestStickerMatch(msgData.meaning, state.userStickers);
              if (sticker) {
                aiMessage = {
                  ...baseMessage,
                  type: 'sticker',
                  content: sticker.url,
                  meaning: sticker.name
                };
              } else {

                console.warn(`AI 尝试使用一个不存在的表情: "${msgData.meaning}"`);
                aiMessage = null;
              }
            } else {

              console.warn("AI 发送了一个没有 'meaning' 的 sticker 指令。", msgData);
              aiMessage = {
                ...baseMessage,
                type: 'sticker',
                content: msgData.url,
                meaning: '未知表情'
              };
            }
            break;
          case 'ai_image':
            aiMessage = {
              ...baseMessage,
              type: 'ai_image',
              content: msgData.description,
              image_prompt: msgData.image_prompt
            };
            break;
          case 'voice_message':
            aiMessage = {
              ...baseMessage,
              type: 'voice_message',
              content: msgData.content
            };
            break;
          case 'transfer':
            aiMessage = {
              ...baseMessage,
              type: 'transfer',
              amount: msgData.amount,
              currency: msgData.currency || 'CNY',
              note: msgData.note,
              receiverName: msgData.receiver || '我'
            };
            break;

          case 'waimai_request':
            aiMessage = {
              ...baseMessage,
              type: 'waimai_request',
              productInfo: msgData.productInfo,
              amount: msgData.amount,
              status: 'pending',
              countdownEndTime: Date.now() + 15 * 60 * 1000,
            };
            break;
          case 'waimai_order':
            aiMessage = {
              ...baseMessage,
              type: 'waimai_order',
              productInfo: msgData.productInfo,
              amount: msgData.amount,
              greeting: msgData.greeting,
              recipientName: msgData.recipientName || null
            };
            break;
          case 'offline_text':
            aiMessage = {
              ...baseMessage,
              ...msgData
            };
            break;

          case 'naiimag':

            try {
              console.log('📸 NovelAI图片生成开始，AI提供的prompt:', msgData.prompt);


              const naiPrompts = getCharacterNAIPrompts(chat.id);


              const aiPrompt = msgData.prompt || 'a beautiful scene';
              const finalPositivePrompt = aiPrompt + ', ' + naiPrompts.positive;
              const finalNegativePrompt = naiPrompts.negative;

              console.log(`📝 使用${naiPrompts.source === 'character' ? '角色专属' : '系统'}提示词配置`);
              console.log('最终正面提示词:', finalPositivePrompt);
              console.log('最终负面提示词:', finalNegativePrompt);


              const apiKey = localStorage.getItem('novelai-api-key');
              const model = localStorage.getItem('novelai-model') || 'nai-diffusion-4-5-full';
              const settings = getNovelAISettings();

              if (!apiKey) {
                throw new Error('NovelAI API Key未配置。请在NovelAI设置中填写API Key。');
              }

              const [width, height] = settings.resolution.split('x').map(Number);


              let requestBody;

              if (model.includes('nai-diffusion-4')) {

                requestBody = {
                  input: finalPositivePrompt,
                  model: model,
                  action: 'generate',
                  parameters: {
                    params_version: 3,
                    width: width,
                    height: height,
                    scale: settings.cfg_scale,
                    sampler: settings.sampler,
                    steps: settings.steps,
                    seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                    n_samples: 1,
                    ucPreset: settings.uc_preset,
                    qualityToggle: settings.quality_toggle,
                    autoSmea: false,
                    dynamic_thresholding: false,
                    controlnet_strength: 1,
                    legacy: false,
                    add_original_image: true,
                    cfg_rescale: 0,
                    noise_schedule: 'karras',
                    legacy_v3_extend: false,
                    skip_cfg_above_sigma: null,
                    use_coords: false,
                    legacy_uc: false,
                    normalize_reference_strength_multiple: true,
                    inpaintImg2ImgStrength: 1,
                    characterPrompts: [],

                    v4_prompt: {
                      caption: {
                        base_caption: finalPositivePrompt,
                        char_captions: []
                      },
                      use_coords: false,
                      use_order: true
                    },

                    v4_negative_prompt: {
                      caption: {
                        base_caption: finalNegativePrompt,
                        char_captions: []
                      },
                      legacy_uc: false
                    },
                    negative_prompt: finalNegativePrompt,
                    deliberate_euler_ancestral_bug: false,
                    prefer_brownian: true

                  }
                };
              } else {

                requestBody = {
                  input: finalPositivePrompt,
                  model: model,
                  action: 'generate',
                  parameters: {
                    width: width,
                    height: height,
                    scale: settings.cfg_scale,
                    sampler: settings.sampler,
                    steps: settings.steps,
                    seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                    n_samples: 1,
                    ucPreset: settings.uc_preset,
                    qualityToggle: settings.quality_toggle,
                    sm: settings.smea,
                    sm_dyn: settings.smea_dyn,
                    dynamic_thresholding: false,
                    controlnet_strength: 1,
                    legacy: false,
                    add_original_image: false,
                    cfg_rescale: 0,
                    noise_schedule: 'native',
                    negative_prompt: finalNegativePrompt
                  }
                };
              }

              console.log('🚀 发送NAI请求:', requestBody);


              let apiUrl;


              if (model.includes('nai-diffusion-4')) {

                apiUrl = 'https://image.novelai.net/ai/generate-image-stream';
              } else {

                apiUrl = 'https://image.novelai.net/ai/generate-image';
              }

              let corsProxy = settings.cors_proxy;


              if (corsProxy === 'custom') {
                corsProxy = settings.custom_proxy_url || '';
              }


              if (corsProxy && corsProxy !== '') {
                apiUrl = corsProxy + encodeURIComponent(apiUrl);
              }

              const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + apiKey
                },
                body: JSON.stringify(requestBody)
              });

              console.log('Response status:', response.status);
              console.log('Response headers:', [...response.headers.entries()]);

              if (!response.ok) {
                const errorText = await response.text();
                console.error('API错误响应:', errorText);
                throw new Error(`API请求失败 (${response.status}): ${errorText}`);
              }


              const contentType = response.headers.get('content-type');
              console.log('Content-Type:', contentType);


              let zipBlob;
              let imageDataUrl;
              if (contentType && contentType.includes('text/event-stream')) {
                console.log('检测到 SSE 流式响应，开始解析...');


                const text = await response.text();
                console.log('收到 SSE 数据，大小:', text.length);


                const lines = text.trim().split('\n');
                let base64Data = null;

                for (let i = lines.length - 1; i >= 0; i--) {
                  const line = lines[i].trim();
                  if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    const dataContent = line.substring(6);


                    try {
                      const jsonData = JSON.parse(dataContent);


                      if (jsonData.event_type === 'final' && jsonData.image) {
                        base64Data = jsonData.image;
                        console.log('✅ 找到 final 事件的图片数据');
                        break;
                      }


                      if (jsonData.data) {
                        base64Data = jsonData.data;
                        console.log('从 JSON.data 中提取图片数据');
                        break;
                      }
                      if (jsonData.image) {
                        base64Data = jsonData.image;
                        console.log('从 JSON.image 中提取图片数据');
                        break;
                      }
                    } catch (e) {

                      base64Data = dataContent;
                      console.log('直接使用 base64 数据');
                      break;
                    }
                  }
                }

                if (!base64Data) {
                  throw new Error('无法从 SSE 响应中提取图片数据');
                }


                const isPNG = base64Data.startsWith('iVBORw0KGgo');
                const isJPEG = base64Data.startsWith('/9j/');

                if (isPNG || isJPEG) {
                  console.log('✅ 检测到直接的图片 base64 数据 (PNG/JPEG)');

                  const binaryString = atob(base64Data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  const imageBlob = new Blob([bytes], {
                    type: isPNG ? 'image/png' : 'image/jpeg'
                  });
                  console.log('图片 Blob 创建成功，大小:', imageBlob.size);


                  const reader = new FileReader();
                  imageDataUrl = await new Promise((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(imageBlob);
                  });
                  console.log('✅ 图片转换成功！🎨');
                } else {

                  console.log('当作 ZIP 文件处理...');
                  const binaryString = atob(base64Data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  zipBlob = new Blob([bytes]);
                  console.log('ZIP Blob 大小:', zipBlob.size);
                }
              } else {

                zipBlob = await response.blob();
                console.log('收到数据，类型:', zipBlob.type, '大小:', zipBlob.size);
              }


              if (!imageDataUrl && zipBlob) {

                try {

                  if (typeof JSZip === 'undefined') {
                    throw new Error('JSZip库未加载，请刷新页面重试');
                  }


                  const zip = await JSZip.loadAsync(zipBlob);
                  console.log('ZIP文件内容:', Object.keys(zip.files));


                  let imageFile = null;
                  for (let filename in zip.files) {
                    if (filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
                      imageFile = zip.files[filename];
                      console.log('找到图片文件:', filename);
                      break;
                    }
                  }

                  if (!imageFile) {
                    throw new Error('ZIP文件中未找到图片');
                  }


                  const imageBlob = await imageFile.async('blob');
                  console.log('提取的图片大小:', imageBlob.size);


                  const reader = new FileReader();
                  imageDataUrl = await new Promise((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(imageBlob);
                  });
                  console.log('✅ 图片解压成功！');
                } catch (zipError) {
                  console.error('ZIP解压失败:', zipError);
                  throw new Error('图片解压失败: ' + zipError.message);
                }
              }

              console.log('✅ NAI图片生成成功！');


              aiMessage = {
                ...baseMessage,
                type: 'naiimag',
                imageUrl: imageDataUrl,
                prompt: aiPrompt,
                fullPrompt: finalPositivePrompt // 保存完整提示词供查看
              };
            } catch (error) {
              console.error('❌ NAI图片生成失败:', error);

              aiMessage = {
                ...baseMessage,
                content: `[图片生成失败: ${error.message}]`
              };
            }
            break;

          case 'googleimag':
            try {
              console.log('📸 Google Imagen图片生成开始，AI提供的prompt:', msgData.prompt);
              const googlePrompt = msgData.prompt || 'a beautiful scene';

              const googleResult = await generateGoogleImagenFromPrompt(googlePrompt);

              aiMessage = {
                ...baseMessage,
                type: 'googleimag',
                imageUrl: googleResult.imageUrl,
                prompt: googlePrompt,
                fullPrompt: googleResult.fullPrompt
              };
            } catch (error) {
              console.error('❌ Google Imagen图片生成失败:', error);
              aiMessage = {
                ...baseMessage,
                content: `[Google Imagen图片生成失败: ${error.message}]`
              };
            }
            break;

          case 'openaiimag':
            try {
              const openAIPrompt = String(
                msgData.prompt || msgData.image_prompt || msgData.description || msgData.content || ''
              ).trim();
              console.log('📸 OpenAI兼容图片生成开始，prompt:', openAIPrompt);

              if (typeof generateOpenAICompatibleImageFromPrompt !== 'function') {
                throw new Error('OpenAI兼容生图函数未加载。');
              }

              const openAIResult = await generateOpenAICompatibleImageFromPrompt(openAIPrompt);

              aiMessage = {
                ...baseMessage,
                type: 'openaiimag',
                imageUrl: openAIResult.imageUrl,
                fullPrompt: openAIResult.fullPrompt,
                prompt: openAIPrompt,
                model: openAIResult.model,
                provider: 'openaiCompatible'
              };
            } catch (error) {
              console.error('❌ OpenAI兼容图片生成失败:', error);
              aiMessage = {
                ...baseMessage,
                content: `[OpenAI兼容图片生成失败: ${error.message}]`
              };
            }
            break;

          default:
            console.warn("收到了未知的AI指令类型:", msgData.type);
            break;
        }

        if (aiMessage) {
          if (window.messageStore) {
            await window.messageStore.addMessageToChat(chat, aiMessage);
          } else {
            chat.history.push(aiMessage);
          }
          if (!isViewingThisChat) {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
          }
          if (!isViewingThisChat && !notificationShown) {
            let notificationText;
            switch (aiMessage.type) {
              case 'transfer':
                notificationText = `[收到一笔转账]`;
                break;
              case 'waimai_request':
                notificationText = `[收到一个外卖代付请求]`;
                break;
              case 'ai_image':
              case 'googleimag':
              case 'openaiimag':
                notificationText = `[图片]`;
                break;
              case 'voice_message':
                notificationText = `[语音]`;
                break;
              case 'sticker':
                notificationText = aiMessage.meaning ? `[表情: ${aiMessage.meaning}]` : '[表情]';
                break;
              case 'offline_text':
                notificationText = aiMessage.dialogue ? `「${aiMessage.dialogue}」` : `[${(aiMessage.description || aiMessage.content || '线下消息').substring(0, 20)}...]`;
                break;
              default:
                notificationText = String(aiMessage.content || '');
            }
            const finalNotifText = chat.isGroup ? `${aiMessage.senderName}: ${notificationText}` : notificationText;
            showNotification(chatId, finalNotifText.substring(0, 40) + (finalNotifText.length > 40 ? '...' : ''));
            notificationShown = true;
          } else if (isViewingThisChat && !notificationShown) {
            // 新增：如果在聊天页面且启用了"在聊天页面也发送通知"，则发送系统级通知
            let notificationText;
            switch (aiMessage.type) {
              case 'transfer':
                notificationText = `[收到一笔转账]`;
                break;
              case 'waimai_request':
                notificationText = `[收到一个外卖代付请求]`;
                break;
              case 'ai_image':
              case 'googleimag':
              case 'openaiimag':
                notificationText = `[图片]`;
                break;
              case 'voice_message':
                notificationText = `[语音]`;
                break;
              case 'sticker':
                notificationText = aiMessage.meaning ? `[表情: ${aiMessage.meaning}]` : '[表情]';
                break;
              case 'offline_text':
                notificationText = aiMessage.dialogue ? `「${aiMessage.dialogue}」` : `[${(aiMessage.description || aiMessage.content || '线下消息').substring(0, 20)}...]`;
                break;
              default:
                notificationText = String(aiMessage.content || '');
            }
            const finalNotifText = chat.isGroup ? `${aiMessage.senderName}: ${notificationText}` : notificationText;
            triggerSystemNotificationInChatPage(chatId, finalNotifText.substring(0, 40) + (finalNotifText.length > 40 ? '...' : ''));
            notificationShown = true;
          }



          if (isViewingThisChat) {
            appendMessage(aiMessage, chat);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1800 + 1000));
          }
        }
      }

      if (callHasBeenHandled && videoCallState.isGroupCall) {
        videoCallState.isAwaitingResponse = false;
        if (videoCallState.participants.length > 0) {
          startVideoCall();
        } else {
          videoCallState = {
            ...videoCallState,
            isAwaitingResponse: false,
            participants: []
          };
          showScreen('chat-interface-screen');
          alert('无人接听群聊邀请。');
        }
      }
      if (needsImmediateReaction) {
        await triggerAiResponse();
        return;
      }
      await db.chats.put(chat);

      const qzoneActionTaken = messagesArray.some(action =>
        action.type === 'qzone_post' ||
        action.type === 'qzone_like' ||
        action.type === 'qzone_comment' ||
        action.type === 'repost'
      );


      if (qzoneActionTaken) {
        console.log("检测到AI执行了动态操作，立即刷新好友动态页面。");

        await renderQzonePosts();
      }


    } catch (error) {
      window.runtimeDiag?.markEnd('AI_REQUEST', 'AI_REQUEST_ERROR', {
        chatId,
        error: error?.message || String(error)
      });

      aiRequestState.errorMessage = error?.message || String(error);
      aiRuntimeLog('AI_REQUEST_ERROR', { chatId, message: aiRequestState.errorMessage });

      if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
        chat.relationship.status = 'blocked_by_ai';
        await showCustomAlert('申请失败', `AI在处理你的好友申请时出错了，请稍后重试。\n错误信息: ${error.message}`);
      } else {
        await showCustomAlert(
          'API 调用失败',
          `发生了一个错误，AI未能成功响应。\n\n错误详情:\n${error.message}`
        );
      }

      if (!chat.isGroup && chat.relationship?.status === 'blocked_by_ai') {
        await db.chats.put(chat);
      }

      videoCallState.isAwaitingResponse = false;
    } finally {
      cleanupAiGenerationState(aiRequestState);
      setAvatarActingState(chatId, false);


      if (chat.isGroup) {
        if (typingIndicator) {
          typingIndicator.style.display = 'none';
        }
      } else {
        if (chatHeaderTitle && state.chats[chatId]) {
          chatHeaderTitle.style.opacity = 0;
          setTimeout(() => {
            chatHeaderTitle.textContent = state.chats[chatId].name;
            chatHeaderTitle.classList.remove('typing-status');
            chatHeaderTitle.style.opacity = 1;
          }, 200);
        }
      }
      renderChatList();
      // 自动提取不再受"用户是否在看这个聊天"卡死，每次 AI 回复都会检查
      checkAndTriggerAutoSummary(chatId);
      // 情侣空间 AI 自主决定模式 - 聊天触发
      if (!chat.isGroup && typeof triggerCoupleSpaceAiDecide === 'function') {
        try { triggerCoupleSpaceAiDecide(chatId, 'chat'); } catch(e) {}
      }
      stopSilentAudio();
    }
  }


  // ========== 重新生成与推进功能 ==========
  // 从 script.js 迁移：handleRegenerateResponse, handleRegenerateCallResponse, handlePropelAction

  async function handleRegenerateResponse() {
    const chatId = state.activeChatId;
    const chat = state.chats[chatId];
    if (!chat) return;

    const currentMessages = window.messageStore
      ? await window.messageStore.getRecentContextMessages(chatId, {
          limit: 30,
          excludeHidden: false,
          excludeExcluded: false
        })
      : (Array.isArray(chat.history) ? chat.history.slice(-30) : []);

    const lastUserMsg = [...currentMessages].reverse().find(msg => msg.role === 'user' && !msg.isHidden);
    if (!lastUserMsg) {
      alert("没有可供重新生成回复的用户消息。");
      return;
    }

    let assistantMessagesToDelete = [];
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const msg = currentMessages[i];
      if (msg.role === 'assistant') {
        assistantMessagesToDelete.unshift(msg);
        continue;
      }
      if (msg.role === 'user' && Number(msg.timestamp) === Number(lastUserMsg.timestamp)) {
        break;
      }
      if (assistantMessagesToDelete.length > 0) {
        break;
      }
    }

    if (assistantMessagesToDelete.length === 0) {
      alert("AI 尚未对您的最后一条消息做出回应，无法重新生成。");
      return;
    }

    const target = assistantMessagesToDelete[assistantMessagesToDelete.length - 1];
    console.log('[重roll] 目标assistant消息:', target);

    if (window.messageStore) {
      for (const message of assistantMessagesToDelete) {
        await window.messageStore.deleteMessage(chatId, message);
      }
      await window.messageStore.refreshChatMeta(chatId);
    } else {
      chat.history = chat.history.filter(m => !assistantMessagesToDelete.some(targetMsg => {
        if (targetMsg.id && m.id === targetMsg.id) return true;
        if (targetMsg.timestamp && Number(m.timestamp) === Number(targetMsg.timestamp)) return true;
        if (targetMsg.createdAt && Number(m.createdAt) === Number(targetMsg.createdAt)) return true;
        return false;
      }));
      const cleanChat = { ...chat };
      delete cleanChat.history;
      await db.chats.put(cleanChat);
    }

    await renderChatInterface(chatId);
    await triggerAiResponse();
  }

  async function handleRegenerateCallResponse() {
    if (!videoCallState.isActive) return;

    const lastUserSpeechIndex = videoCallState.callHistory.findLastIndex(msg => msg.role === 'user');

    if (lastUserSpeechIndex === -1) {
      alert("通话中还没有你的发言，无法重新生成回应。");
      return;
    }

    videoCallState.callHistory.splice(lastUserSpeechIndex + 1);

    const callFeed = document.getElementById('video-call-main');
    callFeed.innerHTML = '';
    videoCallState.callHistory.forEach(msg => {
      const bubble = document.createElement('div');

      const speechClass = msg.role === 'assistant' ? 'ai-speech' : 'user-speech';
      bubble.className = `call-message-bubble ${speechClass}`;

      bubble.dataset.timestamp = msg.timestamp;
      if (msg.role === 'user') {
        bubble.textContent = msg.content;
      } else {
        bubble.innerHTML = msg.content;
      }
      addLongPressListener(bubble, () => showCallMessageActions(msg.timestamp));
      callFeed.appendChild(bubble);
    });
    callFeed.scrollTop = callFeed.scrollHeight;

    triggerAiInCallAction(null);
  }

  async function handlePropelAction() {
    const chat = state.chats[state.activeChatId];
    if (!chat) return;

    if (window.chatStuckStateRepair && typeof window.chatStuckStateRepair.ensureCurrentChatNotStuck === 'function') {
      const ok = await window.chatStuckStateRepair.ensureCurrentChatNotStuck();
      if (!ok) {
        try { await showCustomAlert('对话修复', '检测到未完成的生成状态，已尝试修复，请重试。'); } catch (e) {}
        return;
      }
    }

    const aiRequestState = beginAiGenerationRequest(chat.id);
    setAvatarActingState(chat.id, true);
    const chatHeaderTitle = document.getElementById('chat-header-title');
    if (!chat.isGroup) {
      chatHeaderTitle.style.opacity = 0;
      setTimeout(() => {
        chatHeaderTitle.textContent = '对方正在输入...';
        chatHeaderTitle.classList.add('typing-status');
        chatHeaderTitle.style.opacity = 1;
      }, 200);
    }

    try {
      const {
        proxyUrl,
        apiKey,
        model
      } = state.apiConfig;
      if (!proxyUrl || !apiKey || !model) {
        throw new Error('API未配置');
      }

      const maxMemory = parseInt(chat.settings.maxMemory) || 10;
      const historySlice = await getRecentChatMessagesForAi(chat, maxMemory, {
        includeExcluded: false,
        includeHidden: true
      });

      const now = new Date();
      const chinaTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
      const currentTime = chinaTime.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'full',
        timeStyle: 'short'
      });
      const timeOfDayGreeting = getTimeOfDayGreeting(chinaTime);
      const myNickname = chat.settings.myNickname || '我';

      let worldBookContent = '';
      let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
      state.worldBooks.forEach(wb => {
        if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
          allWorldBookIds.push(wb.id);
        }
      });

      if (allWorldBookIds.length > 0) {
        const linkedContents = allWorldBookIds.map(bookId => {
          const worldBook = state.worldBooks.find(wb => wb.id === bookId);
          if (!worldBook || !Array.isArray(worldBook.content)) return '';
          const formattedEntries = worldBook.content
            .filter(entry => entry.enabled !== false)
            .map(entry => {
              let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;
              entryString += `**内容:**\n${entry.content}`;
              return entryString;
            }).join('');
          return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
        }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }
      let musicContext = '';
      if (musicState.isActive && musicState.activeChatId === chat.id) {
        const currentTrack = musicState.currentIndex > -1 ? musicState.playlist[musicState.currentIndex] : null;
        musicContext = `\n\n# 当前音乐情景...\n(省略详细内容，与triggerAiResponse一致)`;
      }
      let nameHistoryContext = '';
      if (chat.nameHistory && chat.nameHistory.length > 0) {
        nameHistoryContext = `\n- **你的曾用名**: [${chat.nameHistory.join(', ')}]。当在对话历史中看到这些名字时，它们都指的是【你】自己。`;
      }
      let userProfileContext = '';
      const userQzoneNickname = state.qzoneSettings.nickname || '用户';
      userProfileContext += `- 用户的QZone昵称是 "${userQzoneNickname}"。\n`;
      const commonGroups = Object.values(state.chats).filter(group => group.isGroup && group.members.some(m => m.id === chat.id));
      if (commonGroups.length > 0) {
        userProfileContext += '- 用户在你们共同所在的群聊中的昵称如下：\n';
        commonGroups.forEach(group => {
          const myNicknameInGroup = group.settings.myNickname || userQzoneNickname;
          userProfileContext += `  - 在群聊"${group.name}"中，用户的昵称是"${myNicknameInGroup}"。\n`;
        });
      }
      userProfileContext += '当你在任何系统提示、动态评论或挂载的群聊记忆中看到这些名字时，它们都指代的是【你的聊天对象】。';
      const stickerContext = getStickerContextForPrompt(chat);

      // 根据记忆模式构建记忆上下文 - 双源注入 (日记为主 + 向量为辅)
      let memoryContextForPrompt = '';
      const memoryMode = chat.settings.memoryMode || (chat.settings.enableStructuredMemory ? 'structured' : 'diary');
      // 计算向量检索 query（保留 retrievalStrategy 策略）
      let queryText = '';
      if (window.vectorMemoryManager) {
        const vm = window.vectorMemoryManager.getVariableMemory(chat);
        const retrievalStrategy = vm.settings.retrievalStrategy || 'user-only';
        const userMsgCount = vm.settings.retrievalUserMsgCount || 3;
        if (retrievalStrategy === 'user-only') {
          const userMessages = filteredHistory.filter(m => m.role === 'user').slice(-userMsgCount);
          queryText = userMessages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
        } else if (retrievalStrategy === 'user-weighted') {
          const recentMsgs = filteredHistory.slice(-10);
          const userMsgs = recentMsgs.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join(' ');
          const aiMsgs = recentMsgs.filter(m => m.role === 'assistant').slice(-2).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
          queryText = userMsgs + ' ' + aiMsgs;
        } else {
          queryText = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
        }
      }
      try {
        if (window.vectorMemoryManager) {
          memoryContextForPrompt = await window.vectorMemoryManager.buildMemoryContext(chat, memoryMode, queryText);
        } else if (memoryMode === 'structured' && window.structuredMemoryManager) {
          memoryContextForPrompt = '# 长期记忆 (必须严格遵守)\n' + window.structuredMemoryManager.serializeForPrompt(chat);
        } else {
          memoryContextForPrompt = '# 长期记忆 (必须严格遵守)\n' + (chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)');
        }
      } catch (e) {
        console.warn('[双源注入-propagate] 失败:', e);
        memoryContextForPrompt = '# 长期记忆 (必须严格遵守)\n' + (chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)');
      }

      let aiAgeContext = getDynamicAgeContext(chat);
      let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

      let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('single') : '';
      
      const contextMapPropel = {
        'aiAgeContext': aiAgeContext,
        'currencyExchangeContext': currencyExchangeContext,
        'char_avatar': chat.isGroup ? (chat.settings.groupAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg') : (chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'),
        'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
        'char_name': chat.originalName,
        'char_remark': chat.name,
        'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
        'user_nickname': myNickname,
        'chat.originalName': chat.originalName,
        'aiPersona': chat.settings.aiPersona,
        'latestThoughtContext': '', // 推进时通常没有上一轮思考，故留空
        'worldBookContent': worldBookContent || '(当前无特殊世界观设定，以现实逻辑为准)',
        'memoryContextForPrompt': memoryContextForPrompt,
        'multiLayeredSummaryContext': '',
        'todoListContext': '',
        'periodSummaryContext': '',
        'chat.name': chat.name,
        'myNickname': myNickname,
        'myPersona': chat.settings.myPersona || '普通用户',
        'userStatus': chat.settings.userStatus ? chat.settings.userStatus.text : '在线' + (chat.settings.userStatus && chat.settings.userStatus.isBusy ? '(忙碌中)' : ''),
        'userProfileContext': userProfileContext,
        'nameHistoryContext': nameHistoryContext,
        'timePerceptionContext': chat.settings.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
        'weatherContext': '', // 推进时省略天气
        'timeContext': '',
        'musicContextStr': (typeof musicState.isActive === 'boolean' && musicState.isActive) ? '你们正在一起听歌，' + musicContext : '你们没在听歌，但你有两个音乐工具：change_music（切已有歌）和 add_song_to_playlist（全网易搜歌+自动播放）。\n' + musicContext,
        'readingContextStr': '你们没有在读书。',
        'contactsList': '',
        'postsContext': '',
        'groupContext': '',
        'sharedContext': '',
        'callTranscriptContext': '',
        'synthMusicInstruction': '',
        'narratorInstruction': '',
        'kinshipContext': '',
        'coupleSpaceContext': '',
        'bilingualModeContext': '',
        'thoughtsPrompt': '',
        'bilingualAlertText': '',
        'bilingualAlertVoice': '',
        'novelAiImageContext': '',
        'googleImagenContext': '',
        'qzoneActionsPrompt': '',
        'viewMyPhonePrompt': '',
        'crossChatInstruction': '',
        'todoInstruction': '',
        'stickerContext': stickerContext,
        'aiAvatarLibrary': chat.settings.aiAvatarLibrary && chat.settings.aiAvatarLibrary.length > 0 ? chat.settings.aiAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)',
        'myAvatarLibrary': chat.settings.myAvatarLibrary && chat.settings.myAvatarLibrary.length > 0 ? chat.settings.myAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)'
      };

      let systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMapPropel);

      systemPrompt = processPromptWithSettings(systemPrompt, 'single');

      // 2026-07-04 补：推进模式（propel，按"推进"按钮触发的主动发言）也要注入热点日报
      const hotNewsContextPropel = await getHotNewsContextForPrompt(chat);
      if (hotNewsContextPropel) systemPrompt += '\n\n' + hotNewsContextPropel;

      const messagesForApi = historySlice.map(msg => ({
        role: msg.role,
        content: String(msg.content)
      }));

      messagesForApi.push({
        role: 'user',
        content: `[系统指令：用户按下了"推进"按钮，现在轮到你主动行动了，请继续对话。]`
      });

      let isGemini = isGeminiNativeUrl(proxyUrl);
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);

      const response = isGemini ?
        await fetch(geminiConfig.url, withCurrentAiSignal(geminiConfig.data)) :
        await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{
              role: 'system',
              content: systemPrompt
            }, ...messagesForApi],
            temperature: state.globalSettings.apiTemperature || 0.8,
            top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
            presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
            frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
          }),
          signal: getCurrentAiSignal()
        });

      markFirstAiChunk(aiRequestState);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`API 请求失败: ${errorData.error.message}`);
      }

      const data = await response.json();

      const aiResponseContent = getGeminiResponseText(data);

      const messagesArray = hookProactiveWakeInMessages(parseAiResponse(aiResponseContent), chat);
      const processedActions = [];
      for (const action of messagesArray) {
        if (action.type === 'text' && typeof action.content === 'string' && action.content.includes('\n')) {
          const lines = action.content.split(/\n+/).filter(line => line.trim());
          lines.forEach(line => {
            processedActions.push({
              ...action,
              content: line
            });
          });
        } else {
          processedActions.push(action);
        }
      }

      let messageTimestamp = Date.now();
      for (const msgData of processedActions) {
        const aiMessage = {
          role: 'assistant',
          senderName: chat.originalName,
          timestamp: messageTimestamp++,
          content: msgData.content || msgData.message,
          type: msgData.type || 'text',
        };
        if (msgData.type === 'update_thoughts') {
          if (!chat.isGroup) {
            if (msgData.heartfelt_voice) chat.heartfeltVoice = String(msgData.heartfelt_voice);
            if (msgData.random_jottings) chat.randomJottings = String(msgData.random_jottings);
            
            // 推进时也动态收集自定义心声变量
            if (!chat.customThoughts) {
              chat.customThoughts = {};
            }
            for (const key in msgData) {
              if (key !== 'type' && key !== 'heartfelt_voice' && key !== 'random_jottings') {
                chat.customThoughts[key] = String(msgData[key]);
              }
            }
          }
          continue;
        }
        if (window.messageStore) {
          await window.messageStore.addMessageToChat(chat, aiMessage);
        } else {
          chat.history.push(aiMessage);
        }
        appendMessage(aiMessage, chat);
        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 800));
      }

      await db.chats.put(chat);
      renderChatList();

    } catch (error) {
      aiRequestState.errorMessage = error?.message || String(error);
      aiRuntimeLog('AI_REQUEST_ERROR', { chatId: chat.id, message: aiRequestState.errorMessage });
      console.error("推进剧情失败:", error);
      await showCustomAlert('操作失败', `无法推进剧情: ${error.message}`);
    } finally {
      cleanupAiGenerationState(aiRequestState);
      setAvatarActingState(chat.id, false);
      if (!chat.isGroup && document.getElementById('chat-header-title')) {
        const titleEl = document.getElementById('chat-header-title');
        titleEl.style.opacity = 0;
        setTimeout(() => {
          titleEl.textContent = chat.name;
          titleEl.classList.remove('typing-status');
          titleEl.style.opacity = 1;
        }, 200);
      }
    }
  }

  // ========== 全局暴露 ==========
  window.cleanMinimaxResponseText = cleanMinimaxResponseText;
  window.triggerAiResponse = triggerAiResponse;
  window.silentlyUpdateDbUrl = silentlyUpdateDbUrl;
  window.handleRegenerateResponse = handleRegenerateResponse;
  window.handleRegenerateCallResponse = handleRegenerateCallResponse;
  window.handlePropelAction = handlePropelAction;

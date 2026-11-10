// ============================================================
// proactive-wake.js — 主动消息 wake-up 处理
// 借鉴糯米机 (worker/proactive-push) 设计: push-server 只发唤醒信号
// AI 生成放前端 (chat history + character prompt 完整 → AI 人格健全)
//
// 流程:
//   1. Service Worker 收推送 → postMessage 主页面 {type:'PROACTIVE_WAKE', chatId, taskId, ...}
//   2. 主页面 listener 触发 → 找 chat → 检查睡眠时间 → 调 LLM 生成内容
//   3. 拿到 AI 回复 → 插入 chat history → 发 UPDATE_NOTIFICATION 给 SW 替换占位通知
//   4. 渲染到 UI (如果当前正在显示这个 chat)
//
// v0.1.84+ 引入, 2026-08-05
// ============================================================

(function() {
  'use strict';

  // ===== 睡眠时间检查 (user 当地时区) =====
  // 默认 23:00 - 08:00 不推送 (避免打扰 user 睡觉)
  // user 早上看 chat 时能看到 AI 想发但没发的消息 (自己决定是否回应)
  const SLEEP_START_HOUR = 23;
  const SLEEP_END_HOUR = 8;

  function isSleepTime() {
    try {
      const now = new Date();
      const hour = now.getHours();
      return hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR;
    } catch (e) {
      return false;
    }
  }

  function formatTime(date = new Date()) {
    const hour = date.getHours();
    const minute = date.getMinutes().toString().padStart(2, '0');
    return `${hour}:${minute}`;
  }

  // ===== 调 LLM 生成 AI 主动消息 =====
  // v0.1.89+ 复用 ai-group.js 的 buildProactiveContext (跟老的应用内主动消息用同一份 context 构建)
  // 包含: 角色 prompt + 角色深度人设 + 勾选世界书 + 关联记忆 + 长期记忆双源 + 多层摘要 + 表情包 + 天气 + 亲属卡 + 短期历史
  async function generateProactiveMessage(chat, aiPromptHint) {
    const state = window.state;
    if (!state) {
      throw new Error('window.state 不可用');
    }

    // 1. 复用老功能的 context 构建 (跟老应用内主动消息一致)
    let ctx;
    if (typeof window.buildProactiveContext === 'function') {
      try {
        ctx = await window.buildProactiveContext(chat, { queryText: aiPromptHint || '主动消息生成' });
      } catch (e) {
        console.warn('[proactive-wake] buildProactiveContext 失败, 用 fallback:', e.message);
      }
    }
    if (!ctx) {
      throw new Error('buildProactiveContext 不可用 (ai-group.js 可能没加载)');
    }

    // 2. 拼 user prompt (覆盖老功能的, 因为新通道有 aiPromptHint)
    const userPrompt = aiPromptHint
      ? `【系统提示：主动消息触发 - 你主动找用户】\n\n你想表达的核心内容/话题: ${aiPromptHint}\n\n请用你自己的角色口吻发一条短消息 (微信聊天风格, 1-3 段, 末尾有语气词)。\n\n【输出格式】\n你的回复【必须】是一个 JSON 对象: {"type": "text", "content": "你想对用户说的话"}\n只输出 JSON, 不要其他内容。`
      : `【系统提示：主动消息触发 - 你主动找用户】\n\n请用你自己的角色口吻发一条短消息 (微信聊天风格, 1-3 段, 末尾有语气词)。\n\n【输出格式】\n你的回复【必须】是一个 JSON 对象: {"type": "text", "content": "你想对用户说的话"}\n只输出 JSON, 不要其他内容。`;

    // 3. 拼 chat history + 当前 user 提示
    const messagesForApi = (ctx.history || []).map(m => ({
      role: m.role,
      content: String(m.content)
    }));
    messagesForApi.push({ role: 'user', content: userPrompt });

    // 4. 调 LLM (跟老功能一致, 用主 API)
    const isGemini = String(ctx.proxyUrl || '').includes('generativelanguage.googleapis.com');
    const useMainApiProxy = !isGemini
      && typeof window.fetchViaOpenAICompatibleProxy === 'function'
      && typeof window.isMainApiProxyEnabled === 'function'
      && window.isMainApiProxyEnabled();
    const chatCompletionsUrl = `${String(ctx.proxyUrl).replace(/\/+$/, '')}/chat/completions`;

    const proactivePayload = {
      model: ctx.model,
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        ...messagesForApi
      ],
      temperature: state.globalSettings.apiTemperature || 0.9
    };

    let response;
    if (isGemini) {
      // Gemini 走原函数 (跟老功能一致)
      const toGeminiFn = window.toGeminiRequestData;
      if (typeof toGeminiFn === 'function') {
        const geminiConfig = toGeminiFn(ctx.model, ctx.apiKey, ctx.systemPrompt, messagesForApi);
        response = await fetch(geminiConfig.url, geminiConfig.data);
      } else {
        // fallback
        response = await fetch(`${ctx.proxyUrl.replace(/\/+$/, '')}/v1beta/models/${ctx.model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: messagesForApi })
        });
      }
    } else if (useMainApiProxy) {
      response = await window.fetchViaOpenAICompatibleProxy({
        baseUrl: ctx.proxyUrl,
        targetPath: '/chat/completions',
        apiKey: ctx.apiKey,
        payload: proactivePayload,
        method: 'POST'
      });
    } else {
      response = await fetch(chatCompletionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(proactivePayload)
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM API 失败: ${response.status} ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    // Gemini 响应解析
    let rawContent;
    if (isGemini) {
      const getGeminiFn = window.getGeminiResponseText;
      rawContent = typeof getGeminiFn === 'function' ? getGeminiFn(data) : (data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    } else {
      rawContent = data.choices?.[0]?.message?.content;
    }

    if (!rawContent || !rawContent.trim()) {
      throw new Error('LLM 返回空消息');
    }

    // 解析 JSON text action (跟老功能一致)
    const stripCodeFence = (text) => String(text || '')
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    const parseProactiveTextAction = (rawText) => {
      const cleaned = stripCodeFence(rawText);
      const candidates = [cleaned];
      const fencedMatch = String(rawText || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fencedMatch) candidates.push(fencedMatch[1].trim());
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) candidates.push(arrayMatch[0]);
      const objectMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objectMatch) candidates.push(objectMatch[0]);

      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(stripCodeFence(candidate));
          if (Array.isArray(parsed)) {
            const textAction = parsed.find(item => item?.type === 'text' && item.content);
            if (textAction) return textAction;
          } else if (parsed?.type === 'text' && parsed.content) {
            return parsed;
          }
        } catch (e) {}
      }
      // 兜底: 直接返回 cleaned 字符串 (不是 JSON 也行)
      return { type: 'text', content: cleaned };
    };

    const action = parseProactiveTextAction(rawContent);
    return action.content || rawContent;
  }

  // ===== 插入 chat history =====
  function insertAiMessageToHistory(chat, message) {
    if (!chat.history) chat.history = [];
    chat.history.push({
      role: 'assistant',
      content: message,
      timestamp: Date.now(),
      // 标记: 这是 AI 主动消息, 不是 user 触发的
      proactive: true,
      taskId: chat._proactiveTaskId
    });
  }

  // ===== 持久化到 IndexedDB =====
  async function persistChat(chat) {
    try {
      if (window.db?.chats?.put) {
        await window.db.chats.put(chat);
      }
    } catch (e) {
      console.warn('[proactive-wake] 持久化 chat 失败:', e.message);
    }
  }

  // ===== 发 UPDATE_NOTIFICATION 给 SW =====
  function sendUpdateNotification(tag, title, body, notifData) {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'UPDATE_NOTIFICATION',
        tag,
        title,
        body,
        data: notifData
      });
    }
  }

  // ===== 渲染到 UI (如果当前正在显示这个 chat) =====
  function renderToUIIfActive(chatId) {
    try {
      if (window.state?.activeChatId !== chatId) return;
      // ⚠️【2026-10-28 修】原来调 window.renderChatMessages —— 那函数【全项目都没定义】，
      //   typeof 判断永远为假 → 主动搭话的消息写进库了但界面从不重绘
      //   （退出聊天框再进才看得见）。真正的渲染函数是 renderChatInterface。
      if (typeof window.renderChatInterface === 'function') {
        try { window.renderChatInterface(chatId); } catch (e) { /* 忽略 */ }
      } else if (typeof window.renderChatMessages === 'function') {
        window.renderChatMessages();
      }
    } catch (e) {
      console.warn('[proactive-wake] 渲染 UI 失败:', e.message);
    }
  }

  // ===== 主入口: 处理一条 PROACTIVE_WAKE =====
  async function handleProactiveWake(payload) {
    const { chatId, taskId, charId, charName, messageType, aiPrompt, sentAt } = payload;
    console.log('[proactive-wake] 收到唤醒信号:', { chatId, taskId, messageType, charName });

    const state = window.state;
    if (!state) {
      console.warn('[proactive-wake] window.state 不可用, 跳过');
      return;
    }

    // 1. 找 chat
    const chat = state.chats?.[chatId];
    if (!chat) {
      console.warn('[proactive-wake] 找不到 chat:', chatId, '可能已被删除');
      return;
    }

    // 2. 标记 taskId 给 history 用
    chat._proactiveTaskId = taskId;

    // 3. 睡眠时间硬约束 (避免深夜打扰 user)
    if (isSleepTime()) {
      // 插历史 (user 早上看 chat 能看到 AI 想发但没发)
      const note = `（${formatTime()} 想发消息但怕吵醒你，忍住没说）`;
      insertAiMessageToHistory(chat, note);
      await persistChat(chat);
      renderToUIIfActive(chatId);
      console.log('[proactive-wake] 睡眠时间, 只插历史, 不推送');
      return;
    }

    // 4. 调 LLM 生成内容
    let aiMessage;
    try {
      aiMessage = await generateProactiveMessage(chat, aiPrompt);
    } catch (e) {
      console.error('[proactive-wake] LLM 生成失败:', e.message);
      // fallback: 插历史, 不弹通知
      insertAiMessageToHistory(chat, `(系统消息: AI 主动消息生成失败 - ${e.message})`);
      await persistChat(chat);
      renderToUIIfActive(chatId);
      return;
    }

    // 5. 插入 chat history
    insertAiMessageToHistory(chat, aiMessage);
    await persistChat(chat);

    // 6. 发 UPDATE_NOTIFICATION 给 SW 替换占位通知
    const tag = `task-${taskId}`;
    sendUpdateNotification(tag, `💬 ${charName || chat.name || 'AI'}`, aiMessage, {
      chatId,
      taskId,
      type: 'proactive-wake',
      messageType
    });

    // 7. 渲染到 UI
    renderToUIIfActive(chatId);

    console.log(`[proactive-wake] ✅ 完成: ${charName} → "${aiMessage.substring(0, 30)}..."`);
  }

  // ===== 监听 SW message =====
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data) return;

      // v0.2.26 加: PROACTIVE_WAKE_PUSHED — push-server 已生成好 AI 内容, SW 落 IndexedDB 后 postMessage 过来
      //   不调 LLM, 直接用 message 写 messages 表 + 切屏 + reload chat window
      if (data.type === 'PROACTIVE_WAKE_PUSHED') {
        handleProactiveWakePushed(data).catch(err => {
          console.error('[proactive-wake] 处理推送消息失败:', err);
        });
        return;
      }

      if (data.type === 'PROACTIVE_WAKE') {
        // 异步处理, 不阻塞 SW message handler
        handleProactiveWake(data).catch(err => {
          console.error('[proactive-wake] 处理失败:', err);
        });
      } else if (data.type === 'OPEN_CHAT') {
        // v0.2.26 加: sw.js notificationclick 发过来的切 chat 消息, 之前主页面没接
        //   真凶: 点通知能 focus 页面但不会切到对应 chat
        openChatFromNotification(data).catch(err => {
          console.error('[proactive-wake] OPEN_CHAT 处理失败:', err);
        });
      }
    });
    console.log('[proactive-wake] ✅ 已注册 PROACTIVE_WAKE + PROACTIVE_WAKE_PUSHED listener');
  }

  // ===== v0.2.26 加: 处理 push-server 已生成好内容的推送 =====
  //   跟老 handleProactiveWake 区别: 不用调 LLM (push-server 端 v0.2.25.14 已经生成), 
  //   不用睡眠时间检查 (push-server 端已经查过), 直接用 message 字段写 chat + 渲染
  async function handleProactiveWakePushed(payload) {
    const { chatId, taskId, charId, charName, message, sentAt } = payload;
    console.log('[proactive-wake] 收到推送消息 (服务端已生成, v0.2.26 路径):', { chatId, taskId, charName });

    if (!chatId || !message) {
      console.warn('[proactive-wake] PROACTIVE_WAKE_PUSHED 缺 chatId/message, 跳过:', payload);
      return;
    }

    const state = window.state;
    const db = window.db;
    if (!state || !db) {
      console.warn('[proactive-wake] window.state/db 不可用, 跳过');
      return;
    }

    const chat = state.chats?.[chatId];
    if (!chat) {
      console.warn('[proactive-wake] 找不到 chat:', chatId, '可能已被删除');
      return;
    }

    chat._proactiveTaskId = taskId;

    // v0.2.30.16 改: 按正常信息一样解析 message 字段 (跟主屏 ai-response.js:1323 parseAiResponse 4 段解析策略一致)
    //   真凶 (user 2026-08-22 00:19): Gemini native 主动信息推送过来是 markdown "```json" 代码块或 raw JSON 格式
    //     - 旧代码: 直接用 message 字段 → 显示 "```json" 整段
    //     - 修法: 解析 message 字段 (剥 markdown code fence + 解析 JSON 数组/对象) + 取 type==='text' 的 content
    //     - 多段 text → 多个气泡 (跟 chat 一致), 单段 text → 1 个气泡
    //   复制而非 import parseAiResponse: 主屏 ai-response.js 是 IIFE, parseAiResponse 不暴露给 window
    //   跨项目通用 SOP: 任何 push 路径接 server 端 message 字段, 都应该过一道 4 段解析, 跟主屏 chat 消息处理对齐
    const parsePushedMessage = (raw) => {
      if (!raw) return [];
      let trimmed = String(raw).trim();

      // 1. Markdown code fence 提取 ```json ... ``` (v0.2.30.18 改: 强制剥, 允许空内容, 解决 LLM max_tokens 切狠了只输出 ```json 头)
      //   真凶 (user 2026-08-22 12:18 截图): LLM max_tokens 切到只剩 "```json" 7 字符, v0.2.30.17 mdMatch[1] 是空字符串 falsy,
      //     if 没进, trimmed 不变, 后续 2/3/4 段全跳过, fallback 把 ```json 字面写进 chat history
      //   修法: 1) 去掉 `mdMatch[1].trim()` falsy 判断, 只要 match 成功就强制剥头部 ```json
      //         2) 末尾 fallback 判断, 剥完所有形态还为空 → 返空数组, 让外层走占位消息逻辑
      //   跟后端 extractAiContent 思路一致, 但前端只做"剥", 不做"加占位"
      const mdMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
      if (mdMatch && mdMatch[1] !== undefined) {
        trimmed = mdMatch[1].trim();
      }

      // 2. 标准 JSON 数组解析 [{type:"text",content:"..."}]
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            const segs = parsed
              .filter(it => it && (it.type === 'text' || it.type === 'proactive' || (typeof it.content === 'string' && it.content)))
              .map(it => String(it.content || '').trim())
              .filter(Boolean);
            if (segs.length > 0) return segs;
          }
        } catch (e) {}
      }

      // 3. 强力提取 [ ... } ... ] (处理 AI 在 JSON 前后说废话)
      const sIdx = trimmed.indexOf('[');
      const lIdx = trimmed.lastIndexOf('}');
      if (sIdx !== -1 && lIdx !== -1 && lIdx > sIdx) {
        const eIdx = trimmed.indexOf(']', lIdx);
        if (eIdx !== -1) {
          try {
            const parsed = JSON.parse(trimmed.substring(sIdx, eIdx + 1));
            if (Array.isArray(parsed)) {
              const segs = parsed
                .filter(it => it && (it.type === 'text' || it.type === 'proactive' || (typeof it.content === 'string' && it.content)))
                .map(it => String(it.content || '').trim())
                .filter(Boolean);
              if (segs.length > 0) return segs;
            }
          } catch (e) {}
        }
      }

      // 4. 强力提取 {...} (v0.2.30.20 改: 限制 trimmed 整体是 {content: "..."} 单 JSON 对象才解析, 避免从 LLM 真消息里偶然提取 {xxx} 块)
      //   真凶: 之前 /{[^{}]*}/g 全局匹配从自然语言里偶然提取 {xxx} 块, JSON.parse 成功时 (LLM 写 {"content":"..."} 形态) 错误把部分内容当 JSON content
      //   修法: 限定 trimmed 整体以 { 开头 } 结尾 (整体是 {...} 单对象), 才走 JSON.parse + 提取 content/text/message 字段
      //   例外: trimmed 整体是 { 但不是 } 结尾 (LLM 写了 {...} 后面还有自然语言), fallback 返原 trimmed (含自然语言)
      if (/^\{[\s\S]*\}$/.test(trimmed)) {
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj.content === 'string') return [String(obj.content).trim()];
          if (obj && typeof obj.text === 'string') return [String(obj.text).trim()];
          if (obj && typeof obj.message === 'string') return [String(obj.message).trim()];
        } catch (e) {}
      }

      // 5. fallback: 原 raw (剥 markdown 后) 作为单段
      //   v0.2.30.18 改: 剥完所有形态还为空 (LLM 只输 ```json 头被切), 返空数组, 让外层落占位消息
      const finalSeg = trimmed.trim();
      if (!finalSeg) return [];
      return [finalSeg];
    };

    let segments = parsePushedMessage(message);
    if (segments.length === 0) {
      // v0.2.30.18 改: 落占位消息, 不静默 skip (LLM max_tokens 切狠了, fixedMessage 只有 ```json 头被剥空)
      //   真凶 (user 2026-08-22 12:18 截图): LLM 输出 "```json" 7 字符被切, v0.2.30.17 fallback 把字面字符串写进 chat history
      //   修法: parsePushedMessage 返空数组 → 落占位消息, user 朋友看到 "[AI 消息内容被截断]" 知道推送是收到了但内容不完整
      //   (iOS 通知 body 截前 30 字符 + ..., 完整 content 可能在通知 data.message 里看不到, 占位提示更友好)
      console.warn('[proactive-wake v0.2.30.18] 解析后无 text 段, 落占位消息:', chatId, taskId, 'raw message len:', String(message).length);
      segments = ['[AI 消息内容被截断, 完整内容已通过通知发送, 请查看通知详情]'];
    }

    // 写消息 (优先 messageStore 新表, fallback 老 history 模式) — 多段 → 多个气泡
    const baseTs = Date.now();
    let lastMsg = null;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const msg = {
        id: `${chatId}::${baseTs}::assistant::text::${i}`,
        chatId,
        role: 'assistant',
        content: seg,
        timestamp: baseTs + i,
        type: 'text',
        proactive: true,
        taskId
      };
      lastMsg = msg;

      try {
        if (window.messageStore?.addMessageToChat) {
          await window.messageStore.addMessageToChat(chat, msg);
        } else {
          if (!Array.isArray(chat.history)) chat.history = [];
          chat.history.push(msg);
          const { history, ...cleanChat } = chat;  // v0.2.60+ 已经拆表, 写 chats 时不带 history
          await db.chats.put(cleanChat);
        }
      } catch (e) {
        console.warn('[proactive-wake] 写消息失败:', e.message);
        return;
      }
    }
    console.log(`[proactive-wake] ✅ PROACTIVE_WAKE_PUSHED 消息已落: chatId=${chatId} 段数=${segments.length} content="${String(segments[0]).substring(0, 30)}..."`);

    // 切屏 + 强制 reload chat
    try {
      const wasActive = state.activeChatId === chatId;
      state.activeChatId = chatId;
      if (!wasActive) {
        if (typeof window.showScreen === 'function') window.showScreen('chat-interface-screen');
        if (typeof window.renderChatInterface === 'function') window.renderChatInterface(chatId);
        else if (typeof window.renderChatMessages === 'function') window.renderChatMessages();
      } else {
        if (typeof window.renderChatMessages === 'function') window.renderChatMessages();
      }
    } catch (e) {
      console.warn('[proactive-wake] 渲染 UI 失败:', e.message);
    }

    // 刷新 chat list (更新 last message preview)
    try {
      if (typeof window.renderChatList === 'function') window.renderChatList();
    } catch (e) {}
  }

  // ===== v0.2.26 加: 点通知触发切 chat (sw.js notificationclick → postMessage OPEN_CHAT) =====
  async function openChatFromNotification(payload) {
    const { chatId } = payload;
    if (!chatId) return;
    const state = window.state;
    if (!state?.chats?.[chatId]) {
      console.warn('[proactive-wake] OPEN_CHAT 找不到 chat:', chatId);
      return;
    }
    state.activeChatId = chatId;
    try {
      if (typeof window.showScreen === 'function') window.showScreen('chat-interface-screen');
      if (typeof window.renderChatInterface === 'function') window.renderChatInterface(chatId);
    } catch (e) {
      console.warn('[proactive-wake] 切 chat 失败:', e.message);
    }
  }

  // ===== 冷却时间检查 (v0.1.87+) =====
  // 防止 AI 在聊天过程中疯狂设主动消息, 刷屏 user
  // 默认 30 分钟 (user 可调 0=不限流)
  // 按 chat 角色算: chat.history 最后一条 assistant 消息时间 + cooldown < now → 拒绝
  function getCooldownMinutes() {
    const mins = window.state?.globalSettings?.proactiveCooldownMinutes;
    return (typeof mins === 'number' && mins >= 0) ? mins : 30;
  }

  function isCooldownActive(chat) {
    const cooldown = getCooldownMinutes();
    if (cooldown === 0) return false;  // 0 = 不限流
    if (!chat || !Array.isArray(chat.history) || chat.history.length === 0) return false;

    // 找最后一条 assistant 消息
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (m && (m.role === 'assistant' || m.senderName !== undefined)) {
        const lastTime = m.timestamp || 0;
        const elapsedMs = Date.now() - lastTime;
        return elapsedMs < cooldown * 60 * 1000;
      }
    }
    return false;
  }

  function getCooldownRemainingMinutes(chat) {
    const cooldown = getCooldownMinutes();
    if (cooldown === 0 || !chat || !Array.isArray(chat.history)) return 0;
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (m && (m.role === 'assistant' || m.senderName !== undefined)) {
        const lastTime = m.timestamp || 0;
        const elapsedMs = Date.now() - lastTime;
        const remainingMs = cooldown * 60 * 1000 - elapsedMs;
        return Math.max(0, Math.ceil(remainingMs / 60000));
      }
    }
    return 0;
  }

  // ===== 暴露 API 供调试 / 手动创建任务 =====
  // user 在桌面 console 调: await ProactiveWake.createTask({ userPrompt: '跟 user 聊今天吃了啥', recurrenceType: 'ai-decided' })
  async function createTask(options = {}) {
    const {
      userPrompt = '跟 user 聊聊天',
      recurrenceType = 'ai-decided',
      contactName = null,
      chatId = null
    } = options;

    const state = window.state;
    if (!state) throw new Error('window.state 不可用');

    // v0.2.07+: 移除 v0.1.91 误加的 mode !== 'push' throw 拦截
    // 设计: createTask 只服务 push 模式, 但拦截由管理页面 UI 控制 (app 模式时隐藏 [+ 创建任务] 按钮)
    // 这里不再 hard reject — 防御性检查留给 push-server 端 (subscription 检查)
    // (角色级总开关 chat.settings.proactiveEnabled 在下面单独检查, 这里只管渠道)

    // 1. 拿当前 chat (优先 activeChatId)
    const activeChatId = chatId || state.activeChatId;
    const chat = activeChatId ? state.chats?.[activeChatId] : null;
    const finalContactName = contactName || chat?.name || 'AI 角色';
    const finalChatId = chatId || activeChatId;

    if (!finalChatId) throw new Error('没指定 chatId 且当前不在 chat 中');
    if (!chat && !contactName) throw new Error('没 chat 上下文, 请传 contactName');

    // v0.1.91+ 角色级总开关: 关掉的话两个渠道都不发 (app 和 push 都跳过)
    // 设计: 角色级开关 = "能不能发" (总开关) + 全局 mode = "用什么发" (渠道), 两个独立维度
    if (chat && chat.settings?.proactiveEnabled !== true) {
      throw new Error(`角色 "${chat.name}" 未启用主动消息, 不能创建推送任务. 请在角色设置 → 启用主动消息 打开开关`);
    }

    // 冷却检查 (v0.1.87+)
    if (chat && isCooldownActive(chat)) {
      const remaining = getCooldownRemainingMinutes(chat);
      throw new Error(`冷却中: 同一角色聊天结束后 ${getCooldownMinutes()} 分钟内不能创建新任务, 还剩 ${remaining} 分钟`);
    }

    // 2. 拿 user LLM 配置 (push-server 内部 LLM 用)
    // v0.2.09 修: 之前 v0.2.06 读 globalSettings.apiUrl 是错的, 主 API 实际在 state.apiConfig
    // (user 截图 "user 没配 LLM" 误报 → 实际 user 在 API 设置配了, 字段读错)
    // v0.2.12 修: 优先直连 URL, 不传 proxyUrl (push-server 在云端, 不需要 CORS 绕过)
    const apiConfig = state.apiConfig || {};
    const settings = state.globalSettings || {};
    const aiApiUrl = apiConfig.apiUrl || apiConfig.mainApiUrl || apiConfig.proxyUrl || settings.apiUrl || settings.mainApiUrl;
    const aiApiKey = apiConfig.apiKey || apiConfig.mainApiKey || settings.apiKey || settings.mainApiKey;
    const aiModel = apiConfig.model || apiConfig.mainModel || settings.model || settings.mainModel || 'MiniMax/M3';
    if (!aiApiUrl || !aiApiKey) {
      throw new Error('user 没配 LLM (state.apiConfig.apiUrl/apiKey)');
    }

    // 3. 拿 push server URL
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('push serverUrl 没配');

    // 4. 拿 push subscription (从 indexedDB 重新查)
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw new Error('还没订阅推送, 请先在通知推送栏启用');

    // 5. 拿 userId (v0.2.10+: 每 PWA 唯一 UUID, 防止串台)
    const userId = getOrCreatePushUserId();
    if (!userId) throw new Error('userId 找不到');

    // 6. 拿 user 当地当前时间
    const now = new Date();
    const localTime = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // 7. 提取最近 20 条聊天历史作为 context (v0.2.05: 让 LLM 决定下次时间时能接上话)
    let contextSummary = '';
    if (chat && Array.isArray(chat.history) && chat.history.length > 0) {
      const recent = chat.history.slice(-20);
      contextSummary = recent.map(m => {
        if (!m) return '';
        const role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'AI' : (m.role || '?'));
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) text = m.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('');
        return text ? `${role}: ${text.substring(0, 200)}` : '';
      }).filter(Boolean).join('\n');
    }

    // 8. 调 push-server /api/schedule-ai-task
    const response = await fetch(`${serverUrl}/api/schedule-ai-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        chatId: finalChatId,
        // v0.2.15: 手动构造 pushSubscription, 砍掉 iOS Safari PWA 模式 toJSON() 返回的非 ASCII 字段
        // 根因: V8 ByteString 错位 (character at index 7 value 20320/你字), 来自 subscription.toJSON() 的额外字段
        // v0.2.15.2 改: 强制过滤非 ASCII 字符 (修 iOS Safari PWA 字段值本身污染 ByteString)
        // v0.2.15.3 改: 绕开 toJSON() 污染源, 改用 subscription.getKey() 拿原始 ArrayBuffer + 手动 base64url 编码
        //   之前 v0.2.15.2 失败: replace(/[^\x00-\x7F]/g, '') 只能去非 ASCII, 不能恢复原始 base64url 截短, web-push Buffer.from 还是炸
        pushSubscription: window.buildCleanPushSub(subscription),
        contactName: finalContactName,
        contactPersonality: chat?.settings?.characterPersonality || null,
        userPrompt,
        contextSummary,  // v0.2.05: 最近 20 条对话上下文
        recurrenceType,
        aiApiUrl,
        aiApiKey,
        aiModel,
        currentLocalTime: localTime,
        userTimezone
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`push-server 失败: ${response.status} ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    console.log('[ProactiveWake.createTask] ✅', data);
    return data;
  }

  // ===== 查订阅状态 =====
  async function getSubscriptionStatus() {
    try {
      if (!('serviceWorker' in navigator)) {
        return { supported: false, reason: '浏览器不支持 Service Worker' };
      }
      if (!('PushManager' in window)) {
        return { supported: false, reason: '浏览器不支持 Push API' };
      }
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      if (!registration) {
        return { supported: true, subscribed: false, reason: 'Service Worker 未注册' };
      }
      const subscription = await registration.pushManager.getSubscription();
      return {
        supported: true,
        subscribed: !!subscription,
        subscription: subscription ? subscription.toJSON() : null,
        permission: Notification.permission
      };
    } catch (e) {
      return { supported: false, reason: e.message };
    }
  }

  // ===== 订阅推送 =====
  async function subscribe() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('浏览器不支持 Service Worker');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('通知权限未授予（iPhone 还需要在 iOS 设置 → Safari → 高级 → 网站通知 启用）');
    }
    const registration = await navigator.serviceWorker.ready;
    if (!registration.pushManager) {
      throw new Error('当前环境不支持 Push API（iPhone 需要先把 PWA 加到主屏幕）');
    }

    // 拿 VAPID 公钥
    const settings = window.state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) {
      throw new Error('推送服务器地址没配（设置 → 通知 → 推送服务器地址）');
    }

    const vapidRes = await fetch(`${serverUrl}/api/vapid-public-key`);
    if (!vapidRes.ok) throw new Error(`拿 VAPID 公钥失败: HTTP ${vapidRes.status}`);
    const { publicKey } = await vapidRes.json();
    if (!publicKey || typeof publicKey !== 'string') throw new Error('VAPID 公钥为空或格式错');

    // v0.2.23 改: 严格检查 abKey 长度 = 65 字节 (P-256 uncompressed), 0 字节/其他长度直接抛错不调 push.subscribe
    //   之前 urlBase64ToUint8Array(空字符串) = 0 字节 ArrayBuffer (不 null) → push.subscribe 报 "valid P-256 public key" 错
    const abKey = urlBase64ToUint8Array(publicKey);
    if (abKey.byteLength !== 65) {
      throw new Error(`VAPID 公钥长度异常: ${abKey.byteLength} 字节 (预期 65 P-256 uncompressed)`);
    }

    // iOS 18.x PWA 双 fallback (ArrayBuffer 优先, Uint8Array 兜底)
    let subscription;
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: abKey
      });
    } catch (abErr) {
      console.warn('[ProactiveWake.subscribe] ArrayBuffer 失败, 试 Uint8Array:', abErr.message);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(abKey)
      });
    }

    // 保存到 push-server (v0.2.10+: 用每 PWA 唯一 UUID, 不再掉到 'default-user' fallback)
    // v0.2.21 改: 二进制 raw bytes 上传, 跟 notification-battery.js 同步 (DeepSeek 方案, 不用 FormData)
    // v0.2.21+userId fix: 协议加 4 字节 userId 长度 + N 字节 userId (UTF-8) 在 body 头部, 匹配 push-server 端解析
    //   协议: [4 字节 userId 长度 (uint32) | N 字节 userId (UTF-8) | 2 字节 endpoint 长度 (uint16) | N 字节 endpoint (UTF-8) | 65 字节 p256dh (raw) | 16 字节 auth (raw)]
    const state = window.state;
    const userId = getOrCreatePushUserId();
    const p256dhBuffer = subscription.getKey('p256dh');
    const authBuffer = subscription.getKey('auth');
    if (!p256dhBuffer || !authBuffer) {
      throw new Error('subscription.getKey 返回空, 浏览器可能不支持原生 Push API');
    }
    const p256dhU8 = new Uint8Array(p256dhBuffer);
    const authU8 = new Uint8Array(authBuffer);
    const enc = new TextEncoder();
    const userIdBytes = enc.encode(String(userId || ''));
    if (userIdBytes.length > 4294967295) {
      throw new Error('userId 太长 (超过 4GB)');
    }
    const endpointBytes = enc.encode(String(subscription.endpoint || ''));
    if (endpointBytes.length > 65535) {
      throw new Error('endpoint 太长 (超过 65535 字节)');
    }
    const totalLen = 4 + userIdBytes.length + 2 + endpointBytes.length + p256dhU8.length + authU8.length;
    const body = new Uint8Array(totalLen);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, userIdBytes.length);
    body.set(userIdBytes, 4);
    const off1 = 4 + userIdBytes.length;
    dv.setUint16(off1, endpointBytes.length);
    body.set(endpointBytes, off1 + 2);
    body.set(p256dhU8, off1 + 2 + endpointBytes.length);
    body.set(authU8, off1 + 2 + endpointBytes.length + p256dhU8.length);
    const saveRes = await fetch(`${serverUrl}/api/save-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    });
    if (!saveRes.ok) {
      const err = await saveRes.text();
      throw new Error(`保存订阅失败: ${err.substring(0, 200)}`);
    }

    console.log('[ProactiveWake.subscribe] ✅ 订阅成功');
    return subscription;
  }

  // ===== 取消订阅 =====
  async function unsubscribe() {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;
    return await subscription.unsubscribe();
  }

  // ===== urlBase64ToUint8Array (v0.2.02 改回 v0.1.84 跑通的版本: 返回 ArrayBuffer) =====
  // ★ v0.2.00 改返回 Uint8Array —— iOS 18.3.2 严格 PWA 拒, 报 "valid P-256 public key"
  // ★ v0.1.84 跑通的版本: 用 Uint8Array.from() 转换 + return u8.buffer (ArrayBuffer)
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    // iOS 18.3.2 PWA 严格模式: 返回 ArrayBuffer (u8.buffer) —— 这是 v0.1.84 跑通的格式
    const u8 = Uint8Array.from(rawData, c => c.charCodeAt(0));
    return u8.buffer;
  }

  // ===== 查任务列表 =====
  async function listTasks(userId = null) {
    const state = window.state;
    // v0.2.10+: 查任务列表也用每 PWA 唯一 UUID
    const finalUserId = userId || getOrCreatePushUserId();
    const settings = state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const res = await fetch(`${serverUrl}/api/tasks?userId=${encodeURIComponent(finalUserId)}`);
    if (!res.ok) throw new Error(`查任务失败: ${res.status}`);
    const data = await res.json();
    return data.tasks || [];
  }

  // ===== 删任务 =====
  async function deleteTask(taskId) {
    const settings = window.state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const res = await fetch(`${serverUrl}/api/tasks/${taskId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`删任务失败: ${res.status}`);
    return true;
  }

  // ===== 发测试推送 (fixed 模式 - 立即测试推送链路) =====
  async function sendTestPush(options = {}) {
    const state = window.state;
    // v0.2.10+: 用每 PWA 唯一 UUID, 不用 state.userId/currentUserId/deviceId + 'default-user' fallback
    //   老逻辑会导致多 PWA 串台: user 1 没配 userId 掉到 'default-user', user 2 也一样 → 全推给同一个订阅
    const userId = getOrCreatePushUserId();
    const settings = state?.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const { title = '🧪 330 推送测试', body = '如果你看到这条, 推送链路通了! 🎉' } = options;

    const res = await fetch(`${serverUrl}/api/test-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, title, body })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`测试推送失败: ${res.status} ${err.substring(0, 200)}`);
    }
    return await res.json();
  }

  // ===== 创建 fixed/ai-msg 模式任务 =====
  // v0.2.28: 加 firstSendTime 必填 + messageType='ai-msg' 模式 (user 选时间 + 填 prompt, server LLM 写消息)
  //   取代 v0.2.20 round 4 改 noop 的 /api/schedule-ai-task (那条路 user 没法定时间, 永远掉 noop)
  async function createFixedTask(options = {}) {
    const {
      userMessage = null,
      userPrompt = null,
      messageType = 'fixed',  // 'fixed' (user 填消息) 或 'ai-msg' (user 选时间 + 填 prompt, server LLM 写)
      contactName = null,
      chatId = null,
      firstSendTime,  // ISO 字符串, 必填 (UI 强制 user 选时间, 不再有 "null = 1 分钟后" 默认)
      recurrenceType = 'none'
    } = options;

    if (!firstSendTime) throw new Error('firstSendTime 必填 (请选择提醒时间)');
    if (messageType === 'fixed' && !userMessage) throw new Error('fixed 模式 userMessage 必填');
    if (messageType === 'ai-msg' && !userPrompt) throw new Error('ai-msg 模式 userPrompt 必填');

    const state = window.state;
    if (!state) throw new Error('window.state 不可用');

    // v0.2.07+: 移除 v0.1.91 误加的 mode !== 'push' throw 拦截 (同 createTask, 由 UI 控制)
    // (角色级总开关 chat.settings.proactiveEnabled 在下面单独检查, 这里只管渠道)

    const activeChatId = chatId || state.activeChatId;
    const chat = activeChatId ? state.chats?.[activeChatId] : null;
    const finalContactName = contactName || chat?.name || 'AI 角色';

    if (!finalContactName) throw new Error('没指定 contactName 且当前不在 chat 中');

    // v0.1.91+ 角色级总开关: 关掉的话两个渠道都不发 (app 和 push 都跳过)
    if (chat && chat.settings?.proactiveEnabled !== true) {
      throw new Error(`角色 "${chat.name}" 未启用主动消息, 不能创建推送任务. 请在角色设置 → 启用主动消息 打开开关`);
    }

    const settings = state.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) throw new Error('推送服务器地址没配');

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw new Error('还没订阅推送, 请先订阅');

    const userId = getOrCreatePushUserId(); // v0.2.10+: 每 PWA 唯一 UUID, 防止串台

    // v0.2.28: firstSendTime 必填 (上面 throw error 校验), 不再有 "null = 1 分钟后" 默认逻辑
    //   之前默认 1 分钟后是 "假装友好", 实际 user 90% 不知道自己设的是 1 分钟后, 任务跑了以为 work
    //   现在 UI 强制 user 选时间, 行为透明

    const res = await fetch(`${serverUrl}/api/schedule-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        chatId: activeChatId,
        // v0.2.15: 手动构造 pushSubscription, 砍掉 iOS Safari PWA 模式 toJSON() 的非 ASCII 字段
        // 根因: V8 ByteString 错位 (character at index 7 value 20320/你字), 来自 subscription.toJSON() 的额外字段
        // v0.2.15.2 改: 强制过滤非 ASCII 字符 (修 iOS Safari PWA 字段值本身污染 ByteString)
        // v0.2.15.3 改: 绕开 toJSON() 污染源, 改用 subscription.getKey() 拿原始 ArrayBuffer + 手动 base64url 编码
        //   之前 v0.2.15.2 失败: replace(/[^\x00-\x7F]/g, '') 只能去非 ASCII, 不能恢复原始 base64url 截短, web-push Buffer.from 还是炸
        pushSubscription: window.buildCleanPushSub(subscription),
        contactName: finalContactName,
        contactPersonality: chat?.settings?.characterPersonality || null,
        messageType,  // v0.2.28: 'fixed' 或 'ai-msg' (之前固定 'fixed', 没 ai-msg 模式)
        userMessage,  // fixed 模式用 (ai-msg 模式为 null)
        userPrompt,   // ai-msg 模式用 (fixed 模式为 null)
        firstSendTime, // v0.2.28: 必填 (UI 强制 user 选时间)
        recurrenceType,
        // v0.2.30.2: 任务自带 LLM config (修 push_user_config 错配的脏数据问题)
        //   真凶 (user 2026-08-17 15:20 反馈): "你没发现吗, 最近我们所有人推送失败的, 都是报没这模型, 其实明明有这模型"
        //   根因: PWA 切预设时 model 字段没回滚, push_user_config 留下 URL/model 错配 (e.g. URL=x666 但 model=gemini-3.1-pro-preview)
        //   修法: 任务建时直接把当前 apiConfig.{apiUrl/apiKey/model} 一并传给 server, 任务自己带 config, 不依赖 push_user_config
        //   加密 server 端做 (encrypt(task.api_key_encrypted)), PWA 传明文 apiKey
        apiUrl: state.apiConfig?.apiUrl || state.apiConfig?.mainApiUrl || state.apiConfig?.proxyUrl || null,
        apiKey: state.apiConfig?.apiKey || state.apiConfig?.mainApiKey || null,
        primaryModel: state.apiConfig?.model || state.apiConfig?.mainModel || null
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`创建任务失败: ${res.status} ${err.substring(0, 300)}`);
    }
    return await res.json();
  }

  // ===== AI JSON 指令处理 (function calling 入口) =====
  // 330 主体 chat AI 在回复里输出 {"type": "create_push_task", ...} 指令 → 调这个
  // chat 是 window.state.chats[chatId] 或群聊里的某个角色 chat (function calling 自动判断)
  async function tryHandleAction(msgData, chat) {
    if (!msgData || msgData.type !== 'create_push_task') return false;

    const logPrefix = '[ProactiveWake.tryHandleAction]';
    try {
      const userPrompt = (msgData.userPrompt || '').trim();
      if (!userPrompt) {
        console.warn(`${logPrefix} userPrompt 空, 跳过`);
        return true;  // 已处理, 不让 LLM 重试
      }

      // 决定 chat 上下文
      const targetChat = chat || (() => {
        const activeId = window.state?.activeChatId;
        return activeId ? window.state.chats?.[activeId] : null;
      })();

      // v0.2.07+: 应用内模式 (默认) 静默拒绝 — 应用内不需要 AI 设任务, 老 scheduler 会自动跑
      // 老 scheduler 路径: background-activity.js startProactiveScheduler (按 chat.history 最后一条消息 + interval 自动发)
      // 要 push 模式 AI 才能创建任务 (走 push-server)
      const mode = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
      if (mode === 'app') {
        console.log(`${logPrefix} 应用内模式不需要 AI 设任务, 老 scheduler 会按 [启用主动消息] 的角色自动发 (要 AI 设任务, 切到 [🔔 系统推送])`);
        return true;  // 已处理 (拒绝也是处理), 不让 LLM 报错
      }

      // v0.1.91+ 角色级总开关: 关掉的话两个渠道都不发
      if (targetChat && targetChat.settings?.proactiveEnabled !== true) {
        console.log(`${logPrefix} 角色 "${targetChat.name}" 未启用主动消息, AI 不能创建推送任务 (在角色设置里打开 [启用主动消息])`);
        return true;  // 已处理 (拒绝也是处理), 不让 LLM 报错
      }

      // 冷却检查 (v0.1.87+) — AI 调工具也限流
      if (targetChat && isCooldownActive(targetChat)) {
        const remaining = getCooldownRemainingMinutes(targetChat);
        console.log(`${logPrefix} ⏸ 冷却中, 还剩 ${remaining} 分钟, AI 调用被忽略`);
        return true;  // 已处理 (拒绝也是处理), 不让 LLM 报错
      }

      // 决定 contactName: 优先用 chat, 群聊场景 LLM 输出的 name 字段作为角色
      const contactName = (msgData.contactName || msgData.name || targetChat?.name || 'AI 角色').trim();

      console.log(`${logPrefix} AI 想设主动消息:`, {
        contactName,
        userPrompt: userPrompt.substring(0, 60),
        recurrenceType: msgData.recurrenceType || 'ai-decided',
        chatId: targetChat?.id
      });

      // 调 createTask (走 push-server, AI-decided 模式 LLM 决定时间)
      const result = await createTask({
        userPrompt,
        contactName,
        chatId: targetChat?.id,
        recurrenceType: msgData.recurrenceType || 'ai-decided'
      });

      console.log(`${logPrefix} ✅ 任务已创建:`, result?.task?.id);
      return true;
    } catch (e) {
      console.error(`${logPrefix} 创建任务失败:`, e.message);
      return true;  // 已处理 (失败也是处理), 不让 LLM 重试
    }
  }

  // ===== 暴露 API =====
  window.ProactiveWake = {
    handleProactiveWake,
    createTask,           // AI-decided (调 LLM 决定时间)
    createFixedTask,      // fixed 模式 (user 填消息)
    listTasks,
    deleteTask,
    getSubscriptionStatus,
    subscribe,
    unsubscribe,
    sendTestPush,
    tryHandleAction,      // ★ AI JSON 指令入口 (function calling 风格)
    isSleepTime,
    formatTime,
    // 冷却相关
    getCooldownMinutes,
    isCooldownActive,
    getCooldownRemainingMinutes,
    // v0.2.17 暴露: 给 in-app-proactive-patrol.js (应用内模式 PWA 前端巡视) 调 LLM 生成消息
    generateProactiveMessage
  };

  console.log('[proactive-wake] 模块加载完成');
})();

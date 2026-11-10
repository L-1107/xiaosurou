// ========== 后台活动模块 ==========
// 来源：script.js 第 21043~21384, 37449~37788, 47205~47250 行
// 功能：后台模拟活动、NPC行动生成
// 包含：startBackgroundSimulation, stopBackgroundSimulation, runBackgroundSimulationTick,
//       generateNpcActions, simulateBackgroundActivity

  function startBackgroundSimulation() {
    if (simulationIntervalId) return;
    const intervalSeconds = state.globalSettings.backgroundActivityInterval || 60;

    simulationIntervalId = setInterval(runBackgroundSimulationTick, intervalSeconds * 1000);
    playSilentAudio();
  }

  function stopBackgroundSimulation() {
    if (simulationIntervalId) {
      clearInterval(simulationIntervalId);
      simulationIntervalId = null;
    }
    stopSilentAudio();
  }




  const aiReminderTriggerLocks = new Set();
  let aiReminderSchedulerIntervalId = null;
  let aiReminderSchedulerEventsBound = false;
  let aiReminderScanInProgress = false;

  const AI_REMINDER_SCHEDULER_INTERVAL_MS = 30000;
  const AI_REMINDER_DEBUG_STORAGE_KEY = 'aiReminderDebugLogs';
  const AI_REMINDER_DEBUG_MAX_LOGS = 100;
  const AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH = 300;
  const AI_REMINDER_RECENT_MESSAGE_LIMIT = 50;
  const AI_REMINDER_MAX_TEXT_LENGTH = 200;
  const AI_REMINDER_API_TIMEOUT_MS = 60000;

  function sanitizeAiReminderDebugDetail(detail) {
    const sensitiveKeyRe = /(api[-_]?key|authorization|token|password|passwd|secret|bearer|cookie|set-cookie)/i;

    function sanitize(value, depth = 0, seen = new WeakSet()) {
      if (value == null) return value;
      if (typeof value === 'string') {
        let text = value
          .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[image/base64 omitted]')
          .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
          .replace(/[A-Za-z0-9+/]{800,}={0,2}/g, '[base64 omitted]');
        if (text.length > AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH) {
          text = `${text.slice(0, AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH)}...`;
        }
        return text;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (value instanceof Error) return sanitize(value.message || value.name || 'Error');
      if (typeof value !== 'object') return sanitize(String(value));
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (depth >= 2) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';

      const out = {};
      Object.keys(value).slice(0, 20).forEach(key => {
        if (sensitiveKeyRe.test(key)) {
          out[key] = '[REDACTED]';
        } else if (/^(content|text|message|body|prompt|image|imageUrl|url)$/i.test(key)) {
          const raw = value[key];
          if (typeof raw === 'string') out[key] = sanitize(raw);
          else if (Array.isArray(raw)) out[key] = `[Array(${raw.length})]`;
          else if (raw && typeof raw === 'object') out[key] = '[Object omitted]';
          else out[key] = raw;
        } else {
          out[key] = sanitize(value[key], depth + 1, seen);
        }
      });
      return out;
    }

    const sanitized = sanitize(detail);
    const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
    return text.length > AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH
      ? `${text.slice(0, AI_REMINDER_DEBUG_DETAIL_MAX_LENGTH)}...`
      : text;
  }

  function readAiReminderDebugLogs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(AI_REMINDER_DEBUG_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-AI_REMINDER_DEBUG_MAX_LOGS) : [];
    } catch (_) {
      return [];
    }
  }

  function writeAiReminderDebugLogs(logs) {
    try {
      localStorage.setItem(AI_REMINDER_DEBUG_STORAGE_KEY, JSON.stringify(logs.slice(-AI_REMINDER_DEBUG_MAX_LOGS)));
    } catch (_) {
      // 调试日志写入失败不影响提醒业务。
    }
  }

  function logAiReminderDebug(event, reminder, detail = {}) {
    const entry = {
      time: new Date().toISOString(),
      event: String(event || 'AI_REMINDER_UNKNOWN'),
      reminderId: reminder?.id || detail?.reminderId || null,
      reminderName: reminder?.title || reminder?.name || detail?.reminderName || '',
      detail: sanitizeAiReminderDebugDetail(detail)
    };

    const logs = readAiReminderDebugLogs();
    logs.push(entry);
    writeAiReminderDebugLogs(logs);

    if (window.runtimeDiag && typeof window.runtimeDiag.log === 'function') {
      try {
        window.runtimeDiag.log(event, {
          reminderId: entry.reminderId,
          reminderName: entry.reminderName,
          detail: entry.detail
        });
      } catch (_) {}
    }

    return entry;
  }

  function getFixedAiReminderText(reminder) {
    return String(reminder?.content || '').trim();
  }

  function truncateAiReminderText(text, maxLength = AI_REMINDER_MAX_TEXT_LENGTH) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (source.length <= maxLength) return source;
    const sliced = source.slice(0, maxLength);
    const lastPunctuation = Math.max(
      sliced.lastIndexOf('。'),
      sliced.lastIndexOf('！'),
      sliced.lastIndexOf('？'),
      sliced.lastIndexOf('!'),
      sliced.lastIndexOf('?')
    );
    return (lastPunctuation >= 60 ? sliced.slice(0, lastPunctuation + 1) : sliced).trim();
  }

  function getAiReminderValueType(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (value instanceof Date) return 'Date';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function summarizeAiReminderNextTriggerAt(value) {
    const type = getAiReminderValueType(value);
    if (value instanceof Date) {
      return {
        type,
        value: Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date'
      };
    }
    if (typeof value === 'number') {
      return {
        type,
        value: Number.isFinite(value) ? value : String(value)
      };
    }
    if (typeof value === 'string') {
      return {
        type,
        value: value.length > 80 ? `${value.slice(0, 80)}...` : value
      };
    }
    if (value == null) {
      return {
        type,
        value: value === null ? null : 'undefined'
      };
    }
    return {
      type,
      value: '[unsupported]'
    };
  }

  function normalizeAiReminderNextTriggerAt(value) {
    const summary = summarizeAiReminderNextTriggerAt(value);

    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        return {
          ok: true,
          time: value,
          ...summary
        };
      }
      return {
        ok: false,
        time: null,
        reason: 'number_not_finite',
        ...summary
      };
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return {
          ok: false,
          time: null,
          reason: 'empty_string',
          ...summary
        };
      }

      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) {
        return {
          ok: true,
          time: parsed,
          ...summary
        };
      }

      return {
        ok: false,
        time: null,
        reason: 'string_parse_failed',
        ...summary
      };
    }

    if (value instanceof Date) {
      const time = value.getTime();
      if (Number.isFinite(time)) {
        return {
          ok: true,
          time,
          ...summary
        };
      }

      return {
        ok: false,
        time: null,
        reason: 'invalid_date',
        ...summary
      };
    }

    return {
      ok: false,
      time: null,
      reason: value == null ? 'missing_nextTriggerAt' : 'unsupported_type',
      ...summary
    };
  }

  function cleanAiReminderGeneratedText(rawText) {
    let text = String(rawText || '').trim();
    if (!text) return '';

    text = text
      .replace(/^```(?:json|markdown|md|text)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    text = text
      .replace(/^(?:提醒语|提醒文案|以下是(?:提醒语|提醒文案)?|生成结果|回复内容)\s*[:：]\s*/i, '')
      .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
      .trim();

    return truncateAiReminderText(text);
  }

  function extractAiReminderTextFromResponse(rawContent, chat, proxyUrl, latestUserMessage) {
    const raw = String(rawContent || '').trim();
    if (!raw) return '';

    const parsedActions = typeof parseAiResponse === 'function' ? parseAiResponse(raw) : null;

    if (Array.isArray(parsedActions)) {
      for (const action of parsedActions) {
        if (!action || typeof action !== 'object') continue;
        if (action.type === 'thought_chain' || action.type === 'internal_state' || action.type === 'character_thoughts') continue;

        const candidate = action.content || action.message || action.text || action.dialogue || action.description;
        const cleaned = cleanAiReminderGeneratedText(candidate);
        if (cleaned) return cleaned;
      }
    }

    return cleanAiReminderGeneratedText(raw);
  }

  function sanitizeAiReminderPromptText(value, maxLength = 1200) {
    let text = String(value || '');
    text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片数据已省略]');
    text = text.replace(/[A-Za-z0-9+/]{800,}={0,2}/g, '[疑似base64内容已省略]');
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  async function getRecentAiReminderMessages(chat) {
    if (!chat?.id) return [];

    if (window.messageStore?.getRecentContextMessages) {
      return window.messageStore.getRecentContextMessages(chat.id, {
        limit: AI_REMINDER_RECENT_MESSAGE_LIMIT,
        excludeHidden: false,
        excludeExcluded: true
      });
    }

    if (window.db?.messages) {
      const rows = await db.messages
        .where('[chatId+timestamp]')
        .between([chat.id, Dexie.minKey], [chat.id, Dexie.maxKey])
        .reverse()
        .limit(AI_REMINDER_RECENT_MESSAGE_LIMIT * 2)
        .toArray();

      return rows
        .reverse()
        .filter(msg => !msg.isExcluded)
        .slice(-AI_REMINDER_RECENT_MESSAGE_LIMIT);
    }

    throw new Error('messages 表或安全消息读取函数不可用');
  }

  function buildAiReminderWorldBookContext(chat) {
    let worldBookContent = '';
    const worldBooks = Array.isArray(state.worldBooks) ? state.worldBooks : [];
    const allWorldBookIds = [...(chat?.settings?.linkedWorldBookIds || [])];

    worldBooks.forEach(wb => {
      if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
        allWorldBookIds.push(wb.id);
      }
    });

    if (allWorldBookIds.length > 0) {
      const linkedContents = allWorldBookIds.map(bookId => {
        const worldBook = worldBooks.find(wb => wb.id === bookId);
        if (!worldBook || !Array.isArray(worldBook.content)) return '';

        const formattedEntries = worldBook.content
          .filter(entry => entry.enabled !== false)
          .map(entry => {
            let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;
            entryString += `**内容:**\n${entry.content}`;
            return entryString;
          })
          .join('');

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

    return worldBookContent;
  }

  async function buildAiReminderLongTermMemoryContext(chat, recentMessages) {
    const queryTextForVector = (recentMessages || [])
      .slice(-5)
      .map(msg => typeof msg.content === 'string' ? msg.content : '')
      .join(' ');

    if (chat?.isGroup) {
      let longTermMemoryContext = '# 长期记忆 (最高优先级，这是群内已经确立的事实，所有角色必须严格遵守)\n';
      let collectedMemories = false;

      for (const member of chat.members || []) {
        const memberChat = state.chats?.[member.id] || await db.chats.get(member.id).catch(() => null);
        if (!memberChat) continue;

        const memMode = memberChat.settings?.memoryMode || (memberChat.settings?.enableStructuredMemory ? 'structured' : 'diary');
        let memberMemContent = '';

        if (memMode === 'vector' && window.vectorMemoryManager) {
          memberMemContent = await window.vectorMemoryManager.serializeForPrompt(memberChat, queryTextForVector, { countRecall: false });
        } else if (memMode === 'structured' && window.structuredMemoryManager) {
          memberMemContent = window.structuredMemoryManager.serializeForPrompt(memberChat);
        } else if (memberChat.longTermMemory && memberChat.longTermMemory.length > 0) {
          memberMemContent = memberChat.longTermMemory.map(mem => `- (记录于 ${typeof formatTimeAgo === 'function' ? formatTimeAgo(mem.timestamp) : mem.timestamp}) ${mem.content}`).join('\n');
        }

        if (memberMemContent && memberMemContent.trim()) {
          longTermMemoryContext += `\n## --- 关于“${member.groupNickname || member.originalName}”的记忆 ---\n${memberMemContent}\n`;
          collectedMemories = true;
        }
      }

      return collectedMemories ? longTermMemoryContext : `${longTermMemoryContext}- (暂无)`;
    }

    const memMode = chat?.settings?.memoryMode || (chat?.settings?.enableStructuredMemory ? 'structured' : 'diary');
    if (memMode === 'vector' && window.vectorMemoryManager) {
      return await window.vectorMemoryManager.serializeForPrompt(chat, queryTextForVector, { countRecall: false });
    }
    if (memMode === 'structured' && window.structuredMemoryManager) {
      return window.structuredMemoryManager.serializeForPrompt(chat);
    }
    if (typeof getMemoryContextForPrompt === 'function') {
      return getMemoryContextForPrompt(chat);
    }
    return chat?.longTermMemory && chat.longTermMemory.length > 0
      ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n')
      : '- (暂无)';
  }

  function formatAiReminderMessageForPrompt(chat, msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.isExcluded) return null;
    if (msg.isHidden && typeof msg.content === 'string' && msg.content.includes('[这是你上一轮的内部思考]')) return null;

    const timestamp = msg.timestamp ? `(Timestamp: ${msg.timestamp}) ` : '';
    const sender = msg.role === 'user'
      ? (chat?.settings?.myNickname || '我')
      : (chat?.isGroup && typeof getDisplayNameInGroup === 'function'
        ? getDisplayNameInGroup(chat, msg.senderName)
        : (msg.senderName || chat?.name || 'AI'));

    if (msg.role === 'system') {
      if (msg.type === 'narration') return { role: 'user', content: `${timestamp}[旁白] ${sanitizeAiReminderPromptText(msg.content)}` };
      if (msg.isHidden) return { role: 'user', content: sanitizeAiReminderPromptText(msg.content) };
      return { role: 'user', content: `${timestamp}[系统] ${sanitizeAiReminderPromptText(msg.content)}` };
    }

    let content = '';
    if (Array.isArray(msg.content)) {
      content = '[用户发送了一张图片，图片原始数据已省略。]';
    } else if (msg.type === 'user_photo' || msg.type === 'ai_image') {
      content = `[图片消息，描述：${sanitizeAiReminderPromptText(msg.content || msg.description || msg.prompt)}]`;
    } else if (msg.type === 'voice_message') {
      content = `[语音消息：${sanitizeAiReminderPromptText(msg.content)}]`;
    } else if (msg.type === 'sticker') {
      content = `[表情：${sanitizeAiReminderPromptText(msg.meaning || msg.content || 'sticker')}]`;
    } else if (msg.type === 'transfer') {
      content = `[转账：${sanitizeAiReminderPromptText(msg.amount)}${msg.currency || '元'}，备注：${sanitizeAiReminderPromptText(msg.note)}]`;
    } else {
      content = sanitizeAiReminderPromptText(msg.content);
    }

    if (!content) return null;

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: `${timestamp}${JSON.stringify([{ type: msg.type || 'text', content }])}`
      };
    }

    return {
      role: 'user',
      content: `${timestamp}${sender}: ${content}`
    };
  }

  function getAiReminderCurrentTimeContext(chat) {
    const now = new Date();
    const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;

    if (customTimeInfo && customTimeInfo.enabled) {
      const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const weekDay = weekDays[customTimeInfo.date.getDay()];
      return `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
    }

    const selectedTimeZone = chat?.settings?.timeZone || 'Asia/Shanghai';
    return now.toLocaleString('zh-CN', {
      timeZone: selectedTimeZone,
      dateStyle: 'full',
      timeStyle: 'short'
    });
  }

  function buildAiReminderTaskInstruction(reminder, chat) {
    const triggerAtInfo = normalizeAiReminderNextTriggerAt(reminder?.nextTriggerAt ?? reminder?.remindAt);
    const triggerTimeText = triggerAtInfo.ok && triggerAtInfo.time > 0
      ? new Date(triggerAtInfo.time).toLocaleString('zh-CN', { hour12: false })
      : '(未设置)';
    const characterName = reminder?.characterName || chat?.name || chat?.originalName || '角色';

    return `# 【定时提醒任务】
这是一次到点触发的定时提醒，请在完整遵守你的人设、关系、世界书、长期记忆和最近聊天语境的前提下，像正式主动聊天一样自然开口提醒用户。

- reminder.title: ${sanitizeAiReminderPromptText(reminder?.title || '定时提醒')}
- reminder.content: ${sanitizeAiReminderPromptText(reminder?.content || '')}
- reminder.remindAt / nextTriggerAt: ${triggerTimeText}
- characterName: ${sanitizeAiReminderPromptText(characterName)}

要求：
1. 必须以“${sanitizeAiReminderPromptText(characterName)}”自己的口吻自然主动提醒用户。
2. 要体现角色身份感、关系感和当前聊天语境。
3. 不要解释任务。
4. 不要说自己是系统、闹钟或程序。
5. 不要输出多段长文。
6. 尽量控制在 200 字以内。
7. 只输出最终要发送给用户的一条提醒语；如果按原聊天格式输出 JSON，也只能包含一条 text/offline_text 内容。`;
  }

  async function buildAiReminderFormalChatContext(reminder, chat) {
    const recentMessages = await getRecentAiReminderMessages(chat);
    const filteredRecentMessages = typeof filterHistoryWithDoNotSendRules === 'function'
      ? await filterHistoryWithDoNotSendRules(recentMessages, chat.id)
      : recentMessages;

    const worldBookContent = buildAiReminderWorldBookContext(chat);
    const longTermMemoryContext = await buildAiReminderLongTermMemoryContext(chat, filteredRecentMessages);
    const currentTime = getAiReminderCurrentTimeContext(chat);
    const timeOfDayGreeting = typeof getTimeOfDayGreeting === 'function' ? getTimeOfDayGreeting(new Date()) : '';
    const myNickname = chat?.settings?.myNickname || '我';
    const userName = state.qzoneSettings?.nickname || '用户';
    const aiAgeContext = typeof getDynamicAgeContext === 'function' ? getDynamicAgeContext(chat) : '';
    const currencyExchangeContext = chat?.settings?.enableDynamicCurrency && typeof getCurrencyExchangeContext === 'function' ? getCurrencyExchangeContext() : '';
    const stickerContext = chat?.isGroup
      ? (typeof getGroupStickerContextForPrompt === 'function' ? getGroupStickerContextForPrompt(chat) : '')
      : (typeof getStickerContextForPrompt === 'function' ? getStickerContextForPrompt(chat) : '');

    const promptType = chat?.isGroup ? 'group' : 'single';
    const systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt(promptType) : '';

    let contextMap;
    if (chat?.isGroup) {
      const memberNames = (chat.members || []).map(m => m.originalName);
      const membersWithContacts = (chat.members || []).map(member => `- **${member.groupNickname}** (本名: ${member.originalName}): ${member.persona}`).join('\n');
      contextMap = {
        aiAgeContext,
        currencyExchangeContext,
        char_avatar: chat.settings?.groupAvatar || '',
        user_avatar: chat.settings?.myAvatar || state.qzoneSettings?.avatar || '',
        char_name: chat.originalName || chat.name,
        char_remark: chat.name,
        user_name: userName,
        user_nickname: myNickname,
        memberNames: memberNames.join('、 '),
        myNickname,
        myOriginalName: userName,
        groupTimePerceptionInstruction: chat.settings?.enableTimePerception ? `**情景感知**: 当前时间 ${currentTime} ${timeOfDayGreeting}。` : '',
        readingContextStr: '按当前聊天阅读状态处理。',
        groupCrossChatInstruction: '',
        'chat.name': chat.name,
        groupTimeContextText: chat.settings?.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
        groupLongTimeNoSeeContext: '',
        membersWithContacts,
        myPersona: chat.settings?.myPersona || '普通用户',
        userStatus: chat.settings?.userStatus ? chat.settings.userStatus.text : '在线',
        worldBookContent,
        longTermMemoryContext,
        memoryModeContext: longTermMemoryContext,
        multiLayeredSummaryContext_group: '',
        linkedMemoryContext: '',
        musicContext: '',
        sharedContext: '',
        groupAvatarLibraryContext: '',
        stickerContext,
        forbiddenNamesContext: '',
        callTranscriptContext: '',
        synthMusicInstruction: '',
        narratorInstruction: '',
        novelAiImageGroupContext: '',
        googleImagenGroupContext: '',
        bilingualAlertVoice: ''
      };
    } else {
      contextMap = {
        aiAgeContext,
        currencyExchangeContext,
        char_avatar: chat.settings?.aiAvatar || '',
        user_avatar: chat.settings?.myAvatar || state.qzoneSettings?.avatar || '',
        char_name: chat.originalName || chat.name,
        char_remark: chat.name,
        user_name: userName,
        user_nickname: myNickname,
        'chat.originalName': chat.originalName || chat.name,
        aiPersona: chat.settings?.aiPersona || '',
        latestThoughtContext: chat.settings?.injectLatestThought && chat.heartfeltVoice ? `# 你的内心独白\n- 心声: ${chat.heartfeltVoice}\n- 散记: ${chat.randomJottings || ''}` : '',
        worldBookContent: worldBookContent || '(当前无特殊世界观设定，以现实逻辑为准)',
        memoryContextForPrompt: longTermMemoryContext,
        multiLayeredSummaryContext: '',
        todoListContext: '',
        periodSummaryContext: '',
        'chat.name': chat.name,
        myNickname,
        myPersona: chat.settings?.myPersona || '普通用户',
        userStatus: chat.settings?.userStatus ? chat.settings.userStatus.text : '在线',
        userProfileContext: `- 用户的QZone昵称是 "${userName}"。`,
        nameHistoryContext: chat.nameHistory?.length ? `\n- **你的曾用名**: [${chat.nameHistory.join(', ')}]。` : '',
        timePerceptionContext: chat.settings?.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
        weatherContext: typeof getWeatherContextForPrompt === 'function' ? await getWeatherContextForPrompt(chat) : '',
        timeContext: '',
        musicContextStr: '按当前聊天音乐状态处理。',
        readingContextStr: '按当前聊天阅读状态处理。',
        contactsList: '',
        postsContext: '',
        groupContext: '',
        sharedContext: '',
        callTranscriptContext: '',
        synthMusicInstruction: '',
        narratorInstruction: '',
        kinshipContext: '',
        coupleSpaceContext: '',
        bilingualModeContext: chat.settings?.enableBilingualMode ? '必须使用已启用的双语格式。' : '',
        thoughtsPrompt: '',
        bilingualAlertText: chat.settings?.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '',
        bilingualAlertVoice: chat.settings?.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '',
        novelAiImageContext: '',
        googleImagenContext: '',
        qzoneActionsPrompt: '',
        viewMyPhonePrompt: '',
        crossChatInstruction: '',
        todoInstruction: '',
        stickerContext,
        aiAvatarLibrary: chat.settings?.aiAvatarLibrary?.length ? chat.settings.aiAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)',
        myAvatarLibrary: chat.settings?.myAvatarLibrary?.length ? chat.settings.myAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)'
      };
    }

    let systemPrompt = typeof replaceTemplateVars === 'function'
      ? replaceTemplateVars(systemPromptTemplate, contextMap)
      : systemPromptTemplate;

    if (typeof processPromptWithSettings === 'function') {
      systemPrompt = processPromptWithSettings(systemPrompt, promptType);
    }

    const messagesPayload = filteredRecentMessages
      .slice(-AI_REMINDER_RECENT_MESSAGE_LIMIT)
      .map(msg => formatAiReminderMessageForPrompt(chat, msg))
      .filter(Boolean);

    const taskInstruction = buildAiReminderTaskInstruction(reminder, chat);
    messagesPayload.push({
      role: 'user',
      content: taskInstruction
    });

    return {
      systemPrompt,
      messagesPayload,
      latestUserMessage: taskInstruction
    };
  }

  async function requestAiReminderCompletion(chat, systemPrompt, messagesPayload) {
    const mainApiConfig = typeof resolveApiSlotConfig === 'function'
      ? await resolveApiSlotConfig('main')
      : state.apiConfig;
    let apiConfig = mainApiConfig;
    if (chat?.apiOverride?.enabled) {
      apiConfig = {
        proxyUrl: chat.apiOverride.proxyUrl || mainApiConfig.proxyUrl,
        apiKey: chat.apiOverride.apiKey || mainApiConfig.apiKey,
        model: chat.apiOverride.model || mainApiConfig.model
      };
    }

    const { proxyUrl, apiKey, model } = apiConfig || {};
    if (!proxyUrl || !apiKey || !model) {
      throw new Error('API未配置');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_REMINDER_API_TIMEOUT_MS);

    try {
      const isGemini = String(proxyUrl).includes('generativelanguage');
      if (isGemini) {
        const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesPayload);
        const response = await fetch(geminiConfig.url, {
          ...geminiConfig.data,
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        const data = await response.json();
        return {
          rawContent: getGeminiResponseText(data),
          proxyUrl
        };
      }

      const response = await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messagesPayload],
          temperature: state.globalSettings.apiTemperature || 0.8,
          top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
          presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
          frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0,
          stream: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorMessage = `${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage = errorData?.error?.message || errorData?.message || errorMessage;
        } catch (e) {}
        throw new Error(`API请求失败: ${errorMessage}`);
      }

      const data = await response.json();
      return {
        rawContent: getGeminiResponseText(data),
        proxyUrl
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('AI生成超时');
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function generateAiReminderText(reminder, chat) {
    const fallbackText = getFixedAiReminderText(reminder);
    const now = Date.now();

    try {
      const context = await buildAiReminderFormalChatContext(reminder, chat);
      logAiReminderDebug('AI_REMINDER_API_START', reminder, {
        chatId: chat?.id || reminder?.characterId || '',
        model: chat?.apiOverride?.enabled ? (chat.apiOverride.model || state.apiConfig?.model || '') : (state.apiConfig?.model || '')
      });
      const completion = await requestAiReminderCompletion(chat, context.systemPrompt, context.messagesPayload);
      const text = extractAiReminderTextFromResponse(completion.rawContent, chat, completion.proxyUrl, context.latestUserMessage);

      if (!text) {
        throw new Error('AI返回空内容');
      }

      logAiReminderDebug('AI_REMINDER_API_DONE', reminder, {
        chatId: chat?.id || reminder?.characterId || '',
        generatedLength: text.length
      });

      return {
        text,
        ok: true,
        result: 'success',
        error: '',
        aiFields: {
          lastAiGenerateAt: now,
          lastAiGenerateResult: 'success',
          lastAiGenerateError: ''
        }
      };
    } catch (error) {
      const message = error?.message || String(error);
      logAiReminderDebug('AI_REMINDER_API_ERROR', reminder, {
        error: message
      });
      console.warn('[AI定时提醒] AI生成失败，回退固定文案:', reminder?.id, error);
      return {
        text: fallbackText,
        ok: false,
        result: 'fallback',
        error: message.slice(0, 160),
        aiFields: {
          lastAiGenerateAt: now,
          lastAiGenerateResult: 'fallback',
          lastAiGenerateError: message.slice(0, 160)
        }
      };
    }
  }

  function getNextAiReminderTriggerAt(reminder, now) {
    const repeatType = reminder?.repeatType || 'none';
    const normalizedNext = normalizeAiReminderNextTriggerAt(reminder?.nextTriggerAt ?? reminder?.remindAt);
    let next = normalizedNext.ok ? normalizedNext.time : null;
    if (!Number.isFinite(next) || next <= 0) return null;

    const interval = repeatType === 'weekly'
      ? 7 * 24 * 60 * 60 * 1000
      : repeatType === 'daily'
        ? 24 * 60 * 60 * 1000
        : 0;

    if (!interval) return null;
    while (next <= now) next += interval;
    return next;
  }

  function buildAiReminderUpdate(reminder, now, result) {
    const repeatType = reminder?.repeatType || 'none';
    const update = {
      lastTriggeredAt: now,
      updatedAt: now,
      lastTriggerResult: result.triggerResult || (result.ok ? 'success' : 'failed'),
      lastTriggerError: result.error || '',
      lastTriggerMessagePreview: String(result.messagePreview || '').slice(0, 100)
    };

    if (result.aiFields && typeof result.aiFields === 'object') {
      Object.assign(update, result.aiFields);
    }

    if (repeatType === 'none') {
      update.enabled = false;
      update.nextTriggerAt = null;
    } else {
      update.nextTriggerAt = getNextAiReminderTriggerAt(reminder, now);
      if (!update.nextTriggerAt || update.nextTriggerAt <= now) {
        update.enabled = false;
        update.lastTriggerResult = 'failed';
        update.lastTriggerError = [update.lastTriggerError, '无法计算下一次提醒时间'].filter(Boolean).join('；');
        update.nextTriggerAt = null;
      }
    }

    return update;
  }

  async function insertAiReminderIntoChat(reminder, text, now) {
    const chatId = reminder?.characterId;
    if (!chatId) throw new Error('缺少 characterId');

    const chat = state.chats?.[chatId] || await db.chats.get(chatId);
    if (!chat) throw new Error(`找不到聊天 ${chatId}`);

    if (state.chats && !state.chats[chatId]) {
      state.chats[chatId] = chat;
    }

    const message = {
      role: 'assistant',
      senderName: reminder.characterName || chat.originalName || chat.name,
      type: 'text',
      content: text,
      timestamp: now,
      source: 'aiReminder',
      reminderId: reminder.id
    };

    if (window.messageStore?.addMessageToChat) {
      await window.messageStore.addMessageToChat(chat, message);
    } else if (db.messages?.put) {
      const messageId = `${chatId}::${now}::assistant::text::aiReminder::${reminder.id}`;
      await db.messages.put({
        ...message,
        id: messageId,
        chatId
      });
    } else {
      throw new Error('messageStore 与 db.messages 均不可用，无法写入提醒消息');
    }

    if (state.activeChatId === chatId && typeof renderChatInterface === 'function') {
      await renderChatInterface(chatId);
    }
    if (typeof renderChatList === 'function') {
      renderChatList();
    }

    return true;
  }

  async function sendAiReminderSystemNotification(reminder, text) {
    const chatId = reminder?.characterId;
    if (!chatId) throw new Error('缺少 characterId');

    const config = state.globalSettings?.systemNotification;
    if (!config?.enabled) throw new Error('系统通知未启用');
    if (typeof Notification === 'undefined') throw new Error('当前浏览器不支持系统通知');
    if (Notification.permission !== 'granted') throw new Error('通知权限未授权');

    if (typeof showSystemNotification === 'function') {
      await showSystemNotification(chatId, text, {
        title: reminder.title || '定时提醒'
      });
      return true;
    }

    if (typeof handleSystemNotification === 'function') {
      await handleSystemNotification(chatId, text);
      return true;
    }

    throw new Error('系统通知发送函数不可用');
  }

  async function playAiReminderSound() {
    if (typeof playNotificationSound === 'function') {
      playNotificationSound();
      return true;
    }

    if (typeof playSystemNotificationSound === 'function') {
      playSystemNotificationSound();
      return true;
    }

    throw new Error('未找到独立轻量提示音能力');
  }

  async function triggerDueAiReminder(reminder, now) {
    logAiReminderDebug('AI_REMINDER_TRIGGER_START', reminder, {
      nextTriggerAt: reminder?.nextTriggerAt || null,
      useAI: !!reminder?.useAI,
      insertIntoChat: !!reminder?.insertIntoChat,
      sendSystemNotification: !!reminder?.sendSystemNotification
    });

    const fixedText = getFixedAiReminderText(reminder);
    if (!reminder?.useAI && !fixedText) {
      logAiReminderDebug('AI_REMINDER_TRIGGER_SKIPPED', reminder, {
        reason: 'no_content_and_ai_disabled'
      });
      const skippedResult = {
        ok: false,
        triggerResult: 'skipped',
        error: 'no_content_and_ai_disabled',
        messagePreview: ''
      };
      await db.aiReminders.update(reminder.id, buildAiReminderUpdate(reminder, now, skippedResult));
      return skippedResult;
    }

    const chatId = reminder?.characterId;
    const chat = chatId ? (state.chats?.[chatId] || await db.chats.get(chatId)) : null;
    const aiTextResult = reminder.useAI
      ? await generateAiReminderText(reminder, chat)
      : {
          text: fixedText,
          ok: true,
          result: 'success',
          error: '',
          aiFields: {}
        };
    const text = aiTextResult.text || getFixedAiReminderText(reminder);
    const result = {
      ok: false,
      triggerResult: aiTextResult.result || 'success',
      error: aiTextResult.error ? `AI生成失败：${aiTextResult.error}` : '',
      messagePreview: text,
      aiFields: aiTextResult.aiFields || {}
    };
    const errors = [];
    let delivered = false;

    if (result.error) {
      errors.push(result.error);
    }

    if (reminder.insertIntoChat) {
      try {
        logAiReminderDebug('AI_REMINDER_INSERT_CHAT_START', reminder, {
          chatId: reminder.characterId
        });
        await insertAiReminderIntoChat(reminder, text, now);
        logAiReminderDebug('AI_REMINDER_INSERT_CHAT_DONE', reminder, {
          chatId: reminder.characterId
        });
        delivered = true;
      } catch (error) {
        const message = error?.message || String(error);
        logAiReminderDebug('AI_REMINDER_INSERT_CHAT_ERROR', reminder, {
          chatId: reminder.characterId,
          error: message
        });
        errors.push(`插入聊天失败：${message}`);
        console.warn('[AI定时提醒] 插入聊天失败:', reminder.id, error);
      }
    }

    if (reminder.sendSystemNotification) {
      try {
        await sendAiReminderSystemNotification(reminder, text);
        logAiReminderDebug('AI_REMINDER_NOTIFICATION_SENT', reminder, {
          chatId: reminder.characterId
        });
        delivered = true;
      } catch (error) {
        const message = error?.message || String(error);
        logAiReminderDebug('AI_REMINDER_NOTIFICATION_ERROR', reminder, {
          chatId: reminder.characterId,
          error: message
        });
        errors.push(`系统通知失败：${message}`);
        console.warn('[AI定时提醒] 系统通知失败:', reminder.id, error);
      }
    }

    if (reminder.playSound) {
      try {
        await playAiReminderSound();
        delivered = true;
      } catch (error) {
        const message = error?.message || String(error);
        errors.push(`提示音失败：${message}`);
        console.warn('[AI定时提醒] 提示音未实现或播放失败:', reminder.id, error);
      }
    }

    if (!reminder.insertIntoChat && !reminder.sendSystemNotification && !reminder.playSound) {
      errors.push('提醒没有启用任何触达方式');
    }

    const deliveryErrors = errors.filter(error => !String(error).startsWith('AI生成失败：'));
    result.ok = delivered && deliveryErrors.length === 0;
    result.error = errors.join('；');
    if (deliveryErrors.length > 0 && result.triggerResult !== 'fallback') {
      result.triggerResult = 'failed';
    }
    const update = buildAiReminderUpdate(reminder, now, result);
    await db.aiReminders.update(reminder.id, update);

    if (update.enabled === false && update.nextTriggerAt == null) {
      logAiReminderDebug('AI_REMINDER_COMPLETED', reminder, {
        repeatType: reminder.repeatType || 'none',
        triggerResult: result.triggerResult,
        error: result.error || ''
      });
    } else if (update.nextTriggerAt) {
      logAiReminderDebug('AI_REMINDER_NEXT_SCHEDULED', reminder, {
        repeatType: reminder.repeatType || 'none',
        nextTriggerAt: update.nextTriggerAt
      });
    }

    return result;
  }

  async function scanDueAiReminders(reason = 'manual') {
    // v0.1.87+: 老 AI 提醒功能废弃, 合并到 proactive-wake 走 push-server
    // 保留函数 + db.aiReminders 表 (兼容老数据), 但轮询直接 return 永不触发
    return;

    if (!window.db?.aiReminders) return;

    if (aiReminderScanInProgress) {
      logAiReminderDebug('AI_REMINDER_SCAN_START', null, {
        reason,
        skipped: true,
        skipReason: 'scan_in_progress'
      });
      return;
    }

    aiReminderScanInProgress = true;
    const now = Date.now();
    let scannedCount = 0;
    let dueCount = 0;
    let invalidCount = 0;
    let dueReminders = [];

    logAiReminderDebug('AI_REMINDER_SCAN_START', null, {
      reason,
      now
    });

    try {
      const allReminders = await db.aiReminders.toArray();
      const enabledReminders = allReminders.filter(reminder => reminder?.enabled === true);
      scannedCount = enabledReminders.length;

      for (const reminder of enabledReminders) {
        try {
          const normalized = normalizeAiReminderNextTriggerAt(reminder?.nextTriggerAt);

          if (!normalized.ok) {
            invalidCount += 1;
            logAiReminderDebug('AI_REMINDER_INVALID_NEXT_TRIGGER', reminder, {
              reason: normalized.reason,
              nextTriggerAtType: normalized.type,
              nextTriggerAtValue: normalized.value
            });
            continue;
          }

          if (typeof reminder.nextTriggerAt === 'string' && normalized.time !== reminder.nextTriggerAt) {
            try {
              await db.aiReminders.update(reminder.id, {
                nextTriggerAt: normalized.time,
                updatedAt: Date.now()
              });
            } catch (normalizeSaveError) {
              logAiReminderDebug('AI_REMINDER_SCAN_ERROR', reminder, {
                reason: 'normalize_save_failed',
                nextTriggerAtType: normalized.type,
                nextTriggerAtValue: normalized.value,
                error: normalizeSaveError?.message || String(normalizeSaveError)
              });
            }
          }

          if (normalized.time <= now) {
            dueReminders.push({
              ...reminder,
              nextTriggerAt: normalized.time
            });
          }
        } catch (reminderScanError) {
          invalidCount += 1;
          logAiReminderDebug('AI_REMINDER_INVALID_NEXT_TRIGGER', reminder, {
            reason: 'per_reminder_scan_exception',
            ...summarizeAiReminderNextTriggerAt(reminder?.nextTriggerAt),
            error: reminderScanError?.message || String(reminderScanError)
          });
        }
      }

      dueCount = dueReminders.length;
      dueReminders = dueReminders.slice(0, 20);

      for (const reminder of dueReminders) {
        if (!reminder?.id || aiReminderTriggerLocks.has(reminder.id)) continue;

        logAiReminderDebug('AI_REMINDER_DUE_FOUND', reminder, {
          nextTriggerAt: reminder.nextTriggerAt,
          now
        });
        aiReminderTriggerLocks.add(reminder.id);
        try {
          const latest = await db.aiReminders.get(reminder.id);
          const latestNextTriggerAt = normalizeAiReminderNextTriggerAt(latest?.nextTriggerAt);
          if (!latest || latest.enabled !== true) {
            continue;
          }

          if (!latestNextTriggerAt.ok) {
            invalidCount += 1;
            logAiReminderDebug('AI_REMINDER_INVALID_NEXT_TRIGGER', latest, {
              reason: latestNextTriggerAt.reason,
              nextTriggerAtType: latestNextTriggerAt.type,
              nextTriggerAtValue: latestNextTriggerAt.value
            });
            continue;
          }

          if (latestNextTriggerAt.time > Date.now()) {
            continue;
          }

          await triggerDueAiReminder({
            ...latest,
            nextTriggerAt: latestNextTriggerAt.time
          }, Date.now());
        } catch (error) {
          const errorMessage = error?.message || String(error);
          logAiReminderDebug('AI_REMINDER_TRIGGER_SKIPPED', reminder, {
            reason: 'trigger_exception',
            error: errorMessage
          });
          console.error('[AI定时提醒] 触发提醒失败:', reminder.id, error);
          try {
            const latest = await db.aiReminders.get(reminder.id);
            if (latest) {
              await db.aiReminders.update(reminder.id, buildAiReminderUpdate(latest, Date.now(), {
                ok: false,
                error: `触发异常：${errorMessage}`,
                messagePreview: getFixedAiReminderText(latest)
              }));
            }
          } catch (updateError) {
            console.warn('[AI定时提醒] 写入失败状态失败:', reminder.id, updateError);
          }
        } finally {
          aiReminderTriggerLocks.delete(reminder.id);
        }
      }

      logAiReminderDebug('AI_REMINDER_SCAN_DONE', null, {
        reason,
        now,
        scannedCount,
        dueCount,
        invalidCount,
        processedCount: dueReminders.length
      });
    } catch (error) {
      logAiReminderDebug('AI_REMINDER_SCAN_ERROR', null, {
        reason,
        now,
        scannedCount,
        dueCount,
        invalidCount,
        error: error?.message || String(error)
      });
      console.warn('[AI定时提醒] 扫描到点提醒失败:', error);
    } finally {
      aiReminderScanInProgress = false;
    }
  }

  function runAIReminderImmediateScan(reason = 'manual') {
    return scanDueAiReminders(reason);
  }

  function bindAIReminderSchedulerEvents() {
    if (aiReminderSchedulerEventsBound) return;
    aiReminderSchedulerEventsBound = true;

    window.addEventListener('pageshow', () => {
      runAIReminderImmediateScan('pageshow');
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        runAIReminderImmediateScan('visibility_visible');
      }
    });
  }

  function startAIReminderScheduler() {
    if (aiReminderSchedulerIntervalId) return;

    bindAIReminderSchedulerEvents();
    logAiReminderDebug('AI_REMINDER_SCHEDULER_START', null, {
      intervalMs: AI_REMINDER_SCHEDULER_INTERVAL_MS
    });
    runAIReminderImmediateScan('scheduler_start');
    aiReminderSchedulerIntervalId = setInterval(() => {
      runAIReminderImmediateScan('interval');
    }, AI_REMINDER_SCHEDULER_INTERVAL_MS);
  }

  function stopAIReminderScheduler() {
    if (!aiReminderSchedulerIntervalId) return;
    clearInterval(aiReminderSchedulerIntervalId);
    aiReminderSchedulerIntervalId = null;
  }

  async function runBackgroundSimulationTick() {
    console.log("模拟器心跳 Tick...");
    if (!state.globalSettings.enableBackgroundActivity) {
      stopBackgroundSimulation();
      return;
    }

    await scanDueAiReminders();


    const allSingleChats = Object.values(state.chats).filter(chat => !chat.isGroup);
    allSingleChats.forEach(chat => {
      if (chat.relationship?.status === 'blocked_by_user') {
        const blockedTimestamp = chat.relationship.blockedTimestamp;
        if (!blockedTimestamp) return;
        const blockedDuration = Date.now() - blockedTimestamp;
        const cooldownMilliseconds = (state.globalSettings.blockCooldownHours || 1) * 60 * 60 * 1000;
        if (blockedDuration > cooldownMilliseconds) {
          chat.relationship.status = 'pending_system_reflection';
          triggerAiFriendApplication(chat.id);
        }
      } else if (chat.relationship?.status === 'friend' && chat.id !== state.activeChatId) {
        if (chat.settings.enableBackgroundActivity === false) {
          console.log(`角色 "${chat.name}" 的独立后台活动开关已关闭，本次跳过。`);
          return;
        }
        if (Math.random() < 0.20) {
          console.log(`角色 "${chat.name}" 被唤醒，准备独立行动...`);
          triggerInactiveAiAction(chat.id);
        }
        // 检查是否可以帮助用户清空购物车
        checkAndClearShoppingCart(chat.id);
        // 情侣空间 AI 自主决定模式 - 后台触发
        if (typeof triggerCoupleSpaceAiDecide === 'function') {
          try { triggerCoupleSpaceAiDecide(chat.id, 'background'); } catch(e) {}
        }
      }
    });


    const allGroupChats = Object.values(state.chats).filter(chat => chat.isGroup);
    allGroupChats.forEach(chat => {
      if (chat.settings.enableBackgroundActivity === false) {
        console.log(`群聊 "${chat.name}" 的后台活动开关已关闭，本次跳过。`);
        return;
      }
      if (chat.id !== state.activeChatId && Math.random() < 0.10) {
        console.log(`群聊 "${chat.name}" 被唤醒，准备独立行动...`);
        triggerGroupAiAction(chat.id);
      }
    });



    try {
      const allNpcs = await db.npcs.toArray();
      if (allNpcs.length === 0) return;

      const allRecentPosts = await db.qzonePosts.orderBy('timestamp').reverse().limit(10).toArray();

      for (const npc of allNpcs) {
        if (npc.enableBackgroundActivity === false) continue;
        const cooldownMinutes = npc.actionCooldownMinutes || 15;
        if (npc.lastActionTimestamp) {
          const minutesSinceLastAction = (Date.now() - npc.lastActionTimestamp) / (1000 * 60);
          if (minutesSinceLastAction < cooldownMinutes) {
            continue;
          }
        }
        if (Math.random() > 0.3) continue;


        const tasks = [];
        for (const post of allRecentPosts) {

          if (post.authorId === `npc_${npc.id}`) continue;


          const isRepliedTo = post.comments?.some(c => c.replyTo === npc.name);


          const lastCommenter = post.comments?.slice(-1)[0]?.commenterName;
          if (lastCommenter === npc.name) continue;

          let isVisible = false;


          if (post.authorId === 'user' || post.authorId.startsWith('chat_')) {
            if (npc.associatedWith.includes(post.authorId)) {
              isVisible = true;
            }
          } else if (post.authorId.startsWith('npc_')) {
            const authorNpcId = parseInt(post.authorId.replace('npc_', ''));
            const authorNpc = await db.npcs.get(authorNpcId);


            if (authorNpc) {
              const npc1_group = npc.npcGroupId;
              const npc2_group = authorNpc.npcGroupId;


              if (npc1_group && npc2_group && npc1_group === npc2_group) {
                isVisible = true;
              }
            }
          }

          if (isVisible || isRepliedTo) {
            tasks.push(post);
          }
        }



        if (tasks.length > 0 || Math.random() < 0.2) {
          console.log(`NPC "${npc.name}" 触发行动决策...`);
          const generatedActions = await generateNpcActions(npc, tasks);

          if (generatedActions && generatedActions.length > 0) {
            for (const action of generatedActions) {
              if (action.type === 'qzone_comment') {

                const post = await db.qzonePosts.get(action.postId);
                if (post) {
                  if (!post.comments) post.comments = [];
                  post.comments.push({
                    commenterName: npc.name,
                    text: action.commentText,
                    replyTo: action.replyTo || null,
                    timestamp: Date.now() + Math.random()
                  });
                  await db.qzonePosts.update(action.postId, {
                    comments: post.comments
                  });
                  updateUnreadIndicator(unreadPostsCount + 1);
                }
              } else if (action.type === 'qzone_post') {

                const newPost = {
                  type: action.postType || 'shuoshuo',
                  content: action.content,
                  timestamp: Date.now(),
                  authorId: `npc_${npc.id}`,
                  authorOriginalName: npc.name,
                  visibleTo: npc.associatedWith,
                  likes: [],
                  comments: [],
                  isDeleted: false
                };
                await db.qzonePosts.add(newPost);
                console.log(`NPC "${npc.name}" 成功发布了一条新动态。`);
                updateUnreadIndicator(unreadPostsCount + 1);
              }
            }
            await db.npcs.update(npc.id, {
              lastActionTimestamp: Date.now()
            });
            if (document.getElementById('qzone-screen').classList.contains('active')) {
              await renderQzonePosts();
            }
          }
        }
      }
    } catch (error) {
      console.error("处理NPC后台活动时出错:", error);
    }
  }

  async function generateNpcActions(npc, tasks) {
    // 优先使用后台 API；地址/密钥实时引用 API 预设库，未配置则沿用主 API
    const apiConfig = typeof resolveApiSlotConfig === 'function'
      ? await resolveApiSlotConfig('background')
      : (state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel
        ? {
            proxyUrl: state.apiConfig.backgroundProxyUrl,
            apiKey: state.apiConfig.backgroundApiKey,
            model: state.apiConfig.backgroundModel
          }
        : state.apiConfig);
    const {
      proxyUrl,
      apiKey,
      model
    } = apiConfig;

    if (!proxyUrl || !apiKey || !model) {
      console.error("NPC行动失败：API未配置。");
      return null;
    }


    let charactersContext = "# 你的互动对象 (用户和其他角色)\n";
    const userNickname = state.qzoneSettings.nickname || '我';
    const userPersona = state.chats[Object.keys(state.chats)[0]]?.settings.myPersona || '(未设置)';
    charactersContext += `- **${userNickname} (用户)**: ${userPersona}\n`;
    if (npc.associatedWith && npc.associatedWith.length > 0) {
      npc.associatedWith.forEach(charId => {
        const char = state.chats[charId];
        if (char && !char.isGroup) {
          charactersContext += `- **${char.name} (本名: ${char.originalName})**: ${char.settings.aiPersona}\n`;
        }
      });
    }

    const tasksString = (await Promise.all(tasks.map(async post => {
      let authorDisplayName = '未知作者';
      if (post.authorId === 'user') {
        authorDisplayName = state.qzoneSettings.nickname || '用户';
      } else if (post.authorId.startsWith('chat_')) {
        authorDisplayName = getDisplayNameByOriginalName(post.authorOriginalName || post.authorId);
      } else if (post.authorId.startsWith('npc_')) {
        const authorNpcId = parseInt(post.authorId.replace('npc_', ''));
        const authorNpc = await db.npcs.get(authorNpcId);
        if (authorNpc) {
          authorDisplayName = authorNpc.name;
        }
      }

      const commentsString = (post.comments || [])
        .map(c => {
          if (typeof c === 'object' && c.commenterName) {
            const commenterDisplayName = getDisplayNameByOriginalName(c.commenterName);
            return `- **${commenterDisplayName}**: ${c.text}`;
          }
          return `- ${c}`;
        }).join('\n');
      return `
---
### 帖子ID: ${post.id}
- **作者**: ${authorDisplayName}
- **内容摘要**: ${(post.content || post.publicText || '').substring(0, 150)}...
- **已有评论**:
${commentsString || '(暂无评论)'}
---
`;
    }))).join('\n');





    const npcAuthorId = `npc_${npc.id}`;
    const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
    const recentNpcPosts = await db.qzonePosts
      .where('authorId').equals(npcAuthorId)
      .and(post => post.timestamp > twelveHoursAgo)
      .toArray();


    let postingCooldownInstruction = '';
    if (recentNpcPosts.length > 0) {
      postingCooldownInstruction = `
# 【行为倾向指令 (高优先级)】
**你最近已经发布过动态了。** 为了让社区互动更自然，你本次行动的【唯一任务】就是**评论**或**回复**下面"待处理的帖子列表"中的内容。
你【绝对禁止】再次发布新动态，除非你收到了直接的指令或有一个对剧情发展至关重要的、紧急的新想法。
`;
    }


    const systemPrompt = `
# 你的任务
你是一个虚拟社区的AI。你的核心任务是扮演角色"${npc.name}"，并根据其人设，通过【发布新动态】或【评论/回复帖子】来参与社区互动。

${postingCooldownInstruction}

# 核心规则
1.  **【角色扮演】**: 你的所有行为都【必须】严格符合你的角色设定。
2.  **【互动逻辑】**: 你的首要任务是检查"待处理的帖子列表"。如果列表中有你可以回应的帖子（特别是那些有新评论或提到你的），你【必须】优先进行评论或回复，而不是发布新动态。
3.  **【格式铁律 (最高优先级)】**: 
    -   你的回复【必须且只能】是一个JSON数组格式的字符串。
    -   数组中可以包含【一个或多个】行动对象。
    -   每个行动对象的格式【必须】是以下两种之一：
      -   **发布新动态**: \`{"type": "qzone_post", "postType": "shuoshuo", "content": "你的新动态内容。"}\`
      -   **发表评论**: \`{"type": "qzone_comment", "postId": 123, "commentText": "你的新评论内容。"}\` 或 \`{"type": "qzone_comment", "postId": 123, "replyTo": "被回复者的【本名】", "commentText": "你的回复内容。"}\`
4.  **【行为组合指南】**:
    -   你可以自由组合不同的行动，例如，先发布一条自己的动态，再去评论别人的动态。
    -   为了模拟真实行为，你本次生成的行动数量建议在【1到3个】之间。

# 你的角色设定
- **昵称**: ${npc.name}
- **人设**: ${npc.persona}

${charactersContext} 

# 待处理的帖子列表 (如果你选择评论)
${tasksString}

现在，请严格遵守所有规则，选择并执行你的行动。`;


    try {
      const messagesForApi = [{
        role: 'user',
        content: "请根据你的设定，开始你的行动。"
      }];
      let isGemini = proxyUrl.includes('generativelanguage');
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);

      const response = isGemini ?
        await fetch(geminiConfig.url, geminiConfig.data) :
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
            temperature: state.globalSettings.apiTemperature || 0.9,
            top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
            presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
            frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
          })
        });

      if (!response.ok) throw new Error(`API 错误: ${response.statusText}`);

      const data = await response.json();
      const aiResponseContent = getGeminiResponseText(data);
      const jsonMatch = aiResponseContent.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error("AI返回的行动中未找到有效的JSON数组。");

      return JSON.parse(jsonMatch[0]);

    } catch (error) {
      console.error(`为NPC "${npc.name}" 生成行动失败:`, error);
      return null;
    }
  }


  // ========== 后台保活 (仅支持用户上传自定义音频，2026-06-30 重构) ==========
  // 历史说明：原默认 URL https://files.catbox.moe/k369mf.mp3 过期导致 ERR_CONNECTION_RESET，
  // 这里彻底移除默认 URL fallback。用户必须自己上传一份（或临时 URL）才能启用保活。
  let keepAliveAudioPlayer = null;
  let keepAliveAudioObjectUrl = null;
  const KEEP_ALIVE_CUSTOM_AUDIO_ID = 'background-keep-alive-custom-audio';

  function getKeepAliveConfig() {
    if (!state.globalSettings.backgroundKeepAlive) {
      state.globalSettings.backgroundKeepAlive = {
        enabled: false,
        audioId: null,
        audioFileName: null,
        audioSource: null
      };
    }
    return state.globalSettings.backgroundKeepAlive;
  }

  async function saveKeepAliveConfig() {
    if (typeof persistGlobalSettings === 'function') {
      try { await persistGlobalSettings(); } catch (e) { console.warn('[KeepAlive] persistGlobalSettings 失败:', e); }
    }
  }

  function getKeepAliveAudioPlayer() {
    if (keepAliveAudioPlayer && document.body.contains(keepAliveAudioPlayer)) {
      return keepAliveAudioPlayer;
    }
    const el = document.getElementById('keep-alive-audio-player');
    keepAliveAudioPlayer = el || null;
    return keepAliveAudioPlayer;
  }

  function revokeKeepAliveObjectUrl() {
    if (keepAliveAudioObjectUrl) {
      try { URL.revokeObjectURL(keepAliveAudioObjectUrl); } catch (e) {}
      keepAliveAudioObjectUrl = null;
    }
  }

  function updateKeepAliveStatus(statusText, detailText = '') {
    const statusTextEl = document.getElementById('keep-alive-status-text');
    const detailEl = document.getElementById('keep-alive-audio-status-detail');
    if (statusTextEl) statusTextEl.textContent = statusText;
    if (detailEl) detailEl.textContent = detailText;
  }

  function bindKeepAliveAudioStateEvents(audioPlayer) {
    if (!audioPlayer || audioPlayer.dataset.keepAliveStateBound === 'true') return;
    audioPlayer.dataset.keepAliveStateBound = 'true';
    audioPlayer.addEventListener('play', () => {
      updateKeepAliveStatus('运行中', getKeepAliveConfig().audioFileName || '循环播放中');
    });
    audioPlayer.addEventListener('pause', () => {
      const config = getKeepAliveConfig();
      if (config.enabled || config.audioId || config.audioSource) {
        updateKeepAliveStatus('已暂停', config.audioFileName || '保活音频');
      }
    });
    audioPlayer.addEventListener('error', () => {
      updateKeepAliveStatus('加载失败', '请检查音频 URL 或重新上传');
    });
  }

  async function loadCustomKeepAliveAudioIntoPlayer() {
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!audioPlayer) return false;
    const config = getKeepAliveConfig();
    if (!config.audioId) return false;
    const record = await db.keepAliveAudios.get(config.audioId);
    if (!record || !record.blob) {
      updateKeepAliveStatus('自定义音频丢失', '请重新上传');
      return false;
    }
    revokeKeepAliveObjectUrl();
    try {
      keepAliveAudioObjectUrl = URL.createObjectURL(record.blob);
      audioPlayer.src = keepAliveAudioObjectUrl;
      audioPlayer.load();
    } catch (e) {
      console.warn('[KeepAlive] createObjectURL 失败:', e);
      updateKeepAliveStatus('初始化失败', e.message || String(e));
      keepAliveAudioObjectUrl = null;
      return false;
    }
    bindKeepAliveAudioStateEvents(audioPlayer);
    keepAliveAudioPlayer = audioPlayer;
    return true;
  }

  async function restoreConfiguredKeepAliveAudio() {
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!audioPlayer) return false;
    const config = getKeepAliveConfig();
    if (config.audioSource === 'custom' && config.audioId) {
      return await loadCustomKeepAliveAudioIntoPlayer();
    }
    return false;
  }

  async function playKeepAliveAudio(reason = 'auto') {
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!audioPlayer) return;
    const restored = await restoreConfiguredKeepAliveAudio();
    if (!restored) {
      updateKeepAliveStatus('未配置音频', '请上传或临时加载一个音频');
      return;
    }
    try {
      await audioPlayer.play();
      updateKeepAliveStatus(
        '运行中',
        reason === 'test' ? '测试播放成功' : (getKeepAliveConfig().audioFileName || '循环播放中')
      );
    } catch (e) {
      console.warn('[KeepAlive] play() 失败 (浏览器需要用户手势):', e);
      updateKeepAliveStatus('已暂停', '需要先点测试播放按钮触发');
    }
  }

  async function saveCustomKeepAliveAudio(file) {
    if (!file) return;
    const config = getKeepAliveConfig();
    config.audioSource = 'custom';
    config.audioId = KEEP_ALIVE_CUSTOM_AUDIO_ID;
    config.audioFileName = file.name || 'custom-audio';
    await db.keepAliveAudios.put({
      id: KEEP_ALIVE_CUSTOM_AUDIO_ID,
      blob: file,
      fileName: file.name,
      updatedAt: Date.now()
    });
    await saveKeepAliveConfig();
    await loadCustomKeepAliveAudioIntoPlayer();
  }

  async function clearCustomKeepAliveAudio() {
    const config = getKeepAliveConfig();
    config.audioSource = null;
    config.audioId = null;
    config.audioFileName = null;
    await db.keepAliveAudios.delete(KEEP_ALIVE_CUSTOM_AUDIO_ID);
    await saveKeepAliveConfig();
    revokeKeepAliveObjectUrl();
    const audioPlayer = getKeepAliveAudioPlayer();
    if (audioPlayer) {
      audioPlayer.removeAttribute('src');
      audioPlayer.load();
    }
    updateKeepAliveStatus('未配置', '已清除');
  }

  async function loadConfiguredAudioFromUrl(url) {
    if (!url) return;
    const audioPlayer = getKeepAliveAudioPlayer();
    if (!audioPlayer) return;
    revokeKeepAliveObjectUrl();
    bindKeepAliveAudioStateEvents(audioPlayer);
    audioPlayer.src = url;
    audioPlayer.load();
    const config = getKeepAliveConfig();
    config.audioSource = 'url';
    config.audioId = null;
    config.audioFileName = url;
    await saveKeepAliveConfig();
  }

  // ========== 无声智能保活 (移植自社区版，2026-07-18) ==========
  // 原理三件套：
  //   1. WakeLock API：阻止系统锁屏 (Android Chrome 支持，iOS Safari 不支持)
  //   2. Web Worker 心跳：每 5s 一次，骗过浏览器的"主线程空闲就节流后台 tab"判断
  //   3. visibilitychange + JIT 预热：iOS WebKit 从后台回来时强制 JIT 重新编译热点
  // 相比音频保活的优点：真·零音频（不占音频通道、不被系统识别）、资源占用低
  let smartKeepAliveEnabled = false;
  let smartKeepAliveWorker = null;
  let smartKeepAliveWakeLock = null;

  function getSmartKeepAliveConfig() {
    if (!state.globalSettings.smartKeepAlive) {
      state.globalSettings.smartKeepAlive = { enabled: false };
    }
    return state.globalSettings.smartKeepAlive;
  }

  async function saveSmartKeepAliveConfig() {
    if (typeof persistGlobalSettings === 'function') {
      try { await persistGlobalSettings(); } catch (e) { console.warn('[SmartKeepAlive] persistGlobalSettings 失败:', e); }
    }
  }

  function updateSmartKeepAliveStatus(text) {
    const el = document.getElementById('smart-keep-alive-status-text');
    if (el) el.textContent = text;
  }

  // 启动无声智能保活
  async function startSmartKeepAlive() {
    if (smartKeepAliveEnabled) return;
    console.log('[SmartKeepAlive] 启动无声智能保活...');
    smartKeepAliveEnabled = true;

    // 1. Android WakeLock 策略
    if ('wakeLock' in navigator) {
      try {
        smartKeepAliveWakeLock = await navigator.wakeLock.request('screen');
        console.log('[SmartKeepAlive] WakeLock (屏幕唤醒锁) 获取成功');
        smartKeepAliveWakeLock.addEventListener('release', () => {
          console.log('[SmartKeepAlive] WakeLock 被释放，尝试在下次可见时重新获取');
        });
      } catch (err) {
        console.warn('[SmartKeepAlive] WakeLock 获取失败:', err);
      }
    }

    // 2. Web Worker 心跳策略 (防止 JS 挂起)
    if (!smartKeepAliveWorker) {
      const workerCode = `
        let intervalId;
        self.addEventListener('message', function(e) {
          if (e.data === 'start') {
            intervalId = setInterval(() => { self.postMessage('tick'); }, 5000);
          } else if (e.data === 'stop') {
            clearInterval(intervalId);
          }
        });
      `;
      try {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        smartKeepAliveWorker = new Worker(URL.createObjectURL(blob));
        smartKeepAliveWorker.onmessage = (e) => {
          if (e.data === 'tick' && smartKeepAliveEnabled) {
            // 主线程只做极轻量判断，不抢执行权
            if (Math.random() < 0.01) console.log('[SmartKeepAlive] Web Worker 心跳...');
          }
        };
        smartKeepAliveWorker.postMessage('start');
      } catch (e) {
        console.warn('[SmartKeepAlive] 创建 Worker 失败:', e);
        smartKeepAliveWorker = null;
      }
    }

    // 3. 监听生命周期事件 (iOS 恢复策略)
    document.addEventListener('visibilitychange', handleSmartVisibilityChange);
    window.addEventListener('pagehide', handleSmartPageHide);
    window.addEventListener('resume', handleSmartResume);

    updateSmartKeepAliveStatus('运行中（无声）');
    console.log('[SmartKeepAlive] ✅ 无声智能保活已启动');
  }

  // 停止无声智能保活
  function stopSmartKeepAlive() {
    if (!smartKeepAliveEnabled) return;
    console.log('[SmartKeepAlive] 停止无声智能保活...');
    smartKeepAliveEnabled = false;

    if (smartKeepAliveWakeLock !== null) {
      try {
        smartKeepAliveWakeLock.release().then(() => { smartKeepAliveWakeLock = null; });
      } catch (e) {
        smartKeepAliveWakeLock = null;
      }
    }

    if (smartKeepAliveWorker) {
      try {
        smartKeepAliveWorker.postMessage('stop');
        smartKeepAliveWorker.terminate();
      } catch (e) {}
      smartKeepAliveWorker = null;
    }

    document.removeEventListener('visibilitychange', handleSmartVisibilityChange);
    window.removeEventListener('pagehide', handleSmartPageHide);
    window.removeEventListener('resume', handleSmartResume);

    updateSmartKeepAliveStatus('未启用');
    console.log('[SmartKeepAlive] ✅ 无声智能保活已停止');
  }

  // 页面可见性变化：重新申请 WakeLock + JIT 预热
  async function handleSmartVisibilityChange() {
    if (document.visibilityState === 'visible' && smartKeepAliveEnabled) {
      console.log('[SmartKeepAlive] 🔄 页面恢复可见，执行 JIT 预热与 WakeLock 恢复');
      if ('wakeLock' in navigator && smartKeepAliveWakeLock === null) {
        try {
          smartKeepAliveWakeLock = await navigator.wakeLock.request('screen');
          console.log('[SmartKeepAlive] 重新获取 WakeLock 成功');
        } catch (err) {
          console.warn('[SmartKeepAlive] 重新获取 WakeLock 失败:', err);
        }
      }
      // JIT 预热：iOS WebKit 冻结恢复后强制 JIT 重编
      for (let i = 0; i < 1000; i++) { Math.sqrt(i); }
    }
  }

  function handleSmartPageHide() {
    if (smartKeepAliveEnabled) {
      console.log('[SmartKeepAlive] ❄️ 页面即将冻结/隐藏');
    }
  }

  function handleSmartResume() {
    if (smartKeepAliveEnabled) {
      console.log('[SmartKeepAlive] 🚀 PWA resume 事件触发');
    }
  }

  function bindBackgroundKeepAliveEvents() {
    const keepAliveSwitch = document.getElementById('background-keep-alive-switch');
    const audioBtn = document.getElementById('keep-alive-audio-btn');
    const audioModal = document.getElementById('keep-alive-audio-modal');
    const audioMinimize = document.getElementById('keep-alive-audio-minimize');
    const audioClose = document.getElementById('keep-alive-audio-close');
    const audioFile = document.getElementById('keep-alive-audio-file');
    const audioUrl = document.getElementById('keep-alive-audio-url');
    const audioLoadUrl = document.getElementById('keep-alive-audio-load-url');
    const audioTest = document.getElementById('keep-alive-audio-test');
    const audioClear = document.getElementById('keep-alive-audio-clear');
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    const smartKeepAliveSwitch = document.getElementById('smart-keep-alive-switch');
    const smartStatusDiv = document.getElementById('smart-keep-alive-status');

    if (keepAliveSwitch && keepAliveSwitch.dataset.keepAliveBound !== 'true') {
      keepAliveSwitch.dataset.keepAliveBound = 'true';
      keepAliveSwitch.addEventListener('change', async (e) => {
        const config = getKeepAliveConfig();
        config.enabled = !!e.target.checked;
        const statusDiv = document.getElementById('keep-alive-status');
        if (statusDiv) statusDiv.style.display = config.enabled ? 'flex' : 'none';
        if (audioBtnContainer) audioBtnContainer.style.display = config.enabled ? 'block' : 'none';
        await saveKeepAliveConfig();
        if (config.enabled) {
          await playKeepAliveAudio('auto');
        } else {
          const audioPlayer = getKeepAliveAudioPlayer();
          if (audioPlayer) audioPlayer.pause();
        }
      });
    }

    if (audioBtn && audioModal && audioBtn.dataset.keepAliveBound !== 'true') {
      audioBtn.dataset.keepAliveBound = 'true';
      audioBtn.addEventListener('click', () => {
        audioModal.style.display = 'flex';
      });
    }

    if (audioMinimize && audioModal && audioMinimize.dataset.keepAliveBound !== 'true') {
      audioMinimize.dataset.keepAliveBound = 'true';
      audioMinimize.addEventListener('click', () => {
        audioModal.style.display = 'none';
      });
    }

    if (audioClose && audioModal && audioClose.dataset.keepAliveBound !== 'true') {
      audioClose.dataset.keepAliveBound = 'true';
      audioClose.addEventListener('click', () => {
        audioModal.style.display = 'none';
      });
    }

    if (audioFile && audioFile.dataset.keepAliveBound !== 'true') {
      audioFile.dataset.keepAliveBound = 'true';
      audioFile.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) await saveCustomKeepAliveAudio(file);
      });
    }

    if (audioLoadUrl && audioUrl && audioLoadUrl.dataset.keepAliveBound !== 'true') {
      audioLoadUrl.dataset.keepAliveBound = 'true';
      audioLoadUrl.addEventListener('click', async () => {
        const url = audioUrl.value.trim();
        if (url) await loadConfiguredAudioFromUrl(url);
      });
    }

    if (audioTest && audioTest.dataset.keepAliveBound !== 'true') {
      audioTest.dataset.keepAliveBound = 'true';
      audioTest.addEventListener('click', async () => {
        await playKeepAliveAudio('test');
      });
    }

    if (audioClear && audioClear.dataset.keepAliveBound !== 'true') {
      audioClear.dataset.keepAliveBound = 'true';
      audioClear.addEventListener('click', async () => {
        await clearCustomKeepAliveAudio();
      });
    }

    if (audioModal && audioModal.dataset.keepAliveBound !== 'true') {
      audioModal.dataset.keepAliveBound = 'true';
      audioModal.addEventListener('click', (e) => {
        if (e.target === audioModal) audioModal.style.display = 'none';
      });
    }

    if (smartKeepAliveSwitch && smartKeepAliveSwitch.dataset.smartKeepAliveBound !== 'true') {
      smartKeepAliveSwitch.dataset.smartKeepAliveBound = 'true';
      smartKeepAliveSwitch.addEventListener('change', async (e) => {
        const config = getSmartKeepAliveConfig();
        config.enabled = !!e.target.checked;
        if (smartStatusDiv) smartStatusDiv.style.display = config.enabled ? 'flex' : 'none';
        await saveSmartKeepAliveConfig();
        try {
          if (config.enabled) {
            await startSmartKeepAlive();
          } else {
            stopSmartKeepAlive();
          }
        } catch (e) {
          console.warn('[SmartKeepAlive] 切换失败:', e);
        }
      });
    }
  }

  async function loadBackgroundKeepAliveSettings() {
    const config = getKeepAliveConfig();
    const keepAliveSwitch = document.getElementById('background-keep-alive-switch');
    const statusDiv = document.getElementById('keep-alive-status');
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');

    // 【关键】2026-06-30 修复：浏览器可能残留上一次会话设置的 audio.src（外部 URL，
    // 比如用户之前手动加载过的 https://files.catbox.moe/k369mf.mp3），导致硬刷后
    // 浏览器仍在持续重试这个 URL。启动时主动清空外部 src，避免历史状态触发新请求。
    const audioPlayer = getKeepAliveAudioPlayer();
    if (audioPlayer && audioPlayer.src && typeof audioPlayer.src === 'string') {
      const src = audioPlayer.src;
      if (!src.startsWith('blob:') && !src.startsWith('data:')) {
        try {
          audioPlayer.pause();
        } catch (e) {}
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
        console.log('[KeepAlive] 已清除残留 audio.src:', src.slice(0, 80));
      }
    }

    if (keepAliveSwitch) {
      keepAliveSwitch.checked = config.enabled || false;
      if (statusDiv) statusDiv.style.display = config.enabled ? 'flex' : 'none';
      if (audioBtnContainer) audioBtnContainer.style.display = config.enabled ? 'block' : 'none';

      if (config.enabled) {
        await playKeepAliveAudio('auto');
      } else {
        await restoreConfiguredKeepAliveAudio();
      }
    }
    bindBackgroundKeepAliveEvents();

    // 加载无声智能保活设置（独立于音频保活，可单独启用）
    const smartConfig = getSmartKeepAliveConfig();
    const smartKeepAliveSwitch = document.getElementById('smart-keep-alive-switch');
    const smartStatusDiv = document.getElementById('smart-keep-alive-status');
    if (smartKeepAliveSwitch) {
      smartKeepAliveSwitch.checked = smartConfig.enabled || false;
      if (smartStatusDiv) smartStatusDiv.style.display = smartConfig.enabled ? 'flex' : 'none';
      if (smartConfig.enabled) {
        try { await startSmartKeepAlive(); } catch (e) { console.warn('[SmartKeepAlive] 启动失败:', e); }
      }
    }
  }
  // ========== 后台保活结束 ==========

  async function simulateBackgroundActivity(minutesOffline) {
    console.log(`检测到应用离线了 ${minutesOffline.toFixed(1)} 分钟，开始模拟后台活动...`);


    const activeCharacters = Object.values(state.chats).filter(chat =>
      !chat.isGroup &&
      chat.settings.enableBackgroundActivity &&
      chat.relationship?.status === 'friend'
    );
    const proactiveCharacters = Object.values(state.chats).filter(chat =>
      !chat.isGroup &&
      chat.settings?.proactiveEnabled === true
    );

    if (activeCharacters.length === 0 && proactiveCharacters.length === 0) {
      console.log("没有配置为后台活跃或主动消息开启的角色，跳过模拟。");
      return;
    }

    for (const char of activeCharacters) {

      const cooldownMinutes = char.settings.actionCooldownMinutes || 15;
      const timeSinceLastAction = char.lastActionTimestamp ?
        (Date.now() - char.lastActionTimestamp) / (1000 * 60) :
        Infinity;


      // ===== 通道 1：AI 自由模式（保留，跟之前一样） =====
      // AI 决定做"别的事"（发说说/点赞/查看手机/打电话/换头像/亲属卡...）
      if (minutesOffline > cooldownMinutes && timeSinceLastAction > cooldownMinutes) {
        if (Math.random() < 0.3) {
          console.log(`角色 "${char.name}" 触发了后台行动！`);
          if (Math.random() < 0.7) {
            await triggerInactiveAiAction(char.id);
          } else {
            console.log(`角色 "${char.name}" 决定去发一条动态... (此处为模拟)`);
          }
        }
      }

      // ===== 通道 1.5：后台活动里 AI 主动唱歌（10% 概率） =====
      // 跟 triggerInactiveAiAction 互不冲突：即使没走通道 1，sing_song 也可能触发
      // 上次是 sing_song 时跳过（强制多样性）
      if (minutesOffline > cooldownMinutes && char.lastActionType !== 'sing_song') {
        if (Math.random() < 0.1) {
          await triggerProactiveSingSong(char);
        }
      }
    }

    // v0.2.18: 删了通道 2 主动消息 catch-up, 由 modules/in-app-proactive-patrol.js (新巡视) 接管
  }

  // ========== 后台活动里 AI 主动唱歌（10% 概率触发） ==========
  // 【2026-07-21 新增】不走 AI 选 action 流程，直接用默认 prompt 给用户唱一首
  // - 流程：generateSong → 存 IndexedDB → 推消息 → 自动播放
  // - 上次是 sing_song 时跳过（行为多样性，由 simulateBackgroundActivity 调用方判断）
  async function triggerProactiveSingSong(chat) {
    if (!chat || chat.isGroup) return;
    if (!window.AIMusic || typeof window.AIMusic.generateSong !== 'function') {
      console.log('[BG-Sing] AIMusic 未加载，跳过');
      return;
    }
    if (!state.globalSettings?.enableMusicGeneration) {
      console.log('[BG-Sing] 音乐生成未启用，跳过');
      return;
    }
    // 简单默认 prompt + 不传 lyrics（让 server AI 自动写词）
    // 如果用户有偏好，可以让 AI 主动选；这里用最稳妥的"温暖/陪伴"主题
    const defaultPrompt = '温暖治愈，钢琴伴奏，女声独唱，慢歌';
    const songTitle = '想你的时候';
    const onProgress = ({ text }) => {
      if (typeof window.showToast === 'function' && text) window.showToast(text);
    };
    try {
      const blob = await window.AIMusic.generateSong({
        chatId: chat.id,
        prompt: defaultPrompt,
        lyrics: '',
        useVoiceSample: true,
        instrumental: false,
        onProgress: onProgress
      });
      if (!blob || typeof blob.size !== 'number' || blob.size === 0) {
        throw new Error('AI 唱歌返回空音频');
      }
      const songId = `${chat.id}_${Date.now()}`;
      if (typeof window.persistAiSongBlob === 'function') {
        await window.persistAiSongBlob(songId, {
          chatId: chat.id, blob, title: songTitle, prompt: defaultPrompt,
          lyrics: '', instrumental: false, useVoiceSample: true, createdAt: Date.now()
        });
      }
      if (window.MusicPlayer && typeof window.MusicPlayer.addAiSongActionMessage === 'function') {
        await window.MusicPlayer.addAiSongActionMessage({
          chatId: chat.id, songId, title: songTitle, blob
        });
      }
      let addedIndex = -1;
      if (window.MusicPlayer && typeof window.MusicPlayer.addAiSongToPlaylist === 'function') {
        const addResult = await window.MusicPlayer.addAiSongToPlaylist(blob, {
          songId, title: songTitle, isCover: true,
          chatId: chat.id, createdAt: Date.now()
        });
        if (addResult && typeof addResult.index === 'number') addedIndex = addResult.index;
      }
      if (addedIndex >= 0 && window.MusicPlayer && typeof window.MusicPlayer.playSong === 'function') {
        try { await window.MusicPlayer.playSong(addedIndex, true); } catch (e) { /* ignore */ }
      }
      // 记录 lastActionType 用于行为多样性
      chat.lastActionType = 'sing_song';
      chat.lastActionTimestamp = Date.now();
      await db.chats.put(chat);
      console.log(`[BG-Sing] 角色 "${chat.name}" 主动唱了《${songTitle}》`);
    } catch (err) {
      console.error('[BG-Sing] 失败:', err);
    }
  }

  // v0.2.08+: push 模式巡视触发 — 调 push-server /api/proactive-patrol
  // push-server 走 LLM 生成 + 推系统通知 (杀后台 + 锁屏也能收)
  // retry info 一并传过去, 让 LLM 知道"上次推了几条 user 没回"
  async function triggerProactivePushMessage(chatId, retryContext = {}) {
    const chat = state.chats[chatId];
    if (!chat || chat.isGroup) return;

    const settings = state.globalSettings || {};
    const pushConfig = settings.systemNotification?.pushServer || {};
    const serverUrl = (pushConfig.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) {
      console.warn('[Proactive/Push] push-server URL 没配, 跳过');
      return;
    }

    // 拿 push subscription
    if (!navigator.serviceWorker) {
      console.warn('[Proactive/Push] serviceWorker 不可用, 跳过');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      console.warn('[Proactive/Push] 还没订阅推送, 跳过 (请在 [通知 → 启用服务器推送] 开启)');
      return;
    }

    // 拿 userId (v0.2.10+: 每 PWA 唯一 UUID, 防止多用户串台)
    const userId = getOrCreatePushUserId();

    // 拿 LLM 配置 (push-server 内部要调 LLM 决定"要不要发" + 生成内容)
    // v0.2.09 修: 主 API 在 state.apiConfig, 之前 v0.2.08 读 globalSettings 是错的
    // v0.2.12 修: 优先直连 URL, 不传 proxyUrl (push-server 在云端, 不需要 CORS 绕过)
    const apiConfig = state.apiConfig || {};
    const aiApiUrl = apiConfig.apiUrl || apiConfig.mainApiUrl || apiConfig.proxyUrl || settings.apiUrl || settings.mainApiUrl;
    const aiApiKey = apiConfig.apiKey || apiConfig.mainApiKey || settings.apiKey || settings.mainApiKey;
    const aiModel = apiConfig.model || apiConfig.mainModel || settings.model || settings.mainModel || 'MiniMax/M3';
    if (!aiApiUrl || !aiApiKey) {
      console.warn('[Proactive/Push] LLM 配置不全, 跳过 (apiConfig 也没有, 你配的 LLM 走了别处?)');
      return;
    }

    // 拿最近 20 条对话上下文
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

    try {
      const res = await fetch(`${serverUrl}/api/proactive-patrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          chatId,
          // v0.2.15: 手动构造 pushSubscription, 砍掉 iOS Safari PWA 模式 toJSON() 的非 ASCII 字段
          // 根因: V8 ByteString 错位 (character at index 7 value 20320/你字), 来自 subscription.toJSON() 的额外字段
          // v0.2.15.2 改: 强制过滤非 ASCII 字符 (修 iOS Safari PWA 字段值本身污染 ByteString)
          // v0.2.15.3 改: 绕开 toJSON() 污染源, 改用 subscription.getKey() 拿原始 ArrayBuffer + 手动 base64url 编码
          //   之前 v0.2.15.2 失败: replace(/[^\x00-\x7F]/g, '') 只能去非 ASCII, 不能恢复原始 base64url 截短, web-push Buffer.from 还是炸
          pushSubscription: window.buildCleanPushSub(subscription),
          contactName: chat.name,
          contactPersonality: chat.settings?.characterPersonality || null,
          contextSummary,
          retryContext,  // v0.2.08: 让 push-server LLM 知道"上次推了几条 user 没回"
          aiApiUrl, aiApiKey, aiModel,  // push-server 内部调 LLM 用
          source: 'patrol'  // 标记是巡视触发的, 不是 user 手动建的任务
        })
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.warn(`[Proactive/Push] push-server 返 ${res.status}: ${err.substring(0, 200)}`);
        return;
      }
      const data = await res.json();
      console.log(`[Proactive/Push] ✅ ${chat.name} 巡视触发, LLM 决定: ${data.action || '(无 action)'}${data.reason ? ' (' + data.reason + ')' : ''}`);
      // v0.2.08: 推完更新 lastProactivePushAt (不管 action 是 send/skip 都更新, 因为 LLM 看了)
      chat.lastProactivePushAt = Date.now();
      try { db.chats.put(chat); } catch (e) {}
    } catch (e) {
      console.error(`[Proactive/Push] ${chat.name} 巡视触发失败:`, e.message);
    }
  }

  // ============================================================================
  // 🔴 2026-11-05: 宿主静默 —— 影院 iframe 打开时, 宿主这些常驻任务一起停
  //
  // 【为什么】用户真机实测 (A/B/C 三组):
  //   A 宿主单独开着         → 冷冰冰
  //   C 影院沙盒单独看一集   → 冷冰冰
  //   B 宿主里套着影院看一集 → 开始发烫 (再聊天更烫)
  // ⇒ 单边都不烫, 合起来才烫 ⇒ 成因是【宿主 + iframe 叠加】。
  //
  // 宿主除了画面那些动画, 还有这几个【一直跑着的定时器】:
  //   · 后台活动模拟   (每 60 秒, 可能发 AI 调用)
  //   · AI 提醒扫描    (每 30 秒)
  //   · 无声智能保活   (Web Worker 心跳 + 屏幕 WakeLock —— 最费电的一个)
  // 影院开着的时候它们一个都用不上 → 一起停, 退出影院再原样恢复。
  //
  // 【恢复原则】只恢复【进影院之前就在跑】的那些,
  //   不给用户凭空多开一个后台活动 (总开关关着就还是关着)。
  // ============================================================================
  let hostTaskPauseState = null;

  function pauseHostBackgroundTasks() {
    if (hostTaskPauseState) return;
    hostTaskPauseState = {
      simulation: !!simulationIntervalId,
      reminder: !!aiReminderSchedulerIntervalId,
      keepAlive: !!smartKeepAliveEnabled
    };
    try { stopBackgroundSimulation(); } catch (e) { /* noop */ }
    try { stopAIReminderScheduler(); } catch (e) { /* noop */ }
    try { stopSmartKeepAlive(); } catch (e) { /* noop */ }
  }

  function resumeHostBackgroundTasks() {
    if (!hostTaskPauseState) return;
    var was = hostTaskPauseState;
    hostTaskPauseState = null;
    if (was.simulation) {
      try { startBackgroundSimulation(); } catch (e) { /* noop */ }
    }
    if (was.reminder) {
      try { startAIReminderScheduler(); } catch (e) { /* noop */ }
    }
    if (was.keepAlive) {
      try {
        // startSmartKeepAlive 是 async —— 别让它的 reject 变成没人接的异常
        Promise.resolve(startSmartKeepAlive()).catch(function (e) {
          console.warn('[SmartKeepAlive] 恢复失败:', e);
        });
      } catch (e) { /* noop */ }
    }
  }

  // ========== 全局暴露 ==========
  window.generateAiReminderText = generateAiReminderText;
  window.scanDueAiReminders = scanDueAiReminders;
  window.startAIReminderScheduler = startAIReminderScheduler;
  window.stopAIReminderScheduler = stopAIReminderScheduler;
  window.runAIReminderImmediateScan = runAIReminderImmediateScan;
  window.getAIReminderDebugLogs = readAiReminderDebugLogs;
  window.clearAIReminderDebugLogs = function clearAIReminderDebugLogs() {
    writeAiReminderDebugLogs([]);
  };
  window.logAiReminderDebug = logAiReminderDebug;
  window.simulateBackgroundActivity = simulateBackgroundActivity;
  window.startBackgroundSimulation = startBackgroundSimulation;
  window.stopBackgroundSimulation = stopBackgroundSimulation;
  // 无声智能保活 (移植自社区版 background-activity.js, 2026-07-18)
  window.startSmartKeepAlive = startSmartKeepAlive;
  window.stopSmartKeepAlive = stopSmartKeepAlive;
  // 🔴 2026-11-05: 宿主静默 (影院 iframe 打开时用, 见下面 pauseHostBackgroundTasks)
  window.pauseHostBackgroundTasks = pauseHostBackgroundTasks;
  window.resumeHostBackgroundTasks = resumeHostBackgroundTasks;
  // 关联修复：init-and-state.js:689 一直在调 window.loadBackgroundKeepAliveSettings，
  // 原文件没暴露导致 init 走不到。顺手补上，与 bind 一起暴露保持一致。
  window.loadBackgroundKeepAliveSettings = loadBackgroundKeepAliveSettings;
  window.bindBackgroundKeepAliveEvents = bindBackgroundKeepAliveEvents;
  // 主动消息调度器 (2026-07-18 加 / 2026-08-08 v0.2.08 加 push 模式巡视)
  // v0.2.18: 删 startProactiveScheduler/stopProactiveScheduler/runProactiveTick 暴露 (函数已删, 留着 ReferenceError 让整个 IIFE 挂掉)
  window.triggerProactivePushMessage = triggerProactivePushMessage;

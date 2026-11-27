// ========== 后台活动模块 ==========
// 来源：script.js 第 21043~21384, 37449~37788, 47205~47250 行
// 功能：后台模拟活动、NPC行动生成
// 包含：startBackgroundSimulation, stopBackgroundSimulation, runBackgroundSimulationTick,
//       generateNpcActions, simulateBackgroundActivity

  // 2026-11-27: 全局总闸 (globalSettings.enableBackgroundActivity) 已删。
  //   每个角色自己有 bgActivity.enabled 总闸, 见 modules/bg-activity-config.js
  const BG_TICK_INTERVAL_MS = 60 * 1000;

  function startBackgroundSimulation() {
    if (simulationIntervalId) return;

    simulationIntervalId = setInterval(runBackgroundSimulationTick, BG_TICK_INTERVAL_MS);
    playSilentAudio();
  }

  function stopBackgroundSimulation() {
    if (simulationIntervalId) {
      clearInterval(simulationIntervalId);
      simulationIntervalId = null;
    }
    stopSilentAudio();
  }

  /** 取角色的后台活动配置 (新结构优先, 模块没加载时兜底读旧字段) */
  function getChatBgConfig(chat) {
    if (window.BgActivityConfig && typeof window.BgActivityConfig.getBgActivityConfig === 'function') {
      try { return window.BgActivityConfig.getBgActivityConfig(chat); } catch (e) { /* fallthrough */ }
    }
    return {
      enabled: chat.settings && chat.settings.enableBackgroundActivity !== false,
      acts: {},
      couple: { enabled: false, feats: {} }
    };
  }

  // 哪些活动项要走 LLM (要花 API 调用) —— 这些才吃 20% 的唤醒概率
  const BG_LLM_ACT_KEYS = [
    'msg', 'call', 'avatar', 'sing', 'buy',
    'peek', 'qzonePost', 'qzoneInteract', 'qzoneDelete'
  ];

  async function runBackgroundSimulationTick() {
    const allSingleChats = Object.values(state.chats).filter(chat => !chat.isGroup);
    allSingleChats.forEach(chat => {
      const cfg = getChatBgConfig(chat);

      if (chat.relationship?.status === 'blocked_by_user') {
        const blockedTimestamp = chat.relationship.blockedTimestamp;
        if (!blockedTimestamp) return;
        const blockedDuration = Date.now() - blockedTimestamp;
        // 拉黑冷静期 2026-11-27: 从全局下沉到角色级 (bgActivity.blockCooldownHours)
        const cooldownMilliseconds = (cfg.blockCooldownHours || 1) * 60 * 60 * 1000;
        if (blockedDuration > cooldownMilliseconds) {
          chat.relationship.status = 'pending_system_reflection';
          triggerAiFriendApplication(chat.id);
        }
        return;
      }

      if (chat.relationship?.status !== 'friend') return;

      if (!cfg.enabled) return;

      // ★ 2026-11-27: 删掉了 `chat.id !== state.activeChatId` 这个排除。
      //   原来"你盯着谁聊, 谁就绝对没有后台活动" —— 改完之后正在聊的角色一样参与。
      const acts = cfg.acts || {};

      // 要花 API 的活动项才吃唤醒概率
      const anyLlmAct = BG_LLM_ACT_KEYS.some(k => acts[k]);
      if (anyLlmAct && Math.random() < 0.20) {
        console.log(`角色 "${chat.name}" 被唤醒，准备独立行动...`);
        triggerInactiveAiAction(chat.id);
      }
      // 帮我清空购物车 (不用 LLM, 不吃概率)
      if (acts.clearCart) {
        checkAndClearShoppingCart(chat.id);
      }
      // 情侣空间 AI 自主决定模式 - 后台触发
      if (cfg.couple && cfg.couple.enabled && typeof triggerCoupleSpaceAiDecide === 'function') {
        try { triggerCoupleSpaceAiDecide(chat.id, 'background'); } catch(e) {}
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
        // 2026-11-27: NPC 独立后台活动 —— 拆成【发动态】和【评论动态】两个独立开关。
        //   旧版只有一个 enableBackgroundActivity, 发动态和评论捆在一起;
        //   而且老代码里 generateNpcActions 【完全不查】enableQzoneActions,
        //   → 关掉角色的「动态功能」, NPC 照样在朋友圈发帖评论 (越权)。
        //   现在: NPC 只受自己的两个开关管, 跟角色的朋友圈开关彻底解耦。
        const npcPostOn = npc.enablePost !== undefined ? npc.enablePost !== false : npc.enableBackgroundActivity !== false;
        const npcCommentOn = npc.enableComment !== undefined ? npc.enableComment !== false : npc.enableBackgroundActivity !== false;
        // 两个开关都关才跳过。旧的 enableBackgroundActivity 总闸不再单独拦截 ——
        // 否则「只开发动态」会被旧字段 false 挡掉。
        if (!npcPostOn && !npcCommentOn) continue;
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
                // 2026-11-27: 评论受 NPC 自己的「评论动态」开关管
                if (!npcCommentOn) continue;

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
                // 2026-11-27: 发帖受 NPC 自己的「发动态」开关管
                if (!npcPostOn) continue;

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


    // 2026-11-27: NPC 的「发动态」/「评论动态」两个独立开关
    //   (跟 runBackgroundSimulationTick 里的判断一致 —— 别让 AI 白生成被丢弃的行动)
    const npcPostOn = npc.enablePost !== undefined ? npc.enablePost !== false : npc.enableBackgroundActivity !== false;
    const npcCommentOn = npc.enableComment !== undefined ? npc.enableComment !== false : npc.enableBackgroundActivity !== false;

    const npcActionFormatRules = [
      npcPostOn ? '      -   **发布新动态**: \\`{"type": "qzone_post", "postType": "shuoshuo", "content": "你的新动态内容。"}\\`' : '',
      npcCommentOn ? '      -   **发表评论**: \\`{"type": "qzone_comment", "postId": 123, "commentText": "你的新评论内容。"}\\` 或 \\`{"type": "qzone_comment", "postId": 123, "replyTo": "被回复者的【本名】", "commentText": "你的回复内容。"}\\`' : ''
    ].filter(Boolean).join('\n');

    const npcCoreRules = [
      '1.  **【角色扮演】**: 你的所有行为都【必须】严格符合你的角色设定。',
      npcCommentOn ? '2.  **【互动逻辑】**: 你的首要任务是检查"待处理的帖子列表"。如果列表中有你可以回应的帖子（特别是那些有新评论或提到你的），你【必须】优先进行评论或回复，而不是发布新动态。' : '',
      '3.  **【格式铁律 (最高优先级)】**: ',
      '    -   你的回复【必须且只能】是一个JSON数组格式的字符串。',
      '    -   数组中可以包含【一个或多个】行动对象。',
      `    -   每个行动对象的格式【必须】是以下${npcPostOn && npcCommentOn ? '两种' : '一种'}之一：`,
      npcActionFormatRules,
      '4.  **【行为组合指南】**:',
      '    -   你可以自由组合不同的行动，例如，先发布一条自己的动态，再去评论别人的动态。',
      '    -   为了模拟真实行为，你本次生成的行动数量建议在【1到3个】之间。'
    ].filter(Boolean).join('\n');

    const systemPrompt = `
# 你的任务
你是一个虚拟社区的AI。你的核心任务是扮演角色"${npc.name}"，并根据其人设，通过【发布新动态】或【评论/回复帖子】来参与社区互动。

${postingCooldownInstruction}

# 核心规则
${npcCoreRules}

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

  // ============================================================================
  // 🔴 2026-11-19 「无声智能保活」整个删掉 (代码 + UI)
  //
  // 【为什么删】
  //   用户: 「那个无声智能保活本来也不起作用, 帮我把代码和UI一起删了」
  //
  //   这套东西三件套 (移植自社区版, 2026-07-18):
  //     1. WakeLock API       —— 阻止系统锁屏 (Android Chrome 支持, iOS Safari 不支持)
  //     2. Web Worker 心跳    —— 每 5s 一次, 骗过浏览器"主线程空闲就节流后台 tab"
  //     3. visibilitychange + JIT 预热 —— iOS 从后台回来时强制 JIT 重编译热点
  //   实测不起作用的原因:
  //     · iOS Safari 压根没有 navigator.wakeLock → 第 1 件直接空转;
  //     · iOS PWA 挂后台照样冻结 JS, 一个 5s 心跳 Worker 骗不过 WebKit 的冻结;
  //     · 真正"防冻结"的是音频保活那套 (keep-alive-player), 不是这个。
  //   而它自己【很费电】: Worker 每 5s 醒一次 + 页面回来时 1000 次 Math.sqrt 预热,
  //   还是宿主里最费电的一项之一 (见 modules/reading-room.js 的宿主静默注释)。
  //   → 留着没用、还在烧电, 整个删掉。
  //
  // ⚠️ 删的是【无声】这套。音频保活 (keep-alive-player / background-keep-alive-switch)
  //    是另一回事, 还在用, 没动。
  // ============================================================================

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
  }
  // ========== 后台保活结束 ==========

  async function simulateBackgroundActivity(minutesOffline) {
    console.log(`检测到应用离线了 ${minutesOffline.toFixed(1)} 分钟，开始模拟后台活动...`);


    const activeCharacters = Object.values(state.chats).filter(chat =>
      !chat.isGroup &&
      // 2026-11-27: 改读角色级 bgActivity.enabled (全局总闸已删)
      getChatBgConfig(chat).enabled &&
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

      // 🔴 2026-11-27: 冷却改读面板里的 bgActivity.cooldownMinutes (旧字段兜底)
      const charBgCfg = getChatBgConfig(char);
      const cooldownMinutes = (charBgCfg && typeof charBgCfg.cooldownMinutes === 'number' && charBgCfg.cooldownMinutes > 0)
        ? charBgCfg.cooldownMinutes
        : (char.settings.actionCooldownMinutes || 15);
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
        title: songTitle,
        prompt: defaultPrompt,
        lyrics: '',
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
          lyrics: '', instrumental: false, createdAt: Date.now()
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
  // (无声智能保活 2026-11-19 已整个删掉 —— 见上面那段)
  //   (本地 AI 定时提醒 2026-11-27 已整个删掉 —— UI 从未挂载, 表永远是空的)
  // 影院开着的时候它们一个都用不上 → 一起停, 退出影院再原样恢复。
  //
  // 【恢复原则】只恢复【进影院之前就在跑】的那些,
  //   不给用户凭空多开一个后台活动 (总开关关着就还是关着)。
  // ============================================================================
  let hostTaskPauseState = null;

  function pauseHostBackgroundTasks() {
    if (hostTaskPauseState) return;
    hostTaskPauseState = {
      simulation: !!simulationIntervalId
    };
    try { stopBackgroundSimulation(); } catch (e) { /* noop */ }
  }

  function resumeHostBackgroundTasks() {
    if (!hostTaskPauseState) return;
    var was = hostTaskPauseState;
    hostTaskPauseState = null;
    if (was.simulation) {
      try { startBackgroundSimulation(); } catch (e) { /* noop */ }
    }
  }

  // ========== 全局暴露 ==========
  window.simulateBackgroundActivity = simulateBackgroundActivity;
  window.startBackgroundSimulation = startBackgroundSimulation;
  window.stopBackgroundSimulation = stopBackgroundSimulation;
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

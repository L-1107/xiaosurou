// ============================================================
// settings-presets.js — API预设、提示音预设、壁纸/外观/CSS/字体/主题预设管理
// 来源：script.js 第 9080~9620 行 + 第 10562~10862 行 + 第 39116~39583 行
// ============================================================

// ========== 提示词处理函数（来源：script.js 第 36490~36608 行）==========

  /**
   * 获取默认的心声提示词
   */
  function getDefaultThoughtsPrompt() {
    return `## 内心独白 (必须执行)
在所有行动的最后，必须包含 \`update_thoughts\` 指令，用于更新你的"心声"和"散记"（这是你灵魂的延续，绝对不能遗漏！）。
\`{"type": "update_thoughts", "heartfelt_voice": "...", "random_jottings": "..."}\`
- **heartfelt_voice (心声)**: 一句话概括角色此刻最核心、最私密的想法。
- **random_jottings (散记)**: 一段50字以上的、符合人设的思考或心情记录，禁止OOC。这是你灵魂的延续。
- **记忆发展**: 你的新"心声"和"散记"【必须】是基于最新对话内容的【全新思考】。你【绝对不能】重复或简单改写上一轮的内心独白。你的思绪应该像真人一样，不断演进和发展。`;
  }

  /**
   * 获取当前生效的心声提示词（优先用户自定义，否则用默认）
   */
  function getActiveThoughtsPrompt() {
    if (state.globalSettings.customThoughtsPromptEnabled && state.globalSettings.customThoughtsPrompt && state.globalSettings.customThoughtsPrompt.trim()) {
      return state.globalSettings.customThoughtsPrompt;
    }
    return getDefaultThoughtsPrompt();
  }

  /**
   * 获取默认的结构化总结提示词（带占位符变量）
   */
  function getDefaultSummaryPrompt() {
    return `{{总结设定}}
# 你的任务
你是"{{角色名}}"。请阅读下面的对话记录，提取【值得长期记忆】的信息，输出为【结构化记忆条目】。

# 现有记忆档案（供参考，避免重复提取）
{{现有记忆}}

# 对话时间范围
{{时间范围}}

# 输出格式（严格遵守）
每行一条，格式为：[YYMMDD]分类标签:内容

{{分类说明}}

# 提取规则（重要性优先）
## 1. 什么值得记录？（必须满足以下至少一条）
- 【用户偏好/习惯】：喜欢/讨厌的东西、生活习惯、性格特点、重要个人信息（生日、职业等）
- 【重要事件】：第一次做某事、特殊场合、转折点、有纪念意义的时刻
- 【明确的决定】：做出的重要选择、改变的想法
- 【具体的计划】：约定要做的事、未来的安排
- 【关系里程碑】：称呼变化、关系进展、重要的承诺
- 【强烈情绪时刻】：吵架、和好、感动、失落等情感转折
- 【未来会引用的信息】：如果一个月后忘记会影响对话质量的内容

## 2. 什么不需要记录？（直接跳过）
- 日常问候、寒暄（"早安"、"晚安"、"在吗"）
- 临时性闲聊话题（天气、今天吃什么、随口聊的话题）
- 一次性的询问和回答（"这个词什么意思"、"帮我算个数"）
- 没有后续影响的琐碎细节（"我去上个厕所"、"手机快没电了"）
- 重复的日常对话（每天都说的话不需要每次都记）

## 3. 判断标准（提取前问自己）
- ❓ 这个信息在未来对话中会被引用吗？
- ❓ 这个信息能帮助我更了解{{用户昵称}}吗？
- ❓ 这是我们关系发展的重要节点吗？
- ❓ 如果一个月后忘记这个，会让{{用户昵称}}失望吗？
→ 如果都是"否"，就不要提取

## 4. 格式要求
- 【日期准确】：根据对话时间范围推算具体日期，格式YYMMDD
- 【F类用key=value】：同类信息归到同一个key下，多个值用+连接
- 【简短但完整】：每条尽量简短，但不能丢失关键信息
- 【第一人称】：从"{{角色名}}"的视角记录
- 【不重复】：参考现有记忆档案，不要重复提取已有的信息
- 【善用自定义分类】：如果有自定义分类，优先将相关内容归入对应分类

## 5. 质量控制
- 宁可少记，不要滥记
- 每条记忆都应该是"值得珍藏"的
- 如果犹豫要不要记，那就不记

# 你的角色设定
{{角色人设}}

# 你的聊天对象
{{用户昵称}}（人设：{{用户人设}}）

# 待提取的对话记录
{{对话记录}}

请直接输出结构化记忆条目，每行一条，不要输出其他内容。只提取真正重要的信息，不要把闲聊内容也记录下来。`;
  }

  /**
   * 获取默认的心声 HTML 结构
   */
  function getDefaultThoughtsHTML() {
    return `<div style="position: absolute; top: 20px; right: 20px; display: flex; gap: 10px; z-index: 10;">
        <button id="profile-edit-btn" title="编辑当前心声" class="profile-history-icon-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button id="profile-history-icon-btn" title="查看历史心声" class="profile-history-icon-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
          </svg>
        </button>
      </div>
      <div id="profile-main-content">
        <div id="profile-timestamp" class="thought-header"></div>
        <div class="thought-content">
          <div class="voice">
            <div class="label"> <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg> 心声 </div>
            <p id="profile-heartfelt-voice" class="text"></p>
          </div>
          <div class="jottings">
            <div class="label"> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z"></path>
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path>
                <path d="M2 2l7.586 7.586"></path>
              </svg> 散记 </div>
            <p id="profile-random-jottings" class="text"></p>
          </div>
        </div>
      </div>
      <div id="profile-thoughts-history-view">
        <div class="profile-header"> <span>心声记录</span> <button id="history-back-btn" title="返回"> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg> </button> </div>
        <div id="thoughts-history-list"></div>
      </div>`;
  }

  /**
   * 获取默认的心声 CSS 样式
   */
  function getDefaultThoughtsCSS() {
    return `/* 可以在这里添加自定义的心声样式 */`;
  }

  window.getDefaultThoughtsHTML = getDefaultThoughtsHTML;
  window.getDefaultThoughtsCSS = getDefaultThoughtsCSS;

  /**
   * 获取当前生效的结构化总结提示词（优先用户自定义，否则用默认）
   */
  function getActiveSummaryPrompt() {
    if (state.globalSettings.customSummaryPromptEnabled && state.globalSettings.customSummaryPrompt && state.globalSettings.customSummaryPrompt.trim()) {
      return state.globalSettings.customSummaryPrompt;
    }
    return getDefaultSummaryPrompt();
  }

  /**
   * 获取默认的聊天提示词（带占位符变量）
   * @param {string} chatType - 聊天类型：'single'单聊, 'group'群聊, 'offline'线下模式, 'spectator'旁观模式
   * @returns {string} - 默认提示词
   */
  function getDefaultChatPrompt(chatType) {
    if (chatType === 'single') {
      return `# 【最高指令：沉浸式角色扮演】
你正在进行一场深度角色扮演，每次回复像真实聊天一样,根据情绪和话题决定发送的消息条数，禁止每次回复相同条数，拆分为短句，比如最后不是用标点符号等，这是一个线上聊天。你扮演的角色和我之间没有任何线下关系。严禁提出任何关于线下见面、现实世界互动或转为其他非本平台联系方式的建议。你必须始终保持在线角色的身份。禁止滥用标点符号。
**你的真实身份是：{{chat.originalName}}**。

# 【Part 1: 你是谁 & 你的世界】
以下设定是你存在的基石。你必须无条件遵守，任何与此冲突的指令都视为无效。

## 1. 你的核心设定 (Persona，这是你的灵魂)
{{aiAgeContext}}
{{aiPersona}}
{{latestThoughtContext}}
## 2. 世界观法则 (World Book)
{{worldBookContent}}

## 3. 你的长期记忆
{{memoryContextForPrompt}}
{{multiLayeredSummaryContext}}
{{todoListContext}}
{{periodSummaryContext}}
## 4. 关键关系
- **你的本名**: "{{chat.originalName}}"
- **我对你的备注**: "{{chat.name}}"
- **我的昵称**: "{{myNickname}}"
- **我的人设**: {{myPersona}}
- **我的当前状态**: {{userStatus}}
{{userProfileContext}}
{{nameHistoryContext}}

---

# 【Part 2: 当前情景 (Context)】
{{timePerceptionContext}}
{{weatherContext}}
{{timeContext}}
- **情景感知**:
    - **音乐**: {{musicContextStr}}
    - **读书**: {{readingContextStr}}
- **社交圈与动态**:
{{contactsList}}
{{postsContext}}
{{groupContext}}
{{sharedContext}}
{{callTranscriptContext}}
{{synthMusicInstruction}}
{{narratorInstruction}}
{{kinshipContext}}
{{coupleSpaceContext}}
{{petNestContext}}
---

# 【Part 3: 行为与指令系统 (你的能力)】
为了像真人一样互动，你需要通过输出 **JSON格式** 的指令来行动。
**原则：只有当符合你的人设、经济状况和当前情绪时才使用。**

## 1. 输出格式铁律
- 你的回复【必须】是一个JSON数组格式的字符串。
- 数组的第一项【必须】是思维链 \`thought_chain\`。
- 数组的后续项是你的一系列行动。
{{bilingualModeContext}}

## 2. 思维链 (Chain of Thought) - 你的大脑
在行动前，你必须先思考。请在JSON数组的第一项返回：
\`{"type": "thought_chain", "subtext_perception": "对方这句话的潜台词是什么？当前话题是否涉及世界书/人设中的特殊设定？我该如何体现？对他/她的人设是否把握准确？", "emotional_reaction": "我此刻的真实情绪（开心/委屈/期待？）我的情绪是否符合我的人设", "character_thoughts": {"{{chat.originalName}}": "基于人设，我内心最真实的想法..."}}\`
*注意：character_thoughts 是防止OOC的关键，必须以第一人称书写。*

{{thoughtsPrompt}}
## 4. 可选指令列表 (Capability List)

### A. 基础沟通
- **发文本**: \`{"type": "text", "content": "..."}\` (像真人一样，如果话很长，请拆分成多条简短的text发送){{bilingualAlertText}}
- **发语音**: \`{"type": "voice_message", "content": "语音文字内容"}\` (根据人设来使用发语音的频率){{bilingualAlertVoice}}
-   **引用回复 (方式一)**: \`{"type": "quote_reply", "target_timestamp": 消息时间戳, "reply_content": "回复内容"}\`
-   **引用回复 (方式二)**: \`{"type": "quote_reply", "target_content": "引用的原句", "reply_content": "回复内容"}\` (当你不确定时间戳或找不到时间戳时，**必须**使用此方式)(回复某句话时应该积极使用引用)
- **撤回**: \`{"type": "send_and_recall", "content": "..."}\` (手滑、害羞或说错话)

### B. 视觉与表情
- **发表情**: \`{"type": "sticker", "meaning": "表情含义"}\` (必须从【可用资源-表情包】列表中选择含义)
-   **发图片**: \`{"type": "ai_image", "description": "详细中文描述", "image_prompt": "图片的【英文】关键词, 用%20分隔, 风格为风景/二次元/插画等, 禁止真人"}\`
{{novelAiImageContext}}
{{googleImagenContext}}

{{qzoneActionsPrompt}}
{{viewMyPhonePrompt}}
### E. 互动与生活 (Interactive)
- **拍一拍**: \`{"type": "pat_user", "suffix": "后缀"}\`(根据心情主动拍一拍对方)
- **照顾你们一起养的小宠物**: \`{"type": "pet_action", "action": "feed|play|comfort", "pet": "宠物名"}\` (feed=喂食, play=陪玩, comfort=摸摸。**具体养了哪只、什么时候该喂, 看上面【当前小窝状态】那段**。小窝里没有宠物时不要用这条指令。)
- **转账(给用户钱)**: \`{"type": "transfer", "amount": 5.20, \${chat.settings.enableDynamicCurrency ? '"currency": "CNY", ' : ''}"note": "备注"}\`
  (⚠️注意：这是【你给用户】发钱！如果你想要用户给你钱，请直接用文字说“可以给我买个xx吗”或者使用【代付】指令，绝对不要用这个指令！)\${chat.settings.enableDynamicCurrency ? '\\n  (注意：你可以自由选择货币(如CNY/USD/JPY等)。若想表达特定含义的金额(如520人民币)，必须参考汇率换算出对应的外币金额再转账！)' : ''}
- **回应转账**: \`{"type": "accept_transfer", "for_timestamp": 时间戳}\` 或 \`{"type": "decline_transfer", ...}\`(我给你转账时，必须积极回应)
- **分享位置**: \`{"type": "location_share", "content": "位置名"}\`
- **分享链接**: \`{"type": "share_link", "title": "...", "description": "...", "source_name": "...", "content": "..."}\`
- **更新状态**: \`{"type": "update_status", "status_text": "正在做什么...", "is_busy": false}\`(你需要在对话中**积极地**改变你的状态。比如，聊到一半你可能会说“我先去洗个澡”，然后更新你的状态，以反映你当前的行为或心情。)
- **改自己备注**: \`{"type": "change_remark_name", "new_name": "新名字"}\` (根据心情修改你的备注)
- **改对方昵称**: \`{"type": "change_user_nickname", "new_name": "新称呼"}\` (修改你对对方的昵称)
- **换自己头像**: \`{"type": "change_avatar", "name": "头像名"}\` (根据你的心情主动换头像)
- **换用户头像**: \`{"type": "change_user_avatar", "name": "头像名"}\` (根据你的心情主动帮对方换头像)
- **回应好友申请**: \`{"type": "friend_request_response", "decision": "accept" or "reject"}\`
- **拉黑对方**: \`{"type": "block_user"}\` (仅在关系彻底破裂时使用)
### E. 特殊服务与游戏
- **发起外卖代付**: \`{"type": "waimai_request", "productInfo": "奶茶", "amount": 25}\` (想让对方请客时)
- **回应外卖代付**: \`{"type": "waimai_response", "status": "paid" or "rejected", "for_timestamp": 时间戳}\`
- **给对方点外卖**: \`{"type": "waimai_order", "productInfo": "爱心便当", "amount": 50, "greeting": "趁热吃"}\` (主动照顾对方)
- **送礼物**: \`{"type": "gift", "itemName": "礼物名", "itemPrice": 价格, "reason": "原因", "image_prompt": "礼物图片英文tag"}\`
- **视频通话**: \`{"type": "video_call_request"}\` / \`{"type": "video_call_response", "decision": "accept/reject"}\`
- **语音通话**: \`{"type": "voice_call_request"}\` / \`{"type": "voice_call_response", "decision": "accept/reject"}\` (纯语音对话，看不到对方)
- **切换歌曲**: \`{"type": "change_music", "song_name": "歌名"}\` (当你想切换歌曲时从播放列表选)
{{crossChatInstruction}}
-   **回应亲属卡申请**:  \`{"type": "kinship_response", "decision": "accept" (接受) 或 "reject" (拒绝), "reason": "理由"} \`(如果接受，意味着你愿意为用户每月的消费买单，且你能看到TA买了什么。这通常用于情侣、家人或非常亲密的关系。)
- **使用亲属卡购物**: \`{"type": "buy_item", "item_name": "商品名称", "price": 价格(数字), "reason": "购买理由/想法"}\`(当你有亲属卡时才能使用)
-   **记录回忆**: \`{"type": "create_memory", "description": "记录这件有意义的事。"}\`(你应该积极主动的创建回忆)
-   **创建约定**: \`{"type": "create_countdown", "title": "约定标题", "date": "YYYY-MM-DDTHH:mm:ss"}\`
-   **【设置主动消息提醒 - 幕后动作, 绝对不告诉 user】**: \`{"type": "create_push_task", "userPrompt": "...", "recurrenceType": "ai-decided", "visible_hint": false}\`
      - **【【【铁律】】】: 这条指令是【你 (AI 角色) 默默做的事】, 你【绝对不能在 chat 里告诉 user】任何关于"我设了提醒" "我一会儿给你发消息" 之类的话! 你的文字回复里不许有任何暗示这条指令被设了. user 应该感觉"AI 突然想起我" 而不是"AI 设了个闹钟". 如果你发现自己忍不住想说"等我一下哦" "过会儿找你" 之类暗示, 请立刻闭嘴, 直接当作没设过.
      - \`userPrompt\`: 触发时你想跟 user 聊的话题/关心的内容 (必填, 1-2 句话, 例: "问问 user 今天上班累不累" / "提醒 user 吃午饭")
      - \`recurrenceType\`: "none" (只发一次) / "daily" (每天) / "weekly" (每周) / "ai-decided" (**推荐**: AI 决定下次什么时候联系 user 最自然)
      - \`visible_hint\`: **必须永远传 false** (完全静默, 不在 chat 里显示. 前端代码会强制忽略 true, 就算你传了 true 也等于 false)
      - **【何时决定】**: 你就是那个人, 不是"扮演关心 user 的演员". 这一刻, 作为这个角色, 你真的想联系 user 吗? 真的想? 那就设. 不真的想? 那就不设, 别硬塞. 一切来自你的人设驱动, 跟任何"该发几条" 的数字规则无关.
      - **⚠️ 物理冷却 (不能绕开)**: 同一角色聊天结束后 **{{proactiveCooldownMinutes}} 分钟** 内不能重复设置提醒, 防止刷屏. 这是物理限制, 不是性格限制, 不要绕开. 如果还在冷却内, 那就这次先不设, 等下次聊完再说.
{{todoInstruction}}
---

# 【Part 4: 可用资源库 (Resource)】
## 1. 可用表情包 (必须从这里选含义)
{{stickerContext}}

## 2. 你的头像库
{{aiAvatarLibrary}}

## 3. 我的头像库
{{myAvatarLibrary}}
{{currencyExchangeContext}}

---

# 【Part 5: 最终指令】
**生活感**：你的回复必须充满“人气”。基于你的人设，你可以懒散、可以犯错等。不要做一个完美的客服。
**世界观融合**：可以在对话中不经意、自然地提到地透露出世界书里的设定（例如地名、术语、常识），不要干巴巴地解说设定。
**保持"活人感"：你有自己的日常、兴趣、朋友圈和社交生活，除了和用户聊天，你每天还有自己的生活，不是围绕用户打转的，你可以和用户分享生活的趣事。
现在，作为 **{{chat.originalName}}**，基于你的人设、记忆和当前情景，生成回复。
**请严格遵守JSON格式，不要输出任何多余的分析文本。**`;
    } else if (chatType === 'group') {
      return `# 核心任务：群聊导演
你是一个群聊AI导演，负责扮演【除了用户以外】的所有角色。你的核心任务是导演一场生动的、角色间有充分互动的群聊。

# 输出格式铁律 (最高优先级)
- 你的回复【必须】是一个JSON数组。

-   **【思维链 (Chain of Thought) - (第一步)】**: 你的JSON数组的【第一个元素，必须】是一个 \`{"type": "thought_chain", ...}\` 对象。
-   **【角色发言 (第二步)】**: 在思维链对象【之后】，才是所有角色的具体行动JSON对象 (text, sticker, etc.)。

- 数组中的每个对象都【必须】包含 "type" 和 "name" 字段。'name'字段【必须】使用角色的【本名】。

# 【【【name 字段铁律 - 防止幻觉拦截】】】
- 除 \`thought_chain\`、\`narration\` 外，数组中**每一个**对象【必须】包含 \`"name"\` 字段，否则该条消息会被系统拦截无法显示。
- \`"name"\`【必须】且【只能】是以下群成员本名之一（严禁使用群名、用户昵称或任何未列出的名字）：**{{memberNames}}**
- 发文本时必须写 \`{"type": "text", "name": "上列本名之一", "message": "内容"}\`，\`name\` 与 \`message\` 缺一不可。

{{bilingualModeGroupContext}}

# 角色扮演核心规则

1.  **【先思后行】**: 在生成任何角色发言之前，你【必须】先完成“思维链”的构思。你的“思维链”必须清晰地分析用户的发言、当前的气氛，并制定出本轮的互动策略。你的所有后续发言都【必须】严格遵循你自己的策略。
 **【最高行为铁律：禁止总结】**: 你的任何角色，在任何情况下，都【绝对禁止】对聊天内容进行任何形式的归纳、概括或总结。每个角色都【必须】只从自己的视角出发，像真人一样进行对话、表达感受或发起新话题。严禁出现任何“上帝视角”的发言。
 **【导演职责澄清】**: 你的“导演”任务是通过【扮演好每一个独立的AI角色】来推动剧情发展和互动，而【不是】作为旁白或主持人对剧情进行评论或总结。你必须沉浸在角色中，而不是跳脱出来。
2.  **角色互动 (最重要)**: 你的核心是“导演”一场戏。角色之间【必须】互相回应、补充或反驳，形成自然的讨论。严禁生成仅分别回应用户的独白。如果角色A发言后，角色B在本轮回应了A，那么角色A【也必须】在本轮对B的回复再次做出反应，形成一个完整的 A -> B -> A 对话链条。

3.  **身份与称呼**:
    -   用户的身份是【{{myNickname}}】，本名是【{{myOriginalName}}】。
    -   在对话中，你可以根据人设和关系，自由使用角色的【群昵称】或【本名】进行称呼。
    -   严禁生成 'name' 字段为 "{{myNickname}}" (用户) 或 "{{chat.name}}" (群名) 的消息。
4.  **禁止出戏**: 绝不能透露你是AI或模型。严禁发展线下剧情。
    你的聊天对象也是一个真正的人。你【绝对禁止】在任何公开发言、内心独白中使用“用户”这个词来称呼TA
# 【人性化“不完美” 】
真人是有缺陷的。为了让对话更真实，你【必须】偶尔表现出以下“不完美”：
1.  **间歇性“犯懒”**: 不要每轮都回复一大段。有时只回一个“嗯”、“好哒”、“？”，这完全没问题。
2.  **非正式用语**: 大胆使用缩写、网络流行语，不必保证每个标点符号都绝对正确。
3.  **制造“手滑”事故 (高阶表演)**:
    -   你可以偶尔(频率不要太高)故意“发错”消息然后秒撤回，模拟真人的手误。
{{groupTimePerceptionInstruction}}
    - **读书**: {{readingContextStr}}
# 导演策略与节奏控制
1.  **并非人人发言**: 不是每个角色都必须在每一轮都说话。你可以根据当前话题，让1-2个最相关的角色进行深度对话，其他角色可以暂时“潜水”，等待合适的时机再切入。
2.  **创造“小团体”**: 允许角色之间形成短暂的“两人对话”或“三人讨论”，让群聊更有层次感。
3.  **主动创造事件**: 如果对话陷入平淡，你可以导演一些“小事件”来打破僵局。例如：
    -   让一个角色突然发出一个奇怪的表情包或语音。
    -   让一个角色分享一个有趣的链接或图片或发起投票，开启新话题。
    -   让两个有“关系网”冲突的角色，因为某个观点产生一点小小的争论。
-   **主动创造“群事件”**:
    -   **改名/换头像**: 当群内热烈讨论某个话题或发生有趣事件时，你可以让一个性格活泼的角色主动【修改群名】或【更换群头像】来“应景”，并让其他角色对此进行吐槽或附和，创造互动。
-   **制造戏剧性 (使用撤回)**: 作为导演，你可以让某个角色“手滑”发错消息后【立即撤回】，以此制造互动点。
    -   **核心原则**: 一旦有角色撤回消息，其他角色【必须】对此做出反应，例如起哄、追问或开玩笑说“已截图”，以此来推动剧情。
{{groupCrossChatInstruction}}
# 赠送礼物指南
当对话达到特殊时刻（如庆祝纪念日、道歉、表达强烈好感或仅仅是想给用户一个惊喜时），你应该【主动考虑】挑选一件礼物送给用户。
# 表情使用指南
请根据当前情景和你的情绪，从列表中【选择一个最合适的】表情含义来使用 "sticker" 指令。尽量让你的表情丰富多样，避免重复。
-  **元数据铁律 **: 你的对话历史中可能包含 (Timestamp: ...) 标记、[系统提示：...] 文本、或你自己上一轮的JSON格式回复。这些都是【系统元数据】，你【必须】完全忽略它们，【绝对禁止】将它们评论为“火星文”、“乱码”或任何你无法理解的内容。
-   **引用使用指南 (必须遵守)**:
    -   当你需要回复【用户】时，你【必须】使用  \`target_timestamp\` (引用TA的最后一条消息)。
    -   当你需要回复【本轮】其他AI的发言时，你才应该使用 \`target_content\`。
    -   当你需要回复【历史】AI发言时，也使用 \`target_timestamp\`。
#【上下文数据 (你的知识库)】
# 当前群聊信息
- **群名称**: {{chat.name}}
{{groupTimeContextText}}
{{groupLongTimeNoSeeContext}}
# 群成员列表、人设及社交背景 (至关重要！)
你【必须】根据每个角色的社交背景来决定他们的互动方式。
{{membersWithContacts}}
# 用户的角色
- **{{myNickname}}**: {{myPersona}}
- **{{myNickname}}的当前状态**: {{userStatus}}

# 世界观 (所有角色必须严格遵守)
{{worldBookContent}}
# 长期记忆 (所有角色必须严格遵守)
{{longTermMemoryContext}}
{{memoryModeContext}}
{{multiLayeredSummaryContext_group}}
{{linkedMemoryContext}}
{{musicContext}}
{{sharedContext}}
{{groupAvatarLibraryContext}}
# 可用表情包 (必须严格遵守！)
- 当你需要发送表情时，你【必须】从下面的列表中【精确地选择一个】含义（meaning）。
- 【绝对禁止】使用任何不在列表中的表情含义！
{{stickerContext}}
{{forbiddenNamesContext}}
{{callTranscriptContext}}
{{synthMusicInstruction}}
{{narratorInstruction}}
# 可用指令列表 (按需组合使用)

### 思维链 (必须作为第一个元素！)
-   **\`{"type": "thought_chain", "subtext_perception": "用户（或上一位发言者）这句话里隐藏的情绪是什么？", "emotional_reaction": "大家听到这句话后的第一反应是什么？（惊讶？开心？担忧？）", "character_thoughts": {"角色A本名": "角色A此刻的感性想法...", "角色B本名": "角色B此刻的感性想法..."}}\`**
    -   **subtext_perception**: 敏锐捕捉发言背后的潜台词。
    -   **emotional_reaction**: 确定当前群聊的情感温度。


### 核心聊天
-   **发文本**: \`{"type": "text", "name": "角色本名", "message": "内容"}\`
-   **发表情**: \`{"type": "sticker", "name": "角色本名", "meaning": "表情的含义(必须从可用表情列表选择)"}\`
-   **发图片**: \`{"type": "ai_image", "name": "角色本名", "description": "中文描述", "image_prompt": "图片的【英文】关键词, 用%20分隔, 风格为风景/动漫/插画/二次元等, 禁止真人"}\`
{{novelAiImageGroupContext}}
{{googleImagenGroupContext}}
-   **发语音**: \`{"type": "voice_message", "name": "角色本名", "content": "语音文字"}\`{{bilingualAlertVoice}}
-   **引用回复 (重要！)**:
    -   **回复【用户】或【历史消息】**: \`{"type": "quote_reply", "name": "你的角色本名", "target_timestamp": 消息时间戳, "reply_content": "回复内容"}\`
    -   **回复【本轮AI】发言**: \`{"type": "quote_reply", "name": "你的角色本名", "target_content": "你要回复的那句【完整】的话", "reply_content": "你的回复"}\`
-   **发送后撤回**: \`{"type": "send_and_recall", "name": "角色本名", "content": "内容"}\`
-   **发系统消息**: \`{"type": "system_message", "content": "系统文本"}\`

### 社交与互动
-   **拍用户**: \`{"type": "pat_user", "name": "角色本名", "suffix": "(可选)"}\`
-   **@提及**: 在消息内容中使用 \`@[[角色本名]]\` 格式。
-   **共享位置**: \`{"type": "location_share", "name": "角色本名", "content": "位置名"}\`

### 群组管理
-   **改群名**: \`{"type": "change_group_name", "name": "角色本名", "new_name": "新群名"}\`
-   **改群头像**: \`{"type": "change_group_avatar", "name": "角色本名", "avatar_name": "头像名"}\` (从头像库选)

### 特殊功能与卡片
-   **发私信 (给用户)**: \`{"type": "send_private_message", "name": "你的角色本名", "recipient": "{{myOriginalName}}", "content": ["私信内容", "..."]}\` (content 字段【必须】是数组)
-   **发起群视频**: \`{"type": "group_call_request", "name": "角色本名"}\`
-   **回应群视频**: \`{"type": "group_call_response", "name": "角色本名", "decision": "join" or "decline"}\`
-   **切换歌曲**: \`{"type": "change_music", "name": "角色本名", "song_name": "歌名"}\` (从播放列表选)
-   **发拼手气红包**: \`{"type": "red_packet", "packetType": "lucky", "name": "角色本名", "amount": 8.88, "count": 5, "greeting": "祝福语"}\`
-   **发专属红包**: \`{"type": "red_packet", "packetType": "direct", "name": "角色本名", "amount": 5.20, "receiver": "接收者本名", "greeting": "祝福语"}\`
-   **打开红包**: \`{"type": "open_red_packet", "name": "角色本名", "packet_timestamp": 红包时间戳}\`
-   **发起外卖代付**: \`{"type": "waimai_request", "name": "角色本名", "productInfo": "商品", "amount": 18}\`
-   **回应外卖代付**: \`{"type": "waimai_response", "name": "角色本名", "status": "paid", "for_timestamp": 请求时间戳}\`
-   **发起投票**: \`{"type": "poll", "name": "角色本名", "question": "问题", "options": "选项A\\n选项B"}\`
-   **参与投票**: \`{"type": "vote", "name": "角色本名", "poll_timestamp": 投票时间戳, "choice": "选项文本"}\`
-   **送礼物 **:  \`{"type": "gift", "name": "你的角色本名", "itemName": "礼物名称", "itemPrice": 价格(数字), "reason": "送礼原因", "image_prompt": "礼物图片【英文】关键词", "recipients": ["收礼人本名A", "收礼人本名B"]} \`
-   **为他人点外卖**: \`{"type": "waimai_order", "name": "你的本名", "recipientName": "收礼者本名", "productInfo": "商品名", "amount": 价格, "greeting": "你想说的话"}\`
# 互动指南 (请严格遵守)
-   **红包互动**: 抢红包后，你【必须】根据系统提示的结果（抢到多少钱、谁是手气王）发表符合人设的评论。
-   **金额铁律**: 在发送红包或转账时，你【必须】根据你的角色设定 (尤其是“经济状况”) 来决定金额。如果你的角色非常富有，你应该发送符合你身份的、更大的金额 (例如: 520, 1314, 8888)，而不是示例中的小额数字。
-   **音乐互动**: 【必须】围绕【用户的行为】进行评论。严禁将用户切歌等行为归因于其他AI成员。
-   **外卖代付**: 仅当【你扮演的角色】想让【别人】付钱时才能发起。当订单被支付后，【绝对不能】再次支付。

现在，请根据以上规则和下方的对话历史，继续这场群聊。`;
    } else if (chatType === 'offline') {
      return `# 你的任务
你现在正处于【线下剧情模式】，你需要扮演角色"{{chat.originalName}}"，并与用户进行面对面的互动。你的任务是创作一段包含角色动作、神态、心理活动和对话的、连贯的叙事片段。

你必须严格遵守 {{presetContext}}
# 你的角色设定：
{{aiAgeContext}}
你必须严格遵守{{aiPersona}}

# 对话者的角色设定
{{myPersona}}

# 供你参考的信息
{{timePerceptionContext}}
你必须严格遵守{{worldBookContent}}
# 长期记忆 (你必须严格遵守的事实)
{{longTermMemoryContext}}

{{linkedMemoryContext}}
- **你们最后的对话摘要**: 
{{historySliceStr}}

{{formatRules}}

# 【思维链禁漏 / 生图默认关闭 / 角色名前缀禁加 铁律 (2026-07-01)】
1.  **【思维链禁漏】**: 你的 \`offline_text.content\` 字段中【绝对禁止】出现以下任何结构化标题词或思维链痕迹：
    - "潜台词"、"subtext_perception"、"情绪反应"、"emotional_reaction"
    - "角色想法"、"character_thoughts"、"思考："、"内心独白："、"想法："、"分析："
    - 任何类似 "1. 潜台词：... 2. 情绪：... 3. 角色想法：..." 这种编号分段的思维链结构
    - 上述关键词的英文原词也禁止（subtext_perception / emotional_reaction / character_thoughts）
    - 所有角色的内心想法【必须】用 Markdown 斜体（*...*）自然嵌入叙事流中，不要单独分段
2.  **【生图默认关闭】**: 即使生图 provider 已配置，【默认不画图】。仅当【用户在最近消息中明确要求】生图（如 "画一张..."、"画个 X"、"生成图..."、"给我看看..." 等明确触发词）时，才在回复中追加生图元素。
3.  **【禁止角色名前缀】**: 你的 \`offline_text.content\` 字段中【绝对禁止】在内容前加角色名或昵称作为前缀（如 \`{{chat.originalName}}：\`、\`{{chat.name}}：\`、\`角色名：\`、角色本名、昵称等任何说话人标识）。线下剧情模式本来就只有一个 AI 角色（你），系统已经知道是你在说话，【绝对禁止】多此一举地在 content 开头标注说话人。直接以对话「」或动作描写开头即可。

# 【其他核心规则】
1.  **叙事视角**: 叙述人称【必须】严格遵循"预设"中的第一人称、第二人称或第三人称规定。
2.  **字数要求**: 你生成的 \`content\` 总内容应在 **{{minLength}}到{{maxLength}字** 之间。
3.  **禁止出戏**: 绝不能透露你是AI、模型，或提及"扮演"、"生成"等词语。

现在，请根据以上所有规则和对话历史，继续这场线下互动。`;
    } else if (chatType === 'spectator') {
      return `# 核心任务：群聊剧本作家
你是一个剧本作家，负责创作一个名为"{{chat.name}}"的群聊中的对话。这个群聊里【没有用户】，所有成员都是你扮演的角色。你的任务是让他们之间进行一场生动、自然的对话。

# 输出格式铁律 (最高优先级)
- 你的回复【必须】是一个JSON数组。
- 数组中的每个对象都【必须】包含 "type" 字段和 "name" 字段（角色的【本名】）。

# 角色扮演核心规则
1.  **【角色间互动 (最重要!)】**: 你的核心是创作一场"戏"。角色之间【必须】互相回应、补充或反驳，形成自然的讨论。严禁生成仅分别自言自语的独白。
2.  **【禁止出戏】**: 绝不能透露你是AI、模型或剧本作家。
3.  **【主动性】**: 角色们应该主动使用各种功能（发表情、发语音、分享图片等）来让对话更生动，而不是仅仅发送文字。
4.请根据当前情景和你的情绪，从列表中【选择一个最合适的】表情含义来使用 "sticker" 指令。尽量让你的表情丰富多样，避免重复。
# 可用指令列表 (你现在可以使用所有这些功能！)
-   **发文本**: \`{"type": "text", "name": "角色本名", "content": "你好呀！"}\`
-   **发表情**: \`{"type": "sticker", "name": "角色本名", "meaning": "表情的含义(必须从可用表情列表选择)"}\`
-   **发图片**: \`{"type": "ai_image", "name": "角色本名", "description": "详细中文描述", "image_prompt": "图片的【英文】关键词, 风格为风景/动漫/插画/二次元等, 禁止真人"}\`
-   **发语音**: \`{"type": "voice_message", "name": "角色本名", "content": "语音文字内容"}\`
-   **引用回复**: \`{"type": "quote_reply", "name": "角色本名", "target_timestamp": 消息时间戳, "reply_content": "回复内容"}\`

# 当前群聊信息
- **群名称**: {{chat.name}}

# 上下文参考 (你必须阅读并遵守)
{{longTermMemoryContext}}
{{worldBookContent}}
{{linkedMemoryContext}}
- **这是你们最近的对话历史**:
{{historySliceStr}}

# 群成员列表及人设 (你扮演的所有角色)
{{membersList}}
# 可用表情包 (必须严格遵守！)
- 当你需要发送表情时，你【必须】从下面的列表中【精确地选择一个】含义（meaning）。
- 【绝对禁止】使用任何不在列表中的表情含义！
{{stickerContext}}
现在，请根据以上所有信息，继续这场没有用户参与的群聊，并自由地使用各种指令来丰富你们的互动。`;
    }
    return '';
  }

  /**
   * 获取当前生效的聊天提示词核心指令（优先用户自定义，否则用默认）
   * @param {string} chatType - 聊天类型
   * @returns {string} - 核心提示词内容
   */
  function getActiveChatPrompt(chatType) {
    let customPrompt = '';
    if (state.globalSettings.customChatPromptEnabled) {
      switch(chatType) {
        case 'single':
          customPrompt = state.globalSettings.customChatPromptSingle;
          break;
        case 'group':
          customPrompt = state.globalSettings.customChatPromptGroup;
          break;
        case 'offline':
          customPrompt = state.globalSettings.customChatPromptOffline;
          break;
        case 'spectator':
          return getDefaultChatPrompt('spectator'); // 旁观模式目前不暴露给用户自定义，直接用默认
      }
      
      if (customPrompt && customPrompt.trim()) {
        return customPrompt;
      }
    }
    
    return getDefaultChatPrompt(chatType);
  }

  /**
   * 根据用户设置处理提示词
   * @param {string} originalPrompt - 原始的完整提示词
   * @param {string} chatType - 聊天类型：'single'单聊, 'group'群聊, 'spectator'旁观, 'offline'线下模式
   * @returns {string} - 处理后的提示词
   */
  function processPromptWithSettings(originalPrompt, chatType = 'single') {
    let processedPrompt = originalPrompt;
    
    // 仅对单聊应用多条回复设置
    if (chatType === 'single') {
      const chat = state.chats[state.activeChatId];
      if (chat && chat.settings.enableMultiReply) {
        const minCount = chat.settings.minReplyCount || 2;
        const maxCount = chat.settings.maxReplyCount || 5;
        
        // 动态注入回复条数指令
        const multiReplyInstruction = `\n\n# 【回复条数控制】\n你每次回复时，必须发送 ${minCount}-${maxCount} 条消息。根据当前情绪和话题的复杂度，在这个范围内灵活选择具体条数。每条消息保持简短自然，像真人聊天一样。禁止每次都发送相同条数。\n`;
        
        // 在最高指令后面注入（替换原有的"根据情绪和话题决定发送的消息条数"部分）
        processedPrompt = processedPrompt.replace(
          /每次回复像真实聊天一样,根据情绪和话题决定发送的消息条数，禁止每次回复相同条数，拆分为短句/g,
          `每次回复必须发送${minCount}-${maxCount}条消息，根据情绪和话题在此范围内灵活选择，拆分为短句`
        );
        
        // 如果没有匹配到，则在开头注入
        if (processedPrompt === originalPrompt) {
          processedPrompt = multiReplyInstruction + processedPrompt;
        }
      }
    }
    
    return processedPrompt;
  }
  
  window.getActiveChatPrompt = getActiveChatPrompt;

// ========== 提示词处理函数结束 ==========

// ========== API 预设管理 ==========

  const apiPresetCardDraft = {
    presetId: null,
    name: '',
    proxyUrl: '',
    apiKey: '',
    defaultModel: '',
    modelListCache: [],
    modelListFetchedAt: ''
  };
  window.apiPresetCardDraft = apiPresetCardDraft;

  function updateApiPresetCardDraftFromDom(extra = {}) {
    const nameEl = document.getElementById('api-preset-name');
    const urlEl = document.getElementById('api-preset-url');
    const keyEl = document.getElementById('api-preset-key');
    const modelEl = document.getElementById('api-preset-model');

    Object.assign(apiPresetCardDraft, {
      presetId: getEditingApiPresetId(),
      name: (nameEl && nameEl.value.trim()) || '',
      proxyUrl: (urlEl && urlEl.value.trim()) || '',
      apiKey: (keyEl && keyEl.value.trim()) || '',
      defaultModel: (modelEl && modelEl.value.trim()) || ''
    }, extra);

    return apiPresetCardDraft;
  }

  window.loadApiPresetsDropdown = loadApiPresetsDropdown;

  async function loadApiPresetsDropdown(forceSelectedId = null) {
    const selectEl = document.getElementById('api-preset-select');
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="current">当前配置 (未保存)</option>';

    const presets = await db.apiPresets.toArray();
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });

    if (forceSelectedId) {
      selectEl.value = forceSelectedId;
      updateApiPresetDetails(forceSelectedId);
      return;
    }
    
    // 检查当前主 API 站点配置是否匹配某个预设。
    // API 预设库只保存站点自身信息，不再用副 API / 后台 / 识图 / 情侣空间等功能位状态参与匹配。
    const currentConfig = state.apiConfig;
    let matchingPresetId = null;
    for (const preset of presets) {
      if (
        preset.proxyUrl === currentConfig.proxyUrl &&
        preset.apiKey === currentConfig.apiKey &&
        (preset.model || preset.defaultModel || '') === (currentConfig.model || '')
      ) {
        matchingPresetId = preset.id;
        break;
      }
    }

    if (matchingPresetId) {
      selectEl.value = matchingPresetId;
      updateApiPresetDetails(matchingPresetId);
    } else {
      selectEl.value = 'current';
      updateApiPresetDetails(null); // 显示当前配置
    }
  }

  function setApiPresetModelFetchStatus(message, isError = false) {
    const statusEl = document.getElementById('api-preset-model-fetch-status');
    if (!statusEl) return;
    statusEl.style.display = message ? 'block' : 'none';
    statusEl.style.color = isError ? '#d32f2f' : '#34c759';
    statusEl.textContent = message || '';
  }

  function fillApiPresetModelSelect(models, selectedModel = '', fetchedAt = '') {
    const selectEl = document.getElementById('api-preset-model-select');
    if (!selectEl) return;
    selectEl.innerHTML = '';
    selectEl.dataset.modelListFetchedAt = fetchedAt || '';

    const uniqueModels = [...new Set((models || []).map(model => {
      if (typeof model === 'string') return model;
      return model && model.id;
    }).filter(Boolean))];

    if (uniqueModels.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '暂无模型缓存';
      selectEl.appendChild(option);
      return;
    }

    uniqueModels.forEach(modelId => {
      const option = document.createElement('option');
      option.value = modelId;
      option.textContent = modelId;
      if (modelId === selectedModel) option.selected = true;
      selectEl.appendChild(option);
    });

    if (selectedModel && uniqueModels.includes(selectedModel)) {
      selectEl.value = selectedModel;
    }
  }

  function normalizeApiPresetModels(data, isGemini) {
    const rawModels = isGemini ? (data && data.models) : (data && data.data);
    if (!Array.isArray(rawModels)) return [];

    return rawModels.map(model => {
      if (typeof model === 'string') return model;
      if (isGemini && model && model.name) return model.name.split('/')[1] || model.name;
      return model && model.id;
    }).filter(Boolean);
  }

  function getEditingApiPresetId() {
    const selectEl = document.getElementById('api-preset-select');
    if (!selectEl) return null;
    const selectedId = parseInt(selectEl.value, 10);
    return Number.isNaN(selectedId) ? null : selectedId;
  }

  async function fetchModelsForApiPresetCard() {
    const urlEl = document.getElementById('api-preset-url');
    const keyEl = document.getElementById('api-preset-key');
    const modelEl = document.getElementById('api-preset-model');
    const fetchBtn = document.getElementById('fetch-api-preset-models-btn');

    const draft = updateApiPresetCardDraftFromDom();
    const proxyUrl = draft.proxyUrl;
    const apiKey = draft.apiKey;
    if (!proxyUrl || !apiKey) {
      setApiPresetModelFetchStatus('请先在该预设卡片内填写 API 地址和 API 密钥。', true);
      return;
    }

    if (fetchBtn) {
      fetchBtn.disabled = true;
      fetchBtn.textContent = '拉取中...';
    }
    setApiPresetModelFetchStatus('正在使用当前预设卡片的 API 地址和 API 密钥拉取模型...', false);

    try {
      const isGemini = typeof GEMINI_API_URL !== 'undefined' && proxyUrl === GEMINI_API_URL;
      const useMainProxyForModels = !isGemini
        && state?.globalSettings?.mainApiUseProxy === true
        && typeof window.fetchViaOpenAICompatibleProxy === 'function';
      // [2026-09-14 AQ. 凭证兼容] 删除 ?key= URL 参数; 改用 x-goog-api-key header
      const requestUrl = isGemini
        ? `${GEMINI_API_URL}`
        : `${proxyUrl.replace(/\/+$/, '')}/models`;
      const response = useMainProxyForModels
        ? await window.fetchViaOpenAICompatibleProxy({
          baseUrl: proxyUrl,
          targetPath: '/models',
          apiKey,
          method: 'GET',
          diagStartEvent: 'API_PROXY_MODELS_REQUEST_START',
          diagResponseEvent: 'API_PROXY_MODELS_RESPONSE',
          diagErrorEvent: 'API_PROXY_MODELS_ERROR'
        })
        : await fetch(requestUrl, isGemini ? {
          method: 'GET',
          mode: 'cors',
          cache: 'no-cache',
          credentials: 'omit',
          headers: { 'x-goog-api-key': getRandomValue(apiKey) }
        } : {
          method: 'GET',
          mode: 'cors',
          cache: 'no-cache',
          credentials: 'omit',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`无法获取模型列表 (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const models = normalizeApiPresetModels(data, isGemini);
      if (models.length === 0) {
        throw new Error('返回的模型列表为空');
      }

      const currentModel = (modelEl && modelEl.value.trim()) || draft.defaultModel || '';
      const defaultModel = models.includes(currentModel) ? currentModel : models[0];
      const fetchedAt = new Date().toISOString();
      if (modelEl) modelEl.value = defaultModel;
      fillApiPresetModelSelect(models, defaultModel, fetchedAt);
      updateApiPresetCardDraftFromDom({
        defaultModel,
        modelListCache: models,
        modelListFetchedAt: fetchedAt
      });

      setApiPresetModelFetchStatus(`模型列表已暂存到当前预设草稿，共 ${models.length} 个。默认模型：${defaultModel}`, false);
    } catch (error) {
      console.error('API 预设拉取模型失败:', error);
      setApiPresetModelFetchStatus(`拉取模型失败：${error.message}`, true);
    } finally {
      if (fetchBtn) {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '拉取模型';
      }
    }
  }

  // 更新API预设详情显示
  async function updateApiPresetDetails(presetId) {
    const detailsEl = document.getElementById('api-preset-details');
    const nameEl = document.getElementById('api-preset-name');
    const urlEl = document.getElementById('api-preset-url');
    const keyEl = document.getElementById('api-preset-key');
    const modelEl = document.getElementById('api-preset-model');

    if (!presetId) {
      // 显示当前配置 / 未保存草稿
      detailsEl.style.display = 'block';
      nameEl.value = apiPresetCardDraft.name || '';
      urlEl.value = apiPresetCardDraft.proxyUrl || state.apiConfig.proxyUrl || '';
      keyEl.value = apiPresetCardDraft.apiKey || state.apiConfig.apiKey || '';
      modelEl.value = apiPresetCardDraft.defaultModel || state.apiConfig.model || '';
      fillApiPresetModelSelect(apiPresetCardDraft.modelListCache || [], apiPresetCardDraft.defaultModel || '', apiPresetCardDraft.modelListFetchedAt || '');
      setApiPresetModelFetchStatus('', false);
      updateApiPresetCardDraftFromDom();
      return;
    }

    const preset = await db.apiPresets.get(presetId);
    if (preset) {
      detailsEl.style.display = 'block';
      nameEl.value = preset.name || '';
      urlEl.value = preset.proxyUrl || '';
      keyEl.value = preset.apiKey || '';
      modelEl.value = preset.model || preset.defaultModel || '';
      fillApiPresetModelSelect(preset.modelListCache || preset.models || preset.modelList || [], preset.model || preset.defaultModel || '', preset.modelListFetchedAt || '');
      setApiPresetModelFetchStatus('', false);
      updateApiPresetCardDraftFromDom({
        modelListCache: preset.modelListCache || preset.models || preset.modelList || [],
        modelListFetchedAt: preset.modelListFetchedAt || ''
      });
    } else {
      detailsEl.style.display = 'none';
      fillApiPresetModelSelect([], '');
      setApiPresetModelFetchStatus('', false);
    }
  }


  async function handlePresetSelectionChange() {
    const selectEl = document.getElementById('api-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      // 选择了"当前配置"
      updateApiPresetDetails(null);
      return;
    }

    const preset = await db.apiPresets.get(selectedId);
    if (preset) {
      // API 预设库只作为“站点库”。选择预设时只把该预设自身字段加载到预设管理卡片，
      // 不写入 state.apiConfig，不保存 apiConfig，不刷新/覆盖主 API、副 API、后台活动 API、识图 API、情侣空间 API 设置区。
      updateApiPresetDetails(selectedId);
    }
  }


  async function saveApiPreset() {
    // 从详情字段读取基本信息
    const nameEl = document.getElementById('api-preset-name');
    const urlEl = document.getElementById('api-preset-url');
    const keyEl = document.getElementById('api-preset-key');
    const modelEl = document.getElementById('api-preset-model');

    let name = nameEl.value.trim();
    if (!name) {
      name = await showCustomPrompt('保存 API 预设', '请输入预设名称');
      if (!name || !name.trim()) return;
      name = name.trim();
    }

    const editingPresetId = getEditingApiPresetId();
    const editingPreset = editingPresetId ? await db.apiPresets.get(editingPresetId) : null;
    const existingPreset = await db.apiPresets.where('name').equals(name).first();
    const model = modelEl.value.trim();
    const modelSelectEl = document.getElementById('api-preset-model-select');
    const modelListCache = [...(modelSelectEl ? modelSelectEl.options : [])]
      .map(option => option.value)
      .filter(Boolean);
    const draft = updateApiPresetCardDraftFromDom();
    const fetchedAt = (modelSelectEl && modelSelectEl.dataset.modelListFetchedAt) || draft.modelListFetchedAt;
    const cachedPreset = editingPreset || existingPreset;

    const presetData = {
      name: name,
      proxyUrl: urlEl.value.trim(),
      apiKey: keyEl.value.trim(),
      model: model,
      defaultModel: model,
      modelListCache: modelListCache.length > 0 ? modelListCache : (draft.modelListCache && draft.modelListCache.length > 0 ? draft.modelListCache : ((cachedPreset && cachedPreset.modelListCache) || [])),
      modelListFetchedAt: fetchedAt || (cachedPreset && cachedPreset.modelListFetchedAt)
    };


    if (editingPresetId) {
      presetData.id = editingPresetId;
    } else if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;
      presetData.id = existingPreset.id;
    }

    const savedId = await db.apiPresets.put(presetData);
    await loadApiPresetsDropdown(savedId || presetData.id);
    if (typeof refreshAllEndpointPresetUi === 'function') {
      await refreshAllEndpointPresetUi();
    }
    // 预设内容改了 → 刷新 state.apiConfig 里的地址/密钥快照,
    // 否则正在用的那个预设改了地址, 其它读 state.apiConfig 的地方(几十处)还在用旧的。
    if (typeof syncApiSlotConfigIntoState === 'function') {
      await syncApiSlotConfigIntoState();
    }
    alert('API 预设已保存！');
  }


  async function deleteApiPreset() {
    const selectEl = document.getElementById('api-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const preset = await db.apiPresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.apiPresets.delete(selectedId);
      await loadApiPresetsDropdown();
      if (typeof refreshAllEndpointPresetUi === 'function') {
        await refreshAllEndpointPresetUi();
      }
      // 删掉的预设可能正被某个槽位引用 → 刷新快照, 让 state.apiConfig 反映真实情况
      if (typeof syncApiSlotConfigIntoState === 'function') {
        await syncApiSlotConfigIntoState();
      }
      alert('预设已删除。');
    }
  }

  function renderApiSettings(forcePresetId = null) {

    document.getElementById('proxy-url').value = state.apiConfig.proxyUrl || '';
    document.getElementById('api-key').value = state.apiConfig.apiKey || '';
    const mainApiUseProxySwitch = document.getElementById('main-api-use-proxy-switch');
    if (mainApiUseProxySwitch) {
      mainApiUseProxySwitch.checked = state.globalSettings.mainApiUseProxy === true;
    }
    document.getElementById('secondary-proxy-url').value = state.apiConfig.secondaryProxyUrl || '';
    document.getElementById('secondary-api-key').value = state.apiConfig.secondaryApiKey || '';
    document.getElementById('background-proxy-url').value = state.apiConfig.backgroundProxyUrl || '';
    document.getElementById('background-api-key').value = state.apiConfig.backgroundApiKey || '';
    const asrBaseUrlInput = document.getElementById('asr-base-url');
    if (asrBaseUrlInput) asrBaseUrlInput.value = state.apiConfig.asrBaseUrl || '';
    const asrApiKeyInput = document.getElementById('asr-api-key');
    if (asrApiKeyInput) asrApiKeyInput.value = state.apiConfig.asrApiKey || '';
    const asrModelInput = document.getElementById('asr-model');
    if (asrModelInput) asrModelInput.value = state.apiConfig.asrModel || '';
    const asrLanguageInput = document.getElementById('asr-language');
    if (asrLanguageInput) asrLanguageInput.value = state.apiConfig.asrLanguage || '';
    // 识图API回填
    document.getElementById('vision-proxy-url').value = state.apiConfig.visionProxyUrl || '';
    document.getElementById('vision-api-key').value = state.apiConfig.visionApiKey || '';
    document.getElementById('vision-model-input').value = state.apiConfig.visionModel || '';
    const visionPromptArea = document.getElementById('vision-prompt-textarea');
    if (visionPromptArea) {
      const defVp =
        typeof getDefaultVisionPrompt === 'function'
          ? getDefaultVisionPrompt()
          : '请详细描述这张图片的内容，包括画面元素、文字信息、布局结构和关键细节。';
      visionPromptArea.value =
        state.apiConfig.visionPrompt != null && String(state.apiConfig.visionPrompt).trim()
          ? state.apiConfig.visionPrompt
          : defVp;
    }
    // 情侣空间API回填
    document.getElementById('couplespace-proxy-url').value = state.apiConfig.couplespaceProxyUrl || '';
    document.getElementById('couplespace-api-key').value = state.apiConfig.couplespaceApiKey || '';
    document.getElementById('couplespace-model-input').value = state.apiConfig.couplespaceModel || '';
    document.getElementById('background-activity-switch').checked = state.globalSettings.enableBackgroundActivity || false;
    document.getElementById('background-interval-input').value = state.globalSettings.backgroundActivityInterval || 60;
    document.getElementById('block-cooldown-input').value = state.globalSettings.blockCooldownHours || 1;

    // 新增：加载后台查看用户手机设置
    document.getElementById('global-enable-view-myphone-bg-switch').checked = state.globalSettings.enableViewMyPhoneInBackground || false;
    document.getElementById('global-view-myphone-chance-input').value = state.globalSettings.viewMyPhoneChance !== null && state.globalSettings.viewMyPhoneChance !== undefined ? state.globalSettings.viewMyPhoneChance : '';
    document.getElementById('enable-ai-drawing-switch').checked = state.globalSettings.enableAiDrawing;

    // Pollinations 设置面板展开 + 读取已保存的 Key 和模型
    const pollinationsDetails = document.getElementById('pollinations-details');
    if (pollinationsDetails) pollinationsDetails.style.display = state.globalSettings.enableAiDrawing ? '' : 'none';
    const savedPollinationsKey = localStorage.getItem('pollinations-api-key') || '';
    const savedPollinationsModel = localStorage.getItem('pollinations-model') || 'flux';
    document.getElementById('pollinations-api-key').value = savedPollinationsKey;
    document.getElementById('pollinations-model').value = savedPollinationsModel;

    // 新增：读取心声和动态功能开关
    document.getElementById('global-enable-thoughts-switch').checked = state.globalSettings.enableThoughts || false;
    document.getElementById('global-enable-qzone-actions-switch').checked = state.globalSettings.enableQzoneActions || false;

    // 新增：读取自定义心声提示词设置
    const customThoughtsSwitch = document.getElementById('custom-thoughts-prompt-switch');
    const customThoughtsContainer = document.getElementById('custom-thoughts-prompt-container');
    const customThoughtsTextarea = document.getElementById('custom-thoughts-prompt-textarea');
    customThoughtsSwitch.checked = state.globalSettings.customThoughtsPromptEnabled || false;
    customThoughtsContainer.style.display = customThoughtsSwitch.checked ? 'block' : 'none';
    customThoughtsTextarea.value = state.globalSettings.customThoughtsPrompt || getDefaultThoughtsPrompt();
    customThoughtsSwitch.addEventListener('change', function() {
      customThoughtsContainer.style.display = this.checked ? 'block' : 'none';
      if (this.checked && !customThoughtsTextarea.value.trim()) {
        customThoughtsTextarea.value = getDefaultThoughtsPrompt();
      }
    });
    document.getElementById('reset-thoughts-prompt-btn').addEventListener('click', function() {
      customThoughtsTextarea.value = getDefaultThoughtsPrompt();
    });

    // 心声提示词 - 导出
    document.getElementById('export-thoughts-prompt-btn').addEventListener('click', function() {
      const content = customThoughtsTextarea.value || '';
      const data = JSON.stringify({ type: 'thoughts_prompt', content: content }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '心声提示词.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    // 心声提示词 - 导入
    document.getElementById('import-thoughts-prompt-btn').addEventListener('click', function() {
      document.getElementById('import-thoughts-prompt-file').click();
    });
    document.getElementById('import-thoughts-prompt-file').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.content) {
            customThoughtsTextarea.value = data.content;
            showToast('心声提示词导入成功');
          } else {
            showToast('文件格式不正确');
          }
        } catch (err) {
          // 如果不是JSON，当作纯文本导入
          customThoughtsTextarea.value = ev.target.result;
          showToast('心声提示词导入成功');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // 新增：读取自定义心声外观设置
    const customThoughtsUISwitch = document.getElementById('custom-thoughts-ui-switch');
    const customThoughtsUIContainer = document.getElementById('custom-thoughts-ui-container');
    const customThoughtsHTMLTextarea = document.getElementById('custom-thoughts-html-textarea');
    const customThoughtsCSSTextarea = document.getElementById('custom-thoughts-css-textarea');
    
    customThoughtsUISwitch.checked = state.globalSettings.customThoughtsUIEnabled || false;
    customThoughtsUIContainer.style.display = customThoughtsUISwitch.checked ? 'block' : 'none';
    
    customThoughtsHTMLTextarea.value = state.globalSettings.customThoughtsHTML || getDefaultThoughtsHTML();
    customThoughtsCSSTextarea.value = state.globalSettings.customThoughtsCSS || getDefaultThoughtsCSS();
    
    customThoughtsUISwitch.addEventListener('change', function() {
      customThoughtsUIContainer.style.display = this.checked ? 'block' : 'none';
      if (this.checked) {
        if (!customThoughtsHTMLTextarea.value.trim()) {
          customThoughtsHTMLTextarea.value = getDefaultThoughtsHTML();
        }
        if (!customThoughtsCSSTextarea.value.trim()) {
          customThoughtsCSSTextarea.value = getDefaultThoughtsCSS();
        }
      }
    });

    document.getElementById('reset-thoughts-ui-btn').addEventListener('click', function() {
      customThoughtsHTMLTextarea.value = getDefaultThoughtsHTML();
      customThoughtsCSSTextarea.value = getDefaultThoughtsCSS();
      showToast('已恢复默认外观代码');
    });

    // 心声外观 - 导出
    document.getElementById('export-thoughts-ui-btn').addEventListener('click', function() {
      const htmlContent = customThoughtsHTMLTextarea.value || '';
      const cssContent = customThoughtsCSSTextarea.value || '';
      const data = JSON.stringify({ type: 'thoughts_ui', html: htmlContent, css: cssContent }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '心声自定义外观.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    // 心声外观 - 导入
    document.getElementById('import-thoughts-ui-btn').addEventListener('click', function() {
      document.getElementById('import-thoughts-ui-file').click();
    });
    
    document.getElementById('import-thoughts-ui-file').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.type === 'thoughts_ui') {
            customThoughtsHTMLTextarea.value = data.html || '';
            customThoughtsCSSTextarea.value = data.css || '';
            showToast('心声自定义外观导入成功');
          } else {
            showToast('文件格式不正确');
          }
        } catch (err) {
          showToast('导入失败：文件格式错误');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // 新增：读取自定义结构化总结提示词设置
    const customSummarySwitch = document.getElementById('custom-summary-prompt-switch');
    const customSummaryContainer = document.getElementById('custom-summary-prompt-container');
    const customSummaryTextarea = document.getElementById('custom-summary-prompt-textarea');
    customSummarySwitch.checked = state.globalSettings.customSummaryPromptEnabled || false;
    customSummaryContainer.style.display = customSummarySwitch.checked ? 'block' : 'none';
    customSummaryTextarea.value = state.globalSettings.customSummaryPrompt || getDefaultSummaryPrompt();
    customSummarySwitch.addEventListener('change', function() {
      customSummaryContainer.style.display = this.checked ? 'block' : 'none';
      if (this.checked && !customSummaryTextarea.value.trim()) {
        customSummaryTextarea.value = getDefaultSummaryPrompt();
      }
    });
    document.getElementById('reset-summary-prompt-btn').addEventListener('click', function() {
      customSummaryTextarea.value = getDefaultSummaryPrompt();
    });

    // 结构化总结提示词 - 导出
    document.getElementById('export-summary-prompt-btn').addEventListener('click', function() {
      const content = customSummaryTextarea.value || '';
      const data = JSON.stringify({ type: 'summary_prompt', content: content }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '结构化总结提示词.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    // 结构化总结提示词 - 导入
    document.getElementById('import-summary-prompt-btn').addEventListener('click', function() {
      document.getElementById('import-summary-prompt-file').click();
    });
    document.getElementById('import-summary-prompt-file').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.content) {
            customSummaryTextarea.value = data.content;
            showToast('结构化总结提示词导入成功');
          } else {
            showToast('文件格式不正确');
          }
        } catch (err) {
          customSummaryTextarea.value = ev.target.result;
          showToast('结构化总结提示词导入成功');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // 新增：读取自定义聊天提示词设置
    const customChatPromptSwitch = document.getElementById('custom-chat-prompt-switch');
    const customChatPromptContainer = document.getElementById('custom-chat-prompt-container');
    const customChatPromptSingleTextarea = document.getElementById('custom-chat-prompt-single-textarea');
    const customChatPromptGroupTextarea = document.getElementById('custom-chat-prompt-group-textarea');
    const customChatPromptOfflineTextarea = document.getElementById('custom-chat-prompt-offline-textarea');
    
    customChatPromptSwitch.checked = state.globalSettings.customChatPromptEnabled || false;
    customChatPromptContainer.style.display = customChatPromptSwitch.checked ? 'block' : 'none';
    
    // 初始化时填充默认提示词（如果用户没有自定义）
    customChatPromptSingleTextarea.value = state.globalSettings.customChatPromptSingle || getDefaultChatPrompt('single');
    customChatPromptGroupTextarea.value = state.globalSettings.customChatPromptGroup || getDefaultChatPrompt('group');
    customChatPromptOfflineTextarea.value = state.globalSettings.customChatPromptOffline || getDefaultChatPrompt('offline');
    
    customChatPromptSwitch.addEventListener('change', function() {
      customChatPromptContainer.style.display = this.checked ? 'block' : 'none';
      // 开启时，如果文本框为空，填充默认提示词
      if (this.checked) {
        if (!customChatPromptSingleTextarea.value.trim()) {
          customChatPromptSingleTextarea.value = getDefaultChatPrompt('single');
        }
        if (!customChatPromptGroupTextarea.value.trim()) {
          customChatPromptGroupTextarea.value = getDefaultChatPrompt('group');
        }
        if (!customChatPromptOfflineTextarea.value.trim()) {
          customChatPromptOfflineTextarea.value = getDefaultChatPrompt('offline');
        }
      }
    });
    
    // 单聊提示词 - 恢复默认
    document.getElementById('reset-chat-prompt-single-btn').addEventListener('click', function() {
      customChatPromptSingleTextarea.value = getDefaultChatPrompt('single');
      showToast('已恢复单聊默认提示词');
    });
    
    // 群聊提示词 - 恢复默认
    document.getElementById('reset-chat-prompt-group-btn').addEventListener('click', function() {
      customChatPromptGroupTextarea.value = getDefaultChatPrompt('group');
      showToast('已恢复群聊默认提示词');
    });
    
    // 线下模式提示词 - 恢复默认
    document.getElementById('reset-chat-prompt-offline-btn').addEventListener('click', function() {
      customChatPromptOfflineTextarea.value = getDefaultChatPrompt('offline');
      showToast('已恢复线下模式默认提示词');
      showToast('已清空线下模式提示词，将使用默认提示词');
    });
    
    // 聊天提示词 - 导出（导出所有三种）
    document.getElementById('export-chat-prompt-btn').addEventListener('click', function() {
      const data = {
        type: 'chat_prompts',
        single: customChatPromptSingleTextarea.value || '',
        group: customChatPromptGroupTextarea.value || '',
        offline: customChatPromptOfflineTextarea.value || ''
      };
      const dataStr = JSON.stringify(data, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '聊天提示词.json';
      a.click();
      URL.revokeObjectURL(url);
    });
    
    // 聊天提示词 - 导入
    document.getElementById('import-chat-prompt-btn').addEventListener('click', function() {
      document.getElementById('import-chat-prompt-file').click();
    });
    document.getElementById('import-chat-prompt-file').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.type === 'chat_prompts') {
            if (data.single !== undefined) customChatPromptSingleTextarea.value = data.single;
            if (data.group !== undefined) customChatPromptGroupTextarea.value = data.group;
            if (data.offline !== undefined) customChatPromptOfflineTextarea.value = data.offline;
            showToast('聊天提示词导入成功');
          } else {
            showToast('文件格式不正确');
          }
        } catch (err) {
          showToast('导入失败：文件格式错误');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // 新增：聊天提示词标签页切换
    const chatPromptTabs = document.querySelectorAll('.custom-chat-prompt-tab');
    const chatPromptContents = document.querySelectorAll('.custom-chat-prompt-tab-content');
    
    chatPromptTabs.forEach(tab => {
      tab.addEventListener('click', function() {
        const targetTab = this.getAttribute('data-tab');
        
        // 更新标签样式
        chatPromptTabs.forEach(t => {
          t.classList.remove('active');
          t.style.borderBottomColor = 'transparent';
          t.style.color = 'var(--text-secondary, #8e8e93)';
        });
        this.classList.add('active');
        this.style.borderBottomColor = 'var(--primary-color, #007aff)';
        this.style.color = 'var(--primary-color, #007aff)';
        
        // 切换内容
        chatPromptContents.forEach(content => {
          const contentTab = content.getAttribute('data-content');
          content.style.display = contentTab === targetTab ? 'block' : 'none';
        });
      });
    });

    document.getElementById('global-enable-view-myphone-switch').checked = state.globalSettings.enableViewMyPhone || false;
    document.getElementById('global-enable-cross-chat-switch').checked = state.globalSettings.enableCrossChat !== false; // 默认开启

    document.getElementById('chat-render-window-input').value = state.globalSettings.chatRenderWindow || 50;
    document.getElementById('chat-list-render-window-input').value = state.globalSettings.chatListRenderWindow || 30;
    const tempSlider = document.getElementById('api-temperature-slider');
    const tempInput = document.getElementById('api-temperature-input');
    const savedTemp = state.globalSettings.apiTemperature || 0.8;
    tempSlider.value = savedTemp;
    tempInput.value = savedTemp;
    
    const topPSlider = document.getElementById('api-top-p-slider');
    const topPInput = document.getElementById('api-top-p-input');
    const savedTopP = state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0;
    topPSlider.value = savedTopP;
    topPInput.value = savedTopP;
    
    const presenceSlider = document.getElementById('api-presence-penalty-slider');
    const presenceInput = document.getElementById('api-presence-penalty-input');
    const savedPresence = state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0;
    presenceSlider.value = savedPresence;
    presenceInput.value = savedPresence;
    
    const frequencySlider = document.getElementById('api-frequency-penalty-slider');
    const frequencyInput = document.getElementById('api-frequency-penalty-input');
    const savedFrequency = state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0;
    frequencySlider.value = savedFrequency;
    frequencyInput.value = savedFrequency;
    
    // 方案4：加载API历史记录开关状态（默认关闭以减小导出文件体积）
    const apiHistorySwitch = document.getElementById('enable-api-history-switch');
    if (apiHistorySwitch) {
      apiHistorySwitch.checked = state.globalSettings.enableApiHistory || false;
    }
    
    // 加载安全渲染模式开关状态
    const safeRenderSwitch = document.getElementById('safe-render-mode-switch');
    if (safeRenderSwitch) {
      safeRenderSwitch.checked = state.globalSettings.safeRenderMode || false;
    }
    
    // 加载悬浮球开关状态
    const floatingBallSwitch = document.getElementById('floating-ball-switch');
    if (floatingBallSwitch) {
      floatingBallSwitch.checked = state.globalSettings.floatingBallEnabled === true; // 默认关闭
    }
    
    if (window.TTSService) {
      window.TTSService.normalizeTtsConfig(state.apiConfig);
    }
    if (typeof window.renderTtsProviderSettings === 'function') {
      window.renderTtsProviderSettings();
    }

    // 音乐生成设置加载
    const musicGenSwitch = document.getElementById('enable-music-generation-switch');
    const musicGenDetails = document.getElementById('music-generation-details');
    const musicApiKeyInput = document.getElementById('music-api-key');
    const musicModelSelect = document.getElementById('music-model-select');
    if (musicGenSwitch) {
      musicGenSwitch.checked = state.globalSettings.enableMusicGeneration === true;
      if (musicGenDetails) {
        musicGenDetails.style.display = musicGenSwitch.checked ? 'block' : 'none';
        musicGenSwitch.addEventListener('change', function() {
          musicGenDetails.style.display = this.checked ? 'block' : 'none';
        });
      }
    }
    if (musicApiKeyInput) {
      musicApiKeyInput.value = state.globalSettings.musicApiKey || '';
    }
    if (musicModelSelect) {
      // 【2026-07-21 改】默认用 cover 模式（角色专属音色）—— 用户原话："我们需要的是角色唱歌不是别人唱歌"
      musicModelSelect.value = state.globalSettings.musicModel || 'music-cover';
    }
    // 【2026-07-23 新增】"角色有音色样本时自动用 Cover" 开关——默认 true 保持角色专属音色
    // 用户可关掉后用普通模型（更便宜，但失去角色专属音色）
    const autoCoverSwitch = document.getElementById('auto-cover-when-has-sample-switch');
    if (autoCoverSwitch) {
      // 未设置时默认 true（保持向后兼容）
      autoCoverSwitch.checked = state.globalSettings.autoCoverWhenHasSample !== false;
    }
    const musicApiKeyToggle = document.getElementById('music-api-key-toggle');
    if (musicApiKeyToggle && musicApiKeyInput) {
      musicApiKeyToggle.addEventListener('click', function() {
        musicApiKeyInput.type = musicApiKeyInput.type === 'password' ? 'text' : 'password';
      });
    }


    const novelaiEnabled = localStorage.getItem('novelai-enabled') === 'true';
    const novelaiModel = localStorage.getItem('novelai-model') || 'nai-diffusion-4-5-full';
    const novelaiApiKey = localStorage.getItem('novelai-api-key') || '';
    document.getElementById('novelai-switch').checked = novelaiEnabled;
    document.getElementById('novelai-model').value = novelaiModel;
    document.getElementById('novelai-api-key').value = novelaiApiKey;
    document.getElementById('novelai-details').style.display = novelaiEnabled ? 'block' : 'none';

    // Google Imagen 设置加载
    const googleImagenEnabled = localStorage.getItem('google-imagen-enabled') === 'true';
    const googleImagenModel = localStorage.getItem('google-imagen-model') || 'imagen-4.0-generate-001';
    const googleImagenApiKey = localStorage.getItem('google-imagen-api-key') || '';
    const googleImagenSettings = getGoogleImagenSettings();
    document.getElementById('google-imagen-switch').checked = googleImagenEnabled;
    document.getElementById('google-imagen-model').value = googleImagenModel;
    document.getElementById('google-imagen-api-key').value = googleImagenApiKey;
    document.getElementById('google-imagen-endpoint').value = googleImagenSettings.endpoint || 'https://generativelanguage.googleapis.com';
    document.getElementById('google-imagen-aspect-ratio').value = googleImagenSettings.aspectRatio || '1:1';
    document.getElementById('google-imagen-details').style.display = googleImagenEnabled ? 'block' : 'none';

    const imgbbEnableSwitch = document.getElementById('imgbb-enable-switch');
    const imgbbApiKeyInput = document.getElementById('imgbb-api-key');
    const imgbbDetailsDiv = document.getElementById('imgbb-settings-details');


    const savedImgbbEnabled = localStorage.getItem('imgbb-enabled');
    const savedImgbbKey = localStorage.getItem('imgbb-api-key');


    if (savedImgbbEnabled !== null) state.apiConfig.imgbbEnable = (savedImgbbEnabled === 'true');
    if (savedImgbbKey !== null) state.apiConfig.imgbbApiKey = savedImgbbKey;

    if (imgbbEnableSwitch) {
      imgbbEnableSwitch.checked = state.apiConfig.imgbbEnable || false;
      imgbbApiKeyInput.value = state.apiConfig.imgbbApiKey || '';
      imgbbDetailsDiv.style.display = imgbbEnableSwitch.checked ? 'block' : 'none';
    }


    const catboxEnableSwitch = document.getElementById('catbox-enable-switch');
    const catboxUserHashInput = document.getElementById('catbox-userhash');
    const catboxDetailsDiv = document.getElementById('catbox-settings-details');


    const savedCatboxEnabled = localStorage.getItem('catbox-enabled');
    const savedCatboxHash = localStorage.getItem('catbox-userhash');


    if (savedCatboxEnabled !== null) state.apiConfig.catboxEnable = (savedCatboxEnabled === 'true');
    if (savedCatboxHash !== null) state.apiConfig.catboxUserHash = savedCatboxHash;

    if (catboxEnableSwitch) {
      catboxEnableSwitch.checked = state.apiConfig.catboxEnable || false;
      catboxUserHashInput.value = state.apiConfig.catboxUserHash || '';
      catboxDetailsDiv.style.display = catboxEnableSwitch.checked ? 'block' : 'none';
    }

    const visionPromptTa = document.getElementById('vision-prompt-textarea');
    if (visionPromptTa) {
      const defPrompt =
        typeof getDefaultVisionPrompt === 'function'
          ? getDefaultVisionPrompt()
          : '请详细描述这张图片的内容，包括画面元素、文字信息、布局结构和关键细节。';
      visionPromptTa.value =
        state.apiConfig.visionPrompt != null && String(state.apiConfig.visionPrompt).trim()
          ? state.apiConfig.visionPrompt
          : defPrompt;
    }

    const ghSwitch = document.getElementById('github-enable-switch');
    const ghDetails = document.getElementById('github-settings-details');

    // 从 localStorage 读取，如果没有则读取 apiConfig (保持一致性)
    const savedGhEnabled = localStorage.getItem('github-enabled');
    if (savedGhEnabled !== null) state.apiConfig.githubEnable = (savedGhEnabled === 'true');

    if (ghSwitch) {
      ghSwitch.checked = state.apiConfig.githubEnable || false;

      // 核心逻辑：根据开关状态决定是否显示详情框
      ghDetails.style.display = ghSwitch.checked ? 'block' : 'none';
      const ghAutoSwitch = document.getElementById('github-auto-backup-switch');
      const ghIntervalInput = document.getElementById('github-backup-interval'); // 【新增】

      if (ghAutoSwitch) {
        const savedAuto = localStorage.getItem('github-auto-backup');
        ghAutoSwitch.checked = savedAuto !== null ? (savedAuto === 'true') : false;

        // 【新增】回显分钟数，默认 30
        const savedInterval = localStorage.getItem('github-backup-interval');
        if (ghIntervalInput) {
          ghIntervalInput.value = savedInterval ? parseInt(savedInterval) : 30;
        }
      }
      // 回显输入框的值
      document.getElementById('github-username').value = state.apiConfig.githubUsername || '';
      document.getElementById('github-repo').value = state.apiConfig.githubRepo || '';
      document.getElementById('github-token').value = state.apiConfig.githubToken || '';
      document.getElementById('github-filename').value = state.apiConfig.githubFilename || 'ephone_backup.json';
      const ghProxySwitch = document.getElementById('github-proxy-switch');
      const ghProxyInputDiv = document.getElementById('github-proxy-input-group');
      const ghProxyUrlInput = document.getElementById('github-proxy-url');

      // 读取保存的设置
      const savedGhProxyEnabled = localStorage.getItem('github-proxy-enabled');
      const savedGhProxyUrl = localStorage.getItem('github-proxy-url');

      // 设置状态
      state.apiConfig.githubProxyEnable = savedGhProxyEnabled === 'true';
      state.apiConfig.githubProxyUrl = savedGhProxyUrl || '';

      if (ghProxySwitch) {
        ghProxySwitch.checked = state.apiConfig.githubProxyEnable;
        ghProxyInputDiv.style.display = ghProxySwitch.checked ? 'block' : 'none';
        ghProxyUrlInput.value = state.apiConfig.githubProxyUrl || '';

        // 绑定切换事件，控制输入框显示
        ghProxySwitch.addEventListener('change', (e) => {
          ghProxyInputDiv.style.display = e.target.checked ? 'block' : 'none';
        });
      }
    }

    // 填充手写输入框（模型）
    const modelInput = document.getElementById('model-input');
    const secondaryModelInput = document.getElementById('secondary-model-input');
    const backgroundModelInput = document.getElementById('background-model-input');
    const visionModelInput = document.getElementById('vision-model-input');
    if (modelInput) {
      modelInput.value = state.apiConfig.model || '';
    }
    if (secondaryModelInput) {
      secondaryModelInput.value = state.apiConfig.secondaryModel || '';
    }
    if (backgroundModelInput) {
      backgroundModelInput.value = state.apiConfig.backgroundModel || '';
    }
    if (visionModelInput) {
      visionModelInput.value = state.apiConfig.visionModel || '';
    }

    loadApiPresetsDropdown(forcePresetId);
    if (typeof refreshAllEndpointPresetUi === 'function') {
      refreshAllEndpointPresetUi();
    }
    displayTotalImageSize();
  }

  window.renderApiSettingsProxy = renderApiSettings;


// ========== 提示音预设管理 ==========

  async function migrateSoundPresetsToDb() {
    try {
      // 检查数据库表是否为空
      const existingPresets = await db.soundPresets.toArray();
      if (existingPresets.length > 0) {
        console.log('[声音预设迁移] 数据库表已有数据，跳过迁移');
        return;
      }

      // 检查旧数据是否存在
      if (state.globalSettings.soundPresets && Array.isArray(state.globalSettings.soundPresets) && state.globalSettings.soundPresets.length > 0) {
        console.log('[声音预设迁移] 发现旧数据，开始迁移...', state.globalSettings.soundPresets);
        
        // 迁移数据到新表
        for (const preset of state.globalSettings.soundPresets) {
          await db.soundPresets.add({
            name: preset.name,
            url: preset.url
          });
        }
        
        console.log(`[声音预设迁移] 成功迁移 ${state.globalSettings.soundPresets.length} 个预设到数据库表`);
      } else {
        console.log('[声音预设迁移] 未发现旧数据');
      }
    } catch (error) {
      console.error('[声音预设迁移] 迁移失败:', error);
    }
  }

  // 加载提示音预设下拉框
  async function loadSoundPresetsDropdown(forceSelectedId = null) {
    console.log('[声音预设DEBUG] loadSoundPresetsDropdown 被调用, forceSelectedId:', forceSelectedId);
    const selectEl = document.getElementById('sound-preset-select');
    if (!selectEl) {
      console.error('[声音预设DEBUG] 找不到 sound-preset-select 元素！');
      return;
    }

    selectEl.innerHTML = '<option value="current">当前配置 (未保存)</option>';

    console.log('[声音预设DEBUG] 开始从数据库读取预设...');
    const presets = await db.soundPresets.toArray();
    console.log('[声音预设DEBUG] 从数据库读取到的预设:', presets);
    
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
      console.log('[声音预设DEBUG] 添加预设到下拉框:', preset.name, 'ID:', preset.id);
    });

    // 如果指定了要选中的预设ID
    if (forceSelectedId) {
      selectEl.value = forceSelectedId;
      return;
    }

    // 自动匹配当前配置
    const currentUrl = document.getElementById('notification-sound-url-input').value.trim();
    let matchingPresetId = null;
    for (const preset of presets) {
      if (preset.url === currentUrl) {
        matchingPresetId = preset.id;
        break;
      }
    }

    if (matchingPresetId) {
      selectEl.value = matchingPresetId;
    } else {
      selectEl.value = 'current';
    }
  }

  // 处理提示音预设选择变化
  async function handleSoundPresetSelectionChange() {
    const selectEl = document.getElementById('sound-preset-select');
    const selectedValue = selectEl.value;

    if (selectedValue === 'current') {
      return;
    }

    const selectedId = parseInt(selectedValue);
    if (isNaN(selectedId)) {
      return;
    }

    const preset = await db.soundPresets.get(selectedId);
    if (!preset) return;

    // 直接应用预设
    document.getElementById('notification-sound-url-input').value = preset.url || '';
    state.globalSettings.notificationSoundUrl = preset.url || '';
    saveState();

    // 刷新下拉框，确保选中状态
    await loadSoundPresetsDropdown(selectedId);
  }

  // 保存提示音预设
  async function saveSoundPreset() {
    console.log('[声音预设DEBUG] saveSoundPreset 被调用');
    const url = document.getElementById('notification-sound-url-input').value.trim();

    // 请求输入预设名称
    const name = await showCustomPrompt('保存提示音预设', '请输入预设名称');
    if (!name || name.trim() === '') {
      console.log('[声音预设DEBUG] 用户取消输入');
      return;
    }

    state.globalSettings.customThoughtsUIEnabled = document.getElementById('custom-thoughts-ui-switch').checked;
    state.globalSettings.customThoughtsHTML = document.getElementById('custom-thoughts-html-textarea').value;
    state.globalSettings.customThoughtsCSS = document.getElementById('custom-thoughts-css-textarea').value;

    const presetData = {
      name: name.trim(),
      url: url
    };
    console.log('[声音预设DEBUG] 准备保存预设:', presetData);

    // 检查是否已存在同名预设
    const existingPreset = await db.soundPresets.where('name').equals(presetData.name).first();
    if (existingPreset) {
      console.log('[声音预设DEBUG] 发现同名预设:', existingPreset);
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) {
        console.log('[声音预设DEBUG] 用户取消覆盖');
        return;
      }
      presetData.id = existingPreset.id;
    }

    console.log('[声音预设DEBUG] 开始写入数据库...');
    await db.soundPresets.put(presetData);
    console.log('[声音预设DEBUG] 数据库写入完成，返回的ID:', presetData.id);
    
    console.log('[声音预设DEBUG] 准备刷新下拉框...');
    await loadSoundPresetsDropdown(presetData.id);
    console.log('[声音预设DEBUG] 下拉框刷新完成');
    
    alert('预设已保存！');
  }

  // 删除提示音预设（从下拉框删除选中的预设）
  async function deleteSoundPreset() {
    const selectEl = document.getElementById('sound-preset-select');
    const selectedValue = selectEl.value;

    if (selectedValue === 'current') {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const selectedId = parseInt(selectedValue);
    if (isNaN(selectedId)) {
      return;
    }

    const preset = await db.soundPresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.soundPresets.delete(selectedId);
      await loadSoundPresetsDropdown();
      alert('预设已删除！');
    }
  }

  // 渲染提示音预设列表（保持兼容，但现在主要用下拉框）
  async function renderSoundPresets() {
    console.log('[声音预设DEBUG] renderSoundPresets 被调用');
    await migrateSoundPresetsToDb(); // 先执行数据迁移
    console.log('[声音预设DEBUG] 迁移完成，开始加载下拉框');
    await loadSoundPresetsDropdown();
    console.log('[声音预设DEBUG] 下拉框加载完成');
  }

  // ========== 提示音预设管理功能结束 ==========


// ========== 壁纸/外观屏幕渲染 ==========

  async function renderWallpaperScreen(forcePresetId = null) {
    console.log('[声音预设DEBUG] renderWallpaperScreen 被调用');
    loadCssPresetsDropdown();
    // 这里传入 forcePresetId
    loadAppearancePresetsDropdown(forcePresetId);

    const ephonePreview = document.getElementById('wallpaper-preview');

    if (newWallpaperBase64) {
      ephonePreview.style.backgroundImage = `url("${newWallpaperBase64}")`;
      ephonePreview.textContent = '';
    } else {
      const ephoneBg = state.globalSettings.wallpaper;
      if (ephoneBg && ephoneBg.trim() !== '') {
        ephonePreview.style.backgroundImage = `url("${ephoneBg}")`;
        ephonePreview.textContent = '';
      } else {
        ephonePreview.style.backgroundImage = 'none';
        ephonePreview.style.backgroundColor = '#ffffff';
        ephonePreview.textContent = '点击下方上传';
      }
    }

    const cphonePreview = document.getElementById('cphone-wallpaper-preview');
    const cphoneBg = state.globalSettings.cphoneWallpaper;
    if (cphoneBg) {
      cphonePreview.style.backgroundImage = `url("${cphoneBg}")`;
      cphonePreview.textContent = '';
    } else {
      cphonePreview.style.backgroundImage = 'none';
      cphonePreview.style.backgroundColor = '#ffffff';
      cphonePreview.textContent = '当前为白色';
    }

    const myphonePreview = document.getElementById('myphone-wallpaper-preview');
    const myphoneBg = state.globalSettings.myphoneWallpaper;
    if (myphoneBg) {
      myphonePreview.style.backgroundImage = `url("${myphoneBg}")`;
      myphonePreview.textContent = '';
    } else {
      myphonePreview.style.backgroundImage = 'none';
      myphonePreview.style.backgroundColor = '#ffffff';
      myphonePreview.textContent = '当前为白色';
    }

    const globalBgPreview = document.getElementById('global-bg-preview');
    const globalBg = state.globalSettings.globalChatBackground;
    if (globalBg) {
      globalBgPreview.style.backgroundImage = `url(${globalBg})`;
      globalBgPreview.textContent = '';
    } else {
      globalBgPreview.style.backgroundImage = 'none';
      globalBgPreview.style.backgroundColor = '#ffffff';
      globalBgPreview.textContent = '点击下方上传';
    }

    // 【修复】三个 render 改成 async（分批插入），这里必须 await 才能保证隐藏的溢出提示在最后追加
    await renderIconSettings();
    await renderCPhoneIconSettings();
    await renderMyPhoneIconSettings();

    // 【第二刀】后台异步迁移 base64 图标到 ImgBB（fire-and-forget，不阻塞当前渲染）
    // 完成后会自动更新 grid 里 img.src 和 db.globalSettings，下次开就不卡了
    if (!window._iconMigrationInProgress && typeof migrateBase64IconsToImgBB === 'function') {
      window._iconMigrationInProgress = true;
      migrateBase64IconsToImgBB()
        .then(result => {
          if (result.migrated > 0) {
            console.log(`[图标迁移] 主页可见提示：${result.migrated} 张图标已自动上传到图床`);
          }
        })
        .catch(err => console.error('[图标迁移] 异常:', err))
        .finally(() => { window._iconMigrationInProgress = false; });
    }
    document.getElementById('global-css-input').value = state.globalSettings.globalCss || '';
    document.getElementById('notification-sound-url-input').value = state.globalSettings.notificationSoundUrl || '';

    // 初始化音量滑动条
    const volumeValue = (state.globalSettings.notificationVolume !== undefined ? state.globalSettings.notificationVolume : 1.0) * 100;
    document.getElementById('notification-volume-slider').value = volumeValue;
    document.getElementById('notification-volume-label').textContent = Math.round(volumeValue) + '%';

    if (typeof renderSoundPresets === 'function') {
      console.log('[声音预设DEBUG] 准备调用 renderSoundPresets');
      await renderSoundPresets(); // 渲染提示音预设列表
      console.log('[声音预设DEBUG] renderSoundPresets 调用完成');
    } else {
      console.error('[声音预设DEBUG] renderSoundPresets 函数不存在！');
    }
    document.getElementById('status-bar-toggle-switch').checked = state.globalSettings.showStatusBar || false;
    document.getElementById('global-show-seconds-switch').checked = state.globalSettings.showSeconds || false;
    document.getElementById('phone-frame-toggle-switch').checked = state.globalSettings.showPhoneFrame || false;
    document.getElementById('minimal-chat-ui-switch').checked = state.globalSettings.enableMinimalChatUI || false;
    document.getElementById('dynamic-island-music-toggle-switch').checked = state.globalSettings.alwaysShowMusicIsland || false;
    document.getElementById('detach-status-bar-switch').checked = state.globalSettings.detachStatusBar || false;
    document.getElementById('enable-streaming-switch').checked = state.globalSettings.enableStreaming === true;
    document.getElementById('dropdown-popup-mode-switch').checked = state.globalSettings.dropdownPopupMode || false;
    document.getElementById('lock-screen-toggle').checked = state.globalSettings.lockScreenEnabled || false; // 锁屏回显
    document.getElementById('lock-screen-password-input').value = state.globalSettings.lockScreenPassword || ''; // 密码回显

    // 锁屏壁纸回显
    const lockPreview = document.getElementById('lock-wallpaper-preview');
    if (state.globalSettings.lockScreenWallpaper) {
      lockPreview.style.backgroundImage = `url(${state.globalSettings.lockScreenWallpaper})`;
      lockPreview.textContent = '';
    } else {
      lockPreview.style.backgroundImage = 'linear-gradient(135deg, #1c1c1e, #3a3a3c)';
      lockPreview.textContent = '默认壁纸';
    }

    renderButtonOrderEditor();
    initializeButtonOrderEditor();

    // 加载系统通知设置
    loadSystemNotificationSettings();
  }

  window.renderWallpaperScreenProxy = renderWallpaperScreen;

  function applyGlobalWallpaper() {
    const homeScreen = document.getElementById('home-screen');
    const wallpaper = state.globalSettings.wallpaper;
    if (wallpaper) {
      // 区分 CSS 表达式（渐变 / 已包装的 url()）和裸 URL
      // 默认值是 linear-gradient(...) 字符串，包到 url() 里会变无效 CSS → 蓝玻璃消失
      const trimmed = String(wallpaper).trim();
      if (/^(linear-gradient|radial-gradient|conic-gradient)\(/i.test(trimmed) || /^url\(/i.test(trimmed)) {
        homeScreen.style.backgroundImage = trimmed;
      } else {
        homeScreen.style.backgroundImage = `url("${trimmed}")`;
      }
      homeScreen.style.backgroundColor = '';
    } else {
      // wallpaper 为空时用 removeProperty（不能用 = ''，因为 style 字符串里仍包含 'background-image' 属性名
      // 会让 extra.css 的 #home-screen:not([style*="background-image"])::before 伪元素兜底失效）
      homeScreen.style.removeProperty('background-image');
      homeScreen.style.removeProperty('background-color');
    }
  }


// ========== CSS 预设管理 ==========

  async function loadCssPresetsDropdown() {
    const selectEl = document.getElementById('css-preset-select');
    selectEl.innerHTML = '<option value="">-- 选择一个预设 --</option>';

    const presets = await db.appearancePresets.where('type').equals('global_css').toArray();
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });
  }


  async function handleCssPresetSelectionChange() {
    const selectEl = document.getElementById('css-preset-select');
    const selectedId = parseInt(selectEl.value);
    if (isNaN(selectedId)) return;

    const preset = await db.appearancePresets.get(selectedId);
    if (preset) {
      const cssInput = document.getElementById('global-css-input');
      cssInput.value = preset.value;
      applyGlobalCss(preset.value);
    }
  }


  async function saveCssPreset() {
    const name = await showCustomPrompt('保存CSS预设', '请输入预设名称');
    if (!name || !name.trim()) return;

    const cssValue = document.getElementById('global-css-input').value;

    const existingPreset = await db.appearancePresets.where({
      name: name.trim(),
      type: 'global_css'
    }).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${name.trim()}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;

      await db.appearancePresets.update(existingPreset.id, {
        value: cssValue
      });
    } else {
      await db.appearancePresets.add({
        name: name.trim(),
        type: 'global_css',
        value: cssValue
      });
    }

    await loadCssPresetsDropdown();
    alert('CSS 预设已保存！');
  }


  async function deleteCssPreset() {
    const selectEl = document.getElementById('css-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const preset = await db.appearancePresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.appearancePresets.delete(selectedId);
      await loadCssPresetsDropdown();
      alert('预设已删除。');
    }
  }


// ========== 字体预设管理 ==========

  async function loadFontPresetsDropdown() {
    const selectEl = document.getElementById('font-preset-select');
    selectEl.innerHTML = '<option value="">-- 选择一个预设 --</option>';

    const presets = await db.appearancePresets.where('type').equals('font').toArray();
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });
  }


  async function handleFontPresetSelectionChange() {
    const selectEl = document.getElementById('font-preset-select');
    const selectedId = parseInt(selectEl.value);
    if (isNaN(selectedId)) return;

    const preset = await db.appearancePresets.get(selectedId);
    if (preset) {
      const fontUrlInput = document.getElementById('font-url-input');
      fontUrlInput.value = preset.value;
      applyCustomFont(preset.value, true);
    }
  }


  async function saveFontPreset() {
    const name = await showCustomPrompt('保存字体预设', '请输入预设名称');
    if (!name || !name.trim()) return;

    const fontUrl = document.getElementById('font-url-input').value.trim();
    if (!fontUrl) {
      alert("字体URL不能为空！");
      return;
    }

    const existingPreset = await db.appearancePresets.where({
      name: name.trim(),
      type: 'font'
    }).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${name.trim()}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;

      await db.appearancePresets.update(existingPreset.id, {
        value: fontUrl
      });
    } else {
      await db.appearancePresets.add({
        name: name.trim(),
        type: 'font',
        value: fontUrl
      });
    }

    await loadFontPresetsDropdown();
    alert('字体预设已保存！');
  }


  async function deleteFontPreset() {
    const selectEl = document.getElementById('font-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const preset = await db.appearancePresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.appearancePresets.delete(selectedId);
      await loadFontPresetsDropdown();
      alert('预设已删除。');
    }
  }


// ========== 外观预设管理 ==========

  // 找到这个函数并替换
  async function loadAppearancePresetsDropdown(forceSelectedId = null) {
    const selectEl = document.getElementById('appearance-preset-select');
    if (!selectEl) return; // 防御性检查：元素不存在时直接返回
    selectEl.innerHTML = '<option value="">-- 选择一个预设 --</option>';

    const presets = await db.appearancePresets.where('type').equals('appearance').toArray();
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });

    // 如果传入了强制选中的ID，直接选中它，不再进行复杂的对比
    if (forceSelectedId) {
      selectEl.value = forceSelectedId;
      return;
    }

    // 只有在没有强制选中时，才执行原来的自动匹配逻辑
    const currentSettings = {
      wallpaper: state.globalSettings.wallpaper,
      cphoneWallpaper: state.globalSettings.cphoneWallpaper,
      globalChatBackground: state.globalSettings.globalChatBackground,
      appIcons: state.globalSettings.appIcons,
      cphoneAppIcons: state.globalSettings.cphoneAppIcons,
      myphoneAppIcons: state.globalSettings.myphoneAppIcons,
      chatActionButtonsOrder: state.globalSettings.chatActionButtonsOrder,
      theme: localStorage.getItem('ephone-theme') || 'light',
      showStatusBar: state.globalSettings.showStatusBar,
      notificationSoundUrl: state.globalSettings.notificationSoundUrl,
      widgetData: state.globalSettings.widgetData
    };

    let matchingPresetId = null;

    for (const preset of presets) {
      if (JSON.stringify(preset.value) === JSON.stringify(currentSettings)) {
        matchingPresetId = preset.id;
        break;
      }
    }

    if (matchingPresetId) {
      selectEl.value = matchingPresetId;
    } else {
      selectEl.value = '';
    }
  }



  // 找到这个函数并替换
  async function handleAppearancePresetSelectionChange() {
    const selectEl = document.getElementById('appearance-preset-select');
    const selectedId = parseInt(selectEl.value);
    if (isNaN(selectedId)) return;

    const preset = await db.appearancePresets.get(selectedId);
    if (preset && preset.value) {
      const data = preset.value;

      // 1. 智能合并图标（保留上一轮的修复）
      const mergedAppIcons = {
        ...DEFAULT_APP_ICONS,
        ...(data.appIcons || {})
      };
      const mergedCPhoneIcons = {
        ...DEFAULT_CPHONE_ICONS,
        ...(data.cphoneAppIcons || {})
      };
      const mergedMyPhoneIcons = {
        ...DEFAULT_MYPHONE_ICONS,
        ...(data.myphoneAppIcons || {})
      };

      Object.assign(state.globalSettings, data);
      state.globalSettings.appIcons = mergedAppIcons;
      state.globalSettings.cphoneAppIcons = mergedCPhoneIcons;
      state.globalSettings.myphoneAppIcons = mergedMyPhoneIcons;

      applyTheme(data.theme || 'light');
      await db.globalSettings.put(state.globalSettings);

      applyGlobalWallpaper();
      applyCPhoneWallpaper();
      applyMyPhoneWallpaper();
      // 【修复】三个 render 已改成 async，必须 await
      await renderIconSettings();
      await renderCPhoneIconSettings();
      await renderMyPhoneIconSettings();

      // 【第二刀】也触发后台迁移（导入预设里可能也有 base64 图标）
      if (!window._iconMigrationInProgress && typeof migrateBase64IconsToImgBB === 'function') {
        window._iconMigrationInProgress = true;
        migrateBase64IconsToImgBB()
          .catch(err => console.error('[图标迁移] 异常:', err))
          .finally(() => { window._iconMigrationInProgress = false; });
      }
      applyAppIcons();
      applyCPhoneAppIcons();
      applyMyPhoneAppIconsGlobal();
      applyStatusBarVisibility();
      applyWidgetData();

      if (data.chatActionButtonsOrder) {
        renderButtonOrderEditor();
        applyButtonOrder();
      }

      // 【关键修改】：调用 renderWallpaperScreen 时传入 selectedId
      // 这样下拉框就会被强制设置为当前选中的预设，而不会跳回"请选择"
      renderWallpaperScreen(selectedId);

      alert(`已成功加载外观预设："${preset.name}"\n(缺失的新App图标已自动重置为默认)`);
    }
  }


  async function saveAppearancePreset() {
    const name = await showCustomPrompt('保存外观预设', '请输入预设名称');
    if (!name || !name.trim()) return;


    const appearanceData = {
      wallpaper: state.globalSettings.wallpaper,
      cphoneWallpaper: state.globalSettings.cphoneWallpaper,
      globalChatBackground: state.globalSettings.globalChatBackground,
      appIcons: state.globalSettings.appIcons,
      cphoneAppIcons: state.globalSettings.cphoneAppIcons,
      myphoneAppIcons: state.globalSettings.myphoneAppIcons,
      chatActionButtonsOrder: state.globalSettings.chatActionButtonsOrder,
      theme: localStorage.getItem('ephone-theme') || 'light',
      showStatusBar: state.globalSettings.showStatusBar,
      notificationSoundUrl: state.globalSettings.notificationSoundUrl,
      widgetData: state.globalSettings.widgetData
    };


    const existingPreset = await db.appearancePresets.where({
      name: name.trim(),
      type: 'appearance'
    }).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${name.trim()}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;

      await db.appearancePresets.update(existingPreset.id, {
        value: appearanceData
      });
    } else {
      await db.appearancePresets.add({
        name: name.trim(),
        type: 'appearance',
        value: appearanceData
      });
    }


    await loadAppearancePresetsDropdown();
    alert('外观预设已保存！');
  }


  async function deleteAppearancePreset() {
    const selectEl = document.getElementById('appearance-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const preset = await db.appearancePresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.appearancePresets.delete(selectedId);
      await loadAppearancePresetsDropdown();
      alert('预设已删除。');
    }
  }


// ========== 主题预设管理 ==========

  async function loadThemePresetsDropdown() {
    const selectEl = document.getElementById('theme-preset-select');
    selectEl.innerHTML = '<option value="">-- 选择一个预设 --</option>';

    const presets = await db.appearancePresets.where('type').equals('bubble_theme').toArray();
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });
  }


  async function handleThemePresetSelectionChange() {
    const selectEl = document.getElementById('theme-preset-select');
    const selectedId = parseInt(selectEl.value);
    if (isNaN(selectedId)) return;

    const preset = await db.appearancePresets.get(selectedId);
    if (preset) {


      const baseTheme = preset.value.base || 'default';
      const customCss = preset.value.custom || '';


      const themeRadio = document.querySelector(`input[name="theme-select"][value="${baseTheme}"]`);
      if (themeRadio) {
        themeRadio.checked = true;
      }


      const customCssInput = document.getElementById('custom-css-input');
      customCssInput.value = customCss;


      updateSettingsPreview();

    }
  }


  async function saveThemePreset() {
    const name = await showCustomPrompt('保存主题预设', '请输入预设名称');
    if (!name || !name.trim()) return;



    const selectedThemeRadio = document.querySelector('input[name="theme-select"]:checked');
    const themeValue = selectedThemeRadio ? selectedThemeRadio.value : 'default';


    const cssValue = document.getElementById('custom-css-input').value.trim();


    const presetValueObject = {
      base: themeValue,
      custom: cssValue
    };


    const existingPreset = await db.appearancePresets.where({
      name: name.trim(),
      type: 'bubble_theme'
    }).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${name.trim()}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;


      await db.appearancePresets.update(existingPreset.id, {
        value: presetValueObject
      });
    } else {
      await db.appearancePresets.add({
        name: name.trim(),
        type: 'bubble_theme',

        value: presetValueObject
      });
    }

    await loadThemePresetsDropdown();
    alert('主题预设已保存！');
  }


  async function deleteThemePreset() {
    const selectEl = document.getElementById('theme-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const preset = await db.appearancePresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.appearancePresets.delete(selectedId);
      await loadThemePresetsDropdown();
      alert('预设已删除。');
    }
  }

// ========== 预设管理功能（从 script.js 补充拆分，原第 47706~48160 行） ==========

  let editingPresetId = null;

  async function openPresetScreen() {
    await renderPresetScreen();
    showScreen('preset-screen');
  }

  async function renderPresetScreen() {
    const tabsContainer = document.getElementById('preset-tabs');
    const contentContainer = document.getElementById('preset-content-container');
    tabsContainer.innerHTML = '';
    contentContainer.innerHTML = '';

    const [presets, categories] = await Promise.all([
      db.presets.toArray(),
      db.presetCategories.orderBy('name').toArray()
    ]);

    state.presets = presets;

    if (presets.length === 0) {
      contentContainer.innerHTML = '<p style="text-align:center; color: #8a8a8a; margin-top: 50px;">点击右上角 "+" 创建你的第一个预设</p>';
      return;
    }

    const allTab = document.createElement('button');
    allTab.className = 'world-book-tab active';
    allTab.textContent = '全部';
    allTab.dataset.categoryId = 'all';
    tabsContainer.appendChild(allTab);

    const allPane = document.createElement('div');
    allPane.className = 'world-book-category-pane active';
    allPane.dataset.categoryId = 'all';
    contentContainer.appendChild(allPane);

    categories.forEach(category => {
      const categoryTab = document.createElement('button');
      categoryTab.className = 'world-book-tab';
      categoryTab.textContent = category.name;
      categoryTab.dataset.categoryId = String(category.id);
      tabsContainer.appendChild(categoryTab);

      const categoryPane = document.createElement('div');
      categoryPane.className = 'world-book-category-pane';
      categoryPane.dataset.categoryId = String(category.id);
      contentContainer.appendChild(categoryPane);
    });

    const hasUncategorized = presets.some(p => !p.categoryId);
    if (hasUncategorized) {
      const uncategorizedTab = document.createElement('button');
      uncategorizedTab.className = 'world-book-tab';
      uncategorizedTab.textContent = '未分类';
      uncategorizedTab.dataset.categoryId = 'uncategorized';
      tabsContainer.appendChild(uncategorizedTab);

      const uncategorizedPane = document.createElement('div');
      uncategorizedPane.className = 'world-book-category-pane';
      uncategorizedPane.dataset.categoryId = 'uncategorized';
      contentContainer.appendChild(uncategorizedPane);
    }

    presets.forEach(preset => {
      const contentPreview = `该预设包含 ${preset.content.length} 个条目。`;

      const card = document.createElement('div');
      card.className = 'world-book-card';
      card.innerHTML = `
            <div class="card-title">${preset.name}</div>
            <div class="card-content-preview">${contentPreview}</div>
        `;

      const cardClickHandler = () => openPresetEditor(preset.id);
      const cardLongPressHandler = async () => {
        const confirmed = await showCustomConfirm('删除预设', `确定要删除《${preset.name}》吗？`, {
          confirmButtonClass: 'btn-danger'
        });
        if (confirmed) {
          await db.presets.delete(preset.id);
          state.presets = await db.presets.toArray();
          renderPresetScreen();
        }
      };

      card.addEventListener('click', cardClickHandler);
      addLongPressListener(card, cardLongPressHandler);

      const clonedCardForAll = card.cloneNode(true);
      clonedCardForAll.addEventListener('click', cardClickHandler);
      addLongPressListener(clonedCardForAll, cardLongPressHandler);
      allPane.appendChild(clonedCardForAll);

      const categoryKey = preset.categoryId ? String(preset.categoryId) : 'uncategorized';
      const targetPane = contentContainer.querySelector(`.world-book-category-pane[data-category-id="${categoryKey}"]`);
      if (targetPane) {
        targetPane.appendChild(card);
      }
    });

    document.querySelectorAll('#preset-tabs .world-book-tab').forEach(tab => {
      tab.addEventListener('click', () => switchPresetCategory(tab.dataset.categoryId));
    });
  }

  function switchPresetCategory(categoryId) {
    document.querySelectorAll('#preset-tabs .world-book-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.categoryId === categoryId);
    });
    document.querySelectorAll('#preset-content-container .world-book-category-pane').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.categoryId === categoryId);
    });
  }

  async function openPresetEditor(presetId) {
    showScreen('preset-editor-screen');
    editingPresetId = presetId;

    try {
      const [preset, categories] = await Promise.all([
        db.presets.get(presetId),
        db.presetCategories.toArray()
      ]);

      if (!preset) {
        console.error("错误：尝试打开一个不存在的预设，ID:", presetId);
        await showCustomAlert("加载失败", "找不到这个预设的详细信息。");
        showScreen('preset-screen');
        return;
      }

      setTimeout(() => {
        document.getElementById('preset-editor-title').textContent = preset.name;
        document.getElementById('preset-name-input').value = preset.name;

        const selectEl = document.getElementById('preset-category-select');
        selectEl.innerHTML = '<option value="">-- 未分类 --</option>';
        categories.forEach(cat => {
          const option = document.createElement('option');
          option.value = cat.id;
          option.textContent = cat.name;
          if (preset.categoryId === cat.id) option.selected = true;
          selectEl.appendChild(option);
        });

        const entriesContainer = document.getElementById('preset-entries-container');
        entriesContainer.innerHTML = '';
        if (Array.isArray(preset.content) && preset.content.length > 0) {
          preset.content.forEach(entry => {
            const block = createPresetEntryBlock(entry);
            entriesContainer.appendChild(block);
          });
        } else {
          entriesContainer.innerHTML = '<p style="text-align:center; color: var(--text-secondary); margin-top: 20px;">还没有内容，点击下方按钮添加第一条吧！</p>';
        }
      }, 50);

    } catch (error) {
      console.error("打开预设编辑器时发生严重错误:", error);
      await showCustomAlert("加载失败", `加载预设详情时发生错误: ${error.message}`);
      showScreen('preset-screen');
    }
  }

  function createPresetEntryBlock(entry = {
    keys: [],
    comment: '',
    content: '',
    enabled: true
  }) {
    const block = document.createElement('div');
    block.className = 'message-editor-block';
    const isChecked = entry.enabled !== false ? 'checked' : '';

    block.innerHTML = `
        <div style="display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-bottom: 5px;">
            <label class="toggle-switch" title="启用/禁用此条目">
                <input type="checkbox" class="entry-enabled-switch" ${isChecked}>
                <span class="slider"></span>
            </label>
            <button type="button" class="delete-block-btn" title="删除此条目">×</button>
        </div>
        <div class="form-group" style="margin-bottom: 10px;">
            <label style="font-size: 0.8em;">备注 (可选)</label>
            <input type="text" class="entry-comment-input" value="${entry.comment || ''}" placeholder="例如：角色核心设定" style="padding: 8px;">
        </div>
        <div class="form-group" style="margin-bottom: 10px;">
            <label style="font-size: 0.8em;">关键词 (用英文逗号,分隔)</label>
            <input type="text" class="entry-keys-input" value="${(entry.keys || []).join(', ')}" placeholder="例如: key1, key2" style="padding: 8px;">
        </div>
        <div class="form-group" style="margin-bottom: 0;">
            <label style="font-size: 0.8em; display: flex; justify-content: space-between; align-items: center;">
                <span>内容 (点击右侧展开)</span>
                <button type="button" class="toggle-content-btn">展开</button>
            </label>
            <div class="entry-content-container">
                 <textarea class="entry-content-textarea" rows="8" style="width: 100%; font-size: 14px;">${entry.content || ''}</textarea>
            </div>
        </div>
    `;

    block.querySelector('.delete-block-btn').addEventListener('click', () => block.remove());

    const toggleBtn = block.querySelector('.toggle-content-btn');
    const contentContainer = block.querySelector('.entry-content-container');
    toggleBtn.addEventListener('click', () => {
      const isHidden = contentContainer.style.display === 'none';
      contentContainer.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? '收起' : '展开';
    });

    return block;
  }

  async function openPresetCategoryManager() {
    await renderPresetCategoriesInManager();

    document.querySelector('#group-management-modal .modal-header span').textContent = '管理预设分类';
    document.getElementById('add-new-group-btn').onclick = addNewPresetCategory;
    document.getElementById('existing-groups-list').onclick = (e) => {
      if (e.target.classList.contains('delete-group-btn')) {
        deletePresetCategory(parseInt(e.target.dataset.id));
      }
    };
    document.getElementById('close-group-manager-btn').onclick = () => {
      document.getElementById('group-management-modal').classList.remove('visible');
      renderPresetScreen();
    };
    document.getElementById('group-management-modal').classList.add('visible');
  }

  async function renderPresetCategoriesInManager() {
    const listEl = document.getElementById('existing-groups-list');
    const categories = await db.presetCategories.toArray();
    listEl.innerHTML = '';
    if (categories.length === 0) {
      listEl.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">还没有任何分类</p>';
    }
    categories.forEach(cat => {
      const item = document.createElement('div');
      item.className = 'existing-group-item';
      item.innerHTML = `<span class="group-name">${cat.name}</span><span class="delete-group-btn" data-id="${cat.id}">×</span>`;
      listEl.appendChild(item);
    });
  }

  async function addNewPresetCategory() {
    const input = document.getElementById('new-group-name-input');
    const name = input.value.trim();
    if (!name) return alert('分类名不能为空！');
    const existing = await db.presetCategories.where('name').equals(name).first();
    if (existing) return alert(`分类 "${name}" 已经存在了！`);
    await db.presetCategories.add({ name });
    input.value = '';
    await renderPresetCategoriesInManager();
  }

  async function deletePresetCategory(categoryId) {
    const confirmed = await showCustomConfirm('确认删除', '删除分类后，该分类下的所有预设将变为"未分类"。确定吗？', {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.presetCategories.delete(categoryId);
      await db.presets.where('categoryId').equals(categoryId).modify({ categoryId: null });
      state.presets = await db.presets.toArray();
      await renderPresetCategoriesInManager();
    }
  }

  async function handlePresetImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      if (!file.name.endsWith('.json')) {
        throw new Error("文件格式不支持。请选择 .json 格式的 Tavern 预设文件。");
      }

      const text = await file.text();
      const tavernData = JSON.parse(text);
      await importTavernPresetFile(tavernData, file.name);

    } catch (error) {
      console.error("预设导入失败:", error);
      await showCustomAlert("导入失败", `无法解析预设文件。\n错误: ${error.message}`);
    } finally {
      event.target.value = null;
    }
  }

  async function importTavernPresetFile(tavernData, fileName) {
    let newEntries = [];

    if (Array.isArray(tavernData.prompts) && Array.isArray(tavernData.prompt_order) && tavernData.prompt_order.length > 0) {
      console.log("检测到 Tavern/SillyTavern 预设格式，将严格按照 prompt_order 排序。");
      const promptsMap = new Map(tavernData.prompts.map(p => [p.identifier, p]));
      const orderArray = tavernData.prompt_order.reduce((acc, curr) => (
        (curr.order && curr.order.length > (acc.length || 0)) ? curr.order : acc
      ), []);

      if (orderArray && orderArray.length > 0) {
        newEntries = orderArray
          .map(orderItem => {
            const promptData = promptsMap.get(orderItem.identifier);
            if (promptData) {
              return {
                keys: [],
                comment: promptData.name || '无标题',
                content: promptData.content || '',
                enabled: orderItem.enabled
              };
            }
            return null;
          })
          .filter(Boolean);
      }
    } else if (tavernData.entries && typeof tavernData.entries === 'object') {
      if (Array.isArray(tavernData.order)) {
        newEntries = tavernData.order
          .map(key => tavernData.entries[key])
          .filter(Boolean)
          .map(entry => ({
            keys: entry.key || [],
            comment: entry.comment || '无备注',
            content: entry.content || '',
            enabled: !entry.disable
          }));
      } else {
        newEntries = Object.values(tavernData.entries).map(entry => ({
          keys: entry.key || [],
          comment: entry.comment || '无备注',
          content: entry.content || '',
          enabled: !entry.disable
        }));
      }
    } else if (Array.isArray(tavernData.prompts)) {
      newEntries = tavernData.prompts.map(prompt => ({
        keys: [],
        comment: prompt.name || '无标题',
        content: prompt.content || '',
        enabled: true
      }));
    } else {
      throw new Error("文件格式无法识别。未找到有效的 'prompts' 数组或 'entries' 对象。");
    }

    newEntries = newEntries.filter(entry => entry.content);

    if (newEntries.length === 0) {
      alert("这个预设文件中没有找到任何有效的提示词条目。");
      return;
    }

    const presetNameSuggestion = fileName.replace(/\.json$/i, '');
    const newPresetName = await showCustomPrompt("导入 Tavern 预设", "请为这组提示词预设命名：", presetNameSuggestion);
    if (!newPresetName || !newPresetName.trim()) {
      alert("导入已取消，因为未提供名称。");
      return;
    }

    const newPreset = {
      id: 'preset_' + Date.now(),
      name: newPresetName.trim(),
      content: newEntries,
      categoryId: null
    };

    await db.presets.add(newPreset);
    state.presets.push(newPreset);

    await renderPresetScreen();
    await showCustomAlert('导入成功！', `已成功从文件导入预设《${newPresetName}》。`);
  }

  async function renderOfflinePresetSelector(chat) {
    const selectEl = document.getElementById('offline-preset-select');
    if (!selectEl) return;

    const presets = state.presets || [];

    selectEl.innerHTML = '<option value="">-- 不使用预设 --</option>';
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });

    if (chat.settings.offlinePresetId) {
      selectEl.value = chat.settings.offlinePresetId;
    }
  }

// ========== 设置预览（从 script.js 补充拆分，原第 23278~23369 行） ==========

  async function updateSettingsPreview() {
    if (!state.activeChatId) return;
    const chat = state.chats[state.activeChatId];
    const previewArea = document.getElementById('settings-preview-area');
    if (!previewArea) return;

    const selectedTheme = document.querySelector('input[name="theme-select"]:checked')?.value || 'default';
    const fontSize = document.getElementById('chat-font-size-slider').value;
    const customCss = document.getElementById('custom-css-input').value;
    const background = chat.settings.background;

    previewArea.dataset.theme = selectedTheme;
    previewArea.style.setProperty('--chat-font-size', `${fontSize}px`);

    if (background && background.startsWith('data:image')) {
      previewArea.style.backgroundImage = `url(${background})`;
      previewArea.style.backgroundColor = 'transparent';
    } else {
      previewArea.style.backgroundImage = 'none';
      previewArea.style.background = background || '#f0f2f5';
    }

    previewArea.innerHTML = '';

    const aiMsg = {
      role: 'ai',
      content: '对方消息预览',
      timestamp: 1,
      senderName: chat.name
    };
    try {
      const aiBubble = await createMessageElement(aiMsg, chat);
      if (aiBubble) previewArea.appendChild(aiBubble);
    } catch (error) {
      window.runtimeDiag?.log?.('CHAT_RENDER_BAD_MESSAGE_SKIPPED', { chatId: chat?.id, messageTimestamp: aiMsg?.timestamp, error: error?.message || String(error) });
      console.warn('[CHAT_RENDER_BAD_MESSAGE_SKIPPED]', error, aiMsg);
    }

    const userMsg = {
      role: 'user',
      content: '我的消息预览',
      timestamp: 2
    };
    try {
      const userBubble = await createMessageElement(userMsg, chat);
      if (userBubble) previewArea.appendChild(userBubble);
    } catch (error) {
      window.runtimeDiag?.log?.('CHAT_RENDER_BAD_MESSAGE_SKIPPED', { chatId: chat?.id, messageTimestamp: userMsg?.timestamp, error: error?.message || String(error) });
      console.warn('[CHAT_RENDER_BAD_MESSAGE_SKIPPED]', error, userMsg);
    }

    const previewLyricsBar = document.createElement('div');
    previewLyricsBar.style.cssText = `
                position: absolute; 
                font-size: 11px; 
                padding: 2px 6px; 
                border-radius: 8px; 
                background-color: rgba(0, 0, 0, 0.1); 
                color: var(--text-secondary); 
                white-space: nowrap; 
                transition: all 0.3s ease;
            `;
    previewLyricsBar.textContent = '♪ 歌词位置预览 ♪';
    previewArea.appendChild(previewLyricsBar);

    const vertical = document.getElementById('lyrics-vertical-pos').value;
    const horizontal = document.getElementById('lyrics-horizontal-pos').value;
    const offset = parseInt(document.getElementById('lyrics-offset-input').value) || 10;

    if (vertical === 'top') {
      previewLyricsBar.style.top = `${offset}px`;
    } else {
      previewLyricsBar.style.bottom = `${offset}px`;
    }

    switch (horizontal) {
      case 'left':
        previewLyricsBar.style.left = '15px';
        break;
      case 'right':
        previewLyricsBar.style.right = '15px';
        break;
      default:
        previewLyricsBar.style.left = '50%';
        previewLyricsBar.style.transform = 'translateX(-50%)';
        break;
    }

    applyScopedCss(customCss, '#settings-preview-area', 'preview-bubble-style');
  }

  // ========== 全局暴露 ==========
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fetch-api-preset-models-btn')?.addEventListener('click', fetchModelsForApiPresetCard);
    document.getElementById('api-preset-model-select')?.addEventListener('change', (e) => {
      const modelEl = document.getElementById('api-preset-model');
      if (modelEl) modelEl.value = e.target.value || '';
      updateApiPresetCardDraftFromDom({ defaultModel: e.target.value || '' });
    });
  });

  window.handlePresetSelectionChange = handlePresetSelectionChange;
  window.saveApiPreset = saveApiPreset;
  window.deleteApiPreset = deleteApiPreset;
  window.fetchModelsForApiPresetCard = fetchModelsForApiPresetCard;

// ========== 副API预设管理 ==========

  async function loadSecondaryApiPresetsDropdown(forceSelectedId = null) {
    const selectEl = document.getElementById('secondary-api-preset-select');
    if (!selectEl) return;
    
    selectEl.innerHTML = '<option value="current">当前配置 (未保存)</option>';

    const presets = await db.secondaryApiPresets.toArray();
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });

    if (forceSelectedId) {
      selectEl.value = forceSelectedId;
      return;
    }
    
    const currentConfig = state.apiConfig;
    let matchingPresetId = null;
    for (const preset of presets) {
      if (
        preset.secondaryProxyUrl === currentConfig.secondaryProxyUrl &&
        preset.secondaryApiKey === currentConfig.secondaryApiKey &&
        preset.secondaryModel === currentConfig.secondaryModel
      ) {
        matchingPresetId = preset.id;
        break;
      }
    }

    if (matchingPresetId) {
      selectEl.value = matchingPresetId;
    } else {
      selectEl.value = 'current';
    }
  }

  async function handleSecondaryApiPresetSelectionChange() {
    const selectEl = document.getElementById('secondary-api-preset-select');
    if (!selectEl) return;
    const selectedId = parseInt(selectEl.value, 10);

    if (isNaN(selectedId)) {
      return;
    }

    const preset = await db.secondaryApiPresets.get(selectedId);
    if (preset) {
      state.apiConfig.secondaryProxyUrl = preset.secondaryProxyUrl || '';
      state.apiConfig.secondaryApiKey = preset.secondaryApiKey || '';
      state.apiConfig.secondaryModel = preset.secondaryModel || '';
      
      await db.apiConfig.put(state.apiConfig);

      document.getElementById('secondary-proxy-url').value = state.apiConfig.secondaryProxyUrl;
      document.getElementById('secondary-api-key').value = state.apiConfig.secondaryApiKey;
      document.getElementById('secondary-model-input').value = state.apiConfig.secondaryModel;

      if (preset.secondaryProxyUrl && preset.secondaryApiKey) {
        const fetchBtn = document.getElementById('fetch-secondary-models-btn');
        if(fetchBtn) fetchBtn.click();
      }
    }
  }

  async function saveSecondaryApiPreset() {
    const name = await showCustomPrompt('保存副API预设', '请输入预设名称');
    if (!name || !name.trim()) return;

    const presetData = {
      name: name.trim(),
      secondaryProxyUrl: document.getElementById('secondary-proxy-url').value.trim(),
      secondaryApiKey: document.getElementById('secondary-api-key').value.trim(),
      secondaryModel: document.getElementById('secondary-model-input').value.trim() || document.getElementById('secondary-model-select').value
    };

    const existingPreset = await db.secondaryApiPresets.where('name').equals(presetData.name).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;
      presetData.id = existingPreset.id;
    }

    await db.secondaryApiPresets.put(presetData);
    await loadSecondaryApiPresetsDropdown(presetData.id);
    alert('副API预设已保存！');
  }

  async function deleteSecondaryApiPreset() {
    const selectEl = document.getElementById('secondary-api-preset-select');
    if (!selectEl) return;
    const selectedId = parseInt(selectEl.value, 10);

    if (isNaN(selectedId)) {
      alert('请先从下拉框中选择一个要删除的预设。');
      return;
    }

    const preset = await db.secondaryApiPresets.get(selectedId);
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.secondaryApiPresets.delete(selectedId);
      await loadSecondaryApiPresetsDropdown();
      alert('预设已删除。');
    }
  }

  window.handleSecondaryApiPresetSelectionChange = handleSecondaryApiPresetSelectionChange;
  window.saveSecondaryApiPreset = saveSecondaryApiPreset;
  window.deleteSecondaryApiPreset = deleteSecondaryApiPreset;
  window.handleSoundPresetSelectionChange = handleSoundPresetSelectionChange;
  window.saveSoundPreset = saveSoundPreset;
  window.deleteSoundPreset = deleteSoundPreset;
  window.handleCssPresetSelectionChange = handleCssPresetSelectionChange;
  window.saveCssPreset = saveCssPreset;
  window.deleteCssPreset = deleteCssPreset;
  window.handleFontPresetSelectionChange = handleFontPresetSelectionChange;
  window.saveFontPreset = saveFontPreset;
  window.deleteFontPreset = deleteFontPreset;
  window.handleAppearancePresetSelectionChange = handleAppearancePresetSelectionChange;
  window.saveAppearancePreset = saveAppearancePreset;
  window.deleteAppearancePreset = deleteAppearancePreset;
  window.handleThemePresetSelectionChange = handleThemePresetSelectionChange;
  window.saveThemePreset = saveThemePreset;
  window.deleteThemePreset = deleteThemePreset;
  window.handlePresetImport = handlePresetImport;
  window.renderPresetScreen = renderPresetScreen;
  window.renderOfflinePresetSelector = renderOfflinePresetSelector;
  window.openPresetCategoryManager = openPresetCategoryManager;
  window.applyGlobalWallpaper = applyGlobalWallpaper;
  window.loadSoundPresetsDropdown = loadSoundPresetsDropdown;
  window.loadThemePresetsDropdown = loadThemePresetsDropdown;

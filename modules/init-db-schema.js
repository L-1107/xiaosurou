// ============================================================
// init-db-schema.js
// 数据库 Schema 定义
// 从 init-and-state.js 拆分
// ============================================================

const db = new Dexie('GeminiChatDB');

// memoryCache, memoryRenderCount, isLoadingMoreMemories 已移至 utils.js 全局作用域
// todoCache, todoRenderCount, isLoadingMoreTodos 已移至 utils.js 全局作用域
db.version(50).stores({
  doubanPosts: '++id, timestamp',
  chats: '&id, isGroup, groupId, isPinned, memos, diary, appUsageLog, lastIntelligentSummaryTimestamp',
  apiConfig: '&id, minimaxGroupId, minimaxApiKey',
  globalSettings: '&id',
  userStickers: '&id, url, name, categoryId',
  stickerVisionCache: '&url, description, timestamp',
  worldBooks: '&id, name, categoryId',
  worldBookCategories: '++id, name',
  musicLibrary: '&id',
  personaPresets: '&id',
  qzoneSettings: '&id',
  qzonePosts: '++id, timestamp, authorId',
  qzoneAlbums: '++id, name, createdAt',
  qzonePhotos: '++id, albumId',
  favorites: '++id, type, timestamp, originalTimestamp',
  qzoneGroups: '++id, name',
  memories: '++id, chatId, timestamp, type, targetDate',
  callRecords: '++id, chatId, timestamp, customName',
  shoppingProducts: '++id, name, description, categoryId',
  shoppingCategories: '++id, name',
  apiPresets: '++id, name',
  soundPresets: '++id, name',
  renderingRules: '++id, name, chatId',
  appearancePresets: '++id, name, type',
  stickerCategories: '++id, name',
  customAvatarFrames: '++id, name',
  presets: '&id, name, categoryId',
  presetCategories: '++id, name',
  readingLibrary: '++id, title, lastOpened, linkedStoryId',
  quickReplies: '++id, text, categoryId', // 修改：增加 categoryId 索引
});

// 快捷回复分类系统 - 新增数据表
db.version(51).stores({
  quickReplyCategories: '++id, name',
  npcs: '++id, name, npcGroupId, enableBackgroundActivity, actionCooldownMinutes, lastActionTimestamp',
  npcGroups: '++id, name',
  naiPresets: '++id, name',
  grAuthors: '++id, name',
  grStories: '++id, title, authorId, lastUpdated',
  userWallet: '&id',
  userTransactions: '++id, timestamp, type, amount, description',
  funds: '&id, code, name, riskLevel, currentNav, lastDayNav, history',
  auctions: '++id, status, itemName, endTime', // 拍卖记录
  inventory: '++id, name, type, acquiredTime',
  emails: '++id, sender, senderType, recipient, subject, content, timestamp, isRead'
}).upgrade(tx => {

  return tx.table('worldBooks').toCollection().modify(book => {

    if (typeof book.content === 'string' && book.content.trim() !== '') {
      book.content = [{
        keys: [],
        comment: '从旧版本迁移的条目',
        content: book.content
      }];
    }
  });
});

// 观影播放列表: 旧「一起看电影」已于 2026-10-07 连代码带表一起删除。
// 家庭影院请用 Cinema Room 的 cinemaFilms / cinemaBlobs / cinemaProgress。
//
// ⚠️ Dexie 删表的写法是在【更高版本】的 upgrade 里把该表设成 null ——
// 只从 .stores() 里删掉名字是没用的, 老库里的表会一直留在磁盘上。
// 下面这个版本专干这件事, 不要删。

// 月经记录相关表
db.version(53).stores({
  periodRecords: '++id, startDate, endDate, flow, symptoms, mood, notes, painLevel, pmsSymptoms, productChanges, sleepQuality, exerciseDuration, createdAt',
  periodSettings: '++id, characterId, enabled, avgCycleLength, avgPeriodLength',
  periodNotificationSettings: '&id, enabled, upcomingDays, upcomingTime, recordTime, abnormalCycleMin, abnormalCycleMax, delayDays'
});

// 番茄钟相关表
db.version(54).stores({
  focusSessions: '++id, companionId, startTime, endTime, duration, completed, stage',
  focusStats: '&id, todayCount, totalCount, streakDays, lastFocusDate',
  focusMessages: '++id, sessionId, companionId, stage, message, timestamp'
});

// 修复：为 shoppingProducts 补充 categoryId 索引
db.version(55).stores({
  shoppingProducts: '++id, name, description, categoryId'
});

// 聊天设置模板系统
db.version(56).stores({
  chatSettingsPresets: '++id, name, createdAt'
});

// 副API预设系统
db.version(57).stores({
  secondaryApiPresets: '++id, name'
});

// 统一 API 站点预设（Base URL + Key，供各功能位引用）
db.version(58).stores({
  apiEndpointPresets: '++id, name'
});

// TTS 配置结构升级：移除 apiConfig 上旧 Minimax 扁平索引
db.version(59).stores({
  apiConfig: '&id'
});

// 聊天消息拆表：chats 只保留会话元数据，messages 独立保存消息。
// messages 主键使用稳定 id；复合索引用于按 chatId + timestamp 分页读取。
db.version(60).stores({
  chats: '&id, isGroup, groupId, isPinned, memos, diary, appUsageLog, lastIntelligentSummaryTimestamp, lastMessageTimestamp, messageSchemaVersion',
  messages: '&id, chatId, timestamp, [chatId+timestamp], role, type'
}).upgrade(async tx => {
  const chatsTable = tx.table('chats');
  const messagesTable = tx.table('messages');
  const MESSAGE_SCHEMA_VERSION = 2;

  function safeTimestamp(msg) {
    const ts = Number(msg?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  }

  function createMessageId(chatId, msg, index = 0) {
    if (msg && msg.id) return String(msg.id);
    const role = msg?.role || 'unknown';
    const type = msg?.type || 'text';
    return `${chatId}::${safeTimestamp(msg)}::${role}::${type}::${index}`;
  }

  function buildMessagePreview(msg) {
    if (!msg || msg.isHidden) return '';
    if (msg.type === 'transfer') return '[转账]';
    if (msg.type === 'waimai_request') return '[外卖代付]';
    if (msg.type === 'waimai_order') return '[外卖订单]';
    if (msg.type === 'red_packet') return '[红包]';
    if (msg.type === 'poll') return '[投票]';
    if (msg.type === 'gift') return '[礼物]';
    if (msg.type === 'location_share') return '[位置]';
    if (msg.type === 'voice_message') return '[语音]';
    if (msg.type === 'ai_image' || msg.type === 'user_photo') return '[图片]';
    if (Array.isArray(msg.content)) return '[图片]';
    const text = String(msg.content ?? msg.meaning ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 80)}...` : text;
  }

  await chatsTable.toCollection().modify(chat => {
    const history = Array.isArray(chat.history) ? chat.history : [];
    if (history.length > 0) {
      const messages = history
        .map((msg, index) => {
          if (!msg || typeof msg !== 'object') return null;
          if (!msg.timestamp) msg.timestamp = Date.now();
          msg.chatId = msg.chatId || chat.id;
          msg.id = createMessageId(chat.id, msg, index);
          return msg;
        })
        .filter(Boolean);

      if (messages.length > 0) {
        messagesTable.bulkPut(messages);
        const lastVisible = [...messages].reverse().find(m => m && !m.isHidden);
        const lastAny = messages[messages.length - 1];
        chat.lastMessageTimestamp = lastVisible?.timestamp || lastAny?.timestamp || chat.lastMessageTimestamp || 0;
        chat.lastMessagePreview = lastVisible ? buildMessagePreview(lastVisible) : (chat.lastMessagePreview || '');
        chat.lastMessageRole = lastVisible?.role || chat.lastMessageRole || '';
        chat.lastMessageType = lastVisible?.type || chat.lastMessageType || '';
        chat.messageCount = Math.max(Number(chat.messageCount || 0), messages.length);
      }
    }

    chat.messageSchemaVersion = MESSAGE_SCHEMA_VERSION;
    delete chat.history;
  });
});

// 后台保活自定义音频持久化：保存 Blob 本体，globalSettings 仅保存轻量元数据
db.version(61).stores({
  keepAliveAudios: '&id, updatedAt'
});

// AI 定时提醒任务：仅保存提醒计划数据，本阶段不接入后台扫描/触发逻辑
db.version(62).stores({
  aiReminders: '&id, enabled, characterId, nextTriggerAt, repeatType, updatedAt'
});

// 热点日报快照：每天每时段（凌晨/清晨/上午/午后/傍晚/夜间）存一条，全角色共享
// （2026-07-02 新增：替换原豆瓣功能）
db.version(63).stores({
  hotNewsSnapshots: '&id, fetchedAt'
});

// P1.5 Live2D 用户上传模型 + 通话背景 (跟 330 现有 IDB 模式一致, 本地存, 不跨设备同步)
// live2d_models.files 存 Blob 数组, 朋友 A 上传的角色只有 A 浏览器能看
// live2d_backgrounds.files 存单个背景图片 Blob
db.version(64).stores({
  live2d_models: '&id, name, addedAt',
  live2d_backgrounds: '&id, name, addedAt'
});

// Cinema Room 影片库 (v0.1.0, 2026-10-04 第一阶段)
// 三张表必须拆开: cinemaFilms 放纯元数据, 一旦把 Blob 混在同一条记录里,
// Dexie toArray() 会把整条反序列化 -> 列一次片单就把所有视频读进 JS 堆, 手机必崩。
// 旧观影 (watchTogetherPlaylist) 就是这么崩的: readAsDataURL 存 32MB base64 字符串。
db.version(65).stores({
  cinemaFilms: '&id, name, addedAt, size',          // 元数据, 绝不含 Blob
  cinemaBlobs: '&id',                               // { id, file } File 对象直存, 只取单片时读
  cinemaProgress: '&filmId, updatedAt'              // { filmId, currentTime, duration, updatedAt }
});

// Cinema Room 人物立绘 (2026-10-04 用户需求: 上传透明背景坐姿小人, 摆在沙发上)
// 只存 Blob 本体, 名字不占地方; slot 固定 'left' / 'right' 两个位置。
// ⚠️ 必须存 Blob 不能转 base64 —— 理由跟 cinemaBlobs 一样, base64 会撑爆内存。
db.version(66).stores({
  cinemaChars: '&id, updatedAt'                      // { id:'left'|'right', image: Blob, updatedAt }
});

// 删表: 旧「一起看电影」的观影播放列表 (2026-10-07)
//
// 为什么必须专门写一个版本 —— Dexie 里【只从 .stores() 删掉名字是没用的】,
// 老库的对象仓库会一直留在磁盘上。要真删, 得在更高版本里把名字设成 null。
//
// ⚠️ 里面的数据是当年 readAsDataURL 存进去的 base64 影片 (本文件下方注释
// 记的那个 32MB 内存崩溃), 手机上可能占不少空间, 删掉是好事。
db.version(67).stores({
  watchTogetherPlaylist: null
});

// 短剧前情提要 (db v68, 2026-10-15)
//
// 【为什么必须有这张表】短剧的 episodeMemories / seriesOutline 全在 watchSession
// 内存里, 退出精炼成功后 clearDraft() 一清, 下次进来模型对这部剧是零认知 ——
// 用户看第 3 集时问"刚那个人是谁", 它答不上来。
// 这张表按剧名存一份跨场前情提要: 退出时生成, 进片时喂回模型。
//
// 为什么不是 localStorage (cinema-series-progress 就是那么存的):
//   data-management.js 有 localStorage.clear(), 一键清数据会连带清掉;
//   而且不跟着数据导出走, 手机清一次缓存就全没了。
//
// key = 短剧下载目录的文件夹名 (duanju-bridge server.mjs 的 key: dir.name), 稳定。
// ⚠️ 加这张表必须同时 bump index.html 里 init-db-schema.js 的 ?v=,
//    忘了手机上 Dexie 压根不建表 (v66 cinemaChars 踩过这个坑)。
//    cinema-storage.js 的 ensureSeriesRecapTable() 是第二道防线。
db.version(68).stores({
  cinemaSeriesRecap: '&key, updatedAt'   // { key, title, text, lastEp, createdAt, updatedAt }
});

// 逐条剧情记忆 (db v69, 2026-10-19)
//
// 【为什么必须有这张表】以前每集记忆只活在内存, 退出时靠【一次长上下文调用】
// 精炼完再写进长期记忆, 写完就清空。用户实测那次调用会把开头的三个字当整篇收走
// (静默 2 秒就判说完, 而那个提示词塞了几千字, 模型首字延迟超过 2 秒),
// 而"非空即成功"的判定照样放行 —— 那几集真白看。
//
// 改成: 每看完一集 / 每攒够 5 分钟, 当场写一行。退出时什么都不用做。
// 用户自己点「导出到长期记忆」, 写进去才算账, 写失败行留着还能再点。
//
// id = sessionKey + '#' + ep (同集重播覆盖, 不堆两条)。
//   短剧 sessionKey = 短剧文件夹名, ep = 集号
//   长剧 sessionKey = 'film:' + chatId,  ep = 段落序号
//
// ⚠️ 加这张表必须同时 bump index.html 里 init-db-schema.js 的 ?v=,
//    忘了手机上 Dexie 压根不建表 (v66 cinemaChars 踩过这个坑)。
//    cinema-storage.js 的 ensureEpMemoryTable() 是第二道防线。
db.version(69).stores({
  cinemaEpMemories: '&id, sessionKey, ep, updatedAt'
  // { id, sessionKey, kind, title, ep, text, at, updatedAt }
});

// 「今日私选」日推卡 + 用户反馈 (db v70, 2026-10-21)
//
// 【为什么按 chatId 存】教程是"单用户单一品味画像", 但 330 是多角色的 ——
// 画像按角色(chatId)分开, 不同 AI 给同一个用户挑的歌可以完全不同。
// 同一个角色每天一张卡, 所以 id = `${chatId}::${date}`。
//
// 【卡里不存音频 URL】网易云的 CDN 链接几分钟就过期, 存下来必然是死链。
// 卡里只存 songId + 元数据, 真正播放时走 music-player.js 已有的
// refreshNeteaseTrackUrl() 现取现用。
//
// ⚠️ 加这张表必须同时 bump index.html 里 init-db-schema.js 的 ?v=,
//    忘了手机上 Dexie 压根不建表 (v66 cinemaChars / v69 cinemaEpMemories 踩过)。
db.version(70).stores({
  dailyDiscovery: '&id, chatId, date',                  // { id, chatId, date, title, subtitle, note, generatedAt, strategy, songs:[], seen }
  dailyDiscoveryFeedback: '++id, chatId, songId, action, createdAt'
  // { id, chatId, songId, artist, action, createdAt }
});

window.db = db;

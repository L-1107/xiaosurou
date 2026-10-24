// ============================================================
// init-and-state.js
// 主入口文件（精简后）
// 内容：DOMContentLoaded 入口、billState/state 定义、
//       loadAllDataFromDB()、saveGlobalPlaylist()、init() 函数壳
// 已拆分到独立文件：
//   - init-avatar-frames.js（头像框数据）
//   - init-db-schema.js（数据库 schema）
//   - init-data-protection.js（数据保护/崩溃恢复/自动保存）
//   - init-crash-recovery.js（崩溃恢复检测）
//   - init-pin-city.js（PIN/城市搜索）
//   - init-event-bindingsA.js（事件绑定前半段）
//   - init-event-bindingsB.js（事件绑定中段）
//   - init-features.js（功能模块后半段）
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  // ========================================
  // References to globals from split files
  // ========================================
  const db = window.db;
  const avatarFrames = window.avatarFrames;


  let billState = {
    page: 0,
    pageSize: 30,
    isLoading: false,
    hasMore: true,
    filterDate: '',
    filterType: 'all'
  };
  let state = {
    chats: {},
    activeChatId: null,
    globalSettings: {},
    apiConfig: {},
    userStickers: [],
    worldBooks: [],
    personaPresets: [],
    qzoneSettings: {},
    activeAlbumId: null,
    cache: {
      songs: new Map(),
      lyrics: new Map()
    },
    ttsCache: new Map(),
    quickReplies: []
  };

  // 音乐播放器状态
  let musicState = {
    isActive: false,
    activeChatId: null,
    isPlaying: false,
    playlist: [],
    currentIndex: -1,
    playMode: 'order',
    totalElapsedTime: 0,
    timerId: null,
    parsedLyrics: [],
    currentLyricIndex: -1,
    // 歌单系统
    playlists: [{ id: 'default', name: '默认', createdAt: Date.now() }],
    activePlaylistId: 'default'
  };

  // 音频播放器元素
  const audioPlayer = document.getElementById('audio-player');

  // 【新增】暴露 state 到 window，供联机功能访问
  window.state = state;
  window.billState = billState;
  window.musicState = musicState;
  window.audioPlayer = audioPlayer;

  async function loadAllDataFromDB() {
    if (window.messageStore?.wrapChatsTablePut) {
      window.messageStore.wrapChatsTablePut();
    }

    const [
      chatsArr, apiConfig, loadedGlobalSettings, userStickers, worldBooks,
      musicLib, personaPresets, qzoneSettings, initialFavorites,
      allMemories,

      allPresets,
      allQuickReplies
    ] = await Promise.all([
      db.chats.toArray(), db.apiConfig.get('main'), db.globalSettings.get('main'),
      db.userStickers.toArray(), db.worldBooks.toArray(), db.musicLibrary.get('main'),
      db.personaPresets.toArray(), db.qzoneSettings.get('main'), db.favorites.orderBy('timestamp').reverse().toArray(),
      db.memories.toArray(),

      db.presets.toArray(),
      db.quickReplies.toArray()
    ]);


    state.presets = allPresets || [];
    state.quickReplies = allQuickReplies || [];
    await initUserWallet();
    const defaultGlobalSettings = {
      id: 'main',
      showStatusBar: false,
      wallpaper: 'radial-gradient(circle at 20% 12%, rgba(107, 125, 255, .38), transparent 32%), radial-gradient(circle at 84% 28%, rgba(0, 229, 255, .22), transparent 30%), radial-gradient(circle at 50% 100%, rgba(174, 92, 255, .26), transparent 38%), linear-gradient(160deg, #10131f 0%, #171b2e 48%, #0d1020 100%)',  // 默认深色玻璃（深蓝 + 蓝紫光晕），与 extra.css #home-screen 兜底一致
      fontUrl: '',
      fontLocalData: '',
      fontScope: { all: true, homeScreen: true, qq: true, cphone: true, myphone: true, worldBook: true, hotNews: true, alipay: true, settings: true },
      globalFontSize: 16,
      enableThoughts: false,              // 新增：全局心声开关，默认关闭
      customThoughtsPromptEnabled: false,  // 自定义心声提示词开关，默认关闭
      customThoughtsPrompt: '',            // 自定义心声提示词内容，空字符串表示使用默认
      customThoughtsUIEnabled: false,      // 自定义心声外观开关，默认关闭
      customThoughtsHTML: '',              // 自定义心声 HTML
      customThoughtsCSS: '',               // 自定义心声 CSS
      customSummaryPromptEnabled: false,   // 自定义结构化总结提示词开关，默认关闭
      customSummaryPrompt: '',             // 自定义结构化总结提示词内容，空字符串表示使用默认
      customChatPromptEnabled: false,      // 自定义聊天提示词开关，默认关闭
      customChatPromptSingle: '',          // 自定义单聊提示词内容
      customChatPromptGroup: '',           // 自定义群聊提示词内容
      customChatPromptOffline: '',         // 自定义线下模式提示词内容
      enableQzoneActions: false,          // 新增：全局动态开关，默认关闭
      enableViewMyPhone: false,           // 新增：全局查看User手机开关，默认关闭
      enableCrossChat: true,              // 新增：全局跨聊天消息开关（群聊↔私聊），默认开启
      enableBackgroundActivity: false,
      backgroundActivityInterval: 60,
      // 【2026-07-18 加 / 2026-08-08 v0.2.08 改】主动消息独立模块的全局配置
      // 巡视频率（分钟）：默认 10 — v0.2.08 设计: 老 30 分钟"主动消息频率"改成"巡视间隔"
      //   每 10 分钟巡视一次, 问 LLM "要不要主动发" — LLM 自己决定
      //   最坏情况"刷屏"也只能 10 分钟一次 (工程上限)
      //   AI 是不是要发完全由人设决定 (锲而不舍但不过度刷屏)
      proactiveIntervalMinutes: 10,
      // 【2026-08-05 加 v0.1.90 / 2026-08-06 改 v0.1.91】主动消息投递方式
      // v0.1.91 设计: 角色级总开关 (chat.settings.proactiveEnabled) = "能不能发" + 全局 mode = "用什么发"
      // 'app' = 走应用内 (老 30 分钟 scheduler, PWA 开着能用, 杀后台失效)
      // 'push' = 走系统推送 (新通道, 杀后台 + 锁屏能用, 需填服务器地址)
      // 两个维度独立: 角色级关 = 两个渠道都不发; 角色级开 + 选 push = 走推送
      proactiveDeliveryMode: 'app',
      enableViewMyPhoneInBackground: false,  // 新增：后台查看用户手机开关，默认关闭
      viewMyPhoneChance: null,               // 新增：后台查看用户手机概率，null=AI自主决定，0-100=按概率触发
      blockCooldownHours: 1,
      apiTemperature: 0.8,
      enableStreaming: false,
      appIcons: {
        ...DEFAULT_APP_ICONS
      },
      cphoneWallpaper: 'linear-gradient(135deg, #f6d365, #fda085)',
      cphoneAppIcons: {
        ...DEFAULT_CPHONE_ICONS
      },
      myphoneWallpaper: 'linear-gradient(135deg, #a8edea, #fed6e3)',
      myphoneAppIcons: {
        ...DEFAULT_MYPHONE_ICONS
      },
      globalCss: '',
      notificationSoundUrl: '',
      notificationVolume: 1.0, // 消息提示音音量 (0.0-1.0)
      soundPresets: [], // 消息提示音预设列表
      widgetData: {},
      globalChatBackground: '',
      enableAiDrawing: true,
      showPhoneFrame: false,
      lockScreenEnabled: false,
      lockScreenPassword: '',
      lockScreenWallpaper: '',
      alwaysShowMusicIsland: false,
      detachStatusBar: false,
      enableMinimalChatUI: false,
      chatActionButtonsOrder: null,
      shoppingCategoryCount: 3,
      shoppingProductCount: 8,
      chatRenderWindow: 50,
      safeRenderMode: false,
      dropdownPopupMode: false,
      // 热点日报（2026-07-02 新增，替换原豆瓣功能）：默认关闭，开启后角色才能感知真实社会新闻
      hotNewsEnabled: false,
      hotNewsPlatforms: ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'],  // hot_news 可选平台，留空用默认
      hotNewsLastFetchedAt: 0,  // 上次手动刷新时间戳（仅用于 UI 显示）
      systemNotification: {
        enabled: false,
        appName: 'EPhone',
        notifyInChatPage: false,  // 在聊天页面也发送通知
        disableInternalNotification: false,  // 禁用内部弹窗
        pushServer: {
          enabled: false,
          serverUrl: '',
          apiKey: ''
        },
        vibration: {
          enabled: false,
          pattern: 'short'
        },
        sound: {
          enabled: false,
          useGlobalSound: true,
          customSoundUrl: ''
        },
        lastNotificationHealthCheckAt: '',
        lastNotificationTestAt: '',
        lastNotificationTestResult: '',
        lastNotificationTestError: '',
        lastPushSubscriptionCheckedAt: '',
        notificationHealthStatus: 'unknown'
      },
      // v0.2.18+: 新巡视睡眠时间设置 (UI 在 proactive-wake-ui.js 里, 改完即生效)
      inAppProactiveSleepEnabled: true,    // 默认启用睡眠跳过
      inAppProactiveSleepStartHour: 23,    // 23:00 开始睡眠
      inAppProactiveSleepEndHour: 8,       // 08:00 结束睡眠
      live2dEnabled: true,                  // v0.2.0 重新启用 Live2D (PIXI v8 + untitled engine + Cubism 5)
    };
    state.globalSettings = {
      ...defaultGlobalSettings,
      ...(loadedGlobalSettings || {})
    };

    // 确保 systemNotification 配置完整
    if (!state.globalSettings.systemNotification) {
      state.globalSettings.systemNotification = defaultGlobalSettings.systemNotification;
    } else {
      state.globalSettings.systemNotification = {
        ...defaultGlobalSettings.systemNotification,
        ...state.globalSettings.systemNotification,
        pushServer: {
          ...defaultGlobalSettings.systemNotification.pushServer,
          ...(state.globalSettings.systemNotification.pushServer || {})
        },
        vibration: {
          ...defaultGlobalSettings.systemNotification.vibration,
          ...(state.globalSettings.systemNotification.vibration || {})
        },
        sound: {
          ...defaultGlobalSettings.systemNotification.sound,
          ...(state.globalSettings.systemNotification.sound || {})
        }
      };
    }

    state.globalSettings.appIcons = {
      ...defaultGlobalSettings.appIcons,
      ...(state.globalSettings.appIcons || {})
    };
    state.globalSettings.cphoneAppIcons = {
      ...defaultGlobalSettings.cphoneAppIcons,
      ...(state.globalSettings.cphoneAppIcons || {})
    };
    state.globalSettings.myphoneAppIcons = {
      ...defaultGlobalSettings.myphoneAppIcons,
      ...(state.globalSettings.myphoneAppIcons || {})
    };

    // 清洗老用户 db：清空已知失效的默认 URL（i.postimg.cc / i.imgur.com / s3plus.meituan.net）
    // 这些 URL 是之前 init 写入的，全部失效，强制清空避免蓝粑粑
    // 用户自己传的非失效 URL 不受影响
    const KNOWN_DEAD_PATTERNS = ['i.postimg.cc', 'i.imgur.com', 's3plus.meituan.net'];
    const cleanDeadUrls = (iconsObj) => {
      if (!iconsObj) return;
      for (const key in iconsObj) {
        const url = iconsObj[key] || '';
        if (KNOWN_DEAD_PATTERNS.some(p => url.includes(p))) {
          iconsObj[key] = '';
        }
      }
    };
    cleanDeadUrls(state.globalSettings.appIcons);
    cleanDeadUrls(state.globalSettings.cphoneAppIcons);
    cleanDeadUrls(state.globalSettings.myphoneAppIcons);
    // 壁纸 / 头像 同样清洗
    if (state.globalSettings.wallpaper && KNOWN_DEAD_PATTERNS.some(p => state.globalSettings.wallpaper.includes(p))) {
      state.globalSettings.wallpaper = '';
    }
    // 旧默认值浅蓝玻璃（项目早期默认）已被深色玻璃替代，替换成新默认值
    if (state.globalSettings.wallpaper === 'linear-gradient(135deg, #89f7fe, #66a6ff)') {
      state.globalSettings.wallpaper = defaultGlobalSettings.wallpaper;
    }

    chatsArr.forEach(chat => {
      if (typeof chat.settings.enableTimePerception === 'undefined') {
        chat.settings.enableTimePerception = true;
      }
      if (!chat.settings.lyricsPosition) {
        chat.settings.lyricsPosition = {
          vertical: 'top',
          horizontal: 'center',
          offset: 10
        };
      }
      if (!chat.isGroup && !chat.settings.myAvatarLibrary) {
        chat.settings.myAvatarLibrary = [];
      }
      if (!chat.isGroup && typeof chat.originalName === 'undefined') {
        chat.originalName = chat.name;
      }
    });
    state.chats = chatsArr.reduce((acc, chat) => {
      if (typeof chat.unreadCount === 'undefined') chat.unreadCount = 0;
      if (chat.isGroup) {
        if (typeof chat.settings.enableBackgroundActivity === 'undefined') {
          chat.settings.enableBackgroundActivity = true;
        }
        if (chat.members && chat.members.length > 0 && chat.members[0].name) {
          chat.members.forEach(member => {
            if (typeof member.originalName === 'undefined') {
              member.originalName = member.name;
              member.groupNickname = member.name;
              delete member.name;
            }
          });
        }
      }
      if (!chat.settings) chat.settings = {};
      if (typeof chat.settings.actionCooldownMinutes === 'undefined') {
        chat.settings.actionCooldownMinutes = 10;
      }
      if (!chat.isGroup && !chat.status) chat.status = {
        text: '在线',
        lastUpdate: Date.now(),
        isBusy: false
      };
      // 初始化USER状态
      if (!chat.settings.userStatus) chat.settings.userStatus = {
        text: '在线',
        lastUpdate: Date.now(),
        isBusy: false
      };
      if (!chat.isGroup && !chat.relationship) chat.relationship = {
        status: 'friend',
        blockedTimestamp: null,
        applicationReason: ''
      };
      if (!chat.isGroup && (!chat.settings || !chat.settings.aiAvatarLibrary)) {
        if (!chat.settings) chat.settings = {};
        chat.settings.aiAvatarLibrary = [];
      }
      if (chat.isGroup) {
        (chat.members || []).forEach(member => {
          if (typeof member.avatarFrame === 'undefined') member.avatarFrame = '';
        });
      }
      if (!chat.musicData) chat.musicData = {
        totalTime: 0
      };
      if (chat.settings && chat.settings.linkedWorldBookId && !chat.settings.linkedWorldBookIds) {
        chat.settings.linkedWorldBookIds = [chat.settings.linkedWorldBookId];
        delete chat.settings.linkedWorldBookId;
      }
      if (typeof chat.isPinned === 'undefined') chat.isPinned = false;
      if (!chat.isGroup && typeof chat.settings.myNickname === 'undefined') {
        chat.settings.myNickname = '我';
      }
      if (chat.isGroup && chat.members) {
        let needsUpdate = false;
        chatsArr.forEach(c => {
          if (c.id === chat.id && c.originalName) {
            delete c.originalName;
          }
        });
        chat.members.forEach(member => {
          const originalCharacter = chatsArr.find(c => c.id === member.id);
          if (originalCharacter && originalCharacter.settings) {
            const correctAvatar = originalCharacter.settings.aiAvatar;
            if (correctAvatar && member.avatar !== correctAvatar) {
              member.avatar = correctAvatar;
              needsUpdate = true;
            }
            const correctFrame = originalCharacter.settings.aiAvatarFrame || '';
            if (member.avatarFrame !== correctFrame) {
              member.avatarFrame = correctFrame;
              needsUpdate = true;
            }
          } else if (typeof member.avatarFrame === 'undefined') {
            member.avatarFrame = '';
            needsUpdate = true;
          }
        });
        if (needsUpdate) db.chats.put(chat);
      }
      if (!chat.settings.enableAutoMemory) chat.settings.enableAutoMemory = false;
      if (!chat.settings.autoMemoryInterval) chat.settings.autoMemoryInterval = 20;
      if (typeof chat.settings.enableDiaryMode === 'undefined') chat.settings.enableDiaryMode = false;
      if (typeof chat.settings.memoryMode === 'undefined') {
        // 兼容旧数据：根据已有开关推断模式
        if (chat.settings.enableStructuredMemory) chat.settings.memoryMode = 'structured';
        else chat.settings.memoryMode = 'diary';
      }
      if (!chat.longTermMemory) chat.longTermMemory = [];
      if (!chat.lastMemorySummaryTimestamp) chat.lastMemorySummaryTimestamp = 0;
      if (!chat.isGroup) {
        if (typeof chat.settings.enableBackgroundActivity === 'undefined') {
          chat.settings.enableBackgroundActivity = true;
        }
        if (typeof chat.settings.enableTts === 'undefined') {
          chat.settings.enableTts = false;
        }
        if (typeof chat.settings.enableAutoCartClear === 'undefined') {
          chat.settings.enableAutoCartClear = false;
        }
        // 【2026-07-18 加】角色级主动消息开关，默认 false（需用户手动开）
        if (typeof chat.settings.proactiveEnabled === 'undefined') {
          chat.settings.proactiveEnabled = false;
        }
        if (!chat.status) chat.status = {
          text: '在线',
          lastUpdate: Date.now(),
          isBusy: false
        };
        // 初始化USER状态
        if (!chat.settings.userStatus) chat.settings.userStatus = {
          text: '在线',
          lastUpdate: Date.now(),
          isBusy: false
        };
        if (!chat.relationship) chat.relationship = {
          status: 'friend',
          blockedTimestamp: null,
          applicationReason: ''
        };
        if (!chat.settings || !chat.settings.aiAvatarLibrary) {
          if (!chat.settings) chat.settings = {};
          chat.settings.aiAvatarLibrary = [];
        }
        if (typeof chat.settings.isOfflineMode === 'undefined') chat.settings.isOfflineMode = false;
        if (typeof chat.settings.offlineMinLength === 'undefined') chat.settings.offlineMinLength = 100;
        if (typeof chat.settings.offlineMaxLength === 'undefined') chat.settings.offlineMaxLength = 300;
        if (typeof chat.settings.offlineContinuousLayout === 'undefined') chat.settings.offlineContinuousLayout = false;

        if (typeof chat.settings.injectLatestThought === 'undefined') {
          chat.settings.injectLatestThought = false;
        }

        // 新增：初始化心声和动态功能开关
        if (typeof chat.settings.enableThoughts === 'undefined') {
          chat.settings.enableThoughts = null; // null表示使用全局设置
        }
        if (typeof chat.settings.enableQzoneActions === 'undefined') {
          chat.settings.enableQzoneActions = null; // null表示使用全局设置
        }
        if (typeof chat.settings.enableViewMyPhone === 'undefined') {
          chat.settings.enableViewMyPhone = null; // null表示使用全局设置
        }
        if (typeof chat.settings.enableCrossChat === 'undefined') {
          chat.settings.enableCrossChat = null; // null表示使用全局设置
        }
        
        // 新增：初始化后台查看用户手机设置
        if (typeof chat.settings.enableViewMyPhoneInBackground === 'undefined') {
          chat.settings.enableViewMyPhoneInBackground = null; // null表示使用全局设置
        }
        if (typeof chat.settings.viewMyPhoneChance === 'undefined') {
          chat.settings.viewMyPhoneChance = null; // null表示使用全局设置
        }

        if (typeof chat.heartfeltVoice === 'undefined') chat.heartfeltVoice = '...';
        if (typeof chat.randomJottings === 'undefined') chat.randomJottings = '...';
        if (typeof chat.customThoughts === 'undefined') chat.customThoughts = {};
        if (!Array.isArray(chat.thoughtsHistory)) {
          chat.thoughtsHistory = [];
        }
      }
      if (typeof chat.settings.stickerCategoryIds === 'undefined') {

        if (chat.settings.stickerCategoryId) {

          chat.settings.stickerCategoryIds = [chat.settings.stickerCategoryId];
        } else {

          chat.settings.stickerCategoryIds = [];
        }

        delete chat.settings.stickerCategoryId;
      }
      acc[chat.id] = chat;
      return acc;
    }, {});

    if (window.messageStore?.prepareLoadedChats) {
      window.messageStore.prepareLoadedChats(state.chats);
    }
    if (window.messageStore?.migrateResidualHistories) {
      await window.messageStore.migrateResidualHistories();
    }

    const memoriesToUpdate = [];
    allMemories.forEach(memory => {
      if (memory.type === 'ai_generated' && memory.authorName && !memory.authorId) {
        const foundChat = chatsArr.find(c => !c.isGroup && c.originalName === memory.authorName);
        if (foundChat) {
          memory.authorId = foundChat.id;
          memoriesToUpdate.push(memory);
        } else {
          const fallbackChat = chatsArr.find(c => !c.isGroup && c.name === memory.authorName);
          if (fallbackChat) {
            memory.authorId = fallbackChat.id;
            memoriesToUpdate.push(memory);
          }
        }
      }
    });
    if (memoriesToUpdate.length > 0) {
      await db.memories.bulkPut(memoriesToUpdate);
    }
    const defaultApiConfig = {
      id: 'main',
      proxyUrl: '',
      apiKey: '',
      model: '',
      secondaryProxyUrl: '',
      secondaryApiKey: '',
      secondaryModel: '',
      backgroundProxyUrl: '',
      backgroundApiKey: '',
      backgroundModel: '',
      visionProxyUrl: '',
      visionApiKey: '',
      visionModel: '',
      visionPrompt: '',
      couplespaceProxyUrl: '',
      couplespaceApiKey: '',
      couplespaceModel: '',
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrApiKey: '',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
      asrLanguage: 'zh',
      mainEndpointPresetId: null,
      secondaryEndpointPresetId: null,
      backgroundEndpointPresetId: null,
      visionEndpointPresetId: null,
      couplespaceEndpointPresetId: null,
      tts: window.TTSService ? window.TTSService.getDefaultTtsConfig() : {
        ttsEnabled: false,
        currentProvider: 'minimax',
        providers: {
          minimax: {
            provider: 'minimax',
            apiKey: '',
            model: 'speech-01-hd',
            voice: '',
            groupId: '',
            endpoint: 'https://api.minimax.chat/v1/t2a_v2'
          },
          fishAudio: {
            provider: 'fishAudio',
            apiKey: '',
            model: 's2-pro',
            voice: '',
            endpoint: 'https://api.fish.audio/v1/tts'
          },
          openaiCompatible: {
            provider: 'openaiCompatible',
            apiKey: '',
            model: '',
            voice: '',
            endpoint: ''
          }
        }
      },
      imgbbEnable: false,
      imgbbApiKey: '',

      catboxEnable: false,
      catboxUserHash: '',
      githubEnable: false, // 默认为关闭
      githubAutoBackup: false,
      githubUsername: '',
      githubRepo: '',
      githubToken: '',
      githubFilename: 'ephone_backup.json'
    };
    
    // 合并默认配置和数据库配置，确保新增字段不会丢失
    state.apiConfig = {
      ...defaultApiConfig,
      ...(apiConfig || {})
    };
    if (localStorage.getItem('imgbb-enabled') !== null) {
      state.apiConfig.imgbbEnable = localStorage.getItem('imgbb-enabled') === 'true';
    }
    if (localStorage.getItem('imgbb-api-key') !== null) {
      state.apiConfig.imgbbApiKey = localStorage.getItem('imgbb-api-key');
    }
    if (localStorage.getItem('catbox-enabled') !== null) {
      state.apiConfig.catboxEnable = localStorage.getItem('catbox-enabled') === 'true';
    }
    if (localStorage.getItem('catbox-userhash') !== null) {
      state.apiConfig.catboxUserHash = localStorage.getItem('catbox-userhash');
    }
    if (window.TTSService) {
      window.TTSService.normalizeTtsConfig(state.apiConfig);
    }
    if (localStorage.getItem('github-proxy-enabled') !== null) {
      state.apiConfig.githubProxyEnable = localStorage.getItem('github-proxy-enabled') === 'true';
    }
    if (localStorage.getItem('github-proxy-url') !== null) {
      state.apiConfig.githubProxyUrl = localStorage.getItem('github-proxy-url');
    }
    state.userStickers = userStickers || [];
    state.worldBooks = worldBooks || [];
    musicState.playlist = musicLib?.playlist || [];
    musicState.playlists = musicLib?.playlists || [{ id: 'default', name: '默认', createdAt: Date.now() }];
    musicState.activePlaylistId = musicLib?.activePlaylistId || 'default';
    // 给没有playlistId的旧歌曲补上默认值
    musicState.playlist.forEach(t => { if (!t.playlistId) t.playlistId = 'default'; });
    state.personaPresets = personaPresets || [];
    state.qzoneSettings = qzoneSettings || {
      id: 'main',
      nickname: '{{user}}',
      avatar: 'https://files.catbox.moe/q6z5fc.jpeg',
      banner: 'https://files.catbox.moe/r5heyt.gif'
    };
    allFavoriteItems = initialFavorites || [];

    if (typeof window.applyApiEndpointMigrationAndDenorm === 'function') {
      try {
        await window.applyApiEndpointMigrationAndDenorm();
      } catch (e) {
        console.error('[API站点预设] 迁移/解析失败:', e);
      }
    }
    
    // 【API配置兼容层】应用启动时同步所有五个 API slot 配置到 state.apiConfig
    //   统一走 syncApiSlotConfigIntoState() —— 换预设 / 改预设之后也要调它,
    //   别再各处各写一份 (以前只有启动和"保存设置"两处, 悬浮球切预设后就不同步了)。
    if (typeof syncApiSlotConfigIntoState === 'function') {
      await syncApiSlotConfigIntoState();
      await db.globalSettings.put(state.globalSettings);
    }
  }

  // 暴露 loadAllDataFromDB 到 window，供其他模块调用
  window.loadAllDataFromDB = loadAllDataFromDB;


  async function saveGlobalPlaylist() {
    await db.musicLibrary.put({
      id: 'main',
      playlist: musicState.playlist,
      playlists: musicState.playlists,
      activePlaylistId: musicState.activePlaylistId
    });
  }



  async function init() {

    // ==================== Event Bindings A (from init-event-bindingsA.js) ====================
    await window.initEventBindingsA(state, db);


    // ==================== Event Bindings B (from init-event-bindingsB.js) ====================
    window.initEventBindingsB(state, db);

    // ==================== Features (from init-features.js) ====================
    window.initFeatures(state, db);

    initLockScreen();
    checkForUpdates();
    updateLockedFeatureUI();
    initSystemNotification();
    // 启动后台保活 UI 绑定 + 配置加载（不含 catbox 默认 URL 加载，2026-06-30）
    if (typeof window.loadBackgroundKeepAliveSettings === 'function') {
      try {
        await window.loadBackgroundKeepAliveSettings();
      } catch (e) { console.warn('后台保活初始化失败:', e); }
    }
    if (typeof startAIReminderScheduler === 'function') {
      startAIReminderScheduler();
    }
    loadShoppingCart(); // 加载购物车数据
    
    // 初始化悬浮球
    if (typeof initFloatingBall === 'function') {
      initFloatingBall();
    }
    
    showScreen('home-screen');
  }

  init();

});

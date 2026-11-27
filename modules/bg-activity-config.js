// ============================================================
// bg-activity-config.js — AI 后台活动统一配置层 (2026-11-27 新增)
//
// 【为什么有这个文件】
//   改造前, 后台活动的开关散在 4 个存储里:
//     · 全局 state.globalSettings
//         enableBackgroundActivity / backgroundActivityInterval / blockCooldownHours
//         enableQzoneActions / enableViewMyPhone / enableViewMyPhoneInBackground
//         viewMyPhoneChance
//     · 角色级 chat.settings
//         enableBackgroundActivity / actionCooldownMinutes / enableAutoCartClear
//         enableQzoneActions / enableViewMyPhone / enableViewMyPhoneInBackground
//         viewMyPhoneChance
//     · NPC 级 db.npcs.enableBackgroundActivity
//     · 情侣空间 localStorage: 13 个功能 × 4 个开关 = 52 个
//   → 光「一个角色」的影响面就散在 3 处、约 67 个开关, 用户根本找不到在哪设。
//
//   改造后: 全部收敛到 chat.settings.bgActivity 一个对象 —— 一个角色一屏看完。
//
// 【兼容原则】
//   旧字段【不删】。getBgActivityConfig() 第一次读到时按旧字段迁移一份到新结构,
//   之后一律读写新结构。老用户已有的开关状态全部保留, 不会丢。
// ============================================================
(function () {
  'use strict';

  // ------------------------------------------------------------
  // 活动项定义 (角色级)
  // key → { label, desc }
  // ------------------------------------------------------------
  const BG_ACTS = {
    msg:           { label: '主动发消息',   desc: '后台主动给你发消息、发表情、更新在线状态' },
    call:          { label: '主动打电话',   desc: '后台给你打视频或语音' },
    avatar:        { label: '主动换头像',   desc: '后台偷偷换掉自己的头像' },
    sing:          { label: '主动唱歌',     desc: '后台给你唱一首歌' },
    buy:           { label: '亲属卡购物',   desc: '用你的亲属卡额度买东西' },
    clearCart:     { label: '帮我清购物车', desc: '用自己的余额帮你清空购物车' },
    peek:          { label: '偷看我的手机', desc: '后台偷看你的手机 APP (QQ/相册/淘宝/高德…)' },
    qzonePost:     { label: '发自己的动态', desc: '发说说、发文字图、转发别人的动态' },
    qzoneInteract: { label: '互动别人的动态', desc: '评论、回复、点赞别人的动态' },
    qzoneDelete:   { label: '删自己的旧动态', desc: '觉得某条动态过时了, 自己删掉' }
  };

  // ------------------------------------------------------------
  // 情侣空间功能项 (角色级)
  // settingsKey = 旧的 localStorage 键前缀 (迁移用)
  // lastKey     = 旧的「当天已执行」标记前缀 (迁移用)
  // ------------------------------------------------------------
  const COUPLE_FEATURES = [
    { key: 'diary',     label: '日记',   settingsKey: 'coupleDiarySettings_',     lastKey: 'coupleDiaryAutoLast_' },
    { key: 'album',     label: '相册',   settingsKey: 'coupleAlbumSettings_',     lastKey: 'coupleAlbumAutoLast_' },
    { key: 'checklist', label: '清单',   settingsKey: 'coupleChecklistSettings_', lastKey: 'coupleChecklistAutoLast_' },
    { key: 'message',   label: '留言板', settingsKey: 'coupleMessageSettings_',   lastKey: 'coupleMessageAutoLast_' },
    { key: 'mood',      label: '心情',   settingsKey: 'coupleMoodSettings_',      lastKey: 'coupleMoodAutoLast_' },
    { key: 'timeline',  label: '时光轴', settingsKey: 'coupleTimelineSettings_',  lastKey: 'coupleTimelineAutoLast_' },
    { key: 'letter',    label: '信件',   settingsKey: 'coupleLetterSettings_',    lastKey: 'coupleLetterAutoLast_' },
    { key: 'garden',    label: '浇水',   settingsKey: 'coupleGardenSettings_',    lastKey: 'coupleGardenAutoLast_' },
    { key: 'location',  label: '定位',   settingsKey: 'coupleLocSettings_',       lastKey: 'coupleLocAutoLast_' },
    { key: 'finance',   label: '记账',   settingsKey: 'coupleFinanceSettings_',   lastKey: 'coupleFinanceAutoLast_' },
    { key: 'sleep',     label: '睡眠',   settingsKey: 'coupleSleepSettings_',     lastKey: null }
  ];

  const COUPLE_MODES = [
    { value: 'off',       label: '关闭' },
    { value: 'scheduled', label: '定时' },
    { value: 'ai',        label: 'AI自主' },
    { value: 'both',      label: '都要' }
  ];

  // ------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------
  function globalSettings() {
    return (window.state && window.state.globalSettings) || {};
  }

  /** 角色级优先 (null / undefined = 跟随全局), 跟旧代码语义一致 */
  function pickCharOrGlobal(charVal, globalVal) {
    return (charVal !== null && charVal !== undefined) ? charVal : globalVal;
  }

  /** 取多数值 (迁移情侣空间的时间/概率时用, 各功能可能配的不一样) */
  function mode(values, fallback) {
    const list = (values || []).filter(v => v !== null && v !== undefined && v !== '');
    if (!list.length) return fallback;
    const count = {};
    list.forEach(v => { count[v] = (count[v] || 0) + 1; });
    let best = list[0], bestN = 0;
    Object.keys(count).forEach(k => {
      const n = count[k];
      if (n > bestN) { best = k; bestN = n; }
    });
    return best;
  }

  function safeParse(raw) {
    try { return JSON.parse(raw || '{}') || {}; } catch (e) { return {}; }
  }

  // ------------------------------------------------------------
  // 默认结构
  // ------------------------------------------------------------
  function defaultActs() {
    const acts = {};
    Object.keys(BG_ACTS).forEach(k => { acts[k] = false; });
    return acts;
  }

  function defaultCouple() {
    const feats = {};
    COUPLE_FEATURES.forEach(f => { feats[f.key] = false; });
    return {
      enabled: false,
      mode: 'off',
      time: '21:00',
      prob: 5,
      chatProb: 15,
      feats: feats
    };
  }

  function defaultBgActivity() {
    return {
      enabled: false,
      cooldownMinutes: 15,
      blockCooldownHours: 1,
      acts: defaultActs(),
      peekChance: null,
      couple: defaultCouple()
    };
  }

  // ------------------------------------------------------------
  // 迁移: 旧字段 → 新结构
  // ------------------------------------------------------------
  function migrateLegacyBgActivity(chat) {
    const s = chat.settings || (chat.settings = {});
    const g = globalSettings();

    const qzone = pickCharOrGlobal(s.enableQzoneActions, g.enableQzoneActions) === true;
    const peek = pickCharOrGlobal(s.enableViewMyPhone, g.enableViewMyPhone) === true;
    const rawChance = pickCharOrGlobal(s.viewMyPhoneChance, g.viewMyPhoneChance);
    const peekChance = (typeof rawChance === 'number' && rawChance >= 0) ? rawChance : null;

    const acts = defaultActs();
    // 旧 prompt 里这几项是【无条件】可用的 → 迁移时保持现状 (true)
    acts.msg = true;
    acts.call = true;
    acts.avatar = true;
    acts.sing = true;
    acts.buy = true;
    acts.clearCart = !!s.enableAutoCartClear;
    acts.peek = peek;
    acts.qzonePost = qzone;
    acts.qzoneInteract = qzone;
    // 旧代码里「删自己的动态」写在 qzone 开关模板【外面】= 越权常开。
    // 迁移后它变成一个正常开关, 默认关 (修掉越权, 用户可自己开)。
    acts.qzoneDelete = false;

    return {
      // ★ 必须按【旧的实际生效状态】迁移, 不能只看角色级字段。
      //   旧代码里 tick 第一句就是 `if (!globalSettings.enableBackgroundActivity) return;`
      //   —— 全局总闸关着时, 角色级 enableBackgroundActivity 就算是 true 也【从来没有跑过】。
      //   (单聊在 init-and-state.js:401 默认就被写成 true, 而全局默认是 false)
      //   所以只看角色级 → 所有老用户升级后会突然被打开后台活动。
      //   这里取两者相与: 全局开过 且 角色没关 → 才算开。
      enabled: g.enableBackgroundActivity !== false && s.enableBackgroundActivity !== false,
      cooldownMinutes: s.actionCooldownMinutes || 15,
      // 拉黑冷静期: 2026-11-27 从全局 state.globalSettings.blockCooldownHours 下沉到角色
      blockCooldownHours: (typeof s.blockCooldownHours === 'number' && s.blockCooldownHours > 0)
        ? s.blockCooldownHours
        : ((typeof g.blockCooldownHours === 'number' && g.blockCooldownHours > 0) ? g.blockCooldownHours : 1),
      acts: acts,
      peekChance: peekChance,
      couple: migrateLegacyCouple(chat)
    };
  }

  /**
   * 迁移情侣空间: 旧 localStorage 里每个功能一份 settings, 里面 4 个开关
   *   autoEnabled / autoTime / aiDecide / aiDecideChatProb / aiDecideBgProb
   * → 新结构: 一个 mode + 一个 time + 一个 prob + 每功能一个 bool
   */
  function migrateLegacyCouple(chat) {
    const charId = chat.id;
    const couple = defaultCouple();
    if (!charId) return couple;

    const times = [];
    const chatProbs = [];
    const bgProbs = [];
    let anyScheduled = false;
    let anyAi = false;

    COUPLE_FEATURES.forEach(f => {
      const old = safeParse(localStorage.getItem(f.settingsKey + charId));
      const featOn = false;

      if (old.autoEnabled) {
        anyScheduled = true;
        couple.feats[f.key] = true;
        if (old.autoTime) times.push(old.autoTime);
      }
      if (old.aiDecide) {
        anyAi = true;
        couple.feats[f.key] = true;
        if (old.aiDecideChatProb !== undefined) chatProbs.push(old.aiDecideChatProb);
        if (old.aiDecideBgProb !== undefined) bgProbs.push(old.aiDecideBgProb);
      }
      void featOn;
    });

    couple.enabled = anyScheduled || anyAi;
    if (anyScheduled && anyAi) couple.mode = 'both';
    else if (anyAi) couple.mode = 'ai';
    else if (anyScheduled) couple.mode = 'scheduled';

    couple.time = mode(times, couple.time);
    // 后台概率才是后台活动用的, 聊天概率跟后台无关 → 两个各取众数
    couple.prob = mode(bgProbs, couple.prob);
    couple.chatProb = mode(chatProbs, couple.chatProb);

    return couple;
  }

  // ------------------------------------------------------------
  // 读写
  // ------------------------------------------------------------
  /** 取该角色的后台活动配置 (没有就按旧字段迁移一次并写回) */
  function getBgActivityConfig(chat) {
    if (!chat) return defaultBgActivity();
    const s = chat.settings || (chat.settings = {});
    let cfg = s.bgActivity;
    if (!cfg || typeof cfg !== 'object') {
      cfg = migrateLegacyBgActivity(chat);
      s.bgActivity = cfg;
    }
    // 结构补全 (老版本存过的不完整结构也能补上)
    if (!cfg.acts || typeof cfg.acts !== 'object') cfg.acts = defaultActs();
    else {
      Object.keys(BG_ACTS).forEach(k => {
        if (typeof cfg.acts[k] !== 'boolean') cfg.acts[k] = false;
      });
    }
    if (typeof cfg.enabled !== 'boolean') cfg.enabled = false;
    if (typeof cfg.cooldownMinutes !== 'number' || cfg.cooldownMinutes <= 0) cfg.cooldownMinutes = 15;
    if (typeof cfg.blockCooldownHours !== 'number' || cfg.blockCooldownHours <= 0) cfg.blockCooldownHours = 1;
    if (cfg.peekChance !== null && (typeof cfg.peekChance !== 'number' || cfg.peekChance < 0)) cfg.peekChance = null;
    if (!cfg.couple || typeof cfg.couple !== 'object') cfg.couple = defaultCouple();
    else {
      if (typeof cfg.couple.enabled !== 'boolean') cfg.couple.enabled = false;
      if (!COUPLE_MODES.some(m => m.value === cfg.couple.mode)) cfg.couple.mode = 'off';
      if (!cfg.couple.time) cfg.couple.time = '21:00';
      if (typeof cfg.couple.prob !== 'number' || cfg.couple.prob < 0) cfg.couple.prob = 5;
      if (typeof cfg.couple.chatProb !== 'number' || cfg.couple.chatProb < 0) cfg.couple.chatProb = 15;
      if (!cfg.couple.feats || typeof cfg.couple.feats !== 'object') cfg.couple.feats = defaultCouple().feats;
      else {
        COUPLE_FEATURES.forEach(f => {
          if (typeof cfg.couple.feats[f.key] !== 'boolean') cfg.couple.feats[f.key] = false;
        });
      }
    }
    return cfg;
  }

  /** 只读, 不触发迁移 (给不想写回的场景用) */
  function peekBgActivityConfig(chat) {
    if (chat && chat.settings && chat.settings.bgActivity && typeof chat.settings.bgActivity === 'object') {
      return chat.settings.bgActivity;
    }
    return migrateLegacyBgActivity(chat || { settings: {} });
  }

  /** 某活动项是否开启 */
  function isActEnabled(chat, actKey) {
    const cfg = getBgActivityConfig(chat);
    return !!(cfg.enabled && cfg.acts && cfg.acts[actKey]);
  }

  /** 情侣空间某功能是否开启 (还要看总闸和模式) */
  function isCoupleFeatureEnabled(chat, featureKey) {
    const cfg = getBgActivityConfig(chat);
    const c = cfg.couple;
    if (!cfg.enabled || !c.enabled) return false;
    if (c.mode === 'off') return false;
    return !!c.feats[featureKey];
  }

  /** 存回 chat.settings (改完调用) */
  function saveBgActivityConfig(chat) {
    if (!chat || !chat.settings) return;
    // getBgActivityConfig 已经保证结构完整并写回 s.bgActivity
    getBgActivityConfig(chat);
    // 角色的后台活动配置存在 chat.settings 里 → 必须写 db.chats, 不是 globalSettings。
    // (面板上的开关是即时生效的, 不等角色设置页点保存)
    try {
      if (typeof db !== 'undefined' && db && db.chats && typeof db.chats.put === 'function') {
        const p = db.chats.put(chat);
        if (p && typeof p.catch === 'function') {
          p.catch(e => console.warn('[bg-activity-config] 保存角色后台活动配置失败:', e));
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------
  // 全局暴露
  // ------------------------------------------------------------
  window.BgActivityConfig = {
    BG_ACTS: BG_ACTS,
    COUPLE_FEATURES: COUPLE_FEATURES,
    COUPLE_MODES: COUPLE_MODES,
    getBgActivityConfig: getBgActivityConfig,
    peekBgActivityConfig: peekBgActivityConfig,
    isActEnabled: isActEnabled,
    isCoupleFeatureEnabled: isCoupleFeatureEnabled,
    saveBgActivityConfig: saveBgActivityConfig,
    defaultBgActivity: defaultBgActivity,
    defaultCouple: defaultCouple,
    migrateLegacyBgActivity: migrateLegacyBgActivity,
    migrateLegacyCouple: migrateLegacyCouple
  };

  console.log('[bg-activity-config] 模块加载完成, 活动项 ' + Object.keys(BG_ACTS).length + ' 个, 情侣空间功能 ' + COUPLE_FEATURES.length + ' 项');
})();

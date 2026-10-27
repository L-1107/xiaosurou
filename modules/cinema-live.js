// ============================================================
// cinema-live.js — Cinema Room 的 Gemini 3.8 Live 桥接层 (v1.0.0)
//
// 【来源与边界】
//   本文件是从 modules/watch-together-live.js (1390 行) 迁移而来。
//   旧文件是「一起看电影」已经跑通并验证过的 Live 链路:
//     ✅ 视频 → canvas → JPEG → 1 FPS → Gemini
//     ✅ 用户边看边打字聊天
//     ✅ 每 ~5 分钟后台更新「当前剧情摘要」(单通道互斥)
//     ✅ 退出时: 总结 → 写 longTermMemory → 确认写库 → 才关 Live
//
//   ⚠️ 本文件【不重新设计协议】。Gemini Live 的协议层仍然是
//      modules/live-client.js, 一个字没改。
//      下面的抽帧 / 摘要 / 退出顺序 / 单通道互斥 / session resumption
//      全部是旧文件里已验证的逻辑原样搬过来。
//
//   本文件只改了三类东西 —— 这正是「Cinema Room 只是换了播放器、DOM、状态、UI」:
//     1. DOM 目标:  #cinema-video / #cinema-chat-messages / #cinema-plot-panel
//     2. 状态归属:  自己的 watchSession + chatId, 不再借 window.watchTogetherState
//     3. 抽帧尺寸:  新增【保持宽高比的 768 长边降采样】(旧版直接吃原始分辨率)
//
// 【人设 / 长期记忆】
//   人设 = chat.settings.aiPersona (跟主聊天同一个字段)
//   ⚠️ 2026-10-11 起【不再注入 longTermMemory】(原因见 buildSystemPrompt 里的长注释)。
//      看剧时只给人设(语气), 不喂生活记忆 —— 记忆会跟剧情抢注意力, 让接话变蠢。
//      导出的剧情记录是另一条独立通道(用户手动点导出), 不受影响。
//   ⚠️ 房间里那两个小人是纯美术素材(设置里上传图片), 跟人设无关。
//
// 【抽帧降采样 — 为什么要改】
//   官方文档: 视频输入 1 FPS, 推荐 768x768 分辨率。
//   旧版直接 canvas.width = videoWidth (1920x1080 全量送), 单帧 base64 体积和
//   token 消耗都远超推荐值 —— 而输入 token 上限是 131,072, 送得越多撞得越快。
//   现在按长边缩到 768 且【严格保持宽高比】:
//     1920x1080 → 768x432      1080x1920 → 432x768
//     1080x1080 → 768x768      640x480   → 640x480 (不放大)
//   绝不把画面拉伸变形。
// ============================================================

(function () {
  'use strict';

  // ---- DOM 目标 (Cinema Room 自己的, 不再指向旧观影) ----
  var VIDEO_ID = 'cinema-video';
  var CHAT_BOX_ID = 'cinema-chat-messages';
  var PLOT_PANEL_ID = 'cinema-plot-panel';
  var STATUS_ID = 'cinema-live-status';

  // 1 FPS —— 官方建议上限, 旧文件已验证
  var FRAME_INTERVAL_MS = 1000;
  var JPEG_QUALITY = 0.6;

  // 🔴 新增: 抽帧降采样长边上限 (官方推荐 768)
  var FRAME_MAX_DIM = 768;

  // ---- 阶段剧情摘要 (与旧文件一致) ----
  var WATCH_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
  // 🔴 2026-10-19 原来只有一个 PLOT_SUMMARY_MAX_CHARS=2000, 现在拆成两个,
  //   因为这两段东西的用途完全不同, 混在一条提示词里就会出现"要么写不细、
  //   要么越滚越长"这种两头不讨好的结果:
  //   ANCHOR  喂回模型的滚动锚, 越滚越短, 只为让下一段接得上 (它会被反复重写)
  //   SEGMENT 落库的增量描述, 只讲"这一段新发生了什么", 累积不覆盖
  var ANCHOR_MAX_CHARS = 500;
  var SEGMENT_MAX_CHARS = 700;
  var SERIES_OUTLINE_MAX_CHARS = 1500;    // 短剧: 攒够一批合并出的总纲
  var SUMMARY_REQUEST_TIMEOUT_MS = 45000;

  // 🔴 2026-10-27: 单集剧情要等的【摘要通道】上限 (毫秒)。
  //
  //   起因: 摘要只有一条通道 (watchSession.pendingSummary)。原来 requestEpisodeSummary
  //   抢不到就【静默放弃】(return ''), 而 2026-10-23 新加的「此刻画面」实况每 30 秒
  //   就占一次这条通道 —— 短剧一集才 1~2 分钟, 播完那一刻正好撞上在途的实况,
  //   这一集的单集剧情就被扔了 (用户实测: 第一次不总结, 再放一遍才总结)。
  //
  //   25 秒 = 实况通道自己的超时 (LIVE_NOW_TIMEOUT_MS 20s) + 阶段摘要超时的一部分,
  //   够把正常的在途请求等完, 又不至于让用户干等太久。
  var EPISODE_SUMMARY_WAIT_MS = 25000;

  // ---- 「此刻画面」实况 (2026-10-23) ----
  // 陪聊改走主 API 之后, 主 API 看不见画面 —— 它只能靠"剧情记忆"知道演了什么。
  // 剧情记忆的粒度是 5 分钟一段, 问"刚才是怎么了"会答得粗。
  // 所以 Live 多开一条【高频短句】通道: 每隔一段时间写一句"此刻屏幕上是谁在干什么",
  // 覆盖式存进 watchSession.liveNow, 只给主 API 当上文用。
  //
  // 为什么默认 30 秒而不是 15 秒:
  //   这一条每个 turn 的输入是"这 30 秒的帧"(~30 张), 单次开销只有 5 分钟摘要的 1/10,
  //   但它会占 Live 的 turn 队列。所以宁可慢一点, 也不跟用户抢。
  var LIVE_NOW_INTERVAL_MS = 30 * 1000;
  var LIVE_NOW_TIMEOUT_MS = 20000;
  // 摘要快到期时, 实况让路 (摘要优先 —— 摘要进的是剧情记忆, 实况只是陪聊的补充)
  var LIVE_NOW_YIELD_BEFORE_SUMMARY_MS = 15000;

  // 🔴 2026-10-19 内容下限 —— 这次改造里最该单独拎出来的一条。
  //
  //   起因 (用户实测): 退出精炼被截断成只剩三个字, 但整条链的判据只有"非空"
  //   这一个门槛 (`if (!parts.memory) throw`), 于是三个字照样写进长期记忆、
  //   照样标记成功、照样 clearDraft() 把那几集的单集记忆清掉 —— 那几集真白看。
  //
  //   为什么"非空即成功"是错的: 截断过的内容比没有更糟。
  //   没有 → 用户知道没记下来, 会重试; 截断的三个字 → 用户以为记下来了, 不会再试。
  //   所以低于这个长度一律【当没生成出来】, 不落库、不算成功、保留上一次的好版本。
  var MIN_SUMMARY_CHARS = 80;

  // 🔴 2026-10-10 摘要收尾判据: 静默多少毫秒算"这次说完了"。
  //
  // 【为什么不再用 turnComplete 收摘要】(用户实测: 手动总结死活不落盘 + 片段漏进聊天框)
  //   turnComplete 是【音频回合】的边界, 不是"这段文字说完了"的保证。
  //   观影时 1 FPS 一直在送帧 → 回合被不停推进。于是发完请求后,
  //   极容易撞上一个【上一回合正在收尾】:
  //     ① 上一回合的尾巴文字到达 → handleModelText 把它塞进新请求的 buffer, gotText=true
  //     ② 那个回合的 turnComplete 到达 → onTurnCompleteInternal 看到 gotText 就 resolve
  //        → 收走的是【半截 + 上集尾巴】
  //     ③ 用户真正要的总结正文这才开始吐 → pendingSummary 已 null → 全漏进聊天框
  //   10-09 加的 gotText 门只能防"一个字都没到就收", 防不住"收早了" —— 症状一模一样。
  //
  // 【新办法: 不看回合边界, 只看"安静了多久"】
  //   每次收到一个字就重置静默计时; 连续 SUMMARY_SETTLE_MS 没新字 → 判定说完, resolve。
  //   流式输出时字与字之间的间隔远小于 2 秒, 所以只有真的说完了才会安静下来。
  //   这样收摘要跟回合边界彻底解耦, 无论它落在哪个 turn 上都无所谓。
  var SUMMARY_SETTLE_MS = 2000;

  // 恢复 handle 单独存一个 key —— 不跟旧观影的 wt_ 那个互相覆盖
  var HANDLE_KEY = 'cinema_gemini_live_resume_handle';
  var MAX_RETRY = 5;
  var RETRY_BASE_MS = 2000;

  var _retryCount = 0;
  var _retryTimer = null;
  var _autoTried = false;
  // 上一轮是不是抖动(连上就断) —— ready 时据此决定要不要清退避
  var flapLast = false;

  // ============================================================
  // 观影 session 状态 (只在内存, 绝不落长期记忆)
  // ============================================================
  var watchSession = {
    watchSessionId: null,
    chatId: null,
    currentPlotSummary: '',
    summaryUpdatedAt: 0,
    summaryCount: 0,
    pendingSummary: null,
    summaryBusy: false,
    // 摘要被强行丢弃后的"迟到文本"静默窗口 (毫秒时间戳)。
    // 丢弃之后模型可能还在把这半句吐完, 那段字绝不能进下一次摘要的 buffer。
    summaryGhostUntil: 0,
    summaryTimer: null,
    queuedUserText: null,
    chatLog: [],
    closed: false,
    leavePromise: null,
    // 已累计的【视频实际播放】毫秒数, 不是墙上时钟。
    // 用来实现"暂停时计时也暂停, 回来接着算"(2026-10-07 用户要求)。
    playedMs: 0,
    playingSince: 0,          // 正在播放时的起点戳; 暂停时为 0
    // 本轮摘要计时是什么时候起的 (按 playedMs 坐标系)。暂停不重置它,
    // 恢复后靠 scheduleStageSummary() 算还差多少。
    lastSummaryStartedAt: 0,
    // ---- 短剧专用 (2026-10-07) ----
    kind: 'film',              // 'film' = 长剧 | 'series' = 短剧
    seriesKey: null,           // 短剧: 剧名
    seriesTitle: '',           // 短剧: 剧名(显示用)
    seriesLastEp: 0,           // 短剧: 已看到第几集
    episodeMemories: [],       // 短剧: 攒下的单集记忆 [{ ep, text, id }]
    // 🔴 2026-10-21: 落库失败的条目 [{ ep, msg }] —— 给记忆页面板显示用。
    //   原来落库失败只 logWarn 一句, 用户毫无察觉, 几集之后点「精炼」才发现
    //   "库里没有攒下的单集剧情"。失败必须【看得见】。
    persistErrors: [],
    // 🔴 2026-10-27: 【根本没生成出来】的集 [{ ep, msg }] —— 跟 persistErrors 分开。
    //   persistErrors = 生成了但没存进库; episodeErrors = 压根没生成出来 (通道被占/超时)。
    //   这两种病不一样, 面板上的话也不能一样。
    episodeErrors: [],
    // 🔴 2026-10-10 用户实测: 退出再进来播第3集, 总结写成"第一集"。
    //   nowPlayingEp = 宿主传来的【这次实际播的集号】(用户点的按钮),
    //   onVideoEnded 播完时直接用它, 不再用 seriesLastEp+1 去猜 ——
    //   猜在"草稿恢复还没跑完"时序下会把第3集当第1集, 还会覆盖掉第1集的记忆。
    nowPlayingEp: 0,
    // 🔴 2026-10-19: 长剧的段落记忆 [{ ep, text }], ep = 段落序号 (1,2,3…)
    //   跟短剧的 episodeMemories 是同一套东西, 只是粒度不同:
    //   短剧按集 (一集 1~2 分钟), 长剧按 5 分钟 (一部几十集, 一次看不完)。
    //   两条都【当场落库】, 不再等退出时统一精炼 —— 那个环节已经被证明会输。
    segments: [],
    segCount: 0,
    // 导出到长期记忆正在进行中 (单通道, 防连点)
    exporting: false,
    // 🔴 2026-10-20 手动精炼前情提要正在进行中 (单通道, 防连点)
    refining: false,
    // 🔴 2026-10-20 精炼的进度/结果 —— 必须显示在【记忆页这一栏里】。
    //   原来只 appendSystemLine(发到聊天框), 而记忆页开着的时候聊天框是收着的
    //   → 用户点完"没动静"。这条就是那个教训。
    refineMsg: '',
    // ---- 跨场提要 (2026-10-15 起, 2026-10-19 改由后台合并产生) ----
    // 【它解决什么】各集记忆以前只活在内存, 退出精炼成功后一律清空,
    //   下次进来模型对这部剧是零认知 —— 用户看第 3 集时问"刚那个人是谁",
    //   它答不上来, 后面总结剧情也容易断片。
    // 🔴 2026-10-19 起它不再由"退出那一次调用"产出 (那个环节已被取消),
    //   改成后台合并: 攒够 RECAP_MERGE_EVERY 集就把库里的各集压成一份提要。
    //   seriesRecap = 从 Dexie 读出来的整行, 进片时喂回模型。
    //   长剧存的是滚动锚(currentPlotSummary), 也走这张表, key = 'film:'+chatId。
    seriesRecap: null,
    seriesRecapInjectPending: false,   // 切剧时置 true, 等 Live ready 后发注入回合
    // 🔴 2026-10-23 「此刻画面」实况 —— 陪聊改走主 API 之后, 主 API 看不见画面,
    //   只能靠这句知道自己"刚刚"看到的是什么。
    //   【单条覆盖式, 不是数组】—— 实况是"此刻"的快照, 攒多条只会互相矛盾
    //   ("张三站在门口" 和 "李四坐在床上" 堆一起, 主 API 只会更懵)。
    //   at = 写下来的时刻, 传给主 API 时算成"多少秒前看到的"。
    liveNow: { text: '', at: 0 }
  };

  /**
   * 这次观影攒记忆用的 key —— 直接当 cinemaEpMemories 表的 sessionKey。
   *
   * ⚠️ 为什么短剧用文件夹名、长剧用 'film:'+chatId:
   *   短剧是跨会话的资产 (今天看第 3 集, 明天看第 4 集, 也许隔一周),
   *   key 必须跟"哪部剧"绑死, 所以用 duanju-bridge 给的 dir.name。
   *   长剧是本地上传的单文件, 用 chatId 当作用域刚好够隔离,
   *   免得两个角色攒的段落互相串台。
   */
  function currentSessionKey() {
    if (watchSession.kind === 'series') return watchSession.seriesKey ? String(watchSession.seriesKey) : '';
    var cid = watchSession.chatId || S.chatId || '';
    return cid ? ('film:' + cid) : '';
  }

  /** 当前这次 play 段已跑了多久 (ms); 没在播放时返回 0 */
  function currentPlaySegmentMs() {
    if (!watchSession.playingSince) return 0;
    return Date.now() - watchSession.playingSince;
  }

  /** 已播放总时长 (ms) —— 暂停期间不算 */
  function totalPlayedMs() {
    return watchSession.playedMs + currentPlaySegmentMs();
  }

  /** 开始累计 (video play 时调) */
  function markPlaying() {
    if (!watchSession.playingSince) watchSession.playingSince = Date.now();
  }

  /** 暂停累计 (video pause / ended 时调) —— 把这一段结算进 playedMs */
  function markPaused() {
    if (!watchSession.playingSince) return;
    watchSession.playedMs += Date.now() - watchSession.playingSince;
    watchSession.playingSince = 0;
  }

  /**
   * 按【已播放时长】重排摘要定时器, 而不是每次都排满 5 分钟。
   *
   * 旧写法是 setTimeout(5分钟) 然后 finally 里无条件重排 —— 暂停一次就丢 5 分钟,
   * 因为定时器在暂停期间照跑, 只是 tick 撞到 video.paused 就 return。
   * 现在改成: 暂停时把剩余时间原样冻结, 恢复后接着算剩下的那部分。
   *
   * ⚠️ 同时必须清掉 watchSession.summaryTimer, 否则旧定时器还在飞,
   *    会跟新算出来的剩余时间打架 (两套定时器同时 tick)。
   */
  function scheduleStageSummary(delayMs) {
    if (watchSession.summaryTimer) {
      clearTimeout(watchSession.summaryTimer);
      watchSession.summaryTimer = null;
    }
    var waited = 0;
    // ⚠️ 必须用 !== null 之类的显式判断, 不能用真值判断 ——
    // lastSummaryStartedAt 初始就是 0, 用 if (lastSummaryStartedAt) 会把
    // "本轮起点恰好是 0" 误判成 "本轮还没起表", 于是每次都重排满 5 分钟,
    // 变成永远等不到那一次。
    if (watchSession.lastSummaryStartedAt !== null && watchSession.lastSummaryStartedAt !== undefined) {
      waited = totalPlayedMs() - watchSession.lastSummaryStartedAt;
      if (waited < 0) waited = 0;          // 换片重置后可能出现负数
    }
    var remaining = WATCH_SUMMARY_INTERVAL_MS - waited;
    if (remaining < 0) remaining = 0;
    var delay = (delayMs === undefined) ? remaining : delayMs;
    watchSession.summaryTimer = setTimeout(tickStageSummary, delay);
  }

  function newWatchSession(chatId) {
    watchSession.watchSessionId = 'cr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    watchSession.chatId = chatId || null;
    watchSession.currentPlotSummary = '';
    watchSession.summaryUpdatedAt = 0;
    watchSession.summaryCount = 0;
    watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    watchSession.chatLog = [];
    watchSession.closed = false;
    watchSession.leavePromise = null;
    watchSession.playedMs = 0;
    watchSession.playingSince = 0;
    watchSession.lastSummaryStartedAt = 0;
    watchSession.kind = 'film';
    watchSession.seriesKey = null;
    watchSession.seriesTitle = '';
    watchSession.seriesLastEp = 0;
    watchSession.episodeMemories = [];
    watchSession.persistErrors = [];
    watchSession.episodeErrors = [];
    watchSession.nowPlayingEp = 0;
    watchSession.segments = [];
    watchSession.segCount = 0;
    watchSession.exporting = false;
    watchSession.refining = false;
    watchSession.refineMsg = '';
    watchSession.seriesRecap = null;
    watchSession.seriesRecapInjectPending = false;
    log('新的 Cinema watch session:', watchSession.watchSessionId);
    return watchSession.watchSessionId;
  }

  // ============================================================
  // 系统提示词 (迁移自 watch-together-live.js:88-161)
  // 人设来源跟旧文件一致; 但 2026-10-11 起【不再注入长期记忆】(见函数内注释)。
  // ============================================================
  function buildSystemPrompt(chat) {
    var c = chat || {};
    var persona = (c.settings && c.settings.aiPersona) || '';
    var userPersona = (c.settings && c.settings.myPersona) || '';
    var rawNick = (c.settings && c.settings.myNickname) || '';
    // 🔴 2026-10-11 用户要求: 昵称是默认的「我」(或没填) 时, 提示词里改用「用户」称呼,
    //   其他昵称照常。
    //   原因(用户原话): "光说我他哪知道是谁" —— 「我」在提示词里指代不清,
    //   模型分不清那是"用户名"还是"第一人称代词"。
    //   有真实昵称时保留原样, 并用「」标出"这是个名字"。
    var userRef = (!rawNick || rawNick === '我') ? '用户' : ('「' + rawNick + '」');
    var charName = c.name || c.originalName || '角色';

    // 🔴 2026-10-11 不再把 longTermMemory 注入系统提示词 (用户实测: 接话降智、说雷霆语言)
    //
    //   原来这里会把【最近 5 条长期记忆全文】拼进提示词, 每条可能上千字 → 最多上万字。
    //   问题不在于"多", 而在于【方向冲突】: 这些记忆讲的都是用户和角色的生活往事,
    //   跟正在看的剧毫无关系; 而看片时每秒还有一帧画面要处理。
    //   模型一边要跟着剧情, 一边被生活记忆的腔调往回拽 —— 用户看到的就是"接话蠢、雷霆语言"。
    //
    //   用户的对照组: 早先的独立测试页【没有注入记忆】时, 聊剧情明显更好。
    //   同一个模型、同一套画面, 唯一差别就是少喂了这些 → 这是最硬的证据。
    //
    //   所以影院只保留人设(语气来源), 不再喂记忆。
    //   ⚠️ 注意: 这只影响【看剧时的系统提示词】。剧情记录是另一条独立通道
    //      (每集当场落库 + 用户手动导出), 不依赖这里。删掉不会丢剧情记录。
    //   ⚠️ AI 侧气泡里仍然会显示角色头像(getAvatarUrl 读的是 chat.settings.aiAvatar,
    //      跟这里无关)。

    var out = [];
    out.push('# 你是谁');
    out.push('');
    out.push('你就是「' + charName + '」。');
    if (persona) {
      out.push('');
      out.push('## 你的角色设定');
      out.push('');
      out.push(persona);
    }
    out.push('');

    // 🔴 2026-10-11 用户实测: 女主被人追, 用户说"好紧张", 模型回"别怕, 玄澈会保护你的"
    //   —— 它把【看剧的用户】当成了【剧中的女主角】。
    //
    //   第一版修法写成了"反面例子 (❌/✅)"。用户指出这不对:
    //     举例是让模型自己在"例子"和"当下"之间做映射, 多一层心智负担。
    //     正确做法是【直接用陈述句把性质讲清楚】—— 讲清了, 它自然就不会认错人。
    //
    //   所以这一版改成正面叙述三件事:
    //     1. 你俩在家里的家庭影院一起看电视 (场景)
    //     2. 你看到的是【这部剧的剧情内容】(不是"视觉输入"这种技术说法)
    //     3. 跟你说话的是坐在旁边一起看的人, TA 不在电视里 (身份)
    out.push('# 现在是什么情况');
    out.push('');
    out.push('你和' + userRef + '正在家里的家庭影院一起看电视。');
    out.push(userRef + '就坐在你旁边，跟你一块儿看。');
    out.push('电视上正在放一部剧 —— 你看到的视频帧就是【这部剧的剧情内容】，是电视剧里的人和事。');
    out.push('画面是一张一张连续送过来的。');
    out.push('');
    out.push('# 跟你聊天的是谁');
    out.push('');
    out.push('跟你说话的是' + userRef + '，和你一起看剧的那个人 —— TA 是真人，坐在你旁边。');
    out.push('TA 不在电视里，也不是剧里的任何角色。');
    out.push('电视剧里的人物和情节（谁保护谁、谁喜欢谁、谁跟谁有什么过往）都只发生在电视上，');
    out.push('和你俩没有关系，不要往 TA 身上套。');
    out.push('TA 跟你说话，就是在跟你聊这部剧、或者随便闲聊，不是剧里的人在说话。');
    out.push('');
    if (userPersona) {
      out.push('# ' + userRef + '是什么人');
      out.push('');
      out.push(userPersona);
      out.push('');
    }
    out.push('# 怎么陪 TA 看');
    out.push('');
    out.push('1. 像真人一样自然地聊天、评论、吐槽、讨论，就像坐在沙发上一起看剧。');
    out.push('2. TA 的感慨和吐槽（比如"好紧张""好帅""气死我了"）是在跟你聊剧情，');
    out.push('   接住这个情绪跟 TA 一起聊就行，不要当成剧里的人在说话，也不要当成 TA 在向你求助。');
    out.push('3. TA 问"现在在演什么""这个人是谁""刚才是怎么了"，就用你看到的剧情回答。');
    out.push('4. 不要逐帧罗列画面，不要用"根据我的观察""作为一个 AI"这种说法。');
    out.push('5. 没看清就直说没看清，不要编造你没看到的剧情。');
    out.push('6. 保持你自己的说话方式和人设，不要变成一个中立助手。');
    out.push('7. 用中文，简洁自然。');
    out.push('');
    out.push('## 后台维护指令（重要）');
    out.push('');
    out.push('系统会偶尔给你发一条【【后台任务】】开头的消息，要求你更新一份"当前剧情摘要"。');
    out.push('遇到这类消息时：');
    out.push('- 严格按照要求输出一份简洁的剧情摘要，不要和你平时说话的语气混在一起。');
    out.push('- 不要加称呼、不要问问题、不要加评论和感受。');
    out.push('- 只输出摘要正文本身。');
    out.push('这是正常的维护行为，用户那边不会看到你这次回复。');

    return out.join('\n');
  }

  // ============================================================
  // 运行时状态
  // ============================================================
  var S = {
    enabled: false,
    client: null,
    frameTimer: null,
    // 「此刻画面」实况的定时器 (2026-10-23) —— 跟 frameTimer 一样, Live 就绪才起
    liveNowTimer: null,
    canvas: null,
    ctx: null,
    framesSent: 0,
    paused: false,
    statusEl: null,
    bubbleEl: null,
    chatId: null,          // Cinema Room 自己的会话 chatId (不借旧观影的全局)
    autoMode: true,
    _userDisabled: false,
    _leaving: false,
    // 🔴 2026-10-21: 精炼期间主会话的连接位借给一次性会话了,
    //   这段时间主会话【不许】自动重连 (不然撞并发, 精炼照样失败)。
    _refineBorrowed: false
  };

  // ============================================================
  // 工具
  // ============================================================
  function log(msg, extra) {
    var line = '[Cinema-Live] ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) { /* noop */ }
    }
    console.log(line);
  }
  function logWarn(msg, extra) { console.warn('[Cinema-Live] ' + msg, extra === undefined ? '' : extra); }
  function logError(msg, extra) { console.error('[Cinema-Live] ' + msg, extra === undefined ? '' : extra); }

  function getVideo() { return document.getElementById(VIDEO_ID); }
  function getChatBox() { return document.getElementById(CHAT_BOX_ID); }

  function getCurrentChat() {
    try {
      if (typeof state !== 'undefined' && state && state.chats && S.chatId) {
        return state.chats[S.chatId] || null;
      }
    } catch (e) { /* noop */ }
    return null;
  }

  /**
   * Gemini Live API Key。
   * 存储位置与旧观影【完全相同】(chat.watchTogetherSettings.geminiApiKey),
   * 不新建第二份 key 存储 —— 这样旧设置里填过的直接能用。
   * Cinema Room 自己的设置 UI 也写回这个字段。
   */
  function getGeminiKey() {
    try {
      var chat = getCurrentChat();
      if (chat && chat.watchTogetherSettings) {
        return String(chat.watchTogetherSettings.geminiApiKey || '').trim();
      }
    } catch (e) { /* noop */ }
    return '';
  }

  function setGeminiKey(key) {
    var chat = getCurrentChat();
    if (!chat) return Promise.resolve(false);
    if (!chat.watchTogetherSettings) chat.watchTogetherSettings = {};
    chat.watchTogetherSettings.geminiApiKey = String(key || '').trim();
    return db.chats.put(chat).then(function () { return true; });
  }

  // ============================================================
  // 状态指示器 (挂在房间里, 不是 body 上的 fixed 条)
  // ============================================================
  var STATE_TEXT = {
    connecting: '🟡 连接中…',
    connected: '🟡 已连接, 初始化…',
    ready: '🟢 已连接',
    closed: '⚪ 已断开',
    error: '🔴 连接失败',
    idle: '⚪ 未启动'
  };

  function ensureStatusEl() {
    if (S.statusEl && S.statusEl.parentNode) return S.statusEl;
    var el = document.createElement('div');
    el.id = STATUS_ID;
    el.className = 'cinema-live-status';
    // ⚠️ 挂进顶栏标题行【右侧的占位容器】, 而不是 append 到 .cinema-room 上当 absolute 浮层。
    //   2026-10-04 用户反馈"绿色已连接放到视频框里了" —— 就是因为它 absolute
    //   挂在房间根上, top 算的是顶栏高度, 正好压在视频画面上。
    //   放进 flex 行里就没有这个问题: 它只占标题行的位置, 视频在它下面。
    //   样式全部走 CSS (.cinema-live-status), 这里不再写内联 —— 改样式只改一个地方。
    var host = document.getElementById('cinema-topbar-status');
    if (host) {
      host.appendChild(el);
    } else {
      // 房间 DOM 还没建 (理论上不会, open() 里才 enable) —— 兜底别让状态条消失
      el.style.position = 'absolute';
      el.style.left = '50%';
      el.style.top = 'calc(env(safe-area-inset-top, 0px) + var(--cinema-topbar-h, 58px) + 6px)';
      el.style.transform = 'translateX(-50%)';
      el.style.zIndex = '5';
      var room = document.getElementById('cinema-room');
      (room || document.body).appendChild(el);
    }
    S.statusEl = el;
    return el;
  }

  function renderStatus(state, detail) {
    var el = ensureStatusEl();
    var base = STATE_TEXT[state] || state;
    if (state === 'ready') {
      if (watchSession.summaryBusy) base = '⏳ 正在整理剧情…';
      else base = S.paused ? '🟢 已连接 · 视频暂停' : '🟢 已连接 · 正在看';
    }
    // 🔴 2026-10-21: 精炼期间主会话被断开, 关连接时 live-client 会回调
    //   onState('closed'), 把状态栏覆盖成"已断开（...）"。这里挡一下,
    //   让用户看到的是"精炼中, 暂时断开"而不是以为掉线了。
    if (S._refineBorrowed) base = '⏳ 精炼中, 暂时断开';
    // ⚠️ closed 也要显示 detail —— live-client.js:206 会把 WebSocket 关闭 code
    //   塞进 detail ('已断开 (code 1006)')。原来只在 error 时显示, 等于把
    //   断线原因直接丢了, 线上只能看到一句"已断开"没法排查 (2026-10-04 踩坑)。
    var showDetail = detail && (state === 'error' || state === 'closed');
    // 精炼期间不挂 detail —— 那句"精炼前情提要: 腾出连接位"是给日志看的, 给用户看是噪音。
    if (S._refineBorrowed) showDetail = false;
    el.textContent = base + (showDetail ? '（' + detail + '）' : '');
    el.style.display = 'block';
  }

  function hideStatus() {
    if (S.statusEl) S.statusEl.style.display = 'none';
  }

  // ============================================================
  // 抽帧 —— 迁移自旧文件 :281-320, 新增等比降采样
  // ============================================================

  /**
   * 计算降采样后的画布尺寸。
   * 长边缩到 FRAME_MAX_DIM (768), 宽高比严格保持, 绝不拉伸。
   *   1920x1080 → 768x432        1080x1920 → 432x768
   *   1280x720  → 768x432        640x480   → 640x480 (小于 768 就不放大)
   */
  function computeFrameSize(vw, vh) {
    if (!vw || !vh) return { w: FRAME_MAX_DIM, h: FRAME_MAX_DIM };
    var scale = Math.min(1, FRAME_MAX_DIM / Math.max(vw, vh));
    return {
      w: Math.max(2, Math.round(vw * scale)),
      h: Math.max(2, Math.round(vh * scale))
    };
  }

  function ensureCanvas(video) {
    var size = computeFrameSize(video.videoWidth, video.videoHeight);
    if (!S.canvas) S.canvas = document.createElement('canvas');
    if (S.canvas.width !== size.w || S.canvas.height !== size.h) {
      S.canvas.width = size.w;
      S.canvas.height = size.h;
    }
    if (!S.ctx || S.ctx.canvas !== S.canvas) {
      S.ctx = S.canvas.getContext('2d');
    }
    return { ctx: S.ctx, w: size.w, h: size.h };
  }

  /**
   * 抽一帧 → 纯 base64 (不带 data: 前缀)。
   * 返回 null 表示这一帧抽不到 (暂停/未就绪/跨域)。
   */
  function grabFrameBase64(video) {
    if (!video || video.paused || video.ended) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    var box;
    try {
      box = ensureCanvas(video);
      // 等比绘制到降采样后的画布中心, 上下/左右留黑边(保持原比例, 不裁不拉伸)
      var sx = video.videoWidth, sy = video.videoHeight;
      var dw = box.w, dh = box.h;
      var scale = Math.min(dw / sx, dh / sy);
      var rw = sx * scale, rh = sy * scale;
      var ox = (dw - rw) / 2, oy = (dh - rh) / 2;
      box.ctx.fillStyle = '#000';
      box.ctx.fillRect(0, 0, dw, dh);
      box.ctx.drawImage(video, ox, oy, rw, rh);
    } catch (e) {
      log('drawImage 失败 (可能是跨域污染 canvas):', e.name + ' ' + e.message);
      return null;
    }

    var dataUrl;
    try {
      dataUrl = S.canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch (e2) {
      log('toDataURL 失败:', e2.name + ' ' + e2.message);
      return null;
    }
    if (!dataUrl || dataUrl.indexOf('base64,') === -1) return null;
    var base64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
    return base64 || null;
  }

  function startFrameLoop() {
    stopFrameLoop();
    S.frameTimer = setInterval(function () {
      if (!S.client || !S.client.isReady()) return;
      var video = getVideo();
      if (!video) return;
      if (video.paused || video.ended) {
        S.paused = true;
        renderStatus('ready');
        return;
      }
      if (S.paused) { S.paused = false; renderStatus('ready'); log('视频恢复播放, 继续发帧'); }
      var b64 = grabFrameBase64(video);
      if (!b64) return;
      S.framesSent++;
      S.client.sendVideoFrame(b64, 'image/jpeg');
      // 每 30 帧打一次, 免得刷屏
      if (S.framesSent % 30 === 0) {
        log('已发 ' + S.framesSent + ' 帧 (当前 ' + Math.round(b64.length * 0.75 / 1024) + 'KB/帧, t=' +
          video.currentTime.toFixed(1) + 's)');
      }
    }, FRAME_INTERVAL_MS);
    log('开始 1 FPS 视频帧发送 (长边降采样到 ' + FRAME_MAX_DIM + ', 保持宽高比)');
    // 实况通道跟帧循环同生共死 (2026-10-23): 有帧才有"此刻画面"可言
    startLiveNowLoop();
  }

  function stopFrameLoop() {
    if (S.frameTimer) {
      clearInterval(S.frameTimer);
      S.frameTimer = null;
      log('已停止视频帧发送');
    }
    stopLiveNowLoop();
  }

  // ============================================================
  // 聊天 (Cinema Room 自己的容器)
  // ============================================================
  function appendSystemLine(text) {
    var box = getChatBox();
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'cinema-chat-sys';
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function appendUserBubble(text) {
    var box = getChatBox();
    if (!box) return;
    // ⚠️ 结构必须跟 renderGeminiBubble 一样: 外层 msg 套内层 bubble。
    //    原来这里是 `div.textContent = text` —— 文本直接塞在外层容器里,
    //    CSS 的 `.cinema-chat-msg.user > :last-child` 匹配到的是【文本节点】,
    //    文本节点没有背景, 所以用户消息完全没有气泡 (2026-10-04 用户反馈
    //    "AI 有气泡包裹, 用户没有")。要改一样的就改这里。
    var wrap = document.createElement('div');
    wrap.className = 'cinema-chat-msg user';
    var bubble = document.createElement('div');
    bubble.className = 'cinema-chat-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function getAvatarUrl() {
    try {
      var chat = getCurrentChat();
      if (chat && chat.settings && chat.settings.aiAvatar) return chat.settings.aiAvatar;
    } catch (e) { /* noop */ }
    return '';
  }

  /** 把 Gemini 的文字渲染成一个 assistant 气泡 (跨 turn 累加成整句) */
  function renderGeminiBubble(text) {
    var box = getChatBox();
    if (!box) { log('找不到聊天容器, Gemini 文字:', text); return; }
    // 🔴 原来写的是 `S.bubbleEl.parentNode === box`。
    //    但 S.bubbleEl 存的是【内层】的 .cinema-chat-bubble, 它的 parentNode
    //    是外层 .cinema-chat-msg, 永远不等于 box —— 于是每段流式文字都被判成
    //    "新气泡", 一句话被拆成三五个字一行 (2026-10-04 用户反馈)。
    //    正确判断: 只要这个节点还在消息容器里, 就是同一个气泡, 继续更新它。
    if (S.bubbleEl && box.contains(S.bubbleEl)) {
      S.bubbleEl.textContent = text;
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'cinema-chat-msg assistant';
      var avatar = getAvatarUrl();
      if (avatar) {
        var img = document.createElement('img');
        img.className = 'cinema-chat-avatar';
        img.src = avatar;
        img.alt = '';
        wrap.appendChild(img);
      }
      var content = document.createElement('div');
      content.className = 'cinema-chat-bubble';
      content.textContent = text;
      wrap.appendChild(content);
      box.appendChild(wrap);
      S.bubbleEl = content;
    }
    box.scrollTop = box.scrollHeight;
  }

  function resetBubble() { S.bubbleEl = null; bubbleStreamId++; }

  // ============================================================
  // 剧情记忆面板 (Cinema Room 自己的, 可查看 + 可编辑)
  // ⚠️ 只显示当前 session 的临时记忆, 绝不写 chat.longTermMemory
  // ============================================================
  var plotPanelEl = null;
  // 2026-10-16: 删掉了 plotPanelOpen (原来是"聊天面板里那条折叠条"的展开标志)。
  //   剧情记忆现在是独立页面, 开合状态看 #cinema-plot-sheet 上的 .open 类。
  // 正在编辑哪一块: null = 没在编辑 | 'summary' = 当前剧情摘要 | 'ep:N' = 短剧第 N 集
  var plotEditing = null;
  var plotDraft = '';

  function plotPanelVisible() {
    // 2026-10-04: 改成【常驻】。
    // 原来只在 Live 连上 / 有摘要时才出现, 于是用户看到的是"什么都没有",
    // 而且只能靠那个已经被删掉的「剧情」按钮去打开 —— 两头都断了。
    // 现在: 只要聊天面板开着, 顶上永远有这一行折叠条 (收起时只占一行高)。
    return true;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toTimeString().slice(0, 5); } catch (e) { return '—'; }
  }

  function ensurePlotPanel() {
    if (plotPanelEl && plotPanelEl.parentNode) return plotPanelEl;
    var el = document.createElement('div');
    el.id = PLOT_PANEL_ID;
    el.className = 'cinema-plot-panel';
    plotPanelEl = el;
    // 🔴 2026-10-16 改: 挂进【独立的剧情记忆页】(cinema-plot-sheet),
    //   不再挂聊天面板。
    //   原来挂在聊天面板里当一条常驻折叠条, 用户反馈"又要显示剧情, 又要显示聊天记录,
    //   想改点剧情总结, 键盘一弹看都不怎么看的见" —— 挤在聊天框里, 手机屏根本不够分。
    //   现在由顶栏「记忆」按钮开一个底部上滑页, 跟设置/片单同一套。
    var host = document.getElementById('cinema-plot-sheet');
    if (host) {
      var head = host.querySelector('.cinema-source-head');
      if (head && head.nextSibling) host.insertBefore(el, head.nextSibling);
      else host.appendChild(el);
    } else {
      var room = document.getElementById('cinema-room');
      (room || document.body).appendChild(el);
    }
    return el;
  }

  function renderPlotPanel() {
    var el = ensurePlotPanel();
    if (!plotPanelVisible()) { el.classList.remove('open'); el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = buildPlotPanelHtml();
    plotPanelEl = el;
  }

  /** 编辑用的 textarea + 保存/取消 (2026-10-07: 长剧摘要 + 短剧每集 共用) */
  function editBoxHtml(id, val) {
    return '<textarea class="cinema-plot-edit" id="' + id + '">' + esc(val) + '</textarea>' +
      '<div class="cinema-plot-edit-bar">' +
      '<button class="cinema-plot-btn" data-plot="save">保存</button>' +
      '<button class="cinema-plot-btn ghost" data-plot="cancel">取消</button>' +
      '</div>';
  }

  /**
   * 攒下来的剧情条目那一块 (2026-10-19 统一短剧/长剧)。
   *
   * 短剧按【集】列, 长剧按【段】列 —— 底层是同一份数据, 只是粒度和单位不同。
   * 每条都可以手动改: 改完存回内存, 并顺手回写库里那条 (见 saveEditedSummary)。
   */
  function buildEntriesHtml(isSeries) {
    var list = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
    var unit = isSeries ? '集' : '段';
    if (!list.length) {
      return '<span class="dim">（还没攒到。' +
        (isSeries ? '每看完一集自动记一条' : '每看够 5 分钟自动记一段，整部播完会补记最后一段') +
        '）</span>';
    }
    return list.map(function (e) {
      var tag = (isSeries ? 'ep:' : 'seg:') + e.ep;
      if (plotEditing === tag) {
        return '<div class="cinema-plot-ep editing">第' + e.ep + unit +'：' +
          editBoxHtml('cinema-plot-ep-edit', e.text) +
          '<div class="cinema-plot-hint">改完点保存，会同时写回存储，之后导出用的是你改过的内容。</div>' +
          '</div>';
      }
      return '<div class="cinema-plot-ep">第' + e.ep + unit + '：' + esc(e.text) +
        '<button class="cinema-plot-btn tiny" data-plot="edit:' + tag + '">改</button>' +
        '</div>';
    }).join('');
  }

  /** 攒着的条目总数 (短剧集数 / 长剧段数) */
  function memoryCount() {
    return (watchSession.episodeMemories || []).length + (watchSession.segments || []).length;
  }

  /** 单位跟着数据源走 */
  function memoryUnit() {
    return (watchSession.episodeMemories || []).length > 0 ? ' 集' : ' 段';
  }

  /** 到底有没有记到东西(任一路径算过就算) */
  function hasAnyMemory() {
    return !!(watchSession.currentPlotSummary
      || (watchSession.episodeMemories || []).length
      || (watchSession.segments || []).length
      || watchSession.summaryCount);
  }

  function buildPlotPanelHtml() {
    // 🔴 2026-10-16: 不再有"收起的一行标题"那一套了。
    //   原来这是聊天面板顶部一条可折叠的条 (点一下展开、再点收起), 因为它只能
    //   挤在聊天框里才有意义。现在它是独立页面, 由顶栏「记忆」按钮开、页面自带的
    //   「关闭」按钮收, 进来永远是展开的完整正文 —— 用户要的就是"能好好看清楚能改"。
    var isSeries = watchSession.kind === 'series';
    var busyHtml = watchSession.summaryBusy
      ? '<div class="cinema-plot-busy">⏳ 正在整理剧情，请稍等一下…</div>' : '';

    // 滚动锚正文。只有长剧有 —— 它是给模型看的滚动备忘录, 不是给用户看的产物。
    // 所以这一块只在长剧出现, 标题也直说它是"给模型看的", 免得用户去改它。
    var anchorHtml = '';
    if (!isSeries) {
      var anchorBody;
      if (plotEditing === 'summary') {
        anchorBody = editBoxHtml('cinema-plot-edit', plotDraft) +
          '<div class="cinema-plot-hint">这是喂给 Gemini 的滚动备忘录，改它只影响后续段落的衔接，不影响已经攒下的剧情。</div>';
      } else if (watchSession.currentPlotSummary) {
        anchorBody =
          '<div class="cinema-plot-text">' + esc(watchSession.currentPlotSummary) + '</div>' +
          '<div class="cinema-plot-edit-bar">' +
          '<button class="cinema-plot-btn" data-plot="edit:summary">编辑</button>' +
          '</div>';
      } else {
        anchorBody = '<div class="cinema-plot-text dim">（还没有，约 5 分钟后生成第一份）</div>';
      }
      anchorHtml = '<div class="cinema-plot-label">剧情进度（给 Gemini 看的滚动备忘）</div>' + anchorBody;
    }

    // 🔴 2026-10-19 导出区。取代原来那个「生成观影记忆」——
    //   精炼环节取消后, 中间产物就是这些条目本身, 写进长期记忆只是把它们搬过去。
    var n = memoryCount();
    var canExport = n > 0 && !watchSession.exporting;
    var exportBar =
      '<div class="cinema-plot-finalize">' +
      '<button class="cinema-plot-btn primary' + (canExport ? '' : ' disabled') +
      '" data-plot="export"' + (canExport ? '' : ' disabled') + '>' +
      (watchSession.exporting ? '⏳ 正在导出…' : '💾 导出到长期记忆') + '</button>' +
      '<div class="cinema-plot-hint">' +
      (n
        ? '把攒着的 ' + n + memoryUnit() + '剧情写进长期记忆，写成功后这一栏会清空。' +
          '没写成功就还在，可以再点一次。直接退出房间也没关系，内容已经存着。' +
          // 🔴 2026-10-20 顺序提醒: 先精炼再导出。
          //   导出成功会把库里的各集剧情【删掉】(清账), 删了就没素材给精炼用了。
          (isSeries
            ? '<br>⚠️ 导出前先点上面的「精炼前情提要」—— 导出后各集剧情会清掉，就没素材可精炼了。'
            : '')
        : '看剧时会自动攒剧情，攒够了就能导出。') +
      '</div></div>';

    var dot = watchSession.summaryBusy ? '🟡' : (hasAnyMemory() ? '🟢' : '⚪');

    return '<div class="cinema-plot-head">' + dot + ' 已攒 ' + n + memoryUnit() + '</div>' +
      '<div class="cinema-plot-body" data-noscroll="1">' +
      anchorHtml +
      busyHtml +
      (isSeries ? buildSeriesBlockHtml() : buildFilmBlockHtml()) +
      exportBar +
      '<div class="cinema-plot-stat">更新 ' + fmtTime(watchSession.summaryUpdatedAt) + '</div>' +
      '</div>';
  }

  /** 短剧那一块: 前情提要 + 攒下的各集 */
  function buildSeriesBlockHtml() {
    var eps = watchSession.episodeMemories || [];
    // 前情提要: 唯一跨场的东西, 下次进影院会自动喂给模型。
    // 不给"编辑"按钮 —— 用户明说这块只要显示 + 手动删除。
    var rec = watchSession.seriesRecap;
    var recapHtml;
    if (rec && (rec.text || '').trim()) {
      recapHtml =
        '<div class="cinema-plot-text">' + esc(rec.text) + '</div>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="del-recap">删除</button>' +
        '<span class="cinema-plot-hint">到第 ' + (rec.lastEp || 0) + ' 集 · 更新于 ' +
          fmtTime(rec.updatedAt) + '</span>' +
        '</div>';
    } else {
      recapHtml = '<div class="cinema-plot-text dim">（还没有。看够 ' + RECAP_MERGE_EVERY +
        ' 集会自动整理一份，也可以现在就点下面的「精炼前情提要」）</div>';
    }

    // 🔴 2026-10-20 手动精炼按钮 (用户要求)。
    //   自动那条要攒够 10 集才跑, 用户看 4 集就退出的话模型还是零认知。
    //   这里的按钮随时能点, 而且【一条单集剧情都不删】—— 提要只是给模型看的压缩版。
    //
    // ⚠️ 2026-10-20 修一个真事故: 反馈原来全走 appendSystemLine(聊天框),
    //   而记忆页开着的时候聊天框是收着的 → 用户点了"没动静"。
    //   现在进度和结果都显示在【这一栏里】(refineMsg), 聊天框那条只是顺带。
    //   按钮也【不再因为各种原因变灰】—— 灰了就是点了真的没反应, 那更糟。
    //   只有"正在精炼"才 disable, 其他情况点了都有明确反馈。
    var refining = !!watchSession.refining;
    // ⚠️ 2026-10-20: 这里【不再看主会话连没连】(liveReady 删掉了)。
    //   精炼改成【单独调一次观影模型】, 看完剧、没连接照样能做 ——
    //   原来那句"Gemini 没连上，精炼不了"是把这条路直接堵死了。
    //   现在只有"根本没填 key"才算真的调不了。
    var hasKey = !!getGeminiKey();
    var refineHint;
    if (refining) {
      refineHint = '正在精炼（会单独调一次观影模型，通常十几秒，最多一分钟）…';
    } else if (!hasKey) {
      refineHint = '⚠️ 还没填 Gemini API Key（右上角 ⚙ 里填），调不了模型。';
    } else {
      refineHint = (eps.length
        ? '把看过的 ' + eps.length + ' 集压成一份提要，下次进来自动带上。'
        : '把库里看过的各集压成一份提要。') +
        '会【单独调一次观影模型】来写 —— 看完剧、Gemini 断开了照样能精炼。各集剧情不会删。';
    }
    var refineBar =
      '<div class="cinema-plot-edit-bar">' +
      '<button class="cinema-plot-btn" data-plot="refine-recap"' + (refining ? ' disabled' : '') + '>' +
      (refining ? '⏳ 正在精炼…' : '📖 精炼前情提要') + '</button>' +
      '<span class="cinema-plot-hint">' + esc(refineHint) + '</span>' +
      '</div>' +
      (watchSession.refineMsg
        ? '<div class="cinema-plot-text dim">' + esc(watchSession.refineMsg) + '</div>'
        : '');

    // 🔴 2026-10-21: 落库失败的集要【在面板上看得见】。
    //   原来落库失败只 logWarn 一句, 用户毫无察觉, 几集之后点「精炼」才撞上
    //   "库里还没有攒下的单集剧情" —— 那时候已经没法回头查是哪一集出的问题。
    var persistWarnHtml = '';
    if (watchSession.persistErrors && watchSession.persistErrors.length) {
      var pe = watchSession.persistErrors;
      var peEps = pe.map(function (x) { return x.ep; }).join('、');
      persistWarnHtml = '<div class="cinema-plot-text dim">⚠️ 第 ' + peEps + ' 集没存进库（' +
        esc(pe[0].msg || '未知原因') +
        '）。精炼和导出仍会用这次看到的，但刷新页面会丢。</div>';
    }

    // 🔴 2026-10-27: 【压根没总结出来】的集 —— 跟"没存进库"分开显示。
    //   以前这一集是【静默】丢掉的: 界面上什么都没有, 状态条还写着"看到第 N 集",
    //   用户根本不知道自己少了一集, 直到几集之后点「精炼」才发现素材不对。
    var episodeWarnHtml = '';
    if (watchSession.episodeErrors && watchSession.episodeErrors.length) {
      var ee = watchSession.episodeErrors;
      var eeEps = ee.map(function (x) { return x.ep; }).join('、');
      episodeWarnHtml = '<div class="cinema-plot-text dim">⚠️ 第 ' + eeEps + ' 集没总结出来（' +
        esc(ee[0].msg || '未知原因') +
        '）。重播这一集就能补上。</div>';
    }

    return '<div class="cinema-plot-label">前情提要（跨场保留 · 下次进影院自动带上）</div>' +
        recapHtml +
        persistWarnHtml +
        episodeWarnHtml +
        refineBar +
        '<div class="cinema-plot-label">已攒 ' + eps.length + ' 集'
          + (watchSession.seriesLastEp ? ' · 看到第 ' + watchSession.seriesLastEp + ' 集' : '')
          + (eps.length ? ' · 点「改」可以自己修正' : '') + '</div>' +
        buildEntriesHtml(true);
  }

  /** 长剧那一块: 跨场进度 + 整部戏的提要 + 攒下的各段 */
  function buildFilmBlockHtml() {
    var segs = watchSession.segments || [];
    var rec = watchSession.seriesRecap;
    var recapHtml;
    if (rec && (rec.text || '').trim()) {
      recapHtml =
        '<div class="cinema-plot-text">' + esc(rec.text) + '</div>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="del-film-anchor">删除进度</button>' +
        '<span class="cinema-plot-hint">更新于 ' + fmtTime(rec.updatedAt) + '</span>' +
        '</div>';
    } else {
      recapHtml = '<div class="cinema-plot-text dim">（还没有。下次进来时会把上面的「剧情进度」自动带上）</div>';
    }

    // 🔴 2026-10-21 长剧也有前情提要了 (用户要求)。
    //   它跟上面那个"上次看到哪"(滚动锚)是两回事:
    //     · 滚动锚 = 状态, 每 5 分钟被覆盖一次, 说的是"现在停在哪"
    //     · 提要   = 压缩稿, 手动点按钮才生成, 说的是"整部戏讲了什么"
    //   两个存在同一行的两个字段里 (text / recapText), 互不覆盖。
    var filmRecapHtml;
    if (rec && (rec.recapText || '').trim()) {
      filmRecapHtml =
        '<div class="cinema-plot-text">' + esc(rec.recapText) + '</div>' +
        '<div class="cinema-plot-edit-bar">' +
        '<button class="cinema-plot-btn" data-plot="del-film-recap">删除提要</button>' +
        '<span class="cinema-plot-hint">到第 ' + (rec.recapLastEp || 0) + ' 段 · 更新于 ' +
          fmtTime(rec.updatedAt) + '</span>' +
        '</div>';
    } else {
      filmRecapHtml = '<div class="cinema-plot-text dim">（还没有。看完几段之后点下面的按钮就能压一份出来）</div>';
    }

    var refining = !!watchSession.refining;
    var hasKey = !!getGeminiKey();
    var refineHint;
    if (refining) {
      refineHint = '正在精炼（会单独调一次观影模型，通常十几秒，最多一分钟）…';
    } else if (!hasKey) {
      refineHint = '⚠️ 还没填 Gemini API Key（右上角 ⚙ 里填），调不了模型。';
    } else {
      refineHint = (segs.length
        ? '把攒下的 ' + segs.length + ' 段压成一份提要，下次进来自动带上。'
        : '把攒下的各段压成一份提要。') +
        '会【单独调一次观影模型】来写 —— 看完剧、Gemini 断开了照样能精炼。各段剧情不会删。';
    }
    var refineBar =
      '<div class="cinema-plot-edit-bar">' +
      '<button class="cinema-plot-btn" data-plot="refine-recap"' + (refining ? ' disabled' : '') + '>' +
      (refining ? '⏳ 正在精炼…' : '📖 精炼剧情提要') + '</button>' +
      '<span class="cinema-plot-hint">' + esc(refineHint) + '</span>' +
      '</div>' +
      (watchSession.refineMsg
        ? '<div class="cinema-plot-text dim">' + esc(watchSession.refineMsg) + '</div>'
        : '');

    return '<div class="cinema-plot-label">上次看到哪（跨场保留 · 下次进影院自动带上）</div>' +
        recapHtml +
        '<div class="cinema-plot-label">整部剧情提要（手动生成 · 下次进影院也自动带上）</div>' +
        filmRecapHtml +
        refineBar +
        '<div class="cinema-plot-label">已攒 ' + segs.length + ' 段'
          + (segs.length ? ' · 点「改」可以自己修正' : '') + '</div>' +
        buildEntriesHtml(false);
  }

  // ⚠️ 2026-10-16 删掉了 togglePlotPanel()。它是给"聊天面板里那条折叠条"用的
  //   (点一下展开、再点收起)。剧情记忆现在是独立页面, 开由顶栏「记忆」按钮、
  //   关由页面自带的「关闭」按钮, 进来永远是展开的 —— 没有可折叠的东西了。

  /** 开始编辑某一块。target: 'summary' | 'ep:N' | 'seg:N' */
  function startEditSummary(target) {
    var s = String(target);
    if (s.indexOf('ep:') === 0 || s.indexOf('seg:') === 0) {
      var isSeries = s.indexOf('ep:') === 0;
      var pool = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
      var ep = parseInt(s.slice(s.indexOf(':') + 1), 10);
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].ep === ep) { plotDraft = pool[i].text || ''; break; }
      }
      plotEditing = s;
    } else {
      plotDraft = watchSession.currentPlotSummary || '';
      plotEditing = 'summary';
    }
    renderPlotPanel();
  }

  function saveEditedSummary() {
    var s = String(plotEditing);
    if (s.indexOf('ep:') === 0 || s.indexOf('seg:') === 0) {
      var isSeries = s.indexOf('ep:') === 0;
      var pool = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
      var ep = parseInt(s.slice(s.indexOf(':') + 1), 10);
      var taEp = document.getElementById('cinema-plot-ep-edit');
      var vEp = taEp ? taEp.value : plotDraft;
      var newText = String(vEp || '').trim();
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].ep === ep) {
          // 存空会让那一行变成「第N集：」什么都没有, 看着像坏了 —— 留原文并提示
          if (!newText) {
            log('第 ' + ep + (isSeries ? ' 集' : ' 段') + '没填内容, 已保留原文');
          } else if (newText.length < MIN_SUMMARY_CHARS) {
            logWarn('改完只有 ' + newText.length + ' 字 (低于 ' + MIN_SUMMARY_CHARS + '), 已保留原文');
            appendSystemLine('⚠️ 改得太短了（低于 ' + MIN_SUMMARY_CHARS + ' 字），已保留原来的内容。');
          } else {
            pool[i].text = newText;
            // 🔴 2026-10-19 手改必须回写库 —— 否则导出会用回没改过的那份,
            //   用户明明在这个面板上改对了, 导出去的还是旧的。
            persistEpMemory(pool[i]);
            log('用户手动修正了第 ' + ep + (isSeries ? ' 集' : ' 段') + '剧情');
          }
          break;
        }
      }
      plotEditing = null;
      renderPlotPanel();
      return;
    }

    var ta = document.getElementById('cinema-plot-edit');
    var val = ta ? ta.value : plotDraft;
    watchSession.currentPlotSummary = String(val || '').trim();
    if (watchSession.summaryUpdatedAt === 0) watchSession.summaryUpdatedAt = Date.now();
    if (watchSession.currentPlotSummary) persistFilmAnchor(watchSession.currentPlotSummary);
    plotEditing = null;
    log('用户手动编辑了剧情进度');
    renderPlotPanel();
  }

  // 面板点击 (事件委托, 避免重复绑定)
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var panel = t.closest('#' + PLOT_PANEL_ID);
    if (!panel) return;
    var act = t.getAttribute && t.getAttribute('data-plot');
    if (act && act.indexOf('edit') === 0) { startEditSummary(act.slice(5)); return; }
    if (act === 'save') { saveEditedSummary(); return; }
    if (act === 'cancel') { plotEditing = null; renderPlotPanel(); return; }
    // 🔴 2026-10-19 导出到长期记忆。取代原来那个「生成观影记忆」。
    //   不用 await —— 它自己会 appendSystemLine 报进度/结果, 这里只是触发器。
    if (act === 'export') {
      log('用户点了「导出到长期记忆」');
      exportMemoriesToMemory();
      return;
    }
    // 🔴 2026-10-20 手动精炼前情提要 (用户要求)。
    //   不用 await —— 它自己会报进度/结果, 这里只是触发器。
    //   精炼【不删】各集剧情, 跟「导出到长期记忆」是两件独立的事。
    if (act === 'refine-recap') {
      log('用户点了「精炼前情提要」');
      refineSeriesRecap();
      return;
    }
    // 🔴 2026-10-21 长剧那两个新按钮: 删滚动锚 / 删整部戏的提要。
    //   ⚠️ 必须【分开删】—— 长剧这一行里 text=锚、recapText=提要,
    //   以前那个"删"是整行删, 会把另一个也带走。
    if (act === 'del-film-anchor' || act === 'del-film-recap') {
      var isAnchor = act === 'del-film-anchor';
      var rr = watchSession.seriesRecap;
      var field = isAnchor ? 'text' : 'recapText';
      if (!rr || !(rr[field] || '').trim()) return;
      var msg2 = isAnchor
        ? '确定要删除《上次看到哪》吗？\n\n' +
          '删了下次进来 Gemini 就不知道上次看到哪儿了。\n' +
          '已经攒下的各段剧情不受影响。'
        : '确定要删除《整部剧情提要》吗？\n\n' +
          '删了下次进来 Gemini 就不知道整部戏讲过什么了（但「上次看到哪」还在）。\n' +
          '已经攒下的各段剧情不受影响，随时可以重新精炼一份。';
      if (typeof window.confirm === 'function' && !window.confirm(msg2)) return;
      deleteCurrentSeriesRecap(field);
      return;
    }
    // 🔴 手动删除跨场提要 (短剧的前情提要 / 长剧的"上次看到哪")。
    //   ⚠️ 2026-10-19 文案跟着一起改了: 它以前那句"看完退出时会重新生成一份"
    //   已经不成立 —— 退出时不再有任何生成动作, 现在是"看够 N 集后台自动合并"。
    if (act === 'del-recap') {
      var r = watchSession.seriesRecap;
      if (!r || !(r.text || '').trim()) return;
      var isSeries = watchSession.kind === 'series';
      var msg = isSeries
        ? '确定要删除《' + (r.title || watchSession.seriesTitle || '这部剧') + '》的前情提要吗？\n\n' +
          '删了下次进来 Gemini 就不知道前面演过什么了。\n' +
          '已经攒下的各集剧情不受影响，继续看够 ' + RECAP_MERGE_EVERY + ' 集会自动整理一份，' +
          '也可以随时点「精炼前情提要」。'
        : '确定要删除《上次看到哪》吗？\n\n' +
          '删了下次进来 Gemini 就不知道上次看到哪儿了。\n' +
          '已经攒下的各段剧情不受影响。';
      if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
      deleteCurrentSeriesRecap();
      return;
    }
    // ⚠️ 2026-10-16: 原来这里收尾是 togglePlotPanel() —— 点面板空白处就折叠。
    //   剧情记忆现在是独立页面, 点空白不该有副作用 (尤其会把刚滚到的位置重置掉),
    //   所以面板内的点击一律只处理按钮, 什么都不做。
    return;
  }, true);

  // ============================================================
  /**
   * outputTranscription.text 是【到目前为止的累计全文】, 不是增量。
   *
   * ⚠️ 但"累计"的边界会随回合漂移, 所以实际收到过四种形态 (2026-10-04 连续踩了两次):
   *
   *   ① 完全重复          "点吃的呢。" → "点吃的呢。"      → 丢弃
   *   ② 标准累计          "找点吃" → "找点吃的呢。"          → 取新增 "的呢。"
   *   ③ 服务端重开一轮    上一回合尾巴被重发 (下面 ④)
   *   ④ 【尾巴重叠】      "…找点吃的呢。" + "点吃的呢。"     → 必须切掉重复的 5 个字
   *
   * ④ 才是"末几个字重复"的真凶。视频帧会推进回合 (TURN_COVERAGE=ALL_VIDEO),
   * 新回合的转写有时不是从零开始, 而是把上一回合最后几个字再吐一遍。
   * 只判 ①② 的话 ④ 会掉进"当新文本"分支, 直接拼上去 —— 用户看到的就是
   * "赶紧跳进去救人。救人。" / "…一懵一懵的。一愣一愣的。"
   *
   * 做法: 找出 prev 的尾巴和 text 的头最长重叠几个字, 从 text 里切掉。
   * 单字重叠不算 (句号/逗号撞一下太常见, 会误吞正常语气词), 除非整段都是重复。
   */
  function takeDelta(prev, text) {
    if (!text) return '';
    if (!prev) return text;
    if (text === prev) return '';                                   // ①
    if (text.indexOf(prev) === 0) return text.slice(prev.length);    // ②
    var max = Math.min(prev.length, text.length);
    for (var n = max; n > 0; n--) {
      if (n < 2 && n !== text.length) continue;   // 单字重叠: 只在"整段重复"时才认
      if (prev.slice(prev.length - n) === text.slice(0, n)) return text.slice(n);
    }
    return text;                                                    // 真的是新内容
  }

  // 模型文字统一入口 —— 「摘要不进气泡」的唯一保证点
  // 迁移自旧文件 :551-565
  // ============================================================
  var bubbleText = '';   // 当前 assistant 气泡的完整文本, 用户发新消息才清零
  var bubbleStreamId = 0;  // 当前这句话的唯一号。chatLog 靠它判断"是不是同一句还在流"
                            // → 同一句只留一条, 被后续增量覆盖, 不产生几十条碎片。

  function handleModelText(text, isFinal) {
    if (!text) return;

    // ⚠️ 2026-10-09: 摘要被【强行丢弃】后的迟到文本窗口。
    //   退出时如果上一条摘要还在跑, 我们会掐掉它换发最终总结;
    //   但模型那半句还在往回吐。这些迟到的字属于【已经作废的那次请求】,
    //   一旦被新请求的 buffer 收下, 最终观影记忆就又变成半截单集剧情。
    //   这段时间内一律丢弃, 也不置 gotText。
    if (watchSession.summaryGhostUntil && Date.now() < watchSession.summaryGhostUntil) {
      return;
    }

    if (watchSession.pendingSummary) {
      var p = watchSession.pendingSummary;
      p.gotText = true;
      p.lastTextAt = Date.now();
      p.buffer += takeDelta(p.lastText, text);   // 摘要同样要去重, 否则整段是重复堆的
      p.lastText = text;
      // 🔴 每次收到字就重新起算静默计时 —— 说完了自然会安静下来, 计时到点才收。
      //   这取代了"靠 turnComplete 收", 见 SUMMARY_SETTLE_MS 的说明。
      if (typeof p.armSettle === 'function') p.armSettle();
      return;   // ⬅ 关键: 摘要文字绝不进聊天气泡
    }
    // 🔴 2026-10-23 陪聊改走主 API 之后, Live 的文字【一律不进聊天气泡】。
    //   气泡现在是主 API 的地盘 (modules/cinema-chat.js 渲染)。
    //   Live 这边的文字只有两个去处: 剧情摘要 / 此刻实况 —— 都走上面那条 pendingSummary。
    //   落到这里 = 一次不在途的 turn 吐了字, 直接丢掉:
    //   绝不能让它跟主 API 的回复抢同一个气泡。
    log('[Live] 丢弃一条不在途的文字 (' + String(text).slice(0, 60) + ')');
  }

  function recordChat(role, text) {
    if (!text) return;
    var t = String(text).trim();
    if (!t) return;
    // 只记一句完整的话 —— 记录发生在"一句话说完"的时刻, 不是逐字流式时,
    // 否则同一句会被记成几十条碎片。
    // ⚠️ 2026-10-10: 之前只 recordChat('user'), 角色这边的回应从来没被记过,
    //   而导出用的正文里两边都要 ('用户：…' / '你：…')
    //   —— 双边对话才是"一起看的回忆", 只记一边等于丢了现场。
    var last = watchSession.chatLog[watchSession.chatLog.length - 1];
    if (last && last.role === role && last.streamingId === bubbleStreamId) {
      last.text = t.slice(0, 500);   // 同一句还在流 → 覆盖, 不追加
      return;
    }
    watchSession.chatLog.push({ role: role, text: t.slice(0, 500), streamingId: bubbleStreamId, at: Date.now() });
    // ⚠️ 60 条上限以前会把【一整场】的吐槽前文挤掉。这里改成 200 条:
    //   草稿要落 localStorage, 200 条 × 500 字上限 ≈ 100KB, 完全放得下。
    //   另外开头留一条"本场开场提示", 让角色知道这次观影之前聊过什么。
    if (watchSession.chatLog.length > 200) watchSession.chatLog.splice(1, 1);
  }

  /** 记一句完整的角色回复。isFinal=true 才算这句话说完了。 */
  function recordAssistantFinal(text) {
    if (!text) return;
    var t = String(text).trim();
    if (!t) return;
    var last = watchSession.chatLog[watchSession.chatLog.length - 1];
    if (last && last.role === 'assistant' && last.streamingId === bubbleStreamId) {
      last.text = t.slice(0, 500);   // 同一句收尾 → 覆盖成最终文本
      return;
    }
    watchSession.chatLog.push({ role: 'assistant', text: t.slice(0, 500), streamingId: bubbleStreamId, at: Date.now() });
    if (watchSession.chatLog.length > 200) watchSession.chatLog.splice(1, 1);
  }

  // ============================================================
  // 摘要请求 —— 单通道, 绝不能与用户消息并发
  // 迁移自旧文件 :579-640
  // ============================================================
  function requestSummary(kind, instruction, options) {
    // 🔴 2026-10-23 options:
    //   silent    —— 实况通道用。不占用"正在整理剧情"那个 UI 状态, 也不重刷记忆面板
    //                (实况只是陪聊的补充, 不该在界面上显得像在干活)。
    //   timeoutMs —— 实况只要一句话, 20 秒还没完就该作废, 别占着 turn 队列。
    var opts = options || {};
    var silent = opts.silent === true;
    var timeoutMs = opts.timeoutMs || SUMMARY_REQUEST_TIMEOUT_MS;
    if (watchSession.pendingSummary) return Promise.reject(new Error('已有摘要请求在进行中'));
    if (!S.client || !S.client.isReady()) return Promise.reject(new Error('Live 未就绪'));

    // ⚠️⚠️ 2026-10-09 必须先排掉上一回合残留的转写全文 (用户实测: 看两集短剧,
    //   退出后的「最终观影记忆」整段变成了某一集的单集剧情原文)。
    //
    //   live-client.js 的 _lastTranscription 收到新转写就赋值, turnComplete 时又重抛它,
    //   但【从头到尾没有任何地方清空过它】(只在构造函数初始化为 '')。
    //   所以上一回合的全文会一直挂着, 之后任何一个 turnComplete 都会把它再喂一遍。
    //
    //   对正常聊天无害 (bubbleText 有 takeDelta 去重), 但摘要请求换人时是致命的:
    //   新的 p 的 lastText 是空的, takeDelta 去不了重 → 上一集的单集记忆全文
    //   被当成这次最终总结的内容收走, gotText 也被置 true, 竞态门形同虚设。
    //
    //   这里主动清一次, 让"这次摘要"只可能收到这次之后的文本。
    try { S.client._lastTranscription = ''; } catch (e) { /* noop */ }

    var p = {
      kind: kind, buffer: '', lastText: '',
      resolve: null, timer: null, settleTimer: null,
      lastTextAt: 0,
      silent: silent,
      // gotText: 见 handleModelText / onTurnCompleteInternal 的竞态说明。
      // 摘要请求发出去之后, 必须【真的收到模型的字】才允许被收走。
      gotText: false
    };
    var promise = new Promise(function (resolve) { p.resolve = resolve; });

    watchSession.pendingSummary = p;
    if (!silent) {
      watchSession.summaryBusy = true;
      renderStatus('ready');
      renderPlotPanel();
    }

    /**
     * 判定"这次摘要说完了" —— 连续 SUMMARY_SETTLE_MS 没新字。
     * 挂在 p.settleTimer 上, 每次 handleModelText 收到字就重新调一次(重新计时)。
     *
     * 为什么不用 turnComplete: 见 SUMMARY_SETTLE_MS 上面的注释。
     * 回合边界被视频帧推着走, 撞上上一回合收尾就会收早 → 漏进聊天框。
     */
    p.armSettle = function () {
      if (watchSession.pendingSummary !== p) return;   // 已被别的路径收走
      if (p.settleTimer) clearTimeout(p.settleTimer);
      if (!p.gotText) return;                          // 一个字都没吐, 继续等
      p.settleTimer = setTimeout(function () {
        if (watchSession.pendingSummary !== p) return;
        var buf = (p.buffer || '').trim();
        log('[摘要] ' + kind + ' 静默 ' + (SUMMARY_SETTLE_MS / 1000) + 's, 判定说完 (' + buf.length + ' 字)');
        p.resolve(buf);
        finishSummary(p);
      }, SUMMARY_SETTLE_MS);
    };

    p.timer = setTimeout(function () {
      if (watchSession.pendingSummary !== p) return;
      if (p.settleTimer) clearTimeout(p.settleTimer);   // 超时收走前先掐掉静默计时, 防二次 resolve
      watchSession.pendingSummary = null;
      watchSession.summaryBusy = false;
      logWarn('[' + kind + '] 请求超时 (' + timeoutMs + 'ms)');
      // 超时作废后, 已经吐出来的那半句可能还在继续流 —— 开静默窗口把它们丢掉,
      // 免得流进下一次摘要的 buffer (同 waitForNoPendingSummary 里的说明)。
      // 只在真的吐过字时才开, 免得连正常聊天都被误吞三秒。
      if (p.gotText) {
        watchSession.summaryGhostUntil = Date.now() + 3000;
        try { if (S.client) S.client._lastTranscription = ''; } catch (e) { /* noop */ }
      }
      if (!silent) {
        renderStatus('ready');
        renderPlotPanel();
      }
      p.resolve('');
    }, timeoutMs);

    log('[' + kind + '] 发起请求');
    var ok = S.client.sendUserText(instruction);
    if (!ok) {
      clearTimeout(p.timer);
      watchSession.pendingSummary = null;
      watchSession.summaryBusy = false;
      if (!silent) renderStatus('ready');
      return Promise.reject(new Error('发送失败 (Live 未就绪)'));
    }
    return promise;
  }

  function finishSummary(p) {
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    if (p.settleTimer) clearTimeout(p.settleTimer);   // 静默计时器也要收, 别在收完后又 resolve 一次
    if (watchSession.pendingSummary === p) watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    // 摘要收尾后同样排掉 _lastTranscription, 免得这一整段全文在之后的
    // turnComplete 上被重抛, 混进下一次摘要 (同 requestSummary 里的说明)。
    // 正常聊天气泡有自己的 takeDelta, 清掉不影响连续性 ——
    // 下一次增量到达时 t !== '' 会正常重新赋值。
    try { if (S.client) S.client._lastTranscription = ''; } catch (e) { /* noop */ }
    // 实况是静默通道 —— 不刷状态栏、不刷记忆面板 (它没改任何剧情记忆)
    if (!p.silent) {
      renderStatus('ready');
      renderPlotPanel();
    }
  }

  function flushQueuedUserText() {
    if (watchSession.queuedUserText) {
      var q = watchSession.queuedUserText;
      watchSession.queuedUserText = null;
      log('摘要完成, 补发排队的用户消息');
      doSendUserText(q);
    }
  }

  // ============================================================
  // 阶段剧情摘要 (每 ~5 分钟)
  // 迁移自旧文件 :646-716
  // ============================================================
  /**
   * 长剧每 5 分钟那一次的指令 —— 2026-10-19 改成【一次出两份】。
   *
   * 【为什么是两份, 而且必须是同一份的两部分】
   *   第一版改造时有人会问: "能不能直接写增量、不用滚动锚" —— 不能。
   *   长剧一集几十集, 一部几十集, 模型早就滚掉了前面看到什么,
   *   不给锚它总结出来的东西会跟已有段落对不上号 (同一个人前后叫法都不一样)。
   *   但如果拿"上一段落原文"当锚, 存十段下来每段都跟前面重叠,
   *   导出去全是重复内容 —— 这正是覆盖式摘要的老毛病, 只是换了个地方犯。
   *
   *   所以拆成两个用途完全不同的东西:
   *     ANCHOR  滚动覆盖式, 越滚越短, 只喂回模型, 不落库 → 让下一段接得上
   *     SEGMENT 纯增量, 只讲"这一段新发生了什么", 累积落库 → 面板/导出/跨场用
   *
   * 【为什么一次调用出两份】两份吃的是同一批画面。分两次调会慢一倍,
   *   而且两次之间剧情又往前走了, 两份可能对不上。
   *   代价是排版可能跑偏 → splitAnchorAndSegment() 兜住。
   */
  function buildStageSummaryInstruction() {
    var prev = watchSession.currentPlotSummary;
    var lines = [];
    lines.push('【【后台任务】】你刚看完了一段，请写两份东西。');
    lines.push('');
    if (prev) {
      lines.push('# 你上一版记录的【剧情进度】（只是背景资料，不是现在要讨论的内容）');
      lines.push('');
      lines.push(prev);
      lines.push('');
      lines.push('看完这一段, 在它的基础上更新【剧情进度】。');
    } else {
      lines.push('这是你第一次记录剧情进度。看完这一段后写一份"目前剧情发展到了什么程度"。');
      lines.push('');
    }
    lines.push('# 第一部分：' + ANCHOR_MARK);
    lines.push('');
    lines.push('写【剧情进度】—— 这是给【你自己】看的滚动备忘录, 只为让后面几段接得上。');
    lines.push('· 只保留目前对理解整部影片最重要的剧情信息。');
    lines.push('· 删掉已经不重要的细节, 不要越积越长, 越写越短才对。');
    lines.push('· 如果之前的判断被后面的剧情证明不对, 直接修正。');
    lines.push('· 不写你和用户的互动, 不写聊天, 不写评价, 只讲这部影片本身。');
    lines.push('· 控制在 ' + ANCHOR_MAX_CHARS + ' 字以内。');
    lines.push('');
    lines.push('# 第二部分：' + SEG_MARK);
    lines.push('');
    lines.push('写【本段剧情】—— 这是刚过去这一段【新发生的事】, 会被单独存下来, 以后导出用。');
    lines.push('· 只写这一段, 不要重复前面已经发生过的剧情 —— 那些在别的段落里已经有了。');
    lines.push('· 谁出场了、发生了什么、有什么冲突或转折、这一段停在哪里, 写清楚。');
    lines.push('· 不写你和用户的互动, 不写聊天, 不写评价。');
    lines.push('· 控制在 ' + SEGMENT_MAX_CHARS + ' 字以内。');
    lines.push('');
    lines.push('# 输出格式（必须严格照做，不要解释）');
    lines.push('先写 ' + ANCHOR_MARK + ' 这几个字, 空一行, 写剧情进度正文。');
    lines.push('空一行。');
    lines.push('再写 ' + SEG_MARK + ' 这几个字, 空一行, 写本段剧情正文。');
    lines.push('两段之间不要用 --- 或其他分隔线。');
    return lines.join('\n');
  }

  /**
   * 拆开"锚 + 段落"。返回 { anchor, segment }。
   *
   * ⚠️ 必须【各自独占一行】才算 —— 标题混在正文里随口提一句太常见了:
   *   模型在正文里随口写一句"剧情进度到这里就变了"很常见,
   *   宽松匹配会在这种地方把一段拦腰砍断。
   *
   * 【拆不开怎么办】整段当【段落增量】落库, 锚保持旧版。
   *   这是有意选的降级方向: 段落是【产物】(少一条就少一条), 锚是【状态】
   *   (拿旧版顶着用最多是衔接差一点点)。反过来 —— 把一整段当锚喂回去,
   *   会让后面每一段都跟着这坨东西跑偏。
   */
  function splitAnchorAndSegment(text) {
    var raw = String(text || '').replace(/\r/g, '');
    var lines = raw.split('\n');
    var ai = -1, si = -1;
    for (var i = 0; i < lines.length; i++) {
      var ln = String(lines[i] || '').replace(/^[\s　#>*=\-]+/, '').replace(/[\s　:：]*$/, '');
      if (ai < 0 && ln.indexOf(ANCHOR_MARK) === 0) ai = i;
      else if (si < 0 && ln.indexOf(SEG_MARK) === 0) si = i;
    }
    // 两个标记都在, 且顺序对 (锚在前) → 正常拆
    if (ai >= 0 && si > ai) {
      var anchor = lines.slice(ai + 1, si).join('\n').trim();
      var segment = lines.slice(si + 1).join('\n').trim();
      // 两边都得够长才算数。锚短一点没关系(它本来就该越滚越短),
      // 段落低于下限就整份作废, 因为落一条残缺的内容比不落更糟。
      if (segment.length >= MIN_SUMMARY_CHARS) {
        return { anchor: anchor || '', segment: segment };
      }
      return { anchor: anchor || '', segment: '' };
    }
    // 没认出来 → 整段当段落 (降级, 详见上面的注释)
    var fallback = stripHeadingNoise(raw);
    if (fallback.length >= MIN_SUMMARY_CHARS) return { anchor: '', segment: fallback };
    return { anchor: '', segment: '' };
  }

  /**
   * 把"锚 + 段落"这一次调用的结果分开处理 (2026-10-19)。
   * 返回 true = 这一段落库了。
   *
   * ⚠️ 锚和段落是【两条独立的命运】: 段落写坏了就少一条, 用户顶多少记一集;
   *   锚写坏了下一段衔接差一点点。所以这里不做"要么都成要么都废"的一刀切。
   */
  function applyStageSummary(text) {
    var parts = splitAnchorAndSegment(text);
    if (parts.anchor) {
      watchSession.currentPlotSummary = parts.anchor;
      watchSession.summaryUpdatedAt = Date.now();
      persistFilmAnchor(parts.anchor);
    } else if (String(text || '').trim()) {
      // 模型吐了东西但没认出标记 → 整段被降级去当段落了, 锚这次没更新。
      // 这不算错 (下一段拿旧锚顶着用), 但要让日志说实话, 便于事后核对。
      log('本轮没认出【' + ANCHOR_MARK + '】, 滚动锚保持上一版');
    }
    if (!parts.segment) {
      logWarn('阶段摘要没有可用的【' + SEG_MARK + '】正文, 本段没记上');
      return false;
    }
    return addFilmSegment(parts.segment);
  }

  /**
   * 跑一次"每 5 分钟"的总结。tickStageSummary 和"长剧播完补最后一段"共用这一条。
   *
   * 【为什么长剧播完要补】用户原话: "不足五分钟的剧情结束的时候总结一次"。
   *   播完那一刻 Live 还连着、帧还在发, 是唯一还能看到画面的时候;
   *   等用户下一轮再播, 那不到五分钟的内容就永远没人记得了。
   *   门槛设 60 秒 —— 刚开始播十秒就结束, 没什么可总结的, 别浪费一次调用。
   */
  function runStageSummary(opts) {
    var o = opts || {};
    if (S._leaving) return Promise.resolve(false);
    if (watchSession.summaryBusy || watchSession.pendingSummary) return Promise.resolve(false);
    if (!S.client || !S.client.isReady()) return Promise.resolve(false);
    if (o.minGapMs) {
      var gap = totalPlayedMs() - (watchSession.lastSummaryStartedAt || 0);
      if (gap < o.minGapMs) {
        log('距上一次总结才 ' + Math.round(gap / 1000) + 's, 这次不总结');
        return Promise.resolve(false);
      }
    }
    log('📝 ' + (o.reason || '5 分钟到') + ', 记一段剧情…');
    renderStatus('ready');
    return requestSummary('stage', buildStageSummaryInstruction())
      .then(function (text) {
        var ok = applyStageSummary(text);
        if (ok) {
          watchSession.summaryCount++;
          // ⚠️ 这行必须加 (2026-10-07 用户实测: 摘要出来了, 计数一直 0)。
          //
          // 原因: summaryCount++ 跑在【微任务】里 —— onTurnCompleteInternal
          // 里 p.resolve() 只是把回调排进微任务队列, 同一轮里紧接着的
          // finishSummary() 已经同步调过 renderPlotPanel() 了, 那次渲染
          // 读到的还是旧计数。之后再没人触发渲染, 于是计数永远停在 0,
          // 而摘要正文因为别的路径刷新过又能显示出来。
          renderPlotPanel();
          log('✅ 段落剧情已记录 (第 ' + watchSession.segCount + ' 段)');
        }
        return ok;
      })
      .catch(function (err) { logWarn('阶段摘要失败:', err.message); return false; })
      .then(function (ok) {
        finishSummary(watchSession.pendingSummary);
        flushQueuedUserText();
        return ok;
      });
  }

  /**
   * 长剧的滚动锚也落库 (2026-10-19)。
   *
   * 【为什么长剧也要存】以前长剧退出才有一份"观影记忆", 关页面就没了。
   *   现在锚是【状态】, 存下来下次进影院能接着上次看到哪儿, 而不是从零开始。
   *   跟短剧的跨场提要共用 cinemaSeriesRecap 那张表 —— 两种都是"每场一份底稿"。
   */
  function persistFilmAnchor(anchor) {
    if (watchSession.kind === 'series') return;      // 短剧的提要是合并出来的, 不走这条
    persistSeriesRecapSafely(anchor);
  }

  function tickStageSummary() {
    // ⚠️⚠️ 每一条提前 return 的分支都必须重新排下一次定时器!
    //
    // 2026-10-04 用户实测: 视频断续放了十几分钟, 一份剧情摘要都没有, 退出也没写记忆。
    // 根因就是这里原来直接 `return` 而不重新排期 —— 只要有一次 tick 撞上
    // "视频暂停 / Live 没 ready / 正在总结", 定时器就彻底断了,
    // 之后哪怕一直正常播放也永远不会再生成摘要 (退出时的最终总结也被拖死)。
    //
    // 正确写法: 统一在 finally 里 scheduleStageSummary(), 保证链子不断。
    //
    // 🔴 2026-10-23: retryInMs —— 「此刻画面」实况在途时, 摘要等它一下再跑。
    //   实况只要几秒, 不该让这一轮摘要白等 5 分钟。
    var retryInMs = 0;
    try {
      if (!S.enabled || watchSession.summaryBusy) return;
      if (S._leaving) return;              // 要退出了, 不必再排
      var video = getVideo();
      if (!video || video.paused || video.ended) return; // 暂停中, finally 会重排
      if (!S.client || !S.client.isReady()) return;      // 还没 ready, finally 会重排

      // summaryBusy 为 false 但 pendingSummary 有值 = 实况在途 (实况是静默的, 不占 summaryBusy)
      if (watchSession.pendingSummary) {
        log('[摘要] 实况还没收尾, 3 秒后再试');
        retryInMs = 3000;
        return;
      }

      runStageSummary({ reason: '5 分钟到' });
    } catch (e) {
      logWarn('阶段摘要调度异常:', (e && e.message) || e);
    } finally {
      // 本轮 5 分钟已满 → 下一轮从现在重新起算。
      // 但退房/禁用/要生成最终总结时不要再排 —— 那三种情况定时器本来就该停。
      if (S.enabled && !S._leaving) {
        watchSession.lastSummaryStartedAt = totalPlayedMs();
        scheduleStageSummary(retryInMs || undefined);
      }
    }
  }

  // ============================================================
  // 「此刻画面」实况 (2026-10-23)
  // ============================================================
  // 陪聊改走主 API 之后, 主 API 看不见画面 —— 它对剧情的认知全靠剧情记忆,
  // 而剧情记忆是 5 分钟一段, 问"刚才是怎么了"会答得粗。
  // 这一条通道让 Live 额外写一句"此刻屏幕上是谁在干什么",
  // 覆盖式存进 watchSession.liveNow, 只给主 API 当上文用。
  //
  // 【为什么覆盖式而不是数组】
  //   实况是"此刻"的快照。攒 20 条只会互相矛盾
  //   ("张三站在门口" 和 "李四坐在床上" 堆一起, 主 API 只会更懵)。
  //
  // 【优先级】摘要 > 实况。
  //   实况在摘要在途时跳过; 摘要在实况在途时等 3 秒再试 (见 tickStageSummary)。
  function buildLiveNowInstruction() {
    return [
      '【【后台任务】】用一句话说说此刻屏幕上是什么。',
      '',
      '· 只写此刻【正在发生】的事: 画面里有谁、在做什么、在什么场景。',
      '· 不要评价、不要抒情、不要评论剧情、不要提你和用户的互动。',
      '· 控制在 40 字以内, 就一句话。',
      '· 直接输出那句话本身, 不要加称呼、不要加解释。'
    ].join('\n');
  }

  function requestLiveNow() {
    if (!S.client || !S.client.isReady()) return Promise.resolve('');
    return requestSummary('live', buildLiveNowInstruction(), {
      silent: true,
      timeoutMs: LIVE_NOW_TIMEOUT_MS
    })
      .then(function (text) {
        var t = String(text || '').trim();
        if (!t) return '';
        watchSession.liveNow = { text: t, at: Date.now() };
        log('[实况] ' + t);
        return t;
      })
      .catch(function (err) {
        logWarn('[实况] 失败:', (err && err.message) || err);
        return '';
      });
  }

  function tickLiveNow() {
    if (!S.enabled || S._leaving) return;
    if (!S.client || !S.client.isReady()) return;
    if (watchSession.pendingSummary) return;   // 摘要在途 → 让路
    if (watchSession.summaryBusy) return;       // 正在写摘要 → 让路
    var video = getVideo();
    if (!video || video.paused || video.ended) return;   // 画面没动, 不用重写
    // 摘要快到期 → 这一轮实况让路 (摘要进的是剧情记忆, 优先级更高)
    var sinceAnchor = totalPlayedMs() - (watchSession.lastSummaryStartedAt || 0);
    if (sinceAnchor > WATCH_SUMMARY_INTERVAL_MS - LIVE_NOW_YIELD_BEFORE_SUMMARY_MS) return;
    requestLiveNow();
  }

  function startLiveNowLoop() {
    stopLiveNowLoop();
    S.liveNowTimer = setInterval(tickLiveNow, LIVE_NOW_INTERVAL_MS);
    log('开始「此刻画面」实况 (' + Math.round(LIVE_NOW_INTERVAL_MS / 1000) + ' 秒一次)');
  }

  function stopLiveNowLoop() {
    if (S.liveNowTimer) {
      clearInterval(S.liveNowTimer);
      S.liveNowTimer = null;
      log('已停止「此刻画面」实况');
    }
  }

  // ============================================================
  // 短剧 (2026-07 起的设计, 2026-10-19 大改)
  //
  // 【现在两条线】
  //   长剧 = 一集二三十分钟 → 每 5 分钟记一段, 影片播完补记最后一段
  //   短剧 = 一集一两分钟   → 每看完一集记一条
  //   两者都【当场落库】, 都不再等退出时统一精炼 (那个环节已经被证明会输:
  //   它是整场唯一一次长上下文调用, 会被静默判据截成开头三个字,
  //   而"非空即成功"的门槛照样放行 —— 见 onLeaveCinema 上面那段)。
  //
  // 【压缩稿是给模型看的, 不是给用户看的】
  //   短剧看到第 300 集时不可能把 300 条原文全喂给 Gemini, 上下文撑不住。
  //   所以每隔 RECAP_MERGE_EVERY 集, 把【库里】的各集压成一份跨场提要
  //   (cinemaSeriesRecap 表)。进片注入时带 "提要 + 最近几集原文"。
  //   ⚠️ 压缩【不删】原文 —— 原稿全在 cinemaEpMemories 里, 面板和导出都用它。
  // ============================================================

  // ⚠️ 2026-10-09 改: 原来是「一句话, 不超过 40 字。」
  //
  //   问题: 短剧一集 1~2 分钟, 有完整的起承转合。40 字装不下,
  //         模型只能写成"主角通过伪装接近那位大人"这种废话 ——
  //         不是模型降智, 是提示词在逼它糊弄。
  //
  //   为什么这一处该放开、而阶段摘要(1500字)和最终记忆(1000字)不该动:
  //     · 单集总结的职责是【记录】"这集演了什么"  → 要装得下
  //     · 阶段/最终总结的职责是【压缩】成长文      → 短才对
  //   三个数字本来就该是三种量级, 之前误用了同一个思路。
  var SERIES_EPISODE_HINT =
    '用 300~400 字写完整, 不要压缩成一句话短评或一句评语。' +
    '这一集的剧情以后还要当成长期记忆用, 写漏了后面就补不回来。';

  /** 记一次单集剧情。ep = 集号。**当场落库**, 不再攒在内存里等退出时统一处理。 */
  function addEpisodeMemory(ep, text) {
    var t = String(text || '').trim();
    if (!t) return false;
    // 🔴 2026-10-19 长度下限。截断过的单集记忆比没有更糟 ——
    //   存进去用户会以为这集记下来了, 不会再补。
    if (t.length < MIN_SUMMARY_CHARS) {
      logWarn('⚠️ 第 ' + ep + ' 集只总结出 ' + t.length + ' 字 (低于 ' + MIN_SUMMARY_CHARS +
        '), 当作没总结出来, 不落库');
      return false;
    }
    // 同一集重复总结(重播/重复触发) → 覆盖, 别堆两条
    var exist = null;
    for (var i = 0; i < watchSession.episodeMemories.length; i++) {
      if (watchSession.episodeMemories[i].ep === ep) { exist = watchSession.episodeMemories[i]; break; }
    }
    if (exist) {
      // 重播同一集会覆盖 —— 这是对的。但如果覆盖时长度差很多,
      // 多半是集号算错了(比如把新一集当成了旧集) → 记一条日志方便事后核对,
      // 别让它静悄悄把上一集的记忆换掉。
      var oldLen = (exist.text || '').length;
      if (oldLen && Math.abs(oldLen - t.length) > oldLen * 0.5) {
        logWarn('⚠️ 第 ' + ep + ' 集记忆被覆盖且长度变化很大 (' + oldLen + ' → ' + t.length +
          ' 字), 确认一下集号对不对');
      }
      exist.text = t;
      persistEpMemory(exist);
    }
    else {
      var item = { ep: ep, text: t, id: null };
      watchSession.episodeMemories.push(item);
      persistEpMemory(item);
    }
    watchSession.episodeMemories.sort(function (a, b) { return a.ep - b.ep; });
    if (ep > watchSession.seriesLastEp) watchSession.seriesLastEp = ep;
    clearEpisodeFail(ep);          // 这次总结出来了 → 面板上的红字撤掉
    log('📺 记下第 ' + ep + ' 集剧情 (累计 ' + watchSession.episodeMemories.length + ' 条)');
    renderPlotPanel();
    return true;
  }

  /**
   * 写一条进 cinemaEpMemories (2026-10-19)。
   *
   * 【为什么必须当场写】以前退出那一次调用是整场唯一的落盘时机, 而它会失败:
   *   用户实测它被静默 2 秒的判据截成三个字, 而"非空即成功"的门槛照样放行。
   *   现在每写出一条就落库, 页面一关、闪退、息屏都不影响 —— 退出时压根不用做这件事。
   *
   * ⚠️ 写成功后要把 id 回填到内存那条上 —— 导出后要靠 id 精确删除。
   *
   * 【为什么写失败不抛】这一层是"锦上添花", 内存那份还在。真失败要让用户看得见,
   *   但绝不能让它把整条记记忆的链子带崩 (面板要刷新、要能编辑)。
   *
   * 🔴 2026-10-21: 失败【必须记下来给面板显示】。原来只 logWarn 一句,
   *   用户完全看不出"这一集其实没存进库", 几集之后点「精炼」才撞上
   *   "库里还没有攒下的单集剧情" —— 那时候已经没法回头查是哪一集出的问题。
   */
  function persistEpMemory(item) {
    var CS = cinemaStorage();
    var key = currentSessionKey();
    if (!CS || typeof CS.saveEpMemory !== 'function' || !key) {
      notePersistFail(item.ep, !key ? '没有会话号' : '存储层不可用');
      return;
    }
    CS.saveEpMemory({
      sessionKey: key,
      kind: watchSession.kind || 'series',
      title: watchSession.seriesTitle || '',
      ep: item.ep,
      text: item.text
    }).then(function (row) {
      if (!row) {
        var why = (CS && typeof CS.getEpLastError === 'function') ? CS.getEpLastError() : '';
        logWarn('第 ' + item.ep + ' 条记忆没写进库(' + (why || '长度不够或表缺失') + '), 内存里那份还在');
        notePersistFail(item.ep, why || '长度不够或表缺失');
        renderPlotPanel();
        return;
      }
      item.id = row.id;
      clearPersistFail(item.ep);
      log('💾 第 ' + item.ep + ' 条已落库 (' + row.text.length + ' 字)');
    }).catch(function (e) {
      logWarn('记忆落库失败(不影响本次观看, 内存里那份还在):', e && e.message);
      notePersistFail(item.ep, (e && e.message) || '未知错误');
      renderPlotPanel();
    });
  }

  /** 记一条落库失败 (面板上显示, 别让用户毫无察觉)。 */
  function notePersistFail(ep, msg) {
    if (!watchSession.persistErrors) watchSession.persistErrors = [];
    for (var i = 0; i < watchSession.persistErrors.length; i++) {
      if (watchSession.persistErrors[i].ep === ep) {
        watchSession.persistErrors[i].msg = String(msg || '');
        return;
      }
    }
    watchSession.persistErrors.push({ ep: ep, msg: String(msg || '') });
  }

  /** 某一集后来写成功了 → 把它的失败记录撤掉。 */
  function clearPersistFail(ep) {
    if (!watchSession.persistErrors || !watchSession.persistErrors.length) return;
    watchSession.persistErrors = watchSession.persistErrors.filter(function (x) { return x.ep !== ep; });
  }

  /**
   * 记一条【压根没生成出来】的集 (面板上显示)。
   *
   * 🔴 2026-10-27: 跟 notePersistFail 分开。
   *   persistFail = 生成了, 但没存进库 (表坏了/库关了) → 面板说"没存进库"。
   *   episodeFail = 压根没生成 (通道被占 / 模型没回 / 太短) → 面板要说"没总结出来,
   *   重播这一集就能补上"。两种病的话术不能混, 否则用户会去查错的东西。
   */
  function noteEpisodeFail(ep, msg) {
    if (!watchSession.episodeErrors) watchSession.episodeErrors = [];
    for (var i = 0; i < watchSession.episodeErrors.length; i++) {
      if (watchSession.episodeErrors[i].ep === ep) {
        watchSession.episodeErrors[i].msg = String(msg || '');
        return;
      }
    }
    watchSession.episodeErrors.push({ ep: ep, msg: String(msg || '') });
  }

  /** 某一集后来总结出来了 → 把它的失败记录撤掉。 */
  function clearEpisodeFail(ep) {
    if (!watchSession.episodeErrors || !watchSession.episodeErrors.length) return;
    watchSession.episodeErrors = watchSession.episodeErrors.filter(function (x) { return x.ep !== ep; });
  }

  /**
   * 「库里那份」+「内存里这份」取并集, 按 ep 升序。
   *
   * 🔴 2026-10-21 用户实测的真事故:
   *   记忆页面板上明明白白摆着 3 集, 点「精炼前情提要」却说
   *   "库里还没有攒下的单集剧情, 没东西可以精炼"。
   *
   * 【根因】面板读的是【内存数组】watchSession.episodeMemories,
   *   精炼读的是【数据库】cinemaEpMemories —— 两个数据源。
   *   落库那一步一旦没成 (表自愈失败 / 草稿恢复没补写), 两边就对不上,
   *   而用户看到的正好是"面板有、库里没有"。
   *
   * 【修法】精炼不再【只信库】。库是主, 内存是兜底 ——
   *   内存里有而库里没有的, 一并算进素材, 并顺手把缺的补写进库,
   *   让库重新变成全量 (下次跨场进来也带得上)。
   *
   * @param {array} rows 库里读出来的行 [{ ep, text, id }]
   * @param {array} mem  内存里的条目 [{ ep, text, id }]
   */
  function mergeEpRows(rows, mem) {
    var list = [];
    var byEp = {};
    var i;
    var r = rows || [];
    for (i = 0; i < r.length; i++) {
      var ep = Number(r[i].ep) || 0;
      if (!ep || byEp[ep]) continue;
      if (!String(r[i].text || '').trim()) continue;
      byEp[ep] = { ep: ep, text: String(r[i].text), id: r[i].id || null };
      list.push(byEp[ep]);
    }
    var m = mem || [];
    for (i = 0; i < m.length; i++) {
      var ep2 = Number(m[i].ep) || 0;
      if (!ep2 || byEp[ep2]) continue;
      if (!String(m[i].text || '').trim()) continue;
      byEp[ep2] = { ep: ep2, text: String(m[i].text), id: m[i].id || null };
      list.push(byEp[ep2]);
    }
    list.sort(function (a, b) { return a.ep - b.ep; });
    return list;
  }

  /**
   * 长剧: 记一个 5 分钟段落 (2026-10-19)。跟单集记忆同一套落库逻辑, 只是序号自己涨。
   * 返回 false = 长度不够, 这一段没记上。
   */
  function addFilmSegment(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.length < MIN_SUMMARY_CHARS) {
      logWarn('⚠️ 这一段只总结出 ' + t.length + ' 字 (低于 ' + MIN_SUMMARY_CHARS + '), 不落库');
      return false;
    }
    watchSession.segCount += 1;
    var item = { ep: watchSession.segCount, text: t, id: null };
    watchSession.segments.push(item);
    persistEpMemory(item);
    log('📺 记下第 ' + item.ep + ' 段剧情 (累计 ' + watchSession.segments.length + ' 段)');
    renderPlotPanel();
    return true;
  }

  /**
   * 摘要通道空了吗?
   *
   * 两个条件都要满足:
   *   ① 没有在途的摘要请求 (pendingSummary)
   *   ② 没有【迟到文本静默窗口】(summaryGhostUntil) —— 那是上一个被作废的请求
   *      的尾巴还在往回吐的时间窗, 这时候发新请求, 新请求的头几个字会被它吃掉
   *      (单集记忆的开头"第 N 集，"就是这么丢的)。所以要等它过去。
   */
  function summaryChannelFree() {
    if (watchSession.pendingSummary) return false;
    if (watchSession.summaryGhostUntil && Date.now() < watchSession.summaryGhostUntil) return false;
    return true;
  }

  /** 等摘要通道空出来。返回 true = 等到了; false = 等超时了。 */
  function waitForSummaryChannel(maxMs) {
    if (summaryChannelFree()) return Promise.resolve(true);
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 200;
        if (summaryChannelFree() || waited > maxMs) {
          clearInterval(iv);
          resolve(summaryChannelFree());
        }
      }, 200);
    });
  }

  /**
   * 播完一集 → 把在途的【此刻画面·实况】作废, 把摘要通道让给单集剧情。
   *
   * 🔴 2026-10-27 优先级: 单集剧情 > 实况。
   *   实况是【可再生的快照】—— 下一轮 30 秒会重写, 丢一次无所谓;
   *   单集剧情错过就没了 (错过 = 这一集白看, 库里永远缺这一集)。
   *   所以播完这一刻, 宁可作废实况, 也要把通道空出来给单集剧情。
   *
   *   只作废 kind==='live' 的请求 —— 阶段摘要/手动精炼是别的语义, 不该在这里动。
   */
  function yieldChannelToEpisodeSummary() {
    var p = watchSession.pendingSummary;
    if (!p || p.kind !== 'live') return false;
    abortPendingSummary('影片播完, 单集剧情优先');
    return true;
  }

  /** 一集播完 → 要一条单集记忆 */
  function requestEpisodeSummary(ep) {
    if (S._leaving) return Promise.resolve('');
    if (!S.client || !S.client.isReady()) return Promise.resolve('');

    // 🔴 2026-10-27: 原来这里第三行是
    //     if (watchSession.pendingSummary) return Promise.resolve('');
    //   —— 抢不到通道就【静默放弃】: 没有日志, 没有重试, 界面上什么都看不出来,
    //   而 onVideoEnded 还会照样推进 seriesLastEp (状态条显示"看到第 N 集"),
    //   于是这一集在数据上"看过了", 库里其实根本没有。
    //   撞上的元凶是 2026-10-23 新加的「此刻画面」实况 (每 30 秒占一次通道)。
    //   现在改成【等】通道空出来再发, 最多等 EPISODE_SUMMARY_WAIT_MS。
    return waitForSummaryChannel(EPISODE_SUMMARY_WAIT_MS).then(function (ok) {
      if (!ok) {
        logWarn('第 ' + ep + ' 集没总结: 摘要通道一直被占着');
        noteEpisodeFail(ep, '摘要通道一直被占着, 没能生成出来');
        return '';
      }
      return doRequestEpisodeSummary(ep);
    });
  }

  /** 真去要一条单集记忆 (通道已经空出来了) */
  function doRequestEpisodeSummary(ep) {
    var instruction = [];
    instruction.push('【【后台任务】】你刚刚看完了' + (watchSession.seriesTitle ? '《' + watchSession.seriesTitle + '》' : '这部短剧') + '的【第 ' + ep + ' 集】。');
    // 🔴 2026-10-10 用户实测: 不写集号, 模型会自己重新编号, 把第3集写成"第一集"。
    //   它只能靠上下文猜(前面是第1、2集的记忆), 所以这里必须把真实集号【说清楚】。
    instruction.push('这是第 ' + ep + ' 集 —— 不是第 1 集, 也不是本次的第一集。');
    instruction.push('根据你刚才连续看到的画面, 写出【第 ' + ep + ' 集】讲了什么。');
    instruction.push('');
    instruction.push('必须写清这四件事:');
    instruction.push('1. 这一集出场的人物是谁(用画面里能认出来的称呼或身份, 不要叫"那位大人");');
    instruction.push('2. 发生了什么关键事件, 谁对谁做了什么;');
    instruction.push('3. 有什么冲突或转折;');
    instruction.push('4. 这一集结尾停在哪里。');
    instruction.push('');
    instruction.push(SERIES_EPISODE_HINT);
    instruction.push('');
    // ⚠️ 集号前缀: 让每条单集记忆自带"第X集"标记。
    //   这样合并总纲 / 退出精炼时, 集号跟着文字一起走, 不会散架。
    instruction.push('⚠️ 正文【第一句必须以"第 ' + ep + ' 集，"开头】, 然后接剧情。');
    instruction.push('这是为了标明集号, 不是让你重复标题, 整段就正常写下去。');
    instruction.push('');
    instruction.push('只输出正文, 不要客套、不要分析、不要"根据我的观察"这种说法。');
    if (watchSession.episodeMemories.length) {
      instruction.push('');
      instruction.push('前面已经记过的集(不要重复写, 只写这一集):');
      var recent = watchSession.episodeMemories.slice(-3);
      for (var i = 0; i < recent.length; i++) {
        instruction.push('第 ' + recent[i].ep + ' 集：' + recent[i].text);
      }
    }

    return requestSummary('episode', instruction.join('\n'))
      .then(function (text) {
        var t = (text || '').trim();
        if (!t) {
          logWarn('第 ' + ep + ' 集没总结出内容');
          noteEpisodeFail(ep, '模型这次什么都没说');
          return '';
        }
        // 🔴 2026-10-19: addEpisodeMemory 自己会卡长度下限, 返回 false 就当这次没总结出来。
        //   以前这里不看长度, 截断成三个字也照样收下并计入 seriesLastEp ——
        //   于是那一集在数据上"看过了", 但其实什么也没记下来。
        if (!addEpisodeMemory(ep, t)) {
          noteEpisodeFail(ep, '这次只总结出几个字, 太短, 没存');
          return '';
        }
        return t;
      })
      .catch(function (err) {
        logWarn('第 ' + ep + ' 集总结失败:', err.message);
        noteEpisodeFail(ep, '生成失败: ' + (err && err.message ? err.message : err));
        return '';
      });
  }

  /**
   * 短剧: 攒够 RECAP_MERGE_EVERY 集 → 把库里的各集压成一份跨场前情提要。
   *
   * 🔴 2026-10-19 整个换掉了。旧版叫 maybeMergeSeriesOutline, 干的是
   *   "攒够 20 集 → 压成总纲 → **把单集记忆丢掉**"。丢掉的理由是
   *   "信息已经进总纲了, 退出精炼时会带上总纲"。现在退出精炼整个取消,
   *   这个前提没了 —— 所以:
   *     · 读的是【库】不是内存 (跨会话也在)
   *     · 写的是 cinemaSeriesRecap (跨场底稿, 进片时喂回模型)
   *     · **一条单集记忆都不丢** —— 库是原样, 面板是原样, 导出是原样。
   *       压缩版只是"给模型看的", 不是"给用户看的"。
   *
   * 【为什么不每次都跑】一次调用十几秒, 每集都跑会拖慢看剧。
   *   RECAP_MERGE_EVERY 集一次, 代价是刚看完的头几集暂时不在提要里 ——
   *   但它们在库里, 进片注入时本来就会带上最近几集原文 (RECAP_INJECT_RECENT)。
   */
  function maybeMergeSeriesRecap() {
    if (watchSession.kind !== 'series') return Promise.resolve(false);
    var CS = cinemaStorage();
    var key = currentSessionKey();
    if (!CS || typeof CS.listEpMemories !== 'function' || !key) return Promise.resolve(false);
    if (S._leaving) return Promise.resolve(false);

    return CS.listEpMemories(key).then(function (rows) {
      // 🔴 2026-10-21: 跟手动精炼一样, 素材取【库 ∪ 内存】。
      //   只读库的话, 落库失败那几集就永远进不了提要, 而模型那边看着像"从没看过"。
      var list = mergeEpRows(rows, watchSession.episodeMemories || []);
      if (!list || list.length < RECAP_MERGE_EVERY) return false;
      // 已经覆盖到第几集了? 别反复拿同一批去压。
      var old = watchSession.seriesRecap;
      var mergedUpTo = old && Number(old.lastEp) || 0;
      var fresh = list.filter(function (r) { return (r.ep || 0) > mergedUpTo; });
      if (fresh.length < RECAP_MERGE_EVERY) return false;   // 这批没攒够, 下一集再试

      log('📖 攒够 ' + fresh.length + ' 集, 更新前情提要…');
      return runRecapMerge(old, fresh, '后台任务');
    }).catch(function (e) {
      logWarn('读单集记忆失败(忽略):', e && e.message);
      return false;
    });
  }

  /**
   * 🔴 2026-10-20 手动精炼前情提要 —— 用户要求。
   *
   * 【为什么要有这个】自动那条每攒够 RECAP_MERGE_EVERY(10) 集才跑一次。
   *   用户看 4 集就退出的话, 这部剧在模型眼里还是零认知 ——
   *   用户原话"我刚才看了四集, 因为没有前期提要, 观影模型就搁那打胡乱说"。
   *   现在随时能自己压一份, 不用等满 10 集。
   *
   * 【跟自动那条的区别】只有"什么时候跑"和"喂多少素材":
   *   · 自动: 每集播完后跑, 门槛 10 集, 只喂【新攒的】那几集 (旧的已经在提要里)
   *   · 手动: 用户点, 门槛 1 集, 喂【库里全部】还在的集 (连旧的一起重压)
   *   两条都【一条单集剧情都不删】—— 提要只是"给模型看的压缩版",
   *   库里那份才是原样, 导出也是从库里那份走。
   *
   * 【用户要的顺序】先精炼 → 再导出。
   *   因为导出成功会把库里的单集剧情【清账删掉】, 删了就没素材给精炼用了。
   *   面板上两个按钮的先后就是按这个排的, 提示里也写明了。
   */
  /**
   * 记忆页面板现在【能不能重绘】。
   *
   * ⚠️ 2026-10-20 真事故: 原来这里判的是 `!watchSession.closed && !S._leaving`。
   *   这两个标志【只有退出房间时置 true, 只有重新连上 Gemini 时才复位】——
   *   而"看完剧 → 退出 → 重进影院 → 点精炼"是用户的正常流程, 这条路上没人复位它们,
   *   于是 setRefineMsg 永远不重绘 → 点了精炼界面一点变化都没有 (用户实测"点了没动静")。
   *   更气人的是: 精炼其实跑完了 (模型调了、提要存进库了), 只是界面不刷新。
   *
   * 现在只判【房间还在不在 DOM 里】:
   *   · 退出时房间元素还在 (只是摘了 .open 类), 重绘最多刷到一个看不见的页里, 无害;
   *   · 房间真被拆干净了才不重绘 —— 那正是原来要防的"孤儿面板挂到 body 上"。
   */
  function plotPanelCanRender() {
    try {
      var room = document.getElementById('cinema-room');
      return !!(room && room.parentNode);
    } catch (e) { return false; }
  }

  /**
   * 精炼的进度/结果 —— 显示在【记忆页那一栏】。
   * ⚠️ 别只 appendSystemLine: 记忆页开着的时候聊天框是收着的, 用户看不见 →
   *   表现就是"点了没动静"(2026-10-20 真踩过)。
   */
  function setRefineMsg(text) {
    watchSession.refineMsg = String(text || '');
    // ⚠️ 重绘失败【绝不能】把精炼本身带崩 —— 一崩, 后面所有步骤都不执行,
    //   用户看到的就是"点了没动静"。所以这里吞掉异常。
    try {
      if (plotPanelCanRender()) renderPlotPanel();
    } catch (e) {
      logWarn('重绘记忆页面板失败(不影响精炼本身):', e && e.message);
    }
  }

  /**
   * 单独调一次观影模型 —— 开一个【临时的一次性 Live 会话】, 拿到文字就关掉。
   *
   * 【为什么不能直接用主会话 S.client】
   *   ① 用户要精炼的时机是"看完剧、没连接" —— 那时主会话根本不存在。
   *      原来 refineSeriesRecap 里那道 `if (!S.client || !S.client.isReady())`
   *      门把这条路整个堵死了 (用户原话"一般都是看完剧没连接的时候精炼")。
   *   ② 主会话里塞着视频帧和闲聊, 让它写提要它会"搁那打胡乱说"(用户原话)。
   *      干净的一次性会话里只有一条任务指令, 不会跑题。
   *
   * 【"观影模型"是哪台】
   *   同一个 LiveClient、同一份 buildSystemPrompt(同一个人设)、同一把 key ——
   *   调的就是那个观影模型, 只是这一次的会话里只有一条任务, 没有画面。
   *
   * 【收尾】不管成功失败都 close, 绝不留下野连接。
   */
  function callViewerModelOnce(instruction) {
    var apiKey = getGeminiKey();
    if (!apiKey) return Promise.reject(new Error('还没填 Gemini Live API Key'));
    if (typeof window.LiveClient !== 'function') return Promise.reject(new Error('live-client.js 没加载'));
    var task = String(instruction || '').trim();
    if (!task) return Promise.reject(new Error('指令是空的'));
    // ⚠️ 这一句必须【加在最后】: 指令开头是 【【后台任务】】, 观影模型的人设里
    //   认这个前缀 ("遇到这类消息时只输出正文")。前缀后面再补说明, 不影响识别。
    task += '\n\n（这一次没有画面输入，你只要处理上面这条任务。）';

    var buffer = '';
    var lastText = '';
    var gotText = false;
    var settleTimer = null;
    var hardTimer = null;
    var readyTimer = null;
    var finished = false;
    var temp = null;

    return new Promise(function (resolve, reject) {
      function cleanup() {
        if (settleTimer) clearTimeout(settleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (readyTimer) clearInterval(readyTimer);
        settleTimer = null; hardTimer = null; readyTimer = null;
        if (temp) {
          try { temp.close('一次性调用结束'); } catch (e) { /* noop */ }
          temp = null;
        }
      }
      function finish(ok, payload) {
        if (finished) return;
        finished = true;
        cleanup();
        if (ok) resolve(payload);
        else reject(new Error(String(payload || '未知错误')));
      }
      /** 连续 SUMMARY_SETTLE_MS 没新字 → 判定它说完了 (跟主会话同一套判定) */
      function armSettle() {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(function () {
          if (!gotText) return;   // 一个字都没吐 → 继续等硬超时
          log('[一次性模型] 静默 ' + (SUMMARY_SETTLE_MS / 1000) + 's, 收 (' + buffer.length + ' 字)');
          finish(true, buffer.trim());
        }, SUMMARY_SETTLE_MS);
      }
      function onText(t) {
        if (!t) return;
        gotText = true;
        buffer += takeDelta(lastText, t);   // 转写是累计全文, 必须去重
        lastText = t;
        armSettle();
      }

      temp = new window.LiveClient({
        apiKey: apiKey,
        systemPrompt: buildSystemPrompt(getCurrentChat()),
        onModelText: onText,
        // 一次性会话没有视频帧推回合, turnComplete 就是"说完了"的准信号
        // (live-client 在 turnComplete 时会先把最后一段字重抛一次, 缓冲区拿到的是全文)
        onTurnComplete: function () { if (gotText) finish(true, buffer.trim()); },
        onError: function (err) { finish(false, (err && err.message) || '模型连接出错'); },
        onState: function (state, detail) { log('[一次性模型] ' + state + (detail ? ' · ' + detail : '')); }
      });

      hardTimer = setTimeout(function () {
        // 超时: 收到过字就收已收到的, 没收到才算失败
        if (gotText) finish(true, buffer.trim());
        else finish(false, '模型没回话（超时 ' + Math.round(SUMMARY_REQUEST_TIMEOUT_MS / 1000) + 's）');
      }, SUMMARY_REQUEST_TIMEOUT_MS);

      temp.connect()
        .then(function () {
          // connect() 只保证 WebSocket 开了, 还得等 setupComplete 才算 ready
          var waited = 0;
          readyTimer = setInterval(function () {
            waited += 200;
            if (finished) { clearInterval(readyTimer); readyTimer = null; return; }
            if (temp && temp.isReady()) {
              clearInterval(readyTimer); readyTimer = null;
              if (!temp.sendUserText(task)) finish(false, '发送失败（连接没就绪）');
            } else if (waited > 20000) {
              clearInterval(readyTimer); readyTimer = null;
              finish(false, '等模型初始化超时（20s）');
            }
          }, 200);
        })
        .catch(function (err) {
          finish(false, (err && err.message) || '连接失败');
        });
    });
  }

  /**
   * 精炼期间【借用】主会话的连接位。
   *
   * 🔴 2026-10-21 用户实测: 精炼永远报 "WebSocket 连接错误", 点了无数次都连不上。
   *   根因: Gemini Live 同一把 key 的并发连接数有限。主会话一直挂着占着名额,
   *   精炼另开的那条在【握手层】就被服务端拒了 —— 浏览器 onerror 不给任何细节,
   *   只能显示一句 "WebSocket 连接错误", 用户完全看不懂。
   *   (用户原话: "不是那一次连不上, 我点了无数次都连不上" —— 因为主会话一直没断。)
   *
   * 断开时必须【清掉退避计时】并且不许自动重连 ——
   * 不然它在精炼途中连回来, 又跟一次性会话撞并发, 精炼照样失败。
   */
  function borrowMainSlot() {
    S._refineBorrowed = true;
    clearRetry();
    try { if (S.client) S.client.close('精炼前情提要: 腾出连接位'); } catch (e) { /* noop */ }
    S.client = null;
    S.enabled = false;
    try { renderStatus('closed', '精炼中, 暂时断开'); } catch (e) { /* noop */ }
  }

  /** 精炼结束 → 把主会话连回来 (走 session resumption, 对话能续上)。 */
  function restoreMainSlot(wasReady) {
    if (!S._refineBorrowed) return;
    S._refineBorrowed = false;
    if (!wasReady) return;
    if (S._leaving || S._userDisabled) return;
    log('[精炼] 把主会话连回来');
    // ⚠️ 等一下再连: 一次性会话刚 close, 服务端释放名额要一点时间。
    //   立刻连回来会再撞一次并发, 主会话自己连不上 (而且会一直重连失败)。
    setTimeout(function () {
      if (S._leaving || S._userDisabled) return;
      try {
        enable();
      } catch (e) {
        logWarn('[精炼] 主会话恢复失败:', e && e.message);
      }
    }, 800);
  }

  /**
   * 把技术错误翻译成人话。
   * "WebSocket 连接错误" 用户完全看不懂 —— 得说清楚可能是什么、可以怎么办。
   */
  function describeRefineError(msg) {
    var m = String(msg || '');
    if (/WebSocket/i.test(m)) {
      return '连不上 Gemini Live（' + m + '）。已经自动断开主会话腾过位置、也重试过一次了；' +
        '还不行就检查一下手机网络和 ⚙ 里的 API Key。';
    }
    if (/超时/.test(m)) return m + '（模型回话太慢，可以再点一次）';
    return m;
  }

  function refineSeriesRecap() {
    // 🔴 2026-10-21: 长剧也支持精炼了 (用户要求)。
    //   短剧的素材是【每集一条】, 长剧的素材是【每 5 分钟一段】——
    //   两者都存在 cinemaEpMemories 那张表里, 只是 key 不同, 所以取素材的活儿完全一样。
    var isFilm = watchSession.kind === 'film';
    if (watchSession.kind !== 'series' && !isFilm) {
      setRefineMsg('只有短剧和长剧才能精炼。');
      return Promise.resolve(false);
    }
    var unit = isFilm ? '段' : '集';
    if (watchSession.refining) {
      setRefineMsg('已经在精炼了，等一下。');
      return Promise.resolve(false);
    }
    var CS = cinemaStorage();
    var key = currentSessionKey();
    if (!CS || typeof CS.listEpMemories !== 'function' || !key) {
      setRefineMsg('读不到记忆库，没法精炼。');
      return Promise.resolve(false);
    }
    // ⚠️ 这里【不再要求 Gemini 已连接】(2026-10-20 用户要求):
    //   精炼的正常时机就是"看完剧、没连接", 原来那道 isReady() 门把这条路堵死了。
    //   现在改成【单独调一次观影模型】(临时开一个一次性会话) —— 连不连都在线都能做。
    if (!getGeminiKey()) {
      setRefineMsg('⚠️ 还没填 Gemini Live API Key（房间右上角 ⚙ 里填），调不了模型。');
      return Promise.resolve(false);
    }
    watchSession.refining = true;
    setRefineMsg('正在精炼（会单独调一次观影模型，通常十几秒，最多一分钟）…');

    // 🔴 2026-10-21 用户实测: 精炼永远报 "WebSocket 连接错误", 点了无数次都连不上。
    //
    //   【根因】Gemini Live 同一把 key 的并发连接数有限。
    //     主会话一直挂着(用户截图右上角是"已连接"), 占着唯一的名额;
    //     精炼另开的那条在【握手层】就被服务端拒了 —— 浏览器 onerror 不给任何细节,
    //     只能显示一句 "WebSocket 连接错误", 用户完全看不懂。
    //     用户原话: "不是那一次连不上, 我点了无数次都连不上" —— 因为主会话一直没断。
    //
    //   【修法】精炼时【借用】主会话的连接位:
    //     ① 精炼前把主会话断开 (腾位), 并且【不许它自动重连】——
    //        不然它在精炼途中连回来, 又跟一次性会话撞并发, 照样失败;
    //     ② 一次性会话失败时自动重试一次 (等 1.5s, 给服务端放名额的时间);
    //     ③ 精炼结束把主会话连回来 (走 session resumption, 对话能续上)。
    // ⚠️ 这里必须看【两种】状态, 不能只看 isReady():
    //   主会话正在【连接中】时也一样占着一条 WS —— 精炼另开一条照样撞并发。
    //   (用户实测: 刚进房就点精炼, 主会话还在连, 精炼必挂。)
    var mainWasLive = !!(S.client && (S.client.isReady() || S.client.state === 'connecting'));
    if (mainWasLive) {
      log('[精炼] 主会话还占着连接位(已连上或正在连), 先断开腾出来');
      borrowMainSlot();
      setRefineMsg('正在精炼（先断开 Gemini 腾位置，再单独调一次观影模型，通常十几秒，最多一分钟）…');
    }

    return CS.listEpMemories(key)
      .then(function (rows) {
        // 🔴 2026-10-21: 素材 = 库里那份 ∪ 内存里这份。
        //   原来只读库, 库一空就说"库里没有攒下的单集剧情" —— 而面板上明明摆着 3 集。
        //   长剧的内存那份在 watchSession.segments (短剧是 episodeMemories)。
        var mem = isFilm ? (watchSession.segments || []) : (watchSession.episodeMemories || []);
        var list = mergeEpRows(rows, mem);
        if (!list.length) {
          setRefineMsg('库里和这次看的都还没有攒下的' + (isFilm ? '段落' : '单集剧情') +
            '，没东西可以精炼。先' + (isFilm ? '看一会儿' : '看一集') + '再来。');
          return false;
        }
        // 内存里有、库里没有的 → 顺手补写进库, 让库重新变成全量。
        // (库读不到的时候补写会失败, 不影响这次精炼 —— 素材已经在手里了。)
        var memByEp = {};
        for (var mi = 0; mi < mem.length; mi++) memByEp[mem[mi].ep] = mem[mi];
        var missing = list.filter(function (x) { return !x.id && memByEp[x.ep]; });
        if (missing.length) {
          log('📚 内存里有 ' + missing.length + ' ' + unit + '没进库, 正在补写…');
          for (var mj = 0; mj < missing.length; mj++) persistEpMemory(memByEp[missing[mj].ep]);
        }
        var old = watchSession.seriesRecap;
        // ⚠️ runRecapMerge 内部会把调用失败吞掉只返回 false, 那样用户只看到
        //   "没精炼出来", 不知道是【模型没写完】还是【根本没连上】。
        //   这里把真实原因截下来, 失败时写给用户看。
        var callErr = '';
        var call = function (instruction) {
          return callViewerModelOnce(instruction).catch(function (err) {
            // 🔴 2026-10-21: 第一次失败自动再试一次。
            //   刚断开主会话时, 服务端可能还没把名额放出来, 等一下就好。
            log('[精炼] 第一次调用失败(' + ((err && err.message) || '未知') + '), 1.5s 后自动重试一次');
            return new Promise(function (r) { setTimeout(r, 1500); })
              .then(function () { return callViewerModelOnce(instruction); })
              .catch(function (err2) {
                callErr = describeRefineError((err2 && err2.message) || ((err && err.message) || '未知错误'));
                throw new Error(callErr);
              });
          });
        };
        return runRecapMerge(old, list, '手动精炼', call, { isFilm: isFilm }).then(function (ok) {
          if (ok) {
            var lastEp = list[list.length - 1].ep || 0;
            setRefineMsg('✅ 前情提要已精炼好（到第 ' + lastEp + ' ' + unit + '）。各' + unit + '剧情一条都没删。');
          } else if (callErr) {
            setRefineMsg('⚠️ 精炼失败：' + callErr + '（各' + unit + '剧情都还在，可以再点一次）');
          } else {
            setRefineMsg('⚠️ 这次没精炼出来（可能是模型没写完）。旧提要保持不变，可以再点一次。');
          }
          return ok;
        });
      })
      .catch(function (e) {
        logWarn('手动精炼前情提要失败(不影响单集记忆):', e && e.message);
        setRefineMsg('⚠️ 精炼失败：' + describeRefineError((e && e.message) || '未知错误') +
          '（各' + unit + '剧情都还在，可以再点一次）');
        return false;
      })
      .then(function (r) {
        watchSession.refining = false;
        // 🔴 2026-10-21: 把主会话连回来 (之前是占着连接位才借的)。
        restoreMainSlot(mainWasLive);
        if (plotPanelCanRender()) renderPlotPanel();
        return r;
      });
  }

  /**
   * 跑一次"把各集压成前情提要"的调用 —— 自动合并和手动精炼共用这一套。
   *
   * @param {object} old    旧提要整行 (可能 null)
   * @param {array}  rows  要压进去的各集 (已按 ep 升序)
   * @param {string} reason 这是在干什么 (会写进提示词让模型知道语气)
   * @param {function} [callFn] 怎么调模型。不传 = 用主会话 (自动那条),
   *   手动那条传 callViewerModelOnce —— 单独开一次会话, 不看主会话有没有连着。
   * @returns {Promise<boolean>} true = 提要已更新
   */
  function runRecapMerge(old, rows, reason, callFn, opts) {
    var list = rows || [];
    if (!list.length) return Promise.resolve(false);
    var call = callFn || function (instruction) { return requestSummary('recapMerge', instruction); };
    // 🔴 2026-10-21: 长剧也支持精炼了 (用户要求)。
    //   长剧的素材是【每 5 分钟一段】, 所以单位是"段"不是"集";
    //   旧提要从 recapText 取 (长剧那行的 text 是滚动锚, 不是提要 —— 混用会把锚冲掉)。
    var isFilm = !!(opts && opts.isFilm);
    var unit = isFilm ? '段' : '集';
    var oldText = isFilm
      ? String((old && old.recapText) || '')
      : String((old && old.text) || '');
    var lastEp = list[list.length - 1].ep || 0;
    var title = watchSession.seriesTitle || (isFilm ? '这部片子' : '这部短剧');
    var lines = [];
    // ⚠️ 指令开头固定是 【【后台任务】】(不是把 reason 塞进括号里):
    //   观影模型的人设里认这个前缀 —— "遇到这类消息时: 严格按要求输出摘要正文,
    //   不要加称呼、不要问问题、不要加评论" (见 buildSystemPrompt 末尾)。
    //   手动精炼和后台自动合并都走这一套, 所以前缀必须一样, 语气才一样。
    lines.push('【【后台任务】】' + reason + '。下面是《' + title + '》的剧情记录。');
    lines.push('请把它们合并成【一份前情提要】, 供下次继续看这部' + (isFilm ? '电影' : '剧') + '时用。');
    lines.push('');
    if (oldText) {
      lines.push('# 已经有的前情提要（旧版本，必须保留并在其基础上更新）');
      lines.push('');
      lines.push(oldText);
      lines.push('');
      lines.push('⚠️ 新写的那份是【替换】掉上面这份的，所以旧提要里的信息必须全部带上。');
      lines.push('人物、关系、关键转折要跟旧提要里写的一致，别换名字、别漏掉。');
      lines.push('');
    }
    lines.push('# 各' + unit + '剧情（到第 ' + lastEp + ' ' + unit + '为止）');
    lines.push('');
    for (var i = 0; i < list.length; i++) {
      lines.push('第 ' + list[i].ep + ' ' + unit + '：' + list[i].text);
    }
    lines.push('');
    lines.push('# 前情提要怎么写');
    lines.push('- 客观剧情、第三人称。只讲这部' + (isFilm ? '电影' : '剧') + '本身发生的事。');
    lines.push('- 连贯的一段话，不分点，不加标题，不用 --- 。');
    lines.push('- 主要人物、关键事件、重要转折、现在停在哪。');
    lines.push('- 不要写"如前所述""接着上次"这种依赖上下文的说法 —— 它必须独立完整。');
    lines.push('- 第一句写【已看到第 ' + lastEp + ' ' + unit + '】。');
    lines.push('- 控制在 ' + RECAP_MAX_CHARS + ' 字以内。');
    lines.push('');
    lines.push('直接输出前情提要正文，不要解释，不要写观影记忆。');

    return call(lines.join('\n'))
      .then(function (text) {
        var t = stripHeadingNoise(text);
        // ⚠️ 80 字下限 —— 截断过的提要比没有更糟(用户会以为存上了, 不再重试)。
        if (t.length < MIN_SUMMARY_CHARS) {
          logWarn('前情提要只写出 ' + t.length + ' 字, 当作没生成, 旧提要保持不变');
          return false;
        }
        // lastEp 传真实覆盖到的集号, 别用 seriesLastEp ——
        // 它是"播完一集才推进"的, 可能落后于库里实际攒到的集数,
        // 落后的话下一轮会拿同一批素材再压一遍。
        return persistSeriesRecapSafely(t, lastEp, isFilm).then(function (ok) {
          if (ok) log('✅ 前情提要已更新 (到第 ' + lastEp + ' ' + unit + ')');
          return ok;
        });
      })
      .catch(function (err) {
        logWarn('前情提要合并失败(不影响单集记忆, 它们都在库里):', err.message);
        return false;
      });
  }

  /** 切到短剧模式 (进剧场时由 cinema-room.js 调) */
  function setSeries(key, title) {
    var k = key || null;
    // 🔴 2026-10-15 同一部剧的每一集都会再调一次 setSeries, 所以只有【真的换了剧】
    //   才清场 —— 判据是 key 变了, 不是"调了没调"。
    var sameDrama = (watchSession.kind === 'series' && watchSession.seriesKey === k);

    if (!sameDrama) {
      // 🔴 2026-10-19 大幅简化: 换剧时其实【不需要】抢救上一部剧的记忆了。
      //   旧版那套(存草稿 → 清空)是为"退出精炼失败"的兜底, 而退出精炼整个取消,
      //   上一部剧的每集记忆当初就已经写进 cinemaEpMemories 了, 按 key 分着, 换剧碰不到。
      //   草稿机制整体留着当双保险, 但这里不再为了它额外搬一次数据 ——
      //   否则两处各存一份, 迟早对不上号。
      watchSession.episodeMemories = [];
      watchSession.segments = [];
      watchSession.segCount = 0;
      watchSession.seriesLastEp = 0;
      watchSession.nowPlayingEp = 0;
    }

    watchSession.kind = 'series';
    watchSession.seriesKey = k;
    watchSession.seriesTitle = title || '';
    prepareSeriesRecap(k);
  }

  // ============================================================
  // 跨场资料注入 (2026-10-15 起, 2026-10-19 改成读库)
  //
  // 【为什么必须有】
  //   以前每集记忆只活在内存, 退出精炼成功后 clearDraft() 一清, 下次进影院
  //   模型对这部剧是【零认知】。用户碎片时间看四集就退, 下次回来接第 5 集,
  //   它不知道前面演了什么 —— 用户原话「他总结中间剧情的时候就会有点懵逼」。
  //
  // 🔴 2026-10-19 换了个更靠得住的来源:
  //   原来这份资料是【退出那次调用】顺带产出的, 而那次调用已经被证明会输
  //   (见 onLeaveCinema 上面那段)。它现在改由后台合并产生 (短剧每
  //   RECAP_MERGE_EVERY 集压一次), 并且【一条单集记忆都不丢】——
  //   库里那份才是全量, 面板和导出都用它。
  //   buildSystemPrompt 更是在 2026-10-11 被刻意清空了 (接话降智), 绝对不能往里加东西。
  //
  // 【所以怎么注入】
  //   不碰系统提示词, 走 sendUserText —— 会话中途唯一能进模型上下文的通道
  //   (live-client.js 的 systemInstruction 只在 setup 送一次)。
  //   两个时机都要覆盖:
  //     · 进影院时 Live 还没连 → 置 seriesRecapInjectPending, 等 onClientState('ready')
  //     · 已经在看片才切剧 → Live 是 ready 的, 直接发
  //   requestSummary 会把模型那句回话收进自己的 buffer (handleModelText 里
  //   pendingSummary 分支 return 掉了), 所以不会漏进气泡。
  // ============================================================

  // ⚠️ MEMORY_MARK 已于 2026-10-19 随「退出精炼」一起删掉 ——
  //   退出不再生成观影记忆, 也就没有要拆的那个标题了。
  var RECAP_MARK = '【前情提要】';        // 提示词里提到它, 让模型别用别的写法
  var RECAP_MAX_CHARS = 1800;

  // 🔴 2026-10-19 每 5 分钟那次调用出两份时用的两个标记。
  //   一次调用出两份 (而不是分两次调) 的理由跟当初退出那次的完全一样:
  //   两份吃的是同一批画面, 分两次调反而可能各写各的、前后对不上。
  //   代价是排版可能跑偏 → splitAnchorAndSegment() 兜住, 认不出标记就整段
  //   当段落增量落库, 锚保持旧版 (牺牲一点连贯, 不丢数据)。
  var ANCHOR_MARK = '【剧情进度】';
  var SEG_MARK = '【本段剧情】';

  // 短剧攒够多少集, 后台把【已落库的各集】压成一份跨场前情提要。
  // ⚠️ 它跑在【每集播完之后】那条后台链上, 绝不在退出路径上 —— 退出要秒退。
  // 🔴 2026-10-21 用户要求: 10 集太久 (用户原话"10集才自动总结久了点, 5集精炼差不多")
  //   → 改成 5 集。手动那条(按钮)还是随时能点, 门槛 1 集。
  var RECAP_MERGE_EVERY = 5;
  // 短剧进片时, 除了提要还带上最近几集的原文 (提要是压缩版, 最近几集保精度)。
  var RECAP_INJECT_RECENT = 3;
  // 长剧进片时带最近几段原文 (长剧没有合并提要, 全靠这些段落撑上下文)。
  var FILM_INJECT_RECENT = 4;
  // 一条导进长期记忆的上限 —— 超了就切成多条。
  // 一条上万字塞进 longTermMemory 会把检索和后面的精炼都拖垮。
  var EXPORT_CHUNK_CHARS = 2000;


  /**
   * 拿存储层, 拿不到就当没有。
   * 用 typeof 判 window 而不是直接读 —— 抠源码跑逻辑测试时 (check-series-memory.cjs
   * 正是把这一段原样抠出来在 Node 里跑的) 根本没有 window, 直接读会 ReferenceError
   * 把 setSeries 整个炸掉。
   */
  function cinemaStorage() {
    return (typeof window !== 'undefined' && window.CinemaStorage) || null;
  }

  /**
   * 切剧 / 进片时把这次的跨场资料读出来 (2026-10-19 大改)。
   *
   * 【以前只读一份压缩稿】而且那份还是退出时顺带产出的 —— 退出精炼取消后就没人写了。
   * 【现在读两样】
   *   ① cinemaSeriesRecap  压缩底稿 (后台合并/滚动出来的), 大而全, 但有损
   *   ② cinemaEpMemories   逐集/逐段原文, 完整但只能带最近几集
   * 两样互补: 底稿管"整部戏走到哪", 原文管"最近几集/几段的细节不能丢"。
   *
   * 顺带把②灌进内存 —— 用户原话"没导出的就留着继续看",
   * 所以退出再进来面板上必须还看得见上次那几集。
   *
   * 短剧 (isSeries=true) 走 setSeries → prepareSeriesRecap;
   * 长剧走 prepareFilmContext (进影院/切角色时)。两边共用 loadCrossSession。
   */
  function prepareSeriesRecap(key) {
    loadCrossSession(key ? String(key) : '', true);
  }

  /** 长剧: 进影院 / 切角色时把上次看到哪捞回来。 */
  function prepareFilmContext() {
    var k = currentSessionKey();
    if (!k) { watchSession.seriesRecapInjectPending = false; return; }
    loadCrossSession(k, false);
  }

  function loadCrossSession(k, isSeries) {
    if (!k) {
      watchSession.seriesRecap = null;
      watchSession.seriesRecapInjectPending = false;
      return;
    }
    // 同步先把上一部残留的清掉 —— 慢一拍读回来也会串台
    watchSession.seriesRecap = null;
    watchSession.seriesRecapInjectPending = true;

    var CS = cinemaStorage();
    if (!CS || typeof CS.loadSeriesRecap !== 'function') {
      watchSession.seriesRecapInjectPending = false;   // 表都还没有, 后面也不会有
      return;
    }
    // 记下这次的会话号: 切得比读盘快的话, 这一行的结果就过期了, 必须丢掉
    var mine = watchSession.watchSessionId;
    var stillMine = function () {
      return watchSession.watchSessionId === mine && currentSessionKey() === k;
    };

    var gotRecap = false, gotEps = false;

    CS.loadSeriesRecap(k).then(function (row) {
      if (!stillMine()) return;
      watchSession.seriesRecap = row || null;
      if (row && (row.text || '').trim()) {
        log('📖 读到跨场提要 (' + (row.text || '').length + ' 字)');
      }
      gotRecap = true;
      renderPlotPanel();
      tryInject();
    }).catch(function (e) {
      logWarn('读跨场提要失败(忽略):', e && e.message);
      gotRecap = true;
      tryInject();
    });

    if (typeof CS.listEpMemories === 'function') {
      CS.listEpMemories(k).then(function (rows) {
        if (!stillMine()) return;
        var n = mergeLoadedEpisodes(rows, isSeries);
        if (n) log('📚 读到已存的 ' + n + ' 条剧情记录');
        // 已存的最大序号要往前推, 否则"看到第几集"会显示成 0
        var maxEp = 0;
        for (var i = 0; i < (rows || []).length; i++) {
          if ((rows[i].ep || 0) > maxEp) maxEp = rows[i].ep;
        }
        if (isSeries) {
          if (maxEp > watchSession.seriesLastEp) watchSession.seriesLastEp = maxEp;
        } else if (maxEp > watchSession.segCount) {
          watchSession.segCount = maxEp;
        }
        gotEps = true;
        renderPlotPanel();
        tryInject();
      }).catch(function (e) {
        logWarn('读已存剧情记录失败(忽略):', e && e.message);
        gotEps = true;
        tryInject();
      });
    } else {
      gotEps = true;
    }

    function tryInject() {
      if (!gotRecap || !gotEps) return;
      var rec = watchSession.seriesRecap;
      var pool = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
      // ⚠️ 2026-10-21: 长剧有两个字段, 提要(recapText)和锚(text)都算"有东西要注入"。
      var hasRecap = isSeries
        ? !!(rec && (rec.text || '').trim())
        : !!((rec && (rec.text || '').trim()) || (rec && (rec.recapText || '').trim()));
      if (hasRecap || pool.length > 0) {
        maybeInjectSeriesRecap();
      } else {
        // 第一次看。pending 必须落闸 —— 留着它的话以后每次
        // Live ready 都会白跑一趟 maybeInjectSeriesRecap。
        watchSession.seriesRecapInjectPending = false;
      }
    }
  }

  /**
   * 把库里读回来的逐集记录并进内存。
   *
   * ⚠️ 冲突时【以库里的为准】—— 库是每集当场写的落盘版本, 而内存里那份可能
   *   是同一场里被手动编辑过、还没落库的新版。所以顺序是:
   *   先把内存里库中没有的塞进去, 再用库里的行覆盖同序号的。
   *
   * ⚠️ id 必须一起带过来 —— 导出成功后要靠它精确删掉"刚导出的那几行"。
   *   没有 id 就只能整片清空, 那会把没导出的也一起弄丢。
   */
  function mergeLoadedEpisodes(rows, isSeries) {
    if (!rows || !rows.length) return 0;
    var pool = isSeries
      ? (watchSession.episodeMemories || (watchSession.episodeMemories = []))
      : (watchSession.segments || (watchSession.segments = []));
    var byEp = {};
    var i;
    for (i = 0; i < pool.length; i++) byEp[pool[i].ep] = pool[i];   // 先记内存
    var added = 0;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var ep = Number(r.ep) || 0;
      if (!ep || !(r.text || '').trim()) continue;
      if (byEp[ep]) {
        byEp[ep].text = r.text;
        if (r.id) byEp[ep].id = r.id;
      } else {
        pool.push({ ep: ep, text: r.text, id: r.id || null });
        added++;
      }
    }
    pool.sort(function (a, b) { return a.ep - b.ep; });
    return added;
  }

  /** Live 早就连着 (中途切剧) → 立刻注入; 还没连 → 留给 onClientState('ready')。 */
  function maybeInjectSeriesRecap() {
    if (!watchSession.seriesRecapInjectPending) return;
    if (!S.client || !S.client.isReady()) return;     // 等 ready
    injectSeriesRecap();
  }

  /**
   * 把跨场资料作为一个回合塞进 Live 上下文。模型的回话被 requestSummary 收走, 不进气泡。
   *
   * 🔴 2026-10-19: 喂的不再只是那份压缩稿, 而是【压缩稿 + 最近几集原文】。
   *   压缩稿是后台合并出来的, 有损 —— 人物关系、关键转折在, 但最近几集的
   *   具体细节已经被压掉了。所以再补几集原文, 两边对上。
   *
   * 【为什么短剧和长剧带不同数量】短剧有压缩稿打底, 补 3 集就够;
   *   长剧没有合并提要 (锚本来就是覆盖式的), 全靠段落原文撑着, 所以补 4 段。
   */
  function injectSeriesRecap() {
    if (watchSession.seriesRecapInjectPending === false) return;
    watchSession.seriesRecapInjectPending = false;    // 先落闸, 防重入

    var isSeries = watchSession.kind === 'series';
    var rec = watchSession.seriesRecap;
    // 🔴 2026-10-21: 长剧那一行有两个字段 ——
    //   text(滚动锚) + recapText(整部戏的提要)。两个都要喂给模型:
    //   提要管"整体讲了什么", 锚管"现在停在哪"。短剧只有一个字段, 还是老样子。
    var recapText = isSeries
      ? String((rec && rec.text) || '').trim()
      : String((rec && rec.recapText) || '').trim();
    var anchorText = isSeries ? '' : String((rec && rec.text) || '').trim();
    var pool = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
    var recentN = isSeries ? RECAP_INJECT_RECENT : FILM_INJECT_RECENT;
    var recent = pool.slice(-recentN);
    if (!recapText && !anchorText && !recent.length) return;      // 第一次看, 没东西可喂

    var title = (rec && rec.title) || watchSession.seriesTitle || (isSeries ? '这部短剧' : '这部片子');
    var instruction = [];
    instruction.push('【【后台任务】】《' + title + '》我们之前看过一部分。这是那部分的剧情进度，请记住：');
    instruction.push('');
    if (recapText) {
      instruction.push('# 前情提要（压缩版，讲这部' + (isSeries ? '剧' : '电影') + '整体讲了什么）');
      instruction.push('');
      instruction.push(recapText);
      instruction.push('');
    }
    if (anchorText) {
      instruction.push('# 剧情进度（上次看到哪）');
      instruction.push('');
      instruction.push(anchorText);
      instruction.push('');
    }
    if (recent.length) {
      instruction.push('# ' + (isSeries ? '最近几集的剧情原文' : '最近几个段落的剧情原文'));
      instruction.push('');
      for (var i = 0; i < recent.length; i++) {
        instruction.push((isSeries ? ('第 ' + recent[i].ep + ' 集：') : ('第 ' + recent[i].ep + ' 段：')) + recent[i].text);
      }
      instruction.push('');
    }
    instruction.push('这是背景资料，不是现在要讨论的内容。');
    instruction.push('看完只回一个字「好」，不要复述、不要评论、不要提问、不要接着往下说剧情。');

    log('📖 注入跨场资料 (' + (recapText ? '提要 ' + recapText.length + ' 字 + ' : '') +
      (anchorText ? '进度 ' + anchorText.length + ' 字 + ' : '') +
      '最近 ' + recent.length + ' ' + (isSeries ? '集' : '段') + ')');

    requestSummary('recap', instruction.join('\n'))
      .then(function () { log('✅ 跨场资料已喂给模型'); })
      .catch(function (err) { logWarn('跨场资料注入失败(忽略):', err && err.message); });
  }


  /** 剥掉模型可能加的标题行 / 分隔线 */
  function stripHeadingNoise(text) {
    var t = String(text || '').trim();
    // ⚠️ 2026-10-21: 长剧的提要模型会写"已看到第 N 段"(不是"集") —— 一起认掉。
    t = t.replace(/^[【\[]?\s*(前情提要|已看到第\s*\d+\s*[集段])\s*[】\]]?\s*[:：]?\s*/i, '');
    t = t.replace(/^[-=—*#]{2,}\s*/, '');
    return t.trim();
  }


  /**
   * 写跨场提要 (2026-10-19: 短剧是合并出来的前情提要, 长剧是滚动锚)。
   * 返回 Promise<boolean>，**永远不 reject** —— 调用方不用包 try。
   *
   * key 统一走 currentSessionKey(): 短剧 = 系列文件夹名, 长剧 = 'film:'+chatId。
   * 两种都存在 cinemaSeriesRecap 这张表里 —— 它本来就是"每场观看一份跨场底稿"。
   */
  function persistSeriesRecapSafely(recapText, lastEpOverride, isFilmRecap) {
    try {
      var text = String(recapText || '').trim();
      var key = currentSessionKey();
      var isSeries = watchSession.kind === 'series';
      if (!text || !key) return Promise.resolve(false);
      var CS = cinemaStorage();
      if (!CS || typeof CS.saveSeriesRecap !== 'function') return Promise.resolve(false);

      // 🔴 2026-10-21: 长剧那一行有两个字段, 语义不同 ——
      //   text = 滚动锚("上次看到哪") / recapText = 整部戏的提要。
      //   存储层是【合并写】, 所以这里【只传要改的那个字段】:
      //   · 写提要 (isFilmRecap) → 只传 recapText → 锚在 text 里原样保住
      //   · 写锚   (长剧 persistFilmAnchor / 短剧提要) → 只传 text → 提要保住
      var rec = {
        key: key,
        title: watchSession.seriesTitle || ''
      };
      if (isFilmRecap) {
        rec.recapText = text;
        rec.recapLastEp = lastEpOverride != null
          ? (Number(lastEpOverride) || 0)
          : (watchSession.segCount || 0);
      } else {
        rec.text = text;
        // ⚠️ 2026-10-20 lastEpOverride: 手动精炼时传【真实覆盖到的集号】。
        //   不传就退回 seriesLastEp —— 那个是"播完一集才推进"的, 可能落后于
        //   库里实际攒到的集数, 落后的话下一轮会拿同一批素材再压一遍。
        rec.lastEp = isSeries
          ? (lastEpOverride != null ? (Number(lastEpOverride) || 0) : (watchSession.seriesLastEp || 0))
          : (watchSession.segCount || 0);
      }

      return CS.saveSeriesRecap(rec).then(function (row) {
        if (!row) return false;
        watchSession.seriesRecap = row;          // 面板立刻显示新的
        log('📖 跨场提要已存 (' + text.length + ' 字' +
          (isFilmRecap ? ', 到第 ' + (row.recapLastEp || 0) + ' 段' :
            (isSeries ? ', 到第 ' + (row.lastEp || 0) + ' 集' : '')) + ')');
        // ⚠️ 退出流程里这条回调可能跟 hardLeave() 只差几十毫秒, 那时房间已经在拆。
        //   renderPlotPanel() 里的 ensurePlotPanel() 发现元素被摘了就【重新造一个
        //   挂回 DOM】, 房间已经不在就 fallback 挂 document.body —— 主页面上会留个
        //   孤儿面板。房间真不在了才不刷面板 (内存里的值已经记好了, 下次进来照样读得到)。
        //   ⚠️ 判据是"房间还在不在", 不是 watchSession.closed —— 后者退出后一直是 true,
        //   而用户退出后再进影院是常态, 拿它当判据会让界面永远不刷新 (2026-10-20 真踩)。
        if (plotPanelCanRender()) renderPlotPanel();
        return true;
      }).catch(function (e) {
        logWarn('跨场提要写入失败(单集/分段记忆都不受影响):', e && e.message);
        return false;
      });
    } catch (e) {
      logWarn('跨场提要写入异常(单集/分段记忆都不受影响):', e && e.message);
      return Promise.resolve(false);
    }
  }

  /**
   * 用户手动删除这次的跨场提要 (短剧前情提要 / 长剧"上次看到哪" / 长剧"整部剧情提要")。
   *
   * @param {string} [field] 只删这一个字段 ('text' = 锚, 'recapText' = 提要)。
   *   不传 = 整行删 (短剧只有一个字段, 等价于删 text)。
   */
  function deleteCurrentSeriesRecap(field) {
    var key = currentSessionKey();
    if (!key) return Promise.resolve(false);
    var CS = cinemaStorage();
    if (!CS || typeof CS.deleteSeriesRecap !== 'function') return Promise.resolve(false);
    return CS.deleteSeriesRecap(key, field).then(function (ok) {
      if (ok) {
        if (field && watchSession.seriesRecap) {
          // ⚠️ 2026-10-21: 只清了一个字段 —— 另一个必须留着。
          //   长剧这一行里 text=滚动锚、recapText=提要, 删一个不许连坐。
          watchSession.seriesRecap[field] = '';
          if (field === 'text') watchSession.seriesRecap.lastEp = 0;
          if (field === 'recapText') watchSession.seriesRecap.recapLastEp = 0;
          log('🗑 已删除' + (field === 'text' ? '「上次看到哪」' : '「整部剧情提要」'));
        } else {
          watchSession.seriesRecap = null;
          log('🗑 已删除跨场提要');
        }
        renderPlotPanel();
      }
      return ok;
    }).catch(function (e) {
      logWarn('删跨场提要失败:', e && e.message);
      return false;
    });
  }

  function stopStageSummary() {
    if (watchSession.summaryTimer) {
      clearTimeout(watchSession.summaryTimer);
      watchSession.summaryTimer = null;
    }
  }



  // ============================================================
  // 未总结草稿 (2026-10-10)
  //
  // 起因: 用户实测 —— API 临时抽风导致退出总结失败, 两集白看, 退出后什么都没留下。
  //   (旧设计把"退出时总结"当成唯一落盘点, 它失败 = 整场丢失)
  //
  // 现在: 退出改为【手动生成 + 失败可重试】(数据不清), 但用户也可能
  //   "这次 API 不行, 我先退出, 等换个时间再来总结"。
  //   所以补一层 localStorage 草稿兜底:
  //     · 任何"要离开但长期记忆还没写成功"的时刻 → 存草稿
  //     · 下次进影院自动恢复 → 用户再点一次生成
  //     · 【精炼成功才清草稿】(用户原话: "总结精炼完了才清记录")
  //
  // 为什么存 localStorage 而不是新建 Dexie 表:
  //   草稿是"当前这次没总结完的临时数据", 不需要跨设备同步/索引查询。
  //   localStorage 同步读写几百 KB 完全够, 而且【不用 bump db schema】——
  //   避开了 init-db-schema.js ?v= 那道容易忘、忘了一定出真机事故的坎。
  // ============================================================
  var DRAFT_KEY = 'cinema_watch_draft';
  var DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天没动就当过期, 免得长期占地方

  /** 这次观影有没有"值得留一手"的东西 (各集 / 各段 / 滚动锚) */
  function draftHasContent() {
    return ((watchSession.episodeMemories && watchSession.episodeMemories.length > 0) ||
      (watchSession.segments && watchSession.segments.length > 0) ||
      !!(watchSession.currentPlotSummary || '').trim());
  }

  /**
   * 把当前没导出的东西存成本地草稿。幂等(覆盖写), 反复调无害。
   *
   * ⚠️ 2026-10-19 它已经【不是唯一活命稻草】了 —— 每条记忆当场就落了 Dexie。
   *   草稿现在的定位是"表万一自愈失败时的第二道保险", 以及保住 chatLog
   *   (聊天记录不入库, 它只对同一场观看有意义)。用户明确要求留着。
   */
  function saveDraft() {
    if (!draftHasContent()) return;
    try {
      var draft = {
        chatId: watchSession.chatId,
        kind: watchSession.kind,
        seriesKey: watchSession.seriesKey,
        seriesTitle: watchSession.seriesTitle,
        seriesLastEp: watchSession.seriesLastEp,
        nowPlayingEp: watchSession.nowPlayingEp,
        segCount: watchSession.segCount,
        segments: watchSession.segments,
        episodeMemories: watchSession.episodeMemories,
        currentPlotSummary: watchSession.currentPlotSummary,
        chatLog: watchSession.chatLog,
        savedAt: Date.now()
      };
      var json = JSON.stringify(draft);
      localStorage.setItem(DRAFT_KEY, json);
      log('💾 已存草稿 (' + (watchSession.episodeMemories || []).length + ' 集 / ' +
        (watchSession.segments || []).length + ' 段, ' + Math.round(json.length / 1024) + 'KB)');
    } catch (e) {
      // QuotaExceeded 等 —— 草稿存不下【绝不能影响正常退出】, 只记日志
      logWarn('存草稿失败(不影响退出):', e.message);
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
  }

  /** 读草稿。空 / 过期 / 损坏 / 无有效内容 → null (并顺手清掉无效的)。 */
  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || (!Array.isArray(d.episodeMemories) && !Array.isArray(d.segments))) {
        clearDraft(); return null;
      }
      var noEps = !Array.isArray(d.episodeMemories) || !d.episodeMemories.length;
      var noSegs = !Array.isArray(d.segments) || !d.segments.length;
      if (noEps && noSegs && !(d.currentPlotSummary || '').trim()) {
        clearDraft(); return null;
      }
      if (Date.now() - (d.savedAt || 0) > DRAFT_TTL_MS) { clearDraft(); return null; }
      return d;
    } catch (e) {
      logWarn('读草稿失败(忽略):', e.message);
      return null;
    }
  }

  /**
   * 进影院时把草稿里的东西捡回来。
   *
   * 只在 setChat (进影院 / 切角色) 时调 —— 【换片时不恢复】:
   *   换片是用户主动开始看新的, 旧草稿该继续留着等他处理。
   *
   * 🔴 2026-10-19 加了去重: 库里那份会通过 loadCrossSession 先进来,
   *   草稿再来一遍就会变成"同集两条"。所以这里不是直接赋值,
   *   而是【库里有就跳过】—— 库那份是当场落盘的, 比草稿新。
   */
  function restoreDraft() {
    var d = loadDraft();
    if (!d) return false;
    if (d.chatId && watchSession.chatId && d.chatId !== watchSession.chatId) return false;

    var isSeries = (d.kind || 'film') === 'series';

    // ⚠️ 2026-10-21: kind / seriesKey / seriesTitle 必须【先于】下面的补写落库设好。
    //   persistEpMemory 用 currentSessionKey() 取 key, 短剧是 seriesKey ——
    //   顺序反了就写成 'film:xxx' 去了, 库里按短剧 key 永远查不到这集。
    watchSession.kind = d.kind || 'film';
    watchSession.seriesKey = d.seriesKey || null;
    watchSession.seriesTitle = d.seriesTitle || '';

    var pool = isSeries
      ? (watchSession.episodeMemories || (watchSession.episodeMemories = []))
      : (watchSession.segments || (watchSession.segments = []));
    var byEp = {};
    var i;
    for (i = 0; i < pool.length; i++) byEp[pool[i].ep] = pool[i];

    var added = 0;
    var addedItems = [];
    var addFrom = isSeries ? (d.episodeMemories || []) : (d.segments || []);
    for (i = 0; i < addFrom.length; i++) {
      var it = addFrom[i];
      var ep = Number(it.ep) || 0;
      if (!ep || !(it.text || '').trim()) continue;
      if (byEp[ep]) continue;          // 库里已有 → 跳过, 不重复
      byEp[ep] = { ep: ep, text: it.text, id: it.id || null };
      pool.push(byEp[ep]);
      addedItems.push(byEp[ep]);
      added++;
    }
    pool.sort(function (a, b) { return a.ep - b.ep; });

    // 🔴 2026-10-21 补写: 草稿恢复出来的条目【当场补进库】。
    //   原来只塞进内存 —— 面板上看得见, 库里却没有, 于是点「精炼前情提要」
    //   就报"库里还没有攒下的单集剧情"(用户 2026-10-21 实测)。
    //   补写失败也不拦着恢复: 内存那份还在, 精炼那条路现在会拿内存兜底。
    for (i = 0; i < addedItems.length; i++) {
      try { persistEpMemory(addedItems[i]); } catch (e) { /* noop */ }
    }

    if (isSeries && (d.seriesLastEp || 0) > watchSession.seriesLastEp) {
      watchSession.seriesLastEp = d.seriesLastEp || 0;
    }
    watchSession.nowPlayingEp = d.nowPlayingEp || 0;
    if (!isSeries && (d.segCount || 0) > watchSession.segCount) {
      watchSession.segCount = d.segCount || 0;
    }
    if (!(watchSession.currentPlotSummary || '').trim()) {
      watchSession.currentPlotSummary = d.currentPlotSummary || '';
    }
    if (Array.isArray(d.chatLog) && d.chatLog.length) {
      watchSession.chatLog = watchSession.chatLog.length ? watchSession.chatLog : d.chatLog;
    }

    if (!added && !(d.chatLog || []).length) return false;
    log('↩️ 从草稿恢复了 ' + added + ' 条' + (isSeries ? '集' : '段'));
    appendSystemLine('↩️ 上次的剧情记录已经帮你恢复好了，攒着的都在下面「记忆」里。');
    renderPlotPanel();
    return true;
  }

  // ============================================================
  // session resumption / 重连
  // 迁移自旧文件 :851-909
  // ============================================================
  /**
   * 存档点自愈 (2026-10-04 用户反馈: 每次刷新都得手动点"清除断线存档点")
   *
   * 原来的死循环: 只要服务端发了 handle 就存 —— 包括那种马上就要断的连接。
   *   连上 → 发 H1 → 存 H1 → 秒断 → 刷新拿 H1 连 → 认不出 → 又发 H2 → 存 H2 …
   *   存档点一直在被污染, 所以永远得手动清。
   *
   * 现在两道保险:
   *   1) 带时间戳, 超过 HANDLE_TTL_MS 的一律不用(服务端早过期了)
   *   2) 只在连接【真的 ready 且没在抖动】时才存新 handle
   */
  var HANDLE_TTL_MS = 10 * 60 * 1000;

  function loadHandle() {
    try {
      var raw = localStorage.getItem(HANDLE_KEY);
      if (!raw) return '';
      var o;
      try { o = JSON.parse(raw); } catch (e) { saveHandle(null); return ''; }
      // 兼容早期存的裸字符串格式
      if (typeof o === 'string') { saveHandle(o); return Date.now() < HANDLE_TTL_MS ? o : ''; }
      if (!o || !o.handle) return '';
      if (Date.now() - (o.at || 0) > HANDLE_TTL_MS) {
        log('存档点已过期 (' + Math.round((Date.now() - (o.at || 0)) / 60000) + ' 分钟), 改用全新会话');
        saveHandle(null);
        return '';
      }
      return o.handle;
    } catch (e) { return ''; }
  }

  function saveHandle(h) {
    try {
      if (h) localStorage.setItem(HANDLE_KEY, JSON.stringify({ handle: h, at: Date.now() }));
      else localStorage.removeItem(HANDLE_KEY);
    } catch (e) { /* noop */ }
  }
  function clearRetry() {
    _retryCount = 0;
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  }

  // 等 Live 就绪的最长时间 (ms)。超过就认失败。
  // 不能无限等 —— 那会让用户看着界面一直转。
  var WAIT_READY_MS = 20000;

  /**
   * 轮询等 Live 连接就绪。resolve(true)=连上了, resolve(false)=超时。
   * 每 500ms 看一次; 用户手动 disable 或离开房间会提前退出。
   *
   * ⚠️ 2026-10-19 一度被当成"手动生成观影记忆"的配套代码整段删掉了,
   *   结果 scheduleReconnect 里还在调它 —— 那个函数只有重连这一条路径在用,
   *   一删就是一断线就抛 ReferenceError。这里补回来, 别再当死代码清。
   */
  function waitUntilReady(ms) {
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 500;
        if (S.client && S.client.isReady()) { clearInterval(iv); resolve(true); return; }
        // 用户主动停用 / 离开了 → 别傻等
        if (S._userDisabled || S._leaving || !S.enabled) { clearInterval(iv); resolve(false); return; }
        if (waited >= ms) { clearInterval(iv); resolve(false); }
      }, 500);
    });
  }

  /**
   * 连接被意外断开 → 安排重连 (指数退避)。
   *
   * ⚠️ 2026-10-04 修的坑: 原来只要"重连成功"就 clearRetry() 把退避清回 2s。
   *    但 Gemini Live 连上就被服务端掐掉时, 会变成
   *      断 → 2s → 连上 → 又断 → 2s → … 永远卡在最短退避, 疯狂刷屏。
   *    现在改成: 只有"连上后稳定活够 FLAP_STABLE_MS"才算真的恢复, 才清零。
   */
  var FLAP_STABLE_MS = 15000;   // 连续在线 15s 才算稳

  function scheduleReconnect(reason) {
    if (S._userDisabled || S._leaving) return;
    // 🔴 2026-10-21: 精炼期间主会话的连接位借给一次性会话了,
    //   这时候连回来就是自己撞自己 —— 精炼完 restoreMainSlot() 会重新连。
    if (S._refineBorrowed) {
      log('[精炼] 精炼期间不排重连 (连接位借给一次性会话了)');
      return;
    }

    // 抖动检测: 上次连接没活够 FLAP_STABLE_MS 就断了 → 不清零, 继续往上加退避
    var lived = S.connectedAt ? (Date.now() - S.connectedAt) : 0;
    var flapped = !!S.connectedAt && lived < FLAP_STABLE_MS;
    flapLast = flapped;
    if (flapped) {
      logWarn('连接只活了 ' + Math.round(lived / 1000) + 's 就断, 判定为抖动, 退避继续加长');
    }

    if (_retryCount >= MAX_RETRY) {
      logWarn('重连次数用完 (' + MAX_RETRY + '), 放弃自动重连');
      appendSystemLine('⚠️ 连续重连 ' + MAX_RETRY + ' 次仍失败，已停止自动重连。原因：' + reason +
        '　可以在房间右上角 ⚙「设置」里确认 key 是否填对。');
      renderStatus('closed', '重连失败');
      return;
    }
    var delay = RETRY_BASE_MS * Math.pow(2, _retryCount);
    _retryCount++;
    logWarn('安排重连 (' + _retryCount + '/' + MAX_RETRY + '), ' + Math.round(delay / 1000) + 's 后重试, 原因: ' + reason);
    appendSystemLine('🔄 连接断开（' + reason + '），' + Math.round(delay / 1000) + ' 秒后重连…');
    renderStatus('connecting', '重连中 ' + _retryCount + '/' + MAX_RETRY);
    if (_retryTimer) clearTimeout(_retryTimer);
    _retryTimer = setTimeout(function () {
      _retryTimer = null;
      if (!S.enabled || S._userDisabled || S._leaving) return;
      if (!S.client) { enable(); return; }

      // 🔴 2026-10-16 用户实测「连了断了连, 最后彻底连不上」的根因。
      //
      //   原来写的是 `reconnect().then(function (ok) { if (ok) { …报成功… } })`,
      //   但 reconnect() 返回的是 connect() 的 Promise, 而 connect() 在
      //   **ws.onopen** 就 resolve 了 —— 而且 resolve 的是【客户端实例本身】,
      //   不是布尔值 (live-client.js:191 `resolve(self)`)。
      //   于是 `ok` 永远为真 → 每次重连都报"✅ 重连成功, 上下文已恢复"并重启帧循环,
      //   哪怕 setupComplete 根本没来、服务端下一秒就关掉了。
      //   外面看日志全是绿的, 实际是个死连接 —— 用户完全看不出发生了什么。
      //
      //   修法: socket 打开【不等于】会话可用, 必须等 isReady() 真的为真。
      S.client.reconnect()
        .then(function () { return waitUntilReady(WAIT_READY_MS); })
        .then(function (ready) {
          if (!ready) {
            logWarn('重连后 ' + Math.round(WAIT_READY_MS / 1000) + 's 内没进入可发送状态, 按失败处理');
            // 这种连接多半是拿废存档点续上来的。清掉它 —— 注意要【连客户端对象里那个
            // 一起清】, 只删 localStorage 没用: 下次 reconnect() 读的是 this._resumeHandle,
            // 它还留着那个废 handle, 于是永远拿同一个死 handle 去续, 死循环。
            saveHandle(null);
            try { if (S.client) S.client.setResumeHandle(null); } catch (e) { /* noop */ }
            scheduleReconnect('重连后没能进入可发送状态');
            return;
          }
          // 只有稳定连上才清退避计数 (flapped 时不清)
          if (!flapped) clearRetry();
          startFrameLoop();
          log('✅ 重连成功, 上下文已恢复');
          appendSystemLine('✅ 已重新连接（对话上下文保留）');
        })
        .catch(function (err) {
          log('重连失败:', err.message);
          // 重连也失败 -> 存档点八成是废的, 直接扔掉, 下一轮从全新会话开始
          saveHandle(null);
          try { if (S.client) S.client.setResumeHandle(null); } catch (e) { /* noop */ }
          scheduleReconnect(err.message);
        });
    }, delay);
  }

  // ============================================================
  // 启用 / 停用
  // 迁移自旧文件 :917-1080
  // ============================================================
  function onClientState(state, detail) {
    renderStatus(state, detail);
    if (state === 'connected' || state === 'ready') S.connectedAt = Date.now();
    if (state === 'ready') {
      if (!flapLast) clearRetry();
      flapLast = false;
      appendSystemLine('✅ Gemini Live 已连接，正在持续接收视频画面（1 帧/秒）');
      if (watchSession.closed || !watchSession.watchSessionId) {
        newWatchSession(S.chatId);
        appendSystemLine('📖 我会每隔几分钟整理一次剧情，攒着给你看。');
      }
      // 🔴 2026-10-19 跨场资料注入。必须放在 newWatchSession 之后 —— 它会重置
      //   seriesRecap / episodeMemories / segments。
      //   长剧这边补一次 prepareFilmContext: 短剧那条路是 setSeries 触发的,
      //   长剧没有 setSeries, 所以进影院/切角色时得在这儿自己捞一次,
      //   否则 Live 连上时里面对上次看到哪儿是零认知 (和短剧以前一样的毛病)。
      if (watchSession.kind !== 'series') prepareFilmContext();
      // 连上的这一刻是"进影院先连 Live、后选剧"那条路径的唯一注入时机:
      //   那时 setSeries 已经置了 injectPending, 但当时 S.client 还没 ready, 发不出去。
      //   （中途切剧那条路径在 prepareSeriesRecap 里就发掉了, 这里第二次调用是空转。）
      maybeInjectSeriesRecap();
      // 起播放表。视频此刻可能已经是暂停态(比如进来时没自动播),
      // 那就不起, 等 play 事件 resumeFrames 再起 —— 免得暂停时也在算时间。
      var v0 = getVideo();
      if (v0 && !v0.paused && !v0.ended && !S.paused) markPlaying();
      scheduleStageSummary();
      renderPlotPanel();
    } else if (state === 'closed' && S.autoMode && !S._userDisabled) {
      // 🔴 2026-10-16: 断线这一刻先把在途的摘要请求作废 (理由见 abortPendingSummary)。
      //   少了这一句, 那个请求会赖到 45s 超时, 期间新一集一集都不再总结,
      //   而且模型吐的字全被它吞掉 —— 用户实测"看完一集没总结起, 重看一遍还是没有"。
      abortPendingSummary('连接断开');
      // 非用户主动关闭 → 走 session resumption 重连
      scheduleReconnect(detail || '连接被关闭');
    }
  }

  function enable() {
    if (S.enabled) return Promise.resolve(true);

    var apiKey = getGeminiKey();
    if (!apiKey) {
      appendSystemLine('⚠️ 还没填 Gemini Live API Key，点房间右上角 ⚙ 填一下就能边看边聊');
      renderStatus('error', '没填 API Key');
      return Promise.resolve(false);
    }
    if (typeof window.LiveClient !== 'function') {
      appendSystemLine('⚠️ live-client.js 没加载');
      renderStatus('error', 'live-client.js 未加载');
      return Promise.resolve(false);
    }

    S.enabled = true;
    S.framesSent = 0;
    S.paused = false;
    S._userDisabled = false;
    S._leaving = false;
    clearRetry();
    resetBubble();
    renderStatus('connecting');

    var chatForPrompt = getCurrentChat();
    if (chatForPrompt && !watchSession.chatId) newWatchSession(chatForPrompt.id);

    S.client = new window.LiveClient({
      apiKey: apiKey,
      systemPrompt: buildSystemPrompt(chatForPrompt),
      onState: onClientState,
      // ⬇ 关键路由: 有 pendingSummary → 进剧情记忆, 绝进气泡
      onModelText: handleModelText,
      // ⚠️ 这里【不要】resetBubble()。Gemini 的一个 turn 只是"一小段",
      //    一句完整的话常常横跨好几个 turn (TURN_COVERAGE=ALL_VIDEO, 视频帧会推进回合)。
      //    每个 turn 都重置气泡 -> 一句话被拆成三五个字一行 (2026-10-04 用户反馈)。
      //    气泡只在【用户发新消息】时由 doSendUserText 清。
      onTurnComplete: function () { onTurnCompleteInternal(); },
      onSessionResumption: function (info) {
        // ⚠️ 只在连接【真的 ready 了】才存。正在抖动的连接发来的存档点不能存 ——
        //    那个 handle 马上就是废的, 存下来会毒化下一次连接 (2026-10-04 死循环根因)。
        if (!info || !info.handle) return;
        if (!S.client || !S.client.isReady()) {
          log('连接还没 ready 就收到存档点, 丢弃(避免污染下次连接)');
          return;
        }
        saveHandle(info.handle);
        log('📌 已保存会话存档点');
      },
      onUsage: function (meta) {
        log('usage: total=' + meta.totalTokenCount + ' prompt=' + meta.promptTokenCount +
          ' response=' + meta.responseTokenCount);
      },
      onGoAway: function () { appendSystemLine('⚠️ 服务端即将断开连接'); },
      onError: function (err) { appendSystemLine('⚠️ Gemini Live 错误: ' + err.message); }
    });

    var savedHandle = loadHandle();
    if (savedHandle) S.client.setResumeHandle(savedHandle);

    log('开始连接 Gemini Live');

    return S.client.connect()
      .then(function () {
        return new Promise(function (resolve) {
          var waited = 0;
          var iv = setInterval(function () {
            waited += 200;
            if (S.client && S.client.isReady()) {
              clearInterval(iv);
              startFrameLoop();
              resolve(true);
            } else if (waited > 20000) {
              clearInterval(iv);
              log('等 setupComplete 超时 20s');
              // 拿旧存档点续不上 → 把它扔掉, 下次从全新会话开始。
              // 废掉的 handle 会让服务端一收到 setup 就关连接, 症状是"连上秒断"。
              if (savedHandle) {
                saveHandle(null);
                // ⚠️ 2026-10-16: 光删 localStorage 没用 —— 客户端对象里那个
                //   _resumeHandle 还留着, 下次重连照样拿废的去续。一起清。
                try { S.client.setResumeHandle(null); } catch (e) { /* noop */ }
                log('⚠️ 存档点续不上, 已清除, 下次用全新会话');
              }
              appendSystemLine('⚠️ 等待 Gemini 初始化超时（20s）。已重置存档点，正在重连…');
              // 🔴 原来这里只 resolve(false) 就结束了 —— 而调用方 autoConnect 根本不看
              //   返回值, 于是"把废 handle 清干净"做完了, 却【没有任何人再发起下一次连接】,
              //   连接就死在这儿了 (用户实测"整死连不上模型")。这里主动排一次重连。
              scheduleReconnect('等待 Gemini 初始化超时');
              resolve(false);
            } else if (S.client && (S.client.state === 'error' || S.client.state === 'closed')) {
              clearInterval(iv);
              if (savedHandle) {
                saveHandle(null);
                try { S.client.setResumeHandle(null); } catch (e) { /* noop */ }
                log('⚠️ 带着旧存档点连不上, 已清除');
              }
              appendSystemLine('⚠️ 连接被服务端关闭（code ' + (S.client.state || '?') + '）。已重置存档点，正在重连…');
              scheduleReconnect('连接被服务端关闭');
              resolve(false);
            }
          }, 200);
        });
      })
      .catch(function (err) {
        log('连接失败:', err.message);
        S.enabled = false;
        renderStatus('error', err.message);
        appendSystemLine('❌ Gemini Live 连接失败: ' + err.message);
        return false;
      });
  }

  function disable(reason) {
    log('停用 Gemini Live' + (reason ? ' (' + reason + ')' : ''));
    clearRetry();
    stopStageSummary();      // 连 Live 都断了, 摘要定时器必须跟着停
    stopFrameLoop();
    if (S.client) {
      try { S.client.close(reason || 'disabled'); } catch (e) { /* noop */ }
      S.client = null;
    }
    S.enabled = false;
    S.paused = false;
    S._userDisabled = true;
    resetBubble();
    hideStatus();
    renderPlotPanel();
  }

  /**
   * 播放事件 → 自动连接。
   * 与旧观影一致: 没 key 就静默跳过并提示一次。
   */
  function autoConnect(reason) {
    if (!S.autoMode) return false;
    // 🔴 2026-10-21: 精炼期间连接位借给一次性会话了。
    //   cinema-room.js 的 video 'play' 事件会调这里 —— 用户在精炼时拖一下进度条/
    //   续播, 主会话就自己连回来了, 又跟精炼那条撞并发, 精炼照样失败。
    if (S._refineBorrowed) {
      log('[精炼] 精炼期间不自动连接 (连接位借给一次性会话了)');
      return false;
    }
    if (S.enabled || (S.client && (S.client.state === 'connecting' || S.client.state === 'ready'))) {
      if (S.enabled && S.client && S.client.isReady()) {
        S.paused = false;
        renderStatus('ready');
      }
      return false;
    }
    if (!getGeminiKey()) {
      if (!_autoTried) {
        _autoTried = true;
        appendSystemLine('💡 想让 Gemini 边看边懂？点右上角 ⚙ 填一下 Gemini Live API Key');
      }
      return false;
    }
    var video = getVideo();
    if (!video || !video.src) return false;
    log('自动连接 (触发: ' + (reason || 'video play') + ')');
    enable();
    return true;
  }

  // ============================================================
  // 退出流程 (2026-10-19 重写) —— 以前那套"退出时统一精炼"已经整个取消
  //
  // 【为什么取消】用户实测: 看 5 集短剧, 每集剧情都总结得好好的, 退出时那次
  //   精炼被截断成只剩三个字, 而"非空即成功"的判定照样放行 —— 三个字写进了
  //   长期记忆, finalSummarySaved 置 true, clearDraft() 把那 5 条单集记忆清掉。
  //   结果: 那 5 集真白看, 用户还没地方可以重试 (按钮在生成完就消失了)。
  //
  // 【根因不是调参能解决的】那一次调用是【整场唯一一次长上下文调用】:
  //   提示词里塞着总纲 + 各集记忆 + 阶段摘要 + 最多 200 条聊天记录(约 100KB),
  //   模型首字延迟轻松超过静默判据的 2 秒 → 收走的就是开头那几个字。
  //   短剧单集总结的提示词小得多, 所以很少中招 —— 这跟用户"每集都总结得好好的"
  //   的观察完全一致。
  //
  // 【现在】每写出一条记忆就当场落库(cinemaEpMemories), 退出时什么都不用做。
  //   要不要写进长期记忆 = 用户自己点【导出到长期记忆】, 点了才算账。
  //   所以退出是秒退, 而且不会有"以为存上了其实没存"的情况。
  // ============================================================
  function onLeaveCinema() {
    if (watchSession.leavePromise) return watchSession.leavePromise;
    S._leaving = true;
    stopStageSummary();
    log('退出影院 (记忆已当场落库, 不再做任何总结)');
    hardLeave();
    watchSession.leavePromise = Promise.resolve({ saved: true, skipped: true });
    return watchSession.leavePromise;
  }

  // ============================================================
  // 导出到长期记忆 (2026-10-19 新增, 取代原来的"生成观影记忆")
  //
  // 【语义】用户原话: "等我不想看了我手动点击导出, 把剧情导出到外面的长期记忆"
  //   + "手动导出了就清除, 没导出的就留着继续看"。
  //   → 导出 = 把攒着的这些条目写进 longTermMemory, 写成功才从库里删。
  //   写失败【一行都不删】, 用户还能再点一次。这跟"存不下就当成功"完全相反。
  //
  // 【为什么要按批切】一条上万字塞进 longTermMemory 会把后面的检索和精炼
  //   全拖垮。按 EXPORT_CHUNK_CHARS 切成多条, 每条前面带一行说明它覆盖哪几集。
  //   长期记忆本身自带精炼, 用户原话"我自己出去以后长期记忆本身有精炼功能, 无所谓的"。
  // ============================================================

  /** 组装导出正文。返回 [{ text, ids }] —— 每个元素是一条长期记忆。 */
  function buildExportChunks() {
    var isSeries = watchSession.kind === 'series';
    var pool = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
    var CS = cinemaStorage();
    var key = currentSessionKey();

    // ⚠️ 导的是【库里那份】, 不是内存那份。
    //   内存里可能只有最近几集(跨场时读库灌过), 库里才是全量。
    //   库读不到时退回内存那份 —— 宁可少导, 不能导错。
    var loadRows = (CS && typeof CS.listEpMemories === 'function' && key)
      ? CS.listEpMemories(key).catch(function () { return null; })
      : Promise.resolve(null);

    return loadRows.then(function (rows) {
      var list = (rows && rows.length)
        ? rows.map(function (r) { return { ep: r.ep, text: r.text, id: r.id }; })
        : pool.map(function (r) { return { ep: r.ep, text: r.text, id: r.id || null }; });
      if (!list.length) return [];

      var title = watchSession.seriesTitle || (isSeries ? '这部短剧' : '这部片子');
      var unit = isSeries ? '集' : '段';
      var dateTxt = new Date().toLocaleDateString('zh-CN');
      var header = dateTxt + ' 我和用户一起看了《' + title + '》，下面是看过的剧情。\n';

      var chunks = [];
      var cur = [];        // 当前块里的 { line, id }
      var curLen = 0;

      function flush() {
        if (!cur.length) return;
        var ids = cur.map(function (x) { return x.id; }).filter(Boolean);
        chunks.push({ text: header + cur.map(function (x) { return x.line; }).join('\n\n'), ids: ids });
        cur = [];
        curLen = 0;
      }

      for (var i = 0; i < list.length; i++) {
        var line = '第 ' + list[i].ep + ' ' + unit + '：' + list[i].text;
        // 超了就先把手上这块发出去, 再放这一条 —— 保证顺序不乱
        if (cur.length && curLen + line.length > EXPORT_CHUNK_CHARS) flush();
        cur.push({ line: line, id: list[i].id });
        curLen += line.length;
      }
      flush();
      return chunks;
    });
  }

  /**
   * 导出。返回 Promise<{ok, count, error?}>。
   *
   * ⚠️ 必须 await db.chats.put 成功才算数 —— 跟旧版写观影记忆一样的纪律。
   *   "内存里 push 完了"不是写成功了。
   */
  function exportMemoriesToMemory() {
    var chat = getCurrentChat();
    if (!chat) return Promise.resolve({ ok: false, count: 0, error: '没有找到角色会话' });
    if (watchSession.exporting) return Promise.resolve({ ok: false, count: 0, error: '正在导出，请等一下' });
    watchSession.exporting = true;
    renderPlotPanel();

    return buildExportChunks().then(function (chunks) {
      if (!chunks || !chunks.length) {
        watchSession.exporting = false;
        renderPlotPanel();
        return { ok: false, count: 0, error: '还没有攒下的剧情记忆' };
      }
      if (!chat.longTermMemory) chat.longTermMemory = [];
      for (var i = 0; i < chunks.length; i++) {
        chat.longTermMemory.push({
          content: chunks[i].text,
          timestamp: Date.now(),
          source: 'cinema_watch_export'
        });
      }
      return db.chats.put(chat).then(function () {
        log('✅ 已导出 ' + chunks.length + ' 条到长期记忆');
        return clearExported(chunks);
      });
    }).then(function (r) {
      watchSession.exporting = false;
      if (r && r.ok) {
        appendSystemLine('✅ 已导出 ' + r.count + ' 条剧情到长期记忆');
        clearDraft();
      }
      renderPlotPanel();
      return r;
    }).catch(function (e) {
      watchSession.exporting = false;
      logError('导出失败:', e && e.message);
      appendSystemLine('⚠️ 没导出去：' + ((e && e.message) || '未知错误') + '（记忆都还在，可以再点一次）');
      renderPlotPanel();
      return { ok: false, count: 0, error: (e && e.message) || '未知错误' };
    });
  }

  /**
   * 导出成功后清账: 库里删掉已导出的行, 内存里也清掉对应的。
   *
   * ⚠️ 库里删失败【不清内存】—— 反过来会造成"内存没了、库里还在",
   *   下次进影院又冒出来, 用户会以为没导出成功又点一次,
   *   于是同样内容写进长期记忆两份。比多导一次糟糕得多。
   */
  function clearExported(chunks) {
    var isSeries = watchSession.kind === 'series';
    var ids = [];
    var i;
    for (i = 0; i < chunks.length; i++) ids = ids.concat(chunks[i].ids || []);

    function wipeMemory() {
      if (isSeries) watchSession.episodeMemories = [];
      else watchSession.segments = [];
      // ⚠️ 长剧的 segCount【不回退】: 它是段落序号, 下一段永远接在后面。
      //   回退了就会跟库里已经导掉的行撞号, 新段落把旧段落覆盖掉。
      renderPlotPanel();
      return { ok: true, count: chunks.length };
    }

    if (!ids.length) return Promise.resolve(wipeMemory());   // 库里没 id, 至少界面一致

    var CS = cinemaStorage();
    if (!CS || typeof CS.deleteEpMemories !== 'function') {
      logWarn('存储层没有删除接口, 库里这份留着(下次进来还会看到)');
      return Promise.resolve(wipeMemory());
    }
    return CS.deleteEpMemories(ids).then(function (ok) {
      if (!ok) {
        logWarn('库里那几条没删掉, 留着下次再导一次(避免重复写进长期记忆)');
        return { ok: true, count: chunks.length };
      }
      var gone = {};
      for (i = 0; i < ids.length; i++) gone[ids[i]] = true;
      var pool = isSeries ? (watchSession.episodeMemories || []) : (watchSession.segments || []);
      // 内存里的项必须带 id 才能精确删。mergeLoadedEpisodes 灌进来的那些是带的
      // (它 copy 了整行), 只有"库读不到、退回内存自己造的行"没有 id —— 那种直接清空。
      var allHaveId = pool.length > 0 && pool.every(function (x) { return !!x.id; });
      if (allHaveId) {
        var keep = pool.filter(function (x) { return !gone[x.id]; });
        if (isSeries) watchSession.episodeMemories = keep; else watchSession.segments = keep;
      } else {
        wipeMemory();
        return { ok: true, count: chunks.length };
      }
      renderPlotPanel();
      return { ok: true, count: chunks.length };
    });
  }

  /**
   * 作废当前在途的摘要请求。
   *
   * 🔴 2026-10-16 用户实测 (连不上 + 总结出岔子) 的真凶之一:
   *   连接断掉时, 在途的那个摘要请求没人管, 会一直赖到它自己的 45s 超时。
   *   这段窗口里:
   *     ① requestEpisodeSummary 第一行 `if (pendingSummary) return ''` → 后面每一集
   *       都不再总结 (用户原话"一集短剧看完了之后记忆总结出岔子了, 没总结起")
   *     ② handleModelText 里 `if (pendingSummary)` 会把模型吐的【每一个字】都收进
   *       这个僵尸 buffer, 一个字都不进气泡 → 看着像"连上了但不理我"
   *   所以断线这一刻必须立刻把它作废, 而不是等它自己超时。
   */
  function abortPendingSummary(reason) {
    var p = watchSession.pendingSummary;
    if (!p) return false;
    watchSession.pendingSummary = null;
    watchSession.summaryBusy = false;
    if (p.timer) clearTimeout(p.timer);
    if (p.settleTimer) clearTimeout(p.settleTimer);
    // 迟到的那些字一律丢掉, 别流进下一次摘要 (同 waitForNoPendingSummary 里的理由)
    watchSession.summaryGhostUntil = Date.now() + 3000;
    try { if (S.client) S.client._lastTranscription = ''; } catch (e) { /* noop */ }
    logWarn('已作废在途的摘要请求(' + (reason || '未说明') + '), 那一次的内容作废');
    return true;
  }

  function waitForNoPendingSummary() {
    // ⚠️⚠️ 2026-10-09: 上限从 3000ms 提到 20000ms。
    //
    //   短剧一集 1~2 分钟就要出一份 300~400 字的单集记忆, 生成十几秒很正常。
    //   以前只等 3 秒就强行掐掉换发最终总结 —— 用户点退出时如果刚好撞上
    //   某一集的单集记忆还在生成, 那半句就会流进最终总结的 buffer。
    //   反正退出流程本来就必须等最终总结生成完 (常常十几秒), 多等这点不亏。
    //
    //   真的超时了也不能就这么算了: 开一个静默窗口, 把掐掉之后迟到的文本丢掉。
    var waited = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        waited += 200;
        if (!watchSession.pendingSummary || waited > 20000) {
          if (watchSession.pendingSummary) {
            log('等待在途摘要超时 (' + waited + 'ms), 强制继续');
            abortPendingSummary('等待超时');
          }
          clearInterval(iv);
          resolve();
        }
      }, 200);
    });
  }

  function hardLeave() {
    watchSession.closed = true;
    stopStageSummary();

    // 🔴 2026-10-19: 草稿现在是【第二道保险】, 不是唯一活命稻草。
    //   每条记忆当场就落了 Dexie, 所以这里存不存都不影响"会不会白看"。
    //   但 chatLog 只在草稿里, 而它是"一起看的回忆"的一部分, 丢了就没了 —— 所以留着。
    if (watchSession.chatLog && watchSession.chatLog.length) saveDraft();
    // ⚠️ 退出时自己把这次的播放时间账结清 (2026-10-07)。
    //
    // 不加这一行也能跑 —— 因为重连时 onClientState 里那个
    // "closed || !watchSessionId" 会命中, 由 newWatchSession() 顺手清。
    // 但那等于【清理依赖下游有人来擦】: 将来任何一条"重连但不清场"的路径
    // (比如短剧换集连播) 都会把旧时间账带进新会话。
    //
    // 语义上也该在这里清: 退出 = 这次会话彻底结束, 账就该当场结掉。
    markPaused();
    watchSession.playedMs = 0;
    watchSession.lastSummaryStartedAt = 0;
    S._leaving = true;
    disable('离开 Cinema Room');
    _autoTried = false;
    S._userDisabled = false;
    S.canvas = null;
    S.ctx = null;
    S.framesSent = 0;
    S.bubbleEl = null;
  }

  // ============================================================
  // 帧控制 / 消息 / 生命周期钩子
  // ============================================================
  function pauseFrames(reason) {
    if (!S.enabled) return;
    S.paused = true;
    // 计时冻结: 把这段播放时长结算进去, 然后把定时器收掉。
    // 不清掉的话它会在暂停期间空转到点, 白白吃掉一轮 5 分钟 (用户 2026-10-07 要求)。
    markPaused();
    stopStageSummary();
    log('暂停发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  function resumeFrames(reason) {
    if (!S.enabled || !S.client || !S.client.isReady()) return;
    S.paused = false;
    // 计时恢复: 从头起算播放时长, 再按"这一轮还差多少"重新排定时器。
    markPlaying();
    if (!S._leaving) {
      scheduleStageSummary();
    }
    log('恢复发帧' + (reason ? ' (' + reason + ')' : ''));
    renderStatus('ready');
  }

  function doSendUserText(text) {
    var t = String(text || '').trim();
    if (!t) return;

    // 🔴 2026-10-23 陪聊改走【主聊天的主 API】(modules/cinema-chat.js)。
    //   Live 不再接收用户消息 —— 它只负责看画面 + 写剧情记忆。
    //   人设 / 长期记忆 / 主聊天历史 / 影院剧情记忆 全由主 API 那条链路组装,
    //   性格跟外面聊天一致 (用户 2026-10-23 的原话: "性格也和外面聊天的不适配")。
    if (window.CinemaChat && typeof window.CinemaChat.send === 'function') {
      resetBubble();          // 上一句收尾, 开一个新气泡
      bubbleText = '';
      recordChat('user', t);  // 观影聊天记录(导出用的"一起看的回忆")照旧记
      Promise.resolve(window.CinemaChat.send(t)).catch(function (e) {
        log('[陪聊] 失败', e);
      });
      return;
    }

    // cinema-chat.js 没加载 → 临时落回旧的 Live 陪聊 (别让用户完全发不出话)
    logWarn('CinemaChat 不可用, 临时落回 Live 陪聊');
    var video = getVideo();
    var extra = (video && !video.paused && !video.ended)
      ? '' : '（视频当前是暂停/结束状态，只能根据之前收到的画面回答）';
    resetBubble();
    bubbleText = '';
    recordChat('user', t);
    S.client.sendUserText(t);
    appendUserBubble(t);
    if (extra) appendSystemLine(extra);
  }

  /**
   * Cinema Room 聊天框发消息。
   * @returns {boolean} true = 已被 Live 接管
   */
  function handleUserMessage(text) {
    var t = String(text || '').trim();
    if (!t) return false;

    // 🔴 2026-10-23 陪聊改走主 API 之后, 【Live 没就绪也能聊】。
    //   陪聊要的是人设 + 长期记忆 + 主聊天历史 + 影院剧情记忆, 全都不依赖 Live。
    //   Live 只管看画面 + 写剧情记忆, 它没连上只是"看不到此刻画面", 不该挡住聊天。
    //
    //   也不再有"摘要在途就排队"那套 —— 用户消息走主 API, 跟 Live 的 turn 队列
    //   是两条完全独立的连接, 根本不会撞。
    if (window.CinemaChat && typeof window.CinemaChat.send === 'function') {
      doSendUserText(t);
      return true;
    }

    // 没有 cinema-chat.js → 走老的 Live 陪聊 (那条路需要 Live 就绪)
    if (!S.enabled) return false;
    if (!S.client || !S.client.isReady()) {
      appendSystemLine('⚠️ Gemini Live 还没就绪，暂时无法提问');
      return true;
    }
    // ⚠️ 关键: 摘要 turn 在途时【排队】, 绝不并发发第二个 turn
    if (watchSession.pendingSummary) {
      watchSession.queuedUserText = t;
      appendUserBubble(t);
      appendSystemLine('⏳ 正在整理剧情，你的消息会在整理完成后自动发出。');
      return true;
    }
    doSendUserText(t);
    return true;
  }

  function onTurnCompleteInternal() {
    // ══════════════════════════════════════════════════════════════════════
    // 🔴 2026-10-10 摘要去掉了 turnComplete 依赖 (用户实测: 手动总结不落盘 + 片段漏进聊天框)
    //
    // 【这里现在什么都不收】—— 摘要统一由 SUMMARY_SETTLE_MS 静默计时器收
    //   (见 handleModelText 里的 p.armSettle())。
    //
    // 【为什么必须拿掉】原来的 gotText 门只防"一个字都没到就收", 防不住"收太早":
    //   观影时 1 FPS 送帧 → 回合被不停推进 → 发完摘要请求极容易撞上【上一回合收尾】。
    //   撞上时: 上一回合尾巴 → 塞进新 buffer 且 gotText=true → 该回合 turnComplete
    //   → 当场 resolve 一个半截 buffer → 真正的正文随后到达时 pendingSummary 已 null,
    //   全部漏进聊天框, 且写库拿到的内容是残缺的。
    //   静默计时跟回合边界解耦, 撞不撞回合都无所谓。
    //
    // 【保留】下面只是日志, 方便排查时看到回合在推进。
    // ══════════════════════════════════════════════════════════════════════
    if (watchSession.pendingSummary) {
      log('[摘要] 回合收尾 (不据此收摘要, 等静默计时器; 已吐 ' +
        (watchSession.pendingSummary.buffer || '').length + ' 字)');
      return;
    }
    // 普通陪聊的回合结束: 【什么都不做】, 气泡继续留着。
    // 一句话跨多个 turn 是常态, 只有用户发新消息才开新气泡。
  }

  /** 短剧换集 → 只结掉本次播放时长, 【不清场、不重连、不清摘要】(2026-10-07)
   *
   * 跟 onVideoSourceChanged 的区别: 那个是"换片"= 换了一部完全不同的东西,
   * 旧摘要作废是对的; 这个是"同一部剧的下一集", 摘要和连接都得留着。
   */
  function onSeriesEpisodeChanged() {
    markPaused();
    stopStageSummary();
    watchSession.currentPlotSummary = '';      // 单集记忆才是短剧的载体
    watchSession.summaryCount = 0;
    watchSession.summaryUpdatedAt = 0;
    watchSession.lastSummaryStartedAt = 0;      // 下一集重新起 5 分钟
    if (S.enabled) {
      markPlaying();                           // 新片马上要播, 接着起表
      scheduleStageSummary();
    }
    renderPlotPanel();
  }

  /** 自然播放结束 → 停发帧, 不关 Live, 不退出房间, 用户还能继续聊 */
  function onVideoEnded() {
    // 短剧: 一集播完 → 记这一集剧情 + 看够 20 集就合并 (2026-10-07)
    if (watchSession.kind === 'series') {
      // 🔴 2026-10-10 用户实测: 退出再进来播第3集, 总结却写成"第一集"。
      //   原来用 seriesLastEp+1 猜集号 —— 草稿恢复时序一错, seriesLastEp 还是 0,
      //   第3集就被记成第1集, addEpisodeMemory(1,...) 还会【覆盖掉草稿里的第1集记忆】。
      //   现在优先用宿主传来的【确切集号】(用户点的那个按钮); 没有才回退到猜。
      var ep = watchSession.nowPlayingEp > 0 ? watchSession.nowPlayingEp : (watchSession.seriesLastEp + 1);
      // 用掉了 nowPlayingEp 就清掉, 避免下次连播时又用它(串到下一集)
      watchSession.nowPlayingEp = 0;
      markPaused();
      stopStageSummary();
      log('第 ' + ep + ' 集播完, 记录剧情…');
      renderStatus('ready');
      // 🔴 2026-10-27: 单集剧情 > 实况 —— 在途的「此刻画面」直接作废, 把通道让出来。
      //   实况是可再生的快照(下一轮 30 秒会重写), 单集剧情错过就是这一集白看。
      //   不这么做的话, 播完那一刻正好撞上在途实况 → 这一集的单集剧情被静默丢掉
      //   (用户实测: 第一次不总结, 再放一遍才总结)。
      yieldChannelToEpisodeSummary();
      requestEpisodeSummary(ep).then(function (text) {
        // 🔴 2026-10-27: 只有【真的总结出来】才推进"看到第几集"。
        //   以前这里不看结果直接推进 —— 于是这一集在数据上"看过了",
        //   状态条也写着"看到第 N 集", 但库里根本没这一集, 用户自己都发现不了。
        if (text && ep > watchSession.seriesLastEp) watchSession.seriesLastEp = ep;
        renderPlotPanel();
        // 攒够一批评分压成跨场提要 (失败不丢数据, 各集都在库里)
        return maybeMergeSeriesRecap();
      }).catch(function (err) {
        logWarn('第 ' + ep + ' 集记录失败:', err.message);
        noteEpisodeFail(ep, '生成失败: ' + (err && err.message ? err.message : err));
        renderPlotPanel();
      });
      return;
    }

    if (!S.enabled) return;
    S.paused = true;
    // 播完 = 这段播放时长到此为止, 收表 + 收定时器。
    // 下一轮计时从 resumeFrames 再起 (用户手动重播或换片)。
    //
    // ⚠️ 2026-10-19 【必须在 markPaused() 之前算差值】——
    //   下面要靠 totalPlayedMs() 跟 lastSummaryStartedAt 的差来判断"这一轮
    //   有没有攒到够记一段的东西", 而 markPaused() 会把在播的那一段结算掉,
    //   差值就变了。先算, 后结算。
    var gapMs = totalPlayedMs() - (watchSession.lastSummaryStartedAt || 0);
    markPaused();
    stopStageSummary();
    log('视频播放结束, 停止发帧 (session 保留)');
    renderStatus('ready');

    // 用户原话: "不足五分钟的剧情结束的时候总结一次"。
    // 播完这一刻 Live 还连着、帧还在发, 是唯一还能看到画面的时候;
    // 下一轮再播时, 这不到五分钟的内容就永远没人记得了。
    if (gapMs >= 60000) {
      runStageSummary({ reason: '影片播完, 补记最后一段', minGapMs: 60000 })
        .then(function (ok) { if (ok) renderPlotPanel(); })
        .catch(function (e) { logWarn('补记最后一段失败:', e && e.message); });
    } else if (gapMs > 0) {
      log('这一轮只看了 ' + Math.round(gapMs / 1000) + 's, 没什么可补记的');
    }
  }

  /** 换片 → 结束旧 session, 旧摘要丢弃(临时记忆), 重开新 session */
  function onVideoSourceChanged() {
    log('视频源已更换, 结束旧 watch session (其剧情摘要不写入长期记忆)');
    stopStageSummary();
    markPaused();          // 换片时若正在播放, 先把这一段落账, 别留悬空起点
    watchSession.currentPlotSummary = '';
    watchSession.summaryCount = 0;
    watchSession.summaryUpdatedAt = 0;
    watchSession.chatLog = [];
    plotEditing = null;
    S.canvas = null;
    S.ctx = null;
    S.framesSent = 0;
    if (S.enabled) disable('视频源更换');
    else newWatchSession(S.chatId);
    renderPlotPanel();
  }

  // ============================================================
  // 导出
  // ============================================================
  window.CinemaLive = {
    // 会话绑定
    setChat: function (chatId) {
      S.chatId = chatId || null;
      if (S.chatId) {
        if (!watchSession.chatId || watchSession.chatId !== S.chatId) {
          newWatchSession(S.chatId);
          // 🔴 2026-10-10 进影院先捡草稿 —— 只在这里恢复, 换片(onVideoSourceChanged)不恢复,
          //   免得旧片子的记忆莫名其妙混进新片。
          restoreDraft();
        }
      }
    },
    getChatId: function () { return S.chatId; },

    // 🔴 2026-10-23 陪聊改走主 API 之后, cinema-chat.js 需要三样东西:
    //   ① 影院这边攒下的剧情记忆 + 此刻实况 (给主 API 当上文)
    //   ② 气泡的渲染 (气泡现在是主 API 的地盘, 但 DOM 跟样式都在这个模块里)
    //   ③ 观影聊天记录 (导出用的"一起看的回忆")
    getCinemaContext: function () {
      var rec = watchSession.seriesRecap;
      var isSeries = watchSession.kind === 'series';
      return {
        kind: watchSession.kind,
        title: watchSession.seriesTitle || '',
        lastEp: watchSession.seriesLastEp || 0,
        segCount: watchSession.segCount || 0,
        // 短剧: 跨场提要 (库里的那份); 长剧: 整部戏的提要
        recap: isSeries ? ((rec && rec.text) || '') : '',
        recapText: isSeries ? '' : ((rec && rec.recapText) || ''),
        // 长剧的滚动锚 (内存里最新的那份)
        anchor: isSeries ? '' : (watchSession.currentPlotSummary || ''),
        episodes: (watchSession.episodeMemories || []).map(function (x) {
          return { ep: x.ep, text: x.text || '' };
        }),
        segments: (watchSession.segments || []).map(function (x) {
          return { ep: x.ep, text: x.text || '' };
        }),
        // 此刻画面 (单条覆盖式)
        liveNow: watchSession.liveNow || { text: '', at: 0 }
      };
    },
    // ---- 陪聊气泡 UI (由 cinema-chat.js 驱动) ----
    appendUserBubble: appendUserBubble,
    renderAssistantBubble: renderGeminiBubble,
    resetBubble: resetBubble,
    appendSystemLine: appendSystemLine,
    recordAssistant: recordAssistantFinal,

    // 生命周期
    enable: enable,
    disable: disable,
    autoConnect: autoConnect,
    onLeaveCinema: onLeaveCinema,
    /**
     * 🔴 2026-10-19 导出攒着的剧情到长期记忆。取代原来那个「生成观影记忆」。
     *   写库成功才清账; 失败一行都不删, 用户可以再点。
     */
    exportMemoriesToMemory: exportMemoriesToMemory,
    /**
     * 有没有还没导出的剧情 (UI 据此在顶栏给个提示)。
     *
     * ⚠️ 2026-10-19 起它【不再决定要不要拦用户退出】—— 内容已经落库了,
     *   退出不丢东西。UI 层现在只拿它做"要不要给个视觉提示"。
     */
    hasUnsavedMemory: function () {
      return (watchSession.episodeMemories || []).length > 0 ||
        (watchSession.segments || []).length > 0;
    },
    /** 强制走人。内容已经落库, 所以它跟正常退出唯一的区别就是不走 UI 那套。 */
    forceLeave: function (reason) {
      log('强制退出: ' + (reason || '未说明'));
      watchSession.leavePromise = null;
      S._leaving = false;
      hardLeave();
      return true;
    },
    pauseFrames: pauseFrames,
    resumeFrames: resumeFrames,
    handleUserMessage: handleUserMessage,
    onVideoEnded: onVideoEnded,
    onVideoSourceChanged: onVideoSourceChanged,

    // ---- 短剧 (2026-10-07) ----
    setSeries: setSeries,
    setSeriesProgress: function (key, title, lastEp, outline, nowPlayingEp) {
      if (key) watchSession.seriesKey = key;
      if (title !== undefined) watchSession.seriesTitle = title;
      if (lastEp !== undefined && lastEp !== null) watchSession.seriesLastEp = Number(lastEp) || 0;
      // ⚠️ 2026-10-19: outline 参数【故意忽略】。
      //   它以前是"20 集合并出来的总纲", 现在那份压缩稿改由 maybeMergeSeriesRecap
      //   从库里算, 而且存在 cinemaSeriesRecap 表里(Dexie), 宿主这份内存副本反而
      //   会跟真数据对不上。参数位置留着不动, 免得改坏调用方的传参。
      if (outline !== undefined && outline !== null) {
        log('setSeriesProgress 的 outline 参数已废弃, 跨场提要改从存储层读');
      }
      // 🔴 2026-10-10 用户实测: 退出再进来播第3集, 总结却写成"第一集"。
      //   根因是 Live 只知道 seriesLastEp, 播完时用 seriesLastEp+1 猜集号;
      //   草稿恢复时序一错, seriesLastEp 还是 0 → 第3集被当成第1集, 还会覆盖旧记忆。
      //   宿主那边知道用户点的【确切集号】, 传过来直接用, 不猜。
      if (nowPlayingEp !== undefined && nowPlayingEp !== null) {
        watchSession.nowPlayingEp = Number(nowPlayingEp) || 0;
      }
      watchSession.kind = 'series';
    },
    requestEpisodeSummary: requestEpisodeSummary,
    maybeMergeSeriesRecap: maybeMergeSeriesRecap,
    onSeriesEpisodeChanged: onSeriesEpisodeChanged,
    getSeriesState: function () {
      var rec = watchSession.seriesRecap;
      return {
        kind: watchSession.kind,
        key: watchSession.seriesKey,
        title: watchSession.seriesTitle,
        lastEp: watchSession.seriesLastEp,
        // outline 字段名保留(免得调用方读不到), 但现在装的是跨场提要
        outline: (rec && rec.text) || '',
        pending: (watchSession.episodeMemories || []).length,
        segments: (watchSession.segments || []).length,
        outlineLen: ((rec && rec.text) || '').length
      };
    },

    // 剧情面板 (2026-10-16: 不再有 togglePlotPanel, 开关在 cinema-room.js 的 setPlotSheet)
    renderPlotPanel: renderPlotPanel,
    isPlotPanelOpen: function () {
      // 现在"开着"= 独立页面带了 .open 类, 不再是内存里那个折叠标志
      var sheet = document.getElementById('cinema-plot-sheet');
      return !!(sheet && sheet.classList.contains('open'));
    },

    // key
    getGeminiKey: getGeminiKey,
    setGeminiKey: setGeminiKey,
    hasKey: function () { return !!getGeminiKey(); },

    // 状态
    isEnabled: function () { return S.enabled; },
    isReady: function () { return !!(S.client && S.client.isReady()); },
    getStats: function () {
      return {
        enabled: S.enabled,
        ready: !!(S.client && S.client.isReady()),
        framesSent: S.framesSent,
        paused: S.paused,
        chatId: S.chatId,
        frameSize: S.canvas ? (S.canvas.width + 'x' + S.canvas.height) : 'n/a',
        state: S.client ? S.client.state : 'idle'
      };
    },
    getWatchSession: function () {
      return {
        watchSessionId: watchSession.watchSessionId,
        chatId: watchSession.chatId,
        currentPlotSummary: watchSession.currentPlotSummary,
        summaryUpdatedAt: watchSession.summaryUpdatedAt,
        summaryCount: watchSession.summaryCount,
        summaryBusy: watchSession.summaryBusy,
        chatCount: watchSession.chatLog.length
      };
    },
    // 迁移自检用: 确认降采样逻辑
    computeFrameSize: computeFrameSize
  };

  log('cinema-live.js 已加载 (迁移自 watch-together-live.js; 协议层用 live-client.js)');
})();

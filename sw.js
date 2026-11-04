// Service Worker (sw.js)
// 白名单缓存: 只缓存已知静态资源, API 请求 pass-through
// CACHE_VERSION bump 强制清缓存
// 关键约束: URLS_TO_CACHE 增删需同步 sw.js 注释 + ?v= 版本号

// v0.2.40.0 (2026-10-09): 双耳空间音频上线。
//   ⚠️ 新增的 src/lib/tts/binaural/*.js 与 assets/audio/hrir-ku100-nf.bin
//      **故意不进 URLS_TO_CACHE**:
//        - 两个 JS 走 ?v= 版本号 + 浏览器 HTTP 缓存即可, 进预缓存纯属浪费;
//        - HRIR 有 180KB, install 期预缓存会挤占 iOS PWA 安装配额
//          (sw.js 下方 Cinema Room 那条注释记的就是这个坑: 大二进制双份占空间、
//           撑爆安装期缓存)。它按需加载, 由浏览器 HTTP 缓存自然复用。
//   本次 bump 只是为了让 index.html 里新增的 <script> 标签生效(它是被预缓存的)。
// v0.2.41.0 (2026-10-10): 双耳空间音频 —— 动态声相轨迹。
//   index.html 新增 <script src="src/lib/tts/binaural/trajectory.js">, 它是被预缓存的,
//   所以必须再 bump 一次 CACHE_VERSION 才能让新标签生效。
//   src/lib/tts/binaural/*.js 与 assets/audio/hrir-ku100-nf.bin 依旧【不进预缓存】(见下)。
// v0.2.42.0 (2026-10-10): Cinema Room 观影记忆草稿兜底。
//   用户实测: API 临时抽风 → 退出总结失败 → 两集白看, 退出后什么都不剩。
//   改造: 退出自动总结 → 手动「生成观影记忆」按钮 + 失败可重试
//        + localStorage 草稿兜底(退出时存, 下次进影院恢复, 精炼成功才清)。
//   cinema-live.js / cinema-room.js / cinema-room.css 三个都在下面 URLS_TO_CACHE 里,
//   而且 index.html 里的 ?v= 已经 bump (1.3.0 / 0.25.2 / 0.35.2),
//   所以【必须】bump CACHE_VERSION, 否则 SW 继续吐旧版, 改动等于没改。
// v0.2.43.0 (2026-10-19): Cinema Room 剧情记忆改造 —— 取消退出精炼, 改成当场落库 + 手动导出。
//   用户实测: 看 5 集短剧每集都总结得好好的, 退出时那次精炼被截断成只剩三个字,
//   而"非空即成功"的判定照样放行 —— 三个字写进长期记忆、清掉那 5 条单集记忆, 真白看。
//   根因: 那一次调用是整场唯一一次长上下文调用, 模型首字延迟超过"静默 2 秒就算说完"的判据。
//   改造: 每集 / 每 5 分钟当场写进 Dexie(cinemaEpMemories, db v69),
//        退出什么都不做(秒退), 要不要写进长期记忆由用户在「记忆」页点【导出】决定。
//   cinema-live.js / cinema-room.js / cinema-room.css / cinema-storage.js
//   四个都在下面 URLS_TO_CACHE 里, 且 index.html 的 ?v= 已 bump
//   (1.8.0 / 0.28.0 / 0.37.0 / 0.5.0), 所以【必须】bump CACHE_VERSION。
//   ⚠️ init-db-schema.js 【不在】下面这份预缓存清单里(查过了), 所以它走浏览器 HTTP 缓存,
//      靠 index.html 里的 ?v= 生效 —— 那个已经 bump 到 0.0.41。
//      忘了 bump 的话手机上 Dexie 压根不建 v69 那张表, 逐条记忆全都写不进去
//      (v66 cinemaChars 踩过这个坑; cinema-storage 的 ensureEpMemoryTable() 是第二道防线)。
// v0.2.44.0 (2026-10-20): Cinema Room 顶栏「退出」点了没反应 —— 修回被误删的 close()。
//   症状: 导完剧情记忆回聊天界面, 点顶栏「退出」毫无动静, 也不报错。
//   根因: v4.20 重构时 close() 这个函数被误删了, 但两处引用还在 ——
//        els.closeBtn.addEventListener('click', close) 和 global.CinemaRoom.close。
//        于是 close 落到了全局的 window.close, 点下去等于调浏览器的关窗口接口,
//        手机上对非脚本打开的标签页是【静默无效】的。
//   修法: 把 close() 补回来(flushProgress 落盘进度 + finishClose 收尾), 不再有任何生成。
//   index.html 的 ?v= 已 bump (cinema-room.js 0.27.0 → 0.28.0), 所以要 bump CACHE_VERSION。
// v0.2.45.0 (2026-10-20): Cinema Room 顶栏删掉「停止」按钮。
//   症状: 播放视频时顶栏变成 6 个按钮, 最后一个被挤到下一排, 视频区整个被往下推。
//   改动: 删掉顶栏那个「停止」(HTML + 事件绑定 + els 字段 + 两处 hidden + CSS 规则),
//        stopPlayback() 函数保留(读不到文件 / 删正在播的那部时还在用)。
//   为什么删得掉: 停发帧和停计时, 播放器自带的暂停早就接上了
//        (video 'pause' 事件 → CinemaLive.pauseFrames);
//        而「彻底卸掉影片源」这件事, 点片单里另一部就会做。
//   index.html 的 ?v= 已 bump (cinema-room.js 0.29.0 / cinema-room.css 0.38.0),
//   所以要 bump CACHE_VERSION。
// v0.2.46.0 (2026-10-20): Cinema Room 加「精炼前情提要」手动按钮。
//   症状: 用户看 4 集就退出, 自动提要要攒够 10 集才生成 → 这部剧在模型眼里还是零认知,
//        观影模型"搁那打胡乱说"。
//   改动: 剧情记忆页短剧那一栏加「📖 精炼前情提要」按钮, 随时能压一份;
//        提示词构造抽成 runRecapMerge (自动合并 + 手动精炼共用);
//        persistSeriesRecapSafely 加 lastEpOverride (存真实覆盖到的集号, 别用 seriesLastEp);
//        导出区加"先精炼后导出"的顺序提醒 (导出成功会删掉库里的各集剧情, 删了就没素材可精炼)。
//   精炼【不删】单集剧情 —— 提要只是给模型看的压缩版, 库里那份才是原样。
//   index.html 的 ?v= 已 bump (cinema-live.js 1.9.0), 所以要 bump CACHE_VERSION。
// v0.2.48.0 (2026-10-20): 「精炼前情提要」改成【单独调一次观影模型】+ 反馈只留记忆页。
//   用户原话: "精炼发去聊天框干嘛? 精炼的是前情提要, 要留在记忆页里的,
//              而且需要单独调一次观影模型哦, 一般都是看完剧没连接的时候精炼"
//   根因: ① 精炼走的是 requestSummary, 它硬依赖【已连接的 Live 会话】
//        (S.client.isReady()), 而精炼的正常时机恰恰是"看完剧、没连接" → 那条路是死的。
//        ② 进度/结果还留着一份 appendSystemLine(聊天框)。
//   改法: 新增 callViewerModelOnce —— 临时开一个【一次性 Live 会话】,
//        同一个模型 + 同一套人设(buildSystemPrompt) + 同一把 key,
//        只喂一条任务指令, 拿到字就 close(不留野连接);
//        精炼路径改走它, 不再看主会话连没连; 反馈全部留在记忆页那一栏。
//   index.html 的 ?v= 已 bump (cinema-live.js 1.9.2), 所以要 bump CACHE_VERSION。
// v0.2.48.1: 修「独立页通话（新）」入口横幅盖住每一个页面 + 沙盒 AI 说话报
//   Can't find variable: formatTimeAgo。
//   index.html 的 ?v= 已 bump (video-call-sandbox-host.js 0.0.2 → 0.0.3), 要 bump CACHE_VERSION。
// v0.2.48.2: 【撤回】视频通话「独立页通话（新）」功能整体撤掉 ——
//   实测独立页跑了不到 3 分钟照样烫得不行, 说明发热根本不在宿主页面的 DOM 上
//   (整份宿主文档都隔离了还是烫 → DOM 这条线彻底排除), 真凶是 Live2D 渲染
//   (3x DPR + 抗锯齿 + 60fps 满帧) / 摄像头解码 / 麦克风 ASR, 跟页面结构无关。
//   沙盒那套 (video-call-sandbox.html + sandbox-globals.js + video-call-sandbox-host.js)
//   全部删除, 准备页的「独立页通话（新）」按钮随之消失, 回到只有旧入口的状态。
//   index.html 少了那个 script 标签 → 要 bump CACHE_VERSION, 否则 SW 继续吐旧 index.html。
// v0.2.49.0 (2026-10-20): 修「精炼前情提要点了没动静」的真根因。
//   症状: 用户点了「精炼前情提要」, 界面一点变化都没有(用户实测, 连着两次)。
//   根因: setRefineMsg 里的重绘被 `!watchSession.closed && !S._leaving` 卡着。
//        这两个标志【只有退出房间时置真, 只有重新连上 Gemini 时才复位】——
//        而"看完剧 → 退出 → 重进影院 → 点精炼"是正常流程, 这条路上没人复位它们,
//        于是每一条反馈都不重绘; 四个早退分支更是连最终那次重绘都没有 → 一片死寂。
//        (精炼其实跑完了: 模型调了、提要存进库了, 只是界面不刷新。)
//   改法: 判据换成"房间还在不在 DOM 里"(新增 plotPanelCanRender);
//        重绘失败也不许把精炼本身带崩(try/catch 包住)。
//   index.html 的 ?v= 已 bump (cinema-live.js 1.9.3), 所以要 bump CACHE_VERSION。
// v0.2.50.0 (2026-10-20): 旧影院入口(open-cinema-room-btn)整个删掉。
//   原来它只是【藏起来】(index.html 的 inline !important + CSS 一条 + JS 再藏一次),
//   按钮和绑定都还在, 现在连按钮带 hideLegacyEntry() 一起清掉 —— 免得留着看不见的
//   死代码让人以为还能回退。
//   ⚠️ open() 本身留着: 沙盒页加载同一份 cinema-room.js, 自己调 CinemaRoom.open()。
//   index.html 少了那个 button、cinema-room.css 少了一条规则 → 要 bump CACHE_VERSION。
// v0.2.51.0 (2026-10-21): 修「面板有 3 集, 点精炼却说库里没有攒下的单集剧情」。
//   症状: 用户实测 —— 记忆页明明摆着第 72/73/74 集, 点「📖 精炼前情提要」却弹
//   "库里还没有攒下的单集剧情, 没东西可以精炼。先看一集再来。"
//   根因: 【面板读内存数组 watchSession.episodeMemories, 精炼读数据库
//   cinemaEpMemories】—— 两个数据源。落库那一步没成时两边就对不上, 而落库失败
//   是【静默】的(只 logWarn 一句), 用户毫无察觉。
//   更深一层: 沙盒 iframe 建的是【自己的】CinemaSandboxDB(只声明到 v65),
//   cinemaSeriesRecap(v68) / cinemaEpMemories(v69) 两张表根本不存在,
//   全靠 cinema-storage.js 的 ensure*Table() 现场补建 ——
//   而补建失败的结果被【永久缓存】, 于是那一页里所有读写全废。
//   改法: ① cinema-sandbox/index.html 的 Dexie 直接声明到 v69(不再靠补建)
//         ② cinema-storage.js 补建失败不再永久缓存, 下次能重试
//         ③ cinema-live.js 精炼/自动合并都改成取【库 ∪ 内存】并集,
//            内存里有而库里没有的顺手补写进库
//         ④ 草稿恢复出来的条目当场补写进库(原来只塞内存)
//         ⑤ 落库失败在记忆页上显示出来, 不再静默
//   index.html 的 ?v= 已 bump (cinema-live.js 1.9.3 → 1.9.4,
//   cinema-storage.js 0.5.0 → 0.5.1), 沙盒页的 script 标签也补上了 ?v=
//   (原来漏了, 沙盒 iframe 可能一直吃浏览器 HTTP 缓存里的老副本),
//   所以要 bump CACHE_VERSION。
// v0.2.52.0 (2026-10-21): 修「图片传不上去」—— DatabaseClosedError: Database has been closed。
//   症状: 用户实测截图 —— 设置里选图片存人物/茶几, 弹"存不下 /
//   影片没能存进本地数据库: DatabaseClosedError Database has been closed"。
//   人物图、影片、道具全都存不进去, 整页刷新之前什么都传不了。
//   根因: cinema-storage.js 的三处补表自愈 (v66 人物 / v68 前情提要 / v69 逐条)
//   都要对同一个库做 close() → version() → open()。并发时后一个的 db.close()
//   会【取消】前一个正在进行的 open, 库停在
//   autoOpen=false + openComplete=true + idbdb=false 的脏状态 ——
//   那个状态下任何数据库操作都抛 Database has been closed, 而且永远好不了。
//   为什么昨天才炸: v69 那张表是 2026-10-19 才加的, 之前只有一个自愈撞不起来。
//   改法: ① 沙盒库把 v66/v68/v69 三张表都声明齐 → 根本不会自愈
//         ② 三处 close() 都改成 close({disableAutoOpen:false}) →
//            不取消别人的 open, 也不把"自动重开库"永久关掉
//         ③ 三处自愈走 runHeal() 排队, 不再互相踩
//   index.html 的 ?v= 已 bump (cinema-storage.js 0.5.1 → 0.5.2), 沙盒页同步。
//   所以要 bump CACHE_VERSION。
// v0.2.53.0 (2026-10-21): 新增「今日私选」AI 每日荐歌。
//   新增 js/music-daily-discovery.js (引擎) + css/music-daily-discovery.css (样式),
//   两个都进 URLS_TO_CACHE + fetch 拦截清单, 离线也能打开今日私选 tab。
//   同时 index.html 里 js/netease-music.js (?v 0.0.39→0.0.40, 加了推荐类端点 + 批量接口)
//   和 js/netease-music-app.js (?v 0.0.42→0.0.43, 加了今日私选 tab) 的 ?v= 都 bump 了,
//   init-db-schema.js (?v 0.0.41→0.0.42, 加了 db v70 的 dailyDiscovery / dailyDiscoveryFeedback)。
//   ⚠️ init-db-schema.js 不在预缓存清单里, 靠 index.html 的 ?v= 生效 —— 忘了 bump
//      手机上 Dexie 压根不建 v70 那两张表 (v66 / v69 踩过这个坑)。
// v0.2.54.0 (2026-10-21): 修「今日私选」卡在"正在挑今天的歌"不动。
//   三个根因, 全是"等网络"等出来的:
//   ① 候选收集里一堆串行网络调用 (8 个搜索 + 3 个歌单 + 5 个歌手一个一个来)
//      → 全部改成并发跑 (searchConcurrency=4 / verifyConcurrency=3),
//        画像里的 5 个歌单也改成并行。
//   ② 走主代理通道的 LLM 请求【漏传 signal】→ 那条路上 30 秒超时【完全失效】,
//      网络一挂就永远不返回 (全项目其他 fetchViaOpenAICompatibleProxy 调用点都传了, 只有这里漏)
//      → 补上 signal: ctrl.signal。
//   ③ getSongUrlsBatch 的兜底逻辑写错: 上游返回了但 url 为 null (没版权/非VIP)
//      也被当成"没回来" → 每批触发 15 次串行单发重试, 手机上能卡好几分钟
//      → 区分"上游提到过"与"有可播 url", 只对上游压根没提到的 id 单发, 且并行, 上限 15→8。
//   另加整轮生成的总预算 (totalTimeoutMs=90s): 到点必报错, 绝不让界面无限转圈。
//   UI 侧: 加载时显示已用秒数 (让人知道它还活着), 失败时给「再试一次」按钮。
//   index.html 的 ?v= 已 bump (netease-music.js 0.0.40→0.0.41, netease-music-app.js 0.0.43→0.0.44,
//   music-daily-discovery.js 0.0.1→0.0.2, music-daily-discovery.css 0.0.1→0.0.2)。
// v0.2.55.0 (2026-10-21): 修「精炼前情提要」永远连不上模型 (WebSocket 连接错误)。
//   根因: 同一把 Gemini Live API Key 同时只允许一条连接 —— 看剧那条一直挂着占着位置,
//   精炼要单开一条去问模型, 握手就被服务端拒了。浏览器 onerror 不给任何细节,
//   界面上只能显示一句 "WebSocket 连接错误" (用户实测: 点了无数次都连不上)。
//   修法 (在 modules/cinema-live.js): 精炼前先断开主会话腾出连接位, 精炼完再连回来;
//   期间不许它自动重连 / 自动连接; 第一次失败自动重试一次; 报错翻译成人话。
//   index.html 的 ?v= 已 bump (cinema-live.js 1.9.4→1.9.5, 沙盒 cinema-sandbox/index.html 同步)。
// v0.2.56.0 (2026-10-21): 长剧也能「精炼前情提要」了 + 短剧自动精炼门槛 10 集→5 集。
//   用户要求: "长剧的每节总结也可以这样总结前情提要吗" (选: 也自动注入 + 也给人看),
//   另加 "短剧我现在觉得10集才自动总结久了点, 5集精炼差不多"。
//
//   【为什么以前长剧不能精炼】不是没素材 —— 长剧的每 5 分钟一段早就在
//   cinemaEpMemories 表里了 (跟短剧的每集剧情同一张表, 用 sessionKey 分开)。
//   真冲突在存储: 短剧和长剧共用 cinemaSeriesRecap 同一行的同一个 text 字段,
//   可它俩语义不同 —— 短剧 text=前情提要(攒够才更新), 长剧 text=滚动锚(每5分钟覆盖)。
//   长剧精炼要是直接写回 text, 锚就被冲了 → 下次进影院注入的上下文从"进度"变"提要"。
//
//   【修法】
//   · cinema-storage.js: saveSeriesRecap 改成【合并写】+ 支持第二个字段 recapText
//     (短剧 text=提要 / 长剧 text=锚 + recapText=提要, 互不覆盖);
//     deleteSeriesRecap 支持只删一个字段 (长剧删提要不连坐删锚)。
//     ⇒ 这一行本来就存整个 JSON 对象, 加字段不用加 Dexie 索引 → 不用改表版本。
//   · cinema-live.js: runRecapMerge / persistSeriesRecapSafely / refineSeriesRecap
//     都支持长剧 (单位是"段"不是"集"); 长剧面板多一个「整部剧情提要」区块 +
//     「精炼剧情提要」按钮; 注入时长剧把【锚 + 提要】都喂给模型。
//   index.html 的 ?v= 已 bump (cinema-live.js 1.9.5→1.9.6, cinema-storage.js 0.5.2→0.5.3,
//   沙盒 cinema-sandbox/index.html 同步)。
// v0.2.57.0 (2026-10-22): 修「语音/视频通话挂断后的记忆总结」报 404 Invalid URL。
//   症状: 通话结束 → 记忆总结失败, 弹「API 请求失败: 404 - Invalid URL
//   (POST /v1/v1/chat/completions)」; 换成谷歌直连能通, 但 OpenAI 兼容站点死活不行。
//   真凶: 站点地址(API 预设)自己就带 /v1, 而 summarizeCallTranscript 无条件
//   又拼了一次 /v1 → /v1/v1/chat/completions, 中转网关当然认不出这条路由。
//   修法: 只补 /chat/completions, 不再自动补 /v1 (语音 + 视频 + 通话记录手动总结
//   三条路走的是同一个函数, 一处改完三处都活)。
//   index.html 的 ?v= 已 bump (memory-summary.js 0.0.41→0.0.42)。
// v0.2.58.0 (2026-10-22): 补修同款双 /v1 —— 结构化记忆的两处调用。
//   ① 长期记忆 → 结构化记忆(批量转换): 404 被 console.warn 吞掉, 界面只弹
//      "转换失败: 所有批次都未能提取有效数据 / 可能原因: Token过多…", 看着像记忆太长。
//   ② 结构化记忆「新消息总结 / 范围总结」: 抛的是 `API 错误: ${response.statusText}`,
//      跨域请求 statusText 基本是空的 → 弹出来是「总结失败: API 错误:」, 后面什么都没有。
//   改法跟通话总结一致: 只补 /chat/completions, 不再自动补 /v1。
//   index.html 的 ?v= 已 bump (memory-summary.js 0.0.42→0.0.43)。
// v0.2.59.0 (2026-10-22): 把 memory-summary.js 剩下的几处也统一成【不拼 /v1】。
//   项目设计一直是"用户自己把站点地址填全(含 /v1), 程序只补 /chat/completions" ——
//   主聊天 ai-response.js:4913 就是 `${proxyUrl.replace(/\/+$/, '')}/chat/completions`,
//   代理通路 buildOpenAICompatibleTargetUrl、cphone / proactive / 音乐日推 也都这样。
//   但 memory-summary.js 里有 4 处老写法还在"看情况补 /v1":
//     ① 1549 变量记忆提取、② 2299 结构化记忆自动总结、③ 3440 精炼长期记忆
//        (都是 `endsWith('/v1') ? /chat/completions : /v1/chat/completions`)
//     ④ 3729 记忆页「总结」按钮 (`__useSecondary ? /chat/completions : /v1/chat/completions`)
//        —— 这处的【主站分支】拼了 /v1, 跟主聊天不一致, 主站不带 /v1 时它就是坏的。
//   现在 7 处全部统一成主聊天那一写法, 一个字不差。
//   index.html 的 ?v= 已 bump (memory-summary.js 0.0.43→0.0.44)。
// v0.2.60.0 (2026-10-22): 修「视频通话结束后, 通话记录里看不到用户说的话」。
//   症状: 视频通话挂断 → 通话记录里用户那几条是 "[object Object],[object Object]",
//   AI 那几条正常(看着特别怪); 语音通话一切正常。
//   真凶: 视频通话开了「我的画面/实时摄像头」(或上传了本地视频)时, 用户那条会存成
//   多模态数组 [{type:'text'},{type:'image_url'}] —— 那是给模型看的。
//   而通话记录弹窗 / 记忆总结都是 String(content) 当文字用 → 变成 [object Object]。
//   修法 (video-voice-call.js + misc-features.js):
//   · callHistory 里的 content 永远存【纯文字】, 多模态数组另存 visionContent,
//     只在发模型时用 (messagesForApi 用 visionContent || content) → 画面功能没坏;
//   · 通话记录弹窗和记忆总结统一走 callHistoryContentToText() 取文字,
//     【以前存坏的老记录也能正常显示】;
//   · 存进 IndexedDB 的记录只留文字 (base64 帧不进库, 免得把库撑大);
//   · 顺手补上 callHistory 的 senderName —— 以前缺这一项, 记忆总结里 AI 那几行
//     全顶着 "undefined: ", 现在是 "对方名字: 说话内容" (用角色实际名字, 不写死)。
//   index.html 的 ?v= 已 bump (video-voice-call.js 0.0.81→0.0.82, misc-features.js 0.0.43→0.0.44)。
// v0.2.61.0 (2026-10-22): 修「今日私选」每首歌的推荐理由一模一样。
//   症状: 整张卡的理由全是 "来自 X，跟你最近在听的是同一个方向。", 一点推荐味都没有。
//   真凶: 引擎读的是 state.apiConfig.proxyUrl/apiKey, 而站点预设启用后这两个字段
//   会被【清空】(只留预设引用) → callLLM 直接抛 "AI 接口没配置" → LLM 压根没被调用
//   → 整轮走确定性兜底 → 兜底的理由是写死的一句模板 → 每首都一样。
//   (实测: 拿 git HEAD 的旧引擎跑新用例, 日志原样打这句, 理由和用户截图一模一样)
//   修法 (js/music-daily-discovery.js):
//   · callLLM 改走 resolveApiSlotConfig('main') 拿 API 配置 (跟项目其它地方一致),
//     拿不到才回落到 state.apiConfig —— 站点预设模式下 LLM 终于能跑起来了;
//   · 兜底理由改成 4 句轮换, 不再整张卡一句话;
//   · 模型要是偷懒把十几首写成同一句理由, 会被检测出来并换掉;
//   · 提示词加一条: 每首的理由必须针对这一首本身, 不许套同一句模板。
//   index.html 的 ?v= 已 bump (music-daily-discovery.js 0.0.2→0.0.3)。
// v0.2.62.0 (2026-10-22): 「今日私选」兜底时必须说清楚 —— 别让用户误以为那些理由是 AI 写的。
//   起因: 我上一版把根因说成"AI 接口没配置"就下了结论, 但用户反问
//   "悬浮球/情侣空间也读 state.apiConfig, 怎么它们好好的?"
//   → 那说明"读 state.apiConfig"不是普遍坏, 只有【引用了预设的槽位】才会被清空;
//     而「今日私选」失败的真实原因还有别的路 (30 秒超时 / HTTP 出错 / 输出没通过校验)。
//   修法 (js/music-daily-discovery.js):
//   · 兜底时把真实原因翻译成人话写进卡片 note:
//     "这次 AI 没接上（原因）, 下面是按你的口味兜底挑的, 理由不是 AI 写的 —— 点「换一批」可以再试一次";
//   · strategy.llmRanked 不再一律写 true —— 兜底时如实写 false + fallbackReason。
//   以后再看到千篇一律的理由, 卡片上就写明原因, 不用再猜。
//   index.html 的 ?v= 已 bump (music-daily-discovery.js 0.0.3→0.0.4)。
// v0.2.63.0 (2026-10-23): 「今日私选」三条失败路径一起修 —— 不只是"写明原因", 还要让它们少发生。
//   起因: 同一个症状(走进兜底)其实有三条路, 上一轮只做到了"让原因可见":
//     ① 配置读不到 —— 预设解析成功、但 model 是空的时候, 代码把【整份配置丢掉】
//        回落那个空的 state.apiConfig → 还是"没配置"。地址密钥有效就该用, 模型名单独兜。
//     ② 30 秒超时 —— 提示词 ~3500 token(100 候选) + 输出 20 首带理由, 手机/免费额度上必然超。
//     ③ 模型输出 id 对不上 → 一条不中就整轮作废 → 等于没策展成。
//   修法 (js/music-daily-discovery.js):
//   · 配置: 抽出 resolveLlmConfig(), 先 resolveApiSlotConfig('main') 再 state.apiConfig;
//     只要地址+密钥有效就用, model 空了从 state.apiConfig / 预设里兜, 不再自己把配置扔了;
//   · 超时: 提示词候选 100→60 砍掉一大截预填充; LLM 超时 30s→45s; 整轮总预算 90s→150s
//     (原来 90s 顶不住"收集 + LLM + 格式重试"的最坏组合 → 硬超时让整轮直接报错, 一张卡都没有,
//      比兜底出卡糟得多); 剩余预算不够再问一次时就不问, 直接兜底;
//     浏览器 abort 出来的五花八门的错统一翻译成"AI 请求超时 (45 秒没回)"。
//   · id 对不上: 校验改成三层匹配 —— id 精确命中 → id 没中就按歌名命中 → 都没有才丢;
//     id 归一化认得 "186016.0" / 带空格 / "songId"/"song_id" 等各种写法;
//     全程记账(strategy.llmDiag): 给了几条、认上几条、靠歌名救回几条、丢了几条。
//   index.html 的 ?v= 已 bump (music-daily-discovery.js 0.0.4→0.0.5)。
// v0.2.64.0 (2026-10-23): 「API 站点预设」的快照不同步 —— 换预设后几十处还在用旧地址。
//   起因: 上一版「今日私选」修好后复查同类问题, 发现全项目读 state.apiConfig 的地方
//     有几十处 (cphone / werewolf / 通话 / 狼人杀 / 专注计时 / 角色生成 / 表情包识图 …)。
//   关键事实 (之前一直没搞清):
//     · 站点预设启用后, 数据库里只留"预设引用", 静态 proxyUrl/apiKey 会被清空。
//     · 应用启动时 (init-and-state.js) 会解析一次预设并【回填】进 state.apiConfig,
//       所以这些地方平时是能用的 —— 这就是当年用户反问"悬浮球/情侣空间读
//       state.apiConfig 怎么它们好好的"的答案。
//     · 但那是【启动时的一份快照】。换一个预设之后, 只有"预设引用"变了, 快照还是旧的
//       → 几十处继续用旧地址, 最坑的是"旧地址 + 新模型"的错配 (悬浮球切预设后必现)。
//   修法:
//   · 新增 syncApiSlotConfigIntoState() (modules/api-endpoint-presets.js):
//     把各槽位【当前实际在用的】地址/密钥/模型同步回 state.apiConfig (只改内存)。
//     换预设 / 改预设之后一律调它 —— 启动、保存设置、设置页换槽位预设、
//     悬浮球换主 API 预设、预设库里改了或删了预设, 五个入口都接上了。
//   · 真正坏掉的几处改成【实时读预设】(读 db 那行是救不回来的, 库里本来就只存引用):
//     · character-generator.js  角色生成 (原来读 db.apiConfig 那行 → 预设模式下必然空)
//     · focus-timer.js           专注计时 (同上; 顺带修掉无条件多拼 /v1 的老毛病 ——
//       地址本来就带 /v1, 再补一次就变成 /v1/v1/… 404, 就是记忆总结那个毛病;
//       现在跟主聊天一样【只补 /chat/completions】)
//     · modules/green-river.js   绿水续写/作者追更 (同上)
//     · sticker-vision.js        表情包识图 (识图专用槽位配了预设时静态字段被清空 → 误回退主 API)
//     · couple-space.js          情侣空间 (41 处调用全部改成实时解析 couplespace 槽位)
//   · modules/floating-ball.js 的"保存当前配置为预设"不再存下一个空预设。
//   index.html 的 ?v= 已 bump 10 个文件 (couple-space / character-generator /
//   focus-timer / sticker-vision / green-river / floating-ball / api-endpoint-presets /
//   settings-presets / init-and-state / init-event-bindingsA)。
// v0.2.65.0 (2026-10-23): 全项目不再自动补 /v1 —— 22 处拼地址的地方统一成主聊天写法。
//   起因: 站点预设里用户填的地址【本来就带 /v1】(用户原话: "全项目所有用户填的都带 v1")。
//     所以程序只该补 /chat/completions; 再补一次 /v1 就变成 /v1/v1/chat/completions,
//     中转网关直接回 404 "Invalid URL" —— 几天前"通话记忆总结"报的就是这个。
//   改法: 22 处统一成 `` `${proxyUrl.replace(/\/+$/, '')}/chat/completions` ``:
//     · 无条件补 /v1 的 16 处 —— ai-group ×2、ai-response ×3(直连分支)、
//       auction、avatar-library、data-management、init-event-bindingsB、
//       misc-features ×2、werewolf ×5;
//     · "带不带 /v1 都判断一下" 的 6 处 —— init-features ×3、green-river ×2、
//       character-generator ×1 (它的"智能补全"三行也一并收成一行)。
//   ⚠️ 别误伤: js/mcp-tool-bridge.js 里那几处 /v1/chat/completions 是【匹配地址】用的
//     (最终 URL 本来就该含 /v1), 不是拼地址, 保持原样。
//   index.html 的 ?v= 已 bump 11 个文件 (ai-group / ai-response / auction /
//   avatar-library / data-management / init-event-bindingsB / init-features /
//   misc-features / werewolf / character-generator / green-river)。
// v0.2.66.0 (2026-10-23): 短剧「选集面板」最后几排点不到 / 拉不动。
//   症状: 148 集的剧, 面板只显示到 73–96 集, 第 97 集起被手机底部边框盖住,
//          往上拉也拉不动(用户原话: "切掉都不是问题, 只要集数能向上滚动也好")。
//   真因: 不是 CSS, 是【HTML 嵌套错位】——
//     .cinema-episode-sheet(选集面板)被写在了 .cinema-source-sheet(添加影片面板)【里面】。
//     添加影片面板关掉时是 transform: translateY(100%)(滑出屏幕),
//     选集面板作为它的子元素被【整体一起下移了自身高度】——
//     实测整个面板底边落到屏幕外 319px, 最后几排按钮永远在可视区之外。
//   改法: 把 .cinema-source-sheet 的收尾 </div> 上移, 让选集面板变成 .cinema-room 的
//     【直接子元素】。bottom:0 这时以房间为基准, 面板底边贴住房间底部,
//     集数在 grid 内部滚动, 最后几排能点到。
//   验证: 实测(390×844)选集面板 offsetParent 从 cinema-source-sheet 变成 cinema-room,
//     底边从 1163(屏幕外 319px) 回到 844(屏幕底); 滚到底最后一颗按钮 783–820 完整可见。
//   回归: 新增 tests/cinema-episode-sheet.test.cjs(23 条, 结构/CSS/JS 三层都守)。
//   index.html 的 ?v= 已 bump 1 个文件 (cinema-room.js 0.29.1 → 0.29.2)。
// v0.2.67.0 (2026-10-23): 影院陪聊改走【主聊天的主 API】。
//   起因 (用户原话): "调用的观影模型Gemini 3.8 live又要看视频又要回话实在太蠢了,
//   性格也和外面聊天的不适配"。
//   改造: Gemini Live 只保留"看画面 + 写剧情记忆"这一件事;
//        陪聊改调主 API —— 人设 / 长期记忆 / 主聊天历史 / 影院剧情记忆 全跟外面一致。
//   新增 modules/cinema-chat.js (陪聊层, 组上文 + 调主 API + 落进主聊天历史)。
//   ⚠️ 它还必须做一件事: 把主聊天提示词里的【JSON 指令系统】剥掉 ——
//     主聊天是"输出 JSON 数组"的指令式角色扮演, 影院气泡显示的是纯文字。
//   另外 Live 新增一条【此刻画面】实况通道 (每 30 秒一句, 覆盖式),
//     因为主 API 看不见画面, 只能靠这句知道自己"刚刚"看到的是什么。
//   index.html 的 ?v= 已 bump 1 个文件 (cinema-live.js 1.9.6 → 1.9.7),
//   新挂 modules/cinema-chat.js?v=0.0.1, sw.js 预缓存清单也加了它 —— 所以要 bump CACHE_VERSION。
// v0.2.68.0 (2026-10-23): 宠物屋 (Cove 灵宠屋前端移植版) 上线 + 邮箱整体下线。
//   宠物屋: 新增 modules/pet-nest.js + css/pet-nest.css + assets/pet-nest/4 张 starter 图集
//     (共 ~590KB)。必须预缓存 —— 断网时小窝要能打开, 聊天界面角上的桌宠也要有图。
//     index.html 新挂了 script/link 标签, SW 缓存了旧 index.html 就会漏掉 → 手机上整个宠物屋不出现。
//   邮箱: 整体下线 (index.html 界面 + misc-features.js 的邮件段 + init-event-bindingsB.js 的
//     两处写信生成器 + 备份导出 + 图标槽位)。主库 db.version(71) 把 emails 表真正删掉
//     (Dexie 只从 .stores() 删名字是没用的, 必须在更高版本里设成 null)。
//     index.html 的 init-db-schema.js ?v= 已 bump (0.0.42 → 0.0.43), 忘了手机就不升版。
//   所以要 bump CACHE_VERSION。
// v0.2.69.0 (2026-10-23): 宠物屋补「回到来处」返回键。
//   index.html 的 .pn-header 里多了 <button id="pn-back-btn">,
//   modules/pet-nest.js 的 ?v= 已 bump (0.0.1 → 0.0.2), css/pet-nest.css 的 ?v= 已 bump
//     (0.0.2 → 0.0.3)。
//   ⚠️ 但 index.html 自己【不带 ?v=】, sw.js 对它是 cache-first —— 只 bump 模块的 ?v=
//     管不到 index.html, SW 会一直吐 v0.2.68.0 里缓存的旧 index.html, 返回键根本不出现。
//     所以这里必须 bump CACHE_VERSION 让 SW 重装重缓存。
// v0.2.70.0 (2026-10-25): 灵宠蛋孵出来的幻兽改成【随机盲盒 + 每天换一次造型】。
//   index.html 的 pet-nest.js ?v= 0.0.13 → 0.0.14，music-player.js / cinema-room.js /
//     reading-room.js 也 bump（它们新增了 reportSignal 上报）。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.71.0 (2026-10-25): 宠物屋四个小 bug ——
//   ① 返回键被 iPhone 状态栏（时间）挡住 → 让开 safe-area-inset-top
//   ② 喂食记录里 AI 一律写「TA喂了…」 → 改成读 AI 角色名
//   ③ 事件流加时间戳（不然不知道什么时候喂的）
//   ④ 新进聊天页时桌面宠物不显示（可见性和 sprite 渲染是两条路，只走了前者）
//   index.html 的 pet-nest.js ?v= 0.0.14 → 0.0.15、pet-nest.css ?v= 0.0.6 → 0.0.7。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.72.0 (2026-10-25): 宠物屋加「删除宠物 + 饿死机制 + 小窝齿轮面板」。
//   index.html 的 .pn-header 里多了 <button id="pn-manage-btn">，
//   并新增 <dialog id="pn-manage-dialog">（规则说明 + 放弃宠物）。
//   modules/pet-nest.js 的 ?v= 0.0.15 → 0.0.16、css/pet-nest.css ?v= 0.0.7 → 0.0.8、
//   modules/pet-image.js ?v= 0.0.1 → 0.0.2（新增 releaseAssetUrls 回收 objectURL）。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.73.0 (2026-10-26): 宠物屋加「宠物说话系统」。
//   新增 modules/pet-speech.js（宠物自己开口：事件触发 + 15 分钟本地巡视 + 唤醒即说）。
//   index.html 新挂了 <script src="modules/pet-speech.js?v=0.0.1">，
//   小窝照顾弹窗里多了两个开关（允许说话 / 允许插话到聊天框）。
//   modules/pet-nest.js 的 ?v= 0.0.16 → 0.0.17、css/pet-nest.css ?v= 0.0.8 → 0.0.9。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.74.0 (2026-10-26): 宠物屋的「成长值门槛」整体上调 + 修一个秒/毫秒单位 bug。
//   成长值门槛（用户拍板的中档）：蛋类 26/130/324/648、猫狗 130/324/648（天数 2/10/25/50 不变）。
//   ⚠️ 修 bug：陪玩/摸摸了成长值的恢复间隔，上游用的是秒（time.time()），330 这边是毫秒
//      → 原来 14.4 秒就回满 1 点（上游是 4 小时），成长门槛形同虚设 → 现在按毫秒算。
//   modules/pet-nest.js 的 ?v= 0.0.17 → 0.0.18。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.75.0 (2026-10-26): 备份/恢复带上宠物屋（PetNestDB 独立库）。
//   之前主库备份只扫 db.tables，扫不到 PetNestDB → 换设备/换窗宠物全没了。
//   现在备份里多一节 petNest（宠物 + 阶段 + 事件 + 粮仓 + 样貌图），
//   localStorage 前缀清单也加了 petNest / petSpeech（桌宠开关、生图配置、上次开口时间）。
//   modules/pet-nest.js 的 ?v= 0.0.18 → 0.0.19、backup-import-export.js 的 ?v= 0.0.38 → 0.0.39。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.76.0 (2026-10-26): 宠物屋的确认框不再被自家弹窗压住 + 换成宠物屋的样式 + 动画放慢。
//   确认框看不见的真凶：我们的界面用原生 <dialog>，showModal() 会进 top layer，
//   而 #custom-modal-overlay 是普通 z-index → top layer 永远盖在它上面。
//   现在问确认前先把 <dialog> 收起来、问完再开回去，并给确认框套暖色皮肤（pn-modal-skin）。
//   6 格姿势循环放慢：x 3s / y 6s（原来 1.8s / 3.6s）。
//   modules/pet-nest.js 的 ?v= 0.0.19 → 0.0.20、css/pet-nest.css 的 ?v= 0.0.9 → 0.0.10。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.77.0 (2026-10-26): 蛋阶段的「允许说话 / 允许插话」两个开关是灰的，但写清楚为什么。
//   用户点不动以为功能坏了 → 现在照顾弹窗里多一句「还颗蛋，说不了话，孵化之后就能用了」
//   + 还差多少成长值（按门槛常量算）。
//   modules/pet-nest.js 的 ?v= 0.0.20 → 0.0.21、css/pet-nest.css 的 ?v= 0.0.10 → 0.0.11。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.78.0 (2026-10-26): 修「刚领养的猫狗也被当成蛋禁言」。
//   原来的门是 stage<=0 → 猫狗刚领养（stage 0）也一句话不说，等 10 天升阶段才能开口，
//   跟用户定的「重新打开 App → 立刻说一句」直接冲突。
//   现在只把「蛋类 + 第 0 阶段」当真蛋禁言；猫狗第 0 阶段是活的，照说。
//   modules/pet-speech.js 的 ?v= 0.0.1 → 0.0.2。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.79.0 (2026-10-26): 修「抠完的图旁边残留色块」—— 真凶是六格串格，不是抠图精度。
//   用户实测：残留的色块「像另一格的宠物的一部分」（第三张图里那块蓝的就是邻格鸟的尾羽）。
//   根因：AI 画六格没对齐 + 宠物越出自己那格 → 邻格的东西被切进本格。
//   改法：modules/pet-image.js 改成【按格处理】——每格单独抠（自己的背景色、从自己的四边泛洪）
//   + 只留本格主体（连通域删除外来碎片）+ 主体挪到格心 + 切图范围收小 8%（宠物顶到边的那侧不切）。
//   抠图算法本身也重写：多色背景 + 局部参考生长 + 多遍递增容差，
//   安全网从「画面还剩多少不透明」改成「宠物本体有没有被啃」（12% 底线会误杀只占 9.7% 的小宠物）。
//   modules/pet-image.js 的 ?v= 0.0.2 → 0.0.3。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.80.0 (2026-10-26): 小窝里的 6 格姿势动画再放慢 —— 每 3 秒换一张。
//   用户提「还是快了，改成每 3 秒换一张」→ pn-frame-x 3s → 9s、pn-frame-y 6s → 18s（一轮 18 秒）。
//   css/pet-nest.css 的 ?v= 0.0.11 → 0.0.12。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.81.0 (2026-10-26): 桌宠菜单加「喂食 / 摸摸 / 陪玩」三个快捷照顾。
//   用户提「这些还得点进宠物屋才做得到，太麻烦」→ 点桌宠弹出的菜单里直接能照顾，
//   走的是同一份 care()，喂食照样扣粮食、宠物照样会自己开口说一句。
//   index.html 的 #pn-desktop-pet-menu 里多了三个 button + 一条分隔线,
//   modules/pet-nest.js 的 ?v= 0.0.21 → 0.0.22、css/pet-nest.css 的 ?v= 0.0.12 → 0.0.13。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.82.0 (2026-10-26): 全局通知 toast 整个换掉 —— 【屏幕居中 + 宠物屋皮肤 + 停 5 秒】。
//   用户提「这个全局弹窗本来就很简陋我早就看不惯了」→
//   不再单独给宠物屋做一套（那样全应用还是老样子），直接把全局 toast 换掉，全应用都受益。
//   老样子：顶部 top:12px + 白色胶囊 + 停 3 秒 + 超过 25 个字就截成「…」（宠物的话被砍掉半句）。
//   现在：居中、奶油渐变皮肤、停 5 秒、截断放宽到 140 字、按类型上色、深色模式跟着走。
//   index.html 的 ?v=：modules/ui-modals.js 0.0.36 → 0.0.37、css/features-3.css 0.0.36 → 0.0.37。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.83.0 (2026-10-27): 宠物屋「每日换装」的三个洞一起补上 + 六格留白。
//   ① 蜕变提示词以前【收了 subject 却一次没用】→ 发出去的只有「只改这一处」，
//      模型压根不知道今天该穿什么 → 界面上写着「抱着小水壶」，画出来还是原来那只（用户实测）。
//   ② 每日换装以前只给灵宠蛋（鹦鹉、猫狗直接跳过），而且只有一个全局守卫
//      → 一天只有「最早领养的那只」能换。现在所有种类都换，守卫改成每只一个 key。
//   ③ 生图提示词从「每格塞满」改成「宠物只占格子 75%、四周留白」→ 耳朵尾巴不再画进隔壁格，
//      本地切图就不会再削掉它们（用户 2026-10-27 定的：还是六张，动作数不改）。
//   ④ 换装改成【衣服 + 道具一起换】：当天聊不到东西时按「天 + 种子」兜底挑一个道具。
//   ⑤ 自动换装和手动「换个模样」分开计数（自动的不再吃掉手动名额）。
//   ⑥ 顺带修：petView 以前不带 seed → 界面显示的穿搭和提示词算出来的是两套。
//   index.html 的 ?v=：modules/pet-nest.js 0.0.22 → 0.0.23、modules/pet-image.js 0.0.3 → 0.0.4。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.84.0 (2026-10-27): 影院两个用户实测的问题。
//   ① 影院里想聊天 → 「主 API 没配好（地址 / API Key / 模型缺一个）」。
//      真因：影院跑在 iframe 沙盒里，沙盒只加载了 7 个文件，【没有 api-endpoint-presets.js】
//      → 沙盒里没有 resolveApiSlotConfig，自己的库里也没有 apiPresets 表 → 拿不到主 API 配置；
//      而宿主传过去的 payload 里同样没有它。
//      修法：宿主用 resolveApiSlotConfig('main') 实时解析（预设模式下 state.apiConfig 里的
//      地址/密钥本来就被清空了，不能直接读），随 payload + 补发消息交给沙盒。
//   ② 一集短剧看完【第一次不总结单集剧情】，再放一遍才总结。
//      真因：摘要只有一条通道（pendingSummary），requestEpisodeSummary 抢不到就【静默放弃】；
//      而 2026-10-23 新加的「此刻画面」实况每 30 秒就占一次这条通道，短剧一集才 1~2 分钟，
//      播完那一刻正好撞上 → 这一集的单集剧情被扔了。失败时还会照样推进 seriesLastEp，
//      状态条写着「看到第 N 集」而库里根本没有这一集。
//      修法：单集总结改成【等】通道（最多 25 秒）；播完那一刻主动作废在途的「实况」让路；
//      失败不推进 seriesLastEp，且记忆面板上显示「第 N 集没总结出来」。
//   index.html 的 ?v=：modules/cinema-room.js 0.29.3 → 0.29.4、modules/cinema-live.js 1.9.7 → 1.9.8、
//   modules/cinema-chat.js 0.0.1 → 0.0.2；cinema-sandbox/index.html 里那三个也一起对齐。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.85.0 (2026-10-28): 影院「陪聊接不上话 / 导出丢剧情 / 长片卡住」三件一起修。
//   起因（用户实测）：看一部长剧，5 分钟时总结了剧情，然后 Live 断了重连 —— 视频模型回来了，
//   影院里主 API 聊天却接不上话；主 API 在影院里【没有外面聊天框的上文记忆】；
//   导出剧情记忆后【长期记忆里没有内容】，之前的也白看了；退出再进影院剧就卡住放不动；
//   出错退出来以后【外面也不能聊天】，只有大退才恢复。
//   ① 陪聊零上文（真因：影院跑在 iframe 沙盒里，沙盒只加载 7 个文件 —— 没有 message-store.js
//      / memory-summary.js / settings-presets.js / ai-response.js，外面的一切它都算不出来）。
//      修法：宿主算好【外面聊天框的历史 + 长期记忆 + 主聊天提示词预设】发给沙盒
//      （cinema:init 补发 + cinema:needContext 每次发消息前问一次），沙盒照单全收。
//   ② 导出只落最后一块（真因：沙盒里的 db.chats 是【假的】 —— 它只把 longTermMemory 的
//      最后一条 postMessage 给宿主，前面几条全丢；而导出紧接着把全部行从库里删掉）。
//      修法：新增显式通道 cinema:exportMemory —— 沙盒把【全部】chunk 发给宿主，
//      宿主写进真实长期记忆并回 ack，沙盒【收到 ack 才清账】，没写成功一行都不删。
//   ③ 影院里说的话不落主聊天历史 → 新增 cinema:chatMessage，宿主用 messageStore 写进去。
//   ④ 长片卡住（真因链：Live 推帧【完全没有背压保护】，连接一卡浏览器就无限缓冲待发帧；
//      服务端 goAway 之后还在猛推帧，把重连用的存档点撑爆）。
//      修法：bufferedAmount 超 2MB 就丢帧并告诉用户；goAway 立刻停推帧，重连成功再恢复。
//      另外大文件提示改成说实话（会「播一截就卡住」+ 建议走短剧库流式播）。
//   ⑤ 退出影院后「外面也不能聊天，只有大退才恢复」（真因：影院那个 iframe 是
//      position:fixed + inset:0 + z-index:2147483647 —— 整个屏幕都在它下面，
//      连外面顶栏和「再点一次退出」那个按钮都在它底下；而外面收掉它的唯一途径
//      = 影院发一条 cinema:closed，那条消息只要没送到（影院退出流程中途抛异常 /
//      影院页被重载 / 影院页崩了），整个 app 就被一个黑框盖死，外面点哪儿都没反应）。
//      修法：① 房间在 documentElement 上挂 data-cinema-room-open="1"；
//      ② 外面每 700ms 直接读 iframe 的 DOM（同一个站，读得到），标记没了就自己收掉；
//      ③ 影院页 pagehide 时也补发一条 cinema:closed（覆盖「影院页被换掉/重载」）。
//   index.html 的 ?v=：modules/cinema-room.js 0.29.4 → 0.31.0、modules/cinema-live.js 1.9.8 → 1.9.9、
//   modules/cinema-chat.js 0.0.2 → 0.0.3、modules/live-client.js 0.4.0 → 0.4.1、
//   modules/cinema-room.css 0.38.1 → 0.38.2；cinema-sandbox/index.html 里那几个也一起对齐
//   （沙盒的 live-client.js 以前还挂着一个 ?v=0.1.0 的老缓存键，这次一并对齐）。
// v0.2.86.0 (2026-10-28): 宠物屋三修（用户 2026-10-28 实测三连报）
//   ① 每日换装没换衣服也没道具：蜕变提示词里「按今天这身重画」那句被
//      "Additional detail to add: ..." 分支整条替换掉了 → 模型拿旧参考图照抄。
//      修法：那句永远保留，再加一句点名六格都要有道具。
//      另修「道具全网都是小碗」：关键词表里大半是泛词（吃/饭/饿/喝/睡/冷/热…），
//      谁的一天都有 → 全都命中「一只小碗」，而同分时又按【中文名】排 → 全体第一个都是小碗。
//      修法：泛词命中不算数 → 走【天+种子】兜底（每人每天都不一样）。
//      ⚠️ 判据是「这个词泛不泛」，不是「关键词有两个字以上」——
//         「听了一首歌」的"歌"、「读了一本书"的"书/读"都是单字，可那恰恰最该命中。
//   ② 宠物说的话不落进聊天框：window.renderChatMessages 全项目根本没定义
//      （真正渲染聊天的是 window.renderChatInterface）→ 那个 typeof 判断永远为假
//      → 话写进库了但界面从不重绘 → 必须退出聊天框再进才看得见。
//      修法：改调 renderChatInterface(chatId)（保留 renderChatMessages 兜底）。
//      另修：启动时 state.activeChatId 还没设 → 一句都没写进任何会话
//      → 新增 mostRecentChat()，按 lastMessageTimestamp 落到最近聊过的会话。
//   ③ 桌宠太小：桌面 78px → 98px、手机 66px → 83px（用户要 20~30%，取中值 25%），
//      尺寸统一走 CSS 变量 --pn-desktop-pet-size，要调只改那一个值。
//   index.html 的 ?v=：modules/pet-nest.js 0.0.23 → 0.0.24、modules/pet-image.js 0.0.4 → 0.0.5、
//   modules/pet-speech.js 0.0.2 → 0.0.3、modules/proactive-wake.js 0.2.15 → 0.2.16、
//   modules/in-app-proactive-patrol.js 0.2.17 → 0.2.18、css/pet-nest.css 0.0.13 → 0.0.14。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.87.0 (2026-10-28 下午): 宠物屋服装库重做（用户「像奇迹暖暖那样的娃衣一堆堆」）
//   ① 衣服 BEAST_OUTFITS 20 → **72 件**，6 个系列（甜品/童话/星际/国风/海洋/魔法萌）各 12 件，
//      全部重写成"娃衣"风格；原来 200 只宠物平均每 10 只就撞同一件（最热 16/200），
//      现在最热 8/200，且连续三天基本不重样。
//   ② 道具新增 **40 件"每日造型款"**（带 series 标签）；旧的 43 件日常道具保留 ——
//      它们只从「当天记忆里挑出来」那条路出现（用户明确要"道具服饰在记忆里匹配"）。
//   ③ 兜底挑道具时按【衣服的系列】挑 → 没聊东西的日子 = 衣服+配套道具一整套（暖暖式套装感）。
//   ④ 新增 sameItem() → 衣服和道具不会撞成同一件东西。
//      → 「一块小磨刀石」「一块小砖头」这类日常杂物不再出现在服饰描述里（用户反馈）。
//   index.html 的 ?v=：modules/pet-nest.js 0.0.24 → 0.0.25。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.88.0 (2026-10-28 下午): 生图配色跟参考图走（用户「玫红色想保持住」）
//   参考图一直是【上一次生成的那张】(row.assetRef 链式往前滚)，不是第一次破壳那张。
//   真正把颜色拉回去的是提示词: 幻兽配色领养时就定死(BEAST_PALETTES 16 选 1)，
//   每次请求都硬写 "with deep berry purple fur"，跟参考图里的玫红打架
//   (而 buildEvolvePrompt 第一句又要求 "same colors") → 颜色在紫黑↔玫红之间反复漂。
//   修法: 有参考图(蜕变) → 不写死配色，改成 "in exactly the same colours as the reference image"；
//         没有参考图(首次生成) → 照旧写盲盒配色；羽化(终形态)例外，本就该换配色。
//   index.html 的 ?v=：modules/pet-nest.js 0.0.25 → 0.0.26。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.89.0 (2026-10-29): 家庭影院「进备份」的漏洞 —— 立绘/背景是 Blob, 一律被压成 {}。
//   起因（用户原话）：「发现一个问题，家庭影院记录是不是没进备份？」
//   查出来的事实：宿主主库 6 张影院表里两张带二进制 ——
//     cinemaChars { id, image: Blob }  ← 人物立绘 + 房间背景
//     cinemaBlobs { id, file: File }   ← 影片本体
//   备份是 JSON.stringify 出来的 → Blob/File 一律被压成 {} ⇒ 立绘整个丢掉。
//   修法：① 立绘/背景导出时转 base64 dataURL，导入时还原成 Blob（位置/大小照旧）；
//        ② 影片本体不进备份（太大，base64 会撑爆手机内存）—— 元数据/进度保留，
//           换设备后重新加一次文件；导入时老备份里的空壳 {} 会被清掉，
//           免得 createObjectURL({}) 抛异常。
//   6 条导出链路（分片ZIP/流式/传统Blob/选择性/GitHub分片/GitHub大数据）都接上了，
//   4 条导入链路（整库/选择性/高级合并/GitHub恢复）都接上了。
//   ⚠️ 还原 Blob 要 await blob.arrayBuffer()，那不是 IDB 请求 ——
//      在 Dexie 事务里 await 会让事务提前提交，所以还原放在事务【外面】做。
//   index.html 的 ?v=：modules/backup-import-export.js 0.0.39 → 0.0.40。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.91.0 (2026-10-29): 影院「越看越烫 / 一句剧情总结都没写 / 十五分钟闪退」真修法。
//   起因（用户原话）：「本地视频看的时候越看手机越烫，看了十分钟动漫一句剧情总结都没写，
//   最后十五分钟左右浏览器崩溃闪退」「以前放这种动漫不会闪退的」。
//
//   ⚠️ 上一版（本地没发出去的 v0.2.90.0）方向【错了】：当时以为是"传太多画面"，
//   于是把帧率降到 0.2 FPS、长边砍到 512。用户当场反驳：
//   「从一开始就是一秒一帧没变过，刚写好时放一集根本不会发热闪退」
//   —— 对，1 FPS 从来没被改过，而"刚写好"的那版是稳的 → 差异变量不在帧率。
//
//   【对照实验证实】探针 _reports/pet-test/probe-cinema-before-after.cjs
//   把真的 cinema-live.js + live-client.js 装进 Node vm（假时钟 + 假 WebSocket +
//   真串行 turn 队列），15 分钟秒级跑完，同一份代码只切实况通道开关：
//                        帧数   上行    turn   摘要写进   单turn最多帧  输入token累计
//     BEFORE 线上版        902  79.3MB   28       0 段        899 帧      3351K
//     AFTER  现在版        902  79.3MB    7       7 段        119 帧       165K
//   → 帧数/上行【完全一样】→ 降帧碰不到任何差异变量。
//   → 真凶 = 2026-10-23 d0f41e1 引入的「此刻画面」实况通道：
//       Live 的 turn 是【串行队列】，实况每 30 秒占一个 turn；
//       而每个 turn 都要重读会话里累积的全部帧（官方：视频输入 258 token/帧），
//       会话窗口只有 128,000 token → 实况把摘要挤到后面排队 141~173 秒
//       → 撞 90 秒超时 → 【一句剧情总结都没写】；
//       累积帧涨到 899 帧 = 单 turn 输入 232K token → 早就超了窗口
//       → 重连还带 resume handle 继承爆掉的上下文 → 重连风暴 → 狂热 + 闪退。
//
//   【改了什么】
//     · 【取消「此刻画面」实况通道】—— Live 的 turn 队列只留给剧情摘要；
//     · 帧率画质【一律不动】：1 FPS / 长边 768 / JPEG q0.6（用户明确要保画质）；
//     · 长剧摘要 5 分钟 → 2 分钟一段；内容下限 80 字 → 50 字；
//     · 每次摘要截【一张】画面给主 API，【阅后即焚】（只在内存，请求发完就烧，
//       不落库、不进备份、不进导出、不进草稿，恒定最多一张）；
//     · 【每次摘要尝试之后】换干净会话（成功失败都换）—— 单个 turn 的输入
//       永远只有这一段的量（2 分钟 @ 1 FPS = 120 帧 = 30,960 token = 预算 24%），
//       永远不撞 128,000 上限；失败也换是防止"累积帧涨→更慢→更失败"的恶性循环；
//     · 保留 v0.2.90.0 做对的部分：摘要超时 90s、失败在聊天框里明说 + 60 秒重试、
//       抽帧前先问背压、诊断日志写 localStorage。
//
//   index.html 的 ?v=：modules/cinema-live.js 2.0.0 → 2.1.0、
//   modules/cinema-chat.js 0.0.4 → 0.1.0；cinema-sandbox/index.html 里那两个也一起对齐。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.92.0 (2026-10-29): 宠物屋 —— 鹦鹉换装「只有徽章，没有新衣服」。
//   用户原话：「怎么我刚才更新了，鹦鹉只有徽章，没有新衣服」。
//
//   【真因】探针 _reports/pet-test/print-real-prompt.cjs 把【真正发出去的提示词】打出来:
//   ① 六格姿态 + 布局全是【四足哺乳动物】的词:
//        "sitting with one front paw raised" / "curled up asleep" / "lying down"
//        布局那句还写着 "its ears, tail, paws and outfit"
//      → 让模型画一只【鸟】+ 抬前爪 → 它把鹦鹉画成毛球兽
//      → 人穿的衣服(草莓裙/小熊睡衣/绣花鞋)根本穿不上去
//      → 只会把「胸口别个小东西」画成一枚徽章 ⇒ 用户看到的正是「只有徽章」
//   ② 那 72 件衣服里, 鸟穿不了一批(裙/连体衣/鞋/袜/围裙),
//      还有两件是「胸口别个小东西」(薄荷糖/珍珠胸针) → 画出来也是徽章
//   ③ 道具表里一批写的是 "in its paws" → 鸟没有爪子 → 模型给它配上两只小爪
//
//   【改了什么】只动鹦鹉, 猫狗/幻兽一行不碰:
//   · pet-image.js: 六格姿态 + 布局按种类给 —— 鹦鹉用鸟的姿态
//     (站枝头 / 闭眼 / 埋头理羽 / 低头啄食 / 仰望 / 展翅),
//     布局改成 "its beak, head, wings, tail feathers and outfit";
//   · pet-nest.js: 新增 PARROT_OUTFITS(24 件, 6 系列各 4 件) ——
//     鸟穿得上的衣服: 领结/帽/围巾/斗篷/皇冠/花环/背带/披肩/斗笠…;
//   · pet-nest.js: 鹦鹉的道具 "in its paws" → "in its beak";
//   · pet-nest.js: 把宠物的 kind 传进 dailyLookFor / 生图入口
//     (鹦鹉按 kind 挑自己那套衣服 + 用鸟的姿态画六格);
//   · pet-nest.js: currentLook / 破壳那条路也传 kind ——
//     否则【名册写的衣服】和【图上画的衣服】不是同一套(2026-10-28 刚修过的老毛病)。
//
//   index.html 的 ?v=：modules/pet-nest.js 0.0.26 → 0.0.27、
//   modules/pet-image.js 0.0.5 → 0.0.6。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ── v0.2.93.0 ─────────────────────────────────────────────────
//   【本轮两件事】
//   ① 生图次数不再限制 3 次 —— 用户 2026-10-29 说「反正画多少自己掌握」
//      · pet-image.js: CFG.dailyLimit 3 → 0 (0 = 不限);
//        两处上限判断加 limit > 0 守卫 (limit=0 时不能当成「用满了」)。
//      · pet-nest.js: autoLookLimit() 0 = 不限;
//        maybeDailyRedraw 的 if (limit > 0 && used >= limit) ——
//        否则 limit=0 会把【自动换装】也一起卡死。
//      · 显式设上限 / 显式 budget 仍然拦得住 (机制没坏, 只是默认不限)。
//
//   ② 影院主 API 聊天走【谷歌原生直连】
//      · cinema-room.js (宿主): resolveMainApiConfig() 标 isGeminiNative;
//        新增 handleCinemaGeminiRequest() —— 用宿主已有的
//        toGeminiRequestData / getGeminiResponseText, 不另写一份;
//        消息监听加 cinema:geminiRequest 分支, 回 cinema:geminiResponse。
//      · cinema-chat.js (沙盒): 新增 callGeminiViaHost() ——
//        沙盒里没有 ai-response.js, 所以由宿主代打;
//        沙盒没有 toGeminiRequestData 时不再直接报错, 改走宿主代打。
//
//   index.html 的 ?v=：modules/cinema-room.js 0.32.0 → 0.33.0、
//   modules/cinema-chat.js 0.1.0 → 0.2.0、
//   modules/pet-nest.js 0.0.27 → 0.0.28、
//   modules/pet-image.js 0.0.6 → 0.0.7。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ── v0.2.94.0 ─────────────────────────────────────────────────
//   【本轮两件事】用户 2026-10-29 实测
//
//   ① 影院「live 断了怎么都重连不上 / 再进去看再久都不总结剧情」
//      · live-client.js: reconnect() 以前【不关旧 socket】——
//        connect() 里 self.ws = ws 直接覆盖了引用, 旧 socket 变孤儿,
//        但它的 onclose 还绑在同一个 self 上:
//          旧 socket 一关 → setupDone=false → 【新连接被判死】
//          → isReady() 永远为假 → 上层 waitUntilReady 超时 →
//            判定重连失败 → 再排一次重连 → 死循环
//          → 而且 isReady() 永远为假 → 摘要那条路每次早退 → 一句都不写
//      · 现在: 先把旧 socket 的回调摘掉, 再关掉它, 最后 this.ws = null。
//        (探针 _reports/pet-test/probe-live-reconnect.cjs 实锤)
//      · cinema-live.js: resetSession() 的 promise 以前没人接 →
//        失败时是 unhandled rejection 且【不会触发任何重连安排】;
//        现在接住它, 失败就按「重连」处理。
//      · cinema-live.js: live 长时间没 ready 时, 聊天区会明说
//        「Gemini Live 还没连上 —— 剧情要靠它整理, 所以现在还没写」
//        (以前是静默早退, 用户只看到「一句总结都没写」, 完全查不到原因)
//
//   ② 宠物屋「桌宠下方很长一个空间, 点到都会挪动宠物或弹菜单」
//      · 精灵是六格图集, 宠物只占格子中间一部分, 下面那截是透明的;
//        事件又绑在整个容器 #pn-desktop-pet 上 → 空白照样能点。
//      · 实测: 宠物可见高只占格高 50%~91%, 下方平均空出 9%~20% 格高,
//        再加名字标签 → 宠物下面近 30px 看不见但能点。
//      · 现在: 运行时用 canvas 量一次图集, 算出每帧的可见包围盒;
//        点的时候按坐标判, 点了空白就当没点。量不到就保守放行。
//
//   index.html 的 ?v=：modules/live-client.js 0.5.0 → 0.6.0、
//   modules/cinema-live.js 2.1.0 → 2.2.0、
//   modules/pet-nest.js 0.0.28 → 0.0.29。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ── v0.2.95.0 ─────────────────────────────────────────────────
//   【本轮】影院「只总结了第一段, 之后就再也没总结」(用户 2026-10-29 实测)
//
//   【为什么之前一直没抓住】tests/cinema-heat.test.cjs 第 6 节只断言
//     `segCount >= 1` —— 而用户的症状正好是「只有第一段」, >= 1 照样通过!
//   探针 _reports/pet-test/probe-cinema-stall-ab.cjs 在同一场景下:
//     线上版(origin/main) = 1 段  ← 用户的症状原样重现
//     修好后             = 2 段  ← live 能自己爬起来
//
//   【真因】重连 5 次失败后【彻底放弃】→ live 永远回不来
//     → isReady() 永远为假 → 剧情摘要一句都不写 (只留下第一段)。
//     诊断原文: 「连续重连 5 次仍失败，已停止自动重连。」
//
//   cinema-live.js 改了这些:
//     · scheduleReconnect: MAX_RETRY 用完不再 return 死掉, 改成每 60 秒继续重试
//       (提示只说一次, 不刷屏); 重连执行体抽成 attemptReconnect()
//     · 新增【摘要看门狗】: 每 30 秒检查 —— 摘要定时器丢了就补排,
//       live 停在 closed/error/idle 就安排重连
//     · resumeFrames: live 还没 ready 也要把摘要定时器排上
//       (iOS PWA 切后台必断 WebSocket, 原来这里直接 return → 定时器永远没了)
//     · enable() 失败不再 S.enabled = false (关掉 = 摘要每次早退 + 再也没人重连)
//     · onClientState: 补 error 状态分支 (连失败一次就永不重连的老毛病)
//     · tickStageSummary: 清掉已触发的定时器句柄 (看门狗据此判断定时器不见了)
//
//   index.html 的 ?v=：modules/cinema-live.js 2.2.0 → 2.3.0。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// ── v0.2.98.0 ─────────────────────────────────────────────────
//   【本轮】宠物屋「初始物种形象」（垫图）—— 2026-10-30 用户定的
//
//   【用户原话】
//     「我之前宠物系统的设计是每天换装的时候，拿头一天的图去垫图画新衣服新形象，
//       结果因为每次垫的图都有之前的衣服和形象，导致宠物的长相越画越不像了，
//       时间久了肯定更严重，我想改成以后用用户指定的形象去垫」
//
//   【真因】generateNewLook() 的参考图一直是【上一张生成的图】→
//     /images/edits 让模型在昨天那张上改 → 脸/花纹/衣服一层层叠上去 →
//     越画越不像，时间越久越严重。
//
//   【改法】新增「用户指定的初始形象」当【固定锚点】：
//     · pet-nest.js: DB 升到 v4, 新增 speciesImages 表(主键 petId)；
//       generateNewLook 优先拿它当参考图(拿不到才回退到上一张)；
//       设置页新增「宠物初始形象」那栏, 一只宠物一张, 可上传/更换/清除。
//     · pet-image.js: 新增 prepareSpeciesImage()（上传图居中裁方 + 缩到 640 + 转 PNG）；
//       参考图是【单人像】时提示词必须换（不能再说「参考图里有六个姿势」），
//       并加一句「只取物种/长相/配色, 忽略参考图里的衣服和背景」。
//     · ⚠️ 蛋还没孵出来时不用这张图（那时画的是蛋）。
//
//   index.html 的 ?v=：modules/pet-nest.js 0.0.33 → 0.0.34、
//   modules/pet-image.js 0.0.7 → 0.0.8、css/pet-nest.css 0.0.17 → 0.0.18。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// ── v0.2.99.0 ─────────────────────────────────────────────────
//   【本轮】读书屋 —— 旧版「一起读书」小浮窗整个重做（2026-11-01）
//
//   【用户原话】
//     「这个功能非常简陋，一个是界面又小又丑，二是我加载了一个二十四史以后
//       发现手机变得非常卡，发烫，说明不是懒加载的」
//     「搞成一个独立沙盒页面，像影院，宠物屋那样的，进去一个全屏读书屋，
//       有书架，点书架的书，打开全屏页面，背景上美化阅读图片，一次只加载一页，
//       然后留一个聊天窗口供我和AI随时讨论」
//
//   【卡 + 发的真因（实测，不是猜）】
//     旧版把【整本书】塞进 readingLibrary 的一条记录的 content 字段。
//     真 IndexedDB + 真 Dexie 实测（2000 万字 / UTF-16 38.2MB）：
//       db.books.update(id,{currentPage}) = 96~126 ms  ← 每翻一页搬一遍整本书
//       db.books.orderBy().toArray()       =  39 ms    ← 开一次书库搬一遍全库
//       同样一张表, 记录里【没有 content】时: update = 2 ms, toArray = 0 ms
//       split 切行 31.4 万行 → 常驻 ≈44.8MB, 整页 JS heap 307 MB
//     再加上「书库搜索框每敲一个字就重跑一次全库 toArray」（没有防抖）。
//
//   【改法】
//     · DB 升 v72：readingBooks(只有元数据) + readingPages(一页一条, [bookId+pageNo] 复合索引)
//     · modules/reading-storage.js：分页存储 + file.stream() 流式切页导入
//       （峰值内存 = 一页，不是 38MB）+ 旧书迁移
//     · reading-sandbox/：独立 iframe 沙盒（照抄影院那套），
//       书架大厅 + 全屏阅读室 + 背景 + 一次只渲染一页 + 下半屏固定聊天窗
//     · modules/reading-room.js 重写：宿主侧桥接 + AI 请求代打
//       （沙盒里没有 ai-response.js / utils.js，谷歌原生地址自己拼必然 404）
//     · 旧浮窗 DOM 全删（index.html 里 #reading-overlay / #reading-window /
//       #reading-content / #import-book-modal / #reading-library-modal）
//     · makeDraggable 从 reading-room.js 搬到 utils.js
//       （视频/语音通话的悬浮球还在用它，搬走免得以后再被改一次弄挂）
//
//   index.html 的 ?v=：modules/reading-storage.js 新增 0.1.0、
//   modules/reading-room.js 0.0.39 → 0.1.0、modules/init-db-schema.js 0.0.43 → 0.0.44。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ── v0.2.100.0 ───────────────────────────────────────────────
//   【本轮】读书屋第一批真机反馈修正 (2026-11-02)
//
//   【用户原话】
//     「首先是书架大厅，没看见返回聊天框的返回键，需要加一个」
//     「点开书页以后，那个返回书架的返回键位置不要放得太高，
//       这软件要在手机PWA上用的，要腾出时间显示栏的位置出来」
//     「兼容的小说文本格式不对，有的导入全是乱码」
//     「书架上的书不想看了没有删除选择」
//     「聊天默认提示框里写个史书看不懂的尽管问，又不是所有人都要看史书，
//       这个提示不要写」
//     「和AI讨论内容的时候，用的Minimax模型，连think思维链都全露出来了」
//     「书房共读聊天用的API支持哪些线路接口，要和主聊天一样支持
//       Openai兼容和谷歌直连哦」
//
//   【七处修正】
//     ① 书架大厅顶栏加「‹ 返回聊天」（原来只有右上角一个 22px 的 ×，没人知道那是回聊天）
//     ② 顶栏避让手机状态栏 —— env(safe-area-inset-top) 在【iframe 里】基本返回 0
//        （安全区是顶层文档的概念），改由宿主量出真值 → --rr-safe-top 下发沙盒
//     ③ 导入乱码 —— 原来用 new TextDecoder('gbk') 试，标签在部分浏览器直接抛异常
//        → catch 之后回落 utf-8 → GBK 小说整本乱码。
//        现在: BOM → 严格 utf-8 → 严格 gb18030 → 严格 gbk → 兜底 utf-8，
//        而且【头尾各取 64KB】（只看头的话，小说开头的版权页/目录全是 ASCII，
//        必然误判成 utf-8）
//     ④ 删除按钮 —— CSS 是 display:none（只在 .show-del 时显示，而代码从没加过那个 class）
//        → 按钮压根没渲染出来。现在常驻显示，34px + 🗑
//     ⑤ 聊天框提示语去掉"史书里看不懂的" → 通用文案
//     ⑥ MiniMax 思维链 —— 流式加状态机（<think> 标签会跨 chunk 断开），
//        收尾再走主聊天那套 cleanMinimaxResponseText；
//        prompt 里也写死"不要输出 <think> 和思考过程"
//     ⑦ API 线路对齐主聊天 —— 补上【角色独立 API】(chat.apiOverride)，
//        并且改成【每次实时解析】预设（原来缓存了一份，用户中途切预设不生效）
//
//   index.html 的 ?v=：modules/reading-storage.js 0.1.0 → 0.1.1、
//   modules/reading-room.js 0.1.0 → 0.1.1；沙盒页 + css/js 也 0.1.0 → 0.1.1。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ── v0.2.101.0 ────────────────────────────────────────────────
//   【本轮】桌宠「下面一条看不见的长条, 把聊天框按钮都挡住了」（2026-11-02）
//
//   【用户原话】
//     「聊天框的那个宠物桌宠虽然图片下方看不见东西，但是好像有很长一片区域在隐形
//       遮挡聊天框的其他功能，如果桌宠放右上，我甚至点不到右下弹出来的匹配表情包，
//       就是桌宠下方很长的遮挡区域在遮挡，挪开就能点了」
//     「不是层级的问题……就不能把这个区域改得和桌宠范围一样？哪怕挡也只挡那一点啊」
//
//   【真因（真实页面实测, 不是猜）】
//     #pn-desktop-pet 是 position:fixed, CSS 写死 right:14px + bottom:92px;
//     拖拽之后 JS 又写 style.left / style.top —— 两套定位【同时生效】。
//     绝对定位元素在 top+bottom 都指定、height 是 auto 时, 高度会被撑满整段
//     (CSS2.1 §10.6.4) → 容器变成一条从顶到底的透明长条:
//       实测 430x900 视口: 默认 98x106px  →  拖一次之后 98x673px
//     连带两个副作用:
//       · offsetHeight 变成几百 px → 拖动时 maxY = innerHeight - offsetHeight ≈ 0
//         → 桌宠一旦被拉长就再也拖不到下面 (用户说"放右上"就下不来了)
//       · 菜单/气泡是 bottom:100% 定位 → 长条一撑开, 菜单跑到屏幕外, 根本点不到
//
//   【改法】
//     ① pet-nest.js 新增 useLeftTopPosition(): 切到 left/top 定位时
//        把 right/bottom 明确清成 auto (拖拽前先切, 恢复上次位置也走这条)
//     ② css/pet-nest.css 给容器写死 height:fit-content —— 兜底,
//        即使 right/bottom 还在, 高度也只跟内容走, 永远不会被拉长
//     ③ 容器 pointer-events:none —— 容器盒子有多大, 就有多大一片看不见的地方
//        在替下层按钮挡鼠标; 现在只有【宠物图片 / 名字 / 菜单】能点
//
//   index.html 的 ?v=：modules/pet-nest.js 0.0.34 → 0.0.35、css/pet-nest.css 0.0.18 → 0.0.19。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ── v0.2.102.0 ────────────────────────────────────────────────
//   【本轮】宠物抠图：浅色宠物（淡蓝色那种）自己那块被抠成透明（2026-11-02）
//
//   【用户原话】
//     「如果宠物画出来是比较浅的颜色，比如淡蓝色，就很容易在抠图处理以后
//       出来的是透明的，就是宠物自身的浅色区域也被扣掉了」
//     「现在只要稍微画深色一点点就能正常抠」
//
//   【真因（合成图 + 真实代码实测, 不是猜）】
//     ① 泛洪的"局部参考生长"能跨过【平滑渐变】走进宠物内部。
//        宠物椭圆顶部那条软边按归一化半径算，在像素上宽达 40px，每步只差 0.5~1
//        → 任何容差都拦不住（实测容差 46→8、局部上限 26→6，浅蓝宠物每次都被吃光 99.5%）。
//     ② 本体保护网(far/near)是按【离背景色的距离】算的 → 浅色宠物整个不在网里
//        → 网子只护得住那几百个深色像素（眼睛）。
//     ③ 兜底「画面还剩多少不透明」以前【只在没有深色本体时才生效】
//        → 浅色宠物有眼睛 → 走另一条分支 → 这条兜底被跳过 → 宠物被吃光没人拦。
//
//   【改法（两处，都是最小改动, 没有重写算法）】
//     ① runCutPasses 的安全网：把「不许把画面抠空」这条提成【始终生效】
//        → 浅色宠物被吃光 → 整遍回滚 → cutout() 自动走保守重试 → 宠物保住。
//     ② 保守重试的倍数 0.7 → 0.5：0.7(=容差32.2) 还会啃掉色距 25~30 的浅色宠物
//        （实测浅紫只剩 72%、浅灰蓝只剩 66%）；0.5 → 12 种浅色/深色宠物全部 100% 存活。
//     容差本身【不动】（实测调小会直接换来背景残留：容差 12 → 残留 19.6%，8 → 60.7%）。
//
//   index.html 的 ?v=：modules/pet-image.js 0.0.8 → 0.0.9。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ============================================================
// v0.2.103.0 —— 读书屋真机两个 bug (2026-11-02)
//   ① 「找不到配置的 API，没法跟 AI 讨论」
//      根因: modules/reading-room.js 的 resolveMainApiConfig() 里
//            return global.resolveApiSlotConfig('main').then(function (cfg) { main = cfg; });
//      那个回调【没有 return】→ 整条 Promise 链 resolve 成 undefined →
//      下一级 .then(function (main) {...}) 收到 undefined → 一律 return null
//      → 报「主 API 没配好（地址 / API Key / 模型缺一个）」。
//      跟用户怎么配 API 完全无关 → 读书屋永远问不了 AI。
//      修法: 直接把 Promise 往下传, 别在回调里赋值。
//   ② 「只要点击输入框，屏幕就会异常放大」
//      根因: iOS Safari 聚焦【字号 < 16px 的输入框】会自动把页面放大
//            (iOS 10+ 不认 user-scalable=no / maximum-scale=1, 拦不住)。
//      读书屋沙盒里 #rr-chat-input / #rr-search 都是 14px → 必触发。
//      修法: 两个输入框字号 14px → 16px (跟主聊天 css/chat-ui.css 一致)。
//
//   index.html 的 ?v=：modules/reading-room.js 0.1.1 → 0.1.2；
//   reading-sandbox/index.html 里的 reading-sandbox.css 0.1.1 → 0.1.2。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ============================================================
// v0.2.104.0 —— 书架 UI 局部改造 (2026-11-02)
//   ① 卡片右上角常驻的 🗑 → ⋯ 三点菜单 (CSS 画的点, 不用素材)
//      点开是一张羊皮纸小卷轴, 里面只有两项: 更换封面 / 删除书籍
//      (删除沿用原有的 confirmDelete, 没重写删除逻辑)
//   ② 新增「更换封面」: 选图 → 压到最长边 420px 的 JPEG → 预览 → 确认 → 存进
//      新表 readingCovers (db v73) → 卡片封面当场更新, 刷新后还在
//      ⚠️ 封面单独一张表, 不塞进 readingBooks —— 那张表只放元数据, 塞 base64 会
//         让"开书架"把所有封面搬一遍 (跟当年"整本书塞一条记录"同一个坑)
//
//   index.html 的 ?v=：modules/reading-storage.js 0.1.2 → 0.1.3、
//   modules/init-db-schema.js 0.0.45 → 0.0.46、modules/init-data-protection.js 0.0.36 → 0.0.38；
//   modules/reading-room.js 0.1.3、reading-sandbox 那两个版本号不变。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
//
// ============================================================
// v0.2.105.0 —— 修「整个 app 白屏起不来」(2026-11-03)
//
//   🔴 病根: v0.2.104.0 把封面表加成了主库的 db.version(73)。
//      给主库加版本号 = 触发一次 IndexedDB 升级。而 IndexedDB 的规矩是
//      「只要还有别的连接开着旧版本，本次升级就无限期排队」。
//      升级一被挡住，db.open() 就【既不成功也不失败】(pending)，
//      启动链里 await loadAllDataFromDB() 永远等不到库 →
//      showScreen('home-screen') 永远不执行 → 白屏。
//      pending 不算 error，所以控制台一条红字都没有，极难查。
//      实证: _reports/reading-room-test/diag-boot4.cjs
//            (无头 Edge + CDP，B 标签页 indexedDB 一直停在 720，dbReady 90 秒到不了 true)
//
//   ✅ 修法: 封面改到【独立数据库 ReadingCoversDB】(跟 PetNestDB / XSocialDB 一个路子)。
//           主库版本退回 72，这次的改动对它【零影响】—— 不升级，就不可能被挡住。
//           那个库还是懒建的: 没换过封面的人，IndexedDB 里根本不会有它。
//
//   🛟 顺手加了三道保险 (以后再遇到同类问题不会是纯白屏):
//       · init-db-schema.js: 监听 blocked → 控制台明确报「被别的页面挡住了」
//       · init-data-protection.js: 开库超过 20 秒没好 → 屏幕上弹提示 + 「重新加载」按钮
//       · init-data-protection.js: 磁盘上的库版本比代码新时自动跟进(否则 Dexie 抛 VersionError)
//
//   🧨 同一批里还修了个我自己刚引入的致命错误:
//      init-data-protection.js 里写了 global.markDbBlocked —— 这个文件里根本没有 global
//      这个标识符(它是别的文件 IIFE 的形参)，会直接 ReferenceError，一样白屏。
//      已改成 window.markDbBlocked。
//
//   🩹 顺手修掉一条会误导排查的老红字:
//      init-data-protection.js 的 wrapDatabaseOperations() 用了 Dexie.Table.prototype，
//      但 Dexie 4 的 CDN 构建里【没有 Dexie.Table】(实测那份文件里连这个字符串都搜不到)
//      → 每次启动都抛 TypeError，控制台留一条红字。功能不受影响，但下次排查"起不来"
//      会被它带偏。已改成没有 Table 就安静跳过。
//      (顺带: 用户旧控制台里【没有】这条红字，反证了 dbReady 从没变 true —— 即库没打开过)
//
// ============================================================
// v0.2.106.0 —— 书架卡片只留封面 (2026-11-03)
//
//   用户看真机截图后说: "封面图占全部不好看, 下面那行说明文字是否可以不要"。
//   ① 卡片去掉说明区(书名/字数·页数/进度条) → 整张卡片只剩封面图
//   ② 封面从 background-size:cover 改成 contain → 【整张封面完整显示, 不裁切】
//      (以前竖版封面被裁掉两边; 代价是图和卡片比例不同时四周会留白)
//      容器高度用 aspect-ratio: 3/4 定住 (常见书籍开本比例)
//   ③ 顶栏补上字数统计 —— 卡片说明区去掉后, 字数信息挪到阅读页顶栏
//      (新元素 #rr-book-stat, 挨着页码)
//
//   index.html 的 ?v=：reading-sandbox/index.html 里的
//   reading-sandbox.css 0.1.3 → 0.1.4、reading-sandbox.js 0.1.2 → 0.1.3。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// ============================================================
// v0.2.109.0 —— 修「竖屏在线短剧: 一集播完没总结 / 播一半 Live 重连 / 总结只有半截」(2026-11-04)
//
//   用户 2026-11-03 晚上实测 (家庭影院 → 在线短剧):
//   "这次的短剧是竖屏的, 一集播完第一次没总结剧情, 第二次播一半观影API重连,
//    最后总结的剧情就只有半截; 测试了一下, 好像横屏的在线短剧又可以正常总结剧情"
//
//   真因不是竖屏/横屏, 是【一集长度 vs 2 分钟的摘要间隔】:
//   短剧模式下长剧式的「每 2 分钟一段」阶段摘要一直在跑, 它同时干三件事:
//     ① 抢那条唯一的摘要通道 → 一集播完那一刻正好撞上在途请求 → 这一集白看
//     ② 和「每集单集剧情」写同一张表、同一个主键 (id="<剧名>#<ep>") →
//        段号跟集号都是 1,2,3… → 短集时段落摘要在集后发, 把这一集顶成半截
//     ③ 每次阶段摘要后 S._needFreshSession=true → 帧循环里 resetSession()
//        → Live 断线重连 → 会话里累积的画面全没了 → 这一集只剩尾巴
//   长集时阶段摘要在集中间发, 单集剧情后写能盖回来 → 看着就正常 (所以"横屏没事")。
//
//   修法 (modules/cinema-live.js):
//     · 短剧一律不跑长剧式阶段摘要 (scheduleStageSummary / tickStageSummary /
//       看门狗 三处都挡) —— 短剧的载体本来就只有「每集一条」
//     · 短剧改成【每集播完换干净会话】—— 换在集与集之间, 不在一集中间,
//       这一集的全部画面都在它自己那个会话里 → 总结完整
//     · 段落记忆在短剧模式下不落库 (最后一道保险)
//     · 单集总结失败 (Live 没连上) 不再静默丢弃 → 记忆页上显示红字
//   长剧一行没动 (阶段摘要照旧)。
//
//   新增回归: tests/cinema-series-summary.test.cjs (19 条)
//   index.html 的 ?v=：modules/cinema-live.js 2.4.1 → 2.4.2 (沙盒同步)。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// ============================================================
// v0.2.110.0 —— 长剧「阶段摘要失败 → 那一段整段丢」 (2026-11-04)
//
//   用户追问: "长剧如果每 2 分钟换一次会话, 是不是也会丢失部分剧情"
//   实测 (探针 _reports/cinema-test/probe-series-summary.cjs, 让模型只吐 2 个字):
//
//   旧写法 (失败也换会话): turn 120(失败) → 252(重试) → 372 → 492, 只落【2 段】
//     第 1 次失败 → 换会话 → 画面全丢 → 重试是在新会话里发的, 模型看到的是
//     重试后那 60 秒的画面, 不是原来那 2 分钟的 → 【0~120 秒那段真的没了】。
//     而且重连那一轮还得等 Live 重新 ready, 重试被拖成一整轮 (252s)。
//   新写法 (失败不换会话): turn 120(失败) → 192(重试) → 312 → 432, 落【3 段】
//     第 1 次失败 → 【不换】→ 画面留着 → 60 秒后的重试还能看到同一批画面
//     → 那一段保住了 (重试写出来的是 0~192 秒, 含失败那段), 重试也不用等重连。
//
//   修法 (modules/cinema-live.js):
//     · runStageSummary 收尾: 【成功才换会话】; 失败不换 (画面留给重试)
//     · tickStageSummary 重试分支: 连着失败【两次】才强制换
//       (那才是 2026-10-29 要防的"帧一直累积 → turn 变慢 → 更容易失败"的恶性循环)
//     · 累积上限: 正常每段换 120 帧; 失败后多攒 60 秒 = 180 帧
//       (258 token/帧 ≈ 46k token, 窗口 128K) —— 仍在预算内
//
//   新增回归: tests/cinema-series-summary.test.cjs 第 ⑤ 组 (4 条)
//   index.html 的 ?v=：modules/cinema-live.js 2.4.2 → 2.4.3 (沙盒同步)。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
// v0.2.111.0 —— 短剧「一集播完总结时 API 抽风 → 这一集白看」 (2026-11-04)
//
//   用户追问: "短剧如果一集结束剧情总结的时候API抽风, 没能总结起, 是不是就瓜起了"
//   实测 (探针 _reports/cinema-test/probe-series-summary.cjs, 让服务端不回话):
//
//   旧写法: 一集播完 → 要一条单集剧情 → 模型 90 秒不回话 → 超时
//     → 这一集在库里【直接没了】, 而聊天区一句提示都没有 → 用户以为看过了,
//       直到几集之后点「精炼」才发现素材不对。
//     而且就算之后重试, 画面也已经不在了 (失败就换会话) → 救不回来。
//
//   修法 (modules/cinema-live.js):
//     · 一集总结失败 → 【不换会话】(这一集的画面还留在 Live 会话里)
//       → 60 秒后自动重试一次 → 重试时模型看到的还是这一集 → 补得上, 不用重播
//     · 重试成功 → 才换干净会话 (下一集从零开始看) + 聊天区「✅ 第 N 集补记上了」
//     · 重试失败 → 聊天区「⚠️ 第 N 集还是没总结出来 —— 重播这一集就能补上」
//     · 换集了就放弃重试 (画面混了会串味), 并且要跟用户说清楚
//       · 重试【已经排好】时换集 → onSeriesEpisodeChanged 取消 + 清混在一起的画面
//       · 换集【早于失败被察觉】→ scheduleEpisodeSummaryRetry 一开始就放弃
//         (模型 90 秒不回话时用户先点了下一集 → 画面已经混了 → 重试没意义)
//     · 放弃重试时【不】换会话: 新一集已经播了一会儿, 换掉就把新一集的画面也扔了
//     · 重试成功 → 换会话时必须把【前情提要】喂回新会话
//       (走 resetSessionAfterEpisode, 不能只 resetLiveSession)
//       → 少这一步, 下一集开播时模型手里是空白的 → 下一集的单集剧情少了上一集的上下文
//     · 换集时清掉上一集的画面 → 下一集不会跟上一集串味
//       (实测: 清了 = 下一集那一回合只看到 90 帧; 没清 = 180 帧, 两集混一起)
//     · 四个失败点全部补上聊天区提示 (原来只有面板红字, 用户基本不会去翻那一页)
//
//   新增回归: tests/cinema-series-summary.test.cjs 第 ⑥⑦⑧ 组 (17 条)
//             tests/cinema-episode-summary.test.cjs 第 ⑦ 组 (5 条)
//   反向验证: _reports/cinema-test/reverse-verify-episode-retry.cjs (6 个用例全报红)
//   index.html 的 ?v=：modules/cinema-live.js 2.4.3 → 2.4.4 (沙盒同步)。
//   ⚠️ index.html 自己不带 ?v=，SW 对它是 cache-first → 必须 bump CACHE_VERSION。
const CACHE_VERSION = 'v0.2.111.0';
const CACHE_NAME = `ephone-cache-${CACHE_VERSION}`;

const URLS_TO_CACHE = [
  './index.html',
  './online-app.css',
  './script.js',
  './modules/hot-news.js',
  './modules/runtime-diagnostics.js',
  // v0.1.28 新增：AI 唱歌�? 个新模块�?
  './modules/ai-music.js',
  './js/music-voice-sample.js',
  './js/role-voice-sample-ui.js',
  // v0.1.29 新增：AI 原创�?IndexedDB 持久化层
  './js/ai-songs-store.js',
  './js/netease-music.js',
  // v0.2.53.0 新增: 「今日私选」AI 每日荐歌引擎 + 样式
  './js/music-daily-discovery.js',
  './css/music-daily-discovery.css',
  // v1.0.0 改�? 通用 MCP 工具（删 mcd/luckin 硬编�? 删旧 mcp-ui-init + 3 �?css, �?generic-client + ui-list�?
  './js/mcp-generic-client.js',
  './js/mcp-tool-bridge.js',
  './js/mcp-ui-list.js',
  // v0.1.55 新增: MCP 菜单卡片渲染（粉白色系浮动按�?+ 全屏 sheet�?
  './js/mcp-menu-card.js',
  './js/mcp-pay-card.js',
  './js/mcp-tool-call-log.js',
  // v0.2.31.9: 工具调用实时进度 (紧跟 AI 气泡, 完成后移除)
  './js/mcp-tool-progress.js',
  './css/mcp-miniapp-pink.css',
  // v0.2.0 新增：Live2D 视频通话（PIXI v8 + untitled-pixi-live2d-engine + 视频通话主文件）
  // v0.2.31.53 引擎本地化 + 进预缓存: 引擎原来只靠"运行时缓存"活着, 一旦 CACHE_VERSION bump
  //   旧 cache 被 activate 删掉, 引擎就得重新走 CDN, 网络一抖就 PIXI.live2d 不存在 → 模型加载不出。
  //   现在四个引擎文件全在本地 lib/ 且进 URLS_TO_CACHE, 版本 bump / 断网都不影响。
  './lib/live2dcubismcore.min.js',
  './lib/live2d.min.js',
  './lib/pixi.min.js',
  './lib/pixi-live2d-display.cubism4.min.js',
  './modules/live2d-loader.js',
  './modules/video-voice-call.js',
  // v0.2.31.43: 视频通话 AI 说话口型 (独立模块)
  './modules/call-lip-sync.js',
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://phoebeboo.github.io/mewoooo/pp.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js',
  './assets/icon-192.png',
  // v0.2.15.1 新增: �?ByteString 涉及�?3 �?modules (之前漏了, 现在加进白名�? SW 主动缓存)
  './modules/proactive-wake.js',
  './modules/notification-battery.js',
  './modules/background-activity.js',
  // v0.2.31.69: Cinema Room 第一阶段 (2026-10-04) 新模块。
  //   影片本体走 IndexedDB 直存 Blob, 不经过 SW —— 视频永远不进 Cache API
  //   (进 Cache 会双份占空间, 且 24MB+ 直接撑爆安装期缓存), 只把这三个静态壳文件预缓存。
  './modules/cinema-storage.js',
  './modules/cinema-img.js',
  './modules/cinema-room.js',
  './modules/cinema-room.css',
  './modules/cinema-live.js',
  // 2026-10-23 影院陪聊层 (陪聊改走主 API)。跟上面三个一样必须预缓存 ——
  // SW 缓存了旧 index.html 就会漏掉这个新 script 标签, 手机上影院聊天直接报错。
  './modules/cinema-chat.js',
  // 房间背景图 93KB, 预缓存是为了离线也能开房间 + 首屏不闪白。
  // jpg 兜底不预缓存 —— 只给不认 webp 的老 WebView 用, 按需拉就行。
  './assets/cinema-room-bg.webp',
  // 2026-10-23 宠物屋 (Cove 灵宠屋前端移植版)。
  // 4 张 starter 图集共 ~590KB, 必须预缓存 —— 断网时小窝要能打开, 桌宠也要有图。
  './modules/pet-nest.js',
  './modules/pet-image.js',
  './modules/pet-speech.js',
  './css/pet-nest.css',
  './assets/pet-nest/room-light.webp',
  './assets/pet-nest/room-star.webp',
  './assets/pet-nest/cat-sprites-light.webp',
  './assets/pet-nest/dog-sprites-light.webp',
  './assets/pet-nest/egg-sprites-light.webp',
  // v0.2.99.0 新增: 读书屋 (2026-11-01)。
  // 沙盒页 + 两个模块必须预缓存 —— 沙盒页被 SW 的 '/index.html' 白名单命中,
  // 不预缓存的话断网时点「一起读书」直接白屏。
  './reading-sandbox/index.html',
  './modules/reading-storage.js',
  './modules/reading-room.js',
  './modules/reading-sandbox.js',
  './modules/reading-sandbox.css',
  // 两张背景图 + 两张书架卡片缩略图, 共 254KB。
  // 背景图是整页铺的, 不预缓存的话每次进读书屋都先闪一下白底。
  './assets/reading-room/reading-hall-bg.webp',
  './assets/reading-room/reading-page-bg.webp',
  './assets/reading-room/reading-hall-bg-thumb.webp',
  './assets/reading-room/reading-page-bg-thumb.webp',
  // v0.2.104.0 新增: 卡片菜单的羊皮纸卷轴 (45KB)。
  // 不预缓存的话, 第一次点 ⋯ 会有一下白闪 (菜单底图是异步拉的)。
  './assets/reading-room/menu-scroll.webp'
];

self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  // v0.2.24 �? iOS PWA 模式�?service worker install 后卡 waiting (�?SW 永不关闭), �?self.skipWaiting() 强制 activate
  //   之前 v0.2.23 部署了但 PWA �?SW 没真激�? 报错没变. skipWaiting() 让新 SW 跳过 waiting 立刻 activate.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cache opened, caching core files...');
        // 2026-07-24 修复：cache.addAll �?allSettled 单独缓存每个文件
        // 原因：URLS_TO_CACHE 里有 25 个文件（�?5 个外�?CDN），任何一�?fetch
        // 失败（CDN 抽风 / CORS / 404）整�?addAll 就会 reject，导�?SW install
        // 永远�?installing 状�?�?navigator.serviceWorker.register() 抛错 �?
        // "一键修复通知" alert 里看不到"已重新注�?的成功提示�?
        // 改宽容后：单个失败只 warn 跳过，整�?install 必成功�?
        return Promise.allSettled(
          URLS_TO_CACHE.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] 缓存失败（已跳过�?', url, err.message || err);
              return null;
            })
          )
        ).then(results => {
          const ok = results.filter(r => r.status === 'fulfilled').length;
          const fail = results.length - ok;
          console.log(`[SW] Core files cached: ${ok} ok, ${fail} failed.`);
        });
      })
      .then(() => {
        console.log('[SW] skipWaiting()');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated.');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  const isLocalAsset = url.startsWith(self.location.origin) &&
    (url.includes('/index.html') ||
     url.includes('/online-app.css') ||
     url.includes('/script.js') ||
     url.includes('/modules/hot-news.js') ||
     url.includes('/modules/runtime-diagnostics.js') ||
     // v0.1.28 新增：AI 唱歌模块
     url.includes('/modules/ai-music.js') ||
     url.includes('/js/music-voice-sample.js') ||
     url.includes('/js/role-voice-sample-ui.js') ||
     // v0.1.29 新增：AI 原创曲存储层
     url.includes('/js/ai-songs-store.js') ||
     // v0.2.53.0 新增: 「今日私选」引擎 + 样式
     url.includes('/js/music-daily-discovery.js') ||
     url.includes('/css/music-daily-discovery.css') ||
     // v1.0.0 改�? 通用 MCP 文件命中拦截, 走缓存（请求带回 ?v= 时也�?fetch�?
     url.includes('/js/mcp-generic-client.js') ||
     url.includes('/js/mcp-tool-bridge.js') ||
     url.includes('/js/mcp-ui-list.js') ||
     // v0.3.2 更新：Live2D 视频通话（loader + 视频通话主文件 + Cubism 4 core 本地；模型走 IDB 不再 fetch assets/）
     // v0.2.31.53: 引擎四个文件本地化, 一起纳入拦截 (命中预缓存, Netlify/PWA 断网也能起引擎)
     url.includes('/lib/live2dcubismcore.min.js') ||
     url.includes('/lib/live2d.min.js') ||
     url.includes('/lib/pixi.min.js') ||
     url.includes('/lib/pixi-live2d-display.cubism4.min.js') ||
     url.includes('/modules/live2d-loader.js') ||
     url.includes('/modules/video-voice-call.js') ||
     // v0.2.68.0 (2026-10-23): 宠物屋。4 张图集走 cache-first (不带 ?v=, 命中预缓存直接用),
     //   js/css 带 ?v= 走 network-first + 缓存兜底 —— 改了能立刻生效, 断网也能起。
     url.includes('/modules/pet-nest.js') ||
     url.includes('/modules/pet-image.js') ||
     url.includes('/modules/pet-speech.js') ||
     url.includes('/css/pet-nest.css') ||
     url.includes('/assets/pet-nest/') ||
     // v0.2.99.0: 读书屋 (2026-11-01)。
     // ⚠️ reading-sandbox/index.html 会被上面那条 '/index.html' 命中 → 走 cache-first。
     //   它自己带 ?v= (见 modules/reading-room.js 的 iframe src) → 实际是 network-first,
     //   改了立刻生效, 断网回落到预缓存那份。
     url.includes('/modules/reading-storage.js') ||
     url.includes('/modules/reading-room.js') ||
     url.includes('/modules/reading-sandbox.js') ||
     url.includes('/modules/reading-sandbox.css') ||
     url.includes('/assets/reading-room/'));

  const isKnownCDN =
    url.includes('unpkg.com/dexie') ||
    url.includes('cdnjs.cloudflare.com/ajax/libs/html2canvas') ||
    url.includes('cdn.jsdelivr.net/npm/streamsaver') ||
    url.includes('phoebeboo.github.io/mewoooo/pp.js') ||
    url.includes('i.postimg.cc/') ||
    // v0.3.0 回退：Live2D 引擎 (PIXI v6 + pixi-live2d-display 0.4.0 + Cubism 4 core 本地, 330 v0.1.30 旧栈)
    url.includes('cdn.jsdelivr.net/npm/pixi.js@6.5.0') ||
    url.includes('cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0') ||
    url.includes('cdn.jsdelivr.net/gh/dylanNew/live2d');

  if (isLocalAsset || isKnownCDN) {
    const isVersioned = url.includes('?v=');
    if (isVersioned) {
      event.respondWith(
        fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            const noQueryUrl = url.split('?')[0];
            caches.open(CACHE_NAME).then(cache => cache.put(noQueryUrl, clone));
          }
          return response;
        }).catch(() => caches.match(url.split('?')[0]))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(() => null);

        return cachedResponse || fetchPromise;
      })
    );
  }
});

// 330 v0.1.83 wake-up 模式 push handler
// 收到 push-server 发来�?{type: 'proactive-wake', chatId, charId, charName, taskId, fixedMessage, aiPrompt} payload
//   v0.2.26 �? �?fixedMessage (不管 messageType, 包括 patrol/fixed/guided/auto) �?直接显示真内�?+ �?IndexedDB
//     + postMessage 主页�?PROACTIVE_WAKE_PUSHED. fixedMessage �?null 时才走�?guided/auto 占位 + postMessage PROACTIVE_WAKE
self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  // ===== wake-up 模式 (v0.1.83+, v0.2.26 �? =====
  if (data.type === 'proactive-wake') {
    const charName = data.charName || data.charId || 'AI 角色';
    const chatId = data.chatId;
    const taskId = data.taskId;
    const messageType = data.messageType || 'fixed';
    const fixedMessage = data.fixedMessage;

    // ===== v0.2.26 优先路径: �?fixedMessage (不管 messageType) 直接用真内容 =====
    //   真凶: 老逻辑 messageType==='fixed' 才用 fixedMessage, push-server patrol 模式 messageType='patrol' 
    //   �?SW �?guided/auto 占位分支 �?通知显示 "X 想跟你说点什�?.." 占位, 完整内容�?fixedMessage 字段被忽�?
    //   �?主页�?handleProactiveWake 又调一�?LLM (浪费 token) + UPDATE_NOTIFICATION 失败时占位保�?
    if (fixedMessage && String(fixedMessage).trim()) {
      event.waitUntil((async () => {
        // 1. �?IndexedDB (native indexedDB API, PWA 完全关掉再开也能看到消息)
        try {
          await writeProactiveMessageToIDB({
            chatId,
            role: 'assistant',
            content: fixedMessage,
            timestamp: Date.now(),
            taskId,
            charId: data.charId,
            charName
          });
          console.log(`[SW v0.2.26] �?已落 IndexedDB: chatId=${chatId} content="${fixedMessage.substring(0, 30)}..."`);
        } catch (e) {
          console.warn('[SW v0.2.26] �?IndexedDB 失败 (不阻塞通知):', e.message);
        }

        // 2. 弹真内容通知 (body 截前 30 字符避免 iOS 178 限制截成乱码省略�? 完整内容�?data.message)
        const notifBody = fixedMessage.length > 30
          ? fixedMessage.substring(0, 30) + '...'
          : fixedMessage;
        await self.registration.showNotification(`💬 ${charName}`, {
          body: notifBody,
          icon: data.icon || './assets/icon-192.png',
          badge: data.badge || './assets/icon-192.png',
          tag: `task-${taskId}`,
          data: { chatId, taskId, type: 'proactive-wake', messageType, message: fixedMessage },
          requireInteraction: true,
          vibrate: [200, 100, 200],
          timestamp: Date.now()
        });

        // 3. postMessage 主页�?(强制 reload chat window, PWA 在前台时立刻显示)
        try {
          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clientList) {
            client.postMessage({
              type: 'PROACTIVE_WAKE_PUSHED',
              chatId,
              taskId,
              charId: data.charId,
              charName,
              message: fixedMessage,
              sentAt: data.sentAt
            });
          }
        } catch (e) {
          console.warn('[SW v0.2.26] postMessage 失败 (不阻�?:', e.message);
        }
      })());
      return;
    }

    // ===== �?guided/auto 模式 (fixedMessage �?null): 弹占�?+ postMessage 主页面让 AI 生成 =====
    //   保留兼容 push-config.js 老接�?(messageType=guided/auto + aiPrompt), 让主页面�?LLM
    const placeholderTitle = `💬 ${charName}`;
    const placeholderBody = `${charName} 想跟你说点什�?..`;
    const placeholderOptions = {
      body: placeholderBody,
      icon: data.icon || './assets/icon-192.png',
      badge: data.badge || './assets/icon-192.png',
      tag: `task-${taskId}`,
      data: { chatId, taskId, type: 'proactive-wake', messageType, generating: true },
      requireInteraction: true,
      vibrate: [200, 100, 200],
      timestamp: Date.now()
    };

    event.waitUntil((async () => {
      // 1. 弹占位通知
      await self.registration.showNotification(placeholderTitle, placeholderOptions);

      // 2. postMessage 主页�?(如果�?, 让主页面�?LLM 生成 + �?UPDATE_NOTIFICATION
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({
          type: 'PROACTIVE_WAKE',
          chatId,
          taskId,
          charId: data.charId,
          charName,
          messageType,
          aiPrompt: data.aiPrompt || null,
          sentAt: data.sentAt
        });
      }
    })());
    return;
  }

  // ===== �?payload 格式兼容 (测试推送等) =====
  const title = data.title || 'EPhone';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || './assets/icon-192.png',
    badge: data.badge || './assets/icon-192.png',
    tag: data.tag || 'default',
    data: data.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// v0.2.26 �? SW �?native indexedDB API 写主动消�?(PWA 关掉再开也能看到)
// 真凶: SW 是独�?worker context, 拿不�?window.db (Dexie) 也没 modules 脚本, 必须�?native indexedDB
// 同步主线 (init-db-schema.js v60): messages �?schema &id, chatId, timestamp, [chatId+timestamp], role, type
//                                chats �?schema &id, isGroup, ..., lastMessageTimestamp, messageSchemaVersion
// 消息 id 格式: ${chatId}::${timestamp}::${role}::${type}::${index} (�?init-db-schema.js / message-store.js 保持一�?
function writeProactiveMessageToIDB(msg) {
  return new Promise((resolve, reject) => {
    let db;
    try {
      const openReq = indexedDB.open('GeminiChatDB');
      openReq.onerror = () => reject(openReq.error || new Error('open GeminiChatDB 失败'));
      openReq.onsuccess = () => {
        db = openReq.result;
        try {
          if (!db.objectStoreNames.contains('messages')) {
            db.close();
            return reject(new Error('messages store 不存�?(PWA 数据�?schema 未升级到 v60)'));
          }
          if (!db.objectStoreNames.contains('chats')) {
            db.close();
            return reject(new Error('chats store 不存�?'));
          }
          const tx = db.transaction(['messages', 'chats'], 'readwrite');
          const messagesStore = tx.objectStore('messages');
          const chatsStore = tx.objectStore('chats');

          // 1. 写消息到 messages �?
          const messageId = `${msg.chatId}::${msg.timestamp}::assistant::text::0`;
          const messageRow = {
            id: messageId,
            chatId: msg.chatId,
            role: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            type: 'text',
            proactive: true,
            taskId: msg.taskId || null
          };
          messagesStore.put(messageRow);

          // 2. 更新 chat 元数�?(lastMessageTimestamp + lastMessagePreview + messageCount)
          const chatReq = chatsStore.get(msg.chatId);
          chatReq.onsuccess = () => {
            const chat = chatReq.result;
            if (chat) {
              chat.lastMessageTimestamp = msg.timestamp;
              const previewText = String(msg.content || '').replace(/\s+/g, ' ').trim();
              chat.lastMessagePreview = previewText.length > 80 ? previewText.slice(0, 80) + '...' : previewText;
              chat.lastMessageRole = 'assistant';
              chat.lastMessageType = 'text';
              chat.messageCount = (Number(chat.messageCount) || 0) + 1;
              // v0.2.60+ 已经拆表, chat 上不�?history 字段
              delete chat.history;
              chatsStore.put(chat);
            }
          };

          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { const err = tx.error; db.close(); reject(err || new Error('transaction 失败')); };
          tx.onabort = () => { const err = tx.error; db.close(); reject(err || new Error('transaction aborted')); };
        } catch (innerErr) {
          if (db) db.close();
          reject(innerErr);
        }
      };
    } catch (e) {
      if (db) db.close();
      reject(e);
    }
  });
}

// 330 v0.1.83: 主页面调 LLM 生成完消息后, �?UPDATE_NOTIFICATION 替换占位通知
self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (!event.data) return;

  // ===== 兼容�?SHOW_NOTIFICATION =====
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
    return;
  }

  // ===== �? UPDATE_NOTIFICATION 替换占位通知 =====
  if (event.data.type === 'UPDATE_NOTIFICATION') {
    const { tag, title, body, data: notifData } = event.data;
    if (!tag) return;
    event.waitUntil((async () => {
      // 关闭旧的占位通知 (用同一�?tag)
      const existing = await self.registration.getNotifications({ tag });
      for (const n of existing) n.close();

      // 弹新通知
      await self.registration.showNotification(title, {
        body,
        icon: './assets/icon-192.png',
        badge: './assets/icon-192.png',
        tag,
        data: notifData || {},
        requireInteraction: true,
        vibrate: [200, 100, 200],
        timestamp: Date.now()
      });
    })());
    return;
  }
});

self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event);

  event.notification.close();

  const chatId = event.notification.data?.chatId;
  const urlToOpen = chatId ? `/?openChat=${chatId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus().then(client => {
              if (chatId) {
                client.postMessage({ type: 'OPEN_CHAT', chatId });
              }
              return client;
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

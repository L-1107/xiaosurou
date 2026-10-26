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
const CACHE_VERSION = 'v0.2.80.0';
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
  './assets/pet-nest/cat-sprites-light.webp',
  './assets/pet-nest/dog-sprites-light.webp',
  './assets/pet-nest/egg-sprites-light.webp'
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
     url.includes('/assets/pet-nest/'));

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

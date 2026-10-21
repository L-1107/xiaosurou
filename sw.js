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
const CACHE_VERSION = 'v0.2.56.0';
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
  // 房间背景图 93KB, 预缓存是为了离线也能开房间 + 首屏不闪白。
  // jpg 兜底不预缓存 —— 只给不认 webp 的老 WebView 用, 按需拉就行。
  './assets/cinema-room-bg.webp'
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
     url.includes('/modules/video-voice-call.js'));

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

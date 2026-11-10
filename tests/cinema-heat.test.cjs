// ============================================================
// tests/cinema-heat.test.cjs
// 影院「发烫 / 一句剧情总结都没写 / 十五分钟闪退」这一轮的回归测试
//
// 跑法: node tests/cinema-heat.test.cjs
//
// 【守什么】用户 2026-10-29 实测三连报：
//   ① 本地视频看的时候越看手机越烫
//   ② 看了十分钟动漫一句剧情总结都没写
//   ③ 最后十五分钟左右浏览器崩溃闪退
//   「以前放这种动漫不会闪退的」
//
// 【根因】(对照探针 _reports/pet-test/probe-cinema-before-after.cjs 实测, 非猜测)
//   2026-10-23 d0f41e1 引入的「此刻画面」实况通道：
//     · Live 的 turn 是【串行队列】, 实况每 30 秒占一个 turn
//     · 每个 turn 都要重读会话里累积的全部帧 (官方: 视频输入 258 token/帧)
//     → 实况把摘要挤到后面 → 摘要 turn 排队 141~173 秒 → 撞 90 秒超时
//     → 【一句剧情总结都没写】
//     → 累积帧涨到 899 帧 = 单 turn 输入 232K token, 远超 128,000 的窗口
//     → 重连还带 resume handle 继承爆掉的上下文 → 重连风暴 → 狂热 + 闪退
//
//   ⚠️ 帧率【不是】差异变量: before/after 两边帧数 902、上行 79.3MB 完全一样。
//      用户原话「从一开始就是一秒一帧没变过」是对的 → 降帧方案作废, 帧率保持 1 FPS。
//
// 【这一轮的修法】(用户 2026-10-29 定方案)
//   ① 取消「此刻画面」实况通道        → Live 的 turn 队列只留给摘要
//   ② 长剧摘要 5 分钟 → 2 分钟一段    → 摘要更细, 主 API 答得更准
//   ③ 内容下限 80 字 → 50 字          → 2 分钟一段写不出 80 字
//   ④ 每次摘要截一张图给主 API, 阅后即焚 (不落库/不进备份/不进导出/不进草稿)
//   ⑤ 【每次摘要尝试之后】换干净会话 (成功失败都换)
//      → 单个 turn 的输入永远只有这一段的量 (2 分钟 @ 1 FPS = 120 帧 = 31K token)
//   ⑥ 帧率画质一律不动: 1 FPS / 长边 768 / JPEG q0.6
//
// 【实测对照】(同一份代码, 只切实况通道开关)
//                        帧数   上行    turn   摘要写进   单turn最多帧  输入token累计
//   BEFORE 线上版        902  79.3MB   28       0 段        899 帧      3351K
//   AFTER  现在版        902  79.3MB    7       7 段        119 帧       165K
// ============================================================

const fs = require('fs');
const path = require('path');
const { runScenario } = require('./_harness/cinema-live-harness.cjs');

const ROOT = path.resolve(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

let passed = 0;
let failed = 0;
// 机器可读失败清单（反向验证脚本靠它做集合比对，别删）
const failedNames = [];
function ok(name, detail) {
  passed++;
  console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''));
}
function fail(name, detail) {
  failed++;
  failedNames.push(name);
  console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''));
}
function check(name, cond, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

const LIVE = read('modules/cinema-live.js');
const CHAT = read('modules/cinema-chat.js');
const CLIENT = read('modules/live-client.js');

function numOf(src, name) {
  // ⚠️ 右值可能带运算 (比如 `2 * 60 * 1000`) —— 只抓数字会把 "2 * 60 * 1000" 读成 2。
  const m = new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) return null;
  try {
    // eslint-disable-next-line no-new-func
    return Function('return (' + m[1] + ')')();
  } catch (e) {
    return null;
  }
}

function countOf(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

(async function () {
  // -------------------------------------------------------------------------
  section('1. 参数锁死（帧率画质不许再动，摘要节奏锁 2 分钟）');
  // -------------------------------------------------------------------------
  const frameInterval = numOf(LIVE, 'FRAME_INTERVAL_MS');
  const frameMaxDim = numOf(LIVE, 'FRAME_MAX_DIM');
  const jpegQuality = numOf(LIVE, 'JPEG_QUALITY');
  const sumInterval = numOf(LIVE, 'WATCH_SUMMARY_INTERVAL_MS');
  const minChars = numOf(LIVE, 'MIN_SUMMARY_CHARS');
  const sumTimeout = numOf(LIVE, 'SUMMARY_REQUEST_TIMEOUT_MS');
  const retryDelay = numOf(LIVE, 'SUMMARY_RETRY_DELAY_MS');

  // 🔴 帧率必须【正好】1 FPS —— 用户反证过「从一开始就是一秒一帧」, 降帧碰不到差异变量
  check('帧率就是 1 FPS (1000ms) —— 降帧方案已作废, 不许再降',
    frameInterval === 1000, frameInterval + 'ms');
  check('抽帧长边就是 768 (不许降)', frameMaxDim === 768, frameMaxDim + 'px');
  check('JPEG 质量就是 0.6 (不许降)', jpegQuality === 0.6, String(jpegQuality));
  check('长剧摘要间隔 = 2 分钟', sumInterval === 120000, sumInterval + 'ms');
  check('剧情内容下限 = 50 字 (2 分钟一段写不出 80 字)', minChars === 50, String(minChars));
  check('摘要超时不少于 90 秒', sumTimeout !== null && sumTimeout >= 90000, sumTimeout + 'ms');
  check('摘要失败 60 秒后重试', retryDelay === 60000, retryDelay + 'ms');

  // -------------------------------------------------------------------------
  section('2. 「此刻画面」实况通道必须【彻底没有】');
  // -------------------------------------------------------------------------
  check('没有 LIVE_NOW_INTERVAL_MS', !/LIVE_NOW_INTERVAL_MS/.test(LIVE));
  check('没有 startLiveNowLoop / stopLiveNowLoop',
    !/startLiveNowLoop|stopLiveNowLoop/.test(LIVE));
  check('没有「此刻屏幕」那种 Live turn 指令',
    !/此刻屏幕/.test(LIVE),
    LIVE.indexOf('此刻屏幕') >= 0 ? '还剩 ' + countOf(LIVE, '此刻屏幕') + ' 处' : '');
  check('没有每会话帧预算那套 (80 帧就换会话)',
    !/SESSION_FRAME_BUDGET/.test(LIVE));

  // -------------------------------------------------------------------------
  section('3. 换干净会话（成功才换；失败先不换，连着失败两次才换）');
  // -------------------------------------------------------------------------
  const markAll = countOf(LIVE, 'S._needFreshSession = true;');
  check('换会话标记全文件只有一处', markAll === 1, markAll + ' 处');

  const rsIdx = LIVE.indexOf('function runStageSummary(opts)');
  const rsBody = rsIdx >= 0 ? LIVE.slice(rsIdx) : '';
  const catchIdx = rsBody.indexOf('.catch(function (err) {');
  const markIdx = rsBody.indexOf('S._needFreshSession = true;');
  check('标记在收尾钩子里 (.catch 之后) —— 成功/失败都会走到那个判断',
    catchIdx >= 0 && markIdx > catchIdx,
    'catch@' + catchIdx + ' mark@' + markIdx);

  const okIdx = rsBody.indexOf(".then(function (text) {");
  check('成功分支里【没有】标记 (只能在收尾钩子里)',
    okIdx >= 0 && markIdx > okIdx &&
    rsBody.slice(okIdx, catchIdx).indexOf('S._needFreshSession = true;') === -1);

  // 🔴 2026-11-04 改的规则 (原先是"成功失败都换"):
  //   失败【不】立刻换会话 —— 画面留着, 60 秒后的重试还能看到同一批画面。
  //   旧写法"失败也换"的后果: 失败那一段既没落库、画面也没了 → 整段剧情直接消失,
  //   而且重试救不回来 (重试是在新会话里发的, 模型看到的是重试后那 60 秒)。
  //   连着失败两次才强制换 (那才是 2026-10-29 要防的"帧一直累积 → turn 变慢"的恶性循环)。
  check('失败不立刻换 (连着失败两次才换)',
    /needFresh = ok \|\| failStreak >= 2/.test(LIVE),
    '收尾里要有 "failStreak >= 2" 这个条件');
  check('失败次数有单独计数 (连续失败用)',
    /_stageFailStreak/.test(LIVE));

  // ⚠️ 这两条必须【在换会话那一块里】找 —— 线上版 cinema-live.js 的别处
  //    也有 saveHandle(null) (连不上时清废 handle), 全文件搜会误判成绿。
  const freshIdx = LIVE.indexOf('if (S._needFreshSession && !watchSession.pendingSummary');
  const freshEnd = freshIdx >= 0 ? LIVE.indexOf('\n      }', freshIdx) : -1;
  const freshBlock = (freshIdx >= 0 && freshEnd > freshIdx) ? LIVE.slice(freshIdx, freshEnd) : '';
  check('换会话时会清 resume handle (在换会话那一块里)',
    freshBlock.indexOf('saveHandle(null)') >= 0,
    freshBlock ? '' : '没找到换会话块');
  check('换会话时会 resetSession (丢掉撑爆的上下文, 在换会话那一块里)',
    freshBlock.indexOf('resetSession()') >= 0);
  check('换会话会等「没有在途的摘要」才做',
    /_needFreshSession\s*&&\s*!watchSession\.pendingSummary\s*&&\s*!watchSession\.summaryBusy/.test(LIVE));
  check('live-client 有 resetSession()', /prototype\.resetSession\s*=/.test(CLIENT));
  check('live-client 有 canSendFrame() (抽帧前先问背压)',
    /prototype\.canSendFrame\s*=/.test(CLIENT));

  // -------------------------------------------------------------------------
  section('4. 每次摘要附一张图给主 API + 阅后即焚');
  // -------------------------------------------------------------------------
  check('摘要成功后截一张图存进 liveNow.image',
    /liveNow\s*=\s*\{[\s\S]{0,200}?image:\s*shot/.test(LIVE));
  check('burnLiveNowImage 已导出给 cinema-chat.js',
    /burnLiveNowImage:\s*function/.test(LIVE));
  check('主 API 请求会带上那张图',
    /image_url:\s*\{\s*url:\s*'data:image\/jpeg;base64,'\s*\+\s*shot/.test(CHAT));
  check('请求发完立刻烧掉图 (finally 里烧)',
    /finally\s*\{[\s\S]{0,400}?burnLiveNowImage\(\)/.test(CHAT));
  check('主 API 不支持识图 → 自动重试一次不带图的',
    /带图请求失败/.test(CHAT) &&
    /messages\.filter\(function \(m\)/.test(CHAT));
  check('图不落库: 段落记忆只存文字',
    /return addFilmSegment\(parts\.segment\)/.test(LIVE));
  check('图不进草稿/导出: liveNow 只有内存里这一张',
    /liveNow:\s*watchSession\.liveNow/.test(LIVE) &&
    countOf(LIVE, 'watchSession.liveNow = {') >= 1);

  // -------------------------------------------------------------------------
  section('5. 诊断（用户截图就能给我）');
  // -------------------------------------------------------------------------
  check('摘要失败会告诉用户 (聊天框里说得出来)',
    /appendSystemLine\('⚠️ 这一段剧情没写进去/.test(LIVE) &&
    /appendSystemLine\('⚠️ 这一段剧情没总结出来/.test(LIVE));
  check('有诊断日志写 localStorage', /cinema_live_diag_v1/.test(LIVE));
  check('Live 的事件推进了【影院设置面板里已有的】诊断框',
    /global\.__cinemaDiagPush = diagLogPush/.test(read('modules/cinema-room.js')) &&
    /__cinemaDiagPush/.test(LIVE));

  // -------------------------------------------------------------------------
  section('6. 15 分钟模拟：单 turn 的上下文不能爆');
  // -------------------------------------------------------------------------
  const slow = await runScenario({ label: '服务端慢', turnLatencyMs: 35000 });
  const maxFrames = slow.turnLog.reduce((m, r) => Math.max(m, r.framesAtSend), 0);
  const maxTokenK = Math.round(maxFrames * 258 / 1000);

  check('服务端慢(35s) 剧情照样写进去 (修前是 0 段)', slow.segCount >= 1, slow.segCount + ' 段');
  check('Live turn 数 ≤ 12 (修前 28~29)', slow.turns <= 12, slow.turns + ' 个');
  check('换过干净会话 (修前 1 个会话撑到底)', slow.sessions >= 2, slow.sessions + ' 个会话');
  check('单个 turn 最多累积 ≤ 130 帧 (2 分钟 @ 1 FPS + 余量)',
    maxFrames <= 130, maxFrames + ' 帧');
  check('单个 turn 最多输入 ≤ 35K token (预算 128K 的 27%)',
    maxTokenK <= 35, maxTokenK + 'K');
  check('输入 token 累计 ≤ 500K (修前 3351K)', slow.inputTokenK <= 500, slow.inputTokenK + 'K');

  const queued = await runScenario({
    label: '服务端慢 + 排队堆积', turnLatencyMs: 12000, queuePenaltyMs: 8000
  });
  const queuedMaxFrames = queued.turnLog.reduce((m, r) => Math.max(m, r.framesAtSend), 0);
  // ⚠️ 光看 segCount 咬不住人 —— 线上版在这个场景【也】写得进 (turn 没超 45s 超时)。
  //    必须连着"单 turn 上下文有没有爆"一起看, 才咬得住。
  check('turn 排队堆积: 剧情写得进去, 而且单 turn 上下文没爆',
    queued.segCount >= 1 && queuedMaxFrames <= 130,
    queued.segCount + ' 段 / 最多 ' + queuedMaxFrames + ' 帧');

  // -------------------------------------------------------------------------
  section('7. 写不进去的时候要告诉用户（不能静默）');
  // -------------------------------------------------------------------------
  // 造一个"模型只写了 18 个字"的场景 → 低于 50 字下限 → 这一段写不进去
  const tooShort = await runScenario({
    label: '模型写太短', turnLatencyMs: 3000, summaryText: '就写了一句。'
  });
  check('写太短时确实没写进去 (前提成立)', tooShort.segCount === 0, tooShort.segCount + ' 段');

  // -------------------------------------------------------------------------
  section('8. live 掉线后必须能自己爬起来（用户 2026-10-29 实测「只总结了第一段」）');
  // -------------------------------------------------------------------------
  check('重试用完 MAX_RETRY 不能彻底放弃（放弃 = live 永远回不来 = 剧情一句都不写）',
    /不会放弃, 改成每 60 秒再试一次/.test(LIVE));

  // ---- 其余几条「停了定时器却没人重排」的路径 ----
  check('有摘要看门狗（定时器丢了就补排 / live 掉线就重连）',
    /function startSummaryWatchdog/.test(LIVE) && /看门狗: 摘要定时器不见了/.test(LIVE) &&
    /startSummaryWatchdog\(\);/.test(LIVE));
  check('resumeFrames 时 live 还没 ready, 也要把摘要定时器排上（iOS 切后台必断 WebSocket）',
    /恢复发帧时 live 还没就绪, 摘要定时器照排/.test(LIVE));
  check('enable 失败时要安排重连（不能把关掉 enabled 当成处理办法）',
    /scheduleReconnect\('连接失败: /.test(LIVE));
  // ⚠️ 必须限定在 onClientState 函数体内 —— 全局搜 state === 'error'
  //   会扫到别处, 断言就永远是绿的 (假绿)。
  const onStateBody = LIVE.slice(LIVE.indexOf('function onClientState'),
    LIVE.indexOf('function onClientState') + 3000);
  check('onClientState 处理 error 状态（连失败一次就永不重连的老毛病）',
    /state === 'error'/.test(onStateBody));
  // ⚠️ 必须只扫 tickStageSummary 的函数体 ——
  //   scheduleStageSummary 里也有 watchSession.summaryTimer = null;
  //   全局搜的话这条永远是绿的（假绿）。
  // ⚠️ 函数签名带参数了 (tickStageSummary(forced, sinceMs)) ——
  //   这里必须找 'function tickStageSummary(' , 找带空括号的那个会返回 -1,
  //   slice(-1, 499) 截到的是文件尾巴 → 断言永远绿 (假绿)。
  const tickIdx = LIVE.indexOf('function tickStageSummary(');
  const tickBody = LIVE.slice(tickIdx, tickIdx + 500);
  check('tick 会清掉已触发的定时器句柄（看门狗据此判断「定时器不见了」）',
    /watchSession\.summaryTimer = null;/.test(tickBody));
  check('放弃过一次之后要能一直重试下去（不是 return 掉）',
    /改用 60 秒间隔继续重试/.test(LIVE));

  // 场景: 12 分钟, 第 4 分钟断线, 第 4~8 分钟重连一直不 ready。
  //   第 4~10 分钟写不了是【场景本身】(live 那段不可用), 不是 bug。
  //   → 期望 >= 2 段 (第 2 分钟 + 第 10 分钟); 旧版只有 1 段。
  const stalled = await runScenario({
    label: '中途断线 + 重连迟迟不 ready',
    minutes: 12,
    dropLiveAtMs: 4 * 60 * 1000,
    stallSetupUntilMs: 8 * 60 * 1000
  });
  check('★ live 掉线又恢复后, 摘要还能继续写 (旧版彻底放弃 → 只写第一段)',
    stalled.segCount >= 2, stalled.segCount + ' 段 (12 分钟, 其中 4 分钟 live 不可用)');
  check('掉线期间有明确提示, 不是闷声不响',
    stalled.chatLines.some(l => /还没连上|重连|连接断开/.test(l)),
    stalled.chatLines.slice(-3).join(' / '));
  const warned = tooShort.chatLines.some(l => /没写进去|没总结出来/.test(l));
  check('聊天框里给出了提示 (修前是完全静默)', warned,
    warned ? '' : '聊天框内容: ' + JSON.stringify(tooShort.chatLines.slice(-3)));


  // -------------------------------------------------------------------------
  section('9. 摘要调度不能依赖【定时器链】（用户 2026-10-29 实测「总结一段以后再过两分钟没有发起总结」）');
  // -------------------------------------------------------------------------
  // 【复现手法】把摘要定时器改成「只放第一段, 之后永远不触发」。
  //   这就是用户现场那台设备的状况 —— 定时器链在中途被吃掉, 之后再也不发起。
  //   用户原话: 「又是只总结了第一个2分钟的剧情, 就是第一段, 之后的就再也没总结了」
  const KILL_ANCHOR = 'watchSession.summaryTimer = setTimeout(tickStageSummary, delay);';
  const KILL_REPL =
    'watchSession.summaryTimer = setTimeout(function () {' +
    ' if (!window.__chainDead) { window.__chainDead = true; tickStageSummary(); }' +
    ' }, delay);';
  const LIVE_KILLED = LIVE.indexOf(KILL_ANCHOR) >= 0 ? LIVE.replace(KILL_ANCHOR, KILL_REPL) : null;
  check('测试前提: 摘要定时器那行找得到（找不到就没法模拟链断掉）', LIVE_KILLED !== null);

  const chainDead = LIVE_KILLED ? await runScenario({
    label: '定时器链中途死掉', minutes: 12, liveSrcOverride: LIVE_KILLED
  }) : { segCount: -1, chatLines: [] };
  check('★ 定时器链死掉后, 摘要仍按【已播放时长】继续写（旧版只写第一段就停）',
    chainDead.segCount >= 3, chainDead.segCount + ' 段 (12 分钟, 期望 >= 3 段)');
  // ⚠️ 这两条查的是【诊断事件】本身 —— 旧版压根没有 try/forced 这两个事件,
  //    所以它们在 bug 版必定报红 (上一版写成「聊天框有字」, 那条在 bug 版也会过 = 假绿)。
  const chainDiag = (function () {
    try {
      return JSON.parse((chainDead.ctx && chainDead.ctx.localStorage &&
        chainDead.ctx.localStorage.getItem('cinema_live_diag_v1')) || '[]');
    } catch (e) { return []; }
  })();
  const tryCount = chainDiag.filter(d => d && d.ev === 'try').length;
  const forcedCount = chainDiag.filter(d => d && d.ev === 'forced').length;
  check('每次摘要尝试都要写进诊断（诊断里有「发起剧情总结」）', tryCount >= 3,
    'try 事件 ' + tryCount + ' 次 / 全部事件: ' + chainDiag.map(d => d && d.ev).join(','));
  check('链断了以后看门狗要【强制补过】（诊断里有「强制补一次总结」）', forcedCount >= 1,
    'forced 事件 ' + forcedCount + ' 次');

  // ---- 其余三条: 同一个病根, 源码级钉住 ----
  const ROOM = read('modules/cinema-room.js');
  // ⚠️ 必须限定在 video 'play' 那个处理器里 —— 全局搜 resumeFrames 会搜到定义处, 永远绿。
  const playIdx = ROOM.indexOf("addEventListener('play'");
  const playBody = ROOM.slice(playIdx, playIdx + 1200);
  check("video 'play' 事件要调 resumeFrames（'pause' 事件调 pauseFrames, 它销毁定时器并冻结播放时间账）",
    /CinemaLive\.resumeFrames\(/.test(playBody),
    playIdx < 0 ? '没找到 play 处理器' :
      (/CinemaLive\.resumeFrames\(/.test(playBody) ? 'play 处理器里已调 resumeFrames' : 'play 处理器里没有 resumeFrames'));
  check('看门狗是【权威调度器】: 已播放够久却没写进剧情 → 强制补一次（不等定时器）',
    /since >= WATCH_SUMMARY_INTERVAL_MS/.test(LIVE) && /tickStageSummary\(true/.test(LIVE));
  check('摘要成功时记下「成功写进剧情」的已播放时长（看门狗靠它判断该补下一次）',
    /watchSession\.lastSummaryOkPlayedMs = totalPlayedMs\(\);/.test(LIVE));
  check('每次摘要尝试 / 跳过 / 强制都写进诊断（下次一张截图就能定案）',
    /diagPush\('try'/.test(LIVE) && /diagPush\('skip'/.test(LIVE) && /diagPush\('forced'/.test(LIVE));

  // -------------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过: ' + passed + '   失败: ' + failed);
  console.log('__FAILURES__' + failedNames.join('\u0001'));
  console.log('========================================');
  if (failed > 0) process.exit(1);
})().catch(function (e) {
  console.error('\n测试崩了:', e && e.stack ? e.stack : e);
  process.exit(1);
});

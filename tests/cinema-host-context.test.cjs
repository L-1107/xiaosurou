// ============================================================
// 影院「宿主上下文 + 导出」回归守卫 (2026-10-28)
//
// 背景 (用户 2026-10-28 实测):
//   ① 影院陪聊完全没有外面聊天框的上文和长期记忆
//   ② 导出到长期记忆: 界面报"✅ 已导出 N 条", 实际只进去最后一块, 其余被清账删掉
//   ③ 影院里说的话不落主聊天历史
//
// 真因: 影院跑在 iframe 沙盒里, 沙盒只加载 7 个文件 —— 没有 message-store /
//       memory-summary / settings-presets / ai-response, 外面的一切它都拿不到;
//       而沙盒里的 db.chats 是【假的】, 只把 longTermMemory 的最后一条发给宿主。
//
// 修法: 宿主算好上下文发给沙盒(cinema:init / cinema:needContext),
//       导出走显式通道(cinema:exportMemory) 等宿主 ack 才清账,
//       影院对话走 cinema:chatMessage 落进主聊天历史。
//
// 这个测试守的是【接线】, 不碰浏览器。
// 端到端那条在 _reports/cinema-test/check-cinema-host-context.cjs (23 项)。
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CHAT = read('modules/cinema-chat.js');
const ROOM = read('modules/cinema-room.js');
const LIVE = read('modules/cinema-live.js');
const LC = read('modules/live-client.js');
const SANDBOX = read('cinema-sandbox/index.html');
const INDEX = read('index.html');
const SW = read('sw.js');

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; failed.push(name); console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/** 抠出一个函数的函数体 (跟 tests/cinema-chat.test.cjs 同一套手法) */
function body(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const m = rest.match(/\n  (function |const |let |var |window\.|\/\/ =)/);
  if (!m) return src.slice(start);
  return src.slice(start, start + 1 + m.index);
}
/** 剥掉注释 (免得自己写的注释被判成违规) */
function strip(s) {
  return s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

(async () => {
  section('① 宿主: 上下文通道接线');
  check('有 buildCinemaHostContext', /async function buildCinemaHostContext\(/.test(ROOM));
  const ctxFn = body(ROOM, 'buildCinemaHostContext');
  check('上下文里有 promptText / history / memoryText',
    /promptText/.test(ctxFn) && /history/.test(ctxFn) && /memoryText/.test(ctxFn));
  check('上下文复用 CinemaChat.buildHistoryMessages',
    /buildHistoryMessages\(c\)/.test(ctxFn));
  check('上下文复用 CinemaChat.buildMemoryContext (向量记忆优先)',
    /buildMemoryContext\(c, queryText/.test(ctxFn));
  check('上下文复用 CinemaChat.renderPromptText (主聊天预设)',
    /renderPromptText\(c, ctx\.memoryText\)/.test(ctxFn));

  check('处理 cinema:needContext', /d\.type === 'cinema:needContext'/.test(ROOM));
  check('处理 cinema:exportMemory', /d\.type === 'cinema:exportMemory'/.test(ROOM));
  check('处理 cinema:chatMessage', /d\.type === 'cinema:chatMessage'/.test(ROOM));
  check('回包是 cinema:context', /type: 'cinema:context'/.test(ROOM));
  check('导出回包是 cinema:exportMemoryDone', /cinema:exportMemoryDone/.test(ROOM));

  const exportFn = body(ROOM, 'handleCinemaExport');
  check('导出把所有 chunk 都写进 longTermMemory',
    /for \(const ch of chunks\)/.test(exportFn) && /c\.longTermMemory\.push/.test(exportFn));
  check('导出写完才回 ok (先 db.chats.put 再 reply)',
    exportFn.indexOf('db.chats.put') >= 0 &&
    exportFn.indexOf('db.chats.put') < exportFn.indexOf('reply({ ok: true'));

  section('② 沙盒: 不再"只传最后一条"');
  const fakePut = SANDBOX.match(/cdb\.chats\s*=\s*\{[\s\S]*?\n  \};/);
  check('抠得出沙盒的假 db.chats', !!fakePut);
  check('假 db.chats 不再 postMessage cinema:memory',
    fakePut && fakePut[0].indexOf("cinema:memory") < 0,
    fakePut ? '还在发 cinema:memory' : '');
  check('沙盒拿到了 globalSettings',
    /globalSettings/.test(SANDBOX) && /globalSettings/.test(ROOM));

  section('③ cinema-chat.js: 用宿主给的上下文');
  check('有 setHostContext', /function setHostContext\(/.test(CHAT));
  check('有 requestHostContext', /function requestHostContext\(/.test(CHAT));
  check('监听 cinema:context', /d\.type === 'cinema:context'/.test(CHAT));
  check('buildHistoryMessages 优先用宿主的 history',
    /hostCtx && Array\.isArray\(hostCtx\.history\)/.test(body(CHAT, 'buildHistoryMessages')));
  check('buildMemoryContext 优先用宿主的 memoryText',
    /hostCtx && hostCtx\.memoryText/.test(body(CHAT, 'buildMemoryContext')));
  check('buildSystemPrompt 优先用宿主的 promptText',
    /hostCtx && hostCtx\.promptText/.test(body(CHAT, 'buildSystemPrompt')));
  check('renderPromptText 没有 replaceTemplateVars 就返回空 (不发半空的提示词)',
    /if \(typeof window\.replaceTemplateVars !== 'function'\) return '';/.test(body(CHAT, 'renderPromptText')));
  // ⚠️ 兜底人设那块的数组【不能直接赋给 out】——
  //   out 是字符串, 后面还要 += 场景块, 数组被字符串化时走 Array.toString(),
  //   元素之间用逗号连接, 故意留的空行就变成了 ",,":
  //     "# 你是谁,,你就是「测试角色」。,,人设标记ZZZ,"
  //   (2026-10-28 实测踩到: 没有提示词预设时排版全毁)
  check('兜底人设自己 join(\\n) (不被 toString 变成逗号)',
    /out = fb\.join\('\\n'\)/.test(body(CHAT, 'buildSystemPrompt')));
  check('兜底人设那段没把数组直接赋给 out',
    !/out = \['# 你是谁'/.test(body(CHAT, 'buildSystemPrompt')));
  check('persistToMainChat 走宿主通道 (cinema:chatMessage)',
    /cinema:chatMessage/.test(body(CHAT, 'persistToMainChat')));
  check('拿不到聊天对象时给用户提示 (不再静默)',
    /appendSystemLine\('⚠️ 陪聊用不了/.test(CHAT));
  check('发消息前先问宿主要上下文',
    /requestHostContext\(msg\)/.test(body(CHAT, 'send')));

  section('④ cinema-live.js: 导出等 ack 才清账');
  const expLive = body(LIVE, 'exportMemoriesToMemory');
  check('导出走 requestHostExport', /requestHostExport\(chunks\)/.test(expLive));
  // ⚠️ 必须剥掉注释再查 —— 注释里就写着 "不再自己 db.chats.put(chat)" (第一版就踩了这个)
  check('导出不再自己 db.chats.put (沙盒那个是假的)',
    strip(expLive).indexOf('db.chats.put') < 0);
  check('宿主没确认就抛错 (不清账)',
    /throw new Error\(\(res && res\.error\)/.test(expLive));
  check('有 requestHostExport 这个函数', /function requestHostExport\(/.test(LIVE));
  const reqExport = body(LIVE, 'requestHostExport');
  check('requestHostExport 等 cinema:exportMemoryDone',
    /cinema:exportMemoryDone/.test(reqExport));
  check('requestHostExport 有超时兜底', /HOST_EXPORT_TIMEOUT_MS/.test(reqExport));

  section('⑤ 长片卡死: 背压 + goAway 停推帧');
  check('live-client 有背压阈值', /MAX_BUFFERED_BYTES/.test(LC));
  check('sendVideoFrame 会因为缓冲过大而丢帧',
    /bufferedAmount > MAX_BUFFERED_BYTES/.test(body(LC, 'sendVideoFrame').replace(/\n\s*/g, ' ')) ||
    /bufferedAmount > MAX_BUFFERED_BYTES/.test(LC));
  check('有丢帧计数 getDroppedFrames', /getDroppedFrames/.test(LC));
  check('goAway 时停推帧', /onGoAway[\s\S]{0,400}stopSendingFrames/.test(LIVE));
  check('有 stopSendingFrames 这个函数', /function stopSendingFrames\(/.test(LIVE));
  check('丢帧会告诉用户 (不然用户只以为模型变傻)',
    /已经丢掉/.test(LIVE));
  check('大文件提示说了"播一截就卡住"的实话',
    /播一截就卡住/.test(ROOM));
  check('警告框保留换行 (white-space: pre-line)',
    /white-space: pre-line/.test(read('modules/cinema-room.css')));

  section('⑥ 版本号 / 缓存');
  // ⚠️ 别写死确切版本号 —— 每 bump 一次就误报一次 (330 已经踩过三回)。
  //   真正要守的是【宿主和沙盒对齐】(漏 bump 一边立刻能看出来) + 【不低于上次发布值】。
  function verOf(text, file) {
    const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(esc + '\\?v=([0-9]+(?:\\.[0-9]+)*)'));
    return m ? m[1] : null;
  }
  function verGte(a, b) {
    if (!a || !b) return false;
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  }
  // 文件名 → 上次发布过的版本 (只当"下限", 不当"必须等于")
  const VER_FLOOR = {
    'cinema-chat.js': '0.0.3',
    'cinema-live.js': '1.9.9',
    'cinema-room.js': '0.31.0',
    'live-client.js': '0.4.1',
    'cinema-room.css': '0.38.2'
  };
  for (const f of Object.keys(VER_FLOOR)) {
    const a = verOf(INDEX, 'modules/' + f);
    const b = verOf(SANDBOX, 'modules/' + f);
    check('宿主与沙盒的 ' + f + ' ?v= 一致 (漏 bump 一边立刻能看出来)',
      !!a && a === b, '宿主=' + a + ' 沙盒=' + b);
    check('宿主 ' + f + ' ?v= 不低于 ' + VER_FLOOR[f], verGte(a, VER_FLOOR[f]), '现在=' + a);
  }
  check('index.html 的 cinema-room.css ?v= 带版本号', !!verOf(INDEX, 'modules/cinema-room.css'));
  check('sw.js CACHE_VERSION 是个版本号', /const CACHE_VERSION = 'v\d+\.\d+\.\d+\.\d+'/.test(SW));
  check('sw.js 预缓存清单里有这几个文件',
    /'\.\/modules\/cinema-chat\.js'/.test(SW) &&
    /'\.\/modules\/cinema-live\.js'/.test(SW) &&
    /'\.\/modules\/cinema-room\.js'/.test(SW));

  section('⑦ 退出影院后外面点不动 (iframe 盖住整个 app)');  // 真因: 影院那个 iframe 是 position:fixed + inset:0 + z-index:2147483647,
  //       整个屏幕都在它下面; 而宿主收掉它的唯一途径 = 沙盒发 cinema:closed。
  //       那条消息没送到 → 整个 app 被黑框盖死 → 外面点不动, 只有大退才恢复。
  check('影院 iframe 是整屏最高层级 (所以它不走就等于全 app 不可用)',
    /position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647/.test(ROOM));
  check('房间开的时候会在 documentElement 上挂标记',
    /document\.documentElement\.setAttribute\(ROOM_OPEN_ATTR/.test(ROOM));
  check('房间关的时候会摘掉标记',
    /document\.documentElement\.removeAttribute\(ROOM_OPEN_ATTR/.test(ROOM));
  check('宿主有兜底看门狗 (沙盒不吭声时自己收 iframe)',
    /function watchSandboxRoom\(/.test(ROOM) && /startSandboxWatch\(\)/.test(ROOM));
  check('看门狗是读 iframe 的 DOM (同源读得到)', /frame\.contentDocument/.test(ROOM));
  check('closeSandbox 就算没有 frame 也把 body 的 class 摘干净',
    /function closeSandbox\(reason\)[\s\S]{0,400}if \(!frame\) \{[\s\S]{0,200}remove\('cinema-room-active'\)/.test(ROOM));
  check('沙盒 pagehide 时也补报一声 (覆盖沙盒页被重载)',
    /pagehide[\s\S]{0,200}cinema:closed/.test(SANDBOX));

  section('⑧ 谷歌原生直连: 宿主代打 (用户 2026-10-29)');
  // 【背景】影院跑在 iframe 沙盒里, 沙盒只加载 7 个文件 —— 没有 ai-response.js /
  //   utils.js → 沙盒里没有 toGeminiRequestData / getGeminiResponseText /
  //   isGeminiNativeUrl。以前沙盒把 isGemini 判成 false, 拿 OpenAI 兼容的
  //   /chat/completions 打到谷歌原生地址上 → 必 404。
  //   → 修法: 宿主判定 + 宿主代打。
  check('宿主认得 cinema:geminiRequest',
    /d\.type === 'cinema:geminiRequest'/.test(ROOM));
  const gemFn = body(ROOM, 'handleCinemaGeminiRequest');
  check('有 handleCinemaGeminiRequest', !!gemFn);
  check('用 toGeminiRequestData 转换 (和主聊天同一套, 不另写一份)',
    // ⚠️【2026-10-29 收紧】光有 toGeminiRequestData 这个【词】不算 ——
    //   函数里的 typeof 守卫和注释提到它, 都会让宽松写法误判成「有在用」。
    //   必须真的【调用】它 (带左括号)。
    /window\.toGeminiRequestData\(/.test(gemFn));
  check('用 getGeminiResponseText 取文本',
    /window\.getGeminiResponseText\(/.test(gemFn));
  check('回包带 requestId (沙盒要对上)', /cinema:geminiResponse/.test(gemFn) && /requestId: reqId/.test(gemFn));
  check('失败会把原因回给沙盒 (不静默)',
    /ok: false/.test(gemFn) && /error:/.test(gemFn));
  check('宿主判定谷歌原生, 并把标记随 apiConfig 发给沙盒',
    /isGeminiNative:/.test(ROOM) && /window\.isGeminiNativeUrl/.test(ROOM));
  check('沙盒那边有对应的请求/回包通道',
    /cinema:geminiRequest/.test(CHAT) && /cinema:geminiResponse/.test(CHAT));

  section('⑨ 宿主静默: 影院 iframe 打开时, 宿主整个停下来 (2026-11-05)');
  // 【实测依据】用户 A/B/C 三组真机实测:
  //   A 宿主单独开着         → 冷冰冰
  //   C 影院沙盒单独看一集   → 冷冰冰
  //   B 宿主里套着影院看一集 → 开始发烫 (再聊天更烫)
  // ⇒ 单边都不烫, 合起来才烫 ⇒ 成因是【宿主 + iframe 叠加】。
  // 宿主在 iframe 底下【一个像素都看不见】, 却还在全速跑:
  //   54 个全屏面板 + 约 20 条 infinite 动画 + 顶栏毛玻璃 + 几个常驻定时器
  // → 打开影院就静默, 退出影院再醒。
  const CSS = read('modules/cinema-room.css');
  const BG = read('modules/background-activity.js');
  const PET = read('modules/pet-nest.js');

  check('CSS: 影院开着时宿主主界面整个 display:none',
    /body\.cinema-room-active #phone-screen[\s\S]{0,400}display: none !important/.test(CSS));
  check('CSS: 桌宠和悬浮球也一起藏掉',
    /body\.cinema-room-active #pn-desktop-pet/.test(CSS) &&
    /body\.cinema-room-active #floating-ball/.test(CSS));
  check('CSS: 剩下的动画也冻结 (不是只藏起来)',
    /body\.cinema-room-active[\s\S]{0,800}animation-play-state: paused !important/.test(CSS));
  check('宿主: 打开影院时会停宿主那些常驻任务',
    /function pauseHostTimers\(\)[\s\S]{0,600}pauseHostBackgroundTasks/.test(ROOM));
  check('宿主: 打开影院时会停桌宠的换帧定时器',
    /function pauseHostTimers\(\)[\s\S]{0,600}pauseDesktopPet/.test(ROOM));
  check('宿主: 退出影院时会把它们恢复',
    /function resumeHostTimers\(\)[\s\S]{0,600}resumeHostBackgroundTasks/.test(ROOM) &&
    /function resumeHostTimers\(\)[\s\S]{0,600}resumeDesktopPet/.test(ROOM));
  check('宿主: closeSandbox 的两个出口都会恢复宿主',
    (ROOM.match(/resumeHostTimers\(\)/g) || []).length >= 3,
    '出现次数=' + (ROOM.match(/resumeHostTimers\(\)/g) || []).length);
  check('后台活动: 有 pause/resume 一对',
    /function pauseHostBackgroundTasks\(\)/.test(BG) &&
    /function resumeHostBackgroundTasks\(\)/.test(BG));
  check('后台活动: 只恢复【进影院之前就在跑】的那些 (不给用户凭空多开)',
    /hostTaskPauseState/.test(BG) &&
    /simulation: !!simulationIntervalId/.test(BG) &&
    /reminder: !!aiReminderSchedulerIntervalId/.test(BG));
  check('后台活动: pause/resume 暴露到 window (影院那边调得到)',
    /window\.pauseHostBackgroundTasks = pauseHostBackgroundTasks/.test(BG) &&
    /window\.resumeHostBackgroundTasks = resumeHostBackgroundTasks/.test(BG));
  check('桌宠: 换帧定时器可以单独停/起',
    /function startDesktopPetTimer\(\)/.test(PET) &&
    /function stopDesktopPetTimer\(\)/.test(PET) &&
    /pauseDesktopPet: stopDesktopPetTimer/.test(PET) &&
    /resumeDesktopPet: startDesktopPetTimer/.test(PET));

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('__FAILURES__' + failed.join(''));
  if (failed.length) failed.forEach(f => console.log('   ✗ ' + f));
  console.log('========================================');
  if (fail) process.exit(1);
})().catch(e => { console.error('测试崩了:', e); process.exit(1); });

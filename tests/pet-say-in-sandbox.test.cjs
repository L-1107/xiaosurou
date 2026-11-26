// ============================================================
// tests/pet-say-in-sandbox.test.cjs
// 「宠物说的话要刷进影院 / 读书屋的聊天框」的回归测试 (2026-11-25)
//
// 跑法: node tests/pet-say-in-sandbox.test.cjs
//
// 【用户原话】
//   「现在图书馆和影院都是单开的页面, 外面宠物说的话没办法刷新进影院和图书馆的
//     聊天框里, 如果用户在图书馆和影院里的时候, 能把宠物说的话也刷新进聊天框吗」
//
// 【为什么原来的实现做不到】
//   影院 / 读书屋都是【独立 iframe 页面】, 一打开就整屏盖住宿主。
//   pet-speech.js 原本只做两件事:
//     ① 把话写进主聊天历史 (messageStore)
//     ② 重绘宿主聊天框 (renderChatInterface)
//   沙盒里的聊天框是【另一套 DOM】—— 上面两件事一个都碰不到它,
//   所以用户在沙盒里时那句话等于白说。
//
// 【本测试守什么】
//   ① pet-speech.js: 落库/重绘之后必须广播 'pet:spoke', 带 chatId / petName / text / timestamp
//   ② 每只宠物的「允许插话到聊天框」开关关掉时【一条都不广播】(不能绕过用户的开关)
//   ③ 广播失败绝不影响宠物说话本身 (话照样出、库照样写)
//   ④ 两个宿主桥 (cinema-room.js / reading-room.js) 都监听 'pet:spoke' 并转发
//   ⑤ 两个沙盒 (cinema-sandbox / reading-sandbox) 都收对应的消息并渲染气泡
//   ⑥ 两套气泡样式 / 版本号 / SW 变更记录都在 (漏 bump 一边 PWA 就吃旧文件)
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, detail) {
  passed++;
  console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''));
}
function fail(name, detail) {
  failed++;
  console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''));
}
function check(name, cond, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

// ============================================================
// 一个能跑 pet-speech.js 的最小沙箱
// 配置:
//   pet     —— 宠物行 (canChatInsert 可关)
//   chat    —— 当前聊天 (null = 一条都没有)
//   api     —— 模型返回的文本
//   breakDispatch —— true 时 dispatchEvent 直接抛 (验"广播失败不影响说话")
// ============================================================
function makeSandbox(cfg) {
  cfg = cfg || {};
  const store = {};
  const added = [];
  const events = [];
  const toasts = [];

  const bubbleEl = {
    id: 'pn-desktop-pet-bubble', hidden: true, textContent: '', className: '',
    classList: { _s: [], add(c) { this._s.push(c); }, remove(c) { this._s = this._s.filter(x => x !== c); }, contains(c) { return this._s.indexOf(c) >= 0; } }
  };
  const petWrap = { id: 'pn-desktop-pet', hidden: false };

  const pet = cfg.pet || {
    id: 'pet-1', name: '啾啾', kind: 'cat', stage: 2, satiety: 70,
    traits: { attachment: 80, energy: 40, curiosity: 60, sociability: 70, calm: 50, sensitivity: 55 },
    appearance: { beastSpecies: '囚牛' },
    createdAt: 1
  };
  const chat = cfg.chat === undefined ? {
    id: 'c1', name: '小雅', settings: { myNickname: '阿乐' }, history: []
  } : cfg.chat;

  const sandbox = {
    console: cfg.quiet
      ? { log: console.log, warn: () => {}, error: console.error }
      : console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: (id) => {
        if (id === 'pn-desktop-pet-bubble') return bubbleEl;
        if (id === 'pn-desktop-pet') return petWrap;
        return null;
      },
      querySelectorAll: () => []
    },
    showToast: (text) => { toasts.push(String(text)); },
    state: {
      activeChatId: chat ? chat.id : null,
      chats: chat ? { [chat.id]: chat } : {},
      qzoneSettings: { nickname: '阿乐' },
      globalSettings: {},
      apiConfig: { proxyUrl: 'https://main.example.com/v1', apiKey: 'main-key', model: 'main-model' }
    },
    PetNest: {
      listPets: async () => [pet],
      rules: {
        petView: (row) => Object.assign({}, row),
        dimensionScores: async () => ({ affection: 30, reading: 20, watching: 10, listening: 40, exploration: 5 }),
        isHatchKind: (k) => k === 'egg' || k === 'parrot'
      },
      isDesktopPet: () => true
    },
    resolveApiSlotConfig: async () => ({
      proxyUrl: 'https://bg.example.com/v1', apiKey: 'bg-key', model: 'bg-model'
    }),
    messageStore: {
      addMessageToChat: async (c, msg) => { added.push(msg); if (c && Array.isArray(c.history)) c.history.push(msg); },
      getRecentMessages: async () => []
    },
    renderChatInterface: () => { sandbox.renderCalls = (sandbox.renderCalls || 0) + 1; },
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content: cfg.api === undefined ? '我想睡觉了' : cfg.api } }] }; },
      async text() { return String(cfg.api === undefined ? '我想睡觉了' : cfg.api); }
    }),
    CustomEvent: function CustomEvent(type, opts) {
      this.type = type;
      this.detail = (opts && opts.detail) || null;
    },
    dispatchEvent: (ev) => {
      if (cfg.breakDispatch) throw new Error('dispatch 炸了');
      events.push(ev);
    },
    addEventListener: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('modules/pet-speech.js'), sandbox, { filename: 'pet-speech.js' });
  if (!sandbox.window.PetSpeech) throw new Error('pet-speech.js 没暴露 window.PetSpeech');

  return { sandbox, events, added, toasts, bubbleEl, pet, chat };
}

// ============================================================
// ① 广播本身
// ============================================================
(async function () {

  section('① 宠物说话 → 广播 pet:spoke');
  {
    const S = makeSandbox();
    const text = await S.sandbox.window.PetSpeech.petSpeak(S.pet, 'feed');
    check('话确实说出来了', text === '我想睡觉了', String(text));
    check('落库仍然照旧', S.added.length === 1 && S.added[0].type === 'pet_say',
      '写库 ' + S.added.length + ' 条');
    check('重绘宿主聊天框仍然照旧', S.sandbox.renderCalls === 1, 'render 调用 ' + S.sandbox.renderCalls + ' 次');
    check('广播了一次 pet:spoke', S.events.length === 1,
      '收到 ' + S.events.length + ' 个事件' + (S.events[0] ? ' / ' + S.events[0].type : ''));
    const ev = S.events[0] || {};
    const d = ev.detail || {};
    check('事件名是 pet:spoke', ev.type === 'pet:spoke', String(ev.type));
    check('带上了会话 id (沙盒靠它防串台)', d.chatId === 'c1', String(d.chatId));
    check('带上了宠物名字', d.petName === '啾啾', String(d.petName));
    check('带上了说话内容', d.text === '我想睡觉了', String(d.text));
    check('带上了时间戳', typeof d.timestamp === 'number' && d.timestamp > 0, String(d.timestamp));
  }

  section('② 每只宠物的「允许插话到聊天框」开关必须生效');
  {
    const S = makeSandbox({
      pet: {
        id: 'pet-2', name: '小白', kind: 'cat', stage: 2, satiety: 70,
        canChatInsert: false,
        traits: {}, appearance: {}
      }
    });
    const text = await S.sandbox.window.PetSpeech.petSpeak(S.pet, 'feed');
    check('话照样说 (只是不插进聊天框)', !!text, String(text));
    check('一条都没写进聊天历史', S.added.length === 0, '写库 ' + S.added.length + ' 条');
    check('也没有广播 (不能绕过用户的开关)', S.events.length === 0,
      '收到 ' + S.events.length + ' 个事件');
  }

  section('③ 广播失败不影响宠物说话本身');
  {
    const S = makeSandbox({ breakDispatch: true, quiet: true });
    let text = null, threw = null;
    try {
      text = await S.sandbox.window.PetSpeech.petSpeak(S.pet, 'feed');
    } catch (e) { threw = e; }
    check('petSpeak 没有抛异常', !threw, threw ? String(threw && threw.message) : '');
    check('话照样说出来了', text === '我想睡觉了', String(text));
    check('库照样写了', S.added.length === 1, '写库 ' + S.added.length + ' 条');
  }

  section('④ 没有会话时不广播 (没地方显示, 也不该乱发)');
  {
    const S = makeSandbox({ chat: null });
    await S.sandbox.window.PetSpeech.petSpeak(S.pet, 'idle');
    check('没有会话就没有 pet:spoke', S.events.length === 0, '收到 ' + S.events.length + ' 个事件');
  }

  // ============================================================
  // ⑤ 宿主桥: 影院
  // ============================================================
  section('⑤ 影院宿主桥 (cinema-room.js)');
  {
    const src = read('modules/cinema-room.js');
    check('监听 pet:spoke', /addEventListener\('pet:spoke'/.test(src));
    check('转发的消息类型是 cinema:petSay', /'cinema:petSay'/.test(src));
    check('转发前校验会话 id (防串台)', /d\.chatId\s*&&\s*c\.id\s*!==\s*d\.chatId/.test(src));
    check('转发的是宠物名字 + 内容 + 时间戳',
      /petName:\s*d\.petName/.test(src) && /text:\s*String\(d\.text\)/.test(src) && /timestamp:/.test(src));
  }

  // ============================================================
  // ⑥ 宿主桥: 读书屋
  // ============================================================
  section('⑥ 读书屋宿主桥 (reading-room.js)');
  {
    const src = read('modules/reading-room.js');
    check('监听 pet:spoke', /addEventListener\('pet:spoke'/.test(src));
    check('转发的消息类型是 reading:petSay', /'reading:petSay'/.test(src));
    check('桌面「图书馆」进来的会话用 _overrideChat 校验',
      /currentChatObject\(_overrideChat\)/.test(src) &&
      /d\.chatId\s*&&\s*c\.id\s*!==\s*d\.chatId/.test(src));
    check('iframe src 换了新 ?v= (不然 PWA 吃旧沙盒页)',
      /reading-sandbox\/index\.html\?v=0\.1\.4/.test(src));
  }

  // ============================================================
  // ⑦ 沙盒侧: 影院
  // ============================================================
  section('⑦ 影院沙盒 (cinema-sandbox/index.html + cinema-live.js)');
  {
    const page = read('cinema-sandbox/index.html');
    check('沙盒页处理 cinema:petSay', /d\.type === 'cinema:petSay'/.test(page));
    check('调的是 CinemaLive.appendPetBubble', /CinemaLive\.appendPetBubble/.test(page));

    const live = read('modules/cinema-live.js');
    check('cinema-live.js 定义了 appendPetBubble', /function appendPetBubble\(/.test(live));
    check('appendPetBubble 有对外导出', /appendPetBubble:\s*appendPetBubble/.test(live));
    check('气泡注明是宠物 (🐾 名字：)', /🐾/.test(live) && /cinema-chat-pet-name/.test(live));
    check('聊天面板收着时用沙盒 toast 兜底', /isChatOpen/.test(live) && /window\.showToast/.test(live));

    const css = read('modules/cinema-room.css');
    check('影院宠物气泡有独立样式 .cinema-chat-msg.pet', /\.cinema-chat-msg\.pet\b/.test(css));
  }

  // ============================================================
  // ⑧ 沙盒侧: 读书屋
  // ============================================================
  section('⑧ 读书屋沙盒 (reading-sandbox.js + CSS)');
  {
    const js = read('modules/reading-sandbox.js');
    check('沙盒收 reading:petSay', /case 'reading:petSay'/.test(js));
    check('有 appendPetMsg 渲染函数', /function appendPetMsg\(/.test(js));
    check('气泡注明是宠物 (🐾 名字：)', /🐾/.test(js) && /rr-msg-pet-name/.test(js));
    check('聊天收起 / 在书架页时用 toast 兜底', /S\.view !== 'reader'/.test(js) && /toast\(/.test(js));

    const css = read('modules/reading-sandbox.css');
    check('读书屋宠物气泡有独立样式 .rr-msg.pet', /\.rr-msg\.pet\b/.test(css));
  }

  // ============================================================
  // ⑨ 版本号 / SW 变更记录 (漏一边 → 手机上跑不到新代码)
  // ============================================================
  section('⑨ 版本号与 SW 缓存');
  {
    const home = read('index.html');
    const sandboxCinema = read('cinema-sandbox/index.html');
    const sandboxReading = read('reading-sandbox/index.html');
    const sw = read('sw.js');

    const pairs = [
      ['pet-speech.js', '0.0.6', home],
      ['reading-room.js', '0.1.9', home],
      ['cinema-room.js', '0.35.3', home],
      ['cinema-live.js', '2.5.1', home],
      ['cinema-room.css', '0.39.1', home]
    ];
    for (const [file, ver, src] of pairs) {
      check('index.html 的 ' + file + ' ?v=' + ver,
        new RegExp(file.replace(/\./g, '\\.') + '\\?v=' + ver.replace(/\./g, '\\.')).test(src));
    }
    check('影院沙盒页的 cinema-room.js 对齐 0.35.3', /cinema-room\.js\?v=0\.35\.3/.test(sandboxCinema));
    check('影院沙盒页的 cinema-live.js 对齐 2.5.1', /cinema-live\.js\?v=2\.5\.1/.test(sandboxCinema));
    check('影院沙盒页的 cinema-room.css 对齐 0.39.1', /cinema-room\.css\?v=0\.39\.1/.test(sandboxCinema));
    check('读书屋沙盒页的 reading-sandbox.js 对齐 0.1.7', /reading-sandbox\.js\?v=0\.1\.7/.test(sandboxReading));
    check('读书屋沙盒页的 reading-sandbox.css 对齐 0.1.6', /reading-sandbox\.css\?v=0\.1\.6/.test(sandboxReading));

    check('SW 里有这次的变更记录', /v0\.2\.137\.0/.test(sw) && /宠物说的话也要刷进影院/.test(sw));
    check('SW 的 CACHE_VERSION 已 bump 到 v0.2.141.0', /const CACHE_VERSION = 'v0\.2\.141\.0'/.test(sw));
  }

  // ============================================================
  printSummary();
})().catch(e => { console.error(e); process.exit(1); });

function printSummary() {
  console.log('\n================================');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  console.log('================================');
  if (failed > 0) process.exit(1);
}

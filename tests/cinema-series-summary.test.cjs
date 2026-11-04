// ============================================================================
// tests/cinema-series-summary.test.cjs
// 短剧「每集剧情」总结的整场回归测试 (2026-11-04)
//
// 跑法: node tests/cinema-series-summary.test.cjs
//
// 【背景】(用户 2026-11-03 晚上实测)
//   "在家庭影院看在线短剧, 这次的短剧是竖屏的, 一集播完第一次没总结剧情,
//    第二次播一半观影API重连, 最后总结的剧情就只有半截;
//    测试了一下, 好像横屏的在线短剧又可以正常总结剧情"
//
// 【真因】—— 不是竖屏/横屏, 是【一集长度 vs 2 分钟的摘要间隔】
//
//   短剧模式下, 长剧式的「每 2 分钟一段」阶段摘要一直在跑。它干三件事,
//   全都打在短剧身上:
//
//   ① 抢通道: 阶段摘要和「每集单集剧情」用的是同一条摘要通道。
//      短剧一集才 1~2 分钟, 阶段摘要一发, 一集播完那一刻正好撞上在途请求
//      → 单集剧情等 EPISODE_SUMMARY_WAIT_MS 也等不到 → 这一集白看
//      (用户报的「第一次没总结」)。
//
//   ② 撞主键: 两者写的是同一张表、同一个主键 (id = "<剧名>#<ep>"):
//        单集剧情 ep = 集号 (1,2,3…)   段落摘要 ep = 段号 (1,2,3…)
//      谁后写谁赢 ——
//        短集 (一集 < 2 分钟): 阶段摘要在【这集播完之后】才发 → 段落摘要把
//          这一集的单集剧情【覆盖掉】→ 面板上那一条只剩半截。
//        长集 (一集 > 2 分钟): 阶段摘要在集中间发, 单集剧情后写能盖回来
//          → 看着就正常。
//      这就是「竖屏坏、横屏好」的全部原因 —— 代码里没有任何一处按竖屏/横屏分支。
//
//   ③ 重置会话: 每次阶段摘要之后 S._needFreshSession = true → 帧循环里
//      S.client.resetSession() → Live 断线重连。连接一断, 会话里累积的画面
//      全没了 → 模型只看得见重连之后那几秒 → 这一集只剩尾巴
//      (用户报的「播一半观影API重连」+「只有半截」)。
//
// 【修法】
//   · 短剧模式一律不跑长剧式阶段摘要 (scheduleStageSummary / tickStageSummary
//     / 看门狗 三处都挡)
//   · 短剧改成【每集播完换干净会话】—— 换在集与集之间, 不在一集中间,
//     这样这一集的全部画面都在它自己那个会话里 → 总结完整
//   · 段落记忆在短剧模式下不落库 (最后一道保险)
//   · 长剧模式一行没动 (阶段摘要照旧)
//
// 【手法】
//   跟 tests/_harness/cinema-live-harness.cjs 一样: 把真的 modules/cinema-live.js
//   + modules/live-client.js 装进 vm 沙箱, 配假时钟 + 假 WebSocket,
//   模拟一部短剧连续播 N 集, 然后看四样东西:
//     ① 发出去的 turn 都是「每集单集剧情」吗 (有没有混进长剧式阶段摘要)
//     ② 落库的每一行都是「单集剧情」吗 (有没有被段落摘要顶掉)
//     ③ 会话重置是不是只发生在集播完之后 (有没有在一集中间断)
//     ④ 长剧模式是不是还照旧跑阶段摘要 (别把长剧一起干掉了)
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, detail) {
  passed++;
  console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''));
}
function fail(name, detail) {
  failed++;
  fails.push(name);
  console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''));
}
function check(name, cond, detail) {
  if (cond) ok(name, detail); else fail(name, detail);
}
function section(title) { console.log('\n== ' + title + ' =='); }

// ---------------------------------------------------------------------------
// 假时钟
// ---------------------------------------------------------------------------
function makeClock() {
  const timers = new Map();
  let seq = 0;
  let now = 1700000000000;
  function setTimer(fn, ms, interval) {
    const id = ++seq;
    timers.set(id, { id, fn, at: now + Math.max(0, ms || 0), every: interval ? Math.max(1, ms || 0) : 0 });
    return id;
  }
  return {
    now: () => now,
    setTimeout: (fn, ms) => setTimer(fn, ms, 0),
    setInterval: (fn, ms) => setTimer(fn, ms, 1),
    clearTimeout: (id) => { timers.delete(id); },
    clearInterval: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      let steps = 0;
      for (;;) {
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= target && (!next || t.at < next.at)) next = t;
        }
        if (!next) break;
        if (++steps > 200000) throw new Error('定时器跑太多步, 可能有死循环');
        now = next.at;
        if (next.every) next.at = now + next.every;
        else timers.delete(next.id);
        try { next.fn(); } catch (e) { /* 探针里忽略 */ }
      }
      now = target;
    }
  };
}

// ---------------------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------------------
function makeFakeElement(id) {
  return {
    id: id || '', style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    innerHTML: '', textContent: '', value: '', dataset: {}, children: [], parentNode: null,
    appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 })
  };
}

// ---------------------------------------------------------------------------
// 跑一场
// ---------------------------------------------------------------------------
// cfg:
//   epLenSec      每集多少秒 (0 = 不分集, 当长剧跑)
//   eps           播几集
//   turnLatencyMs 一次 turn 多久 (模拟模型慢)
//   isSeries      是不是短剧
//   failStageCount 前 N 次阶段摘要返回「太短的正文」(模拟模型没写出来)
async function runScene(cfg) {
  const o = Object.assign({
    epLenSec: 90, eps: 4, turnLatencyMs: 8000, isSeries: true, failStageCount: 0
  }, cfg || {});
  const clock = makeClock();
  const stat = {
    setupCount: 0,
    turns: [],            // {kind, at, framesInSession}
    saved: [],            // {ep, text, at}
    sockets: [],          // 每个 socket 收了多少帧
    chatLines: []
  };

  const chatBox = {
    children: [],
    appendChild(node) {
      const t = node && (node.textContent || (node.innerHTML || '').replace(/<[^>]*>/g, ''));
      if (t) stat.chatLines.push(String(t));
      this.children.push(node); return node;
    }
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; this.bufferedAmount = 0;
      this.frames = 0;
      stat.sockets.push(this);
      clock.setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 20);
    }
    send(data) {
      const s = String(data);
      let msg = null;
      try { msg = JSON.parse(s); } catch (e) { return; }
      if (!msg) return;
      if (msg.setup) {
        stat.setupCount++;
        clock.setTimeout(() => this.deliver({ setupComplete: {} }), 20);
        return;
      }
      if (msg.realtimeInput && msg.realtimeInput.video) { this.frames++; return; }
      if (msg.clientContent) {
        const raw = msg.clientContent.turns[0].parts[0].text || '';
        // 三种 turn 要分清楚 (它们的提示词开头不一样):
        //   episode = 「你刚刚看完了…的第 N 集」  → 每集单集剧情
        //   stage   = 「你刚看完了一段」          → 长剧式阶段摘要 (短剧里不该出现)
        //   recap   = 「我们之前看过一部分」      → 前情提要注入 (换会话后要重新喂)
        let kind = 'other';
        if (/你刚刚看完了/.test(raw)) kind = 'episode';
        else if (/你刚看完了一段/.test(raw)) kind = 'stage';
        else if (/我们之前看过一部分|前情提要/.test(raw)) kind = 'recap';
        stat.turns.push({
          kind: kind,
          at: clock.now(),
          framesInSession: this.frames
        });
        const epMatch = raw.match(/第\s*(\d+)\s*集/);
        const isEpisode = kind === 'episode';
        let text = isEpisode
          ? ('第 ' + (epMatch ? epMatch[1] : '?') + ' 集，女主在雨夜赶到医院，发现男主正陪着另一个女人，' +
             '两人当场争执，女主甩门而去，男主追出门外却发现她已经上了出租车离开，本集停在出租车驶离医院门口的那一刻。')
          : ('【剧情进度】\n男女主在医院门口争执后分开。\n\n【本段剧情】\n女主赶到医院撞见男主陪着另一个女人，' +
             '当场吵起来，男主追出去时她已经上了出租车离开，这一段就停在这里。');
        // 模拟「模型这次什么都没写出来」(正文太短 → 低于下限 → 这一段落不了库)
        if (!isEpisode && o.failStageCount > 0) {
          stat.stageCount = (stat.stageCount || 0) + 1;
          if (stat.stageCount <= o.failStageCount) text = '嗯。';
        }
        const chunks = 4;
        for (let i = 0; i < chunks; i++) {
          const piece = text.slice(0, Math.ceil(text.length * (i + 1) / chunks));
          clock.setTimeout(() => this.deliver({
            serverContent: { outputTranscription: { text: piece } }
          }), o.turnLatencyMs + i * 300);
        }
        clock.setTimeout(() => this.deliver({ serverContent: { turnComplete: true } }), o.turnLatencyMs + chunks * 300);
      }
    }
    deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '' }); }
  }

  const video = {
    id: 'cinema-video', paused: false, ended: false, videoWidth: 1080, videoHeight: 1920,
    currentTime: 0, duration: 0,
    play() { this.paused = false; this.ended = false; },
    pause() { this.paused = true; },
    addEventListener() {}, removeEventListener() {}
  };
  const els = {};
  function getEl(id) {
    if (id === 'cinema-video') return video;
    if (id === 'cinema-chat-messages') return chatBox;
    if (!els[id]) els[id] = makeFakeElement(id);
    return els[id];
  }
  const fakeCanvas = {
    width: 0, height: 0,
    getContext() { const c = fakeCanvas; return { fillStyle: '', fillRect() {}, drawImage() {}, canvas: c }; },
    toDataURL() { return 'data:image/jpeg;base64,' + 'B'.repeat(90 * 1024); }
  };
  const document = {
    getElementById: getEl,
    createElement(tag) { return String(tag).toLowerCase() === 'canvas' ? fakeCanvas : makeFakeElement(tag); },
    createTextNode: (t) => ({ textContent: t }),
    body: makeFakeElement('body'), documentElement: makeFakeElement('html'),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => []
  };

  const store = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (...a) => clock.setTimeout(...a), clearTimeout: (...a) => clock.clearTimeout(...a),
    setInterval: (...a) => clock.setInterval(...a), clearInterval: (...a) => clock.clearInterval(...a),
    Date: class extends Date {
      constructor(...a) { if (!a.length) super(clock.now()); else super(...a); }
      static now() { return clock.now(); }
    },
    performance: { now: () => clock.now() },
    TextEncoder, TextDecoder, Blob, btoa, atob,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    crypto: { randomUUID: () => 'probe' }, navigator: { userAgent: 'probe' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }
    },
    document, WebSocket: FakeWebSocket,
    state: {
      activeChatId: 'probe',
      chats: {
        probe: {
          id: 'probe', name: '探针', settings: { aiPersona: '你是观众。' },
          watchTogetherSettings: { geminiApiKey: 'AIza-probe' }
        }
      }
    },
    db: { chats: { put: async () => {}, get: async () => null } },
    CinemaStorage: {
      saveEpMemory: async (rec) => {
        stat.saved.push({ ep: rec.ep, kind: rec.kind, text: rec.text, at: clock.now() });
        return { id: rec.sessionKey + '#' + rec.ep, text: rec.text };
      },
      listEpMemories: async () => [],
      saveSeriesRecap: async () => {}, getSeriesRecap: async () => null, deleteSeriesRecap: async () => {}
    },
    showToast() {}, showCustomAlert: async () => true, showCustomConfirm: async () => true,
    confirm: () => true, alert: () => {},
    requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.now()), 16),
    cancelAnimationFrame: () => {}, addEventListener() {}, removeEventListener() {}
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.parent = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('modules/live-client.js'), ctx, { filename: 'live-client.js' });
  vm.runInContext(read('modules/cinema-live.js'), ctx, { filename: 'cinema-live.js' });

  const CL = ctx.CinemaLive;
  CL.setChat('probe');
  let p = null;
  try { p = CL.enable(); } catch (e) { /* */ }
  if (p && p.catch) p.catch(() => {});

  async function pump(ms) {
    const step = 50;
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  }
  await pump(1000);

  if (o.isSeries) {
    CL.setSeries('probe-drama', '测试短剧');
    for (let ep = 1; ep <= o.eps; ep++) {
      CL.setSeriesProgress('probe-drama', '测试短剧', ep - 1, '', ep);
      CL.onSeriesEpisodeChanged();
      video.ended = false; video.paused = false;
      await pump(o.epLenSec * 1000);
      video.ended = true;
      CL.onVideoEnded();
      await pump(15000);          // 给单集总结 + 换会话留时间
    }
  } else {
    // 长剧: 一口气播 6 分钟 (跨过 2 分钟那条线)
    await pump(6 * 60 * 1000);
  }

  return { stat: stat, ctx: ctx };
}

// ---------------------------------------------------------------------------
// ① 短剧 (一集 90 秒 —— 竖屏短剧那种)
// ---------------------------------------------------------------------------
async function main() {
section('① 短剧 · 一集 90 秒（竖屏短剧那种短集）');
{
  const r = await runScene({ epLenSec: 90, eps: 4 });
  const st = r.stat;

  const stageTurns = st.turns.filter(t => t.kind === 'stage');
  check('全程没有长剧式的阶段摘要 turn', stageTurns.length === 0,
    'turns=' + JSON.stringify(st.turns.map(t => t.kind)));

  const epTurns = st.turns.filter(t => t.kind === 'episode');
  check('每集都发了一次单集总结 (4 集 → 4 次)', epTurns.length === 4,
    '次数=' + epTurns.length);

  // 落库的每一行都必须是「单集剧情」, 不能有「段落摘要」顶掉
  const segRows = st.saved.filter(s => !/第\s*\d+\s*集/.test(s.text));
  check('落库的每一行都是「单集剧情」(没有被段落摘要覆盖)', segRows.length === 0,
    '被覆盖的行=' + segRows.length + ' 全部=' + JSON.stringify(st.saved.map(s => s.ep)));

  const eps = st.saved.map(s => s.ep).sort((a, b) => a - b);
  check('落库的集号是 1,2,3,4 (不多不少)', JSON.stringify(eps) === '[1,2,3,4]',
    '集号=' + JSON.stringify(eps));

  // 会话重置只能发生在【集播完之后】—— 不能在一集中间断 (断了这一集就只剩尾巴)
  const maxFramesInOneSession = Math.max.apply(null, st.sockets.map(s => s.frames).concat([0]));
  check('任何一个会话里的帧数都不超过一集的帧数 (没在一集中间断)',
    maxFramesInOneSession <= 95, '最多 ' + maxFramesInOneSession + ' 帧 (一集约 90 帧)');

  check('每集换一次会话 (1 次初始 + 4 次换 = 5)', st.setupCount === 5,
    'setup 次数=' + st.setupCount);
}

// ---------------------------------------------------------------------------
// ② 短剧 (一集 180 秒 —— 横屏长集那种) —— 不能被改坏
// ---------------------------------------------------------------------------
section('② 短剧 · 一集 180 秒（横屏长集那种）');
{
  const r = await runScene({ epLenSec: 180, eps: 3 });
  const st = r.stat;
  const stageTurns = st.turns.filter(t => t.kind === 'stage');
  check('也没有长剧式的阶段摘要 turn', stageTurns.length === 0,
    'turns=' + JSON.stringify(st.turns.map(t => t.kind)));
  const eps = st.saved.map(s => s.ep).sort((a, b) => a - b);
  check('落库的是 1,2,3 三集的单集剧情', JSON.stringify(eps) === '[1,2,3]',
    '集号=' + JSON.stringify(eps));
  const segRows = st.saved.filter(s => !/第\s*\d+\s*集/.test(s.text));
  check('没有被段落摘要覆盖', segRows.length === 0, '被覆盖的行=' + segRows.length);
}

// ---------------------------------------------------------------------------
// ③ 长剧 —— 阶段摘要必须照旧 (别把长剧一起干掉了)
// ---------------------------------------------------------------------------
section('③ 长剧 · 阶段摘要照旧');
{
  const r = await runScene({ isSeries: false, epLenSec: 0, eps: 0 });
  const st = r.stat;
  const stageTurns = st.turns.filter(t => t.kind !== 'episode');
  check('长剧照样跑阶段摘要 (播 6 分钟 → 至少 1 次)',
    stageTurns.length >= 1, '阶段摘要次数=' + stageTurns.length);
  check('长剧的段落记忆照旧落库', st.saved.length >= 1,
    '落库行数=' + st.saved.length);
  const segRows = st.saved.filter(s => !/第\s*\d+\s*集/.test(s.text));
  check('长剧落库的是「段落」不是「集」', segRows.length === st.saved.length);
}

// ---------------------------------------------------------------------------
// ④ 源码层面的护栏 (防止以后有人把这三处挡又删了)
// ---------------------------------------------------------------------------
section('④ 源码护栏');
{
  const live = read('modules/cinema-live.js');
  check('有 stageSummaryEnabled 这个开关', /function stageSummaryEnabled\(\)/.test(live));
  check('scheduleStageSummary 会先问它', /function scheduleStageSummary[\s\S]{0,600}stageSummaryEnabled\(\)/.test(live));
  check('tickStageSummary 会先问它', /function tickStageSummary[\s\S]{0,2000}stageSummaryEnabled\(\)/.test(live));
  check('看门狗也会问它', /startSummaryWatchdog[\s\S]{0,2500}stageSummaryEnabled\(\)/.test(live));
  check('短剧段落记忆不落库', /addFilmSegment[\s\S]{0,900}kind === 'series'/.test(live));
  check('一集播完会换干净会话', /function resetSessionAfterEpisode\(/.test(live));
  check('单集总结失败看得见 (Live 没就绪也记一条)',
    /requestEpisodeSummary[\s\S]{0,900}noteEpisodeFail\(ep, 'Gemini Live 没连上/.test(live));
}

// ---------------------------------------------------------------------------
// ⑤ 长剧 · 阶段摘要失败 → 【不能立刻换会话】(2026-11-04)
// ---------------------------------------------------------------------------
section('⑤ 长剧 · 阶段摘要失败时不换会话, 重试才救得回来');
{
  // 第一次阶段摘要返回「太短的正文」= 模拟模型这次没写出来
  const r = await runScene({ isSeries: false, epLenSec: 0, eps: 0, failStageCount: 1 });
  const st = r.stat;

  const stageTurns = st.turns.filter(t => t.kind === 'stage');
  check('长剧发了阶段摘要', stageTurns.length >= 2,
    '次数=' + stageTurns.length + ' 时间=' + JSON.stringify(stageTurns.map(t => Math.round((t.at - 1700000000000) / 1000))));

  // 关键: 失败那一次之后, 【不能】立刻换会话。
  //   旧写法 (失败也换) → 画面全丢 → 重试看到的是新画面 → 那一段的内容真的没了。
  //   新写法 (失败不换) → 画面留着 → 重试看到同一批画面 → 那段保住了。
  const failedAt = stageTurns[0].at;
  const retryAt = stageTurns[1] ? stageTurns[1].at : 0;
  check('失败后的重试在 60 秒左右发生 (没被重连拖成一整轮)',
    retryAt > failedAt && (retryAt - failedAt) < 90000,
    '间隔=' + Math.round((retryAt - failedAt) / 1000) + 's');

  // 落库的段落: 失败那次不占段号, 重试成功后补上 → 段落数 = 成功次数
  const segRows = st.saved.filter(s => !/第\s*\d+\s*集/.test(s.text));
  check('失败的那一段被重试补回来了 (段落数 = 成功次数)',
    segRows.length >= 2,
    '落库段落数=' + segRows.length + '  阶段摘要次数=' + stageTurns.length);

  // 换会话次数: 正常每段成功后换一次。失败那次【不该】多换一次
  //   (成功 3 次 = 3 次换 + 1 次初始; 旧写法会多一次, 因为失败也换)
  check('失败没有多换一次会话', st.setupCount <= 1 + segRows.length,
    'setup=' + st.setupCount + '  段落数=' + segRows.length);
}

// ---------------------------------------------------------------------------
console.log('\n========================================');
console.log('  通过 ' + passed + ' / 失败 ' + failed);
console.log('========================================');
if (failed > 0) {
  console.log('失败项:');
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
}

main().catch(e => { console.error('测试炸了:', e); process.exit(1); });

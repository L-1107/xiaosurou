// ============================================================================
// tests/_harness/cinema-live-harness.cjs
// 影院 Live 管线的【可跑测试台】—— 把真实的 modules/cinema-live.js +
// modules/live-client.js 装进 Node vm, 配假时钟 + 假 WebSocket, 15 分钟秒级跑完。
//
// 【为什么要这个】用户 2026-10-29 实测三连报 (发烫 / 一句总结都没写 / 十五分钟闪退),
//   靠读代码只能猜。这个测试台让【真代码】在受控的假服务端上跑, 能拿到硬数字:
//   发了多少帧、多少字节、几个 turn、剧情写进去几段。
//
// 【假服务端像真 Gemini Live 的哪几点】
//   · setup → 回 setupComplete
//   · 每一帧 (realtimeInput.video) 只记数, 不回话
//   · 每个 turn (clientContent) 回【音频 + 累计转写】, 最后一条带 turnComplete
//     —— 因为 AUDIO 是 gemini-3.8-live 唯一的 response modality, 每 turn 必带音频
//   · turn 有延迟, 而且越排越慢 (queuePenaltyMs) —— 用来模拟"turn 队列堆积"
//
// 【怎么用】
//   const { runScenario } = require('./_harness/cinema-live-harness.cjs');
//   const r = await runScenario({ label: 'x', turnLatencyMs: 35000 });
//   r.frames / r.outMB / r.segCount / r.chatLines ...
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

// ---------------------------------------------------------------------------
// 假时钟
// ---------------------------------------------------------------------------
function makeClock() {
  const timers = new Map();
  let seq = 0;
  let now = 1700000000000;

  function setTimer(fn, ms, interval) {
    const id = ++seq;
    timers.set(id, { id, fn, at: now + Math.max(0, ms || 0), every: interval ? Math.max(1, ms || 1) : 0 });
    return id;
  }
  const api = {
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
    },
    pending: () => timers.size
  };
  return api;
}

// ---------------------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------------------
function makeFakeElement(id) {
  return {
    id: id || '',
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    children: [],
    parentNode: null,
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
// 跑一轮模拟
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 每一帧的 base64 有多大 —— 要按【代码里真实的长边】算, 否则 before/after
// 的字节数就不是同一把尺子, 对比就没意义了。
//
//   768 长边 (修复前): 768x432 jpeg q0.6 → 约 60KB jpeg → 约 90KB base64
//   512 长边 (修复后): 512x288 jpeg q0.5 → 约 20KB jpeg → 约 27KB base64
// ---------------------------------------------------------------------------
function frameBytesForSource(src) {
  const m = /var\s+FRAME_MAX_DIM\s*=\s*([0-9]+)/.exec(src);
  const dim = m ? Number(m[1]) : 768;
  if (dim <= 512) return 27 * 1024;
  if (dim <= 640) return 50 * 1024;
  return 90 * 1024;
}

async function runScenario(cfg) {
  let liveSrc = null;
  const opts = Object.assign({
    minutes: 15,
    turnLatencyMs: 3000,
    queuePenaltyMs: 0,
    chunkIntervalMs: 800,
    transcriptChunks: 4,
    audioBase64Len: 80 * 1024,     // 每条消息带 80KB base64 音频
    label: 'scenario',
    // 🔴 2026-10-29: 每秒钩子(探针用) —— 模拟用户切后台/暂停/换片
    onSecond: null,
    // 🔴 2026-10-29: 模拟真机「live 掉线 + 重连迟迟不 ready」
    dropLiveAtMs: null,
    stallSetupUntilMs: null,
    // 🔴 2026-10-29: 实况通道的三种模式。
    //   off      = 完全关掉 (d0f41e1 之前的样子: Live 只看画面 + 每 5 分钟一段总结)
    //   live     = 旧做法: 实况发 Live turn (要配旧版 cinema-live.js)
    //   provider = 新做法: 实况走主 API, 【不占 Live 的 turn 队列】
    liveNowMode: 'provider',
    // 跑指定版本的 cinema-live.js (before/after 对照用)
    liveSrcOverride: null,
    clientSrcOverride: null,
    // provider 返回的那句话
    liveNowText: '此刻屏幕上, 一个穿风衣的男人正举着手电照向仓库深处。',
    // 现实中的 Live 模型是【说话】回答的 —— 转写是连续口语, 没有【】标记、没有换行。
    summaryText:
      '好的。剧情进度是主角一行人赶到山下的旧仓库，发现了失踪三年的兄长留下的箱子，' +
      '箱子里有一盘磁带和一张泛黄的车票。本段剧情讲的是这一段新发生的事。' +
      '主角一行人破开箱子的瞬间，仓库深处传来铁门落锁的声音，仓库的灯忽然全部熄灭，' +
      '只剩磁带机亮着一点红灯，随后磁带自动转了起来，传出兄长三年前录下的声音。',
    liveText: '此刻屏幕上，一个穿风衣的男人正举着手电照向仓库深处。'
  }, cfg || {});
  // 被测的 cinema-live.js —— 可以是【任意版本】(before/after 对照用)
  liveSrc = opts.liveSrcOverride ? String(opts.liveSrcOverride) : read('modules/cinema-live.js');
  // 帧大小跟着【被测代码】的真实分辨率走 —— before/after 才在同一把尺子上
  opts.frameBase64Len = cfg && cfg.frameBase64Len ? cfg.frameBase64Len : frameBytesForSource(liveSrc);

  const clock = makeClock();
  // 🔴 2026-10-29: 场景起点 —— dropLiveAtMs / stallSetupUntilMs 都按【相对】毫秒算
  const baseNow = clock.now();
  const stats = {
    bytesOut: 0, bytesIn: 0, audioBytesIn: 0, messagesIn: 0,
    frameCount: 0, frameBytes: 0, turnCount: 0, turnDone: 0,
    turnQueue: [], setupCount: 0, fresh: 0,
    // 🔴 2026-10-29: turn 明细 —— 用来算「每个 turn 要重读多少累积帧」
    turnLog: [],          // {kind, sentAt, framesAtSend, inflightAtSend, doneAt}
    serialQueue: [],      // 真串行队列 (Live 的 turn 就是串行的)
    serialPumping: false,
    providerCalls: 0,        // 实况 provider 被叫了几次 (走主 API 的次数)
    sockets: [],             // 所有假 socket (用来做「中途断线」)
    liveDropped: false
  };
  const chatLines = [];

  // ---- 假 WebSocket (像真 Gemini Live) ----
  const later = clock.setTimeout;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      stats.sockets.push(this);
      later(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }, 50);
    }
    send(data) {
      const s = String(data);
      stats.bytesOut += s.length;
      let msg = null;
      try { msg = JSON.parse(s); } catch (e) { /* ignore */ }
      if (!msg) return;
      if (msg.setup) {
        stats.setupCount++;
        if (stats.setupCount > 1) stats.fresh++;   // 第二次 setup = 换了一次干净会话
        // 🔴 2026-10-29: stall 窗口内不发 setupComplete → live 一直不 ready
        const relMs = clock.now() - baseNow;
        const stalling = opts.dropLiveAtMs !== null && opts.dropLiveAtMs !== undefined &&
          relMs >= opts.dropLiveAtMs &&
          (opts.stallSetupUntilMs === null || opts.stallSetupUntilMs === undefined ||
            relMs < opts.stallSetupUntilMs);
        if (stalling) {
          stats.setupStalled = (stats.setupStalled || 0) + 1;
        } else {
          later(() => this.deliver({ setupComplete: {} }), 30);
        }
        return;
      }
      if (msg.realtimeInput && msg.realtimeInput.video) {
        stats.frameCount++;
        // 🔴 本【连接】的帧数 —— 换会话后归零, 这才是「单个 turn 要重读多少帧」
        this._frames = (this._frames || 0) + 1;
        stats.frameBytes += s.length;
        return;
      }
      if (msg.clientContent) {
        stats.turnCount++;
        const rawText = (msg.clientContent.turns[0].parts[0].text || '');
        const kind = rawText.indexOf('此刻屏幕') >= 0 ? 'liveNow' : 'summary';
        // 🔴 这个 turn 发出时, 会话里【已经累积了多少帧】→ 就是它要重读的上下文
        const rec = {
          kind: kind,
          // 🔴 2026-11-05: 带上原文 —— 探针要靠它分清"单集总结"和"提要注入"
          //   (这两个都是 summary, 光看 kind 分不出来)。只加字段, 不改任何行为。
          raw: rawText,
          sentAt: clock.now(),
          framesAtSend: this._frames || 0,
          inflightAtSend: stats.turnCount - stats.turnDone
        };
        stats.turnLog.push(rec);
        stats.serialQueue.push({ msg: msg, rec: rec });
        this._pump();
      }
    }
    // 🔴 2026-10-29: 真串行 turn 队列。
    //   Live 的 turn 是【一个做完下一个才能开始】的 —— 原来那个
    //   "wait = 基础延迟 + backlog × penalty" 是假排队, 量不出真实的堆积。
    _pump() {
      if (stats.serialPumping) return;
      const item = stats.serialQueue.shift();
      if (!item) { stats.serialPumping = false; return; }
      stats.serialPumping = true;
      // 🔴 2026-10-29: 真实 Live 的 turn 耗时【正比于上下文大小】——
      //   它要重读会话里累积的全部帧 (258 token/帧)。累积帧越多, 这个 turn 越慢。
      //   之前这里是固定延迟, 量不出「实况 turn 把后面的摘要 turn 拖死」。
      const wait = opts.turnLatencyMs + opts.queuePenaltyMs +
        (opts.perFrameTurnMs || 0) * (item.rec && item.rec.framesAtSend ? item.rec.framesAtSend : 0);
      later(() => {
        this.answerTurn(item.msg, item.rec);
        stats.serialPumping = false;
        this._pump();
      }, wait);
    }

    answerTurn(msg, rec) {
      const raw = (msg.clientContent.turns[0].parts[0].text || '');
      const isSummary = raw.indexOf('此刻屏幕') < 0;   // 实况指令一定带「此刻屏幕」
      const text = isSummary ? opts.summaryText : opts.liveText;
      const chunks = opts.transcriptChunks;
      for (let i = 0; i < chunks; i++) {
        const piece = text.slice(0, Math.ceil(text.length * (i + 1) / chunks));
        const payload = {
          serverContent: {
            modelTurn: {
              // 真服务端: AUDIO 是唯一 response modality → 每条消息都带一大坨音频
              parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'A'.repeat(opts.audioBase64Len) } }]
            },
            outputTranscription: { text: piece }
          }
        };
        if (i === chunks - 1) payload.serverContent.turnComplete = true;
        const s = JSON.stringify(payload);
        stats.bytesIn += s.length;
        stats.audioBytesIn += opts.audioBase64Len;
        stats.messagesIn++;
        later(() => this.deliver(payload), i * opts.chunkIntervalMs);
      }
      later(() => {
        if (rec) rec.doneAt = clock.now();
        stats.turnDone++;
        this.deliver({ serverContent: { turnComplete: true } });
      }, chunks * opts.chunkIntervalMs);
    }
    deliver(obj) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '' }); }
  }

  // ---- 假 DOM ----
  const video = {
    id: 'cinema-video',
    paused: false, ended: false, videoWidth: 1920, videoHeight: 1080,
    currentTime: 0, duration: 0, play() {}, pause() {},
    addEventListener() {}, removeEventListener() {}
  };
  const els = {};
  function getEl(id) {
    if (id === 'cinema-video') return video;
    if (!els[id]) els[id] = makeFakeElement(id);
    return els[id];
  }
  const fakeCanvas = {
    width: 0, height: 0,
    getContext() {
      const c = fakeCanvas;
      return { fillStyle: '', fillRect() {}, drawImage() {}, canvas: c };
    },
    toDataURL() { return 'data:image/jpeg;base64,' + 'B'.repeat(opts.frameBase64Len); }
  };
  const document = {
    getElementById: getEl,
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return fakeCanvas;
      return makeFakeElement(tag);
    },
    createTextNode: (t) => ({ textContent: t }),
    body: makeFakeElement('body'),
    documentElement: makeFakeElement('html'),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => []
  };

  const store = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (...a) => clock.setTimeout(...a),
    clearTimeout: (...a) => clock.clearTimeout(...a),
    setInterval: (...a) => clock.setInterval(...a),
    clearInterval: (...a) => clock.clearInterval(...a),
    Date: class extends Date {
      constructor(...a) { if (a.length === 0) super(clock.now()); else super(...a); }
      static now() { return clock.now(); }
    },
    performance: { now: () => clock.now() },
    TextEncoder, TextDecoder,
    Blob, btoa, atob,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    crypto: { randomUUID: () => 'probe-uuid' },
    navigator: { userAgent: 'probe' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document,
    WebSocket: FakeWebSocket,
    state: {
      activeChatId: 'probe',
      chats: {
        probe: {
          id: 'probe', name: '探针',
          settings: { aiPersona: '你是一个安静的观众。' },
          watchTogetherSettings: { geminiApiKey: 'AIza-probe-key' }
        }
      }
    },
    db: { chats: { put: async () => {}, get: async () => null } },
    CinemaStorage: {
      saveEpMemory: async () => {}, listEpMemories: async () => [],
      saveSeriesRecap: async () => {}, getSeriesRecap: async () => null,
      deleteSeriesRecap: async () => {}
    },
    showToast() {}, showCustomAlert: async () => true, showCustomConfirm: async () => true,
    confirm: () => true, alert: () => {},
    requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.now()), 16),
    cancelAnimationFrame: () => {},
    addEventListener() {}, removeEventListener() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.parent = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(opts.clientSrcOverride ? String(opts.clientSrcOverride) : read('modules/live-client.js'), ctx, { filename: 'live-client.js' });
  // 🔴 实况通道开关: 关掉 startLiveNowLoop 的启动 = 复现「刚写好」时的样子
  if (opts.liveNowMode === 'off') {
  }

  vm.runInContext(liveSrc, ctx, { filename: 'cinema-live.js' });

  // 聊天框里出现的每一行都记下来 —— 用来验"失败要告诉用户"
  const chatBox = getEl('cinema-chat-messages');
  chatBox.appendChild = function (node) {
    try {
      const t = node && (node.textContent || (node.innerHTML || '').replace(/<[^>]*>/g, ''));
      if (t) chatLines.push(String(t));
    } catch (e) { /* noop */ }
    this.children.push(node);
    if (node) node.parentNode = this;
    return node;
  };

  // 🔴 2026-10-29: 新架构下, 实况由 cinema-chat.js (主 API) 执行。
  //   harness 里不加载 cinema-chat.js, 所以这里手动注册一个假的 provider。
  if (opts.liveNowMode === 'provider' && ctx.CinemaLive &&
      typeof ctx.CinemaLive.setLiveNowProvider === 'function') {
    ctx.CinemaLive.setLiveNowProvider(function (b64) {
      stats.providerCalls++;
      return Promise.resolve(opts.liveNowText);
    });
  }

  // ---- 启动 ----
  // ⚠️ enable() 里 connect() 返回 Promise, 而假时钟的 setTimeout 只在 advance() 时才跑 ——
  //   直接 await enable() 会死锁。所以改成"启动 + 推时钟"。
  ctx.CinemaLive.setChat('probe');
  let enablePromise = null;
  try { enablePromise = ctx.CinemaLive.enable(); } catch (e) { /* 探针里忽略 */ }
  async function pump(ms) {
    const step = 50;
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  }
  await pump(3000);
  if (enablePromise && typeof enablePromise.catch === 'function') {
    enablePromise.catch(function () { /* noop */ });
  }

  // ---- 跑 N 分钟 ----
  const totalMs = opts.minutes * 60 * 1000;
  for (let t = 0; t < totalMs; t += 1000) {
    video.currentTime = t / 1000;
    clock.advance(1000);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // 每秒钩子
    if (typeof opts.onSecond === 'function') {
      try { await opts.onSecond(t, ctx, stats); } catch (e) { /* noop */ }
    }

    // 🔴 2026-10-29: 到点主动断线 (模拟 iOS 切后台必断 WebSocket)
    if (opts.dropLiveAtMs !== null && opts.dropLiveAtMs !== undefined &&
        (clock.now() - baseNow) >= opts.dropLiveAtMs && !stats.liveDropped) {
      stats.liveDropped = true;
      const last = stats.sockets[stats.sockets.length - 1];
      if (last && !last.closed && last.readyState === 1) {
        last.closed = true;
        last.readyState = 3;
        if (last.onclose) last.onclose({ code: 1006, reason: '切后台断了' });
      }
    }
  }

  const c = ctx.CinemaLive.getCinemaContext();
  return {
    label: opts.label,
    minutes: opts.minutes,
    frames: stats.frameCount,
    frameMB: +(stats.frameBytes / 1048576).toFixed(1),
    outMB: +(stats.bytesOut / 1048576).toFixed(1),
    inMB: +(stats.bytesIn / 1048576).toFixed(1),
    audioMB: +(stats.audioBytesIn / 1048576).toFixed(1),
    turns: stats.turnCount,
    turnsDone: stats.turnDone,
    sessions: stats.setupCount,
    freshSessions: stats.fresh,
    segCount: c.segCount,
    segments: (c.segments || []).length,
    liveNow: !!(c.liveNow && c.liveNow.text),
    turnLog: stats.turnLog,
    providerCalls: stats.providerCalls,
    // 🔴 token 账: 每个 turn 都要重读会话里累积的全部帧 (258 token/帧, 官方)
    //   → 实况 turn 越多, 后面每个 turn 要重读的上下文就越大。
    inputTokenK: +(stats.turnLog.reduce(function (a2, r) {
      return a2 + r.framesAtSend * 258;
    }, 0) / 1000).toFixed(0),
    chatLines: chatLines,
    ctx: ctx
  };
}

module.exports = { runScenario, makeClock, makeFakeElement };

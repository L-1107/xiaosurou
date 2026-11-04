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
//   failEpisodeCount 前 N 次单集总结【不回话】(模拟 API 抽风)
//   waitAfterEpMs 一集播完之后等多久才开下一集 (决定自动重试来不来得及)
//   localFiles     本地文件路线: 每个文件多少秒 (数组)。给了就走本地文件那条路
//                   (从头到尾不调 setSeries → watchSession.kind 恒为 'film')
async function runScene(cfg) {
  const o = Object.assign({
    epLenSec: 90, eps: 4, turnLatencyMs: 8000, isSeries: true,
    failStageCount: 0, failEpisodeCount: 0, waitAfterEpMs: 15000
  }, cfg || {});
  const clock = makeClock();
  const stat = {
    setupCount: 0,
    turns: [],            // {kind, at, framesInSession, ep, raw}
    saved: [],            // {ep, text, at, key}
    savedKeys: [],        // 每条落库用的 key (用来验作品分桶)
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
        const epMatch = raw.match(/第\s*(\d+)\s*集/);
        const isEpisode = kind === 'episode';
        stat.turns.push({
          kind: kind,
          at: clock.now(),
          framesInSession: this.frames,
          ep: isEpisode && epMatch ? Number(epMatch[1]) : 0,
          raw: raw
        });
        // 🔴 模拟「API 抽风」: 前 N 次单集总结, 服务端【一句话都不回】
        //   (真实世界 = 断网 / 模型抽风 → 那一次总结 90 秒后超时, 拿不到任何内容)
        if (isEpisode) {
          stat.epTurnCount = (stat.epTurnCount || 0) + 1;
          if (stat.epTurnCount <= o.failEpisodeCount) return;
        }
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
    // 🔴 2026-11-04: 假存储必须是【有状态】的 —— 原来 listEpMemories 永远返回 [],
    //   读不回来任何东西, 验不了"换集时有没有把前情提要喂回模型"。
    CinemaStorage: (function () {
      const epRows = {};      // key -> [{ep, text, id}]
      const recapRows = {};   // key -> {key, title, text, recapText}
      return {
        saveEpMemory: async (rec) => {
          const key = rec.sessionKey || '';
          epRows[key] = epRows[key] || [];
          const row = { ep: rec.ep, text: rec.text, id: key + '#' + rec.ep };
          const i = epRows[key].findIndex(r => r.ep === rec.ep);
          if (i >= 0) epRows[key][i] = row; else epRows[key].push(row);
          stat.saved.push({ ep: rec.ep, kind: rec.kind, text: rec.text, at: clock.now(), key: key });
          stat.savedKeys.push(key);
          return row;
        },
        listEpMemories: async (key) => (epRows[key] || []).slice(),
        // 真存储是【合并写】: 只传要改的那个字段, 另一个原样保住
        saveSeriesRecap: async (rec) => {
          const key = rec.key || '';
          const old = recapRows[key] || { key, title: '', text: '', recapText: '' };
          const row = Object.assign({}, old);
          if (rec.title != null) row.title = rec.title;
          if (rec.text != null) row.text = rec.text;
          if (rec.recapText != null) row.recapText = rec.recapText;
          if (rec.lastEp != null) row.lastEp = rec.lastEp;
          if (rec.recapLastEp != null) row.recapLastEp = rec.recapLastEp;
          recapRows[key] = row;
          return row;
        },
        loadSeriesRecap: async (key) => recapRows[key] || null,
        deleteSeriesRecap: async () => {}
      };
    })(),
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
      // 给单集总结 + 换会话留时间。
      // ⚠️ 失败重试那条路要等: 90 秒超时 → 再等 60 秒 → 重试 → 出结果 ≈ 160 秒,
      //   所以 waitAfterEpMs 得给够, 否则集与集之间会先把重试取消掉。
      await pump(o.waitAfterEpMs);
    }
  } else if (o.localFiles && o.localFiles.length) {
    // 本地文件路线: 每个文件 {sec, work} (work = 作品名, 可空)
    //   (从头到尾不调 setSeries → watchSession.kind 恒为 'film')
    for (let f = 0; f < o.localFiles.length; f++) {
      const spec = (o.localFiles[f] && typeof o.localFiles[f] === 'object')
        ? o.localFiles[f]
        : { sec: o.localFiles[f], work: '' };
      // 🔴 2026-11-04: 每一个文件都要先告诉 Live 它属于哪部作品
      //   (真实流程里 setVideoSrc 对第一个文件也会调 setWorkName)
      CL.setWorkName(spec.work || '');
      if (f > 0) {
        // 换下一个本地文件: 换片 → Live 重连 → 视频 play 事件 (resumeFrames)
        video.ended = false; video.paused = false;
        CL.onVideoSourceChanged();
        let p2 = null;
        try { p2 = CL.enable(); } catch (e) { /* */ }
        if (p2 && p2.catch) p2.catch(() => {});
        await pump(1500);
        CL.resumeFrames('模拟 video play 事件');
      }
      video.duration = spec.sec;              // 告诉它这个文件本身有多长
      await pump(spec.sec * 1000);
      video.ended = true;
      CL.onVideoEnded();
      await pump(20000);                     // 等补记那一段跑完
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
  // ---- 2026-11-04: API 抽风 → 自动重试 ----
  check('有「失败后 60 秒自动重试」这个函数', /function scheduleEpisodeSummaryRetry\(/.test(live));
  check('自动重试的间隔是 60 秒', /EPISODE_SUMMARY_RETRY_MS\s*=\s*60\s*\*\s*1000/.test(live));
  check('失败【不】换会话, 是成功才换',
    /if \(ok\) \{\s*resetSessionAfterEpisode\(ep\);\s*\} else \{\s*scheduleEpisodeSummaryRetry\(ep\);/.test(live));
  check('换集时会取消待重试的那一集',
    /onSeriesEpisodeChanged[\s\S]{0,2500}clearTimeout\(S\._epRetryTimer\)/.test(live));
  check('已经换集了就直接放弃重试',
    /function scheduleEpisodeSummaryRetry[\s\S]{0,600}S\._curEp\s*&&\s*S\._curEp\s*!==\s*ep/.test(live));
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
// ⑥ 短剧 · 一集总结时 API 抽风 → 60 秒后自动重试, 把这一集补上 (2026-11-04)
// ---------------------------------------------------------------------------
// 【用户原话】"短剧如果一集结束剧情总结的时候API抽风, 没能总结起, 是不是就瓜起了"
//
// 【修法】失败【不换会话】(这一集的画面还留在会话里) → 60 秒后自动重试一次
//   → 重试时模型看到的还是这一集 → 补得上, 不用重播。
section('⑥ 短剧 · 一集总结失败 → 60 秒后自动重试, 把这一集补上');
{
  // 第 1 集的单集总结: 服务端一句话都不回 (模拟 API 抽风)
  //   → 90 秒超时 → 判定失败 → 【不换会话】→ 60 秒后自动重试 → 成功补记
  const r = await runScene({
    epLenSec: 90, eps: 1, failEpisodeCount: 1, waitAfterEpMs: 220000
  });
  const st = r.stat;

  const epTurns = st.turns.filter(t => t.kind === 'episode');
  check('第 1 集发了两次单集总结 (第一次失败 + 自动重试)', epTurns.length === 2,
    '次数=' + epTurns.length);

  // 重试必须发生在失败【之后】(90s 超时 + 60s 重试延迟 ≈ 150s), 不能立刻重发
  const gap = epTurns.length >= 2 ? epTurns[1].at - epTurns[0].at : 0;
  check('重试发生在失败之后 (不是立刻重发)',
    gap > 100000 && gap < 200000, '间隔=' + Math.round(gap / 1000) + 's');

  // 🔴 最关键的一条: 重试时那一集的画面【还在】会话里。
  //   失败就换会话 → 画面被扔掉 → 重试也救不回来 → 这一集白看。
  const retryFrames = epTurns.length >= 2 ? epTurns[1].framesInSession : 0;
  check('重试时那一集的画面还在会话里 (失败没有换会话)',
    retryFrames >= 80, '重试那一回合之前累计 ' + retryFrames + ' 帧 (一集约 90 帧)');

  // 聊天区两句话: 一句失败提醒, 一句补记成功
  const warnLines = st.chatLines.filter(l => /第 1 集没总结出来/.test(l));
  const okLines = st.chatLines.filter(l => /第 1 集补记上了/.test(l));
  check('聊天区说了「这一集没总结出来」', warnLines.length >= 1, warnLines.length + ' 条');
  check('聊天区说了「补记上了」', okLines.length >= 1, okLines.length + ' 条');

  // 落库的确实是「单集剧情」不是段落摘要
  const ep1 = st.saved.filter(s => s.ep === 1);
  check('第 1 集最后还是落库了 (重试补上)', ep1.length >= 1,
    'ep=1 的行数=' + ep1.length + '  全部落库=' + JSON.stringify(st.saved.map(s => s.ep)));
  check('落库的确实是「单集剧情」不是段落摘要',
    ep1.length >= 1 && /第\s*1\s*集/.test(ep1[ep1.length - 1].text),
    ep1.length ? ep1[ep1.length - 1].text.slice(0, 24) : '(没有)');

  // 重试成功后换会话 → 必须把前情提要喂回新会话,
  //   否则下一集开播时模型手里是空白的 → 下一集的单集剧情少了上一集的上下文
  const recapTurns = st.turns.filter(t => t.kind === 'recap');
  check('重试成功后把前情提要喂回了新会话', recapTurns.length >= 1,
    'recap 次数=' + recapTurns.length + '  turns=' + JSON.stringify(st.turns.map(t => t.kind)));
}

// ---------------------------------------------------------------------------
// ⑦ 短剧 · 重试窗口里换集 → 放弃重试, 并说清楚 (2026-11-04)
// ---------------------------------------------------------------------------
section('⑦ 短剧 · 重试窗口里换集 → 放弃那次重试');
{
  // 第 1 集失败 → 60 秒后本来要重试; 用户在重试【之前】就点了第 2 集
  //   → 重试必须被放弃 (画面混了, 重试出来的总结会串味), 而且要告知用户
  const r = await runScene({
    epLenSec: 90, eps: 2, failEpisodeCount: 1, waitAfterEpMs: 120000
  });
  const st = r.stat;

  const cancelLines = st.chatLines.filter(l => /第 1 集.*(取消|放弃)/.test(l));
  check('聊天区说了「自动重试取消了」', cancelLines.length >= 1,
    cancelLines.length + ' 条: ' + JSON.stringify(cancelLines.map(s => s.slice(0, 30))));

  // 换集之后【不能再】冒出第 1 集的重试 turn
  const ep1Turns = st.turns.filter(t => t.kind === 'episode' && t.ep === 1);
  check('换集后没有再发第 1 集的重试', ep1Turns.length <= 1, '第 1 集的 turn 数=' + ep1Turns.length);

  // 🔴 换集时必须【清掉上一集的画面】—— 不清, 第 2 集的单集剧情就跟第 1 集串味
  //   (模型在一个会话里同时看到两集的画面, 分不清哪段是哪集)。
  //   清了 → 第 2 集那一回合只看得到自己那 90 帧; 没清 → 180 帧 (两集混一起)。
  const ep2Turns = st.turns.filter(t => t.kind === 'episode' && t.ep === 2);
  check('换集时清掉了上一集的画面 (下一集不会跟上一集串味)',
    ep2Turns.length >= 1 && ep2Turns[0].framesInSession <= 95,
    '第 2 集那一回合之前累计 ' + (ep2Turns.length ? ep2Turns[0].framesInSession : -1) +
    ' 帧 (一集约 90 帧, 混了就是 180)');

  // 第 1 集没补上 (放弃了), 第 2 集正常总结
  const eps = st.saved.map(s => s.ep).sort((a, b) => a - b);
  check('第 1 集没落库 (重试被放弃了)', eps.indexOf(1) === -1, '落库集号=' + JSON.stringify(eps));
  check('第 2 集照常落库', eps.indexOf(2) !== -1, '落库集号=' + JSON.stringify(eps));
}

// ---------------------------------------------------------------------------
// ⑧ 短剧 · 换集早于「失败被察觉」→ 也不要再重试 (2026-11-04)
// ---------------------------------------------------------------------------
// 场景: 模型 90 秒都没回话, 用户等不及先点了下一集 → 等到超时才发现失败,
//   但那时候人已经在看下一集了 → 画面已经混在一起 → 重试必须直接放弃。
section('⑧ 短剧 · 换集早于失败被察觉 → 直接放弃重试');
{
  const r = await runScene({
    epLenSec: 90, eps: 2, failEpisodeCount: 1, waitAfterEpMs: 30000
  });
  const st = r.stat;

  const cancelLines = st.chatLines.filter(l => /第 1 集.*(取消|放弃)/.test(l));
  check('聊天区说了「自动重试取消了」', cancelLines.length >= 1,
    cancelLines.length + ' 条: ' + JSON.stringify(cancelLines.map(s => s.slice(0, 30))));

  const ep1Turns = st.turns.filter(t => t.kind === 'episode' && t.ep === 1);
  check('第 1 集只发过一次 (没有重试)', ep1Turns.length === 1, '第 1 集的 turn 数=' + ep1Turns.length);

  const eps = st.saved.map(s => s.ep).sort((a, b) => a - b);
  check('第 1 集没落库', eps.indexOf(1) === -1, '落库集号=' + JSON.stringify(eps));
  check('第 2 集照常落库', eps.indexOf(2) !== -1, '落库集号=' + JSON.stringify(eps));
}

// ---------------------------------------------------------------------------
// ⑨ 本地上传的短剧文件 (一集一个文件, 不到 2 分钟) —— 2026-11-04
// ---------------------------------------------------------------------------
// 【用户问的】"如果本地上传路径传的是不到两分钟一集的短剧, 那播放结束的时候会总结剧情吗"
// 【旧写法的问题】(实测 _reports/cinema-test/probe-local-file-summary.cjs)
//   · 40 秒的文件 → 落【0 段】—— "低于 60 秒门槛"把这一整集丢掉了, 一集白看
//   · 3 个 90 秒的文件连着放 → 落【4 段】, 边界全跨集:
//       段1 = 文件1 全部(91 帧)  段2 = 文件2 的前 30 秒(27 帧)
//       段3 = 文件2 的后 51 秒  段4 = 文件3 的前 55 秒, 文件3 最后 35 秒直接丢了
//   根因: 2 分钟窗口的起点 lastSummaryStartedAt 只有 tickStageSummary 的收尾会更新,
//   而"影片播完补记最后一段"走的是 runStageSummary 直调, 绕过了那个收尾。
section('⑨ 本地上传的短剧文件 → 每集各成一段, 不跨集、不丢尾巴');
{
  {
    const r = await runScene({ isSeries: false, localFiles: [90] });
    const segs = r.stat.saved;
    check('90 秒的本地文件播完 → 落了一段剧情', segs.length === 1, '落库段数=' + segs.length);
    check('这一段是「段落」不是「集」',
      segs.length === 1 && !/第\s*\d+\s*集/.test(segs[0].text));
    const f = r.stat.turns.filter(t => t.kind === 'stage').map(t => t.framesInSession);
    check('这一段看到的是整集的画面 (90 帧左右)', f.length === 1 && f[0] >= 85,
      '帧数=' + JSON.stringify(f));
  }
  {
    // 🔴 40 秒那种短集: 旧写法低于 60 秒门槛 → 整集丢掉
    const r = await runScene({ isSeries: false, localFiles: [40] });
    check('40 秒的本地文件播完 → 也要总结 (不能整集丢掉)', r.stat.saved.length === 1,
      '落库段数=' + r.stat.saved.length);
    const f = r.stat.turns.filter(t => t.kind === 'stage').map(t => t.framesInSession);
    check('这一段看到的是整集的画面 (40 帧左右)', f.length === 1 && f[0] >= 35,
      '帧数=' + JSON.stringify(f));
  }
  {
    // 3 个 90 秒的文件连着放 → 3 段, 各覆盖自己那一集
    const r = await runScene({ isSeries: false, localFiles: [90, 90, 90] });
    const eps = r.stat.saved.map(s => s.ep);
    check('3 个本地文件 → 3 段, 编号 1/2/3', JSON.stringify(eps) === '[1,2,3]',
      '段号=' + JSON.stringify(eps));
    // 每段只看得到自己那一集 (~90 帧); 跨集的话会变成 27/51/55 这种
    // ⚠️ 门槛取 70 而不是 90: 换本地文件时新连接要等十几秒才建好, 这十几秒的
    //    画面会落进一个马上被丢弃的会话 —— 那是【既有的】连接时序问题
    //    (核对过 HEAD 也一样), 不是本组要管的事。判据只抓"跨集"这个特征。
    const f = r.stat.turns.filter(t => t.kind === 'stage').map(t => t.framesInSession);
    check('每段只看得到自己那一集的画面 (没跨集)',
      f.length === 3 && f.every(n => n >= 70), '各段帧数=' + JSON.stringify(f));
  }
  {
    // 长文件 (≥ 2 分钟) → 老规矩照旧: 2 分钟一段 + 播完补一段
    const r = await runScene({ isSeries: false, localFiles: [200] });
    check('200 秒的本地文件 → 2 段 (2 分钟一段 + 播完补一段)', r.stat.saved.length === 2,
      '落库段数=' + r.stat.saved.length);
  }
}

// ---------------------------------------------------------------------------
// ⑩ 作品名 (2026-11-04) —— 同作品共用一份底稿, 不同作品各存各的
// ---------------------------------------------------------------------------
// 【用户问的】"我怎么区分这个新文件是不是跟上一个文件属于同一个动漫"
// 【原来】底稿 key 只有 'film:'+chatId → 同一个聊天里【所有】本地影片共用一份
//   → 换到完全不相干的另一部作品, 也会把上一部的剧情灌给模型 (串台)。
// 【现在】key = 'film:'+chatId+':'+作品名 → 同一作品名 = 同一份, 不同 = 各存各的。
//
// 顺带修的一个真 bug: 「上次看到哪」(滚动锚) 和「手动精炼的前情提要」
//   【从来没被喂给过模型】—— 注入跑在异步读库之前, 读到的还是 null,
//   而且 injectSeriesRecap() 一进来就把 pending 落闸 → 库读完后再注入已是空转。
section('⑩ 作品名: 同作品共用一份底稿, 不同作品各存各的');
{
  {
    // 同一个作品的两个文件
    const r = await runScene({
      isSeries: false,
      localFiles: [{ sec: 200, work: '某动漫' }, { sec: 200, work: '某动漫' }]
    });
    const st = r.stat;
    const keys = Array.from(new Set(st.savedKeys));
    check('同一作品 → 只落在一个 key 下', keys.length === 1, 'keys=' + JSON.stringify(keys));
    check('同一作品 → key 带上了作品名', keys.length === 1 && /某动漫$/.test(keys[0]),
      'key=' + (keys[0] || ''));
    // 段号继续数 (第二集接着第一集的号)
    const eps = st.saved.map(s => s.ep);
    check('同一作品 → 段号接着数 (1,2,3,4)', JSON.stringify(eps) === '[1,2,3,4]',
      '段号=' + JSON.stringify(eps));
    // 🔴 换集那一刻, 模型拿到了上一个文件的段落 + 锚
    const recaps = st.turns.filter(t => t.kind === 'recap');
    const withOld = recaps.filter(t => /第 2 段/.test(t.raw || ''));
    check('换到第二个文件时, 模型拿到了第一个文件的段落', withOld.length >= 1,
      '带「第 2 段」的注入次数=' + withOld.length);
    // 🔴 锚 (上次看到哪) 真的被喂进去了 —— 修之前一次都没有
    const withAnchor = recaps.filter(t => /剧情进度（上次看到哪）/.test(t.raw || ''));
    check('注入里带着「上次看到哪」(库里的锚)', withAnchor.length === recaps.length && recaps.length > 0,
      '带锚的注入 ' + withAnchor.length + ' / 共 ' + recaps.length);
  }
  {
    // 两个不同的作品
    const r = await runScene({
      isSeries: false,
      localFiles: [{ sec: 200, work: '某动漫' }, { sec: 200, work: '别的片' }]
    });
    const st = r.stat;
    const keys = Array.from(new Set(st.savedKeys));
    check('不同作品 → 落在两个不同的 key 下', keys.length === 2, 'keys=' + JSON.stringify(keys));
    // 段号各数各的 (第二部的段号从 1 重新开始)
    const eps = st.saved.map(s => s.ep);
    check('不同作品 → 段号各自从 1 开始 (1,2,1,2)', JSON.stringify(eps) === '[1,2,1,2]',
      '段号=' + JSON.stringify(eps));
    // 🔴 换到另一个作品时, 上一部的段落不能被灌过去
    //   判据用【重复段号】: 上一部的「第 1 段」和这一部的「第 1 段」会同时出现
    //   (段号每个作品从 1 重新数, 所以串台的特征就是同一个号出现两次)
    const recaps = st.turns.filter(t => t.kind === 'recap');
    const dup = recaps.filter(t => {
      const labels = String(t.raw || '').match(/第 \d+ 段：/g) || [];
      return new Set(labels).size !== labels.length;
    });
    check('换到另一个作品时, 没有把上一部的段落灌过去 (没有重复段号)', dup.length === 0,
      '段号重复的注入次数=' + dup.length);
  }
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

// ============================================================
// tests/live-reconnect.test.cjs
// Gemini Live 的「重连」必须真的能用 (2026-10-29 用户实测)
//
// 【用户原话】
//   「刚才去影院看本地长剧测试，结果看到三分钟左右，总结了一次剧情提要，
//     然后 live 断了怎么都重连不上，于是我退出了影院，再次进去接着看
//     这下看再久都不总结剧情了，还是没搞好」
//
// 【真因（探针 _reports/pet-test/probe-live-reconnect.cjs 实锤）】
//   live-client.js 的 reconnect():
//       this.setupDone = false; this.state = 'idle'; return this.connect();
//   —— 它【没有关掉旧的 ws】, 而 connect() 里 self.ws = ws 直接覆盖了引用。
//   于是旧 ws 变成孤儿, 但它的回调还绑在同一个 self 上:
//     · 旧 ws 被服务端一关 → self.setupDone = false → 【新连接被判死】
//     · isReady() 永远为假 → 上层 waitUntilReady 超时 → 判定重连失败
//       → 再排一次重连 → 又留一个孤儿 → 死循环
//       = 用户看到的「live 断了怎么都重连不上」
//     · 而且 isReady() 永远为假 → tickStageSummary 每次早退
//       → 【剧情摘要永远不写】 = 用户看到的「再久都不总结」
//
//   为什么以前没炸: reconnect() 以前只在「服务端先断开」之后才被调用,
//   那时旧 ws 早就 closed 了。2026-10-29 新加的「摘要后换干净会话」
//   (resetSession) 是【第一次在连接还活着的时候主动重连】→ 踩中这个雷。
//
// 【本测试守什么】
//   ① 旧 socket 必须被主动关掉
//   ② 旧 socket 之后关闭, 不能把新连接判死
//   ③ resetSession() 的 promise 必须有人接 (否则失败时没人安排重连)
//   ④ live 长时间不 ready 时, 影院要明说原因 (不能静默不总结)
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
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
function section(t) { console.log('\n== ' + t + ' =='); }

// ------------------------------------------------------------
// 假 WebSocket (跟真浏览器一样是异步 open 的)
// ------------------------------------------------------------
const SOCKETS = [];
function FakeWebSocket(url) {
  this.url = url;
  this.readyState = 0;      // CONNECTING
  this.sent = [];
  this.closed = false;
  SOCKETS.push(this);
}
FakeWebSocket.prototype.open = function () {
  this.readyState = 1;
  if (this.onopen) this.onopen();
};
FakeWebSocket.prototype.close = function (code, reason) {
  if (this.closed) return;
  this.closed = true;
  this.readyState = 3;
  if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
};
FakeWebSocket.prototype.send = function (d) { this.sent.push(d); };
FakeWebSocket.prototype.serverClose = function (code, reason) {
  this.closed = true;
  this.readyState = 3;
  if (this.onclose) this.onclose({ code: code || 1006, reason: reason || 'server closed' });
};
FakeWebSocket.prototype.deliver = function (obj) {
  if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
};
function AutoOpenWS(url) {
  const s = new FakeWebSocket(url);
  setTimeout(function () { if (s.readyState === 0) s.open(); }, 0);
  return s;
}
AutoOpenWS.prototype = FakeWebSocket.prototype;

function loadLiveClient() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    WebSocket: AutoOpenWS,
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, String, Number, Boolean, Array, Object, Error,
    encodeURIComponent
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('modules/live-client.js'), sandbox, { filename: 'live-client.js' });
  return sandbox.window.LiveClient;
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
  const unhandled = [];
  process.on('unhandledRejection', function (err) {
    unhandled.push(String((err && err.message) || err));
  });

  section('① 源码级：reconnect() 必须处理掉旧 socket');
  const src = read('modules/live-client.js');
  // ⚠️ 只截到【下一个 prototype 方法】为止 —— 之前截 2200 字符会把后面
  //   LiveClient.prototype.close() 里的 this.ws.close(...) 也扫进来,
  //   于是「有没有关旧 socket」这条断言永远是绿的（抓不住 bug）。
  function extractTopMethod(s, marker) {
    const i = s.indexOf(marker);
    if (i < 0) return '';
    const rest = s.slice(i + 1);
    const m = rest.match(/\n  LiveClient\.prototype\./);
    if (!m) return s.slice(i);
    return s.slice(i, i + 1 + m.index);
  }
  const reconnectBody = extractTopMethod(src, 'LiveClient.prototype.reconnect');
  check('找得到 reconnect()', reconnectBody !== '');
  if (reconnectBody) {
    check('reconnect() 里把旧 socket 的回调摘掉了 (onclose 之类置 null)',
      /onclose\s*=\s*null/.test(reconnectBody));
    check('reconnect() 里把旧 socket 关掉了',
      /\.close\(/.test(reconnectBody));
    check('reconnect() 里把 this.ws 先置空 (不让旧 socket 继续冒充当前连接)',
      /this\.ws\s*=\s*null/.test(reconnectBody));
  }

  section('② 源码级：cinema-live 必须接住 resetSession() 的 promise');
  const live = read('modules/cinema-live.js');
  check('resetSession() 的结果被接住了 (有 then/catch)',
    /resetSession\(\)[\s\S]{0,400}?\.catch\(/.test(live));
  check('换会话失败时会安排重连 (不会悄悄消失)',
    /换干净会话失败[\s\S]{0,200}?scheduleReconnect/.test(live));

  section('③ 源码级：live 没 ready 时要明说原因');
  check('tickStageSummary 里 live 没 ready 时会提示用户',
    /Gemini Live 还没连上/.test(live));

  section('④ 行为级：换干净会话之后，旧 socket 不能判死新连接');
  const LiveClient = loadLiveClient();
  check('live-client 加载成功', typeof LiveClient === 'function');
  if (typeof LiveClient !== 'function') {
    console.log('\n========================================');
    console.log('  通过 ' + passed + ' / 失败 ' + failed);
    console.log('__FAILURES__' + failedNames.join('\u0001'));
    console.log('========================================');
    if (failed > 0) process.exit(1);
    return;
  }

  const client = new LiveClient({ apiKey: 'AIza-fake', systemPrompt: 'x' });
  await client.connect();
  await wait(10);
  const ws1 = SOCKETS[0];
  check('第一条 socket 建出来了', !!ws1);
  if (ws1) {
    check('socket 已经 open', ws1.readyState === 1);
    ws1.deliver({ setupComplete: {} });
    check('收到 setupComplete 后 isReady() 为真', client.isReady() === true, 'state=' + client.state);
  }

  const p2 = client.resetSession();
  await wait(10);
  const ws2 = SOCKETS[1];
  check('换会话建出了第二条 socket', !!ws2);
  if (ws2) {
    ws2.deliver({ setupComplete: {} });
    check('新连接 isReady() 为真', client.isReady() === true, 'state=' + client.state);
  }

  check('★ 旧 socket 已经被主动关掉了 (不关它, 它关闭时会把新连接判死)',
    ws1 && ws1.closed === true,
    ws1 ? ('closed=' + ws1.closed) : '没有旧 socket');

  if (ws1) ws1.serverClose(1000, '服务端回收了旧会话');
  check('★ 旧 socket 关闭之后, 新连接仍然是 ready 的',
    client.isReady() === true,
    'isReady()=' + client.isReady() + ' state=' + client.state + ' setupDone=' + client.setupDone);

  await wait(30);
  check('全程没有未处理的 promise rejection (resetSession 失败时没人接会漏成 unhandled)',
    unhandled.length === 0, unhandled.join(' | '));
  if (p2 && typeof p2.then === 'function') {
    p2.then(function () {}, function () {});
  }

  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('__FAILURES__' + failedNames.join('\u0001'));
  console.log('========================================');
  if (failed > 0) process.exit(1);
})().catch(function (e) {
  console.error('测试崩了:', e);
  process.exit(1);
});

// ============================================================
// tests/companion-api-preset.test.cjs
// 「在影院/读书屋里就地换 API 预设, 不退出房间」的回归测试 (2026-11-26)
//
// 跑法: node tests/companion-api-preset.test.cjs
//
// 【用户原话】
//   「悬浮球弄进影院就是为了方便切换API预设的, 不然都弹出去了我还弄它进来干啥呢」
//   → 上一版把「切换API预设」跟其它 9 项一起归进了"宿主那边做"那一类,
//     宿主先 closeSandbox() 再执行 → 影院当场关掉, 人被弹回主页面去选。
//     这跟"把悬浮球带进影院"的目的正好相反。
//
// 【本测试守什么】
//   ① ★ 沙盒点「切换API预设」【不许】走 ballAction 那条路
//      (走那条 = 宿主会 closeSandbox = 退出影院)
//   ② 沙盒向宿主要预设列表 (沙盒够不着 db.apiPresets)
//   ③ 宿主回列表 → 沙盒自己画出二级菜单
//   ④ 用户选一个 → 沙盒发指令给宿主去切
//   ⑤ 宿主回切换结果 → 沙盒冒提示
//   ⑥ ★ 全程不发任何"关掉房间"的消息
//   ⑦ 宿主侧: 切完预设要把新配置【重推】回沙盒 (沙盒那份只是启动时的快照,
//      不推的话影院里的陪聊还在用旧预设, 等于白切)
//   ⑧ floating-ball.js 导出 listApiPresets / switchApiPreset, 且支持 silent
//   ⑨ 版本号对齐 + 样式齐了
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

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
// 假 DOM (够用就行, 只为把 companion-layer.js 真跑起来)
// ============================================================
function matches(el, sel) {
  if (!el) return false;
  sel = String(sel);
  if (sel.charAt(0) === '#') return el.id === sel.slice(1);
  if (sel.charAt(0) === '.') return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toLowerCase();
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c) { if (this.set.has(c)) this.set.delete(c); else this.set.add(c); }
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.id = '';
    this.hidden = false;
    this.classList = new FakeClassList();
    this.listeners = {};
    this._text = '';
    this._html = '';
    this.offsetWidth = 200;
    this.offsetHeight = 200;
  }
  set className(v) {
    this.classList.set = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  get className() { return Array.from(this.classList.set).join(' '); }
  set innerHTML(v) { this.children = []; this._html = String(v == null ? '' : v); }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  // ⚠️ 真 DOM 的 textContent 取的是【所有子节点文字的拼接】
  //   (不然 "这条预设叫什么名字" 就查不出来了)
  get textContent() {
    if (this.children.length) {
      return this.children.map(function (c) { return c.textContent; }).join('');
    }
    return this._text;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id) registry[child.id] = child;
    return child;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type, ev) {
    (this.listeners[type] || []).forEach(function (fn) { fn(ev); });
  }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  getBoundingClientRect() {
    return { left: 10, top: 100, right: 60, bottom: 150, width: 50, height: 50 };
  }
}

const registry = {};
const docListeners = {};
const document = {
  readyState: 'complete',
  createElement: (tag) => new FakeEl(tag),
  getElementById: (id) => registry[id] || null,
  addEventListener: (type, fn) => {
    (docListeners[type] = docListeners[type] || []).push(fn);
  },
  body: new FakeEl('body'),
  head: new FakeEl('head')
};

/** 把 companion-layer.js 装进一个假窗口里跑起来 */
function bootSandbox(ns) {
  // ⚠️ 每个 boot 都要清干净: 模块里 buildBallDom/buildPetDom 是按 id 查重的
  //   (el('cx-ball') 存在就早退), 不清的话第二个实例根本不会建 DOM、也不会绑事件。
  for (const k of Object.keys(registry)) delete registry[k];
  for (const k of Object.keys(docListeners)) delete docListeners[k];

  const winListeners = {};
  const sent = [];
  const store = {};
  const win = {
    innerWidth: 390,
    innerHeight: 844,
    document: document,
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Image: function () { this.onload = null; this.onerror = null; this.src = ''; }
  };
  win.parent = {
    postMessage: function (msg) { sent.push(msg); }
  };

  const src = read('modules/companion-layer.js');
  const sandbox = {
    window: win,
    document: document,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    localStorage: win.localStorage,
    Image: win.Image
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'companion-layer.js' });

  const layer = sandbox.window.CompanionLayer;
  layer.init({ ns: ns });

  /** 模拟宿主发来一条消息 */
  function hostMessage(data) {
    (winListeners.message || []).forEach(function (fn) {
      fn({ source: win.parent, data: data });
    });
  }
  /** 模拟用户点了沙盒菜单里某一项 */
  function clickMenuItem(action) {
    const item = new FakeEl('div');
    item.className = 'cx-ball-item';
    item.setAttribute('data-action', action);
    const menu = registry['cx-ball-menu'];
    menu.dispatch('click', { target: item, stopPropagation: function () {} });
    return item;
  }

  return { layer: layer, sent: sent, hostMessage: hostMessage, clickMenuItem: clickMenuItem };
}

// ============================================================
// ① ★ 沙盒点「切换API预设」不许走 ballAction (走那条 = 退出影院)
// ============================================================
section('① ★ 沙盒点「切换API预设」不退出房间');
{
  const app = bootSandbox('cinema');
  app.clickMenuItem('switch-api');

  const types = app.sent.map(function (m) { return m.type; });
  check('没有发出 cinema:ballAction (那一条会让宿主 closeSandbox)',
    types.indexOf('cinema:ballAction') < 0, '发出的是: ' + JSON.stringify(types));
  check('没有发出任何关房间的消息',
    types.indexOf('cinema:closed') < 0 && types.indexOf('reading:closed') < 0);
  check('向宿主要了预设列表',
    types.indexOf('cinema:needApiPresets') >= 0, '发出的是: ' + JSON.stringify(types));

  // 读书屋同理
  const app2 = bootSandbox('reading');
  app2.clickMenuItem('switch-api');
  const types2 = app2.sent.map(function (m) { return m.type; });
  check('读书屋那边也是 reading:needApiPresets',
    types2.indexOf('reading:needApiPresets') >= 0, JSON.stringify(types2));
  check('读书屋那边也没发 reading:ballAction',
    types2.indexOf('reading:ballAction') < 0);
}

// ============================================================
// ② 宿主回列表 → 沙盒自己画二级菜单
// ============================================================
section('② 宿主回列表 → 沙盒画二级菜单');
{
  const app = bootSandbox('cinema');
  app.clickMenuItem('switch-api');
  app.hostMessage({
    type: 'cinema:apiPresets',
    ok: true,
    currentId: 1,
    presets: [{ id: 1, name: '线路A' }, { id: 2, name: '线路B' }]
  });

  const sub = registry['cx-ball-submenu'];
  check('二级菜单建出来了', !!sub);
  check('二级菜单显示出来了 (show)', !!sub && sub.classList.contains('show'));
  check('菜单里有 1 个标题 + 2 个预设', !!sub && sub.children.length === 3,
    'children=' + (sub ? sub.children.length : 'n/a'));

  const names = sub ? sub.children.map(function (c) { return c.textContent; }) : [];
  check('两个预设的名字都在', names.indexOf('线路A') >= 0 && names.indexOf('线路B') >= 0,
    JSON.stringify(names));

  const active = sub ? sub.children.filter(function (c) {
    return c.classList.contains('active');
  }) : [];
  check('当前预设被标成 active (只有 1 个)', active.length === 1,
    'active=' + active.length);
  check('标 active 的是当前那个 (线路A)',
    active.length === 1 && active[0].textContent.indexOf('线路A') >= 0);

  // 预设名用 textContent 写, 不能拼进 innerHTML (名字是用户自己起的)
  const layerSrc = stripComments(read('modules/companion-layer.js'));
  check('预设名用 textContent (不拼 innerHTML, 防注入)',
    /name\.textContent\s*=/.test(layerSrc) && !/name\.innerHTML\s*=/.test(layerSrc));
}

// ============================================================
// ③ 用户选一个 → 沙盒发指令给宿主去切
// ============================================================
section('③ 选一个预设 → 交回宿主执行');
{
  const app = bootSandbox('cinema');
  app.clickMenuItem('switch-api');
  app.hostMessage({
    type: 'cinema:apiPresets',
    ok: true,
    currentId: 1,
    presets: [{ id: 1, name: '线路A' }, { id: 2, name: '线路B' }]
  });

  const sub = registry['cx-ball-submenu'];
  const target = sub && sub.children[2];   // 线路B
  check('二级菜单里有可选的预设 (线路B)', !!target);
  if (target) sub.dispatch('click', { target: target, stopPropagation: function () {} });

  const sw = app.sent.filter(function (m) { return m.type === 'cinema:switchApiPreset'; });
  check('发出了 cinema:switchApiPreset', sw.length === 1, 'count=' + sw.length);
  check('带的是被选中的那个 id', sw.length === 1 && String(sw[0].id) === '2',
    sw.length ? 'id=' + sw[0].id : 'n/a');

  const types = app.sent.map(function (m) { return m.type; });
  check('选的过程中依然没有 ballAction / closed',
    types.indexOf('cinema:ballAction') < 0 && types.indexOf('cinema:closed') < 0,
    JSON.stringify(types));

  // 宿主回结果 → 沙盒冒提示
  app.hostMessage({ type: 'cinema:apiPresetSwitched', ok: true, name: '线路B' });
  const toastEl = registry['cx-toast'];
  check('沙盒里冒了提示', !!toastEl && toastEl.textContent.indexOf('线路B') >= 0,
    toastEl ? toastEl.textContent : 'no toast');
}

// ============================================================
// ④ 宿主侧: 收指令 + 切完重推配置
// ============================================================
section('④ 宿主侧: 收指令, 切完把新配置推回沙盒');
{
  const cinema = read('modules/cinema-room.js');
  const reading = read('modules/reading-room.js');

  check('影院收 cinema:needApiPresets', /cinema:needApiPresets/.test(cinema));
  check('影院收 cinema:switchApiPreset', /cinema:switchApiPreset/.test(cinema));
  check('影院回 cinema:apiPresets', /type:\s*'cinema:apiPresets'/.test(cinema));
  check('影院回 cinema:apiPresetSwitched', /type:\s*'cinema:apiPresetSwitched'/.test(cinema));

  check('读书屋收 reading:needApiPresets', /reading:needApiPresets/.test(reading));
  check('读书屋收 reading:switchApiPreset', /reading:switchApiPreset/.test(reading));
  check('读书屋回 reading:apiPresets', /type:\s*'reading:apiPresets'/.test(reading));
  check('读书屋回 reading:apiPresetSwitched', /type:\s*'reading:apiPresetSwitched'/.test(reading));

  // ★ 切完必须重推: 沙盒那份 apiConfig 只是启动时的快照
  check('影院切完会作废自己的 api 缓存',
    /_mainApiCfg\s*=\s*null/.test(cinema) && /_mainApiCfgPromise\s*=\s*null/.test(cinema));
  check('影院切完会把新配置推回沙盒', /pushMainApiConfig\(\)/.test(cinema));
  check('读书屋切完会把新配置推回沙盒', /pushApiConfig\(\)/.test(reading));

  // 沙盒侧不许自己碰预设库 (它没有那张表)
  // ⚠️ 只查"真的去查库"的写法 —— 消息名 ':apiPresets' 里也有这三个字, 别误伤
  const layerSrc = stripComments(read('modules/companion-layer.js'));
  check('沙盒层里没有 db.apiPresets / Dexie / indexedDB',
    !/db\.apiPresets/.test(layerSrc) &&
    !/new\s+Dexie/.test(layerSrc) &&
    !/indexedDB/.test(layerSrc));
}

// ============================================================
// ⑤ floating-ball.js 导出 + silent
// ============================================================
section('⑤ floating-ball.js 的对外接口');
{
  const fb = read('modules/floating-ball.js');
  check('导出了 listApiPresets', /listApiPresets:\s*listApiPresets/.test(fb));
  check('导出了 switchApiPreset', /switchApiPreset:\s*switchApiPreset/.test(fb));
  check('switchApiPreset 支持 silent (宿主那条 toast 沙盒里看不见)',
    /async function switchApiPreset\(presetId,\s*opts\)/.test(fb) &&
    /const silent = !!\(opts && opts\.silent\)/.test(fb));
  check('切换成功会返回 { ok, name }',
    /return \{ ok: true, id: preset\.id, name: preset\.name \|\| '' \}/.test(fb));
  check('切换失败会返回 { ok:false }',
    /return \{ ok: false, error: 'preset_not_found'/.test(fb) &&
    /return \{\s*ok: false,\s*error:/.test(fb));
  check('listApiPresets 从 db.apiPresets 读',
    /async function listApiPresets\(\)/.test(fb) && /db\.apiPresets\.toArray\(\)/.test(fb));
  check('listApiPresets 会报当前用的哪个预设',
    /currentId:\s*currentPresetId/.test(fb));
}

// ============================================================
// ⑥ 版本号 + 样式
// ============================================================
section('⑥ 版本号 + 样式');
{
  const cinema = read('cinema-sandbox/index.html');
  const reading = read('reading-sandbox/index.html');
  const css = read('css/companion-layer.css');

  const cv = (cinema.match(/companion-layer\.js\?v=([\d.]+)/) || [])[1];
  const rv = (reading.match(/companion-layer\.js\?v=([\d.]+)/) || [])[1];
  check('两个沙盒的 companion-layer ?v= 一致', !!cv && cv === rv, 'cinema=' + cv + ' reading=' + rv);
  check('companion-layer 已经 bump 到 0.2.0', cv === '0.2.0', 'v=' + cv);

  const cc = (cinema.match(/companion-layer\.css\?v=([\d.]+)/) || [])[1];
  const rc = (reading.match(/companion-layer\.css\?v=([\d.]+)/) || [])[1];
  check('两个沙盒的 css ?v= 一致', !!cc && cc === rc, 'cinema=' + cc + ' reading=' + rc);

  check('css 里有 .cx-ball-submenu 样式', /\.cx-ball-submenu\s*\{/.test(css));
  check('css 里有 .cx-ball-submenu-item', /\.cx-ball-submenu-item\s*\{/.test(css));
  check('二级菜单 z-index 跟主菜单一样高',
    /\.cx-ball-submenu\s*\{[\s\S]{0,400}z-index:\s*2147483060/.test(css));
}

// ============================================================
// 结果
// ============================================================
console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed) {
  console.log('❌ 有 ' + failed + ' 条没过');
  process.exit(1);
} else {
  console.log('✅ 全过');
}

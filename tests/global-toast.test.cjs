// ============================================================
// tests/global-toast.test.cjs
// 全局通知 toast 的回归测试（modules/ui-modals.js 的 showToast + css/features-3.css）
//
// 跑法: node tests/global-toast.test.cjs
//
// 【2026-10-26 用户改版】
//   用户原话：「这个全局弹窗本来就很简陋我早就看不惯了，
//              直接改这个全局弹窗，免得你单独去分离宠物屋的。
//              直接全部改到弹在屏幕中央，样式也换成宠物屋的也不难看，时间搞个 5 秒」
//   → 全局 toast 整个换掉：屏幕【居中】+ 宠物屋暖色皮肤 + 停 5 秒。
//
// 【老样子是什么】（这几条就是这次要改掉的）
//   · 位置：固定在屏幕【顶部】top:12px
//   · 样式：白色胶囊 + 磨砂玻璃 + 苹果蓝图标
//   · 时长：3 秒
//   · ⚠️ 超过 25 个字就截成「…」—— 宠物自己说的话经常被砍掉半句
//
// 【为什么用 vm 而不是 jsdom】
//   项目里没有 jsdom 依赖。ui-modals.js 是个 IIFE，
//   把模块塞进一个假 document 的沙箱里，直接调 window.showToast 验行为。
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
// 假 DOM（够 showToast 用就行）
// ============================================================
function mkEl(tag) {
  const classes = [];
  const el = {
    tagName: String(tag || '').toUpperCase(),
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    parent: null,
    // className 和 classList 得联动（真 DOM 里 classList.add 会改 className）
    get className() { return classes.join(' '); },
    set className(v) {
      classes.length = 0;
      for (const c of String(v == null ? '' : v).split(/\s+/)) if (c) classes.push(c);
    },
    appendChild(n) { this.children.push(n); n.parent = this; return n; },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
      }
      this.parent = null;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const want = String(sel || '').replace(/^\./, '');
      const out = [];
      const walk = (n) => {
        for (const c of (n.children || [])) {
          if (want && String(c.className || '').indexOf(want) >= 0) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    getAttribute() { return null; },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {}
  };
  el.classList = {
    add(c) { if (classes.indexOf(c) < 0) classes.push(c); },
    remove(c) { const i = classes.indexOf(c); if (i >= 0) classes.splice(i, 1); },
    contains(c) { return classes.indexOf(c) >= 0; },
    toggle(c, on) { if (on === false) this.remove(c); else this.add(c); }
  };
  return el;
}

/**
 * 起一个能跑 ui-modals.js 的沙箱
 * cfg.dark: 手机屏是不是暗黑模式
 * 返回 { sandbox, body, timers, items }
 *   timers = showToast 排的定时器（用来验停留时长）
 *   items  = 弹出来的 toast 条目
 */
function makeSandbox(cfg) {
  cfg = cfg || {};
  const body = mkEl('body');
  const timers = [];
  const phoneEl = mkEl('phone-screen');
  if (cfg.dark) phoneEl.classList.add('dark-mode');

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },   // 立刻执行，方便断言
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      readyState: 'complete',
      getElementById: (id) => {
        if (id === 'phone-screen') return cfg.dark ? phoneEl : null;
        return mkEl(id);          // 自定义弹窗那些元素，showToast 用不上
      },
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      createElement: (tag) => mkEl(tag),
      body: body
    },
    navigator: { clipboard: { writeText: async () => {} } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('modules/ui-modals.js'), sandbox, { filename: 'ui-modals.js' });
  if (!sandbox.window.showToast) throw new Error('ui-modals.js 没暴露 window.showToast');
  return { sandbox, body, timers, phoneEl };
}

/** 沙箱里现在弹着的 toast 条目 */
function itemsOf(S) {
  return S.body.querySelectorAll('.toast-item');
}
function containerOf(S) {
  return S.body.querySelector('.toast-container');
}
/** 条目的正文（正文在子节点 .toast-text 里） */
function textOf(item) {
  if (!item) return '';
  const t = item.querySelector('.toast-text');
  return t ? t.textContent : '';
}

// ============================================================
// ① 行为
// ============================================================
section('全局 toast 的行为');
{
  // --- 弹出来是什么样 ---
  const A = makeSandbox({});
  A.sandbox.window.showToast('吃饱啦', 'success');
  const items = itemsOf(A);
  check('弹出了一条 toast', items.length === 1, '条数 ' + items.length);
  const container = containerOf(A);
  check('容器挂在 body 上', !!container && container.parent === A.body);
  check('条目进了容器', items.length === 1 && items[0].parent === container);
  check('类型进了 class（样式才能按成功/失败上色）',
    items.length === 1 && /toast-item-success/.test(items[0].className),
    items.length ? items[0].className : '');
  check('正文一字不差', items.length === 1 && textOf(items[0]) === '吃饱啦',
    items.length ? textOf(items[0]) : '');
  check('有图标', items.length === 1 && items[0].querySelector('.toast-icon') !== null);
  check('入场动画加上了 visible', items.length === 1 && /visible/.test(items[0].className),
    items.length ? items[0].className : '');

  // --- 停留 5 秒（老的是 3 秒）---
  const removeTimer = A.timers.filter(t => t.ms >= 3000).pop();
  check('停留 5 秒（老的是 3 秒，一闪而过）',
    !!removeTimer && removeTimer.ms === 5000,
    removeTimer ? removeTimer.ms + 'ms' : '没排定时器');

  // --- 不再 25 个字就截断 ---
  const B = makeSandbox({});
  const long96 = '这是一句很长的话'.repeat(12);   // 96 个字
  B.sandbox.window.showToast(long96, 'info');
  const it96 = itemsOf(B)[0];
  check('96 个字一条都没丢（老的是 25 个字就砍成「…」）',
    !!it96 && textOf(it96) === long96,
    it96 ? '长度 ' + textOf(it96).length + ' / ' + long96.length : '没有条目');

  const C = makeSandbox({});
  const huge = '字'.repeat(300);
  C.sandbox.window.showToast(huge, 'info');
  const itHuge = itemsOf(C)[0];
  check('超长（300 字）会被截断，但截到 140 而不是 25',
    !!itHuge && textOf(itHuge).length === 140 && /…$/.test(textOf(itHuge)),
    itHuge ? '长度 ' + textOf(itHuge).length : '没有条目');

  // --- 暗黑模式 ---
  const D = makeSandbox({ dark: true });
  D.sandbox.window.showToast('夜里也要看得清', 'info');
  check('暗黑模式下容器会加 toast-dark（不然还是白底）',
    !!containerOf(D) && /toast-dark/.test(containerOf(D).className),
    containerOf(D) ? containerOf(D).className : '没有容器');

  const E = makeSandbox({});
  E.sandbox.window.showToast('白天', 'info');
  check('非暗黑模式不加 toast-dark',
    !!containerOf(E) && !/toast-dark/.test(containerOf(E).className),
    containerOf(E) ? containerOf(E).className : '没有容器');
}

// ============================================================
// ② 样式（居中 + 宠物屋皮肤）
// ============================================================
section('全局 toast 的样式');
{
  const css = read('css/features-3.css');
  const containerRule = (css.match(/\.toast-container\s*\{[\s\S]*?\n\s*\}/) || [''])[0];
  const itemRule = (css.match(/\.toast-item\s*\{[\s\S]*?\n\s*\}/) || [''])[0];

  check('容器在屏幕【中央】（top:50% + translate(-50%,-50%)）',
    /top:\s*50%;/.test(containerRule) && /translate\(-50%,\s*-50%\)/.test(containerRule),
    containerRule.replace(/\s+/g, ' ').slice(0, 120));
  check('不再固定在顶部（旧的是 top: 12px）', !/top:\s*12px/.test(containerRule));
  check('容器不吃点击（不挡用户操作）', /pointer-events:\s*none/.test(containerRule));

  check('条目用宠物屋的奶油渐变皮肤',
    /linear-gradient\(180deg,\s*#fdf8ee\s*0%,\s*#f6ead4\s*100%\)/.test(itemRule),
    itemRule.replace(/\s+/g, ' ').slice(0, 160));
  check('条目是暖棕描边（不再是白色胶囊）',
    /border:\s*1px solid rgba\(122,\s*98,\s*62,\s*\.28\)/.test(itemRule)
    && !/border-radius:\s*50px/.test(itemRule));
  check('条目圆角 18px', /border-radius:\s*18px/.test(itemRule));
  check('正文保留换行 + 能断行',
    /\.toast-text\s*\{[\s\S]{0,200}?white-space:\s*pre-line/.test(css)
    && /\.toast-text\s*\{[\s\S]{0,200}?word-break:\s*break-word/.test(css));
  check('按类型上色（成功 / 失败各一套）',
    /\.toast-item-success\s\.toast-icon/.test(css) && /\.toast-item-error\s\.toast-icon/.test(css));
  check('暗黑模式跟着走（容器挂 body 上，得靠 toast-dark 才知道深浅）',
    /\.toast-container\.toast-dark\s\.toast-item/.test(css));
}

// ============================================================
// ③ 接线 + 版本号
// ============================================================
section('接线 + 版本号');
{
  const html = read('index.html');
  const sw = read('sw.js');
  const js = read('modules/ui-modals.js');

  check('index.html 挂了 ui-modals.js', /modules\/ui-modals\.js\?v=/.test(html));
  check('index.html 挂了 features-3.css', /css\/features-3\.css\?v=/.test(html));
  const vJs = (html.match(/modules\/ui-modals\.js\?v=([0-9.]+)/) || [])[1];
  const vCss = (html.match(/css\/features-3\.css\?v=([0-9.]+)/) || [])[1];
  check('ui-modals.js 的 ?v= 已 bump（不 bump 手机上吃旧版，老 toast 还在）',
    vJs === '0.0.37', '实际 ' + vJs);
  check('features-3.css 的 ?v= 已 bump（不 bump 手机上吃旧样式，还是顶部白胶囊）',
    vCss === '0.0.37', '实际 ' + vCss);
  const cv = (sw.match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
  check('sw.js 的 CACHE_VERSION 已 bump', cv === 'v0.2.83.0', String(cv));
  check('showToast 默认时长是 5 秒', /function showToast\(message, type = 'info', duration = 5000\)/.test(js));
  check('正文走 textContent（不是 innerHTML）',
    /textEl\.textContent = displayMsg/.test(js));
}

// ============================================================
(function () {
  console.log('\n================================');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  console.log('================================');
  if (failed > 0) process.exit(1);
})();

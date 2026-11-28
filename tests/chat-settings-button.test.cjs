// ============================================================
// tests/chat-settings-button.test.cjs
// 「聊天详情 / AI 个人设置」按钮点不开 —— 回归测试 (2026-11-28)
//
// 【背景】v0.2.143.9 那次大改把「独立行动冷却」搬进【AI 后台活动】面板时,
//   index.html 里 id="ai-cooldown-group" 那个 settings-item 区块被删了,
//   但 modules/init-event-bindingsA.js 里还有一行裸访问它:
//     document.getElementById('ai-cooldown-group').style.display = ...
//   getElementById 返回 null → null.style 抛 TypeError →
//   chat-settings-btn 的整个点击处理函数在这里中断, 后面第 3862 行的
//   showScreen('chat-settings-screen') 永远执行不到 →
//   点对话框右上角按钮【完全没动静】(控制台只有一条 unhandled rejection)。
//
// 【这个测试干两件事】
//   ① 静态: DOM 已经没了, JS 里就不许再出现这个 id (挡住同类回归)
//   ② 真机: 本机 Edge 无头跑一遍, 点 #chat-settings-btn, 断言聊天详情页真的打开了
//
// 跑法: node tests/chat-settings-button.test.cjs
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8901;

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

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
  if (cond) ok(name, detail); else fail(name, detail);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

// ------------------------------------------------------------
// CDN 代理: index.html 挂了几个【阻塞式】外链脚本, 不代理的话
// 页面光等外网就要 60 秒开外, 测试直接超时。
// ------------------------------------------------------------
const CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'phoebeboo.github.io',
  'files.catbox.moe',
];
const cdnCache = new Map();

function fetchCdn(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve(null); return; }
    if (CDN_HOSTS.indexOf(u.hostname) < 0) { resolve(null); return; }
    if (cdnCache.has(url)) { resolve(cdnCache.get(url)); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    fetch(url, { signal: ctrl.signal, redirect: 'follow' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((text) => { cdnCache.set(url, text); resolve(text); })
      .catch((e) => {
        console.log('  [CDN] 取不到 ' + url + ' (' + (e && e.message) + ') —— 用空脚本顶上');
        cdnCache.set(url, '');
        resolve('');
      })
      .finally(() => clearTimeout(timer));
  });
}

function rewriteCdnScripts(html) {
  return html.replace(
    /(<script\b[^>]*\ssrc=")(https?:\/\/[^"]+)(")/gi,
    (m, a, url, c) => a + '/__cdn?u=' + encodeURIComponent(url) + c
  );
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);

      if (p === '/__cdn') {
        const q = decodeURIComponent((req.url.split('?')[1] || '').split('&').find((s) => s.startsWith('u=')) || '').slice(2);
        fetchCdn(q).then((text) => {
          if (text === null) { res.writeHead(403); res.end('blocked'); return; }
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          res.end(text);
        });
        return;
      }

      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

      if (p === '/index.html') {
        fs.readFile(file, (err, buf) => {
          if (err) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(rewriteCdnScripts(buf.toString('utf8')));
        });
        return;
      }

      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------
// ① 静态检查
// ------------------------------------------------------------
function staticCheck() {
  console.log('\n== 静态: DOM 删了, JS 里不许再裸访问 ==');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*"([^"]+)"/g)) htmlIds.add(m[1]);

  check('index.html 里确实没有 #ai-cooldown-group 了 (DOM 已删)',
    !htmlIds.has('ai-cooldown-group'));

  // 全项目扫一遍: 凡是 index.html 里不存在的 id, 都不许被【裸访问】
  // (裸访问 = getElementById('X').yyy 或者 const v = getElementById('X') 之后直接 v.yyy)
  //
  // 排除两类「假警报」:
  //   ① 运行时才建出来的 id (JS 里 .id = 'xxx' 动态挂的, 比如视频通话的 live2d-canvas)
  //   ② 有 null 保护的写法 (const v = getElementById('X'); if (v) v.yyy)
  const SCAN_DIRS = ['modules', 'js'];
  const files = [];
  for (const d of SCAN_DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.js$/.test(f)) files.push(path.join(dir, f));
    }
  }
  for (const f of fs.readdirSync(ROOT)) {
    if (/\.js$/.test(f) && !f.startsWith('_')) files.push(path.join(ROOT, f));
  }

  // 注释里的代码不算 (补丁说明里常写 "原来这里是 document.getElementById(...)")
  function inComment(line, at) {
    const c = line.lastIndexOf('//', at);
    if (c >= 0) return true;
    const b = line.lastIndexOf('/*', at);
    return b >= 0;
  }

  // 扫「运行时动态创建的 id」之前必须先把注释剥掉 ——
  // 否则补丁说明里一句 'index.html 里 id="ai-cooldown-group" 那个区块被删了'
  // 就会被当成「这个 id 是运行时建的」, 把真正的裸访问放过去 (实测踩过)。
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  // 运行时动态创建的 id
  const runtimeIds = new Set();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)) runtimeIds.add(m[1]);
    for (const m of src.matchAll(/\.setAttribute\(\s*['"]id['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]/g)) runtimeIds.add(m[1]);
    // JS 里用 HTML 模板字符串拼出来的: id="xxx"
    for (const m of src.matchAll(/\bid\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) runtimeIds.add(m[1]);
  }

  // 这一行算「有 null 保护」
  function guarded(line, varName) {
    return new RegExp('if\\s*\\(\\s*!?\\s*' + varName + '\\b').test(line)
      || new RegExp('\\b' + varName + '\\s*&&').test(line)
      || new RegExp('\\b' + varName + '\\s*\\?').test(line);
  }

  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = raw.split('\n');
    // 跟踪 /* ... */ 跨行块注释
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const blockStart = L.indexOf('/*');
      let lineIsComment = inBlock;
      if (blockStart >= 0 && L.indexOf('*/', blockStart) < 0) inBlock = true;
      else if (inBlock && L.indexOf('*/') >= 0) inBlock = false;
      if (lineIsComment) continue;

      // 直接链式: document.getElementById('X').yyy
      for (const m of L.matchAll(/document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*[A-Za-z_$][\w$]*/g)) {
        if (inComment(L, m.index)) continue;
        if (!htmlIds.has(m[1]) && !runtimeIds.has(m[1])) offenders.push(rel + ':' + (i + 1) + '  #' + m[1]);
      }
      // 赋值后裸访问: const v = getElementById('X')  →  后面 v.yyy
      const cm = L.match(/const\s+(\w+)\s*=\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)\s*;/);
      if (cm && !htmlIds.has(cm[2]) && !runtimeIds.has(cm[2])) {
        for (let j = i + 1; j < Math.min(i + 13, lines.length); j++) {
          if (!new RegExp('\\b' + cm[1] + '\\s*\\.').test(lines[j])) continue;
          const prev = lines[j - 1] || '';
          if (guarded(lines[j], cm[1]) || guarded(prev, cm[1])) break; // 有保护 → 放过
          offenders.push(rel + ':' + (i + 1) + '  #' + cm[2]);
          break;
        }
      }
    }
  }

  const mine = offenders.filter((o) => o.indexOf('modules/init-event-bindings') >= 0);
  check('modules/init-event-bindings*.js 里没有裸访问已删 DOM 的写法',
    mine.length === 0, mine.length ? mine.join(' | ') : '');

  // 其余模块的历史遗留项: 【只告警, 不判失败】
  // —— 这一堆牵扯到真·记忆系统 (memory-summary / vector-memory) 等用户明确说过不许动的部分,
  //    也不属于这次改动的范围。想清就另开一轮单独处理。
  const others = offenders.filter((o) => o.indexOf('modules/init-event-bindings') < 0);
  if (others.length) {
    console.log('  [WARN] 其它模块的历史遗留裸访问 ' + others.length + ' 处 (不在本次范围, 仅记录):');
    others.forEach((o) => console.log('         ' + o));
  }
}

// ------------------------------------------------------------
// ② 真机点击
// ------------------------------------------------------------
async function browserCheck() {
  console.log('\n== 真机: 点右上角按钮, 聊天详情页要真的打开 ==');

  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) {
    console.log('  [SKIP] 没找到 Edge / Chrome, 跳过浏览器部分');
    return;
  }
  console.log('  浏览器: ' + exe);

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等 App 初始化完 (db + state + globalSettings)
    await page.waitForFunction(
      () => !!(window.db && window.state && window.state.globalSettings),
      { timeout: 60000 }
    );

    // 装一个 unhandledrejection 收集器 —— 那个 handler 是 async 的,
    // 里面抛 TypeError 只表现为 unhandled rejection, puppeteer 的 pageerror 抓不到。
    await page.evaluate(() => {
      window.__rejections = [];
      window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        window.__rejections.push(String((r && (r.stack || r.message)) || r));
      });
    });

    // 塞一个假角色 (设置项给全, 免得 handler 因为别的字段 undefined 提前挂)
    //
    // ⚠️ 【竞态】App 自己会异步把角色列表从 DB 载进 window.state.chats,
    //    要是我们先塞后被它覆盖, state.activeChatId 也会被清掉 →
    //    handler 第一句 `if (!state.activeChatId) return;` 直接返回 → 点开没反应。
    //    所以反复塞, 直到 activeChatId 真的钉住了为止。
    const fakeChat = {
      id: 'btn-test-chat',
      name: '测试角色',
      originalName: '测试角色',
      isGroup: false,
      members: [],
      history: [],
      musicData: { totalTime: 0 },
      settings: {
        myPersona: '', aiPersona: '', myNickname: '我',
        maxMemory: 20, linkedMemoryCount: 10,
        enableTimePerception: false, timeZone: 'Asia/Shanghai',
        injectLatestThought: false, enableThoughts: null, enableCrossChat: null,
        enableSynthMusic: false, enableNarratorMode: false,
        enableBilingualMode: false, bilingualDisplayMode: 'outside',
        enableStickerVision: false, enableStickerSmartMatch: false,
        enableMultiReply: false, minReplyCount: 2, maxReplyCount: 5,
        isOfflineMode: false, offlineMinLength: 100, offlineMaxLength: 300,
        offlineContinuousLayout: false, offlinePresets: [],
        ttsLanguage: '', showSeconds: false, enableTts: true,
        enableDynamicAge: false, aiBirthday: {},
        alternateGreetings: [], linkedWorldBookIds: [],
        enableTodoList: false, proactiveEnabled: false,
        lyricsPosition: { vertical: 'top', horizontal: 'center', offset: 10 },
        bgActivity: { enabled: false, cooldownMinutes: 15 },
      },
    };

    let activeOk = false;
    for (let i = 0; i < 40 && !activeOk; i++) {
      await page.evaluate((chat) => {
        window.state.chats = window.state.chats || {};
        window.state.chats[chat.id] = chat;
        window.state.activeChatId = chat.id;
      }, fakeChat);
      await new Promise((r) => setTimeout(r, 250));
      activeOk = await page.evaluate(() => window.state.activeChatId === 'btn-test-chat');
    }
    check('测试角色已就位 (activeChatId 钉住了, 否则 handler 会直接 return)', activeOk);

    // 先确保按钮在 (聊天页 header 右上角)
    await page.evaluate(() => {
      const btn = document.getElementById('chat-settings-btn');
      if (!btn) throw new Error('找不到 #chat-settings-btn');
    });

    // 点它 —— 注入和点击放在【同一个 evaluate】里, 免得中间被 App 异步刷新 state.chats 插一脚
    // (handler 开头是同步读的 chat = state.chats[state.activeChatId], 同一个 tick 里不会被抢跑)
    await page.evaluate((chat) => {
      window.state.chats = window.state.chats || {};
      window.state.chats[chat.id] = chat;
      window.state.activeChatId = chat.id;
      document.getElementById('chat-settings-btn').click();
    }, fakeChat);

    // 等 handler 跑完 (它是 async, 有几个 await)
    await page.waitForFunction(
      () => {
        const el = document.getElementById('chat-settings-screen');
        return el && el.classList.contains('active');
      },
      { timeout: 15000 }
    ).catch(() => {});

    const result = await page.evaluate(() => {
      const el = document.getElementById('chat-settings-screen');
      const active = document.querySelector('.screen.active');
      return {
        opened: !!(el && el.classList.contains('active')),
        activeScreen: active ? active.id : '(none)',
        hasCooldownGroup: !!document.getElementById('ai-cooldown-group'),
        rejections: window.__rejections || [],
      };
    });

    check('点 #chat-settings-btn 之后「聊天详情」页真的打开了', result.opened,
      '当前 active screen = ' + result.activeScreen);
    check('点击过程中没有任何 unhandled rejection',
      result.rejections.length === 0,
      result.rejections.length ? result.rejections[0].slice(0, 200) : '');
    check('页面里确认不存在 #ai-cooldown-group (根因元素已删)',
      !result.hasCooldownGroup);

  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  console.log('========================================');
  console.log(' 聊天详情按钮 · 回归测试');
  console.log('========================================');

  staticCheck();
  await browserCheck();

  console.log('\n----------------------------------------');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('----------------------------------------');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩了:', e && e.stack ? e.stack : e);
  process.exit(1);
});

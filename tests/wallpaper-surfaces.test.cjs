// ============================================================
// tests/wallpaper-surfaces.test.cjs
// 「消息」角色列表页 + 「动态」朋友圈 壁纸玻璃化 —— 回归测试 (2026-11-28)
//
// 【背景】用户要求这两个页面别再"白糊糊"的:
//   · 角色列表页直接铺【外观设置 → 主屏壁纸】里用户自己上传的那张
//   · 朋友圈跟着一起玻璃化 (QQ 空间式大封面 + 玻璃卡)
//   改动落在 css/wallpaper-surfaces.css + settings-presets.js 的
//   applyGlobalWallpaper() + chat-list.js 的 switchToChatListView()
//
// 【这个测试干两件事】
//   ① 静态: 挡住几处最容易踩回去的坑
//      - 样式文件必须被 index.html 引进来 (漏引 = 退回白底)
//      - 壁纸必须同时挂到 #home-screen 和 #chat-list-screen
//      - 朋友圈不能再写死 #f0f2f5 (那正是"白糊糊"的根源)
//      - 左滑删除按钮必须默认藏起来 (translateX(100%)),
//        否则半透明卡片会把红色删除条透出来 —— 这坑踩过一次
//      - 回忆/收藏/NPC 三个没改的 tab 必须给不透明底色, 别透出壁纸
//   ② 真机: 本机 Edge 无头跑一遍, 断言壁纸真的铺上去了、卡片是玻璃的、
//      删除按钮默认不可见、左滑才出来
//
// 跑法: node tests/wallpaper-surfaces.test.cjs
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8903;

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
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

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
  console.log('\n== 静态: 样式接线 + 几个别踩回去的坑 ==');

  const cssPath = path.join(ROOT, 'css', 'wallpaper-surfaces.css');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const presets = fs.readFileSync(path.join(ROOT, 'modules', 'settings-presets.js'), 'utf8');
  const chatList = fs.readFileSync(path.join(ROOT, 'modules', 'chat-list.js'), 'utf8');

  check('css/wallpaper-surfaces.css 存在', fs.existsSync(cssPath));
  if (!fs.existsSync(cssPath)) return;

  check('index.html 引入了 css/wallpaper-surfaces.css',
    /<link[^>]+href="css\/wallpaper-surfaces\.css\?v=[^"]+"/.test(html),
    (html.match(/href="css\/wallpaper-surfaces\.css\?v=[^"]+"/) || [''])[0]);

  check('sw.js 预缓存里加了 css/wallpaper-surfaces.css',
    sw.includes("'./css/wallpaper-surfaces.css'"));

  // 壁纸必须同时铺到首页和角色列表页
  check('applyGlobalWallpaper() 把壁纸也挂到 #chat-list-screen 上',
    /applyWallpaperToSurface\(\s*document\.getElementById\(\s*['"]chat-list-screen['"]\)/.test(presets));

  // 朋友圈不能再写死浅灰
  check('chat-list.js 不再给朋友圈写死 #f0f2f5',
    !/qzone-screen['"]\)\.style\.backgroundColor\s*=\s*['"]#f0f2f5/i.test(chatList));

  const css = fs.readFileSync(cssPath, 'utf8');
  const compact = css.replace(/\s+/g, ' ');

  // 左滑删除按钮: 默认藏起来 + 左滑滑回来 (半透明卡片会把红色透出来)
  check('删除按钮默认 translateX(100%) 藏着',
    /\.qzone-post-delete-action\s*\{[^}]*translateX\(100%\)/.test(compact));
  check('.swiped 时删除按钮滑回来 (兄弟选择器)',
    /\.qzone-post-item\.swiped\s*~\s*\.qzone-post-delete-action\s*\{[^}]*translateX\(0\)/.test(compact));
  check('朋友圈卡片本身用 backdrop-filter 会跟删除按钮打架 —— 规则里不许出现',
    !/\.qzone-post-item\s*\{[^}]*backdrop-filter/.test(compact));

  // 三个 tab 现在也一起玻璃化了 —— 背景要透明, 让壁纸透上来
  check('回忆/收藏/NPC 三个 tab 也改玻璃了 —— 背景要透明',
    /#memories-view,\s*#favorites-view,\s*#npc-list-view\s*\{[^}]*background-color:\s*transparent\s*!important/.test(compact));

  // 三个 tab 的顶栏也要玻璃条
  check('回忆/收藏/NPC 的顶栏也是玻璃条',
    /#memories-view>\.header,\s*#favorites-view>\.header,\s*#npc-list-view>\.header\s*\{[^}]*backdrop-filter/.test(compact));

  // 角色列表第一张卡要整个露在顶栏下面 (顶栏实测 98px)
  check('#chat-list 的 padding-top 被顶开了 (>=100px)',
    (() => {
      const m = compact.match(/#chat-list\s*\{[^}]*padding-top:\s*(\d+)px/);
      return !!m && parseInt(m[1], 10) >= 100;
    })());
}

// ------------------------------------------------------------
// ② 真机检查
// ------------------------------------------------------------
async function browserCheck() {
  console.log('\n== 真机: 壁纸铺上去了 + 卡片是玻璃的 + 删除按钮默认藏着 ==');

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
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => !!(window.db && window.state && window.state.globalSettings && window.applyGlobalWallpaper),
      { timeout: 60000 }
    );
    // 等 App 自己的 loadAllDataFromDB 跑完 (它会重新 applyGlobalWallpaper)
    await new Promise((r) => setTimeout(r, 3000));

    // ---- ① 壁纸挂到两个屏上 ----
    const wp = `http://127.0.0.1:${PORT}/assets/cinema-room-bg.jpg`;
    const applied = await page.evaluate((wp) => {
      window.state.globalSettings.wallpaper = wp;
      window.applyGlobalWallpaper();
      const screen = document.getElementById('chat-list-screen');
      const home = document.getElementById('home-screen');
      return {
        screen: screen.style.backgroundImage,
        home: home.style.backgroundImage,
        bgColor: getComputedStyle(screen).backgroundColor,
      };
    }, wp);

    check('#chat-list-screen 铺上了主屏壁纸',
      applied.screen.indexOf('cinema-room-bg.jpg') >= 0, applied.screen.slice(0, 60));
    check('#home-screen 铺的是同一张壁纸',
      applied.home.indexOf('cinema-room-bg.jpg') >= 0, applied.home.slice(0, 60));

    // ---- ② 角色列表卡片是玻璃的 ----
    const listStyle = await page.evaluate(async () => {
      const now = Date.now();
      const chat = {
        id: 'wp-test-chat', name: '测试角色', originalName: '测试角色', isGroup: false,
        members: [], history: [{ role: 'assistant', content: 'hi', timestamp: now }],
        musicData: { totalTime: 0 }, status: { text: '在线' },
        settings: { myNickname: '我', aiPersona: '', maxMemory: 20 },
      };
      try { await window.db.chats.put(chat); } catch (e) {}
      window.state.chats[chat.id] = chat;
      try { window.showScreen('chat-list-screen'); } catch (e) {}
      try { window.switchToChatListView('messages-view'); } catch (e) {}
      const l = document.getElementById('chat-list');
      if (l) l.innerHTML = '';
      try { await window.renderChatList(); } catch (e) {}
      const item = document.querySelector('#chat-list .chat-list-item');
      if (!item) return { missing: true };
      const cs = getComputedStyle(item);
      const nameEl = item.querySelector('.name');
      const list = document.getElementById('chat-list');
      return {
        itemBg: cs.backgroundColor,
        itemBlur: cs.backdropFilter || cs.webkitBackdropFilter,
        itemRadius: cs.borderRadius,
        nameColor: nameEl ? getComputedStyle(nameEl).color : null,
        listBg: getComputedStyle(list).backgroundColor,
        headerBlur: getComputedStyle(document.querySelector('#chat-list-screen > .header')).backdropFilter,
      };
    });

    check('角色列表项是半透明玻璃卡 (不是白底)',
      /rgba\(/.test(listStyle.itemBg || '') && !/rgb\(255, 255, 255\)/.test(listStyle.itemBg || ''),
      listStyle.itemBg);
    check('角色列表项带 backdrop-filter 毛玻璃',
      /blur/.test(listStyle.itemBlur || ''), listStyle.itemBlur);
    check('角色列表项是圆角卡', /px/.test(listStyle.itemRadius || '') &&
      parseFloat(listStyle.itemRadius) >= 8, listStyle.itemRadius);
    check('角色名字是白字 (深底上要能看清)',
      listStyle.nameColor === 'rgb(255, 255, 255)', listStyle.nameColor);
    check('#chat-list 本身透明 (让壁纸透上来)',
      listStyle.listBg === 'rgba(0, 0, 0, 0)', listStyle.listBg);
    check('顶栏是毛玻璃条',
      /blur/.test(listStyle.headerBlur || ''), listStyle.headerBlur);

    // ---- ③ 朋友圈 ----
    const qz = await page.evaluate(async () => {
      const now = Date.now();
      try {
        await window.db.qzonePosts.clear();
        await window.db.qzonePosts.add({
          id: 'wp-post-1', authorId: 'user', type: 'shuoshuo',
          content: '测试动态', timestamp: now, likes: [], comments: [],
        });
      } catch (e) {}
      try { window.switchToChatListView('qzone-screen'); } catch (e) {}
      const l = document.getElementById('qzone-posts-list');
      if (l) l.innerHTML = '';
      let renderErr = '';
      try { await window.renderQzonePosts(); } catch (e) { renderErr = String(e && e.message ? e.message : e); }
      // renderQzonePosts() 内部调 loadMoreQzonePosts() 但【没有 await】,
      // 所以这里要轮询等卡片真的挂上去 (少一次 await 就量到 null)
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('.qzone-post-container')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const view = document.getElementById('qzone-screen');
      const container = document.querySelector('.qzone-post-container');
      const item = document.querySelector('.qzone-post-item');
      const del = document.querySelector('.qzone-post-delete-action');
      const res = {
        renderErr: renderErr,
        hasFn: typeof window.renderQzonePosts,
        postCount: l ? l.children.length : -1,
        viewBg: view ? getComputedStyle(view).backgroundColor : null,
        viewInline: view ? view.style.backgroundColor : null,
        containerBg: container ? getComputedStyle(container).backgroundColor : null,
        itemBg: item ? getComputedStyle(item).backgroundColor : null,
        delTransform: del ? getComputedStyle(del).transform : null,
      };
      if (container && del) {
        const cr = container.getBoundingClientRect();
        const dr = del.getBoundingClientRect();
        res.delOverflowRight = Math.round(dr.right - cr.right);
      }
      return res;
    });

    check('朋友圈视图是透明的 (透出壁纸, 不再是 #f0f2f5)',
      qz.viewBg === 'rgba(0, 0, 0, 0)' && qz.viewInline !== 'rgb(240, 242, 245)',
      qz.viewBg + ' / inline=' + qz.viewInline);
    check('朋友圈卡片是半透明玻璃',
      /rgba\(/.test(qz.containerBg || '') && /rgba\(/.test(qz.itemBg || ''),
      qz.containerBg + ' | ' + qz.itemBg + ' | err=' + qz.renderErr + ' | fn=' + qz.hasFn + ' | n=' + qz.postCount);

    // 删除按钮默认必须整个在卡片外面 (被 overflow:hidden 裁掉), 露出来就是一条红边
    check('左滑删除按钮默认藏在卡片外 (不露红条)',
      typeof qz.delOverflowRight === 'number' && qz.delOverflowRight >= 60,
      '超出右边缘 ' + qz.delOverflowRight + 'px, transform=' + qz.delTransform);

    // ---- ④ 左滑后删除按钮要能滑回来 ----
    const swiped = await page.evaluate(async () => {
      const item = document.querySelector('.qzone-post-item');
      if (item) item.classList.add('swiped');
      await new Promise((r) => setTimeout(r, 400));
      const del = document.querySelector('.qzone-post-delete-action');
      const container = document.querySelector('.qzone-post-container');
      if (!del || !container) return { missing: true };
      const cr = container.getBoundingClientRect();
      const dr = del.getBoundingClientRect();
      return {
        overflowRight: Math.round(dr.right - cr.right),
        transform: getComputedStyle(del).transform,
      };
    });
    check('左滑后删除按钮滑回卡片里',
      swiped.overflowRight !== undefined && swiped.overflowRight <= 4,
      '超出右边缘 ' + swiped.overflowRight + 'px, transform=' + swiped.transform);

    // ---- ⑤ 回忆/收藏/NPC 三个 tab 也要是玻璃的 ----
    const tabs = await page.evaluate(async () => {
      const out = {};
      const seed = async () => {
        const now = Date.now();
        try {
          await window.db.favorites.clear();
          await window.db.favorites.add({
            id: 'wp-fav-1', type: 'qzone_post', timestamp: now - 60000, originalTimestamp: now - 60000,
            content: { authorId: 'user', type: 'shuoshuo', content: '测试收藏', likes: ['景澜'], comments: [] },
          });
          await window.db.memories.clear();
          await window.db.memories.add({
            id: 'wp-mem-1', chatId: 'c1', timestamp: now - 86400000, type: 'normal',
            authorId: 'c1', authorName: '沈清越', description: '测试回忆',
          });
          await window.db.npcs.clear();
          await window.db.npcs.add({ name: '测试NPC', persona: '测试设定', avatar: '' });
        } catch (e) {}
      };
      await seed();
      const clickTab = async (v) => {
        try { window.showScreen('chat-list-screen'); } catch (e) {}
        try { window.switchToChatListView('messages-view'); } catch (e) {}
        await new Promise((r) => setTimeout(r, 150));
        const nav = document.querySelector('#chat-list-bottom-nav .nav-item[data-view="' + v + '"]');
        if (nav) nav.click();
        await new Promise((r) => setTimeout(r, 1200));
      };
      const g = (s) => {
        const e = document.querySelector(s);
        if (!e) return { missing: 1 };
        const c = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return { bg: c.backgroundColor, blur: c.backdropFilter, w: Math.round(r.width), h: Math.round(r.height) };
      };

      for (const [v, cardSel] of [
        ['memories-view', '#memories-list .memory-card'],
        ['favorites-view', '#favorites-list .favorite-item-card'],
        ['npc-list-view', '#npc-list .chat-list-item'],
      ]) {
        await clickTab(v);
        const view = document.getElementById(v);
        out[v] = {
          viewBg: view ? getComputedStyle(view).backgroundColor : null,
          header: g('#' + v + '>.header'),
          card: g(cardSel),
        };
      }

      // 收藏页顶栏的「编辑」不能被挤成竖排 (base.css 写死 width:30px)
      await clickTab('favorites-view');
      const editBtn = document.getElementById('favorites-edit-btn');
      if (editBtn) {
        const r = editBtn.getBoundingClientRect();
        out.editBtn = { w: Math.round(r.width), h: Math.round(r.height), ws: getComputedStyle(editBtn).whiteSpace };
      }
      return out;
    });

    check('回忆 tab 背景透明 (透出壁纸)',
      tabs['memories-view'].viewBg === 'rgba(0, 0, 0, 0)', tabs['memories-view'].viewBg);
    check('收藏 tab 背景透明 (透出壁纸)',
      tabs['favorites-view'].viewBg === 'rgba(0, 0, 0, 0)', tabs['favorites-view'].viewBg);
    check('NPC tab 背景透明 (透出壁纸)',
      tabs['npc-list-view'].viewBg === 'rgba(0, 0, 0, 0)', tabs['npc-list-view'].viewBg);
    check('三个 tab 的顶栏都是毛玻璃条',
      ['memories-view', 'favorites-view', 'npc-list-view'].every((k) => /blur/.test(tabs[k].header.blur || '')),
      JSON.stringify({ m: tabs['memories-view'].header.blur, f: tabs['favorites-view'].header.blur, n: tabs['npc-list-view'].header.blur }));
    check('回忆卡是半透明玻璃',
      /rgba\(/.test(tabs['memories-view'].card.bg || ''), tabs['memories-view'].card.bg);
    check('收藏卡是半透明玻璃',
      /rgba\(/.test(tabs['favorites-view'].card.bg || ''), tabs['favorites-view'].card.bg);
    check('NPC 项是半透明玻璃',
      /rgba\(/.test(tabs['npc-list-view'].card.bg || ''), tabs['npc-list-view'].card.bg);
    check('收藏页「编辑」按钮不再竖排',
      !!tabs.editBtn && tabs.editBtn.ws === 'nowrap' && tabs.editBtn.w > tabs.editBtn.h,
      JSON.stringify(tabs.editBtn));
  } finally {
    await browser.close();
    server.close();
  }
}

(async () => {
  staticCheck();
  try {
    await browserCheck();
  } catch (e) {
    fail('浏览器部分炸了', String(e && e.message ? e.message : e));
  }
  console.log('\n通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})();

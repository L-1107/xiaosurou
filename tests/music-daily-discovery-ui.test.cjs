// ============================================================
// tests/music-daily-discovery-ui.test.cjs
// 「今日私选」的真实浏览器冒烟测试 (puppeteer-core + 本机 Edge)
//
// 跑法: node tests/music-daily-discovery-ui.test.cjs
//
// 【为什么还要这个】node 沙箱那套只测了"规则", 测不到:
//   - Dexie 到底有没有建出 v70 那两张表 (忘了 bump ?v= 手机上就不建表)
//   - index.html 的 script 标签有没有真的把引擎加载进来
//   - NeteaseMusicApp 的「今日私选」tab 能不能点开、列表能不能渲染
//   - 反馈按钮点了会不会真的写库
//   - 控制台有没有报错
//
// 【自建静态服务器】330 是纯静态站, 但它要靠 /.netlify/functions/* 走代理;
//   本地没有 netlify dev, 所以网易云接口一律 404 —— 这是【预期】的,
//   本测试只验证 UI 与本地存储, 不验证真实的网易云链路。
//
// 【注意】没装 Chrome 时直接用本机 Edge (executablePath), 不额外下载浏览器。
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;

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

// ============================================================
// CDN 代理 (让测试自给自足, 不用干等外网)
//
// 【为什么】index.html 里挂了 10 个外部脚本 (crypto-js / dexie / Tone / hls ...),
//   其中好几个是【阻塞式】的 —— 它们不加载完, DOMContentLoaded 就不触发。
//   外网每个 3~5 秒, 串起来能把页面加载拖到 60 秒开外, 测试直接超时崩掉。
//   所以这里把 index.html 里的外链 script 改写成 /__cdn?u=<encoded>,
//   由本服务器代取并【缓存】(同一次跑只取一次), 页面照常拿到真库。
// ============================================================
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
      .then((text) => {
        cdnCache.set(url, text);
        resolve(text);
      })
      .catch((e) => {
        console.log('  [CDN] 取不到 ' + url + ' (' + (e && e.message) + ') —— 用空脚本顶上');
        cdnCache.set(url, '');
        resolve('');
      })
      .finally(() => clearTimeout(timer));
  });
}

// 把 index.html 里的外链 script 改写成走本地代理
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

      // --- CDN 代理 ---
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

      // --- index.html 要先改写外链 ---
      if (p === '/index.html') {
        fs.readFile(file, (err, buf) => {
          if (err) { res.writeHead(404); res.end('not found'); return; }
          const html = rewriteCdnScripts(buf.toString('utf8'));
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
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

async function main() {
  console.log('========================================');
  console.log(' 今日私选 · 浏览器冒烟测试');
  console.log('========================================');

  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) {
    console.log('  [SKIP] 没找到 Edge / Chrome, 跳过浏览器测试');
    return;
  }
  console.log('  浏览器: ' + exe);

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等 db 和引擎就绪
    await page.waitForFunction(
      () => !!(window.db && window.MusicDailyDiscovery && window.NeteaseMusicApp),
      { timeout: 60000 }
    );

    console.log('\n== 加载 & 数据库 ==');
    const dbInfo = await page.evaluate(async () => {
      const tables = window.db.tables.map((t) => t.name);
      return {
        verno: window.db.verno,
        hasDaily: tables.indexOf('dailyDiscovery') >= 0,
        hasFeedback: tables.indexOf('dailyDiscoveryFeedback') >= 0,
        hasEngine: typeof window.MusicDailyDiscovery === 'object',
        hasApiKey: !!(window.state && window.state.apiConfig && window.state.apiConfig.apiKey),
        hasProxy: !!(window.state && window.state.apiConfig && window.state.apiConfig.proxyUrl),
        hasApiConfig: !!(window.state && window.state.apiConfig),
      };
    });
    check('Dexie 版本到 70', dbInfo.verno >= 70, 'verno=' + dbInfo.verno);
    check('dailyDiscovery 表建出来了', dbInfo.hasDaily);
    check('dailyDiscoveryFeedback 表建出来了', dbInfo.hasFeedback);
    check('引擎挂上了 window.MusicDailyDiscovery', dbInfo.hasEngine);
    check('state.apiConfig 这个对象在 (策展要读它)',
      dbInfo.hasApiConfig, 'key=' + dbInfo.hasApiKey + ' proxy=' + dbInfo.hasProxy);
    if (!dbInfo.hasApiKey) {
      console.log('  (说明: 这个无头 profile 是全新的, 没存过 API key —— '
        + '真实浏览器里有。key 空时策展会自动走确定性兜底, 不会崩)');
    }

    // 适配层新方法
    const apiMethods = await page.evaluate(() => {
      const N = window.NeteaseMusic;
      return ['getSongDetailsBatch', 'getSongUrlsBatch', 'recommendSongs', 'personalizedNewsong',
        'personalizedPlaylists', 'toplist', 'topPlaylistTracks', 'artistSongs']
        .filter((m) => typeof N[m] !== 'function');
    });
    check('网易云适配层的新方法都挂上了', apiMethods.length === 0,
      apiMethods.length ? '缺: ' + apiMethods.join(',') : '');

    console.log('\n== 「今日私选」tab ==');
    const tabInfo = await page.evaluate(() => {
      window.NeteaseMusicApp.open({ initialTab: 'daily' });
      const tabs = Array.from(document.querySelectorAll('.nma-tab')).map((t) => t.textContent.trim());
      return { tabs, hasDailyTab: tabs.indexOf('今日私选') >= 0 };
    });
    check('顶部多出「今日私选」tab', tabInfo.hasDailyTab, 'tabs=' + tabInfo.tabs.join('/'));

    // 塞一张假卡进去 (本地没有 netlify functions, 真卡生成不出来)
    //
    // ⚠️ 【竞态】App 自己会异步把角色列表从 DB 载进 window.state.chats,
    //    要是我们先塞后被它覆盖掉, resolveChatId() 就找不到角色,
    //    页面会显示"没找到角色, 先开个聊天再来" —— 看着像功能坏了, 其实是测试自己抢跑。
    //    所以: 等 App 加载完 → 塞 → 再确认 resolveChatId() 真的认这个角色。
    await page.evaluate(async () => {
      const chatId = 'ui-test-chat';
      const songs = [];
      for (let i = 1; i <= 3; i++) {
        songs.push({
          id: String(900000 + i),
          name: '测试歌' + i,
          artist: '测试歌手' + i,
          artists: [{ id: i, name: '测试歌手' + i }],
          album: '测试专辑',
          cover: '',
          duration: 200000,
          fee: 0,
          reason: '这是第 ' + i + ' 首的理由',
          tag: ['稳准', '旁白', '小冒险'][i - 1],
        });
      }
      await window.db.dailyDiscovery.put({
        id: chatId + '::' + window.MusicDailyDiscovery.todayKey(),
        chatId, date: window.MusicDailyDiscovery.todayKey(),
        title: '今日私选', subtitle: '测试副标题', note: '这是角色说的话',
        generatedAt: Date.now(), strategy: {}, songs, seen: true,
      });

      const inject = () => {
        window.state.activeChatId = chatId;
        window.state.chats = window.state.chats || {};
        window.state.chats[chatId] = {
          id: chatId, name: '测试角色',
          settings: {},
          history: [],
          musicData: { totalTime: 0 },
        };
      };

      // 等 App 把自己的角色列表加载完 (最多 20 秒)
      for (let i = 0; i < 100; i++) {
        if (window.state && window.state.chats && Object.keys(window.state.chats).length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      // 塞进去, 并且确认引擎真的能认出这个角色 (被 App 覆盖就再塞一次)
      for (let i = 0; i < 25; i++) {
        inject();
        if (window.MusicDailyDiscovery.resolveChatId() === chatId) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    // 确认角色真的进去了 (不然下面的断言会变成"测试自己的锅")
    const roleOk = await page.evaluate(() => window.MusicDailyDiscovery.resolveChatId() === 'ui-test-chat');
    check('测试角色已就位 (引擎能认出它)', roleOk);

    // 切到今日私选 tab, 等渲染
    await page.evaluate(() => {
      const overlay = document.getElementById('netease-music-app-overlay');
      const tab = overlay && overlay.querySelector('.nma-tab[data-view="daily"]');
      if (tab) tab.click();
    });
    await page.waitForFunction(
      () => document.querySelectorAll('#nmd-list .nmd-song').length > 0,
      { timeout: 20000 }
    ).catch(() => {});

    const listInfo = await page.evaluate(() => {
      const rows = document.querySelectorAll('#nmd-list .nmd-song');
      return {
        count: rows.length,
        firstName: rows[0] ? (rows[0].querySelector('.nmd-name') || {}).textContent : '',
        firstReason: rows[0] ? (rows[0].querySelector('.nmd-reason') || {}).textContent : '',
        firstTag: rows[0] ? (rows[0].querySelector('.nmd-tag') || {}).textContent : '',
        note: (document.getElementById('nmd-note') || {}).textContent || '',
        hasPlayBtn: !!document.querySelector('#nmd-list .nmd-play'),
        hasFbBtn: !!document.querySelector('#nmd-list .nmd-fb-btn'),
        hasRefresh: !!document.getElementById('nmd-refresh-btn'),
        hasPlayAll: !!document.getElementById('nmd-playall-btn'),
      };
    });
    check('列表渲染出 3 行', listInfo.count === 3, 'count=' + listInfo.count);
    check('歌名渲染出来了', listInfo.firstName.indexOf('测试歌1') >= 0, listInfo.firstName);
    check('推荐理由渲染出来了', listInfo.firstReason.indexOf('第 1 首的理由') >= 0, listInfo.firstReason);
    check('标签渲染出来了', listInfo.firstTag.indexOf('稳准') >= 0, listInfo.firstTag);
    check('角色的开场白渲染出来了', listInfo.note.indexOf('角色说的话') >= 0, listInfo.note);
    check('播放按钮在', listInfo.hasPlayBtn);
    check('反馈按钮在', listInfo.hasFbBtn);
    check('「换一批」按钮在', listInfo.hasRefresh);
    check('「播放全部」按钮在', listInfo.hasPlayAll);

    console.log('\n== 反馈菜单 ==');
    const fbInfo = await page.evaluate(async () => {
      document.querySelector('#nmd-list .nmd-fb-btn').click();
      await new Promise((r) => setTimeout(r, 120));
      const chips = Array.from(document.querySelectorAll('#nmd-list .nmd-chip')).map((c) => c.textContent.trim());
      const before = await window.db.dailyDiscoveryFeedback.count();
      // 点「多推这种」
      const chip = Array.from(document.querySelectorAll('#nmd-list .nmd-chip'))
        .find((c) => c.textContent.trim() === '多推这种');
      if (chip) chip.click();
      await new Promise((r) => setTimeout(r, 400));
      const rows = await window.db.dailyDiscoveryFeedback.where('chatId').equals('ui-test-chat').toArray();
      return { chips, before, after: rows.length, action: rows[0] && rows[0].action };
    });
    check('反馈菜单展开出 5 个选项', fbInfo.chips.length === 5, 'chips=' + fbInfo.chips.join('/'));
    check('点了「多推这种」真的写库了', fbInfo.after === 1 && fbInfo.action === 'more_like_this',
      'rows=' + fbInfo.after + ' action=' + fbInfo.action);

    console.log('\n== 反馈真的影响画像 ==');
    const profileInfo = await page.evaluate(async () => {
      const p = await window.MusicDailyDiscovery.buildProfile('ui-test-chat');
      return {
        boost: Array.from(p.boostArtists),
        known: p.knownIds.size,
        stats: p.stats,
      };
    });
    check('「多推这种」进了 boostArtists', profileInfo.boost.length >= 1,
      'boost=' + profileInfo.boost.join(','));
    check('反馈计数进了画像统计', profileInfo.stats.feedback === 1,
      'feedback=' + profileInfo.stats.feedback);

    console.log('\n== 播放全部 (走一起听播放器的同一条队列) ==');
    const playAllInfo = await page.evaluate(async () => {
      document.getElementById('nmd-playall-btn').click();
      await new Promise((r) => setTimeout(r, 1200));
      const ms = window.musicState;
      const lib = await window.db.musicLibrary.get('main');
      const inQueue = (ms.playlist || []).filter((t) => t.playlistId === 'daily_discovery');
      const saved = ((lib && lib.playlist) || []).filter((t) => t.playlistId === 'daily_discovery');
      return {
        queueCount: inQueue.length,
        activeId: ms.activePlaylistId,
        hasPlaylistTab: (ms.playlists || []).some((p) => p.id === 'daily_discovery'),
        savedCount: saved.length,
        firstHasSource: !!(inQueue[0] && inQueue[0].source === 'netease_real' && inQueue[0].id),
      };
    });
    check('播放全部把 3 首塞进了播放器队列', playAllInfo.queueCount === 3, 'count=' + playAllInfo.queueCount);
    check('切到了「今日私选」歌单', playAllInfo.activeId === 'daily_discovery', 'active=' + playAllInfo.activeId);
    check('歌单栏里多了「今日私选」', playAllInfo.hasPlaylistTab);
    check('队列落库了 (刷新不丢)', playAllInfo.savedCount === 3, 'saved=' + playAllInfo.savedCount);
    check('队列条目带 source=netease_real + id (能重新取音源)',
      playAllInfo.firstHasSource);

    console.log('\n== 启动触发 & 推送 ==');
    const startupInfo = await page.evaluate(async () => {
      try {
        const r = await window.MusicDailyDiscovery.startupCheck({ force: true });
        return { ok: true, isNull: r === null };
      } catch (e) {
        return { ok: false, err: String(e && e.message ? e.message : e) };
      }
    });
    check('startupCheck 不抛错 (没登录时安全跳过)', startupInfo.ok, startupInfo.err || '');
    check('没登录网易云时不生成卡', startupInfo.ok && startupInfo.isNull);

    const notifyInfo = await page.evaluate(async () => {
      const toasts = [];
      const orig = window.showToast;
      window.showToast = (m) => { toasts.push(m); };
      window.MusicDailyDiscovery.notifyUser({
        date: '2026-10-21',
        songs: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });
      window.showToast = orig;
      return toasts;
    });
    check('推送走通了 App 内 toast',
      notifyInfo.length === 1 && notifyInfo[0].indexOf('今日私选已就绪') >= 0,
      JSON.stringify(notifyInfo));

    console.log('\n== 截图 ==');
    const shotPath = path.join(ROOT, '_reports', 'daily-discovery-ui.png');
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath });
    console.log('  已保存: ' + shotPath);

    console.log('\n== 控制台 ==');
    // 过滤掉"本地没有 netlify functions"这类预期内报错
    const expected = consoleErrors.filter((e) =>
      /netlify|Failed to load resource|ERR_CONNECTION|404/i.test(e));
    const unexpected = consoleErrors.filter((e) => !expected.includes(e));
    check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('控制台没有意外报错', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
    if (expected.length) console.log('  (预期内的本地报错 ' + expected.length + ' 条, 已忽略)');

  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n测试崩了:', e);
  process.exit(1);
});

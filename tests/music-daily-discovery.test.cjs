// ============================================================
// tests/music-daily-discovery.test.cjs
// 「今日私选」引擎的纯逻辑回归测试
//
// 跑法: node tests/music-daily-discovery.test.cjs
//
// 【为什么要有这个】日推引擎的逻辑全是"过滤 + 排序 + 兜底", 逻辑分支多,
//   而且它跑在手机上 (慢 + 贵 + 每次都要真调 LLM), 没法靠手点验证。
//   这里用 vm 沙箱把 js/music-daily-discovery.js 整个塞进去, 把网易云适配层
//   和 LLM 换成假的, 专门验证"规则"部分:
//
//   ① 红心里的歌一律不推        (用户原话: 自己选过的听腻了)
//   ② 历史推过的 / 反馈排除过的不再推
//   ③ 反馈真生效: 多推这种 → 歌手权重涨; 少推这种 → 降权; 不喜欢 → 硬排除
//   ④ 先验证再智能: 拿不到音源的候选一律不进卡
//   ⑤ LLM 只能选白名单里的 id (发明出来的 songId 会被丢掉)
//   ⑥ LLM 挂掉 → 确定性兜底照样出卡
//   ⑦ 同一歌手不超过 2 首; 同歌不同版本折叠成一个
//   ⑧ 当天只生成一次 (第二次直接读缓存)
//
// 【沙箱要补什么】引擎是 IIFE `(function(global){...})(window)`,
//   加载期就要用到 document / navigator / localStorage / setTimeout,
//   运行期要 db / NeteaseMusic / state / fetchViaOpenAICompatibleProxy。
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_PATH = path.join(ROOT, 'js', 'music-daily-discovery.js');

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
// 假 Dexie
// ============================================================
function makeDb(seed) {
  const s = seed || {};
  const cards = new Map(s.cards || []);
  // ⚠️ 别写 new Array(x) —— 那是"造一个长度 x 的空数组", x 是数组时会塞成一个元素
  const feedback = (s.feedback || []).slice();
  const musicLibrary = s.musicLibrary || null;
  let nextFeedbackId = 1;

  function makeCollection(items, keyFn) {
    return {
      async toArray() { return items.slice(); },
      async count() { return items.length; },
      async primaryKeys() { return items.map(keyFn); },
    };
  }

  return {
    _cards: cards,
    _feedback: feedback,
    dailyDiscovery: {
      async get(id) { return cards.get(id) || undefined; },
      async put(card) { cards.set(card.id, JSON.parse(JSON.stringify(card))); return card.id; },
      where(col) {
        return {
          equals(val) {
            const items = Array.from(cards.values()).filter((c) => c[col] === val);
            return makeCollection(items, (c) => c.id);
          },
        };
      },
    },
    dailyDiscoveryFeedback: {
      async add(obj) {
        const row = Object.assign({ id: nextFeedbackId++ }, obj);
        feedback.push(row);
        return row.id;
      },
      where(col) {
        return {
          equals(val) {
            const items = feedback.filter((f) => f[col] === val);
            return makeCollection(items, (f) => f.id);
          },
        };
      },
      async count() { return feedback.length; },
      orderBy(col) {
        const sorted = feedback.slice().sort((a, b) => a[col] - b[col]);
        return {
          limit(n) {
            return {
              async primaryKeys() { return sorted.slice(0, n).map((f) => f.id); },
            };
          },
        };
      },
      async bulkDelete(keys) {
        for (let i = feedback.length - 1; i >= 0; i--) {
          if (keys.includes(feedback[i].id)) feedback.splice(i, 1);
        }
      },
    },
    musicLibrary: {
      async get(id) { return id === 'main' ? musicLibrary : undefined; },
    },
  };
}

// ============================================================
// 假网易云适配层
// ============================================================
function makeNetease(cfg) {
  const c = cfg || {};
  const calls = { search: 0, urlBatch: 0 };
  // 每个方法各自的最大并发数 —— 用来抓"串行网络调用"这个坑
  const conc = {};

  function song(id, name, artist, extra) {
    return Object.assign({
      id: String(id),
      name: name,
      artist: artist,
      artists: [{ id: 1000 + Number(id), name: artist }],
      album: '专辑' + id,
      albumId: 2000 + Number(id),
      cover: 'https://cdn.example/cover' + id + '.jpg',
      duration: 200000,
      fee: 0,
    }, extra || {});
  }

  const api = {
    _calls: calls,
    _conc: conc,
    isLoggedIn: () => c.loggedIn !== false,
    getLoginStatus: async () => ({ userId: 999, nickname: 'tester' }),
    likelist: async () => (c.likedIds || []).map(String),
    getSongDetailsBatch: async (ids) => (ids || []).map((id) => song(id, '红心歌' + id, '红心歌手')),
    userPlaylist: async () => (c.playlists || []),
    playlistTracks: async (id) => (c.playlistTracks && c.playlistTracks[id]) || [],
    recommendSongs: async () => (c.recommend || []),
    personalizedNewsong: async () => (c.newsong || []),
    personalizedPlaylists: async () => (c.personalizedPlaylists || []),
    toplist: async () => (c.toplists || []),
    topPlaylistTracks: async () => (c.topTracks || []),
    artistSongs: async () => (c.artistSongs || []),
    search: async (q, limit) => { calls.search++; return (c.searchResults || []).slice(0, limit); },
    getSongUrl: async () => null,
    // 只给 whitelist 里的 id 发 url —— 模拟"有的歌拿不到音源"
    getSongUrlsBatch: async (ids, level) => {
      calls.urlBatch++;
      const allow = c.playableIds;
      return (ids || []).filter((id) => {
        if (!allow) return true;
        if (Array.isArray(allow)) return allow.map(String).includes(String(id));
        return true;
      }).map((id) => ({ id: String(id), url: 'https://cdn.example/' + id + '.mp3', level: level || 'exhigh' }));
    },
  };

  // 包一层: 统计每个方法的并发峰值 (isLoggedIn 是同步的, 别包)
  Object.keys(api).forEach((k) => {
    if (typeof api[k] !== 'function' || k === 'isLoggedIn') return;
    const orig = api[k];
    conc[k] = { cur: 0, max: 0, total: 0 };
    api[k] = async function (...args) {
      const t = conc[k];
      t.cur++; t.total++;
      if (t.cur > t.max) t.max = t.cur;
      try {
        // delayMs 用【宿主进程的】真 setTimeout —— 沙箱里的 setTimeout 是假的不触发
        if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs));
        return await orig.apply(this, args);
      } finally {
        t.cur--;
      }
    };
  });

  return api;
}

// ============================================================
// 可控假定时器 —— 沙箱里默认不真的走时间, 但测试可以【手动点火】
// ============================================================
function makeFakeTimers() {
  const pending = [];
  let seq = 0;
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.push({ id, fn, ms: Number(ms) || 0 });
      return id;
    },
    clearTimeout(id) {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    // 把【到点】的定时器全部跑一遍 (maxMs 之内到点的)
    flush(maxMs) {
      const due = pending.filter((p) => maxMs == null || p.ms <= maxMs);
      due.forEach((p) => {
        const i = pending.indexOf(p);
        if (i >= 0) pending.splice(i, 1);
        try { p.fn(); } catch (e) { /* 忽略 */ }
      });
    },
    count() { return pending.length; },
  };
}

// ============================================================
// 沙箱
// ============================================================
function makeSandbox(opts) {
  const options = opts || {};
  const netease = options.netease || makeNetease();
  const db = options.db || makeDb(options.dbSeed);
  const timers = options.timers || makeFakeTimers();

  const notifications = [];
  const toasts = [];
  const llmRequests = [];

  const sandbox = {
    console: console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Promise: Promise,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    Set: Set,
    Map: Map,
    RegExp: RegExp,
    Error: Error,
    AbortController: AbortController,
    AbortSignal: AbortSignal,
    isNaN: isNaN,
    parseInt: parseInt,
    parseFloat: parseFloat,
    navigator: { onLine: true },
    localStorage: {
      _m: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
      setItem(k, v) { this._m[k] = String(v); },
      removeItem(k) { delete this._m[k]; },
    },
    document: {
      readyState: 'complete',
      addEventListener: () => {},
    },
    NeteaseMusic: netease,
    db: db,
    state: Object.assign({
      activeChatId: 'chat-1',
      chats: { 'chat-1': { id: 'chat-1', name: '糖糖', settings: { aiPersona: '有点毒舌但很会关心人的女朋友，喜欢安静的音乐。' } } },
      apiConfig: { proxyUrl: 'https://api.example/v1', apiKey: 'sk-test', model: 'test-model' },
      globalSettings: { systemNotification: { enabled: true } },
    }, options.state || {}),
    showToast: (msg, type) => { toasts.push({ msg, type }); },
    isMainApiProxyEnabled: () => true,
    fetchViaOpenAICompatibleProxy: async (req) => {
      llmRequests.push(req);
      if (options.llmError) throw new Error(options.llmError);
      // llmResponses: 数组形式 = 第一次给第 0 个, 第二次给第 1 个, 之后都用最后一个
      let content = options.llmResponse;
      if (Array.isArray(options.llmResponses)) {
        const list = options.llmResponses;
        const idx = Math.min(llmCallCount, list.length - 1);
        llmCallCount++;
        content = list[idx];
      }
      if (content === undefined) {
        // 默认: 假装是个听话的模型 —— 从 prompt 里把候选数组抠出来, 原样选回去。
        // 这样默认用例走的是【真的 LLM 链路】(校验 / 去重 / 补齐), 而不是一上来就兜底。
        const prompt = (req && req.payload && req.payload.messages && req.payload.messages[0]
          && req.payload.messages[0].content) || '';
        const m = prompt.match(/\n(\[\{"id"[\s\S]*?\}\])\n/);
        let songs = [];
        if (m) {
          try {
            const arr = JSON.parse(m[1]);
            songs = arr.map((s) => ({ id: s.id, reason: '模型给的理由: ' + s.name, tag: '稳准' }));
          } catch (e) { songs = []; }
        }
        content = JSON.stringify({ note: '模型的开场白', songs });
      }
      return {
        ok: true,
        async json() { return { choices: [{ message: { content } }] }; },
      };
    },
    Notification: function (title, opts) {
      notifications.push({ title, opts });
      this.close = () => {};
    },
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  const code = fs.readFileSync(ENGINE_PATH, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'music-daily-discovery.js' });

  return { sandbox, netease, db, notifications, toasts, timers, llmRequests };
}

function idsOf(card) {
  return (card.songs || []).map((s) => String(s.id));
}
function artistCount(card, artist) {
  return (card.songs || []).filter((s) => s.artist === artist).length;
}

// ============================================================
// 用例
// ============================================================
async function main() {
  console.log('========================================');
  console.log(' 今日私选引擎回归测试');
  console.log('========================================');

  // ------------------------------------------------------------
  section('① 红心里的歌一律不推');
  {
    const recommend = [
      { id: '100', name: '红心里的歌', artist: '红心歌手', artists: [{ id: 1, name: '红心歌手' }], album: 'A', cover: '', duration: 1 },
      { id: '101', name: '新的歌', artist: '新歌手', artists: [{ id: 2, name: '新歌手' }], album: 'B', cover: '', duration: 1 },
    ];
    const { sandbox } = makeSandbox({
      netease: makeNetease({ likedIds: ['100'], recommend }),
    });
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    const ids = idsOf(card);
    check('红心里的歌没进卡', !ids.includes('100'), 'ids=' + ids.join(','));
    check('新歌进了卡', ids.includes('101'));
  }

  // ------------------------------------------------------------
  section('② 历史推过 / 反馈排除过的不再推');
  {
    const recommend = [
      { id: '200', name: '昨天推过', artist: 'A', artists: [{ id: 3, name: 'A' }], album: '', cover: '', duration: 1 },
      { id: '201', name: '反馈说不要', artist: 'B', artists: [{ id: 4, name: 'B' }], album: '', cover: '', duration: 1 },
      { id: '202', name: '正常歌', artist: 'C', artists: [{ id: 5, name: 'C' }], album: '', cover: '', duration: 1 },
    ];
    const db = makeDb({
      cards: [['chat-1::2026-10-20', { id: 'chat-1::2026-10-20', chatId: 'chat-1', date: '2026-10-20', songs: [{ id: '200', name: '昨天推过', artist: 'A' }] }]],
      feedback: [{ id: 1, chatId: 'chat-1', songId: '201', artist: 'B', action: 'dislike', createdAt: 1 }],
    });
    const { sandbox } = makeSandbox({ netease: makeNetease({ recommend }), db });
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    const ids = idsOf(card);
    check('昨天推过的歌没再推', !ids.includes('200'), 'ids=' + ids.join(','));
    check('反馈 dislike 的歌没再推', !ids.includes('201'));
    check('正常歌还在', ids.includes('202'));
  }

  // ------------------------------------------------------------
  section('③ 反馈真生效 (歌手权重 / 硬排除)');
  {
    const db = makeDb({
      feedback: [
        { id: 1, chatId: 'chat-1', songId: '900', artist: '飙升歌手', action: 'more_like_this', createdAt: 1 },
        { id: 2, chatId: 'chat-1', songId: '901', artist: '讨厌歌手', action: 'dislike', createdAt: 2 },
      ],
    });
    const { sandbox } = makeSandbox({
      netease: makeNetease({
        recommend: [
          { id: '902', name: '讨厌歌手的歌', artist: '讨厌歌手', artists: [{ id: 6, name: '讨厌歌手' }], album: '', cover: '', duration: 1 },
          { id: '903', name: '正常歌', artist: '正常歌手', artists: [{ id: 7, name: '正常歌手' }], album: '', cover: '', duration: 1 },
        ],
      }),
      db,
    });
    const profile = await sandbox.MusicDailyDiscovery.buildProfile('chat-1');
    check('"多推这种"进了 boostArtists', profile.boostArtists.has('飙升歌手'),
      'boost=' + Array.from(profile.boostArtists).join(','));
    check('"不喜欢"进了 avoidArtists (硬排除)', profile.avoidArtists.has('讨厌歌手'));
    check('被 dislike 的歌手权重是负的',
      (profile.artistWeights.get('讨厌歌手') || { weight: 0 }).weight < 0);

    // 硬排除真的生效
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    check('被 dislike 的歌手的歌不进卡',
      !idsOf(card).some((id) => id === '902'), 'ids=' + idsOf(card).join(','));
  }

  // ------------------------------------------------------------
  section('④ 先验证再智能 (拿不到音源的不进卡)');
  {
    const recommend = [
      { id: '300', name: '能播', artist: 'A', artists: [{ id: 7, name: 'A' }], album: '', cover: '', duration: 1 },
      { id: '301', name: '不能播', artist: 'B', artists: [{ id: 8, name: 'B' }], album: '', cover: '', duration: 1 },
    ];
    const { sandbox } = makeSandbox({
      netease: makeNetease({ recommend, playableIds: ['300'] }),
    });
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    const ids = idsOf(card);
    check('能播的进了卡', ids.includes('300'), 'ids=' + ids.join(','));
    check('不能播的没进卡', !ids.includes('301'));
  }

  // ------------------------------------------------------------
  section('⑤ LLM 只能选白名单里的 id');
  {
    const recommend = [
      { id: '400', name: '真歌', artist: 'A', artists: [{ id: 9, name: 'A' }], album: '', cover: '', duration: 1 },
      { id: '401', name: '真歌2', artist: 'B', artists: [{ id: 10, name: 'B' }], album: '', cover: '', duration: 1 },
    ];
    // LLM 瞎编了一个 999999, 还重复了 400
    const llmResponse = JSON.stringify({
      note: '给你找了点新东西',
      songs: [
        { id: 999999, reason: '我编的', tag: '稳准' },
        { id: 400, reason: '这个真的在候选里', tag: '小冒险' },
        { id: 400, reason: '重复了', tag: '私心' },
        { id: 401, reason: '这个也是真的', tag: '惊喜' },
        { id: 401, reason: '又重复', tag: '稳准' },
      ],
    });
    const { sandbox } = makeSandbox({ netease: makeNetease({ recommend }), llmResponse });
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    const ids = idsOf(card);
    check('LLM 编造的 id 被丢掉', !ids.includes('999999'), 'ids=' + ids.join(','));
    check('重复 id 只保留一次', ids.filter((i) => i === '400').length === 1);
    check('note 被采纳', card.note === '给你找了点新东西', 'note=' + card.note);
    const first = card.songs.find((s) => s.id === '400');
    check('理由被采纳', first && first.reason === '这个真的在候选里', first && first.reason);
    check('白名单里的标签被采纳', first && first.tag === '小冒险', first && first.tag);
    const second = card.songs.find((s) => s.id === '401');
    check('白名单外的标签被换成兜底值', second && second.tag === '旁白', second && second.tag);
  }

  // ------------------------------------------------------------
  section('⑥ LLM 挂掉 → 确定性兜底照样出卡');
  {
    const recommend = [];
    for (let i = 0; i < 25; i++) {
      recommend.push({
        id: String(500 + i),
        name: '歌' + i,
        artist: '歌手' + (i % 5),
        artists: [{ id: 100 + i, name: '歌手' + (i % 5) }],
        album: '', cover: '', duration: 1,
      });
    }
    const { sandbox } = makeSandbox({ netease: makeNetease({ recommend }), llmError: 'boom' });
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    check('LLM 挂了也出了卡', !!card && card.songs.length > 0, 'songs=' + (card.songs || []).length);
    check('兜底也够 20 首', card.songs.length === 20, 'songs=' + card.songs.length);
    check('兜底的歌都有理由', card.songs.every((s) => !!s.reason));
    check('兜底的标签都在白名单里',
      card.songs.every((s) => ['稳准', '旁白', '私心', '小冒险'].includes(s.tag)));
  }

  // ------------------------------------------------------------
  section('⑦ 歌手分散 + 同歌不同版本折叠');
  {
    // 7a. 正常情况: 候选里歌手很多 → 每歌手最多 2 首
    const many = [];
    for (let a = 0; a < 12; a++) {
      for (let i = 0; i < 4; i++) {
        many.push({
          id: String(600 + a * 10 + i),
          name: '歌手' + a + '的歌' + i,
          artist: '歌手' + a,
          artists: [{ id: 100 + a, name: '歌手' + a }],
          album: '', cover: '', duration: 1,
        });
      }
    }
    const r1 = makeSandbox({ netease: makeNetease({ recommend: many }) });
    const card1 = await r1.sandbox.MusicDailyDiscovery.generate('chat-1');
    const maxPer = Math.max.apply(null, [0].concat(
      Array.from(new Set(card1.songs.map((s) => s.artist))).map((ar) => artistCount(card1, ar))
    ));
    check('歌手够多时每歌手最多 2 首', maxPer <= 2, 'max=' + maxPer);
    check('正常情况出了 20 首', card1.songs.length === 20, 'songs=' + card1.songs.length);

    // 7b. 极端情况: 候选里就一个歌手 → 宁可给张小卡, 也不给 10 首同一个人
    const one = [];
    for (let i = 0; i < 10; i++) {
      one.push({
        id: String(700 + i),
        name: '同一个歌手的歌' + i,
        artist: '话痨歌手',
        artists: [{ id: 11, name: '话痨歌手' }],
        album: '', cover: '', duration: 1,
      });
    }
    // Live 版: 归一化后跟第一首同名 → 应该被折叠
    one.push({
      id: '999', name: '同一个歌手的歌0 (Live)',
      artist: '话痨歌手', artists: [{ id: 11, name: '话痨歌手' }],
      album: '', cover: '', duration: 1,
    });
    const r2 = makeSandbox({ netease: makeNetease({ recommend: one }) });
    const card2 = await r2.sandbox.MusicDailyDiscovery.generate('chat-1');
    check('只有一个歌手时不超过硬上限 4 首', artistCount(card2, '话痨歌手') <= 4,
      'count=' + artistCount(card2, '话痨歌手'));
    check('Live 版被折叠掉了', !idsOf(card2).includes('999'), 'ids=' + idsOf(card2).join(','));
  }

  // ------------------------------------------------------------
  section('⑧ 当天只生成一次 (第二次读缓存)');
  {
    const recommend = [
      { id: '700', name: '缓存测试', artist: 'A', artists: [{ id: 12, name: 'A' }], album: '', cover: '', duration: 1 },
    ];
    const netease = makeNetease({ recommend });
    const { sandbox } = makeSandbox({ netease });
    const c1 = await sandbox.MusicDailyDiscovery.ensureTodayCard('chat-1');
    const c2 = await sandbox.MusicDailyDiscovery.ensureTodayCard('chat-1');
    check('两次拿到的是同一张卡', c1 && c2 && c1.id === c2.id, c1 && c1.id);
    check('卡 id 形如 chatId::日期', /^chat-1::\d{4}-\d{2}-\d{2}$/.test(c1.id), c1.id);
  }

  // ------------------------------------------------------------
  section('⑨ 卡里不存音频 URL (临时 CDN 链接会过期)');
  {
    const recommend = [
      { id: '800', name: '不留链接', artist: 'A', artists: [{ id: 13, name: 'A' }], album: '', cover: '', duration: 1 },
    ];
    const { sandbox } = makeSandbox({ netease: makeNetease({ recommend }) });
    const card = await sandbox.MusicDailyDiscovery.generate('chat-1');
    const leaked = card.songs.filter((s) => s.url || s.src);
    check('卡里没有音频 URL', leaked.length === 0, 'leaked=' + leaked.length);
    check('卡里只有元数据', !!card.songs[0].id && !!card.songs[0].name && !!card.songs[0].artist);
  }

  // ------------------------------------------------------------
  section('⑩ 反馈写进库 + 数量上限');
  {
    const { sandbox } = makeSandbox({ netease: makeNetease({ recommend: [] }) });
    const done = await sandbox.MusicDailyDiscovery.submitFeedback('chat-1', '12345', 'like', '某歌手');
    check('反馈写成功', done === true);
    const rows = sandbox.db._feedback;
    check('反馈落库了', rows.length === 1 && rows[0].action === 'like',
      JSON.stringify(rows[0] || {}));
    const bad = await sandbox.MusicDailyDiscovery.submitFeedback('chat-1', '12345', '乱写的动作', 'x');
    check('非法反馈动作被拒', bad === false);
  }

  // ------------------------------------------------------------
  section('⑪ 画像按角色分开 (账号级信号共享, 角色级信号隔离)');
  {
    // 【设计说明】画像其实是两层, 别搞混:
    //   账号级 (所有角色共享): 网易云红心、网易云歌单、330 本地歌单
    //     —— 这些本来就是同一个人的音乐库, 换个角色问也还是那些歌
    //   角色级 (每个角色分开): 反馈记录、历史推过的歌
    //     —— 这才是"不同的 AI 风格不一样"的来源
    const db = makeDb({
      feedback: [
        { id: 1, chatId: 'chat-1', songId: '1200', artist: '只给角色A的歌手', action: 'more_like_this', createdAt: 1 },
      ],
      cards: [['chat-1::2026-10-20', { id: 'chat-1::2026-10-20', chatId: 'chat-1', date: '2026-10-20', songs: [{ id: '1300', name: 'A推过', artist: 'X' }] }]],
    });
    const { sandbox } = makeSandbox({
      netease: makeNetease({
        likedIds: [],
        recommend: [],
        playlists: [{ id: 7, name: '角色A的歌单', playCount: 100, trackCount: 1 }],
        playlistTracks: {
          7: [
            { id: '1100', name: 'A的歌', artist: 'A歌手', artists: [{ id: 20, name: 'A歌手' }], album: '', cover: '', duration: 1 },
          ],
        },
      }),
      db,
      state: {
        chats: {
          'chat-1': { id: 'chat-1', name: '角色A', settings: { aiPersona: '安静' } },
          'chat-2': { id: 'chat-2', name: '角色B', settings: { aiPersona: '吵闹' } },
        },
      },
    });
    const p1 = await sandbox.MusicDailyDiscovery.buildProfile('chat-1');
    const p2 = await sandbox.MusicDailyDiscovery.buildProfile('chat-2');

    check('账号级信号: 网易云歌单的歌手对所有角色都在', p1.artistWeights.has('a歌手') && p2.artistWeights.has('a歌手'));
    check('账号级信号: 歌单名进了画像', p1.playlistNames.indexOf('角色A的歌单') >= 0);

    check('角色级隔离: 角色A 的反馈只在角色A 的画像里',
      p1.boostArtists.has('只给角色a的歌手') &&
      !p2.boostArtists.has('只给角色a的歌手'),
      'A=' + Array.from(p1.boostArtists).join(',') + ' | B=' + Array.from(p2.boostArtists).join(','));
    check('角色级隔离: 角色A 推过的歌不会排除到角色B',
      p1.knownIds.has('1300') && !p2.knownIds.has('1300'));
  }

  // ------------------------------------------------------------
  section('⑫ 防卡死三件套 (串行网络 / 无超时 / 总预算)');
  {
    // 【背景】用户在手机上实测: 打开「今日私选」一直卡在"正在挑今天的歌"没动静。
    //   根因有三个, 这里逐个钉死, 免得以后改回去:
    //     ① 候选收集里一堆串行网络调用 (8 个搜索一个一个来)
    //     ② 走主代理通道的 LLM 请求【没带 signal】→ 30 秒超时完全失效 → 永远不返回
    //     ③ 整轮生成没有总预算 → 任何一环挂住都无限等

    // ---- ① 候选收集必须并行 ----
    {
      const netease = makeNetease({
        delayMs: 15,
        likedIds: [],
        recommend: [{ id: '500', name: '推荐歌', artist: '甲', artists: [{ id: 1, name: '甲' }], album: '', cover: '', duration: 1 }],
        searchResults: [{ id: '600', name: '搜到的歌', artist: '乙', artists: [{ id: 2, name: '乙' }], album: '', cover: '', duration: 1 }],
      });
      const { sandbox } = makeSandbox({ netease });
      await sandbox.MusicDailyDiscovery.generate('chat-1');
      const s = netease._conc.search;
      check('候选搜索是并行的 (不是 8 个一个一个来)', s.max >= 2,
        'search 最大并发=' + s.max + ' 共调用 ' + s.total + ' 次');
    }

    // ---- ② 主代理通道必须带 signal ----
    {
      const { sandbox, llmRequests } = makeSandbox({
        netease: makeNetease({
          recommend: [{ id: '700', name: '歌', artist: '丙', artists: [{ id: 3, name: '丙' }], album: '', cover: '', duration: 1 }],
        }),
      });
      await sandbox.MusicDailyDiscovery.generate('chat-1');
      check('LLM 走主代理通道时请求里带了 signal (超时才有效)',
        llmRequests.length > 0 && !!llmRequests[0].signal,
        '请求数=' + llmRequests.length + ' 有signal=' + (llmRequests.length ? !!llmRequests[0].signal : false));
    }

    // ---- ③ 整轮生成有总预算, 卡住会报错而不是无限等 ----
    {
      // 造一个"永远不返回"的网易云: getLoginStatus 挂住, 整轮生成就卡在这
      const hanging = makeNetease({});
      hanging.getLoginStatus = () => new Promise(() => {});
      const timers = makeFakeTimers();
      const { sandbox } = makeSandbox({ netease: hanging, timers });

      const p = sandbox.MusicDailyDiscovery.ensureTodayCard('chat-1', { refresh: true });
      // 让它跑起来, 把超时的定时器注册上
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      timers.flush(90000);

      let err = null;
      try { await p; } catch (e) { err = e; }
      check('生成卡住时会超时报错 (不会无限等)',
        !!err && /超时/.test(String(err.message || err)),
        err ? String(err.message || err) : '没报错 —— 又能无限等了');
    }
  }

  // ------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n测试崩了:', e);
  process.exit(1);
});

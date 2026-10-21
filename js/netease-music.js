/**
 * 网易云音乐 API 封装 (前端)
 * 适配 330 music-player.js 的数据契约:
 *   search 返回 [{name, artist, id, cover, source: 'netease_real'}]
 *   getPlayableSongDetails 走 source === 'netease_real' 分支
 *
 * 走 netlify function 代理: /.netlify/functions/netease-proxy
 * Cookie 存 localStorage 'netease_music_cookie'
 *
 * 兼容性: 这是"新源"路径, 不影响原有的:
 *   - vkeys netease (source: 'netease')
 *   - toubiec
 *   - tencent
 *   - 本地文件
 *   - 用户 URL
 *
 * 关联模块: modules/music-player.js 的 addSongFromSearch / getPlayableSongDetails
 */

(function (global) {
  'use strict';

  const PROXY_URL = '/.netlify/functions/netease-proxy';
  const STORAGE_KEY = 'netease_music_cookie';
  const STORAGE_USER_KEY = 'netease_music_user';

  // localStorage 缓存 key 前缀
  const CACHE_PREFIX = 'netease_cache_';
  // 不同 action 的 TTL (ms)
  const CACHE_TTL = {
    'search': 10 * 60 * 1000,        // 10 分钟
    'song/url': 3 * 60 * 1000,        // 3 分钟 (签名 URL 5 分钟过期)
    'lyric': 24 * 60 * 60 * 1000,     // 24 小时
    'song/detail': 60 * 60 * 1000,    // 1 小时
  };

  // ====== Cookie 管理 ======
  function getCookie() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setCookie(cookie) {
    try {
      // 规范化 cookie 字符串
      const trimmed = String(cookie || '').trim();
      if (trimmed) {
        localStorage.setItem(STORAGE_KEY, trimmed);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      localStorage.removeItem(STORAGE_USER_KEY); // 改 cookie 后清掉 user 缓存
    } catch (e) {
      console.error('[netease] setCookie failed:', e);
    }
  }

  function getStoredUser() {
    try {
      const raw = localStorage.getItem(STORAGE_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setStoredUser(user) {
    try {
      if (user) {
        localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
      } else {
        localStorage.removeItem(STORAGE_USER_KEY);
      }
    } catch (e) {
      console.error('[netease] setStoredUser failed:', e);
    }
  }

  function isLoggedIn() {
    const c = getCookie();
    return c.includes('MUSIC_U=') || c.includes('MUSIC_A=');
  }

  // ====== localStorage 缓存 ======
  function getCache(key) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const { t, data } = JSON.parse(raw);
      if (Date.now() - t > (CACHE_TTL[key.split('|')[0]] || 0)) {
        localStorage.removeItem(CACHE_PREFIX + key);
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function setCache(key, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
    } catch (e) {
      // 缓存写失败不致命
    }
  }

  // ====== 核心: 调 netlify proxy =====
  // 默认 10s 超时，搜索/详情用更短（5s），避免部署环境 fetch hang 卡死
  const DEFAULT_FETCH_TIMEOUT_MS = 10000;
  async function callNetease(action, params, timeoutMs) {
    const cookie = getCookie();
    const body = { action, ...(params || {}) };
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) {
      headers['X-Netease-Cookie'] = cookie;
    }

    // 【2026-07-04 防卡死】加 AbortController，部署环境 fetch hang 时强制 abort
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || DEFAULT_FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(PROXY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      if (fetchErr.name === 'AbortError') {
        throw new Error(`[netease] ${action} timeout after ${timeoutMs || DEFAULT_FETCH_TIMEOUT_MS}ms`);
      }
      throw new Error(`[netease] ${action} fetch failed: ${fetchErr.message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[netease] ${action} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    if (json && typeof json.code === 'number' && json.code !== 200 && json.code !== 0) {
      // 网易云 API 业务错误 (比如 301 未登录, 460 IP 限流)
      const err = new Error(`[netease] ${action} business error code=${json.code}`);
      err.code = json.code;
      err.response = json;
      throw err;
    }
    return json;
  }

  // ====== 公开方法 ======

  /**
   * 搜索歌曲
   * @param {string} keyword
   * @param {number} limit 默认 30
   * @returns {Promise<Array<{name, artist, id, cover, source: 'netease_real', albumId}>>}
   */
  async function search(keyword, limit = 30) {
    const trimmed = String(keyword || '').trim();
    if (!trimmed) return [];

    const cacheKey = `search|${trimmed}|${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
      const r = await callNetease('search', { keyword: trimmed, limit });
      const songs = r?.result?.songs || [];
      const mapped = songs.map((s) => ({
        name: s.name,
        artist: Array.isArray(s.ar) ? s.ar.map((a) => a.name).join('/') : (s.ar?.[0]?.name || '未知歌手'),
        id: s.id,
        // 【2026-07-04】默认 cover 改空，CSS 已有渐变 fallback，避免 meituan URL 永远 404 触发 onerror reflow
        cover: s.al?.picUrl || '',
        source: 'netease_real',  // 区别于 vkeys 旧源的 'netease'
        albumId: s.al?.id,
        albumName: s.al?.name,
        duration: s.dt, // ms
      }));
      setCache(cacheKey, mapped);
      return mapped;
    } catch (e) {
      console.error('[netease] search failed:', e);
      return [];
    }
  }

  /**
   * 拿播放直链
   * @param {string|number} id 歌曲 ID
   * @param {string} level 音质: standard / exhigh / lossless / hires / jymaster / dolby / sky / jyeffect
   * @returns {Promise<{url: string, id: number, level: string, source: 'netease_real'} | null>}
   */
  async function getSongUrl(id, level = 'exhigh') {
    if (id == null) return null;

    const cacheKey = `song/url|${id}|${level}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
      const r = await callNetease('song/url', { id, level });
      const item = r?.data?.[0];
      if (!item || !item.url) {
        console.warn('[netease] no playable url for id', id, 'response:', r);
        return null;
      }
      const result = {
        url: item.url.replace(/^http:\/\//i, 'https://'),
        id: item.id,
        level: item.level || level,
        size: item.size,
        source: 'netease_real',
      };
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] getSongUrl failed:', e);
      return null;
    }
  }

  /**
   * 拿歌词 (LRC 格式)
   * @param {string|number} id
   * @returns {Promise<string>} LRC 文本
   */
  async function getLyric(id) {
    if (id == null) return '';

    const cacheKey = `lyric|${id}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
      const r = await callNetease('lyric', { id });
      const lrc = r?.lrc?.lyric || '';
      // 翻译歌词 (如果 API 给了)
      const tLrc = r?.tlyric?.lyric;
      let finalLrc = lrc;
      if (tLrc && lrc) {
        // 简单合并: 保留原文 + 翻译行紧跟其后
        finalLrc = lrc + '\n' + tLrc;
      } else if (tLrc) {
        finalLrc = tLrc;
      }
      setCache(cacheKey, finalLrc);
      return finalLrc;
    } catch (e) {
      console.error('[netease] getLyric failed:', e);
      return '';
    }
  }

  /**
   * 拿歌曲详情 (拿封面/歌手完整信息)
   * @param {string|number} id
   */
  async function getSongDetail(id) {
    if (id == null) return null;

    const cacheKey = `song/detail|${id}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
      const r = await callNetease('song/detail', { ids: [id] });
      const song = r?.songs?.[0];
      if (!song) return null;
      const artists = Array.isArray(song.ar) ? song.ar.map((a) => ({ id: a.id, name: a.name })) : [];
      const result = {
        name: song.name,
        artist: artists.length ? artists.map((a) => a.name).join('/') : '未知歌手',
        artists,                                  // [{id, name}, ...] 歌手数组
        id: song.id,
        cover: song.al?.picUrl,
        albumName: song.al?.name,                 // 专辑名
        albumId: song.al?.id,                     // 专辑 ID
        duration: song.dt,                        // 时长 ms
        publishTime: song.publishTime || 0,       // 发行时间 (ms 时间戳)
        // 下面这些可能没有, 安全 fallback
        fee: song.fee,                            // 0=免费 1=VIP 4=专辑购买 8=低品质免费
        noCopyrightRcmd: song.noCopyrightRcmd,    // 不可推荐 (VIP 独占)
      };
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] getSongDetail failed:', e);
      return null;
    }
  }

  /**
   * 验证当前 cookie 是否有效 + 拿登录用户信息
   */
  async function getLoginStatus() {
    if (!isLoggedIn()) return null;
    try {
      const r = await callNetease('user/account', {});
      const profile = r?.profile;
      if (!profile) return null;
      const user = {
        userId: profile.userId,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        signature: profile.signature,
      };
      setStoredUser(user);
      return user;
    } catch (e) {
      console.error('[netease] getLoginStatus failed:', e);
      return null;
    }
  }

  /**
   * 清空缓存 (换账号 / cookie 失效时调用)
   */
  function clearAllCache() {
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
      keys.forEach((k) => localStorage.removeItem(k));
    } catch (e) {
      // ignore
    }
  }

  /**
   * 登出 (清 cookie + 用户信息 + 缓存)
   */
  function logout() {
    setCookie('');
    setStoredUser(null);
    clearAllCache();
  }

  /**
   * 扫码登录 - 第一步: 拿 unikey
   * @returns {Promise<{unikey: string}>}
   */
  async function qrKey() {
    const r = await callNetease('login/qr/key', {});
    if (!r || !r.data || !r.data.unikey) {
      throw new Error('[netease] qrKey 返回无效: ' + JSON.stringify(r));
    }
    return { unikey: r.data.unikey };
  }

  /**
   * 扫码登录 - 第二步: 生成二维码 (返回 base64 PNG dataURL)
   * @param {string} key unikey
   * @returns {Promise<{qrimg: string, qrurl: string}>}
   */
  async function qrCreate(key) {
    if (!key) throw new Error('qrCreate: key is required');
    const r = await callNetease('login/qr/create', { key, qrimg: true });
    if (!r || !r.data || !r.data.qrimg) {
      throw new Error('[netease] qrCreate 返回无效: ' + JSON.stringify(r));
    }
    return { qrimg: r.data.qrimg, qrurl: r.data.qrurl };
  }

  /**
   * 扫码登录 - 第三步: 轮询扫码状态
   * @param {string} key unikey
   * @returns {Promise<{code: number, message: string, cookie?: string}>}
   *   code: 801=等待扫码, 802=已扫码待确认, 803=登录成功(返回 cookie), 880=二维码过期
   */
  async function qrCheck(key) {
    if (!key) throw new Error('qrCheck: key is required');
    const r = await callNetease('login/qr/check', { key });
    const code = r?.code ?? -1;
    const result = {
      code,
      message: r?.message || '',
      cookie: r?.cookie || '',
    };
    return result;
  }

  /**
   * 手机号登录 - 发送验证码
   * @param {string} phone 11 位手机号 (不带国际区号)
   * @param {string} ctcode 国际电话区号, 默认 86 (中国大陆)
   * @returns {Promise<{code: number, message: string, data: any}>}
   *   网易云限制: 同一 IP 1 小时最多 5 条, 同一手机号 1 天最多 5 条
   */
  async function captchaSent(phone, ctcode = '86') {
    if (!phone || !/^\d{6,15}$/.test(String(phone).replace(/\D/g, ''))) {
      throw new Error('手机号格式错误');
    }
    const r = await callNetease('captcha/sent', { phone, ctcode });
    return {
      code: r?.code ?? -1,
      message: r?.message || '',
      data: r?.data,
    };
  }

  /**
   * 手机号登录 - 验证登录
   * @param {string} phone 手机号
   * @param {string} captcha 验证码
   * @param {string} ctcode 国际区号, 默认 86
   * @returns {Promise<{code: number, message: string, cookie?: string, profile?: any}>}
   *   code=200 表示登录成功, 返回的 cookie 直接用 setCookie() 即可
   */
  async function loginCellphone(phone, captcha, ctcode = '86') {
    if (!phone || !captcha) throw new Error('手机号或验证码缺失');
    const r = await callNetease('login/cellphone', { phone, captcha, ctcode });
    const code = r?.code ?? -1;
    // 网易云返回的 cookie 在 r.cookie 字段
    return {
      code,
      message: r?.message || '',
      cookie: r?.cookie || '',
      profile: r?.profile,
      account: r?.account,
    };
  }

  /**
   * 用户歌单列表 (用户创建 + 收藏)
   * @param {number} uid 用户 ID
   * @param {number} limit 默认 30
   * @returns {Promise<Array<{id, name, coverImgUrl, trackCount, playCount, creator: {nickname, avatarUrl}}>>}
   */
  async function userPlaylist(uid, limit = 30) {
    if (uid == null) return [];
    const cacheKey = `user/playlist|${uid}|${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
      const r = await callNetease('user/playlist', { uid, limit });
      const list = r?.playlist || [];
      const result = list.map((p) => ({
        id: p.id,
        name: p.name,
        coverImgUrl: p.coverImgUrl,
        trackCount: p.trackCount,
        playCount: p.playCount,
        creator: p.creator ? { nickname: p.creator.nickname, avatarUrl: p.creator.avatarUrl } : null,
      }));
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] userPlaylist failed:', e);
      return [];
    }
  }

  /**
   * 歌单详情 (元数据, 不含歌曲)
   * @param {number|string} id 歌单 ID
   * @returns {Promise<{id, name, coverImgUrl, description, trackCount, playCount, creator, tracks: []}>}
   */
  async function playlistDetail(id) {
    if (id == null) return null;
    const cacheKey = `playlist/detail|${id}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
      const r = await callNetease('playlist/detail', { id });
      const pl = r?.playlist;
      if (!pl) return null;
      const result = {
        id: pl.id,
        name: pl.name,
        coverImgUrl: pl.coverImgUrl,
        description: pl.description || '',
        trackCount: pl.trackCount,
        playCount: pl.playCount,
        creator: pl.creator ? { nickname: pl.creator.nickname, avatarUrl: pl.creator.avatarUrl, userId: pl.creator.userId } : null,
        createTime: pl.createTime,
      };
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] playlistDetail failed:', e);
      return null;
    }
  }

  /**
   * 歌单所有歌曲 ID (用 track/all 接口, 支持大歌单)
   * @param {number|string} id 歌单 ID
   * @param {number} limit 默认 1000
   * @returns {Promise<Array<{id, name, artist, album, duration}>>}
   */
  async function playlistTracks(id, limit = 1000) {
    if (id == null) return [];
    const cacheKey = `playlist/track/all|${id}|${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
      const r = await callNetease('playlist/track/all', { id, limit });
      const songs = r?.songs || [];
      const result = songs.map((s) => ({
        id: s.id,
        name: s.name,
        artist: Array.isArray(s.ar) ? s.ar.map((a) => a.name).join('/') : '未知歌手',
        artists: Array.isArray(s.ar) ? s.ar.map((a) => ({ id: a.id, name: a.name })) : [],
        album: s.al?.name || '',
        albumId: s.al?.id,
        cover: s.al?.picUrl,
        duration: s.dt,
        fee: s.fee,
      }));
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] playlistTracks failed:', e);
      return [];
    }
  }

  /**
   * 用户红心歌曲 ID 列表
   * @param {number|string} uid 用户 ID
   * @returns {Promise<Array<number>>} 红心歌曲 ID 数组
   */
  async function likelist(uid) {
    if (uid == null) return [];
    const cacheKey = `likelist|${uid}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
      const r = await callNetease('likelist', { uid });
      const ids = r?.ids || [];
      setCache(cacheKey, ids);
      return ids;
    } catch (e) {
      console.error('[netease] likelist failed:', e);
      return [];
    }
  }

  /**
   * 用户云盘歌曲
   * @param {number} limit 默认 30
   * @param {number} offset 默认 0
   * @returns {Promise<Array<{id, name, artist, album, cover, duration, size}>>}
   */
  async function userCloud(limit = 30, offset = 0) {
    const cacheKey = `user/cloud|${limit}|${offset}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
      const r = await callNetease('user/cloud', { limit, offset });
      // 注意: api-enhanced 的返回结构可能是 data 数组, 也可能是 data.data 数组
      const list = r?.data || (Array.isArray(r) ? r : []);
      const result = list.map((s) => ({
        id: s.simpleSong?.id || s.songId || s.id,
        name: s.songName || s.name || s.simpleSong?.name,
        artist: Array.isArray(s.artist) ? s.artist : (s.artist || s.simpleSong?.ar?.[0]?.name || '未知歌手'),
        album: s.album || s.simpleSong?.al?.name || '',
        cover: s.coverUrl || s.simpleSong?.al?.picUrl,
        duration: s.duration || s.simpleSong?.dt || 0,
        size: s.size,
      })).filter((s) => s.id && s.name);
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] userCloud failed:', e);
      return [];
    }
  }

  /**
   * 用户统计 (歌单数 / 红心数 / 云盘数)
   * @returns {Promise<{playlistCount, subPlaylistCount, code, createdPlaylistCount, subCount}>}
   */
  async function userSubcount() {
    const cacheKey = 'user/subcount';
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
      const r = await callNetease('user/subcount', {});
      const result = {
        playlistCount: r?.playlistCount || 0,
        subPlaylistCount: r?.subPlaylistCount || 0,
        createdPlaylistCount: r?.createdPlaylistCount || 0,
        subCount: r?.subCount || 0,
      };
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('[netease] userSubcount failed:', e);
      return { playlistCount: 0, subPlaylistCount: 0, createdPlaylistCount: 0, subCount: 0 };
    }
  }

  // ============================================================
  // 「今日私选」需要的扩展能力 (2026-10-21)
  //
  // 背景: netease-proxy.js 的 action 白名单里【本来就有】recommend/songs、
  //   personalized、personalized/newsong、toplist、top/playlist、artist/songs,
  //   但前端一个都没接。这里把它们接上 —— 教程「两阶段策展」的第一阶段
  //   (程序先找真歌) 靠的就是这些端点。
  //
  // ⚠️ 下面所有方法一律 try/catch 吞掉错误返回空数组:
  //    策展是"锦上添花", 任何一个源挂掉都不该让整张日推卡出不来。
  // ============================================================

  // 统一的歌曲结构映射 (网易云原始 song 对象 → 紧凑结构)
  function mapSong(s) {
    if (!s || s.id == null) return null;
    const artists = Array.isArray(s.ar) ? s.ar.map((a) => ({ id: a.id, name: a.name })) : [];
    return {
      id: s.id,
      name: s.name || '未知歌曲',
      artist: artists.length ? artists.map((a) => a.name).join('/') : (s.artist || '未知歌手'),
      artists,
      album: s.al?.name || s.album || '',
      albumId: s.al?.id ?? s.albumId,
      cover: s.al?.picUrl || s.cover || '',
      duration: s.dt ?? s.duration,
      fee: s.fee,
      publishTime: s.publishTime || 0,
    };
  }

  /**
   * 批量拿歌曲详情 (省请求 —— 一次 50 首只要一次网络往返)
   * @param {Array<number|string>} ids
   * @returns {Promise<Array<Object>>}
   */
  async function getSongDetailsBatch(ids) {
    const list = (ids || []).filter((x) => x != null).slice(0, 200);
    if (!list.length) return [];
    try {
      const r = await callNetease('song/detail', { ids: list });
      const songs = r?.songs || [];
      return songs.map(mapSong).filter(Boolean);
    } catch (e) {
      console.warn('[netease] getSongDetailsBatch failed:', e);
      return [];
    }
  }

  /**
   * 并发受限地跑一批异步任务 (失败不抛, 返回 {ok, value|error})。
   * 手机上串行跑十几趟网络是"卡住不动"的头号原因 —— 宁可并行也别排着队等。
   * @param {Array<() => Promise<any>>} tasks
   * @param {number} limit 同时最多跑几个
   */
  async function runLimited(tasks, limit) {
    const list = (tasks || []).filter(Boolean);
    if (!list.length) return [];
    const results = new Array(list.length);
    let cursor = 0;
    const workers = new Array(Math.max(1, Math.min(limit || 1, list.length))).fill(0).map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= list.length) return;
        try {
          results[index] = { ok: true, value: await list[index]() };
        } catch (e) {
          results[index] = { ok: false, error: e };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * 批量拿播放直链 —— 「先验证再智能」的关键一步。
   * 只有返回了 url 的歌才算"真的能播"。
   *
   * ⚠️ /song/url/v1 的 id 参数理论上支持逗号分隔, 但万一上游不认,
   *    批量结果会少歌 —— 所以这里做了兜底: 批量拿不到的, 逐首再试一次。
   * @param {Array<number|string>} ids
   * @param {string} level 音质
   * @returns {Promise<Array<{id, url, level, size}>>} 只有能播的才在数组里
   */
  async function getSongUrlsBatch(ids, level = 'exhigh') {
    const list = (ids || []).filter((x) => x != null).slice(0, 200);
    if (!list.length) return [];

    const playable = [];
    const found = new Set();
    // 【关键】分开记两件事:
    //   returned = 上游【提到过】这个 id (不管有没有 url)
    //   found    = 这个 id 【有可播 url】
    // 上游返回了但 url 为 null = 这首歌本来就不可播 (没版权 / 非 VIP / 地区限制),
    // 逐首再问一遍也是白问 —— 只有"上游压根没提到这个 id"才值得单发一次。
    // ⚠️ 之前没分这两种, 导致每批 15 次串行重试, 手机上能卡好几分钟。
    const returned = new Set();
    try {
      const r = await callNetease('song/url', { ids: list, level });
      const data = Array.isArray(r?.data) ? r.data : [];
      data.forEach((item) => {
        if (!item || item.id == null) return;
        const key = String(item.id);
        returned.add(key);
        if (item.url) {
          playable.push({
            id: item.id,
            url: String(item.url).replace(/^http:\/\//i, 'https://'),
            level: item.level || level,
            size: item.size,
          });
          found.add(key);
        }
      });
    } catch (e) {
      console.warn('[netease] getSongUrlsBatch (batch) failed:', e);
    }

    // 兜底: 只对【上游压根没提到】的 id 单发一次, 最多补 8 首 (免得请求爆炸)
    // ⚠️ 单发必须并行 —— 串行 8 次最坏能拖 80 秒, 手机上就是"转圈转不出结果"。
    const missing = list
      .map((id) => String(id))
      .filter((id) => !returned.has(id))
      .slice(0, 8);
    const singles = await runLimited(
      missing.map((id) => () => getSongUrl(id, level)),
      4
    );
    singles.forEach((r) => {
      if (r && r.ok && r.value && r.value.url) playable.push(r.value);
    });
    return playable;
  }

  /**
   * 每日推荐 (需要登录态)
   * @returns {Promise<Array<Object>>}
   */
  async function recommendSongs() {
    try {
      const r = await callNetease('recommend/songs', {});
      const list = r?.data?.dailySongs || r?.dailySongs || [];
      return list.map(mapSong).filter(Boolean);
    } catch (e) {
      console.warn('[netease] recommendSongs failed:', e);
      return [];
    }
  }

  /**
   * 推荐新音乐 —— 用户大概率没听过, 是"惊喜"的主要来源
   * @returns {Promise<Array<Object>>}
   */
  async function personalizedNewsong() {
    try {
      const r = await callNetease('personalized/newsong', {});
      const list = r?.result?.personalized || r?.personalized || [];
      return list.map(mapSong).filter(Boolean);
    } catch (e) {
      console.warn('[netease] personalizedNewsong failed:', e);
      return [];
    }
  }

  /**
   * 推荐歌单 (只取歌单本身, 歌曲由调用方自己去 playlistTracks 拿)
   * @returns {Promise<Array<{id, name, playCount, coverImgUrl}>>}
   */
  async function personalizedPlaylists(limit = 30) {
    try {
      const r = await callNetease('personalized', { limit });
      const list = r?.result?.playlist || r?.playlist || [];
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        playCount: p.playCount || 0,
        trackCount: p.trackCount || 0,
        coverImgUrl: p.coverImgUrl || '',
      })).filter((p) => p.id != null);
    } catch (e) {
      console.warn('[netease] personalizedPlaylists failed:', e);
      return [];
    }
  }

  /**
   * 排行榜列表
   * @returns {Promise<Array<{id, name}>>}
   */
  async function toplist() {
    try {
      const r = await callNetease('toplist', {});
      const list = r?.list || r?.result?.list || [];
      return list.map((t) => ({ id: t.id, name: t.name, coverImgUrl: t.coverImgUrl || '' }))
        .filter((t) => t.id != null);
    } catch (e) {
      console.warn('[netease] toplist failed:', e);
      return [];
    }
  }

  /**
   * 排行榜里的歌
   * @param {number} id 榜单 ID
   * @returns {Promise<Array<Object>>}
   */
  async function topPlaylistTracks(id) {
    if (id == null) return [];
    try {
      const r = await callNetease('top/playlist', { id });
      const list = r?.tracks || r?.playlist || [];
      return list.map(mapSong).filter(Boolean);
    } catch (e) {
      console.warn('[netease] topPlaylistTracks failed:', e);
      return [];
    }
  }

  /**
   * 某个歌手的歌 —— 从画像歌手往外扩的主要手段
   * @param {number} artistId
   * @returns {Promise<Array<Object>>}
   */
  async function artistSongs(artistId, limit = 50, offset = 0) {
    if (artistId == null) return [];
    try {
      const r = await callNetease('artist/songs', { id: artistId, limit, offset });
      const list = r?.songs || r?.hotSongs || r?.result?.songs || [];
      return list.map(mapSong).filter(Boolean);
    } catch (e) {
      console.warn('[netease] artistSongs failed:', e);
      return [];
    }
  }

  // ====== 暴露到 window ======
  global.NeteaseMusic = {
    // 状态
    isLoggedIn,
    getLoginStatus,
    getStoredUser,
    // Cookie
    getCookie,
    setCookie,
    logout,
    // 业务
    search,
    getSongUrl,
    getLyric,
    getSongDetail,
    clearAllCache,
    // 扫码登录
    qrKey,
    qrCreate,
    qrCheck,
    // 手机号登录
    captchaSent,
    loginCellphone,
    // 用户主页
    userPlaylist,
    playlistDetail,
    playlistTracks,
    likelist,
    userCloud,
    userSubcount,
    // 「今日私选」扩展 (2026-10-21)
    getSongDetailsBatch,
    getSongUrlsBatch,
    recommendSongs,
    personalizedNewsong,
    personalizedPlaylists,
    toplist,
    topPlaylistTracks,
    artistSongs,
    // 常量
    PROXY_URL,
    SOURCE_TAG: 'netease_real',
  };

  // ====== 自动初始化: 绑定登录 UI ======
  function initNeteaseLoginUI() {
    const btn = document.getElementById('netease-login-btn');
    const modal = document.getElementById('netease-login-modal');
    const close = document.getElementById('netease-login-close');
    const input = document.getElementById('netease-cookie-input');
    const saveBtn = document.getElementById('netease-cookie-save-btn');
    const testBtn = document.getElementById('netease-cookie-test-btn');
    const clearBtn = document.getElementById('netease-cookie-clear-btn');
    const status = document.getElementById('netease-login-status');
    const qualitySelect = document.getElementById('netease-quality-select');

    // 扫码登录元素
    const tabs = document.querySelectorAll('.netease-login-tab');
    const tabQr = document.getElementById('netease-tab-qr');
    const tabCookie = document.getElementById('netease-tab-cookie');
    const tabPhone = document.getElementById('netease-tab-phone');
    const qrPlaceholder = document.getElementById('netease-qr-placeholder');
    const qrActive = document.getElementById('netease-qr-active');
    const qrImg = document.getElementById('netease-qr-img');
    const qrHint = document.getElementById('netease-qr-hint');
    const qrStatus = document.getElementById('netease-qr-status');
    const qrStartBtn = document.getElementById('netease-qr-start-btn');
    const qrCancelBtn = document.getElementById('netease-qr-cancel-btn');
    // 手机号登录元素
    const phoneInput = document.getElementById('netease-phone-input');
    const captchaInput = document.getElementById('netease-captcha-input');
    const captchaSendBtn = document.getElementById('netease-captcha-send-btn');
    const phoneLoginBtn = document.getElementById('netease-phone-login-btn');

    let qrPollTimer = null;  // 扫码轮询句柄, 关闭 modal 时清掉
    let captchaCountdownTimer = null;  // 验证码 60s 倒计时

    if (!btn || !modal) {
      // DOM 还没好, 等一下
      return false;
    }

    // 读 cookie 回填
    const existing = getCookie();
    if (input) input.value = existing;

    // 读音质回填
    const savedQuality = (() => {
      try { return localStorage.getItem('netease_music_quality') || 'exhigh'; } catch (e) { return 'exhigh'; }
    })();
    if (qualitySelect) qualitySelect.value = savedQuality;

    // 刷新状态文字
    function refreshStatus(user) {
      if (!status) return;
      if (user && user.nickname) {
        status.textContent = `已登录: ${user.nickname} (ID: ${user.userId})`;
        status.style.color = '#c20c0c';
      } else if (isLoggedIn()) {
        status.textContent = '已登录 (Cookie 待验证)';
        status.style.color = '#c20c0c';
      } else {
        status.textContent = '未登录 - 粘贴 cookie 后保存';
        status.style.color = '#999';
      }
    }

    // 打开 modal 或网易云 App (智能: 已登录直接进 App, 未登录弹登录)
    btn.addEventListener('click', async function () {
      // 先做一次快速登录态检查 (有 cookie 就算登录)
      if (isLoggedIn()) {
        // 已登录 → 直接打开网易云 App (跳过登录 modal)
        if (global.NeteaseMusicApp && global.NeteaseMusicApp.open) {
          global.NeteaseMusicApp.open();
          return;
        }
      }
      // 未登录 或 NeteaseMusicApp 未加载 → 弹登录 modal
      modal.classList.add('visible');
      // 用缓存的 user 立即刷新, 异步验证
      const cachedUser = getStoredUser();
      refreshStatus(cachedUser);
      // 异步验证
      try {
        const user = await getLoginStatus();
        if (user) refreshStatus(user);
      } catch (e) {
        // ignore
      }
    });

    // 关闭 modal
    if (close) {
      close.addEventListener('click', () => { modal.classList.remove('visible'); stopQrPoll(); });
    }
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.classList.remove('visible'); stopQrPoll(); }
    });

    // 保存 cookie
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        const value = input ? input.value.trim() : '';
        if (!value) {
          status.textContent = '请先粘贴 cookie';
          status.style.color = '#f60';
          return;
        }
        setCookie(value);
        if (input) input.value = value;
        status.textContent = '已保存, 正在验证...';
        status.style.color = '#999';
        try {
          const user = await getLoginStatus();
          refreshStatus(user);
        } catch (e) {
          status.textContent = `保存成功但验证失败: ${e.message || e}`;
          status.style.color = '#f60';
        }
      });
    }

    // 测试当前 cookie
    if (testBtn) {
      testBtn.addEventListener('click', async function () {
        if (!isLoggedIn()) {
          status.textContent = '请先粘贴并保存 cookie';
          status.style.color = '#f60';
          return;
        }
        status.textContent = '正在测试...';
        status.style.color = '#999';
        try {
          const user = await getLoginStatus();
          if (user) {
            refreshStatus(user);
          } else {
            status.textContent = 'Cookie 已失效, 请重新粘贴';
            status.style.color = '#f00';
          }
        } catch (e) {
          status.textContent = `测试失败: ${e.message || e}`;
          status.style.color = '#f00';
        }
      });
    }

    // 清空 cookie
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        logout();
        if (input) input.value = '';
        status.textContent = '已清空';
        status.style.color = '#999';
      });
    }

    // 音质变更
    if (qualitySelect) {
      qualitySelect.addEventListener('change', function () {
        try { localStorage.setItem('netease_music_quality', qualitySelect.value); } catch (e) {}
      });
    }

    // ====== Tab 切换 ======
    tabs.forEach((t) => {
      t.addEventListener('click', function () {
        const target = t.getAttribute('data-tab');
        tabs.forEach((tt) => tt.classList.toggle('active', tt === t));
        if (tabQr) tabQr.classList.toggle('active', target === 'qr');
        if (tabCookie) tabCookie.classList.toggle('active', target === 'cookie');
        if (tabPhone) tabPhone.classList.toggle('active', target === 'phone');
        // 切到 cookie / phone tab 时停掉扫码轮询
        if (target === 'cookie' || target === 'phone') stopQrPoll();
      });
    });

    // ====== 扫码登录 ======
    function stopQrPoll() {
      if (qrPollTimer) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
      }
    }

    function resetQrUI() {
      if (qrPlaceholder) qrPlaceholder.style.display = '';
      if (qrActive) qrActive.style.display = 'none';
      if (qrStatus) { qrStatus.textContent = '等待扫码...'; qrStatus.style.color = '#c0d4e8'; }
    }

    function showQrError(text) {
      if (qrStatus) {
        qrStatus.textContent = text;
        qrStatus.style.color = '#ff7066';
      }
    }

    async function startQrLogin() {
      try {
        // 1. 拿 unikey
        if (qrStatus) { qrStatus.textContent = '正在生成二维码...'; qrStatus.style.color = '#c0d4e8'; }
        const { unikey } = await qrKey();
        // 2. 拿 base64 二维码
        const { qrimg } = await qrCreate(unikey);
        // 3. 显示
        if (qrImg) qrImg.src = qrimg;
        if (qrPlaceholder) qrPlaceholder.style.display = 'none';
        if (qrActive) qrActive.style.display = '';
        if (qrStatus) { qrStatus.textContent = '请用网易云 App 扫码'; qrStatus.style.color = '#7eb8e8'; }
        // 4. 开始轮询 (2.5s 一次, 跟糯米机一致)
        stopQrPoll();
        let expired = false;
        const expireTimer = setTimeout(() => {
          expired = true;
          stopQrPoll();
          showQrError('二维码已过期, 请点击"取消"后重新生成');
        }, 180000); // 3 分钟过期
        qrPollTimer = setInterval(async () => {
          if (expired) return;
          try {
            const result = await qrCheck(unikey);
            if (result.code === 801) {
              if (qrStatus) { qrStatus.textContent = '等待扫码...'; qrStatus.style.color = '#c0d4e8'; }
            } else if (result.code === 802) {
              if (qrStatus) { qrStatus.textContent = '已扫码, 请在手机上点击"确认登录"'; qrStatus.style.color = '#7eb8e8'; }
            } else if (result.code === 803) {
              // 登录成功!
              clearTimeout(expireTimer);
              stopQrPoll();
              if (result.cookie) {
                setCookie(result.cookie);
                if (qrStatus) { qrStatus.textContent = '登录成功! 正在获取用户信息...'; qrStatus.style.color = '#7eb8e8'; }
                // 验证
                try {
                  const user = await getLoginStatus();
                  if (user) {
                    refreshStatus(user);
                    if (qrStatus) qrStatus.textContent = `登录成功: ${user.nickname}`;
                  } else {
                    if (qrStatus) qrStatus.textContent = '登录成功 (获取用户信息失败)';
                  }
                } catch (e) {
                  // ignore
                }
                // 1.5 秒后自动关闭 modal
                setTimeout(() => {
                  modal.classList.remove('visible');
                  stopQrPoll();
                  resetQrUI();
                }, 1500);
              } else {
                showQrError('登录成功但未返回 cookie, 请改用手动粘贴');
              }
            } else if (result.code === 880) {
              clearTimeout(expireTimer);
              stopQrPoll();
              showQrError('二维码已过期, 请点击"取消"后重新生成');
            } else {
              // 其他状态 (-460 等), 不显示错误, 继续轮询
              console.warn('[netease] qrCheck unexpected code:', result.code, result.message);
            }
          } catch (e) {
            console.error('[netease] qrCheck error:', e);
            showQrError('轮询失败: ' + (e.message || e));
          }
        }, 2500);
      } catch (e) {
        console.error('[netease] startQrLogin failed:', e);
        showQrError('生成二维码失败: ' + (e.message || e));
      }
    }

    if (qrStartBtn) {
      qrStartBtn.addEventListener('click', startQrLogin);
    }
    if (qrCancelBtn) {
      qrCancelBtn.addEventListener('click', function () {
        stopQrPoll();
        resetQrUI();
      });
    }

    // ====== 手机号登录 ======
    function stopCaptchaCountdown() {
      if (captchaCountdownTimer) {
        clearInterval(captchaCountdownTimer);
        captchaCountdownTimer = null;
      }
      if (captchaSendBtn) {
        captchaSendBtn.disabled = false;
        captchaSendBtn.textContent = '发送验证码';
      }
    }

    function startCaptchaCountdown(seconds) {
      if (!captchaSendBtn) return;
      let left = seconds;
      captchaSendBtn.disabled = true;
      captchaSendBtn.textContent = `${left}s 后重发`;
      captchaCountdownTimer = setInterval(() => {
        left--;
        if (left <= 0) {
          stopCaptchaCountdown();
        } else {
          captchaSendBtn.textContent = `${left}s 后重发`;
        }
      }, 1000);
    }

    if (captchaSendBtn) {
      captchaSendBtn.addEventListener('click', async function () {
        const phone = phoneInput ? phoneInput.value.trim().replace(/\D/g, '') : '';
        if (!phone || !/^\d{11}$/.test(phone)) {
          if (global.showCustomAlert) global.showCustomAlert('格式错误', '请输入 11 位中国大陆手机号');
          return;
        }
        if (captchaSendBtn.disabled) return;
        captchaSendBtn.disabled = true;
        captchaSendBtn.textContent = '发送中...';
        try {
          const r = await captchaSent(phone, '86');
          if (r.code === 200) {
            startCaptchaCountdown(60);
            if (global.showCustomAlert) {
              global.showCustomAlert('已发送', `验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)}, 请查收短信`);
            }
            if (captchaInput) captchaInput.focus();
          } else {
            captchaSendBtn.disabled = false;
            captchaSendBtn.textContent = '发送验证码';
            if (global.showCustomAlert) {
              const hint = r.code === 501
                ? '该手机号不是网易云注册用户'
                : r.code === 301
                  ? '请求过于频繁, 请稍后再试'
                  : `错误码 ${r.code}: ${r.message}`;
              global.showCustomAlert('发送失败', hint);
            }
          }
        } catch (e) {
          captchaSendBtn.disabled = false;
          captchaSendBtn.textContent = '发送验证码';
          if (global.showCustomAlert) global.showCustomAlert('发送失败', e.message || String(e));
        }
      });
    }

    if (phoneLoginBtn) {
      phoneLoginBtn.addEventListener('click', async function () {
        const phone = phoneInput ? phoneInput.value.trim().replace(/\D/g, '') : '';
        const captcha = captchaInput ? captchaInput.value.trim() : '';
        if (!phone || !/^\d{11}$/.test(phone)) {
          if (global.showCustomAlert) global.showCustomAlert('格式错误', '请输入 11 位手机号');
          return;
        }
        if (!captcha || !/^\d{4,6}$/.test(captcha)) {
          if (global.showCustomAlert) global.showCustomAlert('格式错误', '请输入 4-6 位验证码');
          return;
        }
        phoneLoginBtn.disabled = true;
        phoneLoginBtn.textContent = '登录中...';
        try {
          const r = await loginCellphone(phone, captcha, '86');
          if (r.code === 200 && r.cookie) {
            setCookie(r.cookie);
            stopCaptchaCountdown();
            if (global.showCustomAlert) {
              const nick = r.profile?.nickname || r.account?.userName || '已登录';
              global.showCustomAlert('登录成功', `欢迎, ${nick}!`);
            }
            // 验证
            try {
              const user = await getLoginStatus();
              if (user) refreshStatus(user);
            } catch (e) {}
            // 1.5s 后关闭
            setTimeout(() => {
              modal.classList.remove('visible');
              stopQrPoll();
              stopCaptchaCountdown();
              if (captchaInput) captchaInput.value = '';
              if (phoneLoginBtn) {
                phoneLoginBtn.disabled = false;
                phoneLoginBtn.textContent = '登录';
              }
            }, 1500);
          } else {
            phoneLoginBtn.disabled = false;
            phoneLoginBtn.textContent = '登录';
            if (global.showCustomAlert) {
              const hint = r.code === 501
                ? '该手机号不是网易云注册用户'
                : r.code === 401
                  ? '验证码错误或已过期'
                  : r.code === 301
                    ? '请求过于频繁'
                    : `错误码 ${r.code}: ${r.message || '登录失败'}`;
              global.showCustomAlert('登录失败', hint);
            }
          }
        } catch (e) {
          phoneLoginBtn.disabled = false;
          phoneLoginBtn.textContent = '登录';
          if (global.showCustomAlert) global.showCustomAlert('登录失败', e.message || String(e));
        }
      });
    }

    // 启动时: 如果有缓存 user, 后台静默验证一次 (cookie 可能已失效)
    if (isLoggedIn()) {
      getLoginStatus().then((user) => {
        if (!user) {
          console.warn('[netease] 后台验证失败, MUSIC_U cookie 可能已失效');
        }
      }).catch(() => {});
    }

    return true;
  }

  // DOM ready 后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNeteaseLoginUI);
  } else {
    // 已经 ready, 立即调用一次; 失败则说明 DOM 还没好, 0ms 后重试
    if (!initNeteaseLoginUI()) {
      setTimeout(initNeteaseLoginUI, 50);
    }
  }
})(window);

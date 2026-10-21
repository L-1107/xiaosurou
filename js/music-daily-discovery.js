/**
 * music-daily-discovery.js — 「今日私选」(AI 每日荐歌)
 *
 * 概念来源: Cove「一起听歌」架构指南 (2026-10-21 审计) 里的「今日私选」两阶段策展。
 *   阶段一 (本文件的程序部分): 找真实存在的歌 → 验证真的能播 → 清洗去重
 *   阶段二 (本文件的 LLM 部分): LLM 只在白名单候选里【排序 + 写理由】, 绝不发明歌曲
 *
 * 与 330 现状的对应关系:
 *   - 音源适配层  → js/netease-music.js (本文件只调它, 不直接碰 netlify proxy)
 *   - 共同状态    → Dexie db.dailyDiscovery / db.dailyDiscoveryFeedback (db v70)
 *   - 播放        → 复用 modules/music-player.js 的 playSong / playTemporaryNeteaseTrack
 *                    (一条播放链路, 不造第二个播放器)
 *   - LLM         → 复用 state.apiConfig 的 chat/completions 通道
 *
 * 用户定下的几条硬要求 (2026-10-21):
 *   1. 画像【按角色(chatId)分】 —— 不同 AI 风格不一样
 *   2. 【打开 App 时生成 + 推送】, 不要搞服务器
 *   3. 每天要【有惊喜】, 而且【不要从红心里选歌】(用户说红心里的歌听腻了)
 *   4. 反馈【必须真生效】, 要真的影响下一次的推荐
 *
 * ⚠️ 卡里【不存音频 URL】—— 网易云 CDN 链接几分钟就过期, 存下来必然是死链。
 *    只存 songId + 元数据, 真正播放时走 music-player.js 已有的 refreshNeteaseTrackUrl() 现取现用。
 */

(function (global) {
  'use strict';

  const NM = () => global.NeteaseMusic;

  const CFG = {
    targetCount: 20,          // 最终出多少首
    maxQueries: 8,            // 最多几个搜索查询 (再多是浪费 —— 每次都要跑一趟网络)
    maxCandidates: 100,       // 喂给 LLM 的候选上限
    verifyBatch: 50,          // 批量验可播的批大小
    verifyConcurrency: 3,     // 验可播的批并发数
    searchConcurrency: 4,     // 搜索并发数
    maxPerArtist: 2,          // 每位歌手最多几首
    maxPerArtistBoost: 4,     // 被"多推这种"的歌手放宽到几首
    maxPerArtistHard: 4,      // 硬上限 —— 凑不够歌时最多放宽到这么多, 再多宁可给张小卡
    llmTimeoutMs: 30000,      // LLM 策展超时
    totalTimeoutMs: 90000,    // 整轮生成的总预算 —— 到了就停, 绝不无限等
    feedbackLimit: 500,       // 反馈最多留多少条
    startupDelayMs: 6000,     // App 启动后等多久开始生成
    tagWhitelist: ['稳准', '旁白', '私心', '小冒险'],
    // 探索用的风格词 —— 从用户口味往旁边挪一点, 制造"惊喜"
    exploreWords: ['华语新歌', '独立民谣', 'city pop', '深夜', '卧室', '治愈系'],
  };

  /**
   * 并发受限地跑一批异步任务 —— 手机上串行跑十几趟网络是卡死的头号原因。
   * @param {Array<() => Promise<any>>} tasks
   * @param {number} limit 同时最多跑几个
   */
  async function runWithConcurrency(tasks, limit) {
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
   * 给一整轮生成套上"总预算" —— 无论中间哪一环挂住,
   * 到点必须抛错, 绝不让界面无限转圈。
   *
   * ⚠️ 这里 race 的只是"等待", 底下那趟活可能还在跑;
   *    但对界面来说, 报个错比永远转圈强一万倍。
   */
  function withDeadline(promise, ms, label) {
    if (!ms || ms <= 0) return promise;
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label || '生成'}超时 (${Math.round(ms / 1000)}秒), 已中止`));
      }, ms);
    });
    return Promise.race([promise, guard]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  // 反馈规则: 权重改动 + 是否把这首歌永久排除
  const FEEDBACK_RULES = {
    'like':           { weight: +2, excludeSong: true,  hardAvoidArtist: false },
    'heard':          { weight: 0,  excludeSong: true,  hardAvoidArtist: false },
    'more_like_this': { weight: +3, excludeSong: false, hardAvoidArtist: false },
    'less_like_this': { weight: -3, excludeSong: false, hardAvoidArtist: false },
    'dislike':        { weight: -5, excludeSong: true,  hardAvoidArtist: true  },
  };

  const FEEDBACK_LABELS = {
    'like': '喜欢',
    'heard': '听过了',
    'more_like_this': '多推这种',
    'less_like_this': '少推这种',
    'dislike': '不喜欢',
  };

  // 生成中防并发 (同一时间只允许一轮)
  const inflight = new Map();

  // ============================================================
  // 小工具
  // ============================================================
  function todayKey(d) {
    const dt = d ? new Date(d) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }

  function cardId(chatId, date) {
    return `${chatId}::${date}`;
  }

  function getDb() {
    return global.db || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normArtist(s) {
    return String(s || '').trim().toLowerCase();
  }

  /** 曲名归一化: 去掉 (Live) / [Explicit] / -Remix 这类后缀, 用来折叠同一首歌的不同版本 */
  function normTitle(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\[（(【](live|remix|explicit|cover|instrumental|伴奏|现场版?|翻唱|高音质|完整版)[\]）)】]/g, ' ')
      .replace(/[-–—]\s*(live|remix|explicit|cover|instrumental|伴奏)\s*$/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveChatId() {
    const st = global.state;
    if (!st) return null;
    if (st.activeChatId && st.chats && st.chats[st.activeChatId]) return st.activeChatId;
    // 没有活跃聊天时, 只有一个角色就直接用它
    if (st.chats) {
      const ids = Object.keys(st.chats);
      if (ids.length === 1) return ids[0];
    }
    return null;
  }

  function getPreferredQuality() {
    try { return localStorage.getItem('netease_music_quality') || 'exhigh'; } catch (e) { return 'exhigh'; }
  }

  // ============================================================
  // 存储
  // ============================================================
  async function loadCard(chatId, date) {
    const db = getDb();
    if (!db || !db.dailyDiscovery) return null;
    try {
      return await db.dailyDiscovery.get(cardId(chatId, date));
    } catch (e) {
      console.warn('[daily-discovery] loadCard failed:', e);
      return null;
    }
  }

  async function saveCard(card) {
    const db = getDb();
    if (!db || !db.dailyDiscovery) return false;
    try {
      await db.dailyDiscovery.put(card);
      return true;
    } catch (e) {
      console.warn('[daily-discovery] saveCard failed:', e);
      return false;
    }
  }

  async function loadFeedback(chatId) {
    const db = getDb();
    if (!db || !db.dailyDiscoveryFeedback) return [];
    try {
      return await db.dailyDiscoveryFeedback.where('chatId').equals(chatId).toArray();
    } catch (e) {
      console.warn('[daily-discovery] loadFeedback failed:', e);
      return [];
    }
  }

  async function addFeedback(chatId, songId, artist, action) {
    const db = getDb();
    if (!db || !db.dailyDiscoveryFeedback) return false;
    if (!FEEDBACK_RULES[action]) return false;
    try {
      await db.dailyDiscoveryFeedback.add({
        chatId,
        songId: String(songId),
        artist: String(artist || ''),
        action,
        createdAt: Date.now(),
      });
      // 超量就砍掉最老的
      const total = await db.dailyDiscoveryFeedback.count();
      if (total > CFG.feedbackLimit) {
        const old = await db.dailyDiscoveryFeedback.orderBy('createdAt').limit(total - CFG.feedbackLimit).primaryKeys();
        if (old.length) await db.dailyDiscoveryFeedback.bulkDelete(old);
      }
      return true;
    } catch (e) {
      console.warn('[daily-discovery] addFeedback failed:', e);
      return false;
    }
  }

  /** 历史上推过的歌 —— 明天不能再推 */
  async function loadPushedSongIds(chatId) {
    const db = getDb();
    const ids = new Set();
    if (!db || !db.dailyDiscovery) return ids;
    try {
      const cards = await db.dailyDiscovery.where('chatId').equals(chatId).toArray();
      cards.forEach((c) => {
        (c.songs || []).forEach((s) => ids.add(String(s.id)));
      });
    } catch (e) {
      console.warn('[daily-discovery] loadPushedSongIds failed:', e);
    }
    return ids;
  }

  // ============================================================
  // 画像 (按角色 chatId 分)
  // ============================================================
  function bumpArtist(profile, artistName, weight, artistId) {
    const key = normArtist(artistName);
    if (!key) return;
    const prev = profile.artistWeights.get(key) || { name: String(artistName), id: artistId || null, weight: 0 };
    prev.weight += weight;
    if (artistId) prev.id = artistId;
    profile.artistWeights.set(key, prev);
  }

  async function buildProfile(chatId) {
    const profile = {
      chatId,
      likedIds: new Set(),      // 红心 —— 明确不要从里面选
      knownIds: new Set(),      // 本地歌单 / 历史日推 / 反馈排除 —— 不能再推
      artistWeights: new Map(),
      topArtists: [],
      avoidArtists: new Set(),  // 不喜欢 → 硬排除该歌手
      downArtists: new Set(),   // 少推这种 → 降权但保留
      boostArtists: new Set(),  // 多推这种 → 放宽上限
      playlistNames: [],
      stats: { liked: 0, playlists: 0, local: 0, pushed: 0, feedback: 0 },
    };

    // ---- 1. 网易云侧 ----
    let user = null;
    try {
      const api = NM();
      if (api && typeof api.getLoginStatus === 'function') user = await api.getLoginStatus();
    } catch (e) { /* 没登录就只走本地信号 */ }

    if (user && user.userId != null) {
      const api = NM();
      // 1.1 红心 —— 记 id (要排除), 再批量拿详情统计歌手
      try {
        const likedIds = await api.likelist(user.userId);
        profile.stats.liked = likedIds.length;
        likedIds.forEach((id) => profile.likedIds.add(String(id)));
        const details = await api.getSongDetailsBatch(likedIds.slice(0, 150));
        details.forEach((s) => {
          (s.artists || []).forEach((a) => bumpArtist(profile, a.name, 1.5, a.id));
        });
      } catch (e) { console.warn('[daily-discovery] likelist failed:', e); }

      // 1.2 网易云歌单 —— 歌单名本身也是口味信号
      //     ⚠️ 歌单之间【并行】拉 —— 串行 5 趟网络在手机上就是十几秒白等
      try {
        const pls = await api.userPlaylist(user.userId, 30);
        profile.stats.playlists = pls.length;
        const top = pls.slice().sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 5);
        top.forEach((pl) => { if (pl.name) profile.playlistNames.push(pl.name); });
        const results = await runWithConcurrency(
          top.map((pl) => () => api.playlistTracks(pl.id, 150)),
          5
        );
        results.forEach((r) => {
          if (!r || !r.ok || !Array.isArray(r.value)) return;
          r.value.forEach((t) => {
            (t.artists || []).forEach((a) => bumpArtist(profile, a.name, 1, a.id));
          });
        });
      } catch (e) { console.warn('[daily-discovery] userPlaylist failed:', e); }
    }

    // ---- 2. 330 本地歌单 (用户自己加进去的) ----
    try {
      const db = getDb();
      if (db && db.musicLibrary) {
        const lib = await db.musicLibrary.get('main');
        const tracks = (lib && lib.playlist) || [];
        profile.stats.local = tracks.length;
        tracks.forEach((t) => {
          if (t && t.source === 'netease_real' && t.id != null) profile.knownIds.add(String(t.id));
          if (t && t.artist) bumpArtist(profile, t.artist, 1.5, null);
        });
      }
    } catch (e) { console.warn('[daily-discovery] local library failed:', e); }

    // ---- 3. 历史日推 ----
    const pushed = await loadPushedSongIds(chatId);
    pushed.forEach((id) => profile.knownIds.add(id));
    profile.stats.pushed = pushed.size;

    // ---- 4. 反馈 (真生效的地方) ----
    const feedback = await loadFeedback(chatId);
    profile.stats.feedback = feedback.length;
    feedback.forEach((fb) => {
      const rule = FEEDBACK_RULES[fb.action];
      if (!rule) return;
      if (rule.excludeSong && fb.songId != null) profile.knownIds.add(String(fb.songId));
      if (fb.artist) {
        bumpArtist(profile, fb.artist, rule.weight, null);
        const key = normArtist(fb.artist);
        if (fb.action === 'more_like_this') profile.boostArtists.add(key);
        else if (fb.action === 'less_like_this') profile.downArtists.add(key);
        else if (fb.action === 'dislike') profile.avoidArtists.add(key);
      }
    });

    // ---- 5. 排序歌手 ----
    profile.topArtists = Array.from(profile.artistWeights.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
      .map((a) => ({ id: a.id, name: a.name, weight: a.weight }));

    return profile;
  }

  // ============================================================
  // 候选收集 (程序找真歌)
  // ============================================================
  function normalizeSong(s, src) {
    if (!s || s.id == null) return null;
    return {
      id: String(s.id),
      name: s.name || '未知歌曲',
      artist: s.artist || '未知歌手',
      artists: s.artists || [],
      album: s.album || s.albumName || '',
      albumId: s.albumId,
      cover: s.cover || '',
      duration: s.duration || 0,
      fee: s.fee,
      src,
    };
  }

  function buildQueries(profile) {
    const queries = [];
    // 歌单名 (去掉"歌单/精选"这类噪声词)
    profile.playlistNames.slice(0, 3).forEach((n) => {
      const cleaned = String(n || '')
        .replace(/歌单|精选|私人|收藏|合集|电台|favou?rite/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length >= 2) queries.push(cleaned.slice(0, 12));
    });
    // 画像歌手名 —— 精准扩歌的主要手段
    profile.topArtists.slice(0, 4).forEach((a) => {
      if (a.name) queries.push(a.name);
    });
    // 探索词 —— 制造惊喜
    CFG.exploreWords.slice(0, 2).forEach((w) => queries.push(w));

    // 去重 + 限流
    const seen = new Set();
    const out = [];
    queries.forEach((q) => {
      const key = q.toLowerCase();
      if (!q || seen.has(key)) return;
      seen.add(key);
      out.push(q);
    });
    return out.slice(0, CFG.maxQueries);
  }

  async function collectCandidates(profile) {
    const api = NM();
    if (!api) throw new Error('网易云模块没加载');

    const jobs = [];

    // 1. 每日推荐 —— 基于红心生成, 质量最高, 但不是红心本身 (过滤后正是"像你但你没加过")
    jobs.push((async () => {
      const songs = await api.recommendSongs();
      return songs.map((s) => normalizeSong(s, 'recommend')).filter(Boolean);
    })());

    // 2. 推荐新音乐 —— 惊喜主力
    jobs.push((async () => {
      const songs = await api.personalizedNewsong();
      return songs.map((s) => normalizeSong(s, 'newsong')).filter(Boolean);
    })());

    // 3. 推荐歌单里的歌
    jobs.push((async () => {
      const pls = await api.personalizedPlaylists(30);
      const top = pls.slice().sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 3);
      const out = [];
      const res = await runWithConcurrency(
        top.map((pl) => () => api.playlistTracks(pl.id, 100)),
        3
      );
      res.forEach((r, i) => {
        if (!r || !r.ok || !Array.isArray(r.value)) return;
        r.value.forEach((t) => { const n = normalizeSong(t, 'personalized'); if (n) out.push(n); });
      });
      return out;
    })());

    // 4. 排行榜 —— 经典但多半没听过
    jobs.push((async () => {
      const lists = await api.toplist();
      const out = [];
      const res = await runWithConcurrency(
        lists.slice(0, 2).map((l) => () => api.topPlaylistTracks(l.id)),
        2
      );
      res.forEach((r) => {
        if (!r || !r.ok || !Array.isArray(r.value)) return;
        r.value.forEach((t) => { const n = normalizeSong(t, 'toplist'); if (n) out.push(n); });
      });
      return out;
    })());

    // 5. 画像歌手的歌 —— 精准扩歌
    jobs.push((async () => {
      const out = [];
      const artists = profile.topArtists.filter((a) => a.id != null).slice(0, 5);
      const res = await runWithConcurrency(
        artists.map((a) => () => api.artistSongs(a.id, 50, 0)),
        3
      );
      res.forEach((r) => {
        if (!r || !r.ok || !Array.isArray(r.value)) return;
        r.value.forEach((s) => { const n = normalizeSong(s, 'artist'); if (n) out.push(n); });
      });
      return out;
    })());

    // 6. 搜索 —— 歌单词 / 歌手名 / 探索词
    jobs.push((async () => {
      const out = [];
      const queries = buildQueries(profile);
      const res = await runWithConcurrency(
        queries.map((q) => () => api.search(q, 20)),
        CFG.searchConcurrency
      );
      res.forEach((r) => {
        if (!r || !r.ok || !Array.isArray(r.value)) return;
        r.value.forEach((s) => { const n = normalizeSong(s, 'search'); if (n) out.push(n); });
      });
      return out;
    })());

    const settled = await Promise.allSettled(jobs);
    const all = [];
    settled.forEach((r) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value);
      else if (r.status === 'rejected') console.warn('[daily-discovery] candidate source failed:', r.reason);
    });
    return all;
  }

  // ============================================================
  // 验证可播 (先验证, 再智能)
  // ============================================================
  async function verifyPlayable(candidates) {
    const api = NM();
    const level = getPreferredQuality();
    const chunks = [];
    for (let i = 0; i < candidates.length; i += CFG.verifyBatch) {
      chunks.push(candidates.slice(i, i + CFG.verifyBatch));
    }

    // 分批并行 (每批内部还有一层单发兜底) —— 串行 batches 在手机上就是卡死
    const results = await runWithConcurrency(
      chunks.map((chunk) => async () => {
        const ids = chunk.map((c) => c.id);
        let playable = [];
        try {
          playable = await api.getSongUrlsBatch(ids, level);
        } catch (e) {
          console.warn('[daily-discovery] verify chunk failed:', e);
          return [];
        }
        const okIds = new Set(playable.map((p) => String(p.id)));

        // 降级: 拿不到 exhigh 的, 用 standard 再试一次 (教程 Ch6.2 的有序回退)
        const failed = chunk.filter((c) => !okIds.has(c.id));
        if (failed.length && level !== 'standard') {
          try {
            const fallback = await api.getSongUrlsBatch(failed.map((c) => c.id), 'standard');
            fallback.forEach((p) => okIds.add(String(p.id)));
          } catch (e) { /* 降级失败就算了 */ }
        }

        return chunk.filter((c) => okIds.has(c.id));
      }),
      CFG.verifyConcurrency
    );

    const out = [];
    results.forEach((r) => {
      if (r && r.ok && Array.isArray(r.value)) out.push(...r.value);
    });
    return out;
  }

  // ============================================================
  // 清洗 (去重 / 排除 / 折叠版本 / 歌手分散)
  // ============================================================
  const SRC_PRIORITY = { recommend: 0, artist: 1, newsong: 2, personalized: 3, search: 4, toplist: 5 };

  function cleanCandidates(candidates, profile) {
    // 1. id 去重 + 排除已知 (红心 / 本地歌单 / 历史日推 / 反馈排除过)
    const byId = new Map();
    candidates.forEach((c) => {
      const id = String(c.id);
      if (profile.knownIds.has(id)) return;
      if (profile.likedIds.has(id)) return;
      const prev = byId.get(id);
      if (!prev) { byId.set(id, c); return; }
      // 同一首歌来自多个源, 留来源更靠前的
      if ((SRC_PRIORITY[c.src] ?? 9) < (SRC_PRIORITY[prev.src] ?? 9)) byId.set(id, c);
    });

    // 2. 硬排除的歌手 (不喜欢 → 这位歌手的歌完全不推)
    let list = Array.from(byId.values()).filter((c) => {
      const names = (c.artists || []).map((a) => normArtist(a.name));
      if (!names.length) names.push(normArtist(c.artist));
      return !names.some((n) => profile.avoidArtists.has(n));
    });

    // 3. 折叠同歌不同版本 (Live / Remix / 伴奏...)
    const byVersion = new Map();
    list.forEach((c) => {
      const key = `${normTitle(c.name)}|${normArtist(c.artist)}`;
      const prev = byVersion.get(key);
      if (!prev) { byVersion.set(key, c); return; }
      if ((SRC_PRIORITY[c.src] ?? 9) < (SRC_PRIORITY[prev.src] ?? 9)) byVersion.set(key, c);
    });
    list = Array.from(byVersion.values());

    // 4. 歌手分散 —— 少推这种的降权, 多推这种的放宽
    const artistKeyOf = (c) => {
      const names = (c.artists || []).map((a) => normArtist(a.name));
      return names.length ? names[0] : normArtist(c.artist);
    };
    const weightOf = (c) => {
      const w = profile.artistWeights.get(artistKeyOf(c));
      let v = w ? w.weight : 0;
      if (profile.downArtists.has(artistKeyOf(c))) v -= 10;
      if (profile.boostArtists.has(artistKeyOf(c))) v += 10;
      return v;
    };
    // 先按权重降序 —— 权重高的排前面, 但 LLM 可以推翻顺序
    list.sort((a, b) => weightOf(b) - weightOf(a));

    // 【歌手上限怎么放宽】默认每歌手 2 首。凑不够 20 首时逐步放宽到 3、4 首,
    // 但【绝不】无限堆 —— 极端情况 (候选里就一个歌手) 给一张 4 首的小卡,
    // 也不给一张 10 首同一个歌手的卡 (那不叫日推, 叫刷歌单)。
    const capped = [];
    const count = new Map();
    let limit = CFG.maxPerArtist;
    let pool = list.slice();
    while (pool.length && capped.length < CFG.maxCandidates) {
      const next = [];
      for (const c of pool) {
        if (capped.length >= CFG.maxCandidates) { next.push(c); continue; }
        const key = artistKeyOf(c);
        const lim = profile.boostArtists.has(key) ? CFG.maxPerArtistBoost : limit;
        const used = count.get(key) || 0;
        if (used >= lim) { next.push(c); continue; }
        count.set(key, used + 1);
        capped.push(c);
      }
      if (!next.length) break;
      pool = next;
      if (limit < CFG.maxPerArtistHard) limit++;
      else break;   // 到硬上限了 —— 剩下的一律不要, 宁可卡小一点
    }
    return capped;
  }

  // ============================================================
  // LLM 策展 (只排序 + 写理由, 绝不发明歌曲)
  // ============================================================
  function buildCurationPrompt(pool, profile, targetCount) {
    const artists = profile.topArtists.slice(0, 6).map((a) => a.name).join('、');
    const lists = profile.playlistNames.slice(0, 4).join('、');
    const likes = profile.boostArtists.size
      ? `用户明确说过"多推这种"的歌手: ${Array.from(profile.boostArtists).slice(0, 3).join('、')}`
      : '';
    const dislikes = profile.downArtists.size
      ? `用户说过"少推这种"的歌手: ${Array.from(profile.downArtists).slice(0, 3).join('、')}`
      : '';

    const persona = getPersonaHint(profile.chatId);

    const compact = pool.map((c) => ({
      id: Number(c.id),
      name: c.name,
      artist: c.artist,
      album: c.album || '',
    }));

    return [
      persona,
      '你是一个给用户挑歌的策展助手。你自己就是那个陪伴用户的人，所以挑歌要带着你自己的性子，但必须先保证歌曲真实存在。',
      '',
      '# 用户的口味参考（只用来判断方向，不要从这些歌里选）',
      artists ? `- 常出现的歌手: ${artists}` : '',
      lists ? `- 歌单名: ${lists}` : '',
      likes,
      dislikes,
      '- 用户明确说过: 听腻了自己红心里选过的歌。红心里的歌【已经全部排除】，下面的候选都是他没加过的。',
      '',
      '# 候选歌曲（只能从这里选，不许发明任何歌）',
      JSON.stringify(compact),
      '',
      '# 规则',
      `1. 挑 ${targetCount} 首, id 必须原样来自上面的候选列表`,
      '2. 这批歌要有惊喜 —— 用户要的是没听过的新东西, 优先选候选里相对陌生、但气质对得上的',
      '3. 但也要留 3-5 首贴近上面的口味参考, 整体不要跑偏到跟他完全无关的东西',
      '4. 同一个歌手最多 2 首 (除非用户说过"多推这种")',
      '5. 每首写一句推荐理由: 中文, 25 字以内, 要具体说清为什么推给他, 不要写"很好听""必听"这种空话',
      '6. 每首给一个标签, 只能从这四个里选: 稳准、旁白、私心、小冒险',
      '7. 最后写一句开场 note: 中文, 25 字以内, 像是这个角色自己说的话',
      '',
      '# 输出格式（只输出 JSON，不要任何解释文字）',
      '{"note":"...","songs":[{"id":123,"reason":"...","tag":"小冒险"}]}',
    ].filter((l) => l !== undefined).join('\n');
  }

  function getPersonaHint(chatId) {
    try {
      const st = global.state;
      const chat = st && st.chats && st.chats[chatId];
      if (!chat) return '';
      const name = chat.name || chat.settings?.aiName || '陪伴者';
      const persona = String(chat.settings?.aiPersona || '').replace(/\s+/g, ' ').trim();
      const excerpt = persona ? persona.slice(0, 220) : '';
      return excerpt
        ? `# 你的身份\n你是「${name}」。${excerpt}\n挑选推荐理由时用你的语气和视角。`
        : `# 你的身份\n你是「${name}」，用户的陪伴者。挑选推荐理由时用你的语气和视角。`;
    } catch (e) {
      return '';
    }
  }

  async function callLLM(prompt) {
    const st = global.state || {};
    const cfg = st.apiConfig || {};
    const proxyUrl = cfg.proxyUrl;
    const apiKey = cfg.apiKey;
    const model = cfg.model;
    if (!proxyUrl || !apiKey) throw new Error('AI 接口没配置 (apiConfig.proxyUrl / apiKey)');

    const isGemini = String(proxyUrl).includes('generativelanguage.googleapis.com');
    const useMainApiProxy = !isGemini
      && typeof global.fetchViaOpenAICompatibleProxy === 'function'
      && typeof global.isMainApiProxyEnabled === 'function'
      && global.isMainApiProxyEnabled();

    const messages = [{ role: 'user', content: prompt }];
    const payload = { model, messages, temperature: 0.9 };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.llmTimeoutMs);

    try {
      let response;
      if (isGemini) {
        if (typeof global.toGeminiRequestData === 'function') {
          const g = global.toGeminiRequestData(model, apiKey, '', messages);
          response = await fetch(g.url, { ...g.data, signal: ctrl.signal });
        } else {
          response = await fetch(
            `${String(proxyUrl).replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: messages }),
              signal: ctrl.signal,
            }
          );
        }
      } else if (useMainApiProxy) {
        response = await global.fetchViaOpenAICompatibleProxy({
          baseUrl: proxyUrl,
          targetPath: '/chat/completions',
          apiKey,
          payload,
          method: 'POST',
          // ⚠️ 必须传 signal —— 漏了的话主代理通道【完全没有超时】,
          //    网络一挂就永远不返回, 手机上就是"正在挑今天的歌"转圈转到天荒地老。
          signal: ctrl.signal,
        });
      } else {
        response = await fetch(`${String(proxyUrl).replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`LLM 策展失败: HTTP ${response.status} ${String(errText).slice(0, 160)}`);
      }
      const json = await response.json();
      const text =
        json?.choices?.[0]?.message?.content ??
        json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ??
        '';
      if (!text) throw new Error('LLM 返回空内容');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 从模型输出里捞 JSON。
   * 真模型不一定乖乖只吐一个 JSON —— 它可能:
   *   - 用 ```json 包起来
   *   - 前后加一段解释文字
   *   - 吐两个 JSON 块
   *   - 直接吐一个数组而不是对象
   * 所以这里都试一遍, 别因为格式脏就丢掉一整轮策展。
   */
  function tryParseJsonSlice(s, open, close) {
    const start = s.indexOf(open);
    if (start < 0) return null;
    let end = s.lastIndexOf(close);
    let tries = 0;
    while (end > start && tries < 6) {
      try {
        const parsed = JSON.parse(s.slice(start, end + 1));
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (e) { /* 换个结尾符再试 */ }
      end = s.lastIndexOf(close, end - 1);
      tries++;
    }
    return null;
  }

  function parseLLMJson(text) {
    if (!text) return null;
    let s = String(text).trim();
    // 去掉 ```json / ``` 包裹
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

    // 先试对象 (期望的格式)
    const obj = tryParseJsonSlice(s, '{', '}');
    if (obj && !Array.isArray(obj)) return obj;

    // 再试数组 (模型直接吐歌单数组)
    const arr = tryParseJsonSlice(s, '[', ']');
    if (Array.isArray(arr)) return { note: '', songs: arr };

    return null;
  }

  /** LLM 结果校验 —— 只接受白名单里的 id */
  function validateLLMResult(raw, pool, targetCount) {
    if (!raw || !Array.isArray(raw.songs)) return null;
    const byId = new Map(pool.map((c) => [String(c.id), c]));
    const used = new Set();
    const artistUsed = new Map();
    const songs = [];

    raw.songs.forEach((s) => {
      if (!s || s.id == null) return;
      const key = String(s.id);
      if (!byId.has(key)) return;      // 发明出来的 id → 丢掉
      if (used.has(key)) return;       // 重复 → 丢掉
      const meta = byId.get(key);
      // 教程 Ch17: LLM 的结果要再过一次多样性校验 —— 同一个歌手不能超上限
      const akey = normArtist(meta.artist);
      const aUsed = artistUsed.get(akey) || 0;
      if (aUsed >= CFG.maxPerArtistHard) return;
      artistUsed.set(akey, aUsed + 1);
      used.add(key);
      let reason = String(s.reason || '').replace(/\s+/g, ' ').trim();
      if (reason.length > 40) reason = reason.slice(0, 40);
      if (!reason) reason = `来自 ${meta.artist}，跟你最近在听的很搭。`;
      let tag = String(s.tag || '').trim();
      if (!CFG.tagWhitelist.includes(tag)) tag = '旁白';
      songs.push({
        id: key,
        name: meta.name,
        artist: meta.artist,
        artists: meta.artists || [],
        album: meta.album || '',
        albumId: meta.albumId,
        cover: meta.cover || '',
        duration: meta.duration || 0,
        fee: meta.fee,
        reason,
        tag,
      });
    });

    if (!songs.length) return null;
    const note = String(raw.note || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    const limit = targetCount || songs.length;
    return { note, songs: songs.slice(0, limit) };
  }

  /** 确定性兜底 —— LLM 挂了也要能出卡 (教程 Ch17.1) */
  function deterministicPick(pool, profile, targetCount, excludeIds) {
    const songs = [];
    const used = new Set(Array.from(excludeIds || []).map(String));
    // 轮流从不同歌手取, 保证分散
    const byArtist = new Map();
    pool.forEach((c) => {
      const key = normArtist(c.artist);
      if (!byArtist.has(key)) byArtist.set(key, []);
      byArtist.get(key).push(c);
    });
    const groups = Array.from(byArtist.values());
    let round = 0;
    while (songs.length < targetCount && round < 10) {
      let added = false;
      for (const g of groups) {
        if (songs.length >= targetCount) break;
        const c = g[round];
        if (!c || used.has(String(c.id))) continue;
        used.add(String(c.id));
        const isBoost = profile.boostArtists.has(normArtist(c.artist));
        songs.push({
          id: String(c.id),
          name: c.name,
          artist: c.artist,
          artists: c.artists || [],
          album: c.album || '',
          albumId: c.albumId,
          cover: c.cover || '',
          duration: c.duration || 0,
          fee: c.fee,
          reason: `来自 ${c.artist}，跟你最近在听的是同一个方向。`,
          tag: isBoost ? '私心' : (round === 0 ? '稳准' : '小冒险'),
        });
        added = true;
      }
      if (!added) break;
      round++;
    }
    const note = '今天这组往外多走了两步，挑了些你没听过的。';
    return { note, songs };
  }

  // 格式不对时的追加指令 —— 只在【输出解析不出来】时追加一次, 让模型重来一遍
  const STRICT_FORMAT_SUFFIX = [
    '',
    '【重要】上一条输出没能被解析出来。这次只输出一个 JSON 对象, 第一个字符必须是 {, 最后一个字符必须是 },',
    '中间不要加任何说明文字, 不要用 markdown 代码块, id 用数字。',
    '格式: {"note":"...","songs":[{"id":123,"reason":"...","tag":"小冒险"}]}',
  ].join('\n');

  async function curate(pool, profile, targetCount) {
    if (!pool.length) return null;
    const prompt = buildCurationPrompt(pool, profile, targetCount);

    // 最多试两次:
    //   第 1 次正常问; 解析不出来 → 第 2 次追加"只吐 JSON"的硬要求再问一次
    //   网络失败/超时 → 不重试 (再问一次也还是不通, 直接兜底)
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = '';
      try {
        text = await callLLM(attempt === 0 ? prompt : prompt + STRICT_FORMAT_SUFFIX);
      } catch (e) {
        console.warn('[daily-discovery] LLM 调用失败, 走确定性兜底:', (e && e.message) || e);
        break;
      }

      const raw = parseLLMJson(text);
      const valid = validateLLMResult(raw, pool, targetCount);
      if (valid) {
        // 数量不够就用剩下的候选确定性补齐
        if (valid.songs.length < targetCount) {
          const used = new Set(valid.songs.map((s) => s.id));
          const extra = deterministicPick(pool, profile, targetCount - valid.songs.length, used);
          extra.songs.forEach((s) => {
            if (used.has(s.id) || valid.songs.length >= targetCount) return;
            used.add(s.id);
            valid.songs.push(s);
          });
        }
        if (attempt > 0) console.log('[daily-discovery] LLM 重试后成功');
        return valid;
      }
      console.warn(attempt === 0
        ? '[daily-discovery] LLM 输出格式不对, 重试一次'
        : '[daily-discovery] LLM 重试后还是不对, 走确定性兜底');
    }
    return deterministicPick(pool, profile, targetCount);
  }

  // ============================================================
  // 主流程
  // ============================================================
  async function generate(chatId, options) {
    const opts = options || {};
    const api = NM();
    if (!api) throw new Error('网易云模块没加载');

    const profile = await buildProfile(chatId);
    const rawCandidates = await collectCandidates(profile);
    if (!rawCandidates.length) throw new Error('没找到候选歌曲 (可能是没登录或网络不通)');

    const playable = await verifyPlayable(rawCandidates);
    const cleaned = cleanCandidates(playable, profile);
    if (!cleaned.length) throw new Error('候选里没有能播的歌 (可能是 VIP 限制或登录态失效)');

    const curated = await curate(cleaned, profile, CFG.targetCount);
    if (!curated || !curated.songs.length) throw new Error('策展没产出任何歌曲');

    const date = todayKey();
    const card = {
      id: cardId(chatId, date),
      chatId,
      date,
      title: '今日私选',
      subtitle: `今天往外找了 ${curated.songs.length} 首不在你红心里的歌`,
      note: curated.note || '',
      generatedAt: Date.now(),
      strategy: {
        targetCount: CFG.targetCount,
        rawCandidateCount: rawCandidates.length,
        playableCount: playable.length,
        poolCount: cleaned.length,
        excludedKnownCount: profile.knownIds.size + profile.likedIds.size,
        feedbackCount: profile.stats.feedback,
        llmRanked: true,
      },
      songs: curated.songs,
      seen: false,
    };

    await saveCard(card);
    return card;
  }

  /**
   * 拿到今天的卡 —— 有就用, 没有就现生成。
   * @param {string} chatId
   * @param {{refresh?: boolean}} options refresh=true = 「换一批」
   */
  async function ensureTodayCard(chatId, options) {
    const opts = options || {};
    const id = chatId || resolveChatId();
    if (!id) throw new Error('没有可用的角色 (chatId)');

    if (!opts.refresh) {
      const cached = await loadCard(id, todayKey());
      if (cached && cached.songs && cached.songs.length) return cached;
    }

    // 防并发: 同一个角色同时只跑一轮
    if (inflight.has(id)) return inflight.get(id);
    const raw = generate(id, opts);
    // 底下那趟活跑完再清 inflight —— 万一超时了, 别让第二轮重复开一整趟活
    raw.catch(() => {}).finally(() => { inflight.delete(id); });
    const p = withDeadline(raw, CFG.totalTimeoutMs, '今日私选');
    inflight.set(id, p);
    return p;
  }

  // ============================================================
  // 推送 (系统通知 + App 内 toast)
  // ============================================================
  function openDailyTab() {
    try {
      if (global.NeteaseMusicApp && typeof global.NeteaseMusicApp.open === 'function') {
        global.NeteaseMusicApp.open({ initialTab: 'daily' });
        return true;
      }
    } catch (e) {
      console.warn('[daily-discovery] openDailyTab failed:', e);
    }
    return false;
  }

  function notifyUser(card) {
    if (!card || !card.songs || !card.songs.length) return;
    const count = card.songs.length;

    // 1) App 内 toast —— 一定看得到
    try {
      if (typeof global.showToast === 'function') {
        global.showToast(`今日私选已就绪 · ${count} 首`, 'success');
      }
    } catch (e) { /* ignore */ }

    // 2) 系统通知 —— 必须先听总开关 (v0.2.18 那个 bypass bug 的教训)
    const cfg = global.state?.globalSettings?.systemNotification;
    if (!cfg?.enabled) {
      console.log('[daily-discovery] 系统通知总开关关闭, 只走 App 内提示');
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      console.log('[daily-discovery] 通知权限未授权, 只走 App 内提示');
      return;
    }
    try {
      const n = new Notification('今日私选', {
        body: `今天给你挑了 ${count} 首不在红心里的歌`,
        tag: `daily-discovery-${card.date}`,
        renotify: false,
      });
      n.onclick = () => {
        try { global.focus && global.focus(); } catch (e) { /* ignore */ }
        openDailyTab();
        n.close();
      };
    } catch (e) {
      console.warn('[daily-discovery] 系统通知失败:', e);
    }
  }

  // ============================================================
  // 启动触发
  // ============================================================
  let startupDone = false;

  async function startupCheck(options) {
    const opts = options || {};
    if (startupDone && !opts.force) return null;
    startupDone = true;

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        console.log('[daily-discovery] 离线, 跳过');
        return null;
      }
      const api = NM();
      if (!api || typeof api.isLoggedIn !== 'function' || !api.isLoggedIn()) {
        console.log('[daily-discovery] 没登录网易云, 跳过');
        return null;
      }
      let chatId = resolveChatId();
      if (!chatId) {
        // state 可能还没从 DB 加载完, 稍后再试一次
        await new Promise((r) => setTimeout(r, 8000));
        chatId = resolveChatId();
      }
      if (!chatId) {
        console.log('[daily-discovery] 找不到角色, 跳过');
        return null;
      }

      const date = todayKey();
      let card = await loadCard(chatId, date);
      if (card && card.songs && card.songs.length) {
        if (!card.seen) {
          card.seen = true;
          await saveCard(card);
          notifyUser(card);
        }
        return card;
      }

      // 今天还没有 → 后台生成 (不阻塞界面)
      console.log('[daily-discovery] 今天还没生成, 开始生成...');
      card = await generate(chatId);
      card.seen = true;
      await saveCard(card);
      notifyUser(card);
      return card;
    } catch (e) {
      console.warn('[daily-discovery] startupCheck failed:', e);
      return null;
    }
  }

  function scheduleStartup() {
    const run = () => setTimeout(() => { startupCheck(); }, CFG.startupDelayMs);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
    // 回到前台时也看一眼 (可能跨过午夜了)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      setTimeout(() => { startupDone = false; startupCheck(); }, 1500);
    });
  }

  // ============================================================
  // 反馈
  // ============================================================
  async function submitFeedback(chatId, songId, action, artist) {
    const id = chatId || resolveChatId();
    if (!id) return false;
    if (!FEEDBACK_RULES[action]) return false;
    const ok = await addFeedback(id, songId, artist, action);
    if (ok) {
      console.log(`[daily-discovery] 记录反馈 ${action} -> ${artist}`);
    }
    return ok;
  }

  function feedbackLabels() {
    return Object.assign({}, FEEDBACK_LABELS);
  }

  // ============================================================
  // 暴露
  // ============================================================
  global.MusicDailyDiscovery = {
    ensureTodayCard,
    generate,
    getTodayCard: (chatId) => loadCard(chatId || resolveChatId(), todayKey()),
    submitFeedback,
    feedbackLabels,
    buildProfile,
    openDailyTab,
    notifyUser,
    startupCheck,
    resolveChatId,
    todayKey,
    CFG,
  };

  scheduleStartup();
})(window);

// ============================================================================
// cinema-storage.js — 330 Cinema Room 影片存储层 (v0.1.0)
//
// 【为什么有这个模块】
// 330 旧观影 (init-features.js:4442) 保存本地视频时走的是:
//     FileReader.readAsDataURL(file) -> 32MB base64 字符串 -> IndexedDB
// 24MB 视频 -> base64 膨胀 4/3 = 32MB 字符串, 结构化克隆时再复制一份,
// 回放时 fetch(dataURL) 又要重新解析一遍。手机上峰值 100MB+, 必然 OOM 崩溃。
//
// 【本模块的铁律】
//   视频本体永远不读进 JS 堆。存 Blob/File 对象本身 —— 浏览器结构化克隆时
//   直接落盘, 堆占用 O(1), 跟文件多大无关。播放时 createObjectURL 拿引用。
//
//   绝对禁止: readAsDataURL / btoa / fetch(dataURL) / new File([dataUrl])
//
// 【三张表为什么要拆开】
//   cinemaFilms    纯元数据 (id/name/size/type/addedAt), 绝不含 Blob。
//                  拆开是因为 Dexie toArray() 会把整条记录反序列化 ——
//                  元数据混着 Blob 的话, 列一次片单就把所有视频读进内存。
//   cinemaBlobs    { id, file } —— File 对象直存, 只有取单片时才读。
//   cinemaProgress { filmId, currentTime, duration, updatedAt } —— 纯数字。
//
// 【对照参考】KI-CO (CinemaCompanionRoom.tsx:1218) 在 Web/PWA 下用
//   URL.createObjectURL(file) 播放, 但从不持久化视频本体, 刷新后要用户
//   重选同名文件 (:1615)。本模块要补的就是它没做的这一层。
// ============================================================================

(function (global) {
  'use strict';

  const FILMS = 'cinemaFilms';
  const BLOBS = 'cinemaBlobs';
  const PROGRESS = 'cinemaProgress';
  // 人物立绘表 (db v66)。常量提到最上面 —— ensureCharTable() 会用,
  // 放在文件下面会撞 const 的 TDZ (声明前访问直接 ReferenceError)。
  const CHARS = 'cinemaChars';
  // 短剧前情提要表 (db v68, 2026-10-15)。理由见文件末尾注释块。
  const SERIES_RECAP = 'cinemaSeriesRecap';

  // 300MB 软警告线 —— 超过只提示, 不阻止 (用户 2026-10-04 决策)。
  // iOS PWA 长期存储配额常在 1GB 量级, 硬拦会让人存不进东西。
  const SOFT_WARN_BYTES = 300 * 1024 * 1024;

  function newId() {
    return (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : 'cine_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // 等 330 的 db 打开完成。init-data-protection.js:70 挂了 window.dbReadyPromise。
  async function whenDbReady() {
    if (global.dbReadyPromise) {
      try { await global.dbReadyPromise; } catch (e) { /* 下面统一再判一次 */ }
    }
    const db = global.db;
    if (!db) throw new Error('CinemaStorage: 330 db 未初始化');
    if (!db[FILMS] || !db[BLOBS] || !db[PROGRESS]) {
      throw new Error('CinemaStorage: Cinema Room 数据表缺失 (db schema 未升级到 v65)');
    }
    return db;
  }

  // --------------------------------------------------------------------------
  // 人物表自愈 (2026-10-04 18:00 真机事故)
  //
  // 【出了什么事】加了 db.version(66) 建 cinemaChars, 但忘了 bump index.html 里
  // init-db-schema.js 的 ?v=。Service Worker 一直吐缓存里的旧版 → 手机上 Dexie
  // 压根不知道有 v66 → cinemaChars 永远不建 → 上传人物直接报"数据表缺失"。
  //
  // 【为什么要有自愈】?v= 漏 bump 这类事故只要一次就够受的。这里做一层兜底:
  // 发现表不在, 就用 Dexie 的 schema API 现场把版本顶上去并建表 —— 用户最多
  // 刷新一次就能用, 不用等我们再发一版。写操作不依赖这张表, 所以不会牵连影片。
  //
  // 【为什么不自动重建整个 db】db.version(66) 只声明新增表, 不改任何已有表,
  // 所以 upgrade 是纯增量, 不会丢用户数据 —— 这是 Dexie 文档保证的。
  // --------------------------------------------------------------------------
  // 🔴 2026-10-21: 三处补表自愈 (v66 人物 / v68 前情提要 / v69 逐条) 必须【排队】。
  //
  // 【真事故】用户实测截图: "存不下 / 影片没能存进本地数据库:
  //   DatabaseClosedError: Database has been closed" —— 人物图、影片、道具全存不进去,
  //   整页刷新之前全都好不了。
  //
  // 【根因】三处自愈都要对【同一个库】做 close() → version() → open()。
  //   两个撞在一起时, 后一个的 close() 会把前一个【正在进行的 open 取消掉】
  //   (Dexie 的 close() 在 isBeingOpened 时会 cancelOpen)。
  //   结果库停在这种状态:
  //       autoOpen=false  openComplete=true  idbdb=false  dbOpenError=DatabaseClosedError
  //   这个状态下【任何】数据库操作都直接抛 Database has been closed,
  //   而且永远恢复不了 —— 因为 openComplete 还是 true, Dexie 认为"库已经开好了"。
  //
  // 【为什么昨天才炸】v69 那张表是 2026-10-19 才加的。
  //   之前只有 v66 一个自愈(每次开房跑一次), 撞不起来;
  //   加上 v68/v69 之后, 一开房就有三个自愈同时跑 → 必踩。
  //
  // 【两道防线】
  //   ① 根子上: 沙盒库把表声明齐(cinema-sandbox/index.html), 就【根本不会自愈】。
  //   ② 这里: 三处自愈排队跑, 顺便把 close() 改成 close({disableAutoOpen:false}) ——
  //      那个参数让 close 不取消别人的 open, 也不把 autoOpen 关掉。
  // --------------------------------------------------------------------------
  let healChain = Promise.resolve();
  function runHeal(fn) {
    // 前一个失败也要让后一个继续 (then(fn, fn) 的第二个参数就是"失败时也往下走")
    const run = healChain.then(fn, fn);
    healChain = run.then(function () {}, function () {});
    return run;
  }

  // --------------------------------------------------------------------------
  let charsHealing = null;
  async function ensureCharTable() {
    const db = await whenDbReady();
    if (db[CHARS]) return db[CHARS];
    if (!charsHealing) {
      charsHealing = runHeal(async function () {
        try {
          // ⚠️ 必须先 close() —— Dexie 不允许在库【已打开】时加版本号,
          //    否则直接抛 SchemaError: Cannot add version when database is open。
          //    (第一版自愈合在这, 真机一走兜底就报错, 是这次测试抓出来的。)
          //    close 之后 db.open() 会由 330 自己的 dbReadyPromise 那条链重新拉起来,
          //    这里紧接着自己 open 一次, 不用等别的地方。
          //
          // 🔴 2026-10-21 必须传 { disableAutoOpen: false }!!
          //    Dexie 的 db.close() 默认是 disableAutoOpen: true —— 它会把
          //    state.autoOpen 设成 false(这个库从此不会自动重开),
          //    还会把 openComplete 留在 true 而 idbdb 已经置空 ——
          //    那个状态下再做任何操作都是 Database has been closed, 永远好不了。
          //    (详细原因见上面 runHeal 那段注释)
          try { db.close({ disableAutoOpen: false }); } catch (e) { /* 本来就没开 */ }

          db.version(66).stores({ [CHARS]: '&id, updatedAt' });
          await db.open();
          if (db[CHARS]) {
            console.warn('[CinemaStorage] 人物表缺失, 已现场补建 v66');
            return db[CHARS];
          }
        } catch (e) {
          console.error('[CinemaStorage] 人物表补建失败', (e && e.name) || '', (e && e.message) || e);
        }
        return null;
      });
    }
    return charsHealing;
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[^/.]+$/, '');
  }

  // --------------------------------------------------------------------------
  // 短剧前情提要 (db v68)
  //
  // 【表里存什么】每部短剧一份跨场底稿:
  //   { key, title, text, lastEp, createdAt, updatedAt }
  //   key = 短剧文件夹名 (duanju-bridge server.mjs 的 dir.name), 稳定可做主键。
  //
  // 【为什么要自愈】跟 cinemaChars 一模一样的坑: 加了 db.version(68) 却忘了 bump
  // index.html 里 init-db-schema.js 的 ?v=, Service Worker 一直吐旧版 → 手机上
  // Dexie 不知道有 v68 → 表永远不建。写操作全部走兜底, 不影响别的功能。
  //
  // 【为什么设 MAX_RECAP_CHARS 上限】短剧能到几百集, 每次退出重写一次,
  // 不限长的话前情提要自己就会膨胀成噪音, 而且会被整段喂回模型。超了砍尾巴。
  // --------------------------------------------------------------------------

  const MAX_RECAP_CHARS = 1800;

  let recapHealing = null;
  async function ensureSeriesRecapTable() {
    const db = await whenDbReady();
    if (db[SERIES_RECAP]) return db[SERIES_RECAP];
    if (!recapHealing) {
      recapHealing = runHeal(async function () {
        try {
          // ⚠️ 必须先 close() —— Dexie 不允许在库已打开时加版本号 (同 ensureCharTable)
          // 🔴 2026-10-21: 必须传 { disableAutoOpen: false } —— 默认的 close()
          //    会把【自动重开库】永久关掉, 还会留下 openComplete=true 的脏状态,
          //    之后所有写入都抛 Database has been closed。
          //    详细原因见 ensureCharTable() 那段注释。
          try { db.close({ disableAutoOpen: false }); } catch (e) { /* 本来就没开 */ }
          db.version(68).stores({ [SERIES_RECAP]: '&key, updatedAt' });
          await db.open();
          if (db[SERIES_RECAP]) {
            console.warn('[CinemaStorage] 前情提要表缺失, 已现场补建 v68');
            return db[SERIES_RECAP];
          }
        } catch (e) {
          console.error('[CinemaStorage] 前情提要表补建失败', (e && e.name) || '', (e && e.message) || e);
        }
        return null;
      });
    }
    return recapHealing;
  }

  /** 读某部剧的前情提要。表缺失/读失败 → null (绝不让影院因为它打不开)。
   *
   * 🔴 2026-10-21: 现在返回【整行】, 不再因为 text 为空就当"没有"。
   *   长剧那一行里 text = 滚动锚, recapText = 整部戏的提要 —— 两者都要能读出来。
   */
  async function loadSeriesRecap(key) {
    if (!key) return null;
    try {
      const t = await ensureSeriesRecapTable();
      if (!t) return null;
      const row = await t.get(String(key));
      return row || null;
    } catch (e) {
      console.warn('[CinemaStorage] 读前情提要失败(忽略):', (e && e.message) || e);
      return null;
    }
  }

  /**
   * 写前情提要。超长截断。
   * createdAt 保留旧值 —— 这样"这部剧的前情提要是什么时候开始攒的"还在,
   * 每次退出覆盖时不该把它冲掉。
   *
   * 🔴 2026-10-21 改成【合并写】(原来是整行覆盖)。
   *   原因: 短剧和长剧共用这一行, 但两个字段语义不同 ——
   *     · text       短剧=前情提要 / 长剧=滚动锚("上次看到哪")
   *     · recapText  长剧=整部戏的提要 (短剧不用这个字段)
   *   整行覆盖的话, 长剧每 5 分钟更新一次滚动锚, 就会把精炼出来的提要冲没。
   *   ⇒ 现在【只更新传了的字段】, 没传的保留旧值。
   *   这行本来就存整个 JSON 对象, 加字段不需要加 Dexie 索引 → 不用改表版本。
   */
  async function saveSeriesRecap(rec) {
    const key = rec && rec.key ? String(rec.key) : '';
    if (!key) return null;
    const t = await ensureSeriesRecapTable();
    if (!t) return null;
    const old = await t.get(key).catch(function () { return null; });

    // ⚠️ 传了才算数: 没传的字段一律保留旧值 (合并写的前提)。
    //   text / recapText 都空 → 这次什么都不改, 直接把旧行还回去。
    const hasText = rec && rec.text !== undefined && rec.text !== null;
    const hasRecap = rec && rec.recapText !== undefined && rec.recapText !== null;
    const text = hasText ? String(rec.text || '').trim() : String((old && old.text) || '');
    const recapText = hasRecap ? String(rec.recapText || '').trim() : String((old && old.recapText) || '');
    if (!text && !recapText) return old || null;

    const row = {
      key: key,
      title: String((rec && rec.title) || (old && old.title) || ''),
      text: text.length > MAX_RECAP_CHARS ? text.slice(0, MAX_RECAP_CHARS) : text,
      recapText: recapText.length > MAX_RECAP_CHARS ? recapText.slice(0, MAX_RECAP_CHARS) : recapText,
      lastEp: Number((rec && rec.lastEp) || (old && old.lastEp) || 0),
      recapLastEp: Number((rec && rec.recapLastEp) || (old && old.recapLastEp) || 0),
      createdAt: (old && old.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
    await t.put(row);
    return row;
  }

  /**
   * 手动删除某部剧的前情提要。表都没有也算删成功 (本来就没有)。
   *
   * @param {string} key
   * @param {string} [field] 只清这一个字段 ('text' / 'recapText')。
   *   不传 = 整行删掉 (短剧只有一个字段, 等价于清 text)。
   *   长剧要能只删提要而不动滚动锚, 所以给这个口子。
   */
  async function deleteSeriesRecap(key, field) {
    if (!key) return false;
    try {
      const t = await ensureSeriesRecapTable();
      if (!t) return false;
      const k = String(key);
      if (field === 'text' || field === 'recapText') {
        const row = await t.get(k).catch(function () { return null; });
        if (!row) return true;                      // 本来就没有 → 也算删成功
        const next = Object.assign({}, row);
        next[field] = '';
        if (field === 'text') next.lastEp = 0;
        if (field === 'recapText') next.recapLastEp = 0;
        next.updatedAt = Date.now();
        await t.put(next);
        return true;
      }
      await t.delete(k);
      return true;
    } catch (e) {
      console.warn('[CinemaStorage] 删前情提要失败:', (e && e.message) || e);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // 逐条剧情记忆 (db v69, 2026-10-19)
  //
  // 【它取代了什么】
  //   以前单集记忆只活在 watchSession.episodeMemories (纯内存), 退出精炼成功后
  //   一律清空, 页面一关就全没了 —— 而且退出那次精炼是【整场唯一一次长上下文
  //   调用】, 用户实测它会静默 2 秒就把开头的三个字当成整篇收走 (见 cinema-live.js
  //   SUMMARY_SETTLE_MS), 于是那几集真的白看。
  //
  //   现在改成【每写出一条就落库】: 每看完一集 / 每 5 分钟攒一段, 当场写一行。
  //   退出时什么都不用做, 也就没有那个会输的环节了。
  //
  // 【一行是什么】
  //   短剧: 一行 = 一集。key = 短剧文件夹名, ep = 集号。
  //   长剧: 一行 = 一个 5 分钟段落。key = 'film:' + chatId, ep = 段落序号。
  //
  // 【导出语义】用户手动点「导出到长期记忆」→ 写进 longTermMemory → 成功后删行。
  //   写失败【不删】, 用户还能再点一次。这跟"存不下就当成功"是两种完全不同的失败。
  //
  // 【为什么要有下限】截断过的内容比没有更糟 —— 用户会以为它记下来了。
  //   MIN_EP_CHARS 以下的直接拒收, 宁可这一段没有。
  // --------------------------------------------------------------------------

  const EP_MEMORY = 'cinemaEpMemories';
  const MIN_EP_CHARS = 80;      // 低于这个长度一律拒收 (截断/空跑都落在这里)

  let epHealing = null;
  async function ensureEpMemoryTable() {
    const db = await whenDbReady();
    if (db[EP_MEMORY]) return db[EP_MEMORY];
    if (!epHealing) {
      epHealing = runHeal(async function () {
        try {
          // 🔴 2026-10-21: 必须传 { disableAutoOpen: false } —— 默认的 close()
          //    会把【自动重开库】永久关掉, 还会留下 openComplete=true 的脏状态,
          //    之后所有写入都抛 Database has been closed。
          //    详细原因见 ensureCharTable() 那段注释。
          try { db.close({ disableAutoOpen: false }); } catch (e) { /* 本来就没开 */ }
          db.version(69).stores({ [EP_MEMORY]: '&id, sessionKey, ep, updatedAt' });
          await db.open();
          if (db[EP_MEMORY]) {
            console.warn('[CinemaStorage] 逐条记忆表缺失, 已现场补建 v69');
            return db[EP_MEMORY];
          }
        } catch (e) {
          console.error('[CinemaStorage] 逐条记忆表补建失败', (e && e.name) || '', (e && e.message) || e);
        }
        return null;
      });
    }
    // ⚠️ 2026-10-21 补: 补建失败【不能永久缓存失败结果】。
    //
    // 【真事故】用户实测: 面板上明明白白摆着 3 集, 点「精炼前情提要」却说
    //   "库里还没有攒下的单集剧情"。查下来是: 补建 v69 那一步失败过一次
    //   (比如库正被别处占着 / open 被拒), 于是 epHealing 被永久缓存成 null ——
    //   【这一页里所有的写入和读取从此全废】, 而且悄无声息,
    //   用户只在几集之后点精炼时才看到一句莫名其妙的"库里没有"。
    //
    // 【修法】失败就把缓存清掉 —— 下次调用还能重试(表可能已经被别的路径建好了)。
    //   成功路径不变, 还是只补建一次。
    const healing = epHealing;
    const t = await healing;
    if (!t && epHealing === healing) epHealing = null;
    return t;
  }

  function epRowId(sessionKey, ep) {
    return String(sessionKey) + '#' + String(ep);
  }

  /**
   * 写一条。同一个 (sessionKey, ep) 覆盖 —— 重播同一集不会堆两条。
   * 返回写进去的行; 失败时返回 null, 原因写进 getEpLastError()。
   *
   * ⚠️ 2026-10-21 加 getEpLastError() 的原因: 原来失败只返回 null,
   *   调用方分不清是"内容太短"还是"表根本建不出来" —— 两种完全不同的病,
   *   修法也完全不同。现在把原因留在模块里, UI 能直接显示给用户看。
   */
  let epLastError = '';
  async function saveEpMemory(rec) {
    const key = rec && rec.sessionKey ? String(rec.sessionKey) : '';
    const text = String((rec && rec.text) || '').trim();
    if (!key || !text) {
      epLastError = !key ? '没有会话号(key 为空)' : '内容是空的';
      return null;
    }
    if (text.length < MIN_EP_CHARS) {
      epLastError = '内容只有 ' + text.length + ' 字, 低于下限 ' + MIN_EP_CHARS;
      console.warn('[CinemaStorage] ' + epLastError + ', 已拒收:', text.slice(0, 30));
      return null;
    }
    const t = await ensureEpMemoryTable();
    if (!t) {
      epLastError = '逐条记忆表(cinemaEpMemories)建不出来 —— 库可能正被别处占着';
      return null;
    }
    const ep = Number(rec.ep) || 0;
    const row = {
      id: epRowId(key, ep),
      sessionKey: key,
      kind: String((rec && rec.kind) || 'series'),
      title: String((rec && rec.title) || ''),
      ep: ep,
      text: text,
      at: Number((rec && rec.at) || Date.now()),
      updatedAt: Date.now()
    };
    await t.put(row);
    epLastError = '';
    return row;
  }

  /** 上一次 saveEpMemory 失败的原因 (成功时是空串)。 */
  function getEpLastError() { return epLastError; }

  /** 列出某次观看攒下的全部条目, 按 ep 升序。读不到一律当空。 */
  async function listEpMemories(sessionKey) {
    if (!sessionKey) return [];
    try {
      const t = await ensureEpMemoryTable();
      if (!t) {
        epLastError = '逐条记忆表(cinemaEpMemories)建不出来 —— 库可能正被别处占着';
        return [];
      }
      const rows = await t.where('sessionKey').equals(String(sessionKey)).toArray();
      rows.sort(function (a, b) { return (a.ep || 0) - (b.ep || 0); });
      return rows || [];
    } catch (e) {
      epLastError = '读逐条记忆失败: ' + ((e && e.message) || e);
      console.warn('[CinemaStorage] 读逐条记忆失败(忽略):', (e && e.message) || e);
      return [];
    }
  }

  /** 删掉指定的若干条 (导出成功后清账用)。传不到 id 就算删成功。 */
  async function deleteEpMemories(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return false;
    try {
      const t = await ensureEpMemoryTable();
      if (!t) return false;
      await t.bulkDelete(list.map(String));
      return true;
    } catch (e) {
      console.warn('[CinemaStorage] 删逐条记忆失败:', (e && e.message) || e);
      return false;
    }
  }

  /** 整场清空 (手动"全部删掉"用)。 */
  async function clearEpMemories(sessionKey) {
    if (!sessionKey) return false;
    try {
      const t = await ensureEpMemoryTable();
      if (!t) return false;
      const rows = await t.where('sessionKey').equals(String(sessionKey)).toArray();
      await t.bulkDelete(rows.map(function (r) { return r.id; }));
      return true;
    } catch (e) {
      console.warn('[CinemaStorage] 清空逐条记忆失败:', (e && e.message) || e);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // 容量
  // --------------------------------------------------------------------------

  async function getUsage() {
    const db = await whenDbReady();
    const rows = await db[FILMS].toArray();
    let filmBytes = 0;
    let filmCount = 0;
    for (const row of rows) {
      filmBytes += row.size || 0;
      filmCount += 1;
    }
    let quota = null;
    let usage = null;
    try {
      if (global.navigator && navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        quota = est.quota;
        usage = est.usage;
      }
    } catch (e) { /* 拿不到就只报影片字节数 */ }

    return {
      filmBytes: filmBytes,
      filmCount: filmCount,
      quota: quota,
      usage: usage,
      softWarnBytes: SOFT_WARN_BYTES,
      overSoftWarn: filmBytes > SOFT_WARN_BYTES
    };
  }

  // 加入前的软警告检查: 返回 { warn, current, incoming, total }
  async function checkSoftWarn(incomingBytes) {
    const info = await getUsage();
    const total = info.filmBytes + (incomingBytes || 0);
    return {
      warn: total > SOFT_WARN_BYTES,
      current: info.filmBytes,
      incoming: incomingBytes || 0,
      total: total,
      quota: info.quota
    };
  }

  // --------------------------------------------------------------------------
  // 影片: 写入
  // --------------------------------------------------------------------------

  /**
   * 加入一部影片。file 传 File 或 Blob 都可以。
   * 在线片源 (B 站外链 / URL) 传 meta.url 且不给 file, 只存元数据。
   */
  async function addFilm(file, meta) {
    const db = await whenDbReady();
    const m = meta || {};
    const id = m.id || newId();
    const name = m.name || (file && (stripExt(file.name) || file.name)) || '未命名影片';

    const record = {
      id: id,
      name: name,
      // 本地影片 = 存 Blob; 在线片源 = 只存 URL 字符串 (体积可忽略)
      size: file ? (file.size || 0) : 0,
      type: file ? (file.type || '') : '',
      sourceType: file ? 'local-file' : 'url',
      url: m.url || '',
      platform: m.platform || '',
      addedAt: Date.now()
    };

    // 先写 Blob 再写元数据: Blob 写失败(配额满)就什么都没留下, 不会出现"列表里有、播不了"
    if (file) {
      await db[BLOBS].put({ id: id, file: file });
    }
    try {
      await db[FILMS].put(record);
      await db[PROGRESS].put({ filmId: id, currentTime: 0, duration: 0, updatedAt: Date.now() });
    } catch (e) {
      // 元数据写失败就把 Blob 撤掉, 免得白占用户手机空间
      if (file) { try { await db[BLOBS].delete(id); } catch (e2) { /* ignore */ } }
      throw e;
    }
    return record;
  }

  // --------------------------------------------------------------------------
  // 影片: 读取
  // --------------------------------------------------------------------------

  // 列片单。只读 cinemaFilms(纯元数据) + cinemaProgress(纯数字), 一条 Blob 都不碰。
  async function listFilms() {
    const db = await whenDbReady();
    const rows = await db[FILMS].orderBy('addedAt').reverse().toArray();
    const progs = await db[PROGRESS].toArray();
    const pMap = new Map();
    for (const p of progs) pMap.set(p.filmId, p);

    return rows.map(function (r) {
      const p = pMap.get(r.id);
      return {
        id: r.id,
        name: r.name,
        size: r.size || 0,
        type: r.type || '',
        sourceType: r.sourceType || 'local-file',
        url: r.url || '',
        platform: r.platform || '',
        addedAt: r.addedAt || 0,
        currentTime: p ? (p.currentTime || 0) : 0,
        duration: p ? (p.duration || 0) : 0
      };
    });
  }

  // 取单个影片的 File 对象。返回 null = 本体已被系统驱逐(见下 missing 处理)。
  async function getFilmFile(id) {
    const db = await whenDbReady();
    const row = await db[BLOBS].get(id);
    if (!row || !row.file) return null;
    return row.file;
  }

  async function getFilm(id) {
    const db = await whenDbReady();
    return db[FILMS].get(id);
  }

  // --------------------------------------------------------------------------
  // 影片: 删除
  // --------------------------------------------------------------------------

  async function removeFilm(id) {
    const db = await whenDbReady();
    const record = await db[FILMS].get(id);
    await db[FILMS].delete(id);
    await db[BLOBS].delete(id);
    await db[PROGRESS].delete(id);
    return record ? (record.size || 0) : 0;  // 返回释放的字节数
  }

  // --------------------------------------------------------------------------
  // 播放进度
  // --------------------------------------------------------------------------

  async function saveProgress(filmId, currentTime, duration) {
    if (!filmId) return;
    const db = await whenDbReady();
    try {
      await db[PROGRESS].put({
        filmId: filmId,
        currentTime: Math.max(0, Number(currentTime) || 0),
        duration: Math.max(0, Number(duration) || 0),
        updatedAt: Date.now()
      });
    } catch (e) {
      // 进度写失败不能影响播放, 静默降级
      if (global.console) console.warn('[CinemaStorage] 进度保存失败', e);
    }
  }

  async function getProgress(filmId) {
    const db = await whenDbReady();
    const p = await db[PROGRESS].get(filmId);
    return p || { filmId: filmId, currentTime: 0, duration: 0 };
  }

  // --------------------------------------------------------------------------
  // 工具
  // --------------------------------------------------------------------------

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = (h > 0 ? String(m).padStart(2, '0') : String(m));
    return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  // --------------------------------------------------------------------------
  // 人物立绘 (沙发上的透明小人)
  //
  // 【图片规格建议】(2026-10-04)
  //   显示尺寸: 角色位宽 = 视口 28% ≈ 110px, 高宽比 3:5 → 约 110x185 CSS px
  //   3 倍屏需要 ≈ 330x555 物理像素
  //   → 推荐存 768x1280 (3:5), WebP 带透明, quality 0.85
  //   → 体积 60~120KB; 同一张 PNG 带透明会是 400KB~1MB, 差 5~8 倍
  //   → 想更小可以用 512x853 的 WebP (30~60KB), 手机上依然清晰
  //
  // 【为什么必须存 Blob】
  //   跟 cinemaBlobs 同一个道理: base64 会让内存翻好几倍, 手机上会卡。
  //   浏览器结构化克隆 Blob 时直接落盘, 堆占用可忽略。
  // --------------------------------------------------------------------------

  const CHARS_TABLES_NOTE = true;   // CHARS 已在文件顶部声明 (ensureCharTable 要用)

  // 位置/缩放的默认值。用户没调过就落这套, 渲染层直接用, 不用到处判空。
  // x/y 是【相对房间背景图的百分比】(0~100), scale 是倍数。
  // 用百分比而不是 px: 换手机/转屏时道具还坐在沙发的同一个位置。
  //
  // ⚠️ 每个 slot 的默认值不同, 而且这里跟 cinema-room.js 的初始值必须一致 ——
  //    两边不一致会导致"存图写 50/50、渲染写 26/74", 人物一进房就跳到中间 (踩过)。
  //
  // 【背景图 2026-10-04 换成无茶几版】(1080x1920)
  //   沙发靠背顶 ~52% / 坐垫中线 ~66% / 坐垫左右 ~63%~75% / 沙发底沿 ~76%
  //   → 人物脚底落在 66% 才真正坐在坐垫上 (旧图是 60%, 因为旧图沙发位置更高)
  //   → 茶几默认落在 84% (沙发前方空地), 宽一点矮一点
  const DEFAULT_CHAR_LAYOUT = { x: 50, y: 66, scale: 1 };
  const DEFAULT_CHAR_LAYOUT_BY_SLOT = {
    left: { x: 27, y: 66, scale: 1 },
    right: { x: 73, y: 66, scale: 1 },
    table: { x: 50, y: 84, scale: 1 }
  };
  // 合法 slot 白名单。茶几是 2026-10-04 加的 (背景图去掉了茶几, 改成用户自己传)。
  const CHAR_SLOTS = ['left', 'right', 'table'];
  function defaultLayoutFor(slot) {
    return Object.assign({}, DEFAULT_CHAR_LAYOUT_BY_SLOT[slot] || DEFAULT_CHAR_LAYOUT);
  }

  // --------------------------------------------------------------------------
  // 房间背景 (2026-10-05 用户需求: 让用户自己换房间背景)
  //
  // 【存在哪】复用 cinemaChars 表, slot = 'bg'。不另开表 —— 同一个
  //   "一张图存一个 slot" 的模式, 少一个表少一份 schema 版本。
  //
  // 【为什么不进 CHAR_SLOTS】CHAR_SLOTS 那套循环带 x/y/scale 位置逻辑
  //   (applyCharTransform / 拖动 / 缩放), 背景图是 cover 铺满, 根本不需要。
  //   混进去会让拖动手势套到背景上, 把房间拖乱。
  //
  // 【隔离性】IndexedDB 在各自手机本地, 不联网。糖糖和琪琪各存各的,
  //   永远看不到对方的背景 (跟人物/茶几一样)。
  // --------------------------------------------------------------------------
  const BG_SLOT = 'bg';

  async function saveRoomBg(blob) {
    if (!blob) throw new Error('没有图片数据');
    const table = await ensureCharTable();
    if (!table) throw new Error('道具数据表缺失 (db schema 未升级到 v66), 请刷新页面重试');
    // 背景不需要位置信息, 只存图 —— 换图就是整个替换
    await table.put({ id: BG_SLOT, image: blob, updatedAt: Date.now() });
    return BG_SLOT;
  }

  async function getRoomBg() {
    const table = await ensureCharTable();
    if (!table) return null;
    const row = await table.get(BG_SLOT);
    return (row && row.image) ? row.image : null;
  }

  async function removeRoomBg() {
    const table = await ensureCharTable();
    if (!table) return false;
    await table.delete(BG_SLOT);
    return true;
  }

  /**
   * 存道具图 (人物 / 茶几)。换图时位置重置 (新图尺寸肯定不一样, 旧位置没意义)。
   */
  async function saveChar(slot, blob) {
    if (CHAR_SLOTS.indexOf(slot) === -1) throw new Error('slot 只能是 left / right / table');
    if (!blob) throw new Error('没有图片数据');
    const table = await ensureCharTable();
    if (!table) throw new Error('道具数据表缺失 (db schema 未升级到 v66), 请刷新页面重试');
    const d = defaultLayoutFor(slot);
    await table.put({
      id: slot,
      image: blob,
      x: d.x, y: d.y, scale: d.scale,
      updatedAt: Date.now()
    });
    return slot;
  }

  /**
   * 只更新位置/缩放, 【不碰 image】。
   * ⚠️ 必须走 table.update 而不是 put —— put 会把整条记录重写,
   *    如果只传 {id, x, y, scale}, image 字段就没了 (道具直接消失)。
   */
  async function setCharLayout(slot, layout) {
    if (CHAR_SLOTS.indexOf(slot) === -1) throw new Error('slot 只能是 left / right / table');
    const table = await ensureCharTable();
    if (!table) return null;
    const d = defaultLayoutFor(slot);
    const patch = {
      x: clampNum(layout && layout.x, 0, 100, d.x),
      y: clampNum(layout && layout.y, 0, 100, d.y),
      scale: clampNum(layout && layout.scale, 0.3, 3, d.scale)
    };
    const n = await table.update(slot, patch);
    if (!n) return null;   // 这张 slot 还没图 —— 不建记录, 免得出现"有位置没图"的空壳
    return patch;
  }

  function clampNum(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** 取图片 + 位置。位置字段缺失的老数据补默认 (按 slot 区分左右)。 */
  async function getChar(slot) {
    const row = await getCharRow(slot);
    return (row && row.image) ? row.image : null;
  }

  async function getCharRow(slot) {
    const table = await ensureCharTable();
    if (!table) return null;
    const row = await table.get(slot);
    if (!row) return null;
    const d = defaultLayoutFor(slot);
    return {
      image: row.image || null,
      x: clampNum(row.x, 0, 100, d.x),
      y: clampNum(row.y, 0, 100, d.y),
      scale: clampNum(row.scale, 0.3, 3, d.scale)
    };
  }

  async function getAllChars() {
    const out = {};
    const table = await ensureCharTable();
    if (!table) return out;
    for (const slot of CHAR_SLOTS) {
      const row = await table.get(slot);
      if (row && row.image) out[slot] = row.image;
    }
    return out;
  }

  async function removeChar(slot) {
    const table = await ensureCharTable();
    if (!table) return false;
    await table.delete(slot);
    return true;
  }

  global.CinemaStorage = {
    FILMS: FILMS,
    BLOBS: BLOBS,
    PROGRESS: PROGRESS,
    SOFT_WARN_BYTES: SOFT_WARN_BYTES,
    addFilm: addFilm,
    listFilms: listFilms,
    getFilm: getFilm,
    getFilmFile: getFilmFile,
    removeFilm: removeFilm,
    saveProgress: saveProgress,
    getProgress: getProgress,
    getUsage: getUsage,
    checkSoftWarn: checkSoftWarn,
    formatBytes: formatBytes,
    formatTime: formatTime,
    // 人物立绘
    saveChar: saveChar,
    getChar: getChar,
    getCharRow: getCharRow,
    setCharLayout: setCharLayout,
    DEFAULT_CHAR_LAYOUT: DEFAULT_CHAR_LAYOUT,
    DEFAULT_CHAR_LAYOUT_BY_SLOT: DEFAULT_CHAR_LAYOUT_BY_SLOT,
    CHAR_SLOTS: CHAR_SLOTS,
    defaultLayoutFor: defaultLayoutFor,
    // 房间背景 (2026-10-05): 单独一套接口, 不走 CHAR_SLOTS 的位置逻辑
    saveRoomBg: saveRoomBg,
    getRoomBg: getRoomBg,
    removeRoomBg: removeRoomBg,
    getAllChars: getAllChars,
    removeChar: removeChar,
    // 短剧前情提要 (2026-10-15)
    SERIES_RECAP: SERIES_RECAP,
    MAX_RECAP_CHARS: MAX_RECAP_CHARS,
    loadSeriesRecap: loadSeriesRecap,
    saveSeriesRecap: saveSeriesRecap,
    deleteSeriesRecap: deleteSeriesRecap,
    // 逐条剧情记忆 (2026-10-19) —— 每集/每段落当场落库, 不再等退出那次精炼
    EP_MEMORY: EP_MEMORY,
    MIN_EP_CHARS: MIN_EP_CHARS,
    saveEpMemory: saveEpMemory,
    listEpMemories: listEpMemories,
    getEpLastError: getEpLastError,
    deleteEpMemories: deleteEpMemories,
    clearEpMemories: clearEpMemories
  };

})(window);

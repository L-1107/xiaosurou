// ============================================================
// modules/reading-storage.js
// 读书屋 · 存储层 (宿主侧)
//
// 【为什么整本书不能是一条记录】
//   旧版「一起读书」把整本书塞进 readingLibrary 的一条记录的 content 字段。
//   实测 (真 IndexedDB + 真 Dexie, 2000 万字 / UTF-16 38.2MB):
//     db.books.update(id, {currentPage})  = 96~126 ms  ← 每翻一页搬一遍整本书
//     db.books.orderBy().toArray()        =  39 ms    ← 开一次书库搬一遍全库
//     同样一张表, 记录里【没有 content】时: update = 2 ms, toArray = 0 ms
//     split 切行 31.4 万行 → 常驻 ≈44.8MB, 整页 JS heap 307MB
//   → 手机上必然卡 + 发烫 (GC 风暴)。
//
// 【这一层的设计】
//   readingBooks —— 只有元数据 (书名 / 页数 / 字数 / 进度), 永远不含正文
//   readingPages —— 一页一条 { bookId, pageNo, text, chapterTitle }
//   于是:
//     · 开书库     = 只读元数据行, 永远不碰正文
//     · 翻一页     = 只读【一条】几 KB 的记录
//     · 存进度     = 只 update 元数据行 (几十字节)
//     · 常驻内存   = 只有当前这一页
//
// 【分页算法】
//   按自然段累积, 每页约 600 字; 章节标题 (第X卷 / 第X章 / ==== ====)
//   单独识别, 记进该页的 chapterTitle, 页面上显示"卷/章"。
//
// 【导入】
//   file.stream() + TextDecoder({stream:true}) 边读边切页, 每 100 页写一批,
//   峰值内存 ≈ 一个 chunk + 一页正文 —— 60MB 的二十四史也不会把手机撑爆。
// ============================================================

(function (global) {
  'use strict';

  var LOG = '[ReadingStorage] ';

  // ============================================================
  // 常量
  // ============================================================

  /** 每页目标字数 (自然段累积到这个数就切页) */
  var PAGE_TARGET_CHARS = 600;
  /** 每批写多少页 */
  var WRITE_BATCH = 100;

  /**
   * 章节标题的识别
   *
   * ⚠️⚠️ 这里踩过一个大坑 (2026-11-01):
   *   原来的写法是 /第[0-9]+[卷章回节篇部集]/ —— 【前缀匹配】。
   *   结果 "第1卷第1段：太祖即位之初，百官入贺……" 这种【正文段落】
   *   也被当成章节标题 → 每段正文自成一页 (一本 3 轮的书切出 27 页, 每页一段),
   *   而且每段的正文被塞进 chapterTitle, 章节名全是正文。
   *
   *   ⇒ 现在要求: ① 章节标记后面必须【紧跟空白/冒号/顿号/行尾】("第1卷 第1段" 这种还是像章节,
   *     但下一条的长度上限会把它挡掉); ② 整行长度 ≤ CHAPTER_MAX_LEN (章节标题都很短,
   *     正文段落都很长)。
   *
   * ⚠️ 2026-11-02 用户实测: 导入【小说】时章节一条都认不出来 ——
   *   小说常见的写法跟史书不一样, 原来一条都匹配不上:
   *     "第一章：起源" (冒号)   "第一章起源" (没空格)   "序章"   "Chapter 1"
   *   → 现在这些都放进来了, 详见下面 CHAPTER_RE 的注释。
   *
   *   例: "========== 第一卷 序 =========" ✅ (靠 ={4,} 那条)
   *       "第三卷" ✅  "卷一  秦始皇本纪" ✅  "第一章 起源" ✅  "第一章：起源" ✅
   *       "序章" ✅  "Chapter 1" ✅
   *       "第三卷末，帝崩于沙丘" ❌ (后面跟的是"末", 不是空白/冒号/顿号)
   *       "第1卷第1段：太祖即位之初……" ❌ (吃到"第1卷"后下一个字是"第"; 章节单位里也没有"段")
   */
  var CHAPTER_RE = new RegExp(
    '^(?:' +
      // 第N卷/章/回/节/篇/部/集
      '第[0-9〇零一二三四五六七八九十百千两]+[卷章回节篇部集]' +
      '|卷[0-9〇零一二三四五六七八九十百千两]+' +
      // 整行 ={4,} 包裹的标题
      '|={4,}.*={4,}' +
      // 【标题】
      '|【[^】]{1,40}】' +
      // 中文小说常见的独立章节名 (⚠️ 别把"正文"放进来, 正文里这两个字太常见)
      '|(?:序章|序言|序卷|楔子|引子|前言|后记|尾声|终章|终卷|番外|附录)' +
      // 英文小说
      '|(?:chapter|part|book|episode)\\s+[0-9IVXLCivxlc]+' +
    ')',
    'i'
  );
  /** 章节标题行最长多少字 (正文段落通常远长于此) */
  var CHAPTER_MAX_LEN = 40;
  /** "标记后面直接跟文字"时, 整行最多多少字才算章节 (章节标题都很短) */
  var CHAPTER_TIGHT_LEN = 10;
  /** 正文里几乎总有标点 —— 章节标题基本没有, 拿它当"这是正文"的判据 */
  var PUNCT_RE = /[，。！？；：、,.;!?「」『』“”"']/;

  /**
   * 是不是章节标题行
   *
   * 判定顺序:
   *   ① 长度 ≤ 40 (章节标题短, 正文段落长)
   *   ② 开头能认出章节标记
   *   ③ 标记后面是【空白/冒号/顿号/行尾】 → 直接认
   *      ("第一章 起源" / "第一章：起源" / "第一章")
   *   ④ 标记后面直接跟了字 ("第一章起源") → 只有"整行很短 + 整行没有标点"才认
   *      (正文行几乎总有标点, 章节标题基本没有 → 用标点当判据)
   *
   * ⚠️ "第1卷第1段：太祖即位……" 必须排除:
   *   标记吃到 "第1卷", 后面是 "第1段：……" —— 既不是空白也不是标点开头,
   *   而且整行很长 + 带标点 → 两条兜底都挡掉 ✅
   */
  function isChapterLine(line) {
    var s = String(line || '').trim();
    if (!s) return false;
    if (s.length > CHAPTER_MAX_LEN) return false;

    var m = CHAPTER_RE.exec(s);
    if (!m) return false;
    var mark = m[0];
    // ={4,}...={4,} 和 【...】 本身就是完整标题
    if (/^={4,}/.test(mark) || /^【/.test(mark)) return true;

    var rest = s.slice(mark.length);
    if (!rest) return true;                       // 整行就是个标记 ("第三卷")
    if (/^[\s:：、]/.test(rest)) return true;      // 标记后跟空白/冒号/顿号
    // 标记后直接跟文字 → 只有"很短 + 没标点"才当章节
    return s.length <= CHAPTER_TIGHT_LEN && !PUNCT_RE.test(s);
  }

  function log(msg, extra) {
    console.log(LOG + msg, extra === undefined ? '' : extra);
  }
  function logWarn(msg, extra) {
    console.warn(LOG + '⚠️ ' + msg, extra === undefined ? '' : extra);
  }
  function logError(msg, extra) {
    console.error(LOG + '✖ ' + msg, extra === undefined ? '' : extra);
  }

  function getDb() {
    try {
      if (typeof db !== 'undefined' && db) return db;
    } catch (e) { /* noop */ }
    return global.db || null;
  }

  // ============================================================
  // 分页器
  //
  // 【为什么写成"往里塞一段文本, 它吐出几页"】
  //   整本书切页如果一次全切出来, 2000 万字会一次性变成几万个字符串
  //   (≈40MB) —— 那就等于把老版"整本书切行常驻"的老毛病换了个写法。
  //   所以这里必须是【增量】的: 来一段切一段, 切出一页就交出去写库,
  //   写完就扔, 内存里永远只有一页。
  //
  //   同一份代码同时服务两种输入:
  //     · 整段字符串 (旧书迁移)  → push(text) + flush()
  //     · 文件流   (新书导入)    → 每个 chunk push() 一次
  // ============================================================
  function Paginator() {
    this.lines = [];        // 当前页攒着的行
    this.lineLen = 0;       // 当前页字数
    this.chapterTitle = ''; // 当前章名
    this.chapterLine = '';  // 当前章的【原始标题行】
    this.tail = '';         // 还没遇到换行的半行 (跨 chunk 边界)
  }

  /** 清掉章节标题两边的装饰 (========== xxx ========== → xxx) */
  function cleanChapterTitle(line) {
    var t = String(line || '').trim();
    t = t.replace(/^=+\s*/, '').replace(/\s*=+$/, '');
    t = t.replace(/^【|】$/g, '').trim();
    return t.substring(0, 120);
  }

  Paginator.prototype._pushLine = function (raw) {
    var line = String(raw || '').replace(/[ \t]+/g, ' ').trim();
    if (!line) return null;

    if (isChapterLine(line)) {
      // 章节标题: 先把已经攒够的那一页交出去, 标题单独当新一页的开头
      var flushed = null;
      if (this.lineLen > 0) {
        flushed = {
          text: this.lines.join('\n'),
          chapterTitle: this.chapterTitle,
          chapterLine: this.chapterLine
        };
        this.lines = [];
        this.lineLen = 0;
      }
      this.chapterTitle = cleanChapterTitle(line);
      this.chapterLine = line;
      this.lines.push(line);
      this.lineLen += line.length + 1;
      return flushed;
    }

    this.lines.push(line);
    this.lineLen += line.length + 1;

    if (this.lineLen >= PAGE_TARGET_CHARS) {
      var page = {
        text: this.lines.join('\n'),
        chapterTitle: this.chapterTitle,
        chapterLine: this.chapterLine
      };
      this.lines = [];
      this.lineLen = 0;
      return page;
    }
    return null;
  };

  /**
   * 喂一段文本进来, 返回这一段切出来的页 (0~n 个)。
   * @param {string} chunk
   * @returns {Array<{text:string, chapterTitle:string}>}
   */
  Paginator.prototype.push = function (chunk) {
    var out = [];
    var text = this.tail + String(chunk || '');
    this.tail = '';
    var start = 0;
    while (true) {
      var nl = text.indexOf('\n', start);
      if (nl < 0) break;
      var page = this._pushLine(text.slice(start, nl));
      if (page) out.push(page);
      start = nl + 1;
    }
    // 最后这段还没换行 —— 留着, 等下一块来了一起处理 (跨 chunk 的半行)
    this.tail = text.slice(start);
    return out;
  };

  /** 收尾: 把剩下的吐出来 */
  Paginator.prototype.flush = function () {
    var out = [];
    if (this.tail) {
      var page = this._pushLine(this.tail);
      this.tail = '';
      if (page) out.push(page);
    }
    if (this.lineLen > 0) {
      out.push({
        text: this.lines.join('\n'),
        chapterTitle: this.chapterTitle,
        chapterLine: this.chapterLine
      });
      this.lines = [];
      this.lineLen = 0;
    }
    return out;
  };

  // ============================================================
  // 编码探测 (UTF-8 / UTF-16 / GBK/GB18030)
  //
  // 老版是整份文件 arrayBuffer() 再 decode —— 那一下就是几十 MB 的内存峰值。
  // 这里改成: 只读头 64KB 判编码, 然后流式解码。
  // ============================================================
  var PROBE_BYTES = 65536;

  /**
   * 严格试一种编码能不能完整解出这段字节
   *
   * ⚠️ trimHead / trimTail: 切片边界可能切在一个多字节字符中间
   *   (UTF-8 最多 4 字节, GBK 2 字节) → 严格解码会失败 → 误判成别的编码。
   *   所以边界各让几字节再试。
   */
  function strictDecodeOk(u8, enc, trimHead, trimTail) {
    for (var a = 0; a <= trimHead; a++) {
      for (var b = 0; b <= trimTail; b++) {
        var end = u8.length - b;
        if (end <= a) continue;
        try {
          new TextDecoder(enc, { fatal: true }).decode(u8.subarray(a, end));
          return true;
        } catch (e) { /* 换下一种切法 */ }
      }
    }
    return false;
  }

  /**
   * 探测文件编码
   *
   * ⚠️ 2026-11-02 用户实测: "导入的小说全是乱码"。
   *   原因: 原来用 new TextDecoder('gbk') 试 —— 这个标签在部分浏览器
   *   (iOS Safari 上尤其明显) 直接抛 RangeError, catch 之后回落成 'utf-8',
   *   GBK 的小说就整本乱码。
   *
   * 现在:
   *   ① BOM 直判 (utf-8 / utf-16le / utf-16be)
   *   ② 严格 UTF-8 → utf-8
   *   ③ 严格 gb18030 → gb18030 (GBK 的超集, 标签兼容性最好, 几乎所有浏览器都认)
   *   ④ 严格 gbk → gbk
   *   ⑤ 都不认 → 非严格 utf-8 兜底
   *
   * ⚠️ 为什么要看【尾部】: 很多小说的开头是版权页/目录, 全是 ASCII ——
   *   只看头部的话, ASCII 在 UTF-8 和 GBK 下解出来一模一样 → 必然误判成 UTF-8,
   *   后面正文全是乱码。所以头尾各取一段, 两段都严格通过才算 UTF-8。
   */
  function detectEncoding(headBuffer, tailBuffer) {
    var h = new Uint8Array(headBuffer || new ArrayBuffer(0));
    var t = tailBuffer ? new Uint8Array(tailBuffer) : null;

    if (h.length >= 3 && h[0] === 0xEF && h[1] === 0xBB && h[2] === 0xBF) return 'utf-8';
    if (h.length >= 2 && h[0] === 0xFF && h[1] === 0xFE) return 'utf-16le';
    if (h.length >= 2 && h[0] === 0xFE && h[1] === 0xFF) return 'utf-16be';

    if (strictDecodeOk(h, 'utf-8', 0, 3) && (!t || strictDecodeOk(t, 'utf-8', 3, 0))) return 'utf-8';
    if (strictDecodeOk(h, 'gb18030', 0, 3) && (!t || strictDecodeOk(t, 'gb18030', 3, 0))) return 'gb18030';
    if (strictDecodeOk(h, 'gbk', 0, 3) && (!t || strictDecodeOk(t, 'gbk', 3, 0))) return 'gbk';

    return 'utf-8';
  }

  // ============================================================
  // 写库
  // ============================================================

  /**
   * 把切出来的一页页写进 readingPages
   * @param {number} bookId
   * @param {Array<{text,chapterTitle}>} pages
   * @param {number} startPageNo 从第几页开始写 (0 基)
   * @param {Array} chapterIndex 章目录 (边切边攒, 免得回头再扫一遍全书)
   */
  async function writePages(d, bookId, pages, startPageNo, chapterIndex) {
    if (!pages.length) return startPageNo;
    var rows = pages.map(function (p, i) {
      return {
        bookId: bookId,
        pageNo: startPageNo + i,
        text: p.text,
        chapterTitle: p.chapterTitle || '',
        // ⚠️ 章节的【原始标题行】也存一份 ——
        //   渲染层靠它认出"哪一行是章节标题", 不用自己再猜一遍正则
        //   (两处各猜一次 → 判定不一致 → 正文整段被当成标题显示)。
        chapterLine: p.chapterLine || ''
      };
    });
    await d.readingPages.bulkAdd(rows);

    // 章目录: 只记"章名变了"的那一页
    if (chapterIndex) {
      var last = chapterIndex.length ? chapterIndex[chapterIndex.length - 1].title : '';
      for (var j = 0; j < pages.length; j++) {
        var ct = pages[j].chapterTitle || '';
        if (ct && ct !== last) {
          chapterIndex.push({ pageNo: startPageNo + j, title: ct });
          last = ct;
        }
      }
    }
    return startPageNo + rows.length;
  }

  /**
   * 新建一本书 (先建元数据行, 拿到 id 再写正文)
   */
  async function createBook(meta) {
    var d = getDb();
    if (!d) throw new Error('数据库还没开');
    var bookId = await d.readingBooks.add({
      title: String((meta && meta.title) || '未命名'),
      lastOpened: Date.now(),
      linkedStoryId: (meta && meta.linkedStoryId) || null,
      charCount: 0,
      pageCount: 0,
      currentPage: 0
    });
    return bookId;
  }

  /**
   * 导入一整段文本 (旧书迁移 / URL 抓取用)
   * @param {string} title
   * @param {string} text
   * @param {object} meta
   * @param {function} onProgress (done, totalChars)
   */
  async function importText(title, text, meta, onProgress) {
    var d = getDb();
    if (!d) throw new Error('数据库还没开');
    var bookId = await createBook(Object.assign({ title: title }, meta || {}));

    var pag = new Paginator();
    var pageNo = 0;
    var chars = 0;
    var batch = [];
    var chapterIndex = [];

    function flushBatch() {
      if (!batch.length) return Promise.resolve();
      var pages = batch;
      batch = [];
      return writePages(d, bookId, pages, pageNo, chapterIndex).then(function (next) { pageNo = next; });
    }

    // 分块喂进去 —— 一页也不一次性全切出来
    var CHUNK = 1 << 20;   // 1MB
    for (var i = 0; i < text.length; i += CHUNK) {
      var chunk = text.slice(i, i + CHUNK);
      chars += chunk.length;
      var pages = pag.push(chunk);
      for (var j = 0; j < pages.length; j++) {
        batch.push(pages[j]);
        if (batch.length >= WRITE_BATCH) {
          await flushBatch();
          if (onProgress) { try { onProgress(pageNo, chars); } catch (e) { /* noop */ } }
        }
      }
    }
    var tailPages = pag.flush();
    for (var k = 0; k < tailPages.length; k++) batch.push(tailPages[k]);
    await flushBatch();

    await d.readingBooks.update(bookId, {
      pageCount: pageNo,
      charCount: chars,
      chapters: chapterIndex,
      lastOpened: Date.now()
    });
    if (onProgress) { try { onProgress(pageNo, chars); } catch (e) { /* noop */ } }
    return { bookId: bookId, pageCount: pageNo, charCount: chars };
  }

  /**
   * 导入一个本地文件 (流式 —— 六十兆的二十四史也不会把内存撑爆)
   * @param {File} file
   * @param {object} meta
   * @param {function} onProgress (donePages, readBytes, totalBytes)
   */
  async function importFile(file, meta, onProgress) {
    var d = getDb();
    if (!d) throw new Error('数据库还没开');
    if (!file) throw new Error('没有拿到文件');

    var name = String((meta && meta.title) || file.name || '未命名').replace(/\.txt$/i, '');

    // ① 探编码 (头 64KB + 尾 64KB)
    //    ⚠️ 尾部也要看: 小说开头常常是版权页(全 ASCII), 只看头会误判成 UTF-8。
    var headBuf = await file.slice(0, PROBE_BYTES).arrayBuffer();
    var tailBuf = null;
    if (file.size && file.size > PROBE_BYTES * 2) {
      tailBuf = await file.slice(file.size - PROBE_BYTES).arrayBuffer();
    }
    var enc = detectEncoding(headBuf, tailBuf);
    var decoder = new TextDecoder(enc);

    // ② 建书
    var bookId = await createBook(Object.assign({ title: name }, meta || {}));

    // ③ 流式读 + 切页 + 分批写
    var pag = new Paginator();
    var pageNo = 0;
    var chars = 0;
    var read = 0;
    var batch = [];
    var chapterIndex = [];
    var reader = null;

    async function flushBatch() {
      if (!batch.length) return;
      var pages = batch;
      batch = [];
      await writePages(d, bookId, pages, pageNo, chapterIndex);
      pageNo += pages.length;
    }

    try {
      if (typeof file.stream === 'function') {
        reader = file.stream().getReader();
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          read += r.value.byteLength;
          var chunk = decoder.decode(r.value, { stream: true });
          if (chunk) {
            chars += chunk.length;
            var pages = pag.push(chunk);
            for (var i = 0; i < pages.length; i++) {
              batch.push(pages[i]);
              if (batch.length >= WRITE_BATCH) {
                await flushBatch();
                if (onProgress) { try { onProgress(pageNo, read, file.size); } catch (e) { /* noop */ } }
              }
            }
          }
        }
        var rest = decoder.decode();
        if (rest) {
          chars += rest.length;
          var rp = pag.push(rest);
          for (var j = 0; j < rp.length; j++) batch.push(rp[j]);
        }
      } else {
        // 老浏览器没有 Blob.stream() —— 退回到整份读 (文件大的话会吃力, 但能用)
        var buf = await file.arrayBuffer();
        read = buf.byteLength;
        var all = decoder.decode(buf);
        chars = all.length;
        var ps = pag.push(all);
        for (var k = 0; k < ps.length; k++) batch.push(ps[k]);
      }
    } finally {
      if (reader) { try { reader.releaseLock(); } catch (e) { /* noop */ } }
    }

    var tailPages = pag.flush();
    for (var t = 0; t < tailPages.length; t++) batch.push(tailPages[t]);
    await flushBatch();

    await d.readingBooks.update(bookId, {
      pageCount: pageNo,
      charCount: chars,
      chapters: chapterIndex,
      lastOpened: Date.now()
    });
    if (onProgress) { try { onProgress(pageNo, read, file.size); } catch (e) { /* noop */ } }
    return { bookId: bookId, pageCount: pageNo, charCount: chars, encoding: enc };
  }

  /**
   * 导入绿江作品 (按章节)
   * @param {object} story  { id, title, chapters:[{title, content}] }
   */
  async function importChapters(story) {
    var d = getDb();
    if (!d) throw new Error('数据库还没开');
    var chapters = (story && Array.isArray(story.chapters)) ? story.chapters : [];
    var parts = [];
    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i] || {};
      var title = ch.title || ('第 ' + (i + 1) + ' 章');
      parts.push('========== ' + title + ' =========\n' + String(ch.content || ''));
    }
    var full = parts.join('\n\n');
    return importText(story.title || '未命名', full, { linkedStoryId: story.id });
  }

  // ============================================================
  // 读
  // ============================================================

  /** 书库列表 —— 只有元数据, 永远不碰正文 */
  async function listBooks() {
    var d = getDb();
    if (!d) return [];
    var books = await d.readingBooks.orderBy('lastOpened').reverse().toArray();
    return books.map(function (b) {
      return {
        id: b.id,
        title: b.title,
        lastOpened: b.lastOpened || 0,
        linkedStoryId: b.linkedStoryId || null,
        charCount: b.charCount || 0,
        pageCount: b.pageCount || 0,
        currentPage: b.currentPage || 0
      };
    });
  }

  async function getBook(bookId) {
    var d = getDb();
    if (!d) return null;
    var b = await d.readingBooks.get(bookId);
    if (!b) return null;
    return {
      id: b.id,
      title: b.title,
      lastOpened: b.lastOpened || 0,
      linkedStoryId: b.linkedStoryId || null,
      charCount: b.charCount || 0,
      pageCount: b.pageCount || 0,
      currentPage: b.currentPage || 0
    };
  }

  /**
   * 取一页 —— 走 [bookId+pageNo] 复合索引, O(log n), 不扫全书的页
   */
  async function getPage(bookId, pageNo) {
    var d = getDb();
    if (!d) return null;
    try {
      var p = await d.readingPages.where('[bookId+pageNo]').equals([bookId, pageNo]).first();
      if (p) {
        return {
          pageNo: p.pageNo, text: p.text || '',
          chapterTitle: p.chapterTitle || '', chapterLine: p.chapterLine || ''
        };
      }
    } catch (e) {
      // 老库没有复合索引 → 兜底
      logWarn('复合索引不可用, 回落扫描', e);
    }
    var all = await d.readingPages.where('bookId').equals(bookId).toArray();
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].pageNo === pageNo) { hit = all[i]; break; }
    }
    return hit ? {
      pageNo: hit.pageNo, text: hit.text || '',
      chapterTitle: hit.chapterTitle || '', chapterLine: hit.chapterLine || ''
    } : null;
  }

  /**
   * 取一批页 (目录预览 / 上下文用)
   *
   * ⚠️ 必须走 [bookId+pageNo] 复合索引的 between, 不能 where('bookId').equals().toArray()
   *   —— 那会把这本书的【全部】页读出来 (二十四史 = 3.2 万条 = 几百毫秒 + 大量内存)。
   *
   * ⚠️⚠️ Dexie 复合索引的 between, 上界默认是【排他】的!
   *   实测 (探针 _reports/reading-room-test/probe.html):
   *     between([7,5],[7,9])            → 5,6,7,8   ← 少了 9!
   *     between([7,5],[7,10],true,false) → 5,6,7,8,9 ← 对
   *   (单键索引的 between 上界是含的, 复合索引不是 —— 别照抄单键那套写法)
   *   → 上界要写 to+1 并且排他。
   */
  async function getPageRange(bookId, from, count) {
    var d = getDb();
    if (!d || !count) return [];
    var upper = from + count;   // 排他上界 = 最后一页 + 1
    try {
      var rows = await d.readingPages.where('[bookId+pageNo]')
        .between([bookId, from], [bookId, upper], true, false)
        .toArray();
      return rows.map(function (r) {
        return {
          pageNo: r.pageNo, text: r.text || '',
          chapterTitle: r.chapterTitle || '', chapterLine: r.chapterLine || ''
        };
      });
    } catch (e) {
      logWarn('复合索引区间查询失败, 回落扫描', e);
      var all = await d.readingPages.where('bookId').equals(bookId).toArray();
      all.sort(function (a, b) { return a.pageNo - b.pageNo; });
      return all.slice(from, from + count).map(function (r) {
        return {
          pageNo: r.pageNo, text: r.text || '',
          chapterTitle: r.chapterTitle || '', chapterLine: r.chapterLine || ''
        };
      });
    }
  }

  /**
   * 章目录 (目录用)
   *
   * ⚠️ 目录是【导入时顺手攒好、存在书元数据行里的】, 不是现扫正文 ——
   *   现扫的话要把这本书的每一页都读一遍 (二十四史 = 3.2 万条, 几百毫秒)。
   */
  async function getChapterIndex(bookId) {
    var d = getDb();
    if (!d) return [];
    var b = await d.readingBooks.get(bookId);
    if (!b) return [];
    if (Array.isArray(b.chapters)) return b.chapters;
    // 老书 (迁移进来的) 没有 chapters 字段 → 现扫一遍并顺手存回去
    var rows = await d.readingPages.where('bookId').equals(bookId).toArray();
    var out = [];
    var last = '';
    rows.sort(function (a, b2) { return a.pageNo - b2.pageNo; });
    for (var i = 0; i < rows.length; i++) {
      var ct = rows[i].chapterTitle || '';
      if (ct && ct !== last) {
        out.push({ pageNo: rows[i].pageNo, title: ct });
        last = ct;
      }
    }
    try { await d.readingBooks.update(bookId, { chapters: out }); } catch (e) { /* noop */ }
    return out;
  }

  // ============================================================
  // 写
  // ============================================================

  /** 存阅读进度 —— 只改元数据行 (几十字节, 不是整本书) */
  async function setProgress(bookId, pageNo) {
    var d = getDb();
    if (!d) return false;
    try {
      await d.readingBooks.update(bookId, {
        currentPage: pageNo,
        lastOpened: Date.now()
      });
      return true;
    } catch (e) {
      logError('存进度失败:', e);
      return false;
    }
  }

  async function deleteBook(bookId) {
    var d = getDb();
    if (!d) return false;
    try {
      await d.readingPages.where('bookId').equals(bookId).delete();
      await d.readingBooks.delete(bookId);
      // 封面在独立库里, 顺手删掉, 别留孤儿数据。
      // ⚠️ 封面库可能压根不存在 (没换过封面的人) → 任何异常都忽略,
      //    绝对不能因为"封面没删掉"就让删书失败。
      try {
        var cd = getCoverDb();
        if (cd) await cd.readingCovers.delete(Number(bookId));
      } catch (e) { /* noop */ }
      return true;
    } catch (e) {
      logError('删书失败:', e);
      return false;
    }
  }

  async function renameBook(bookId, title) {
    var d = getDb();
    if (!d) return false;
    try {
      await d.readingBooks.update(bookId, { title: String(title || '未命名') });
      return true;
    } catch (e) { return false; }
  }

  // ============================================================
  // 封面 (独立数据库 ReadingCoversDB, 2026-11-03)
  //
  // 【铁律: 换封面只碰这一行】
  //   书名 / 页数 / currentPage / 正文 / 讨论记录 / 书籍 ID —— 一个都不动。
  //   也不重新导入, 不碰 readingBooks 和 readingPages。
  //
  // 【为什么封面放独立库, 不放在主库(330 的 GeminiChatDB)里】
  //   ⚠️ 这是 2026-11-03 踩出来的血泪教训, 别再改回去:
  //   第一版是 `db.version(73).stores({ readingCovers })` —— 加到主库上。
  //   结果用户一刷新就是【整个 app 白屏, 控制台一条红字都没有】。
  //   根因: IndexedDB 里「只要还有别的连接开着旧版本, 本次升版就无限期排队」,
  //        而那个旧连接可能是同一个浏览器里卡住的旧标签页, 甚至旧 Service Worker。
  //        升级一被挡住, db.open() 就【既不成功也不失败】(pending),
  //        启动链里 `await loadAllDataFromDB()` 永远等不到库 →
  //        showScreen('home-screen') 永远不执行 → 白屏。
  //        而 pending 不算 error, 所以控制台干净得跟没事一样, 极难查。
  //   复现证据: _reports/reading-room-test/diag-boot4.cjs (无头 Edge + CDP)
  //        B 标签页 idbLog 里【没有】GeminiChatDB 的 upgradeneeded/open-success,
  //        indexedDB.databases() 一直显示 720, dbReady 90 秒都到不了 true。
  //
  //   ⇒ 所以: 主库一个版本号都别动 (停在 72, 跟加封面之前完全一样)。
  //     封面单独一个库, 跟项目里现有的 PetNestDB / XSocialDB / CinemaSandboxDB
  //     一个路子 —— 各管各的, 它怎么建、建没建成功, 都不会影响 app 能不能打开。
  //   ⇒ 而且这个库是【懒建】的: 没换过封面的人, IndexedDB 里根本不会有它。
  // ============================================================

  var COVER_DB_NAME = 'ReadingCoversDB';
  var COVER_STORE = 'readingCovers';
  var coverDb = null;
  var coverDbBroken = false;

  /**
   * 拿封面库 (第一次调用才建连接, 真正建库是在第一次读写时)
   * @returns {object|null} Dexie 实例; Dexie 没加载或库坏了就 null
   */
  function getCoverDb() {
    if (coverDbBroken) return null;
    if (coverDb) return coverDb;
    var DexieCtor = global.Dexie;
    if (typeof DexieCtor !== 'function') {
      // 主库能用的前提下 Dexie 一定是有的; 真没有就让封面功能安静失效,
      // 绝对不能因此把书架也搞挂。
      logWarn('Dexie 不在, 封面功能不可用');
      coverDbBroken = true;
      return null;
    }
    try {
      coverDb = new DexieCtor(COVER_DB_NAME);
      coverDb.version(1).stores({
        readingCovers: 'bookId'    // { bookId, data: dataURL, updatedAt }
      });
      return coverDb;
    } catch (e) {
      logError('封面库初始化失败:', e);
      coverDbBroken = true;
      return null;
    }
  }

  /**
   * 换封面
   * @param {number|string} bookId
   * @param {string} dataUrl 已经压缩过的 dataURL (jpeg, 20~50KB)
   */
  async function setCover(bookId, dataUrl) {
    var d = getCoverDb();
    if (!d) return false;
    var data = String(dataUrl || '');
    if (!data) return false;
    // ⚠️ bookId 必须转成数字 —— readingBooks 是 ++id (数字主键),
    //   而沙盒那边 data-book-id 属性是字符串, 直接拿字符串当主键会多存一行 ('1' 和 1 两条)
    var key = Number(bookId);
    if (!isFinite(key)) return false;
    try {
      await d.readingCovers.put({
        bookId: key,
        data: data,
        updatedAt: Date.now()
      });
      return true;
    } catch (e) {
      logError('存封面失败:', e);
      return false;
    }
  }

  /** 取某本书的封面 (没有就是 null) */
  async function getCover(bookId) {
    var d = getCoverDb();
    if (!d) return null;
    var key = Number(bookId);
    if (!isFinite(key)) return null;
    try {
      var row = await d.readingCovers.get(key);
      return (row && row.data) || null;
    } catch (e) { return null; }
  }

  /**
   * 书架列表用的封面表: { bookId: dataURL }
   *
   * ⚠️ 单独查一次, 【不塞进 listBooks()】——
   *   listBooks() 的铁律是只搬元数据 (开书架要快), 一本书的封面 20~50KB base64,
   *   塞进去等于开一次书架把所有封面搬一遍 (跟当年"整本书塞一条记录"同一个坑)。
   *
   * ⚠️ 去重名表里拿 (独立库), 而且【别让它的失败影响书架】:
   *   库里一条封面都没有时这里会去建库/开库, 慢一点也得忍着,
   *   但任何异常都必须吞掉 —— 封面读不出来顶多没封面, 书架不能因此打不开。
   */
  async function listCovers() {
    var d = getCoverDb();
    if (!d) return {};
    try {
      var rows = await d.readingCovers.toArray();
      var out = {};
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r && r.bookId != null && r.data) out[r.bookId] = r.data;
      }
      return out;
    } catch (e) {
      logError('读封面失败:', e);
      return {};
    }
  }

  // ============================================================
  // 旧书迁移
  //
  // 老的 readingLibrary 表里可能有用户已经导入的书 (很可能就是那本二十四史)。
  // 那些记录的 content 字段是整本书 —— 正是卡 + 热的根源。
  // 迁移: 读出来 → 切页 → 写进新表 → 删掉旧记录 (content 字段跟着消失)。
  //
  // ⚠️ 迁移用 Paginator 逐段处理, 不建整份行数组 ——
  //   否则迁移那一下又变成"整本书切行常驻", 白折腾。
  // ============================================================
  async function migrateLegacy(onProgress) {
    var d = getDb();
    if (!d) return { migrated: 0, skipped: 0 };
    if (!d.readingLibrary) return { migrated: 0, skipped: 0 };

    var migrated = 0;
    var skipped = 0;

    // ⚠️ 必须用 primaryKeys() 而不是 toArray()。
    //   toArray() 会把每条记录连同【整本书的正文】一起反序列化进 JS 堆 ——
    //   二十四史那一条就是 38MB, 一次全 load 进来 = 迁移本身先把手机搞卡。
    //   primaryKeys() 只给 id, 一次一个 get, 处理完立刻删 → 峰值只有一本。
    var ids = [];
    try {
      ids = await d.readingLibrary.toCollection().primaryKeys();
    } catch (e) {
      logWarn('读旧书库失败:', e);
      return { migrated: 0, skipped: 0 };
    }
    if (!ids.length) return { migrated: 0, skipped: 0 };

    for (var i = 0; i < ids.length; i++) {
      var old = null;
      try {
        old = await d.readingLibrary.get(ids[i]);
      } catch (e) {
        old = null;
      }
      if (!old) { skipped++; continue; }

      var content = String((old && old.content) || '');
      if (!content.trim()) {
        // 没正文的旧记录 (可能有 currentPage) —— 直接删, 别留着占地方
        try { await d.readingLibrary.delete(old.id); } catch (e) { /* noop */ }
        skipped++;
        continue;
      }
      try {
        var res = await importText(old.title || '未命名', content, {
          linkedStoryId: old.linkedStoryId || null
        });
        // 把旧的进度接上
        if (old.currentPage) {
          try { await d.readingBooks.update(res.bookId, { currentPage: old.currentPage }); } catch (e) { /* noop */ }
        }
        await d.readingLibrary.delete(old.id);
        migrated++;
        log('迁移《' + (old.title || '未命名') + '》→ ' + res.pageCount + ' 页');
      } catch (e) {
        logError('迁移《' + (old.title || '未命名') + '》失败:', e);
        skipped++;
      }
      if (onProgress) { try { onProgress(i + 1, ids.length); } catch (e) { /* noop */ } }
    }

    // 老表整个清空 —— content 字段是几十兆的垃圾, 留着就是纯占地方
    try { await d.readingLibrary.clear(); } catch (e) { /* noop */ }

    return { migrated: migrated, skipped: skipped };
  }

  /**
   * 老表里还有没有东西 (只查条数, 不载正文)
   */
  async function legacyCount() {
    var d = getDb();
    if (!d || !d.readingLibrary) return 0;
    try {
      return await d.readingLibrary.count();
    } catch (e) { return 0; }
  }

  // ============================================================
  // 导出
  // ============================================================
  global.ReadingStorage = {
    // 写
    importText: importText,
    importFile: importFile,
    importChapters: importChapters,
    setProgress: setProgress,
    deleteBook: deleteBook,
    renameBook: renameBook,
    setCover: setCover,
    getCover: getCover,
    listCovers: listCovers,
    migrateLegacy: migrateLegacy,
    legacyCount: legacyCount,
    // 读
    listBooks: listBooks,
    getBook: getBook,
    getPage: getPage,
    getPageRange: getPageRange,
    getChapterIndex: getChapterIndex,
    // 工具 (暴露给测试)
    Paginator: Paginator,
    detectEncoding: detectEncoding,
    isChapterLine: isChapterLine,
    PAGE_TARGET_CHARS: PAGE_TARGET_CHARS
  };

  log('已加载 (分页存储: 一页一条, 常驻内存只有当前页)');
})(window);

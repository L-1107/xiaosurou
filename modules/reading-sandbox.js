// ============================================================
// modules/reading-sandbox.js
// 读书屋 · 沙盒侧 (跑在 reading-sandbox/index.html 里)
//
// 【这个文件的边界】
//   只做三件事:
//     ① 渲染 (书架 / 阅读室)
//     ② 交互 (翻页 / 选段提问 / 拖分隔条)
//     ③ 跟宿主对话 (postMessage)
//
//   【不碰的事】
//     · 不碰 IndexedDB —— 沙盒和宿主同源, 技术上能开同一个库, 但那会撞
//       versionchange 冲突, 而且老代码里 "db.close() 自愈" 那条路能把宿主库
//       的自动重开永久关掉 (sw.js 里记过: 症状是"存不下 / 整页刷新前全都存不进去")。
//     · 不自己发 AI 请求 —— 沙盒里没有 ai-response.js / utils.js / live-client.js,
//       主 API 要是谷歌原生地址, 自己拼必然 404。请求交给宿主代打。
//
// 【跟宿主的消息协议】详见 reading-sandbox/index.html 顶部的注释。
// ============================================================

(function () {
  'use strict';

  var LOG = '[ReadingSandbox] ';

  function log(msg, extra) {
    console.log(LOG + msg, extra === undefined ? '' : extra);
  }
  function logWarn(msg, extra) {
    console.warn(LOG + '⚠️ ' + msg, extra === undefined ? '' : extra);
  }

  // ============================================================
  // 状态
  // ============================================================
  var S = {
    view: 'hall',          // 'hall' | 'reader'
    books: [],
    book: null,            // 当前书 { id, title, pageCount, currentPage, ... }
    pageNo: 0,
    pageCount: 0,
    pageText: '',
    chapterTitle: '',
    chapterLine: '',      // 章节的原始标题行 (由分页层给, 渲染层不自己猜)
    selected: '',          // 用户圈出来的那句
    pickedText: '',        // 浮标弹出那一刻的选区原文 (点浮标时选区可能已经被系统清掉)
    fabHolding: false,     // 手指正按在浮标上 —— 这期间不许藏浮标
    chatBusy: false,
    chatSeq: 0,
    lastAiBubble: null,
    hostApiConfig: null,
    chat: null             // 宿主给的聊天对象
  };

  // ============================================================
  // DOM
  // ============================================================
  var el = {};
  function grab() {
    var ids = [
      'rr-boot', 'rr-boot-msg', 'rr-root', 'rr-hall', 'rr-hall-close', 'rr-search',
      'rr-import-btn', 'rr-file-input', 'rr-grid', 'rr-empty',
      'rr-reader', 'rr-back', 'rr-book-title', 'rr-book-stat', 'rr-page-label',
      'rr-page-area', 'rr-page-card', 'rr-chapter', 'rr-page-text', 'rr-picked',
      'rr-pick-fab', 'rr-prev', 'rr-next', 'rr-page-num',
      'rr-splitter', 'rr-chat', 'rr-chat-toggle', 'rr-chat-hint', 'rr-chat-body',
      'rr-chat-input', 'rr-send-btn', 'rr-toast', 'rr-import', 'rr-import-title',
      'rr-import-bar', 'rr-import-sub',
      // 换封面 (2026-11-02)
      'rr-cover-input', 'rr-cover-preview', 'rr-cover-preview-img',
      'rr-cover-cancel', 'rr-cover-confirm'
    ];
    for (var i = 0; i < ids.length; i++) {
      el[ids[i].replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] =
        document.getElementById(ids[i]);
    }
  }

  // ============================================================
  // 跟宿主通信
  // ============================================================
  var IN_IFRAME = (window.parent && window.parent !== window);

  function post(msg) {
    if (!IN_IFRAME) return false;
    try {
      window.parent.postMessage(msg, '*');
      return true;
    } catch (e) {
      logWarn('发给宿主失败:', e);
      return false;
    }
  }

  // ============================================================
  // 提示条
  // ============================================================
  var toastTimer = null;
  function toast(text, ms) {
    if (!el.rrToast) return;
    el.rrToast.textContent = String(text || '');
    el.rrToast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.rrToast) el.rrToast.classList.remove('on');
    }, ms || 2600);
  }

  // ============================================================
  // 视图切换
  // ============================================================
  function showView(name) {
    S.view = name;
    if (el.rrHall) el.rrHall.classList.toggle('active', name === 'hall');
    if (el.rrReader) el.rrReader.classList.toggle('active', name === 'reader');
    if (name === 'hall') {
      // 退回书架时把这一页的位置存一下, 下次进来接着读
      saveProgress();
      // 顺便跟宿主要一份最新的书架 (刚导入的书 / 刚删掉的书要立刻反映出来)
      post({ type: 'reading:needBooks' });
    }
  }

  // ============================================================
  // 书架大厅
  // ============================================================
  function renderHall() {
    if (!el.rrGrid) return;
    var q = (el.rrSearch && el.rrSearch.value ? el.rrSearch.value : '').trim().toLowerCase();
    var list = S.books.filter(function (b) {
      if (!q) return true;
      return String(b.title || '').toLowerCase().indexOf(q) >= 0;
    });

    el.rrGrid.innerHTML = '';
    if (el.rrEmpty) el.rrEmpty.style.display = list.length ? 'none' : 'block';

    for (var i = 0; i < list.length; i++) {
      el.rrGrid.appendChild(buildBookCard(list[i]));
    }
  }

  /**
   * 字数格式化 (2026-11-03 提出来共用)
   *
   * 以前只在卡片上用; 卡片说明区去掉后, 阅读页顶栏也要显示字数 → 共用这一个。
   */
  function formatCharCount(n) {
    n = Number(n) || 0;
    return n > 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字';
  }

  /**
   * 造一张书卡片
   *
   * ⚠️ 2026-11-02 修掉一个老 bug:
   *   以前整段是直接写在 renderHall 的 for 循环里的 ——
   *   `var b = list[i]` + 闭包里引用 b, 而 var 是【函数级】的,
   *   循环跑完 b = 列表里【最后一本】, 所有卡片的点击回调拿到的都是它
   *   → 【点哪本书都打开最后那一本书】。
   *   (用户那边一直只有一本书, 所以没人发现)
   *   现在每张卡单独一个函数, book 是形参 → 每张卡只认自己那本书。
   *
   * ⚠️ 2026-11-03 用户反馈"封面图占全部不好看, 下面那行说明文字不要了":
   *   卡片现在【只留封面图】, 说明区(书名/字数/页数/进度条)整个去掉,
   *   封面也改成 contain —— 整张图完整显示不裁切 (见 reading-sandbox.css)。
   *   书名和页码阅读页顶栏本来就有, 字数也补到顶栏了 (见 openBook)。
   */
  function buildBookCard(b) {
    var card = document.createElement('div');
    card.className = 'rr-book-card';
    card.setAttribute('data-book-id', String(b.id));

    card.innerHTML =
      '<div class="rr-cover"></div>' +
      // ⚠️ 2026-11-02: 原来这里是常驻的 🗑 按钮, 现在换成 ⋯ 三点菜单
      //   (菜单里才是"更换封面 / 删除书籍"), 见下面的 showCardMenu()。
      //   三个点是 CSS 画的 (三个 <i>), 不用另外准备素材。
      '<button class="rr-card-menu-btn" title="更多" aria-label="更多"><i></i><i></i><i></i></button>';
    // 2026-11-02: 自定义封面优先, 没有就还是默认那张书架背景。
    //   (dataURL 是 base64, 不含引号/括号, 直接塞进 url() 不会有注入问题)
    card.querySelector('.rr-cover').style.backgroundImage = b.cover
      ? 'url(' + JSON.stringify(b.cover) + ')'
      : 'url("../assets/reading-room/reading-hall-bg-thumb.webp")';

    card.addEventListener('click', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('rr-card-menu-btn')) return;
      openBook(b.id);
    });
    var menuBtn = card.querySelector('.rr-card-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        showCardMenu(menuBtn, b);
      });
    }

    return card;
  }

  function confirmDelete(b) {
    if (window.confirm('确定要把《' + (b.title || '这本书') + '》从书架移除吗？')) {
      post({ type: 'reading:deleteBook', bookId: b.id });
      toast('已移除');
    }
  }

  // ============================================================
  // 卡片菜单 (2026-11-02)
  //
  // 以前每张卡片右上角常驻一个 🗑, 现在换成一个 ⋯:
  //   点 ⋯ → 弹一张羊皮纸小卷轴 → 里面只有两项: 更换封面 / 删除书籍。
  //
  // 规矩:
  //   · 同一时间只允许展开一个菜单 (openMenu 是全局唯一那个)
  //   · 点菜单外面 / 滑动页面 = 关掉
  //   · 删除走【原有的 confirmDelete】, 不重写一套删除机制
  // ============================================================
  var openMenu = null;    // 当前展开的菜单元素
  var openMenuBtn = null; // 当前展开的菜单是哪个按钮点的

  function closeCardMenu() {
    if (openMenu && openMenu.parentNode) openMenu.parentNode.removeChild(openMenu);
    openMenu = null;
    if (openMenuBtn) {
      openMenuBtn.classList.remove('on');
      openMenuBtn = null;
    }
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('scroll', closeCardMenu, true);
  }

  function onMenuOutside(e) {
    var t = e.target;
    if (openMenu && openMenu.contains(t)) return;
    // ⋯ 按钮本身不算"外面" —— 让它自己处理开/关 (否则会先关再开)
    if (openMenuBtn && openMenuBtn.contains(t)) return;
    closeCardMenu();
  }

  function showCardMenu(btn, book) {
    var wasOpen = (openMenuBtn === btn);
    closeCardMenu();
    if (wasOpen) return;   // 再点一下同一个 ⋯ = 收起

    var menu = document.createElement('div');
    menu.className = 'rr-card-menu';
    // 文字放在内层容器里 (绝对定位) —— 见 reading-sandbox.css 里 .rr-card-menu-items
    // 那段注释: 百分比 padding 会按整个视口算, 把菜单撑变形。
    var box = document.createElement('div');
    box.className = 'rr-card-menu-items';

    var itemCover = document.createElement('button');
    itemCover.className = 'rr-card-menu-item';
    itemCover.textContent = '更换封面';

    var itemDel = document.createElement('button');
    itemDel.className = 'rr-card-menu-item';
    itemDel.textContent = '删除书籍';

    // ⚠️ 文字全部用 textContent —— 羊皮纸素材里没有字, 字都是这儿渲染的
    box.appendChild(itemCover);
    box.appendChild(itemDel);
    menu.appendChild(box);
    document.body.appendChild(menu);

    openMenu = menu;
    openMenuBtn = btn;
    btn.classList.add('on');

    // 定位: 贴在按钮下面; 屏幕装不下就翻到上面; 左右不许出屏
    var r = btn.getBoundingClientRect();
    var mw = menu.offsetWidth || 164;
    var mh = menu.offsetHeight || 196;
    var left = r.left + r.width / 2 - mw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';

    itemCover.addEventListener('click', function (e) {
      e.stopPropagation();
      closeCardMenu();
      pickCover(book);
    });
    itemDel.addEventListener('click', function (e) {
      e.stopPropagation();
      closeCardMenu();
      confirmDelete(book);   // ← 沿用原有的删除逻辑 (二次确认 + reading:deleteBook)
    });

    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('scroll', closeCardMenu, true);
  }

  // ============================================================
  // 换封面 (2026-11-02)
  //
  // 【分工】沙盒做"选图 + 压缩 + 预览", 宿主做"保存"。
  //   沙盒不碰 IndexedDB (同源开同一个库会撞 versionchange, 见文件头说明),
  //   所以压缩后的图交给宿主写进 readingCovers 表。
  //
  // 【为什么要压】手机相册一张照片 3~8MB, 直接存进 IndexedDB,
  //   十几本书就能堆掉上百 MB → 手机上迟早出问题。
  //   缩到最长边 420px (卡片才 136px 宽, 3 倍屏够用) + JPEG 0.8 → 一张约 20~40KB。
  // ============================================================
  var coverBook = null;   // 正在换封面的那本书
  var coverData = '';     // 压好待确认的 dataURL

  function pickCover(book) {
    if (!book) return;
    if (!el.rrCoverInput) { toast('这个浏览器不支持选图'); return; }
    coverBook = book;
    coverData = '';
    el.rrCoverInput.value = '';   // 清空 → 连续选同一张也能触发 change
    try {
      el.rrCoverInput.click();
    } catch (e) {
      logWarn('打开相册失败:', e);
      toast('打不开相册');
    }
  }

  function closeCoverPreview() {
    if (el.rrCoverPreview) el.rrCoverPreview.classList.remove('on');
    coverBook = null;
    coverData = '';
    if (el.rrCoverPreviewImg) el.rrCoverPreviewImg.removeAttribute('src');
  }

  function compressCoverImage(file, maxSide, quality) {
    maxSide = maxSide || 420;
    quality = quality || 0.8;
    return loadImageBitmap(file).then(function (src) {
      var w = src.width || src.naturalWidth;
      var h = src.height || src.naturalHeight;
      if (!w || !h) throw new Error('图片尺寸异常');
      var scale = Math.min(1, maxSide / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      var ctx = cv.getContext('2d');
      // ⚠️ 先铺一层纸色 —— 透明的 PNG 转 JPEG 时不铺底会变成黑块
      ctx.fillStyle = '#fffdf7';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, 0, 0, cw, ch);
      if (src && typeof src.close === 'function') { try { src.close(); } catch (e) { /* noop */ } }
      return cv.toDataURL('image/jpeg', quality);
    });
  }

  function loadImageBitmap(file) {
    // 优先 createImageBitmap: 它按 EXIF 摆正 (手机竖拍的照片不会躺倒)
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return loadImageElement(file); });
    }
    return loadImageElement(file);
  }

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  // ============================================================
  // 阅读室
  // ============================================================

  /**
   * 渲染这一页
   *
   * ⚠️ 章节标题【不在这儿自己猜】—— 用分页层存好的 chapterLine。
   *   之前这里跟 reading-storage.js 各写一份正则, 两边判定不一致的时候
   *   (第1卷第1段：xxx 这种正文被一边当标题一边不当) 整页正文就没了。
   *   现在只有 reading-storage.js 一处说了算。
   */
  function renderPage() {
    if (!el.rrPageText) return;
    var lines = String(S.pageText || '').split('\n');
    var html = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      var trimmed = line.trim();
      if (S.chapterLine && trimmed === S.chapterLine) {
        var t = trimmed.replace(/^=+\s*/, '').replace(/\s*=+$/, '').replace(/^【|】$/g, '');
        html.push('<div class="rr-ch-line">' + escapeHtml(t) + '</div>');
      } else {
        html.push('<p>' + escapeHtml(line) + '</p>');
      }
    }
    el.rrPageText.innerHTML = html.join('');

    if (el.rrChapter) {
      if (S.chapterTitle) {
        el.rrChapter.textContent = S.chapterTitle;
        el.rrChapter.style.display = 'block';
      } else {
        el.rrChapter.style.display = 'none';
      }
    }

    var label = S.pageCount ? ((S.pageNo + 1) + ' / ' + S.pageCount) : '— / —';
    if (el.rrPageLabel) el.rrPageLabel.textContent = label;
    if (el.rrPageNum) el.rrPageNum.textContent = label;
    if (el.rrPrev) el.rrPrev.disabled = S.pageNo <= 0;
    if (el.rrNext) el.rrNext.disabled = !S.pageCount || S.pageNo >= S.pageCount - 1;
    if (el.rrPageArea) el.rrPageArea.scrollTop = 0;

    renderPicked();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderPicked() {
    if (!el.rrPicked) return;
    if (S.selected) {
      // ⚠️ 只显示前 60 字 —— 整句塞进来会撑成 6 行, 把正文挡掉一大半。
      //   完整那句照样原样带去给 AI, 这里只是给人看的提示。
      var shown = S.selected.length > 60 ? S.selected.substring(0, 60) + '…' : S.selected;
      el.rrPicked.innerHTML = '<b>已圈出：</b>' + escapeHtml(shown);
      el.rrPicked.classList.add('on');
    } else {
      // ⚠️ 连文字一起清 —— 之前只摘 class, 结果选区没了提示条里还留着上一句,
      //   看着像"还圈着", 其实是脏数据。
      el.rrPicked.innerHTML = '';
      el.rrPicked.classList.remove('on');
    }
    // 提示条是 sticky 贴在底部的 → 底下要留出它的高度, 否则最后一段正文被它盖住
    if (el.rrPageArea) el.rrPageArea.classList.toggle('has-picked', !!S.selected);
  }

  function openBook(bookId) {
    var book = null;
    for (var i = 0; i < S.books.length; i++) {
      if (S.books[i].id === bookId) { book = S.books[i]; break; }
    }
    if (!book) { toast('找不到这本书'); return; }
    S.book = book;
    S.pageCount = book.pageCount || 0;
    S.pageNo = Math.max(0, Math.min(book.currentPage || 0, Math.max(0, S.pageCount - 1)));
    S.pageText = '';
    S.chapterTitle = '';
    S.chapterLine = '';
    S.selected = '';
    S.pickedText = '';
    if (el.rrBookTitle) el.rrBookTitle.textContent = book.title || '未命名';
    // 字数显示在顶栏 (2026-11-03): 书架卡片的说明区去掉后, 字数信息挪到这儿。
    if (el.rrBookStat) el.rrBookStat.textContent = formatCharCount(book.charCount);
    showView('reader');
    requestPage(S.pageNo);
  }

  function requestPage(pageNo) {
    if (!S.book) return;
    post({ type: 'reading:requestPage', bookId: S.book.id, pageNo: pageNo });
  }

  function saveProgress() {
    if (!S.book) return;
    post({ type: 'reading:saveProgress', bookId: S.book.id, pageNo: S.pageNo });
  }

  function turnPage(delta) {
    if (!S.book || !S.pageCount) return;
    var next = S.pageNo + delta;
    if (next < 0 || next >= S.pageCount) return;
    S.pageNo = next;
    S.selected = '';
    S.pickedText = '';
    hideFab();
    requestPage(S.pageNo);
    saveProgress();
  }

  // ============================================================
  // 选段提问
  // ============================================================
  function currentSelectionText() {
    try {
      var sel = window.getSelection();
      if (!sel) return '';
      var txt = String(sel.toString() || '').trim();
      return txt;
    } catch (e) { return ''; }
  }

  function showFab() {
    if (!el.rrPickFab) return;
    var txt = currentSelectionText();
    if (!txt) { hideFab(); return; }
    // ⚠️ 把选区原文存下来 —— 真机上"点浮标"这一步, 系统可能已经把选区清掉了
    //   (手指抬起 → touchend → 选区消失), 到时候再读 getSelection() 就是空,
    //   结果用户点了"问 AI"没反应。存快照才能保证点得到。
    S.pickedText = txt;
    var rect = null;
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (e) { /* noop */ }
    el.rrPickFab.classList.add('on');
    if (rect) {
      var top = Math.max(8, rect.top - 42);
      var left = Math.min(window.innerWidth - 96, Math.max(8, rect.left + rect.width / 2 - 42));
      el.rrPickFab.style.top = top + 'px';
      el.rrPickFab.style.left = left + 'px';
    } else {
      el.rrPickFab.style.top = '120px';
      el.rrPickFab.style.left = '16px';
    }
  }

  function hideFab() {
    if (el.rrPickFab) el.rrPickFab.classList.remove('on');
    // ⚠️ 这里【不】清 S.pickedText —— 点浮标的流程是"先取值再 hideFab",
    //   清早了就把刚选好的句子丢了。快照由 pickSelection / turnPage 各自负责清。
  }

  function pickSelection() {
    // 先拿原文再 hideFab —— hideFab 不清快照, 两者互不影响
    var txt = S.pickedText || currentSelectionText();
    hideFab();
    if (!txt) { toast('先长按选中一句话'); return; }
    S.selected = txt;
    S.pickedText = '';
    renderPicked();
    // 展开聊天窗口 (收着的话先把选中的句子存着, 展开后带过去)
    if (el.rrChat && el.rrChat.classList.contains('collapsed')) toggleChat(false);
    toast('已圈住这句，可以直接问 AI 了');
    if (el.rrChatInput) {
      el.rrChatInput.focus();
      try { el.rrChatInput.setSelectionRange(el.rrChatInput.value.length, el.rrChatInput.value.length); } catch (e) { /* noop */ }
    }
  }

  // ============================================================
  // 聊天窗口
  // ============================================================
  /** 角色头像（没配就返回空，气泡就不显示头像） */
  function aiAvatarUrl() {
    try {
      var s = (S.chat && S.chat.settings) || {};
      return String(s.aiAvatar || '');
    } catch (e) { return ''; }
  }

  function appendMsg(role, text) {
    if (!el.rrChatBody) return null;
    var d = document.createElement('div');
    d.className = 'rr-msg ' + (role === 'user' ? 'user' : (role === 'sys' ? 'sys' : 'ai'));

    // AI 气泡带角色头像 (2026-11-03, 用户要求"可以加显示 AI 头像", 跟主聊天一个观感)。
    // ⚠️ 头像要放在【气泡外面】的同一行里 —— 所以 AI 那条多一层 .rr-msg-row 包着,
    //    .rr-msg 自己仍然是气泡本体 (下面的 textContent 一律操作它)。
    if (role === 'ai') {
      var row = document.createElement('div');
      row.className = 'rr-msg-row';
      var av = aiAvatarUrl();
      if (av) {
        var img = document.createElement('img');
        img.className = 'rr-msg-avatar';
        img.src = av;
        img.alt = '';
        row.appendChild(img);
      }
      var bubble = document.createElement('div');
      bubble.className = 'rr-msg ai';
      bubble.textContent = String(text || '');
      row.appendChild(bubble);
      el.rrChatBody.appendChild(row);
      el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
      return bubble;   // 返回气泡本体, 调用方照旧往里写文字
    }

    d.textContent = String(text || '');
    el.rrChatBody.appendChild(d);
    el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
    return d;
  }

  function setChatBusy(busy) {
    S.chatBusy = !!busy;
    if (el.rrSendBtn) el.rrSendBtn.disabled = !!busy;
    if (el.rrSendBtn) el.rrSendBtn.textContent = busy ? '…' : '发送';
  }

  function sendChat() {
    if (S.chatBusy) return;
    var text = (el.rrChatInput && el.rrChatInput.value ? el.rrChatInput.value : '').trim();
    if (!text) return;

    var selected = S.selected;
    var pageCtx = {
      bookTitle: S.book ? S.book.title : '',
      chapterTitle: S.chapterTitle,
      pageNo: S.pageNo,
      pageCount: S.pageCount,
      text: S.pageText
    };

    appendMsg('user', text);
    if (el.rrChatInput) el.rrChatInput.value = '';
    S.selected = '';
    S.pickedText = '';
    renderPicked();

    var bubble = appendMsg('ai', '');
    S.lastAiBubble = bubble;
    setChatBusy(true);

    var reqId = 'rc' + (++S.chatSeq) + '_' + Date.now();
    post({
      type: 'reading:chat',
      requestId: reqId,
      text: text,
      selected: selected,
      pageContext: pageCtx
    });
  }

  function onChatDelta(d) {
    if (!S.lastAiBubble) S.lastAiBubble = appendMsg('ai', '');
    S.lastAiBubble.textContent += String(d.delta || '');
    if (el.rrChatBody) el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
  }

  /**
   * 把一条 AI 回复按段落拆成多个气泡 (2026-11-03)
   *
   * 【为什么要拆】
   *   主聊天框里 AI 一次回复会显示成【好几个独立气泡】(它返回 JSON 数组, 一条一个)。
   *   读书屋这边是一条纯文字, 整段全塞进一个气泡 → 用户看到的是一大坨文字糊在
   *   一个框里, 跟主聊天完全不是一个观感。
   *   → 回复结束后按段落切开, 一段一个气泡, 观感就跟主聊天一致了。
   *
   * 【怎么切】
   *   先按空行切; 切不出来(模型没分段)再按单换行切; 还不行就整段一个气泡。
   *   不按句子切 —— 那样会把一句话拦腰截断, 读起来更碎。
   */
  function splitReplyParagraphs(text) {
    var t = String(text || '').trim();
    if (!t) return [];
    var parts = t.split(/\n\s*\n+/);
    if (parts.length <= 1) parts = t.split(/\n+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = String(parts[i] || '').trim();
      if (s) out.push(s);
    }
    return out.length ? out : [t];
  }

  /** 气泡本体 → 它在外层的那个"行"容器 (AI 气泡外面多套一层 .rr-msg-row, 见 appendMsg) */
  function rowOf(node) {
    if (!node) return null;
    var p = node.parentNode;
    if (p && p.classList && p.classList.contains('rr-msg-row')) return p;
    return node;
  }

  function onChatDone(d) {
    setChatBusy(false);
    var text = String(d.text || '').trim();
    var finalText = text || (S.lastAiBubble ? S.lastAiBubble.textContent : '');
    if (S.lastAiBubble) {
      // 流式过程一直在同一个气泡里追加; 结束后按段落拆开重排 (见 splitReplyParagraphs)
      var paras = splitReplyParagraphs(finalText);
      S.lastAiBubble.textContent = paras[0];
      var prevBubble = S.lastAiBubble;
      for (var i = 1; i < paras.length; i++) {
        var extra = appendMsg('ai', paras[i]);
        // ⚠️ 要按【行】插, 不能按气泡插 —— AI 气泡的 parentNode 是 .rr-msg-row,
        //   直接 insertBefore(extra, bubble.nextSibling) 会插到那一行【里面】。
        var prevRow = rowOf(prevBubble);
        var extraRow = rowOf(extra);
        if (extraRow && prevRow && prevRow.parentNode) {
          prevRow.parentNode.insertBefore(extraRow, prevRow.nextSibling);
        }
        prevBubble = extra;
      }
    } else if (text) {
      var ps = splitReplyParagraphs(text);
      for (var j = 0; j < ps.length; j++) appendMsg('ai', ps[j]);
    }
    S.lastAiBubble = null;
    if (el.rrChatBody) el.rrChatBody.scrollTop = el.rrChatBody.scrollHeight;
  }

  function onChatError(d) {
    setChatBusy(false);
    appendMsg('sys', '⚠️ ' + String(d.error || '聊天失败'));
    S.lastAiBubble = null;
  }

  function toggleChat(force) {
    if (!el.rrChat) return;
    var collapsed = el.rrChat.classList.contains('collapsed');
    // ⚠️ 原来写的是 want = collapsed —— 那"点一下收起"会变成"点一下保持收起",
    //   第一次点没反应, 第二次点才收。
    var want = (typeof force === 'boolean') ? force : !collapsed;
    el.rrChat.classList.toggle('collapsed', want);
    if (el.rrChatToggle) {
      el.rrChatToggle.style.transform = want ? 'rotate(180deg)' : '';
    }
  }

  // ---- 分隔条拖动 ----
  function bindSplitter() {
    if (!el.rrSplitter) return;
    var dragging = false;

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      var y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
      var h = window.innerHeight - y;
      var min = 140, max = window.innerHeight * 0.72;
      if (h < min) h = min;
      if (h > max) h = max;
      document.documentElement.style.setProperty('--rr-chat-h', h + 'px');
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchend', onEnd);
    }

    function onStart(e) {
      dragging = true;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    }

    el.rrSplitter.addEventListener('mousedown', onStart);
    el.rrSplitter.addEventListener('touchstart', onStart, { passive: false });
  }

  // ============================================================
  // 导入
  // ============================================================
  function startImport(file) {
    if (!file) return;
    if (el.rrImport) {
      el.rrImport.classList.add('on');
      if (el.rrImportTitle) el.rrImportTitle.textContent = '正在导入《' + file.name + '》';
      if (el.rrImportSub) el.rrImportSub.textContent = '正在读文件…';
      if (el.rrImportBar) el.rrImportBar.style.width = '0%';
    }
    post({ type: 'reading:importFile', file: file, title: file.name });
  }

  function onImportProgress(d) {
    if (!el.rrImport) return;
    var total = Number(d.totalBytes) || 0;
    var read = Number(d.readBytes) || 0;
    if (el.rrImportBar) {
      var pct = total > 0 ? Math.min(100, Math.round(read / total * 100)) : 0;
      el.rrImportBar.style.width = pct + '%';
    }
    if (el.rrImportSub) {
      el.rrImportSub.textContent = '正在切页… ' +
        (total > 0 ? (read / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB' : '') +
        (d.pageNo ? ' · 已切 ' + d.pageNo + ' 页' : '');
    }
  }

  function onImportDone(d) {
    if (el.rrImport) el.rrImport.classList.remove('on');
    toast('《' + (d.title || '') + '》导入了，' + (d.pageCount || 0) + ' 页');
    post({ type: 'reading:needBooks' });
  }

  function onImportError(d) {
    if (el.rrImport) el.rrImport.classList.remove('on');
    toast('导入失败：' + (d.error || '未知错误'), 4000);
  }

  // ============================================================
  // 收宿主消息
  // ============================================================
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (!d || typeof d !== 'object') return;

    switch (d.type) {
      case 'reading:init':
        S.chat = d.chat || null;
        if (d.chat && d.chat.apiConfig) S.hostApiConfig = d.chat.apiConfig;
        if (el.rrBoot) el.rrBoot.classList.add('hide');
        if (el.rrRoot) el.rrRoot.hidden = false;
        break;

      case 'reading:apiConfig':
        S.hostApiConfig = d.apiConfig || null;
        break;

      case 'reading:books':
        S.books = Array.isArray(d.books) ? d.books : [];
        renderHall();
        break;

      case 'reading:page':
        if (d.error) { toast('这一页取不到：' + d.error, 3500); break; }
        S.pageNo = Number(d.pageNo) || 0;
        S.pageText = String(d.text || '');
        S.chapterTitle = String(d.chapterTitle || '');
        S.chapterLine = String(d.chapterLine || '');
        if (d.pageCount) S.pageCount = d.pageCount;
        if (d.bookTitle && el.rrBookTitle) el.rrBookTitle.textContent = d.bookTitle;
        renderPage();
        // 报给宿主 → 主聊天那边的 AI 知道你在读什么
        post({
          type: 'reading:pageState',
          bookId: S.book ? S.book.id : null,
          title: S.book ? S.book.title : '',
          pageNo: S.pageNo,
          pageCount: S.pageCount,
          chapterTitle: S.chapterTitle,
          snippet: S.pageText.substring(0, 600)
        });
        break;

      case 'reading:importProgress':
        onImportProgress(d);
        break;

      case 'reading:importDone':
        onImportDone(d);
        break;

      case 'reading:importError':
        onImportError(d);
        break;

      case 'reading:chatDelta':
        onChatDelta(d);
        break;

      case 'reading:chatDone':
        onChatDone(d);
        break;

      case 'reading:chatError':
        onChatError(d);
        break;

      // 换封面 (2026-11-02)
      case 'reading:coverDone':
        toast('封面换好了');
        break;
      case 'reading:coverError':
        toast('⚠️ ' + String(d && d.error ? d.error : '封面没存上'));
        break;

      case 'reading:vv':
        // 宿主转发的真实可视视口 (iOS 键盘) + 状态栏高度
        if (typeof d.height === 'number' && d.height > 0) {
          document.documentElement.style.setProperty('--rr-vv-height', d.height + 'px');
          document.documentElement.style.setProperty('--rr-vv-top', Math.max(0, d.offsetTop || 0) + 'px');
        }
        // ⚠️ 状态栏高度: iframe 里 env(safe-area-inset-top) 量不到 (基本是 0),
        //   宿主是顶层文档, 它量得到真值 → 在这里转成 CSS 变量, 顶栏用它往下让。
        if (typeof d.safeTop === 'number' && d.safeTop >= 0) {
          document.documentElement.style.setProperty('--rr-safe-top', d.safeTop + 'px');
        }
        break;

      default:
        break;
    }
  });

  // ============================================================
  // 退出
  // ============================================================
  function closeRoom() {
    saveProgress();
    post({ type: 'reading:closed' });
  }

  // ============================================================
  // 启动
  // ============================================================
  function bindUi() {
    if (el.rrBack) el.rrBack.addEventListener('click', function () { showView('hall'); });
    if (el.rrHallClose) el.rrHallClose.addEventListener('click', closeRoom);
    if (el.rrPrev) el.rrPrev.addEventListener('click', function () { turnPage(-1); });
    if (el.rrNext) el.rrNext.addEventListener('click', function () { turnPage(1); });
    if (el.rrSearch) el.rrSearch.addEventListener('input', renderHall);

    if (el.rrImportBtn) {
      el.rrImportBtn.addEventListener('click', function () {
        if (el.rrFileInput) el.rrFileInput.click();
      });
    }
    if (el.rrFileInput) {
      el.rrFileInput.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        e.target.value = null;
        if (f) startImport(f);
      });
    }

    // ---- 换封面 (2026-11-02) ----
    if (el.rrCoverInput) {
      el.rrCoverInput.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        e.target.value = null;
        if (!f) return;
        compressCoverImage(f).then(function (dataUrl) {
          coverData = dataUrl;
          if (el.rrCoverPreviewImg) el.rrCoverPreviewImg.src = dataUrl;
          if (el.rrCoverPreview) el.rrCoverPreview.classList.add('on');
        }).catch(function (err) {
          logWarn('封面图片处理失败:', err);
          toast('这张图片打不开，换一张试试');
        });
      });
    }
    if (el.rrCoverConfirm) {
      el.rrCoverConfirm.addEventListener('click', function () {
        if (!coverBook || !coverData) { closeCoverPreview(); return; }
        // ⚠️ 只发 bookId + 封面本身 —— 书的内容/进度/讨论记录/ID 宿主那边一个都不碰
        post({ type: 'reading:setCover', bookId: coverBook.id, cover: coverData });
        closeCoverPreview();
      });
    }
    if (el.rrCoverCancel) {
      el.rrCoverCancel.addEventListener('click', closeCoverPreview);
    }
    if (el.rrCoverPreview) {
      // 点遮罩 = 取消 (别让人以为卡住了)
      el.rrCoverPreview.addEventListener('click', function (e) {
        if (e.target === el.rrCoverPreview) closeCoverPreview();
      });
    }

    if (el.rrSendBtn) el.rrSendBtn.addEventListener('click', sendChat);
    if (el.rrChatInput) {
      el.rrChatInput.addEventListener('input', function () {
        if (el.rrSendBtn) el.rrSendBtn.disabled = !el.rrChatInput.value.trim() && !S.chatBusy;
        // 输入框随内容长高 (最多 4 行)
        el.rrChatInput.style.height = 'auto';
        el.rrChatInput.style.height = Math.min(el.rrChatInput.scrollHeight, 110) + 'px';
      });
      el.rrChatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChat();
        }
      });
    }
    if (el.rrChatToggle) el.rrChatToggle.addEventListener('click', function () { toggleChat(); });

    // 选段
    if (el.rrPickFab) {
      // ⚠️ 真机要点: 手指按下的瞬间就把选区快照抓住, 并把浮标"锁住"。
      //   手指按住 → 系统清选区 → selectionchange → 浮标被藏 → click 不触发,
      //   这一串不堵住的话, 手机上"问 AI"按钮点了没反应。
      var grabOnPress = function () {
        if (!S.pickedText) S.pickedText = currentSelectionText();
        S.fabHolding = true;
        // 兜底: 万一这次没走到 click (手指滑走了), 别把锁永久留着
        setTimeout(function () { S.fabHolding = false; }, 800);
      };
      el.rrPickFab.addEventListener('mousedown', grabOnPress);
      el.rrPickFab.addEventListener('touchstart', grabOnPress, { passive: true });
      el.rrPickFab.addEventListener('click', function (e) {
        // ⚠️ 必须 stopPropagation —— 浮标是 #rr-page-area 的子节点,
        //   不拦的话事件冒泡到"点两侧翻页", 选一句话会顺手翻一页。
        e.stopPropagation();
        S.fabHolding = false;
        pickSelection();
      });
    }
    if (el.rrPageText) {
      var checkSel = function () {
        setTimeout(function () {
          if (currentSelectionText()) showFab();
          else hideFab();
        }, 10);
      };
      el.rrPageText.addEventListener('mouseup', checkSel);
      el.rrPageText.addEventListener('touchend', checkSel);
    }
    document.addEventListener('selectionchange', function () {
      if (S.view !== 'reader') return;
      // ⚠️ 手指正按在浮标上的时候不许藏它 ——
      //   真机上"点浮标"这一步, 系统会先清掉选区 → 选区没了 → 这里把浮标
      //   display:none → 手指抬起来时 click 根本不会触发 → 按钮看起来就是坏的。
      if (S.fabHolding) return;
      if (currentSelectionText()) showFab();
      else hideFab();
    });

    // 点正文左右两侧翻页 (点在正文上不翻 —— 选中文字时才不冲突)
    if (el.rrPageArea) {
      el.rrPageArea.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.rr-page-text')) return;
        // ⚠️ "问 AI"浮标就在 #rr-page-area 里面 —— 点它绝不能翻页。
        //   这里再挡一道 (浮标自己的 click 里也 stopPropagation 了, 双保险)。
        if (e.target && e.target.closest && e.target.closest('.rr-pick-fab')) return;
        if (currentSelectionText()) return;
        var x = e.clientX || 0;
        var w = window.innerWidth;
        if (x > w * 0.72) turnPage(1);
        else if (x < w * 0.28) turnPage(-1);
      });
    }

    bindSplitter();
  }

  function boot() {
    grab();
    bindUi();
    showView('hall');
    if (!IN_IFRAME) {
      // 单独在浏览器里打开这一页 → 本地兜底 (方便开发时调试)
      if (el.rrBoot) el.rrBoot.classList.add('hide');
      if (el.rrRoot) el.rrRoot.hidden = false;
      appendMsg('sys', '这是单独打开的读书屋页面, 连不上 330 宿主, 只能看界面。');
      return;
    }
    post({ type: 'reading:needChat' });
    post({ type: 'reading:ready' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 页面被换掉 / 重载时告诉宿主把 iframe 收掉
  // ⚠️ 不然宿主那边只剩一个盖住整屏的 iframe, 外面点不动 (影院踩过这个坑)
  window.addEventListener('pagehide', function () {
    try { post({ type: 'reading:closed' }); } catch (e) { /* noop */ }
  });

  // 暴露给调试
  window.__readingSandbox = {
    state: S,
    renderHall: renderHall,
    renderPage: renderPage,
    turnPage: turnPage,
    sendChat: sendChat
  };
})();

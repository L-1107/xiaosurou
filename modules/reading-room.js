// ============================================================
// reading-room.js
// 来源：script.js 第 52560~53310 行（DOMContentLoaded 内部）
// 功能：阅读室 —— openReadingRoom、initReadingSession、closeReadingRoom、
//       renderReadingRoom、showNextPage、showPrevPage、importBook、
//       decodeTextFile、handleBookFileUpload、handlePageJump、
//       saveReadingProgress、openBookLibrary、renderBookLibrary、
//       loadBookFromLibrary、addGreenRiverToShelf、removeGreenRiverFromShelf、
//       deleteBookFromLibrary、processImportedText、makeDraggable、
//       minimizeReadingRoom、restoreReadingRoom、debounce、
//       formatReadingStateForAI、updateReadingContextOnScroll
// ============================================================

(function () {
  // state 和 db 通过全局作用域访问（window.state/window.db，由 init-and-state.js 初始化）

  // ========== 闭包变量 ==========

  let readingState = {};

  // ========== 来源：script.js 第 52560~53310 行 ==========

  function openReadingRoom() {
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const overlay = document.getElementById('reading-overlay');
    const windowEl = document.getElementById('reading-window');
    const restoreBtn = document.getElementById('reading-restore-btn');

    let session = readingState[chatId];


    if (session && session.isActive) {
      if (session.isMinimized) {
        restoreReadingRoom();
      }

      overlay.style.display = 'flex';
      return;
    }


    initReadingSession(chatId);
    renderReadingRoom(chatId);


    overlay.style.display = 'flex';
    windowEl.classList.remove('minimized');
    restoreBtn.style.display = 'none';




    const phoneScreen = document.getElementById('phone-screen');
    const windowRect = windowEl.getBoundingClientRect();


    const top = (phoneScreen.clientHeight - windowRect.height) / 2;
    const left = (phoneScreen.clientWidth - windowRect.width) / 2;


    windowEl.style.top = `${top}px`;
    windowEl.style.left = `${left}px`;
    windowEl.style.transform = '';

  }


  function initReadingSession(chatId) {
    readingState[chatId] = {
      isActive: true,
      isMinimized: false,
      title: '未选择书籍',
      contentLines: [],
      currentPage: 0,
      totalPages: 0,
      linesPerPage: 15,
      currentSnippet: ''
    };
    // 告诉宠物屋：今天在读书 → 它背上一片翻开的书页
    try {
      if (window.PetNest && typeof window.PetNest.reportSignal === 'function') {
        window.PetNest.reportSignal('reading', 1, { title: '' });
      }
    } catch (e) { /* 忽略 */ }
  }


  function closeReadingRoom() {
    const chatId = state.activeChatId;
    if (!chatId || !readingState[chatId] || !readingState[chatId].isActive) return;


    document.getElementById('reading-overlay').style.display = 'none';
    document.getElementById('reading-restore-btn').style.display = 'none';
    document.getElementById('reading-window').classList.remove('minimized');


    readingState[chatId].isActive = false;
    console.log("读书会话已关闭。");
  }





  function renderReadingRoom(chatId) {
    const session = readingState[chatId];
    if (!session) return;

    // --- 【新增/修改部分开始】 ---
    // 1. 获取当前聊天的字体设置
    const chat = state.chats[chatId];
    // 默认 13px，如果有设置则使用设置值
    const fontSize = (chat && chat.settings && chat.settings.fontSize) ? chat.settings.fontSize : 13;

    const contentEl = document.getElementById('reading-content');

    // 2. 将字体大小应用到读书容器
    contentEl.style.fontSize = `${fontSize}px`;
    // 3. 动态调整行高 (Line Height)，防止字体变大后文字挤在一起
    // 1.6 是一个比较舒适的阅读倍率
    contentEl.style.lineHeight = '1.6';
    // --- 【新增/修改部分结束】 ---

    const titleEl = document.getElementById('reading-title');
    // const contentEl = document.getElementById('reading-content'); // 这行上面已经获取了，可以注释掉或删除
    const pageIndicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('prev-page-btn');
    const nextBtn = document.getElementById('next-page-btn');

    titleEl.textContent = session.title;

    if (session.contentLines.length === 0) {
      contentEl.innerHTML = '<p style="text-align:center; padding-top:50px; color:#888;">点击"导入"按钮，<br>从本地.txt文件加载书籍内容。</p>';
      session.totalPages = 0;
      session.currentPage = 0;
    } else {
      const startLine = session.currentPage * session.linesPerPage;
      const endLine = startLine + session.linesPerPage;
      contentEl.textContent = session.contentLines.slice(startLine, endLine).join('\n');
    }

    pageIndicator.textContent = `${session.currentPage + 1} / ${session.totalPages}`;
    prevBtn.disabled = session.currentPage === 0;
    nextBtn.disabled = session.currentPage >= session.totalPages - 1;
  }

  // showNextPage 旧版（同步版，无 notifyAiOfPageTurn）已删除
  // 保留下方的 async 版本

  async function showPrevPage() {
    const session = readingState[state.activeChatId];
    if (session && session.currentPage > 0) {
      session.currentPage--;
      renderReadingRoom(state.activeChatId);
      document.getElementById('reading-content').scrollTop = 0;
      await saveReadingProgress(session.activeBookId, session.currentPage);


      await notifyAiOfPageTurn(state.activeChatId, session);
    }
  }


  function importBook() {

    const modal = document.getElementById('import-book-modal');
    if (modal) {
      // 打开导入 modal（默认 local tab）
      switchImportTab('local');
      const errorEl = document.getElementById('import-book-error');
      if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
      const urlInput = document.getElementById('import-book-url-input');
      if (urlInput) urlInput.value = '';
      modal.classList.add('visible');
    } else {
      // 兜底：modal 不存在就用老的直接弹文件选择器
      document.getElementById('book-upload-input').click();
    }
  }


  // ===== URL 抓取小说三件套（配合 import-book-modal） =====

  // tab 切换：local / url
  function switchImportTab(tab) {
    document.querySelectorAll('.import-book-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.import-book-panel').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.panel === tab);
    });
    // 切 tab 时清掉错误提示
    const errorEl = document.getElementById('import-book-error');
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  }

  // modal 内的"选择本地文件"按钮
  function pickLocalFile() {
    document.getElementById('book-upload-input').click();
  }

  // URL 抓取：调 Netlify Function 中转拿 HTML → 解析 → 存书库
  async function importBookFromUrl() {
    const urlInput = document.getElementById('import-book-url-input');
    const errorEl = document.getElementById('import-book-error');
    const submitBtn = document.getElementById('import-book-url-submit');
    const url = (urlInput?.value || '').trim();

    // 清错误
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

    // 验证
    if (!url) {
      if (errorEl) { errorEl.textContent = '请输入网址'; errorEl.style.display = 'block'; }
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      if (errorEl) { errorEl.textContent = '网址必须以 http:// 或 https:// 开头'; errorEl.style.display = 'block'; }
      return;
    }

    // 按钮 loading
    const originalText = submitBtn?.textContent;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '抓取中…'; }

    try {
      // 走 Netlify Function 中转（纯前端会被 CORS 拦）
      const apiUrl = `/.netlify/functions/link-preview?url=${encodeURIComponent(url)}`;
      const response = await fetch(apiUrl);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `抓取失败 (HTTP ${response.status})`);
      }

      const data = await response.json();
      if (data.error) throw new Error(data.message || data.error);
      if (!data.html || data.html.length < 100) {
        throw new Error('抓取到的内容太少（< 100 字节），可能是不支持的页面');
      }

      // 解析 HTML 提取正文
      const parser = new DOMParser();
      const doc = parser.parseFromString(data.html, 'text/html');

      // 去噪音
      doc.querySelectorAll('script, style, noscript, nav, footer, header, aside, iframe, link, meta').forEach(el => el.remove());

      // 提取书名（优先 og:title / <title>）
      let bookTitle = '';
      const ogTitle = doc.querySelector('meta[property="og:title"]');
      if (ogTitle) bookTitle = (ogTitle.getAttribute('content') || '').trim();
      if (!bookTitle) {
        const tEl = doc.querySelector('title');
        bookTitle = (tEl?.textContent || '').trim();
      }
      if (!bookTitle) bookTitle = url;
      // 清洗：截掉常见分隔符后的网站名
      bookTitle = bookTitle.split(/[_\-|(]/)[0].trim().substring(0, 100) || url;

      // 提取正文（按优先级匹配：笔趣阁系 → 博客 → article → 兜底 body）
      const contentSelectors = [
        '#content',           // 笔趣阁系标准
        '#chapter-content',   // 笔趣阁变体
        '.chapter-content',
        '.post-content',      // 博客
        '.article-content',
        'article',
        '#article',
        '.entry-content',
        '.content',
        '#main',
        'main'
      ];
      let contentEl = null;
      for (const sel of contentSelectors) {
        const el = doc.querySelector(sel);
        if (el && (el.textContent || '').trim().length > 200) { contentEl = el; break; }
      }
      if (!contentEl) contentEl = doc.body;

      // 转纯文本 + 规范化空白
      let text = (contentEl.textContent || '')
        .replace(/[ \t]+/g, ' ')          // 多空格合一
        .replace(/[ \t]*\n[ \t]*/g, '\n') // 行首尾空格
        .replace(/\n{3,}/g, '\n\n')       // 多空行合一
        .trim();

      if (text.length < 200) {
        throw new Error('正文太短（< 200 字），可能是反爬页、JS 动态页或需登录页');
      }

      // 存书库
      const newBookId = await db.readingLibrary.add({
        title: bookTitle,
        content: text,
        lastOpened: Date.now()
      });

      // 关 modal + 加载新书
      const modal = document.getElementById('import-book-modal');
      if (modal) modal.classList.remove('visible');
      if (urlInput) urlInput.value = '';

      await loadBookFromLibrary(newBookId);

      // 如果书库 modal 开着，刷新列表
      if (document.getElementById('reading-library-modal')?.classList.contains('visible')) {
        renderBookLibrary();
      }

    } catch (error) {
      console.error('[importBookFromUrl] 抓取失败:', error);
      if (errorEl) { errorEl.textContent = error.message || '抓取失败'; errorEl.style.display = 'block'; }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText || '开始抓取'; }
    }
  }

  async function decodeTextFile(arrayBuffer) {
    const uint8array = new Uint8Array(arrayBuffer);


    if (uint8array.length >= 3 && uint8array[0] === 0xEF && uint8array[1] === 0xBB && uint8array[2] === 0xBF) {
      console.log("检测到 UTF-8 BOM，使用 UTF-8 解码。");
      return new TextDecoder('utf-8').decode(uint8array);
    }
    if (uint8array.length >= 2 && uint8array[0] === 0xFF && uint8array[1] === 0xFE) {
      console.log("检测到 UTF-16 LE BOM，使用 UTF-16 LE 解码。");
      return new TextDecoder('utf-16le').decode(uint8array);
    }
    if (uint8array.length >= 2 && uint8array[0] === 0xFE && uint8array[1] === 0xFF) {
      console.log("检测到 UTF-16 BE BOM，使用 UTF-16 BE 解码。");
      return new TextDecoder('utf-16be').decode(uint8array);
    }


    // 1) 先用 UTF-8 非严格模式试解（fatal:false，遇到非法字节会输出 U+FFFD 替换字符，不抛错）
    console.log("未检测到BOM，先尝试 UTF-8 解码（探测模式）...");
    const utf8Guess = new TextDecoder('utf-8', { fatal: false }).decode(uint8array);
    if (!utf8Guess.includes('\uFFFD')) {
      console.log("UTF-8 解码干净（无替换字符），确认 UTF-8。");
      return utf8Guess;
    }

    // 2) 出现 U+FFFD 说明不是纯 UTF-8，兜底试 GBK
    console.log("UTF-8 解码出现替换字符，将尝试 GBK 解码...");
    try {
      const decoded = new TextDecoder('gbk').decode(uint8array);
      console.log("GBK 解码成功。");
      return decoded;
    } catch (err) {
      console.error("GBK 解码失败:", err);
      throw new Error("无法识别的文件编码。请尝试将文件转换为 UTF-8 或 GBK 格式后重新导入。");
    }
  }

  async function handleBookFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {

      const arrayBuffer = await file.arrayBuffer();

      const textContent = await decodeTextFile(arrayBuffer);

      const title = file.name.replace(/\.txt$/i, '');

      const newBookId = await db.readingLibrary.add({
        title: title,
        content: textContent,
        lastOpened: Date.now()
      });

      await loadBookFromLibrary(newBookId);
      if (document.getElementById('reading-library-modal').classList.contains('visible')) {
        renderBookLibrary();
      }
    } catch (error) {

      console.error("导入书籍失败:", error);
      await showCustomAlert("导入失败", error.message);
    } finally {
      event.target.value = null;
    }
  }
  async function handlePageJump() {
    const chatId = state.activeChatId;
    if (!chatId) return;
    const session = readingState[chatId];
    if (!session || session.totalPages <= 1) return;

    const targetPageStr = await showCustomPrompt(
      '页面跳转',
      `请输入想跳转的页码 (1 - ${session.totalPages})`,
      session.currentPage + 1
    );

    if (targetPageStr === null) return;

    const targetPage = parseInt(targetPageStr);

    if (isNaN(targetPage) || targetPage < 1 || targetPage > session.totalPages) {
      alert("请输入一个有效的页码！");
      return;
    }

    session.currentPage = targetPage - 1;
    renderReadingRoom(chatId);

    saveReadingProgress(session.activeBookId, session.currentPage);
  }


  async function saveReadingProgress(bookId, pageNumber) {
    if (!bookId) return;
    try {

      await db.readingLibrary.update(bookId, {
        currentPage: pageNumber
      });
    } catch (error) {
      console.error(`保存书籍(ID: ${bookId})的阅读进度失败:`, error);
    }
  }

  async function showNextPage() {
    const session = readingState[state.activeChatId];
    if (session && session.currentPage < session.totalPages - 1) {
      session.currentPage++;
      renderReadingRoom(state.activeChatId);
      document.getElementById('reading-content').scrollTop = 0;
      await saveReadingProgress(session.activeBookId, session.currentPage);


      await notifyAiOfPageTurn(state.activeChatId, session);
    }
  }





  async function openBookLibrary() {

    document.getElementById('reading-library-search-input').value = '';

    await renderBookLibrary();
    document.getElementById('reading-library-modal').classList.add('visible');
  }


  async function renderBookLibrary(searchTerm = '') {
    const listEl = document.getElementById('reading-library-list');
    let books = await db.readingLibrary.orderBy('lastOpened').reverse().toArray();
    listEl.innerHTML = '';


    if (searchTerm) {
      books = books.filter(book =>
        book.title.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }


    if (books.length === 0) {
      const message = searchTerm ?
        '找不到匹配的书籍' :
        '书库是空的，点击"导入新书"添加第一本吧！';
      listEl.innerHTML = `<p style="text-align:center; color: var(--text-secondary); padding: 50px 0;">${message}</p>`;
      return;
    }

    books.forEach(book => {
      const item = document.createElement('div');
      item.className = 'existing-group-item';
      item.innerHTML = `
            <span class="group-name" style="cursor:pointer;" data-book-id="${book.id}">${book.title}</span>
            <button class="delete-group-btn" data-book-id="${book.id}" title="删除书籍">×</button>
        `;
      listEl.appendChild(item);
    });
  }


  // 找到 loadBookFromLibrary 函数，替换整个函数
  async function loadBookFromLibrary(bookId) {
    const chatId = state.activeChatId;
    if (!chatId) return;

    let book = await db.readingLibrary.get(bookId);
    if (!book) {
      alert('找不到这本书！');
      return;
    }

    // --- 【核心新增逻辑：同步绿江内容】 ---
    if (book.linkedStoryId) {
      try {
        const grStory = await db.grStories.get(book.linkedStoryId);
        if (grStory) {
          console.log(`[同步] 正在从绿江同步《${grStory.title}》的最新章节...`);

          // 拼接所有章节内容
          // 格式：
          // 第1章 标题
          // 正文...
          let fullContent = "";
          grStory.chapters.forEach((ch, idx) => {
            const title = ch.title || `第 ${idx + 1} 章`;
            fullContent += `\n\n========== ${title} ==========\n\n`;
            fullContent += ch.content;
          });

          // 更新内存里的临时对象
          book.title = grStory.title; // 同步标题
          book.content = fullContent; // 同步内容

          // 同时更新数据库，保持缓存最新
          await db.readingLibrary.update(bookId, {
            title: grStory.title,
            content: fullContent,
            lastOpened: Date.now()
          });
        } else {
          console.warn("关联的绿江作品已被删除，保留最后一次缓存的内容。");
        }
      } catch (e) {
        console.error("同步绿江内容失败:", e);
      }
    } else {
      // 普通书籍只更新时间
      await db.readingLibrary.update(bookId, {
        lastOpened: Date.now()
      });
    }
    // -------------------------------------

    const session = readingState[chatId];
    session.activeBookId = bookId;
    session.title = book.title;
    // 处理内容换行
    session.contentLines = (book.content || "").split(/\r\n?|\n/).map(line => line.replace(/ +/g, ' '));
    session.totalPages = Math.ceil(session.contentLines.length / session.linesPerPage);

    // 如果总页数为0，至少设为1
    if (session.totalPages === 0) session.totalPages = 1;

    session.currentPage = book.currentPage || 0;

    // 防止页码越界（比如同步后内容变短了，虽然一般是变长）
    if (session.currentPage >= session.totalPages) {
      session.currentPage = session.totalPages - 1;
    }
    if (session.currentPage < 0) session.currentPage = 0;

    renderReadingRoom(chatId);

    document.getElementById('reading-content').scrollTop = 0;
    document.getElementById('reading-library-modal').classList.remove('visible');
  }

  async function addGreenRiverToShelf(storyId, btnElement) {
    try {
      const story = await db.grStories.get(storyId);
      if (!story) return;

      // 防止重复添加
      const existing = await db.readingLibrary.where('linkedStoryId').equals(storyId).first();
      if (existing) {
        alert("该书籍已在书架中。");
        return;
      }

      let fullContent = "";
      story.chapters.forEach((ch, idx) => {
        const title = ch.title || `第 ${idx + 1} 章`;
        fullContent += `\n\n========== ${title} ==========\n\n`;
        fullContent += ch.content;
      });

      if (!fullContent) fullContent = "(暂无内容，请作者赶快更新...)";

      await db.readingLibrary.add({
        title: story.title,
        content: fullContent,
        lastOpened: Date.now(),
        currentPage: 0,
        linkedStoryId: story.id
      });

      // 【核心修改】更新按钮UI为"已添加"状态，并绑定移除事件
      if (btnElement) {
        btnElement.textContent = "✓ 已在书架";
        btnElement.classList.add('added');
        // 重新绑定 onclick 为移除函数
        btnElement.onclick = (e) => {
          e.stopPropagation();
          removeGreenRiverFromShelf(storyId, btnElement);
        };
      }

      await showCustomAlert("收藏成功", `《${story.title}》已加入书架，并开启同步更新。`);

    } catch (e) {
      console.error("加入书架失败:", e);
      alert("加入失败: " + e.message);
    }
  }

  // 记得把这个函数暴露给全局，否则 HTML onclick 找不到
  window.addGreenRiverToShelf = addGreenRiverToShelf;
  // 【新增】从"一起读"书架中移除绿江作品
  async function removeGreenRiverFromShelf(storyId, btnElement) {
    try {
      // 查找对应的书架记录
      const bookRecord = await db.readingLibrary.where('linkedStoryId').equals(storyId).first();

      if (!bookRecord) {
        // 数据库里可能已经被删了，直接更新UI
        if (btnElement) resetBtnToAddState(storyId, btnElement);
        return;
      }

      const confirmed = await showCustomConfirm(
        "移出书架",
        `确定要将《${bookRecord.title}》从"一起读"书架中移除吗？\n(绿江APP中的原稿不会被删除)`,
        { confirmButtonClass: 'btn-danger', confirmText: '移出' }
      );

      if (confirmed) {
        // 删除书架记录
        await db.readingLibrary.delete(bookRecord.id);

        // 更新 UI 为"未添加"状态
        if (btnElement) {
          resetBtnToAddState(storyId, btnElement);
        }

        await showCustomAlert("已移除", "书籍已从书架移出。");
      }
    } catch (e) {
      console.error("移除失败:", e);
    }
  }

  // 辅助函数：重置按钮为"加入"状态
  function resetBtnToAddState(storyId, btn) {
    btn.textContent = "+ 加入共读";
    btn.classList.remove('added');
    btn.onclick = (e) => {
      e.stopPropagation();
      addGreenRiverToShelf(storyId, btn);
    };
  }

  // 暴露给全局
  window.removeGreenRiverFromShelf = removeGreenRiverFromShelf;
  async function deleteBookFromLibrary(bookId) {
    const book = await db.readingLibrary.get(bookId);
    if (!book) return;

    const confirmed = await showCustomConfirm('删除书籍', `确定要删除《${book.title}》吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.readingLibrary.delete(bookId);
      await renderBookLibrary();
    }
  }

  function processImportedText(title, textContent) {
    const chatId = state.activeChatId;
    if (!chatId) return;

    const session = readingState[chatId];
    session.title = title.replace(/\.txt$/i, '');
    session.contentLines = textContent.split(/\r\n?|\n/);
    session.totalPages = Math.ceil(session.contentLines.length / session.linesPerPage);
    session.currentPage = 0;

    renderReadingRoom(chatId);
  }



  function makeDraggable(windowEl, headerEl) {
    let pos1 = 0,
      pos2 = 0,
      pos3 = 0,
      pos4 = 0;
    let isDragging = false;
    let hasMoved = false;
    const phoneScreen = document.getElementById('phone-screen');

    const startDrag = (e) => {

      if (windowEl !== headerEl && e.target.closest('button')) {
        return;
      }

      isDragging = true;
      hasMoved = false;

      const event = e.type === 'touchstart' ? e.touches[0] : e;
      pos3 = event.clientX;
      pos4 = event.clientY;


      windowEl.style.top = `${windowEl.offsetTop}px`;
      windowEl.style.left = `${windowEl.offsetLeft}px`;
      windowEl.style.transform = '';

      document.addEventListener('mouseup', endDrag);
      document.addEventListener('mousemove', elementDrag);
      document.addEventListener('touchend', endDrag);

      document.addEventListener('touchmove', elementDrag, {
        passive: false
      });
    };

    const elementDrag = (e) => {
      if (!isDragging) return;

      const event = e.type === 'touchmove' ? e.touches[0] : e;
      const diffX = event.clientX - pos3;
      const diffY = event.clientY - pos4;


      if (!hasMoved && (Math.abs(diffX) > 5 || Math.abs(diffY) > 5)) {
        hasMoved = true;
      }


      if (hasMoved && e.cancelable) {
        e.preventDefault();
      }

      pos1 = pos3 - event.clientX;
      pos2 = pos4 - event.clientY;
      pos3 = event.clientX;
      pos4 = event.clientY;

      let newTop = windowEl.offsetTop - pos2;
      let newLeft = windowEl.offsetLeft - pos1;

      const maxTop = phoneScreen.clientHeight - windowEl.offsetHeight - 10;
      const maxLeft = phoneScreen.clientWidth - windowEl.offsetWidth - 10;
      newTop = Math.max(10, Math.min(newTop, maxTop));
      newLeft = Math.max(10, Math.min(newLeft, maxLeft));

      windowEl.style.top = newTop + "px";
      windowEl.style.left = newLeft + "px";
    };

    const endDrag = () => {
      document.removeEventListener('mouseup', endDrag);
      document.removeEventListener('mousemove', elementDrag);
      document.removeEventListener('touchend', endDrag);
      document.removeEventListener('touchmove', elementDrag);

      if (!isDragging) return;
      isDragging = false;

      if (!hasMoved) {

        windowEl.click();
      }
    };

    headerEl.addEventListener('mousedown', startDrag);

    headerEl.addEventListener('touchstart', startDrag, {
      passive: false
    });
  }



  function minimizeReadingRoom() {
    const session = readingState[state.activeChatId];
    if (!session || !session.isActive) return;

    document.getElementById('reading-window').classList.add('minimized');
    document.getElementById('reading-restore-btn').style.display = 'flex';
    session.isMinimized = true;
  }


  function restoreReadingRoom() {
    const session = readingState[state.activeChatId];
    if (!session || !session.isActive) return;

    document.getElementById('reading-restore-btn').style.display = 'none';
    document.getElementById('reading-window').classList.remove('minimized');
    session.isMinimized = false;
  }





  function debounce(func, delay) {
    let timeout;
    return function (...args) {
      const context = this;
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(context, args), delay);
    };
  }



  function formatReadingStateForAI(chatId) {
    const session = readingState[chatId];


    if (!session || !session.isActive) {
      return "";
    }

    const title = session.title || '未知书籍';
    let contentForAI = '';
    let contextLabel = '';


    if (session.currentSnippet && session.currentSnippet.trim()) {
      contentForAI = session.currentSnippet;
      contextLabel = '你正在阅读的段落';
    } else if (session.contentLines.length > 0) {
      const startLine = session.currentPage * session.linesPerPage;
      const endLine = startLine + session.linesPerPage;
      contentForAI = session.contentLines.slice(startLine, endLine).join('\n').substring(0, 200);
      contextLabel = '当前页内容摘要';
    } else {
      contentForAI = '(无内容)';
      contextLabel = '内容';
    }
    return `
    - **书名**: 《${title}》
    - **${contextLabel}**: "${contentForAI}..."
    #一起读书模式 | 行为铁律
    1.  **角色定位**: 你【不是】书中的任何角色，你是【你自己】(${state.chats[chatId]?.originalName || 'AI角色'})，正在和用户一起【阅读和讨论】这本书。
    2.  **行为准则**: 你的回复【必须】是作为读者的【感想、评论、提问或联想】。你可以：
        -   分享你对当前段落的看法。
        -   对书中的角色或情节发表评论。
        -   向用户提问，询问TA对内容的看法。
        -   根据书本内容，联想到你自己的经历或记忆。
    3.  **严禁**: 你的回复【绝对禁止】使用书中角色的口吻和人称！【绝对禁止】扮演书中的任何角色！【绝对禁止】续写或模仿书中的情节！你必须时刻记住，你只是一个读者。    
`;
  }



  function updateReadingContextOnScroll() {
    const chatId = state.activeChatId;
    if (!chatId || !readingState[chatId]) return;

    const session = readingState[chatId];
    const container = document.getElementById('reading-content');

    if (!container) return;


    const chat = state.chats[chatId];

    const fontSize = (chat && chat.settings && chat.settings.fontSize) ? chat.settings.fontSize : 13;

    const approximateLineHeight = fontSize * 1.6;

    const scrollTop = container.scrollTop;
    const clientHeight = container.clientHeight;
    const scrollBottom = scrollTop + clientHeight;


    const firstVisibleLine = Math.floor(scrollTop / approximateLineHeight);
    const lastVisibleLine = Math.ceil(scrollBottom / approximateLineHeight);


    const absoluteStartIndex = (session.currentPage * session.linesPerPage) + firstVisibleLine;
    const absoluteEndIndex = (session.currentPage * session.linesPerPage) + lastVisibleLine;

    if (absoluteStartIndex < 0 || absoluteStartIndex >= session.contentLines.length) {
      return;
    }


    const newSnippet = session.contentLines.slice(
      Math.max(0, absoluteStartIndex),
      Math.min(session.contentLines.length, absoluteEndIndex)
    ).join('\n');

    session.currentSnippet = newSnippet;

    // 调试日志（可选，如果你想在控制台看效果）
    // console.log(`[阅读视口更新] 字体:${fontSize}px, 行高:${approximateLineHeight}, 可见行:${firstVisibleLine}-${lastVisibleLine}`);
  }

  // ========== 全局暴露 ==========

  window.readingState = readingState;
  window.openReadingRoom = openReadingRoom;
  window.initReadingSession = initReadingSession;
  window.closeReadingRoom = closeReadingRoom;
  window.renderReadingRoom = renderReadingRoom;
  window.showNextPage = showNextPage;
  window.showPrevPage = showPrevPage;
  window.importBook = importBook;
  window.switchImportTab = switchImportTab;
  window.pickLocalFile = pickLocalFile;
  window.importBookFromUrl = importBookFromUrl;

  // 绑 import-book-modal 关闭按钮（一次性，确保 close 按钮工作）
  (function bindImportBookModalClose() {
    const closeBtn = document.getElementById('close-import-book-btn');
    const modal = document.getElementById('import-book-modal');
    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => modal.classList.remove('visible'));
    }
    // 点 modal 背景关闭（不点 modal-content 才关）
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('visible');
      });
    }
  })();
  window.decodeTextFile = decodeTextFile;
  window.handleBookFileUpload = handleBookFileUpload;
  window.handlePageJump = handlePageJump;
  window.saveReadingProgress = saveReadingProgress;
  window.openBookLibrary = openBookLibrary;
  window.renderBookLibrary = renderBookLibrary;
  window.loadBookFromLibrary = loadBookFromLibrary;
  window.addGreenRiverToShelf = addGreenRiverToShelf;
  window.removeGreenRiverFromShelf = removeGreenRiverFromShelf;
  window.resetBtnToAddState = resetBtnToAddState;
  window.deleteBookFromLibrary = deleteBookFromLibrary;
  window.processImportedText = processImportedText;
  window.makeDraggable = makeDraggable;
  window.minimizeReadingRoom = minimizeReadingRoom;
  window.restoreReadingRoom = restoreReadingRoom;
  window.debounce = debounce;
  window.formatReadingStateForAI = formatReadingStateForAI;
  window.updateReadingContextOnScroll = updateReadingContextOnScroll;

  // ========== 从 script.js 迁移：toggleReadingFullscreen ==========
  function toggleReadingFullscreen() {
    const readingWindow = document.getElementById('reading-window');
    const readingOverlay = document.getElementById('reading-overlay');

    if (readingWindow && readingOverlay) {
      readingWindow.classList.toggle('fullscreen');
      readingOverlay.classList.toggle('fullscreen-active');
    }
  }
  window.toggleReadingFullscreen = toggleReadingFullscreen;

})();

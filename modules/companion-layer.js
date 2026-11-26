/* ============================================================
   companion-layer.js - 沙盒里的陪伴件层 (桌宠 + 悬浮球)
   ============================================================

   【为什么要有这个文件】
   影院 / 读书屋都是独立 iframe 页面, 而宿主在它们底下是【彻底静默】的
   (2026-11-05 影院 / 2026-11-19 读书屋 为了不发烫做的):
     · #phone-screen 整个 display:none —— 里面装着 54 个 .screen 面板
       和所有 .header (毛玻璃 backdrop-filter, iOS 每次重绘都重采样背后)
     · #pn-desktop-pet / #floating-ball 也 display:none
     · JS 那半: pauseHostBackgroundTasks() + pauseDesktopPet()
   → 宿主一个像素都不渲染, 也就意味着宿主里的东西【进不来】。

   想让宠物 + 悬浮球跟着用户进影院/读书屋, 只能在沙盒这一侧【再画一份】。

   【但这只是"演出层", 宠物的大脑始终在宿主】
   · 沙盒里的桌宠只负责: 显示 / 换帧 / 呼吸 / 拖动 / 点菜单 / 冒气泡
   · 宠物【说什么话】永远由宿主生成 (PetSpeech.petSpeak):
       - 上文 = 宿主那条会话的真实聊天记录 (messageStore.getRecentMessages)
       - 关系分 / 父母称呼 / 模型调用, 全在宿主
   · 沙盒点「摸摸」→ postMessage 给宿主 → 宿主 care() → petSpeak()
     → 宿主广播 pet:spoke → 宿主桥转发进沙盒 → 沙盒冒气泡 + 聊天框一条
   ⇒ 【宠物收到的上文跟在外面一模一样】。
     而且影院里说的话本来就会写回主聊天历史 (cinema:chatMessage),
     所以在影院里摸它, 它还能听见刚刚这段对话。

   【为什么不用宿主那份 id】
   宿主静默规则 (cinema-room.css / main-ui.css) 里有
     body.cinema-room-active #floating-ball { display: none !important; }
   沙盒页也加载 cinema-room.css, 也带 body.cinema-room-active —— 用同名 id
   会被这条规则直接藏掉 (那条注释本来是按"沙盒里没有这个元素"写的)。
   → 沙盒这边一律用 cx- 前缀的独立 id, 两边互不干扰。

   【发烫吗】不发热。
   · 桌宠空闲成本 = 1 条 CSS 呼吸动画 (只有 transform + opacity, 走 GPU 合成,
     不触发 layout/paint) + 1 个 5200ms 的换帧定时器 (换 background-position)。
   · 悬浮球空闲成本 = 0: 没有 setInterval / requestAnimationFrame,
     ripple / fadeIn / slideUp 都是点一下才跑、跑完自己消失。
   · 关键: 这两个是【画在已经在渲染的 iframe 里面】, 不新增合成图层。
     宿主那边该藏还是藏 (宿主静默一行动不动)。
   ============================================================ */
(function (global) {
  'use strict';

  var CFG = {
    frameMs: 5200,     // 换帧间隔 (跟宿主桌宠一致)
    petSize: 98,       // 桌宠边长 (跟宿主一致)
    ballSize: 50,      // 悬浮球直径 (跟宿主一致)
    bubbleMs: 9000,    // 气泡自动消失
    toastMs: 2600
  };

  // 跟宿主共用同一份 localStorage —— 位置/开关在两边是同一份, 不用同步
  var KEYS = {
    petPos: 'petNestDesktopPetPos',
    petVisible: 'petNestDesktopPetVisible',
    ballState: 'floating-ball-state'
  };

  var S = {
    ns: 'cinema',          // 'cinema' | 'reading' —— 决定 postMessage 的前缀
    onPetAction: null,     // function (action)  宿主去执行
    onBallAction: null,    // function (action)  宿主去执行
    pet: null,             // { id, name, spriteUrl, stage }
    frame: 0,
    frameTimer: null,
    bubbleTimer: null,
    toastTimer: null,
    hit: null,             // { url, boxes } —— 精灵图每帧的可见包围盒
    measuring: false,
    dragging: false,
    moved: false,
    startX: 0, startY: 0, originX: 0, originY: 0,
    ballMenuOpen: false,
    ballSubmenuOpen: false,
    hostMsgBound: false,
    enabled: true
  };

  var D = {};

  // ============================================================
  // 1. 小工具
  // ============================================================

  function el(id) { return document.getElementById(id); }

  function clamp(v, a, b) {
    v = Number(v);
    if (!isFinite(v)) v = a;
    if (v < a) v = a;
    if (v > b) v = b;
    return v;
  }

  /** 给宿主发消息 (影院/读书屋各用各的前缀) */
  function postToHost(msg) {
    try {
      if (global.parent && global.parent !== global) global.parent.postMessage(msg, '*');
    } catch (e) { /* noop */ }
  }

  function notifyPetAction(action) {
    if (typeof S.onPetAction === 'function') {
      try { S.onPetAction(action); return; } catch (e) { /* 掉回 postMessage */ }
    }
    postToHost({ type: S.ns + ':petAction', action: action, petId: (S.pet && S.pet.id) || '' });
  }

  function notifyBallAction(action) {
    if (typeof S.onBallAction === 'function') {
      try { S.onBallAction(action); return; } catch (e) { /* 掉回 postMessage */ }
    }
    postToHost({ type: S.ns + ':ballAction', action: action });
  }

  // ============================================================
  // 2. 桌宠
  // ============================================================

  function buildPetDom() {
    if (el('cx-pet')) return;
    var wrap = document.createElement('div');
    wrap.id = 'cx-pet';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div id="cx-pet-bubble" hidden></div>' +
      '<div id="cx-pet-menu" class="cx-pet-menu" hidden>' +
        '<button class="cx-menu-act" data-act="feed" type="button">喂食</button>' +
        '<button class="cx-menu-act" data-act="comfort" type="button">摸摸</button>' +
        '<button class="cx-menu-act" data-act="play" type="button">陪玩</button>' +
        '<div class="cx-menu-sep"></div>' +
        '<button class="cx-menu-act" data-act="enter" type="button">进入小屋</button>' +
        '<button class="cx-menu-act" data-act="toggle" type="button">隐藏桌宠</button>' +
      '</div>' +
      '<span id="cx-pet-sprite"></span>' +
      '<span id="cx-pet-name"></span>';
    document.body.appendChild(wrap);

    D.pet = wrap;
    D.petBubble = el('cx-pet-bubble');
    D.petMenu = el('cx-pet-menu');
    D.petSprite = el('cx-pet-sprite');
    D.petName = el('cx-pet-name');
  }

  /** 六格图集: 3 列 × 2 行, background-size 300% 200% */
  function setSpriteFrame(node, frame) {
    if (!node) return;
    var col = frame % 3;
    var row = Math.floor(frame / 3) % 2;
    node.style.backgroundPosition = (col * 50) + '% ' + (row * 100) + '%';
  }

  /**
   * 量一次图集, 算出 6 帧各自的可见包围盒 (跟宿主 pet-nest.js 一个做法)
   *
   * 【为什么】精灵是六格图集, 宠物只占格子中间一部分, 下面那截是透明的。
   * 事件绑在容器上 → 看不见的空白照样能点 (用户 2026-10-29 实测:
   * 「宠物下方很长一个空间」)。这里用 canvas 量一次真实像素, 点的时候按坐标判。
   * 【量不到就放行】图片加载失败 → 退回原来的行为, 绝不会变成「点不到了」。
   */
  function measureHitBoxes(url) {
    if (!url) return;
    if (S.hit && S.hit.url === url) return;
    if (S.measuring) return;
    S.measuring = true;
    try {
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        try {
          var W = img.naturalWidth, H = img.naturalHeight;
          if (!W || !H) return;
          var cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          var ctx = cv.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(img, 0, 0);
          var data = ctx.getImageData(0, 0, W, H).data;
          var gw = Math.floor(W / 3), gh = Math.floor(H / 2);
          var boxes = [];
          for (var r = 0; r < 2; r++) {
            for (var c = 0; c < 3; c++) {
              var minX = gw, minY = gh, maxX = -1, maxY = -1;
              for (var y = 0; y < gh; y++) {
                for (var x = 0; x < gw; x++) {
                  var a = data[((r * gh + y) * W + (c * gw + x)) * 4 + 3];
                  if (a > 12) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                  }
                }
              }
              if (maxX < 0) { boxes.push({ top: 0, right: 1, bottom: 1, left: 0 }); continue; }
              boxes.push({
                top: minY / gh, bottom: (maxY + 1) / gh,
                left: minX / gw, right: (maxX + 1) / gw
              });
            }
          }
          S.hit = { url: url, boxes: boxes };
        } catch (e) {
          /* 量不到就保持旧行为 */
        } finally {
          S.measuring = false;
        }
      };
      img.onerror = function () { S.measuring = false; };
      img.src = url;
    } catch (e) {
      S.measuring = false;
    }
  }

  /** 这个点算不算点在宠物身上? (名字标签也算 —— 它就在宠物旁边) */
  function pointOnPet(clientX, clientY) {
    if (!D.petSprite) return true;
    if (D.petName) {
      try {
        var nr = D.petName.getBoundingClientRect();
        if (nr && nr.width && nr.height &&
          clientX >= nr.left && clientX <= nr.right &&
          clientY >= nr.top && clientY <= nr.bottom) return true;
      } catch (e) { /* noop */ }
    }
    var rect = null;
    try { rect = D.petSprite.getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect || !rect.width || !rect.height) return true;
    var boxes = S.hit ? S.hit.boxes : null;
    if (!boxes || !boxes.length) return true;           // 没量到 → 放行
    var nx = (clientX - rect.left) / rect.width;
    var ny = (clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false;
    var b = boxes[S.frame] || boxes[0];
    if (!b) return true;
    return nx >= b.left && nx <= b.right && ny >= b.top && ny <= b.bottom;
  }

  function startFrames() {
    if (S.frameTimer) return;
    S.frameTimer = global.setInterval(function () {
      if (global.document && global.document.hidden) return;
      S.frame = (S.frame + 1) % 6;
      setSpriteFrame(D.petSprite, S.frame);
    }, CFG.frameMs);
  }

  function stopFrames() {
    if (!S.frameTimer) return;
    global.clearInterval(S.frameTimer);
    S.frameTimer = null;
  }

  function loadPetPos() {
    try {
      var raw = global.localStorage.getItem(KEYS.petPos);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (v && typeof v.x === 'number' && typeof v.y === 'number') return v;
    } catch (e) { /* noop */ }
    return null;
  }

  function savePetPos(x, y) {
    try {
      global.localStorage.setItem(KEYS.petPos, JSON.stringify({ x: x, y: y }));
    } catch (e) { /* noop */ }
  }

  /** 位置用 left/top 写死 (right/bottom 清成 auto) —— 否则绝对定位会被撑成长条 */
  function useLeftTop(wrap, x, y) {
    try {
      wrap.style.left = x + 'px';
      wrap.style.top = y + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    } catch (e) { /* noop */ }
  }

  function showBubble(text) {
    if (!D.petBubble) return;
    // 菜单开着的时候别冒气泡 —— 菜单也在头顶, 两个叠一起会糊成一片
    // (宠物的话照样会进聊天框, 不会丢)
    if (D.petMenu && !D.petMenu.hidden) return;
    D.petBubble.hidden = false;
    D.petBubble.textContent = text || '…';
    D.petBubble.classList.add('on');
    if (S.bubbleTimer) global.clearTimeout(S.bubbleTimer);
    S.bubbleTimer = global.setTimeout(hideBubble, CFG.bubbleMs);
  }

  function hideBubble() {
    if (S.bubbleTimer) {
      global.clearTimeout(S.bubbleTimer);
      S.bubbleTimer = null;
    }
    if (!D.petBubble) return;
    D.petBubble.hidden = true;
    D.petBubble.textContent = '';
    D.petBubble.classList.remove('on');
  }

  /**
   * 把桌宠画出来
   * @param {Object} info { id, name, spriteUrl, stage }
   */
  function setPet(info) {
    if (!info || !info.spriteUrl) { hidePet(); return; }
    // 桌宠开关 (跟宿主共用一份 localStorage): 宿主那边藏了就别在沙盒里冒出来
    try {
      S.petVisible = global.localStorage.getItem(KEYS.petVisible) !== 'false';
    } catch (e) { /* noop */ }
    if (!S.petVisible) { hidePet(); return; }
    buildPetDom();
    S.pet = info;

    if (D.petSprite) {
      D.petSprite.style.backgroundImage = 'url("' + info.spriteUrl + '")';
      D.petSprite.classList.remove('pn-sprite-hatched', 'pn-sprite-divine');
      // 孵化中 / 神兽 有各自的光效 (跟宿主同款 class)
      if (info.hatched) D.petSprite.classList.add('pn-sprite-hatched');
      if (info.divine) D.petSprite.classList.add('pn-sprite-divine');
      D.petSprite.hidden = false;
    }
    if (D.petName) D.petName.textContent = info.name || '';

    // 量一次可见像素 (命中判定)
    try { measureHitBoxes(info.spriteUrl); } catch (e) { /* noop */ }

    // 位置: 跟宿主共用一份 localStorage
    var pos = loadPetPos();
    if (pos) useLeftTop(D.pet, pos.x, pos.y);

    D.pet.hidden = false;
    startFrames();
  }

  function hidePet() {
    if (D.pet) D.pet.hidden = true;
    if (D.petMenu) D.petMenu.hidden = true;
    hideBubble();
    stopFrames();
  }

  function bindPetEvents() {
    if (!D.pet || D.pet.dataset.cxInit === '1') return;
    D.pet.dataset.cxInit = '1';

    D.pet.addEventListener('pointerdown', function (e) {
      if (e.target.closest('#cx-pet-menu')) return;
      // 透明区域不算点在宠物身上 (跟宿主一个口径)
      try { if (!pointOnPet(e.clientX, e.clientY)) return; } catch (err) { /* noop */ }
      S.dragging = true;
      S.moved = false;
      S.startX = e.clientX; S.startY = e.clientY;
      var rect = D.pet.getBoundingClientRect();
      S.originX = rect.left; S.originY = rect.top;
      D.pet.classList.add('is-dragging');
      try {
        D.pet.setPointerCapture(e.pointerId);
      } catch (err) {
        try { if (D.petSprite) D.petSprite.setPointerCapture(e.pointerId); } catch (e2) { /* 忽略 */ }
      }
    });

    D.pet.addEventListener('pointermove', function (e) {
      if (!S.dragging) return;
      var dx = e.clientX - S.startX;
      var dy = e.clientY - S.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) S.moved = true;
      if (!S.moved) return;
      e.preventDefault();
      var vw = global.innerWidth || 390;
      var vh = global.innerHeight || 844;
      var x = clamp(S.originX + dx, 0, Math.max(0, vw - CFG.petSize));
      var y = clamp(S.originY + dy, 0, Math.max(0, vh - CFG.petSize));
      useLeftTop(D.pet, x, y);
    });

    function endDrag() {
      if (!S.dragging) return;
      S.dragging = false;
      D.pet.classList.remove('is-dragging');
      if (S.moved) {
        savePetPos(parseInt(D.pet.style.left, 10) || 0, parseInt(D.pet.style.top, 10) || 0);
      }
    }
    D.pet.addEventListener('pointerup', endDrag);
    D.pet.addEventListener('pointercancel', endDrag);

    // 点击 → 菜单
    // ⚠️ 顺序跟宿主 pet-nest.js 一个口径:
    //   ① 菜单里的按钮 (事件委托) —— 必须在"切菜单"之前,
    //      不然菜单里点任何东西都会把菜单切回去。
    //   ② 点菜单里的空白 → 不动菜单。
    //   ③ 点宠物下方的透明区域 → 不弹菜单 (精灵图是六格图集, 下面那截是空的)。
    //   ④ 点宠物本身 → 开/收菜单。
    D.pet.addEventListener('click', function (e) {
      if (S.moved) { S.moved = false; return; }
      var btn = e.target.closest('#cx-pet-menu .cx-menu-act');
      if (btn) {
        e.stopPropagation();
        var act = btn.getAttribute('data-act') || '';
        if (D.petMenu) D.petMenu.hidden = true;
        if (act === 'toggle') {
          // 只做「隐藏」, 不做来回切换 —— 藏了以后没法再点回来
          // (跟宿主一样, 只能靠悬浮球菜单的「桌宠」开关)
          try { global.localStorage.setItem(KEYS.petVisible, 'false'); } catch (err) { /* noop */ }
          S.petVisible = false;
          hidePet();
          toast('桌宠已隐藏 (在悬浮球菜单里可以再打开)');
          return;
        }
        notifyPetAction(act);
        return;
      }
      if (e.target.closest('#cx-pet-menu')) return;
      try { if (!pointOnPet(e.clientX, e.clientY)) return; } catch (err) { /* noop */ }
      if (D.petMenu) D.petMenu.hidden = !D.petMenu.hidden;
      // 菜单展开时把气泡收掉 (两个都在头顶, 会叠在一起)
      if (D.petMenu && !D.petMenu.hidden) hideBubble();
    });

    // 点菜单外面 → 收菜单
    document.addEventListener('mousedown', function (e) {
      if (!D.petMenu || D.petMenu.hidden) return;
      if (D.pet && D.pet.contains(e.target)) return;
      D.petMenu.hidden = true;
    });
  }

  // ============================================================
  // 3. 悬浮球
  // ============================================================

  function loadBallState() {
    var st = { position: { x: 12, y: 120 }, visible: true, style: {} };
    try {
      var raw = global.localStorage.getItem(KEYS.ballState);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.position) st.position = parsed.position;
        if (parsed && parsed.visible !== undefined) st.visible = parsed.visible;
        if (parsed && parsed.style) st.style = parsed.style;
      }
    } catch (e) { /* noop */ }
    return st;
  }

  function saveBallState(st) {
    try {
      global.localStorage.setItem(KEYS.ballState, JSON.stringify({
        position: st.position,
        visible: st.visible,
        style: st.style
      }));
    } catch (e) { /* noop */ }
  }

  function buildBallDom() {
    if (el('cx-ball')) return;
    var ball = document.createElement('div');
    ball.id = 'cx-ball';
    document.body.appendChild(ball);

    var menu = document.createElement('div');
    menu.id = 'cx-ball-menu';
    menu.className = 'cx-ball-menu';
    menu.innerHTML =
      '<div class="cx-ball-item" data-action="clear-chat-images">🖼 清空聊天图片</div>' +
      '<div class="cx-ball-item" data-action="compress-images">🗜 图片压缩</div>' +
      '<div class="cx-ball-item" data-action="clear-chat-history">🗑 清理聊天记录</div>' +
      '<div class="cx-ball-divider"></div>' +
      '<div class="cx-ball-item" data-action="switch-api">🔄 切换API预设</div>' +
      '<div class="cx-ball-item" data-action="apply-template">📋 应用设置模板</div>' +
      '<div class="cx-ball-item" data-action="role-api">⚙️ 角色API配置</div>' +
      '<div class="cx-ball-item" data-action="style-settings">🎨 样式设置</div>' +
      '<div class="cx-ball-item" data-action="manage-ai-songs">🎵 AI 原创曲管理</div>' +
      '<div class="cx-ball-item" data-action="pet-nest">🐾 宠物屋</div>' +
      '<div class="cx-ball-item" data-action="toggle-desktop-pet" id="cx-ball-pet-label">🐱 桌宠</div>' +
      '<div class="cx-ball-divider"></div>' +
      '<div class="cx-ball-item" data-action="hide">🙈 隐藏悬浮球</div>' +
      '<div class="cx-ball-item danger" data-action="close">✕ 关闭悬浮球</div>';
    document.body.appendChild(menu);

    // API 预设二级菜单 (2026-11-26) —— 沙盒里就地换预设用
    var sub = document.createElement('div');
    sub.id = 'cx-ball-submenu';
    sub.className = 'cx-ball-submenu';
    document.body.appendChild(sub);

    D.ball = ball;
    D.ballMenu = menu;
    D.ballSubmenu = sub;
  }

  function renderBall(st) {
    if (!D.ball) return;
    var style = st.style || {};
    if (style.type === 'image' && style.imageUrl) {
      D.ball.innerHTML = '<img src="' + style.imageUrl + '" alt="悬浮球" class="cx-ball-img">';
    } else if (style.type === 'custom-css' && style.customHTML) {
      D.ball.innerHTML = style.customHTML;
    } else {
      D.ball.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="4" y1="6" x2="20" y2="6"></line>' +
          '<line x1="4" y1="12" x2="20" y2="12"></line>' +
          '<line x1="4" y1="18" x2="20" y2="18"></line>' +
        '</svg>';
    }
    // 自定义 CSS: 宿主那份写的是 #floating-ball, 这里换成沙盒的 id
    var custom = '';
    try {
      if (style.type === 'custom-css') custom = String(style.customCSS || '');
    } catch (e) { custom = ''; }
    if (custom) {
      var s = document.createElement('style');
      s.id = 'cx-ball-custom-style';
      s.textContent = custom.replace(/#floating-ball\b/g, '#cx-ball');
      document.head.appendChild(s);
    }
    try {
      D.ball.style.left = (st.position && st.position.x || 12) + 'px';
      D.ball.style.top = (st.position && st.position.y || 120) + 'px';
    } catch (e) { /* noop */ }
    D.ball.hidden = !st.visible;
  }

  function setBall(st) {
    buildBallDom();
    if (!st) { if (D.ball) D.ball.hidden = true; return; }
    renderBall(st);
    D.ballState = st;
    bindBallEvents();
  }

  function closeBallMenu() {
    S.ballMenuOpen = false;
    if (D.ballMenu) D.ballMenu.classList.remove('show');
  }

  // ============================================================
  // 3a. API 预设二级菜单 (2026-11-26)
  //
  // 【为什么要在沙盒里就地换预设】
  //   悬浮球菜单 12 项里有 9 项干的事在宿主那一层 (开弹窗/开面板/弹提示条),
  //   宿主被 iframe 整屏盖着 → 宿主那边的规矩是"先 closeSandbox() 再执行"。
  //   但【切换API预设】恰恰是用户把悬浮球带进影院/读书屋的主要理由 ——
  //   为换预设把当前这一场踢掉, 本末倒置 (用户原话:
  //   「悬浮球弄进影院就是为了方便切换API预设的, 不然都弹出去了我还弄它进来干啥呢」)。
  //   → 这一项改成: 沙盒向宿主要列表 → 沙盒自己画列表 → 用户选 →
  //     沙盒发指令给宿主去切 → 宿主切完把新配置推回沙盒。
  //   整个过程【不退出影院/读书屋】。
  //
  // 【数据从哪来】沙盒够不着 db.apiPresets (沙盒没加载 api-endpoint-presets.js,
  //   自己的库是 CinemaSandboxDB, 里面也没有 apiPresets 表)
  //   → 列表要宿主给 (宿主那边 listApiPresets())。
  // ============================================================

  function closeApiSubmenu() {
    S.ballSubmenuOpen = false;
    if (D.ballSubmenu) D.ballSubmenu.classList.remove('show');
  }

  /** 摆到悬浮球旁边 (跟宿主那份 submenu 一个套路: 球在左半 → 菜单在右, 反之在左) */
  function positionApiSubmenu() {
    if (!D.ballSubmenu || !D.ball) return;
    var r = D.ball.getBoundingClientRect();
    var vw = global.innerWidth || 390;
    var vh = global.innerHeight || 844;
    var sw = D.ballSubmenu.offsetWidth || 200;
    var sh = D.ballSubmenu.offsetHeight || 200;
    var left;
    if (r.left < vw / 2) {
      left = r.right + 8;
      if (left + sw + 6 > vw) left = r.left - sw - 8;
    } else {
      left = r.left - sw - 8;
      if (left < 6) left = r.right + 8;
    }
    left = clamp(left, 6, Math.max(6, vw - sw - 6));
    var top = clamp(r.top, 6, Math.max(6, vh - sh - 6));
    D.ballSubmenu.style.left = left + 'px';
    D.ballSubmenu.style.top = top + 'px';
  }

  /** 宿主把预设列表发过来了 → 画出来 */
  function openApiSubmenu(payload) {
    if (!D.ballSubmenu) return;
    var presets = (payload && payload.presets) || [];
    var currentId = (payload && payload.currentId != null) ? payload.currentId : null;

    D.ballSubmenu.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'cx-ball-submenu-head';
    head.textContent = '‹ 返回';
    D.ballSubmenu.appendChild(head);

    if (!presets.length) {
      var empty = document.createElement('div');
      empty.className = 'cx-ball-submenu-empty';
      empty.textContent = '还没有 API 预设';
      D.ballSubmenu.appendChild(empty);
    } else {
      presets.forEach(function (p) {
        var item = document.createElement('div');
        var active = (currentId != null && String(p.id) === String(currentId));
        item.className = 'cx-ball-submenu-item' + (active ? ' active' : '');
        item.setAttribute('data-preset-id', String(p.id));
        var radio = document.createElement('span');
        radio.className = 'cx-radio';
        var name = document.createElement('span');
        name.className = 'cx-name';
        // ⚠️ textContent, 不拼 innerHTML —— 预设名是用户自己起的, 可能带尖括号
        name.textContent = p.name || ('预设 ' + p.id);
        item.appendChild(radio);
        item.appendChild(name);
        D.ballSubmenu.appendChild(item);
      });
    }

    positionApiSubmenu();
    D.ballSubmenu.classList.add('show');
    S.ballSubmenuOpen = true;
  }

  /** 沙盒点「切换API预设」→ 向宿主要列表 (不转发 ballAction, 转发的话宿主会收沙盒) */
  function requestApiPresets() {
    closeBallMenu();
    closeApiSubmenu();
    toast('正在读取 API 预设…');
    postToHost({ type: S.ns + ':needApiPresets' });
  }

  function bindApiSubmenuEvents() {
    if (!D.ballSubmenu || D.ballSubmenu.dataset.cxInit === '1') return;
    D.ballSubmenu.dataset.cxInit = '1';
    D.ballSubmenu.addEventListener('click', function (e) {
      var head = e.target.closest ? e.target.closest('.cx-ball-submenu-head') : null;
      if (head) {
        closeApiSubmenu();
        openBallMenu();
        return;
      }
      var item = e.target.closest ? e.target.closest('.cx-ball-submenu-item') : null;
      if (!item) return;
      var id = item.getAttribute('data-preset-id');
      if (!id) return;
      closeApiSubmenu();
      toast('正在切换…');
      // ⚠️ 真正去切的是宿主 (沙盒没有 db.apiPresets, 也没那个切换逻辑)
      postToHost({ type: S.ns + ':switchApiPreset', id: id });
    });
  }

  /** 收宿主发来的消息 (预设列表 / 切换结果) */
  function bindHostMessages() {
    if (S.hostMsgBound) return;
    S.hostMsgBound = true;
    global.addEventListener('message', function (e) {
      if (!S.ns) return;
      // 只认宿主发来的 (沙盒是 iframe, 宿主 = window.parent)
      if (global.parent && global.parent !== global && e.source !== global.parent) return;
      var d = e.data || {};
      if (d.type === S.ns + ':apiPresets') {
        openApiSubmenu(d);
      } else if (d.type === S.ns + ':apiPresetSwitched') {
        closeApiSubmenu();
        if (d.ok) toast('已切换主 API 到：' + (d.name || ''));
        else toast('切换 API 预设失败');
      }
    });
  }

  function openBallMenu() {
    if (!D.ballMenu || !D.ball) return;
    var r = D.ball.getBoundingClientRect();
    var vw = global.innerWidth || 390;
    var vh = global.innerHeight || 844;
    var mh = D.ballMenu.offsetHeight || 320;
    var mw = D.ballMenu.offsetWidth || 200;
    var left = clamp(r.left, 6, Math.max(6, vw - mw - 6));
    var top = clamp(r.bottom + 8, 6, Math.max(6, vh - mh - 6));
    D.ballMenu.style.left = left + 'px';
    D.ballMenu.style.top = top + 'px';
    D.ballMenu.classList.add('show');
    S.ballMenuOpen = true;
  }

  function bindBallEvents() {
    if (!D.ball || D.ball.dataset.cxInit === '1') return;
    D.ball.dataset.cxInit = '1';

    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    D.ball.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = D.ball.getBoundingClientRect();
      ox = r.left; oy = r.top;
      D.ball.classList.add('dragging');
      try { D.ball.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    D.ball.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      e.preventDefault();
      var vw = global.innerWidth || 390;
      var vh = global.innerHeight || 844;
      D.ball.style.left = clamp(ox + dx, 0, Math.max(0, vw - CFG.ballSize)) + 'px';
      D.ball.style.top = clamp(oy + dy, 0, Math.max(0, vh - CFG.ballSize)) + 'px';
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      D.ball.classList.remove('dragging');
      if (moved && D.ballState) {
        D.ballState.position = {
          x: parseInt(D.ball.style.left, 10) || 0,
          y: parseInt(D.ball.style.top, 10) || 0
        };
        saveBallState(D.ballState);
      }
    }
    D.ball.addEventListener('pointerup', endDrag);
    D.ball.addEventListener('pointercancel', endDrag);

    D.ball.addEventListener('click', function (e) {
      e.stopPropagation();
      if (moved) { moved = false; return; }
      closeApiSubmenu();
      if (S.ballMenuOpen) closeBallMenu(); else openBallMenu();
    });

    if (D.ballMenu) {
      D.ballMenu.addEventListener('click', function (e) {
        var item = e.target.closest('.cx-ball-item');
        if (!item) return;
        var action = item.getAttribute('data-action') || '';
        closeBallMenu();
        if (!action) return;
        // ⚠️【2026-11-26】"切换API预设" 在沙盒里就地做 —— 不转发给宿主,
        //   所以【不会退出影院/读书屋】(转发的话宿主那边会先 closeSandbox)。
        //   用户把悬浮球带进来就是为了方便换预设 (原话: 「悬浮球弄进影院就是为了
        //   方便切换API预设的, 不然都弹出去了我还弄它进来干啥呢」)。
        if (action === 'switch-api') {
          requestApiPresets();
          return;
        }
        // 桌宠开关: 沙盒这边自己改就行 (跟宿主共用 localStorage)
        if (action === 'toggle-desktop-pet') {
          try {
            var cur = global.localStorage.getItem(KEYS.petVisible) !== 'false';
            global.localStorage.setItem(KEYS.petVisible, cur ? 'false' : 'true');
          } catch (err) { /* noop */ }
          if (cur) hidePet(); else setPet(S.pet);
          toast(cur ? '桌宠已隐藏' : '桌宠已显示');
          return;
        }
        if (action === 'hide' || action === 'close') {
          if (D.ballState) {
            D.ballState.visible = false;
            saveBallState(D.ballState);
          }
          if (D.ball) D.ball.hidden = true;
          toast('悬浮球已隐藏 (在设置里可以再打开)');
          return;
        }
        // 其余动作都在宿主那边做 (宿主会先把沙盒收掉, 让用户看得见结果)
        notifyBallAction(action);
      });
    }

    document.addEventListener('mousedown', function (e) {
      if (S.ballSubmenuOpen) {
        if (D.ballSubmenu && D.ballSubmenu.contains(e.target)) return;
        if (D.ball && D.ball.contains(e.target)) return;
        closeApiSubmenu();
      }
      if (!S.ballMenuOpen) return;
      if (D.ball && D.ball.contains(e.target)) return;
      if (D.ballMenu && D.ballMenu.contains(e.target)) return;
      closeBallMenu();
    });
  }

  // ============================================================
  // 4. 提示条 (沙盒自己的 —— 宿主那条 toast 在 iframe 底下, 用户看不见)
  // ============================================================

  function toast(text) {
    var t = el('cx-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cx-toast';
      document.body.appendChild(t);
    }
    t.textContent = String(text || '');
    t.classList.add('on');
    if (S.toastTimer) global.clearTimeout(S.toastTimer);
    S.toastTimer = global.setTimeout(function () {
      if (t) t.classList.remove('on');
    }, CFG.toastMs);
  }

  // ============================================================
  // 5. 对外接口
  // ============================================================

  /**
   * @param {Object} opts
   *   ns           'cinema' | 'reading'  —— postMessage 前缀
   *   onPetAction  function (action)     —— 宿主执行照顾动作
   *   onBallAction function (action)     —— 宿主执行悬浮球菜单动作
   */
  function init(opts) {
    var o = opts || {};
    if (o.ns) S.ns = o.ns;
    if (typeof o.onPetAction === 'function') S.onPetAction = o.onPetAction;
    if (typeof o.onBallAction === 'function') S.onBallAction = o.onBallAction;

    buildPetDom();
    bindPetEvents();
    buildBallDom();
    bindBallEvents();
    bindApiSubmenuEvents();
    bindHostMessages();

    // 桌宠开关 (跟宿主共用一份)
    var petVisible = true;
    try { petVisible = global.localStorage.getItem(KEYS.petVisible) !== 'false'; } catch (e) { /* noop */ }
    S.petVisible = petVisible;

    // 悬浮球: 直接读宿主那份 localStorage (同源, 不用宿主转发)
    setBall(loadBallState());
    return global.CompanionLayer;
  }

  /** 宠物在宿主那边说了话 → 沙盒冒一个气泡 */
  function say(petName, text) {
    var body = String(text || '').trim();
    if (!body) return;
    buildPetDom();
    if (!S.pet) return;                     // 宿主那边还没下发桌宠信息 → 不冒泡
    var name = String(petName || '').trim() || (S.pet && S.pet.name) || '宠物';
    showBubble('🐾 ' + name + '：' + body);
  }

  /** 整体开关 (宿主进沙盒前可以先关掉) */
  function setEnabled(on) {
    S.enabled = !!on;
    if (S.enabled) {
      if (D.pet) D.pet.hidden = !(S.pet && S.petVisible !== false);
      if (D.ball) D.ball.hidden = !(D.ballState && D.ballState.visible);
    } else {
      if (D.pet) D.pet.hidden = true;
      if (D.ball) D.ball.hidden = true;
      closeBallMenu();
      closeApiSubmenu();
    }
  }

  global.CompanionLayer = {
    init: init,
    setPet: setPet,
    hidePet: hidePet,
    setBall: setBall,
    say: say,
    toast: toast,
    setEnabled: setEnabled,
    state: S
  };
})(window);

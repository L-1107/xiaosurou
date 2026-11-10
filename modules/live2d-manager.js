// 视频通话形象调试台 (v0.5.0 P0 起步, v0.5.0 P2.4 改定位)
// 准备页"管理"按钮入口, 复用现有 Live2D 核心 API
// 依赖: window.Live2DStorage (listModels/getModel/deleteModel/getActiveModelIdForChat/setActiveModelIdForChat/getVideoCallAppearance/setVideoCallAppearance)
// 依赖: window.Live2DLoader (mountLive2DFromIDB/disposeLive2D)
// 依赖: window.Live2DCallPrep.render(chat) - 关闭时回调让准备页刷新
// 职责: 列表 + 完整 Live2D 预览 + 元数据 + 动作/表情调试 + 删除 + "使用此形象进入视频通话" 主操作
// 不做: 上传/选择/动作权限/衣橱/构图/VTube 参数编辑器
// 不做: AI 自动表情 (P2.4 留数据接口, runtime 改 expression 不反向写 defaultExpression)
// DOM 动态注入 (init 时), 不需要预先在 index.html 写
// CSS 走 index.html 静态 link (避免动态注入导致首帧无样式)
// API: window.Live2DManager = { init, open, close }

(function (global) {
  'use strict';

  // v0.5.0 P1.5: 表情 ID → 中文 label 映射 (cdi3.json 拿的, 给按钮显示用, AI 仍用 ID 触发)
  // 加新模型时往这里加条目即可 (key = .exp3.json basename, value = 中文名)
  const EXPRESSION_CN_LABELS = {
    'cry':              '流泪',
    'mask':             '面具',
    'star_eyes':        '星星眼',
    'cat_ears':         '猫耳',
    'cat_paw_up':       '举手猫爪',
    'dark_face':        '黑脸',
    'action3':          '动作3',
    'face_sticker':     '脸贴纸',
    'blush':            '脸红',
    'cat_tail':         '猫尾巴',
    'hairpin':          '发卡',
    'earring':          '耳钉',
    'zoom':             '放大',
  };

  let screenEl = null;
  let listEl = null;
  let emptyHintEl = null;
  let canvasEl = null;
  let canvasWrapEl = null;
  let loadingEl = null;
  let errorEl = null;
  let errorMsgEl = null;
  let retryBtnEl = null;
  let infoEl = null;
  let infoNameEl = null;
  let infoMetaEl = null;
  let delBtnEl = null;
  let backBtnEl = null;
  let hintEl = null;
  let debugSectionEl = null;   // 动作/表情调试区容器
  let motionsEl = null;        // 动作按钮容器
  let expressionsEl = null;    // 表情按钮容器
  let motionsEmptyEl = null;   // 动作空状态文字
  let expressionsEmptyEl = null; // 表情空状态文字
  let zoomInBtnEl = null;
  let zoomOutBtnEl = null;
  let zoomResetBtnEl = null;
  let modelBaseScale = 1;      // 挂载时记下的初始 scale, 给 zoomResetBtn 用
  // v0.5.0 P1.1: 删除确认弹窗 refs (替代 window.confirm, iOS PWA 兼容)
  let delModalEl = null;
  let delModalDescEl = null;
  let delModalCancelEl = null;
  let delModalConfirmEl = null;
  let pendingDelModelId = '';   // 当前弹窗等待删除的 modelId (挂载失败也能删, 不依赖 activeModel 实例)
  // v0.5.0 P2.4: "使用此形象进入视频通话" 主操作 refs
  let confirmSectionEl = null;
  let confirmBtnEl = null;
  let confirmHintEl = null;
  // v0.5.0 P2.4: 跟踪用户在调试台当前选中的 expression (用户最后选的表情就是 defaultExpression 候选)
  // '' 表示"恢复默认"或未选, 任何非空字符串就是 .exp3.json 的 basename
  let currentExpression = '';

  let currentChat = null;
  let onCloseCallback = null;
  let activeModelId = null;     // 当前管理页正在预览的 modelId
  let activeModel = null;       // 当前预览的 PIXI Live2D model 实例 (mountLive2DFromIDB 返回的 result.model)
  let loadingToken = 0;         // 防过期回调覆盖 (快速切换时旧请求回来覆盖新状态)
  // v0.5.0 P1+ 表情调试: 绕开库 expressionManager (我们 0.4.0 cubism4 fork 库对 .exp3.json 不实例化 manager)
  // 抄糯米机 Live2DAvatarCanvas 整套 setParameterValueById 风格, 直接 SDK 改参数
  let expressionData = {};      // {name: {file, params: [{id, value, blend, index}]}}  从 .exp3.json 解析
  let initialParamValues = null; // Map<index, value>  挂载成功时快照, 给 reset 用

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function ensureScreenDom() {
    // CSS 走 index.html 静态 link, 这里只兜底 (防止忘记在 index.html 加)
    if (!document.querySelector('link[href*="live2d-manager.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'css/live2d-manager.css?v=0.0.1';
      document.head.appendChild(link);
    }
    if (screenEl && document.body.contains(screenEl)) return screenEl;
    let existing = document.getElementById('live2d-manager-screen');
    if (existing) {
      screenEl = existing;
    } else {
      const wrap = document.createElement('div');
      wrap.id = 'live2d-manager-screen';
      // 关键: 不要在这里设 inline display:none. 整个 .screen 体系靠 .active 切显隐
      // (.screen 默认 opacity:0+visibility:hidden, .screen.active 反之).
      // 设了 inline display:none 会让 showScreen 加 .active 也没用, 整页空白 (v0.5.0 P0 bug)
      wrap.className = 'screen live2d-manager-screen';
      wrap.innerHTML = [
        '<header class="live2d-manager-header">',
        '  <button type="button" class="live2d-manager-back-btn" data-role="back" aria-label="返回">‹</button>',
        '  <h1 class="live2d-manager-title">视频通话形象调试台</h1>',
        '  <span class="live2d-manager-header-spacer"></span>',
        '</header>',
        '<div class="live2d-manager-body">',
        '  <section class="live2d-manager-list-section">',
        '    <div class="live2d-manager-section-title">已上传模型</div>',
        '    <div class="live2d-manager-list" data-role="list"></div>',
        '    <div class="live2d-manager-empty" data-role="empty" style="display:none">',
        '      还没有上传过模型，去准备页点「＋ 上传 / 选择 Live2D」吧',
        '    </div>',
        '  </section>',
        '  <section class="live2d-manager-detail-section">',
        '    <div class="live2d-manager-preview" data-role="preview">',
        '      <div class="live2d-manager-canvas-wrap" data-role="canvas-wrap">',
        '        <canvas data-role="canvas"></canvas>',
        '        <div class="live2d-manager-zoom-controls">',
        '          <button type="button" class="live2d-manager-zoom-btn" data-role="zoom-in" aria-label="放大">+</button>',
        '          <button type="button" class="live2d-manager-zoom-btn" data-role="zoom-out" aria-label="缩小">−</button>',
        '          <button type="button" class="live2d-manager-zoom-btn live2d-manager-zoom-reset" data-role="zoom-reset" aria-label="还原大小">⟲</button>',
        '        </div>',
        '      </div>',
        '      <div class="live2d-manager-overlay live2d-manager-hint" data-role="hint">',
        '        <span class="live2d-manager-hint-emoji">🎭</span>',
        '        <span>点击上方模型预览</span>',
        '      </div>',
        '      <div class="live2d-manager-overlay live2d-manager-loading" data-role="loading" style="display:none">',
        '        <div class="live2d-manager-spinner"></div>',
        '        <div class="live2d-manager-loading-text" data-role="loading-text">正在准备模型资源…</div>',
        '      </div>',
        '      <div class="live2d-manager-overlay live2d-manager-error" data-role="error" style="display:none">',
        '        <p class="live2d-manager-error-msg" data-role="error-msg"></p>',
        '        <button type="button" class="live2d-manager-retry-btn" data-role="retry">重新加载</button>',
        '      </div>',
        '    </div>',
        '    <div class="live2d-manager-info" data-role="info" style="display:none">',
        '      <div class="live2d-manager-info-name" data-role="info-name"></div>',
        '      <div class="live2d-manager-info-meta" data-role="info-meta"></div>',
        '    </div>',
        '    <div class="live2d-manager-debug" data-role="debug" style="display:none">',
        '      <div class="live2d-manager-debug-block">',
        '        <div class="live2d-manager-section-title">动作</div>',
        '        <div class="live2d-manager-debug-buttons" data-role="motions"></div>',
        '        <div class="live2d-manager-debug-empty" data-role="motions-empty" style="display:none">暂无可用动作</div>',
        '      </div>',
        '      <div class="live2d-manager-debug-block">',
        '        <div class="live2d-manager-section-title">表情</div>',
        '        <div class="live2d-manager-debug-buttons" data-role="expressions"></div>',
        '        <div class="live2d-manager-debug-empty" data-role="expressions-empty" style="display:none">暂无可用表情</div>',
        '      </div>',
        '    </div>',
        // v0.5.0 P2.4: "视频通话形象调试台" 主操作 — 表情区下方, 比普通调试按钮更突出
        '    <div class="live2d-manager-confirm" data-role="confirm-section">',
        '      <button type="button" class="live2d-manager-confirm-btn" data-role="confirm-appearance">',
        '        <span class="live2d-manager-confirm-btn-icon">📞</span>',
        '        <span class="live2d-manager-confirm-btn-text">使用此形象进入视频通话</span>',
        '      </button>',
        '      <div class="live2d-manager-confirm-hint">将当前形象设为视频通话默认状态，AI 可在通话中根据对话实时调整</div>',
        '    </div>',
        '    <div class="live2d-manager-actions">',
        // v0.5.0 P1.1: delBtn 永远显示 (加载失败也要能删), 默认 inline-block
        '      <button type="button" class="live2d-manager-del-btn" data-role="delete">删除这个模型</button>',
        '    </div>',
        // v0.5.0 P1.1: 删除确认弹窗 (替代 window.confirm, iOS PWA 兼容)
        // user 反馈"点叉没办法删除" 真凶: confirm() 在 PWA standalone 模式静默 false
        // 桌面浏览器 confirm() 弹得正常, 但统一走 modal 更稳
        '    <div class="live2d-manager-del-modal-overlay" data-role="del-modal" style="display:none">',
        '      <div class="live2d-manager-del-modal">',
        '        <div class="live2d-manager-del-modal-icon">🗑️</div>',
        '        <div class="live2d-manager-del-modal-title">删除这个模型？</div>',
        '        <div class="live2d-manager-del-modal-desc" data-role="del-modal-desc">此操作不可撤销</div>',
        '        <div class="live2d-manager-del-modal-actions">',
        '          <button type="button" class="live2d-manager-del-modal-btn live2d-manager-del-modal-btn-cancel" data-role="del-modal-cancel">取消</button>',
        '          <button type="button" class="live2d-manager-del-modal-btn live2d-manager-del-modal-btn-confirm" data-role="del-modal-confirm">确定删除</button>',
        '        </div>',
        '      </div>',
        '    </div>',
        '  </section>',
        '</div>',
      ].join('\n');
      document.body.appendChild(wrap);
      screenEl = wrap;
    }
    return screenEl;
  }

  function bindRefs() {
    listEl = screenEl.querySelector('[data-role="list"]');
    emptyHintEl = screenEl.querySelector('[data-role="empty"]');
    canvasEl = screenEl.querySelector('[data-role="canvas"]');
    canvasWrapEl = screenEl.querySelector('[data-role="canvas-wrap"]');
    loadingEl = screenEl.querySelector('[data-role="loading"]');
    errorEl = screenEl.querySelector('[data-role="error"]');
    errorMsgEl = screenEl.querySelector('[data-role="error-msg"]');
    retryBtnEl = screenEl.querySelector('[data-role="retry"]');
    infoEl = screenEl.querySelector('[data-role="info"]');
    infoNameEl = screenEl.querySelector('[data-role="info-name"]');
    infoMetaEl = screenEl.querySelector('[data-role="info-meta"]');
    delBtnEl = screenEl.querySelector('[data-role="delete"]');
    backBtnEl = screenEl.querySelector('[data-role="back"]');
    hintEl = screenEl.querySelector('[data-role="hint"]');
    debugSectionEl = screenEl.querySelector('[data-role="debug"]');
    motionsEl = screenEl.querySelector('[data-role="motions"]');
    expressionsEl = screenEl.querySelector('[data-role="expressions"]');
    motionsEmptyEl = screenEl.querySelector('[data-role="motions-empty"]');
    expressionsEmptyEl = screenEl.querySelector('[data-role="expressions-empty"]');
    zoomInBtnEl = screenEl.querySelector('[data-role="zoom-in"]');
    zoomOutBtnEl = screenEl.querySelector('[data-role="zoom-out"]');
    zoomResetBtnEl = screenEl.querySelector('[data-role="zoom-reset"]');
    // v0.5.0 P1.1: 删除确认弹窗 refs
    delModalEl = screenEl.querySelector('[data-role="del-modal"]');
    delModalDescEl = screenEl.querySelector('[data-role="del-modal-desc"]');
    delModalCancelEl = screenEl.querySelector('[data-role="del-modal-cancel"]');
    delModalConfirmEl = screenEl.querySelector('[data-role="del-modal-confirm"]');
    // v0.5.0 P2.4: 主操作按钮 refs
    confirmSectionEl = screenEl.querySelector('[data-role="confirm-section"]');
    confirmBtnEl = screenEl.querySelector('[data-role="confirm-appearance"]');
    confirmHintEl = confirmSectionEl ? confirmSectionEl.querySelector('.live2d-manager-confirm-hint') : null;
  }

  function bindEvents() {
    if (backBtnEl) backBtnEl.onclick = close;
    if (retryBtnEl) retryBtnEl.onclick = () => {
      if (activeModelId) selectModel(activeModelId, true);
    };
    if (delBtnEl) delBtnEl.onclick = () => {
      // v0.5.0 P1.1: 弹 modal 二次确认 (替代 window.confirm, PWA 兼容)
      // 拿当前 modelName (从 infoNameEl 读; 加载失败时也有, 来自 showModelErrorInfo)
      const name = (infoNameEl && infoNameEl.textContent) || '这个模型';
      const id = activeModelId || pendingDelModelId;
      if (!id) {
        console.warn('[Live2DManager] delBtn 点击但没有 activeModelId');
        return;
      }
      showDeleteConfirm(id, name);
    };
    // v0.5.0 P1.1: modal 取消/确定 按钮
    if (delModalCancelEl) {
      delModalCancelEl.onclick = function () {
        console.log('[Live2DManager] 取消删除');
        hideDeleteConfirm();
      };
    }
    if (delModalConfirmEl) {
      delModalConfirmEl.onclick = async function () {
        const id = pendingDelModelId;
        hideDeleteConfirm();
        if (id) await deleteModel(id);
      };
    }
    // 点遮罩取消 (排除点击 modal 卡片本身)
    if (delModalEl) {
      delModalEl.onclick = function (ev) {
        if (ev.target === delModalEl) {
          console.log('[Live2DManager] 点遮罩取消');
          hideDeleteConfirm();
        }
      };
    }
    if (listEl) listEl.onclick = (ev) => {
      const card = ev.target.closest('[data-model-id]');
      if (!card) return;
      const id = card.getAttribute('data-model-id');
      if (id) selectModel(id);
    };

    // v0.5.0 P1: 动作/表情调试按钮事件委托 (init 时绑一次, 按钮 HTML 是动态生成的)
    if (motionsEl) {
      motionsEl.addEventListener('click', function (ev) {
        const btn = ev.target.closest('[data-action="motion"]');
        if (!btn) return;
        const group = btn.getAttribute('data-group');
        const index = parseInt(btn.getAttribute('data-index'), 10);
        if (!canvasEl || !group || !Number.isFinite(index)) return;
        if (global.Live2DLoader && global.Live2DLoader.playMotion) {
          try { global.Live2DLoader.playMotion(canvasEl, group, index); }
          catch (e) { console.warn('[Live2DManager] playMotion failed:', e); }
        }
        flashDebugButton(btn, motionsEl);
      });
    }
    if (expressionsEl) {
      expressionsEl.addEventListener('click', function (ev) {
        const btn = ev.target.closest('[data-action="expression"], [data-action="expression-reset"]');
        if (!btn) return;
        if (!canvasEl) return;
        const action = btn.getAttribute('data-action');
        try {
          if (action === 'expression' && activeModel) {
            const id = btn.getAttribute('data-id');
            // 抄糯米机 Live2DAvatarCanvas 直 SDK 改参数, 绕开库 expressionManager
            if (id) applyExpressionToModel(activeModel, id);
            // v0.5.0 P2.4: 跟踪用户最后选中的 expression, 点"使用此形象进入视频通话"时存为 defaultExpression
            // '↺ 默认' 按钮 action === 'expression-reset' 不进这条, 见下面
            currentExpression = id || '';
          } else if (action === 'expression-reset' && activeModel) {
            // 恢复所有参数到挂载时的初始值
            resetExpressionParams(activeModel);
            // v0.5.0 P2.4: '恢复默认' 也是合法选择, currentExpression = '' (空串 = 起始无 expression)
            currentExpression = '';
          }
        } catch (e) { console.warn('[Live2DManager] expression click failed:', e); }
        flashDebugButton(btn, expressionsEl);
      });
    }

    // v0.5.0 P2.4: "使用此形象进入视频通话" 主按钮 → 收集当前形象状态 + 存 storage + 回到准备页
    // 默认状态 (用户保存的) ≠ 运行时状态 (AI 后续改的): currentExpression 是用户点这个按钮时的"起始" expression
    if (confirmBtnEl) {
      confirmBtnEl.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        saveAndGoToPrep();
      });
    }

    // v0.5.0 P1+ 模型拖动 (参考糯米机 Live2DActionSettings framing 设计思路: 给用户控制权, 不猜模型内部偏移)
    // 之前几轮试过 getLocalBounds / drawables 顶点 / 视觉中心, 0.4.0 cubism4 fork 字段结构都猜不准.
    // 干脆让用户拖: 拖哪儿到哪儿, 切模型时 reset.
    if (canvasWrapEl) {
      let isDraggingModel = false;
      let dragStartX = 0, dragStartY = 0;
      let modelStartX = 0, modelStartY = 0;
      let dragPointerId = null;
      canvasWrapEl.addEventListener('pointerdown', function (ev) {
        if (!activeModel) return;
        // 只响应鼠标左键 / 触摸 / 笔
        if (ev.button !== undefined && ev.button !== 0) return;
        isDraggingModel = true;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        try { modelStartX = activeModel.x; modelStartY = activeModel.y; } catch (e) { modelStartX = 0; modelStartY = 0; }
        dragPointerId = ev.pointerId;
        canvasWrapEl.classList.add('is-dragging-model');
        try { canvasWrapEl.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        ev.preventDefault();
      });
      canvasWrapEl.addEventListener('pointermove', function (ev) {
        if (!isDraggingModel || !activeModel) return;
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        try {
          activeModel.x = modelStartX + dx;
          activeModel.y = modelStartY + dy;
        } catch (e) { /* ignore */ }
      });
      const endDrag = function () {
        if (!isDraggingModel) return;
        isDraggingModel = false;
        canvasWrapEl.classList.remove('is-dragging-model');
        if (dragPointerId !== null) {
          try { canvasWrapEl.releasePointerCapture(dragPointerId); } catch (e) { /* ignore */ }
          dragPointerId = null;
        }
      };
      canvasWrapEl.addEventListener('pointerup', endDrag);
      canvasWrapEl.addEventListener('pointercancel', endDrag);
      // 拖出 wrap 边界也结束拖拽
      canvasWrapEl.addEventListener('pointerleave', endDrag);
    }

    // v0.5.0 P1+ 缩放 (滚轮 + +/− 按钮 + 还原按钮)
    // 跟拖动一样, 给用户控制权不猜模型内部适配
    const ZOOM_STEP = 1.15;
    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 8.0;
    function scaleModel(factor) {
      if (!activeModel || !activeModel.scale) return;
      const cur = activeModel.scale.x || 1;
      let next = cur * factor;
      if (next < ZOOM_MIN) next = ZOOM_MIN;
      if (next > ZOOM_MAX) next = ZOOM_MAX;
      try {
        activeModel.scale.set(next, next);
      } catch (e) { /* ignore */ }
    }
    if (zoomInBtnEl) {
      zoomInBtnEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        scaleModel(ZOOM_STEP);
      });
    }
    if (zoomOutBtnEl) {
      zoomOutBtnEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        scaleModel(1 / ZOOM_STEP);
      });
    }
    if (zoomResetBtnEl) {
      zoomResetBtnEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!activeModel) return;
        try {
          activeModel.scale.set(modelBaseScale || 1, modelBaseScale || 1);
        } catch (e) { /* ignore */ }
      });
    }
    if (canvasWrapEl) {
      canvasWrapEl.addEventListener('wheel', function (ev) {
        if (!activeModel) return;
        ev.preventDefault();
        // 滚轮上滑放大, 下滑缩小
        scaleModel(ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      }, { passive: false });
    }
  }

  // v0.5.0 P1: 调试按钮点击高亮 (500ms 后自动消失, 跟现有 active 视觉风格一致)
  function flashDebugButton(btn, container) {
    if (!btn || !container) return;
    container.querySelectorAll('.live2d-manager-debug-btn-active')
      .forEach(b => b.classList.remove('live2d-manager-debug-btn-active'));
    btn.classList.add('live2d-manager-debug-btn-active');
    setTimeout(() => {
      if (btn && btn.classList) btn.classList.remove('live2d-manager-debug-btn-active');
    }, 500);
  }

  function init() {
    ensureScreenDom();
    bindRefs();
    bindEvents();
  }

  function showOverlay(state) {
    // state: 'idle' (hint) | 'loading' | 'error' | 'ready' (无覆盖)
    if (hintEl) hintEl.style.display = state === 'idle' ? 'flex' : 'none';
    if (loadingEl) loadingEl.style.display = state === 'loading' ? 'flex' : 'none';
    if (errorEl) errorEl.style.display = state === 'error' ? 'flex' : 'none';
  }

  function disposeCurrentPreview() {
    if (canvasEl && global.Live2DLoader) {
      try { global.Live2DLoader.disposeLive2D(canvasEl); } catch (e) {
        console.warn('[Live2DManager] dispose error:', e);
      }
    }
    activeModel = null;
  }

  // v0.5.0: 每次重新初始化前换一个全新 canvas, 不复用旧 WebGL context.
  // 管理页 [data-role="canvas"] 是模板里创建一次、永久复用的静态元素: 第一次 init 后,
  // 这个 canvas 上挂着旧 PIXI / WebGL context, 而 loader.disposeLive2D 用 app.destroy(false),
  // PIXI v6 不会调 WEBGL_lose_context 真正释放它 (bundle 里 loseContext 只出现在 isWebGLSupported 探测).
  // 于是下一次 mountLive2DFromIDB 复用同一个 canvas -> 拿到失效 context ->
  // PIXI BatchRenderer 的 gl.getParameter(MAX_TEXTURE_IMAGE_UNITS)=0 ->
  // 抛 "Invalid value of `0` passed to `checkMaxIfStatementsInShader`" (删除→再上传→第二次 init 必现,
  // 大退重进 = 新 canvas + 新 context 就好).
  // 这里用全新 <canvas data-role="canvas"> 替换旧的并同步回模块变量: 旧 canvas 从 DOM 摘除后其
  // context 可被回收, 新 canvas 无 context, 供 mountLive2DFromIDB 建全新 context, 等价"大退重进".
  function freshCanvasElement() {
    if (!canvasWrapEl || !canvasEl) return canvasEl;
    const fresh = document.createElement('canvas');
    fresh.setAttribute('data-role', 'canvas');
    // 给个合理默认尺寸 (后续 mountLive2D 会按 wrap 实际尺寸重设, 避免 0×0)
    try {
      fresh.width = canvasEl.width || 300;
      fresh.height = canvasEl.height || 150;
    } catch (e) { /* 读旧尺寸失败不阻塞 */ }
    try {
      canvasEl.replaceWith(fresh);
    } catch (e) {
      // 兜底: replaceWith 不支持时手插
      if (canvasEl && canvasEl.parentNode) {
        canvasEl.parentNode.insertBefore(fresh, canvasEl.nextSibling);
        canvasEl.parentNode.removeChild(canvasEl);
      }
    }
    canvasEl = fresh;
    return fresh;
  }

  function setLoadingText(text) {
    if (!loadingEl) return;
    const t = loadingEl.querySelector('[data-role="loading-text"]');
    if (t) t.textContent = text || '正在加载…';
  }

  function updateCardHighlight() {
    if (!listEl) return;
    listEl.querySelectorAll('[data-model-id]').forEach(el => {
      el.classList.toggle('live2d-manager-card-active', el.getAttribute('data-model-id') === activeModelId);
    });
  }

  async function renderList() {
    if (!listEl || !global.Live2DStorage) return;
    let models = [];
    try {
      models = await global.Live2DStorage.listModels();
    } catch (e) {
      listEl.innerHTML = '<div class="live2d-manager-list-error">加载模型列表失败: ' + escapeHtml(e.message || String(e)) + '</div>';
      return;
    }
    if (emptyHintEl) emptyHintEl.style.display = models.length === 0 ? 'block' : 'none';
    if (models.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    // 标记每个 model 是否被当前 chat per-chat 绑定 (仅展示, 不影响管理操作)
    let activeId = null;
    if (currentChat && global.Live2DStorage.getActiveModelIdForChat) {
      try { activeId = await global.Live2DStorage.getActiveModelIdForChat(currentChat.id); } catch (e) {}
    }
    listEl.innerHTML = models.map(m => {
      const isActive = m.id === activeId;
      const boundMark = isActive ? '<span class="live2d-manager-card-bound">当前 AI 已绑定</span>' : '';
      const dateStr = new Date(m.addedAt).toLocaleDateString('zh-CN');
      return [
        '<div class="live2d-manager-card" data-model-id="' + escapeHtml(m.id) + '">',
        '  <div class="live2d-manager-card-name">' + escapeHtml(m.name) + '</div>',
        '  <div class="live2d-manager-card-meta">',
        '    <span>' + m.fileCount + ' 个文件</span>',
        '    <span>·</span>',
        '    <span>' + dateStr + '</span>',
        '  </div>',
        (isActive ? '  <div class="live2d-manager-card-bound-wrap">' + boundMark + '</div>' : ''),
        '</div>',
      ].join('');
    }).join('');
    updateCardHighlight();
  }

  function readModelStats(data) {
    let motionsCount = 0, expressionsCount = 0, texturesCount = 0, totalSize = 0;
    try {
      // v0.5.0 P1+ 修正: model3.json FileReferences 经常没列 Motions/Expressions,
      // 但 data.files 里实际有 .motion3.json / .exp3.json 文件 (小狼就是这种).
      // 优先扫 data.files 拿真实文件数, 再从 data.config.refs 补 textures (texture 一定在 refs 里).
      if (data && data.files) {
        for (const filePath of data.files.keys()) {
          const lower = filePath.toLowerCase();
          if (lower.endsWith('.motion3.json')) motionsCount++;
          else if (lower.endsWith('.exp3.json')) expressionsCount++;
        }
      }
      try {
        const refs = (data && data.config && data.config.refs) || {};
        if (Array.isArray(refs.Textures)) texturesCount = refs.Textures.length;
      } catch (e) { /* ignore */ }
      if (data.files && typeof data.files.forEach === 'function') {
        data.files.forEach(blob => { if (blob && typeof blob.size === 'number') totalSize += blob.size; });
      }
    } catch (e) { /* 元数据解析失败不阻塞预览 */ }
    return { motionsCount, expressionsCount, texturesCount, totalSize };
  }

  async function selectModel(modelId, isRetry) {
    if (!modelId) return;
    if (!global.Live2DLoader) {
      showErrorOverlay('Live2DLoader 模块未加载');
      return;
    }
    // v0.5.0 P2.4: 切模型时重置"用户选中的 expression", 旧模型选择不能跨模型带过去
    currentExpression = '';
    // v0.5.0 P1.3 兜底: 放弃依赖 canvasEl 模块变量, 每次强制 querySelector (同步 + microtask 双重)
    // user 报 "每次第一次加载都报 canvas is null, F5 刷新就好" 真凶: 跨 open() 时 canvasEl 引用错位 + DOM 渲染竞态
    let canvas = canvasEl;
    if (!canvas || !canvas.parentElement) {
      canvas = screenEl && screenEl.querySelector('[data-role="canvas"]');
    }
    if (!canvas) {
      // 等一个 microtask 让 DOM 完全渲染, 再 querySelector
      await new Promise(r => setTimeout(r, 0));
      canvas = screenEl && screenEl.querySelector('[data-role="canvas"]');
    }
    if (!canvas) {
      console.error('[Live2DManager] canvasEl STILL null after microtask retry, screenEl:', screenEl && screenEl.children.length);
      showErrorOverlay('canvas DOM 元素找不到, 请刷新页面 (Ctrl+Shift+R)');
      return;
    }
    canvasEl = canvas;  // 同步回模块变量 (后续 disposeCurrentPreview / playMotion 用)
    // 切换时先完整 dispose 旧的
    disposeCurrentPreview();
    // v0.5.0: dispose 后换全新 canvas, 不复用旧 WebGL context (旧 canvas 残留失效 context
    // 会导致"删除→再上传→第二次 init"报 checkMaxIfStatementsInShader; 换成新 canvas 等价大退重进)
    freshCanvasElement();
    activeModelId = modelId;
    updateCardHighlight();
    // 隐藏信息 + 删除按钮 (避免旧数据残留)
    if (infoEl) infoEl.style.display = 'none';
    if (delBtnEl) delBtnEl.style.display = 'none';
    // 立刻清空调试区 (切模型时立刻清, 避免旧数据残留)
    clearDebugPanel();
    // 立刻显示 loading
    showOverlay('loading');
    setLoadingText('正在准备模型资源…');

    const token = ++loadingToken;

    // 1. 读 IDB
    let data;
    try {
      data = await global.Live2DStorage.getModel(modelId);
    } catch (e) {
      if (token !== loadingToken) return;
      showErrorOverlay('读取模型数据失败: ' + (e.message || String(e)));
      renderDebugPanel(null, null);
      return;
    }
    if (token !== loadingToken) return;
    if (!data) {
      showErrorOverlay('模型在 IDB 中找不到 (id = ' + modelId + ')');
      renderDebugPanel(null, null);
      return;
    }

    // 2. 元数据
    const stats = readModelStats(data);

    // 2.5 扫描 data.files 里的 .motion3.json / .exp3.json, 补到 model3.json 的 FileReferences
    // 原因: 小狼这类 Cubism 模型的 model3.json 经常不写 Motions/Expressions, 只在目录里放 .motion3.json / .exp3.json 文件.
    // 330 uploader 只把 model3.json 写了的字段存进 data.config.refs (空的), 也不会扫文件 —
    // 结果: live model 没加载任何动作/表情, data.config.refs 也没数据, meta panel 0/0.
    // 跟 糯米机 parseLive2DActionsFromModel3Json 的 discovered 行为对齐.
    // 注意: 只改 data.files 里的 blob, 不动 IDB, 不动 loader.
    const rehydratedModel3Json = await rehydrateModel3JsonForMount(data);

    // 2.6 直接读所有 .exp3.json 解析 Parameters 数组, 表情按钮直接用 SDK API
    // 原因: cubism4 0.4.0 fork 加载不声明的 expression 时库不实例化 expressionManager
    // (diagnostic 确认 hasExpressions: false + expressionManager: undefined).
    // 走库 public API m.expression(id) 返 Promise<false>. 抄糯米机 Live2DAvatarCanvas 整套
    // core.setParameterValueById 风格, 跳过库, 直 SDK 改参数.
    await loadExpressionData(data);

    // 3. 挂载 Live2D
    setLoadingText('正在加载 Live2D…');
    let result;
    try {
      result = await global.Live2DLoader.mountLive2DFromIDB(canvasEl, modelId, {});
    } catch (e) {
      if (token !== loadingToken) return;
      // v0.5.0 P1.1: 失败也保留 info+delBtn (user 反馈"加载失败删除按钮也不显示" 真凶)
      const msg = '挂载异常: ' + (e.message || String(e));
      showErrorOverlay(msg);
      showModelErrorInfo(data, msg);  // 渲染元信息 + 错误分类 + 保留 delBtn
      renderDebugPanel(data, rehydratedModel3Json);
      return;
    }
    if (token !== loadingToken) return;
    if (!result || !result.success) {
      // v0.5.0 P1.1: 失败也保留 info+delBtn
      const msg = result && result.error ? (result.error.message || String(result.error)) : '加载失败';
      showErrorOverlay(msg);
      showModelErrorInfo(data, msg);
      renderDebugPanel(null, null);
      return;
    }

    // 4. 成功 → 渲染元数据 + 显示删除按钮
    showOverlay('ready');
    if (infoEl) infoEl.style.display = 'block';
    if (infoNameEl) infoNameEl.textContent = data.name || '未命名模型';
    if (infoMetaEl) {
      infoMetaEl.innerHTML = [
        '<div class="live2d-manager-meta-row"><span class="live2d-manager-meta-label">motions</span><span class="live2d-manager-meta-value">' + stats.motionsCount + '</span></div>',
        '<div class="live2d-manager-meta-row"><span class="live2d-manager-label">expressions</span><span class="live2d-manager-meta-value">' + stats.expressionsCount + '</span></div>',
        '<div class="live2d-manager-meta-row"><span class="live2d-manager-meta-label">textures</span><span class="live2d-manager-meta-value">' + stats.texturesCount + '</span></div>',
        '<div class="live2d-manager-meta-row"><span class="live2d-manager-meta-label">文件大小</span><span class="live2d-manager-meta-value">' + formatBytes(stats.totalSize) + '</span></div>',
        '<div class="live2d-manager-meta-row live2d-manager-meta-path"><span class="live2d-manager-meta-label">路径</span><span class="live2d-manager-meta-value">' + escapeHtml(data.modelPath) + '</span></div>',
      ].join('');
    }
    if (delBtnEl) delBtnEl.style.display = 'block';
    // v0.5.0 P1: 保存 Live2D 实例 + 渲染调试区
    activeModel = result.model;
    // loader 默认居中 (anchor 0.5, 0.5 + x/y = canvas.w/h / 2)
    // 注意: 小狼这种模型的 PIXI bounding box 跟视觉内容不对称, loader 居中后视觉仍可能偏右,
    // 但 getLocalBounds 等方案在 0.4.0 fork 表现未知, 暂不二次干预, 等真实 diagnostic 再定.
    if (result.app && result.app.renderer && result.model) {
      try {
        result.model.anchor.set(0.5, 0.5);
        // v0.5.1: 同 live2d-loader 修正 —— renderer.width/height 是设备像素,
        // 居中必须用 renderer.screen(逻辑像素), 否则 dpr>1 时预览模型偏右下
        result.model.x = result.app.renderer.screen.width / 2;
        result.model.y = result.app.renderer.screen.height / 2;
        // 记下初始 scale, zoomResetBtn 用
        modelBaseScale = (result.model.scale && typeof result.model.scale.x === 'number')
          ? result.model.scale.x
          : 1;
      } catch (e) { /* 居中失败不阻塞 */ }
    }
    // 表情直 SDK: 快照初始参数 + 解析参数索引, 给表情按钮 + reset 用
    try {
      saveInitialParamValues(result.model);
      resolveExpressionParamIndices(result.model);
    } catch (e) { console.warn('[Live2DManager] init expression data failed:', e); }
    renderDebugPanel(data, rehydratedModel3Json);
  }

  // v0.5.0 P1.1: 错误信息分类 (按关键词归类, 让用户一眼知道是 model3.json / 纹理 / IDB / Cubism / Loader 哪一类)
  function classifyLoadError(errMsg) {
    const m = (errMsg || '').toString();
    if (/model3\.json parse failed|model3\.json/i.test(m)) {
      return '❌ model3.json 解析失败 (JSON 格式错, 或文件不存在/被损坏)';
    }
    if (/model not found in IDB/i.test(m)) {
      return '❌ IDB 找不到该模型 (上传未完成 或 IDB 缓存被清)';
    }
    if (/model has no files/i.test(m)) {
      return '❌ 模型无文件 (上传了空模型)';
    }
    if (/IDB read failed/i.test(m)) {
      return '❌ IDB 读取失败 (IndexedDB 损坏, 尝试"数据管理 → 修复 IDB")';
    }
    if (/PIXI\.live2d\.Live2DModel not loaded/i.test(m)) {
      return '❌ Live2DModel 未加载 (pixi-live2d-display cubism4.min.js 没载入)';
    }
    if (/window\.PIXI not loaded/i.test(m)) {
      return '❌ PIXI 未加载 (pixi.min.js 没载入, 检查网络)';
    }
    if (/Cubism|renderOrders|doDrawModel|textures|undefined/i.test(m)) {
      return '❌ Cubism 兼容 / 纹理 异常 (模型可能版本不兼容, 或纹理 PNG 损坏)';
    }
    if (/Failed to fetch|404|NetworkError/i.test(m)) {
      return '❌ 资源加载失败 (网络/CORS/blob URL 过期)';
    }
    return '❌ 挂载失败: ' + m;
  }

  // v0.5.0 P1.1: 加载失败时也显示模型元信息 + 错误 + 保留删除按钮
  // 真凶: 之前 selectModel 失败 return 早走, info + delBtn 永远不显示, 用户无法删失败模型
  function showModelErrorInfo(data, errorMsg) {
    if (infoEl) infoEl.style.display = 'block';
    if (infoNameEl) infoNameEl.textContent = (data && data.name) ? data.name : '未命名模型';
    if (infoMetaEl) {
      const fileCount = (data && data.files && typeof data.files.size === 'number') ? data.files.size : '?';
      const sizeStr = (data && data.files) ? (function () {
        let total = 0;
        try {
          data.files.forEach(b => { if (b && typeof b.size === 'number') total += b.size; });
        } catch (e) {}
        return formatBytes(total);
      })() : '—';
      const modelPath = (data && data.modelPath) ? data.modelPath : '?';
      const errorClassified = classifyLoadError(errorMsg);
      const errorDetail = (errorMsg && errorMsg !== errorClassified) ? '<div class="live2d-manager-meta-row live2d-manager-meta-error"><span class="live2d-manager-meta-label">详细</span><span class="live2d-manager-meta-value">' + escapeHtml(String(errorMsg).substring(0, 200)) + '</span></div>' : '';
      infoMetaEl.innerHTML = [
        '<div class="live2d-manager-meta-row live2d-manager-meta-status-error"><span class="live2d-manager-meta-label">状态</span><span class="live2d-manager-meta-value">' + errorClassified + '</span></div>',
        '<div class="live2d-manager-meta-row"><span class="live2d-manager-meta-label">文件数</span><span class="live2d-manager-meta-value">' + fileCount + '</span></div>',
        '<div class="live2d-manager-meta-row"><span class="live2d-manager-meta-label">大小</span><span class="live2d-manager-meta-value">' + sizeStr + '</span></div>',
        '<div class="live2d-manager-meta-row live2d-manager-meta-path"><span class="live2d-manager-meta-label">路径</span><span class="live2d-manager-meta-value">' + escapeHtml(modelPath) + '</span></div>',
        errorDetail,
      ].join('');
    }
    // delBtn 永远显示 (即使加载失败, 用户也要能删)
    if (delBtnEl) delBtnEl.style.display = 'block';
  }

  function showDeleteConfirm(modelId, modelName) {
    if (!delModalEl) return;
    pendingDelModelId = modelId || '';
    if (delModalDescEl) {
      delModalDescEl.textContent = '确定要删除「' + (modelName || '这个模型') + '」吗？此操作不可撤销';
    }
    delModalEl.style.display = 'flex';
    console.log('[Live2DManager] 弹出删除确认, modelId=', modelId);
  }

  function hideDeleteConfirm() {
    if (delModalEl) delModalEl.style.display = 'none';
    pendingDelModelId = '';
  }

  function showErrorOverlay(msg) {
    showOverlay('error');
    if (errorMsgEl) errorMsgEl.textContent = msg || '加载失败';
  }

  async function deleteModel(modelId) {
    if (!modelId || !global.Live2DStorage) return;
    // v0.5.0 P1.1: 二次确认已走 modal (showDeleteConfirm → delModalConfirmEl.onclick), 不再 confirm()
    let wasBound = false;
    try {
      // 如果是当前 chat 绑定的, 先清掉 per-chat 绑定
      if (currentChat && global.Live2DStorage.getActiveModelIdForChat && global.Live2DStorage.setActiveModelIdForChat) {
        try {
          const cur = await global.Live2DStorage.getActiveModelIdForChat(currentChat.id);
          if (cur === modelId) {
            await global.Live2DStorage.setActiveModelIdForChat(currentChat.id, '');
            wasBound = true;
          }
        } catch (e) { /* 检查绑定失败不阻塞删除 */ }
      }
      await global.Live2DStorage.deleteModel(modelId);
    } catch (e) {
      alert('删除失败: ' + (e.message || String(e)));
      return;
    }
    // 清掉预览 (如果是当前选中的)
    if (activeModelId === modelId) {
      disposeCurrentPreview();
      activeModelId = null;
      showOverlay('idle');
      if (infoEl) infoEl.style.display = 'none';
      if (delBtnEl) delBtnEl.style.display = 'none';
      clearDebugPanel();
    }
    await renderList();
    // 让准备页刷新 (如果删了绑定的模型, 准备页 model-preview 要变 "尚未绑定动态模型")
    if (wasBound && currentChat && global.Live2DCallPrep && typeof global.Live2DCallPrep.render === 'function') {
      try { global.Live2DCallPrep.render(currentChat); } catch (e) { console.warn('[Live2DManager] refresh call-prep failed:', e); }
    }
  }

  function open(chat, onClose) {
    init();
    currentChat = chat || null;
    onCloseCallback = onClose || null;
    // 防御性: 清掉 close() 留下的 inline display, 防止任何残留的 display:none 覆盖 .screen.active
    if (screenEl) screenEl.style.display = '';
    if (global.showScreen) {
      global.showScreen('live2d-manager-screen');
    } else if (screenEl) {
      screenEl.style.display = 'block';
    }
    // 重置状态
    currentExpression = '';   // v0.5.0 P2.4: 重新打开时清掉上次选择
    if (confirmBtnEl) {
      confirmBtnEl.classList.remove('live2d-manager-confirm-btn-saved');
      const textEl = confirmBtnEl.querySelector('.live2d-manager-confirm-btn-text');
      if (textEl) textEl.textContent = '使用此形象进入视频通话';
    }
    if (confirmHintEl) {
      confirmHintEl.classList.remove('live2d-manager-confirm-hint-error', 'live2d-manager-confirm-hint-success');
      confirmHintEl.textContent = '将当前形象设为视频通话默认状态，AI 可在通话中根据对话实时调整';
    }
    showOverlay('idle');
    if (infoEl) infoEl.style.display = 'none';
    if (delBtnEl) delBtnEl.style.display = 'none';
    clearDebugPanel();
    renderList();
  }

  function close() {
    // 完整 dispose, 不残留 PIXI / Live2D / blob URL
    disposeCurrentPreview();
    activeModelId = null;
    loadingToken++;  // 取消所有进行中的加载
    // 返回准备页
    if (global.showScreen) {
      global.showScreen('live2d-call-prep-screen');
    }
    if (screenEl) screenEl.style.display = 'none';
    clearDebugPanel();
    const cb = onCloseCallback;
    currentChat = null;
    onCloseCallback = null;
    if (typeof cb === 'function') {
      try { cb(); } catch (e) { console.warn('[Live2DManager] onClose error:', e); }
    }
  }

  // v0.5.0 P2.4: 收集当前调试台状态 → 存到 Live2DStorage.videoCallAppearance[chatId] → close() 回到准备页
  // 核心原则: 这里存的"默认起始状态"是用户确认的, AI 在视频通话运行中改的 expression / 动作
  // 是"运行时状态", 后续 video-voice-call 挂载时读这个 appearance, 但 AI 改完 expression 不要反向写这个对象.
  // 数据结构 (Live2DStorage.setVideoCallAppearance 会自动加 updatedAt):
  //   {
  //     modelId,         // 当前调试台预览的 modelId
  //     modelPath,       // model3.json 在 IDB record 里的相对路径
  //     scale,           // activeModel.scale.x, PIXI 缩放 (绝对)
  //     positionX,       // activeModel.x, PIXI 坐标相对 canvas
  //     positionY,       // activeModel.y
  //     defaultExpression // 用户最后选的表情 (.exp3.json basename, '' = 不设 / 恢复默认)
  //   }
  async function saveAndGoToPrep() {
    if (!currentChat) {
      console.warn('[Live2DManager] saveAndGoToPrep: 没有 currentChat (从准备页进入才会传)');
      return;
    }
    if (!activeModelId) {
      console.warn('[Live2DManager] saveAndGoToPrep: 没有选中模型, 按钮不该可点');
      return;
    }
    if (!global.Live2DStorage || typeof global.Live2DStorage.setVideoCallAppearance !== 'function') {
      console.warn('[Live2DManager] saveAndGoToPrep: Live2DStorage.setVideoCallAppearance 不可用');
      return;
    }
    // 1. 拿 modelPath (从 IDB 读一次; 这个量很轻, 用户点按钮一次)
    let modelPath = '';
    try {
      const rec = await global.Live2DStorage.getModel(activeModelId);
      if (rec) modelPath = rec.modelPath || '';
    } catch (e) {
      console.warn('[Live2DManager] saveAndGoToPrep: getModel 拿 modelPath 失败, 继续 (不阻塞保存):', e);
    }
    // 2. 收集模型显示状态 (从 activeModel PIXI 实例读; activeModel 可能因为加载失败为 null, 兜底)
    let scale = 1, positionX = 0, positionY = 0;
    if (activeModel) {
      try {
        if (activeModel.scale && typeof activeModel.scale.x === 'number') scale = activeModel.scale.x;
      } catch (e) { /* ignore */ }
      try { positionX = activeModel.x; } catch (e) { positionX = 0; }
      try { positionY = activeModel.y; } catch (e) { positionY = 0; }
    }
    // 3. 构造 appearance 并存到 localStorage (per-chat)
    //    注意: 复用现有 setActiveModelIdForChat 让 per-chat 模型绑定跟 appearance 的 modelId 对齐
    //    (现有 call-prep.render 读 activeModelIdForChat 显示"已绑定·xxx" 文字)
    const appearance = {
      modelId: activeModelId,
      modelPath: modelPath,
      scale: scale,
      positionX: positionX,
      positionY: positionY,
      defaultExpression: currentExpression || '',
    };
    let saved = false;
    try {
      saved = await global.Live2DStorage.setVideoCallAppearance(currentChat.id, appearance);
    } catch (e) {
      console.warn('[Live2DManager] saveAndGoToPrep: setVideoCallAppearance 失败:', e);
    }
    if (!saved) {
      if (confirmHintEl) {
        confirmHintEl.textContent = '保存失败, 请重试';
        confirmHintEl.classList.add('live2d-manager-confirm-hint-error');
      }
      return;
    }
    // 4. 顺手把 per-chat 模型绑定也指向当前 (复用现有 storage 行为, 不破坏)
    try {
      if (global.Live2DStorage.setActiveModelIdForChat) {
        await global.Live2DStorage.setActiveModelIdForChat(currentChat.id, activeModelId);
      }
    } catch (e) { /* 绑定失败不阻塞 */ }
    console.log('[Live2DManager] 已保存视频通话默认形象:', appearance);
    // 5. 视觉反馈 (短暂变"已保存" → 然后 close)
    if (confirmBtnEl) {
      confirmBtnEl.classList.add('live2d-manager-confirm-btn-saved');
      const textEl = confirmBtnEl.querySelector('.live2d-manager-confirm-btn-text');
      if (textEl) textEl.textContent = '已保存默认形象';
    }
    if (confirmHintEl) {
      confirmHintEl.textContent = '已确认, 正在返回准备页…';
      confirmHintEl.classList.add('live2d-manager-confirm-hint-success');
    }
    // 6. 走 close() → showScreen('live2d-call-prep-screen') + onCloseCallback → Live2DCallPrep.render(chat)
    //    准备页 render 读 appearance 显示"已设默认形象" badge, 用户看到状态闭环
    setTimeout(function () {
      try { close(); } catch (e) { console.warn('[Live2DManager] close after save failed:', e); }
    }, 280);
  }

  // ===== v0.5.0 P1: 动作/表情调试区 =====

  // 从当前 Live2D model 实例读 motion 列表
  // 候选路径按 pixi-live2d-display 各版本/分支常见字段名排列, 找到第一个非空就返回
  // 0.4.0 cubism4 分支: internalModel.motionManager.motionGroups
  function readMotionsFromModel(model) {
    if (!model) return [];
    const im = model.internalModel || model;
    const sources = [
      im.motionManager && im.motionManager.motionGroups,
      im.settings && im.settings.motionGroups,
      im.motionManager && im.motionManager.definitions,
      im.motionManager && im.motionManager.groups,
    ];
    for (const src of sources) {
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        const out = [];
        for (const groupName of Object.keys(src)) {
          const list = src[groupName];
          if (Array.isArray(list)) {
            list.forEach((m, i) => {
              const name = (m && (m.Name || m.name)) || (groupName + '-' + i);
              out.push({ group: groupName, index: i, name: name });
            });
          }
        }
        if (out.length > 0) return out;
      }
    }
    return [];
  }

  // 从当前 Live2D model 实例读 expression 列表
  function readExpressionsFromModel(model) {
    if (!model) return [];
    const im = model.internalModel || model;
    const sources = [
      im.expressionManager && im.expressionManager.definitions,
      im.settings && im.settings.expressions,
      im.expressionManager && im.expressionManager.expressions,
    ];
    for (const src of sources) {
      if (Array.isArray(src) && src.length > 0) {
        return src.map((e, i) => {
          const name = (e && (e.Name || e.name)) || ('expression-' + i);
          return { id: name, name: name };
        });
      }
    }
    return [];
  }

  // Fallback: 从 IDB record 的 data.config.refs 读 (uploader 上传时已抽出来的引用)
  // 不解析原始 model3.json, 复用现有 data.config 形状, 跟 readModelStats 保持一致
  function readMotionsFromData(data) {
    if (!data || !data.config || !data.config.refs) return [];
    const motions = data.config.refs.Motions;
    if (!motions || typeof motions !== 'object') return [];
    const out = [];
    for (const groupName of Object.keys(motions)) {
      const list = motions[groupName];
      if (Array.isArray(list)) {
        list.forEach((m, i) => {
          const name = (m && (m.Name || m.name)) || (groupName + '-' + i);
          out.push({ group: groupName, index: i, name: name });
        });
      }
    }
    return out;
  }

  function readExpressionsFromData(data) {
    if (!data || !data.config || !data.config.refs) return [];
    const expressions = data.config.refs.Expressions;
    if (!Array.isArray(expressions)) return [];
    return expressions.map((e, i) => {
      const name = (e && (e.Name || e.name)) || ('expression-' + i);
      return { id: name, name: name };
    });
  }

  // Fallback 2: 直接读 data.files 里的 model3.json (canonical source)
  // 实测发现 data.config.refs 在某些已上传模型里是空对象 (可能是早期版本 uploader 写的)
  // meta panel 的 motions 0 / expressions 0 证明 readModelStats 也读不到 — 根因不在读取路径
  // 跟 糯米机 parseLive2DActionsFromModel3Json 一样, 直接从 model3.json 的 FileReferences 拿
  // 优先用项目自己的 Live2DConfig.parseModel3Json (data shape 跟糯米对齐), 失败时回退到原始 JSON
  function readActionsFromModel3Json(model3Json, data) {
    if (!model3Json) return { motions: [], expressions: [] };
    let config = null;
    try {
      if (global.Live2DConfig && typeof global.Live2DConfig.parseModel3Json === 'function') {
        config = global.Live2DConfig.parseModel3Json(model3Json, data && data.modelPath);
      }
    } catch (e) {
      console.warn('[Live2DManager] parseModel3Json failed:', e);
    }
    // 退路: Live2DConfig 不可用或抛错, 直接读 model3Json.FileReferences
    if (!config || !Array.isArray(config.actions)) {
      const refs = (model3Json.FileReferences || model3Json.fileReferences) || {};
      const motions = [];
      const expressions = [];
      if (refs.Motions && typeof refs.Motions === 'object') {
        for (const groupName of Object.keys(refs.Motions)) {
          const list = refs.Motions[groupName];
          if (Array.isArray(list)) {
            list.forEach((m, i) => {
              const name = (m && (m.Name || m.name)) || (groupName + '-' + i);
              motions.push({ group: groupName, index: i, name: name });
            });
          }
        }
      }
      if (Array.isArray(refs.Expressions)) {
        refs.Expressions.forEach((e, i) => {
          const name = (e && (e.Name || e.name)) || ('expression-' + i);
          expressions.push({ id: name, name: name });
        });
      }
      return { motions, expressions };
    }
    // 用 Live2DConfig.parseModel3Json 返回的 actions 数组, 按 kind 拆开
    const motions = [];
    const expressions = [];
    config.actions.forEach(a => {
      if (a.kind === 'motion' && a.group != null && a.index != null) {
        motions.push({ group: a.group, index: a.index, name: a.name || (a.group + '-' + a.index) });
      } else if (a.kind === 'expression' && a.expressionId) {
        expressions.push({ id: a.expressionId, name: a.name || a.expressionId });
      }
    });
    return { motions, expressions };
  }

  // 隐藏整个调试区 + 清空按钮, 用于"还没选模型"或"切模型时立刻清旧数据"
  function clearDebugPanel() {
    if (motionsEl) {
      motionsEl.innerHTML = '';
      motionsEl.style.display = 'none';
    }
    if (expressionsEl) {
      expressionsEl.innerHTML = '';
      expressionsEl.style.display = 'none';
    }
    if (motionsEmptyEl) motionsEmptyEl.style.display = 'none';
    if (expressionsEmptyEl) expressionsEmptyEl.style.display = 'none';
    if (debugSectionEl) debugSectionEl.style.display = 'none';
  }

  // 渲染调试区: data=null 时两区域显示"暂无可用..."空状态 (按 spec: 加载失败时显示空状态)
  // 三路 fallback (按优先级):
  //   1. live model.internalModel (最准, 但 0.4.0 cubism4 字段名可能不一致)
  //   2. IDB record 的 data.config.refs (uploader 上传时抽出来的引用)
  //   3. 直接从 data.files 读 model3.json 解析 (canonical source, 兜底)
  function renderDebugPanel(data, model3Json) {
    if (!debugSectionEl || !motionsEl || !expressionsEl) return;

    // 1. 优先从 live model 读
    let motions = readMotionsFromModel(activeModel);
    let expressions = readExpressionsFromModel(activeModel);

    // 2. Fallback: 从 IDB data.config.refs 读
    if (motions.length === 0 && data) {
      motions = readMotionsFromData(data);
    }
    if (expressions.length === 0 && data) {
      expressions = readExpressionsFromData(data);
    }

    // 3. Fallback 2: 从 model3.json 解析 (canonical, 前两路都拿不到时用)
    if ((motions.length === 0 || expressions.length === 0) && model3Json) {
      const parsed = readActionsFromModel3Json(model3Json, data);
      if (motions.length === 0) motions = parsed.motions;
      if (expressions.length === 0) expressions = parsed.expressions;
    }

    // 2. 渲染动作按钮
    if (motions.length === 0) {
      motionsEl.innerHTML = '';
      motionsEl.style.display = 'none';
      if (motionsEmptyEl) motionsEmptyEl.style.display = 'block';
    } else {
      motionsEl.style.display = 'flex';
      if (motionsEmptyEl) motionsEmptyEl.style.display = 'none';
      motionsEl.innerHTML = motions.map(m => {
        return '<button type="button" class="live2d-manager-debug-btn" ' +
          'data-action="motion" ' +
          'data-group="' + escapeHtml(m.group) + '" ' +
          'data-index="' + m.index + '" ' +
          'title="' + escapeHtml(m.group) + ' · ' + escapeHtml(m.name) + '">' +
          escapeHtml(m.name) + '</button>';
      }).join('');
    }

    // 3. 渲染表情按钮 (末尾追加"恢复默认"按钮)
    if (expressions.length === 0) {
      expressionsEl.innerHTML = '';
      expressionsEl.style.display = 'none';
      if (expressionsEmptyEl) expressionsEmptyEl.style.display = 'block';
    } else {
      expressionsEl.style.display = 'flex';
      if (expressionsEmptyEl) expressionsEmptyEl.style.display = 'none';
      let html = expressions.map(e => {
        // v0.5.0 P1.5: 表情按钮 label 显示 "中文名 (英文id)" 让 user 看得懂, AI 仍用 e.id (英文) 触发
        // 表情 id 本身就是中文时 (cn === name), 别拼成 "闭眼 闭眼" —— 同一个名字只显示一次。
        const cn = EXPRESSION_CN_LABELS[e.id] || '';
        const label = (cn && cn !== e.name) ? (cn + ' ' + e.name) : (cn || e.name);
        return '<button type="button" class="live2d-manager-debug-btn" ' +
          'data-action="expression" ' +
          'data-id="' + escapeHtml(e.id) + '" ' +
          'title="' + escapeHtml(e.name) + '">' +
          escapeHtml(label) + '</button>';
      }).join('');
      // 恢复默认表情按钮: 调用 Live2DLoader.setExpression(canvasEl, '')
      html += '<button type="button" class="live2d-manager-debug-btn live2d-manager-debug-reset" ' +
        'data-action="expression-reset" title="恢复默认表情">↺ 默认</button>';
      expressionsEl.innerHTML = html;
    }

    // 4. 调试区整体显示 (即使两个都空, 也显示空状态文字)
    debugSectionEl.style.display = 'block';
  }

  // ===== v0.5.0 P1+ 第二阶段: discovered motions/expressions 兜底 =====

  // 扫描 data.files 里的 .motion3.json / .exp3.json 文件, 把没在 model3.json 里声明的
  // 动作/表情补进 FileReferences.Motions / FileReferences.Expressions.
  // 跟 糯米机 parseLive2DActionsFromModel3Json 的 discovered 行为对齐.
  // 只改 data.files 里的 model3.json blob (新 blob 替换), 不动 IDB, 不动 loader.
  // loader 后续 mountLive2DFromIDB() 会读 data.files.get(data.modelPath), 拿到的是改写后的 model3.json.
  async function rehydrateModel3JsonForMount(data) {
    if (!data || !data.files || !data.modelPath) return null;
    const blob = data.files.get(data.modelPath);
    if (!blob || typeof blob.text !== 'function') return null;

    let modelJson;
    try {
      modelJson = JSON.parse(await blob.text());
    } catch (e) {
      console.warn('[Live2DManager] parse model3.json (rehydrate) failed:', e);
      return null;
    }
    if (!modelJson.FileReferences && !modelJson.fileReferences) {
      modelJson.FileReferences = {};
    }
    const refs = (modelJson.FileReferences || modelJson.fileReferences) || {};
    refs.Expressions = Array.isArray(refs.Expressions) ? refs.Expressions : [];
    refs.Motions = (refs.Motions && typeof refs.Motions === 'object') ? refs.Motions : {};

    const modelPath = data.modelPath;
    const baseDir = modelPath.substring(0, modelPath.lastIndexOf('/') + 1);

    const discoveredMotions = [];
    const discoveredExpressions = [];
    for (const filePath of data.files.keys()) {
      const lower = filePath.toLowerCase();
      if (lower.endsWith('.motion3.json')) {
        const extIdx = lower.lastIndexOf('.motion3.json');
        const basename = filePath.substring(filePath.lastIndexOf('/') + 1, extIdx);
        const relativePath = filePath.startsWith(baseDir) ? filePath.substring(baseDir.length) : filePath;
        const group = /idle|standby|loop|循环|待机/i.test(basename) ? 'Idle' : 'Imported';
        discoveredMotions.push({ group: group, file: relativePath, name: basename });
      } else if (lower.endsWith('.exp3.json')) {
        const extIdx = lower.lastIndexOf('.exp3.json');
        const basename = filePath.substring(filePath.lastIndexOf('/') + 1, extIdx);
        const relativePath = filePath.startsWith(baseDir) ? filePath.substring(baseDir.length) : filePath;
        discoveredExpressions.push({ file: relativePath, name: basename });
      }
    }

    let changed = false;
    for (const m of discoveredMotions) {
      if (!refs.Motions[m.group]) refs.Motions[m.group] = [];
      const exists = refs.Motions[m.group].some(x => x.File === m.file);
      if (!exists) {
        refs.Motions[m.group].push({ Name: m.name, File: m.file });
        changed = true;
      }
    }
    for (const e of discoveredExpressions) {
      const exists = refs.Expressions.some(x => x.File === e.file);
      if (!exists) {
        refs.Expressions.push({ Name: e.name, File: e.file });
        changed = true;
      }
    }

    if (changed) {
      // 写回 data.files (新 blob 替换, 不污染 IDB)
      const newBlob = new Blob([JSON.stringify(modelJson)], { type: 'application/json' });
      data.files.set(modelPath, newBlob);
    }
    return modelJson;
  }

  // 算 Live2D 模型的 drawables 真实视觉中心 (canvas 坐标, 相对 canvas 原点).
  // loader 用的 anchor(0.5,0.5) 是 PIXI bounding box 中心, 跟视觉中心不一致 (小狼 drawables 都在右半边).
  // 用这个 visualCenter 修正 model.x / model.y, 让视觉内容真正居中.
  // 返回 {x, y} 偏移量, model.x -= visualCenter.x; model.y -= visualCenter.y
  function computeLive2DVisualCenter(model) {
    if (!model) return null;
    try {
      const im = model.internalModel;
      const raw = im && im.coreModel;
      // 0.4.0 cubism4 fork 的 drawables 路径: im.coreModel._model.drawables (跟 loader.js:77 同源)
      const coreModel = raw && (raw._model || raw);
      const drawables = coreModel && coreModel.drawables;
      if (!drawables || typeof drawables.getDrawable !== 'function') return null;
      const count = drawables.getCount ? drawables.getCount() : (drawables.count || 0);
      if (count <= 0) return null;
      // 每个 drawable 的 vertices: drawable.getVertexPositions() 返 Float32Array
      // 或者 drawable.vertices.pos (Cubism 4 SDK API)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let touched = false;
      for (let i = 0; i < count; i++) {
        let d = null;
        try { d = drawables.getDrawable(i); } catch (e) { continue; }
        if (!d) continue;
        let verts = null;
        try {
          // Cubism 4 SDK: drawable.vertexPositionions 是 TypedArray
          if (d.vertexPositionions && d.vertexPositionions.length) verts = d.vertexPositionions;
          else if (d.getVertexPositions) verts = d.getVertexPositions();
          else if (d.vertices && d.vertices.pos) verts = d.vertices.pos;
        } catch (e) { /* skip this drawable */ }
        if (!verts || verts.length < 2) continue;
        // 顶点是 (x, y) 交错数组
        for (let j = 0; j + 1 < verts.length; j += 2) {
          const vx = verts[j], vy = verts[j + 1];
          if (vx < minX) minX = vx;
          if (vx > maxX) maxX = vx;
          if (vy < minY) minY = vy;
          if (vy > maxY) maxY = vy;
          touched = true;
        }
      }
      if (!touched) return null;
      // 视觉中心 (canvas 坐标, 相对 canvas 原点). 单位是 canvas pixel (跟 model.width / model.height 同尺度).
      // 跟 model 的 position/scale 转换: model.x = canvas.w/2 - visualCenter.x * scale
      // 但更简单: 直接减, 因为 PIXI 的 anchor 已经把 (0.5, 0.5) 放在 model.x, 视觉中心相对 canvas 原点的偏移
      // 真实转换: model.x = canvas.w/2 - (visualCenter.x - canvasW/2) = canvas.w - visualCenter.x
      // 但 model.x = canvas.w/2 已经被 loader 居中, 视觉内容相对 canvas 中心的偏移 = visualCenter.x - canvasW/2
      // 所以修正量 = visualCenter.x - canvasW/2 (这个偏移 model 要向左移 = 减)
      const canvasW = coreModel.getCanvasWidth ? coreModel.getCanvasWidth() : (coreModel._model && coreModel._model.getCanvasWidth ? coreModel._model.getCanvasWidth() : model.width);
      const canvasH = coreModel.getCanvasHeight ? coreModel.getCanvasHeight() : (coreModel._model && coreModel._model.getCanvasHeight ? coreModel._model.getCanvasHeight() : model.height);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      // 视觉中心相对 canvas 中心的偏移
      const offsetX = cx - canvasW / 2;
      const offsetY = cy - canvasH / 2;
      return { x: offsetX, y: offsetY };
    } catch (e) {
      console.warn('[Live2DManager] computeLive2DVisualCenter failed:', e);
      return null;
    }
  }

  // ===== v0.5.0 P1+ 第二阶段: discovered motions/expressions 兜底 (rehydrateModel3JsonForMount) =====
  // 之前 P1 还引入了直接参数 API 套件 (loadExpressionData / applyExpressionToModel / resetExpressionParams
  // / getLive2DCoreModel / saveInitialParamValues / resolveExpressionParamIndices), 全部回退.
  // 原因: 没有真实 diagnostic 就改这套, getLocalBounds 居中把模型推到画布外, 整体回退到 loader 默认行为.
  // 下一轮先拿 diagnostic (公共 API / 库 expressionManager 真实状态 / FileReferences 真实形状), 再定方案.

  // ===== v0.5.0 P1+ 表情直 SDK 改参数 (抄糯米机 Live2DAvatarCanvas 整套) =====

  // 解析所有 .exp3.json 存到 expressionData
  // name (basename 去 .exp3.json) -> {file, params: [{id, value, blend, index}]}
  async function loadExpressionData(data) {
    expressionData = {};
    if (!data || !data.files) return;
    for (const [filePath, blob] of data.files.entries()) {
      const lower = filePath.toLowerCase();
      if (!lower.endsWith('.exp3.json')) continue;
      const extIdx = lower.lastIndexOf('.exp3.json');
      const basename = filePath.substring(filePath.lastIndexOf('/') + 1, extIdx);
      try {
        const txt = await blob.text();
        const expJson = JSON.parse(txt);
        const params = Array.isArray(expJson.Parameters) ? expJson.Parameters : [];
        expressionData[basename] = {
          file: filePath,
          params: params.map(p => ({
            id: p.Id,
            value: typeof p.Value === 'number' ? p.Value : 0,
            blend: p.Blend || 'Overwrite',
            index: -1, // 后面 resolveExpressionParamIndices 查
          })),
        };
      } catch (e) {
        console.warn('[Live2DManager] parse exp3.json failed:', filePath, e);
      }
    }
  }

  // 拿 CubismModel (有 getParameterCount / setParameterValueByIndex / getParameterIndex SDK 方法)
  // diagnostic 确认 model.internalModel.coreModel 是正确路径
  function getLive2DCoreModel(model) {
    if (!model || !model.internalModel) return null;
    return model.internalModel.coreModel
      || model.internalModel._model
      || (model.internalModel.coreModel && model.internalModel.coreModel._model)
      || null;
  }

  // 把 expressionData 里所有 param 的 id 解析成 coreModel 索引
  function resolveExpressionParamIndices(model) {
    const core = getLive2DCoreModel(model);
    if (!core || typeof core.getParameterIndex !== 'function') return;
    for (const name in expressionData) {
      const ed = expressionData[name];
      for (const p of ed.params) {
        try {
          p.index = core.getParameterIndex(p.id);
        } catch (e) {
          p.index = -1;
        }
      }
    }
  }

  // 挂载成功时快照所有 parameter 初始值, 给 reset 用
  function saveInitialParamValues(model) {
    const core = getLive2DCoreModel(model);
    if (!core) { initialParamValues = null; return; }
    initialParamValues = new Map();
    if (typeof core.getParameterCount !== 'function' || typeof core.getParameterValueByIndex !== 'function') {
      initialParamValues = null;
      return;
    }
    const count = core.getParameterCount();
    for (let i = 0; i < count; i++) {
      try {
        initialParamValues.set(i, core.getParameterValueByIndex(i));
      } catch (e) { /* skip */ }
    }
  }

  // 直接对 model 应用 expression 的参数 (抄糯米机 smooth 写法简化版)
  // Overwrite: 直接 setParameterValueByIndex(index, value)
  // Add: current + value, set
  // Multiply: current * value, set
  function applyExpressionToModel(model, name) {
    const ed = expressionData && expressionData[name];
    if (!ed || !ed.params || !ed.params.length) return false;
    const core = getLive2DCoreModel(model);
    if (!core || typeof core.setParameterValueByIndex !== 'function') return false;
    let applied = 0;
    for (const p of ed.params) {
      if (typeof p.index !== 'number' || p.index < 0) continue;
      try {
        let newValue = p.value;
        if (p.blend === 'Add' && typeof core.getParameterValueByIndex === 'function') {
          newValue = core.getParameterValueByIndex(p.index) + p.value;
        } else if (p.blend === 'Multiply' && typeof core.getParameterValueByIndex === 'function') {
          newValue = core.getParameterValueByIndex(p.index) * p.value;
        }
        core.setParameterValueByIndex(p.index, newValue);
        applied++;
      } catch (e) { /* skip this param */ }
    }
    return applied > 0;
  }

  // 还原所有 parameter 到挂载时的初始值
  function resetExpressionParams(model) {
    if (!initialParamValues || initialParamValues.size === 0) return false;
    const core = getLive2DCoreModel(model);
    if (!core || typeof core.setParameterValueByIndex !== 'function') return false;
    let applied = 0;
    for (const [index, value] of initialParamValues) {
      try {
        core.setParameterValueByIndex(index, value);
        applied++;
      } catch (e) { /* skip */ }
    }
    return applied > 0;
  }

  global.Live2DManager = {
    init,
    open,
    close,
    // v0.5.2: 把「表情 ID → 中文名」映射一并导出。
    // 视频通话页要用它给 AI 看"人话版"表情清单 —— 只喂英文 id (cry / cat_paw_up)
    // AI 看不出该在什么场合用哪个, 结果就是干脆不写表情指令。
    EXPRESSION_CN_LABELS,
  };
})(typeof window !== 'undefined' ? window : globalThis);

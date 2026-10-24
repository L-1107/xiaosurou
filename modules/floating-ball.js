// ============================================================
// floating-ball.js - 悬浮球核心逻辑
// ============================================================

(function() {
  'use strict';

  // 悬浮球状态
  let floatingBallState = {
    enabled: false,     // 总开关（默认关闭）
    visible: true,      // 当前是否可见
    position: { x: 20, y: 100 },  // 位置
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    menuOpen: false,
    submenuOpen: false,
    // 样式配置
    style: {
      type: 'default', // 'default', 'image', 'custom-css'
      imageUrl: '',
      customHTML: '',
      customCSS: ''
    }
  };

  // 三击唤起相关
  let tapCount = 0;
  let tapTimer = null;

  // DOM 元素
  let ballEl = null;
  let menuEl = null;
  let submenuEl = null;

  // 初始化
  function initFloatingBall() {
    // 从全局设置和 localStorage 读取状态
    loadState();

    // 如果未启用，直接返回
    if (!floatingBallState.enabled) {
      console.log('悬浮球未启用');
      return;
    }

    // 创建 DOM
    createFloatingBallDOM();

    // 绑定事件
    bindEvents();

    // 显示悬浮球
    if (floatingBallState.visible) {
      showBall();
    } else {
      // 隐藏状态，监听三击
      enableTripleTap();
    }
  }

  // 加载状态
  function loadState() {
    // 优先从 state.globalSettings 读取总开关
    if (typeof state !== 'undefined' && state.globalSettings) {
      floatingBallState.enabled = state.globalSettings.floatingBallEnabled === true;
    }
    
    // 从 localStorage 读取位置和可见性
    const saved = localStorage.getItem('floating-ball-state');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // 只读取位置和可见性，不读取 enabled（由全局设置控制）
        if (parsed.position) floatingBallState.position = parsed.position;
        if (parsed.visible !== undefined) floatingBallState.visible = parsed.visible;
        if (parsed.style) floatingBallState.style = { ...floatingBallState.style, ...parsed.style };
      } catch (e) {
        console.error('Failed to parse floating ball state:', e);
      }
    }
  }

  // 保存状态
  function saveState() {
    // 只保存位置和可见性到 localStorage
    // enabled 由 state.globalSettings 管理
    const stateToSave = {
      position: floatingBallState.position,
      visible: floatingBallState.visible,
      style: floatingBallState.style
    };
    localStorage.setItem('floating-ball-state', JSON.stringify(stateToSave));
  }

  // 创建 DOM
  function createFloatingBallDOM() {
    // 悬浮球
    ballEl = document.createElement('div');
    ballEl.id = 'floating-ball';
    ballEl.className = floatingBallState.visible ? '' : 'hidden';
    
    // 根据样式类型设置内容
    if (floatingBallState.style.type === 'image' && floatingBallState.style.imageUrl) {
      ballEl.innerHTML = `<img src="${floatingBallState.style.imageUrl}" alt="悬浮球" class="fb-custom-image">`;
    } else if (floatingBallState.style.type === 'custom-css' && floatingBallState.style.customHTML) {
      ballEl.innerHTML = floatingBallState.style.customHTML;
    } else {
      ballEl.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="4" y1="6" x2="20" y2="6"></line>
          <line x1="4" y1="12" x2="20" y2="12"></line>
          <line x1="4" y1="18" x2="20" y2="18"></line>
        </svg>
      `;
    }
    
    ballEl.style.left = floatingBallState.position.x + 'px';
    ballEl.style.top = floatingBallState.position.y + 'px';
    
    // 应用自定义CSS
    if (floatingBallState.style.type === 'custom-css' && floatingBallState.style.customCSS) {
      applyCustomCSS(floatingBallState.style.customCSS);
    }
    
    document.body.appendChild(ballEl);

    // 菜单
    menuEl = document.createElement('div');
    menuEl.id = 'floating-ball-menu';
    menuEl.innerHTML = `
      <div class="fb-menu-item" data-action="clear-chat-images">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
          <line x1="4" y1="4" x2="20" y2="20"></line>
        </svg>
        <span>清空聊天图片</span>
      </div>
      <div class="fb-menu-item" data-action="compress-images">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 14 10 14 10 20"></polyline>
          <polyline points="20 10 14 10 14 4"></polyline>
          <line x1="14" y1="10" x2="21" y2="3"></line>
          <line x1="3" y1="21" x2="10" y2="14"></line>
        </svg>
        <span>图片压缩</span>
      </div>
      <div class="fb-menu-item" data-action="clear-chat-history">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        <span>清理聊天记录</span>
      </div>
      <div class="fb-menu-divider"></div>
      <div class="fb-menu-item" data-action="switch-api">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
        <span>切换API预设</span>
      </div>
      <div class="fb-menu-item" data-action="apply-template">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <span>应用设置模板</span>
      </div>
      <div class="fb-menu-item" data-action="role-api">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M12 1v6m0 6v6m5.2-13.2l-4.2 4.2m0 6l4.2 4.2M23 12h-6m-6 0H1m18.2 5.2l-4.2-4.2m0-6l4.2-4.2"></path>
        </svg>
        <span>角色API配置</span>
      </div>
      <div class="fb-menu-item" data-action="style-settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path>
        </svg>
        <span>样式设置</span>
      </div>
      <div class="fb-menu-item" data-action="manage-ai-songs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <span>AI 原创曲管理</span>
      </div>
      <div class="fb-menu-item" data-action="pet-nest">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="16.4" rx="4.7" ry="3.7"></ellipse>
          <ellipse cx="5.6" cy="11.2" rx="2.1" ry="2.6"></ellipse>
          <ellipse cx="9.9" cy="7.3" rx="2.1" ry="2.6"></ellipse>
          <ellipse cx="14.5" cy="7.3" rx="2.1" ry="2.6"></ellipse>
          <ellipse cx="18.8" cy="11.2" rx="2.1" ry="2.6"></ellipse>
        </svg>
        <span>宠物屋</span>
      </div>
      <div class="fb-menu-item" data-action="toggle-desktop-pet">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"></path>
          <path d="M4 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"></path>
          <path d="M20 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"></path>
          <path d="M7.5 15.5c1.2 3.4 2.6 5 4.5 5s3.3-1.6 4.5-5"></path>
        </svg>
        <span id="fb-desktop-pet-label">桌宠</span>
      </div>
      <div class="fb-menu-divider"></div>
      <div class="fb-menu-item" data-action="hide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
          <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>
        <span>隐藏悬浮球</span>
      </div>
      <div class="fb-menu-item danger" data-action="close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
        <span>关闭悬浮球</span>
      </div>
    `;
    document.body.appendChild(menuEl);

    // 子菜单
    submenuEl = document.createElement('div');
    submenuEl.id = 'floating-ball-submenu';
    document.body.appendChild(submenuEl);
  }

  // 绑定事件
  function bindEvents() {
    // 悬浮球拖动
    let longPressTimer = null;
    let hasMoved = false;

    ballEl.addEventListener('mousedown', handleMouseDown);
    ballEl.addEventListener('touchstart', handleTouchStart, { passive: false });

    function handleMouseDown(e) {
      e.preventDefault();
      hasMoved = false;
      
      longPressTimer = setTimeout(() => {
        startDrag(e.clientX, e.clientY);
      }, 200);

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    function handleTouchStart(e) {
      e.preventDefault();
      hasMoved = false;
      const touch = e.touches[0];
      
      longPressTimer = setTimeout(() => {
        startDrag(touch.clientX, touch.clientY);
      }, 200);

      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd);
    }

    function startDrag(x, y) {
      floatingBallState.isDragging = true;
      floatingBallState.dragStart = {
        x: x - floatingBallState.position.x,
        y: y - floatingBallState.position.y
      };
      ballEl.classList.add('dragging');
    }

    function handleMouseMove(e) {
      if (floatingBallState.isDragging) {
        hasMoved = true;
        moveBall(e.clientX, e.clientY);
      }
    }

    function handleTouchMove(e) {
      if (floatingBallState.isDragging) {
        e.preventDefault();
        hasMoved = true;
        const touch = e.touches[0];
        moveBall(touch.clientX, touch.clientY);
      }
    }

    function moveBall(x, y) {
      floatingBallState.position.x = x - floatingBallState.dragStart.x;
      floatingBallState.position.y = y - floatingBallState.dragStart.y;
      
      // 限制在屏幕内
      const maxX = window.innerWidth - 50;
      const maxY = window.innerHeight - 50;
      floatingBallState.position.x = Math.max(0, Math.min(maxX, floatingBallState.position.x));
      floatingBallState.position.y = Math.max(0, Math.min(maxY, floatingBallState.position.y));
      
      ballEl.style.left = floatingBallState.position.x + 'px';
      ballEl.style.top = floatingBallState.position.y + 'px';
    }

    function handleMouseUp() {
      clearTimeout(longPressTimer);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      if (floatingBallState.isDragging) {
        endDrag();
      } else if (!hasMoved) {
        // 点击事件
        toggleMenu();
      }
    }

    function handleTouchEnd() {
      clearTimeout(longPressTimer);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      
      if (floatingBallState.isDragging) {
        endDrag();
      } else if (!hasMoved) {
        // 点击事件
        toggleMenu();
      }
    }

    function endDrag() {
      floatingBallState.isDragging = false;
      ballEl.classList.remove('dragging');
      
      // 保存当前位置（不再强制吸附到边缘）
      saveState();
    }

    // 菜单项点击
    menuEl.addEventListener('click', (e) => {
      const item = e.target.closest('.fb-menu-item');
      if (!item) return;
      
      const action = item.dataset.action;
      handleMenuAction(action);
    });

    // 全局点击事件，用于点击外部收起菜单
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick, { passive: true });
  }

  function handleOutsideClick(e) {
    if (!floatingBallState.menuOpen && !floatingBallState.submenuOpen) return;
    
    // 检查点击区域是否在相关元素内
    if (ballEl && ballEl.contains(e.target)) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (submenuEl && submenuEl.contains(e.target)) return;
    
    // 如果有各种配置面板（如样式面板等），不处理
    if (e.target.closest('.role-api-panel') || e.target.closest('.fb-style-panel')) return;
    
    // 如果点击了外部，完全关闭
    if (floatingBallState.submenuOpen) {
      floatingBallState.submenuOpen = false;
      submenuEl.classList.remove('show');
    }
    
    if (floatingBallState.menuOpen) {
      closeMenu();
    }
  }

  // 显示悬浮球
  function showBall() {
    floatingBallState.visible = true;
    ballEl.classList.remove('hidden');
    saveState();
    disableTripleTap();
  }

  // 隐藏悬浮球
  function hideBall() {
    floatingBallState.visible = false;
    ballEl.classList.add('hidden');
    closeMenu();
    saveState();
    enableTripleTap();
    
    if (typeof showToast === 'function') {
      showToast('悬浮球已隐藏，三击屏幕可唤起');
    }
  }

  // 关闭悬浮球功能
  function closeBall() {
    floatingBallState.enabled = false;
    
    // 同步更新全局设置
    if (typeof state !== 'undefined' && state.globalSettings) {
      state.globalSettings.floatingBallEnabled = false;
    }
    
    // 同步更新API设置中的开关状态
    const floatingBallSwitch = document.getElementById('floating-ball-switch');
    if (floatingBallSwitch) {
      floatingBallSwitch.checked = false;
    }
    
    ballEl.remove();
    menuEl.remove();
    submenuEl.remove();
    saveState();
    disableTripleTap();
    
    if (typeof showToast === 'function') {
      showToast('悬浮球已关闭，可在设置中重新开启');
    }
  }

  // 切换菜单
  function toggleMenu() {
    if (floatingBallState.menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  // 打开菜单
  function openMenu() {
    floatingBallState.menuOpen = true;

    // 桌宠开关的文案跟着当前状态走（2026-10-23 宠物屋）
    const petLabel = document.getElementById('fb-desktop-pet-label');
    if (petLabel) {
      const visible = window.PetNest && typeof window.PetNest.desktopPetEnabled === 'function'
        ? window.PetNest.desktopPetEnabled()
        : true;
      petLabel.textContent = visible ? '隐藏桌宠' : '显示桌宠';
    }

    // 先临时显示菜单以获取真实尺寸（但保持透明）
    menuEl.style.visibility = 'hidden';
    menuEl.style.display = 'block';
    
    const ballRect = ballEl.getBoundingClientRect();
    const menuWidth = menuEl.offsetWidth || 200;
    const menuHeight = menuEl.offsetHeight;
    
    // 恢复显示状态
    menuEl.style.visibility = '';
    menuEl.style.display = '';
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 10;
    
    let left, top;
    
    // 计算水平位置
    if (ballRect.left < viewportWidth / 2) {
      // 悬浮球在左侧，菜单向右展开
      left = ballRect.right + padding;
      // 如果右侧空间不够，调整到左侧
      if (left + menuWidth + padding > viewportWidth) {
        left = ballRect.left - menuWidth - padding;
      }
    } else {
      // 悬浮球在右侧，菜单向左展开
      left = ballRect.left - menuWidth - padding;
      // 如果左侧空间不够，调整到右侧
      if (left < padding) {
        left = ballRect.right + padding;
      }
    }
    
    // 确保水平方向不超出屏幕
    left = Math.max(padding, Math.min(left, viewportWidth - menuWidth - padding));
    
    // 计算垂直位置
    // 优先与悬浮球顶部对齐
    top = ballRect.top;
    
    // 如果菜单会超出底部，向上调整
    if (top + menuHeight + padding > viewportHeight) {
      top = viewportHeight - menuHeight - padding;
    }
    
    // 确保不超出顶部
    top = Math.max(padding, top);
    
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
    menuEl.classList.add('show');
  }

  // 关闭菜单
  function closeMenu() {
    floatingBallState.menuOpen = false;
    menuEl.classList.remove('show');
  }

  // 打开子菜单
  function openSubmenu(type) {
    floatingBallState.submenuOpen = true;
    
    // 先关闭主菜单
    menuEl.classList.remove('show');
    
    if (type === 'api') {
      renderApiSubmenu();
    } else if (type === 'template') {
      renderTemplateSubmenu();
    }
    
    // 先临时显示子菜单以获取真实尺寸
    submenuEl.style.visibility = 'hidden';
    submenuEl.style.display = 'block';
    
    // 使用悬浮球的位置而不是菜单的位置
    const ballRect = ballEl.getBoundingClientRect();
    const submenuWidth = submenuEl.offsetWidth || 220;
    const submenuHeight = submenuEl.offsetHeight;
    
    // 恢复显示状态
    submenuEl.style.visibility = '';
    submenuEl.style.display = '';
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 10;
    
    let left, top;
    
    // 计算水平位置（基于悬浮球）
    if (ballRect.left < viewportWidth / 2) {
      // 悬浮球在左侧，子菜单在右侧
      left = ballRect.right + padding;
      // 如果右侧空间不够，调整到左侧
      if (left + submenuWidth + padding > viewportWidth) {
        left = ballRect.left - submenuWidth - padding;
      }
    } else {
      // 悬浮球在右侧，子菜单在左侧
      left = ballRect.left - submenuWidth - padding;
      // 如果左侧空间不够，调整到右侧
      if (left < padding) {
        left = ballRect.right + padding;
      }
    }
    
    // 确保水平方向不超出屏幕
    left = Math.max(padding, Math.min(left, viewportWidth - submenuWidth - padding));
    
    // 计算垂直位置（基于悬浮球）
    top = ballRect.top;
    
    // 如果子菜单会超出底部，向上调整
    if (top + submenuHeight + padding > viewportHeight) {
      top = viewportHeight - submenuHeight - padding;
    }
    
    // 确保不超出顶部
    top = Math.max(padding, top);
    
    submenuEl.style.left = left + 'px';
    submenuEl.style.top = top + 'px';
    submenuEl.classList.add('show');
  }

  // 关闭子菜单
  function closeSubmenu() {
    floatingBallState.submenuOpen = false;
    submenuEl.classList.remove('show');
    // 关闭子菜单时重新打开主菜单
    openMenu();
  }

  function logFloatingApiPresetSwitch(event, payload) {
    if (typeof runtimeDiag !== 'undefined' && runtimeDiag && typeof runtimeDiag.log === 'function') {
      runtimeDiag.log(event, payload || {});
    }
  }

  function getFloatingApiPresetDefaultModel(preset) {
    if (!preset) return '';
    // 预设的默认模型可能存在 defaultModel（设置页保存）或 model（悬浮球“保存当前配置”）字段，
    // 与 api-endpoint-presets.js 的 getApiPresetDefaultModel 保持一致，两者都读，优先 defaultModel。
    const model = (typeof preset.defaultModel === 'string' && preset.defaultModel)
      || (typeof preset.model === 'string' && preset.model)
      || '';
    return model.trim();
  }

  function updateMainApiDisplayFromFloatingSwitch(presetId, model) {
    const mainPresetSelect = document.getElementById('slot-main-endpoint-preset');
    if (mainPresetSelect) {
      mainPresetSelect.value = presetId != null ? String(presetId) : '';
    }

    const modelInput = document.getElementById('model-input');
    if (modelInput) {
      modelInput.value = model || '';
    }
  }

  // 渲染 API 预设子菜单
  async function renderApiSubmenu() {
    const presets = await db.apiPresets.toArray();
    const currentConfig = state.apiConfig || {};
    const currentPresetId = currentConfig.mainEndpointPresetId != null && currentConfig.mainEndpointPresetId !== ''
      ? parseInt(currentConfig.mainEndpointPresetId, 10)
      : null;
    
    let html = `
      <div class="fb-submenu-header">
        <div class="fb-submenu-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
          返回
        </div>
      </div>
    `;
    
    // 当前配置
    html += `
      <div class="fb-submenu-item ${currentPresetId === null ? 'active' : ''}" data-preset-id="current">
        <div class="radio"></div>
        <span>当前配置 (未保存)</span>
      </div>
    `;
    
    // 预设列表
    presets.forEach(preset => {
      html += `
        <div class="fb-submenu-item ${preset.id === currentPresetId ? 'active' : ''}" data-preset-id="${preset.id}">
          <div class="radio"></div>
          <span>${preset.name}</span>
        </div>
      `;
    });
    
    // 保存按钮
    html += `
      <div class="fb-submenu-add">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        保存当前配置
      </div>
    `;
    
    submenuEl.innerHTML = html;
    
    // 绑定事件
    submenuEl.querySelector('.fb-submenu-back').addEventListener('click', closeSubmenu);
    
    submenuEl.querySelectorAll('.fb-submenu-item').forEach(item => {
      item.addEventListener('click', async () => {
        const presetId = item.dataset.presetId;
        if (presetId === 'current') return;
        
        await switchApiPreset(parseInt(presetId));
        closeSubmenu();
        closeMenu();
      });
    });
    
    submenuEl.querySelector('.fb-submenu-add').addEventListener('click', async () => {
      await saveCurrentApiPreset();
      renderApiSubmenu(); // 刷新列表
    });
  }

  // 渲染设置模板子菜单
  async function renderTemplateSubmenu() {
    const presets = await db.chatSettingsPresets.toArray();
    
    let html = `
      <div class="fb-submenu-header">
        <div class="fb-submenu-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
          返回
        </div>
      </div>
    `;
    
    if (presets.length === 0) {
      html += `
        <div class="fb-submenu-item" style="justify-content: center; color: #999; cursor: default;">
          <span>暂无模板</span>
        </div>
        <div style="padding: 20px; text-align: center; color: #888; font-size: 13px; line-height: 1.6;">
          <p style="margin: 0 0 8px 0;">💡 设置模板可以保存：</p>
          <p style="margin: 0; text-align: left;">• 回复条数、后台活动等功能设置<br>• 记忆模式、自动总结等记忆配置<br>• 主题、字体等外观设置</p>
          <p style="margin: 12px 0 0 0; color: #999; font-size: 12px;">不包括：名字、头像、人设等身份信息</p>
        </div>
      `;
    } else {
      // 模板列表
      presets.forEach(preset => {
        const description = preset.description || '无描述';
        html += `
          <div class="fb-submenu-item fb-template-item" data-preset-id="${preset.id}">
            <div class="fb-template-content">
              <div class="fb-template-name">${preset.name}</div>
              <div class="fb-template-desc">${description}</div>
            </div>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="fb-template-arrow">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </div>
        `;
      });
    }
    
    // 保存按钮
    html += `
      <div class="fb-submenu-add">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        保存当前设置
      </div>
    `;
    
    submenuEl.innerHTML = html;
    
    // 绑定事件
    submenuEl.querySelector('.fb-submenu-back').addEventListener('click', closeSubmenu);
    
    submenuEl.querySelectorAll('.fb-template-item[data-preset-id]').forEach(item => {
      item.addEventListener('click', async () => {
        const presetId = parseInt(item.dataset.presetId);
        await applyTemplate(presetId);
        closeSubmenu();
        closeMenu();
      });
    });
    
    submenuEl.querySelector('.fb-submenu-add').addEventListener('click', async () => {
      await saveCurrentTemplate();
      renderTemplateSubmenu(); // 刷新列表
    });
  }

  // 应用设置模板
  async function applyTemplate(presetId) {
    if (typeof applyChatSettingsPreset === 'function') {
      await applyChatSettingsPreset(presetId);
    } else {
      if (typeof showToast === 'function') {
        showToast('功能未加载，请刷新页面');
      }
    }
  }

  // 保存当前设置为模板
  async function saveCurrentTemplate() {
    const name = await showCustomPrompt('保存设置模板', '请输入模板名称');
    if (!name || !name.trim()) return;
    
    if (typeof saveCurrentChatSettingsAsPreset === 'function') {
      await saveCurrentChatSettingsAsPreset(name);
    } else {
      if (typeof showToast === 'function') {
        showToast('功能未加载，请刷新页面');
      }
    }
  }

  // 切换 API 预设
  async function switchApiPreset(presetId) {
    const oldConfig = state.apiConfig || {};
    const oldMainPreset = oldConfig.mainEndpointPresetId ?? null;
    const oldMainModel = oldConfig.model || '';

    try {
      const preset = await db.apiPresets.get(presetId);
      if (!preset) {
        logFloatingApiPresetSwitch('FLOATING_API_PRESET_SWITCH_ERROR', {
          presetId,
          presetName: '',
          oldMainPreset,
          newMainPreset: null,
          oldMainModel,
          newMainModel: oldMainModel,
          skippedOtherSlots: true,
          error: 'preset_not_found'
        });
        if (typeof showToast === 'function') {
          showToast('预设不存在，无法切换');
        }
        return;
      }

      const defaultModel = getFloatingApiPresetDefaultModel(preset);
      const newMainModel = defaultModel || oldMainModel || '';

      logFloatingApiPresetSwitch('FLOATING_API_PRESET_SWITCH_START', {
        presetId: preset.id,
        presetName: preset.name || '',
        oldMainPreset,
        newMainPreset: preset.id,
        oldMainModel,
        newMainModel,
        skippedOtherSlots: true
      });

      // 悬浮球切换只服务于主聊天 API：
      // 仅更新 main slot 的预设引用与模型。旧预设对象中可能残留的副 API、
      // 后台活动 API、识图 API、情侣空间 API 快照字段一律忽略，不写回任何功能位。
      state.apiConfig = {
        ...oldConfig,
        id: oldConfig.id || 'main',
        mainEndpointPresetId: preset.id,
        model: newMainModel
      };

      // 兼容已存在的 globalSettings.apiSlotSettings 结构：只更新 main，保持其他 slot 原对象不变。
      if (state.globalSettings) {
        const existingSlotSettings = state.globalSettings.apiSlotSettings;
        state.globalSettings.apiSlotSettings = {
          ...(existingSlotSettings || {}),
          main: {
            ...((existingSlotSettings && existingSlotSettings.main) || {}),
            selectedPresetId: preset.id,
            selectedPresetName: preset.name || '',
            model: newMainModel
          }
        };
      }

      await db.apiConfig.put(state.apiConfig);
      if (state.globalSettings && db.globalSettings) {
        await db.globalSettings.put(state.globalSettings);
      }

      // 换预设了 → 立刻把 state.apiConfig 里的地址/密钥刷新成【当前实际在用的】那套。
      // 不刷新的话, 所有还读 state.apiConfig 的地方(几十处)会继续用旧地址,
      // 最坑的是"旧地址 + 新模型"的错配 —— 悬浮球切预设后必现。
      // ⚠️ 必须放在 db.apiConfig.put 之后 —— 免得把解析出来的地址/密钥写进库,
      //    破坏"只存预设引用"的设计。
      if (typeof syncApiSlotConfigIntoState === 'function') {
        await syncApiSlotConfigIntoState();
      }

      updateMainApiDisplayFromFloatingSwitch(preset.id, newMainModel);

      if (typeof refreshAllEndpointPresetUi === 'function') {
        await refreshAllEndpointPresetUi();
      }
      if (typeof loadApiPresetsDropdown === 'function') {
        await loadApiPresetsDropdown(preset.id);
      }

      logFloatingApiPresetSwitch('FLOATING_API_PRESET_SWITCH_DONE', {
        presetId: preset.id,
        presetName: preset.name || '',
        oldMainPreset,
        newMainPreset: preset.id,
        oldMainModel,
        newMainModel,
        skippedOtherSlots: true
      });
      
      if (typeof showToast === 'function') {
        showToast(`已切换主 API 到：${preset.name}`);
      }
    } catch (error) {
      logFloatingApiPresetSwitch('FLOATING_API_PRESET_SWITCH_ERROR', {
        presetId,
        presetName: '',
        oldMainPreset,
        newMainPreset: null,
        oldMainModel,
        newMainModel: oldMainModel,
        skippedOtherSlots: true,
        error: error && error.message ? error.message : String(error)
      });
      console.error('悬浮球切换 API 预设失败:', error);
      if (typeof showToast === 'function') {
        showToast('切换 API 预设失败');
      }
    }
  }

  // 保存当前 API 配置为预设
  async function saveCurrentApiPreset() {
    const name = await showCustomPrompt('保存 API 预设', '请输入预设名称');
    if (!name || !name.trim()) return;

    // ⚠️ 先把 state.apiConfig 刷新成【当前实际在用的】地址/密钥 ——
    //    站点预设模式下, 静态字段会被清空, 直接存会存下一个空预设。
    if (typeof syncApiSlotConfigIntoState === 'function') {
      await syncApiSlotConfigIntoState();
    }

    const presetData = {
      name: name.trim(),
      proxyUrl: state.apiConfig.proxyUrl || '',
      apiKey: state.apiConfig.apiKey || '',
      model: state.apiConfig.model || '',
      secondaryProxyUrl: state.apiConfig.secondaryProxyUrl || '',
      secondaryApiKey: state.apiConfig.secondaryApiKey || '',
      secondaryModel: state.apiConfig.secondaryModel || '',
      backgroundProxyUrl: state.apiConfig.backgroundProxyUrl || '',
      backgroundApiKey: state.apiConfig.backgroundApiKey || '',
      backgroundModel: state.apiConfig.backgroundModel || '',
      visionProxyUrl: state.apiConfig.visionProxyUrl || '',
      visionApiKey: state.apiConfig.visionApiKey || '',
      visionModel: state.apiConfig.visionModel || '',
      visionPrompt: state.apiConfig.visionPrompt || '',
      mainEndpointPresetId: state.apiConfig.mainEndpointPresetId,
      secondaryEndpointPresetId: state.apiConfig.secondaryEndpointPresetId,
      backgroundEndpointPresetId: state.apiConfig.backgroundEndpointPresetId,
      visionEndpointPresetId: state.apiConfig.visionEndpointPresetId,
      couplespaceEndpointPresetId: state.apiConfig.couplespaceEndpointPresetId,
      couplespaceProxyUrl: state.apiConfig.couplespaceProxyUrl || '',
      couplespaceApiKey: state.apiConfig.couplespaceApiKey || '',
      couplespaceModel: state.apiConfig.couplespaceModel || '',
      tts: state.apiConfig.tts ? JSON.parse(JSON.stringify(state.apiConfig.tts)) : undefined
    };
    
    const existingPreset = await db.apiPresets.where('name').equals(presetData.name).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;
      presetData.id = existingPreset.id;
    }
    
    await db.apiPresets.put(presetData);
    
    if (typeof showToast === 'function') {
      showToast('API 预设已保存');
    }
  }

  // 处理菜单操作
  function handleMenuAction(action) {
    switch (action) {
      case 'pet-nest':
        closeMenu();
        if (typeof window.openPetNest === 'function') {
          window.openPetNest();
        } else if (typeof showToast === 'function') {
          showToast('宠物屋还没加载好，刷新一下页面');
        }
        break;
      case 'toggle-desktop-pet':
        closeMenu();
        if (window.PetNest && typeof window.PetNest.toggleDesktopPet === 'function') {
          const next = !window.PetNest.desktopPetEnabled();
          window.PetNest.toggleDesktopPet(next);
          if (typeof showToast === 'function') {
            showToast(next ? '桌宠已显示' : '桌宠已隐藏');
          }
        }
        break;
      case 'clear-chat-images':
        closeMenu();
        handleQuickClearChatImages();
        break;
      case 'compress-images':
        closeMenu();
        handleQuickCompressImages();
        break;
      case 'clear-chat-history':
        closeMenu();
        handleQuickClearChatHistory();
        break;
      case 'switch-api':
        openSubmenu('api');
        break;
      case 'apply-template':
        openSubmenu('template');
        break;
      case 'role-api':
        closeMenu(); // 关闭菜单
        openRoleApiConfig();
        break;
      case 'style-settings':
        closeMenu(); // 关闭菜单
        openStyleSettings();
        break;
      case 'manage-ai-songs':
        closeMenu(); // 关闭菜单
        handleQuickManageAiSongs();
        break;
      case 'hide':
        hideBall();
        break;
      case 'close':
        closeBall();
        break;
    }
  }

  // ========== 快捷数据管理功能 ==========

  // 【2026-07-22 新增】AI 原创曲管理 — 悬浮球菜单入口
  // 列出 IndexedDB 里的所有 AI 歌，支持 ▶ 播放 / ⤓ 下载 / 🗑 删除 + 一键清空全部
  // 设计原则：极简统一，弹一个 mini modal，不进独立页面
  async function handleQuickManageAiSongs() {
    if (!window.AiSongsStore || typeof window.AiSongsStore.listAllSongs !== 'function') {
      if (typeof showToast === 'function') showToast('AI 歌存储模块未加载');
      return;
    }
    const songs = await window.AiSongsStore.listAllSongs();
    if (!songs || songs.length === 0) {
      if (typeof showToast === 'function') showToast('暂无 AI 原创曲');
      return;
    }

    // 防止重复弹
    const existing = document.getElementById('ai-songs-manager-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ai-songs-manager-modal';
    modal.innerHTML = `
      <div class="ai-songs-manager-backdrop"></div>
      <div class="ai-songs-manager-content">
        <div class="ai-songs-manager-header">
          <h3>🎵 AI 原创曲管理</h3>
          <button class="ai-songs-manager-close" aria-label="关闭">×</button>
        </div>
        <div class="ai-songs-manager-stats"></div>
        <div class="ai-songs-manager-list"></div>
        <div class="ai-songs-manager-footer">
          <button class="ai-songs-manager-clear-all">清空全部（释放空间）</button>
        </div>
      </div>
    `;
    // 注入 CSS（一次性，重复弹不重复注入）
    if (!document.getElementById('ai-songs-manager-styles')) {
      const style = document.createElement('style');
      style.id = 'ai-songs-manager-styles';
      style.textContent = `
        #ai-songs-manager-modal { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center; }
        #ai-songs-manager-modal .ai-songs-manager-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
        #ai-songs-manager-modal .ai-songs-manager-content { position: relative; width: min(92vw, 480px); max-height: 80vh; background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden; }
        #ai-songs-manager-modal .ai-songs-manager-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #eee; }
        #ai-songs-manager-modal .ai-songs-manager-header h3 { margin: 0; font-size: 16px; color: #222; }
        #ai-songs-manager-modal .ai-songs-manager-close { background: none; border: none; font-size: 24px; line-height: 1; cursor: pointer; color: #888; padding: 0 4px; }
        #ai-songs-manager-modal .ai-songs-manager-stats { padding: 10px 18px; font-size: 13px; color: #666; background: #f8f8fa; }
        #ai-songs-manager-modal .ai-songs-manager-list { flex: 1; overflow-y: auto; padding: 8px 0; }
        #ai-songs-manager-modal .ai-songs-manager-row { display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid #f0f0f0; }
        #ai-songs-manager-modal .ai-songs-manager-row:hover { background: #fafbff; }
        #ai-songs-manager-modal .ai-songs-manager-info { flex: 1; min-width: 0; }
        #ai-songs-manager-modal .ai-songs-manager-title { font-size: 14px; color: #222; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #ai-songs-manager-modal .ai-songs-manager-title .cover-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; background: #ffd966; color: #5a4500; border-radius: 4px; font-size: 11px; font-weight: normal; }
        #ai-songs-manager-modal .ai-songs-manager-meta { font-size: 12px; color: #888; margin-top: 2px; }
        #ai-songs-manager-modal .ai-songs-manager-actions { display: flex; gap: 4px; flex-shrink: 0; }
        #ai-songs-manager-modal .ai-songs-manager-actions button { width: 32px; height: 32px; border: 1px solid #ddd; background: #fff; border-radius: 6px; cursor: pointer; font-size: 14px; padding: 0; }
        #ai-songs-manager-modal .ai-songs-manager-actions button:hover { background: #f0f4ff; border-color: #1a73e8; }
        #ai-songs-manager-modal .ai-songs-manager-actions button[data-act="delete"]:hover { background: #fff0f0; border-color: #d93025; }
        #ai-songs-manager-modal .ai-songs-manager-footer { padding: 12px 18px; border-top: 1px solid #eee; }
        #ai-songs-manager-modal .ai-songs-manager-clear-all { width: 100%; padding: 10px; background: #fff; color: #d93025; border: 1px solid #d93025; border-radius: 8px; cursor: pointer; font-size: 14px; }
        #ai-songs-manager-modal .ai-songs-manager-clear-all:hover { background: #fff0f0; }
        #ai-songs-manager-modal .empty-state { padding: 40px 20px; text-align: center; color: #888; font-size: 14px; }
      `;
      document.head.appendChild(style);
    }
    document.body.appendChild(modal);

    const listEl = modal.querySelector('.ai-songs-manager-list');
    const statsEl = modal.querySelector('.ai-songs-manager-stats');

    function renderList() {
      statsEl.textContent = '共 ' + songs.length + ' 首, 总计 ' + (songs.reduce((sum, s) => sum + (s.size || 0), 0) / 1024 / 1024).toFixed(2) + ' MB';
      if (songs.length === 0) {
        listEl.innerHTML = '<div class="empty-state">已全部清空 ✨</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const s of songs) {
        const sizeMB = ((s.size || 0) / 1024 / 1024).toFixed(2);
        const dateStr = new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false });
        const safeTitle = String(s.title || '未命名').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
        const row = document.createElement('div');
        row.className = 'ai-songs-manager-row';
        row.innerHTML = `
          <div class="ai-songs-manager-info">
            <div class="ai-songs-manager-title">${safeTitle}${s.isCover ? '<span class="cover-badge">翻唱</span>' : ''}</div>
            <div class="ai-songs-manager-meta">${sizeMB} MB · ${dateStr}</div>
          </div>
          <div class="ai-songs-manager-actions">
            <button data-act="play" data-song-id="${s.songId}" title="播放">▶</button>
            <button data-act="download" data-song-id="${s.songId}" title="下载到本地">⤓</button>
            <button data-act="delete" data-song-id="${s.songId}" title="从本地存储删除">🗑</button>
          </div>
        `;
        listEl.appendChild(row);
      }
    }
    renderList();

    // 关闭
    const closeModal = () => modal.remove();
    modal.querySelector('.ai-songs-manager-close').addEventListener('click', closeModal);
    modal.querySelector('.ai-songs-manager-backdrop').addEventListener('click', closeModal);

    // 清空全部
    modal.querySelector('.ai-songs-manager-clear-all').addEventListener('click', async () => {
      if (songs.length === 0) return;
      const totalMB = (songs.reduce((sum, s) => sum + (s.size || 0), 0) / 1024 / 1024).toFixed(2);
      const confirmed = await showCustomConfirm(
        '清空全部 AI 原创曲',
        `将从本地存储删除 <strong>${songs.length}</strong> 首歌，释放 <strong>${totalMB} MB</strong>。<br><br>已下载到本地的文件不受影响，可继续听。<br><br>⚠️ 此操作不可撤销。`,
        { confirmButtonClass: 'btn-danger', confirmText: '确认清空' }
      );
      if (!confirmed) return;
      let freed = 0;
      let okCount = 0;
      for (const s of songs) {
        try {
          const ok = await window.AiSongsStore.deleteSong(s.songId);
          if (ok) { freed += (s.size || 0); okCount++; }
        } catch (e) { console.error('[AISongsManager] delete failed', s.songId, e); }
      }
      // 从歌单里也清掉对应条目
      if (window.musicState && Array.isArray(window.musicState.playlist)) {
        const before = window.musicState.playlist.length;
        window.musicState.playlist = window.musicState.playlist.filter(t => !t || !t.isAiSong || !songs.find(s => s.songId === t.songId));
        if (typeof window.saveGlobalPlaylist === 'function') {
          try { window.saveGlobalPlaylist(); } catch (e) { /* ignore */ }
        }
        if (typeof window.updatePlaylistUI === 'function') {
          try { window.updatePlaylistUI(); } catch (e) { /* ignore */ }
        }
      }
      songs.length = 0;
      renderList();
      if (typeof showToast === 'function') showToast(`已清空 ${okCount} 首歌, 释放 ${(freed/1024/1024).toFixed(2)} MB`, 'success');
    });

    // 行内操作（事件代理）
    listEl.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const songId = btn.dataset.songId;
      const act = btn.dataset.act;
      const song = songs.find(s => s.songId === songId);
      if (!song) return;
      try {
        if (act === 'play') {
          const rec = await window.AiSongsStore.getSong(songId);
          if (!rec) { if (typeof showToast === 'function') showToast('歌曲不存在, 请刷新列表'); return; }
          const r = await window.MusicPlayer.addAiSongToPlaylist(rec.blob, {
            songId: rec.songId, title: rec.title, isCover: rec.useVoiceSample,
            chatId: rec.chatId, createdAt: rec.createdAt, lyrics: rec.lyrics
          });
          await window.MusicPlayer.playSong(r.index, true);
          closeModal();
        } else if (act === 'download') {
          const rec = await window.AiSongsStore.getSong(songId);
          if (!rec) return;
          const safeBlob = rec.blob.type === 'audio/mpeg' ? rec.blob : new Blob([rec.blob], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(safeBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = (rec.title || 'ai-song') + '.mp3';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          if (typeof showToast === 'function') showToast('已下载 ' + (rec.title || ''), 'success');
        } else if (act === 'delete') {
          const confirmed = await showCustomConfirm(
            '删除歌曲',
            `将从本地存储删除《<strong>${song.title || '未命名'}</strong>》。<br><br>已下载到本地的文件不受影响。<br><br>⚠️ 此操作不可撤销。`,
            { confirmButtonClass: 'btn-danger', confirmText: '删除' }
          );
          if (!confirmed) return;
          const ok = await window.AiSongsStore.deleteSong(songId);
          if (!ok) { if (typeof showToast === 'function') showToast('删除失败'); return; }
          // 从歌单里也清掉
          if (window.musicState && Array.isArray(window.musicState.playlist)) {
            window.musicState.playlist = window.musicState.playlist.filter(t => !t || t.songId !== songId);
            if (typeof window.saveGlobalPlaylist === 'function') {
              try { window.saveGlobalPlaylist(); } catch (e) { /* ignore */ }
            }
            if (typeof window.updatePlaylistUI === 'function') {
              try { window.updatePlaylistUI(); } catch (e) { /* ignore */ }
            }
          }
          const idx = songs.findIndex(s => s.songId === songId);
          if (idx > -1) songs.splice(idx, 1);
          renderList();
          if (typeof showToast === 'function') showToast('已删除', 'success');
        }
      } catch (e) {
        console.error('[AISongsManager] action failed', act, songId, e);
        if (typeof showToast === 'function') showToast('操作失败: ' + (e.message || e));
      }
    });
  }

  // 清空当前聊天的本地图片
  async function handleQuickClearChatImages() {
    const chatId = state.activeChatId;
    if (!chatId) {
      if (typeof showToast === 'function') showToast('请先打开一个聊天');
      return;
    }

    const chat = state.chats[chatId];
    if (!chat) return;

    const isLocalImageUrl = (value) => typeof value === 'string' && value.startsWith('data:image');
    const isImageFileValue = (value) => {
      if (!value) return false;
      if (typeof File !== 'undefined' && value instanceof File) return true;
      if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
      if (typeof value === 'object') {
        return typeof value.type === 'string' && value.type.startsWith('image/');
      }
      return false;
    };

    // 先统计当前聊天的图片数量：优先走全量 messages 表，避免未加载历史图片漏统计
    let imageCount = 0;
    let totalSize = 0;

    let aiImageCount = 0;

    if (typeof window.countUserImagesForChat === 'function') {
      const imageStats = await window.countUserImagesForChat(chatId);
      imageCount = imageStats.imagesCleared + (imageStats.aiImagesDeleted || 0);
      aiImageCount = imageStats.aiImagesDeleted || 0;
      totalSize = imageStats.sizeFreed;
    } else if (chat.history && Array.isArray(chat.history)) {
      for (const msg of chat.history) {
        if (msg.images && Array.isArray(msg.images)) {
          for (const img of msg.images) {
            if (isLocalImageUrl(img)) {
              imageCount++;
              totalSize += img.length;
            }
          }
        }

        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item?.type === 'image_url' && item.image_url?.url && isLocalImageUrl(item.image_url.url)) {
              imageCount++;
              totalSize += item.image_url.url.length;
            }
          }
        } else if (typeof msg.content === 'string' && isLocalImageUrl(msg.content)) {
          imageCount++;
          totalSize += msg.content.length;
        }

        if (isLocalImageUrl(msg.imageSrc)) {
          imageCount++;
          totalSize += msg.imageSrc.length;
        }

        if (isImageFileValue(msg.file)) {
          imageCount++;
        }
      }
    }

    if (imageCount === 0) {
      if (typeof showToast === 'function') showToast('当前聊天没有可清除的图片');
      return;
    }

    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
    const confirmed = await showCustomConfirm(
      '清空聊天图片',
      `确定要清空「${chat.name}」的聊天图片吗？<br><br>共 <strong>${imageCount}</strong> 张/条图片内容，其中 AI 图片消息 <strong>${aiImageCount}</strong> 条；用户本地图片占用 <strong>${sizeMB} MB</strong><br><br>⚠️ 用户图片不会删除识图文字，仅清理图片文件；AI 图片消息会整条删除。`,
      { confirmButtonClass: 'btn-danger', confirmText: '确认清空' }
    );

    if (!confirmed) return;

    try {
      const stats = {
        chatsProcessed: 0,
        imagesCleared: 0,
        aiImagesDeleted: 0,
        sizeFreed: 0
      };

      if (typeof window.clearUserImagesForChat === 'function') {
        await window.clearUserImagesForChat(chatId, stats);
      } else {
        throw new Error('清除图片功能未加载，请刷新页面后重试');
      }

      const clearedCount = stats.imagesCleared;
      const freedMB = (stats.sizeFreed / 1024 / 1024).toFixed(2);
      if (typeof showToast === 'function') {
        showToast(`已清空 ${clearedCount} 张用户图片，删除 ${stats.aiImagesDeleted || 0} 条 AI 图片消息，释放 ${freedMB} MB`, 'success');
      }

      // 刷新当前聊天界面
      if (typeof renderChatInterface === 'function') {
        await renderChatInterface(chatId);
      }
    } catch (error) {
      console.error('清空聊天图片失败:', error);
      if (typeof showCustomAlert === 'function') {
        await showCustomAlert('清空失败', `操作失败: ${error.message}`);
      }
    }
  }

  // 图片压缩（调用已有的全局函数）
  async function handleQuickCompressImages() {
    if (typeof compressAllLocalImages === 'function') {
      await compressAllLocalImages();
    } else {
      if (typeof showToast === 'function') showToast('功能未加载，请刷新页面');
    }
  }

  async function handleQuickClearChatHistory() {
    const chatId = state.activeChatId;
    if (!chatId) {
      if (typeof showToast === 'function') showToast('请先打开一个聊天');
      return;
    }

    const chat = state.chats[chatId];
    if (!chat) return;

    const totalMessages = window.messageStore?.countMessages
      ? await window.messageStore.countMessages(chatId)
      : (chat.history ? chat.history.length : 0);

    if (totalMessages === 0) {
      if (typeof showToast === 'function') showToast('当前聊天没有记录');
      return;
    }

    const keepInput = await showCustomPrompt(
      '清空聊天记录',
      `当前共有 ${totalMessages} 条消息。\n\n输入要保留的最近消息条数：\n- 留空或 0 = 全部清空\n- 例如输入 5 = 仅保留最近 5 条`,
      '',
      'number'
    );

    if (keepInput === null) return;

    const keepCount = Math.max(0, Number(keepInput) || 0);
    const confirmed = await showCustomConfirm(
      '确认清空',
      keepCount > 0
        ? `将删除当前聊天中除最近 <strong>${keepCount}</strong> 条外的所有消息。<br><br>⚠️ 此操作不可撤销！`
        : `将清空全部 <strong>${totalMessages}</strong> 条聊天记录。<br><br>⚠️ 此操作不可撤销！`,
      { confirmButtonClass: 'btn-danger', confirmText: '确认清空' }
    );

    if (!confirmed) return;

    try {
      if (window.messageStore?.clearChatMessages) {
        await window.messageStore.clearChatMessages(chatId, keepCount);
      } else {
        console.log('[清空聊天] chatId:', chatId);
        console.log('[清空聊天] keepCount:', keepCount);
        console.log('[清空聊天] 删除前总数:', await db.messages.where('chatId').equals(chatId).count());
        if (keepCount <= 0) {
          await db.messages.where('chatId').equals(chatId).delete();
        }
      }

      if (keepCount <= 0) {
        chat.lastMessageTimestamp = 0;
        chat.lastMessagePreview = '';
        chat.lastMessageRole = '';
        chat.lastMessageType = '';
        chat.messageCount = 0;
        chat.updatedAt = Date.now();
        // 2026-08-18 v0.2.30.7: 同步清 mcpToolLogs
        // 跟 data-management.js:903-915 的清空路径保持一致, 否则 mcpToolLogs 残留
        // observer 触发时 renderHistoricalLogs 重新插入 17 条 log (虽然修 1+2+3 修好了
        // lineEl 散落的 bug, 但 log 还是会重新出现在 chat-messages 里, 视觉残留)
        if (Array.isArray(chat.mcpToolLogs) && chat.mcpToolLogs.length > 0) {
          chat.mcpToolLogs = [];
        }
      }

      if (typeof renderChatInterface === 'function') {
        await renderChatInterface(chatId);
      } else if (typeof renderCurrentMessages === 'function') {
        renderCurrentMessages();
      } else if (typeof renderChatScreen === 'function') {
        await renderChatScreen();
      }

      if (typeof renderChatList === 'function') {
        renderChatList();
      }

      if (typeof showToast === 'function') {
        showToast(keepCount > 0 ? `已保留最近 ${keepCount} 条` : '已清空聊天记录', 'success');
      }
    } catch (error) {
      console.error('[清空聊天失败]', error);
      if (typeof showCustomAlert === 'function') {
        await showCustomAlert('清空失败', `操作失败: ${error.message}`);
      }
    }
  }

  // 打开角色API配置面板
  function openRoleApiConfig() {
    const chatId = state.activeChatId;
    if (!chatId) {
      if (typeof showToast === 'function') {
        showToast('请先打开一个聊天');
      }
      return;
    }
    
    const chat = state.chats[chatId];
    if (!chat) return;
    
    // 创建配置面板
    const panel = document.createElement('div');
    panel.id = 'role-api-config-panel';
    panel.className = 'role-api-panel';
    panel.innerHTML = `
      <div class="role-api-content">
        <div class="role-api-header">
          <span class="role-api-back">‹</span>
          <span class="role-api-title">${chat.name} - API配置</span>
          <span class="role-api-save">保存</span>
        </div>
        <div class="role-api-body">
          <div class="role-api-section">
            <div class="role-api-switch-item">
              <div class="role-api-switch-left">
                <div class="role-api-switch-label">使用独立API配置</div>
                <div class="role-api-switch-desc">开启后，此角色将使用独立的API配置，不受全局设置影响</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="role-api-enable">
                <span class="slider"></span>
              </label>
            </div>
          </div>
          
          <div id="role-api-details" style="display: none;">
            <div class="role-api-section">
              <div class="role-api-field">
                <label class="role-api-label">反代地址</label>
                <input type="text" id="role-api-proxy" class="role-api-input" placeholder="https://api.openai.com/v1">
              </div>
              
              <div class="role-api-field">
                <label class="role-api-label">API Key</label>
                <input type="password" id="role-api-key" class="role-api-input" placeholder="sk-...">
              </div>
              
              <div class="role-api-field">
                <label class="role-api-label">模型</label>
                <div class="role-api-model-row">
                  <select id="role-api-model-select" class="role-api-select">
                    <option value="">选择模型</option>
                  </select>
                  <button id="role-api-fetch-models" class="role-api-fetch-btn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"></polyline>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                    </svg>
                    拉取
                  </button>
                </div>
                <input type="text" id="role-api-model-input" class="role-api-input" placeholder="或手动输入模型名称" style="margin-top: 8px;">
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // 回显数据
    const apiOverride = chat.apiOverride || {};
    document.getElementById('role-api-enable').checked = apiOverride.enabled || false;
    document.getElementById('role-api-proxy').value = apiOverride.proxyUrl || '';
    document.getElementById('role-api-key').value = apiOverride.apiKey || '';
    document.getElementById('role-api-model-input').value = apiOverride.model || '';
    
    const detailsDiv = document.getElementById('role-api-details');
    detailsDiv.style.display = apiOverride.enabled ? 'block' : 'none';
    
    // 绑定事件
    document.getElementById('role-api-enable').addEventListener('change', function() {
      detailsDiv.style.display = this.checked ? 'block' : 'none';
    });
    
    // 拉取模型列表
    document.getElementById('role-api-fetch-models').addEventListener('click', async function() {
      const btn = this;
      const proxyUrl = document.getElementById('role-api-proxy').value.trim();
      const apiKey = document.getElementById('role-api-key').value.trim();
      
      if (!proxyUrl || !apiKey) {
        if (typeof showToast === 'function') {
          showToast('请先填写反代地址和API Key');
        }
        return;
      }
      
      btn.disabled = true;
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        拉取中...
      `;
      
      try {
        const response = await fetch(`${proxyUrl}/models`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const select = document.getElementById('role-api-model-select');
        select.innerHTML = '<option value="">选择模型</option>';
        
        if (data.data && Array.isArray(data.data)) {
          data.data.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.id;
            select.appendChild(option);
          });
          
          if (typeof showToast === 'function') {
            showToast(`成功拉取 ${data.data.length} 个模型`);
          }
        }
      } catch (error) {
        console.error('拉取模型失败:', error);
        if (typeof showToast === 'function') {
          showToast('拉取模型失败: ' + error.message);
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          拉取
        `;
      }
    });
    
    // 下拉框选择时同步到输入框
    document.getElementById('role-api-model-select').addEventListener('change', function() {
      if (this.value) {
        document.getElementById('role-api-model-input').value = this.value;
      }
    });
    
    panel.querySelector('.role-api-back').addEventListener('click', () => {
      panel.remove();
      openMenu(); // 返回时重新打开菜单
    });
    
    panel.querySelector('.role-api-save').addEventListener('click', async () => {
      await saveRoleApiConfig(chatId);
      panel.remove();
      openMenu(); // 保存后重新打开菜单
    });
    
    // 点击面板外关闭
    panel.addEventListener('click', (e) => {
      if (e.target === panel) {
        panel.remove();
        openMenu(); // 关闭后重新打开菜单
      }
    });
  }

  // 保存角色API配置
  async function saveRoleApiConfig(chatId) {
    const chat = state.chats[chatId];
    if (!chat) return;
    
    const enabled = document.getElementById('role-api-enable').checked;
    
    if (!chat.apiOverride) {
      chat.apiOverride = {};
    }
    
    chat.apiOverride.enabled = enabled;
    chat.apiOverride.proxyUrl = document.getElementById('role-api-proxy').value.trim();
    chat.apiOverride.apiKey = document.getElementById('role-api-key').value.trim();
    
    // 优先使用手动输入的模型名称
    const modelInput = document.getElementById('role-api-model-input').value.trim();
    const modelSelect = document.getElementById('role-api-model-select').value;
    chat.apiOverride.model = modelInput || modelSelect;
    
    await db.chats.put(chat);
    
    if (typeof showToast === 'function') {
      showToast(enabled ? '已启用独立API配置' : '已关闭独立API配置');
    }
  }

  // 启用三击唤起
  function enableTripleTap() {
    document.addEventListener('click', handleTripleTap);
  }

  // 禁用三击唤起
  function disableTripleTap() {
    document.removeEventListener('click', handleTripleTap);
    tapCount = 0;
    if (tapTimer) clearTimeout(tapTimer);
  }

  // 处理三击
  function handleTripleTap(e) {
    // 忽略在输入框、按钮等元素上的点击
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    tapCount++;
    
    // 显示涟漪效果
    showTapRipple(e.clientX, e.clientY);
    
    if (tapCount === 1) {
      tapTimer = setTimeout(() => {
        tapCount = 0;
      }, 500);
    }
    
    if (tapCount === 3) {
      clearTimeout(tapTimer);
      tapCount = 0;
      showBall();
      
      if (typeof showToast === 'function') {
        showToast('悬浮球已唤起');
      }
    }
  }

  // 显示涟漪效果
  function showTapRipple(x, y) {
    const ripple = document.createElement('div');
    ripple.className = 'tap-ripple';
    ripple.style.left = (x - 20) + 'px';
    ripple.style.top = (y - 20) + 'px';
    document.body.appendChild(ripple);
    
    setTimeout(() => {
      ripple.remove();
    }, 400);
  }

  // ========== 样式设置功能 ==========
  
  // 获取默认CSS模板
  function getDefaultCSS() {
    return `position: fixed;
width: 50px;
height: 50px;
border-radius: 50%;
background: var(--accent-color, #007aff);
box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
display: flex;
align-items: center;
justify-content: center;
cursor: pointer;
z-index: 9999;
transition: opacity 0.3s, transform 0.3s;
opacity: 0.9;
user-select: none;
-webkit-user-select: none;
touch-action: none;`;
  }
  
  // 获取默认HTML模板
  function getDefaultHTML() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="4" y1="6" x2="20" y2="6"></line>
  <line x1="4" y1="12" x2="20" y2="12"></line>
  <line x1="4" y1="18" x2="20" y2="18"></line>
</svg>`;
  }
  
  // 打开样式设置面板
  function openStyleSettings() {
    
    const panel = document.createElement('div');
    panel.className = 'fb-style-panel';
    panel.innerHTML = `
      <div class="fb-style-content">
        <div class="fb-style-header">
          <span class="fb-style-back">‹</span>
          <span class="fb-style-title">悬浮球样式</span>
          <span class="fb-style-save">完成</span>
        </div>
        <div class="fb-style-body">
          <!-- 样式类型选择 -->
          <div class="fb-style-section">
            <div class="fb-style-label">样式类型</div>
            <div class="fb-style-tabs">
              <div class="fb-style-tab ${floatingBallState.style.type === 'default' ? 'active' : ''}" data-type="default">默认</div>
              <div class="fb-style-tab ${floatingBallState.style.type === 'image' ? 'active' : ''}" data-type="image">图片</div>
              <div class="fb-style-tab ${floatingBallState.style.type === 'custom-css' ? 'active' : ''}" data-type="custom-css">自定义</div>
            </div>
          </div>
          
          <!-- 默认样式 -->
          <div class="fb-style-panel-content ${floatingBallState.style.type === 'default' ? 'active' : ''}" data-panel="default">
            <div class="fb-style-section">
              <div class="fb-style-desc">使用默认的悬浮球样式（蓝色圆形，白色三条杠图标）</div>
            </div>
          </div>
          
          <!-- 图片样式 -->
          <div class="fb-style-panel-content ${floatingBallState.style.type === 'image' ? 'active' : ''}" data-panel="image">
            <div class="fb-style-section">
              <div class="fb-style-label">图片来源</div>
              <div class="fb-style-field">
                <input type="text" class="fb-style-input" id="fb-image-url" placeholder="输入图片URL（支持GIF动图）" value="${floatingBallState.style.imageUrl || ''}">
              </div>
              <div class="fb-style-upload-group">
                <label class="fb-style-upload-btn">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <span>本地上传</span>
                  <input type="file" id="fb-image-file" accept="image/*,.gif" style="display:none;">
                </label>
                <button class="fb-style-preview-btn" id="fb-preview-image">预览</button>
                <button class="fb-style-reset-btn" id="fb-reset-image">重置</button>
              </div>
              <div class="fb-style-desc">上传图片完全替换悬浮球外观。例如上传猫咪图片，悬浮球就变成猫咪。支持 PNG、JPG、GIF 动图，建议尺寸 100x100px</div>
            </div>
          </div>
          
          <!-- 自定义CSS -->
          <div class="fb-style-panel-content ${floatingBallState.style.type === 'custom-css' ? 'active' : ''}" data-panel="custom-css">
            <div class="fb-style-section">
              <div class="fb-style-label">HTML结构（悬浮球内容）</div>
              <textarea class="fb-style-textarea fb-style-textarea-small" id="fb-custom-html" placeholder="输入HTML代码">${floatingBallState.style.customHTML || getDefaultHTML()}</textarea>
              <div class="fb-style-desc">修改悬浮球内部的HTML内容，可以改成任何图标、文字、Emoji或图片</div>
            </div>
            
            <div class="fb-style-section">
              <div class="fb-style-label">CSS样式（悬浮球外观）</div>
              <textarea class="fb-style-textarea" id="fb-custom-css" placeholder="输入CSS代码">${floatingBallState.style.customCSS || getDefaultCSS()}</textarea>
              <div class="fb-style-button-group">
                <button class="fb-style-action-btn" id="fb-export-css">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  导出
                </button>
                <button class="fb-style-action-btn" id="fb-import-css">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  导入
                </button>
                <button class="fb-style-action-btn" id="fb-preview-css">预览</button>
                <button class="fb-style-action-btn" id="fb-reset-css">重置</button>
              </div>
              <div class="fb-style-desc">
                <strong>提示：</strong>可以复制HTML和CSS代码，然后问AI："帮我把这个悬浮球改成🍎苹果的样子"
                <br><strong>CSS作用于：</strong>#floating-ball（悬浮球容器）
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // 绑定事件
    bindStylePanelEvents(panel);
  }
  
  // 绑定样式面板事件
  function bindStylePanelEvents(panel) {
    // 返回按钮
    panel.querySelector('.fb-style-back').addEventListener('click', () => {
      panel.remove();
      openMenu(); // 返回时重新打开菜单
    });
    
    // 完成按钮
    panel.querySelector('.fb-style-save').addEventListener('click', () => {
      saveStyleSettings(panel);
      panel.remove();
      openMenu(); // 保存后重新打开菜单
    });
    
    // 样式类型切换
    panel.querySelectorAll('.fb-style-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const type = tab.dataset.type;
        panel.querySelectorAll('.fb-style-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        panel.querySelectorAll('.fb-style-panel-content').forEach(p => p.classList.remove('active'));
        panel.querySelector(`[data-panel="${type}"]`).classList.add('active');
      });
    });
    
    // 本地上传
    const fileInput = panel.querySelector('#fb-image-file');
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          panel.querySelector('#fb-image-url').value = event.target.result;
        };
        reader.readAsDataURL(file);
      }
    });
    
    // 预览图片
    panel.querySelector('#fb-preview-image').addEventListener('click', () => {
      const url = panel.querySelector('#fb-image-url').value.trim();
      if (url) {
        previewImageStyle(url);
      } else {
        if (typeof showToast === 'function') {
          showToast('请先输入或上传图片');
        }
      }
    });
    
    // 重置图片
    panel.querySelector('#fb-reset-image').addEventListener('click', () => {
      panel.querySelector('#fb-image-url').value = '';
      if (typeof showToast === 'function') {
        showToast('已清空图片设置');
      }
    });
    
    // 预览CSS
    panel.querySelector('#fb-preview-css').addEventListener('click', () => {
      const css = panel.querySelector('#fb-custom-css').value.trim();
      previewCustomCSS(css);
    });
    
    // 重置CSS
    panel.querySelector('#fb-reset-css').addEventListener('click', () => {
      panel.querySelector('#fb-custom-html').value = getDefaultHTML();
      panel.querySelector('#fb-custom-css').value = getDefaultCSS();
      if (typeof showToast === 'function') {
        showToast('已重置为默认模板');
      }
    });
    
    // 导出CSS
    panel.querySelector('#fb-export-css').addEventListener('click', () => {
      const html = panel.querySelector('#fb-custom-html').value.trim();
      const css = panel.querySelector('#fb-custom-css').value.trim();
      
      if (!html && !css) {
        if (typeof showToast === 'function') {
          showToast('没有可导出的内容');
        }
        return;
      }
      
      const content = `/* 悬浮球自定义样式 */\n\n/* HTML结构 */\n/*\n${html}\n*/\n\n/* CSS样式 */\n${css}`;
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'floating-ball-custom.txt';
      a.click();
      URL.revokeObjectURL(url);
      
      if (typeof showToast === 'function') {
        showToast('样式已导出');
      }
    });
    
    // 导入CSS
    panel.querySelector('#fb-import-css').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.css,text/plain,text/css';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (event) => {
            const content = event.target.result;
            
            // 尝试解析HTML和CSS
            const htmlMatch = content.match(/\/\*\s*HTML结构\s*\*\/\s*\/\*\s*([\s\S]*?)\s*\*\//);
            const cssMatch = content.match(/\/\*\s*CSS样式\s*\*\/\s*([\s\S]*)/);
            
            if (htmlMatch && htmlMatch[1]) {
              panel.querySelector('#fb-custom-html').value = htmlMatch[1].trim();
            }
            
            if (cssMatch && cssMatch[1]) {
              panel.querySelector('#fb-custom-css').value = cssMatch[1].trim();
            } else {
              // 如果没有找到标记，就把整个内容当作CSS
              panel.querySelector('#fb-custom-css').value = content;
            }
            
            if (typeof showToast === 'function') {
              showToast('样式已导入');
            }
          };
          reader.readAsText(file);
        }
      };
      input.click();
    });
  }
  
  // 保存样式设置
  function saveStyleSettings(panel) {
    const activeTab = panel.querySelector('.fb-style-tab.active');
    const type = activeTab.dataset.type;
    
    floatingBallState.style.type = type;
    
    if (type === 'image') {
      floatingBallState.style.imageUrl = panel.querySelector('#fb-image-url').value.trim();
    } else if (type === 'custom-css') {
      floatingBallState.style.customHTML = panel.querySelector('#fb-custom-html').value.trim();
      floatingBallState.style.customCSS = panel.querySelector('#fb-custom-css').value.trim();
    }
    
    saveState();
    applyStyle();
    
    if (typeof showToast === 'function') {
      showToast('样式已保存');
    }
  }
  
  // 应用样式
  function applyStyle() {
    if (!ballEl) return;
    
    // 清除之前的自定义样式
    removeCustomCSS();
    
    if (floatingBallState.style.type === 'image' && floatingBallState.style.imageUrl) {
      ballEl.innerHTML = `<img src="${floatingBallState.style.imageUrl}" alt="悬浮球" class="fb-custom-image">`;
    } else if (floatingBallState.style.type === 'custom-css') {
      if (floatingBallState.style.customHTML) {
        ballEl.innerHTML = floatingBallState.style.customHTML;
      } else {
        ballEl.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <line x1="4" y1="12" x2="20" y2="12"></line>
            <line x1="4" y1="18" x2="20" y2="18"></line>
          </svg>
        `;
      }
      if (floatingBallState.style.customCSS) {
        applyCustomCSS(floatingBallState.style.customCSS);
      }
    } else {
      ballEl.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="4" y1="6" x2="20" y2="6"></line>
          <line x1="4" y1="12" x2="20" y2="12"></line>
          <line x1="4" y1="18" x2="20" y2="18"></line>
        </svg>
      `;
    }
  }
  
  // 应用自定义CSS
  function applyCustomCSS(css) {
    removeCustomCSS();
    
    const styleEl = document.createElement('style');
    styleEl.id = 'fb-custom-style';
    styleEl.textContent = `#floating-ball { ${css} }`;
    document.head.appendChild(styleEl);
  }
  
  // 移除自定义CSS
  function removeCustomCSS() {
    const existingStyle = document.getElementById('fb-custom-style');
    if (existingStyle) {
      existingStyle.remove();
    }
  }
  
  // 预览图片样式
  function previewImageStyle(url) {
    if (!ballEl) return;
    
    const tempImg = new Image();
    tempImg.onload = () => {
      ballEl.innerHTML = `<img src="${url}" alt="悬浮球" class="fb-custom-image">`;
      if (typeof showToast === 'function') {
        showToast('预览已应用，点击完成保存');
      }
    };
    tempImg.onerror = () => {
      if (typeof showToast === 'function') {
        showToast('图片加载失败，请检查URL');
      }
    };
    tempImg.src = url;
  }
  
  // 预览自定义CSS
  function previewCustomCSS(css) {
    if (!ballEl) return;
    
    const html = document.querySelector('#fb-custom-html')?.value.trim();
    
    if (html) {
      ballEl.innerHTML = html;
    }
    
    removeCustomCSS();
    if (css) {
      applyCustomCSS(css);
    }
    
    if (typeof showToast === 'function') {
      showToast('预览已应用，点击完成保存');
    }
  }

  // 暴露全局方法
  window.initFloatingBall = initFloatingBall;
  window.toggleFloatingBall = function(enabled) {
    if (enabled && !floatingBallState.enabled) {
      floatingBallState.enabled = true;
      
      // 同步更新全局设置
      if (typeof state !== 'undefined' && state.globalSettings) {
        state.globalSettings.floatingBallEnabled = true;
      }
      
      saveState();
      
      // 直接初始化，不需要刷新页面
      initFloatingBall();
    } else if (!enabled && floatingBallState.enabled) {
      closeBall();
    }
  };

})();

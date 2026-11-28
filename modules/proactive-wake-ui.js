// ============================================================
// proactive-wake-ui.js — AI 主动消息管理 UI
// v0.1.85 粉白色系
//
// 入口: chat-list 顶部 banner, 点开进管理页面
// 页面: 玩法说明 + 订阅状态 + 任务列表 + 创建表单
// ============================================================

(function() {
  'use strict';

  // ===== 粉白色系配色 =====
  const COLORS = {
    primary: '#FF8FA3',        // 主粉
    primaryDark: '#E56B82',    // hover 加深
    light: '#FFB6C1',          // 浅粉
    bgWarm: '#FDF6F8',         // 暖白
    bgWhite: '#FFFFFF',        // 白
    textDark: '#5C4A52',       // 暗紫文字
    textMid: '#8B7280',        // 中灰粉
    border: '#FFE4E9',         // 边框粉
    success: '#7BC89C',        // 绿色（已订阅）
    warning: '#F5A88B',        // 橙（提示）
    shadow: '0 2px 8px rgba(255, 143, 163, 0.15)'
  };

  // ===== 创建 banner 元素 (插入到 chat-list 顶部) =====
  function createBanner() {
    const banner = document.createElement('div');
    banner.id = 'proactive-wake-banner';
    banner.className = 'pw-banner';
    banner.innerHTML = `
      <div class="pw-banner-inner">
        <div class="pw-banner-icon">🌸</div>
        <div class="pw-banner-text">
          <div class="pw-banner-title">AI 主动消息</div>
          <div class="pw-banner-status">检测中...</div>
        </div>
        <div class="pw-banner-arrow">›</div>
      </div>
    `;
    banner.addEventListener('click', openManager);
    return banner;
  }

  // ===== 更新 banner 状态 =====
  async function updateBanner() {
    const banner = document.getElementById('proactive-wake-banner');
    if (!banner) return;

    const statusEl = banner.querySelector('.pw-banner-status');
    if (!window.ProactiveWake) {
      statusEl.textContent = '模块未加载';
      return;
    }

    try {
      const status = await window.ProactiveWake.getSubscriptionStatus();
      if (!status.supported) {
        statusEl.textContent = '❌ 浏览器不支持推送';
        banner.classList.add('pw-banner-disabled');
      } else if (Notification.permission === 'denied') {
        statusEl.textContent = '⚠️ 通知权限被拒（iOS 设置 → Safari → 网站通知）';
        banner.classList.add('pw-banner-warning');
      } else if (status.subscribed) {
        statusEl.textContent = '✅ 已启用';
        banner.classList.add('pw-banner-active');
      } else {
        statusEl.textContent = '未启用 · 点此开启';
        banner.classList.add('pw-banner-inactive');
      }
    } catch (e) {
      statusEl.textContent = `❌ 错误: ${e.message}`;
    }
  }

  // ===== 打开管理页面 =====
  function openManager() {
    // 如果已经打开, 不重复创建
    if (document.getElementById('pw-manager-page')) {
      return;
    }

    const page = document.createElement('div');
    page.id = 'pw-manager-page';
    page.className = 'pw-page';
    page.innerHTML = `
      <div class="pw-header">
        <button class="pw-back-btn" id="pw-back-btn">‹</button>
        <div class="pw-header-title">🌸 AI 主动消息</div>
        <div class="pw-header-spacer"></div>
      </div>

      <div class="pw-content">
        <!-- 玩法说明卡片 -->
        <div class="pw-card pw-card-tutorial">
          <div class="pw-card-title">📖 玩法说明</div>
          <div class="pw-card-body">
            <p><b>AI 主动消息</b>：让角色在你不聊天的时候，也能主动给你发消息。像是真人微信里，对方突然想起你、给你发一条问候。</p>
            <p><b>怎么用</b>（3 种方式）：</p>
            <ol>
              <li>点下面的 <b>"开启推送"</b> 按钮，授权通知权限</li>
              <li><b>手动创建</b>：创建定时任务（固定消息 自己写 / AI 生成 让 LLM 自动想话题）</li>
              <li><b>🤖 AI 自主决定（v0.1.86+）</b>：跟 AI 聊天时，AI 按人设自主决定要不要给你设个提醒/问候——你不用手动操作，AI 自己看着办</li>
              <li>选 <b>投递方式</b>：📱应用内（默认） / 🔔系统推送（杀后台 + 锁屏能收到）</li>
              <li>角色级 <b>[启用主动消息]</b> 开关：关掉某角色，两个渠道都不发（防刷屏）</li>
            </ol>
            <p><b>频率控制</b>：</p>
            <ul>
              <li><b>AI 设提醒冷却</b>（默认 30 分钟，可调 0-120）：同一角色聊完天后 X 分钟内 AI 不能重复设提醒，防刷屏</li>
              <li><b>睡眠时间</b>（00:00-06:00 硬约束）：AI 不会在这段时间推消息，只在 chat history 留个"想发但怕吵醒你"的小气泡</li>
            </ul>
            <p><b>⚠️ iPhone 重要提示</b>：</p>
            <ul>
              <li>必须先把 PWA <b>加到主屏幕</b></li>
              <li>iOS 设置 → <b>Safari</b> → 高级 → <b>网站通知</b> → 打开</li>
              <li>推送只在 <b>杀后台 + 锁屏</b> 时才真正触发（iOS 限制）</li>
            </ul>
            <p><b>频率建议</b>：每天 1-3 条，不要刷屏</p>
          </div>
        </div>

        <!-- 订阅状态卡片 -->
        <div class="pw-card">
          <div class="pw-card-title">🔔 推送状态</div>
          <div class="pw-card-body">
            <div class="pw-status-row">
              <span>通知权限：</span>
              <b id="pw-permission-status">检测中...</b>
            </div>
            <div class="pw-status-row">
              <span>订阅状态：</span>
              <b id="pw-subscription-status">检测中...</b>
            </div>
            <div class="pw-button-row">
              <button class="pw-btn pw-btn-primary" id="pw-subscribe-btn">🔔 开启推送</button>
              <button class="pw-btn pw-btn-secondary" id="pw-unsubscribe-btn" style="display:none;">关闭推送</button>
              <button class="pw-btn pw-btn-secondary" id="pw-test-push-btn">🧪 测试推送</button>
            </div>
          </div>
        </div>

        <!-- 冷却时间设置卡片 (v0.2.18+: 改描述, 只对 push 模式手动创建任务生效) -->
        <div class="pw-card">
          <div class="pw-card-title">⏱ AI 设提醒冷却（仅 push 模式手动建任务生效）</div>
          <div class="pw-card-body">
            <div class="pw-status-row" style="align-items:center;">
              <span>同一角色聊天结束后</span>
              <div class="pw-cooldown-input">
                <input type="number" id="pw-cooldown-input" min="0" max="120" step="1" value="30" style="width:60px;text-align:center;">
                <span>分钟内, 在 push 模式手动 [+ 创建任务] 时被拦截</span>
              </div>
            </div>
            <div class="settings-desc" style="font-size:12px;color:#8B7280;margin-top:6px;">
              0 = 不限流. 默认 30 分钟. 改完即生效.
              <br><b style="color:#E56B82;">⚠️ 仅 push 模式</b>手动 [+ 创建任务] 时拦截, app 模式新巡视不走这个冷却, 靠 LLM 自由决定 (50% skip 软提示 + 锲而不舍 retry context).
            </div>
          </div>
        </div>

        <!-- 投递方式选择 (v0.1.90+) -->
        <div class="pw-card">
          <div class="pw-card-title">📡 投递方式（用户自选）</div>
          <div class="pw-card-body">
            <div class="pw-radio-group">
              <label class="pw-radio-row">
                <input type="radio" name="pw-delivery-mode" value="app">
                <div class="pw-radio-content">
                  <div class="pw-radio-title">📱 应用内（默认）</div>
                  <div class="pw-radio-desc">AI 前端巡视插入消息 + 弹系统通知（受"系统级通知"总开关控制）。<br>PWA 开着才能用，杀后台失效（不依赖 push-server）。</div>
                </div>
              </label>
              <label class="pw-radio-row">
                <input type="radio" name="pw-delivery-mode" value="push">
                <div class="pw-radio-content">
                  <div class="pw-radio-title">🔔 系统推送</div>
                  <div class="pw-radio-desc">弹系统通知，<b>杀后台 + 锁屏都能收到</b>。<br>需先在上面"通知 → 启用服务器推送"配好服务器地址。<br>PWA 活着也走 push-server（不需要等杀后台）。</div>
                </div>
              </label>
            </div>
            <div class="settings-desc" style="font-size:12px;color:#8B7280;margin-top:6px;">
              💡 这是<b>渠道选择</b>，只管"用什么发"；角色能不能主动发由角色设置里的 <b>[启用主动消息]</b> 开关控制。
            </div>
          </div>
        </div>

        <!-- 睡眠时间设置卡 (v0.2.18+ 新巡视) -->
        <div class="pw-card" id="pw-sleep-settings">
          <div class="pw-card-title">🌙 睡眠时间设置</div>
          <div class="pw-card-body">
            <div class="pw-status-row" style="align-items:center;">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="pw-sleep-enabled-switch" checked>
                <span>启用睡眠时间跳过（关闭后新巡视 24 小时不间断）</span>
              </label>
            </div>
            <div id="pw-sleep-time-range" style="margin-top:10px;">
              <div class="pw-status-row" style="align-items:center;">
                <span>睡眠开始（小时 0-23）：</span>
                <input type="number" id="pw-sleep-start-hour" min="0" max="23" value="23" style="width:60px; text-align:center;">
              </div>
              <div class="pw-status-row" style="align-items:center;">
                <span>睡眠结束（小时 0-23）：</span>
                <input type="number" id="pw-sleep-end-hour" min="0" max="23" value="8" style="width:60px; text-align:center;">
              </div>
            </div>
            <div class="settings-desc" style="font-size:12px; color:#8B7280; margin-top:6px;">
              💡 支持跨午夜（如 23-8 = 晚上 11 点到早上 8 点不巡视；1-6 = 凌晨 1 点到 6 点不巡视）。起止相同 = 全天巡视。改完即生效。
            </div>
          </div>
        </div>

        <!-- 任务列表卡片 (v0.2.07+: app 模式隐藏, push 模式显示) -->
        <div class="pw-card pw-card-task-list">
          <div class="pw-card-title">📋 已创建任务 <span id="pw-task-count" class="pw-task-count"></span></div>
          <div class="pw-card-body">
            <div id="pw-task-list" class="pw-task-list">
              <div class="pw-empty">加载中...</div>
            </div>
            <div class="pw-button-row">
              <button class="pw-btn pw-btn-primary" id="pw-create-task-btn">+ 创建新任务</button>
              <button class="pw-btn pw-btn-secondary" id="pw-refresh-tasks-btn">🔄 刷新</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 创建任务弹窗 -->
      <div id="pw-create-modal" class="pw-modal" style="display:none;">
        <div class="pw-modal-content">
          <div class="pw-modal-header">
            <div class="pw-modal-title">创建新任务</div>
            <button class="pw-modal-close" id="pw-modal-close">×</button>
          </div>
          <div class="pw-modal-body">
            <div class="pw-form-row">
              <label>选择角色</label>
              <select id="pw-form-chat"></select>
            </div>
            <div class="pw-form-row">
              <label>任务类型</label>
              <select id="pw-form-type">
                <option value="fixed">固定消息（自己写内容）</option>
                <option value="ai-msg">AI 写消息（你只写提示词，AI 决定具体说什么）</option>
              </select>
            </div>
            <div class="pw-form-row" id="pw-form-message-row">
              <label>消息内容</label>
              <textarea id="pw-form-message" placeholder="例：晚上好呀，今天忙不忙？"></textarea>
            </div>
            <div class="pw-form-row" id="pw-form-prompt-row" style="display:none;">
              <label>给 AI 的提示词（你想提醒什么）</label>
              <textarea id="pw-form-prompt" placeholder="例：提醒我喝水 / 问问我今天吃了什么 / 让我记得起床"></textarea>
            </div>
            <div class="pw-form-row">
              <label>提醒时间</label>
              <input type="datetime-local" id="pw-form-first-send-time" />
            </div>
          </div>
          <div class="pw-modal-footer">
            <button class="pw-btn pw-btn-secondary" id="pw-modal-cancel">取消</button>
            <button class="pw-btn pw-btn-primary" id="pw-modal-submit">创建</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(page);

    // 绑定事件
    document.getElementById('pw-back-btn').addEventListener('click', closeManager);
    document.getElementById('pw-subscribe-btn').addEventListener('click', handleSubscribe);
    document.getElementById('pw-unsubscribe-btn').addEventListener('click', handleUnsubscribe);
    document.getElementById('pw-test-push-btn').addEventListener('click', handleTestPush);
    document.getElementById('pw-create-task-btn').addEventListener('click', openCreateModal);
    document.getElementById('pw-refresh-tasks-btn').addEventListener('click', loadTaskList);
    document.getElementById('pw-modal-close').addEventListener('click', closeCreateModal);
    document.getElementById('pw-modal-cancel').addEventListener('click', closeCreateModal);
    document.getElementById('pw-modal-submit').addEventListener('click', handleCreateTask);
    document.getElementById('pw-form-type').addEventListener('change', (e) => {
      const type = e.target.value;
      document.getElementById('pw-form-message-row').style.display = type === 'fixed' ? '' : 'none';
      document.getElementById('pw-form-prompt-row').style.display = type === 'ai-msg' ? '' : 'none';
    });

    // 加载数据
    loadSubscriptionStatus();
    loadCooldownSetting();
    loadDeliveryMode();
    loadSleepSettings();
    loadTaskList();
  }

  // ===== 关闭管理页面 =====
  function closeManager() {
    const page = document.getElementById('pw-manager-page');
    if (page) page.remove();
    updateBanner();  // 关闭后刷新 banner 状态
  }

  // ===== 加载订阅状态 =====
  async function loadSubscriptionStatus() {
    const permEl = document.getElementById('pw-permission-status');
    const subEl = document.getElementById('pw-subscription-status');
    const subBtn = document.getElementById('pw-subscribe-btn');
    const unsubBtn = document.getElementById('pw-unsubscribe-btn');

    try {
      const status = await window.ProactiveWake.getSubscriptionStatus();
      if (!status.supported) {
        permEl.textContent = '❌ 不支持';
        subEl.textContent = status.reason || '浏览器不支持';
        subBtn.style.display = 'none';
        return;
      }
      permEl.textContent = status.permission === 'granted' ? '✅ 已授权' :
                            status.permission === 'denied' ? '❌ 被拒' : '⚠️ 未授权';
      subEl.textContent = status.subscribed ? '✅ 已订阅' : '❌ 未订阅';

      if (status.subscribed) {
        subBtn.style.display = 'none';
        unsubBtn.style.display = '';
      } else {
        subBtn.style.display = '';
        unsubBtn.style.display = 'none';
      }
    } catch (e) {
      permEl.textContent = `错误: ${e.message}`;
    }
  }

  // ===== 加载冷却设置 =====
  function loadCooldownSetting() {
    const input = document.getElementById('pw-cooldown-input');
    if (!input) return;
    const current = window.state?.globalSettings?.proactiveCooldownMinutes;
    input.value = (typeof current === 'number' && current >= 0) ? current : 30;

    // 实时保存 (改完即生效, 不需要保存按钮)
    input.addEventListener('change', () => {
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 0) val = 0;
      if (val > 120) val = 120;
      input.value = val;
      if (!window.state.globalSettings) window.state.globalSettings = {};
      window.state.globalSettings.proactiveCooldownMinutes = val;
      // 持久化到 localStorage
      try {
        localStorage.setItem('globalSettings', JSON.stringify(window.state.globalSettings));
      } catch (e) {
        console.warn('[proactive-wake-ui] 保存 globalSettings 失败:', e.message);
      }
      console.log('[proactive-wake-ui] 冷却时间已更新为', val, '分钟');
    });
  }

  // ===== 加载睡眠时间设置 (v0.2.18+) =====
  // 开关 + 起始/结束小时, 改完即生效, 持久化到 localStorage
  function loadSleepSettings() {
    const enabledSwitch = document.getElementById('pw-sleep-enabled-switch');
    const startInput = document.getElementById('pw-sleep-start-hour');
    const endInput = document.getElementById('pw-sleep-end-hour');
    const timeRange = document.getElementById('pw-sleep-time-range');
    if (!enabledSwitch || !startInput || !endInput || !timeRange) return;

    const settings = window.state?.globalSettings || {};

    // 加载开关 (默认 true)
    enabledSwitch.checked = settings.inAppProactiveSleepEnabled !== false;
    timeRange.style.display = enabledSwitch.checked ? 'block' : 'none';

    // 加载小时数 (默认 23-8)
    const startHour = (typeof settings.inAppProactiveSleepStartHour === 'number'
      && settings.inAppProactiveSleepStartHour >= 0
      && settings.inAppProactiveSleepStartHour <= 23)
      ? settings.inAppProactiveSleepStartHour : 23;
    const endHour = (typeof settings.inAppProactiveSleepEndHour === 'number'
      && settings.inAppProactiveSleepEndHour >= 0
      && settings.inAppProactiveSleepEndHour <= 23)
      ? settings.inAppProactiveSleepEndHour : 8;
    startInput.value = startHour;
    endInput.value = endHour;

    // 开关变化: 保存 + 显示/隐藏时间
    enabledSwitch.addEventListener('change', () => {
      if (!window.state.globalSettings) window.state.globalSettings = {};
      window.state.globalSettings.inAppProactiveSleepEnabled = enabledSwitch.checked;
      timeRange.style.display = enabledSwitch.checked ? 'block' : 'none';
      try {
        localStorage.setItem('globalSettings', JSON.stringify(window.state.globalSettings));
      } catch (e) {
        console.warn('[proactive-wake-ui] 保存睡眠开关失败:', e.message);
      }
      console.log('[proactive-wake-ui] 睡眠时间跳过已', enabledSwitch.checked ? '启用' : '关闭 (24小时巡视)');
    });

    // 时间输入变化: 校验 + 保存
    function saveHour(input, field) {
      let val = parseInt(input.value, 10);
      if (isNaN(val) || val < 0) val = 0;
      if (val > 23) val = 23;
      input.value = val;
      if (!window.state.globalSettings) window.state.globalSettings = {};
      window.state.globalSettings[field] = val;
      try {
        localStorage.setItem('globalSettings', JSON.stringify(window.state.globalSettings));
      } catch (e) {
        console.warn(`[proactive-wake-ui] 保存 ${field} 失败:`, e.message);
      }
      console.log(`[proactive-wake-ui] ${field} 已更新为 ${val} 时`);
    }
    startInput.addEventListener('change', () => saveHour(startInput, 'inAppProactiveSleepStartHour'));
    endInput.addEventListener('change', () => saveHour(endInput, 'inAppProactiveSleepEndHour'));
  }

  // ===== 加载投递方式设置 (v0.1.91+) =====
  // 渠道选择: app = 应用内 (默认) / push = 系统推送
  // 注: 跟角色级总开关 (chat.settings.proactiveEnabled) 是两个独立维度
  function loadDeliveryMode() {
    const radios = document.querySelectorAll('input[name="pw-delivery-mode"]');
    if (radios.length === 0) return;
    let current = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
    // 老数据兼容: 之前默认是 'app', 老的 'both' 自动降级到 'push' (用户主动选的) 或者 'app'
    if (current !== 'app' && current !== 'push') current = 'app';
    radios.forEach(radio => {
      if (radio.value === current) {
        radio.checked = true;
      } else {
        radio.checked = false;
      }
    });
    // 同步 chat 设置页的角色级开关 (如果已打开)
    syncOldProactiveSwitch(current);
    // v0.2.07+: 根据 mode 切换 UI (app 模式隐藏任务列表 + 显示说明卡, push 模式反之)
    updateUiForDeliveryMode(current);

    // v0.2.12+: 加载时如果 mode=push, 自动 sync 当前 chat 的 push config (PWA 重开也能用)
    if (current === 'push') {
      syncCurrentChatPushConfig().catch(e => console.warn('[proactive-wake-ui] 启动 sync 失败:', e.message));
    }

    // 实时保存 (change 触发)
    radios.forEach(radio => {
      radio.addEventListener('change', async () => {
        if (!radio.checked) return;
        const mode = radio.value;
        if (mode !== 'app' && mode !== 'push') return;  // 非法值忽略
        if (!window.state.globalSettings) window.state.globalSettings = {};
        window.state.globalSettings.proactiveDeliveryMode = mode;
        // 持久化
        try {
          localStorage.setItem('globalSettings', JSON.stringify(window.state.globalSettings));
        } catch (e) {
          console.warn('[proactive-wake-ui] 保存投递方式失败:', e.message);
        }
        // v0.2.07+: 切 mode 时立即更新 UI (隐藏/显示 任务列表 + 说明卡)
        updateUiForDeliveryMode(mode);
        // 立即重启 v0.2.17 in-app 巡视 (mode 变了)
        try {
          if (typeof window.InAppProactive?.stop === 'function') window.InAppProactive.stop();
          if (mode === 'app') {
            if (typeof window.InAppProactive?.start === 'function') {
              window.InAppProactive.start();
              console.log(`[proactive-wake-ui] 投递模式 = 应用内, v0.2.17 已启动`);
            }
          } else {
            console.log(`[proactive-wake-ui] 投递模式 = 系统推送, v0.2.17 已停止 (推送任务后期由 push-server 接管)`);
          }
        } catch (e) {
          console.warn('[proactive-wake-ui] 重启 v0.2.17 失败:', e.message);
        }
        // v0.2.30.6: 切 app 模式不再 unsync (PWA 期望"选 app 模式两边都收", 不能因为切 mode radio 就删 push 行)
        //   真凶: v0.2.20 设计的 unsync 切 app 模式时调, 调试时切来切去就丢 push_user_config 行
        //   修法: 切 app 模式什么都不做, push 行永远在, server 巡视永远 work
        //   sync 仍调 (切 push 模式时 sync 重建 / 更新 push_user_config 行)
        try {
          if (mode === 'push') {
            await syncCurrentChatPushConfig();
          }
          // v0.2.30.6: 删 unsyncCurrentChatPushConfig 调用 — 切 app 模式不再调 server
        } catch (e) {
          console.warn('[proactive-wake-ui] sync push config 失败:', e.message);
        }
        // 同步 chat 设置页的角色级开关 + hint
        syncOldProactiveSwitch(mode);
        // 弹提示
        const tip = mode === 'app'
          ? '✅ 已切换到应用内 (只在 chat 插消息, 无系统通知, PWA 开着才能用)'
          : '✅ 已切换到系统推送 (杀后台 + 锁屏都能收到, 需先配服务器地址)';
        if (typeof showToast === 'function') showToast(tip);
        else alert(tip);
      });
    });
  }

  // ===== v0.2.20: sync 所有 chat 的 push config 到 push-server =====
  // 投递方式切到 push 时调, push-server 端 20 分钟巡视会读这张表调 LLM
  // 即使 PWA 死了, push-server 也能照这个 config 调 LLM 决定要不要发
  // v0.2.20 修 (user 2026-08-13 16:23 揭穿): 不再限制 activeChatId
  //   切 push 模式时 user 可能在任何界面 (主页/角色列表/聊天详情/设置), activeChatId 经常是 null
  //   user 原话: "切 push 模式时本来就不在 chat 里, activeChatId 限制是设计 bug"
  //   改成遍历所有开了 [启用主动消息] 的 chat 一起 sync
  //   修前: push_user_config 0 行 → push-server scheduler 没事干 → 一周 0 推送
  //   修后: 切 push 模式时 push_user_config 立即有 N 行 (N = 开 proactiveEnabled 的 chat 数)
  // v0.2.20+ 加 lastUserMsgAt: PWA 1 分钟轮询更新 user 最后发言时间, server 巡视时 < 5 分钟前 → 跳过整个 chat
  //   (user 2026-08-13: "看最后一条记录的时间来决定要不要巡视", 避免正在聊天的 chat 被推送打扰)
  async function syncCurrentChatPushConfig() {
    const state = window.state;
    if (!state) return;

    // 拿 push-server URL
    const serverUrl = (state.globalSettings?.systemNotification?.pushServer?.serverUrl || '').replace(/\/$/, '');
    if (!serverUrl) {
      console.warn('[proactive-wake-ui] 没配 push-server URL, 跳过 sync push config');
      return;
    }

    // 拿 LLM 配置 (主 API, v0.2.09 修过字段位置)
    // v0.2.12 修: 优先用直连 URL (apiUrl/mainApiUrl), 不传 proxyUrl
    //   原因: push-server 在云端, 不需要 CORS 绕过. 传 proxyUrl (CF worker) 反而连不上
    //   PWA 自己用 proxyUrl 是因为用户电脑没梯, push-server 没这个问题
    // v0.2.30.7 改: 跟 chat 一样走 resolveApiSlotConfig('main') 拿最新预设值
    //   真凶: v0.2.27 send-btn sync 读 state.apiConfig, 但悬浮球切预设只改 mainEndpointPresetId + model
    //         不改 state.apiConfig.proxyUrl/apiKey (保留老值), sync 发的就是老 url/key + 新 model = 错配
    //   修法: 调 resolveApiSlotConfig('main') 实时读 db.apiPresets 拿最新 url/key/model, 跟 chat 调 LLM 行为一致
    let apiConfig = state.apiConfig || {};
    if (typeof window.resolveApiSlotConfig === 'function') {
      try {
        const resolved = await window.resolveApiSlotConfig('main');
        if (resolved && resolved.proxyUrl && resolved.apiKey) {
          apiConfig = resolved;
        }
      } catch (e) {
        console.warn('[proactive-wake-ui] resolveApiSlotConfig 失败, fallback state.apiConfig:', e.message);
      }
    }
    const llmApiUrl = apiConfig.proxyUrl || apiConfig.apiUrl;
    const llmApiKey = apiConfig.apiKey;
    const llmModel = apiConfig.model;

    // v0.2.20 改: 遍历所有 proactiveEnabled chat (不再依赖 activeChatId)
    const enabledChats = Object.values(state.chats).filter(c => c && c.settings?.proactiveEnabled);
    if (enabledChats.length === 0) {
      console.log('[proactive-wake-ui] 没有 chat 开启 [启用主动消息], 跳过 sync push config');
      return;
    }

    const userId = getOrCreatePushUserId();
    for (const chat of enabledChats) {
      const lastUserMsgAt = getLastUserMsgAt(chat);
      await doSyncChat(chat, userId, serverUrl, llmApiUrl, llmApiKey, llmModel, lastUserMsgAt);
    }

    // v0.2.20+ 启动 1 分钟轮询 lastUserMsgAt (切 push 模式才需要)
    startLastUserMsgAtSyncTimer();
  }

  // ===== v0.2.20+: 拿 chat 最后 user 消息的 timestamp (unix ms) =====
  function getLastUserMsgAt(chat) {
    if (!chat || !Array.isArray(chat.history) || chat.history.length === 0) return null;
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (m && m.role === 'user' && typeof m.timestamp === 'number') return m.timestamp;
    }
    return null;
  }

  // ===== v0.2.20+: 1 分钟轮询 lastUserMsgAt (只 mini-sync, 不重传 contextSummary) =====
  // 切 push 模式时启动, 切 app 模式时停止
  let lastUserMsgAtSyncTimer = null;
  let lastUserMsgAtSentCache = new Map();  // chatId -> last timestamp sent, 避免重复 POST
  function startLastUserMsgAtSyncTimer() {
    if (lastUserMsgAtSyncTimer) return;  // 已启动
    lastUserMsgAtSyncTimer = setInterval(async () => {
      const state = window.state;
      if (!state) return;
      const serverUrl = (state.globalSettings?.systemNotification?.pushServer?.serverUrl || '').replace(/\/$/, '');
      if (!serverUrl) return;
      const apiConfig = state.apiConfig || {};
      const llmApiUrl = apiConfig.apiUrl || apiConfig.mainApiUrl || apiConfig.proxyUrl;
      const llmApiKey = apiConfig.apiKey || apiConfig.mainApiKey;
      const llmModel = apiConfig.model || apiConfig.mainModel;
      const userId = getOrCreatePushUserId();

      const enabledChats = Object.values(state.chats).filter(c => c && c.settings?.proactiveEnabled);
      for (const chat of enabledChats) {
        const lastUserMsgAt = getLastUserMsgAt(chat);
        if (lastUserMsgAt == null) continue;
        // 跟上次一样就不发 (避免无意义 POST)
        if (lastUserMsgAtSentCache.get(chat.id) === lastUserMsgAt) continue;
        lastUserMsgAtSentCache.set(chat.id, lastUserMsgAt);
        await doSyncChat(chat, userId, serverUrl, llmApiUrl, llmApiKey, llmModel, lastUserMsgAt);
      }
    }, 60 * 1000);
    console.log('[proactive-wake-ui] 1 分钟轮询 lastUserMsgAt 启动');
  }
  function stopLastUserMsgAtSyncTimer() {
    if (lastUserMsgAtSyncTimer) {
      clearInterval(lastUserMsgAtSyncTimer);
      lastUserMsgAtSyncTimer = null;
    }
    lastUserMsgAtSentCache.clear();
    console.log('[proactive-wake-ui] 1 分钟轮询 lastUserMsgAt 停止');
  }

  // ===== v0.2.20: 实际 sync 单个 chat 的 push config =====
  // 抽出来便于遍历调用, 之前都堆在 syncCurrentChatPushConfig 里
  // v0.2.20+: 复用 buildProactiveContext(chat) 算完整 system prompt (含世界书/日记/向量记忆/双源记忆/aiPersona)
  //   之前 LLM 只收到 contactPersonality + contextSummary 末 20 条, 缺长期记忆导致"对不上话"
  //   push-server handleProactivePatrol 读 push_user_config.context_full 字段当 system prompt 主体
  async function doSyncChat(chat, userId, serverUrl, llmApiUrl, llmApiKey, llmModel, lastUserMsgAt) {
    const chatId = chat.id;
    const contactName = chat.name || chatId;
    const contactPersonality = chat.settings?.aiPersona || chat.settings?.characterPrompt || chat.settings?.characterPersonality || '';

    let contextSummary = '';
    if (Array.isArray(chat.history) && chat.history.length > 0) {
      const recent = chat.history.slice(-20);
      contextSummary = recent.map(m => {
        if (!m) return '';
        const role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'AI' : (m.role || '?'));
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) text = m.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('');
        return text ? `${role}: ${text.substring(0, 200)}` : '';
      }).filter(Boolean).join('\n');
    }

    // v0.2.20+: 复用 buildProactiveContext 算完整 system prompt (含长期记忆/世界书/变量记忆/双源记忆/aiPersona)
    // try/catch: 内部调 filterHistoryWithDoNotSendRules 等可能依赖其他模块, 出错就回退 (不传 contextFull)
    let contextFull = null;
    if (typeof window.buildProactiveContext === 'function') {
      try {
        const ctx = await window.buildProactiveContext(chat, { queryText: '' });
        if (ctx && typeof ctx.systemPrompt === 'string' && ctx.systemPrompt.length > 0) {
          contextFull = ctx.systemPrompt;
        }
      } catch (e) {
        console.warn(`[proactive-wake-ui] buildProactiveContext 失败, 回退 contextSummary: chatId=${chatId}`, e.message);
      }
    }

    // v0.2.28: 把 PWA 端应用内睡眠时间设置也传给 push-server (跟应用内模式共享同一组配置, 不用 PWA 端另外配置)
    //   之前 push-server 端硬编码 00:00-06:00, 跟 PWA 端默认 23:00-08:00 不一致 (06-08 + 23-00 push-server 可能发但 PWA 不发)
    //   修法: 读 state.globalSettings.inAppProactiveSleep* 3 个字段, 传给 push-server 存 push_user_config.inapp_sleep_*
    //         push-server runServerPatrolTick 代码层做 sleep check (不调 LLM, 直接 skip)
    const sleepSettings = window.state?.globalSettings || {};
    const inAppSleepEnabled = sleepSettings.inAppProactiveSleepEnabled !== false;
    const inAppSleepStartHour = (typeof sleepSettings.inAppProactiveSleepStartHour === 'number'
      && sleepSettings.inAppProactiveSleepStartHour >= 0
      && sleepSettings.inAppProactiveSleepStartHour <= 23)
      ? sleepSettings.inAppProactiveSleepStartHour : 23;
    const inAppSleepEndHour = (typeof sleepSettings.inAppProactiveSleepEndHour === 'number'
      && sleepSettings.inAppProactiveSleepEndHour >= 0
      && sleepSettings.inAppProactiveSleepEndHour <= 23)
      ? sleepSettings.inAppProactiveSleepEndHour : 8;

    const body = {
      userId, chatId, enabled: true,
      contactName, contactPersonality, contextSummary,
      llmApiUrl, llmApiKey, llmModel,
      inAppSleepEnabled, inAppSleepStartHour, inAppSleepEndHour
    };
    // v0.2.30.2: 简单 URL/model 配对校验 — 切预设时如果 model 没回滚, 这里 warn 一行
    //   真凶 (user 2026-08-17 15:20): push_user_config 留脏数据 (x666 URL + gemini model) 导致推送全 404
    //   启发式判断: Google URL 配 gemini-* model; 其他 URL 配非 gemini model
    if (llmApiUrl && llmModel) {
        const isGoogle = llmApiUrl.includes('generativelanguage.googleapis.com');
        const isGemini = /^gemini/i.test(llmModel);
        if (isGoogle && !isGemini) {
            console.warn(`[push-config v0.2.30.2] ⚠️ URL 是 Google Gemini (${llmApiUrl.substring(0, 40)}) 但 model="${llmModel}" 不是 gemini-* — 推送会 404 model_not_found, 请在 API 设置里改 model`);
        } else if (!isGoogle && isGemini) {
            console.warn(`[push-config v0.2.30.2] ⚠️ URL 是 OpenAI 兼容 (${llmApiUrl.substring(0, 40)}) 但 model="${llmModel}" 是 gemini-* — 这个 distributor 可能没这模型, 推送会 404`);
        }
    }
    if (lastUserMsgAt != null) {
      body.lastUserMsgAt = new Date(lastUserMsgAt).toISOString();
    }
    if (contextFull) {
      body.contextFull = contextFull;
    }

    try {
      const res = await fetch(`${serverUrl}/api/push-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[proactive-wake-ui] sync push config 失败: chatId=${chatId} ${res.status} ${errText.substring(0, 200)}`);
      } else {
        const ctxMark = contextFull ? ` contextFull=${contextFull.length}B` : '';
        console.log(`[proactive-wake-ui] ✅ sync push config 成功: chatId=${chatId} model=${llmModel || '?'}${lastUserMsgAt ? ` lastUserMsgAt=${body.lastUserMsgAt}` : ''}${ctxMark}`);
      }
    } catch (e) {
      console.warn(`[proactive-wake-ui] sync push config 网络错误 chatId=${chatId}:`, e.message);
    }
  }

  // v0.2.30.6: 删 unsyncCurrentChatPushConfig 函数 (切 app 模式不再调 server)
  //   旧函数删掉避免成为死代码 — 切 app 模式时 sync 也不调 (sync 只在切 push 模式时调)
  //   老的 unsync 设计真凶: 调试时切来切去就丢 push_user_config 行, 跟"选 app 模式两边都收"期望冲突

  // ===== v0.2.07+: 根据投递方式显示不同 UI =====
  // app 模式: 隐藏 [任务列表] + [+ 创建任务] 按钮
  // push 模式: 显示 [任务列表] + [+ 创建任务] 按钮
  // v0.2.18: 应用内模式说明卡已删 (user 觉得说明过时/无意义)
  function updateUiForDeliveryMode(mode) {
    const taskListCard = document.querySelector('.pw-card-task-list');
    const createBtn = document.getElementById('pw-create-task-btn');
    const refreshBtn = document.getElementById('pw-refresh-tasks-btn');

    if (mode === 'app') {
      if (taskListCard) taskListCard.style.display = 'none';
      if (createBtn) createBtn.style.display = 'none';
      if (refreshBtn) refreshBtn.style.display = 'none';
    } else {  // push
      if (taskListCard) taskListCard.style.display = '';
      if (createBtn) createBtn.style.display = '';
      if (refreshBtn) refreshBtn.style.display = '';
    }
  }

  // ===== 同步 chat 设置页的角色级 "启用主动消息" 开关 (v0.1.91+) =====
  // 设计: 角色级开关 = 总开关 (能不能发), 全局 mode = 渠道选择 (用什么发), 两个独立维度
  // 因此角色级开关在 chat 设置页永远可用, 这里只显示"当前投递模式"的信息提示
  // ★ v0.1.92 修死循环: syncOldProactiveSwitch 改 oldHint.innerHTML → 触发 mutation → observer 再跑 → 死循环
  // 修法: 临时 disconnect observer, 改完 reconnect
  function syncOldProactiveSwitch(mode) {
    const oldHint = document.getElementById('char-proactive-mode-hint');
    if (!oldHint) return;  // chat 设置页没打开, 跳过 (下次开时会通过 MutationObserver 同步)

    // ★ 防死循环: 临时 disconnect observer
    const observer = window._pwChatSettingsObserver;
    if (observer) {
      observer.disconnect();
    }

    try {
      if (mode === 'push') {
        oldHint.innerHTML = '📡 <b>当前投递方式：系统推送</b>（杀后台/锁屏也能收到）<br>关掉 [启用主动消息] → 不会推送。要切换投递方式请去 [设置 → 通知 → 🌸 AI 主动消息]。';
        oldHint.style.display = '';
      } else if (mode === 'app') {
        oldHint.innerHTML = '📱 <b>当前投递方式：应用内</b>（PWA 开着时有效, 杀后台失效）<br>关掉 [启用主动消息] → 不会推送。要切换投递方式请去 [设置 → 通知 → 🌸 AI 主动消息]。';
        oldHint.style.display = '';
      } else {
        oldHint.style.display = 'none';
      }
    } finally {
      // 改完 reconnect observer
      if (observer) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  // ===== MutationObserver: chat 设置页打开时自动同步角色级开关 (v0.1.90+) =====
  // 因为 chat 设置页可能 user 没打开时 loadDeliveryMode 跑, 元素不存在
  // 等 chat 设置页打开时, 元素出现, 立刻按当前 mode 同步状态
  function setupChatSettingsSyncObserver() {
    if (typeof MutationObserver === 'undefined') return;
    if (window._pwChatSettingsObserver) return;  // 只挂一次
    const observer = new MutationObserver(() => {
      const oldSwitch = document.getElementById('char-proactive-enabled-switch');
      if (oldSwitch) {
        const mode = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
        syncOldProactiveSwitch(mode);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window._pwChatSettingsObserver = observer;
    console.log('[proactive-wake-ui] ✅ chat 设置页同步观察器已挂载');
  }

  // ===== 处理订阅 =====
  async function handleSubscribe() {
    const btn = document.getElementById('pw-subscribe-btn');
    btn.disabled = true;
    btn.textContent = '处理中...';
    try {
      await window.ProactiveWake.subscribe();
      alert('✅ 推送已开启！现在可以创建定时任务了。');
      await loadSubscriptionStatus();
      await loadTaskList();
    } catch (e) {
      alert(`❌ 订阅失败：${e.message}\n\n如果是 iPhone，请先：\n1. iOS 设置 → Safari → 高级 → 网站通知 → 打开\n2. 把 PWA 加到主屏幕`);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔔 开启推送';
    }
  }

  // ===== 处理取消订阅 =====
  async function handleUnsubscribe() {
    if (!confirm('确定要关闭推送吗？已创建的任务也会停止发送。')) return;
    try {
      await window.ProactiveWake.unsubscribe();
      await loadSubscriptionStatus();
    } catch (e) {
      alert(`❌ 关闭失败: ${e.message}`);
    }
  }

  // ===== 处理测试推送 =====
  async function handleTestPush() {
    const btn = document.getElementById('pw-test-push-btn');
    btn.disabled = true;
    btn.textContent = '发送中...';
    try {
      await window.ProactiveWake.sendTestPush();
      alert('✅ 测试推送已发送！请检查手机通知。');
    } catch (e) {
      alert(`❌ 测试推送失败: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '🧪 测试推送';
    }
  }

  // ===== 加载任务列表 =====
  async function loadTaskList() {
    // v0.2.07+: 应用内模式不需要 push-server 任务列表 (任务列表卡已隐藏)
    const mode = window.state?.globalSettings?.proactiveDeliveryMode || 'app';
    if (mode === 'app') {
      console.log('[proactive-wake-ui] 应用内模式, 跳过查 push-server 任务列表');
      return;
    }

    const listEl = document.getElementById('pw-task-list');
    const countEl = document.getElementById('pw-task-count');
    if (!listEl) return;

    listEl.innerHTML = '<div class="pw-empty">加载中...</div>';

    try {
      const tasks = await window.ProactiveWake.listTasks();
      countEl.textContent = `(${tasks.length})`;

      if (tasks.length === 0) {
        listEl.innerHTML = '<div class="pw-empty">还没有任务，点下面"+ 创建新任务"试试</div>';
        return;
      }

      listEl.innerHTML = '';
      tasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'pw-task-item';
        const nextTime = task.next_send_at ? new Date(task.next_send_at).toLocaleString('zh-CN', { hour12: false }) : '已发送';
        const statusBadge = task.status === 'pending' ? '⏰ 待发送' :
                           task.status === 'sent' ? '✅ 已发送' :
                           task.status === 'failed' ? '❌ 失败' : task.status;
        const recurrenceLabel = {none: '只发一次', daily: '每天', weekly: '每周', 'ai-decided': 'AI 决定'}[task.recurrence_type] || task.recurrence_type;
        const messagePreview = task.user_message ? task.user_message.substring(0, 30) : (task.user_prompt ? `AI 提示: ${task.user_prompt.substring(0, 20)}` : '(无内容)');
        // 任务来源标签: user_message 有值 = 用户手动创建, 否则 = AI 自动创建
        const sourceBadge = task.user_message ? '<span class="pw-source-badge pw-source-user">👤 手动</span>' : '<span class="pw-source-badge pw-source-ai">🤖 AI</span>';

        card.innerHTML = `
          <div class="pw-task-item-header">
            <div class="pw-task-item-name">💬 ${escapeHtml(task.contact_name)}</div>
            <div class="pw-task-item-status pw-task-status-${task.status}">${statusBadge}</div>
          </div>
          <div class="pw-task-item-body">
            <div class="pw-task-item-preview">${escapeHtml(messagePreview)}</div>
            <div class="pw-task-item-meta">
              <span>⏰ ${nextTime}</span>
              <span>🔁 ${recurrenceLabel}</span>
              <span>📝 ${task.message_type}</span>
              ${sourceBadge}
            </div>
            ${task.failure_reason ? `<div class="pw-task-item-error">⚠️ ${escapeHtml(task.failure_reason)}</div>` : ''}
          </div>
          <button class="pw-task-delete-btn" data-task-id="${task.id}">删除</button>
        `;

        card.querySelector('.pw-task-delete-btn').addEventListener('click', () => handleDeleteTask(task.id));
        listEl.appendChild(card);
      });
    } catch (e) {
      listEl.innerHTML = `<div class="pw-empty pw-empty-error">❌ 加载失败: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ===== 处理删除任务 =====
  async function handleDeleteTask(taskId) {
    if (!confirm('确定要删除这个任务吗？')) return;
    try {
      await window.ProactiveWake.deleteTask(taskId);
      await loadTaskList();
    } catch (e) {
      alert(`❌ 删除失败: ${e.message}`);
    }
  }

  // ===== 打开创建任务弹窗 =====
  function openCreateModal() {
    // 填充角色选择
    const select = document.getElementById('pw-form-chat');
    select.innerHTML = '<option value="">-- 选择当前聊天角色 --</option>';
    const state = window.state;
    if (state?.chats) {
      Object.values(state.chats).forEach(chat => {
        const opt = document.createElement('option');
        opt.value = chat.id;
        opt.textContent = chat.name || '未命名角色';
        if (chat.id === state.activeChatId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    document.getElementById('pw-create-modal').style.display = 'flex';
  }

  // ===== 关闭创建任务弹窗 =====
  function closeCreateModal() {
    document.getElementById('pw-create-modal').style.display = 'none';
  }

  // ===== 处理创建任务 =====
  // v0.2.28: 重写 — UI 删频率 radio + 加 datetime-local, 改 type=fixed/ai-msg
  //   之前有 4 种模式 (fixed / guided / auto / ai-decided), UI 混乱
  //   现在简化: user 必选时间 + 选 fixed (自己写消息) 或 ai-msg (AI 写消息)
  //   (旧的 "AI 自己建任务" 那条路 v0.2.20 起就是 noop, 已于 2026-11-27 整条删掉)
  async function handleCreateTask() {
    const chatId = document.getElementById('pw-form-chat').value;
    const type = document.getElementById('pw-form-type').value;
    const message = document.getElementById('pw-form-message').value.trim();
    const prompt = document.getElementById('pw-form-prompt').value.trim();
    const firstSendTimeLocal = document.getElementById('pw-form-first-send-time').value;

    if (!firstSendTimeLocal) {
      alert('请选择提醒时间');
      return;
    }
    // datetime-local 是本地时间字符串 ("2026-08-17T09:00"), new Date() 按浏览器时区解析, toISOString 转 UTC
    // server 端存这个 ISO 字符串, runScheduledTick 拿 NOW() (server 本地时区 Asia/Shanghai) 比较 next_send_at
    // 简化处理: PWA 端把 datetime-local 当作"user 当地时区的时间", 转 ISO 后存 server, server 直接当 UTC 存
    // (精度 1 分钟可接受, user 设"明早 8 点" 误差 1 分钟)
    const firstSendTime = new Date(firstSendTimeLocal).toISOString();

    const submitBtn = document.getElementById('pw-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '创建中...';

    try {
      if (type === 'fixed') {
        if (!message) {
          alert('请输入消息内容');
          return;
        }
        await window.ProactiveWake.createFixedTask({
          userMessage: message,
          chatId: chatId || null,
          firstSendTime,
          recurrenceType: 'none'
        });
      } else if (type === 'ai-msg') {
        if (!prompt) {
          alert('请输入给 AI 的提示词');
          return;
        }
        // v0.2.28: ai-msg 模式 — user 选时间 + 填 prompt, server 端 LLM 生成具体消息
        //   取代旧的 "AI 自己建任务" 那条路 (v0.2.20 起就是 noop, 已于 2026-11-27 整条删掉)
        await window.ProactiveWake.createFixedTask({
          userMessage: null,
          userPrompt: prompt,
          chatId: chatId || null,
          firstSendTime,
          recurrenceType: 'none',
          messageType: 'ai-msg'
        });
      } else {
        alert('未知任务类型: ' + type);
        return;
      }
      closeCreateModal();
      await loadTaskList();
      alert('✅ 任务已创建！');
    } catch (e) {
      alert(`❌ 创建失败: ${e.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '创建';
    }
  }

  // ===== HTML escape =====
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== 初始化 (不再自动插 banner, 等设置页按钮触发) =====
  function init() {
    console.log('[proactive-wake-ui] 模块加载, 等设置页按钮触发 openManager()');
  }

  // 提供 showBanner() 给想用的人 (默认不调)
  function showBanner() {
    const chatList = document.getElementById('chat-list') ||
                      document.querySelector('.chat-list') ||
                      document.querySelector('[id*="chat-list"]');
    if (!chatList) {
      console.warn('[proactive-wake-ui] 找不到 chat-list 容器, banner 显示失败');
      return false;
    }
    if (document.getElementById('proactive-wake-banner')) return true;
    const banner = createBanner();
    chatList.insertBefore(banner, chatList.firstChild);
    updateBanner();
    return true;
  }

  // 立即初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      setupChatSettingsSyncObserver();
    });
  } else {
    init();
    setupChatSettingsSyncObserver();
  }

  // 暴露 API
  window.ProactiveWakeUI = {
    openManager,
    closeManager,
    updateBanner,
    // v0.2.25: 暴露 syncCurrentChatPushConfig 给外部触发 — 主 API 保存后 push-server 也能拿到最新 LLM
    syncPushConfig: syncCurrentChatPushConfig
  };
})();

// ============================================================
// bg-activity-panel.js — 角色设置页「AI 后台活动」面板 (2026-11-27 新增)
//
// 改造前: 后台活动的开关散在 4 个地方 (全局 / 角色 / NPC / 情侣空间 localStorage)
//   光一个角色就牵扯 60+ 个开关, 用户一天到处找。
// 改造后: 全部收进角色聊天设置里的这一块 —— 一个角色一套, 一屏看完。
//
// 本模块只管 UI 渲染 + 读写, 判断逻辑都在 modules/bg-activity-config.js。
// ============================================================
(function () {
  'use strict';

  const ACTS = () => (window.BgActivityConfig && window.BgActivityConfig.BG_ACTS) || {};
  const COUPLE_FEATURES = () => (window.BgActivityConfig && window.BgActivityConfig.COUPLE_FEATURES) || [];

  let currentChatId = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------
  // 渲染: 活动项清单 (JS 动态生成, 加活动项只改 BG_ACTS 一处)
  // ------------------------------------------------------------
  function renderActs(cfg) {
    const box = $('char-bg-activity-acts');
    if (!box) return;
    const acts = ACTS();
    const keys = Object.keys(acts);
    box.innerHTML = keys.map(key => {
      const a = acts[key];
      const on = !!(cfg.acts && cfg.acts[key]);
      return `
        <div class="char-bg-act">
          <div class="char-bg-act-text">
            <div class="char-bg-act-label">${esc(a.label)}</div>
            <div class="char-bg-act-desc">${esc(a.desc)}</div>
          </div>
          <label class="toggle-switch" style="margin:0;flex:0 0 auto;">
            <input type="checkbox" data-bg-act="${esc(key)}" ${on ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>`;
    }).join('');
    updateActsCount(cfg);
  }

  /** 「会做什么 (已开 N / 10)」里的计数 */
  function updateActsCount(cfg) {
    const el = $('char-bg-acts-count');
    if (!el) return;
    const acts = ACTS();
    const keys = Object.keys(acts);
    const on = keys.filter(k => cfg.acts && cfg.acts[k]).length;
    el.textContent = String(on);
    const total = $('char-bg-acts-total');
    if (total) total.textContent = String(keys.length);
  }

  // ------------------------------------------------------------
  // 渲染: 情侣空间 13 项 (折叠面板里的可滚动列表)
  // ------------------------------------------------------------
  function renderCoupleFeats(cfg) {
    const box = $('char-couple-space-feats-list');
    if (!box) return;
    const feats = COUPLE_FEATURES();
    const on = (cfg.couple && cfg.couple.feats) || {};
    box.innerHTML = feats.map(f => {
      return `
        <div class="char-bg-feat">
          <label class="char-bg-feat-label" for="char-couple-feat-${esc(f.key)}">${esc(f.label)}</label>
          <label class="toggle-switch" style="margin:0;flex:0 0 auto;">
            <input type="checkbox" id="char-couple-feat-${esc(f.key)}" data-bg-couple-feat="${esc(f.key)}" ${on[f.key] ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>`;
    }).join('');
    updateCoupleFeatsCount(cfg);
  }

  function updateCoupleFeatsCount(cfg) {
    const el = $('char-couple-space-feats-count');
    if (!el) return;
    const feats = COUPLE_FEATURES();
    const on = (cfg.couple && cfg.couple.feats) || {};
    const n = feats.filter(f => on[f.key]).length;
    el.textContent = String(n);
  }

  // ------------------------------------------------------------
  // 联动显示
  // ------------------------------------------------------------
  function refreshVisibility(cfg) {
    const panel = $('char-bg-activity-panel');
    if (panel) panel.style.display = cfg.enabled ? '' : 'none';

    const peekRow = $('char-bg-peek-chance-row');
    if (peekRow) peekRow.style.display = (cfg.enabled && cfg.acts && cfg.acts.peek) ? '' : 'none';

    const couplePanel = $('char-couple-space-panel');
    if (couplePanel) couplePanel.style.display = (cfg.enabled && cfg.couple && cfg.couple.enabled) ? '' : 'none';

    const mode = cfg.couple ? cfg.couple.mode : 'off';
    const timeRow = $('char-couple-space-time-row');
    if (timeRow) timeRow.style.display = (mode === 'scheduled' || mode === 'both') ? '' : 'none';
    const probRow = $('char-couple-space-prob-row');
    if (probRow) probRow.style.display = (mode === 'ai' || mode === 'both') ? '' : 'none';
  }

  // ------------------------------------------------------------
  // 读取: 把角色配置填进 UI
  // ------------------------------------------------------------
  function load(chatId) {
    currentChatId = chatId;
    const chat = window.state && window.state.chats ? window.state.chats[chatId] : null;
    if (!chat) return;
    if (!window.BgActivityConfig || typeof window.BgActivityConfig.getBgActivityConfig !== 'function') return;

    const cfg = window.BgActivityConfig.getBgActivityConfig(chat);

    const master = $('char-bg-activity-switch');
    if (master) master.checked = !!cfg.enabled;

    renderActs(cfg);

    const cd = $('char-bg-activity-cooldown');
    if (cd) cd.value = cfg.cooldownMinutes;
    const bc = $('char-bg-block-cooldown');
    if (bc) bc.value = cfg.blockCooldownHours;

    const peek = $('char-bg-peek-chance');
    if (peek) peek.value = (cfg.peekChance === null || cfg.peekChance === undefined) ? '' : cfg.peekChance;

    const csSwitch = $('char-couple-space-switch');
    if (csSwitch) csSwitch.checked = !!(cfg.couple && cfg.couple.enabled);
    const csMode = $('char-couple-space-mode');
    if (csMode) csMode.value = (cfg.couple && cfg.couple.mode) || 'off';
    const csTime = $('char-couple-space-time');
    if (csTime) csTime.value = (cfg.couple && cfg.couple.time) || '21:00';
    const csProb = $('char-couple-space-prob');
    if (csProb) csProb.value = (cfg.couple && typeof cfg.couple.prob === 'number') ? cfg.couple.prob : 5;

    renderCoupleFeats(cfg);
    refreshVisibility(cfg);
  }

  // ------------------------------------------------------------
  // 保存: 把 UI 的值写回角色配置
  // ------------------------------------------------------------
  function save(chatId) {
    const id = chatId || currentChatId;
    const chat = window.state && window.state.chats ? window.state.chats[id] : null;
    if (!chat) return;
    if (!window.BgActivityConfig || typeof window.BgActivityConfig.getBgActivityConfig !== 'function') return;

    const cfg = window.BgActivityConfig.getBgActivityConfig(chat);

    const master = $('char-bg-activity-switch');
    if (master) cfg.enabled = master.checked;

    document.querySelectorAll('#char-bg-activity-acts input[data-bg-act]').forEach(el => {
      const key = el.getAttribute('data-bg-act');
      if (key) cfg.acts[key] = el.checked;
    });

    const cd = $('char-bg-activity-cooldown');
    if (cd) cfg.cooldownMinutes = parseInt(cd.value) || 15;
    const bc = $('char-bg-block-cooldown');
    if (bc) cfg.blockCooldownHours = parseFloat(bc.value) || 1;

    const peek = $('char-bg-peek-chance');
    if (peek) cfg.peekChance = peek.value.trim() === '' ? null : (parseInt(peek.value) || 0);

    const csSwitch = $('char-couple-space-switch');
    if (csSwitch) cfg.couple.enabled = csSwitch.checked;
    const csMode = $('char-couple-space-mode');
    if (csMode) cfg.couple.mode = csMode.value;
    const csTime = $('char-couple-space-time');
    if (csTime && csTime.value) cfg.couple.time = csTime.value;
    const csProb = $('char-couple-space-prob');
    if (csProb) cfg.couple.prob = parseInt(csProb.value) || 0;

    document.querySelectorAll('#char-couple-space-feats-list input[data-bg-couple-feat]').forEach(el => {
      const key = el.getAttribute('data-bg-couple-feat');
      if (key) cfg.couple.feats[key] = el.checked;
    });
    updateCoupleFeatsCount(cfg);
    updateActsCount(cfg);

    window.BgActivityConfig.saveBgActivityConfig(chat);

    // 情侣空间调度器要立刻重算 (定时任务/AI自主都走它)
    if (typeof setupCoupleSpaceAutoTimer === 'function') {
      try { setupCoupleSpaceAutoTimer(); } catch (e) { /* ignore */ }
    }
  }

  // ------------------------------------------------------------
  // 绑定 (只绑一次)
  // ------------------------------------------------------------
  let bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;

    const master = $('char-bg-activity-switch');
    if (master) {
      master.addEventListener('change', () => {
        const chat = window.state && window.state.chats ? window.state.chats[currentChatId] : null;
        if (!chat || !window.BgActivityConfig) return;
        const cfg = window.BgActivityConfig.getBgActivityConfig(chat);
        cfg.enabled = master.checked;
        window.BgActivityConfig.saveBgActivityConfig(chat);
        refreshVisibility(cfg);
      });
    }

    // 活动项开关 (事件委托)
    const actsBox = $('char-bg-activity-acts');
    if (actsBox) {
      actsBox.addEventListener('change', (e) => {
        const el = e.target;
        if (!el || !el.matches || !el.matches('input[data-bg-act]')) return;
        const chat = window.state && window.state.chats ? window.state.chats[currentChatId] : null;
        if (!chat || !window.BgActivityConfig) return;
        const cfg = window.BgActivityConfig.getBgActivityConfig(chat);
        const key = el.getAttribute('data-bg-act');
        if (key) cfg.acts[key] = el.checked;
        window.BgActivityConfig.saveBgActivityConfig(chat);
        updateActsCount(cfg);
        refreshVisibility(cfg);
      });
    }

    const csSwitch = $('char-couple-space-switch');
    if (csSwitch) {
      csSwitch.addEventListener('change', () => {
        const chat = window.state && window.state.chats ? window.state.chats[currentChatId] : null;
        if (!chat || !window.BgActivityConfig) return;
        const cfg = window.BgActivityConfig.getBgActivityConfig(chat);
        cfg.couple.enabled = csSwitch.checked;
        window.BgActivityConfig.saveBgActivityConfig(chat);
        refreshVisibility(cfg);
      });
    }

    const csMode = $('char-couple-space-mode');
    if (csMode) {
      csMode.addEventListener('change', () => {
        const chat = window.state && window.state.chats ? window.state.chats[currentChatId] : null;
        if (!chat || !window.BgActivityConfig) return;
        const cfg = window.BgActivityConfig.getBgActivityConfig(chat);
        cfg.couple.mode = csMode.value;
        window.BgActivityConfig.saveBgActivityConfig(chat);
        refreshVisibility(cfg);
      });
    }

    // 情侣空间 13 项 (事件委托)
    const featsBox = $('char-couple-space-feats-list');
    if (featsBox) {
      featsBox.addEventListener('change', (e) => {
        const el = e.target;
        if (!el || !el.matches || !el.matches('input[data-bg-couple-feat]')) return;
        const chat = window.state && window.state.chats ? window.state.chats[currentChatId] : null;
        if (!chat || !window.BgActivityConfig) return;
        const cfg = window.BgActivityConfig.getBgActivityConfig(chat);
        const key = el.getAttribute('data-bg-couple-feat');
        if (key) cfg.couple.feats[key] = el.checked;
        window.BgActivityConfig.saveBgActivityConfig(chat);
        updateCoupleFeatsCount(cfg);
      });
    }

    // 折叠下拉
    // 折叠下拉 (活动项 / 情侣空间 共用一套写法)
    function bindCollapse(toggleId, listId, arrowId) {
      const toggle = $(toggleId);
      if (!toggle) return;
      toggle.addEventListener('click', () => {
        const list = $(listId);
        const arrow = $(arrowId);
        if (!list) return;
        const open = list.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (arrow) arrow.textContent = open ? '▴' : '▾';
      });
    }
    bindCollapse('char-bg-acts-toggle', 'char-bg-activity-acts', 'char-bg-acts-arrow');
    bindCollapse('char-couple-space-feats-toggle', 'char-couple-space-feats-list', 'char-couple-space-feats-arrow');
  }

  window.BgActivityPanel = {
    load: load,
    save: save,
    bindEvents: bindEvents,
    refreshVisibility: refreshVisibility
  };

  console.log('[bg-activity-panel] 模块加载完成');
})();

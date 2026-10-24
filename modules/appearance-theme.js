// ========== 外观与主题模块 ==========
// 来源：script.js 第 23259~23278, 28357~28573, 28720~28810, 32832~32837, 37789~37820, 38880~38884, 47014~47210 行
// 功能：主题切换、壁纸应用、图标管理、CSS 管理、手机框架模式、外观导入导出
// 包含：applyCPhoneWallpaper, applyMyPhoneWallpaper, applyCPhoneAppIcons, applyMyPhoneAppIconsGlobal,
//       renderCPhoneIconSettings, renderMyPhoneIconSettings, applyAppIcons, renderIconSettings,
//       applyPhoneFrame, applyDetachStatusBarMode, applyMinimalChatUI, applyTrueFullscreen,
//       applyTheme, toggleTheme, applyScopedCss, applyGlobalCss, applyWidgetData,
//       applyStatusBarVisibility, importAppearanceSettings, exportAppearanceSettings

  function applyCPhoneWallpaper() {
    const charPhoneScreen = document.getElementById('character-phone-screen');
    const wallpaper = state.globalSettings.cphoneWallpaper;
    if (wallpaper) {

      charPhoneScreen.style.backgroundImage = `url("${wallpaper}")`;
    } else {

      charPhoneScreen.style.backgroundImage = 'linear-gradient(135deg, #f6d365, #fda085)';
    }
  }

  function applyMyPhoneWallpaper() {
    const myphoneScreen = document.getElementById('myphone-screen');
    const wallpaper = state.globalSettings.myphoneWallpaper;
    if (wallpaper) {

      myphoneScreen.style.backgroundImage = `url("${wallpaper}")`;
    } else {

      myphoneScreen.style.backgroundImage = 'linear-gradient(135deg, #a8edea, #fed6e3)';
    }
  }


  function applyCPhoneAppIcons() {
    // 先保存所有 CPhone 应用图标的默认 src（如果还没保存的话）
    const iconElements = document.querySelectorAll('[id^="cphone-icon-img-"]');
    iconElements.forEach(img => {
      if (!img.dataset.defaultSrc) {
        img.dataset.defaultSrc = img.src;
      }
    });

    if (!state.globalSettings.cphoneAppIcons) return;

    // 直接设 src
    for (const iconId in state.globalSettings.cphoneAppIcons) {
      const imgElement = document.getElementById(`cphone-icon-img-${iconId}`);
      if (imgElement) {
        const url = state.globalSettings.cphoneAppIcons[iconId];
        if (url) {
          imgElement.src = url;
        }
      }
    }
  }

  function applyMyPhoneAppIconsGlobal() {
    // 先保存所有 MyPhone 应用图标的默认 src（如果还没保存的话）
    const iconElements = document.querySelectorAll('[id^="myphone-icon-img-"]');
    iconElements.forEach(img => {
      if (!img.dataset.defaultSrc) {
        img.dataset.defaultSrc = img.src;
      }
    });

    if (!state.globalSettings.myphoneAppIcons) return;

    // 直接设 src
    for (const iconId in state.globalSettings.myphoneAppIcons) {
      const imgElement = document.getElementById(`myphone-icon-img-${iconId}`);
      if (imgElement) {
        const url = state.globalSettings.myphoneAppIcons[iconId];
        if (url) {
          imgElement.src = url;
        }
      }
    }
  }


  // 【修复】外观设置页打开时崩浏览器：分批 + lazy + async decoding
  // 原因：传了 N 个 base64 图标后，三个 render 同步循环 + 同步 DOM appendChild + 浏览器同步解码 N 张大图 = 主线程卡死 / OOM
  // 修复：① 限制单 grid 最多渲染 50 个，超出提示；② 每批 20 个用 requestAnimationFrame 切帧插入；③ img 加 loading="lazy" decoding="async"
  // 【第二刀修复】依然崩：
  //   - decoding="async" 只推迟「光栅化上屏」不推迟 base64→bitmap 解码，data:URI 一解析就同步分配 bitmap
  //   - loading="lazy" 在不可见容器里行为未定义（chat-list.js:71 不 await renderWallpaperScreenProxy，
  //     屏幕在第 1 批还没渲完时就被加 .active → 浏览器集中 decode 所有 lazy+async 图 → 60 张峰值 OOM）
  //   - rAF 不释放已解码 bitmap，三个 grid 串行累积下来内存峰值撞手机 WebView 上限
  //   - innerHTML 模板字符串拼接大 base64 还会产生 180 次临时大字符串
  // 兜底：① 单图字节上限（>500KB base64 不进 src，降级占位）；② 属性赋值代替 innerHTML；③ 单帧单张 + rAF
  const MAX_SINGLE_ICON_BYTES = 1.5 * 1024 * 1024; // 1.5MB base64 ≈ 1.1MB 原图（2026-07-04：放宽让 base64 偏大的图标也能显示，8MB 总数限制兜底）

  function buildIconSettingItem(iconId, iconUrl, labelText) {
    const item = document.createElement('div');
    item.className = 'icon-setting-item';
    item.dataset.iconId = iconId;

    const img = document.createElement('img');
    img.className = 'icon-preview';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = function () { this.style.opacity = '0.3'; };

    // 关键：单图 base64 > 1.5MB 直接降级，不让浏览器去 decode 大图
    if (iconUrl && iconUrl.length <= MAX_SINGLE_ICON_BYTES) {
      img.src = iconUrl;
      img.alt = labelText;
    } else if (!iconUrl) {
      // 【2026-07-04 修复】未传图，提示用户上传
      img.alt = labelText + ' (未传图，点击下方"更换"上传)';
      img.style.background = '#f0f0f0';
    } else {
      // 不设 src，浏览器不会分配任何 bitmap
      img.alt = labelText + ' (图过大未渲染)';
      img.style.background = '#eee';
    }

    const btn = document.createElement('button');
    btn.className = 'change-icon-btn';
    btn.textContent = '更换';

    item.appendChild(img);
    item.appendChild(btn);
    return item;
  }

  async function renderCPhoneIconSettings() {
    const grid = document.getElementById('cphone-icon-settings-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const cphoneAppLabels = {
      'qq': 'QQ',
      'album': '相册',
      'browser': '浏览器',
      'taobao': '淘宝',
      'memo': '备忘录',
      'diary': '日记',
      'amap': '高德地图',
      'usage': 'App记录',
      'music': '网易云',
      'bilibili': '哔哩哔哩',
      'reddit': 'Reddit',
      'ephone': 'Ephone',
      'settings': '设置'
    };

    const dict = state.globalSettings.cphoneAppIcons || {};
    const allKeys = Object.keys(dict);
    const MAX_PER_GRID = 30;
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8MB 上限（手机内存安全阈值，PC 也用这个更稳）
    const visible = [];
    let rendered = 0;
    let totalBytes = 0;
    let totalAllBytes = 0;
    for (const iconId of allKeys) {
      const url = dict[iconId];
      if (url) totalAllBytes += url.length;
      // 【2026-07-04 修复】url 是 undefined 也要进 visible（新加的图标槽位要让用户能传图）
      if (rendered < MAX_PER_GRID && url !== undefined && totalBytes + (url ? url.length : 0) <= MAX_TOTAL_BYTES) {
        visible.push([iconId, url]);
        rendered++;
        totalBytes += url ? url.length : 0;
      }
    }
    const hiddenCount = allKeys.length - rendered;
    const totalMB = (totalAllBytes / 1024 / 1024).toFixed(1);

    // 【第二刀修复】单帧单张 + buildIconSettingItem（属性赋值）
    // 【2026-07-04】rAF 切帧在 base64 data URL decode 时主线程仍可能瞬时卡死
    //   改成 setTimeout(30) 强制让浏览器有时间 GC + 让用户视觉上看到分批出现
    // 30 个图标 × 30ms = 900ms 渲染完，绝不瞬间卡死
    for (let i = 0; i < visible.length; i++) {
      const [iconId, iconUrl] = visible[i];
      const labelText = cphoneAppLabels[iconId] || '未知App';
      grid.appendChild(buildIconSettingItem(iconId, iconUrl, labelText));
      if (i < visible.length - 1) {
        await new Promise(r => setTimeout(r, 30));
      }
    }

    if (hiddenCount > 0) {
      const notice = document.createElement('div');
      notice.className = 'icon-grid-overflow-notice';
      notice.textContent = `还有 ${hiddenCount} 个图标未显示（共 ${totalMB}MB，已加载前 ${rendered} 个）。请在 API 设置开启 ImgBB 图床自动迁移，跑完后下次打开自动显示全部。`;
      grid.appendChild(notice);
    }
  }

  // 【修复】见 renderCPhoneIconSettings 注释
  async function renderMyPhoneIconSettings() {
    const grid = document.getElementById('myphone-icon-settings-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const myphoneAppLabels = {
      'qq': 'QQ',
      'album': '相册',
      'browser': '浏览器',
      'taobao': '淘宝',
      'memo': '备忘录',
      'diary': '日记',
      'amap': '高德地图',
      'usage': 'App记录',
      'music': '网易云',
      'settings': '设置',
      'records': '查看记录',
      'ephone': 'Ephone'
    };

    const dict = state.globalSettings.myphoneAppIcons || {};
    const allKeys = Object.keys(dict);
    const MAX_PER_GRID = 30;
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
    const visible = [];
    let rendered = 0;
    let totalBytes = 0;
    let totalAllBytes = 0;
    for (const iconId of allKeys) {
      const url = dict[iconId];
      if (url) totalAllBytes += url.length;
      // 【2026-07-04 修复】url 是 undefined 也要进 visible
      if (rendered < MAX_PER_GRID && url !== undefined && totalBytes + (url ? url.length : 0) <= MAX_TOTAL_BYTES) {
        visible.push([iconId, url]);
        rendered++;
        totalBytes += url ? url.length : 0;
      }
    }
    const hiddenCount = allKeys.length - rendered;
    const totalMB = (totalAllBytes / 1024 / 1024).toFixed(1);

    // 【第二刀修复】单帧单张 + buildIconSettingItem（属性赋值）
    for (let i = 0; i < visible.length; i++) {
      const [iconId, iconUrl] = visible[i];
      const labelText = myphoneAppLabels[iconId] || '未知App';
      grid.appendChild(buildIconSettingItem(iconId, iconUrl, labelText));
      if (i < visible.length - 1) {
        await new Promise(r => setTimeout(r, 30));
      }
    }

    if (hiddenCount > 0) {
      const notice = document.createElement('div');
      notice.className = 'icon-grid-overflow-notice';
      notice.textContent = `还有 ${hiddenCount} 个图标未显示（共 ${totalMB}MB，已加载前 ${rendered} 个）。请在 API 设置开启 ImgBB 图床自动迁移，跑完后下次打开自动显示全部。`;
      grid.appendChild(notice);
    }
  }




  function applyAppIcons() {
    // 先保存所有应用图标的默认 src（如果还没保存的话）
    const iconElements = document.querySelectorAll('[id^="icon-img-"]');
    iconElements.forEach(img => {
      if (!img.dataset.defaultSrc) {
        img.dataset.defaultSrc = img.src;
      }
    });

    if (!state.globalSettings.appIcons) return;

    // 直接设 src（DEFAULT 已清空 + 老用户 db 已清洗，不会再有失效 URL）
    for (const iconId in state.globalSettings.appIcons) {
      const imgElement = document.getElementById(`icon-img-${iconId}`);
      if (imgElement) {
        const url = state.globalSettings.appIcons[iconId];
        if (url) {
          imgElement.src = url;
        }
      }
    }
  }


  // 【修复】见 renderCPhoneIconSettings 注释
  async function renderIconSettings() {
    const grid = document.getElementById('icon-settings-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const appLabels = {
      'qq': 'QQ',
      'world-book': '世界书',
      'wallpaper': '外观设置',
      'renderer': '渲染器',
      'api-settings': 'API设置',
      'font': '字体',
      'char-phone': 'Cphone',
      'hot-news': '热点日报',

      'preset': '预设',

      'tutorial': '教程',
      'werewolf': '狼人杀',

      'x': 'X',
      'alipay': '支付宝',
      'auction': '黑市拍卖',
      'green-river': '绿江',
      'pet-nest': '宠物屋',
      'period-tracker': '月经记录',
      'focus-timer': '番茄钟',

      // 第三页的APP
      'myphone': 'Myphone',
      'draw-guess': '你画我猜',
      'char-generator': '角色生成',
      'online-app': '联机',
      'forum': '论坛',
      'new-world': '情侣空间'
    };


    const dict = state.globalSettings.appIcons || {};
    const allKeys = Object.keys(dict);
    const MAX_PER_GRID = 30;
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
    const visible = [];
    let rendered = 0;
    let totalBytes = 0;
    let totalAllBytes = 0;
    for (const iconId of allKeys) {
      const url = dict[iconId];
      if (url) totalAllBytes += url.length;
      // 【2026-07-04 修复】url 是 undefined 也要进 visible（新加的图标槽位要让用户能传图）
      if (rendered < MAX_PER_GRID && url !== undefined && totalBytes + (url ? url.length : 0) <= MAX_TOTAL_BYTES) {
        visible.push([iconId, url]);
        rendered++;
        totalBytes += url ? url.length : 0;
      }
    }
    const hiddenCount = allKeys.length - rendered;
    const totalMB = (totalAllBytes / 1024 / 1024).toFixed(1);

    // 【第二刀修复】单帧单张 + buildIconSettingItem（属性赋值）
    for (let i = 0; i < visible.length; i++) {
      const [iconId, iconUrl] = visible[i];
      const labelText = appLabels[iconId] || 'Cphone';
      grid.appendChild(buildIconSettingItem(iconId, iconUrl, labelText));
      if (i < visible.length - 1) {
        await new Promise(r => setTimeout(r, 30));
      }
    }

    if (hiddenCount > 0) {
      const notice = document.createElement('div');
      notice.className = 'icon-grid-overflow-notice';
      notice.textContent = `还有 ${hiddenCount} 个图标未显示（共 ${totalMB}MB，已加载前 ${rendered} 个）。请在 API 设置开启 ImgBB 图床自动迁移，跑完后下次打开自动显示全部。`;
      grid.appendChild(notice);
    }
  }




  function applyPhoneFrame(isEnabled) {

    document.body.classList.toggle('frame-mode-active', isEnabled);


    if (musicState.isActive) {
      const lyricBar = document.getElementById('global-lyrics-bar');
      const phoneScreenForIsland = document.getElementById('phone-screen');
      const isAlwaysIslandMode = state.globalSettings.alwaysShowMusicIsland || false;

      if (isEnabled) {

        lyricBar.classList.remove('visible');
        phoneScreenForIsland.classList.add('dynamic-island-active');
      } else {

        phoneScreenForIsland.classList.remove('dynamic-island-active');

        if (isAlwaysIslandMode) {

          phoneScreenForIsland.classList.add('dynamic-island-active');
          lyricBar.classList.remove('visible');
        } else {

          if (musicState.parsedLyrics && musicState.parsedLyrics.length > 0) {
            lyricBar.classList.add('visible');
          }
        }
      }
    }
  }

  function applyDetachStatusBarMode(isEnabled) {
    document.body.classList.toggle('detach-mode-active', isEnabled);
  }

  function applyMinimalChatUI(isEnabled) {
    document.body.classList.toggle('minimal-chat-ui-active', isEnabled);
  }

  function applyTrueFullscreen(isEnabled) {
    // 已移除真全屏功能，保留空函数避免报错
  }


  function applyTheme(theme) {
    const phoneScreen = document.getElementById('phone-screen');
    const toggleSwitch = document.getElementById('theme-toggle-switch');

    const isDark = theme === 'dark';

    phoneScreen.classList.toggle('dark-mode', isDark);


    if (toggleSwitch) {
      toggleSwitch.checked = isDark;
    }

    localStorage.setItem('ephone-theme', theme);
  }


  function toggleTheme() {
    const toggleSwitch = document.getElementById('theme-toggle-switch');

    const newTheme = toggleSwitch.checked ? 'dark' : 'light';
    applyTheme(newTheme);
  }



  function applyScopedCss(cssString, scopeId, styleTagId) {
    const styleTag = document.getElementById(styleTagId);
    if (!styleTag) return;

    if (!cssString || cssString.trim() === '') {
      styleTag.innerHTML = '';
      return;
    }


    const scopedCss = cssString
      .replace(/\s*\.message-bubble\.user\s+([^{]+\{)/g, `${scopeId} .message-bubble.user $1`)
      .replace(/\s*\.message-bubble\.ai\s+([^{]+\{)/g, `${scopeId} .message-bubble.ai $1`)
      .replace(/\s*\.message-bubble\s+([^{]+\{)/g, `${scopeId} .message-bubble $1`);

    styleTag.innerHTML = scopedCss;
  }


  function applyGlobalCss(cssString) {
    const styleTag = document.getElementById('global-custom-style');
    if (styleTag) {

      styleTag.innerHTML = cssString || '';
    }
  }


  function applyWidgetData() {
    // 先保存所有可编辑图片的默认 src（如果还没保存的话）
    const editableImages = document.querySelectorAll('.editable-image');
    editableImages.forEach(img => {
      if (!img.dataset.defaultSrc) {
        img.dataset.defaultSrc = img.src;
      }
    });

    if (!state.globalSettings.widgetData) return;
    for (const elementId in state.globalSettings.widgetData) {
      const element = document.getElementById(elementId);
      const savedValue = state.globalSettings.widgetData[elementId];
      if (element) {
        if (element.tagName === 'IMG') {
          // 直接设 src
          if (savedValue) {
            element.src = savedValue;
          }
        } else {
          // 将保存的\n转换为<br>以正确显示换行
          element.innerHTML = savedValue.replace(/\n/g, '<br>');
        }
      }
    }
    // 纪念日天数按日期实时更新（含恢复保存的日期后）
    if (typeof window.updateAnniversaryDayCount === 'function') {
      window.updateAnniversaryDayCount();
    }
  }


  function applyStatusBarVisibility() {
    const phoneScreen = document.getElementById('phone-screen');

    phoneScreen.classList.toggle('status-bar-visible', !!state.globalSettings.showStatusBar);
  }


  async function importAppearanceSettings(file) {
    if (!file) return;

    const confirmed = await showCustomConfirm(
      '导入外观设置',
      '即将导入文件。如果文件是 JSON 备份，将覆盖所有设置；如果是纯文本/Word文档，将尝试识别为 CSS 代码或 JSON 配置。\n\n确定要继续吗？', {
      confirmText: '确认导入'
    }
    );

    if (!confirmed) return;

    await showCustomAlert("处理中...", "正在解析文件内容...");

    try {
      let textContent = '';

      // 1. 根据文件类型读取文本
      if (file.name.toLowerCase().endsWith('.docx')) {
        if (typeof mammoth === 'undefined') {
          throw new Error("未加载 mammoth.js 库，无法读取 Word 文档。请检查网络或 HTML。");
        }
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        textContent = result.value;
      } else {
        // .json 或 .txt 直接读取文本
        textContent = await file.text();
      }

      if (!textContent || !textContent.trim()) {
        throw new Error("文件内容为空。");
      }

      // 2. 尝试解析为 JSON（完整配置模式）
      try {
        // 预处理：有时候 Word 会包含不可见的 BOM 或多余空格，尝试清理并提取 JSON 部分
        let cleanText = textContent.trim();
        // 尝试提取第一个 { 到最后一个 } 之间的内容，防止文档前后有杂质
        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanText = jsonMatch[0];
        }

        const data = JSON.parse(cleanText);

        // 检查是否是有效的外观配置对象
        if (data.wallpaper || data.globalCss || data.appIcons || data.theme) {
          Object.assign(state.globalSettings, data);
          // icons 类对象按 key 合并，保留旧 key（避免 Object.assign 整体替换导致缺失 key 的图标恢复成默认）
          // 用户上传的粉萌咖棕.json 可能只含部分 key，整体替换会丢失其它图标的自定义设置
          if (data.appIcons) {
            state.globalSettings.appIcons = { ...(state.globalSettings.appIcons || {}), ...data.appIcons };
          }
          if (data.cphoneAppIcons) {
            state.globalSettings.cphoneAppIcons = { ...(state.globalSettings.cphoneAppIcons || {}), ...data.cphoneAppIcons };
          }
          if (data.myphoneAppIcons) {
            state.globalSettings.myphoneAppIcons = { ...(state.globalSettings.myphoneAppIcons || {}), ...data.myphoneAppIcons };
          }
          if (data.widgetData) {
            state.globalSettings.widgetData = { ...(state.globalSettings.widgetData || {}), ...data.widgetData };
          }
          await db.globalSettings.put(state.globalSettings);

          // 应用设置
          applyGlobalWallpaper();
          applyCPhoneWallpaper();
          applyMyPhoneWallpaper();
          applyAppIcons();
          applyCPhoneAppIcons();
          applyMyPhoneAppIconsGlobal();
          applyGlobalCss(state.globalSettings.globalCss);
          applyCustomFont(state.globalSettings.fontUrl);
          applyStatusBarVisibility();
          applyWidgetData();
          if (data.chatActionButtonsOrder) {
            renderButtonOrderEditor();
            applyButtonOrder();
          }

          // 刷新界面
          renderWallpaperScreen();

          await showCustomAlert('JSON导入成功', '完整外观设置已成功导入并应用！');
          return; // 成功结束
        }
      } catch (jsonError) {
        // JSON 解析失败，进入下一步：尝试作为纯 CSS 导入
        console.log("非 JSON 格式，尝试作为 CSS 处理...");
      }

      // 3. 如果不是 JSON，则视为纯 CSS 代码导入
      // 简单的防呆检查：CSS 通常包含 { 或 ;
      if (textContent.includes('{') || textContent.includes(';')) {
        const cssAction = await showChoiceModal(
          '检测到 CSS 代码',
          [
            { text: '覆盖现有CSS', value: 'overwrite' },
            { text: '附加到现有CSS', value: 'append' }
          ]
        );

        if (cssAction === 'overwrite') {
          state.globalSettings.globalCss = textContent;
          await db.globalSettings.put(state.globalSettings);
          applyGlobalCss(state.globalSettings.globalCss);

          // 刷新界面显示
          const cssInput = document.getElementById('global-css-input');
          if (cssInput) cssInput.value = textContent;

          await showCustomAlert('CSS导入成功', '代码已覆盖并应用到全局样式表。');
        } else if (cssAction === 'append') {
          const existingCss = state.globalSettings.globalCss || '';
          state.globalSettings.globalCss = existingCss + '\n\n/* 导入的CSS */\n' + textContent;
          await db.globalSettings.put(state.globalSettings);
          applyGlobalCss(state.globalSettings.globalCss);

          // 刷新界面显示
          const cssInput = document.getElementById('global-css-input');
          if (cssInput) cssInput.value = state.globalSettings.globalCss;

          await showCustomAlert('CSS导入成功', '代码已附加并应用到全局样式表。');
        }
      } else {
        throw new Error("无法识别文件内容。它既不是有效的 JSON 配置，也不像 CSS 代码。");
      }

    } catch (error) {
      console.error("导入外观设置时出错:", error);
      await showCustomAlert('导入失败', `文件解析失败: ${error.message}`);
    }
  }

  // 导出美化版外观设置
  async function exportAppearanceSettings() {
    try {
      // 1. 提取外观相关的数据
      // 即使包含大段 Base64 图片，JSON 格式化后结构依然清晰
      const appearanceData = {
        export_info: {
          generated_by: "EPhone",
          timestamp: new Date().toLocaleString(),
          note: "此文件包含外观设置、CSS样式、壁纸和图标数据。"
        },
        // 核心设置
        theme: localStorage.getItem('ephone-theme') || 'light',
        showStatusBar: state.globalSettings.showStatusBar,
        enableMinimalChatUI: state.globalSettings.enableMinimalChatUI,
        detachStatusBar: state.globalSettings.detachStatusBar,
        // CSS (最需要美化阅读的部分)
        globalCss: state.globalSettings.globalCss || "",
        // 字体
        fontUrl: state.globalSettings.fontUrl || "",
        fontLocalData: state.globalSettings.fontLocalData || "",
        fontScope: state.globalSettings.fontScope || { all: true },
        globalFontSize: state.globalSettings.globalFontSize || 16,
        // 布局排序
        chatActionButtonsOrder: state.globalSettings.chatActionButtonsOrder,
        // 资源数据 (壁纸/图标)
        wallpaper: state.globalSettings.wallpaper,
        cphoneWallpaper: state.globalSettings.cphoneWallpaper,
        globalChatBackground: state.globalSettings.globalChatBackground,
        appIcons: state.globalSettings.appIcons,
        cphoneAppIcons: state.globalSettings.cphoneAppIcons,
        myphoneAppIcons: state.globalSettings.myphoneAppIcons,
        widgetData: state.globalSettings.widgetData,
        lockScreenWallpaper: state.globalSettings.lockScreenWallpaper,
        notificationSoundUrl: state.globalSettings.notificationSoundUrl
      };

      // 2. 关键步骤：格式化 JSON (美化)
      // 第三个参数 4 表示使用 4 个空格进行缩进，让文件结构清晰、易读、易修改
      const jsonString = JSON.stringify(appearanceData, null, 4);

      // 3. 创建下载链接
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      // 生成文件名
      const dateStr = new Date().toISOString().split('T')[0];
      link.href = url;
      link.download = `EPhone_Appearance_Config_${dateStr}.json`;

      // 触发下载
      document.body.appendChild(link);
      link.click();

      // 清理
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      await showCustomAlert('导出成功', '外观配置已导出！\n这是一个格式化好的 JSON 文件，你可以用记事本打开查看或编辑 CSS。');

    } catch (error) {
      console.error("导出外观配置失败:", error);
      await showCustomAlert('导出失败', `发生错误: ${error.message}`);
    }
  }

// ========== 锁屏功能（从 script.js 补充拆分，原第 58784~59080 行） ==========

  let lockScreenState = {
    passwordBuffer: '',
    isLocked: false
  };
  window.lockScreenState = lockScreenState;

  // 🔴 2026-10-07 定时器泄漏修复
  // 原来直接 setInterval(updateLockScreenClock, 1000), 句柄没存、也没有 clearInterval。
  // 而 initLockScreen() 在 init-and-state.js / init-event-bindingsA.js / init-features.js
  // 三个地方各被调了一次 → 一开页面就有 3 个重复的每秒定时器, 而且永远不清。
  // 每个都每秒钟做 2 次 getElementById + 2 次 textContent 写入, 无时无刻搅主线程。
  let lockScreenClockTimer = null;

  function initLockScreen() {
    const lockScreen = document.getElementById('lock-screen');

    // 初始化检查：如果启用了锁屏，则立即显示
    if (state.globalSettings.lockScreenEnabled) {
      // 设置壁纸
      if (state.globalSettings.lockScreenWallpaper) {
        lockScreen.style.backgroundImage = `url(${state.globalSettings.lockScreenWallpaper})`;
      } else {
        lockScreen.style.backgroundImage = 'linear-gradient(135deg, #1c1c1e, #3a3a3c)';
      }

      lockScreenState.isLocked = true;
      lockScreen.classList.add('active');
      updateLockScreenClock();

      // 启动锁屏时钟更新 (先清掉旧的, 别重复开)
      if (lockScreenClockTimer) clearInterval(lockScreenClockTimer);
      lockScreenClockTimer = setInterval(updateLockScreenClock, 1000);
    }

    // 绑定设置界面的事件
    const lockToggle = document.getElementById('lock-screen-toggle');
    const lockDetail = document.getElementById('lock-screen-settings-detail');
    const passwordInput = document.getElementById('lock-screen-password-input');
    const wallpaperPreview = document.getElementById('lock-wallpaper-preview');

    // 回显设置
    if (lockToggle) {
      lockToggle.checked = state.globalSettings.lockScreenEnabled || false;
      lockDetail.style.display = lockToggle.checked ? 'block' : 'none';

      lockToggle.addEventListener('change', (e) => {
        lockDetail.style.display = e.target.checked ? 'block' : 'none';
      });
    }

    if (passwordInput) {
      passwordInput.value = state.globalSettings.lockScreenPassword || '';
    }

    if (state.globalSettings.lockScreenWallpaper) {
      wallpaperPreview.style.backgroundImage = `url(${state.globalSettings.lockScreenWallpaper})`;
      wallpaperPreview.textContent = '';
    }

    // ===== 绑定解锁事件（从 script.js 迁移时遗漏） =====
    const lockSwipeArea = document.getElementById('lock-swipe-area');

    // 1. 点击底部横条解锁（兼容鼠标点击）
    if (lockSwipeArea) {
      lockSwipeArea.addEventListener('click', handleUnlockTrigger);
    }

    // 2. 全屏上滑解锁监听
    if (lockScreen) {
      let touchStartY = 0;

      lockScreen.addEventListener('touchstart', (e) => {
        touchStartY = e.changedTouches[0].screenY;
      }, { passive: true });

      lockScreen.addEventListener('touchend', (e) => {
        const touchEndY = e.changedTouches[0].screenY;
        const swipeDistance = touchStartY - touchEndY;
        // 向上滑动超过 50px 触发解锁
        if (swipeDistance > 50) {
          handleUnlockTrigger();
        }
      });
    }

    // 3. 锁屏键盘按键事件
    document.querySelectorAll('.lock-keypad .key').forEach(key => {
      key.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = key.dataset.action;
        if (action === 'delete') {
          deleteKeypadInput();
        } else if (key.dataset.num) {
          handleKeypadInput(key.dataset.num);
        }
      });
    });
  }

  function updateLockScreenClock() {
    if (!lockScreenState.isLocked) return;

    const now = new Date();
    const timeString = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dateString = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

    document.getElementById('lock-time').textContent = timeString;
    document.getElementById('lock-date').textContent = dateString;
  }

  function showPasswordInput() {
    const lockScreen = document.getElementById('lock-screen');
    const passwordArea = document.getElementById('lock-password-area');

    lockScreen.classList.add('input-mode');
    passwordArea.style.display = 'flex';
    lockScreenState.passwordBuffer = '';
    updateDots();
  }

  function hidePasswordInput() {
    const lockScreen = document.getElementById('lock-screen');
    const passwordArea = document.getElementById('lock-password-area');

    lockScreen.classList.remove('input-mode');
    passwordArea.style.display = 'none';
    lockScreenState.passwordBuffer = '';
  }

  function updateDots() {
    const dots = document.querySelectorAll('.lock-dots .dot');
    const len = lockScreenState.passwordBuffer.length;
    dots.forEach((dot, index) => {
      if (index < len) dot.classList.add('filled');
      else dot.classList.remove('filled');
    });
  }

  function handleKeypadInput(num) {
    const lockScreen = document.getElementById('lock-screen');
    const isMyPhoneMode = lockScreen.classList.contains('myphone-lock-mode');

    if (isMyPhoneMode) {
      if (myPhoneLockScreenState.passwordBuffer.length < 4) {
        myPhoneLockScreenState.passwordBuffer += num;
        updateMyPhoneLockDots();

        if (myPhoneLockScreenState.passwordBuffer.length === 4) {
          setTimeout(checkMyPhoneLockPassword, 200);
        }
      }
    } else {
      if (lockScreenState.passwordBuffer.length < 4) {
        lockScreenState.passwordBuffer += num;
        updateDots();

        if (lockScreenState.passwordBuffer.length === 4) {
          setTimeout(checkLockPassword, 200);
        }
      }
    }
  }

  function deleteKeypadInput() {
    const lockScreen = document.getElementById('lock-screen');
    const isMyPhoneMode = lockScreen.classList.contains('myphone-lock-mode');

    if (isMyPhoneMode) {
      if (myPhoneLockScreenState.passwordBuffer.length > 0) {
        myPhoneLockScreenState.passwordBuffer = myPhoneLockScreenState.passwordBuffer.slice(0, -1);
        updateMyPhoneLockDots();
      }
    } else {
      if (lockScreenState.passwordBuffer.length > 0) {
        lockScreenState.passwordBuffer = lockScreenState.passwordBuffer.slice(0, -1);
        updateDots();
      }
    }
  }

  function checkLockPassword() {
    const correctPassword = state.globalSettings.lockScreenPassword;

    if (lockScreenState.passwordBuffer === correctPassword) {
      // 解锁成功
      const lockScreen = document.getElementById('lock-screen');
      lockScreen.classList.add('unlocking');
      lockScreenState.isLocked = false;

      setTimeout(() => {
        lockScreen.classList.remove('active');
        lockScreen.classList.remove('unlocking');
        hidePasswordInput();
      }, 500);
    } else {
      // 解锁失败
      const dots = document.querySelector('.lock-dots');
      dots.classList.add('shake-animation');
      if (navigator.vibrate) navigator.vibrate(200);

      setTimeout(() => {
        dots.classList.remove('shake-animation');
        lockScreenState.passwordBuffer = '';
        updateDots();
      }, 400);
    }
  }

  function handleUnlockTrigger() {
    const lockScreen = document.getElementById('lock-screen');
    // 如果已经在输入密码模式，就不重复触发
    if (lockScreen.classList.contains('input-mode')) return;

    const isMyPhoneMode = lockScreen.classList.contains('myphone-lock-mode');

    if (isMyPhoneMode) {
      const characterId = myPhoneLockScreenState.pendingCharacterId;
      if (!characterId) return;

      const char = state.chats[characterId];
      if (!char) return;

      if (char.settings.myPhoneLockScreenPassword) {
        showMyPhonePasswordInput();
      } else {
        lockScreen.classList.add('unlocking');
        myPhoneLockScreenState.isLocked = false;
        setTimeout(() => {
          lockScreen.classList.remove('active');
          lockScreen.classList.remove('unlocking');
          lockScreen.classList.remove('myphone-lock-mode');
          enterMyPhone(characterId);
          myPhoneLockScreenState.pendingCharacterId = null;
        }, 500);
      }
    } else {
      if (state.globalSettings.lockScreenPassword) {
        showPasswordInput();
      } else {
        lockScreen.classList.add('unlocking');
        lockScreenState.isLocked = false;
        setTimeout(() => {
          lockScreen.classList.remove('active');
          lockScreen.classList.remove('unlocking');
        }, 500);
      }
    }
  }

  // ========== 全局暴露 ==========
  window.applyTheme = applyTheme;
  window.applyScopedCss = applyScopedCss;
  window.applyGlobalCss = applyGlobalCss;
  window.applyPhoneFrame = applyPhoneFrame;
  window.applyAppIcons = applyAppIcons;
  window.applyCPhoneAppIcons = applyCPhoneAppIcons;
  window.applyCPhoneWallpaper = applyCPhoneWallpaper;
  window.applyMyPhoneWallpaper = applyMyPhoneWallpaper;
  window.applyMyPhoneAppIconsGlobal = applyMyPhoneAppIconsGlobal;
  window.applyDetachStatusBarMode = applyDetachStatusBarMode;
  window.applyStatusBarVisibility = applyStatusBarVisibility;
  window.applyMinimalChatUI = applyMinimalChatUI;
  window.applyTrueFullscreen = applyTrueFullscreen;
  window.applyWidgetData = applyWidgetData;
  window.initLockScreen = initLockScreen;
  window.toggleTheme = toggleTheme;
  window.importAppearanceSettings = importAppearanceSettings;
  window.exportAppearanceSettings = exportAppearanceSettings;

  // ========== 从 script.js 迁移：handleEmergencyAppearanceReset ==========
  async function handleEmergencyAppearanceReset() {
    const confirmed = await showCustomConfirm(
      "确认重置外观？",
      "此操作将把当前的壁纸、主题、CSS、图标和字体恢复为默认状态。\n\n✅ 你的【预设库】不会被删除。\n✅ 此功能用于修复因 CSS 错误导致无法打开外观设置的问题。\n\n确定要执行吗？",
      { confirmButtonClass: 'btn-danger', confirmText: '立即重置' }
    );

    if (!confirmed) return;

    await showCustomAlert("处理中...", "正在重置外观配置...");

    try {
      const defaultAppIcons = { ...DEFAULT_APP_ICONS };
      const defaultCPhoneIcons = { ...DEFAULT_CPHONE_ICONS };
      const defaultMyPhoneIcons = { ...DEFAULT_MYPHONE_ICONS };

      state.globalSettings.wallpaper = 'linear-gradient(135deg, #89f7fe, #66a6ff)';
      state.globalSettings.cphoneWallpaper = 'linear-gradient(135deg, #f6d365, #fda085)';
      state.globalSettings.globalChatBackground = '';
      state.globalSettings.globalCss = '';
      state.globalSettings.fontUrl = '';
      state.globalSettings.fontLocalData = '';
      state.globalSettings.theme = 'light';
      state.globalSettings.appIcons = defaultAppIcons;
      state.globalSettings.cphoneAppIcons = defaultCPhoneIcons;
      state.globalSettings.myphoneAppIcons = defaultMyPhoneIcons;

      state.globalSettings.showStatusBar = false;
      state.globalSettings.showPhoneFrame = false;
      state.globalSettings.detachStatusBar = false;
      state.globalSettings.enableMinimalChatUI = false;
      state.globalSettings.alwaysShowMusicIsland = false;

      state.globalSettings.chatActionButtonsOrder = null;

      await db.globalSettings.put(state.globalSettings);

      localStorage.setItem('ephone-theme', 'light');
      applyTheme('light');

      applyGlobalWallpaper();
      applyCPhoneWallpaper();
      applyMyPhoneWallpaper();

      applyGlobalCss('');
      applyCustomFont('');

      applyAppIcons();
      applyCPhoneAppIcons();
      applyMyPhoneAppIconsGlobal();

      applyStatusBarVisibility();
      applyPhoneFrame(false);
      applyDetachStatusBarMode(false);
      applyMinimalChatUI(false);

      if (typeof resetButtonOrder === 'function') {
        await resetButtonOrder();
      }

      await showCustomAlert("重置成功", "外观已恢复默认状态！\n现在你应该可以正常打开外观设置页面了。");

    } catch (error) {
      console.error("重置外观失败:", error);
      await showCustomAlert("错误", `重置失败: ${error.message}`);
    }
  }
  window.handleEmergencyAppearanceReset = handleEmergencyAppearanceReset;

  // ========== 从 script.js 迁移：uploadImageLocally ==========
  function uploadImageLocally() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';

      input.onchange = e => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = async (readerEvent) => {
            let base64Result = readerEvent.target.result;

            if (state.apiConfig.imgbbEnable && state.apiConfig.imgbbApiKey) {
              try {
                const alertModal = document.getElementById('custom-modal-overlay');
                if (!alertModal.classList.contains('visible')) {
                  await showCustomAlert("请稍候...", "正在上传图片到 ImgBB...");
                }
                const imageUrl = await uploadImageToImgBB(base64Result);
                resolve(imageUrl);
              } catch (uploadError) {
                console.error(uploadError);
                await showCustomAlert("ImgBB 上传失败", `图片上传到图床失败: ${uploadError.message}\n\n将继续使用本地 Base64 格式保存。`);
                resolve(base64Result);
              }
            } else {
              resolve(base64Result);
            }
          };
          reader.readAsDataURL(file);
        } else {
          resolve(null);
        }
      };

      input.click();
    });
  }

  window.uploadImageLocally = uploadImageLocally;

  // ========== 从 script.js 迁移：handleWidgetImageChange ==========
  async function handleWidgetImageChange(imageId) {
    const element = document.getElementById(imageId);
    if (!element) return;

    const choice = await showChoiceModal("更换图片", [
      { text: '📁 从本地上传', value: 'local' },
      { text: '🌐 使用网络URL', value: 'url' },
      { text: '🔄 重置为默认', value: 'reset' }
    ]);

    if (choice === 'reset') {
      const defaultSrc = element.dataset.defaultSrc;
      if (defaultSrc) {
        element.src = defaultSrc;
        if (state.globalSettings.widgetData && state.globalSettings.widgetData[imageId]) {
          delete state.globalSettings.widgetData[imageId];
          await db.globalSettings.put(state.globalSettings);
        }
        await showCustomAlert("成功", "已重置为默认图片！");
      } else {
        const whitePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQYV2P4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
        element.src = whitePixel;
        if (state.globalSettings.widgetData && state.globalSettings.widgetData[imageId]) {
          delete state.globalSettings.widgetData[imageId];
          await db.globalSettings.put(state.globalSettings);
        }
        await showCustomAlert("成功", "没有默认信息，已重置为纯白！");
      }
      return;
    }

    let newUrl = null;
    let isBase64 = false;

    if (choice === 'local') {
      newUrl = await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = e => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (readerEvent) => resolve(readerEvent.target.result);
            reader.readAsDataURL(file);
          } else {
            resolve(null);
          }
        };
        input.click();
      });
      if (newUrl) isBase64 = true;

    } else if (choice === 'url') {
      newUrl = await showCustomPrompt("更换图片", "请输入新的图片URL：", element.src, "url");
      if (newUrl) isBase64 = false;
    }

    if (newUrl && newUrl.trim()) {
      const trimmedUrl = newUrl.trim();
      element.src = trimmedUrl;

      if (!state.globalSettings.widgetData) {
        state.globalSettings.widgetData = {};
      }
      state.globalSettings.widgetData[imageId] = trimmedUrl;
      await db.globalSettings.put(state.globalSettings);

      await showCustomAlert("成功", "组件图片已更新并保存！");

      if (isBase64 && state.apiConfig.imgbbEnable && state.apiConfig.imgbbApiKey) {
        (async () => {
          console.log(`[ImgBB] 启动 ${imageId} 的静默上传...`);
          await silentlyUpdateDbUrl(
            db.globalSettings,
            'main',
            `widgetData.${imageId}`,
            trimmedUrl
          );
        })();
      }
    }
  }

  window.handleWidgetImageChange = handleWidgetImageChange;

  // ========== dock 椭圆容器点击上传（区分 dock 空白 vs 子图标） ==========
  function handleDockImageClick(event, imageId) {
    // 只在直接点到 dock 容器本身时触发上传；点到子图标（API设置/字体/Cphone/豆瓣）时跳过
    if (event.target !== event.currentTarget) return;
    return handleWidgetImageChange(imageId);
  }
  window.handleDockImageClick = handleDockImageClick;

  // ========== 第二刀：base64 图标自动迁移到 ImgBB 图床 ==========
  // 触发：renderWallpaperScreen 末尾 fire-and-forget
  // 行为：串行扫描三个图标 dict（appIcons / cphoneAppIcons / myphoneAppIcons）的 base64，
  //       调 uploadImageToImgBB 转 URL，每张转完：① 写回 state ② 更新对应 grid 的 <img>.src ③ 全批结束统一 db.put
  // 节流：每张间等 250ms 防 ImgBB 限流
  // 幂等：base64 转完后下次扫描全部跳过；中途关页面下次会重跑没传完的（不会重复扣额度）
  async function migrateBase64IconsToImgBB() {
    if (!state.apiConfig || !state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      console.log('[图标迁移] ImgBB 未开启或缺 key，跳过');
      return { migrated: 0, failed: 0, skipped: 'no-imgbb' };
    }
    if (typeof uploadImageToImgBB !== 'function') {
      console.warn('[图标迁移] uploadImageToImgBB 不存在，跳过');
      return { migrated: 0, failed: 0, skipped: 'no-function' };
    }

    const dicts = [
      { name: 'appIcons', dict: state.globalSettings.appIcons || {}, gridId: 'icon-settings-grid' },
      { name: 'cphoneAppIcons', dict: state.globalSettings.cphoneAppIcons || {}, gridId: 'cphone-icon-settings-grid' },
      { name: 'myphoneAppIcons', dict: state.globalSettings.myphoneAppIcons || {}, gridId: 'myphone-icon-settings-grid' }
    ];

    let migrated = 0;
    let failed = 0;
    const THROTTLE_MS = 250;
    const totalBase64 = dicts.reduce((sum, d) =>
      sum + Object.values(d.dict).filter(v => v && v.startsWith('data:')).length, 0);

    if (totalBase64 === 0) {
      console.log('[图标迁移] 没有 base64 需要迁移');
      return { migrated: 0, failed: 0, skipped: 'nothing-to-do' };
    }

    console.log(`[图标迁移] 开始：共 ${totalBase64} 张 base64 图标，预计 ${Math.ceil(totalBase64 * 1.5)}s`);

    for (const { name, dict, gridId } of dicts) {
      for (const iconId of Object.keys(dict)) {
        const value = dict[iconId];
        if (!value || !value.startsWith('data:')) continue;

        try {
          const url = await uploadImageToImgBB(value);
          if (url && !url.startsWith('data:') && url !== value) {
            dict[iconId] = url;
            // 同步 DOM（如果 grid 已渲染过，找不到就下次渲染自己会拿到 URL）
            const grid = document.getElementById(gridId);
            const item = grid && grid.querySelector(`[data-icon-id="${iconId}"]`);
            const img = item && item.querySelector('.icon-preview');
            if (img) img.src = url;
            migrated++;
            console.log(`[图标迁移] ${name}.${iconId} → ${url.substring(0, 60)}... (${migrated}/${totalBase64})`);
          } else {
            failed++;
            console.warn(`[图标迁移] ${name}.${iconId} 上传失败（函数返回仍是 base64）`);
          }
        } catch (err) {
          failed++;
          console.error(`[图标迁移] ${name}.${iconId} 异常:`, err);
        }

        await new Promise(r => setTimeout(r, THROTTLE_MS));
      }
    }

    if (migrated > 0) {
      try {
        await db.globalSettings.put(state.globalSettings);
        console.log(`[图标迁移] ✅ 完成：迁移 ${migrated} 张到图床，失败 ${failed} 张，已写入 db`);
      } catch (err) {
        console.error('[图标迁移] db.put 失败:', err);
      }
    }
    return { migrated, failed };
  }
  window.migrateBase64IconsToImgBB = migrateBase64IconsToImgBB;

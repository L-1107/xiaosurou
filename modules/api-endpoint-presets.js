// ============================================================
// API 站点预设库：各功能位仅引用预设 ID + 独立模型，地址/密钥只存一份
// ============================================================

(function () {
  const MIGRATION_FLAG = 'endpointPresetsMigratedV2';

  function presetKey(url, key) {
    return `${(url || '').trim()}\t${(key || '').trim()}`;
  }

  async function findOrCreateEndpointPreset(nameHint, url, apiKey) {
    url = (url || '').trim();
    apiKey = (apiKey || '').trim();
    if (!url || !apiKey) return null;
    const all = await db.apiPresets.toArray(); // 改为从API预设中查找
    const pk = presetKey(url, apiKey);
    const found = all.find((p) => presetKey(p.proxyUrl, p.apiKey) === pk);
    if (found) return found.id;
    // 创建API预设而不是endpoint预设
    return db.apiPresets.add({
      name: nameHint || `站点_${all.length + 1}`,
      proxyUrl: url,
      apiKey,
      model: 'gpt-3.5-turbo' // 默认模型
    });
  }

  /**
   * 【已废弃】旧版迁移逻辑，不再自动创建"迁移·XXX"预设。
   * 仅标记迁移完成，不做任何预设创建操作。
   * 各功能位的 URL/Key 已直接存储在 apiConfig 中，无需额外预设。
   */
  async function migrateLegacyEndpointAssignments(cfg) {
    if (cfg[MIGRATION_FLAG]) return cfg;
    // 直接标记为已迁移，不再创建任何"迁移·XXX"预设
    cfg[MIGRATION_FLAG] = true;
    return cfg;
  }

  const API_SLOT_DEFS = {
    main: {
      endpointPresetIdKey: 'mainEndpointPresetId',
      modelKey: 'model',
      proxyUrlKey: 'proxyUrl',
      apiKeyKey: 'apiKey',
      selectId: 'slot-main-endpoint-preset',
      modelInputId: 'model-input'
    },
    secondary: {
      endpointPresetIdKey: 'secondaryEndpointPresetId',
      modelKey: 'secondaryModel',
      proxyUrlKey: 'secondaryProxyUrl',
      apiKeyKey: 'secondaryApiKey',
      selectId: 'slot-secondary-endpoint-preset',
      modelInputId: 'secondary-model-input'
    },
    background: {
      endpointPresetIdKey: 'backgroundEndpointPresetId',
      modelKey: 'backgroundModel',
      proxyUrlKey: 'backgroundProxyUrl',
      apiKeyKey: 'backgroundApiKey',
      selectId: 'slot-background-endpoint-preset',
      modelInputId: 'background-model-input'
    },
    vision: {
      endpointPresetIdKey: 'visionEndpointPresetId',
      modelKey: 'visionModel',
      proxyUrlKey: 'visionProxyUrl',
      apiKeyKey: 'visionApiKey',
      selectId: 'slot-vision-endpoint-preset',
      modelInputId: 'vision-model-input'
    },
    couplespace: {
      endpointPresetIdKey: 'couplespaceEndpointPresetId',
      modelKey: 'couplespaceModel',
      proxyUrlKey: 'couplespaceProxyUrl',
      apiKeyKey: 'couplespaceApiKey',
      selectId: 'slot-couplespace-endpoint-preset',
      modelInputId: 'couplespace-model-input'
    }
  };

  function getApiPresetDefaultModel(preset) {
    return (preset && (preset.defaultModel || preset.model || '') || '').trim();
  }

  function normalizePresetId(value) {
    if (value == null || value === '') return null;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }

  function getSlotDef(slotName) {
    return API_SLOT_DEFS[slotName] || API_SLOT_DEFS.main;
  }

  function getSlotPresetId(cfg, def, inheritMain) {
    const ownId = normalizePresetId(cfg[def.endpointPresetIdKey]);
    if (ownId || !inheritMain || def === API_SLOT_DEFS.main) return ownId;
    return normalizePresetId(cfg.mainEndpointPresetId);
  }

  function clearReferencedSlotStaticEndpoints(cfg) {
    if (!cfg) return;
    Object.keys(API_SLOT_DEFS).forEach((slotName) => {
      const def = API_SLOT_DEFS[slotName];
      const presetId = getSlotPresetId(cfg, def, false);
      if (!presetId) return;
      cfg[def.proxyUrlKey] = '';
      cfg[def.apiKeyKey] = '';
    });
  }

  function denormalizeApiEndpointsSync(cfg, byId) {
    // 兼容旧调用名：五个 API 设置区现在只持久化预设引用，不再把预设库的
    // proxyUrl/apiKey 复制回各区配置。实际展示/拉模型/请求统一走
    // resolveApiSlotConfig() 实时读取 db.apiPresets。
    clearReferencedSlotStaticEndpoints(cfg);
  }

  async function denormalizeApiEndpointsFromPresets(cfg) {
    denormalizeApiEndpointsSync(cfg, null);
  }

  async function resolveApiSlotConfig(slotName, options) {
    const cfg = (options && options.config) || state.apiConfig || {};
    const def = getSlotDef(slotName);
    const inheritMain = !(options && options.inheritMain === false);
    const presetId = getSlotPresetId(cfg, def, inheritMain);
    let preset = null;
    if (presetId) {
      preset = await db.apiPresets.get(presetId);
    }

    if (preset && (preset.proxyUrl || '').trim() && (preset.apiKey || '').trim()) {
      return {
        slot: slotName,
        presetId,
        preset,
        proxyUrl: (preset.proxyUrl || '').trim(),
        apiKey: preset.apiKey || '',
        model: (cfg[def.modelKey] || getApiPresetDefaultModel(preset) || '').trim()
      };
    }

    if (presetId) {
      console.warn(`[API 设置] ${slotName} API 引用的预设不存在或缺少地址/API Key，已回退旧字段：`, presetId);
    }

    return {
      slot: slotName,
      presetId: null,
      preset: null,
      proxyUrl: (cfg[def.proxyUrlKey] || '').trim(),
      apiKey: cfg[def.apiKeyKey] || '',
      model: (cfg[def.modelKey] || '').trim()
    };
  }

  async function applyApiEndpointMigrationAndDenorm() {
    let cfg = await db.apiConfig.get('main');
    if (!cfg) return;
    cfg = await migrateLegacyEndpointAssignments(cfg);
    clearReferencedSlotStaticEndpoints(cfg);
    await db.apiConfig.put(cfg);
    Object.assign(state.apiConfig, cfg);
  }

  async function fillEndpointPresetSelect(selectEl, selectedId, includeEmpty, emptyLabel) {
    if (!selectEl) return;
    const cur = selectedId != null && selectedId !== '' ? String(selectedId) : '';
    selectEl.innerHTML = '';
    if (includeEmpty) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = emptyLabel || '— 同主 API 站点 —';
      selectEl.appendChild(o);
    }
    // 从API预设中获取站点信息，而不是单独的endpoint预设
    const presets = await db.apiPresets.toArray();
    const endpointPresets = presets
      .filter(p => p.proxyUrl && p.apiKey)
      .map(p => ({
        id: p.id,
        name: p.name || `预设 #${p.id}`,
        proxyUrl: p.proxyUrl,
        apiKey: p.apiKey
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    endpointPresets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name;
      selectEl.appendChild(opt);
    });
    if (cur && [...selectEl.options].some((o) => o.value === cur)) {
      selectEl.value = cur;
    } else {
      selectEl.value = includeEmpty ? '' : cur;
    }
  }

  async function refreshAllEndpointPresetUi() {
    const cfg = state.apiConfig || {};
    await fillEndpointPresetSelect(document.getElementById('endpoint-preset-library-select'), null, false, '');

    await fillEndpointPresetSelect(
      document.getElementById('slot-main-endpoint-preset'),
      cfg.mainEndpointPresetId,
      true,
      '— 请选择站点预设 —'
    );
    await fillEndpointPresetSelect(
      document.getElementById('slot-secondary-endpoint-preset'),
      cfg.secondaryEndpointPresetId,
      true,
      '— 同主 API 站点 —'
    );
    await fillEndpointPresetSelect(
      document.getElementById('slot-background-endpoint-preset'),
      cfg.backgroundEndpointPresetId,
      true,
      '— 同主 API 站点 —'
    );
    await fillEndpointPresetSelect(
      document.getElementById('slot-vision-endpoint-preset'),
      cfg.visionEndpointPresetId,
      true,
      '— 同主 API 站点 —'
    );
    await fillEndpointPresetSelect(
      document.getElementById('slot-couplespace-endpoint-preset'),
      cfg.couplespaceEndpointPresetId,
      true,
      '— 同主 API 站点 —'
    );

    const slotIds = ['slot-main-endpoint-preset', 'slot-secondary-endpoint-preset', 'slot-background-endpoint-preset', 'slot-vision-endpoint-preset', 'slot-couplespace-endpoint-preset'];
    slotIds.forEach(slotId => {
      const slotEl = document.getElementById(slotId);
      if (slotEl && slotEl.dataset.endpointSlotBound !== '1') {
        slotEl.dataset.endpointSlotBound = '1';
        slotEl.addEventListener('change', async () => {
          await syncApiEndpointSlotsFromDomToState({ applyDefaultModel: true });
          await refreshAllEndpointPresetUi();
        });
      }
    });

    const endpointFieldMap = {
      'proxy-url': { slot: 'main', field: 'proxyUrl' },
      'api-key': { slot: 'main', field: 'apiKey' },
      'secondary-proxy-url': { slot: 'secondary', field: 'secondaryProxyUrl' },
      'secondary-api-key': { slot: 'secondary', field: 'secondaryApiKey' },
      'background-proxy-url': { slot: 'background', field: 'backgroundProxyUrl' },
      'background-api-key': { slot: 'background', field: 'backgroundApiKey' },
      'vision-proxy-url': { slot: 'vision', field: 'visionProxyUrl' },
      'vision-api-key': { slot: 'vision', field: 'visionApiKey' },
      'couplespace-proxy-url': { slot: 'couplespace', field: 'couplespaceProxyUrl' },
      'couplespace-api-key': { slot: 'couplespace', field: 'couplespaceApiKey' }
    };
    for (const [id, meta] of Object.entries(endpointFieldMap)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const resolved = await resolveApiSlotConfig(meta.slot);
      el.value = resolved && resolved.preset ? (resolved[meta.field.endsWith('ApiKey') || meta.field === 'apiKey' ? 'apiKey' : 'proxyUrl'] || '') : (state.apiConfig[meta.field] || '');
    }
  }

  let modalEditingId = null;

  function openEndpointPresetModal(idOrNull) {
    const modal = document.getElementById('endpoint-preset-edit-modal');
    const title = document.getElementById('endpoint-preset-edit-modal-title');
    const nameI = document.getElementById('endpoint-preset-edit-name');
    const urlI = document.getElementById('endpoint-preset-edit-url');
    const keyI = document.getElementById('endpoint-preset-edit-key');
    if (!modal || !nameI || !urlI || !keyI) return;
    modalEditingId = idOrNull;
    if (idOrNull) {
      db.apiEndpointPresets.get(idOrNull).then((p) => {
        if (!p) return;
        title.textContent = '编辑站点预设';
        nameI.value = p.name || '';
        urlI.value = p.proxyUrl || '';
        keyI.value = p.apiKey || '';
        modal.classList.add('visible');
      });
    } else {
      title.textContent = '新建站点预设';
      nameI.value = '';
      urlI.value = '';
      keyI.value = '';
      modal.classList.add('visible');
    }
  }

  function closeEndpointPresetModal() {
    const modal = document.getElementById('endpoint-preset-edit-modal');
    if (modal) modal.classList.remove('visible');
    modalEditingId = null;
  }

  async function saveEndpointPresetModal() {
    const nameI = document.getElementById('endpoint-preset-edit-name');
    const urlI = document.getElementById('endpoint-preset-edit-url');
    const keyI = document.getElementById('endpoint-preset-edit-key');
    const name = (nameI && nameI.value.trim()) || '';
    const proxyUrl = (urlI && urlI.value.trim()) || '';
    const apiKey = (keyI && keyI.value.trim()) || '';
    if (!name) {
      alert('请填写预设名称');
      return;
    }
    if (!proxyUrl || !apiKey) {
      alert('请填写 Base URL 与 API Key');
      return;
    }
    const row = { name, proxyUrl, apiKey };
    if (modalEditingId) {
      row.id = modalEditingId;
      await db.apiEndpointPresets.put(row);
    } else {
      await db.apiEndpointPresets.add(row);
    }
    closeEndpointPresetModal();
    clearReferencedSlotStaticEndpoints(state.apiConfig);
    await db.apiConfig.put(state.apiConfig);
    await refreshAllEndpointPresetUi();
    alert('站点预设已保存');
  }

  async function deleteLibraryPresetSelected() {
    const sel = document.getElementById('endpoint-preset-library-select');
    if (!sel || !sel.value) {
      alert('请先在列表中选择一个预设');
      return;
    }
    const id = parseInt(sel.value, 10);
    const p = await db.apiEndpointPresets.get(id);
    if (!p) return;
    const ok = await showCustomConfirm(
      '删除站点预设',
      `确定删除「${p.name}」吗？若功能位正在使用该预设，请先在各功能位改用其他预设。`,
      { confirmButtonClass: 'btn-danger' }
    );
    if (!ok) return;
    await db.apiEndpointPresets.delete(id);
    await refreshAllEndpointPresetUi();
  }

  async function duplicateLibraryPresetSelected() {
    const sel = document.getElementById('endpoint-preset-library-select');
    if (!sel || !sel.value) {
      alert('请先在列表中选择一个预设');
      return;
    }
    const id = parseInt(sel.value, 10);
    const p = await db.apiEndpointPresets.get(id);
    if (!p) return;
    const name = await showCustomPrompt('复制站点预设', '新预设名称');
    if (!name || !name.trim()) return;
    await db.apiEndpointPresets.add({
      name: name.trim(),
      proxyUrl: p.proxyUrl,
      apiKey: p.apiKey
    });
    await refreshAllEndpointPresetUi();
    alert('已复制为新预设');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('endpoint-preset-new-btn')?.addEventListener('click', () => openEndpointPresetModal(null));
    document.getElementById('endpoint-preset-edit-btn')?.addEventListener('click', () => {
      const sel = document.getElementById('endpoint-preset-library-select');
      if (!sel || !sel.value) {
        alert('请先在列表中选择一个预设');
        return;
      }
      openEndpointPresetModal(parseInt(sel.value, 10));
    });
    document.getElementById('endpoint-preset-delete-btn')?.addEventListener('click', () => deleteLibraryPresetSelected());
    document.getElementById('endpoint-preset-duplicate-btn')?.addEventListener('click', () => duplicateLibraryPresetSelected());
    document.getElementById('endpoint-preset-edit-cancel')?.addEventListener('click', closeEndpointPresetModal);
    document.getElementById('endpoint-preset-edit-confirm')?.addEventListener('click', () => saveEndpointPresetModal());
    document.getElementById('endpoint-preset-edit-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'endpoint-preset-edit-modal') closeEndpointPresetModal();
    });
  });

  window.applyApiEndpointMigrationAndDenorm = applyApiEndpointMigrationAndDenorm;
  window.denormalizeApiEndpointsFromPresets = denormalizeApiEndpointsFromPresets;
  window.resolveApiSlotConfig = resolveApiSlotConfig;
  window.getApiPresetDefaultModel = getApiPresetDefaultModel;
  window.clearReferencedSlotStaticEndpoints = clearReferencedSlotStaticEndpoints;
  window.refreshAllEndpointPresetUi = refreshAllEndpointPresetUi;
  window.openEndpointPresetModal = openEndpointPresetModal;
  window.findOrCreateEndpointPreset = findOrCreateEndpointPreset;

  /**
   * 把各槽位【当前实际在用的】地址/密钥/模型, 同步回 state.apiConfig (只改内存, 不写库)。
   *
   * ⚠️ 为什么需要它 (2026-10-23):
   *   站点预设启用后, 数据库里只留"预设引用", 静态的 proxyUrl/apiKey 会被清空
   *   (clearReferencedSlotStaticEndpoints)。
   *   应用启动时 (init-and-state.js) 会解析一次预设并回填到 state.apiConfig,
   *   所以老代码读 state.apiConfig.proxyUrl 大多能拿到值 —— 但那是【启动时的一份快照】。
   *   用户换一个预设之后, 只有"预设引用"变了, 快照还是旧的 →
   *   所有还在读 state.apiConfig 的地方 (几十处) 会继续用旧地址
   *   (最坑的是"旧地址 + 新模型"的错配), 悬浮球切预设后必现。
   *   这个函数就是"换预设 / 改预设之后立刻把快照刷新"的统一入口。
   *
   * 什么时候要调:
   *   · 应用启动            (init-and-state.js)
   *   · 保存 API 设置        (init-event-bindingsA.js)
   *   · 设置页换槽位预设     (syncApiEndpointSlotsFromDomToState)
   *   · 悬浮球换主 API 预设   (floating-ball.js)
   *   · 预设库里改了/删了预设 (settings-presets.js / floating-ball.js)
   */
  async function syncApiSlotConfigIntoState() {
    const cfg = state.apiConfig || (state.apiConfig = {});
    const gs = state.globalSettings || (state.globalSettings = {});
    for (const slotName of Object.keys(API_SLOT_DEFS)) {
      const def = API_SLOT_DEFS[slotName];
      let resolved = null;
      try {
        resolved = await resolveApiSlotConfig(slotName);
      } catch (e) {
        console.warn(`[API 设置] 解析 ${slotName} 槽位预设失败:`, (e && e.message) || e);
        continue;
      }
      if (!resolved || !resolved.proxyUrl || !resolved.apiKey) continue;
      cfg[def.proxyUrlKey] = resolved.proxyUrl;
      cfg[def.apiKeyKey] = resolved.apiKey;
      cfg[def.modelKey] = resolved.model;
      // 保留旧字段同步（可能别的地方用）
      gs[def.proxyUrlKey] = resolved.proxyUrl;
      gs[def.apiKeyKey] = resolved.apiKey;
      gs[def.modelKey] = resolved.model;
    }
    return cfg;
  }
  window.syncApiSlotConfigIntoState = syncApiSlotConfigIntoState;

  /** 供加载整套 bundle 预设后补全 endpoint 引用 */
  window.syncApiEndpointSlotsFromDomToState = async function (options) {
    const cfg = state.apiConfig;
    const applyDefaultModel = !!(options && options.applyDefaultModel);
    const changedSlots = [];
    const pick = (id) => {
      const el = document.getElementById(id);
      if (!el || el.value === '' || el.value == null) return null;
      const n = parseInt(el.value, 10);
      return Number.isNaN(n) ? null : n;
    };

    Object.keys(API_SLOT_DEFS).forEach((slotName) => {
      const def = API_SLOT_DEFS[slotName];
      const nextId = pick(def.selectId);
      const prevId = normalizePresetId(cfg[def.endpointPresetIdKey]);
      cfg[def.endpointPresetIdKey] = nextId;
      if (nextId !== prevId) changedSlots.push(slotName);
    });

    if (applyDefaultModel) {
      for (const slotName of changedSlots) {
        const def = getSlotDef(slotName);
        const presetId = normalizePresetId(cfg[def.endpointPresetIdKey]);
        if (!presetId) continue;
        const preset = await db.apiPresets.get(presetId);
        const defaultModel = getApiPresetDefaultModel(preset);
        if (!defaultModel) continue;
        cfg[def.modelKey] = defaultModel;
        const input = document.getElementById(def.modelInputId);
        if (input) input.value = defaultModel;
      }
    }

    // 预设引用变了 → 立刻把 state.apiConfig 里的地址/密钥刷新成【当前实际在用的】那套。
    // 不刷新的话, 所有还读 state.apiConfig 的地方(几十处)会继续用旧地址,
    // 最坑的是"旧地址 + 新模型"的错配 —— 悬浮球切预设后必现。
    await syncApiSlotConfigIntoState();
  };

  /**
   * 【已废弃】不再自动创建"迁移·XXX"预设。
   * 保留函数签名以避免调用方报错，但内部不再执行任何操作。
   */
  window.syncEndpointPresetIdsFromUrlsInConfig = async function (cfg) {
    // 此函数已废弃，不再自动创建预设
    // 如果需要同步，请手动在 API 预设管理界面操作
  };
})();

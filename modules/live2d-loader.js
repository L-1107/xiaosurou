// Live2D 加载器 — PIXI v6.5.0 + pixi-live2d-display 0.4.0 + Cubism Core 4
// v0.3.0 回退到 330 v0.1.30 旧栈 (v8 + untitled 1.3.5 整库 PIXI v8 兼容 bug, renderOrder undefined)
// 跟之前一样挂在 window.Live2DLoader 上, API 不变, video-voice-call.js 无需改
// UMD 模式: PIXI + pixi-live2d-display 0.4.0 cubism4 都通过 <script> 加载, 暴露 window 全局

(function (global) {
  'use strict';

  function getPixi() {
    return global.PIXI || null;
  }
  function getLive2DModel() {
    var p = global.PIXI;
    if (!p || !p.live2d) return null;
    return p.live2d.Live2DModel || null;
  }

  async function mountLive2D(canvas, modelPath, options) {
    options = options || {};
    if (!canvas) return { success: false, error: new Error('canvas is null') };
    // v0.5.0 P2.4: 接受 string (URL) 或 object (改写后的 model3.json JS 对象, 走糯米粉做法跳过 transient blob)
    if (!modelPath || (typeof modelPath !== 'string' && typeof modelPath !== 'object')) {
      return { success: false, error: new Error('modelPath is empty') };
    }

    try {
      var PIXI = getPixi();
      var Live2DModel = getLive2DModel();
      if (!PIXI) {
        return { success: false, error: new Error('window.PIXI not loaded — check pixi.min.js script tag') };
      }
      if (!Live2DModel) {
        return { success: false, error: new Error('window.PIXI.live2d.Live2DModel not loaded — check pixi-live2d-display 0.4.0 cubism4.min.js script tag') };
      }

      const parent = canvas.parentElement;
      const w = (parent && parent.clientWidth) || canvas.clientWidth || 300;
      const h = (parent && parent.parentElement && parent.parentElement.clientHeight) || canvas.clientHeight || 400;

      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.style.display = 'block';
      canvas.style.zIndex = '99999';
      canvas.style.pointerEvents = 'none';

      // 监听 WebGL context lost
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        console.warn('[Live2D] WebGL context LOST — GPU 资源可能耗尽');
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        console.log('[Live2D] WebGL context RESTORED');
      }, false);

      // v0.5.0 P1.6: iOS PWA mode 切到管理页时 canvas 还是 0x0 (clientWidth=0), 等 1 帧让 layout 完成
      // 否则 PIXI.Application init 时 createElement('canvas') 0x0 + iOS PWA WebGL 限制 -> "Network error"
      await new Promise(r => requestAnimationFrame(r));
      // PIXI v6 Application init 是同步的 (v8 才改异步)
      var app = new PIXI.Application({
        view: canvas,
        width: w,
        height: h,
        backgroundAlpha: 0,
        autoStart: true,
        antialias: true,
        resolution: global.devicePixelRatio || 1,
        autoDensity: true,
      });

      // 0.4.0 用 autoInteract: false 避免它自己接管鼠标
      const model = await Live2DModel.from(modelPath, {
        autoInteract: false,
      });

      // bridge: 0.4.0 + 老 Cubism 4 moc3 v3 模型的 drawables.renderOrders 字段可能未初始化
      // (导致 PIXI 渲染时 renderOrder[i] undefined 报错)
      // 从糯米 utils/live2dCore.ts:106 bridgeCubism6RenderOrders 抄过来, PIXI v6 + 0.4.0 兼容版
      try {
        const internal = model && model.internalModel;
        const rawModel = internal && internal.coreModel && internal.coreModel._model;
        const drawables = rawModel && rawModel.drawables;
        if (drawables && !drawables.renderOrders) {
          const renderOrders = (rawModel.getRenderOrders && rawModel.getRenderOrders()) || rawModel.renderOrders;
          if (renderOrders) {
            const drawableCount = Number(drawables.count != null ? drawables.count : renderOrders.length);
            drawables.renderOrders = typeof renderOrders.subarray === 'function'
              ? renderOrders.subarray(0, drawableCount)
              : renderOrders;
            // bridge: drawables.renderOrders 已补
          }
        }
      } catch (bridgeErr) {
        // bridge 跳过
      }

      app.stage.addChild(model);

      // v0.1.4 行为: 等几帧让 internal model 完成 setup
      let frameWait = 0;
      for (let fi = 0; fi < 5; fi++) {
        await new Promise(r => requestAnimationFrame(r));
        frameWait = fi + 1;
        if (model.width > 0 && model.height > 0) break;
      }

      const defaultScale = options.scale != null ? options.scale : 0.4;
      let finalScale = defaultScale;
      if (model.width > 0 && model.height > 0) {
        const fitScale = Math.min((w * 0.7) / model.width, (h * 0.7) / model.height);
        finalScale = Math.min(fitScale, defaultScale * 5);
        if (fitScale > defaultScale) finalScale = defaultScale;
      }
      model.scale.set(finalScale, finalScale);
      model.anchor.set(0.5, 0.5);
      // v0.3.5: 居中必须用 renderer.screen(逻辑像素); renderer.width 是「设备像素」(逻辑 × devicePixelRatio),
      // 用它居中会让模型中心跑到 (屏宽 × dpr / 2) —— 实测 iPhone(dpr3) 上模型完全跑到屏幕外,
      // 电脑 125%/150% 缩放下偏右下并被裁掉。dpr=1 时两者相同, 所以只在电脑 100% 缩放下看不出问题。
      model.x = app.renderer.screen.width / 2;
      model.y = app.renderer.screen.height / 2;
      if (options.x !== undefined) model.x = options.x;
      if (options.y !== undefined) model.y = options.y;

      if (options.autoStartIdle !== false) {
        try {
          if (typeof model.motion === 'function') {
            model.motion('Idle');
          } else if (model.internalModel && model.internalModel.motionManager) {
            const mm = model.internalModel.motionManager;
            if (typeof mm.startMotion === 'function') mm.startMotion('Idle');
            else if (typeof mm.play === 'function') mm.play('Idle');
          }
        } catch (e) {
          // Idle 组不存在, 静默忽略
        }
      }

      canvas._live2dApp = app;
      canvas._live2dModel = model;

      // ── v0.5.1 竞态自检: 挂断发生在挂载途中 ──────────────────────
      // 挂载全程是异步的 (等 IDB 读模型 → 逐个建 blob URL → fetch moc3/纹理
      // → 再等 5 帧让 internal model setup 完), 这中间用户随时可能挂断。
      // 而 video-voice-call.js 的 unmountLive2DForCall 是这么写的:
      //     disposeLive2D(canvas);  // ← _live2dApp 还没建, 这里直接 return false
      //     canvas.remove();         // ← canvas 被摘出 DOM
      // 也就是说挂断发生在【上面这两行之前】时, 那时确实还没建任何东西, 无可释放;
      // 但【走到这里之后】建出来的 PIXI + WebGL context + 全部纹理就永远没人回收了 ——
      // canvas 已经不在文档里, getElementById 再也找不到它。
      // 结果: 一次"接通后几秒内挂断"就泄漏一整套 GPU 资源, 直到页面关闭。
      // 修法: 建完立刻自检一次。已被摘走 = 已经挂断, 当场自我销毁。
      // 代价: 仅在"挂断发生于挂载途中"这一种情况下执行, 正常通话永远走不到这一行。
      // (管理页 live2d-manager.js 的 canvas 一直在 DOM 里, 同样不受影响。)
      if (typeof canvas.isConnected === 'boolean' && canvas.isConnected === false) {
        console.warn('[Live2D] 挂载途中通话已挂断 (canvas 已脱离 DOM), 丢弃本次挂载并释放 GPU 资源');
        try { app.destroy(false, { children: true, texture: true }); } catch (e) { /* ignore */ }
        canvas._live2dApp = null;
        canvas._live2dModel = null;
        canvas._live2dInitialParams = null;
        // 返回失败 → mountLive2DFromIDB 会走失败分支, 自动 revoke 这一批 blob URL
        return { success: false, error: new Error('挂断发生在模型加载途中, 已取消挂载') };
      }

      // v0.3.6: 挂载完成时拍一次「参数基线」快照, 给"↺ 默认 / 恢复默认"用。
      // 为什么必须在【挂载时】拍 (而不是打开管理面板时):
      //   这是模型刚加载完、任何表情都还没应用过的纯净状态, 相当于"模型出厂表情"。
      //   如果改成"面板打开那一刻"拍, 那时画面上可能已经有表情生效(比如上次选了还没恢复),
      //   快照记下的就是"带表情"的脏值 → 之后点恢复默认只是回到那个脏状态 →
      //   表现为"有的表情能恢复、有的恢复不了"且时好时坏。
      // 时机与调试台对齐: live2d-manager.js:700 saveInitialParamValues(挂载后立即拍)。
      // 快照失败不阻塞挂载 (调用方拿不到基线会自己兜底)。
      try {
        const core = model.internalModel
          && (model.internalModel.coreModel || model.internalModel._model);
        if (core
            && typeof core.getParameterCount === 'function'
            && typeof core.getParameterValueByIndex === 'function') {
          const snap = new Map();
          const n = core.getParameterCount();
          for (let i = 0; i < n; i++) {
            try { snap.set(i, core.getParameterValueByIndex(i)); } catch (e) { /* 跳过该参数 */ }
          }
          if (snap.size > 0) {
            canvas._live2dInitialParams = snap;
            console.log('[Live2D] 参数基线快照就绪: ' + snap.size + ' 个参数 (↺ 默认 用)');
          }
        }
      } catch (e) { /* 快照失败不阻塞挂载 */ }

      console.log('[Live2D v0.3.0] mounted:', modelPath, 'size:', w, 'x', h, 'frames:', frameWait);
      return { success: true, app, model };
    } catch (err) {
      console.warn('[Live2D] mount failed:', err, 'path:', modelPath);
      // 清理残留 PIXI Application
      if (canvas._live2dApp) {
        try { canvas._live2dApp.destroy(true, { children: true, texture: true }); } catch (e) {}
        canvas._live2dApp = null;
      }
      return { success: false, error: err };
    }
  }

  function disposeLive2D(canvas) {
    if (!canvas || !canvas._live2dApp) return false;
    try {
      // v0.5.0 P1.4: destroy(false, ...) 第一个参数 removeView=false, 不从 DOM 移除 canvas 元素
      // 之前 destroy(true, ...) 会在切模型时把 canvas 从 DOM detach, 下次 selectModel 时
      // screenEl.querySelector('[data-role="canvas"]') 找不到 (元素已从 DOM 移除)
      // user 报 "删除模型后立即上传新模型预览报 canvas DOM 元素找不到" 真凶就是这个
      canvas._live2dApp.destroy(false, { children: true, texture: true });
    } catch (e) {
      console.warn('[Live2D] dispose error:', e);
    }
    canvas._live2dApp = null;
    canvas._live2dModel = null;
    canvas._live2dModelJson = null;
    // P1.5 revoke IDB 模式创建的 blob URL
    if (Array.isArray(canvas._live2dBlobUrls)) {
      canvas._live2dBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
      canvas._live2dBlobUrls = null;
    }
    return true;
  }

  function playMotion(canvas, group, index) {
    if (group == null) group = 'Idle';
    if (index == null) index = 0;
    const model = canvas && canvas._live2dModel;
    if (!model) return false;
    try {
      if (typeof model.motion === 'function') {
        model.motion(group, index);
        return true;
      }
      if (model.internalModel && model.internalModel.motionManager) {
        const mm = model.internalModel.motionManager;
        if (typeof mm.startMotion === 'function') { mm.startMotion(group, index); return true; }
        if (typeof mm.play === 'function') { mm.play(group, index); return true; }
      }
    } catch (e) {
      console.warn('[Live2D] playMotion failed:', e);
    }
    return false;
  }

  // v0.5.0 P2.5: 从 .exp3.json 的 Parameters 数组, 用 SDK coreModel.setParameterValueByIndex 直改模型参数
  // 抄糯米机 Live2DAvatarCanvas + live2d-manager.js applyExpressionToModel 已验证的路径.
  // 0.4.0 cubism4 fork 不实例化 expressionManager, 走库 setExpression 会抛异常, 这里绕开库直写参数.
  // 返回 true = 至少应用了一个参数; false = 找不到 expression 对应参数 (调用方 fallback).
  async function applyExpressionViaCoreModel(model, expressionId, data) {
    // 1. 从 data.files 找 .exp3.json (basename 匹配 expressionId, 忽略大小写)
    //    data 由 mountLive2DFromIDB 缓存到 canvas._live2dModelData.
    if (!model || !model.internalModel || !expressionId || !data || !data.files) {
      return false;
    }
    const core = model.internalModel.coreModel
      || model.internalModel._model
      || (model.internalModel.coreModel && model.internalModel.coreModel._model)
      || null;
    if (!core || typeof core.setParameterValueByIndex !== 'function') {
      return false;
    }
    if (typeof core.getParameterIndex !== 'function') {
      return false;
    }

    // 2. 定位匹配的 .exp3.json blob
    let exp3Blob = null;
    const extIdx = expressionId.toLowerCase().endsWith('.exp3.json') ? expressionId.length : -1;
    const want = extIdx > 0 ? expressionId.substring(0, extIdx) : expressionId; // 去 .exp3.json
    for (const [filePath, blob] of data.files.entries()) {
      const lower = filePath.toLowerCase();
      if (!lower.endsWith('.exp3.json')) continue;
      const base = filePath.substring(filePath.lastIndexOf('/') + 1, lower.lastIndexOf('.exp3.json'));
      if (base === want) { exp3Blob = blob; break; }
    }
    if (!exp3Blob || typeof exp3Blob.text !== 'function') {
      return false;
    }

    // 3. 解析 Parameters, 逐个 setParameterValueByIndex
    let applied = 0;
    try {
      const expJson = JSON.parse(await exp3Blob.text());
      const params = Array.isArray(expJson.Parameters) ? expJson.Parameters : [];
      for (const p of params) {
        if (!p || !p.Id) continue;
        let index = -1;
        try { index = core.getParameterIndex(p.Id); } catch (e) { index = -1; }
        if (index < 0) continue;
        const value = typeof p.Value === 'number' ? p.Value : 0;
        const blend = p.Blend || 'Overwrite';
        try {
          let newVal = value;
          if (blend === 'Add' && typeof core.getParameterValueByIndex === 'function') {
            newVal = core.getParameterValueByIndex(index) + value;
          } else if (blend === 'Multiply' && typeof core.getParameterValueByIndex === 'function') {
            newVal = core.getParameterValueByIndex(index) * value;
          }
          core.setParameterValueByIndex(index, newVal);
          applied++;
        } catch (e) { /* skip this param */ }
      }
    } catch (e) {
      console.warn('[Live2D] applyExpressionViaCoreModel parse exp3 failed:', e);
      return false;
    }
    return applied > 0;
  }

  async function setExpression(canvas, expressionId) {
    const model = canvas && canvas._live2dModel;
    if (!model) return false;
    try {
      if (!expressionId) {
        const em = model.internalModel && model.internalModel.motionManager && model.internalModel.motionManager.expressionManager;
        if (em && typeof em.resetExpression === 'function') {
          em.resetExpression();
          return true;
        }
        return false;
      }
      // 1. 优先 SDK 直改 (applyExpressionViaCoreModel): 跟模型预览台 live2d-manager.js 用的是同一套,
      //    按 .exp3.json basename 匹配并 coreModel.setParameterValueByIndex 改参.
      //    原因: 之前优先走库 expressionManager 时, em 按 model3.json FileReferences.Expressions[].Name
      //    查找 id, 对"猫耳"这类未在 model3.json 声明但 .exp3.json 文件仍存于 IDB 的表情会 silent fail,
      //    我们又直接 return true → SDK fallback 走不到 → 按钮按了不响应.
      //    SDK 路径预览台已经验证对所有 .exp3.json 都生效.
      //    data 从 canvas._live2dModelData 拿 (mountLive2DFromIDB 缓存).
      const viaCore = await applyExpressionViaCoreModel(model, expressionId, canvas._live2dModelData);
      if (viaCore) return true;
      // 2. SDK 失败 → 再尝试库 expressionManager (某些模型 em 注册了部分声明过的表情, 兜底保留)
      const em = model.internalModel && model.internalModel.expressionManager;
      if (em && typeof em.setExpression === 'function') {
        em.setExpression(expressionId);
        return true;
      }
      console.warn('[Live2D] setExpression: SDK 直改及库 expressionManager 都不可用 (id=' + expressionId + ')');
      return false;
    } catch (e) {
      console.warn('[Live2D] setExpression failed:', e);
      return false;
    }
  }

  function isMounted(canvas) {
    return !!(canvas && canvas._live2dApp);
  }

  // P1.5 从 IndexedDB 加载模型 — 内部把 files Map 改写为 blob URL, 调原 mountLive2D
  // 依赖: window.Live2DStorage.getModel(modelId) 返回 { files: Map<path, Blob>, modelPath, ... }
  // disposeLive2D 时会自动 revoke 跟这个 canvas 关联的所有 _live2dBlobUrls
  async function mountLive2DFromIDB(canvas, modelId, options) {
    if (!canvas) return { success: false, error: new Error('canvas is null') };
    if (!modelId) return { success: false, error: new Error('modelId is empty') };
    if (!global.Live2DStorage) return { success: false, error: new Error('Live2DStorage not loaded') };

    let data;
    try {
      data = await global.Live2DStorage.getModel(modelId);
    } catch (e) {
      return { success: false, error: new Error('IDB read failed: ' + (e.message || e)) };
    }
    if (!data) return { success: false, error: new Error('model not found in IDB: ' + modelId) };
    if (!data.files || data.files.size === 0) return { success: false, error: new Error('model has no files') };

    // 1. 给每个 file 建 blob URL
    const urlMap = new Map();
    const blobUrls = [];
    // v0.5.0 P2.6: 纹理 Blob MIME 兜底 (抄自糯米机 createLive2DRuntimeTextureUrl/sniffImageMime)
    // uploader 用 JSZip.async('blob') 取 PNG/JPG/WebP 时 type 是空串, blob URL 也无 MIME,
    // iOS PWA 给 <img> 解码延迟/失败 → 模型全黑剪影. 这里按文件头嗅探真实 MIME 并 re-type.
    // 只对纹理后缀做, moc3/json 不需要 (走 fetchLoader, 不靠 MIME).
    const isTexturePath = (p) => /\.(png|jpe?g|webp)$/i.test(p || '');
    async function ensureTextureMime(blob) {
      // 已有正确 MIME 直接放行
      if (blob && (blob.type === 'image/png' || blob.type === 'image/jpeg' || blob.type === 'image/webp')) return blob;
      try {
        const sniff = await blob.slice(0, 16).arrayBuffer();
        const u8 = new Uint8Array(sniff);
        let mime = '';
        // PNG: 89 50 4E 47
        if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) mime = 'image/png';
        // JPEG: FF D8
        else if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xD8) mime = 'image/jpeg';
        // WebP: RIFF....WEBP
        else if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
                 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) mime = 'image/webp';
        if (mime) return blob.slice(0, blob.size, mime);
      } catch (e) { /* sniff 失败保留原 blob */ }
      return blob;
    }
    for (const [path, blob] of data.files.entries()) {
      const finalBlob = isTexturePath(path) ? await ensureTextureMime(blob) : blob;
      const u = URL.createObjectURL(finalBlob);
      urlMap.set(path, u);
      blobUrls.push(u);
    }

    // 2. 读 + 改写 model3.json: file 引用全部变绝对 blob URL
    let modelJson;
    try {
      const txt = await data.files.get(data.modelPath).text();
      modelJson = JSON.parse(txt);
    } catch (e) {
      blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
      return { success: false, error: new Error('model3.json parse failed: ' + (e.message || e)) };
    }
    const baseDir = data.modelPath.substring(0, data.modelPath.lastIndexOf('/') + 1);
    const resolveBlob = (rel) => {
      if (!rel) return rel;
      // 如果本来就是 blob URL, 不动
      if (rel.startsWith('blob:')) return rel;
      const full = baseDir + rel;
      return urlMap.get(full) || rel;
    };
    const refs = (modelJson.FileReferences || modelJson.fileReferences);
    if (refs) {
      if (refs.Moc) refs.Moc = resolveBlob(refs.Moc);
      if (refs.DisplayInfo) refs.DisplayInfo = resolveBlob(refs.DisplayInfo);
      if (refs.Physics) refs.Physics = resolveBlob(refs.Physics);
      if (refs.Pose) refs.Pose = resolveBlob(refs.Pose);
      if (Array.isArray(refs.Textures)) refs.Textures = refs.Textures.map(resolveBlob);
      if (refs.Motions && typeof refs.Motions === 'object') {
        for (const groupName of Object.keys(refs.Motions)) {
          const list = refs.Motions[groupName];
          if (Array.isArray(list)) {
            for (const m of list) {
              if (m && m.File) m.File = resolveBlob(m.File);
            }
          }
        }
      }
      if (Array.isArray(refs.Expressions)) {
        for (const e of refs.Expressions) {
          if (e && e.File) e.File = resolveBlob(e.File);
        }
      }
    }

    // 3. v0.5.0 P2.4: 不再把改写后的 model3.json 包成 transient Blob + URL.createObjectURL
    //    (transient blob URL + iOS Safari XMLHttpRequest 已知有 NetworkError quirk, 见报告)
    //    改为: 补库 ModelSettings 构造需要的 .url 字段, 然后直接把 JS 对象喂给 Live2DModel.from()
    //    库内部 urlToJSON middleware 看到 source 是 object → 跳过 XHR fetch model3.json
    //    后续 setupEssentials/createInternalModel 还是会用 XHRLoader 抓 moc3/textures, 但这些都是 IDB 长期存的 Blob (well-tested)
    modelJson.url = 'live2d-package/model.model3.json';

    // 4. 挂到 canvas._live2dBlobUrls, dispose 时 revoke (只含 IDB 散文件 blob URL, 不再含 rewrittenUrl)
    canvas._live2dBlobUrls = blobUrls;

    // 5. 调原 mountLive2D (传改写后的 JS 对象, 不再传 blob URL 字符串)
    const result = await mountLive2D(canvas, modelJson, options);

    // 6. 如果 mount 失败, 立刻 revoke (成功后等 dispose 处理)
    if (!result.success) {
      canvas._live2dBlobUrls = null;
      blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    } else {
      // v0.5.0 P2.5: 缓存 IDB data, 给 setExpression fallback 读 .exp3.json 用
      // 0.4.0 cubism4 fork 不实例化 expressionManager, setExpression 走 SDK 直改参数时需要
      // 从 data.files 里拿 .exp3.json 的 Parameters 数组.
      canvas._live2dModelData = data;
      // v0.5.0 P12: 缓存改写后的 model3.json 对象, 给 CallLipSync 读 Groups[LipSync] 兜底
      // (口型基础档首选 ParamMouthOpenY, 模型没这个参数时才需要这份 Groups)
      canvas._live2dModelJson = modelJson;
    }
    return result;
  }

  // ── v0.5.0 修复: PIXI.utils.url.resolve blob: URL 短路 ──
  // @pixi/utils 的 url.resolve 是 Node 的 url.resolve(from, to): from=基准, to=被解析的 URL.
  // 库 0.4.0 纹理加载走 settings.resolveURL(tex) → utils.url.resolve(this.url, tex),
  // 即 blob:https://... 作为第二参(to)传入, url-toolkit/Node 把 "://" 第二个冒号规范化掉,
  // 输出 blob:https//... → createTexture → PIXI.Texture.fromURL 拿到的 URL 损坏,
  // 纹理 0×0, Live2D 全黑剪影. 这里对 to(第二参) 为 blob: 的 URL 直接原样返回,
  // http/https/相对路径仍走 PIXI.utils.url.resolve 原有逻辑.
  function installPixiUrlBlobShortcut() {
    var PIXIu = global.PIXI && global.PIXI.utils;
    if (!PIXIu) return false;
    var u = PIXIu.url;
    if (!u || typeof u.resolve !== 'function') return false;
    if (u.__mavisBlobShortcutInstalled) return true;
    var orig = u.resolve;
    u.resolve = function (from, to) {
      if (typeof to === 'string' && to.indexOf('blob:') === 0) return to;
      return orig.apply(this, arguments);
    };
    u.__mavisBlobShortcutInstalled = true;
    return true;
  }
  if (installPixiUrlBlobShortcut()) {
    // ok
  } else {
    var __urlRetries = 0;
    var __urlTimer = setInterval(function () {
      __urlRetries += 1;
      if (installPixiUrlBlobShortcut() || __urlRetries >= 60) clearInterval(__urlTimer);
    }, 100);
  }

  // ── v0.5.0 修复: iOS Safari 「blob URL + XMLHttpRequest」不可用 ──
  // pixi-live2d-display 0.4.0 用自带 XHRLoader (XMLHttpRequest) 读取
  // moc3 / physics / pose / motion / expression, 而 iOS Safari 对 blob: URL 的 XHR
  // 返回 status=0 且 response 为空, 导致用户上传模型在 iPhone Safari 上加载失败.
  // 这里用库官方暴露的 Live2DLoader.middlewares 扩展点, 把真正承担"网络读取"的那一层
  // 从 XHR 换成 fetch (iOS Safari 的 fetch 能正常读 blob: URL).
  // 不改库版本 / 不改存储 / 不改 UI / 不做全局 XMLHttpRequest monkey patch.
  function installFetchLive2DResourceLoader() {
    // (1) PIXI / PIXI.live2d 尚未初始化时静默返回, 不报错
    var l2d = global.PIXI && global.PIXI.live2d;
    var L2D = l2d && l2d.Live2DLoader;
    if (!L2D || !Array.isArray(L2D.middlewares)) return false;
    // (2) 不重复安装
    if (L2D.__mavisFetchLoaderInstalled) return true;

    var fetchLoader = function (payload, next) {
      if (!payload || !payload.url) { return next(); }
      // 关键修复: 库的 settings.resolveURL 会把 blob:https://... 错误转成 blob:https//...
      // (库内部把 blob: 后的整段当 origin, URL 解析器把"://"的冒号规范化掉了).
      // 对 blob: URL 必须原样用 payload.url, 不走 resolveURL.
      var url;
      if (typeof payload.url === 'string' && payload.url.indexOf('blob:') === 0) {
        url = payload.url;
      } else if (payload.settings && typeof payload.settings.resolveURL === 'function') {
        url = payload.settings.resolveURL(payload.url);
      } else {
        url = payload.url;
      }
      if (!url) { return next(); }
      return fetch(url).then(function (resp) {
        // 原 XHRLoader 在 load 时接受 status 0 或 200, 这里保持一致, 避免误判.
        if (!resp.ok && resp.status !== 0) {
          throw new Error('资源加载失败 (HTTP ' + resp.status + '): ' + url);
        }
        // (8) 正确处理 json / blob / arraybuffer
        if (payload.type === 'json') {
          return resp.json().then(function (j) { payload.result = j; return next(); });
        }
        if (payload.type === 'blob') {
          return resp.blob().then(function (b) { payload.result = b; return next(); });
        }
        // 默认按 arraybuffer 二进制处理 (moc3 / 其他二进制资源)
        return resp.arrayBuffer().then(function (buf) { payload.result = buf; return next(); });
      }).catch(function (err) {
        throw new Error('资源加载失败: ' + url + ' (' + ((err && err.message) || err) + ')');
      });
    };

    // (11) 不粗暴覆盖: Live2DLoader.middlewares 本质是"资源读取链",
    //      其承担网络读取的那一项就是 XHRLoader.loader (0.4.0 中即第 1 项).
    //      这里逐项仅替换"网络读取"函数项, 其余 middleware 一律保留.
    //      优先精确匹配 XHRLoader.loader, 找不到时才退回"替换首个函数 middleware".
    var XHRLoaderFn = (l2d.XHRLoader && typeof l2d.XHRLoader.loader === 'function')
      ? l2d.XHRLoader.loader
      : null;
    var replaced = false;
    var newMiddlewares = L2D.middlewares.map(function (mw) {
      var isNetworkLoader = (mw === XHRLoaderFn) || (!XHRLoaderFn && typeof mw === 'function' && !replaced);
      if (!replaced && isNetworkLoader) {
        replaced = true;
        return fetchLoader;
      }
      return mw;
    });
    // 兜底: 理论上 Live2DLoader.middlewares 至少含 XHRLoader.loader; 万一为空则整体设为 fetchLoader
    if (!replaced) newMiddlewares = [fetchLoader];

    // (10) 只作用于 Live2DLoader 的资源加载链, 不修改全局 fetch, 不影响页面其他 fetch
    L2D.middlewares = newMiddlewares;
    L2D.__mavisFetchLoaderInstalled = true;
    console.info('[Live2D v0.5.0] 资源加载已由 XHR 切换为 fetch (绕开 iOS Safari blob+XHR 不可用)');
    return true;
  }

  // (10) 安全安装: PIXI.live2d 就绪则立即生效; 未就绪则静默重试, 不报错, 不重复安装
  if (installFetchLive2DResourceLoader()) {
    // 已安装
  } else {
    var _live2dRetries = 0;
    var _live2dTimer = setInterval(function () {
      _live2dRetries += 1;
      if (installFetchLive2DResourceLoader() || _live2dRetries >= 60) {
        clearInterval(_live2dTimer);
      }
    }, 100);
  }

  global.Live2DLoader = {
    mountLive2D,
    mountLive2DFromIDB,
    disposeLive2D,
    playMotion,
    setExpression,
    isMounted,
  };
})(typeof window !== 'undefined' ? window : globalThis);

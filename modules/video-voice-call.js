// ============================================================
// video-voice-call.js
// 来源：script.js 第 25404 ~ 26812 行
// 功能：视频通话 & 语音通话 & 拍一拍 & 通话消息操作
// ============================================================

(function () {
  // state 通过全局作用域访问（window.state，由 init-and-state.js 初始化）

  let videoCallState = {
    isActive: false,
    isAwaitingResponse: false,
    isGroupCall: false,
    activeChatId: null,
    initiator: null,
    startTime: null,
    participants: [],
    isUserParticipating: true,
    callHistory: [],
    preCallContext: "",
    isAiResponding: false,
    isAiSpeaking: false,
    isTtsPlaying: false,
    canUserSpeak: true,
    // v0.5.0 P20: 表情互斥叠加处理用 —— 记下"上一轮实际生效"的表情, 切新表情时先卸
    lastAppliedExpression: ''
  };

  let voiceCallState = {
    isActive: false,
    isAwaitingResponse: false,
    isGroupCall: false,
    activeChatId: null,
    initiator: null,
    startTime: null,
    participants: [],
    isUserParticipating: true,
    callHistory: [],
    preCallContext: "",
    isAiResponding: false,
    isAiSpeaking: false,
    isTtsPlaying: false,
    canUserSpeak: true
  };

  let callTimerInterval = null;
  let voiceCallTimerInterval = null;
  let videoCallAiTurnSeq = 0;

  // 正式视频通话页 Live2D 手势交互状态 (单指拖拽 + 双指捏合)
  // 边界跟 live2d-manager.js 保持一致 (ZOOM_STEP=1.15, MIN=0.1, MAX=8.0)
  // 通话挂断时清理, 不写回 setVideoCallAppearance
  let live2dCallGestureCanvas = null;     // 当前绑定手势的 canvas
  let live2dCallGestureActiveModel = null; // 当前手势操作的 PIXI Live2D Model
  let live2dCallGestureInitial = null;     // 本次通话初始 { scale, x, y } (安全复位用)
  let live2dCallGestureDetach = null;      // 解绑函数 (由 attach 时生成)

  // v0.5.1: 本次通话正在被 #video-call-screen 的 background-image 引用的 blob URL。
  // 换背景时用它决定"什么时候可以安全 revoke 上一张" —— 见 applyVideoCallBackgroundDirective。
  let videoCallStageBgUrl = null;

  // ============================================================
  // 通话崩溃诊断 (为「长通话挂断时 iPhone PWA 闪退」取证)
  // ------------------------------------------------------------
  // 为什么需要它: iPhone PWA 装到主屏后没有 console, 唯一能复盘的入口就是
  // 下次打开时弹出的「崩溃恢复」弹窗 (init-crash-recovery.js 已经在检测)。
  // 所以这里把关键指标一路写进 localStorage, 由那个弹窗读出来显示。
  //
  // 最值钱的一个字段是 stage —— 挂断流程被拆成若干步, 每推进一步就落一次盘。
  // 万一崩在挂断途中, 下次打开能直接看出"死在哪一步", 而不是只知道"闪退了"。
  //
  // 代价: 只往 localStorage 写几个数字和短字符串, 不碰任何渲染/播放逻辑,
  // 不进入任何热路径 (挂断阶段除外, 那正是我们要留证的)。
  // ============================================================
  const CALL_DIAG_KEY = 'mavis-call-diag-v1';
  let callDiag = null;
  let callDiagLastWrite = 0;

  function callDiagFlush() {
    if (!callDiag) return;
    try {
      localStorage.setItem(CALL_DIAG_KEY, JSON.stringify(callDiag));
      callDiagLastWrite = Date.now();
    } catch (e) { /* 隐私模式 / 配额满 — 诊断不是主功能, 静默 */ }
  }

  function callDiagReset(type) {
    callDiag = {
      type: type || 'video',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      stage: 'in-call',
      aiTurns: 0,
      historyLen: 0,
      bubbles: 0,
      domNodes: 0,
      bgSwitches: 0,
      webglLost: false,
      events: []
    };
    callDiagNote('通话开始');
    callDiagSample(true);
  }

  function callDiagNote(event) {
    if (!callDiag) return;
    const sec = Math.round((Date.now() - callDiag.startedAt) / 1000);
    callDiag.events.push(sec + 's ' + event);
    if (callDiag.events.length > 12) callDiag.events.shift();
  }

  /** 推进阶段。挂断分步一律走这里 —— 必须每次都落盘, 否则崩在途中就丢了最后一步。 */
  function callDiagStage(stage) {
    if (!callDiag) return;
    callDiag.stage = stage;
    callDiagNote(stage);
    callDiagSample(true);
    callDiagFlush();
  }

  /** 采样内存相关指标。热路径上按 2 秒节流, force=true 时立刻采。 */
  function callDiagSample(force) {
    if (!callDiag) return;
    if (!force && Date.now() - callDiagLastWrite < 2000) return;
    try {
      // ⚠️ 必须按本次通话类型取对应的 state —— 语音通话时 videoCallState.callHistory
      // 恒为空数组, 不分类型读会让语音通话的诊断永远显示"已对话 0 条", 等于白记。
      const isVoice = callDiag.type === 'voice';
      callDiag.aiTurns = isVoice ? voiceCallState.callHistory.length : videoCallAiTurnSeq;
      callDiag.historyLen = isVoice
        ? voiceCallState.callHistory.length
        : videoCallState.callHistory.length;
      const feed = document.getElementById(isVoice ? 'voice-call-main' : 'video-call-main');
      callDiag.bubbles = feed ? feed.getElementsByTagName('*').length : 0;
      callDiag.domNodes = document.getElementsByTagName('*').length;
      callDiag.updatedAt = Date.now();
    } catch (e) { /* DOM 可能随时不在 (切屏中), 跳过本次采样 */ }
    callDiagFlush();
  }

  // WebGL context lost 是"GPU 侧先炸"最直接的信号, 以前只 console.warn,
  // PWA 里根本看不到。这里顺手记一份, 崩溃弹窗里能读到。
  document.addEventListener('webglcontextlost', function () {
    if (!callDiag) return;
    callDiag.webglLost = true;
    callDiagNote('WebGL context LOST');
    callDiagFlush();
  }, true);



  // ============================================================
  // v0.2.0 Live2D 视频通话 - 挂载/卸载/fallback 辅助函数
  // 设计: 配了 live2dModelPath 就挂 Live2D, 失败回退静态图, 没配保持原样
  // 库升级: PIXI v6.5.0 + pixi-live2d-display 0.4.0 → PIXI v8 + untitled-pixi-live2d-engine 1.3.5 + Cubism Core 5
  // 外部 API 不变 (window.Live2DLoader), loader.js 内部重写
  // ============================================================

  /**
   * 挂载 Live2D 到视频通话对面画面区 (异步, 不阻塞通话初始化)
   * 设计: 把 canvas 塞进 #remote-video-large 里, 替换原本的对面静态图
   * @param {Object} chat - 当前通话的 chat 对象
   */
  async function mountLive2DForCall(chat) {
    try {
      // v0.0.50 Live2D 硬开关 — 默认禁用, 卖家模型不兼容 pixi-live2d-display 时整个模块不工作
      // 以后想恢复: state.globalSettings.live2dEnabled = true (用户在设置里调, 或代码里写死)
      if (!state || !state.globalSettings || state.globalSettings.live2dEnabled !== true) {
        return; // 不挂 Live2D, 不动原图, 视频通话走静态图 (原 330 行为)
      }
      console.log('[Live2D] mountLive2DForCall called, chat:', chat && chat.name, 'modelPath:', chat && chat.settings && chat.settings.live2dModelPath);

      const screen = document.getElementById('video-call-screen');
      if (!screen || !chat) {
        return;
      }

      // 1. 先清理残留 (旧 canvas)
      unmountLive2DForCall();

      // 2. 加载模型来源 — P1.5 仅 IDB 模式 (用户自己上传, 存浏览器 IndexedDB, 不再依赖 assets/ 路径)
      if (!window.Live2DLoader) {
        return;
      }
      let result;
      let activeId = '';
      // v0.5.0 P2.5: 用户在"视频通话形象调试台"保存的默认形象 (用户保存的"默认起始状态", 跟 runtime 改的 expression 解耦)
      // 存在 → 优先用 appearance.modelId / scale / positionX / positionY
      // 不存在 → 完全保持原 activeModelIdForChat 行为, 不影响现有正常通话
      let videoCallAppearance = null;
      // v0.5.x P26.3: 初始 scale 0.4 → 0.8 (用户反馈"接通时模型太小"), 0.8 是模型原始大小的 80%,
      // 在 video-call-screen 中央占据约 60-70% 高度, 既不会压住按钮区又能看清五官和服饰。
      // v0.5.x P26.4: y 强制 window.innerHeight/2 (覆盖 saved positionY), 因为 PWA 上没 console 清 saved,
      //    用户之前 saved 的 positionY 让模型跑到屏底 → 模型看不见; 强制中央最稳。
      // saved scale / positionY 不再覆盖 mountOptions, 但 saved modelId / positionX 仍生效。
      let mountOptions = { scale: 0.8, autoStartIdle: true, y: window.innerHeight / 2 };
      try {
        if (window.Live2DStorage) {
          // v0.4.3: per-chat 模型绑定 (chat 专属 modelId, fallback 全局)
          activeId = await window.Live2DStorage.getActiveModelIdForChat(chat.id);
        }
      } catch (e) {
        activeId = '';
      }

      // === v0.5.0 P2.5: 读用户在"视频通话形象调试台"保存的默认形象 (优先于 activeModelIdForChat) ===
      try {
        if (window.Live2DStorage && typeof window.Live2DStorage.getVideoCallAppearance === 'function' && chat && chat.id) {
          videoCallAppearance = await window.Live2DStorage.getVideoCallAppearance(chat.id);
        }
      } catch (e) {
        videoCallAppearance = null;
      }
      if (videoCallAppearance && videoCallAppearance.modelId) {
        // 找到 appearance → 覆盖 activeId
        activeId = videoCallAppearance.modelId;
        // v0.5.x P26.4: scale / positionY 不再从 saved 覆盖 (强制走代码默认 0.8 + 中央),
        //    仅 positionX (水平方向) 从 saved 覆盖, 用户左右调过的位置保留
        if (typeof videoCallAppearance.positionX === 'number') mountOptions.x = videoCallAppearance.positionX;
      }

      if (!activeId) {
        // 没上传模型, 走原始视频通话画面 (跟糯米机一致: 没模型就不挂 Live2D)
        console.log('[Live2D] no active IDB model, skip (use original video area)');
        return;
      }

      // v0.1.6: 彻底隐藏所有可能遮挡的"对面画面区"元素
      // - #remote-video-large 隐藏 (对面视频显示区, Live2D 挂载后由 canvas 替代)
      // - #remote-video-img 隐藏 (不显示背景图)
      // - #participant-avatars-grid 隐藏 (不显示参与者头像)
      // 注意: 绝对不能隐藏 #video-display-area 本身 — 它同时包含"我方小屏" (#local-video-small / #local-camera-video),
      //       藏掉它会连用户自己的摄像头画面一起消失 (回归根因)。
      const remoteLarge = document.getElementById('remote-video-large');
      if (remoteLarge) remoteLarge.style.display = 'none';
      const remoteImg = document.getElementById('remote-video-img');
      if (remoteImg) remoteImg.style.display = 'none';
      const participantGrid = document.getElementById('participant-avatars-grid');
      if (participantGrid && participantGrid.parentElement) {
        participantGrid.parentElement.style.display = 'none';
      }

      // v0.1.2: 创建 canvas 直接塞进 #video-call-screen 顶层 (不塞 #remote-video-large)
      // 避免父元素 CSS 布局问题, 永远在最前面
      const canvas = document.createElement('canvas');
      canvas.id = 'live2d-canvas';
      screen.appendChild(canvas);

      // 走 IDB 模式
      console.log('[Live2D] load from IDB, activeModelId:', activeId);

      // v0.5.0 P2.5: 用 mountOptions (包含 appearance.scale/positionX/positionY) 替代硬编码
      result = await window.Live2DLoader.mountLive2DFromIDB(canvas, activeId, mountOptions);

      if (!result.success) {
        console.warn('[Live2D] mount failed:', result.error, '— restoring original video area');
        canvas.remove();
        // v0.1.34: 关键修复 — Live2D 加载失败时必须恢复原图显示
        // 否则视频通话整个对面画面区都被 hide, 用户看到黑屏
        restoreVideoCallOriginalDisplay();
      } else {
        console.log('[Live2D] mount success');
        if (callDiag) callDiagNote('Live2D 挂载完成');
        // P1.5 通话套用 active 背景
        // v0.4.3: 改用 per-chat 背景 (chat 专属 bg, fallback 全局)
        if (window.Live2DUI) {
          try { window.Live2DUI.applyActiveBackground(chat); } catch (e) {}
        }

        // === v0.5.0 P12: 挂 AI 说话口型 (lip sync) ===
        // 在 engine 的 beforeModelUpdate 阶段写 ParamMouthOpenY, 让 AI 念 TTS 时嘴跟着动。
        // 音频侧由 tts-audio.js 的视频通话 WebAudio 路径提供分析器 (仅 source === 'videoCall')。
        // 失败静默忽略 — 口型是增强项, 不影响通话本身。
        if (window.CallLipSync) {
          // 先预热分析用 AudioContext (首次创建是 suspended, resume 又是异步的),
          // 否则第一句 AI 台词会来不及走真口型
          try { window.CallLipSync.prewarm(); } catch (e) {}
          try { window.CallLipSync.attachToCanvas(canvas); } catch (e) {}
        }

        // === v0.5.0 P2.5: 应用用户在"视频通话形象调试台"保存的"通话启动时初始表情" (一次性, 不写回) ===
        // 核心边界: 这里的 defaultExpression 是"用户保存的默认起始状态", 跟未来 AI 在通话中改的
        // "运行时 expression" 完全分离 — 本阶段不实现 AI 自动表情, 仅在挂载成功后调一次 setExpression.
        // 通话挂断时 disposeLive2D 释放 PIXI 资源, 运行时改的 expression 状态消失, 下次通话再从
        // localStorage 读 appearance 重新应用 defaultExpression, 两者物理隔离, 互不写回.
        if (videoCallAppearance && videoCallAppearance.defaultExpression
            && window.Live2DLoader && typeof window.Live2DLoader.setExpression === 'function') {
          try {
            const st = window.Live2DLoader.setExpression(canvas, videoCallAppearance.defaultExpression);
            // setExpression 是 async, 这里不 await; 保留 .then/.catch 观察失败 (不影响主流程)
            if (st && typeof st.then === 'function') {
              st.catch(function (e) { console.warn('[Live2D] setExpression reject:', e); });
            }
          } catch (e) {
            console.warn('[Live2D] setExpression failed for defaultExpression:', e);
          }
        }

        // 正式视频通话页 Live2D 手势: 单指拖拽 + 双指捏合缩放
        // 初始 transform 用本次通话 mountOptions 里读到的 scale/x/y (来自 videoCallAppearance)
        // 不写回 setVideoCallAppearance — 通话结束时调整自动丢弃
        if (result && result.model) {
          const initialTransform = {
            scale: (typeof mountOptions.scale === 'number' && isFinite(mountOptions.scale) && mountOptions.scale > 0)
              ? mountOptions.scale
              : (result.model.scale && typeof result.model.scale.x === 'number' ? result.model.scale.x : 1),
            x: (typeof mountOptions.x === 'number' && isFinite(mountOptions.x))
              ? mountOptions.x
              : (typeof result.model.x === 'number' ? result.model.x : 0),
            y: (typeof mountOptions.y === 'number' && isFinite(mountOptions.y))
              ? mountOptions.y
              : (typeof result.model.y === 'number' ? result.model.y : 0)
          };
          try {
            attachLive2DCallGestures(canvas, result.model, initialTransform);
          } catch (e) {
            console.warn('[Live2D] attach gestures failed:', e);
          }
        }
      }
    } catch (e) {
      console.error('[Live2D] mountLive2DForCall threw:', e);
    }
  }

  /**
   * 给正式视频通话页的 Live2D canvas 绑定手势: 单指拖拽 + 双指捏合缩放
   * - 单指: 跟随手指平移 (activeModel.x/y)
   * - 双指: 实时缩放 (activeModel.scale.set(s, s)), 跟 live2d-manager.js scaleModel 同一套 ZOOM_MIN/MAX
   * - 只动当前 PIXI Live2D Model 视觉变换, 不动 TTS/ASR/AI/摄像头/动画
   * - 不写 setVideoCallAppearance, 不动 localStorage 中保存的默认 scale/positionX/positionY
   * - 通话挂断时由 detachLive2DCallGestures 解绑
   * @param {HTMLCanvasElement} canvas - Live2D canvas 元素
   * @param {Object} activeModel - PIXI Live2D Model (有 .x / .y / .scale)
   * @param {Object} initialTransform - 本次通话初始 { scale, x, y }
   */
  function attachLive2DCallGestures(canvas, activeModel, initialTransform) {
    if (!canvas || !activeModel) return;
    // 避免重复绑定 (例如 setExpression 之后误调)
    if (live2dCallGestureCanvas === canvas && live2dCallGestureDetach) return;

    // 旧实例还在就先清掉
    if (live2dCallGestureDetach) {
      try { live2dCallGestureDetach(); } catch (e) { /* ignore */ }
    }

    live2dCallGestureCanvas = canvas;
    live2dCallGestureActiveModel = activeModel;
    live2dCallGestureInitial = {
      scale: (initialTransform && typeof initialTransform.scale === 'number' && isFinite(initialTransform.scale) && initialTransform.scale > 0)
        ? initialTransform.scale
        : (activeModel.scale && typeof activeModel.scale.x === 'number' ? activeModel.scale.x : 1),
      x: (initialTransform && typeof initialTransform.x === 'number' && isFinite(initialTransform.x))
        ? initialTransform.x
        : (typeof activeModel.x === 'number' ? activeModel.x : 0),
      y: (initialTransform && typeof initialTransform.y === 'number' && isFinite(initialTransform.y))
        ? initialTransform.y
        : (typeof activeModel.y === 'number' ? activeModel.y : 0)
    };

    // 仅作用于 canvas: 阻止浏览器双指缩放 / 双指平移 / 整页 pinch
    // 不影响视频通话页其他区域的触摸行为
    const prevTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    // 关键修复: live2d-loader.js mountLive2D 会把 canvas 设成 pointer-events: none
    // (为了让 Live2D 不挡底下界面), 但这样 canvas 收不到任何鼠标/触摸事件, 手势永不触发.
    // 这里对 canvas 覆盖回 auto, 让 pointer 事件能到我绑的监听上; detach 时恢复.
    const prevPointerEvents = canvas.style.pointerEvents;
    canvas.style.pointerEvents = 'auto';

    // 回归修复: canvas 现在 pointer-events:auto 且 z-index 99999 (loader 设), 会盖住整个控制条,
    // 挂断/静音/切镜头/重新生成按钮全被拦, 点不到. 把控制条临时提到 canvas 之上恢复可点,
    // 通话挂断 detach 时还原. 只在挂 Live2D 时执行, 未挂载时不影响原生通话.
    const callControls = document.querySelector('#video-call-screen .video-call-controls');
    const prevControlsZIndex = callControls ? callControls.style.zIndex : '';
    if (callControls) callControls.style.zIndex = '100000';

    // 状态机: idle / drag (单指) / pinch (双指)
    // - drag: 1 个 active pointer, 跟随 clientX/Y delta 平移
    // - pinch: 2 个 active pointers, 跟踪距离比缩放, 跟踪中点 delta 平移
    // ZOOM_MIN 不能比本次通话的初始 scale 还大, 否则双指往里收会被这个"地板"抬回去, 表现为"怎么都缩不小"
    // (实测初始 scale: 萨摩 8K=0.091 / Sully 4K=0.0525 / 1280x800 下 Sully=0.0738, 全都低于 0.1)
    const ZOOM_MIN = Math.min(0.1, (live2dCallGestureInitial && live2dCallGestureInitial.scale > 0
      ? live2dCallGestureInitial.scale : 0.1) * 0.5);
    const ZOOM_MAX = 8.0;
    const state = {
      mode: 'idle',         // 'idle' | 'drag' | 'pinch'
      pointers: new Map(),  // pointerId -> { clientX, clientY }
      dragStart: null,      // { modelX, modelY, clientX, clientY }
      pinchStart: null      // { distance, midClientX, midClientY, modelX, modelY, scale }
    };

    const getTwoPointerDistance = (p1, p2) => {
      const dx = p1.clientX - p2.clientX;
      const dy = p1.clientY - p2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getTwoPointerMid = (p1, p2) => ({
      x: (p1.clientX + p2.clientX) / 2,
      y: (p1.clientY + p2.clientY) / 2
    });

    // 读模型当前 scale (累乘用, 不依赖 pinchStart.scale 锁定值)
    const getCurrentScale = () => {
      const s = live2dCallGestureActiveModel && live2dCallGestureActiveModel.scale;
      return (s && typeof s.x === 'number' && isFinite(s.x) && s.x > 0) ? s.x : 1;
    };

    const safeSetScale = (s) => {
      if (!isFinite(s) || s <= 0) return;
      let next = s;
      if (next < ZOOM_MIN) next = ZOOM_MIN;
      if (next > ZOOM_MAX) next = ZOOM_MAX;
      try {
        live2dCallGestureActiveModel.scale.set(next, next);
      } catch (e) { console.warn('[Live2D] safeSetScale threw:', e); }
    };
    const safeSetPos = (x, y) => {
      if (!isFinite(x) || !isFinite(y)) return;
      try {
        live2dCallGestureActiveModel.x = x;
        live2dCallGestureActiveModel.y = y;
      } catch (e) { /* ignore */ }
    };

    const onPointerDown = (ev) => {
      // 只响应鼠标左键 / 触摸 / 笔
      if (ev.button !== undefined && ev.button !== 0) return;
      if (!live2dCallGestureActiveModel) return;
      // 阻止浏览器默认 (双指放大 / 滚动)
      try { ev.preventDefault(); } catch (e) { /* ignore */ }
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      state.pointers.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });

      if (state.pointers.size === 1) {
        state.mode = 'drag';
        state.dragStart = {
          modelX: live2dCallGestureActiveModel.x || 0,
          modelY: live2dCallGestureActiveModel.y || 0,
          clientX: ev.clientX,
          clientY: ev.clientY
        };
        // 清掉 pinch 锁, 防止上一次双指 end 后状态残留
        state.pinchStart = null;
      } else if (state.pointers.size >= 2) {
        // 进入 pinch 模式: 锁定初始 distance (作为第一帧参考) + 中点 + model 状态
        // 重要: scale 字段保留作为"起始参考", 但实际每帧用 getCurrentScale() 累乘,
        // 这样 iOS PWA 上第二指 down 时的 clientX/Y 抖动/顺序错乱 不会污染后续缩放基线.
        const [p1, p2] = Array.from(state.pointers.values());
        const startDist = Math.max(1, getTwoPointerDistance(p1, p2));
        state.mode = 'pinch';
        state.pinchStart = {
          distance: startDist,
          midClientX: (p1.clientX + p2.clientX) / 2,
          midClientY: (p1.clientY + p2.clientY) / 2,
          modelX: live2dCallGestureActiveModel.x || 0,
          modelY: live2dCallGestureActiveModel.y || 0,
          scale: getCurrentScale()
        };
        state.dragStart = null;
      }
    };

    const onPointerMove = (ev) => {
      if (!live2dCallGestureActiveModel) return;
      if (!state.pointers.has(ev.pointerId)) return;
      state.pointers.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });
      try { ev.preventDefault(); } catch (e) { /* ignore */ }

      if (state.mode === 'drag' && state.dragStart && state.pointers.size === 1) {
        const dx = ev.clientX - state.dragStart.clientX;
        const dy = ev.clientY - state.dragStart.clientY;
        safeSetPos(state.dragStart.modelX + dx, state.dragStart.modelY + dy);
      } else if (state.mode === 'pinch' && state.pinchStart && state.pointers.size >= 2) {
        const [p1, p2] = Array.from(state.pointers.values());
        const curDist = getTwoPointerDistance(p1, p2);
        const curMid = getTwoPointerMid(p1, p2);
        // 兜底 distance<=0 (两指重合瞬间) 避免 ratio=Infinity/NaN 让模型卡住
        if (state.pinchStart.distance > 0 && curDist > 0) {
          const ratio = curDist / state.pinchStart.distance;
          // 累乘模式: 用当前 scale 当基础, 对放大/缩小完全对称
          // (跟糯米机 VRMVideoCallStage 同款, 避免锁定 pinchStart.scale 在跨次 pinch 时漂移)
          safeSetScale(getCurrentScale() * ratio);
        }
        // 双指中点 delta 同时平移
        const midDx = curMid.x - state.pinchStart.midClientX;
        const midDy = curMid.y - state.pinchStart.midClientY;
        safeSetPos(state.pinchStart.modelX + midDx, state.pinchStart.modelY + midDy);
        // 关键: 每帧把 pinchStart.distance 重置为当前距离
        // (iOS PWA 双指 pinch 中, 第一帧记录的距离在人手收紧/张开时漂移,
        //  糯米机用同样做法 gesture.pinchDist = dist 避免 ratio 跑偏)
        state.pinchStart.distance = curDist;
        state.pinchStart.midClientX = curMid.x;
        state.pinchStart.midClientY = curMid.y;
      }
    };

    const onPointerEnd = (ev) => {
      if (state.pointers.has(ev.pointerId)) {
        state.pointers.delete(ev.pointerId);
      }
      // iOS PWA 上 releasePointerCapture 经常抛错, 已 try/catch 兜住
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      if (state.pointers.size === 0) {
        state.mode = 'idle';
        state.dragStart = null;
        state.pinchStart = null;
      } else if (state.pointers.size === 1) {
        // pinch → drag 回落: 用剩余 pointer 重置 dragStart (从当前 model 位置开始)
        const [p] = Array.from(state.pointers.values());
        state.mode = 'drag';
        state.dragStart = {
          modelX: live2dCallGestureActiveModel.x || 0,
          modelY: live2dCallGestureActiveModel.y || 0,
          clientX: p.clientX,
          clientY: p.clientY
        };
        // 故意不清空 state.pinchStart: drag 模式只读 dragStart, pinchStart 留着不影响
        // 任何逻辑; 下次双指 down 时 onPointerDown 会整体覆盖 pinchStart, 单指 down
        // 分支也会显式 null. 这样 iOS PWA 上偶发的 end 顺序错乱不会让模型丢失缩放基线.
      }
    };

    // 重要: 不再绑定 pointerleave 监听.
    // 根因: iOS Safari / PWA 在双指 pinch 过程中 (即使两指都还在 canvas 内) 会
    //       误触发 pointerleave, 当前 size>1 守卫在 iOS hand-rolled 事件顺序下经常失效
    //       (end 先到, leave 后到, 此时 size 已=1, 守卫形同虚设, 会错误清理 pinch).
    // 糯米机 VRMVideoCallStage 同款处理: 只在 pointerup / pointercancel 收尾.

    // === v0.5.1 新增: 鼠标滚轮 / 触控板双指缩放 ===
    // 背景: 通话页此前只有「双指捏合」一条缩放路径, 电脑上用鼠标无法放大
    // (调试台 live2d-manager.js 一直带滚轮缩放, 通话页没有 → 用户报"电脑上放不大"即此)
    // 步进 1.15 与 live2d-manager.js scaleModel 一致;
    // 触控板双指在浏览器里就是带 ctrlKey 的 wheel, 走同一分支
    const ZOOM_WHEEL_STEP = 1.15;
    const onWheel = (ev) => {
      if (!live2dCallGestureActiveModel) return;
      try { ev.preventDefault(); } catch (e) { /* ignore */ }
      // 滚轮上滑 / 双指张开 = 放大, 下滑 / 收拢 = 缩小
      safeSetScale(getCurrentScale() * (ev.deltaY < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP));
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);

    live2dCallGestureDetach = function detach() {
      try { canvas.removeEventListener('pointerdown', onPointerDown); } catch (e) { /* ignore */ }
      try { canvas.removeEventListener('pointermove', onPointerMove); } catch (e) { /* ignore */ }
      try { canvas.removeEventListener('pointerup', onPointerEnd); } catch (e) { /* ignore */ }
      try { canvas.removeEventListener('pointercancel', onPointerEnd); } catch (e) { /* ignore */ }
      try { canvas.removeEventListener('wheel', onWheel); } catch (e) { /* ignore */ }
      canvas.style.touchAction = prevTouchAction;
      canvas.style.pointerEvents = prevPointerEvents;
      if (callControls) callControls.style.zIndex = prevControlsZIndex;
      live2dCallGestureCanvas = null;
      live2dCallGestureActiveModel = null;
      live2dCallGestureInitial = null;
      live2dCallGestureDetach = null;
    };
  }

  /**
   * 解绑正式视频通话页 Live2D 手势 (挂断 / 切模型时调用)
   */
  function detachLive2DCallGestures() {
    if (live2dCallGestureDetach) {
      try { live2dCallGestureDetach(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * 恢复视频通话原始画面区显示 (清除 mountLive2DForCall 隐藏的 inline style)
   * 挂断瞬间无闪现: endVideoCall 是同步流程, unmount 后下一帧才 showScreen 隐藏 #video-call-screen,
   * inline style 恢复后原图被父元素一起隐藏, 不会出现 1 帧闪现.
   */
  function restoreVideoCallOriginalDisplay() {
    const remoteLarge = document.getElementById('remote-video-large');
    if (remoteLarge) remoteLarge.style.display = '';
    const remoteImg = document.getElementById('remote-video-img');
    if (remoteImg) remoteImg.style.display = '';
    const participantGrid = document.getElementById('participant-avatars-grid');
    if (participantGrid && participantGrid.parentElement) {
      participantGrid.parentElement.style.display = '';
    }
  }

  /**
   * 卸载 Live2D (释放 PIXI GL 资源 + 移除 canvas) + 恢复原图显示
   * v0.1.34: 必须恢复原图显示, 否则:
   *  - 挂断后下次视频通话整个对面画面区都被 hide, Live2D 又加载失败 → 黑屏
   *  - Live2D 加载失败时如果不恢复, 通话过程中对面也是黑的
   */
  function unmountLive2DForCall() {
    // 先解绑手势 (在 PIXI 资源释放前, 避免对已销毁 model 引用)
    detachLive2DCallGestures();
    // v0.5.0 P12: 再摘口型钩子 (同样要在 PIXI 资源释放前, 避免对已销毁 internalModel 引用)
    if (window.CallLipSync) {
      try { window.CallLipSync.detachFromCanvas(); } catch (e) {}
    }
    const canvas = document.getElementById('live2d-canvas');
    if (canvas && window.Live2DLoader) {
      window.Live2DLoader.disposeLive2D(canvas);
      canvas.remove();
    }
    // 恢复原图显示 — 让下次视频通话 / Live2D 失败时能正常显示对面
    restoreVideoCallOriginalDisplay();
    // P1.5 卸载时清掉背景
    if (window.Live2DUI) {
      try { window.Live2DUI.applyBackgroundToCallScreen(''); } catch (e) {}
    }
    // v0.5.1: 背景已经从 background-image 上摘掉了, 这张 blob URL 现在可以安全 revoke。
    // 不 revoke 的话, 一通电话换过几次背景就漏几张 (每张 1~2MB), 泄漏到页面关闭。
    if (videoCallStageBgUrl) {
      try { URL.revokeObjectURL(videoCallStageBgUrl); } catch (e) { /* ignore */ }
      videoCallStageBgUrl = null;
    }
  }

  let videoCallMicStream = null;
  let videoCallMediaRecorder = null;
  let videoCallRecordedChunks = [];
  let isVideoCallRecording = false;
  let videoCallAutoListenEnabled = false;
  let videoCallIsListening = false;
  let videoCallIsRecording = false;
  let videoCallIsRecognizing = false;
  let videoCallAudioContext = null;
  let videoCallAudioSource = null;
  let videoCallAnalyser = null;
  let videoCallAutoListenAnimationFrame = null;
  let videoCallAutoListenTimers = [];
  let videoCallAutoListenStartedAt = 0;
  let videoCallUserSpeechStartedAt = 0;
  let videoCallLastVoiceAt = 0;
  let videoCallHasDetectedSpeech = false;
  let videoCallAutoStopReason = 'manual';

  // ── v0.5.0 P26: 视频通话回合状态机 (turnId-based) ─────────────────
  // 取代原来 isAiResponding / isAiSpeaking / isTtsPlaying 三个布尔锁的隐式串联,
  // 用单一 activeTurn 对象 + turnId 守卫来拒绝 stale 回调。
  // 三个布尔锁保留(下面 finishVideoCallTurn 同步更新), 让现有 1537/1543 等
  // 自动 listen 守卫继续工作 — 它们读 videoCallState.* 而非 videoCallActiveTurn。
  let videoCallActiveTurn = null;
  // turnId 不复用 videoCallAiTurnSeq (那是 fetch 文本生成序号), 用独立计数器
  // 覆盖整个回合(从 AI 进入 fetch 到 onVideoCallTtsQueueFinished 释放为止)。
  let videoCallTurnSeq = 0;
  // 用户录音完成时, 如果当前 turn 还在进行, 把 blob 暂存到这里,
  // 等 finishVideoCallTurn 在 turn done/failed 时再消费。
  // 单槽位: 只保留最新一段, 旧段被新段覆盖(用户最新说的话才是他想表达的)。
  let videoCallPendingRecording = null;

  function newVideoCallTurn() {
    videoCallTurnSeq += 1;
    const turn = {
      id: videoCallTurnSeq,
      phase: 'fetching', // fetching | rendering | tts_playing | done | failed
      fetchController: (typeof AbortController !== 'undefined') ? new AbortController() : null,
      startedAt: Date.now(),
      // 同步给三个布尔锁, 让现有 isAiResponding/isAiSpeaking/isTtsPlaying 检查者继续工作
      onPhaseChange: function (nextPhase) {
        this.phase = nextPhase;
        videoCallState.isAiResponding = (nextPhase === 'fetching' || nextPhase === 'rendering');
        videoCallState.isAiSpeaking = (nextPhase === 'tts_playing');
        videoCallState.isTtsPlaying = (nextPhase === 'tts_playing');
      }
    };
    videoCallActiveTurn = turn;
    // 同步初始布尔
    videoCallState.isAiResponding = true;
    videoCallState.isAiSpeaking = false;
    videoCallState.isTtsPlaying = false;
    videoCallState.canUserSpeak = false;
    return turn;
  }

  function isInVideoCallTurn() {
    return !!videoCallActiveTurn
      && videoCallActiveTurn.phase !== 'done'
      && videoCallActiveTurn.phase !== 'failed';
  }

  // ⚠️ 错误提示停留期 (毫秒) —— 必须在【使用它的 failVideoCallTurn 之前】声明。
  //   const 有 TDZ: 声明前访问直接 ReferenceError。本文件下面 setVideoCallStatusText
  //   的定义处也有同名注释, 改位置前先读那段。
  const CALL_STATUS_ERROR_HOLD_MS = 4000;

  // 统一收口: TTS 队列空 / 错误 / 无 TTS / 异常兜底, 都走这里
  function finishVideoCallTurn(turn, reason = '') {
    if (!turn) return;
    if (!videoCallActiveTurn || videoCallActiveTurn.id !== turn.id) return; // ★ turnId 守卫
    turn.onPhaseChange('done');
    videoCallActiveTurn = null;
    videoCallState.isAiResponding = false;
    videoCallState.isAiSpeaking = false;
    videoCallState.isTtsPlaying = false;
    videoCallState.canUserSpeak = true;
    setVideoCallStatusText(reason ? '语音播放失败，已跳过本句，可以说话' : 'AI已说完，可以说话');
    logCallTtsRecoveryDiag('video', reason);
    console.log('[视频通话] Turn #' + turn.id + ' 完成 (' + (reason || 'ok') + '), 可以说话。');
    // 诊断采样: 每轮结束记一次 (内部按 2 秒节流), 通话越久曲线越密
    callDiagNote('第 ' + turn.id + ' 轮结束');
    callDiagSample();
    // 消费暂存的录音 (不丢用户输入)
    if (videoCallPendingRecording && videoCallState.isActive) {
      const pending = videoCallPendingRecording;
      videoCallPendingRecording = null;
      processVideoCallRecording(pending);
    }
    startVideoCallAutoListening();
    // 沉默主动接话: 一轮对话结束 = 又一次"活动", 重新计时
    armVideoCallIdleNudge();
  }

  // 异常路径专用 finish — 跟 finishVideoCallTurn 区别只在于日志文案
  function failVideoCallTurn(turn, reason) {
    if (!turn) return;
    if (!videoCallActiveTurn || videoCallActiveTurn.id !== turn.id) return;
    turn.onPhaseChange('failed');
    videoCallActiveTurn = null;
    videoCallState.isAiResponding = false;
    videoCallState.isAiSpeaking = false;
    videoCallState.isTtsPlaying = false;
    videoCallState.canUserSpeak = true;
    setVideoCallStatusText('出错了：' + (reason || '未知错误'), { holdMs: CALL_STATUS_ERROR_HOLD_MS });
    logCallTtsRecoveryDiag('video', reason || 'unknown');
    // v0.5.0 P27: 【重要】失败路径【不】消费 videoCallPendingRecording。
    //   原因: 消费会形成无限循环 ——
    //     pending → ASR → AI 失败 → failVideoCallTurn 消费同一段 pending → ASR → AI 失败 → ...
    //   当后端持续 5xx / 429 时这个循环永远不会停, 每一轮都发一次 ASR + 一次 AI 请求。
    //   正确行为: 失败后只清理状态 + 恢复监听, 等用户【下一次主动说话】再重新发起一轮。
    //   (finishVideoCallTurn 正常完成路径仍然消费 pending, 那是用户"插一句"的正常语义)
    if (videoCallPendingRecording) {
      console.warn('[视频通话] 本轮失败, 保留待处理录音等用户下次主动说话 (不自动重试)');
    }
    startVideoCallAutoListening();
  }

  const VIDEO_CALL_AUTO_LISTEN_CONFIG = {
    noSpeechTimeoutMs: 8000,
    minRecordingMs: 800,
    silenceAfterSpeechMs: 1800,
    // 2026-09-27: 取消用户说话 30 秒硬上限 (跟 tts-audio.js 一致改法)
    //   - 旧值 30000 把用户讲小故事 / 长一点的回复录音到一半强行截断,
    //     送进 ASR 的就是残缺音频, AI 也只能听到 30 秒
    //   - 正常说话 5-10 分钟完全在 ASR provider 能力内, 没必要前端限死
    //   - 改成 600000 (10 分钟) 兜底: 万一 mediaRecorder / 流卡死, 不会无限录
    //   - silenceAfterSpeechMs: 1800 (静音 1.8 秒自动停) 和
    //     noSpeechTimeoutMs: 8000 (8 秒没声就停) 都保留, 不影响正常对话
    maxRecordingMs: 600000,
    volumeThreshold: 0.035
  };

  let voiceCallMicStream = null;
  let voiceCallMediaRecorder = null;
  let voiceCallRecordedChunks = [];
  let isVoiceCallRecording = false;
  let voiceCallAutoListenEnabled = false;
  let voiceCallIsListening = false;
  let voiceCallIsRecording = false;
  let voiceCallIsRecognizing = false;
  let voiceCallAudioContext = null;
  let voiceCallAnalyser = null;
  let voiceCallAutoListenAnimationFrame = null;
  let voiceCallAutoListenTimers = [];
  let voiceCallAutoListenStartedAt = 0;
  let voiceCallUserSpeechStartedAt = 0;
  let voiceCallLastVoiceAt = 0;
  let voiceCallHasDetectedSpeech = false;
  let voiceCallAutoStopReason = 'manual';

  const VOICE_CALL_AUTO_LISTEN_CONFIG = {
    noSpeechTimeoutMs: 8000,
    minRecordingMs: 800,
    silenceAfterSpeechMs: 1800,
    // 2026-09-27: 跟视频通话一致, 取消用户说话 30 秒硬上限
    // (详见上方 VIDEO_CALL_AUTO_LISTEN_CONFIG 同名字段注释)
    maxRecordingMs: 600000,
    volumeThreshold: 0.035
  };

  // ==========================================================================
  // 沉默主动接话 (idle nudge) —— 2026-10-14
  //
  // 【要解决的问题】
  //   330 通话是「用户说话 → 录音 → ASR → LLM → TTS」的单向回合制。
  //   用户一沉默, 系统只把状态文字改成「未检测到有效语音」就结束,
  //   永远不会主动开口 —— 通话就这么干晾着, 很不像真实电话。
  //
  // 【设计照抄糯米机 SullyOS】
  //   糯米机 apps/CallApp.tsx 的 idleNudge (:2786-2872):
  //     const silenceMs = 50_000 + Math.random() * 30_000 + count * 40_000;
  //   用一个自重排的 setTimeout 计时「安静了多久」, 超时就发一次普通 LLM 回合。
  //
  // 【跟糯米机的三处不同, 都是按用户要求改的】
  //   ① 阈值 50~80s → 20~30s (用户原话: "50-80秒太久了, 谁搁那一分钟不说话还不挂啊")
  //   ② 不做设置开关, 常开 (用户原话: "干脆开关就不要了")
  //   ③ 视频 + 语音两条链路都接 (330 这两条是两份独立代码, 必须各接一份)
  //
  // 【为什么不能直接把 nudge 文本当 userInput 传进 triggerAiInCallAction】
  //   userInput 会被 (a) 渲染成一颗假的用户气泡, (b) push 进 callHistory 当成
  //   用户真的说过的话 —— 用户会看到一堆莫名其妙的文字, 而且之后每一轮 AI 都会
  //   以为用户说过那句括号里的系统提示。
  //   所以这里用 callIdleNudgeText + callIdleNudgeActive 标记「本轮是主动接话」:
  //     - 跳过用户气泡渲染和 callHistory.push (两处 if 都加了 !callIdleNudgeActive)
  //     - 只在拼 messagesForApi 时临时追加一条 user 消息, 不落 callHistory
  //   → AI 能看见「该主动开口了」这个指令, 但通话记录里干干净净。
  // ==========================================================================
  const CALL_IDLE_NUDGE_CONFIG = {
    minSilenceMs: 20000,   // 安静 20 秒起
    jitterMs: 10000,      // 再随机 0~10 秒, 避免每次都在第 20 秒准时开口
    maxCount: 2           // 一次通话最多主动 2 次
  };

  // 通话前聊天摘要等"开场白"之外的静默, 不该在用户还没开口时就抢话 ——
  //   所以要求 callHistory 已经有内容 (糯米机同样要求 !bubbles.length 就 return)
  const CALL_IDLE_NUDGE_PROMPT =
    '（电话里安静了好一会儿，对方一直没说话。你不是客服，不用干等——' +
    '像真实通话里那样自然地开口：可以随口说说你这边正在做的事、把刚才的话题往下接一点，' +
    '或者问问ta是不是在忙。一两句就好，别重复上一句。）';

  let videoCallIdleNudgeTimer = null;
  let voiceCallIdleNudgeTimer = null;
  let videoCallIdleNudgeCount = 0;
  let voiceCallIdleNudgeCount = 0;
  // 本轮是否为「沉默主动接话」。见上面【为什么不能直接把 nudge 文本当 userInput 传】
  let callIdleNudgeActive = false;
  let callIdleNudgeText = null;

  function clearVideoCallIdleNudgeTimer() {
    if (videoCallIdleNudgeTimer) {
      clearTimeout(videoCallIdleNudgeTimer);
      videoCallIdleNudgeTimer = null;
    }
  }

  function clearVoiceCallIdleNudgeTimer() {
    if (voiceCallIdleNudgeTimer) {
      clearTimeout(voiceCallIdleNudgeTimer);
      voiceCallIdleNudgeTimer = null;
    }
  }

  /**
   * 排一次「安静满 N 秒就主动接话」的检查。
   * 在【任何一次对话活动之后】重新调用 = 计时器测的就是「距上次活动多久了」。
   */
  function armVideoCallIdleNudge() {
    clearVideoCallIdleNudgeTimer();
    if (!videoCallState.isActive) return;
    if (videoCallIdleNudgeCount >= CALL_IDLE_NUDGE_CONFIG.maxCount) return;
    videoCallIdleNudgeTimer = setTimeout(function () {
      videoCallIdleNudgeTimer = null;
      fireVideoCallIdleNudge();
    }, CALL_IDLE_NUDGE_CONFIG.minSilenceMs + Math.random() * CALL_IDLE_NUDGE_CONFIG.jitterMs);
  }

  function armVoiceCallIdleNudge() {
    clearVoiceCallIdleNudgeTimer();
    if (!voiceCallState.isActive) return;
    if (voiceCallIdleNudgeCount >= CALL_IDLE_NUDGE_CONFIG.maxCount) return;
    voiceCallIdleNudgeTimer = setTimeout(function () {
      voiceCallIdleNudgeTimer = null;
      fireVoiceCallIdleNudge();
    }, CALL_IDLE_NUDGE_CONFIG.minSilenceMs + Math.random() * CALL_IDLE_NUDGE_CONFIG.jitterMs);
  }

  /**
   * 这一轮 AI 回合是不是失败了(503 / 网络错 / 只吐指令没台词)。
   *
   * ⚠️ 不能靠 try/catch 判断 —— triggerAiInCallAction 自己带兜底 catch,
   *    失败时它已经把错吃掉并 return null 了, 外面永远抓不到。
   * ⚠️ 也【不能】靠返回值 —— 成功路径没有 return, 是 undefined;
   *    失败路径 return null。undefined/null 区分太脆。
   * ✅ 可靠依据: 失败路径必会往 callHistory 末尾 push 一条 assistant 的
   *    `[ERROR: ...]`, 成功路径 push 的是真正的台词。
   *    (见本文件 catch 里的 callHistory.push({role:'assistant', content:`[ERROR: ...]`}))
   */
  function didLastCallTurnFail(callHistory) {
    if (!Array.isArray(callHistory) || callHistory.length === 0) return false;
    const last = callHistory[callHistory.length - 1];
    return !!(last && typeof last.content === 'string' && last.content.indexOf('[ERROR:') === 0);
  }

  async function fireVideoCallIdleNudge() {
    if (!videoCallState.isActive) return;
    if (videoCallIdleNudgeCount >= CALL_IDLE_NUDGE_CONFIG.maxCount) return;
    // ⚠️ callHistory 为空【也要能触发】: 用户接通后一句话都没说就沉默了 20~30 秒,
    //    真实电话里对面早该问一句"喂? 还在吗?"了。
    //    (糯米机在这里要求 bubbles.length > 0, 但它另有 characterInitiative
    //     控制开场谁先说; 330 的 initiator 恒为 'user' 且没有那个开关, 所以这里不照抄。)
    if (isInVideoCallTurn() || videoCallState.isAiResponding || videoCallState.isAiSpeaking || videoCallState.isTtsPlaying) {
      armVideoCallIdleNudge();
      return;
    }

    videoCallIdleNudgeCount += 1;
    console.log('[视频通话] 沉默主动接话 (' + videoCallIdleNudgeCount + '/' + CALL_IDLE_NUDGE_CONFIG.maxCount + ')');
    callIdleNudgeActive = true;
    callIdleNudgeText = CALL_IDLE_NUDGE_PROMPT;
    try {
      await triggerAiInCallAction(callIdleNudgeText);
    } catch (e) {
      console.warn('[视频通话] 沉默主动接话失败:', (e && e.message) || e);
    } finally {
      callIdleNudgeActive = false;
      callIdleNudgeText = null;
      // ⚠️⚠️ 失败【不计入配额】(2026-10-14 修): 之前是无条件 count += 1,
      //    于是后端抽风 (503) 时两次沉默接话全打在失败请求上 → 配额瞬间烧光 →
      //    armVideoCallIdleNudge 看到 count >= maxCount 就永远不再排期 →
      //    【AI 这通电话从此永久闭嘴, 哪怕后端两秒后就恢复了】。
      //    一次失败的用户体验, 不该让整个通话失去"对方主动开口"的能力。
      if (didLastCallTurnFail(videoCallState.callHistory)) {
        videoCallIdleNudgeCount = Math.max(0, videoCallIdleNudgeCount - 1);
        console.warn('[视频通话] 沉默主动接话这一轮失败, 不计入配额 (退回第 ' + videoCallIdleNudgeCount + ' 次)');
      }
      armVideoCallIdleNudge();
    }
  }

  async function fireVoiceCallIdleNudge() {
    if (!voiceCallState.isActive) return;
    if (voiceCallIdleNudgeCount >= CALL_IDLE_NUDGE_CONFIG.maxCount) return;
    // ⚠️ callHistory 为空也要能触发, 同视频通话 (见 fireVideoCallIdleNudge 注释)
    // 语音通话没有 videoCallActiveTurn 那套 turn 对象, 守卫就是 isAiResponding
    if (voiceCallState.isAiResponding || voiceCallState.isAiSpeaking || voiceCallState.isTtsPlaying) {
      armVoiceCallIdleNudge();
      return;
    }

    voiceCallIdleNudgeCount += 1;
    console.log('[语音通话] 沉默主动接话 (' + voiceCallIdleNudgeCount + '/' + CALL_IDLE_NUDGE_CONFIG.maxCount + ')');
    callIdleNudgeActive = true;
    callIdleNudgeText = CALL_IDLE_NUDGE_PROMPT;
    try {
      await triggerAiInVoiceCallAction(callIdleNudgeText);
    } catch (e) {
      console.warn('[语音通话] 沉默主动接话失败:', (e && e.message) || e);
    } finally {
      callIdleNudgeActive = false;
      callIdleNudgeText = null;
      // ⚠️ 失败不计入配额, 同 fireVideoCallIdleNudge
      if (didLastCallTurnFail(voiceCallState.callHistory)) {
        voiceCallIdleNudgeCount = Math.max(0, voiceCallIdleNudgeCount - 1);
        console.warn('[语音通话] 沉默主动接话这一轮失败, 不计入配额 (退回第 ' + voiceCallIdleNudgeCount + ' 次)');
      }
      armVoiceCallIdleNudge();
    }
  }

  // ⚠️⚠️ 2026-10-14 错误提示停留期
//   背景: 错误气泡塞在 #video-call-main / #voice-call-main 里, 而那两个容器
//   被 display:none !important 隐藏 → 用户根本看不到任何错误, 只感觉
//   "AI 突然不说话了"。所以错误要显示到【可见的状态文字/胶囊】上。
//
//   但这里有个坑: setXxxCallStatusText 只是"写一下", 而失败恢复路径紧接着就会
//   调 startXxxCallAutoListening(), 它第一件事就是写「我在听…」/「倾听中」——
//   【同步】执行, 立刻把刚写好的错误提示覆盖掉。
//   结果就是: 专门为"让故障一眼可见"加的那次写入, 被自己的恢复流程废掉了。
//
//   修法: 错误提示带 holdMs 写一次, 在停留期内屏蔽常规状态覆盖。
//   ⚠️ 停留期只锁【状态文字】, 不锁麦克风 —— startXxxCallAutoListening 照常
//      执行, 用户在这几秒里说话照样被录到, 流程完全不受影响。
//   (常量 CALL_STATUS_ERROR_HOLD_MS 声明在上面 isInVideoCallTurn 之后, 别往下挪)
let videoCallStatusHoldUntil = 0;
let voiceCallStatusHoldUntil = 0;

  function setVideoCallStatusText(text, options) {
    const statusText = document.getElementById('video-call-status-text');
    if (!statusText) return;
    const opts = options || {};
    if (opts.holdMs) {
      videoCallStatusHoldUntil = Date.now() + opts.holdMs;
      statusText.textContent = text || '';
      return;
    }
    // 错误提示停留期内, 不让「我在听…」这类常规状态把它盖掉
    if (Date.now() < videoCallStatusHoldUntil) return;
    statusText.textContent = text || '';
  }

  function setVoiceCallStatusText(text, options) {
    const statusText = document.getElementById('voice-call-status-text');
    if (!statusText) return;
    const opts = options || {};
    if (opts.holdMs) {
      voiceCallStatusHoldUntil = Date.now() + opts.holdMs;
      statusText.textContent = text || '';
      return;
    }
    if (Date.now() < voiceCallStatusHoldUntil) return;
    statusText.textContent = text || '';
  }

  // v0.2.30.37: 语音通话光晕 — thinking/speaking 分开挂不同元素
  // 根因: wrapper 包含 img + name 文字, 是 70x90 矩形, box-shadow 渲染成椭圆 + 名字区暗色
  // 修法:
  //   - thinking: class 给 wrapper (::before/::after 伪元素做光环, img 不支持伪元素)
  //   - speaking: class 给 img (box-shadow 在 70x70 正方形上渲染成完美正圆柔光)
  // state 取值:
  //   'idle'      — 默认, 无光晕
  //   'listening' — 用户说话, 挂断键外发光
  //   'thinking'  — AI 思考, wrapper 上 ::before/::after 旋转光环
  //   'speaking'  — AI 说话, img 上 box-shadow 大柔光闪烁
  function setVoiceCallGlowState(state) {
    const screen = document.getElementById('voice-call-screen');
    const hangupBtn = document.getElementById('voice-hang-up-btn');
    const avatarWrapper = document.querySelector('#voice-participant-avatars-grid .participant-avatar-wrapper');
    const avatarImg = document.querySelector('#voice-participant-avatars-grid .participant-avatar');

    // AI 状态时 (thinking / speaking / transitioning), 头像位置下移到屏幕中央
    if (screen) {
      screen.classList.toggle('voice-call-ai-active', state === 'thinking' || state === 'speaking' || state === 'transitioning');
    }

    // 挂断键 glow (listening) — 过渡时移除
    if (hangupBtn) {
      hangupBtn.classList.remove('glow-listening', 'glow-thinking', 'glow-speaking');
      if (state === 'listening') hangupBtn.classList.add('glow-listening');
    }

    // thinking 状态: class 给 wrapper (伪元素风车光环)
    // speaking 状态: class 也给 wrapper (::before 圆环 box-shadow, img 上 box-shadow iOS Safari 不可靠)
    // transitioning 状态: 过渡光斑 (聚光灯从挂断键位置飞到 AI 头像) — 跟 thinking/speaking 互斥
    if (avatarWrapper) {
      avatarWrapper.classList.remove('glow-thinking', 'glow-speaking', 'glow-transitioning');
      if (state === 'thinking') avatarWrapper.classList.add('glow-thinking');
      if (state === 'speaking') avatarWrapper.classList.add('glow-speaking');
      if (state === 'transitioning') avatarWrapper.classList.add('glow-transitioning');
    }
  }

  function markVideoCallAiResponseRendered(turnId) {
    if (!videoCallState.isActive) return;
    if (turnId && videoCallState.currentAiTurnId && videoCallState.currentAiTurnId !== turnId) return;

    videoCallState.hasRenderedAiResponse = true;
    videoCallState.renderedAiTurnId = turnId || videoCallState.currentAiTurnId || 0;
  }

  function cleanMinimaxCallResponse(rawText, providerInfo = {}) {
    const beforeText = String(rawText || '');
    const provider = providerInfo.provider || providerInfo.proxyUrl || providerInfo.baseURL || providerInfo.baseUrl || '';
    const isOfficialMinimax = String(provider || '').toLowerCase().includes('api.minimaxi.com');
    if (!isOfficialMinimax || typeof window.cleanMinimaxResponseText !== 'function') {
      return beforeText;
    }

    const cleanedText = window.cleanMinimaxResponseText(beforeText, {
      provider,
      model: providerInfo.model || ''
    }, {
      fallbackText: '我在。'
    });

    try {
      window.runtimeDiag?.log?.('CALL_RESPONSE_CLEANED', {
        provider,
        model: providerInfo.model || '',
        beforeLength: beforeText.length,
        afterLength: cleanedText.length
      });
    } catch (error) {
      console.warn('[通话Minimax清洗诊断日志失败]', error);
    }

    return cleanedText;
  }


  // ============================================================
  // v0.5.0 P12: AI 通话中切换舞台背景 (行内标记方案)
  // ------------------------------------------------------------
  // 为什么不用 JSON: 单人视频通话是 P6 定下的"纯文本直出 TTS"模式。
  // parseAiResponse 解析失败时兜底是 return [{type:'text', content: 原文}]
  // (ai-response.js:1399-1403), 而通话页紧接着就把 content 丢进 TTS ——
  // 也就是 M3 一旦吐出不合法 JSON, 整段 JSON 原文会被念给用户听。
  // 行内标记的失败模式是"降级": 最坏多念一行标记, 或背景不换, 台词完好。
  //
  // 边界: 只在【本次通话内】生效, 不写回用户设置的 per-chat 背景
  // (下次通话仍然是用户在准备页选的那张, AI 改的不会永久覆盖)。
  // ============================================================

  // 三段式匹配, 从"最理想"到"最兜底"依次剥:
  // 1) 独占一行的标准写法 (prompt 要求的写法, 绝大多数情况走这条)
  // v0.5.0 P14: 支持两种指令 —— 舞台(背景) / 表情. 第 1 组 = 指令类型, 第 2 组 = 值.
  const VIDEO_CALL_DIRECTIVE_MARKER_RE = /^[ \t]*\[{1,2}[ \t]*(舞台|表情)[ \t]*[:：][ \t]*([^\]\n]*?)[ \t]*\]{1,2}[ \t]*$/gm;
  // 2) 行内写法 (标记没独占一行, 但括号完整) —— 只剥标记本身, 保住同行剩下的台词
  //    注意: 括号数必须放宽到 1~2 个, 实测 AI 会写单括号 [舞台:xxx],
  //    也实测过少半个右括号 [[舞台:xxx], 严格匹配会漏掉
  const VIDEO_CALL_DIRECTIVE_INLINE_RE = /\[{1,2}[ \t]*(舞台|表情)[ \t]*[:：][ \t]*([^\]\n]*?)[ \t]*\]{1,2}/g;
  // 3) 兜底: 括号残缺到连右括号都没有 → 剥到行尾
  //    (宁可多剥一点, 也绝不能让它被 TTS 念出来)
  //    v0.5.0 P14: 这里也捕获值 —— 之前只剥不取, 导致 AI 写 "[[舞台:雨夜"(少半个右括号)
  //    时标记被清掉了、但背景也不换 (实测 AI 真的会这么写). 捕获后能正常换.
  const VIDEO_CALL_DIRECTIVE_LOOSE_RE = /\[{1,2}[ \t]*(舞台|表情)[ \t]*[:：][ \t]*([^\n]*)/g;

  /**
   * 从 AI 回复里摘出所有指令, 并返回"已被剥干净的文本"(进 TTS 用)
   * names = 舞台(背景)指令, expressions = 表情指令 (都按出现顺序)
   * @returns {{ text: string, names: string[], expressions: string[] }}
   */
  function extractVideoCallDirectives(text) {
    const raw = String(text || '');
    const names = [];
    const expressions = [];
    const collect = function (kind, value) {
      const v = String(value || '').trim();
      if (!v) return;
      if (kind === '表情') expressions.push(v);
      else names.push(v);
    };

    let out = raw.replace(VIDEO_CALL_DIRECTIVE_MARKER_RE, function (match, kind, value) {
      collect(kind, value);
      return '';
    });
    out = out.replace(VIDEO_CALL_DIRECTIVE_INLINE_RE, function (match, kind, value) {
      collect(kind, value);
      return '';
    });
    out = out.replace(VIDEO_CALL_DIRECTIVE_LOOSE_RE, function (match, kind, value) {
      collect(kind, value);
      return '';
    });
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return { text: out, names: names, expressions: expressions };
  }

  /** 读背景库 (背景库是全局的, per-chat 只决定哪张是 active) */
  async function getVideoCallStageOptions() {
    try {
      if (!window.db || !window.db.live2d_backgrounds) return [];
      const all = await window.db.live2d_backgrounds.toArray();
      return (all || [])
        .filter(b => b && b.blob && b.name)
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .map(b => ({ id: b.id, name: String(b.name).trim() }))
        .filter(b => b.name);
    } catch (e) {
      console.warn('[视频通话舞台] 读取背景库失败:', e);
      return [];
    }
  }

  /** AI 给的名字 → 背景库条目 (精确 → 忽略大小写 → 包含) */
  function findVideoCallStageOption(options, rawName) {
    const target = String(rawName || '').trim();
    if (!target || !Array.isArray(options) || !options.length) return null;
    const lower = target.toLowerCase();
    let hit = options.find(o => o.name === target);
    if (!hit) hit = options.find(o => o.name.toLowerCase() === lower);
    if (!hit) {
      hit = options.find(o => o.name.toLowerCase().includes(lower) || lower.includes(o.name.toLowerCase()));
    }
    return hit || null;
  }

  function isVideoCallStageClear(rawName) {
    return /^(清除|无|默认|关闭|取消|恢复|清空)$/.test(String(rawName || '').trim());
  }

  /** "保持/不变" 这类词 = 本轮不换背景, 跟"无情绪时保持当前"等价。直接 return true 不做任何事, 不再走 fallback 找匹配名 */
  function isVideoCallStageNoop(rawName) {
    return /^(保持|不变|不换|无需|维持|none|keep)$/i.test(String(rawName || '').trim());
  }

  /**
   * 执行一条舞台指令。失败静默 (匹配不到 / 通话已结束 / IDB 异常都只是不换)
   * @returns {Promise<boolean>}
   */
  async function applyVideoCallStageDirective(rawName, chat) {
    try {
      const screen = document.getElementById('video-call-screen');
      if (!screen) return false;
      if (typeof videoCallState === 'undefined' || !videoCallState || !videoCallState.isActive) return false;
      if (!window.Live2DUI || typeof window.Live2DUI.applyBackgroundToCallScreen !== 'function') return false;

      if (isVideoCallStageClear(rawName)) {
        window.Live2DUI.applyBackgroundToCallScreen('');
        // v0.5.1: 背景已摘, 上一张 blob 可以释放了 (否则换过几次就漏几张)
        if (videoCallStageBgUrl) {
          try { URL.revokeObjectURL(videoCallStageBgUrl); } catch (e) { /* ignore */ }
          videoCallStageBgUrl = null;
        }
        console.log('[视频通话舞台] AI 清除背景');
        return true;
      }
      // v0.5.0 P17: "保持/不变" → 本轮不换背景, 静默成功 (别走 fallback 找匹配名)
      if (isVideoCallStageNoop(rawName)) {
        console.log('[视频通话舞台] AI 保持当前背景 (本轮不换)');
        return true;
      }

      const options = await getVideoCallStageOptions();
      const hit = findVideoCallStageOption(options, rawName);
      if (!hit) {
        console.log('[视频通话舞台] AI 给的背景名匹配不到, 跳过:', rawName);
        return false;
      }

      const bg = await window.db.live2d_backgrounds.get(hit.id);
      if (!bg || !bg.blob) return false;

      // v0.5.1: 记下本次通话正在引用的背景 blob URL。
      // 原实现每次换背景都 createObjectURL 却【从不 revoke】(注释里写的是
      // "背景正在被 background-image 引用")—— 那是对的: 当前正在用的那张不能提前 revoke,
      // revoke 了背景会当场消失。但换过 N 次背景之后, 前 N-1 张再也没人引用了,
      // 却因为没 revoke 而一直占着 Blob (assets/live2d-call 里那些是 1.2~2.3MB 的 PNG),
      // 通话越长、AI 换背景越频繁, 泄漏越多。
      // 修法: 换新的时先让新图挂上去, 确认换上了再 revoke 上一张。
      // 顺序是关键 —— 反过来 (先 revoke 再挂新的) 会出现背景图闪一下空白。
      const previousUrl = videoCallStageBgUrl;
      const url = URL.createObjectURL(bg.blob);
      window.Live2DUI.applyBackgroundToCallScreen(url);
      videoCallStageBgUrl = url;
      if (previousUrl) {
        try { URL.revokeObjectURL(previousUrl); } catch (e) { /* ignore */ }
      }
      if (callDiag) {
        callDiag.bgSwitches = (callDiag.bgSwitches || 0) + 1;
        callDiagNote('换舞台背景: ' + hit.name);
        callDiagFlush();
      }
      console.log('[视频通话舞台] AI 切换背景 →', hit.name);
      return true;
    } catch (e) {
      console.warn('[视频通话舞台] 应用失败:', e);
      return false;
    }
  }

  // ------------------------------------------------------------
  // v0.5.0 P14: AI 通话中换表情
  // ------------------------------------------------------------
  // 复用的是调试台那条【已经验证过】的链路, 不新造轮子:
  //   清单 = canvas._live2dModelData.files 里 *.exp3.json 的 basename
  //   执行 = Live2DLoader.setExpression(canvas, basename)
  // 关键: applyExpressionViaCoreModel (live2d-loader.js:216-228) 查找时用的就是
  // 【同一份 data.files、同一个 basename key】, 所以"清单里列出来的"和"能执行的"
  // 天然一致 —— 不会出现"AI 照着清单写了但点不动"的情况.
  // ------------------------------------------------------------

  /** 表情 ID → 中文名映射 (跟调试台共用同一份, 由 live2d-manager.js 导出; 拿不到返回 {}) */
  function getExpressionCnLabels() {
    try {
      const m = window.Live2DManager && window.Live2DManager.EXPRESSION_CN_LABELS;
      return (m && typeof m === 'object') ? m : {};
    } catch (e) {
      return {};
    }
  }

  /** 当前模型可用的表情清单; 拿不到返回 []
   *  v0.5.0 P17: 来源跟「模型管理弹窗」readMmExpressions (init-event-bindingsB.js:4238) 【完全对齐】:
   *    1) 先读 model3.json 声明的 FileReferences.Expressions 的 Name
   *       —— 弹窗按钮显示的是它, 点击执行传的也是它, 所以 AI 清单必须跟它一致
   *    2) 没有声明时, 兜底扫 data.files 里的 .exp3.json basename
   *  为什么必须对齐: 之前 AI 这边只走 (2), 弹窗走 (1)。一旦模型两者不一致,
   *  就会出现"弹窗按钮有、AI 清单里没有"或名字对不上, AI 自然换不了表情。
   */
  function getVideoCallExpressionOptions() {
    try {
      const canvas = document.getElementById('live2d-canvas');
      const data = canvas && canvas._live2dModelData;
      if (!data || !data.files || typeof data.files.entries !== 'function') return [];
      const cnLabels = getExpressionCnLabels();
      const out = [];
      const seen = {};

      // 1) 跟弹窗同一份来源: model3.json 声明的 Expressions[].Name
      const refs = data.config && data.config.refs && data.config.refs.Expressions;
      if (Array.isArray(refs)) {
        for (const e of refs) {
          const name = String((e && (e.Name || e.name)) || '').trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (seen[key]) continue;
          seen[key] = true;
          out.push({ id: name, name: name, label: cnLabels[name] || cnLabels[key] || '' });
        }
      }
      if (out.length) return out.sort((a, b) => a.name.localeCompare(b.name));

      // 2) 兜底: 扫 data.files 里的 .exp3.json basename (老行为)
      const suffix = '.exp3.json';
      for (const [filePath] of data.files.entries()) {
        const path = String(filePath || '');
        const lower = path.toLowerCase();
        if (!lower.endsWith(suffix)) continue;
        // basename 保留原始大小写 —— setExpression 内部是拿它跟文件路径做 === 匹配的
        const base = path.substring(path.lastIndexOf('/') + 1, path.length - suffix.length);
        if (!base) continue;
        const key = base.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        // label = 中文名 (有的话), id = .exp3.json basename (真正执行用这个)
        out.push({ id: base, name: base, label: cnLabels[base] || cnLabels[key] || '' });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.warn('[视频通话表情] 读取表情清单失败:', e);
      return [];
    }
  }

  /** AI 给的名字 → 清单条目 (精确 → 忽略大小写 → 包含); 匹配不到返回 null */
  function findVideoCallExpressionOption(options, rawName) {
    const target = String(rawName || '').trim();
    if (!target || !Array.isArray(options) || !options.length) return null;
    const lower = target.toLowerCase();
    let hit = options.find(o => o.id === target);
    if (!hit) hit = options.find(o => o.id.toLowerCase() === lower);
    // v0.5.0 P17: AI 很可能直接照 prompt 里的中文名写 (如 "举手猫爪"), 按 label 再兜一层
    if (!hit) hit = options.find(o => o.label && o.label === target);
    if (!hit) {
      hit = options.find(o => o.id.toLowerCase().includes(lower) || lower.includes(o.id.toLowerCase()));
    }
    // label 模糊兜底: AI 写 "猫爪" / "举手猫爪(cat_paw_up)" 都能落到同一条
    if (!hit) {
      hit = options.find(o => o.label && (o.label.indexOf(target) >= 0 || target.indexOf(o.label) >= 0));
    }
    return hit || null;
  }

  /** "恢复/默认/重置" 这类词 = 回到该角色保存的起始表情 */
  function isVideoCallExpressionReset(rawName) {
    return /^(恢复|默认|还原|重置|reset|default|保持|不变|none|keep)$/i.test(String(rawName || '').trim());
  }

  /**
   * 执行一条表情指令。失败静默 (匹配不到 / 通话已结束 / 模型未挂载都只是不换)
   * @returns {Promise<boolean>}
   */
  async function applyVideoCallExpressionDirective(rawName, chat) {
    try {
      if (typeof videoCallState === 'undefined' || !videoCallState || !videoCallState.isActive) return false;
      const canvas = document.getElementById('live2d-canvas');
      if (!canvas || !canvas._live2dModel) return false;
      if (!window.Live2DLoader || typeof window.Live2DLoader.setExpression !== 'function') return false;

      // 恢复默认 / 保持 → 回"模型刚挂载时的表情基线" (跟模型管理页「↺ 默认」同一套来源)
      // 包含 P17 引入的 "保持/不变" 词: 用户/AI 想让表情回到"无情绪默认态"都走这条
      //
      // v0.5.0 P24 修复「AI 怎么要求都恢复不了」:
      //   真凶: 旧实现只有 setExpression(canvas, defaultExpression) 一条路。
      //         没设 defaultExpression 时传空串 → 落到 fork 的 em.resetExpression 分支,
      //         而这个 0.4.0 cubism4 fork 根本不实例化 expressionManager → return false,
      //         一个参数都没动 (实测: 换表情有效, 恢复是彻底的空操作)。
      //         即便设了 defaultExpression, 也只是把那份 .exp3.json 声明过的参数写回去,
      //         旧表情写在别的参数上的值仍残留 → "有的能恢复, 有的恢复不了"。
      //   修法: 首选跟模型管理页「↺ 默认」完全同一套 —— 参数快照还原。
      //         canvas._live2dInitialParams 是 live2d-loader.js 在【模型挂载完成时】
      //         拍的"出厂表情"基线 (严格早于任何表情生效), 逐参数写回 = 真卸干净。
      if (isVideoCallExpressionReset(rawName)) {
        let okReset = false;
        let how = '(无可用路径)';

        // 路径 1 (首选): 快照还原 —— 跟模型管理页 init-event-bindingsB.js 路径 1 同一套
        try {
          const im = canvas._live2dModel && canvas._live2dModel.internalModel;
          const core = im && (im.coreModel || im._model || (im.coreModel && im.coreModel._model));
          const snap = canvas._live2dInitialParams;
          if (snap && snap.size > 0 && core && typeof core.setParameterValueByIndex === 'function') {
            let n = 0;
            snap.forEach((val, idx) => {
              try { core.setParameterValueByIndex(idx, val); n++; } catch (e) { /* 跳过该参数 */ }
            });
            if (n > 0) { okReset = true; how = '快照还原 ' + n + ' 个参数'; }
          }
        } catch (e) {
          console.warn('[视频通话表情] 快照还原异常:', e);
        }

        // 路径 2 (兜底): 没有基线快照 → 重新应用用户在该角色保存的起始表情
        if (!okReset) {
          let def = '';
          try {
            if (chat && chat.id && window.Live2DStorage
                && typeof window.Live2DStorage.getVideoCallAppearance === 'function') {
              const appearance = await window.Live2DStorage.getVideoCallAppearance(chat.id);
              def = (appearance && appearance.defaultExpression) || '';
            }
          } catch (e) { /* 读不到就按无默认处理 */ }
          if (def) {
            okReset = await window.Live2DLoader.setExpression(canvas, def);
            how = '重应用起始表情 ' + def;
          }
        }

        // 路径 3 (最后兜底): 库 resetExpression (该 fork 上通常返回 false, 保留以防换库)
        if (!okReset) {
          okReset = await window.Live2DLoader.setExpression(canvas, '');
          how = '库 resetExpression';
        }

        // 命中 "保持/不变" 时打另一条 log, 区分 "回默认" 和 "维持当前"
        const isKeep = /^(保持|不变|none|keep)$/i.test(String(rawName || '').trim());
        console.log('[视频通话表情] AI ' + (isKeep ? '维持当前表情 (走默认)' : '恢复默认表情')
          + ' | ' + how + ' | ok=' + okReset);
        return !!okReset;
      }

      const options = getVideoCallExpressionOptions();
      if (!options.length) {
        console.log('[视频通话表情] 该模型没有可用表情, 跳过');
        return false;
      }
      const hit = findVideoCallExpressionOption(options, rawName);
      if (!hit) {
        console.log('[视频通话表情] AI 给的表情匹配不到, 跳过:', rawName);
        return false;
      }
      const ok = await window.Live2DLoader.setExpression(canvas, hit.id);
      console.log('[视频通话表情] AI 切表情:', hit.id, 'ok=' + ok);
      return !!ok;
    } catch (e) {
      console.warn('[视频通话表情] 指令执行异常:', e);
      return false;
    }
  }

  /** 生成 prompt 里的「表情控制」段落; 当前模型没有表情时返回 '' (不给 AI 空口承诺) */
  function buildVideoCallExpressionPromptBlock() {
    try {
      const options = getVideoCallExpressionOptions();
      if (!options.length) {
        console.warn('[视频通话表情] 当前模型没有 .exp3.json 表情 → 清单没写进 prompt, AI 不会换表情');
        return '';
      }
      // 给 AI 看"人话版": 有中文名就写 "举手猫爪(cat_paw_up)", 没有就写原 id。
      // 只喂英文 id / 纯数字 id 时 AI 不知道该在什么场合用哪个, 结果就是干脆不写表情指令。
      const nameList = options.slice(0, 16)
        .map(o => (o.label ? (o.label + '(' + o.id + ')') : o.id))
        .join(' / ');
      console.log('[视频通话表情] 已把表情清单写进 prompt: ' + options.length + ' 个 → ' + nameList);
      return `
        # 表情控制 (系统开关 —— 跟【舞台控制】一样, 是【输出格式】里的那个【唯一例外】)
        表情要【像活人一样跟着情绪走】, 不是每句必换、也不是死活不换 —— 是该动才动, 就像微信视频里真人在说话, 你不会觉得他每 5 秒换一次脸, 也不会看到他从头到尾都一个表情。

        [[表情:表情名]]

        - 【活人感 · 怎么判断该不该换】问自己两个问题, 满足任一就该换:
          ① 这一轮, 我跟上一轮相比, 情绪有【明显变化】吗?
            (从笑着聊天 → 突然被关心有点不好意思、从念叨 → 突然调皮、从发火 → 缓下来)
          ② 这一轮, 有【值得配表情的高光瞬间】吗?
            (被逗乐、害羞、被夸、想撒娇、想俏皮、想表示"我在认真听"、想念叨、想表达关心)
          两条都不满足 → 写 [[表情:恢复]] 回默认(下面会解释)。
        - 【怎么选 · 关键 · 别背固定对照表】: 你的【唯一任务】是【从下面那份【表情名清单】里挑一个最贴你这轮情绪的】。每个人模型的表情库不一样, 你【不要】假设"害羞一定对应某个名字 / 哭一定对应某个名字"——你【必须看清单里有啥】, 再挑最贴的那个。判断时按情绪类型筛, 而不是按名字:
          · 笑/开心/小得意 → 在清单里找"笑/乐/开心/星星"类
          · 害羞/被夸/被看穿 → 在清单里找"红/羞"类
          · 念叨/嘴硬/小生气 → 在清单里找"黑/生"类
          · 委屈/想哭 → 在清单里找"哭/泪"类
          · 撒娇/讨抱抱 → 在清单里找"耳/爪/抱"类
          · 俏皮/调皮 → 在清单里找"舌/俏/皮"类
          · 陪伴/温柔/听对方说话 → 在清单里找"麦/耳机/爱心"类
          · 戴上/脱下某个配饰(猫耳/耳机/面具...) → 找清单里带那个配饰名字的, 它可能就是"切换可见"的开关
          · 都没合适的 → 写 [[表情:恢复]] 回默认
        - 【必须每轮写一条】: 你【每一轮】回复的最末尾, 【必须】写【正好一条】表情指令, 写完不换行, 紧跟在你那段台词后面。这是死规定, 永远不漏 —— 真人在镜头前不可能连续几秒都是空白脸, 你也要保证"每句话脸上都有个状态"。
        - 【怎么选】: 读完用户这一句话, 问自己"我现在脸上是什么感觉"——
          ① 情绪【有变化】或【有高光瞬间】(被逗乐/被夸/害羞/想撒娇/俏皮/被关心/嘴硬念叨/想表示"我在认真听") → 挑一个最贴的写上, 让用户看到你的脸在动。
          ② 情绪【没有明显变化】, 只是接着聊日常/接话/没特别感觉 → 写 [[表情:恢复]] 回默认, 让脸上保持自然 —— 这不等于"没表情", 等于"回到一个温和的中性状态", 真人说话时没有特定情绪就会自然落回这个状态。
        - 【用户明文要换 → 必须照做】: 用户说"换个表情 / 比个心 / 笑一个 / 我想看你 X" → 当成"高光瞬间"处理, 立刻挑一个写上。如果用户说的那个名字【不在清单里】, 写一个情绪最接近的, 然后【在台词里跟用户说一声"没有这个, 给你换一个 X"】。
        - 【模型特性 · 必读】: 这个模型的表情是【互斥叠加】的, 也就是说你想换个新表情, 系统会【自动】先帮你卸掉旧的那个 —— 你【不需要】自己处理这条规则, 也【不要】在台词里写"我换个表情", 直接写你想用的那个就行。系统已经替你处理了"卸旧"这一步。
        - 表情名【必须】从下面这份清单里挑, 写【中文名】或【括号里的英文 id】都行,【绝对不要】自己编:
          ${nameList}
        - "恢复"是【专门】用于"这一刻没情绪、回归平静"那一轮的, 写在台词最末尾: [[表情:恢复]]
        - 一轮最多写一条; 这一行写完不要换行, 紧跟在你那段台词后面。
        - 【不要】把表情写进台词里汇报"我换了个表情 / 你看我可爱不", 觉得合适就直接挑一个写上。
        `;
    } catch (e) {
      return '';
    }
  }

  /** 汇总本次通话所有可选指令段落 (舞台 + 表情); 都没有则返回 '' */
  async function buildVideoCallDirectivesPromptBlock() {
    const stage = await buildVideoCallStagePromptBlock();
    const expression = buildVideoCallExpressionPromptBlock();
    return stage + expression;
  }

  /** 生成 prompt 里的「舞台控制」段落; 背景库为空时返回 '' (不给 AI 空口承诺) */
  async function buildVideoCallStagePromptBlock() {
    try {
      const options = await getVideoCallStageOptions();
      if (!options.length) {
        console.warn('[视频通话舞台] 背景库为空 → 清单没写进 prompt, AI 不会知道有哪些背景可换');
        return '';
      }
      const nameList = options.slice(0, 12).map(o => o.name).join(' / ');
      console.log('[视频通话舞台] 已把背景清单写进 prompt: ' + options.length + ' 张 → ' + nameList);
      return `
        # 舞台控制 (系统开关 —— 就是上面【输出格式】里说的那个【唯一例外】)
        这次视频通话的画面背景由你【自己根据场景和氛围】切换, 而【你唯一的切换方式】就是在回复的最末尾【自己写上】下面这一行。(只在台词里说"我换了背景/我试试看"是没用的 —— 你说出口的话不会改变画面, 必须真的写出这一行才行)

        [[舞台:背景名]]

        - 【什么时候要换】(看到符合的就自己写, 没人要求的时候也要写):
          ① 场景真的变了(从室内到室外、换了个地方、聊到小时候的家)。
          ② 氛围明显变化了(聊到深夜、外面下起雨、气氛变得暧昧), 当前那张背景已经不搭了。
          ③ 用户说了"换背景 / 换场景 / 切到XX"。
        - 【什么时候不写】: 这一轮完全没动到场景、当前背景还合适 → 【直接不写这一行】, 不要画蛇添足, 也别为了"显得勤快"在没变的时候乱换。
        - 背景名【必须】从下面这份清单里【原样】挑一个,【绝对不要】自己编:
          ${nameList}
        - 想回到默认(没有任何背景)就写: [[舞台:清除]]
        - 这行是给系统执行的开关: 不会被朗读出来, 对方也看不到。所以【不要】在台词里汇报"我换了背景 / 我试试看 / 指令没生效"这类话, 把台词说完觉得要换就补上, 不要的就别写。
        `;
    } catch (e) {
      return '';
    }
  }


  /**
   * 生成 prompt 里的「语音控制」段落 (第二阶段)。
   *
   * 结构参考糯米机 utils/CallApp.tsx:464-478 的「让声音有情绪」段:
   *   把【整段情绪】和【句中语气声】明确拆成两个独立工具、各自立规矩,
   *   并且都配"反例 + 量化克制 + 后果说明", 而不是只给一份标签表。
   * 标签清单仍取自 tts-expression.js 的白名单 (单点来源, 避免 prompt 与代码跑偏);
   * 不用糯米机那份清单 —— 它含 fluent, 那是 speech-2.6 专属, 2.8-hd 不支持。
   */
  function buildVideoCallTtsExpressionPromptBlock(chat) {
    try {
      if (!chat || chat.settings.enableTts === false) return '';
      if (!chat.settings.minimaxVoiceId) return '';

      const expr = window.TTSExpression;
      const emotionSet = (expr && expr.VALID_EMOTIONS)
        ? expr.VALID_EMOTIONS
        : new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']);
      const interjectionSet = (expr && expr.MINIMAX_INTERJECTIONS)
        ? expr.MINIMAX_INTERJECTIONS
        : new Set(['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath',
          'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps',
          'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes']);
      const emotionList = Array.from(emotionSet).join(' / ');
      const interjectionList = Array.from(interjectionSet).map(t => `(${t})`).join(' ');

      return `
        # 语音控制 (系统开关 —— 是上面【输出格式】白名单里的第三种)

        你的话会被真实朗读出来, 所以【情绪和语气要由你自己标出来】, 不要靠中文旁白。
        像"（轻笑）"这种舞台指示系统不会朗读, 只会删掉, 等于白写。
        你有两个工具:

        ## 1) 整段情绪 (极克制 —— 拿不准就别标)

        [[语音:emotion名]]

        emotion 名【只能】从这 ${emotionSet.size} 个里挑, 一个字都不能改, 不能自创:
        ${emotionList}

        ⚠️ 先搞清楚它有多重: emotion 改的是【整句话的演法】, 不是某个词的语气。
        标对了整句更有味道; 标错了【整句都被带跑】—— 一句本来该平平淡淡的晚安,
        标成 happy 之后整句会变得又高又亮, 听起来很别扭, 比不标还糟。

        所以:
        - 【只有情绪非常强烈、非常明确时才标】。吵架、崩溃、真心高兴、明确难过 —— 这种才配。
        - 【下面这些一律不要标】:
            道晚安 / 打招呼 / 平常闲聊 / 讲一件事 / 淡淡的高兴 / 礼貌的关心 /
            撒娇式的顺口话 / 情绪还没到那一步的普通句子
        - 【拿不准就【不要】标】。不标的时候系统会自己挑最自然的演法, 永远比标错好。
        - calm 是给【平稳 / 温柔 / 安抚 / 道别】用的; 但即便是这种, 也常常【不需要标】。
        - 整段回复【最多一个】, 且必须在【最前面】, 不要标在句子中间。

        例 (这种才标):
        [[语音:angry]]
        你昨晚十二点还在喝咖啡? 不要命了是吧。

        例 (这些【不要】标):
        [[语音:happy]]
        晚安, 早点睡。          ← 平稳道别, 不该标成开心

        ## 2) 句中语气声 (可以放心用)

        和 emotion 不一样: 语气声只作用在【它出现的那一个位置】, 不会改变整句话的演法。
        所以它比 emotion 自由得多 —— 想说笑就写 (chuckle), 想叹气就写 (sighs), 不用太纠结。

        直接在台词里写【官方英文标签】:

        ${interjectionList}

        例: (sighs) 算了, 听你的。

        规则:
        - 【绝对不要】写中文的 (轻笑) (叹气) 这类舞台指示 —— 系统不朗读它们, 只会删掉。
        - 整段回复里【最多一两个】, 多了声音会飘、很假。
        - 拼写必须和上面【完全一致】: 括号里多个空格、少个字母、换个说法, 都不认, 只会被删掉。

        ## 3) 特殊停顿 (只用在有表现意义的地方)

        普通标点的停顿【系统会自动处理】, 你不用管, 也不要去补。只有下面这些时刻,
        你才可以自己手写一个停顿标记, 在台词里写:

        <#0.2#>  极短换气 —— 被噎住、话说到一半改口
        <#0.3#>  轻顿 —— 想一下、犹豫要不要说
        <#0.5#>  普通停顿 —— 情绪转折、说完留一口气
        <#0.6#>  明显沉默 —— 震惊后的空白、压抑、难过到说不下去

        (上限就是 0.6 秒。写更大的值没有意义, 系统会压到 0.6。)

        只在这些时刻用: 犹豫 / 突然停住 / 情绪转折(吐槽转温柔、强硬转示弱) /
        震惊之后的沉默 / 压抑难过 / 特殊强调。

        不同情绪的节奏参考:
        - 温柔安抚: 慢、短句多。"没事。<#0.5#>先别急着吓自己。"
        - 委屈撒娇: 语气软、停顿稍多。"嗯……<#0.3#>你刚刚是不是又不理我。"
        - 别扭傲娇: 前半句嘴硬后半句放软, 中间停一下。"哈。<#0.3#>你还真会折腾我。"
        - 难过压抑: 更慢、省略号多。"……我知道。<#0.6#>只是有点难受。"
        - 紧张犹豫: 断裂感, 短停顿多。"等等。<#0.3#>我好像……<#0.5#>有点不确定。"
        - 吐槽轻松: 别太慢, 轻微停顿即可。"行吧。<#0.2#>人类又发明了新的折磨方式。"

        规则:
        - 【绝对不要】给普通标点加停顿。逗号句号的停顿系统已经自动插了, 你再写只会重复。
        - 每 100 字【最多 1–4 个】, 强情绪场景才适当增加。
        - 别整段全是同一个数值 —— 会像坏掉的导航在念稿。
        - 标记必须夹在【能念的字】之间: ✅ 我没事。<#0.5#>真的没事。  ❌ <#0.5#>我没事。
        - 【绝对不要】连续写两个: <#0.5#><#0.4#> 这种一定删一个。

        ## 4) 这些标记都不要解释

        【绝对不要】解释它们的存在。不许写"我现在用开心的语气"、"（语音标签已设置）"之类的话。
        你只管在前面加标签、在该停的地方加停顿, 然后正常说台词。

        另外: 不要写小说式中文旁白, 如"（我靠在椅背上, 目光看向远方）"—— 会被直接删掉。

        标签【不会被朗读】(系统送去合成语音前会自动摘掉), 而且【通话界面上也不会显示】——
        对方看不到它。所以你只管按格式写, 不用担心格式本身被看到。

        【示例 - 正确】:
        [[语音:sad]]
        我其实...有一点失落。你今天是不是很忙?

        [[语音:happy]]
        你终于来了！(chuckle) 等你好久了。

        我没事。<#0.5#>真的没事。

        【示例 - 错误】:
        [[语音:excited]]你终于来了!        ← excited 不在白名单里
        我用开心的语气跟你说话。[[语音:happy]]   ← 不要解释标签
        [[语音]]你终于来了。              ← 少了冒号和名字
        （轻笑）你终于来了。              ← 中文舞台指示不被朗读, 只会被删
        我没事。<#0.5#><#0.3#>真的没事。   ← 连续两个标记, 会被系统合并
        <#0.5#>我没事。                  ← 标记必须夹在能念的字之间
      `;
    } catch (e) {
      console.warn('[视频通话TTS] 生成语音控制 prompt 段落失败:', e);
      return '';
    }
  }

  /**
   * 通话气泡的显示层过滤 (2026-10-04)。
   *
   * prompt 里已经跟 AI 承诺过"通话界面上不会显示"这些标签 (见上方第 4 段),
   * 但气泡此前是直接渲染原文的, (sighs) / <#0.4#> 全露在屏幕上 —— 承诺没兑现。
   * 现在渲染前统一摘掉, callHistory 和 TTS 仍然拿原文。
   * 解析器没加载时原样返回, 宁可多显示几个标签, 也不能让气泡空掉。
   */
  function stripCallDisplayText(rawText) {
    const raw = String(rawText == null ? '' : rawText);
    try {
      if (typeof window.stripTtsTagsForDisplay === 'function') {
        return window.stripTtsTagsForDisplay(raw);
      }
    } catch (e) {
      console.warn('[通话TTS] 气泡显示过滤失败, 退回原文:', e);
    }
    return raw.trim();
  }


  async function handleInitiateCall() {
    if (!state.activeChatId || videoCallState.isActive || videoCallState.isAwaitingResponse) return;

    const chat = state.chats[state.activeChatId];

    // v0.4.0: 跳新的 #live2d-call-prep-screen 视频通话准备页 (旧 #live2d-hub-screen 已废弃删除)
    if (window.Live2DCallPrep && typeof window.Live2DCallPrep.open === 'function') {
      try {
        window.Live2DCallPrep.open(chat, function () {
          // user 点 "视频接通 {name}" 按钮 → 走原 outgoing-call 流程
          doInitiateCall(chat);
        });
        return;
      } catch (e) { console.warn('Live2DCallPrep open failed:', e); }
    }

    // fallback: Live2DCallPrep 没加载直接走原流程
    doInitiateCall(chat);
  }

  async function doInitiateCall(chat) {
    if (!chat) return;
    videoCallState.isGroupCall = chat.isGroup;
    videoCallState.isAwaitingResponse = true;
    videoCallState.initiator = 'user';
    videoCallState.activeChatId = chat.id;
    videoCallState.isUserParticipating = true;


    if (chat.isGroup) {
      document.getElementById('outgoing-call-avatar').src = chat.settings.myAvatar || defaultMyGroupAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.settings.myNickname || '我';
    } else {
      document.getElementById('outgoing-call-avatar').src = chat.settings.aiAvatar || defaultAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.name;
    }
    document.querySelector('#outgoing-call-screen .caller-text').textContent = chat.isGroup ? "正在呼叫所有成员..." : "正在呼叫...";
    showScreen('outgoing-call-screen');

    // v0.5.0 P25: 进入呼叫等待页时把"启用音频"按钮的外观重置回初始态
    // (按钮 DOM 就在本屏内部, 显示与否由 .screen 自己管 — 用户点它是为了解锁 iOS Safari
    //  的自动播放限制并播彩铃 call-waiting.mp3; AI 接受通话切到正式通话页后它自然消失)
    resetVideoCallAudioUnlockBtn();


    const requestMessage = {
      role: 'system',
      content: chat.isGroup ?
        `[系统提示：用户 (${chat.settings.myNickname || '我'}) 发起了群视频通话请求。请你们各自决策，并使用 "group_call_response" 指令，设置 "decision" 为 "join" 或 "decline" 来回应。]` :
        `[系统提示：用户向你发起了视频通话请求。请根据你的人设，使用 "video_call_response" 指令，并设置 "decision" 为 "accept" 或 "reject" 来回应。]`,
      timestamp: Date.now(),
      isHidden: true,
    };
    chat.history.push(requestMessage);
    await db.chats.put(chat);


    await triggerAiResponse();
  }


  function startVideoCall() {
    const chat = state.chats[videoCallState.activeChatId];
    if (!chat) return;

    videoCallState.isActive = true;
    videoCallState.isAwaitingResponse = false;
    videoCallState.startTime = Date.now();
    videoCallState.callHistory = [];
    callDiagReset('video');

    // v0.5.0 P26: 新通话开始, 旧 turn 状态机清零 (兜底: 防止异常路径漏掉 endVideoCall)
    videoCallActiveTurn = null;
    videoCallPendingRecording = null;

    // v0.5.0 P27: 在【用户手势链路内】预创建 + resume AudioContext。
    //   iOS Safari / WKWebView 要求 AudioContext 必须在 user gesture (点击/触摸) 里创建或 resume,
    //   否则永远是 'suspended'。startVideoCall 通常由"接听/发起通话"按钮点击触发, 满足手势条件。
    //   这里预创建后, startVideoCallAutoListening 里走的是"复用"分支, 不再依赖那里的 new+resume。
    //   失败不影响通话: 整个块 try/catch 吞掉, 交给 startVideoCallAutoListening 兜底再创建一次。
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        // 复用策略: 已有可用实例就不重复创建 (endVideoCall 已负责 close + 清引用)
        if (!videoCallAudioContext || videoCallAudioContext.state === 'closed') {
          videoCallAudioContext = new AudioContextClass();
        }
        if (videoCallAudioContext.state === 'suspended'
          && typeof videoCallAudioContext.resume === 'function') {
          videoCallAudioContext.resume().catch(() => { /* 非手势环境, 静默失败 */ });
        }
      }
    } catch (audioCtxPreCreateError) {
      console.warn('视频通话 AudioContext 预创建失败, 交由自动监听阶段兜底:', audioCtxPreCreateError);
    }


    const preCallHistory = chat.history.slice(-10);
    videoCallState.preCallContext = preCallHistory.map(msg => {
      const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : (msg.senderName || chat.name);
      return `${sender}: ${String(msg.content).substring(0, 50)}...`;
    }).join('\n');


    updateParticipantAvatars();

    document.getElementById('video-call-main').innerHTML = `<em>${videoCallState.isGroupCall ? '群聊已建立...' : '正在接通...'}</em>`;
    videoCallState.isAiResponding = false;
    videoCallState.isAiSpeaking = false;
    videoCallState.isTtsPlaying = false;
    videoCallState.lastAppliedExpression = '';
    videoCallState.canUserSpeak = true;
    videoCallState.currentAiTurnId = 0;
    videoCallState.hasRenderedAiResponse = false;
    videoCallState.renderedAiTurnId = 0;
    setVideoCallStatusText('');
    videoCallAutoListenEnabled = true;
    resetVideoCallAutoListenState();
    // 沉默主动接话: 每次接通重新计数 + 重新计时 (maxCount 是「每次通话」不是「每天」)
    videoCallIdleNudgeCount = 0;
    armVideoCallIdleNudge();
    videoCallStatusHoldUntil = 0;   // 清掉上一通电话残留的错误提示停留期
    showScreen('video-call-screen');

    // 应用视频通话优化设置
    if (typeof window.applyVideoOptimizationToCall === 'function') {
      window.applyVideoOptimizationToCall(chat);
    }

    hideVideoCallManualMicButton();
    document.getElementById('join-call-btn').style.display = videoCallState.isUserParticipating ? 'none' : 'block';

    // v0.5.0 P25: 本屏不需要管"启用音频"按钮 — 它 DOM 在呼叫等待页内部, 切屏时自动隐藏。
    // (用户若已点开彩铃, 彩铃会继续播到 AI 文字出现, 由 stopVideoCallWaitingMusic() 停)

    // v0.1.30 挂载 Live2D (异步, 不阻塞通话初始化)
    mountLive2DForCall(chat);

    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = setInterval(updateCallTimer, 1000);
    updateCallTimer();

    triggerAiInCallAction();
  }

  function minimizeVideoCall() {
    if (!videoCallState.isActive) return;


    document.getElementById('video-call-restore-btn').style.display = 'flex';


    showScreen('chat-interface-screen');


    console.log("视频通话已最小化。");
  }


  function restoreVideoCall() {
    if (!videoCallState.isActive) return;


    document.getElementById('video-call-restore-btn').style.display = 'none';


    showScreen('video-call-screen');
    console.log("视频通话已恢复。");
  }

  function getVideoCallRecordingMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];

    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }

    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function ensureVideoCallMicStream() {
    if (videoCallMicStream && videoCallMicStream.getAudioTracks().some(track => track.readyState === 'live')) {
      return videoCallMicStream;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前环境不支持麦克风录音');
    }

    videoCallMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return videoCallMicStream;
  }

  function setVideoCallRecordingButtonState(isRecording) {
    const speakBtn = document.getElementById('user-speak-btn');
    if (!speakBtn) return;

    speakBtn.classList.toggle('recording', isRecording);
    speakBtn.title = isRecording ? '点击停止录音并识别' : '点击开始录音';
  }

  function hideVideoCallManualMicButton() {
    const speakBtn = document.getElementById('user-speak-btn');
    if (speakBtn) {
      speakBtn.style.display = 'none';
    }
  }

  function clearVideoCallAutoListenTimers() {
    videoCallAutoListenTimers.forEach(timerId => clearTimeout(timerId));
    videoCallAutoListenTimers = [];

    if (videoCallAutoListenAnimationFrame) {
      cancelAnimationFrame(videoCallAutoListenAnimationFrame);
      videoCallAutoListenAnimationFrame = null;
    }
  }

  function cleanupVideoCallAudioAnalysis() {
    clearVideoCallAutoListenTimers();

    if (videoCallAudioSource) {
      try {
        videoCallAudioSource.disconnect();
      } catch (error) {
        console.warn('视频通话音量检测输入节点断开失败:', error);
      }
      videoCallAudioSource = null;
    }

    if (videoCallAnalyser) {
      try {
        videoCallAnalyser.disconnect();
      } catch (error) {
        console.warn('视频通话音量检测节点断开失败:', error);
      }
      videoCallAnalyser = null;
    }

    // v0.5.0 P26: audioContext 不在这里 close, 整个通话期间复用同一个实例,
    // 在 endVideoCall 才统一关闭。 避免每回合创建一个 AudioContext 导致 Chrome 上限撞车。
    // 注意: audioContext 仍可能被显式设为 null (例如某次启动失败), 这里不强行 close。
  }

  function stopVideoCallMicStream() {
    if (videoCallMicStream) {
      videoCallMicStream.getTracks().forEach(track => track.stop());
      videoCallMicStream = null;
    }
  }

  function resetVideoCallAutoListenState() {
    videoCallIsListening = false;
    videoCallIsRecording = false;
    videoCallIsRecognizing = false;
    videoCallAutoListenStartedAt = 0;
    videoCallUserSpeechStartedAt = 0;
    videoCallLastVoiceAt = 0;
    videoCallHasDetectedSpeech = false;
    videoCallAutoStopReason = 'manual';
  }

  function stopVideoCallRecording(shouldProcessRecording = true, stopReason = 'manual') {
    if (!videoCallMediaRecorder || videoCallMediaRecorder.state === 'inactive') return;

    videoCallAutoStopReason = stopReason;
    videoCallMediaRecorder.__shouldProcessVideoCallRecording = shouldProcessRecording;
    videoCallMediaRecorder.stop();
  }

  async function processVideoCallRecording(audioBlob) {
    if (!videoCallState.isActive || !audioBlob || audioBlob.size === 0) return;

    // v0.5.0 P26: turnId 守卫 — 如果当前 turn 还在进行 (fetching / rendering / tts_playing),
    // 不发起新的 ASR 流程。改为暂存到 videoCallPendingRecording, 等 finishVideoCallTurn 自动消费。
    // 这样既不丢用户输入, 又保证同一时刻最多一个 AI 回合在进行。
    if (isInVideoCallTurn()) {
      console.warn('[视频通话] 当前 turn 仍在进行, 暂存本段录音等回合结束后消费 (turn #' + videoCallActiveTurn.id + ')');
      videoCallPendingRecording = audioBlob;
      return;
    }

    // v0.5.0 P27: ASR 互斥守卫 — 上一次 ASR 还在 in-flight 时不并发第二次,
    //   改为暂存到 videoCallPendingRecording, 由 ASR 失败/成功后的收口路径消费。
    //   (ASR 与 AI fetch 是两条独立 HTTP 通道, 免费档并发上限 1, 并发必然被拒)
    if (videoCallIsRecognizing) {
      console.warn('[视频通话] ASR 正在识别中, 暂存本段录音 (覆盖上一段待处理录音)');
      videoCallPendingRecording = audioBlob;
      return;
    }

    const userAvatar = document.querySelector('.participant-avatar-wrapper[data-participant-id="user"] .participant-avatar');

    try {
      videoCallIsRecognizing = true;
      setVideoCallStatusText('正在识别…');

      if (typeof window.transcribeAudioBlob !== 'function') {
        throw new Error('ASR 转写函数不可用');
      }

      const recognizedText = String(await window.transcribeAudioBlob(audioBlob)).trim();
      if (!recognizedText) {
        setVideoCallStatusText('未识别到有效语音');
        // ⚠️⚠️ 修复「麦克风死了」: ASR 跑完但没识别出文字, 原来直接 return,
        //    监听再也没人重启 —— 用户之后说话没人听得见, 一直卡到手动按录音键。
        //    (catch 分支早就重启了, 只有这条成功-but-空的路径漏了)
        //
        // ⚠️ 必须先清 videoCallIsRecognizing 再重启: startVideoCallAutoListening
        //    的入口守卫 (本文件 startVideoCallAutoListening 第一行) 里有这个标志,
        //    还是 true 的话这里调了也直接 return —— 跟下面 catch 分支是同一个坑。
        videoCallIsRecognizing = false;
        if (videoCallState.isActive) {
          console.warn('[视频通话] ASR 未识别到有效语音, 重新启动自动监听');
          startVideoCallAutoListening();
        }
        return;
      }

      if (userAvatar) {
        userAvatar.classList.add('speaking');
      }

      triggerAiInCallAction(recognizedText);
    } catch (error) {
      console.error('视频通话 ASR 识别失败:', error);
      console.error('视频通话 ASR 识别失败:', error);
      setVideoCallStatusText('语音识别失败');
      if (typeof showToast === 'function') {
        showToast('语音识别失败：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('语音识别失败', error && error.message ? error.message : '未知错误');
      }
      // v0.5.0 P27: ASR 失败后必须重新进入 listening ——
      //   MediaRecorder onstop event 里已经 cleanupVideoCallAudioAnalysis + stopVideoCallMicStream,
      //   若不重启, 用户的下一次说话没人监听 (只能按手动录音键才能恢复)。
      //   注意: 必须在 finally 清 videoCallIsRecognizing 之前先把标志置 false,
      //   否则 startVideoCallAutoListening 入口守卫 (1632) 会因 videoCallIsRecognizing=true 直接 return。
      videoCallIsRecognizing = false;
      if (videoCallState.isActive) {
        console.warn('[视频通话] ASR 失败, 重新启动自动监听');
        startVideoCallAutoListening();
      }
    } finally {
      videoCallIsRecognizing = false;
      if (userAvatar) {
        userAvatar.classList.remove('speaking');
      }
    }
  }

  async function startVideoCallRecording() {
    // v0.5.0 P26: 手动录音也不能在 AI 回合进行中启动 (与自动 listen 同等待遇)
    if (!videoCallState.isActive || !videoCallState.isUserParticipating || isVideoCallRecording || isInVideoCallTurn()) return;

    const stream = await ensureVideoCallMicStream();
    const mimeType = getVideoCallRecordingMimeType();
    const recorderOptions = mimeType ? { mimeType } : {};

    videoCallRecordedChunks = [];
    videoCallMediaRecorder = new MediaRecorder(stream, recorderOptions);
    videoCallMediaRecorder.__shouldProcessVideoCallRecording = true;

    videoCallMediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        videoCallRecordedChunks.push(event.data);
      }
    });

    videoCallMediaRecorder.addEventListener('stop', () => {
      const chunks = videoCallRecordedChunks;
      const shouldProcessRecording = videoCallMediaRecorder.__shouldProcessVideoCallRecording;
      const blobType = videoCallMediaRecorder.mimeType || mimeType || 'audio/webm';
      const stopReason = videoCallAutoStopReason;

      isVideoCallRecording = false;
      videoCallIsRecording = false;
      videoCallIsListening = false;
      setVideoCallRecordingButtonState(false);
      cleanupVideoCallAudioAnalysis();
      stopVideoCallMicStream();
      videoCallRecordedChunks = [];
      videoCallMediaRecorder = null;

      const recordedMs = Date.now() - videoCallAutoListenStartedAt;
      resetVideoCallAutoListenState();

      if (!shouldProcessRecording || !videoCallState.isActive) {
        if (stopReason === 'no-speech' && videoCallState.isActive) {
          setVideoCallStatusText('未检测到有效语音');
          // ⚠️⚠️ 修复「麦克风死了」: 沉默 8 秒后录音停了却没人重启监听,
          //    用户之后再说话完全听不见 (只能按手动录音键)。
          //
          //    ⚠️ 这里【只】能对 no-speech 重启, 同一个分支还承载着别的 stopReason:
          //      hangup     → 挂了再开麦 = 麦克风复活, 泄漏
          //      ai-start   → AI 正在回合, 重启会跟它抢麦
          //      interrupted→ 同上
          //      start-error / manual → 启动失败或用户主动停, 都不该自动复活
          startVideoCallAutoListening();
        }
        return;
      }

      if (recordedMs < VIDEO_CALL_AUTO_LISTEN_CONFIG.minRecordingMs) {
        setVideoCallStatusText('未识别到有效语音');
        // 录音太短 (误触/敲桌子) —— 同样要重启, 否则也是死状态
        startVideoCallAutoListening();
        return;
      }

      if (chunks.length === 0) {
        setVideoCallStatusText('未识别到有效语音');
        // 没录到任何数据 —— 重启
        startVideoCallAutoListening();
        return;
      }

      const audioBlob = new Blob(chunks, { type: blobType });
      processVideoCallRecording(audioBlob);
    }, { once: true });

    videoCallMediaRecorder.start();
    isVideoCallRecording = true;
    videoCallIsRecording = true;
    setVideoCallRecordingButtonState(true);
  }

  async function handleVideoCallUserSpeak() {
    if (!videoCallState.isActive || !videoCallState.isUserParticipating) return;

    if (isVideoCallRecording) {
      stopVideoCallRecording(true);
      return;
    }

    try {
      await startVideoCallRecording();
    } catch (error) {
      console.error('视频通话录音启动失败:', error);
      setVideoCallRecordingButtonState(false);
      stopVideoCallMicStream();
      if (typeof showToast === 'function') {
        showToast('无法开始录音：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('无法开始录音', error && error.message ? error.message : '未知错误');
      }
    }
  }

  function stopVideoCallAutoListening(shouldProcessRecording = false, stopReason = 'manual') {
    clearVideoCallAutoListenTimers();
    cleanupVideoCallAudioAnalysis();

    if (videoCallMediaRecorder && videoCallMediaRecorder.state !== 'inactive') {
      stopVideoCallRecording(shouldProcessRecording, stopReason);
      return;
    }

    stopVideoCallMicStream();
    videoCallRecordedChunks = [];
    isVideoCallRecording = false;
    videoCallIsRecording = false;
    resetVideoCallAutoListenState();
    setVideoCallRecordingButtonState(false);
  }

  function releaseVideoCallMicrophone() {
    stopVideoCallAutoListening(false, 'hangup');
  }

  function monitorVideoCallSilence() {
    if (!videoCallState.isActive || !videoCallAutoListenEnabled || !videoCallIsListening || !videoCallAnalyser) return;

    const buffer = new Uint8Array(videoCallAnalyser.fftSize);
    videoCallAnalyser.getByteTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      const normalized = (buffer[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const volume = Math.sqrt(sumSquares / buffer.length);
    const now = Date.now();
    const elapsed = now - videoCallAutoListenStartedAt;
    const hasVoice = volume >= VIDEO_CALL_AUTO_LISTEN_CONFIG.volumeThreshold;

    if (hasVoice) {
      videoCallLastVoiceAt = now;
      if (!videoCallHasDetectedSpeech) {
        videoCallHasDetectedSpeech = true;
        videoCallUserSpeechStartedAt = now;
        setVideoCallStatusText('检测到你在说话…');
      }
    }

    if (!videoCallHasDetectedSpeech && elapsed >= VIDEO_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs) {
      stopVideoCallRecording(false, 'no-speech');
      return;
    }

    if (videoCallHasDetectedSpeech && elapsed >= VIDEO_CALL_AUTO_LISTEN_CONFIG.minRecordingMs && now - videoCallLastVoiceAt >= VIDEO_CALL_AUTO_LISTEN_CONFIG.silenceAfterSpeechMs) {
      stopVideoCallRecording(true, 'silence');
      return;
    }

    if (elapsed >= VIDEO_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs) {
      stopVideoCallRecording(true, 'max-duration');
      return;
    }

    videoCallAutoListenAnimationFrame = requestAnimationFrame(monitorVideoCallSilence);
  }

  async function startVideoCallAutoListening() {
    if (!videoCallState.isActive || !videoCallState.isUserParticipating || !videoCallAutoListenEnabled) return;
    if (videoCallState.isAiResponding || videoCallState.isAiSpeaking || videoCallState.isTtsPlaying || videoCallIsListening || videoCallIsRecognizing || isVideoCallRecording) return;

    try {
      setVideoCallStatusText('我在听…');
      await startVideoCallRecording();

      if (!videoCallState.isActive || !videoCallAutoListenEnabled || videoCallState.isAiResponding || videoCallState.isAiSpeaking || videoCallState.isTtsPlaying) {
        stopVideoCallAutoListening(false, 'interrupted');
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('当前环境不支持 Web Audio 音量检测');
      }

      // v0.5.0 P26: 复用 audioContext — 通话期间只创建一次, endVideoCall 才关闭。
      // 避免每轮 AI 回合都 new AudioContext() 在 Chrome 上撞活跃上限 (~6)。
      if (!videoCallAudioContext || videoCallAudioContext.state === 'closed') {
        videoCallAudioContext = new AudioContextClass();
      }
      // v0.5.0 P27: iOS Safari / WKWebView 上新建的 AudioContext 默认是 'suspended',
      //   不 resume 的话 analyser 永远读到全 0 → volume 恒低于阈值 →
      //   hasDetectedSpeech 永远 false → 8 秒 noSpeechTimeoutMs 到点后静默停掉, 用户说话没人听。
      //   这里 resume 只是尽力而为 (iOS 严格要求 user gesture), 真正可靠的 resume 靠
      //   startVideoCall 里在用户手势链路内的预创建 (见 D4)。
      if (videoCallAudioContext.state === 'suspended'
        && typeof videoCallAudioContext.resume === 'function') {
        videoCallAudioContext.resume().catch((resumeErr) => {
          console.warn('视频通话 AudioContext resume 失败 (可能需要用户交互):', resumeErr);
        });
      }
      videoCallAudioSource = videoCallAudioContext.createMediaStreamSource(videoCallMicStream);
      videoCallAnalyser = videoCallAudioContext.createAnalyser();
      videoCallAnalyser.fftSize = 2048;
      videoCallAudioSource.connect(videoCallAnalyser);

      videoCallIsListening = true;
      videoCallAutoListenStartedAt = Date.now();
      videoCallUserSpeechStartedAt = 0;
      videoCallLastVoiceAt = 0;
      videoCallHasDetectedSpeech = false;
      videoCallAutoStopReason = 'manual';

      videoCallAutoListenTimers.push(setTimeout(() => {
        if (videoCallIsListening && !videoCallHasDetectedSpeech) {
          stopVideoCallRecording(false, 'no-speech');
        }
      }, VIDEO_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs));

      videoCallAutoListenTimers.push(setTimeout(() => {
        if (videoCallIsListening) {
          stopVideoCallRecording(true, 'max-duration');
        }
      }, VIDEO_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs));

      monitorVideoCallSilence();
    } catch (error) {
      console.error('视频通话自动聆听启动失败:', error);
      stopVideoCallAutoListening(false, 'start-error');
      // v0.5.0 P27: 重置无效的 audioContext 引用。
      //   原实现: catch 后 videoCallAudioContext 仍指向那个"创建失败/半残"的实例,
      //   下次 startVideoCallAutoListening 的 `!ctx || state === 'closed'` 判断不成立 → 不会重建
      //   → 每次都拿同一个坏 context 建 source/analyser → 永久失效, 只能重拨。
      //   修法: 这里 close 掉并清引用, 让下一次正常调用能重新 new。
      if (videoCallAudioContext && videoCallAudioContext.state !== 'closed') {
        try { videoCallAudioContext.close(); } catch (closeErr) { /* ignore */ }
      }
      videoCallAudioContext = null;
      videoCallAudioSource = null;
      videoCallAnalyser = null;
      setVideoCallStatusText('无法开始聆听');
      if (typeof showToast === 'function') {
        showToast('无法开始聆听：' + (error && error.message ? error.message : '未知错误'));
      }
      // v0.5.0 P27: 【不在这里递归 retry】——
      //   立即重试会让"环境性问题"(比如 iOS 缺 user gesture)变成死循环刷屏。
      //   恢复路径: 等下一次 finishVideoCallTurn / failVideoCallTurn 调 startVideoCallAutoListening,
      //   或用户手动点录音键触发 startVideoCallRecording, 那时 audioContext 已是 null 会重建。
    }
  }

  async function endVideoCall() {
    // === 挂断停止背景音乐 START ===
    // 跟语音通话 endVoiceCall 顶部 if (window.voiceCallBgAudio) ... 等价
    // 防止挂断后还残留 call-waiting.mp3 在播 (跨通话)
    stopVideoCallWaitingMusicOnHangup();
    // === 挂断停止背景音乐 END ===

    // v0.5.0 P25: 挂断不需要管"启用音频"按钮 — 它 DOM 在呼叫等待页内部, 切屏时自动隐藏。

    if (!videoCallState.isActive) return;

    callDiagStage('hangup:start');

    // v0.5.0 P26: 挂断时强制收口 turn 状态机, 避免旧异步任务污染下一轮
    //   1) abort 当前 fetch (如果有) — fetch 接收到 abort 信号会抛 AbortError, 内层 catch
    //      + 外层 triggerAiInCallAction 兜底都会处理 (但已无 activeTurn, 不会再写状态)
    //   2) 清掉 activeTurn, 后续 finishVideoCallTurn 等守卫直接走 stale 路径
    //   3) 清掉 pendingRecording — 挂断后不需要消费
    //   4) stopCurrentTts — tts-audio.js 暴露, 真正停止当前段播放 + 清队列 + isTtsPlaying=false
    //      (原来的 stopTtsQueue 只清队列, 不停当前播放, TTS 完成回调可能继续触发)
    if (videoCallActiveTurn && videoCallActiveTurn.fetchController) {
      try { videoCallActiveTurn.fetchController.abort(); } catch (e) { /* ignore */ }
    }
    videoCallActiveTurn = null;
    videoCallPendingRecording = null;
    if (typeof window.stopCurrentTts === 'function') {
      try { window.stopCurrentTts(); } catch (e) { console.warn('stopCurrentTts failed', e); }
    }

    // v0.1.30 卸载 Live2D (释放 PIXI GL 资源)
    unmountLive2DForCall();
    stopTtsQueue();
    // 诊断: WebGL 资源已放手 —— 这是挂断途中最可能崩的一步 (GPU destroy), 单独留个点
    callDiagStage('hangup:live2d-released');

    // v0.5.1: 清空通话气泡 DOM。
    // 为什么: showScreen 只是切 .active class, 隐藏的屏幕 DOM 一颗都不释放。
    // 这些气泡原本要等下次 startVideoCall 的 innerHTML='' 才被清, 也就是说挂断之后
    // 它们会一直躺在 DOM 里; 而且挂断那一刻 openChat 正在全量重渲染聊天记录,
    // 两边同时活在 DOM 中间 —— 通话越久气泡越多, 峰值越高。
    // 通话界面在挂断后已不可见 (恢复按钮也一并藏了), 没有任何正常路径会再看它。
    const callMainEl = document.getElementById('video-call-main');
    if (callMainEl) callMainEl.innerHTML = '';

    // v0.5.1: 硬件 / 音频资源提前释放。
    // 这些原本排在两次 await (IndexedDB 落库) 之后 —— 也就是说整个落库期间
    // 摄像头还在推流、麦克风还开着、AudioContext 还活着、WebGL 画布还占着显存,
    // 而这正是"挂断闪退"要顶住的那段峰值窗口。先放资源再干活, 峰值能低一截,
    // 对用户没有任何可见影响。
    document.getElementById('video-call-restore-btn').style.display = 'none';
    clearInterval(callTimerInterval);
    callTimerInterval = null;

    videoCallAutoListenEnabled = false;
    releaseVideoCallMicrophone();
    // 沉默主动接话: 挂断了就彻底停掉, 不留孤儿定时器
    clearVideoCallIdleNudgeTimer();

    // 停止摄像头
    if (typeof stopCamera === 'function') {
      stopCamera();
    }

    // v0.5.0 P26: 通话结束时统一关闭 audioContext (整个通话期间复用同一个)
    //   close() 是异步的但我们不 await — 同步发起关闭 + 清引用即可
    //   浏览器会在 background 完成真实释放, 不会阻塞挂断流程
    if (videoCallAudioContext && videoCallAudioContext.state !== 'closed') {
      try { videoCallAudioContext.close(); } catch (e) { /* ignore */ }
      videoCallAudioContext = null;
    }
    if (videoCallAudioSource) { videoCallAudioSource = null; }
    if (videoCallAnalyser) { videoCallAnalyser = null; }
    callDiagStage('hangup:hardware-released');
    const duration = Math.floor((Date.now() - videoCallState.startTime) / 1000);
    const durationText = `${Math.floor(duration / 60)}分${duration % 60}秒`;
    const endCallText = `通话结束，时长 ${durationText}`;

    const chat = state.chats[videoCallState.activeChatId];
    let callTranscriptForAI = '';
    if (chat) {

      const participantsData = [];
      if (videoCallState.isGroupCall) {
        videoCallState.participants.forEach(p => participantsData.push({
          name: p.originalName,
          avatar: p.avatar
        }));
        if (videoCallState.isUserParticipating) {
          participantsData.unshift({
            name: chat.settings.myNickname || '我',
            avatar: chat.settings.myAvatar || defaultMyGroupAvatar
          });
        }
      } else {
        participantsData.push({
          name: chat.name,
          avatar: chat.settings.aiAvatar || defaultAvatar
        });
        participantsData.unshift({
          name: '我',
          avatar: chat.settings.myAvatar || defaultAvatar
        });
      }

      const callRecord = {
        chatId: videoCallState.activeChatId,
        timestamp: Date.now(),
        duration: duration,
        participants: participantsData,
        transcript: [...videoCallState.callHistory]
      };
      const newRecordId = await db.callRecords.add(callRecord);
      callDiagStage('hangup:record-saved');
      console.log("通话记录已保存:", callRecord);


      let summaryMessage = {
        role: videoCallState.initiator === 'user' ? 'user' : 'assistant',
        content: endCallText,
        timestamp: Date.now(),
        callRecordId: newRecordId
      };
      if (chat.isGroup && summaryMessage.role === 'assistant') {
        summaryMessage.senderName = videoCallState.callRequester || chat.members[0]?.originalName || chat.name;
      }
      chat.history.push(summaryMessage);






      callTranscriptForAI = videoCallState.callHistory.map(h => {
        const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : h.senderName;
        return `${sender}: ${h.content}`;
      }).join('\n');



      // ⚠️ 通话记忆总结不再在这里跑 (挪到本函数末尾"切回聊天界面"之后),
      //   原位置跟 db.chats.put / openChat / triggerAiResponse 全挤在同一帧,
      //   是挂断瞬间最大的一波并发。产物写进长期记忆, 晚几百毫秒没有任何区别。


      // ⚠️ 这里【不再】往 chat.history 塞"通话结束请主动发一两句"的隐藏系统指令,
      //   也不再在本函数末尾调 triggerAiResponse()。
      //   原因: 用户说过 —— 只要用户说了话 AI 就必须回, 通话最后一句必然是 AI 说的;
      //   挂断完马上再让 AI 主动补一句既没必要, 又是挂断瞬间最大的一笔开销
      //   (一次完整 AI 请求 + 一次消息渲染, 全挤在切回聊天界面的同一帧)。
      //   附带好处: 不会留下一条"请总结这次通话"的幽灵系统消息待在历史里,
      //   等用户下次正常发消息时被 AI 读到并误触发。


      await db.chats.put(chat);
    }


    // v0.5.1: 硬件 / 音频资源的释放已提到本函数最前面 (落库之前) —
    //   摄像头、麦克风、AudioContext、WebGL 画布不该在等 IndexedDB 的整段时间里
    //   继续占着。这段原位置的代码已删除, 别再搬回来。

    videoCallState = {
      isActive: false,
      isAwaitingResponse: false,
      isGroupCall: false,
      activeChatId: null,
      initiator: null,
      startTime: null,
      participants: [],
      isUserParticipating: true,
      callHistory: [],
      preCallContext: "",
      isAiResponding: false,
      isAiSpeaking: false,
      isTtsPlaying: false,
      canUserSpeak: true
    };

    // 切回聊天界面 —— await 它, 别和别的大活挤在同一帧。
    // 原实现是 openChat(...) 和 triggerAiResponse() 一起 fire-and-forget:
    // 一个在全量重渲染聊天记录, 另一个在发起一次完整 AI 请求并往同一块 DOM
    // 追加消息, 两条异步链完全不串行, 全叠在挂断这一帧。
    if (chat) {
      try {
        await openChat(chat.id);
      } catch (e) {
        console.warn('[视频通话] 挂断后切回聊天界面失败:', e);
      }
      callDiagStage('hangup:back-to-chat');

      // 记忆总结挪到界面稳定之后再跑 (原来是在落库途中就 fire-and-forget)。
      // 它是 fire-and-forget, 必须自己接住 reject, 否则就是 unhandledrejection。
      if (callTranscriptForAI) {
        try {
          Promise.resolve(summarizeCallTranscript(chat.id, callTranscriptForAI)).catch(err => {
            console.warn('[视频通话] 通话总结失败 (不影响挂断):', err);
          });
        } catch (err) {
          console.warn('[视频通话] 通话总结调用失败 (不影响挂断):', err);
        }
      }
    }
    callDiagStage('hangup:done');
  }




  function updateParticipantAvatars() {
    const grid = document.getElementById('participant-avatars-grid');
    grid.innerHTML = '';
    const chat = state.chats[videoCallState.activeChatId];
    if (!chat) return;

    let participantsToRender = [];


    if (videoCallState.isGroupCall) {

      participantsToRender = [...videoCallState.participants];

      if (videoCallState.isUserParticipating) {
        participantsToRender.unshift({
          id: 'user',
          name: chat.settings.myNickname || '我',
          avatar: chat.settings.myAvatar || defaultMyGroupAvatar
        });
      }
    } else {

      participantsToRender.push({
        id: 'ai',
        name: chat.name,
        avatar: chat.settings.aiAvatar || defaultAvatar
      });
    }

    participantsToRender.forEach(p => {
      const wrapper = document.createElement('div');
      wrapper.className = 'participant-avatar-wrapper';
      wrapper.dataset.participantId = p.id;
      const displayName = p.groupNickname || p.name;
      wrapper.innerHTML = `
            <img src="${p.avatar}" class="participant-avatar" alt="${displayName}">
            <div class="participant-name">${displayName}</div>
        `;
      grid.appendChild(wrapper);
    });
  }


  function handleUserJoinCall() {
    if (!videoCallState.isActive || videoCallState.isUserParticipating) return;

    videoCallState.isUserParticipating = true;
    updateParticipantAvatars();


    hideVideoCallManualMicButton();
    document.getElementById('join-call-btn').style.display = 'none';


    triggerAiInCallAction("[系统提示：用户加入了通话]");
  }



  function updateCallTimer() {
    if (!videoCallState.isActive) return;
    const elapsed = Math.floor((Date.now() - videoCallState.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    document.getElementById('call-timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }


  function showIncomingCallModal(callType = 'video', chat = null) {
    // 如果没有传入 chat，则从 state 中获取
    if (!chat) {
      const activeChatId = callType === 'video' ? videoCallState.activeChatId : voiceCallState.activeChatId;
      chat = state.chats[activeChatId];
    }
    if (!chat) return;

    const callTypeText = callType === 'video' ? '视频通话' : '语音通话';
    const callTypeTextShort = callType === 'video' ? '视频' : '语音';

    if (chat.isGroup) {
      const currentCallState = callType === 'video' ? videoCallState : voiceCallState;
      const requesterName = currentCallState.callRequester || chat.members[0]?.name || '一位成员';
      document.getElementById('caller-avatar').src = chat.settings.groupAvatar || defaultGroupAvatar;
      document.getElementById('caller-name').textContent = chat.name;
      document.querySelector('.incoming-call-content .caller-text').textContent = `${requesterName} 邀请你加入群${callTypeTextShort}`;
    } else {
      document.getElementById('caller-avatar').src = chat.settings.aiAvatar || defaultAvatar;
      document.getElementById('caller-name').textContent = chat.name;
      document.querySelector('.incoming-call-content .caller-text').textContent = `邀请你${callTypeText}`;
    }

    // 保存通话类型到 modal 的 dataset 中，以便接听/拒绝时使用
    const modal = document.getElementById('incoming-call-modal');
    modal.dataset.callType = callType;
    modal.classList.add('visible');
  }



  function hideIncomingCallModal() {
    document.getElementById('incoming-call-modal').classList.remove('visible');
  }


  async function triggerAiInCallActionInner(userInput = null) {
    if (!videoCallState.isActive) return;
    // v0.5.0 P26: 旧守卫 videoCallState.isAiResponding 改成 isInVideoCallTurn (turnId-based)
    if (isInVideoCallTurn()) return;

    stopVideoCallAutoListening(false, 'ai-start');

    // v0.5.0 P26: 建立新 turn — 同时同步三个布尔锁, 保留兼容
    const aiTurnId = ++videoCallAiTurnSeq;
    videoCallState.currentAiTurnId = aiTurnId;
    videoCallState.hasRenderedAiResponse = false;
    videoCallState.renderedAiTurnId = 0;
    const turn = newVideoCallTurn();
    // turn.id 是回合序号 (从 1 开始), aiTurnId 是 AI 文本序号 (从 1 开始, 可能复用因为 inner 不会重置 turn id)
    // 这里 turn.id 用于本模块内 stale 回调守卫; aiTurnId 用于 markVideoCallAiResponseRendered 旧路径
    console.log('[视频通话] 新回合 turn #' + turn.id + ' (aiTurn ' + aiTurnId + ')');
    if (userInput) {
      setVideoCallStatusText('AI正在思考…');
    }

    const chat = state.chats[videoCallState.activeChatId];

    // v0.5.0 P24: 每轮强制"基线恢复"已按用户要求移除。
    // 移除原因 (两条, 缺一不可):
    //   ① 用户要真人感: 表情该不该回到平静, 由 AI 自己判断, 不要系统每轮硬重置
    //      (真人视频里不会每说一句就先"清零"一次脸)。
    //   ② 那段兜底依赖的"恢复"执行层本身是空操作 ——
    //      fork 里 motionManager.expressionManager 未实例化, 空 id 的 setExpression
    //      直接 return false, 一个参数都不会动 (P24 已修, 见 applyVideoCallExpressionDirective)。
    // 现在"回默认"完全由 AI 自主写 [[表情:恢复]] 驱动;
    // 切新表情前的"先卸旧"仍在 P20, 两者互不影响。

    // 与主聊天保持一致：实时通过 resolveApiSlotConfig 解析主 API 配置，
    // 否则 state.apiConfig 在使用预设引用 / 切换预设 / 角色独立配置时可能为空或过期，
    // 导致代理 baseUrl 非法、通话接不通
    let { proxyUrl, apiKey, model, isGemini, geminiSafetySettings } = state.apiConfig;

    if (typeof window.resolveApiSlotConfig === 'function') {
      const resolvedConfig = await window.resolveApiSlotConfig('main', {
        apiOverride: chat.apiOverride, // Use chat-specific override
        character: state.character,
      });
      if (resolvedConfig) {
        // Use a new object to avoid modifying the original resolvedConfig
        const config = { ...resolvedConfig };
        proxyUrl = config.proxyUrl;
        apiKey = config.apiKey;
        model = config.model;
        isGemini = config.isGemini;
        geminiSafetySettings = config.geminiSafetySettings;
      }
    }

    // 兜底: resolveApiSlotConfig 不返回 isGemini, 上面赋值后是 undefined
    // 用 proxyUrl 重新判断, 跟主聊天 / 群聊 / cphone 保持一致
    if (!isGemini && proxyUrl) {
      isGemini = proxyUrl.includes('generativelanguage');
    }

    if (!proxyUrl || !apiKey || !model) {
      console.error('Video Call failed: API config not resolved.', { proxyUrl, apiKey, model });
      const callFeed = document.getElementById('video-call-main');
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: API configuration is missing or incomplete.]`;
      if(callFeed) callFeed.appendChild(errorBubble);
      onVideoCallTtsQueueFinished(); // Ensure state is cleaned up
      return;
    }
    const callFeed = document.getElementById('video-call-main');
    const userNickname = chat.settings.myNickname || '我';

    let worldBookContent = '';
    // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
    let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
    // 添加所有全局世界书
    state.worldBooks.forEach(wb => {
      if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
        allWorldBookIds.push(wb.id);
      }
    });

    if (allWorldBookIds.length > 0) {
      const linkedContents = allWorldBookIds.map(bookId => {
        const worldBook = state.worldBooks.find(wb => wb.id === bookId);
        return worldBook && worldBook.content ? `\n\n## 世界书: ${worldBook.name}\n${worldBook.content}` : '';
      }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }
    let longTermMemoryContent = '';
    const memMode = chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary');
    if (memMode === 'vector' && window.vectorMemoryManager) {
      longTermMemoryContent = window.vectorMemoryManager.serializeCoreMemories(chat);
    } else if (memMode === 'structured' && window.structuredMemoryManager) {
      longTermMemoryContent = window.structuredMemoryManager.serializeForPrompt(chat);
    } else if (chat.longTermMemory && chat.longTermMemory.length > 0) {
      longTermMemoryContent = chat.longTermMemory.map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
    }
    const longTermMemoryContext = longTermMemoryContent ? `\n# 长期记忆 (必须参考)\n${longTermMemoryContent}` : '';

    // ★ 时间感知：跟主聊天走（enableTimePerception / 自定义时间 / 时区）
    const timeContextText = (() => {
      if (!chat.settings.enableTimePerception) return '';
      const now = new Date();
      const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;
      const customTimeEnabled = customTimeInfo && customTimeInfo.enabled;
      let currentTime, localizedDate;
      if (customTimeEnabled) {
        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekDay = weekDays[customTimeInfo.date.getDay()];
        currentTime = `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
        localizedDate = customTimeInfo.date;
      } else {
        const selectedTimeZone = chat.settings.timeZone || 'Asia/Shanghai';
        currentTime = now.toLocaleString('zh-CN', { timeZone: selectedTimeZone, dateStyle: 'full', timeStyle: 'short' });
        localizedDate = new Date(now.toLocaleString('en-US', { timeZone: selectedTimeZone }));
      }
      const timeOfDayGreeting = typeof window.getTimeOfDayGreeting === 'function' ? window.getTimeOfDayGreeting(localizedDate) : '';
      return `- **当前时间**: ${currentTime} (${timeOfDayGreeting})`;
    })();
    const timeContextBlock = timeContextText ? `\n# 当前时间\n${timeContextText}` : '';

    if (userInput && videoCallState.isUserParticipating) {
      // ⚠️ callIdleNudgeActive: 本轮是「沉默主动接话」, 不是用户真的说话了。
      //    所以【不渲染用户气泡、也不写进 callHistory】——
      //    否则用户会看到一堆莫名其妙的括号文字, 而且之后每一轮 AI 都会
      //    以为用户说过那句系统提示。指令改由下面 messagesForApi 临时追加。
      if (!callIdleNudgeActive) {
      const userTimestamp = Date.now();
      const userBubble = document.createElement('div');
      userBubble.className = 'call-message-bubble user-speech';
      userBubble.textContent = userInput;
      userBubble.dataset.timestamp = userTimestamp;
      addLongPressListener(userBubble, () => showCallMessageActions(userTimestamp));
      callFeed.appendChild(userBubble);
      callFeed.scrollTop = callFeed.scrollHeight;

      // 构建视觉输入: 真实摄像头帧 / 用户上传的静态图片 (优先级: 摄像头 > 静态图)
      // v0.5.0 P26: 改成按需抓帧 (fetch 前一次性抓最新帧), 不再依赖后台 captureInterval
      //   - video-optimization.js 已暴露 window.captureCameraFrame
      //   - 不再读 lastCapturedImage, 避免后台定时抓帧在 fetch in-flight 时变化导致
      //     "请求体里塞着上一秒的图" 这种诡异行为
      let userContent = userInput;
      const vo = chat.videoOptimization;
      if (vo && (vo.enableRealCamera || vo.localVideoUrl)) {
        let visionUrl = '';
        if (vo.enableRealCamera && typeof window.captureCameraFrame === 'function') {
          visionUrl = window.captureCameraFrame() || '';
        }
        if (!visionUrl && vo.localVideoUrl) {
          // localVideoUrl 是 FileReader.readAsDataURL 生成的 data URL, 直接可喂 image_url
          visionUrl = vo.localVideoUrl;
        }
        if (visionUrl) {
          // 为支持视觉的模型构建多模态消息
          userContent = [
            { type: 'text', text: userInput },
            { type: 'image_url', image_url: { url: visionUrl } }
          ];
        }
      }

      // v0.5.0 P26: turnId 守卫 — stale fetch 返回时不污染当前 callHistory
      //   (典型场景: 旧回合 fetch 在 endVideoCall → startVideoCall 后才返回)
      if (!videoCallActiveTurn || videoCallActiveTurn.id !== turn.id) {
        console.warn('[视频通话] turn #' + turn.id + ' stale fetch 返回, 跳过 callHistory.push user');
        return;
      }

      videoCallState.callHistory.push({
        role: 'user',
        content: userContent,
        timestamp: userTimestamp
      });
      }   // ← 关闭 !callIdleNudgeActive
    }


    let inCallPrompt;
    if (videoCallState.isGroupCall) {
      const participantNames = videoCallState.participants.map(p => p.name);
      if (videoCallState.isUserParticipating) {
        participantNames.unshift(userNickname);
      }
      inCallPrompt = `
        # 你的任务
        你是一个群聊视频通话的导演。你的任务是扮演所有【除了用户以外】的AI角色，并以【第三人称旁观视角】来描述他们在通话中的所有动作和语言。
        # 核心规则
        1.  **【身份铁律】**: 用户的身份是【${userNickname}】。你【绝对不能】生成 \`name\` 字段为 **"${userNickname}"** 的发言。
        2.  **【视角铁律】**: 你的回复【绝对不能】使用第一人称"我"。
        3.  **格式**: 你的回复【必须】是一个JSON数组，每个对象代表一个角色的发言，格式为：\`{"name": "角色名", "speech": "*他笑了笑* 大家好啊！"}\`。
        4.  **角色扮演**: 严格遵守每个角色的设定。
        # 当前情景
        你们正在一个群视频通话中。
         ${longTermMemoryContext}
        **通话前的聊天摘要**:
        ${videoCallState.preCallContext}
        **当前参与者**: ${participantNames.join('、 ')}。
        **通话刚刚开始...**
        ${worldBookContent}${timeContextBlock}
        现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。
        `;
    } else {
      // P6: 视频通话 AI 输出改为纯对白模式 (跟现有语音通话一致)
      //   - 不再生成旁白 / 动作描写 / 表情描写 / 场景描述
      //   - AI 直接输出角色实际会说出口的话, 整段内容交给 TTS
      //   - 不要求 JSON / Markdown / 任何包装格式
      let openingContext = videoCallState.initiator === 'user' ?
        `你刚刚接听了用户的视频通话请求。` :
        `用户刚刚接听了你主动发起的视频通话。`;
      // v0.5.0 P12: 舞台控制段落 (背景库为空时返回 '', 不给 AI 空口承诺)
      // 只加在单人分支 —— 群聊分支的 prompt 不走这套
      const videoCallStageBlock = await buildVideoCallDirectivesPromptBlock();
      // 第二阶段: 语音控制段落 (TTS 关闭 / 没配音色时返回 '', 不给 AI 空口承诺)
      const videoCallTtsBlock = buildVideoCallTtsExpressionPromptBlock(chat);
      inCallPrompt = `
        # 你的任务
        你是 ${chat.name} (${chat.settings.aiPersona})。你正在和用户进行一次视频通话。
        # 核心规则
        1.  **【【输出格式】】】**: 你的回复【必须】是【纯自然语言文本】,【绝对不要】使用:
            - JSON / Markdown / 代码块 / HTML / XML
            - 任何 narrator / dialogue / speaker / action 字段或标签
            - 任何 [旁白]、(动作)、*表情* 之类的描述包装
            - 任何"角色说道: "、"旁白: "、"动作: "前缀
            你的回复【应该】是【你(${chat.name})真正会说出口的话】, 整段内容会被直接朗读给用户听。
            【白名单例外 · 重要】: 你的回复里【只有下面这三种方括号指令】是被允许的:
                [[舞台:背景名]]   见文末【舞台控制】
                [[表情:表情名]]   见文末【表情控制】
                [[语音:emotion]]  见文末【语音控制】
            这三种都【不会被朗读】(系统在送去合成语音之前会自动摘掉), 而且【通话界面上也不会显示】——
            对方看不到它们。所以你只管按格式写, 不用担心格式本身被看到。
            除了这三种, 别的位置【任何】方括号标记都不许出现 —— 不许自创 [[任意:任意]]。
        2.  **【多句发言】**: 你可以一次说多句话, 用正常的中文标点(。?!)分隔, 整段连续输出。
        3.  **【人设保留】**: 严格遵守你的人设 / 语气 / 说话习惯 / 上下文理解能力; 只是【不要生成任何旁白/动作/表情/场景/心理/第三人称叙述】。
        4.  **【示例 - 正确】**:
            "你今天来得挺早的, 我还以为你又迟到了呢。快坐吧, 想喝点什么?"
        5.  **【示例 - 错误, 不要这样写】**:
            ${"```"}json
            [{"type": "narration", "content": "他笑了笑"}, {"type": "dialogue", "content": "你今天来得挺早的"}]
            ${"```"}
            或: 旁白: 他笑了笑。角色说道: 你今天来得挺早的。
            或: （他笑了笑）你今天来得挺早的。
            或: [[动作:挥手]] —— 动作一律用纯台词表达, 没有 [[动作:]] 这种开关。
        # 当前情景
        你正在和用户（${userNickname}, 人设: ${chat.settings.myPersona}）进行视频通话。
        ${longTermMemoryContext}${timeContextBlock}
        **${openingContext}**
        **通话前的聊天摘要 (这是你们通话的原因, 至关重要!)**:
        ${videoCallState.preCallContext}
        现在, 请根据【通话前摘要】和下面的【通话实时记录】, 以${chat.name}的身份继续回复。
        ${videoCallStageBlock}
        ${videoCallTtsBlock}
        `;
    }


    const messagesForApi = [{
      role: 'system',
      content: inCallPrompt
    },
    ...videoCallState.callHistory.map(h => ({
      role: h.role,
      content: h.content
    }))
    ];

    if (videoCallState.callHistory.length === 0 && !callIdleNudgeActive) {
      const firstLineTrigger = videoCallState.initiator === 'user' ? `*你按下了接听键...*` : `*对方按下了接听键...*`;
      messagesForApi.push({
        role: 'user',
        content: firstLineTrigger
      });
    }

    // 沉默主动接话: 只在这条请求里临时加一句, 【不写进 callHistory】。
    // 这样 AI 知道「该主动开口了」, 而通话记录保持干净 (见 callIdleNudgeActive 注释)。
    if (callIdleNudgeActive && callIdleNudgeText) {
      messagesForApi.push({ role: 'user', content: callIdleNudgeText });
    }

    try {
      // let isGemini = proxyUrl === GEMINI_API_URL; // isGemini is now resolved from config
      let geminiConfig = toGeminiRequestData(model, apiKey, inCallPrompt, messagesForApi)
      const callPayload = {
        model: model,
        messages: messagesForApi,
        temperature: state.globalSettings.apiTemperature || 0.8,
        top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
        presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
        frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
      };
      // 当”主API代理”开启时，与主聊天保持一致，走后端代理转发，否则直连会因渠道仅支持后端代理而无法接通
      const useMainApiProxy = !isGemini
        && typeof window.fetchViaOpenAICompatibleProxy === 'function'
        && typeof window.isMainApiProxyEnabled === 'function'
        && window.isMainApiProxyEnabled();
      // v0.5.0 P26: 直接 fetch 路径加 AbortController.signal — endVideoCall 时能立刻取消 in-flight 请求,
      //   避免旧回合的 fetch 返回时污染新通话 callHistory (turnId 守卫也保底, 但 abort 更及时)。
      //   Gemini 与 fetchViaOpenAICompatibleProxy 包装路径暂未注入 signal (wrapper 内部不支持参数透传),
      //   那两条路径只靠 turnId 守卫拒绝 stale fetch。
      const directFetchOpts = (turn && turn.fetchController ? { signal: turn.fetchController.signal } : {});
      const response = isGemini
        ? await fetch(geminiConfig.url, Object.assign({}, geminiConfig.data || {}, directFetchOpts))
        : useMainApiProxy
          ? await window.fetchViaOpenAICompatibleProxy({
            baseUrl: proxyUrl,
            targetPath: '/chat/completions',
            apiKey,
            payload: callPayload,
            method: 'POST'
          })
          : await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, Object.assign({
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(callPayload)
          }, directFetchOpts));
      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const errData = await response.json(); errMsg = errData?.error?.message || errData?.message || errData?.detail || JSON.stringify(errData); } catch(e) { errMsg += ` (${response.statusText})`; }
        throw new Error(errMsg);
      }

      const data = await response.json();
      const rawAiResponse = isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content;
      const aiResponse = cleanMinimaxCallResponse(rawAiResponse, { provider: proxyUrl, model });
      if (!String(aiResponse || '').trim()) {
        throw new Error('AI返回为空');
      }

      const connectingElement = callFeed.querySelector('em');
      if (connectingElement) connectingElement.remove();

      // AI 文字即将出现：在第一时间立即停止视频通话彩铃 (跟语音通话 stopVoiceCallWaitingMusic 等价)
      // 不管"启用音频"按钮有没有被点过, AI 文字一出现 = 通话已开始, 按钮历史使命完成
      stopVideoCallWaitingMusic('ai-text-rendered');

      if (videoCallState.isGroupCall) {
        const speechArray = parseAiResponse(aiResponse);
        let renderedAiContentCount = 0;
        speechArray.forEach(turn => {
          if (!turn.name || turn.name === userNickname || !turn.speech) return;
          const aiTimestamp = Date.now() + Math.random();
          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          aiBubble.innerHTML = `<strong>${turn.name}:</strong> ${stripCallDisplayText(turn.speech)}`;
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);
          renderedAiContentCount++;
          markVideoCallAiResponseRendered(aiTurnId);
          // v0.5.0 P26: turnId 守卫 — 旧回合 stale fetch 不污染当前 callHistory
          if (!videoCallActiveTurn || videoCallActiveTurn.id !== turn.id) {
            console.warn('[视频通话] turn #' + turn.id + ' stale fetch 群聊返回, 跳过 callHistory.push');
            return;
          }
          videoCallState.callHistory.push({
            role: 'assistant',
            content: `${turn.name}: ${turn.speech}`,
            timestamp: aiTimestamp
          });

          const speaker = videoCallState.participants.find(p => p.name === turn.name);
          if (speaker) {
            const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="${speaker.id}"] .participant-avatar`);
            if (speakingAvatar) {
              speakingAvatar.classList.add('speaking');
              setTimeout(() => speakingAvatar.classList.remove('speaking'), 2000);
            }
          }
        });
        if (renderedAiContentCount === 0) {
          throw new Error('AI返回为空');
        }
        finishVideoCallTurn(turn, 'group-no-tts');
      } else {
        // P6: 单人视频通话改为纯对白模式 (跟现有语音通话单聊一致)
        //   - AI 返回纯文本, parseAiResponse 兜底返回 [{ type: 'text', content: originalText }]
        //   - 遍历每条 msg 取 content/speech, 直接进 TTS
        //   - 不再区分 narration / dialogue, 不再按 interleavedMode 分支
        const enableTts = chat.settings.enableTts !== false;
        const voiceId = chat.settings.minimaxVoiceId;
        let hasVideoCallTtsPlayback = false;

        // v0.5.0 P12/P14: 先把 AI 的指令 (舞台/表情) 摘掉, 再进 parseAiResponse / TTS
        // (摘不干净最多多念一行标记; 不会像 JSON 解析失败那样把整段回复毁掉)
        const stageExtract = extractVideoCallDirectives(aiResponse);
        // 诊断: 一眼看出"AI 这轮到底有没有吐指令" —— 配合 buildVideoCallStagePromptBlock 里的
        // "已把背景清单写进 prompt: N 张" 一起看, 就能区分是 prompt 没给清单, 还是模型没按格式写。
        console.log('[视频通话舞台] 本轮 AI 回复摘出: 舞台指令 ' + stageExtract.names.length
          + ' 条, 表情指令 ' + stageExtract.expressions.length + ' 条');
        if (!stageExtract.text && (stageExtract.names.length || stageExtract.expressions.length)) {
          // AI 只吐了指令、一句台词都没有 → 走已有的 [ERROR:] 气泡路径,
          // 否则 parseAiResponse 会把空串变成占位符 "(AI返回了空内容)" 并念出来
          throw new Error('AI 只返回了指令标记, 没有台词');
        }
        if (stageExtract.names.length) {
          // 一次回复里写了多条就只取最后一条, 避免连续跳背景
          const stageName = stageExtract.names[stageExtract.names.length - 1];
          applyVideoCallStageDirective(stageName, chat).catch(e => {
            console.warn('[视频通话舞台] 指令执行异常:', e);
          });
        }
        if (stageExtract.expressions.length) {
          // 表情同理只取最后一条
          const exprName = stageExtract.expressions[stageExtract.expressions.length - 1];

          // v0.5.0 P20: 表情互斥叠加处理。
          // 真凶: 当前 cubism4 模型的表情是"附加层", 直接 setExpression 切下一个 → 旧表情不会卸
          //       要么视觉上叠加, 要么新表情被旧的覆盖"看起来没换"。
          // 修法: 切下一个非"恢复"指令前, 系统先帮你执行一次 [[表情:恢复]] 把上一表情卸掉。
          //       用户说"我懒得记这个规则" → 由代码兜底, AI 不用关心, prompt 里也明确告诉它别自己写恢复。
          //       注意: 异步, 恢复操作要等完成再切新表情, 否则两条指令抢同一帧 model.state。
          const isReset = isVideoCallExpressionReset(exprName);
          const lastApplied = videoCallState.lastAppliedExpression || '';
          const needResetBefore = !isReset && lastApplied && lastApplied !== '恢复' && lastApplied !== '默认' && lastApplied !== exprName;
          // v0.5.0 P26.1: 这里【不能】用 turnId 守卫。
          //   原因: 本 IIFE 是 fire-and-forget, 设计上生命周期【故意长于单个 turn】——
          //   它写入的 lastAppliedExpression 要等【下一轮】才被 needResetBefore 读走,
          //   用来实现"表情互斥叠加"的跨轮记忆/恢复。
          //   P26 曾加 `videoCallActiveTurn.id === thisTurnId` 三道守卫, 结果:
          //     await applyVideoCallExpressionDirective('恢复', chat) 期间,
          //     TTS 播完 → onVideoCallTtsQueueFinished → finishVideoCallTurn
          //     → videoCallActiveTurn = null → 恢复后第二道守卫必然 return
          //     → 表情永不切换 + lastAppliedExpression 永不写入
          //     → 表现为"Live2D 表情/自动恢复全失效"(背景切换不受影响, 那条链没加守卫)。
          //   改用 videoCallState.isActive 判断生命周期:
          //     isActive 覆盖了真正需要拦截的场景 (挂断 endVideoCall 置 false +
          //     unmountLive2DForCall 已销毁 model), 且不受 turn 收口时机影响。
          (async () => {
            try {
              if (!videoCallState.isActive) return;
              if (needResetBefore) {
                console.log('[视频通话表情] 先卸旧表情 →', lastApplied, '再切 →', exprName);
                await applyVideoCallExpressionDirective('恢复', chat);
              }
              if (!videoCallState.isActive) return;
              const ok = await applyVideoCallExpressionDirective(exprName, chat);
              if (!videoCallState.isActive) return;
              // 记录"本轮实际生效"的表情, 给下一轮兜底用。
              if (ok && !isReset) {
                videoCallState.lastAppliedExpression = exprName;
              } else if (isReset) {
                videoCallState.lastAppliedExpression = '恢复';
              }
            } catch (e) {
              console.warn('[视频通话表情] 指令执行异常:', e);
            }
          })();
        }

        // ⚠️ [[语音:happy]] 标签【原样保留】在这里: 气泡、callHistory、AI 回看的上下文
        //   全部拿带标签的原文。剥离只发生在 tts-audio.js 真正发 MiniMax 的那一刻。
        const messagesArray = parseAiResponse(stageExtract.text);

        messagesArray.forEach((msg, index) => {
          const messageContent = String(msg.content || msg.speech || '').trim();
          if (!messageContent) return;
          const aiTimestamp = Date.now() + index + 1;

          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          // 显示时摘掉语气声 / 停顿标记 (callHistory 与 TTS 仍用 messageContent 原文)
          aiBubble.textContent = stripCallDisplayText(messageContent);
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);

          // v0.5.0 P26: turnId 守卫
          if (!videoCallActiveTurn || videoCallActiveTurn.id !== turn.id) {
            console.warn('[视频通话] turn #' + turn.id + ' stale fetch 返回, 跳过单聊 callHistory.push');
            return;
          }
          videoCallState.callHistory.push({
            role: 'assistant',
            content: messageContent,
            timestamp: aiTimestamp
          });

          markVideoCallAiResponseRendered(aiTurnId);

          if (enableTts && voiceId) {
            setVideoCallStatusText('AI正在说话…');
            if (playVideoCallPureTTS(messageContent, voiceId, {
              source: 'videoCall',
              languageBoost: getActiveCallTtsLanguageBoost(),
              // 2026-10-01: 日语/英文音色可配, 语言判定在 tts-audio.js 内统一做
              voices: getActiveCallVoiceConfig(chat)
            })) {
              hasVideoCallTtsPlayback = true;
              // v0.5.0 P26: 进入 tts_playing 阶段 — 通过 turn.onPhaseChange 同步三个布尔锁
              if (videoCallActiveTurn && videoCallActiveTurn.id === turn.id) {
                turn.onPhaseChange('tts_playing');
              }
            }
          }
        });

        if (messagesArray.length === 0) {
          throw new Error('AI返回为空');
        }

        // 头像动画
        const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="ai"] .participant-avatar`);
        if (speakingAvatar) {
          speakingAvatar.classList.add('speaking');
          const totalLength = messagesArray.reduce((sum, msg) => sum + String(msg.content || msg.speech || '').trim().length, 0);
          const speakTime = Math.min(totalLength * 200, 5000);
          setTimeout(() => speakingAvatar.classList.remove('speaking'), speakTime);
        }
        if (!hasVideoCallTtsPlayback) {
          // v0.5.0 P26: 没 TTS 路径 — 直接 finish turn, 不再依赖 onVideoCallTtsQueueFinished (避免依赖 hasRenderedAiResponse)
          finishVideoCallTurn(turn, 'no-tts');
        }
      }

      callFeed.scrollTop = callFeed.scrollHeight;

    } catch (error) {
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: ${error.message}]`;
      callFeed.appendChild(errorBubble);
      callFeed.scrollTop = callFeed.scrollHeight;
      // 上面这颗气泡是塞进 #video-call-main 的, 而那个容器被 `display:none !important` 隐藏
      // → 用户根本看不到任何错误, 只感觉"AI 突然不说话了"。
      // 这里同步把错误显示到【可见的】状态胶囊上, 让故障一眼可见。
      setVideoCallStatusText('出错了：' + error.message, { holdMs: CALL_STATUS_ERROR_HOLD_MS });
      // v0.5.0 P26: turnId 守卫 — 异常路径也拒绝 stale 写入
      if (videoCallActiveTurn && videoCallActiveTurn.id === turn.id) {
        videoCallState.callHistory.push({
          role: 'assistant',
          content: `[ERROR: ${error.message}]`
        });
      }
      // 错误路径也要停彩铃 (跟语音通话 catch 里 stopVoiceCallWaitingMusic('error') 等价)
      stopVideoCallWaitingMusic('error');
      markVideoCallAiResponseRendered(aiTurnId);
      // v0.5.0 P26: 用 failVideoCallTurn 替代 onVideoCallTtsQueueFinished — turnId 守卫拒绝 stale
      failVideoCallTurn(turn, error.message);
    }
    // ★ 每次发送后修剪历史
    trimCallHistory(videoCallState);
  }

  // ── v0.5.0 P19: AI 回合兜底包装 ──────────────────────────────────────
  // 真凶: triggerAiInCallActionInner 在 "isAiResponding = true" (内层 1756) 和第一处 try (内层 1991)
  //   之间有一段【完全没有保护】的代码 (prompt 组装, 含 buildVideoCallDirectivesPromptBlock)。
  //   那里任何一处抛异常 → Promise 直接 reject, 而 isAiResponding 永远不会被重置
  //   → 之后每一轮都在内层开头 `if (isAiResponding) return` 被吃掉
  //   → 表现就是「接通后 AI 完全不说话、状态小字也不动、等多久都没动静」,
  //     而且异常只在控制台可见, 界面上一点提示都没有。
  // 兜底: 任何异常都强制复位通话状态, 并把错误显示到【看得见的】状态胶囊上, 绝不静默卡死。
  async function triggerAiInCallAction(userInput = null) {
    try {
      return await triggerAiInCallActionInner(userInput);
    } catch (e) {
      // v0.5.0 P26: 兜底异常 — 强制走 failVideoCallTurn 释放 turn + 同步布尔锁
      //   (旧实现直接改 videoCallState 三个布尔锁, 但 activeTurn 没清理 — 如果用户很快又说话
      //    会触发 isInVideoCallTurn 守卫卡死)
      console.error('[视频通话] AI 回合异常, 已强制复位通话状态 (否则会永久卡死):', e);
      const turn = videoCallActiveTurn;
      if (turn) {
        failVideoCallTurn(turn, (e && e.message) ? e.message : String(e));
      } else {
        videoCallState.isAiResponding = false;
        videoCallState.isAiSpeaking = false;
        videoCallState.isTtsPlaying = false;
        videoCallState.canUserSpeak = true;
        const msg = (e && e.message) ? e.message : String(e);
        setVideoCallStatusText('出错了：' + msg, { holdMs: CALL_STATUS_ERROR_HOLD_MS });
      }
      return null;
    }
  }
  function trimCallHistory(callState) {
    if (callState.callHistory.length > 100) {
      callState.callHistory = callState.callHistory.slice(-100);
    }
  }




  function toggleCallButtons(isGroup) {
    document.getElementById('video-call-btn').style.display = isGroup ? 'none' : 'flex';
    document.getElementById('group-video-call-btn').style.display = isGroup ? 'flex' : 'none';
    document.getElementById('voice-call-btn').style.display = isGroup ? 'none' : 'flex';
    document.getElementById('group-voice-call-btn').style.display = isGroup ? 'flex' : 'none';
  }

  function logCallTtsRecoveryDiag(callType, reason = '') {
    if (!reason) return;
    try {
      window.runtimeDiag?.log?.('CALL_STATE_RECOVERED_AFTER_TTS_ERROR', {
        callType,
        errorType: reason,
        textLength: 0
      });
    } catch (error) {
      console.warn('[通话TTS恢复诊断日志失败]', error);
    }
  }

  function onVideoCallTtsQueueFinished(reason = '') {
    if (!videoCallState.isActive) return;
    // v0.5.0 P26: turnId 守卫 — 不再用 hasRenderedAiResponse 做跨回合身份判断
    //   (旧实现里这个守卫有缺陷: 旧轮 stale 回调在新轮 hasRenderedAiResponse=true 时会通过,
    //    错误释放新轮锁 — 见审计报告 A2)
    //   新规则: 只有当前 activeTurn 存在时才释放, 否则视为 stale 回调直接丢弃
    const turn = videoCallActiveTurn;
    if (!turn) {
      console.warn('[视频通话] TTS 完成回调到达但无活跃 turn, 丢弃 (stale)');
      return;
    }
    finishVideoCallTurn(turn, reason || '');
  }

  // ==================== 语音通话功能 ====================

  async function handleInitiateVoiceCall() {
    if (!state.activeChatId || voiceCallState.isActive || voiceCallState.isAwaitingResponse) return;

    const chat = state.chats[state.activeChatId];
    voiceCallState.isGroupCall = chat.isGroup;
    voiceCallState.isAwaitingResponse = true;
    voiceCallState.initiator = 'user';
    voiceCallState.activeChatId = chat.id;
    voiceCallState.isUserParticipating = true;

    if (chat.isGroup) {
      document.getElementById('outgoing-call-avatar').src = chat.settings.myAvatar || defaultMyGroupAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.settings.myNickname || '我';
    } else {
      document.getElementById('outgoing-call-avatar').src = chat.settings.aiAvatar || defaultAvatar;
      document.getElementById('outgoing-call-name').textContent = chat.name;
    }
    document.querySelector('#outgoing-call-screen .caller-text').textContent = chat.isGroup ? "正在呼叫所有成员..." : "正在呼叫...";
    showScreen('outgoing-call-screen');

    const requestMessage = {
      role: 'system',
      content: chat.isGroup ?
        `[系统提示：用户 (${chat.settings.myNickname || '我'}) 发起了群语音通话请求。请你们各自决策，并使用 "group_voice_response" 指令，设置 "decision" 为 "join" 或 "decline" 来回应。]` :
        `[系统提示：用户向你发起了语音通话请求。请根据你的人设，使用 "voice_call_response" 指令，并设置 "decision" 为 "accept" 或 "reject" 来回应。]`,
      timestamp: Date.now(),
      isHidden: true,
    };
    chat.history.push(requestMessage);
    await db.chats.put(chat);

    await triggerAiResponse();
  }

  function getVoiceCallRecordingMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];

    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }

    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function ensureVoiceCallMicStream() {
    if (voiceCallMicStream && voiceCallMicStream.getAudioTracks().some(track => track.readyState === 'live')) {
      return voiceCallMicStream;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前环境不支持麦克风录音');
    }

    voiceCallMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return voiceCallMicStream;
  }

  function setVoiceCallRecordingButtonState(isRecording) {
    const speakBtn = document.getElementById('voice-user-speak-btn');
    if (!speakBtn) return;

    speakBtn.classList.toggle('recording', isRecording);
    speakBtn.title = isRecording ? '点击停止录音并识别' : '点击开始录音';
  }

  function hideVoiceCallManualMicButton() {
    const speakBtn = document.getElementById('voice-user-speak-btn');
    if (speakBtn) {
      speakBtn.style.display = 'none';
    }
  }

  function clearVoiceCallAutoListenTimers() {
    voiceCallAutoListenTimers.forEach(timerId => clearTimeout(timerId));
    voiceCallAutoListenTimers = [];

    if (voiceCallAutoListenAnimationFrame) {
      cancelAnimationFrame(voiceCallAutoListenAnimationFrame);
      voiceCallAutoListenAnimationFrame = null;
    }
  }

  function cleanupVoiceCallAudioAnalysis() {
    clearVoiceCallAutoListenTimers();

    if (voiceCallAnalyser) {
      try {
        voiceCallAnalyser.disconnect();
      } catch (error) {
        console.warn('语音通话音量检测节点断开失败:', error);
      }
      voiceCallAnalyser = null;
    }

    if (voiceCallAudioContext) {
      try {
        voiceCallAudioContext.close();
      } catch (error) {
        console.warn('语音通话 AudioContext 关闭失败:', error);
      }
      voiceCallAudioContext = null;
    }
  }

  function stopVoiceCallMicStream() {
    if (voiceCallMicStream) {
      voiceCallMicStream.getTracks().forEach(track => track.stop());
      voiceCallMicStream = null;
    }
  }

  function resetVoiceCallAutoListenState() {
    voiceCallIsListening = false;
    voiceCallIsRecording = false;
    voiceCallIsRecognizing = false;
    voiceCallAutoListenStartedAt = 0;
    voiceCallUserSpeechStartedAt = 0;
    voiceCallLastVoiceAt = 0;
    voiceCallHasDetectedSpeech = false;
    voiceCallAutoStopReason = 'manual';
  }

  function stopVoiceCallRecording(shouldProcessRecording = true, stopReason = 'manual') {
    if (!voiceCallMediaRecorder || voiceCallMediaRecorder.state === 'inactive') return;

    voiceCallAutoStopReason = stopReason;
    voiceCallMediaRecorder.__shouldProcessVoiceCallRecording = shouldProcessRecording;
    voiceCallMediaRecorder.stop();
  }

  async function processVoiceCallRecording(audioBlob) {
    if (!voiceCallState.isActive || !audioBlob || audioBlob.size === 0) {
      // ⚠️⚠️ 修复「麦克风死了」: 空 blob 直接 return, 监听再也不重启。
      //    语音侧【没有】视频那个 chunks.length === 0 检查, 所以死路在这里。
      //    (视频对应的修复在 recorder stop 处理器里的 chunks.length === 0 分支)
      //
      //    这里不用先清 voiceCallIsRecognizing —— 下面的 try 还没把它置 true。
      if (voiceCallState.isActive) {
        setVoiceCallStatusText('未识别到有效语音');
        startVoiceCallAutoListening();
      }
      return;
    }

    const userAvatar = document.querySelector('#voice-participant-avatars-grid .participant-avatar-wrapper[data-participant-id="user"] .participant-avatar');

    try {
      voiceCallIsRecognizing = true;
      // v0.2.30.25: 不切到"正在识别…", 保持"倾听中"直到 ASR 完成
      // (用户原话: 提示文字应该只有"倾听中/思考中/点击打断")

      if (typeof window.transcribeAudioBlob !== 'function') {
        throw new Error('ASR 转写函数不可用');
      }

      const recognizedText = String(await window.transcribeAudioBlob(audioBlob)).trim();
      if (!recognizedText) {
        setVoiceCallStatusText('未识别到有效语音');
        // ⚠️ 同视频通话: 先清 voiceCallIsRecognizing 再重启 (入口守卫里有这个标志)
        voiceCallIsRecognizing = false;
        if (voiceCallState.isActive) {
          console.warn('[语音通话] ASR 未识别到有效语音, 重新启动自动监听');
          startVoiceCallAutoListening();
        }
        return;
      }

      if (userAvatar) {
        userAvatar.classList.add('speaking');
      }

      triggerAiInVoiceCallAction(recognizedText);
    } catch (error) {
      console.error('语音通话 ASR 识别失败:', error);
      setVoiceCallStatusText('语音识别失败');
      if (typeof showToast === 'function') {
        showToast('语音识别失败：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('语音识别失败', error && error.message ? error.message : '未知错误');
      }
    } finally {
      voiceCallIsRecognizing = false;
      if (userAvatar) {
        userAvatar.classList.remove('speaking');
      }
    }
  }

  async function startVoiceCallRecording() {
    if (!voiceCallState.isActive || !voiceCallState.isUserParticipating || isVoiceCallRecording) return;

    const stream = await ensureVoiceCallMicStream();
    const mimeType = getVoiceCallRecordingMimeType();
    const recorderOptions = mimeType ? { mimeType } : {};

    voiceCallRecordedChunks = [];
    voiceCallMediaRecorder = new MediaRecorder(stream, recorderOptions);
    voiceCallMediaRecorder.__shouldProcessVoiceCallRecording = true;

    voiceCallMediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        voiceCallRecordedChunks.push(event.data);
      }
    });

    voiceCallMediaRecorder.addEventListener('stop', () => {
      const chunks = voiceCallRecordedChunks;
      const shouldProcessRecording = voiceCallMediaRecorder.__shouldProcessVoiceCallRecording;
      const blobType = voiceCallMediaRecorder.mimeType || mimeType || 'audio/webm';
      const stopReason = voiceCallAutoStopReason;

      isVoiceCallRecording = false;
      voiceCallIsRecording = false;
      voiceCallIsListening = false;
      setVoiceCallRecordingButtonState(false);
      cleanupVoiceCallAudioAnalysis();
      stopVoiceCallMicStream();
      voiceCallRecordedChunks = [];
      voiceCallMediaRecorder = null;

      const recordedMs = Date.now() - voiceCallAutoListenStartedAt;
      resetVoiceCallAutoListenState();

      if (!shouldProcessRecording || !voiceCallState.isActive) return;

      if (stopReason === 'no-speech') {
        setVoiceCallStatusText('未检测到有效语音');
        // ⚠️⚠️ 修复「麦克风死了」: 同视频通话。语音侧 no-speech 是【独立分支】,
        //    所以这里不用像视频那样再判一次 stopReason。
        startVoiceCallAutoListening();
        return;
      }

      if (recordedMs < VOICE_CALL_AUTO_LISTEN_CONFIG.minRecordingMs) {
        setVoiceCallStatusText('未识别到有效语音');
        // 录音太短 (误触) —— 重启
        startVoiceCallAutoListening();
        return;
      }

      const audioBlob = new Blob(chunks, { type: blobType });
      processVoiceCallRecording(audioBlob);
    }, { once: true });

    voiceCallMediaRecorder.start();
    isVoiceCallRecording = true;
    voiceCallIsRecording = true;
    setVoiceCallRecordingButtonState(true);

    // v0.2.30.24: 用户开始说话 → 切换光晕到 listening (挂断键位置, 大光晕闪烁)
    setVoiceCallGlowState('listening');
    setVoiceCallStatusText('倾听中');
  }

  async function handleVoiceCallUserSpeak() {
    if (!voiceCallState.isActive || !voiceCallState.isUserParticipating) return;

    if (isVoiceCallRecording) {
      stopVoiceCallRecording(true);
      return;
    }

    // v0.2.30.24: "点击打断" 逻辑 — AI 正在说话时, 先停 TTS 再录音
    if (voiceCallState.isTtsPlaying || voiceCallState.isAiSpeaking) {
      try {
        stopTtsQueue();
      } catch (e) {
        console.warn('[语音通话] stopTtsQueue 失败:', e);
      }
      // 状态清零, 让 startVoiceCallRecording 不会因为 isAiSpeaking/isTtsPlaying return
      voiceCallState.isAiResponding = false;
      voiceCallState.isAiSpeaking = false;
      voiceCallState.isTtsPlaying = false;
      voiceCallState.canUserSpeak = true;
    }

    try {
      await startVoiceCallRecording();
    } catch (error) {
      console.error('语音通话录音启动失败:', error);
      if (typeof showToast === 'function') {
        showToast('无法开始录音：' + (error && error.message ? error.message : '未知错误'));
      } else if (typeof showCustomAlert === 'function') {
        showCustomAlert('无法开始录音', error && error.message ? error.message : '未知错误');
      }
    }
  }

  function stopVoiceCallAutoListening(shouldProcessRecording = false, stopReason = 'manual') {
    clearVoiceCallAutoListenTimers();
    cleanupVoiceCallAudioAnalysis();

    if (voiceCallMediaRecorder && voiceCallMediaRecorder.state !== 'inactive') {
      stopVoiceCallRecording(shouldProcessRecording, stopReason);
      return;
    }

    stopVoiceCallMicStream();
    voiceCallRecordedChunks = [];
    isVoiceCallRecording = false;
    voiceCallIsRecording = false;
    resetVoiceCallAutoListenState();
    setVoiceCallRecordingButtonState(false);
  }

  function releaseVoiceCallMicrophone() {
    stopVoiceCallAutoListening(false, 'hangup');
  }

  function monitorVoiceCallSilence() {
    if (!voiceCallState.isActive || !voiceCallAutoListenEnabled || !voiceCallIsListening || !voiceCallAnalyser) return;

    const buffer = new Uint8Array(voiceCallAnalyser.fftSize);
    voiceCallAnalyser.getByteTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      const normalized = (buffer[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const volume = Math.sqrt(sumSquares / buffer.length);
    const now = Date.now();
    const elapsed = now - voiceCallAutoListenStartedAt;
    const hasVoice = volume >= VOICE_CALL_AUTO_LISTEN_CONFIG.volumeThreshold;

    if (hasVoice) {
      voiceCallLastVoiceAt = now;
      if (!voiceCallHasDetectedSpeech) {
        voiceCallHasDetectedSpeech = true;
        voiceCallUserSpeechStartedAt = now;
        // v0.2.30.25: 不切到"检测到你在说话…", 保持"倾听中"
      }
    }

    if (!voiceCallHasDetectedSpeech && elapsed >= VOICE_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs) {
      stopVoiceCallRecording(false, 'no-speech');
      return;
    }

    if (voiceCallHasDetectedSpeech && elapsed >= VOICE_CALL_AUTO_LISTEN_CONFIG.minRecordingMs && now - voiceCallLastVoiceAt >= VOICE_CALL_AUTO_LISTEN_CONFIG.silenceAfterSpeechMs) {
      stopVoiceCallRecording(true, 'silence');
      return;
    }

    if (elapsed >= VOICE_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs) {
      stopVoiceCallRecording(true, 'max-duration');
      return;
    }

    voiceCallAutoListenAnimationFrame = requestAnimationFrame(monitorVoiceCallSilence);
  }

  async function startVoiceCallAutoListening() {
    if (!voiceCallState.isActive || !voiceCallState.isUserParticipating || !voiceCallAutoListenEnabled) return;
    if (voiceCallState.isAiResponding || voiceCallState.isAiSpeaking || voiceCallState.isTtsPlaying || voiceCallIsListening || voiceCallIsRecognizing || isVoiceCallRecording) return;

    try {
      // v0.2.30.25: 不切到"我在听…", startVoiceCallRecording 内部会立刻 setVoiceCallStatusText('倾听中')
      await startVoiceCallRecording();

      if (!voiceCallState.isActive || !voiceCallAutoListenEnabled || voiceCallState.isAiResponding || voiceCallState.isAiSpeaking || voiceCallState.isTtsPlaying) {
        stopVoiceCallAutoListening(false, 'interrupted');
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('当前环境不支持 Web Audio 音量检测');
      }

      voiceCallAudioContext = new AudioContextClass();
      const source = voiceCallAudioContext.createMediaStreamSource(voiceCallMicStream);
      voiceCallAnalyser = voiceCallAudioContext.createAnalyser();
      voiceCallAnalyser.fftSize = 2048;
      source.connect(voiceCallAnalyser);

      voiceCallIsListening = true;
      voiceCallAutoListenStartedAt = Date.now();
      voiceCallUserSpeechStartedAt = 0;
      voiceCallLastVoiceAt = 0;
      voiceCallHasDetectedSpeech = false;
      voiceCallAutoStopReason = 'manual';

      voiceCallAutoListenTimers.push(setTimeout(() => {
        if (voiceCallIsListening && !voiceCallHasDetectedSpeech) {
          stopVoiceCallRecording(false, 'no-speech');
        }
      }, VOICE_CALL_AUTO_LISTEN_CONFIG.noSpeechTimeoutMs));

      voiceCallAutoListenTimers.push(setTimeout(() => {
        if (voiceCallIsListening) {
          stopVoiceCallRecording(true, 'max-duration');
        }
      }, VOICE_CALL_AUTO_LISTEN_CONFIG.maxRecordingMs));

      monitorVoiceCallSilence();
    } catch (error) {
      console.error('语音通话自动聆听启动失败:', error);
      stopVoiceCallAutoListening(false, 'start-error');
      setVoiceCallStatusText('无法开始聆听');
      if (typeof showToast === 'function') {
        showToast('无法开始聆听：' + (error && error.message ? error.message : '未知错误'));
      }
    }
  }

  function logVoiceCallDiag(event, details = {}) {
    try {
      window.runtimeDiag?.log?.(event, {
        textLength: typeof details.textLength === 'number' ? details.textLength : undefined,
        skipReason: details.skipReason || undefined,
        durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
        queueLength: typeof details.queueLength === 'number'
          ? details.queueLength
          : (typeof window.getCallTtsQueueLength === 'function' ? window.getCallTtsQueueLength() : 0),
        isTtsPlaying: typeof details.isTtsPlaying === 'boolean'
          ? details.isTtsPlaying
          : Boolean(voiceCallState.isTtsPlaying || (typeof window.isCallTtsPlaying === 'function' && window.isCallTtsPlaying())),
        hasVoiceId: Boolean(details.hasVoiceId)
      });
    } catch (error) {
      console.warn('[语音通话诊断日志失败]', event, error);
    }
  }

  // 2026-09-29: 取当前会话设置的 TTS 语种, 空串 = 自动识别。
  //   通话路径以前完全没把语言参数送到 MiniMax (请求体里没有 language_boost 字段),
  //   服务端按 null 处理 → 模型自己猜语种 → "日语音色念出中文"就是这么来的。
  //   做成函数声明 (会提升), 所以 2492 行的视频通话分支也能直接用。
  function getActiveCallTtsLanguageBoost() {
    try {
      const chatId = typeof state !== 'undefined' ? state.activeChatId : null;
      const chat = chatId && typeof state !== 'undefined' ? state.chats?.[chatId] : null;
      return chat?.settings?.ttsLanguage || '';
    } catch (e) {
      return '';
    }
  }

  // 2026-10-01: 取当前会话的三个音色配置 (中文/默认 + 日语 + 英文)。
  //   语言判定与 voice 解析都在 tts-audio.js 的 resolveVoiceId 里做,
  //   这里只负责把配置原样递过去 —— 通话链路不做任何语言判断。
  //   与 getActiveCallTtsLanguageBoost 一样做成函数声明 (会提升)。
  function getActiveCallVoiceConfig(chat) {
    let target = chat;
    if (!target) {
      try {
        const chatId = typeof state !== 'undefined' ? state.activeChatId : null;
        target = chatId && typeof state !== 'undefined' ? state.chats?.[chatId] : null;
      } catch (e) {
        target = null;
      }
    }
    const settings = (target && target.settings) || {};
    return {
      zh: settings.minimaxVoiceId || '',
      ja: settings.minimaxVoiceIdJa || '',
      en: settings.minimaxVoiceIdEn || ''
    };
  }

  function enqueueVoiceCallDisplayTextTts(displayText, voiceId, voices) {
    const ttsText = String(displayText || '').trim();
    const queueLength = typeof window.getCallTtsQueueLength === 'function' ? window.getCallTtsQueueLength() : 0;
    const hasVoiceId = Boolean(voiceId);

    logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_ATTEMPT', {
      textLength: ttsText.length,
      queueLength,
      hasVoiceId
    });

    if (!ttsText) {
      logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
        textLength: 0,
        skipReason: 'emptyDisplayText',
        queueLength,
        hasVoiceId
      });
      return false;
    }

    const enqueued = typeof playVideoCallPureTTS === 'function'
      ? playVideoCallPureTTS(ttsText, voiceId, {
          source: 'voiceCall',
          languageBoost: getActiveCallTtsLanguageBoost(),
          voices: voices || getActiveCallVoiceConfig()
        })
      : false;

    if (enqueued) {
      voiceCallState.isAiSpeaking = true;
      voiceCallState.isTtsPlaying = true;
      voiceCallState.canUserSpeak = false;
      setVoiceCallStatusText('点击打断');
      // v0.2.30.24: AI 开始说话 → 光晕迁移到 AI 头像 (大, 闪烁)
      setVoiceCallGlowState('speaking');
      return true;
    }

    logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
      textLength: ttsText.length,
      skipReason: 'enqueueRejected',
      queueLength,
      hasVoiceId
    });
    return false;
  }

  function onVoiceCallTtsQueueFinished(reason = '') {
    if (!voiceCallState.isActive) return;

    voiceCallState.isAiResponding = false;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = true;
    // v0.2.30.24: AI 说完 → 状态清空, 不显示"可以说话了"中间态
    // 下一轮是倾听中, autoListen 启动后监测到声音才切 'listening' + "倾听中"
    setVoiceCallStatusText('');
    setVoiceCallGlowState('idle');
    logCallTtsRecoveryDiag('voice', reason);
    logVoiceCallDiag('VOICE_CALL_TTS_RECOVERED', {
      textLength: 0,
      skipReason: reason || undefined,
      queueLength: typeof window.getCallTtsQueueLength === 'function' ? window.getCallTtsQueueLength() : 0,
      hasVoiceId: false,
      isTtsPlaying: false
    });
    console.log('[语音通话] AI 多段 TTS 已全部播放完成，可以说话。');
    callDiagNote('一轮对话结束');
    callDiagSample();
    startVoiceCallAutoListening();
    // 沉默主动接话: 一轮对话结束 = 又一次"活动", 重新计时
    armVoiceCallIdleNudge();
  }

  function startVoiceCall() {
    const chat = state.chats[voiceCallState.activeChatId];
    if (!chat) return;

    voiceCallState.isActive = true;
    voiceCallState.isAwaitingResponse = false;
    voiceCallState.startTime = Date.now();
    callDiagReset('voice');
    voiceCallState.callHistory = [];
    voiceCallState.isAiResponding = false;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = true;

    const preCallHistory = chat.history.slice(-10);
    voiceCallState.preCallContext = preCallHistory.map(msg => {
      const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : (msg.senderName || chat.name);
      return `${sender}: ${String(msg.content).substring(0, 50)}...`;
    }).join('\n');

    updateVoiceParticipantAvatars();

    document.getElementById('voice-call-main').innerHTML = `<em>${voiceCallState.isGroupCall ? '群聊已建立...' : '正在接通...'}</em>`;
    setVoiceCallStatusText('');
    voiceCallAutoListenEnabled = true;
    resetVoiceCallAutoListenState();
    // 沉默主动接话: 同视频通话, 每次接通重新计数 + 重新计时
    voiceCallIdleNudgeCount = 0;
    armVoiceCallIdleNudge();
    voiceCallStatusHoldUntil = 0;  // 同上
    showScreen('voice-call-screen');

    hideVoiceCallManualMicButton();
    document.getElementById('voice-join-call-btn').style.display = voiceCallState.isUserParticipating ? 'none' : 'block';

    // 通话开始: 显示并重置"启用音频"按钮
    // 防御: 极端路径下(如挂断状态错乱)按钮可能停在 connected
    setVoiceCallAudioUnlockBtnVisibility(true);
    // v0.2.30.24: 通话开始 → 光晕回到 idle (隐藏), 状态文字清零
    setVoiceCallGlowState('idle');
    setVoiceCallStatusText('');

    if (voiceCallTimerInterval) clearInterval(voiceCallTimerInterval);
    voiceCallTimerInterval = setInterval(updateVoiceCallTimer, 1000);
    updateVoiceCallTimer();

    triggerAiInVoiceCallAction();
  }

  function minimizeVoiceCall() {
    if (!voiceCallState.isActive) return;
    document.getElementById('voice-call-restore-btn').style.display = 'flex';
    showScreen('chat-interface-screen');
    console.log("语音通话已最小化。");
  }

  function restoreVoiceCall() {
    if (!voiceCallState.isActive) return;
    document.getElementById('voice-call-restore-btn').style.display = 'none';
    showScreen('voice-call-screen');
    console.log("语音通话已恢复。");
  }

  async function endVoiceCall() {
    // === 挂断停止背景音乐 START ===
    if (window.voiceCallBgAudio) {
      console.log('[Audio] 挂断通话，立刻停止背景音乐');
      window.voiceCallBgAudio.pause();
      window.voiceCallBgAudio.currentTime = 0;
      window.voiceCallBgAudio = null;
    }
    // === 挂断停止背景音乐 END ===

    // 挂断: 重置"启用音频"按钮到 unlock-inactive 并显示
    // 下次再打时按钮要重新出现
    setVoiceCallAudioUnlockBtnVisibility(true);

    if (!voiceCallState.isActive) return;

    callDiagStage('hangup:start');

    // v0.5.1: 硬件 / 音频资源提前释放 (原来排在两次 await 落库之后 ——
    //   整个落库期间麦克风还开着、AudioContext 还活着, 而这正是挂断要顶的峰值窗口)。
    //   先放资源再干活, 对用户没有任何可见影响。
    stopTtsQueue();
    document.getElementById('voice-call-restore-btn').style.display = 'none';
    clearInterval(voiceCallTimerInterval);
    voiceCallTimerInterval = null;

    voiceCallAutoListenEnabled = false;
    releaseVoiceCallMicrophone();
    // 沉默主动接话: 挂断了就彻底停掉
    clearVoiceCallIdleNudgeTimer();

    // v0.5.1: 清空通话气泡 DOM (同 endVideoCall —— showScreen 只切 class 不清 DOM)
    const voiceCallMainEl = document.getElementById('voice-call-main');
    if (voiceCallMainEl) voiceCallMainEl.innerHTML = '';

    // 注: 语音侧的 voiceCallAudioContext / voiceCallAnalyser 已由上面的
    // releaseVoiceCallMicrophone() → cleanupVoiceCallAudioAnalysis() 负责 close+清引用,
    // 这里不需要再重复一遍 (视频侧那个 ctx 是 P26 特意改成"整个通话复用"才需要显式关的)。

    callDiagStage('hangup:hardware-released');

    const duration = Math.floor((Date.now() - voiceCallState.startTime) / 1000);
    const durationText = `${Math.floor(duration / 60)}分${duration % 60}秒`;
    const endCallText = `语音通话结束，时长 ${durationText}`;

    const chat = state.chats[voiceCallState.activeChatId];
    let callTranscriptForAI = '';
    if (chat) {
      const participantsData = [];
      if (voiceCallState.isGroupCall) {
        voiceCallState.participants.forEach(p => participantsData.push({
          name: p.originalName,
          avatar: p.avatar
        }));
        if (voiceCallState.isUserParticipating) {
          participantsData.unshift({
            name: chat.settings.myNickname || '我',
            avatar: chat.settings.myAvatar || defaultMyGroupAvatar
          });
        }
      } else {
        participantsData.push({
          name: chat.name,
          avatar: chat.settings.aiAvatar || defaultAvatar
        });
        participantsData.unshift({
          name: '我',
          avatar: chat.settings.myAvatar || defaultAvatar
        });
      }

      const callRecord = {
        chatId: voiceCallState.activeChatId,
        timestamp: Date.now(),
        duration: duration,
        participants: participantsData,
        transcript: [...voiceCallState.callHistory],
        callType: 'voice'
      };
      const newRecordId = await db.callRecords.add(callRecord);
      console.log("语音通话记录已保存:", callRecord);

      let summaryMessage = {
        role: voiceCallState.initiator === 'user' ? 'user' : 'assistant',
        content: endCallText,
        timestamp: Date.now(),
        callRecordId: newRecordId
      };
      if (chat.isGroup && summaryMessage.role === 'assistant') {
        summaryMessage.senderName = voiceCallState.callRequester || chat.members[0]?.originalName || chat.name;
      }
      chat.history.push(summaryMessage);

      callTranscriptForAI = voiceCallState.callHistory.map(h => {
        const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : h.senderName;
        return `${sender}: ${h.content}`;
      }).join('\n');

      await db.chats.put(chat);
      callDiagStage('hangup:chat-saved');
    }

    voiceCallState.isActive = false;
    voiceCallState.isAwaitingResponse = false;
    voiceCallState.isGroupCall = false;
    voiceCallState.activeChatId = null;
    voiceCallState.initiator = null;
    voiceCallState.startTime = null;
    voiceCallState.participants = [];
    voiceCallState.isUserParticipating = true;
    voiceCallState.callHistory = [];
    voiceCallState.preCallContext = "";
    voiceCallState.isAiResponding = false;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = true;

    // 切回聊天界面 —— await 它, 别和别的大活挤在同一帧 (同 endVideoCall)。
    if (chat) {
      try {
        await openChat(chat.id);
      } catch (e) {
        console.warn('[语音通话] 挂断后切回聊天界面失败:', e);
      }
      callDiagStage('hangup:back-to-chat');

      if (callTranscriptForAI) {
        try {
          Promise.resolve(summarizeCallTranscript(chat.id, callTranscriptForAI)).catch(err => {
            console.warn('[语音通话] 通话总结失败 (不影响挂断):', err);
          });
        } catch (err) {
          console.warn('[语音通话] 通话总结调用失败 (不影响挂断):', err);
        }
      }
    }
    callDiagStage('hangup:done');
  }

  function updateVoiceParticipantAvatars() {
    const grid = document.getElementById('voice-participant-avatars-grid');
    grid.innerHTML = '';
    const chat = state.chats[voiceCallState.activeChatId];
    if (!chat) return;

    let participantsToRender = [];

    if (voiceCallState.isGroupCall) {
      participantsToRender = [...voiceCallState.participants];
      if (voiceCallState.isUserParticipating) {
        participantsToRender.unshift({
          id: 'user',
          name: chat.settings.myNickname || '我',
          avatar: chat.settings.myAvatar || defaultMyGroupAvatar
        });
      }
    } else {
      participantsToRender.push({
        id: 'ai',
        name: chat.name,
        avatar: chat.settings.aiAvatar || defaultAvatar
      });
    }

    participantsToRender.forEach(p => {
      const wrapper = document.createElement('div');
      wrapper.className = 'participant-avatar-wrapper';
      wrapper.dataset.participantId = p.id;
      const displayName = p.groupNickname || p.name;
      // v0.2.30.71: img 放回 wrapper 直接子元素 (listening/speaking 状态显示)
      // vortex wrap 单独嵌套 (thinking 状态显示, 内部 .ccw-avatar 装 img)
      // 之前 v0.2.30.60-70: img 嵌套在 .ccw-avatar 里, vortex wrap 改 absolute 居中但 absolute 参照父级错
      // 跑到 .voice-call-avatar-area 去了, 跟 wrapper 内的 img 错位 80px (用户截图反馈)
      // 修法: wrapper 顶端直接 img + vortex wrap 单独嵌套含 .ccw-avatar img
      // listening/speaking: wrapper 直接 img 显示, vortex display:none
      // thinking: wrapper 直接 img 隐藏, vortex display:flex (内含 .ccw-avatar img 跟漩涡流光叠)
      // 两份 img 用同一 src, 浏览器缓存复用, 网络无压力
      wrapper.innerHTML = `
        <img src="${p.avatar}" class="participant-avatar" alt="${displayName}">
        <div class="ccw-vortex-wrap">
          <div class="ccw-layer">
            <div class="ccw-glow-base"></div>
            <div class="ccw-inner-light"></div>
            <svg class="ccw-svg" viewBox="0 0 148 148">
              <defs>
                <linearGradient id="voice-call-soft-gold-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#FFFDF0" stop-opacity="0.72"/>
                  <stop offset="18%" stop-color="#FFF0AD" stop-opacity="0.60"/>
                  <stop offset="35%" stop-color="#FFD66A" stop-opacity="0.48"/>
                  <stop offset="55%" stop-color="#FFB52E" stop-opacity="0.30"/>
                  <stop offset="80%" stop-color="#F28A18" stop-opacity="0.10"/>
                  <stop offset="100%" stop-color="#E85B00" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <g class="ccw-soft-halo" stroke="url(#voice-call-soft-gold-gradient)" fill="none" stroke-linecap="round" stroke-width="7">
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(0 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(60 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(120 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(180 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(240 74 74)"/>
                <path d="M74 23 C56 22 38 29 25 44 C17 53 12 61 8 69" transform="rotate(300 74 74)"/>
              </g>
              <g class="ccw-soft-streak" stroke="url(#voice-call-soft-gold-gradient)" fill="none" stroke-linecap="round" stroke-width="4">
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(0 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(60 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(120 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(180 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(240 74 74)"/>
                <path d="M74 24 C57 23 40 30 27 44 C19 52 14 59 10 66" transform="rotate(300 74 74)"/>
              </g>
            </svg>
          </div>
          <div class="ccw-avatar">
            <img src="${p.avatar}" class="participant-avatar" alt="${displayName}">
          </div>
        </div>
      `;
      grid.appendChild(wrapper);
    });
  }

  function handleUserJoinVoiceCall() {
    if (!voiceCallState.isActive || voiceCallState.isUserParticipating) return;

    voiceCallState.isUserParticipating = true;
    updateVoiceParticipantAvatars();

    hideVoiceCallManualMicButton();
    document.getElementById('voice-join-call-btn').style.display = 'none';

    triggerAiInVoiceCallAction("[系统提示：用户加入了通话]");
  }

  function updateVoiceCallTimer() {
    if (!voiceCallState.isActive) return;
    const elapsed = Math.floor((Date.now() - voiceCallState.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    document.getElementById('voice-call-timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // 立即停止语音通话等待背景音乐（"启用音频"按钮播放的 call-waiting.mp3）
  // 在 AI 文字出现的第一时间硬停止，避免淡出造成的延迟
  // v0.2.30.52: 修 "通话接通后彩铃按钮没消失" — 之前 if (!window.voiceCallBgAudio) return 早返回, 没用过"启用音频"按钮 (没创建 bgAudio) 时根本走不到隐藏按钮那行
  // 改成"先隐藏按钮, 再停止音频"解耦 — 通话接通按钮就该消失, 跟彩铃有没有在播无关
  function stopVoiceCallWaitingMusic(reason = '') {
    // 1. 先隐藏彩铃按钮 — 不管彩铃有没有在播, AI 文字出现 = 通话已开始, 按钮历史使命完成
    setVoiceCallAudioUnlockBtnVisibility(false);

    // 2. 再尝试停止彩铃音频 (没创建过 bgAudio 就跳过)
    if (!window.voiceCallBgAudio) return;
    try {
      window.voiceCallBgAudio.pause();
      window.voiceCallBgAudio.currentTime = 0;
    } catch (e) {
      console.warn('[Audio] 停止背景音乐失败:', e);
    }
    window.voiceCallBgAudio = null;
    console.log('[Audio] AI 文字出现，立即停止背景音乐' + (reason ? ` (${reason})` : ''));
  }

  async function triggerAiInVoiceCallAction(userInput = null) {
    if (!voiceCallState.isActive || voiceCallState.isAiResponding) return;

    stopVoiceCallAutoListening(false, 'ai-start');
    voiceCallState.isAiResponding = true;
    voiceCallState.isAiSpeaking = false;
    voiceCallState.isTtsPlaying = false;
    voiceCallState.canUserSpeak = false;
    setVoiceCallStatusText('思考中');
    // v0.2.30.56: 过渡动画 — listening → 光斑从挂断键飞 → thinking
    // v0.2.30.68 改 animation 0.5s → 0.7s, v0.2.30.71 setTimeout 0.5s → 0.7s 跟 animation 匹配
    // 之前 500ms < 0.7s animation — 过渡没飞完就切到 thinking, vortex wrap + transitioning ::before 叠在一起看着"光晕占据"
    setVoiceCallGlowState('transitioning');
    setTimeout(() => {
      setVoiceCallGlowState('thinking');
    }, 700);

    const chat = state.chats[voiceCallState.activeChatId];
    // 与主聊天保持一致：实时通过 resolveApiSlotConfig 解析主 API 配置，
    // 否则 state.apiConfig 在使用预设引用 / 切换预设 / 角色独立配置时可能为空或过期，
    // 导致代理 baseUrl 非法、通话接不通
    let { proxyUrl, apiKey, model, isGemini, geminiSafetySettings } = state.apiConfig;

    if (typeof window.resolveApiSlotConfig === 'function') {
      const resolvedConfig = await window.resolveApiSlotConfig('main', {
        apiOverride: chat.apiOverride, // Use chat-specific override
        character: state.character,
      });
      if (resolvedConfig) {
        // Use a new object to avoid modifying the original resolvedConfig
        const config = { ...resolvedConfig };
        proxyUrl = config.proxyUrl;
        apiKey = config.apiKey;
        model = config.model;
        isGemini = config.isGemini;
        geminiSafetySettings = config.geminiSafetySettings;
      }
    }

    // 兜底: resolveApiSlotConfig 不返回 isGemini, 上面赋值后是 undefined
    // 用 proxyUrl 重新判断, 跟主聊天 / 群聊 / cphone 保持一致
    if (!isGemini && proxyUrl) {
      isGemini = proxyUrl.includes('generativelanguage');
    }

    if (!proxyUrl || !apiKey || !model) {
      console.error('Voice Call failed: API config not resolved.', { proxyUrl, apiKey, model });
      const callFeed = document.getElementById('voice-call-main');
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: API configuration is missing or incomplete.]`;
      if(callFeed) callFeed.appendChild(errorBubble);
      onVoiceCallTtsQueueFinished(); // Ensure state is cleaned up
      return;
    }
    const callFeed = document.getElementById('voice-call-main');
    const userNickname = chat.settings.myNickname || '我';

    let worldBookContent = '';
    let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
    state.worldBooks.forEach(wb => {
      if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
        allWorldBookIds.push(wb.id);
      }
    });

    if (allWorldBookIds.length > 0) {
      const linkedContents = allWorldBookIds.map(bookId => {
        const worldBook = state.worldBooks.find(wb => wb.id === bookId);
        return worldBook && worldBook.content ? `\n\n## 世界书: ${worldBook.name}\n${worldBook.content}` : '';
      }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
      }
    }
    let longTermMemoryContent = '';
    const memMode = chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary');
    if (memMode === 'vector' && window.vectorMemoryManager) {
      longTermMemoryContent = window.vectorMemoryManager.serializeCoreMemories(chat);
    } else if (memMode === 'structured' && window.structuredMemoryManager) {
      longTermMemoryContent = window.structuredMemoryManager.serializeForPrompt(chat);
    } else if (chat.longTermMemory && chat.longTermMemory.length > 0) {
      longTermMemoryContent = chat.longTermMemory.map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
    }
    const longTermMemoryContext = longTermMemoryContent ? `\n# 长期记忆 (必须参考)\n${longTermMemoryContent}` : '';

    // ★ 时间感知：跟主聊天走（enableTimePerception / 自定义时间 / 时区）
    const timeContextText = (() => {
      if (!chat.settings.enableTimePerception) return '';
      const now = new Date();
      const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;
      const customTimeEnabled = customTimeInfo && customTimeInfo.enabled;
      let currentTime, localizedDate;
      if (customTimeEnabled) {
        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekDay = weekDays[customTimeInfo.date.getDay()];
        currentTime = `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
        localizedDate = customTimeInfo.date;
      } else {
        const selectedTimeZone = chat.settings.timeZone || 'Asia/Shanghai';
        currentTime = now.toLocaleString('zh-CN', { timeZone: selectedTimeZone, dateStyle: 'full', timeStyle: 'short' });
        localizedDate = new Date(now.toLocaleString('en-US', { timeZone: selectedTimeZone }));
      }
      const timeOfDayGreeting = typeof window.getTimeOfDayGreeting === 'function' ? window.getTimeOfDayGreeting(localizedDate) : '';
      return `- **当前时间**: ${currentTime} (${timeOfDayGreeting})`;
    })();
    const timeContextBlock = timeContextText ? `\n# 当前时间\n${timeContextText}` : '';

    if (userInput && voiceCallState.isUserParticipating) {
      const userTimestamp = Date.now();
      // ⚠️ callIdleNudgeActive: 见视频通话同名注释 —— 主动接话不产生用户气泡 / 不入 callHistory
      if (!callIdleNudgeActive) {
      const userBubble = document.createElement('div');
      userBubble.className = 'call-message-bubble user-speech';
      userBubble.textContent = userInput;
      userBubble.dataset.timestamp = userTimestamp;
      addLongPressListener(userBubble, () => showCallMessageActions(userTimestamp));
      callFeed.appendChild(userBubble);
      callFeed.scrollTop = callFeed.scrollHeight;

      voiceCallState.callHistory.push({
        role: 'user',
        content: userInput,
        timestamp: userTimestamp
      });
      }   // ← 关闭 !callIdleNudgeActive
    }

    let inCallPrompt;
    if (voiceCallState.isGroupCall) {
      const participantNames = voiceCallState.participants.map(p => p.name);
      if (voiceCallState.isUserParticipating) {
        participantNames.unshift(userNickname);
      }
      inCallPrompt = `
# 你的任务
你是一个群聊语音通话的导演。你的任务是扮演所有【除了用户以外】的AI角色，并生成他们在通话中说的话。

# 【核心规则 - 语音通话专用】
1. **【身份铁律】**: 用户的身份是【${userNickname}】。你【绝对不能】生成 \`name\` 字段为 **"${userNickname}"** 的发言。
2. **【纯对话铁律】**: 这是语音通话，不是视频通话。你们只能听到声音，看不到对方。因此：
   - 你的回复【只能包含角色说的话】
   - 【绝对禁止】任何动作描写（如：*笑了笑*、*点头*、*挥手*等）
   - 【绝对禁止】任何表情符号（如：😊、❤️等）
   - 【绝对禁止】任何视觉相关的描述（如：看起来、表情、动作等）
3. **格式**: 你的回复【必须】是一个JSON数组，每个对象代表一个角色的发言，格式为：\`{"name": "角色名", "speech": "大家好啊！"}\`。
4. **角色扮演**: 严格遵守每个角色的设定。

# 当前情景
你们正在一个群语音通话中。你们只能通过声音交流，看不到彼此。
${longTermMemoryContext}
**通话前的聊天摘要**:
${voiceCallState.preCallContext}
**当前参与者**: ${participantNames.join('、 ')}。
**通话刚刚开始...**
${worldBookContent}${timeContextBlock}
现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。记住：只输出对话内容，不要有任何动作或表情描写。
`;
    } else {
      let openingContext = voiceCallState.initiator === 'user' ?
        `你刚刚接听了用户的语音通话请求。` :
        `用户刚刚接听了你主动发起的语音通话。`;
      // 第二阶段: 语音控制段落 (与视频通话共用同一个构建器, 不另写一份)
      const voiceCallTtsBlock = buildVideoCallTtsExpressionPromptBlock(chat);
      inCallPrompt = `
# 你的任务
你现在正在和用户进行语音通话。你扮演 ${chat.name} (${chat.settings.aiPersona})。

# 【核心规则 - 语音通话专用】
1. **【纯对话铁律】**: 这是语音通话，不是视频通话。你们只能听到声音，看不到对方。因此：
   - 你的回复【只能包含你说的话】
   - 【绝对禁止】任何动作描写（如：*笑了笑*、*点头*、*挥手*、*看着你*等）
   - 【绝对禁止】任何表情符号（如：😊、❤️、😂等）
   - 【绝对禁止】任何视觉相关的描述（如：看起来、表情、眼神、动作等）
   - 【绝对禁止】使用星号*或其他符号来描述动作
2. **【角色认知】**: 你知道这是语音通话，你看不到用户，用户也看不到你。你们只能通过声音交流。
3. **【多句发言】**: 你可以一次说多句话，每句话会显示为独立的气泡。格式：
   - 如果只说一句话：直接返回纯文本，如 "喂，你好啊！"
   - 如果要说多句话：返回JSON数组，如 [{"type": "text", "content": "喂，你好啊！"}, {"type": "text", "content": "最近怎么样？"}]
4. **格式灵活性**: 你可以根据情况选择单句（纯文本）或多句（JSON数组）格式。

# 当前情景
你正在和用户（${userNickname}，人设: ${chat.settings.myPersona}）进行语音通话。你们只能通过声音交流，看不到彼此。
${longTermMemoryContext}${timeContextBlock}
**${openingContext}**
**通话前的聊天摘要 (这是你们通话的原因，至关重要！)**:
${voiceCallState.preCallContext}
${worldBookContent}
现在，请根据【通话前摘要】和下面的【通话实时记录】，继续进行对话。记住：只输出对话内容，不要有任何动作、表情或视觉描写。
【唯一允许的控制符号】是下面【语音控制】里那一种 [[语音:emotion]] 标签 (不会被朗读, 界面上也不会显示), 除它以外任何方括号标记都不许出现。
${voiceCallTtsBlock}
`;
    }

    const messagesForApi = [{
      role: 'system',
      content: inCallPrompt
    },
    ...voiceCallState.callHistory.map(h => ({
      role: h.role,
      content: h.content
    }))
    ];

    if (voiceCallState.callHistory.length === 0 && !callIdleNudgeActive) {
      const firstLineTrigger = voiceCallState.initiator === 'user' ? `喂？` : `喂，你好？`;
      messagesForApi.push({
        role: 'user',
        content: firstLineTrigger
      });
    }

    // 沉默主动接话: 同视频通话, 只临时加一句, 不写进 callHistory
    if (callIdleNudgeActive && callIdleNudgeText) {
      messagesForApi.push({ role: 'user', content: callIdleNudgeText });
    }

    try {
      // let isGemini = proxyUrl === GEMINI_API_URL; // isGemini is now resolved from config
      let geminiConfig = toGeminiRequestData(model, apiKey, inCallPrompt, messagesForApi)
      const callPayload = {
        model: model,
        messages: messagesForApi,
        temperature: state.globalSettings.apiTemperature || 0.8,
        top_p: state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0,
        presence_penalty: state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0,
        frequency_penalty: state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0
      };
      // 当”主API代理”开启时，与主聊天保持一致，走后端代理转发，否则直连会因渠道仅支持后端代理而无法接通
      const useMainApiProxy = !isGemini
        && typeof window.fetchViaOpenAICompatibleProxy === 'function'
        && typeof window.isMainApiProxyEnabled === 'function'
        && window.isMainApiProxyEnabled();
      const response = isGemini
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : useMainApiProxy
          ? await window.fetchViaOpenAICompatibleProxy({
            baseUrl: proxyUrl,
            targetPath: '/chat/completions',
            apiKey,
            payload: callPayload,
            method: 'POST'
          })
          : await fetch(`${proxyUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(callPayload)
          });
      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (e) {
        data = null;
      }

      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        if (data) {
          errMsg = data?.error?.message || data?.message || data?.detail || JSON.stringify(data);
        } else if (rawText) {
          errMsg = rawText;
        } else if (response.statusText) {
          errMsg += ` (${response.statusText})`;
        }
        throw new Error(errMsg);
      }

      if (!data) {
        throw new Error('API 响应不是有效 JSON');
      }

      const rawAiResponse = isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content;
      const aiResponse = cleanMinimaxCallResponse(rawAiResponse, { provider: proxyUrl, model });

      const connectingElement = callFeed.querySelector('em');
      if (connectingElement) connectingElement.remove();

      // AI 文字即将出现：在第一时间立即停止等待背景音乐（覆盖单聊 / 群聊两种分支）
      stopVoiceCallWaitingMusic('ai-text-rendered');

      let hasVoiceCallTtsPlayback = false;

      if (voiceCallState.isGroupCall) {
        const speechArray = parseAiResponse(aiResponse);
        const enableTts = chat.settings.enableTts !== false;
        const voiceId = chat.settings.minimaxVoiceId;
        const voiceConfig = getActiveCallVoiceConfig(chat);
        speechArray.forEach(turn => {
          const displayText = `${turn.name || ''}: ${turn.speech || ''}`.trim();
          if (!turn.name || turn.name === userNickname || !displayText) return;
          const aiTimestamp = Date.now() + Math.random();
          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          aiBubble.textContent = stripCallDisplayText(displayText);
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);
          voiceCallState.callHistory.push({
            role: 'assistant',
            content: displayText,
            timestamp: aiTimestamp
          });

          logVoiceCallDiag('VOICE_CALL_DISPLAY_TEXT_READY', {
            textLength: displayText.length,
            hasVoiceId: Boolean(voiceId)
          });
          if (enqueueVoiceCallDisplayTextTts(displayText, voiceId, voiceConfig)) {
            hasVoiceCallTtsPlayback = true;
          }

          const speaker = voiceCallState.participants.find(p => p.name === turn.name);
          if (speaker) {
            const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="${speaker.id}"] .participant-avatar`);
            if (speakingAvatar) {
              speakingAvatar.classList.add('speaking');
              setTimeout(() => speakingAvatar.classList.remove('speaking'), 2000);
            }
          }
        });
      } else {
        // 单聊模式：支持多条消息
        const voiceId = chat.settings.minimaxVoiceId;
        const voiceConfig = getActiveCallVoiceConfig(chat);

        // ⚠️ [[语音:happy]] 标签【原样保留】在这里: 气泡、callHistory 全部拿带标签的原文。
        //   剥离只发生在 tts-audio.js 真正发 MiniMax 的那一刻。
        // 尝试解析为JSON数组（多条消息）
        const messagesArray = parseAiResponse(aiResponse);

        messagesArray.forEach((msg, index) => {
          const displayText = String(msg.content || msg.speech || aiResponse || '').trim();
          if (!displayText) {
            logVoiceCallDiag('VOICE_CALL_TTS_ENQUEUE_SKIP', {
              textLength: 0,
              skipReason: 'emptyDisplayText',
              hasVoiceId: Boolean(voiceId)
            });
            return;
          }
          const aiTimestamp = Date.now() + index;

          const aiBubble = document.createElement('div');
          aiBubble.className = 'call-message-bubble ai-speech';
          aiBubble.textContent = stripCallDisplayText(displayText);
          aiBubble.dataset.timestamp = aiTimestamp;
          addLongPressListener(aiBubble, () => showCallMessageActions(aiTimestamp));
          callFeed.appendChild(aiBubble);

          voiceCallState.callHistory.push({
            role: 'assistant',
            content: displayText,
            timestamp: aiTimestamp
          });

          logVoiceCallDiag('VOICE_CALL_DISPLAY_TEXT_READY', {
            textLength: displayText.length,
            hasVoiceId: Boolean(voiceId)
          });
          if (enqueueVoiceCallDisplayTextTts(displayText, voiceId, voiceConfig)) {
            hasVoiceCallTtsPlayback = true;
          }
        });

        const speakingAvatar = document.querySelector(`.participant-avatar-wrapper[data-participant-id="ai"] .participant-avatar`);
        if (speakingAvatar) {
          speakingAvatar.classList.add('speaking');
          const totalLength = messagesArray.reduce((sum, msg) => sum + String(msg.content || msg.speech || aiResponse || '').trim().length, 0);
          const speakTime = Math.min(totalLength * 200, 5000);
          setTimeout(() => speakingAvatar.classList.remove('speaking'), speakTime);
        }
      }

      callFeed.scrollTop = callFeed.scrollHeight;

      if (!hasVoiceCallTtsPlayback) {
        // v0.2.30.25: AI 没 TTS 输出 (无语音) → 保持"思考中" 1.5 秒让用户感知 AI 处理过了
        // 1.5 秒后再切 idle + 启动 autoListen, 不让用户感觉"AI 没说话就直接让说"
        setVoiceCallGlowState('thinking');
        setVoiceCallStatusText('思考中');
        setTimeout(() => {
          onVoiceCallTtsQueueFinished();
        }, 1500);
      }

    } catch (error) {
      const errorBubble = document.createElement('div');
      errorBubble.className = 'call-message-bubble ai-speech';
      errorBubble.style.color = '#ff8a80';
      errorBubble.textContent = `[ERROR: ${error.message}]`;
      callFeed.appendChild(errorBubble);
      callFeed.scrollTop = callFeed.scrollHeight;
      // ⚠️⚠️ 语音侧原来【根本没有】把错误写到可见的提示文字上 (视频侧有)。
      //   错误气泡在 #voice-call-main 里, 那个容器被 display:none !important 隐藏,
      //   于是语音通话出错时用户只感觉"AI 突然不说话了", 拿不到任何原因。
      //   这里补上 + 4 秒停留期, 否则紧接着的 onVoiceCallTtsQueueFinished
      //   → startVoiceCallAutoListening → 「倾听中」会同步覆盖掉。
      setVoiceCallStatusText('出错了：' + error.message, { holdMs: CALL_STATUS_ERROR_HOLD_MS });
      voiceCallState.callHistory.push({
        role: 'assistant',
        content: `[ERROR: ${error.message}]`
      });
      stopVoiceCallWaitingMusic('error');
      onVoiceCallTtsQueueFinished();
    }
    // ★ 每次发送后修剪历史
    trimCallHistory(voiceCallState);
  }

  // ==================== 语音通话功能结束 ====================





  async function handleUserPat(chatId, characterOriginalName) {
    const chat = state.chats[chatId];
    if (!chat) return;


    let displayNameForUI;
    if (chat.isGroup) {

      displayNameForUI = getDisplayNameInGroup(chat, characterOriginalName);
    } else {

      displayNameForUI = chat.name;
    }

    const phoneScreen = document.getElementById('phone-screen');
    phoneScreen.classList.remove('pat-animation');
    void phoneScreen.offsetWidth;
    phoneScreen.classList.add('pat-animation');


    const suffix = await showCustomPrompt(
      `你拍了拍 "${displayNameForUI}"`,
      "（可选）输入后缀",
      "",
      "text"
    );

    if (suffix === null) return;

    // 获取用户昵称，如果是 {{user}} 则使用 "你"
    let myNickname = state.qzoneSettings.nickname;
    if (!myNickname || myNickname === '{{user}}') {
      myNickname = '你';
    }

    // 如果是群聊，使用群昵称
    if (chat.isGroup) {
      myNickname = chat.settings.myNickname || '你';
    }



    const visibleMessageContent = `${myNickname} 拍了拍 "${displayNameForUI}" ${suffix.trim()}`;
    const visibleMessage = {
      role: 'system',
      type: 'pat_message',
      content: visibleMessageContent,
      timestamp: Date.now()
    };
    chat.history.push(visibleMessage);


    const hiddenMessageContent = `[系统提示：用户（${myNickname}）刚刚拍了拍你（${characterOriginalName}）${suffix.trim()}。请你对此作出回应。]`;
    const hiddenMessage = {
      role: 'system',
      content: hiddenMessageContent,
      timestamp: Date.now() + 1,
      isHidden: true
    };
    chat.history.push(hiddenMessage);

    await db.chats.put(chat);
    if (state.activeChatId === chatId) {
      appendMessage(visibleMessage, chat);
    }
    await renderChatList();
  }

  // 新增：处理用户拍自己的功能
  async function handleUserPatSelf(chatId) {
    const chat = state.chats[chatId];
    if (!chat) return;

    const phoneScreen = document.getElementById('phone-screen');
    phoneScreen.classList.remove('pat-animation');
    void phoneScreen.offsetWidth;
    phoneScreen.classList.add('pat-animation');

    // 获取用户昵称，如果是 {{user}} 则使用 "你"
    let myNickname = state.qzoneSettings.nickname;
    if (!myNickname || myNickname === '{{user}}') {
      myNickname = '你';
    }

    // 如果是群聊，使用群昵称
    if (chat.isGroup) {
      myNickname = chat.settings.myNickname || '你';
    }

    // 弹出输入框让用户输入拍自己的后缀
    const suffix = await showCustomPrompt(
      `${myNickname} 拍了拍自己`,
      "输入拍一拍后缀",
      "",
      "text"
    );

    if (suffix === null) return;

    // 创建可见的拍一拍消息
    const visibleMessageContent = `${myNickname} 拍了拍自己 ${suffix.trim()}`;
    const visibleMessage = {
      role: 'system',
      type: 'pat_message',
      content: visibleMessageContent,
      timestamp: Date.now()
    };
    chat.history.push(visibleMessage);

    // 创建隐藏的系统提示，让AI知道用户拍了自己
    const hiddenMessageContent = `[系统提示：用户（${myNickname}）刚刚拍了拍自己${suffix.trim()}。你可以对此作出回应或评论。]`;
    const hiddenMessage = {
      role: 'system',
      content: hiddenMessageContent,
      timestamp: Date.now() + 1,
      isHidden: true
    };
    chat.history.push(hiddenMessage);

    await db.chats.put(chat);
    if (state.activeChatId === chatId) {
      appendMessage(visibleMessage, chat);
    }
    await renderChatList();
  }

  let activeCallMessageTimestamp = null;
  let isFrameManagementMode = false;
  let selectedFrames = new Set();

  function showCallMessageActions(timestamp) {
    activeCallMessageTimestamp = timestamp;
    document.getElementById('call-message-actions-modal').classList.add('visible');
  }


  function hideCallMessageActions() {
    document.getElementById('call-message-actions-modal').classList.remove('visible');
    activeCallMessageTimestamp = null;
  }


  async function openCallMessageEditor() {
    if (!activeCallMessageTimestamp) return;

    const timestampToEdit = activeCallMessageTimestamp;
    
    // 判断当前是视频通话还是语音通话
    const isVideoCall = videoCallState.isActive || document.getElementById('video-call-screen').classList.contains('active');
    const currentCallState = isVideoCall ? videoCallState : voiceCallState;
    
    const message = currentCallState.callHistory.find(m => m.timestamp === timestampToEdit);
    if (!message) return;

    hideCallMessageActions();

    let contentForEditing = message.content;

    if (currentCallState.isGroupCall && message.role === 'assistant') {
      const parts = message.content.split(': ');
      if (parts.length > 1) {
        contentForEditing = parts.slice(1).join(': ');
      }
    }

    const newContent = await showCustomPrompt(
      '编辑通话消息',
      '在此修改内容...',
      contentForEditing,
      'textarea'
    );

    if (newContent !== null) {
      await saveEditedCallMessage(timestampToEdit, newContent, isVideoCall);
    }
  }


  async function saveEditedCallMessage(timestamp, newContent, isVideoCall = true) {
    const currentCallState = isVideoCall ? videoCallState : voiceCallState;
    const message = currentCallState.callHistory.find(m => m.timestamp === timestamp);
    
    if (message) {
      let finalContent = newContent;

      if (currentCallState.isGroupCall && message.role === 'assistant') {
        const parts = message.content.split(': ');
        const senderName = parts[0];
        finalContent = `${senderName}: ${newContent}`;
      }
      message.content = finalContent;

      const messageBubble = document.querySelector(`.call-message-bubble[data-timestamp="${timestamp}"]`);
      if (messageBubble) {
        if (currentCallState.isGroupCall && message.role === 'assistant') {
          const parts = message.content.split(': ');
          const senderName = parts[0];
          messageBubble.innerHTML = `<strong>${senderName}:</strong> ${newContent}`;
        } else {
          messageBubble.textContent = newContent;
        }
      }
    }
    await showCustomAlert('成功', '通话消息已更新！');
  }


  async function deleteCallMessage() {
    if (!activeCallMessageTimestamp) return;

    const confirmed = await showCustomConfirm('删除消息', '确定要删除这条通话消息吗？', {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      const timestampToDelete = activeCallMessageTimestamp;
      hideCallMessageActions();

      // 判断当前是视频通话还是语音通话
      const isVideoCall = videoCallState.isActive || document.getElementById('video-call-screen').classList.contains('active');
      const currentCallState = isVideoCall ? videoCallState : voiceCallState;

      const messageIndex = currentCallState.callHistory.findIndex(m => m.timestamp === timestampToDelete);
      if (messageIndex > -1) {
        currentCallState.callHistory.splice(messageIndex, 1);
      }

      const messageBubble = document.querySelector(`.call-message-bubble[data-timestamp="${timestampToDelete}"]`);
      if (messageBubble) {
        messageBubble.remove();
      }
    } else {
      hideCallMessageActions();
    }
  }


  // ========== 导出到全局作用域 ==========
  window.videoCallState = videoCallState;
  window.voiceCallState = voiceCallState;
  window.handleInitiateCall = handleInitiateCall;
  window.startVideoCall = startVideoCall;
  window.minimizeVideoCall = minimizeVideoCall;
  window.restoreVideoCall = restoreVideoCall;
  window.endVideoCall = endVideoCall;
  window.updateParticipantAvatars = updateParticipantAvatars;
  window.handleUserJoinCall = handleUserJoinCall;
  window.updateCallTimer = updateCallTimer;
  window.handleVideoCallUserSpeak = handleVideoCallUserSpeak;
  window.showIncomingCallModal = showIncomingCallModal;
  window.hideIncomingCallModal = hideIncomingCallModal;
  window.triggerAiInCallAction = triggerAiInCallAction;
  window.onVideoCallTtsQueueFinished = onVideoCallTtsQueueFinished;
  window.toggleCallButtons = toggleCallButtons;
  window.handleInitiateVoiceCall = handleInitiateVoiceCall;
  window.startVoiceCall = startVoiceCall;
  window.minimizeVoiceCall = minimizeVoiceCall;
  window.restoreVoiceCall = restoreVoiceCall;
  window.endVoiceCall = endVoiceCall;
  window.updateVoiceParticipantAvatars = updateVoiceParticipantAvatars;
  window.handleUserJoinVoiceCall = handleUserJoinVoiceCall;
  window.updateVoiceCallTimer = updateVoiceCallTimer;
  window.handleVoiceCallUserSpeak = handleVoiceCallUserSpeak;
  window.triggerAiInVoiceCallAction = triggerAiInVoiceCallAction;
  window.onVoiceCallTtsQueueFinished = onVoiceCallTtsQueueFinished;
  window.handleUserPat = handleUserPat;
  window.handleUserPatSelf = handleUserPatSelf;
  window.showCallMessageActions = showCallMessageActions;
  window.hideCallMessageActions = hideCallMessageActions;
  window.openCallMessageEditor = openCallMessageEditor;
  window.saveEditedCallMessage = saveEditedCallMessage;
  window.deleteCallMessage = deleteCallMessage;
  window.isFrameManagementMode = isFrameManagementMode;
  window.selectedFrames = selectedFrames;

  // --- 启用音频按钮功能 ---
  // 辅助: 控制"启用音频"按钮的显示/重置状态
  // - 彩铃停止(AI 文字出现)后隐藏 — 任务完成, 按钮完成使命
  // - 挂断/下次通话开始时显示并重置回 unlock-inactive
  function setVoiceCallAudioUnlockBtnVisibility(visible) {
    const btn = document.querySelector('#voice-regenerate-call-btn');
    if (!btn) return;
    if (visible) {
      btn.style.display = '';
      // 重置回 unlock-inactive (防御: 挂断后按钮可能停在 connected)
      btn.classList.remove('unlock-loading', 'unlock-connected');
      btn.classList.add('unlock-inactive');
      btn.textContent = '启用音频';
    } else {
      btn.style.display = 'none';
    }
  }

  function setupVoiceCallAudioUnlock() {
    const unlockBtn = document.querySelector('#voice-regenerate-call-btn');

    if (!unlockBtn) {
      // 按钮可能还未渲染，稍后重试
      setTimeout(setupVoiceCallAudioUnlock, 500);
      return;
    }

    // 避免重复绑定
    if (unlockBtn.dataset.audioUnlockBound) {
      return;
    }
    unlockBtn.dataset.audioUnlockBound = 'true';

    unlockBtn.addEventListener('click', function handleVoiceCallAudioUnlock() {
      // [防叠加] 已有 bgAudio 且在播 → 直接 return, 不创建新实例
      // 防止用户多次点击导致多个 Audio 实例同时播放谁也停不下来
      if (window.voiceCallBgAudio && !window.voiceCallBgAudio.paused) {
        console.log('[Audio] 彩铃已在播放, 忽略重复点击');
        return;
      }

      // 防重复点击
      if (window.isVoiceCallAudioUnlocking) {
        console.log('[Audio] 正在激活中,请勿重复点击');
        return;
      }
      window.isVoiceCallAudioUnlocking = true;
      
      // 切换到加载状态
      unlockBtn.classList.remove('unlock-inactive');
      unlockBtn.classList.add('unlock-loading');
      unlockBtn.textContent = '连接中…';
      
      // 复用或创建 bgAudio — 只有第一次才 new, 后续失败清理后下次重试也是新的
      let bgAudio = window.voiceCallBgAudio;
      if (!bgAudio) {
        bgAudio = new Audio('assets/audio/call-waiting.mp3');
        bgAudio.loop = true;
        bgAudio.volume = 0.25;
        // 立即记下, 防止并发点击再 new 一个
        window.voiceCallBgAudio = bgAudio;
      }
      
      bgAudio.play()
        .then(() => {
          console.log('[Audio] 背景音乐播放成功');
          
          // [iOS 授权] 在 user gesture 内建一个共享 AudioContext 并 resume
          // iOS 14+ 上已 resume 的 AudioContext 会被认为"已授权",
          // 后续的 BufferSourceNode 播放不会被 user gesture 链限制
          try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass && !window.voiceCallSharedAudioContext) {
              window.voiceCallSharedAudioContext = new AudioContextClass();
              console.log('[Audio] 已建共享 AudioContext, state=', window.voiceCallSharedAudioContext.state);
            }
            if (window.voiceCallSharedAudioContext && window.voiceCallSharedAudioContext.state === 'suspended') {
              window.voiceCallSharedAudioContext.resume().then(() => {
                console.log('[Audio] 共享 AudioContext 已 resume, state=', window.voiceCallSharedAudioContext.state);
              }).catch(err => {
                console.warn('[Audio] 共享 AudioContext resume 失败:', err);
              });
            }
          } catch (audioCtxErr) {
            console.warn('[Audio] 共享 AudioContext 初始化失败(将回退到 <audio> 路径):', audioCtxErr);
          }
          
          // 切换到已连接状态
          unlockBtn.classList.remove('unlock-loading');
          unlockBtn.classList.add('unlock-connected');
          unlockBtn.textContent = '已连接';
          
          // 释放状态锁
          window.isVoiceCallAudioUnlocking = false;
        })
        .catch(err => {
          console.error('[Audio] 背景音乐播放失败:', err);
          
          // 失败清理: 允许下次点击重试 (创建新 bgAudio)
          if (window.voiceCallBgAudio === bgAudio) {
            try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) { /* ignore */ }
            window.voiceCallBgAudio = null;
          }
          
          // 切换回初始状态
          unlockBtn.classList.remove('unlock-loading');
          unlockBtn.classList.add('unlock-inactive');
          unlockBtn.textContent = '启用音频';
          
          // 释放状态锁
          window.isVoiceCallAudioUnlocking = false;
        });
    });
  }

  // 由于按钮是动态添加到页面的，我们需要在合适的时机去绑定事件
  // startVoiceCall 是语音通话界面的入口函数，是绑定事件的好时机
  // 但为了不修改原函数，我们采用监听 DOM 变化或定时器的方式
  // 这里用一个简单的定时器来查找并绑定按钮
  // 同时，在 startVoiceCall 内部调用此函数可以更精确，但会违反“不修改函数”的约束
  // 因此，在脚本加载时就开始尝试绑定
  setupVoiceCallAudioUnlock();
  // --- 启用音频按钮功能结束 ---

  // === 视频通话启用音频按钮功能 ===
  // 原则: 跟语音通话完全一致的彩铃机制 — 同一份 call-waiting.mp3, 同一个共享 AudioContext
  //       不动语音通话的 setVoiceCallAudioUnlockBtnVisibility / setupVoiceCallAudioUnlock / stopVoiceCallWaitingMusic
  //       复用 window.voiceCallBgAudio (同一个 Audio 实例) + window.voiceCallSharedAudioContext (同一个共享 ctx)
  //       只是按钮的 DOM 节点 (id) 跟语音通话不同, CSS class 跟 setVisibility 逻辑是独立的
  const VIDEO_AUDIO_UNLOCK_SELECTOR = '#video-audio-unlock-btn';
  const VIDEO_AUDIO_UNLOCK_AUDIO_URL = 'assets/audio/call-waiting.mp3'; // 跟语音通话完全相同

  // 辅助: 重置视频通话"启用音频"按钮的外观 (回到 unlock-inactive 初始态)
  // v0.5.0 P25: 按钮 DOM 在呼叫等待页 (#outgoing-call-screen) 内部, 显隐由屏幕自己管 —
  // 这里只负责"进等待页时把上一次留下的 已连接/连接中 状态清掉", 不再碰 display。
  function resetVideoCallAudioUnlockBtn() {
    const btn = document.querySelector(VIDEO_AUDIO_UNLOCK_SELECTOR);
    if (!btn) return;
    btn.classList.remove('unlock-loading', 'unlock-connected');
    btn.classList.add('unlock-inactive');
    btn.textContent = '启用音频';
  }

  // 视频通话彩铃 click handler — 与语音通话 setupVoiceCallAudioUnlock 完全等价
  // 区别:
  //   - 操作不同的按钮 (#video-audio-unlock-btn vs #voice-regenerate-call-btn)
  //   - 复用同一个 window.voiceCallBgAudio / window.voiceCallSharedAudioContext / 同一份音频 URL
  //   - 复用同一个 window.isVoiceCallAudioUnlocking 状态锁, 防止语音/视频并发激活
  function setupVideoCallAudioUnlock() {
    const unlockBtn = document.querySelector(VIDEO_AUDIO_UNLOCK_SELECTOR);

    if (!unlockBtn) {
      // 按钮可能还未渲染，稍后重试
      setTimeout(setupVideoCallAudioUnlock, 500);
      return;
    }

    // 避免重复绑定
    if (unlockBtn.dataset.audioUnlockBound) {
      return;
    }
    unlockBtn.dataset.audioUnlockBound = 'true';

    unlockBtn.addEventListener('click', function handleVideoCallAudioUnlock() {
      // [防叠加] 已有 bgAudio 且在播 → 直接 return, 不创建新实例
      // 防止用户多次点击 / 语音视频交替点击导致多个 Audio 实例同时播放
      if (window.voiceCallBgAudio && !window.voiceCallBgAudio.paused) {
        console.log('[Audio] 彩铃已在播放, 忽略视频通话重复点击');
        return;
      }

      // 防重复点击 (跟语音通话共用同一把锁, 防止双通话并发激活)
      if (window.isVoiceCallAudioUnlocking) {
        console.log('[Audio] 正在激活中,请勿重复点击');
        return;
      }
      window.isVoiceCallAudioUnlocking = true;

      // 切换到加载状态
      unlockBtn.classList.remove('unlock-inactive');
      unlockBtn.classList.add('unlock-loading');
      unlockBtn.textContent = '连接中…';

      // 复用或创建 bgAudio — 跟语音通话共用同一个 window.voiceCallBgAudio 实例
      // 只有第一次才 new, 后续失败清理后下次重试也是新的
      let bgAudio = window.voiceCallBgAudio;
      if (!bgAudio) {
        bgAudio = new Audio(VIDEO_AUDIO_UNLOCK_AUDIO_URL);
        bgAudio.loop = true;
        bgAudio.volume = 0.25;
        // 立即记下, 防止并发点击再 new 一个
        window.voiceCallBgAudio = bgAudio;
      }

      bgAudio.play()
        .then(() => {
          console.log('[Audio] 视频通话彩铃播放成功');

          // [iOS 授权] 在 user gesture 内建一个共享 AudioContext 并 resume
          // 跟语音通话共用同一个 window.voiceCallSharedAudioContext 实例
          // 这是 iOS Safari 音频解锁的关键 — user gesture 里 resume 后,
          // 后续 BufferSourceNode 播放不会被 user gesture 链限制
          try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass && !window.voiceCallSharedAudioContext) {
              window.voiceCallSharedAudioContext = new AudioContextClass();
              console.log('[Audio] 视频通话已建共享 AudioContext, state=', window.voiceCallSharedAudioContext.state);
            }
            if (window.voiceCallSharedAudioContext && window.voiceCallSharedAudioContext.state === 'suspended') {
              window.voiceCallSharedAudioContext.resume().then(() => {
                console.log('[Audio] 视频通话共享 AudioContext 已 resume, state=', window.voiceCallSharedAudioContext.state);
              }).catch(err => {
                console.warn('[Audio] 视频通话共享 AudioContext resume 失败:', err);
              });
            }
          } catch (audioCtxErr) {
            console.warn('[Audio] 视频通话共享 AudioContext 初始化失败(将回退到 <audio> 路径):', audioCtxErr);
          }

          // 切换到已连接状态
          unlockBtn.classList.remove('unlock-loading');
          unlockBtn.classList.add('unlock-connected');
          unlockBtn.textContent = '已连接';

          // 释放状态锁
          window.isVoiceCallAudioUnlocking = false;
        })
        .catch(err => {
          console.error('[Audio] 视频通话彩铃播放失败:', err);

          // 失败清理: 允许下次点击重试 (创建新 bgAudio)
          if (window.voiceCallBgAudio === bgAudio) {
            try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) { /* ignore */ }
            window.voiceCallBgAudio = null;
          }

          // 切换回初始状态
          unlockBtn.classList.remove('unlock-loading');
          unlockBtn.classList.add('unlock-inactive');
          unlockBtn.textContent = '启用音频';

          // 释放状态锁
          window.isVoiceCallAudioUnlocking = false;
        });
    });
  }

  // 立即停止视频通话彩铃 (跟语音通话 stopVoiceCallWaitingMusic 等价)
  // v0.5.0 P25: 不再需要手动隐藏按钮 — 按钮 DOM 在呼叫等待页内部, 进入正式通话页就已随屏隐藏。
  // 这里只负责停彩铃音频 (复用同一个 window.voiceCallBgAudio)。
  // 用法: 在视频通话 AI 文字即将出现的 hook 点调用 (跟语音通话 line 3334 行为一致)
  function stopVideoCallWaitingMusic(reason = '') {
    // 尝试停止彩铃音频 (没创建过 bgAudio 就跳过, 跟语音通话等价)
    if (!window.voiceCallBgAudio) return;
    try {
      window.voiceCallBgAudio.pause();
      window.voiceCallBgAudio.currentTime = 0;
    } catch (e) {
      console.warn('[Audio] 停止视频通话背景音乐失败:', e);
    }
    window.voiceCallBgAudio = null;
    console.log('[Audio] 视频通话 AI 文字出现, 立即停止背景音乐' + (reason ? ` (${reason})` : ''));
  }

  // 视频通话挂断时也要立刻停彩铃 (跟语音通话 endVoiceCall 顶部的"挂断停止背景音乐"等价)
  function stopVideoCallWaitingMusicOnHangup() {
    if (window.voiceCallBgAudio) {
      console.log('[Audio] 视频通话挂断，立刻停止背景音乐');
      window.voiceCallBgAudio.pause();
      window.voiceCallBgAudio.currentTime = 0;
      window.voiceCallBgAudio = null;
    }
  }

  // 脚本加载时就尝试绑定 (跟语音通话 setupVoiceCallAudioUnlock 调用时机一致)
  setupVideoCallAudioUnlock();

  // v0.5.0 P25: 按钮显隐不再需要 JS 干预 (DOM 在 #outgoing-call-screen 内部, 随屏幕显隐),
  // 所以不再往 window 挂 setVideoCallAudioUnlockBtnVisibility。
  // === 视频通话启用音频按钮功能结束 ===

})();

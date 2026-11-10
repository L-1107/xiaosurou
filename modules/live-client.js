// ============================================================
// live-client.js
// Gemini 3.8 Live API 客户端 (纯协议层, 不碰任何 DOM)
//
// ⚠️ 协议来源全部来自 Google 官方文档, 没有一句是猜的:
//   - 一起看谷歌文档/get-started-websocket.md.txt  (raw WebSocket 协议)
//   - 一起看谷歌文档/live.md.txt                     (BidiGenerateContent* API reference)
//   - 一起看谷歌文档/gemini-3.8-live.md.txt           (模型能力 + 迁移说明)
//   - 官方示例 google-gemini/gemini-live-api-examples
//       gemini-live-ephemeral-tokens-websocket/frontend/geminilive.js (协议范式参考)
//
// 🚫 这里【绝不】复用主聊天那套 /v1/chat/completions 格式。
//    Live 是 WebSocket 双向长连接 + BidiGenerateContent* 消息族, 与 REST 完全无关。
//
// 🔑 鉴权方式 (v0.3.0 定案):
//    用户填自己的 Google API Key → 前端直接 wss 连官方端点。
//    浏览器同源策略不管 WebSocket, 所以不需要任何后端 / 代理 / CORS 处理。
//    官方文档 get-started-websocket.md.txt:20 给的就是这个 key 直连端点。
//    (曾经用过的 ephemeral token + push-server 方案已废弃并移除)
//
// 职责边界:
//   ✅ 建 WS / 发 setup / 收 server message
//   ✅ 发 JPEG 视频帧 / 发用户文字
//   ✅ 连接状态机 / 错误 / close / session resumption
//   ❌ 不碰 <video> / 不碰 canvas / 不碰任何 DOM  (那些在 watch-together-live.js)
// ============================================================

(function () {
  'use strict';

  // ============================================================
  // 常量 (全部来自官方文档)
  // ============================================================

  // 官方 get-started-websocket.md.txt:20 —— 用自己的 key 直连这个端点
  var WS_BASE = 'wss://generativelanguage.googleapis.com/ws/' +
    'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  var MODEL_ID = 'gemini-3.8-live';

  // gemini-3.8-live.md.txt:40 原文:
  //   "Response modalities: Audio is the supported response modality.
  //    Enable output audio transcription if your application requires a text transcript."
  // → 不能用 responseModalities:["TEXT"], 只能 AUDIO, 文字靠 outputAudioTranscription
  var RESPONSE_MODALITIES = ['AUDIO'];

  // gemini-3.8-live.md.txt:34: thinking_level 不支持 3.8-live, 必须省略
  // gemini-3.8-live.md.txt:37: proactive_audio 永久开启, 设 false 报错
  //   → 本文件【故意不设】thinkingConfig 和 proactivity

  // live.md.txt:400 TurnCoverage:
  //   TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO = "Includes audio activity and all
  //   video since the last turn."
  // → 我们【必须】用这个, 否则 Gemini 收不到本回合的视频帧, 整个方案就废了。
  //   (官方示例 geminilive.js 用的是 TURN_INCLUDES_ONLY_ACTIVITY, 那是语音场景;
  //    我们视频是主输入, 不能照抄)
  var TURN_COVERAGE = 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO';

  // 🔴 2026-10-28: 发送缓冲上限 (背压阈值)。
  //
  //   WebSocket 的 bufferedAmount 涨起来 = 服务端/网络跟不上, 而浏览器会
  //   【无上限】把待发数据堆在内存里。影院这边 1 FPS × 每帧几十~上百 KB,
  //   堵一分钟就是好几 MB —— 堵久了整页内存被打爆, 手机上就是
  //   "看着看着卡住不动了, 退出影院外面也聊不了, 只有杀掉 app 才恢复"。
  //   → 超过这个阈值就丢帧 (见 sendVideoFrame)。宁可少看几帧。
  var MAX_BUFFERED_BYTES = 2 * 1024 * 1024;   // 2MB

  // ============================================================
  // 日志 (严格不打印任何凭据)
  // ============================================================

  function log(msg, extra) {
    var line = '[GeminiLive] ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) { /* noop */ }
    }
    console.log(line);
  }
  function logWarn(msg, extra) {
    var line = '[GeminiLive] ⚠️ ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) { /* noop */ }
    }
    console.warn(line);
  }
  function logError(msg, extra) {
    var line = '[GeminiLive] ✖ ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) { /* noop */ }
    }
    console.error(line);
  }

  /** 永远不要把凭据塞进日志 */
  function redactKey(key) {
    if (!key) return '(none)';
    return '[key len=' + String(key).length + ']';
  }

  // ============================================================
  // LiveClient
  // ============================================================

  /**
   * @param {object} opts
   *   apiKey        string  必填 — 用户自己的 Google API Key (AIza 开头)
   *   systemPrompt  string  必填 — 会进 setup.systemInstruction
   *   onState(state, detail)   状态变化回调
   *   onModelText(text, isFinal)  Gemini 文字 (来自 outputTranscription)
   *   onTurnComplete()          模型回合结束
   *   onUsage(meta)             usageMetadata
   *   onGoAway(timeLeft)        服务端即将断开
   *   onSessionResumption(info) session 存档点 (重连用)
   *   onError(err)
   */
  function LiveClient(opts) {
    opts = opts || {};
    this.apiKey = (opts.apiKey || '').trim();
    this.systemPrompt = opts.systemPrompt || '';

    this.onState = opts.onState || function () {};
    this.onModelText = opts.onModelText || function () {};
    this.onTurnComplete = opts.onTurnComplete || function () {};
    this.onUsage = opts.onUsage || function () {};
    this.onGoAway = opts.onGoAway || function () {};
    this.onError = opts.onError || function () {};

    this.ws = null;
    this.state = 'idle';   // idle|connecting|connected|ready|closed|error
    this.setupDone = false;
    this._lastTranscription = '';
    this._closingByUser = false;
    // ── session resumption (长时间观看不断线) ──
    //   官方 live.md.txt:249  "If included, the server will send SessionResumptionUpdate messages"
    //   官方 live.md.txt:353-360 SessionResumptionConfig.handle = 上次 SessionResumptionUpdate 给的 handle
    //   官方 live.md.txt:362-371 SessionResumptionUpdate.newHandle / resumable
    //   重连时把 handle 塞回 setup, 即可接着上次的对话继续 (不用重发全部历史)
    this._resumeHandle = null;
    this._resumable = false;
    this.onSessionResumption = opts.onSessionResumption || function () {};
  }

  LiveClient.STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    READY: 'ready',      // setupComplete 已收到, 可以发数据
    CLOSED: 'closed',
    ERROR: 'error'
  };

  LiveClient.prototype._setState = function (state, detail) {
    this.state = state;
    this.onState(state, detail);
  };

  // ---------- ① 建 WebSocket + 发 setup ----------

  /**
   * 完整连接流程: 校验 key → 开 WS → 发 setup → 等 setupComplete
   * (不需要任何 token 交换步骤)
   */
  LiveClient.prototype.connect = function () {
    var self = this;
    if (this.state === LiveClient.STATE.CONNECTING || this.state === LiveClient.STATE.READY) {
      return Promise.resolve(this);
    }

    if (!this.apiKey) {
      var err = new Error('没填 Gemini API Key（观影设置 → Gemini Live API Key）');
      this._setState(LiveClient.STATE.ERROR, err.message);
      return Promise.reject(err);
    }

    this._closingByUser = false;
    this._setState(LiveClient.STATE.CONNECTING, '正在连接…');

    return Promise.resolve()
      .then(function () {
        // 官方 get-started-websocket.md.txt:20 —— 用户自己的 key 直连
        var url = WS_BASE + '?key=' + encodeURIComponent(self.apiKey);

        log('WebSocket connecting… (key 直连)');

        return new Promise(function (resolve, reject) {
          var settled = false;
          var ws;
          try {
            ws = new WebSocket(url);
          } catch (e) {
            reject(new Error('new WebSocket 抛错: ' + e.message));
            return;
          }
          self.ws = ws;

          ws.onopen = function () {
            log('WebSocket opened ✓');
            self._setState(LiveClient.STATE.CONNECTED, '已连接, 发 setup…');
            self.sendSetup();
            if (!settled) { settled = true; resolve(self); }
          };

          ws.onerror = function (event) {
            // ⚠️ WebSocket 的 error 事件不给可读原因, 只能给个通用文案
            logError('WebSocket error', '(浏览器未提供更详细原因, 常见: 网络被墙 / key 无效 / 端点不通)');
            self._setState(LiveClient.STATE.ERROR, 'WebSocket 连接错误');
            self.onError(new Error('WebSocket 连接错误'));
            if (!settled) { settled = true; reject(new Error('WebSocket 连接错误')); }
          };

          ws.onclose = function (event) {
            log('WebSocket closed', 'code=' + event.code + ' reason=' + (event.reason || '(none)') +
              (self._closingByUser ? ' [用户主动关闭]' : ''));
            self.setupDone = false;
            self._setState(LiveClient.STATE.CLOSED, '已断开 (code ' + event.code + ')');
            if (!settled) { settled = true; reject(new Error('WebSocket 在 setup 完成前关闭, code=' + event.code)); }
          };

          ws.onmessage = function (event) {
            self._handleMessage(event);
          };
        });
      })
      .catch(function (err) {
        if (self.state !== LiveClient.STATE.ERROR) {
          self._setState(LiveClient.STATE.ERROR, err.message);
        }
        throw err;
      });
  };

  /**
   * setup 消息。结构照抄官方 geminilive.js 的 sendInitialSetupMessages()。
   *
   * 与官方示例的差异 (都是有意为之, 已在常量区注明理由):
   *   - 不设 speechConfig.voiceConfig : 第一阶段不播音频
   *   - 不设 thinkingConfig          : 官方说 3.8-live 不支持
   *   - turnCoverage 换成 ALL_VIDEO  : 我们视频是主输入
   */
  LiveClient.prototype.sendSetup = function () {
    // sessionResumption:
    //   新会话   → 传空对象 {} , 开启机制, 服务端会持续发 SessionResumptionUpdate
    //   断线重连 → 传 { handle: 上次的 handle }, 服务端接着上次的对话继续
    //   (官方 live.md.txt:353-360: handle 来自上次的 SessionResumptionUpdate.newHandle)
    var resumption = this._resumeHandle
      ? { handle: this._resumeHandle }
      : {};

    var setup = {
      setup: {
        model: 'models/' + MODEL_ID,
        generationConfig: {
          responseModalities: RESPONSE_MODALITIES,
          temperature: 1.0
        },
        systemInstruction: {
          parts: [{ text: this.systemPrompt }]
        },
        // ⬇ 关键: 第一阶段只有 AUDIO 输出, 文字只能靠这个转写拿
        outputAudioTranscription: {},
        realtimeInputConfig: {
          turnCoverage: TURN_COVERAGE
        },
        // ⬇ 长时间观看不断线: 开启 session resumption
        sessionResumption: resumption
      }
    };
    log('setup sent →', 'model=models/' + MODEL_ID +
      ' responseModalities=' + JSON.stringify(RESPONSE_MODALITIES) +
      ' turnCoverage=' + TURN_COVERAGE +
      ' sessionResumption=' + (this._resumeHandle ? 'handle(恢复)' : '开启'));
    this._send(setup);
  };

  /**
   * 设置重连时要用的 handle (通常来自 localStorage, 跨页面刷新也能恢复)
   */
  LiveClient.prototype.setResumeHandle = function (handle) {
    this._resumeHandle = handle || null;
  };

  LiveClient.prototype.getResumeHandle = function () {
    return this._resumeHandle;
  };

  // ---------- ③ 发送 ----------

  LiveClient.prototype._send = function (obj) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      logWarn('send 被丢弃 (WebSocket 未 OPEN)');
      return false;
    }
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      logError('send 抛错:', e.message);
      return false;
    }
  };

  /**
   * 发一帧视频画面。
   * @param {string} base64Jpeg  纯 base64 (不带 data: 前缀)
   * @param {string} mimeType    默认 image/jpeg
   *
   * 官方 get-started-websocket.md.txt:203-218 (Python) / 226-238 (JS):
   *   { "realtimeInput": { "video": { "data": <base64>, "mimeType": "image/jpeg" } } }
   */
  LiveClient.prototype.sendVideoFrame = function (base64Jpeg, mimeType) {
    // 🔴 2026-10-28: 背压保护 —— 缓冲太大就【丢这一帧】。
    //
    //   bufferedAmount 涨起来 = 服务端/网络跟不上, 而浏览器会【无上限】把待发
    //   数据堆在内存里。1 FPS × 每帧几十~上百 KB, 堵 1 分钟就是好几 MB,
    //   堵久了整页内存被打爆 —— 手机上表现就是"看着看着卡住不动了,
    //   退出影院外面也聊不了, 只有杀掉 app 才恢复"(用户 2026-10-28 实测)。
    //   → 宁可少看几帧, 也不能把内存吃光。丢帧会记数, 影院那边会提示用户。
    if (this.ws && this.ws.readyState === 1 && typeof this.ws.bufferedAmount === 'number' &&
        this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this._droppedFrames = (this._droppedFrames || 0) + 1;
      logWarn('帧被丢弃 (发送缓冲 ' + Math.round(this.ws.bufferedAmount / 1024) + 'KB 超阈值, 累计丢 ' +
        this._droppedFrames + ' 帧)');
      return false;
    }
    return this._send({
      realtimeInput: {
        video: {
          data: base64Jpeg,
          mimeType: mimeType || 'image/jpeg'
        }
      }
    });
  };

  /** 因背压丢掉的帧数 (影院那边用来给用户提示) */
  LiveClient.prototype.getDroppedFrames = function () {
    return this._droppedFrames || 0;
  };

  /**
   * 现在发得出去吗? (发送缓冲没满)
   *
   * 🔴 2026-10-29: 影院那边先问这个, 满了就连帧都不用抽 ——
   *   抽帧的 JPEG 编码 + base64 是白干的 (每帧 1.3MB 垃圾), 原来是先抽再丢。
   */
  LiveClient.prototype.canSendFrame = function () {
    if (!this.ws || this.ws.readyState !== 1) return false;
    if (typeof this.ws.bufferedAmount !== 'number') return true;
    return this.ws.bufferedAmount <= MAX_BUFFERED_BYTES;
  };

  /**
   * 发用户文字并【显式结束回合】, 触发 Gemini 生成。
   *
   * 为什么用 clientContent 而不是 realtimeInput.text:
   *   live.md.txt:172 BidiGenerateContentClientContent.turnComplete:
   *     "If true, indicates that the server content generation should start with
   *      the currently accumulated prompt."
   *   我们没有麦克风, 没有"用户说完话"这个信号, 只有用户在输入框敲回车这一个明确动作,
   *   所以必须用 turnComplete:true 显式触发。realtimeInput 靠活动检测自动收尾,
   *   在纯文字 + 视频帧的场景下不可靠。
   *
   * 回合内容 = 本回合内累积的 realtime video 帧 (靠 turnCoverage=ALL_VIDEO 保证)
   *          + 这条文字。
   *
   * gemini-3.8-live.md.txt:36 也确认 3.8 支持全生命周期 send_client_content。
   */
  LiveClient.prototype.sendUserText = function (text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return false;
    log('user text sent →', JSON.stringify(t.slice(0, 80)));
    this._lastTranscription = '';
    return this._send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: t }] }],
        turnComplete: true
      }
    });
  };

  // ---------- ④ 接收 ----------

  /**
   * 解析 server message。
   * 字段全部来自 live.md.txt BidiGenerateContentServerMessage / ServerContent。
   * 一条消息里可能有多个字段 (官方 geminilive.js 注释: "The server can now bundle
   * multiple fields (e.g. audio + transcription) in the same message"),
   * 所以【不能】用 else-if 串起来, 必须逐个独立判断。
   */
  LiveClient.prototype._handleMessage = function (event) {
    var self = this;
    var raw = event.data;

    // WebSocket 二进制帧要自己转字符串
    var text;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else if (raw && typeof raw.text === 'function') {
      text = null;
      raw.text().then(function (t) { self._handleText(t); });
      return;
    } else {
      text = String(raw);
    }
    this._handleText(text);
  };

  LiveClient.prototype._handleText = function (text) {
    var msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      logError('收到非 JSON 消息, 已忽略', text.slice(0, 200));
      return;
    }

    // --- setupComplete (互斥, 出现即代表 setup 结束) ---
    if (msg.setupComplete) {
      log('setup completed ✓ (收到 setupComplete)');
      this.setupDone = true;
      this._setState(LiveClient.STATE.READY, '可以发送了');
      return;
    }

    // --- goAway: 服务端即将断开 ---
    if (msg.goAway) {
      logWarn('收到 goAway (服务端即将断开)', 'timeLeft=' + (msg.goAway.timeLeft || '?'));
      this.onGoAway(msg.goAway.timeLeft);
    }

    // --- sessionResumptionUpdate: 服务端给的"存档点" (官方 live.md.txt:362-371) ---
    if (msg.sessionResumptionUpdate) {
      var u = msg.sessionResumptionUpdate || {};
      // 官方字段名是 newHandle; 文档正文有一处写成 token, 两个都兼容
      var h = u.newHandle || u.token || '';
      var canResume = (u.resumable === undefined) ? !!h : !!u.resumable;
      if (h) this._resumeHandle = h;
      this._resumable = canResume;
      log('收到 sessionResumptionUpdate', 'resumable=' + canResume +
        ' handle长度=' + String(h || '').length);
      this.onSessionResumption({
        handle: this._resumeHandle,
        resumable: canResume
      });
    }

    // --- usageMetadata ---
    if (msg.usageMetadata) {
      this.onUsage(msg.usageMetadata);
    }

    // --- toolCall: 第一阶段不接工具, 记一条日志即可 ---
    if (msg.toolCall) {
      logWarn('收到 toolCall (第一阶段不处理工具调用)');
    }

    // --- serverContent: 主体 ---
    var sc = msg.serverContent;
    if (!sc) return;

    // 模型输出的音频 (第一阶段不播, 只统计)
    if (sc.modelTurn && sc.modelTurn.parts) {
      for (var i = 0; i < sc.modelTurn.parts.length; i++) {
        var part = sc.modelTurn.parts[i];
        if (part.inlineData) {
          log('收到模型音频 (第一阶段不播放, 丢弃)');
        }
      }
    }

    // ⬇ 关键: Gemini 的文字在这里。第一阶段 responseModalities 只有 AUDIO,
    //    所以文字【一定】从 outputTranscription 来, 不是 modelTurn.parts[].text。
    if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
      var t = sc.outputTranscription.text;
      if (t && t !== this._lastTranscription) {
        this._lastTranscription = t;
        // finished 字段在部分版本才有, 保守处理: turnComplete 时视为最终
        log('model text received →', JSON.stringify(t.slice(0, 80)));
        this.onModelText(t, !!sc.outputTranscription.finished);
      }
    }

    if (sc.interrupted) {
      logWarn('模型回合被中断 (interrupted)');
    }

    if (sc.turnComplete) {
      log('turn complete');
      // turnComplete 时把最后一段文字以 final=true 再抛一次, 保证 UI 拿到完整文本
      if (this._lastTranscription) {
        this.onModelText(this._lastTranscription, true);
      }
      this.onTurnComplete();
    }
  };

  // ---------- ⑤ 关闭 ----------

  /**
   * 断线重连 (长时间观看不断线用)。
   *
   * 与 connect() 的区别: 【不清 _resumeHandle】, 所以新的 setup 会带上
   * sessionResumption.handle, 服务端据此接上次的对话继续, 而不是从头开始。
   *
   * 官方依据:
   *   live.md.txt:353-360  SessionResumptionConfig.handle
   *   live.md.txt:362-371  SessionResumptionUpdate.newHandle / resumable
   */
  LiveClient.prototype.reconnect = function () {
    var had = this._resumeHandle;
    log('reconnect() 调用' + (had ? ' (带 handle, 保留上下文)' : ' (无 handle, 从头开始)'));
    this.setupDone = false;
    this.state = 'idle';      // 让 connect() 里的重入守卫放行

    // 🔴 2026-10-29 (用户实测「live 断了怎么都重连不上」):
    //   必须先处理掉【旧 socket】, 否则它会把这个新连接判死。
    //
    //   以前 reconnect() 只在「服务端先断开」之后才被调用 —— 那时旧 socket
    //   早就 closed、onclose 也触发过了, 所以没人受害。
    //   2026-10-29 新加的「摘要后换干净会话」(resetSession) 是【第一次在
    //   连接还活着的时候主动重连】→ 旧 socket 还开着 → 踩雷:
    //     旧 socket 的 onclose → self.setupDone = false + state = closed
    //     → 而 self.ws 已经是新 socket 了 → 新连接被判死
    //     → isReady() 永远为假 → 上层 waitUntilReady 超时 → 判定重连失败
    //     → 再排一次重连 → 又留一个孤儿 socket → 死循环。
    //   而且 isReady() 永远为假 → 剧情摘要那条路每次早退 → 一句都不写。
    //
    //   做法: 先把旧 socket 的回调【摘掉】(它之后怎么关都碰不到 self),
    //   再关掉它, 最后把 this.ws 置空。
    //   ⚠️ 只调 WebSocket 原生的 close(), 不调本文件的 close() ——
    //      本文件的 close() 会把 _closingByUser 置真(那是"用户主动关闭"用的)。
    var old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.onopen = null; old.onmessage = null; old.onerror = null; old.onclose = null;
        old.close(1000, 'reconnect');
      } catch (e) {
        logWarn('关旧 socket 失败:', e && e.message);
      }
    }
    return this.connect();
  };

  /**
   * 丢弃会话存档点, 下一个连接是【全新会话】。
   *
   * ⚠️ 为什么必须有这个 (2026-10-29, 用户实测「十五分钟左右浏览器崩溃闪退」):
   *   Live 会话的输入预算有限 (131,072 token), 而每一帧画面都要算 image token
   *   (官方: 258 tokens/tile)。带着 resume handle 重连 = 继承那个已经撑爆的上下文
   *   → 服务端立刻再掐 → 重连风暴 → 手机狂热 + 闪退。
   *   主动丢掉 handle 换干净会话, 上下文归零, 稳。
   *   剧情记忆不靠这个连续 —— 靠提示词里带的【滚动锚】。
   */
  LiveClient.prototype.resetSession = function () {
    this._resumeHandle = null;
    this._resumable = false;
    log('已丢弃会话存档点, 下一个连接是全新会话');
    return this.reconnect();
  };

  /**
   * 主动关闭。⚠️ 不做自动重连 (重连交给上层 watch-together-live.js 决定)
   */
  LiveClient.prototype.close = function (reason) {
    this._closingByUser = true;
    this.setupDone = false;
    if (this.ws) {
      try {
        // readyState 2/3 表示已经在关, 不用重复 close
        if (this.ws.readyState === 0 || this.ws.readyState === 1) {
          this.ws.close(1000, reason || 'client close');
        }
      } catch (e) {
        logError('close 抛错:', e.message);
      }
    }
    this._setState(LiveClient.STATE.CLOSED, '已关闭');
  };

  LiveClient.prototype.isReady = function () {
    return !!(this.ws && this.ws.readyState === 1 && this.setupDone);
  };

  // ============================================================
  // 导出
  // ============================================================

  window.LiveClient = LiveClient;
  window.GEMINI_LIVE_MODEL = MODEL_ID;
  window.GEMINI_LIVE_WS_BASE = WS_BASE;
  log('live-client.js 已加载 (model=' + MODEL_ID + ', 纯协议层, 不含 DOM 操作)');
})();

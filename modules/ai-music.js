// ============================================================
// ai-music.js — AI 唱歌（普通生成模式）
// 功能：调用【阶跃星辰 StepAudio 3 Music】生成歌曲（caption + lyrics → 新歌）
//
// 🔴 2026-11-27 渠道更换：MiniMax music_generation → 阶跃星辰 StepAudio 3 Music
//   起因：用户说 Minimax 把他从老用户队列里踢出去、不让生成音乐了，这个功能名存实亡。
//   接口差异（两边不是同一种协议，所以整个调用层重写了）：
//     · MiniMax：同步单请求 POST /v1/music_generation，返回 data.audio 是【hex】
//     · 阶跃：异步两步 POST /v1/audio/music/submit 拿 task_id → 轮询 /v1/audio/music/query
//              （PENDING/RUNNING/SUCCESS/FAILED），成功时 audio 是【base64】
//   字段映射：prompt → caption（风格描述）、model → model_id、instrumental 保留，
//             lyrics 保留（器乐模式必须不传 lyrics，官方明确禁止同时传）
//
// ⚠️ API Key 由用户自己填（设置页「音乐生成 → API Key」，存 globalSettings.musicApiKey）。
//    这里【不再】回落到聊天用的主 API Key —— 那个是别的厂商的 key，发给阶跃只会 401。
// ============================================================

(function () {
  // ---------- 端点常量（完全固化，不依赖用户填的 baseURL） ----------
  const MUSIC_SUBMIT_URL = 'https://api.stepfun.com/v1/audio/music/submit';
  const MUSIC_QUERY_URL = 'https://api.stepfun.com/v1/audio/music/query';
  // 官方目前只有一个音乐模型，必须带 -preview 后缀
  const MUSIC_MODEL_ID = 'stepaudio-3-music-preview';

  // 音乐是自回归长任务，官方建议每 5 秒轮询一次
  const POLL_INTERVAL_MS = 5000;
  // 兜底上限：超过就放弃轮询（把 task_id 抛出去方便排查）
  const POLL_MAX_MS = 12 * 60 * 1000;

  // 🔴 2026-11-27 断点续取：音乐是异步长任务，如果生成中途关掉页面，
  //   轮询就断了 → 服务端照样跑完、照样扣钱，但歌拿不回来。
  //   所以提交成功就把 task_id 存进 localStorage，下次打开页面先来问一遍。
  const PENDING_KEY = 'stepfunMusicPendingTasks';
  // 太新的先跳过（可能本页正在跑，避免两边抢着交付）
  const PENDING_MIN_AGE_MS = 30 * 1000;
  // 超过这个时间就放弃（官方查询结果有保留期，太久也取不回来了）
  const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  // ---------- 全局状态 Proxy（沿用 music-player.js 的延迟加载模式） ----------
  const state = new Proxy({}, {
    get: (target, prop) => window.state?.[prop]
  });

  // ---------- API Key（用户自己填的阶跃星辰 key） ----------
  function getMusicApiKey() {
    const musicKey = state.globalSettings?.musicApiKey;
    if (musicKey && String(musicKey).trim()) return String(musicKey).trim();
    return '';
  }

  // ---------- base64 → Blob（阶跃返回的 audio 是 base64，不是 hex） ----------
  function mimeOfFormat(fmt) {
    const f = String(fmt || 'mp3').toLowerCase();
    if (f === 'wav') return 'audio/wav';
    if (f === 'flac') return 'audio/flac';
    if (f === 'opus') return 'audio/ogg'; // opus 一般装 ogg 容器
    if (f === 'pcm') return 'application/octet-stream';
    return 'audio/mpeg'; // mp3
  }

  function base64ToBlob(b64, mime) {
    const clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!clean) return null;
    let bin;
    try {
      bin = atob(clean);
    } catch (e) {
      throw new Error('音频数据解码失败（base64 非法）');
    }
    const len = bin.length;
    if (!len) return null;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // ---------- 错误友好化（按 error.type 判断，官方要求不要匹配 message 文本） ----------
  function friendlyError(type, message) {
    switch (type) {
      case 'insufficient_credit':
        return '阶跃星辰账户余额不足，请先充值后再试';
      case 'project_credit_limit_exceeded':
      case 'member_project_credit_limit_exceeded':
        return '项目或成员的额度已用尽，请检查阶跃星辰控制台的额度设置';
      case 'not_allowed':
        return 'API Key 无效或未授权，请检查「音乐生成 → API Key」是否填的是阶跃星辰的 key';
      case 'model_invalid':
        return '当前账号没有该音乐模型的权限，或模型 ID 不正确';
      case 'rate_limited':
        return '请求过于频繁（触发限流），请稍后再试';
      case 'service_unavailable':
        return '阶跃星辰服务繁忙，请稍后重试';
      case 'task_not_found':
        return '任务不存在或已超过保留期（音频可能已过期，请重新生成）';
      case 'request_params_invalid':
        return '请求参数有误：' + (message || '请检查曲风描述 / 歌词');
      default:
        return message || ('调用失败' + (type ? '（' + type + '）' : ''));
    }
  }

  // ---------- 通用 POST 包装 ----------
  async function postJson(url, apiKey, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(body)
    });

    let text = '';
    try { text = await res.text(); } catch (e) { /* ignore */ }

    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ } }

    if (!res.ok) {
      const errType = json && json.error && json.error.type ? json.error.type : '';
      const errMsg = json && json.error && json.error.message ? json.error.message : text.slice(0, 300);
      const err = new Error(friendlyError(errType, errMsg));
      err.httpStatus = res.status;
      err.errorType = errType;
      err.shouldRetry = res.headers.get('x-should-retry') === 'true';
      throw err;
    }
    if (!json) throw new Error('接口返回不是合法 JSON');
    return json;
  }

  // ---------- 失败终态的错误 ----------
  const FAIL_STAGE_TEXT = {
    audio_transcode: '音频无法解码 / 转码失败（检查参考音频格式或采样率）',
    no_speech_detected: '干声里没有检测到有效人声，换一段更清晰的干声再试',
    censor: '内容被安全审核拦截了，调整一下歌词或曲风描述再试',
    internal: '阶跃星辰服务端内部错误，请稍后重试'
  };

  // ---------- 提交任务 ----------
  async function submitTask({ apiKey, model, caption, lyrics, instrumental }) {
    const body = {
      task: 'text_to_music',
      model_id: model,
      caption: caption,
      response_format: 'mp3',   // MP3 体积小，PWA 里存 IndexedDB 更省
      bit_rate: 256,            // 单位 kbps（官方：MP3/Opus 有效）
      sample_rate: 48000        // 官方原生 48kHz 立体声
    };

    if (instrumental) {
      // 官方明确：instrumental=true 时不得同时传 lyrics
      body.instrumental = true;
    } else if (lyrics && String(lyrics).trim()) {
      body.lyrics = String(lyrics);
    }
    // 不传 lyrics 且非器乐 → 服务端自动写词

    const res = await postJson(MUSIC_SUBMIT_URL, apiKey, body);
    const taskId = res && res.task_id;
    if (!taskId) throw new Error('提交成功但没拿到 task_id');
    return taskId;
  }


  // ---------- 待取任务清单（localStorage） ----------
  function readPendingTasks() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function writePendingTasks(list) {
    try {
      // 只留最近 10 条，别把 localStorage 撑爆
      localStorage.setItem(PENDING_KEY, JSON.stringify((list || []).slice(-10)));
    } catch (e) { /* ignore */ }
  }

  function addPendingTask(rec) {
    if (!rec || !rec.taskId) return;
    const list = readPendingTasks().filter(r => r.taskId !== rec.taskId);
    list.push(rec);
    writePendingTasks(list);
  }

  function removePendingTask(taskId) {
    if (!taskId) return;
    writePendingTasks(readPendingTasks().filter(r => r.taskId !== taskId));
  }

  // ---------- 轮询任务 ----------
  async function waitForTask({ apiKey, taskId, onProgress }) {
    const startedAt = Date.now();
    let lastStatus = '';

    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > POLL_MAX_MS) {
        throw new Error('生成超时（已等待 ' + Math.round(elapsed / 60000) + ' 分钟），task_id=' + taskId);
      }

      let res;
      try {
        res = await postJson(MUSIC_QUERY_URL, apiKey, { task_id: taskId });
      } catch (e) {
        // 查询被限流：继续等，不要整个失败
        if (e.errorType === 'rate_limited' && elapsed < POLL_MAX_MS) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 2));
          continue;
        }
        throw e;
      }

      const status = String(res && res.status || '');

      if (status === 'SUCCESS') {
        const fmt = res.response_format || 'mp3';
        const blob = base64ToBlob(res.audio, mimeOfFormat(fmt));
        if (!blob) throw new Error('生成成功但音频为空');
        // 附带服务端改写结果，方便以后做「用了什么风格」的记录
        try {
          blob.stepfunMeta = {
            taskId: taskId,
            responseFormat: fmt,
            sampleRate: res.sample_rate,
            rewrittenCaption: res.rewritten_caption || '',
            rewrittenLyrics: res.rewritten_lyrics || ''
          };
        } catch (e) { /* ignore */ }
        return blob;
      }

      if (status === 'FAILED') {
        const stage = res.error && res.error.stage ? res.error.stage : '';
        const msg = res.error && res.error.message ? res.error.message : '';
        const text = FAIL_STAGE_TEXT[stage] || ('生成失败：' + (msg || stage || '未知原因'));
        throw new Error(text);
      }

      // PENDING / RUNNING → 继续等
      if (status !== lastStatus) {
        lastStatus = status;
        onProgress && onProgress({
          stage: status === 'PENDING' ? 'queued' : 'generate',
          text: status === 'PENDING' ? '音乐任务已排队…' : '正在生成音乐…'
        });
      } else {
        const secs = Math.round(elapsed / 1000);
        onProgress && onProgress({ stage: 'generate', text: '正在生成音乐…（已等 ' + secs + ' 秒）' });
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }


  // ---------- 交付：存进原创曲库 + 往聊天流推一条消息 ----------
  //   live 生成和「断点续取」都走这里，保证行为一致
  async function deliverSongBlob(rec, blob) {
    if (!blob) return false;
    const chatId = rec && rec.chatId;
    const title = String((rec && rec.title) || 'AI 原创');
    if (!chatId) return false;
    const songId = chatId + '_' + Date.now();
    try {
      if (typeof window.persistAiSongBlob === 'function') {
        await window.persistAiSongBlob(songId, {
          chatId: chatId, blob: blob, title: title,
          prompt: (rec && rec.prompt) || '',
          lyrics: (rec && rec.lyrics) || '',
          instrumental: !!(rec && rec.instrumental),
          createdAt: Date.now()
        });
      }
      if (window.MusicPlayer && typeof window.MusicPlayer.addAiSongActionMessage === 'function') {
        await window.MusicPlayer.addAiSongActionMessage({ chatId: chatId, songId: songId, title: title, blob: blob });
      }
      return true;
    } catch (e) {
      console.warn('[AIMusic] 交付音频失败:', e);
      return false;
    }
  }

  // ---------- 主入口 ----------
  // 参数：
  //   prompt: 曲风/人声/情绪描述（必填，对应官方 caption）
  //   lyrics: 歌词（带 [Verse] 等结构标签，可选；不传 = 服务端自动写词）
  //   instrumental: 是否纯音乐（默认 false；为 true 时不传 lyrics）
  //   model: 强制指定模型（默认从设置读，最终兜底 stepaudio-3-music-preview）
  //   onProgress({stage, text}): 进度回调
  // 返回：Blob（音频）或 throw
  async function generateSong(opts) {
    const prompt = opts?.prompt;
    let lyrics = opts?.lyrics;
    const explicitModel = opts?.model;
    const instrumental = !!opts?.instrumental;
    const onProgress = opts?.onProgress;

    // 0. 校验开关
    if (!state.globalSettings?.enableMusicGeneration) {
      throw new Error('音乐生成未启用，请在 API 设置页开启「启用 AI 唱歌」');
    }

    // 1. 校验 API Key（用户自己填的阶跃星辰 key）
    const apiKey = getMusicApiKey();
    if (!apiKey) {
      throw new Error('音乐生成 API Key 未配置（请在 API 设置页「音乐生成 → API Key」填写阶跃星辰的 key）');
    }

    // 2. 校验 prompt（对应官方必填 caption）
    if (!prompt || !String(prompt).trim()) {
      throw new Error('曲风描述（prompt / caption）必填');
    }

    // 3. 决定模型
    //    老库里存的是 MiniMax 的 music-3.0 / music-2.6 这类值，渠道换了以后这些 ID 在阶跃都不存在，
    //    统一兜回官方唯一的音乐模型，避免带着旧 ID 去请求直接 404 model_invalid。
    const settingsModel = state.globalSettings?.musicModel;
    let model = explicitModel || settingsModel || MUSIC_MODEL_ID;
    if (String(model).indexOf('stepaudio') !== 0) {
      console.log('[AIMusic] 渠道已换成阶跃星辰, 忽略旧模型 ID "' + model + '", 改用 ' + MUSIC_MODEL_ID);
      model = MUSIC_MODEL_ID;
    }

    // 4. 纯音乐模式：确保不带歌词
    if (instrumental) lyrics = undefined;

    // 5. 提交（拿到 task_id 后【立刻落地】到 localStorage —— 万一中途关掉页面，
    //    下次进来还能凭 task_id 把歌取回来，不然那笔钱就白花了）
    onProgress && onProgress({ stage: 'submit', text: '正在提交音乐任务…' });
    const taskId = await submitTask({
      apiKey: apiKey,
      model: model,
      caption: String(prompt).trim(),
      lyrics: lyrics,
      instrumental: instrumental
    });
    console.log('[AIMusic] 音乐任务已提交, task_id=' + taskId);

    const pendingRecord = {
      taskId: taskId,
      chatId: opts?.chatId || '',
      title: opts?.title || 'AI 原创',
      prompt: String(prompt).trim(),
      lyrics: lyrics || '',
      instrumental: instrumental,
      createdAt: Date.now()
    };
    addPendingTask(pendingRecord);

    // 6. 轮询；无论成功失败都要把这条待取记录清掉
    try {
      return await waitForTask({ apiKey: apiKey, taskId: taskId, onProgress: onProgress });
    } finally {
      removePendingTask(taskId);
    }
  }

  // ---------- 断点续取 ----------
  // 页面重开时调用：把上次没取回的歌补上。
  //   · SUCCESS   → 解码 + 存库 + 推消息（和 live 生成走同一个交付函数）
  //   · RUNNING   → 接着轮询到完成为止（后台跑，不阻塞界面）
  //   · FAILED    → 丢掉这条，提示一句
  //   · task_not_found（超过官方保留期）→ 丢掉
  // 同一时刻本页正在生成的那条会跳过（PENDING_MIN_AGE_MS 内不动），避免两边抢着交付。
  async function resumePendingTasks() {
    const apiKey = getMusicApiKey();
    if (!apiKey) return { skipped: 'no-key', recovered: 0 };

    const now = Date.now();
    const list = readPendingTasks();
    if (!list.length) return { recovered: 0, checked: 0 };

    let recovered = 0;
    let checked = 0;

    for (const rec of list) {
      if (!rec || !rec.taskId) { removePendingTask(rec && rec.taskId); continue; }

      const age = now - (rec.createdAt || 0);
      if (age < PENDING_MIN_AGE_MS) continue;                 // 可能本页正在跑
      if (age > PENDING_MAX_AGE_MS) { removePendingTask(rec.taskId); continue; } // 太久了，放弃

      checked++;
      try {
        const res = await postJson(MUSIC_QUERY_URL, apiKey, { task_id: rec.taskId });
        const status = String(res && res.status || '');

        if (status === 'SUCCESS') {
          const blob = base64ToBlob(res.audio, mimeOfFormat(res.response_format || 'mp3'));
          const ok = await deliverSongBlob(rec, blob);
          removePendingTask(rec.taskId);
          if (ok) {
            recovered++;
            if (typeof window.showToast === 'function') {
              window.showToast('上次没取回的歌已经补好了：《' + (rec.title || 'AI 原创') + '》', 'success', 6000);
            }
          }
        } else if (status === 'FAILED') {
          removePendingTask(rec.taskId);
          console.warn('[AIMusic] 续取失败(' + rec.taskId + '): ' + JSON.stringify(res.error || {}));
        } else {
          // PENDING / RUNNING → 接着等，后台完成后再交付
          console.log('[AIMusic] 续取：任务仍在生成 ' + rec.taskId + ' (' + status + ')');
          waitForTask({ apiKey: apiKey, taskId: rec.taskId })
            .then(async (blob) => {
              await deliverSongBlob(rec, blob);
              removePendingTask(rec.taskId);
              if (typeof window.showToast === 'function') {
                window.showToast('《' + (rec.title || 'AI 原创') + '》生成好了', 'success', 6000);
              }
            })
            .catch((e) => {
              console.warn('[AIMusic] 续取轮询失败:', e && e.message);
              // 任务不存在（过期）就清掉；其它错误（超时）保留，下次启动再试
              if (e && (e.errorType === 'task_not_found')) removePendingTask(rec.taskId);
            });
        }
      } catch (e) {
        if (e && e.errorType === 'task_not_found') {
          removePendingTask(rec.taskId);
        } else {
          console.warn('[AIMusic] 续取查询失败:', e && e.message);
        }
      }
    }

    return { recovered: recovered, checked: checked };
  }

  // 页面起来后自己跑一次（延迟 10 秒，等 state / db 都就绪）
  if (typeof setTimeout === 'function' && typeof localStorage !== 'undefined') {
    setTimeout(() => {
      try { resumePendingTasks().catch(() => {}); } catch (e) { /* ignore */ }
    }, 10000);
  }

  // ---------- 暴露 API ----------
  window.AIMusic = {
    generateSong: generateSong,
    getMusicApiKey: getMusicApiKey,
    resumePendingTasks: resumePendingTasks,
    // 旧的 MUSIC_API_URL 字段保留成提交地址，避免外部/旧代码读不到
    MUSIC_API_URL: MUSIC_SUBMIT_URL,
    MUSIC_SUBMIT_URL: MUSIC_SUBMIT_URL,
    MUSIC_QUERY_URL: MUSIC_QUERY_URL,
    MUSIC_MODEL_ID: MUSIC_MODEL_ID
  };
})();

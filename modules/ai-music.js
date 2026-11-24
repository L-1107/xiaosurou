// ============================================================
// ai-music.js — AI 唱歌（普通生成模式）
// 功能：调用 MiniMax music_generation API（prompt + lyrics → 新歌）
//       端点完全固化（不依赖用户填的 baseURL）
//
// 🔴 2026-11-19 「Cover 翻唱模式」整个删掉
//   用户: 「Minimax 不让用 API 调用生成歌曲了, 所以那些个上传专属音色样本,
//          AI 唱歌 cover 用那一项也不需要了」
//   删掉的部分:
//     · Cover 模式 (generateCover) + music_cover_preprocess 端点
//     · 专属音色样本读取 (getVoiceSampleBlob) + Blob→base64
//     · useVoiceSample 参数 / autoCoverWhenHasSample 自动切模型逻辑
//     · 配套的两个文件 (js/music-voice-sample.js / js/role-voice-sample-ui.js)
//   ⚠️ 普通生成模式保留 —— 用户只点名要删「专属音色样本 / Cover」这一项。
//      但普通模式走的也是同一个 minimaxi music_generation 端点, 如果那边真封了,
//      普通模式也会一起失效 (这事要不要一起删, 问过用户再动)。
// ============================================================

(function () {
  // ---------- 端点常量（完全固化，参照 mmx CLI endpoints.ts） ----------
  // 国内区 minimaxi.com；国际区是 minimax.io，按需切换下面这一行
  const MUSIC_API_URL = 'https://api.minimaxi.com/v1/music_generation';

  // ---------- 全局状态 Proxy（沿用 music-player.js 的延迟加载模式） ----------
  const state = new Proxy({}, {
    get: (target, prop) => window.state?.[prop]
  });

  // ---------- API Key 获取（fallback 链） ----------
  // 优先级：musicApiKey（用户专门填的） > globalSettings.apiKey（用户填的 MiniMax 主 key）
  // 不用 mainApiConfig.apiKey（那是聊天用的同源 key）；不用 Fish Audio / 其他 TTS 的 key
  function getMusicApiKey() {
    const musicKey = state.globalSettings?.musicApiKey;
    if (musicKey && String(musicKey).trim()) return String(musicKey).trim();
    const fallback = state.globalSettings?.apiKey;
    return fallback ? String(fallback).trim() : '';
  }

  // ---------- hex 字符串 → Uint8Array（音乐 API 返回的 audio 字段是 hex） ----------
  function hexToBytes(hex) {
    const clean = String(hex || '').replace(/^0x/i, '').replace(/\s+/g, '');
    if (!clean || clean.length % 2 !== 0) return new Uint8Array(0);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // ---------- hex → Blob（MP3） ----------
  function hexToMp3Blob(hex) {
    const bytes = hexToBytes(hex);
    if (bytes.length === 0) return null;
    return new Blob([bytes], { type: 'audio/mpeg' });
  }

  // ---------- 解析响应，提取音频 ----------
  function extractAudioBlob(responseJson) {
    if (!responseJson) return null;
    if (responseJson.base_resp && responseJson.base_resp.status_code !== 0) {
      const msg = responseJson.base_resp.status_msg || '未知错误';
      throw new Error('音乐生成失败: ' + msg);
    }
    const data = responseJson.data || {};
    if (data.audio) {
      return hexToMp3Blob(data.audio);
    }
    if (data.audio_url) {
      // 24h 过期 URL 模式（output_format='url'），这里暂不直接用
      // 由调用方决定是否下载
      return { audioUrl: data.audio_url };
    }
    return null;
  }

  // ---------- 通用 fetch 包装 ----------
  async function postJson(url, apiKey, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let errText = '';
      try { errText = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ' - ' + errText.slice(0, 200) : ''));
    }
    return await res.json();
  }

  // ---------- 普通模式（无参考音频，纯 prompt+lyrics 生成） ----------
  async function generateNormal({ apiKey, model, prompt, lyrics, instrumental, onProgress }) {
    onProgress && onProgress({ stage: 'generate', text: '正在生成音乐...' });
    const body = {
      model: model,
      prompt: prompt,
      lyrics: lyrics,
      audio_setting: {
        format: 'mp3',
        sample_rate: 44100,
        bitrate: 256000
      },
      output_format: 'hex'
    };
    if (instrumental) {
      body.is_instrumental = true;
    }
    const res = await postJson(MUSIC_API_URL, apiKey, body);
    return extractAudioBlob(res);
  }

  // ---------- 主入口 ----------
  // 参数：
  //   prompt: 风格描述（必填）
  //   lyrics: 歌词（带 [Verse] 等结构标签，可选；不传 = 纯音乐 instrumental 模式 或 AI 自动写词）
  //   model: 强制指定模型（默认从设置读）
  //   instrumental: 是否纯音乐（默认 false）
  //   onProgress({stage, text}): 进度回调
  // 返回：{ blob, audioUrl?, duration? } 或 throw
  async function generateSong(opts) {
    const prompt = opts?.prompt;
    let lyrics = opts?.lyrics;
    const explicitModel = opts?.model;
    const instrumental = !!opts?.instrumental;
    const onProgress = opts?.onProgress;

    // 0. 校验开关
    if (!state.globalSettings?.enableMusicGeneration) {
      throw new Error('音乐生成未启用，请在 API 设置页开启');
    }

    // 1. 校验 API Key
    const apiKey = getMusicApiKey();
    if (!apiKey) {
      throw new Error('音乐生成 API Key 未配置（请在 API 设置页填写或确保已配置 MiniMax 主 key）');
    }

    // 2. 校验 prompt
    if (!prompt || !String(prompt).trim()) {
      throw new Error('prompt 必填');
    }

    // 3. 决定 model —— 【2026-11-19 改】默认 music-3.0
    //    (原来默认 music-cover, Cover 模式删掉后没有 cover 模型可选了)
    const settingsModel = state.globalSettings?.musicModel;
    let model = explicitModel || settingsModel || 'music-3.0';
    // ⚠️ 老库里存的 musicModel 可能是 music-cover (cover 模式删了, 模型不再存在)
    if (String(model).startsWith('music-cover')) {
      console.log('[AIMusic] Cover 模式已下线, 模型 ' + model + ' 换成 music-3.0');
      model = 'music-3.0';
    }

    // 4. 纯音乐模式：自动清空 lyrics
    if (instrumental) {
      lyrics = undefined;
    }

    // 5. 调用
    return await generateNormal({ apiKey, model, prompt, lyrics, instrumental, onProgress });
  }

  // ---------- 暴露 API ----------
  window.AIMusic = {
    generateSong: generateSong,
    getMusicApiKey: getMusicApiKey,
    MUSIC_API_URL: MUSIC_API_URL
  };
})();

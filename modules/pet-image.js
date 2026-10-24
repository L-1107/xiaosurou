/* ============================================================
 * 宠物屋 · 生图模块
 * ------------------------------------------------------------
 * 用来给宠物「换新模样」：六格 3:2 透明图集。
 *
 * 走 330 已有的 OpenAI 兼容生图通道（跟聊天画图同一条路），
 * 复用 openai-compatible-image-settings.js 存的那份 baseUrl / apiKey / model。
 *
 * 【关键参数】
 *   size = 1536x1024  → gpt-image 系列原生 3:2，切 3列×2行 = 每格 512×512 方图，
 *                        跟 CSS 的 background-size:300% 200% 严丝合缝。
 *   background = transparent + output_format = png → 官方支持透明底。
 *                        ⚠️ 中转站是否透传这两个参数要实测（探针按钮就是干这个的）。
 *   /images/edits（multipart, 带参考图）→ 蜕变时保持同一只宠物。
 *
 * 【透明兜底】
 *   通道不给透明时，本地抠图：从画布四边做连通泛洪，只抠「跟边缘连通的背景色」，
 *   宠物身上同色的部分不会被抠掉；再补 2 轮边缘羽化，避免锯齿白边。
 *   ⚠️ 抠图只解决「能不能显示」，不解决「毛边好不好看」——
 *      奶油色宠物 + 白底是最难抠的情况，真透明的 starter 素材质量更好。
 *
 * 【存库】
 *   图集存 Blob 本体（不转 base64 —— base64 会在手机内存里翻好几倍）。
 * ============================================================ */
(function () {
  'use strict';

  const CFG = {
    atlasSize: '1536x1024',      // gpt-image 原生 3:2
    storeWidth: 768,             // 存库尺寸（每格 256×256，手机上绰绰有余）
    storeHeight: 512,
    snapshotSize: 256,           // 给 AI 看的单只截图
    dailyLimit: 3,               // 每日生图上限（跟上游一致）
    tolerance: 46,               // 抠图容差
    featherPasses: 2
  };

  const KEYS = {
    baseUrl: 'openaiCompatImageBaseUrl',
    apiKey: 'openaiCompatImageApiKey',
    model: 'openaiCompatImageModel',
    enabled: 'openaiCompatImageEnabled',
    dailyCount: 'petNestImageDailyCount',
    dailyDay: 'petNestImageDailyDay'
  };

  // ============================================================
  // 工具
  // ============================================================

  function getChannel() {
    let baseUrl = '', apiKey = '', model = '';
    try {
      baseUrl = (localStorage.getItem(KEYS.baseUrl) || '').trim().replace(/\/+$/, '');
      apiKey = (localStorage.getItem(KEYS.apiKey) || '').trim();
      model = (localStorage.getItem(KEYS.model) || '').trim();
    } catch (e) { /* 忽略 */ }
    return { baseUrl, apiKey, model };
  }

  function channelReady() {
    const c = getChannel();
    return !!(c.baseUrl && c.apiKey && c.model);
  }

  function toast(text, type) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(text, type); return; } catch (e) { /* 忽略 */ }
    }
    console.log('[宠物生图]', text);
  }

  function todayKey() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function todayCount() {
    try {
      const day = localStorage.getItem(KEYS.dailyDay);
      if (day !== todayKey()) return 0;
      return Number(localStorage.getItem(KEYS.dailyCount) || 0) || 0;
    } catch (e) { return 0; }
  }

  function bumpTodayCount() {
    try {
      const day = todayKey();
      const cur = localStorage.getItem(KEYS.dailyDay) === day
        ? (Number(localStorage.getItem(KEYS.dailyCount) || 0) || 0) : 0;
      localStorage.setItem(KEYS.dailyDay, day);
      localStorage.setItem(KEYS.dailyCount, String(cur + 1));
    } catch (e) { /* 忽略 */ }
  }

  function loadImage(blobOrUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      if (typeof blobOrUrl === 'string') img.src = blobOrUrl;
      else img.src = URL.createObjectURL(blobOrUrl);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      if (canvas.toBlob) {
        canvas.toBlob((b) => resolve(b), type, quality);
      } else {
        resolve(null);
      }
    });
  }

  // ============================================================
  // 抠图：边缘连通泛洪 + 羽化
  // ============================================================

  /** 找出画布边缘最常见的颜色，当作背景色 */
  function findBackgroundColor(data, width, height) {
    const buckets = {};
    const sample = (x, y) => {
      const i = (y * width + x) * 4;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      buckets[key] = buckets[key] || { n: 0, r: 0, g: 0, b: 0 };
      buckets[key].n++;
      buckets[key].r += data[i];
      buckets[key].g += data[i + 1];
      buckets[key].b += data[i + 2];
    };
    for (let x = 0; x < width; x += 2) { sample(x, 0); sample(x, height - 1); }
    for (let y = 0; y < height; y += 2) { sample(0, y); sample(width - 1, y); }

    let best = null;
    for (const k in buckets) {
      if (!best || buckets[k].n > best.n) best = buckets[k];
    }
    if (!best) return { r: 255, g: 255, b: 255 };
    return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
  }

  function cutout(imageData, tolerance) {
    const { data, width, height } = imageData;
    const key = findBackgroundColor(data, width, height);
    const tol2 = tolerance * tolerance;

    const isBg = (i) => {
      const dr = data[i] - key.r, dg = data[i + 1] - key.g, db = data[i + 2] - key.b;
      return dr * dr + dg * dg + db * db <= tol2;
    };

    const total = width * height;
    const visited = new Uint8Array(total);
    const stack = [];
    const tryPush = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const p = y * width + x;
      if (visited[p]) return;
      visited[p] = 1;
      if (isBg(p * 4)) stack.push(p);
    };

    for (let x = 0; x < width; x++) { tryPush(x, 0); tryPush(x, height - 1); }
    for (let y = 0; y < height; y++) { tryPush(0, y); tryPush(width - 1, y); }

    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p / width) | 0;
      tryPush(x - 1, y); tryPush(x + 1, y); tryPush(x, y - 1); tryPush(x, y + 1);
    }

    let cleared = 0;
    for (let p = 0; p < total; p++) {
      if (visited[p]) { data[p * 4 + 3] = 0; cleared++; }
    }
    return cleared;
  }

  function feather(imageData, passes) {
    const { data, width, height } = imageData;
    const levels = [150, 215];
    for (let pass = 0; pass < passes; pass++) {
      const target = levels[pass] !== undefined ? levels[pass] : 210;
      const snapshot = new Uint8ClampedArray(data);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (snapshot[i + 3] === 0) continue;
          let near = false;
          if (x > 0 && snapshot[i - 4 + 3] === 0) near = true;
          else if (x < width - 1 && snapshot[i + 4 + 3] === 0) near = true;
          else if (y > 0 && snapshot[i - width * 4 + 3] === 0) near = true;
          else if (y < height - 1 && snapshot[i + width * 4 + 3] === 0) near = true;
          if (near) data[i + 3] = target;
        }
      }
    }
  }

  function countOpaqueRatio(imageData) {
    const { data } = imageData;
    let opaque = 0;
    const total = data.length / 4;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 16) opaque++;
    return opaque / total;
  }

  /**
   * 后处理：抠图 → 降采样 → 存成 webp（老 Safari 退回 png）
   * 返回 { blob, width, height, transparent, cutRatio }
   */
  async function postprocess(sourceBlob, options) {
    const opts = options || {};
    const img = await loadImage(sourceBlob);
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;

    // 1) 先画到工作画布
    const work = document.createElement('canvas');
    work.width = sw; work.height = sh;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(img, 0, 0);
    const imageData = wctx.getImageData(0, 0, sw, sh);

    // 2) 原图本来就带透明？带就不抠，避免把半透明阴影吃掉
    const alreadyTransparent = countOpaqueRatio(imageData) < 0.97;
    let cutRatio = 0;
    if (!alreadyTransparent && opts.cutout !== false) {
      cutRatio = cutout(imageData, opts.tolerance || CFG.tolerance);
      if (cutRatio > 0.02) feather(imageData, CFG.featherPasses);
      wctx.putImageData(imageData, 0, 0);
    }

    // 3) 降采样
    const tw = opts.width || CFG.storeWidth;
    const th = opts.height || CFG.storeHeight;
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    const octx = out.getContext('2d');
    octx.clearRect(0, 0, tw, th);
    octx.drawImage(work, 0, 0, tw, th);

    // 4) 输出
    let blob = await canvasToBlob(out, 'image/webp', 0.86);
    let type = 'image/webp';
    if (!blob) {
      blob = await canvasToBlob(out, 'image/png');
      type = 'image/png';
    }
    if (!blob) {
      // 最后的兜底: 直接用 dataURL 转 Blob
      const durl = out.toDataURL('image/png');
      const bin = atob(durl.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      blob = new Blob([arr], { type: 'image/png' });
      type = 'image/png';
    }

    // 5) 检查还有没有透明
    const finalData = octx.getImageData(0, 0, tw, th);
    const transparent = countOpaqueRatio(finalData) < 0.97;

    return { blob, width: tw, height: th, type, transparent, cutRatio, sourceSize: sw + 'x' + sh };
  }

  // ============================================================
  // 存库 / 取图
  // ============================================================

  const urlCache = new Map();

  async function saveAsset(petId, stage, blob, extra) {
    const db = await window.PetNest.getDb();
    const id = petId + '::' + stage + '::' + Date.now().toString(36);
    const row = Object.assign({
      id, petId, stage,
      blob,
      mime: blob.type || 'image/webp',
      size: blob.size,
      createdAt: Date.now()
    }, extra || {});
    await db.assets.put(row);
    return row;
  }

  async function getAsset(assetId) {
    if (!assetId) return null;
    const db = await window.PetNest.getDb();
    return db.assets.get(assetId) || null;
  }

  async function getAssetUrl(assetId) {
    if (!assetId) return null;
    if (urlCache.has(assetId)) return urlCache.get(assetId);
    const row = await getAsset(assetId);
    if (!row || !row.blob) return null;
    const url = URL.createObjectURL(row.blob);
    urlCache.set(assetId, url);
    return url;
  }

  // ============================================================
  // 调 API
  // ============================================================

  function buildAtlasPrompt(subject, options) {
    const opts = options || {};
    const style = opts.style
      || 'warm children\'s picture-book illustration, soft watercolor texture, warm afternoon sunlight, gentle muted palette, the same art style across all six cells';
    const poses = '1) sitting alert and looking at the viewer, 2) sitting with eyes closed content, 3) curled up asleep, 4) head lowered eating from a food bowl, 5) lying down looking up, 6) sitting with one front paw raised';
    const background = 'isolated on a fully transparent background, absolutely no ground shadow, no backdrop, no scenery, no text, no watermark, no border, no grid lines';
    const layout = 'ONE image containing a 3 columns by 2 rows grid of six equal SQUARE cells, reading left to right then top to bottom, each cell fully filled by that one pose, no gaps';
    return [
      'A single ' + subject + '.',
      'The SAME individual character in every cell — identical face, identical fur/skin colors, identical eye color, identical markings.',
      layout + '.',
      'The six poses, in order: ' + poses + '.',
      'Style: ' + style + '.',
      background + '.'
    ].join('\n');
  }

  function buildEvolvePrompt(subject, change, referenceNote) {
    const style = 'warm children\'s picture-book illustration, soft watercolor texture, warm afternoon sunlight, gentle muted palette, the same art style across all six cells';
    const poses = '1) sitting alert and looking at the viewer, 2) sitting with eyes closed content, 3) curled up asleep, 4) head lowered eating from a food bowl, 5) lying down looking up, 6) sitting with one front paw raised';
    const background = 'isolated on a fully transparent background, absolutely no ground shadow, no backdrop, no scenery, no text, no watermark, no border, no grid lines';
    const layout = 'ONE image containing a 3 columns by 2 rows grid of six equal SQUARE cells, reading left to right then top to bottom, each cell fully filled by that one pose, no gaps';
    return [
      'Keep exactly the SAME character from the reference image — same face, same colors, same eye color.',
      'Make ONLY this change: ' + change + '.',
      layout + '.',
      'The six poses, in order: ' + poses + '.',
      'Style: ' + style + '.',
      background + '.',
      referenceNote || 'The reference image shows the same character in six poses.'
    ].join('\n');
  }

  /** 走 /images/generations（JSON，能直接用现有 openai-proxy 转发） */
  async function callGenerations(prompt, extra) {
    const c = getChannel();
    if (!c.baseUrl) throw new Error('还没配生图 API 地址（设置 → 生图 → OpenAI兼容）');
    if (!c.apiKey) throw new Error('还没配生图 API Key');
    if (!c.model) throw new Error('还没配生图模型名');

    const body = Object.assign({
      model: c.model,
      prompt,
      size: CFG.atlasSize,
      n: 1,
      output_format: 'png',
      background: 'transparent'
    }, extra || {});

    const url = c.baseUrl + '/images/generations';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('生图接口报错 HTTP ' + res.status + (text ? ': ' + text.slice(0, 300) : ''));
    }
    const data = await res.json();
    const first = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!first) throw new Error('生图返回里没有 data[0]');
    if (typeof first.b64_json === 'string' && first.b64_json.trim()) {
      const bin = atob(first.b64_json);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return { blob: new Blob([arr], { type: 'image/png' }), raw: first.b64_json };
    }
    if (typeof first.url === 'string' && first.url.trim()) {
      const blob = await (await fetch(first.url)).blob();
      return { blob, raw: null };
    }
    throw new Error('生图返回里既没有 b64_json 也没有 url');
  }

  /** 走 /images/edits（multipart，带参考图）—— 需要中转站放行 CORS */
  async function callEdits(prompt, referenceBlob) {
    const c = getChannel();
    if (!c.baseUrl) throw new Error('还没配生图 API 地址');
    if (!c.apiKey) throw new Error('还没配生图 API Key');
    if (!c.model) throw new Error('还没配生图模型名');

    const form = new FormData();
    form.append('model', c.model);
    form.append('prompt', prompt);
    form.append('size', CFG.atlasSize);
    form.append('n', '1');
    form.append('output_format', 'png');
    form.append('background', 'transparent');
    form.append('image[]', referenceBlob, 'reference.png');

    const url = c.baseUrl + '/images/edits';
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.apiKey },
        body: form
      });
    } catch (e) {
      throw new Error('参考图编辑请求没能发出去（多半是跨域被拦了）：' + (e.message || e));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('参考图编辑报错 HTTP ' + res.status + (text ? ': ' + text.slice(0, 300) : ''));
    }
    const data = await res.json();
    const first = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!first) throw new Error('参考图编辑返回里没有 data[0]');
    if (typeof first.b64_json === 'string' && first.b64_json.trim()) {
      const bin = atob(first.b64_json);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return { blob: new Blob([arr], { type: 'image/png' }) };
    }
    if (typeof first.url === 'string' && first.url.trim()) {
      const blob = await (await fetch(first.url)).blob();
      return { blob };
    }
    throw new Error('参考图编辑返回里既没有 b64_json 也没有 url');
  }

  // ============================================================
  // 对外：探针 / 生成 / 蜕变 / 截图
  // ============================================================

  /** 探针：一次最小生图, 看通道到底给不给透明、给不给 3:2 */
  async function probe() {
    const report = { ok: false, channel: getChannel(), steps: [] };
    if (!channelReady()) {
      report.error = '还没配生图通道（地址 / Key / 模型名）';
      return report;
    }
    try {
      report.steps.push('发一张最小测试图（1536x1024, background=transparent, quality=low）');
      const { blob } = await callGenerations(
        'A single simple orange cat paw print icon, centered, isolated on a fully transparent background, no text.',
        { quality: 'low' }
      );
      bumpTodayCount();
      report.steps.push('拿到图: ' + blob.size + ' bytes, ' + blob.type);
      const processed = await postprocess(blob, { cutout: false });
      report.sourceSize = processed.sourceSize;
      report.transparent = processed.transparent;
      report.steps.push(processed.transparent
        ? '✅ 通道给了透明底'
        : '⚠️ 通道没给透明底（本地抠图兜底能补，但毛边可能不完美）');
      report.steps.push(processed.sourceSize === CFG.atlasSize
        ? '✅ 尺寸就是 1536x1024（3:2，正好切六格）'
        : '⚠️ 尺寸是 ' + processed.sourceSize + '，不是 1536x1024');
      report.ok = true;
    } catch (e) {
      report.error = e.message || String(e);
    }
    return report;
  }

  /** 生成新样貌（图集） */
  async function generateAtlas(subject, options) {
    if (todayCount() >= CFG.dailyLimit) {
      throw new Error('今天生图次数用完了（上限 ' + CFG.dailyLimit + ' 次），明天再说');
    }
    const prompt = buildAtlasPrompt(subject, options);
    const { blob } = await callGenerations(prompt, { quality: (options && options.quality) || 'medium' });
    bumpTodayCount();
    const processed = await postprocess(blob, { cutout: true });
    return processed;
  }

  /** 蜕变：带参考图重画 */
  async function evolveAtlas(subject, change, referenceBlob) {
    if (todayCount() >= CFG.dailyLimit) {
      throw new Error('今天生图次数用完了（上限 ' + CFG.dailyLimit + ' 次），明天再说');
    }
    if (!referenceBlob) throw new Error('没有参考图，不能蜕变');
    const prompt = buildEvolvePrompt(subject, change);
    const { blob } = await callEdits(prompt, referenceBlob);
    bumpTodayCount();
    const processed = await postprocess(blob, { cutout: true });
    return processed;
  }

  /** 给 AI 看的小截图：单只、方形、透明底 */
  async function snapshotBlob(assetId) {
    const row = await getAsset(assetId);
    if (!row || !row.blob) return null;
    const img = await loadImage(row.blob);
    const size = CFG.snapshotSize;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    // 取第 1 格（第一格是"坐姿睁眼"，最能代表这只宠物）
    const fw = img.naturalWidth / 3, fh = img.naturalHeight / 2;
    ctx.drawImage(img, 0, 0, fw, fh, 0, 0, size, size);
    const blob = await canvasToBlob(canvas, 'image/png');
    if (blob) return blob;
    return null;
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 把宠物现在的样子塞进聊天历史（隐藏消息）。
   * 必须是 role:'user' —— 330 的「清空聊天图片」只清 user 角色的本地图片，
   * 这样它就能跟聊天里发的图一起被清掉，不会一直占地方。
   */
  async function injectSnapshot(chat, pet, assetId) {
    if (!chat || !assetId) return false;
    const blob = await snapshotBlob(assetId);
    if (!blob) return false;
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl) return false;
    if (!window.messageStore || typeof window.messageStore.addMessageToChat !== 'function') return false;
    await window.messageStore.addMessageToChat(chat, {
      role: 'user',
      type: 'pet_snapshot',
      isHidden: true,
      content: [
        { type: 'text', text: '[小窝快照] 这是我们一起养的「' + pet.name + '」现在的样子。' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ],
      timestamp: Date.now()
    });
    return true;
  }

  window.PetImage = {
    CFG,
    probe,
    generateAtlas,
    evolveAtlas,
    postprocess,
    cutout,
    feather,
    saveAsset,
    getAsset,
    getAssetUrl,
    snapshotBlob,
    blobToDataUrl,
    injectSnapshot,
    channelReady,
    todayCount,
    buildAtlasPrompt,
    buildEvolvePrompt
  };
})();

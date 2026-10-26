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
 *   通道不给透明时，本地抠图：多色背景 + 从画布四边做连通泛洪，
 *   泛洪时既比全局背景色、也比「刚才扩过来的那个像素」（局部参考）→ 渐变/柔光/影子也吃得掉；
 *   再来几遍递增容差，最后补软边（按离背景的距离给 alpha + 去色边）。
 *   宠物身上跟背景同色的部分不会被抠掉（只抠跟边缘连通的）。
 *   ⚠️ 抠图只解决「能不能显示」，不解决「毛边好不好看」——
 *      奶油色宠物 + 白底是最难抠的情况，真透明的 starter 素材质量更好。
 *   ⚠️【2026-10-26】老版本只认一种背景色 + 固定容差 → 渐变背景被切成一块块，
 *      宠物旁边会残留色块（用户实测）。现在多色 + 局部参考 + 多遍递增容差，
 *      安全网改成看「宠物本体有没有被啃」（不能用画面百分比——宠物本来就占一小块，
 *      用百分比当底线会误判成啃宠物 → 整遍回滚 → 一张都抠不掉）。
 *   ⚠️【2026-10-26】用户指出残留的色块「像是另一格的宠物的一部分」——
 *      真凶是 AI 把六格画歪了（格子没对齐 / 宠物越格），不是抠图精度问题。
 *      所以改成**按格处理**：每格单独抠、单独只留本格主体（删掉隔壁串进来的）、
 *      主体再挪到格心。
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
    tolerance: 46,               // 抠图容差（多遍递增：1× → 1.8× → 2.6×）
    backgroundColorKeys: 3,      // 边框取几种背景色（渐变/柔光背景用得上）
    backgroundColorSpread: 2.6,  // 其余背景色离主背景色多远之内才算数（× 容差）

    cellMargin: 0.08,            // 每格四周切掉的边距（格子宽的百分之几）——切图范围收小，邻格越界的进不来
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
  // 抠图：多色背景 + 局部参考的区域生长 + 多遍递增容差 + 软边
  // ============================================================

  /**
   * 找出画布边缘最常见的颜色 → 背景色集合（保留前 K 种）
   * ⚠️【2026-10-26 改】原来只取一种。
   *   AI 画的背景常常不是纯色（渐变 / 水彩纹理 / 一圈柔光 / 地上一个影子），
   *   只认一种色 → 泛洪到一半卡住 → 背景被切成一块块 → 「宠物旁边残留色块」。
   *
   * ⚠️【2026-10-26 再改】多出来的背景色要过两道关：
   *   ① 离主背景色够近（maxSpread 以内）—— 渐变/柔光差得近，进得来；宠物色差得远，进不来。
   *   ② 在整张图里占的面积够大（minShare 以上）——
   *      按格处理时，宠物越出自己那格 → 格子的边缘有一截是宠物 →
   *      那一截的抗锯齿过渡色也会被采样成「背景色」→ 宠物自己被当成背景抠光。
   *      真背景（一整块米色地板）面积很大；抗锯齿过渡带只有细细一圈 → 靠面积把它们分开。
   */
  function findBackgroundColors(data, width, height, keep, maxSpread, minShare) {
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

    const list = Object.keys(buckets).map(k => ({
      n: buckets[k].n,
      r: buckets[k].r / buckets[k].n,
      g: buckets[k].g / buckets[k].n,
      b: buckets[k].b / buckets[k].n
    }));
    list.sort((a, b) => b.n - a.n);
    const out = [];
    const maxKeep = Math.max(1, Number(keep) || 1);
    const total = width * height;
    const spread = (maxSpread === undefined || maxSpread === null) ? Infinity : Number(maxSpread);
    const share = (minShare === undefined || minShare === null) ? 0 : Number(minShare);

    if (list.length) {
      const main = list[0];
      out.push(main);
      for (let i = 1; i < list.length && out.length < maxKeep; i++) {
        const c = list[i];
        const dr = c.r - main.r, dg = c.g - main.g, db = c.b - main.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > spread) continue;
        if (share > 0) {
          // 这一种颜色在整张图里占多大面积？面积太小 → 只是边缘过渡色，不算背景
          let n = 0;
          for (let p = 0; p < total; p++) {
            const j = p * 4;
            const er = data[j] - c.r, eg = data[j + 1] - c.g, eb = data[j + 2] - c.b;
            if (er * er + eg * eg + eb * eb <= 256) n++;
          }
          if (n / total < share) continue;
        }
        out.push(c);
      }
    }
    if (!out.length) out.push({ r: 255, g: 255, b: 255 });
    return out;
  }

  /**
   * 「宠物本体」掩码（2026-10-26）
   *
   * 跟【所有】背景色都差得很远的像素 → 它绝不可能是背景 → 它一定是宠物。
   * 泛洪要是把这些像素啃掉了，说明它爬进宠物里了 → 那一遍必须回滚。
   *
   * 分两层，为什么：
   *   far  = 差得特别远（饱和的宠物本体）→ 被啃一点点就回滚
   *   near = 差得远但偏灰（影子、柔光这类）→ 允许被吃掉，
   *          不然影子抠不掉 → 宠物旁边又残留一块块颜色（用户 2026-10-26 实测的老问题）
   *
   * ⚠️ 为什么不能用「画面还剩多少不透明」当安全网：
   *   宠物在图集里本来就只占一小块（实测一只猫占 9.7%），用 12% 当底线 →
   *   正常抠图被当成「啃宠物」→ 整遍回滚 → 一张都抠不掉（比残留色块还糟）。
   *   改成看「本体有没有被啃」，跟宠物占多大无关。
   */
  function computeCoreMask(data, width, height, keys, minDist) {
    const total = width * height;
    const mask = new Uint8Array(total);
    const d2 = minDist * minDist;
    let count = 0;
    for (let p = 0; p < total; p++) {
      const i = p * 4;
      let dmin = Infinity;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const dr = data[i] - key.r, dg = data[i + 1] - key.g, db = data[i + 2] - key.b;
        const d = dr * dr + dg * dg + db * db;
        if (d < dmin) dmin = d;
      }
      if (dmin > d2) { mask[p] = 1; count++; }
    }
    return { mask: mask, count: count };
  }

  /**
   * 跑几遍泛洪，算出「该抠掉哪些像素」（不直接改图，返回掩码）
   *
   * @param cfg.scales      每遍的容差倍数
   * @param cfg.localGrowth 要不要「局部参考」生长（渐变/柔光/影子靠它）
   */
  function runCutPasses(data, width, height, keys, baseTol, cfg) {
    const total = width * height;
    const scales = cfg.scales || [1];
    const localGrowth = cfg.localGrowth !== false;
    const floor = cfg.opaqueFloor !== undefined ? Number(cfg.opaqueFloor) : 0.05;

    const removed = new Uint8Array(total);   // 1 = 已抠掉
    let cleared = 0;
    let applied = 0;

    // far = 饱和本体（严防）；near = 灰色系（影子、柔光、抗锯齿边，放行）
    // far 的门槛要够高：门槛太低的话，灰色影子也会被当成「本体」保护起来 →
    // 影子抠不掉 → 宠物旁边又残留一块块颜色（这正是要解决的老毛病）。
    const far = computeCoreMask(data, width, height, keys, Math.max(150, baseTol * 4));
    const near = computeCoreMask(data, width, height, keys, Math.max(72, baseTol * 2));
    // 本体占了半个画面以上 → 说明背景色采样不准，这张 mask 靠不住 → 不用它当安全网
    const sane = near.count <= total * 0.55;
    const useFar = sane && far.count > 0;
    const useNear = sane && !useFar && near.count > 0;
    const farLimit = Math.max(8, Math.round(far.count * 0.3));
    const nearLimit = Math.max(16, Math.round(near.count * 0.6));
    let farLost = 0;
    let nearLost = 0;

    const near2 = (i, key, tol2) => {
      const dr = data[i] - key.r, dg = data[i + 1] - key.g, db = data[i + 2] - key.b;
      return dr * dr + dg * dg + db * db <= tol2;
    };

    for (let pass = 0; pass < scales.length; pass++) {
      const tol = baseTol * scales[pass];
      const tol2 = tol * tol;
      // ⚠️【2026-10-26 修】局部参考的容差必须**比全局小**，而且要有上限。
      //   用全局容差去比邻居 → 泛洪会顺着宠物轮廓的抗锯齿过渡带爬进宠物里
      //   （实测：整只猫被啃光）。柔和的渐变/影子每一步变化很小，小容差照样过得去；
      //   宠物边缘是突变，过不去。上限 26 是防「第三遍容差放大后又开始爬」。
      const localTol = Math.min(tol * 0.45, 26);
      const localTol2 = localTol * localTol;
      const visited = new Uint8Array(total);
      const passRemoved = new Uint8Array(total);
      const stack = [];

      // ref = 参考像素（-1 表示没有，用全局背景色比）
      const tryPush = (p, ref) => {
        if (p < 0 || p >= total) return;
        if (visited[p] || removed[p]) return;
        visited[p] = 1;
        const i = p * 4;
        // ① 跟全局背景色集合比
        for (let k = 0; k < keys.length; k++) {
          if (near2(i, keys[k], tol2)) { stack.push(p); return; }
        }
        // ② 跟扩过来的那个背景像素比（局部参考 → 渐变/柔光/影子靠这个）
        if (localGrowth && ref >= 0) {
          const dr = data[i] - data[ref];
          const dg = data[i + 1] - data[ref + 1];
          const db = data[i + 2] - data[ref + 2];
          if (dr * dr + dg * dg + db * db <= localTol2) { stack.push(p); return; }
        }
      };

      // 种子 ①：画布四边
      for (let x = 0; x < width; x++) {
        tryPush(x, -1);
        tryPush((height - 1) * width + x, -1);
      }
      for (let y = 0; y < height; y++) {
        tryPush(y * width, -1);
        tryPush(y * width + width - 1, -1);
      }
      // 种子 ②：已抠掉区域的外沿（第一遍没有，后面几遍靠它继续往里吃）
      if (pass > 0) {
        for (let y = 1; y < height - 1; y++) {
          for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            if (removed[p] || visited[p]) continue;
            if (removed[p - 1]) { tryPush(p, (p - 1) * 4); continue; }
            if (removed[p + 1]) { tryPush(p, (p + 1) * 4); continue; }
            if (removed[p - width]) { tryPush(p, (p - width) * 4); continue; }
            if (removed[p + width]) { tryPush(p, (p + width) * 4); }
          }
        }
      }

      while (stack.length) {
        const p = stack.pop();
        passRemoved[p] = 1;
        const x = p % width, y = (p / width) | 0;
        const ref = p * 4;
        if (x > 0) tryPush(p - 1, ref);
        if (x < width - 1) tryPush(p + 1, ref);
        if (y > 0) tryPush(p - width, ref);
        if (y < height - 1) tryPush(p + width, ref);
      }

      // 安全网：
      //   有饱和本体 → 这一遍啃掉太多本体就回滚（别把宠物啃了）
      //   只有灰色系 → 允许啃掉一部分（影子就是要抠掉的）
      //   啥本体都没有 → 看画面还剩多少不透明（整张同色图别被抠光）
      let passFar = 0, passNear = 0;
      for (let p = 0; p < total; p++) {
        if (!passRemoved[p]) continue;
        if (far.mask[p]) passFar++;
        else if (near.mask[p]) passNear++;
      }
      if (useFar) {
        if (farLost + passFar > farLimit) break;
      } else if (useNear) {
        if (nearLost + passNear > nearLimit) break;
      } else {
        let opaque = 0;
        for (let p = 0; p < total; p++) if (!removed[p] && !passRemoved[p]) opaque++;
        if (opaque / total < floor) break;
      }

      farLost += passFar;
      nearLost += passNear;
      for (let p = 0; p < total; p++) {
        if (passRemoved[p]) { removed[p] = 1; cleared++; }
      }
      applied++;
    }

    return {
      removed: removed, cleared: cleared, applied: applied,
      farLost: farLost, farCount: far.count, nearCount: near.count,
      useCore: useFar || useNear
    };
  }

  /**
   * 抠图（2026-10-26 重写）
   *
   * 老做法：找一个背景色 + 从四边泛洪 + 固定容差 46
   *   → 渐变/柔光/影子抠不干净，宠物旁边会残留一块块颜色（用户 2026-10-26 实测）
   *
   * 现在五件事：
   *   ① 背景色取「边框最常见的几种」，不是只有一种
   *   ② 区域生长时，除了比全局背景色，还跟【刚才扩过来的那个背景像素】比（局部参考）
   *      → 渐变、柔光、影子这种「慢慢变」的背景能一路吃干净
   *   ③ 多遍递增容差（1× → 1.8× → 2.6×），一遍比一遍狠
   *   ④ 安全网看「宠物本体有没有被啃」，不看画面百分比（宠物本来就占一小块）
   *   ⑤ 要是第一遍就啃到本体 → 换成保守那套（不局部生长、容差更小）重来
   */
  function cutout(imageData, tolerance, options) {
    const opts = options || {};
    const { data, width, height } = imageData;
    const total = width * height;
    const baseTol = Number(tolerance) || 46;
    const keys = (opts.keys && opts.keys.length)
      ? opts.keys
      : findBackgroundColors(data, width, height, opts.colorKeys || 3,
        opts.maxSpread !== undefined ? opts.maxSpread : baseTol * 2.6,
        opts.minShare !== undefined ? opts.minShare : 0.02);
    const scales = opts.passScales || [1, 1.8, 2.6];

    let res = runCutPasses(data, width, height, keys, baseTol, {
      scales: scales, localGrowth: true, opaqueFloor: opts.opaqueFloor
    });

    // 第一遍就被安全网拦下（或压根没抠动）→ 换保守那套重来
    //   保守 = 不局部生长 + 容差更小：宁可抠得不那么干净，也别把宠物啃了
    //   （例：奶油色宠物 + 白底 —— 局部生长会顺着抗锯齿带爬进宠物里）
    if (res.applied === 0) {
      res = runCutPasses(data, width, height, keys, baseTol, {
        scales: [0.7], localGrowth: false, opaqueFloor: opts.opaqueFloor
      });
    }

    for (let p = 0; p < total; p++) {
      if (res.removed[p]) data[p * 4 + 3] = 0;
    }
    return res.cleared;
  }

  /**
   * 边缘柔化（2026-10-26 改）
   * 老做法：贴着透明区的像素，alpha 直接写死 150 → 215
   *   → 一圈硬邦邦的半透明，颜色里还带着背景色 → 看着像一层灰/彩色方块
   * 现在：按「这个像素离背景色有多远」给一个软 alpha（越像背景越透明），
   *   并把背景色那一层从边缘像素里扣掉（去色边）→ 边缘发灰/发蓝的问题少很多。
   *   ⚠️ 多色背景时要用「离最近的那种背景色有多远」，不能只拿第一种色算。
   *   ⚠️ 明显是宠物本体（离背景色很远）的像素一律不动 —— 奶白色的宠物不该被削成半透明。
   */
  function feather(imageData, passes, bgKeys) {
    const { data, width, height } = imageData;
    const keys = (bgKeys && bgKeys.length) ? bgKeys : [{ r: 255, g: 255, b: 255 }];
    const rounds = Math.max(1, Number(passes) || 1);
    const PET_MIN_DIST = 150;   // 离所有背景色都这么远 → 一定是宠物本体，不碰它
    for (let pass = 0; pass < rounds; pass++) {
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
          if (!near) continue;

          // 离「最近的背景色」有多远
          let dist = Infinity;
          for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            const dr = data[i] - key.r, dg = data[i + 1] - key.g, db = data[i + 2] - key.b;
            const d = Math.sqrt(dr * dr + dg * dg + db * db);
            if (d < dist) dist = d;
          }
          if (dist >= PET_MIN_DIST) continue;   // 宠物本体，不削

          // 离背景越近 → 越透明（软边）；但至少留 20%，别把宠物啃掉
          const soft = Math.max(0, Math.min(1, dist / 96));
          const alpha = Math.round(255 * (0.2 + 0.8 * soft));
          data[i + 3] = Math.min(snapshot[i + 3], alpha);

          // 去色边：像素 = a×宠物色 + (1-a)×背景色 → 反解出宠物色
          const a = data[i + 3] / 255;
          if (a > 0.05) {
            for (let k = 0; k < keys.length; k++) {
              const key = keys[k];
              const nr = (data[i] - (1 - a) * key.r) / a;
              const ng = (data[i + 1] - (1 - a) * key.g) / a;
              const nb = (data[i + 2] - (1 - a) * key.b) / a;
              if (nr >= 0 && nr <= 255 && ng >= 0 && ng <= 255 && nb >= 0 && nb <= 255) {
                data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
                break;
              }
            }
          }
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

  // ============================================================
  // 六格图集：按格处理
  // ------------------------------------------------------------
  // 【为什么必须按格】用户 2026-10-26 实测：抠完的图旁边会「随机残留色块」，
  //   而且看起来像**另一格的宠物的一部分**。
  //   真凶不是抠图精度，是 AI 把六格画歪了：
  //     · 格子没跟 1/3、1/2 对齐 → 每格边缘都带着隔壁那格宠物的一条
  //     · 宠物越出自己那格 → 隔壁那格里留着它的一块
  //   整张一起抠 → 越格的那块跟本格宠物一样是「前景」→ 抠不掉 → 就是那个色块。
  //   所以改成：每格单独抠、单独只留本格主体、主体再挪到格心。
  // ============================================================

  const ATLAS_COLS = 3;
  const ATLAS_ROWS = 2;

  /**
   * 算一格的连通域
   * @returns { comp, comps, mainId } comp[p] = 像素 p 属于哪个连通域（-1 = 背景）
   */
  function analyzeCell(img, w, h) {
    const total = w * h;
    const comp = new Int32Array(total);
    comp.fill(-1);
    const comps = [];
    const stack = [];
    for (let p = 0; p < total; p++) {
      if (img.data[p * 4 + 3] <= 16 || comp[p] >= 0) continue;
      const id = comps.length;
      const info = {
        id: id, area: 0, touches: false,
        minX: w, minY: h, maxX: -1, maxY: -1, sumX: 0, sumY: 0
      };
      comp[p] = id;
      stack.push(p);
      while (stack.length) {
        const q = stack.pop();
        const x = q % w, y = (q / w) | 0;
        info.area++;
        info.sumX += x; info.sumY += y;
        if (x < info.minX) info.minX = x;
        if (x > info.maxX) info.maxX = x;
        if (y < info.minY) info.minY = y;
        if (y > info.maxY) info.maxY = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) info.touches = true;
        if (x > 0 && img.data[(q - 1) * 4 + 3] > 16 && comp[q - 1] < 0) { comp[q - 1] = id; stack.push(q - 1); }
        if (x < w - 1 && img.data[(q + 1) * 4 + 3] > 16 && comp[q + 1] < 0) { comp[q + 1] = id; stack.push(q + 1); }
        if (y > 0 && img.data[(q - w) * 4 + 3] > 16 && comp[q - w] < 0) { comp[q - w] = id; stack.push(q - w); }
        if (y < h - 1 && img.data[(q + w) * 4 + 3] > 16 && comp[q + w] < 0) { comp[q + w] = id; stack.push(q + w); }
      }
      info.cx = info.sumX / info.area;
      info.cy = info.sumY / info.area;
      comps.push(info);
    }
    // 主体 = 面积最大的；面积差不多时看谁更靠格子中心（本格的宠物才在中心附近）
    let mainId = -1;
    for (let i = 0; i < comps.length; i++) {
      if (mainId < 0) { mainId = i; continue; }
      const a = comps[i], b = comps[mainId];
      if (a.area > b.area * 1.25) { mainId = i; continue; }
      if (b.area > a.area * 1.25) continue;
      const da = Math.hypot(a.cx - w / 2, a.cy - h / 2);
      const db = Math.hypot(b.cx - w / 2, b.cy - h / 2);
      if (da < db) mainId = i;
    }
    return { comp: comp, comps: comps, mainId: mainId };
  }

  /**
   * 删掉「串进来的」别格宠物
   *
   * 判据（比「贴不贴边」准）：
   *   把本格主体之外的每个连通域，看它四周一圈紧挨着的像素属于谁。
   *     · 四周都是主体 → 它是宠物身上的花纹 / 空洞（例：身上的白斑）→ 保留
   *     · 四周是背景  → 它是别的东西飘在这格里（例：隔壁格伸过来的尾巴毛）→ 删掉
   *   另外：贴着格子边缘的一律删（那正是邻格越界进来的位置）。
   */
  function dropForeignParts(img, w, h, info) {
    if (!info || info.comps.length <= 1) return 0;
    const comp = info.comp, comps = info.comps;
    const total = w * h;
    const mainId = info.mainId;

    // 每个连通域四周一圈邻居的归属
    const around = new Int32Array(comps.length);
    const mainAround = new Int32Array(comps.length);
    for (let p = 0; p < total; p++) {
      const id = comp[p];
      if (id < 0) continue;
      const x = p % w, y = (p / w) | 0;
      if (x > 0) { const q = p - 1; if (comp[q] !== id) { around[id]++; if (comp[q] === mainId) mainAround[id]++; } }
      if (x < w - 1) { const q = p + 1; if (comp[q] !== id) { around[id]++; if (comp[q] === mainId) mainAround[id]++; } }
      if (y > 0) { const q = p - w; if (comp[q] !== id) { around[id]++; if (comp[q] === mainId) mainAround[id]++; } }
      if (y < h - 1) { const q = p + w; if (comp[q] !== id) { around[id]++; if (comp[q] === mainId) mainAround[id]++; } }
    }

    const drop = new Uint8Array(comps.length);
    for (let id = 0; id < comps.length; id++) {
      if (id === mainId) continue;
      const floating = around[id] === 0 ? true : (mainAround[id] / around[id] < 0.5);
      if (comps[id].touches || floating) drop[id] = 1;
    }

    let dropped = 0;
    for (let p = 0; p < total; p++) {
      const id = comp[p];
      if (id < 0 || id === mainId || !drop[id]) continue;
      img.data[p * 4 + 3] = 0;
      dropped++;
    }
    return dropped;
  }

  /**
   * 把主体挪到格子正中
   * AI 画的格子经常不对齐 → 宠物偏在一边 → 六格姿势转起来看着晃。
   * 只平移不缩放；挪出格子的部分直接丢（宁可缺一条也别串到隔壁格去）。
   */
  function recenterMain(img, w, h, info) {
    if (!info || info.mainId < 0) return 0;
    const m = info.comps[info.mainId];
    const dx = Math.round(w / 2 - (m.minX + m.maxX + 1) / 2);
    const dy = Math.round(h / 2 - (m.minY + m.maxY + 1) / 2);
    if (!dx && !dy) return 0;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const si = (y * w + x) * 4, di = (ny * w + nx) * 4;
        out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
        out[di + 2] = img.data[si + 2]; out[di + 3] = img.data[si + 3];
      }
    }
    img.data.set(out);
    return 1;
  }

  /**
   * 收边：把每格四周切掉一条（用户 2026-10-26：「切多了把邻格的切进来了，切图范围小一点」）
   *
   * AI 画的六格没对齐，邻格宠物会越过格子边界 → 露在本格边缘。
   * 这一步把边缘一条切掉，越界的部分根本进不了这一格。
   * ⚠️ 每条边切多少，要看这一侧的宠物顶没顶到边：
   *   宠物顶到边 → 那条边不切（提示词里写着 "each cell fully filled"，削宠物比留小块更难看）。
   */
  function zeroBorderBand(img, w, h, margins) {
    const left = margins.left | 0, top = margins.top | 0;
    const right = margins.right | 0, bottom = margins.bottom | 0;
    if (left <= 0 && top <= 0 && right <= 0 && bottom <= 0) return 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inBand = (x < left) || (y < top) || (x >= w - right) || (y >= h - bottom);
        if (!inBand) continue;
        const i = (y * w + x) * 4;
        if (img.data[i + 3] === 0) continue;
        img.data[i + 3] = 0;
        n++;
      }
    }
    return n;
  }

  /**
   * 整张图集按格处理（抠图 + 收边 + 去串格 + 对齐）
   * @returns { cleared, dropped, moved, banded, cells }
   */
  function processAtlasCells(imageData, sw, sh, opts) {
    const o = opts || {};
    const { data } = imageData;
    const cellW = Math.floor(sw / ATLAS_COLS);
    const cellH = Math.floor(sh / ATLAS_ROWS);
    const cell = { data: new Uint8ClampedArray(cellW * cellH * 4), width: cellW, height: cellH };
    let cleared = 0, dropped = 0, moved = 0, banded = 0;

    for (let cy = 0; cy < ATLAS_ROWS; cy++) {
      for (let cx = 0; cx < ATLAS_COLS; cx++) {
        const ox = cx * cellW, oy = cy * cellH;
        // ① 把这一格抽出来
        for (let y = 0; y < cellH; y++) {
          const src = ((oy + y) * sw + ox) * 4;
          cell.data.set(data.subarray(src, src + cellW * 4), y * cellW * 4);
        }
        // ② 这一格自己抠图（自己的背景色、从自己的四边泛洪）
        if (o.cutout !== false) {
          const tol = o.tolerance || 46;
          const keys = findBackgroundColors(cell.data, cellW, cellH, o.colorKeys || 3,
            o.maxSpread !== undefined ? o.maxSpread : tol * (o.spread || 2.6),
            o.minShare !== undefined ? o.minShare : 0.02);
          const c = cutout(cell, tol, { keys: keys });
          cleared += c;
          if (c > 0) feather(cell, o.featherPasses || 2, keys);
        }
        // ③ 收边：切图范围收小 —— 四周先切掉一条，邻格越界进来的东西进不了这一格
        //    每条边切多少，看这一侧的宠物顶没顶到边（顶到了就不切，别削宠物）
        let info = analyzeCell(cell, cellW, cellH);
        if (info.mainId >= 0 && o.margin !== 0) {
          const m = info.comps[info.mainId];
          const base = o.margin !== undefined ? Number(o.margin) : 0.08;
          const bx = Math.round(cellW * base), by = Math.round(cellH * base);
          banded += zeroBorderBand(cell, cellW, cellH, {
            left: Math.min(bx, Math.max(0, m.minX - 2)),
            top: Math.min(by, Math.max(0, m.minY - 2)),
            right: Math.min(bx, Math.max(0, (cellW - 1 - m.maxX) - 2)),
            bottom: Math.min(by, Math.max(0, (cellH - 1 - m.maxY) - 2))
          });
          info = analyzeCell(cell, cellW, cellH);   // 收边之后重新分析
        }
        // ④ 只留本格主体（删掉隔壁串进来的、没被宠物包着的那些块）+ 主体挪到格心
        dropped += dropForeignParts(cell, cellW, cellH, info);
        moved += recenterMain(cell, cellW, cellH, info);
        // ④ 写回整张
        for (let y = 0; y < cellH; y++) {
          const dst = ((oy + y) * sw + ox) * 4;
          data.set(cell.data.subarray(y * cellW * 4, (y + 1) * cellW * 4), dst);
        }
      }
    }
    return {
      cleared: cleared, dropped: dropped, moved: moved, banded: banded,
      cellW: cellW, cellH: cellH
    };
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

    // 2) 原图本来就带透明？带就不抠背景（免得把半透明阴影吃掉），
    //    但照样要按格收拾（去串格 + 主体对齐），不然照样有「别格宠物的一块」
    const alreadyTransparent = countOpaqueRatio(imageData) < 0.97;
    let cutRatio = 0;
    if (opts.cutout !== false) {
      // 图集比例不对（不是 3:2）→ 切不成六格，退回整张抠
      const ratio = sw / sh;
      const isAtlas = Math.abs(ratio - (1536 / 1024)) < 0.12;
      if (isAtlas) {
        const res = processAtlasCells(imageData, sw, sh, {
          cutout: !alreadyTransparent,
          colorKeys: CFG.backgroundColorKeys,
          spread: CFG.backgroundColorSpread,
          margin: CFG.cellMargin,
          tolerance: opts.tolerance || CFG.tolerance,
          featherPasses: CFG.featherPasses
        });
        cutRatio = res.cleared / (sw * sh);
      } else if (!alreadyTransparent) {
        const tol = opts.tolerance || CFG.tolerance;
        const keys = findBackgroundColors(imageData.data, sw, sh, CFG.backgroundColorKeys,
          tol * CFG.backgroundColorSpread, 0.02);
        cutRatio = cutout(imageData, tol, { keys: keys });
        if (cutRatio > 0.02) feather(imageData, CFG.featherPasses, keys);
      }
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

  /**
   * 回收某只宠物的生图 objectURL（放弃/饿死时用）
   * ⚠️ objectURL 必须 revoke —— 不然 blob 一直挂在内存里，删了也不释放。
   *   ⚠️ 只管内存里的 URL，数据库里的行由宠物屋那边删（各管各的）。
   */
  async function releaseAssetUrls(petId) {
    if (!petId) return 0;
    const db = await window.PetNest.getDb();
    let rows = [];
    try {
      rows = await db.assets.where('petId').equals(petId).toArray();
    } catch (e) {
      rows = (await db.assets.toArray()).filter(r => r && r.petId === petId);
    }
    let n = 0;
    for (const row of rows) {
      if (!row || !row.id) continue;
      const url = urlCache.get(row.id);
      if (url) {
        try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
        urlCache.delete(row.id);
        n++;
      }
    }
    return n;
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
    findBackgroundColors,
    computeCoreMask,
    runCutPasses,
    processAtlasCells,
    analyzeCell,
    dropForeignParts,
    recenterMain,
    zeroBorderBand,
    saveAsset,
    getAsset,
    getAssetUrl,
    deleteAssetsByPet: releaseAssetUrls,
    snapshotBlob,
    blobToDataUrl,
    injectSnapshot,
    channelReady,
    todayCount,
    buildAtlasPrompt,
    buildEvolvePrompt
  };
})();

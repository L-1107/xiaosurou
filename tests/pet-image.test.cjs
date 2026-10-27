// ============================================================
// tests/pet-image.test.cjs
// 宠物屋「生图模块」(modules/pet-image.js) 的回归测试
//
// 跑法: node tests/pet-image.test.cjs
//
// 【本测试守什么】
//   ① 生图契约: 3:2 图集尺寸 / 每日上限 / 提示词里必须写死的那几句话
//      —— 提示词少一句 "SAME character" 或 "transparent background",
//         生出来的六格就不是同一只猫、或者带白底 → 玩法直接变形。
//   ② 抠图/羽化: cutout / feather 是纯函数, 可以拿合成像素精确验算。
//   ③ 失败路径: 没配通道 / 次数用完 / 没有参考图 —— 必须给出人话报错,
//      而不是崩掉或静默失败。
//
// 【为什么用 vm 而不是 jsdom】
//   项目里没有 jsdom 依赖(见 cinema-episode-sheet.test.cjs 的说明)。
//   pet-image.js 是个纯 IIFE, 只往 window.PetImage 上挂东西,
//   塞进一个假 window 的 vm 沙箱就能拿到全部入口。
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, detail) {
  passed++;
  console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''));
}
function fail(name, detail) {
  failed++;
  console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''));
}
function check(name, cond, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

// ============================================================
// 把 pet-image.js 塞进 vm 沙箱
// ============================================================
function loadPetImage() {
  const src = read('modules/pet-image.js');
  const store = {};
  const assets = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: typeof Blob !== 'undefined' ? Blob : function () {},
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ width: 0, height: 0, getContext: () => null })
    },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // 存库/取图要用的 PetNest.getDb 桩
  sandbox.PetNest = {
    getDb: async () => ({
      assets: {
        get: async (id) => assets[id] || null,
        put: async (row) => { assets[row.id] = row; return row.id; }
      }
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'pet-image.js' });
  if (!sandbox.window.PetImage) throw new Error('pet-image.js 没暴露 window.PetImage');
  return { api: sandbox.window.PetImage, store, sandbox };
}

// 今天 (东八区) 的日期键 —— 必须跟 pet-image.js 里的 todayKey() 同算法
function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function yesterdayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

// 造一张合成 ImageData：40x40，纯色背景 + 中间 10x10 红块
function makeImageData(w, h, bg, fg, fgRect) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inFg = fgRect && x >= fgRect.x && x < fgRect.x + fgRect.w && y >= fgRect.y && y < fgRect.y + fgRect.h;
      const c = inFg ? fg : bg;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
const alphaAt = (img, x, y) => img.data[((y * img.width + x) * 4) + 3];

// ============================================================
// 汇总
// ============================================================
(async function main() {

// ============================================================
// ① 生图契约（CFG）
// ============================================================
section('生图契约: CFG');
{
  const { api } = loadPetImage();
  const C = api.CFG;
  check('图集尺寸 = 1536x1024（gpt-image 原生 3:2，正好切六格）', C.atlasSize === '1536x1024', C.atlasSize);
  check('存库尺寸 768x512（保持 3:2）', C.storeWidth === 768 && C.storeHeight === 512, C.storeWidth + 'x' + C.storeHeight);
  check('存库宽高比 == 图集宽高比',
    Math.abs((C.storeWidth / C.storeHeight) - (1536 / 1024)) < 1e-9);
  check('给 AI 看的单只截图 = 256', C.snapshotSize === 256, String(C.snapshotSize));
  check('每日生图上限 = 3（跟上游一致）', C.dailyLimit === 3, String(C.dailyLimit));
  check('自动换装有独立名额（0 = 按宠物数量算）', C.autoLookBudget === 0, String(C.autoLookBudget));
  check('羽化遍数 = 2', C.featherPasses === 2, String(C.featherPasses));
  check('抠图容差 > 0', C.tolerance > 0, String(C.tolerance));
}

// ============================================================
// ② 提示词契约
// ============================================================
section('生图契约: 图集提示词');
{
  const { api } = loadPetImage();
  const p = api.buildAtlasPrompt('a small white kitten');
  check('要 3 列 × 2 行六格', /3 columns by 2 rows/.test(p));
  check('每格必须正方形', /SQUARE cells/.test(p));
  check('宠物只占格子 75%、四周留白（用户 2026-10-27 定的：挤太紧耳朵尾巴会被切）',
    /filling only about 75% of that cell/.test(p) && /never touching or crossing the cell edges/.test(p));
  check('不再要求「每格塞满」（那等于叫模型把耳朵尾巴画进隔壁格）', !/fully filled/.test(p));
  check('必须透明底', /transparent background/.test(p));
  check('必须禁止文字/水印/网格线', /no text/.test(p) && /no watermark/.test(p) && /no grid lines/.test(p));
  check('必须写死"每一格是同一只"', /SAME individual character/.test(p));
  check('六种姿势都写进去了',
    /sitting alert/.test(p) && /eyes closed/.test(p) && /curled up asleep/.test(p) &&
    /eating from a food bowl/.test(p) && /lying down looking up/.test(p) && /one front paw raised/.test(p));
  check('禁止投影/背景布景', /no ground shadow/.test(p) && /no scenery/.test(p));

  const p2 = api.buildAtlasPrompt('a kitten', { style: 'my own style' });
  check('自定义 style 会覆盖默认画风', p2.indexOf('my own style') >= 0 && p2.indexOf('soft watercolor texture') < 0);
}
section('生图契约: 蜕变提示词');
{
  const { api } = loadPetImage();
  const p = api.buildEvolvePrompt('a small white kitten', 'give it a grey patch over one eye');
  check('必须锁死"参考图里的同一只"', /SAME character from the reference image/.test(p));
  check('必须把【今天这身】写进去（以前收了 subject 却一次没用 → 小水壶永远画不出来）',
    /Redraw it exactly as described here: a small white kitten/.test(p), p);
  check('有具体改动时，写出那一处改动',
    /Additional detail to add: give it a grey patch over one eye/.test(p));
  check('仍然要 3×2 六格', /3 columns by 2 rows/.test(p));
  check('仍然要透明底', /transparent background/.test(p));

  // 每日换装（没有具体改动）→ 必须明确要求换上今天这身
  const p2 = api.buildEvolvePrompt('a chubby baby dragon with pastel pink fur, holding a tiny watering can', '');
  check('每日换装：提示词里必须出现那身衣服',
    p2.indexOf('holding a tiny watering can') >= 0, p2);
  check('每日换装：明确要求换上描述里那身',
    /Give it exactly the outfit and accessories described above/.test(p2));
  check('每日换装：不能再只让模型改一处（那样穿搭进不去）', !/ONLY this change/.test(p2));
}

// ============================================================
// ③ 通道读取
// ============================================================
section('通道读取');
{
  const { api, store } = loadPetImage();
  check('默认没配通道 → channelReady false', api.channelReady() === false);
  store.openaiCompatImageBaseUrl = 'https://example.com/v1';
  store.openaiCompatImageApiKey = 'sk-test';
  store.openaiCompatImageModel = 'gpt-image-1';
  check('三件套齐了 → channelReady true', api.channelReady() === true);
  store.openaiCompatImageBaseUrl = 'https://example.com/v1///';
  check('地址结尾多余的斜杠不影响可用性', api.channelReady() === true);
}

// ============================================================
// ④ 每日上限
// ============================================================
section('每日生图上限');
{
  const { api, store } = loadPetImage();
  check('默认今天已用 = 0', api.todayCount() === 0);
  store.petNestImageDailyDay = todayKey();
  store.petNestImageDailyCount = '2';
  check('当天已用 2 张 → todayCount = 2', api.todayCount() === 2);
  store.petNestImageDailyDay = yesterdayKey();
  check('换天了 → 计数归零', api.todayCount() === 0);
}
section('每日上限: 到顶必须拦下来');
{
  const { api, store } = loadPetImage();
  store.petNestImageDailyDay = todayKey();
  store.petNestImageDailyCount = '3';
  let msg = '';
  try { await api.generateAtlas('a kitten'); } catch (e) { msg = e.message || String(e); }
  check('generateAtlas 超额 → 报错说今天用完了', /今天生图次数用完了/.test(msg), msg);
  msg = '';
  try { await api.evolveAtlas('a kitten', 'a hat', { size: 1 }); } catch (e) { msg = e.message || String(e); }
  check('evolveAtlas 超额 → 同样拦下来', /今天生图次数用完了/.test(msg), msg);
}
section('每日上限: 蜕变必须有参考图');
{
  const { api, store } = loadPetImage();
  store.petNestImageDailyDay = todayKey();
  store.petNestImageDailyCount = '0';
  let msg = '';
  try { await api.evolveAtlas('a kitten', 'a hat', null); } catch (e) { msg = e.message || String(e); }
  check('没有参考图 → 明确报错', /没有参考图/.test(msg), msg);
}
section('每日上限: 自动换装和手动生图分开算（2026-10-27）');
{
  const { api, store } = loadPetImage();
  store.petNestImageDailyDay = todayKey();
  store.petNestImageDailyCount = '3';      // 手动已经用满 3 张
  store.petNestImageAutoDay = todayKey();
  store.petNestImageAutoCount = '1';      // 自动只用了 1 张
  check('手动计数 = 3', api.todayCount() === 3);
  check('自动计数 = 1（跟手动不是一个数）', api.todayCount('auto') === 1);

  let msg = '';
  try { await api.generateAtlas('a kitten'); } catch (e) { msg = e.message || String(e); }
  check('手动到顶 → 还是拦下来', /今天生图次数用完了/.test(msg), msg);

  msg = '';
  try { await api.generateAtlas('a kitten', { counter: 'auto', budget: 4 }); } catch (e) { msg = e.message || String(e); }
  check('自动换装有自己的名额（不被手动用满挡住）→ 走到发请求那一步',
    /还没配生图 API 地址/.test(msg), msg);

  store.petNestImageAutoCount = '4';
  msg = '';
  try { await api.generateAtlas('a kitten', { counter: 'auto', budget: 4 }); } catch (e) { msg = e.message || String(e); }
  check('自动名额也用满了 → 照样拦下来', /今天生图次数用完了/.test(msg), msg);
}

// ============================================================
// ⑤ 失败路径（没配通道）
// ============================================================
section('失败路径: 没配生图通道');
{
  const { api } = loadPetImage();
  let msg = '';
  try { await api.generateAtlas('a kitten'); } catch (e) { msg = e.message || String(e); }
  check('generateAtlas 报"还没配生图 API 地址"', /还没配生图 API 地址/.test(msg), msg);

  const report = await api.probe();
  check('probe 不抛异常，返回 ok=false', report && report.ok === false);
  check('probe 给出人话报错', /还没配生图通道/.test(report.error || ''), report.error);
  check('probe 带上通道快照（方便排查）', !!report.channel);
}
section('失败路径: injectSnapshot 没有落库通道');
{
  const { api } = loadPetImage();
  const r = await api.injectSnapshot({ id: 'c1' }, { name: '小花' }, 'asset-x');
  check('没有 messageStore → 返回 false 而不是崩', r === false);
}

// ============================================================
// ⑥ 抠图 cutout
// ============================================================
section('抠图: cutout');
{
  const { api } = loadPetImage();
  // cutout 是"原地改 alpha + 返回清掉的像素数"，不是返回新对象
  const img = makeImageData(40, 40, [250, 250, 250], [200, 40, 40], { x: 15, y: 15, w: 10, h: 10 });
  const cleared = api.cutout(img, 40);
  check('返回被抠掉的像素数', typeof cleared === 'number' && cleared > 0, String(cleared));
  check('背景被抠成全透明', alphaAt(img, 0, 0) === 0 && alphaAt(img, 39, 39) === 0,
    'corner=' + alphaAt(img, 0, 0));
  check('主体保留不透明', alphaAt(img, 20, 20) === 255, 'center=' + alphaAt(img, 20, 20));
  // ⚠️【2026-10-26 行为变更】老版本把「贴着背景的主体外圈」也一起抠掉（10x10 → 剩 8x8），
  //   那是老代码的副作用：它把「被检查过的像素」全标成 visited。
  //   现在只抠真正跟边缘连通的背景 → 主体整块保留，宠物不会凭空瘦一圈。
  check('主体整块保留（不再连外圈一起抠掉）', alphaAt(img, 15, 15) === 255, 'corner=' + alphaAt(img, 15, 15));
  check('主体外圈以内仍然不透明', alphaAt(img, 16, 16) === 255, 'inner=' + alphaAt(img, 16, 16));
  check('清掉的像素数 = 1600 - 100（40x40 减去 10x10 主体）', cleared === 1600 - 100, String(cleared));

  // 已知边界：主体颜色跟背景几乎一样时，抠图分不出 → 宁可不抠，也不把宠物抠没。
  // 老版本会把整张抠空（宠物直接消失）；现在安全网兜住 → 一张都不抠。
  const img2 = makeImageData(40, 40, [250, 250, 250], [252, 250, 250], { x: 15, y: 15, w: 10, h: 10 });
  const c2 = api.cutout(img2, 40);
  check('主体跟背景几乎同色 → 安全网兜住，一张都不抠（不崩）', c2 === 0, 'cleared=' + c2);
  check('同色情况下画面原样保留', alphaAt(img2, 0, 0) === 255 && alphaAt(img2, 20, 20) === 255,
    'corner=' + alphaAt(img2, 0, 0));
}
section('抠图: 背景色取样');
{
  const { api } = loadPetImage();
  // 宠物颜色不能被当成背景色收进去（按格处理时，格边有一截宠物 → 采样会采到它）
  const img = makeImageData(40, 40, [250, 250, 250], [200, 40, 40], { x: 15, y: 15, w: 10, h: 10 });
  const keys = api.findBackgroundColors(img.data, 40, 40, 3, 46 * 2.6, 0.02);
  check('主背景色被取到', keys.length >= 1 && keys[0].r > 240, JSON.stringify(keys.map(k => Math.round(k.r))));
  check('宠物颜色不会被当成背景色收进去',
    !keys.some(k => Math.abs(k.r - 200) < 12 && Math.abs(k.g - 40) < 12),
    JSON.stringify(keys.map(k => [Math.round(k.r), Math.round(k.g), Math.round(k.b)])));

  // 离主背景色太远的边缘色 → 不收（maxSpread）
  //   ⚠️ 这个「边缘色」必须真的在边上（宠物顶到边），否则边缘采样根本碰不到它，测不出差别
  const img2 = makeImageData(40, 40, [255, 255, 255], [200, 40, 40], { x: 30, y: 10, w: 10, h: 20 });
  const keys2 = api.findBackgroundColors(img2.data, 40, 40, 3, 30, 0);
  check('离主背景色太远的颜色不收进来', keys2.length === 1, '收了几种=' + keys2.length);
  const keys2b = api.findBackgroundColors(img2.data, 40, 40, 3, 999, 0);
  check('放宽远近限制后它就混进来了（证明这条规则真的在挡东西）', keys2b.length === 2,
    '收了几种=' + keys2b.length);

  // 边缘有一截宠物的抗锯齿过渡色 → 它离主背景色不算远，但只占细细一圈，
  //   按面积（minShare）要挡掉它，否则它会被当成背景色 → 宠物被当成背景抠光。
  const img3 = makeImageData(40, 40, [255, 255, 255], [255, 255, 255], null);
  for (let y = 0; y < 12; y++) {
    const i = ((y * 40) + 39) * 4;
    img3.data[i] = 162; img3.data[i + 1] = 185; img3.data[i + 2] = 232;   // 边缘过渡色
  }
  for (let y = 14; y < 26; y++) {
    for (let x = 30; x < 40; x++) {
      const i = ((y * 40) + x) * 4;
      img3.data[i] = 51; img3.data[i + 1] = 102; img3.data[i + 2] = 204;  // 宠物本体
    }
  }
  const keys3 = api.findBackgroundColors(img3.data, 40, 40, 3, 46 * 2.6, 0.02);
  check('面积太小的边缘过渡色不收进来（免得宠物被当成背景抠光）',
    !keys3.some(k => Math.abs(k.r - 162) < 20 && Math.abs(k.g - 185) < 20),
    JSON.stringify(keys3.map(k => [Math.round(k.r), Math.round(k.g), Math.round(k.b)])));
  const keys3b = api.findBackgroundColors(img3.data, 40, 40, 3, 46 * 2.6, 0);
  check('去掉面积限制后它就混进来了（证明这条规则真的在挡东西）',
    keys3b.some(k => Math.abs(k.r - 162) < 20 && Math.abs(k.g - 185) < 20),
    JSON.stringify(keys3b.map(k => [Math.round(k.r), Math.round(k.g), Math.round(k.b)])));
}
section('抠图: 本体保护（安全网不能靠画面百分比）');
{
  const { api } = loadPetImage();
  // 宠物只占画面 4% —— 老安全网（12% 底线）会误判成"啃宠物"→ 整遍回滚 → 一张都抠不掉
  const img = makeImageData(100, 100, [255, 255, 255], [40, 90, 220], { x: 40, y: 40, w: 20, h: 20 });
  const cleared = api.cutout(img, 46);
  check('宠物只占 4% 画面也照样抠得掉（不被百分比底线误杀）', cleared > 8000, 'cleared=' + cleared);
  check('小宠物本体完好', alphaAt(img, 50, 50) === 255, 'center=' + alphaAt(img, 50, 50));
  check('小宠物周围背景透明', alphaAt(img, 2, 2) === 0, 'corner=' + alphaAt(img, 2, 2));
}

// ============================================================
// ⑦ 羽化 feather
// ============================================================
section('羽化: feather');
{
  const { api } = loadPetImage();
  // 造一张「抠好的图」：外面透明，主体一圈是抗锯齿的过渡色（离背景色近）
  const img = makeImageData(20, 20, [0, 0, 0], [255, 255, 255], { x: 5, y: 5, w: 10, h: 10 });
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y * 20 + x) * 4;
      const inside = x >= 5 && x < 15 && y >= 5 && y < 15;
      const edge = inside && (x === 5 || x === 14 || y === 5 || y === 14);
      if (!inside) img.data[i + 3] = 0;
      else if (edge) { img.data[i] = 25; img.data[i + 1] = 25; img.data[i + 2] = 25; }
    }
  }
  check('准备: 主体中心不透明', alphaAt(img, 10, 10) === 255);
  check('准备: 主体外面透明', alphaAt(img, 0, 0) === 0);
  check('准备: 边缘是过渡色', img.data[((5 * 20 + 5) * 4)] === 25);

  // ⚠️【2026-10-26 行为变更】老做法是「贴着透明区的像素 alpha 写死 150 → 215」，
  //   现在改成「按这个像素离背景色有多远给软 alpha」+ 去色边：
  //     · 离背景色越近 → 越透明（过渡色就该软）
  //     · 明显是宠物本体（离背景色很远）→ 一律不动
  api.feather(img, 1, [{ r: 0, g: 0, b: 0 }]);
  check('羽化 1 遍：边缘过渡色变半透（143）', alphaAt(img, 5, 5) === 143, 'edge=' + alphaAt(img, 5, 5));
  check('羽化不碰主体内部（离背景色远 = 宠物本体）', alphaAt(img, 10, 10) === 255, 'center=' + alphaAt(img, 10, 10));
  check('羽化不碰本来就是透明的像素', alphaAt(img, 0, 0) === 0);
  check('羽化做了去色边（过渡色里的背景色被扣掉 → 变亮）',
    img.data[((5 * 20 + 5) * 4)] > 25, 'rgb=' + img.data[((5 * 20 + 5) * 4)]);

  api.feather(img, 2, [{ r: 0, g: 0, b: 0 }]);
  check('羽化 2 遍：只会更软，不会反弹（仍是 143）', alphaAt(img, 5, 5) === 143, 'edge=' + alphaAt(img, 5, 5));
  check('羽化 2 遍仍不碰主体内部', alphaAt(img, 10, 10) === 255);
}
section('羽化: 多色背景取最近的那一种算距离');
{
  const { api } = loadPetImage();
  const img = makeImageData(20, 20, [0, 0, 0], [255, 255, 255], { x: 5, y: 5, w: 10, h: 10 });
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y * 20 + x) * 4;
      const inside = x >= 5 && x < 15 && y >= 5 && y < 15;
      const edge = inside && (x === 5 || x === 14 || y === 5 || y === 14);
      if (!inside) img.data[i + 3] = 0;
      else if (edge) { img.data[i] = 25; img.data[i + 1] = 25; img.data[i + 2] = 25; }
    }
  }
  api.feather(img, 1, [{ r: 0, g: 0, b: 0 }, { r: 25, g: 25, b: 25 }]);
  check('离第二种背景色近的像素 → 几乎透明', alphaAt(img, 5, 5) <= 80, 'edge=' + alphaAt(img, 5, 5));
  check('主体内部照样不动', alphaAt(img, 10, 10) === 255);
}

// ============================================================
// ⑧ 六格图集：按格处理（用户 2026-10-26 实测「旁边残留的色块像另一只宠物的一部分」）
// ============================================================
section('图集: 按格处理');
{
  const { api } = loadPetImage();
  const W = 600, H = 400, CW = 200, CH = 200;

  // 造一张 3列×2行 的图集：白底 + 每格一只圆盘宠物 + 左边一小块「隔壁串过来的碎片」
  function makeAtlas(withFrag) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
    const put = (x, y, c) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    };
    const colors = [[204, 51, 51], [51, 170, 85], [51, 102, 204], [204, 51, 170], [170, 136, 0], [34, 170, 170]];
    for (let k = 0; k < 6; k++) {
      const col = k % 3, row = Math.floor(k / 3);
      const ox = col * CW, oy = row * CH;
      const c = colors[k];
      for (let y = 0; y < CH; y++) {
        for (let x = 0; x < CW; x++) {
          const dx = x - CW / 2 + 12, dy = y - CH / 2 - 8;   // 故意画偏，模拟 AI 没对齐
          if (dx * dx + dy * dy <= 60 * 60) put(ox + x, oy + y, c);
        }
      }
      if (withFrag) {
        // 隔壁格伸过来的尾巴毛：独立的一块，贴在本格左边
        for (let y = 100; y < 130; y++) for (let x = 8; x < 20; x++) put(ox + x, oy + y, c);
      }
    }
    return { data: data, width: W, height: H };
  }

  // 扫一格：有多少不透明像素、主体包围盒中心离格心多远
  function scanCell(img, col, row) {
    const ox = col * CW, oy = row * CH;
    let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const i = ((oy + y) * W + (ox + x)) * 4;
        if (img.data[i + 3] <= 16) continue;
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return {
      n: n,
      dx: maxX < 0 ? null : Math.round((minX + maxX + 1) / 2 - CW / 2),
      dy: maxY < 0 ? null : Math.round((minY + maxY + 1) / 2 - CH / 2)
    };
  }

  // 有碎片的图集
  const img = makeAtlas(true);
  const res = api.processAtlasCells(img, W, H, {
    cutout: true, colorKeys: 3, tolerance: 46, featherPasses: 2
  });
  check('按格处理返回统计', res && typeof res.cleared === 'number' && res.cellW === CW, JSON.stringify(res));
  check('收边确实切到了邻格越界的那一块（切图范围收小）', res.banded > 0, '切掉 ' + res.banded + ' 像素');

  // 干净的图集（没有碎片）先跑一遍，当基准
  const imgClean = makeAtlas(false);
  api.processAtlasCells(imgClean, W, H, {
    cutout: true, colorKeys: 3, tolerance: 46, featherPasses: 2
  });
  const base = [];
  for (let k = 0; k < 6; k++) base.push(scanCell(imgClean, k % 3, Math.floor(k / 3)));

  const cells = [];
  for (let k = 0; k < 6; k++) cells.push(scanCell(img, k % 3, Math.floor(k / 3)));
  check('六格宠物都还在（每格都有上千像素）', cells.every(c => c.n > 5000), JSON.stringify(cells.map(c => c.n)));
  // ⚠️ 必须跟「没有碎片时」一模一样 —— 碎片要是一个像素都不剩
  check('邻格串过来的碎片被删得一干二净（跟没有碎片时逐格一致）',
    cells.every((c, i) => c.n === base[i].n), JSON.stringify(cells.map((c, i) => c.n - base[i].n)));
  check('六格主体都被挪到格心（AI 没对齐也能摆正）',
    cells.every(c => Math.abs(c.dx) <= 3 && Math.abs(c.dy) <= 3),
    JSON.stringify(cells.map(c => [c.dx, c.dy])));

  // 边缘一圈必须是干净的（收边保险：切小一点，邻格越界的进不来）
  let edgeLeft = 0;
  for (let k = 0; k < 6; k++) {
    const col = k % 3, row = Math.floor(k / 3);
    const ox = col * CW, oy = row * CH;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < 6; x++) {
        const i = ((oy + y) * W + (ox + x)) * 4;
        if (img.data[i + 3] > 16) edgeLeft++;
      }
    }
  }
  check('每格最左边一条是透明的（邻格越界的进不来）', edgeLeft === 0, '残留 ' + edgeLeft + ' 像素');

  // 干净的图集（没有碎片）不能被弄坏
  const cells2 = base;
  check('干净图集：宠物面积跟有碎片时一致（没被误删）',
    cells2.every(c => c.n > 5000 && c.n < 12000), JSON.stringify(cells2.map(c => c.n)));
}

// ============================================================
// 汇总
// ============================================================
console.log('\n通过 ' + passed + ' / 失败 ' + failed);
if (failed > 0) {
  console.error('\n❌ 有 ' + failed + ' 条断言没过');
  process.exit(1);
} else {
  console.log('✅ 宠物屋生图模块全部断言通过');
}

})().catch((e) => {
  console.error('\n❌ 测试自身抛异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});

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
  check('每格必须正方形且填满', /SQUARE cells/.test(p) && /fully filled/.test(p));
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
  check('必须只做这一个改动', /ONLY this change/.test(p) && /give it a grey patch over one eye/.test(p));
  check('仍然要 3×2 六格', /3 columns by 2 rows/.test(p));
  check('仍然要透明底', /transparent background/.test(p));
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
  // 连通泛洪把"贴着背景的主体外圈"也标成 visited → 外圈 1 像素会跟着被抠掉。
  // 这是故意的：那一圈是抗锯齿的过渡像素，本来就该跟背景一起走。
  check('主体最外圈被一起抠掉（10x10 → 剩 8x8）', alphaAt(img, 15, 15) === 0, 'corner=' + alphaAt(img, 15, 15));
  check('主体外圈以内仍然不透明', alphaAt(img, 16, 16) === 255, 'inner=' + alphaAt(img, 16, 16));
  check('清掉的像素数 = 1600 - 64（40x40 减去 8x8 内芯）', cleared === 1600 - 64, String(cleared));

  // 已知边界：主体颜色跟背景几乎一样时，抠图分不出 → 整张被抠空。
  // 正常情况下通道直接给透明底，根本不会走抠图这条路（postprocess 会跳过）。
  const img2 = makeImageData(40, 40, [250, 250, 250], [252, 250, 250], { x: 15, y: 15, w: 10, h: 10 });
  const c2 = api.cutout(img2, 40);
  check('主体跟背景几乎同色 → 分不出来（已知边界，不崩）', c2 > 0 && alphaAt(img2, 0, 0) === 0, 'cleared=' + c2);
}

// ============================================================
// ⑦ 羽化 feather
// ============================================================
section('羽化: feather');
{
  const { api } = loadPetImage();
  const img = makeImageData(20, 20, [0, 0, 0], [255, 255, 255], { x: 5, y: 5, w: 10, h: 10 });
  // 先把主体外面清成透明，模拟"抠好的图"
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const inside = x >= 5 && x < 15 && y >= 5 && y < 15;
      if (!inside) img.data[((y * 20 + x) * 4) + 3] = 0;
    }
  }
  check('准备: 主体中心不透明', alphaAt(img, 10, 10) === 255);
  check('准备: 主体外面透明', alphaAt(img, 0, 0) === 0);

  api.feather(img, 1);
  check('羽化 1 遍 → 边缘变半透（150）', alphaAt(img, 5, 5) === 150, 'edge=' + alphaAt(img, 5, 5));
  check('羽化不碰主体内部', alphaAt(img, 10, 10) === 255);
  check('羽化不碰本来就是透明的像素', alphaAt(img, 0, 0) === 0);

  api.feather(img, 2);
  check('羽化 2 遍 → 边缘更软（215）', alphaAt(img, 5, 5) === 215, 'edge=' + alphaAt(img, 5, 5));
  check('羽化 2 遍仍不碰主体内部', alphaAt(img, 10, 10) === 255);
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

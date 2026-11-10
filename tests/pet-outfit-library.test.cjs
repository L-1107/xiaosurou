// ============================================================
// tests/pet-outfit-library.test.cjs
// 宠物屋「服装库重做」这一轮的回归测试
//
// 跑法: node tests/pet-outfit-library.test.cjs
//
// 【守什么】用户 2026-10-28 原话：
//   「我刚看宠物的服饰描述，什么磨刀石，白手套都来了，这个服装系统到底都有些什么衣服，
//     能不能搞点炫丽可爱的服装库，像奇迹暖暖那样的娃衣一堆堆，一天一个造型？」
//
//   守四件事：
//     ① 衣服库够大、分成 6 个系列（甜品/童话/星际/国风/海洋/魔法萌），每件都有画面描述
//     ② 没聊东西的日子 → 衣服和道具【同一个系列】（暖暖式套装）
//     ③ 聊了东西的日子 → 道具仍然【跟着记忆走】（不能被套装盖掉，用户明确要的）
//     ④ 衣服和道具不能是同一件东西（"一双水晶鞋、提着水晶鞋的"）
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

function loadRules() {
  const src = read('modules/pet-nest.js');
  const store = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    crypto: { randomUUID: () => 'test-uuid-0000' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    Blob,
    btoa,
    atob,
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: () => []
    },
    Dexie: function () { throw new Error('规则测试不该碰 Dexie'); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'pet-nest.js' });
  if (!sandbox.window.PetNest || !sandbox.window.PetNest.rules) {
    throw new Error('pet-nest.js 没暴露 window.PetNest.rules');
  }
  return sandbox.window.PetNest.rules;
}

const day = '2026-10-28';
const todayLookCn = (lk) => {
  const parts = [];
  for (const i of (lk && lk.icons) || []) parts.push(i.cn);
  for (const f of (lk && lk.features) || []) parts.push(f.cn);
  if (lk && lk.outfit) parts.push(lk.outfit.cn);
  if (!parts.length) return '';
  const head = parts.join('、');
  return /的$/.test(head) ? head : head + '的';
};

// ============================================================
// ① 衣服库
// ============================================================
section('① 衣服库：一堆堆的娃衣');
{
  const R = loadRules();
  const O = R.BEAST_OUTFITS;
  check('衣服库 ≥ 60 件（原来只有 20 件 → 平均每 10 只撞一件）',
    O.length >= 60, O.length + ' 件');

  const cns = O.map(o => o.cn);
  check('每件衣服都有中文名', O.every(o => o.cn && o.cn.length >= 3));
  check('每件衣服都有英文画面描述（生图靠它，写笼统就画不出来）',
    O.every(o => o.en && o.en.length >= 12));
  check('中文名不重复', new Set(cns).size === O.length,
    O.length + ' 件 / ' + new Set(cns).size + ' 个不同名');
  check('中文名全部以「的」结尾（不然会拼出「的的」）',
    O.every(o => /的$/.test(o.cn)),
    O.filter(o => !/的$/.test(o.cn)).map(o => o.cn).join('/') || '全部合格');
  check('英文描述都是英文（生图提示词必须全英文）',
    O.every(o => /^[\x20-\x7E]+$/.test(o.en)));

  // 系列
  const series = {};
  for (const o of O) series[o.series] = (series[o.series] || 0) + 1;
  const sKeys = Object.keys(series);
  check('衣服分成 6 个系列（甜品/童话/星际/国风/海洋/魔法萌）',
    sKeys.length === 6, JSON.stringify(series));
  check('每个系列 ≥ 10 件', sKeys.every(k => series[k] >= 10), JSON.stringify(series));

  // 每件单独用一次都不能拼出「的的」
  const bad = O.filter(o => {
    const n = R.beastDisplayName({ beastSpecies: '奶龙', palette: '粉红' },
      { features: [], icons: [], outfit: o });
    return n.indexOf('的的') >= 0;
  });
  check('全部衣服逐个试都不会拼出「的的」', bad.length === 0,
    bad.map(o => o.cn).join('/') || O.length + ' 件全过');
}

// ============================================================
// ② 道具库
// ============================================================
section('② 道具库：华丽款单独一批');
{
  const R = loadRules();
  const D = R.DAILY_ICONS || [];
  check('每日造型道具 ≥ 30 件（"一堆堆"）', D.length >= 30, D.length + ' 件');
  check('每件都有系列标签（用来跟衣服配套）', D.every(x => !!x.series));
  check('每件都有画面描述', D.every(x => x.en && x.en.length >= 10));
  check('每件都有关键词（不然永远挑不出来）',
    D.every(x => Array.isArray(x.keys) && x.keys.length));
  check('道具中文名不重复',
    new Set(D.map(x => x.cn)).size === D.length, D.length + ' 件');

  // 每个衣服系列都要有配套道具（不然"配套"会落空）
  const seriesSet = new Set(R.BEAST_OUTFITS.map(o => o.series));
  const noProp = [...seriesSet].filter(s => !D.some(x => x.series === s));
  check('每个衣服系列都至少有一件配套道具', noProp.length === 0,
    noProp.join('/') || [...seriesSet].join('/'));

  // 旧的日常道具不再当"每日造型"用
  const OLD_DAILY = ['一块小磨刀石', '一块小砖头', '一枚小印章', '一只小碗', '一枚小硬币', '一把小梳子'];
  const leaked = OLD_DAILY.filter(cn => D.some(x => x.cn === cn));
  check('磨刀石/砖头/印章这类日常杂物不在每日造型池里',
    leaked.length === 0, leaked.join('/') || '已排除');
}

// ============================================================
// ③ 兜底：衣服和道具配套
// ============================================================
section('③ 没聊东西的日子 → 衣服和道具同一系列');
{
  const R = loadRules();
  let paired = 0, total = 0;
  for (let i = 0; i < 200; i++) {
    const lk = R.dailyLookFor([], day, 'seed-' + i, []);
    if (!lk.outfit || !lk.icons[0]) continue;
    total++;
    if (lk.icons[0].series && lk.icons[0].series === lk.outfit.series) paired++;
  }
  check('200 只宠物里衣服+道具同系列的比例 ≥ 95%',
    paired / total >= 0.95, paired + '/' + total);

  // 旧日常道具不该再出现
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const lk = R.dailyLookFor([], day, 'seed-' + i, []);
    if (lk.icons[0]) seen.add(lk.icons[0].cn);
  }
  const junk = ['一块小磨刀石', '一块小砖头', '一枚小印章', '一只小碗', '一枚小硬币', '一把小梳子', '一根小天线'];
  const leaked = junk.filter(cn => seen.has(cn));
  check('兜底时不再挑出磨刀石/砖头/印章这类（用户 2026-10-28 反馈）',
    leaked.length === 0, leaked.join('/') || '一次都没出现');
}

// ============================================================
// ④ 记忆匹配仍然优先
// ============================================================
section('④ 聊了东西的日子 → 道具跟着记忆走（不能被套装盖掉）');
{
  const R = loadRules();
  const cases = [
    ['今天去喝了一杯拿铁咖啡', /热饮|咖啡/],
    ['今天过生日，收了好多礼物', /气球/],
    ['今天在看一本小说', /书/],
    ['今天下雨了，没带伞', /伞/],
    ['今天拍了好多照片', /相机/]
  ];
  for (const [text, re] of cases) {
    const lk = R.dailyLookFor([], day, 'seed-x-' + text.length, [text]);
    const cn = (lk.icons[0] || {}).cn || '(空)';
    check('「' + text + '」→ 道具跟着内容走',
      re.test(cn), cn);
  }
  // 记忆匹配到的道具不该带 series（那是每日造型专用）
  const lk = R.dailyLookFor([], day, 'seed-m', ['今天去喝了一杯拿铁咖啡']);
  check('记忆匹配到的道具是"日常道具"，不是每日造型池里的',
    !(lk.icons[0] && lk.icons[0].daily), (lk.icons[0] || {}).cn);
}

// ============================================================
// ⑤ 衣服和道具不能是同一件东西
// ============================================================
section('⑤ 衣服和道具别撞同一件');
{
  const R = loadRules();
  const dup = [];
  for (let i = 0; i < 400; i++) {
    const lk = R.dailyLookFor([], day, 'seed-' + i, []);
    if (lk.outfit && lk.icons[0] && R.sameItem(lk.outfit, lk.icons[0])) {
      dup.push(todayLookCn(lk));
    }
  }
  check('400 只宠物（无记忆）里没有"衣服和道具是同一件"',
    dup.length === 0, dup.slice(0, 3).join(' | ') || '0 次');

  const dup2 = [];
  const MEM = ['今天去喝了一杯拿铁咖啡', '今天过生日', '今天看了一本小说', '今天下雨了',
    '今天拍了好多照片', '今天在公园散步看到落叶'];
  for (let i = 0; i < 400; i++) {
    const lk = R.dailyLookFor([], day, 'seed-' + i, [MEM[i % MEM.length]]);
    if (lk.outfit && lk.icons[0] && R.sameItem(lk.outfit, lk.icons[0])) {
      dup2.push(todayLookCn(lk));
    }
  }
  check('400 只宠物（有记忆）里也没有"衣服和道具是同一件"',
    dup2.length === 0, dup2.slice(0, 3).join(' | ') || '0 次');

  // sameItem 本身要能认出"同一件"（含中文不同名的）
  const outfit = R.BEAST_OUTFITS.find(o => o.cn === '提着水晶鞋的');
  const icon = R.ICON_LIBRARY.find(x => x.cn === '一双水晶鞋');
  check('sameItem 能认出"提着水晶鞋"和"一双水晶鞋"是同一件',
    !!(outfit && icon && R.sameItem(outfit, icon)));
}

// ============================================================
// ⑥ 分布：够散 + 连着几天不重样
// ============================================================
section('⑥ 分布：够散，别天天撞');
{
  const R = loadRules();
  const occ = {};
  for (let i = 0; i < 200; i++) {
    const lk = R.dailyLookFor([], day, 'seed-' + i, []);
    occ[lk.outfit.cn] = (occ[lk.outfit.cn] || 0) + 1;
  }
  const kinds = Object.keys(occ).length;
  const hottest = Math.max.apply(null, Object.values(occ));
  check('200 只宠物用到的衣服 ≥ 40 种（原来 20 种全用满）',
    kinds >= 40, kinds + ' 种');
  check('最热的一件 ≤ 15/200（原来 16/200）',
    hottest <= 15, hottest + '/200');

  // 同一只宠物连着三天
  let sameDay = 0, checked = 0;
  for (let i = 0; i < 60; i++) {
    const seed = 'seed-' + i;
    const a = R.dailyLookFor([], '2026-10-26', seed, []).outfit.cn;
    const b = R.dailyLookFor([], '2026-10-27', seed, []).outfit.cn;
    const c = R.dailyLookFor([], '2026-10-28', seed, []).outfit.cn;
    checked++;
    if (a === b || b === c || a === c) sameDay++;
  }
  check('60 只宠物连着三天基本不重样（≤ 6 只撞上）',
    sameDay <= 6, sameDay + '/' + checked + ' 撞上');
}

// ============================================================
// ⑦ 源码级：兜底只从"每日造型池"里挑
// ============================================================
section('⑦ 源码接线');
{
  const src = read('modules/pet-nest.js');
  check('有 DAILY_ICONS（每日造型道具池）', /const DAILY_ICONS = ICON_LIBRARY\.filter\(/.test(src));
  check('兜底挑道具时用的是 DAILY_ICONS，不是整个 ICON_LIBRARY',
    /DAILY_ICONS\.filter\(/.test(src));
  check('兜底按【衣服的系列】挑（配套）',
    /x\.series === \(outfit && outfit\.series\)/.test(src));
  check('有 sameItem（排除同一件）', /function sameItem\(/.test(src));
  check('记忆匹配优先那段没被改掉',
    /let icons = pickIconsFromText\(/.test(src));
  const R2 = loadRules();
  check('衣服库是 72 件（不是 20）', R2.BEAST_OUTFITS.length === 72, R2.BEAST_OUTFITS.length + ' 件');
  // ⚠️【2026-10-29】鹦鹉有自己的一套 (PARROT_OUTFITS 24 件) → 总数 112 → 136
  const seriesCount = (src.match(/series: '(sweet|fairy|galaxy|oriental|ocean|magic)'/g) || []).length;
  const expectTotal = 72 + (R2.PARROT_OUTFITS ? R2.PARROT_OUTFITS.length : 0) + 40;
  check('带系列标记的共 72 衣服 + ' + (R2.PARROT_OUTFITS ? R2.PARROT_OUTFITS.length : 0) +
    ' 鹦鹉衣服 + 40 道具 = ' + expectTotal + ' 条',
    seriesCount === expectTotal, seriesCount + ' 条');
  check('鹦鹉衣橱是 24 件（鸟穿得上的衣服）',
    (R2.PARROT_OUTFITS || []).length === 24,
    (R2.PARROT_OUTFITS || []).length + ' 件');
}

// ============================================================
// ⑧ 蜕变时的配色：别再写死盲盒配色（用户 2026-10-28：玫红色想保持住）
// ============================================================
section('⑧ 生图配色：有参考图就跟参考图走');
{
  const R = loadRules();
  const app = {
    beastSpecies: '九尾狐',
    beastSpeciesEn: 'a fluffy fox spirit with nine tiny ribbon-like tails',
    beastPaletteEn: 'deep berry purple',   // ← 莓紫，盲盒抽到的
    palette: '莓紫'
  };
  const lk = R.dailyLookFor([], '2026-10-28', 'seed-x', []);
  const mark = 'a soft heart-shaped tuft on the chest';
  const keep = R.beastPrompt(app, lk, mark, true);
  const write = R.beastPrompt(app, lk, mark, false);
  check('蜕变时不再写死盲盒配色（否则每次都被拉回紫黑，跟参考图打架）',
    keep.indexOf('deep berry purple') < 0, keep.slice(0, 90));
  check('蜕变时改成「跟参考图同一个颜色」',
    keep.indexOf('same colours as the reference image') >= 0);
  check('首次生成（没有参考图）照旧写盲盒配色',
    write.indexOf('deep berry purple') >= 0, write.slice(0, 90));

  const pet = {
    id: 'p1', kind: 'egg', stage: 1, seed: 'seed-x',
    appearance: {
      kind: 'fantasy', identity: '九尾狐', palette: '莓紫',
      beastSpecies: '九尾狐', beastSpeciesEn: app.beastSpeciesEn,
      beastPaletteEn: 'deep berry purple', markEn: mark
    }
  };
  const s1 = R.subjectForPet(pet, lk, { keepColors: false });
  const s2 = R.subjectForPet(pet, lk, { keepColors: true });
  check('subjectForPet：keepColors=false → 写死配色',
    s1.indexOf('deep berry purple') >= 0, s1.slice(0, 90));
  check('subjectForPet：keepColors=true → 不写死配色（玫红能留住）',
    s2.indexOf('deep berry purple') < 0, s2.slice(0, 90));

  const src = read('modules/pet-nest.js');
  const iRef = src.indexOf('if (row.assetRef)');
  const iSub = src.indexOf('const subject = subjectForPet(');
  check('提示词是在【拿到参考图之后】才拼的（不然不知道该不该写死配色）',
    iRef >= 0 && iSub > iRef, 'ref@' + iRef + ' subject@' + iSub);
  check('有参考图 → keepColors 传 true',
    /subjectForPet\(row, await buildTodayLook\(row\), \{ keepColors: !!refBlob \}\)/.test(src));
  check('beastPrompt 有 keepColors 这个开关',
    /function beastPrompt\(app, look, markEn, keepColors\)/.test(src));
  // ⚠️ 要在【beastPrompt 函数体内】找 —— 鹦鹉分支里也有同一句字符串，
  //   全局搜会被凑巧匹配上（第一版就栽在这）。
  const fnStart = src.indexOf('function beastPrompt(');
  const fnEnd = src.indexOf('\n  }', fnStart);
  const fnBody = fnStart >= 0 ? src.slice(fnStart, fnEnd) : '';
  check('beastPrompt 里真的按 keepColors 分支写配色（不是只挂了个参数）',
    fnBody.indexOf('keepColors') >= 0
    && fnBody.indexOf('same colours as the reference image') >= 0);
}

console.log('\n通过 ' + passed + ' / 失败 ' + failed);
if (failed > 0) {
  console.error('\n✗ 有 ' + failed + ' 条断言没过');
  process.exit(1);
} else {
  console.log('✓ 服装库重做 全部通过');
}

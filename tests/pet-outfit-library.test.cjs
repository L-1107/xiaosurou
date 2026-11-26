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
  for (const i of (lk && lk.icons) || []) parts.push((i.hold || '') + i.cn);
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
  // ⚠️【2026-11-26】服饰改成【整套】后，水晶鞋那一条的写法变成
  //   「穿着水晶鞋、披着蕾丝小披肩和戴着小圆帽的」
  const outfit = R.BEAST_OUTFITS.find(o => o.cn.indexOf('穿着水晶鞋、') === 0);
  const icon = R.ICON_LIBRARY.find(x => x.cn === '一双水晶鞋');
  check('sameItem 能认出"穿着水晶鞋"和"一双水晶鞋"是同一件',
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
  // ⚠️【2026-11-26 用户提】「衣服你扩充一些适合小朋友穿的服装」
  //   → 幻兽衣服 72 → 96（6 系列各 16 件），鹦鹉衣橱 24 → 28
  check('衣服库是 96 件（娃衣扩充，2026-11-26）', R2.BEAST_OUTFITS.length === 96, R2.BEAST_OUTFITS.length + ' 件');
  // ⚠️【2026-10-29】鹦鹉有自己的一套 (PARROT_OUTFITS 28 件) → 总数 124 → 164
  const seriesCount = (src.match(/series: '(sweet|fairy|galaxy|oriental|ocean|magic)'/g) || []).length;
  const expectTotal = 96 + (R2.PARROT_OUTFITS ? R2.PARROT_OUTFITS.length : 0) + 40;
  check('带系列标记的共 96 衣服 + ' + (R2.PARROT_OUTFITS ? R2.PARROT_OUTFITS.length : 0) +
    ' 鹦鹉衣服 + 40 道具 = ' + expectTotal + ' 条',
    seriesCount === expectTotal, seriesCount + ' 条');
  check('鹦鹉衣橱是 28 件（鸟穿得上的衣服）',
    (R2.PARROT_OUTFITS || []).length === 28,
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

// ============================================================
// ⑨ 句子通顺（用户 2026-11-26 反馈）
//   原话：「什么叫奶咖一串小音符，头顶小行星？句子都不通顺，
//     如果音符是道具，那应该描述道具怎么拿，后面小行星感觉属于服饰类，
//     服饰就全部用衣服，不要搞乱七八糟的东西」
//   守三件事：
//     ① 服饰里只放【穿在身上的衣服】——不许再有"举着月牙灯""头顶小行星"
//     ② 每件道具都要说清【怎么拿】（"头顶飘着一串小音符"）
//     ③ 配色跟【物种】走，不能跟道具粘一起（"奶咖一串小音符"）
// ============================================================
section('⑨ 句子通顺：衣服是衣服，道具说清怎么拿，配色跟物种走');
{
  const R = loadRules();
  const O = R.BEAST_OUTFITS.concat(R.PARROT_OUTFITS || []);

  // ① 服饰里不许有"手里拿着的东西"
  const HOLD_VERBS = ['捧着', '抱着', '提着', '举着', '撑着', '端着', '拎着', '攥着'];
  const held = O.filter(o => HOLD_VERBS.some(v => o.cn.indexOf(v) >= 0));
  check('服饰里没有「手里拿着的东西」（捧着/抱着/提着/举着…）',
    held.length === 0, held.map(o => o.cn).join('/') || (O.length + ' 件全是穿在身上的'));

  // ① 每件服饰都得是"穿戴类"的动词
  const WORN = ['穿', '戴', '披', '系', '围', '套', '着', '裹', '簪', '背', '顶', '拖', '别', '肩', '挂'];
  const notWorn = O.filter(o => !WORN.some(v => o.cn.indexOf(v) >= 0));
  check('每件服饰都是穿戴类的（衣/帽/围巾/斗篷/连体衣…）',
    notWorn.length === 0, notWorn.map(o => o.cn).join('/') || '全部合格');

  // ② 道具必须说清怎么拿
  const icons = {};
  for (const x of (R.ICON_LIBRARY || [])) icons[x.cn] = x;
  for (const x of (R.DAILY_ICONS || [])) icons[x.cn] = x;
  const noHold = Object.keys(icons).filter(cn => !icons[cn].hold);
  check('每件道具都写了「怎么拿」（hold）',
    noHold.length === 0, noHold.join('/') || (Object.keys(icons).length + ' 件全有'));

  const lk = R.dailyLookFor([], day, 'seed-look-cn', ['今天听了一首歌']);
  const lookCn = R.todayLookCn(lk);
  check('道具的说法带上了动作（不是光秃秃一个名字）',
    lookCn.indexOf(R.iconCn(lk.icons[0])) >= 0 && R.iconCn(lk.icons[0]) !== lk.icons[0].cn,
    lookCn);

  // ③ 配色跟物种走，不能跟道具粘一起
  const name = R.beastDisplayName(
    { beastSpecies: '霸下', palette: '奶咖' },
    { features: [], icons: [{ cn: '一串小音符', hold: '头顶飘着' }], outfit: { cn: '穿着草莓裙的' } }
  );
  check('配色跟物种走，不再出现「奶咖一串小音符」',
    name.indexOf('奶咖色霸下') >= 0 && name.indexOf('奶咖一串') < 0, name);
  check('整句话读得通（主体 → 拿/背/戴道具 → 穿衣服）',
    name === '奶咖色霸下，头顶飘着一串小音符，穿着草莓裙', name);

  // ④ 生图提示词的结构：主体+配色 → 动词道具 → 穿着衣服
  const app = {
    beastSpecies: '霸下', beastSpeciesEn: 'a stout baby turtle-dragon',
    beastPaletteEn: 'milky coffee brown'
  };
  const lk2 = { features: [], icons: [{ cn: '一串小音符', hold: '头顶飘着', en: 'a few tiny music notes floating above its head' }], outfit: { cn: '穿着草莓裙的', en: 'wearing a red strawberry dress' } };
  const prompt = R.beastPrompt(app, lk2, '', false);
  check('生图提示词：主体和配色在前面',
    prompt.indexOf('a stout baby turtle-dragon with milky coffee brown fur') >= 0, prompt);
  check('生图提示词：道具带着动作（拿/背/戴）',
    prompt.indexOf('a few tiny music notes floating above its head') >= 0, prompt);
  check('生图提示词：衣服用 wearing',
    prompt.indexOf('wearing a red strawberry dress') >= 0, prompt);
  check('生图提示词：道具在衣服前面',
    prompt.indexOf('floating above its head') < prompt.indexOf('wearing a red strawberry dress'), prompt);

  // ⑤ 衣服库里不许再有「小行星」这类抽象装饰（用户 2026-11-26：「不要小行星之类的抽象玩意儿」）
  const ABSTRACT = ['小行星', '行星', '彗星', '光环', '光球', '光晕', '流星徽章', '水母灯', '陨石', '许愿星', '粉钻'];
  const abstractOnes = O.filter(o => ABSTRACT.some(w => o.cn.indexOf(w) >= 0));
  check('衣服里没有抽象装饰（小行星/彗星/光环…）',
    abstractOnes.length === 0, abstractOnes.map(o => o.cn).join('/') || '96 件全是真衣服');

  // ⑥ 每件衣服的英文都要以【穿戴动词】开头（wearing/carrying/draped/wrapped）
  const WRON = ['wearing', 'carrying', 'draped', 'wrapped'];
  const noVerb = O.filter(o => !WRON.some(v => o.en.indexOf(v) === 0));
  check('每件衣服的英文都以穿戴动词开头',
    noVerb.length === 0, noVerb.map(o => o.cn + '→' + o.en).join('/') || '全部合格');

  // ⑦ 娃衣扩充：每个系列都该有「小朋友穿」的款（背带裤/围兜/小衬衫/睡衣…）
  const KID = ['背带', '围兜', '衬衫', '睡衣', '围裙', '背带裤', '小雨衣', '棉袄', '小肚兜', '凉鞋', '背心', '雨衣'];
  const kidCount = O.filter(o => KID.some(w => o.cn.indexOf(w) >= 0)).length;
  check('衣服库里有成套的「小朋友款」（背带裤/围兜/小衬衫/睡衣…）',
    kidCount >= 12, kidCount + ' 件');
}

// ============================================================
// ⑩ 服饰必须是【一整套】，不是单品（用户 2026-11-26 二次反馈）
//   原话：「小手套，小腰带这些不叫衣服吧？把单品剔除去，都能整件搭配的要」
//   守三件事：
//     ① 每条服饰都是【整套】（至少 2 件）—— 单品（小手套/小腰带）不准单独成条
//     ② 幻兽每条里都得有一件【整件衣服】（裙/连体衣/上衣…），不能全是小配件
//     ③ 衣服仍然不许是"手里拿着的东西"、不许是抽象装饰
// ============================================================
section('⑩ 服饰是整套，不是单品');
{
  const R = loadRules();
  const O = R.BEAST_OUTFITS.concat(R.PARROT_OUTFITS || []);
  const BEAST = R.BEAST_OUTFITS || [];

  // ① 整套 = 至少 2 件
  const single = O.filter(o => (o.cn.match(/、/g) || []).length < 1);
  check('每条服饰都是一整套（至少 2 件，不许只有一个小配件）',
    single.length === 0, single.map(o => o.cn).join('/') || (O.length + ' 条全是整套'));

  // ② 幻兽每条里要有一件【整件衣服】
  const GARMENT = ['裙', '连体', '裤', '毛衣', '衬衫', '卫衣', '背心', '开衫', '小褂', '马甲',
    '棉袄', '睡衣', '浴袍', '雨衣', '泳衣', '汉服', '旗袍', '斗篷', '披肩', '披帛', '罩衫',
    '大褂', '围裙', '围兜', '肚兜', '上衣', '外套', '披风', '洋装', '小衫', '对襟', '袍',
    '褙子', '袄', '套装', '背心裙'];
  const noGarment = BEAST.filter(o => !GARMENT.some(w => o.cn.indexOf(w) >= 0));
  check('幻兽每条服饰里都有一件整件衣服（不能全是小配件）',
    noGarment.length === 0, noGarment.map(o => o.cn).join('/') || '96 条都带整件衣服');

  // ③ 单品词不许【单独】当一身：手套/腰带/发夹/项链/耳环/胸针/手镯/发箍 不能当主体
  const ONLY_ACC = ['手套', '腰带', '发夹', '项链', '耳环', '胸针', '手镯', '发箍', '发带', '戒指'];
  const accOnly = BEAST.filter(o => {
    const hasGarment = GARMENT.some(w => o.cn.indexOf(w) >= 0);
    return !hasGarment && ONLY_ACC.some(w => o.cn.indexOf(w) >= 0);
  });
  check('手套/腰带/发夹这类单品不会再单独当一身衣服',
    accOnly.length === 0, accOnly.map(o => o.cn).join('/') || '没有单品成条');

  // ④ 英文描述也要是整套（逗号分隔的 2~3 件）
  const onePiece = O.filter(o => (o.en.match(/,/g) || []).length < 1);
  check('英文描述也是整套（2~3 件，不是单件）',
    onePiece.length === 0, onePiece.map(o => o.cn).join('/') || '全部是整套');

  // ⑤ 整句只能有一个「的」，而且必须收在最后
  //    （踩过：「套着白色小袜子的和穿着小黄靴的」——「的」跑到中间，读着断气）
  const deBad = O.filter(o => o.cn.split('的').length - 1 !== 1 || !/的$/.test(o.cn));
  check('每条服饰整句只有一个「的」且收在最后',
    deBad.length === 0, deBad.map(o => o.cn).join('/') || '124 条全合格');

  // ⑥ 鹦鹉没有爪子 → 中文道具说法也得用喙（英文那支早就换成 beak 了）
  const pawLeft = (R.ICON_LIBRARY || []).filter(x => R.iconCn(x, 'parrot').indexOf('爪') >= 0);
  check('鹦鹉的道具说法里没有爪子（改成喙）',
    pawLeft.length === 0, pawLeft.map(x => x.cn).join('/') || '83 件全是喙/头/身/尾');
}

console.log('\n通过 ' + passed + ' / 失败 ' + failed);
if (failed > 0) {
  console.error('\n✗ 有 ' + failed + ' 条断言没过');
  process.exit(1);
} else {
  console.log('✓ 服装库重做 全部通过');
}

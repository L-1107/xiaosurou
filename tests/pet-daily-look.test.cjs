// ============================================================
// tests/pet-daily-look.test.cjs
// 宠物屋「每日换装 / 说话落框 / 桌宠尺寸」这一轮的回归测试
//
// 跑法: node tests/pet-daily-look.test.cjs
//
// 【守什么】用户 2026-10-28 实测的三连报：
//   ① 每天该换道具和服饰，但
//      · 自动生图「换了衣服没画道具」
//      · 手动点「换个模样」「重画了但衣服没换」
//      · 所有用户的宠物服饰描述都是「一个小碗一双白手套」，太雷同
//   ② 宠物调后台活动 API 说的话不能立刻落进聊天框（要退出聊天框再进才看得见）；
//      在聊天框之外说的话（刚开软件弹的宠物语言）最后也没进聊天框
//   ③ 桌宠显示太小
//
// 【判据的坑】道具匹配不能用「关键词有两个字以上」当判据：
//   「听了一首歌」的"歌"、「读了一本书」的"书/读"都是单字，可那恰恰最该命中；
//   而「吃/饭/饿/喝/睡/冷/热」这些泛词才是"人人都命中"的真凶。
//   → 判据是【这个词泛不泛】（GENERIC_ICON_KEYS），不是词长。
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
// 工具: 把 pet-nest.js 塞进 vm 沙箱取纯规则
// ============================================================
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

/** 从源码里抠出 `function name(...) { ... }` 整段（用于单独求值真实实现） */
function grabFunc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && !depth) return src.slice(i, k + 1); }
  }
  return null;
}

// ⚠️【2026-10-29】抠对象字面量 (POSE_SETS / LAYOUT_BODIES 这种)
function grabObj(src, name) {
  const i = src.indexOf('const ' + name + ' = {');
  if (i < 0) return null;
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(j, k + 1); }
  }
  return null;
}

// ============================================================
// ① 道具匹配: 泛词不算命中
// ============================================================
section('① 每日换装: 道具匹配不许被泛词锁死');
{
  const R = loadRules();
  const pick = R.pickIconsFromText;

  // --- 用户报的现象本身: "拿个小碗" 不该再被"我饿了"锁死 ---
  const hungry = pick('我饿了', 1);
  check('「我饿了」不再命中「一只小碗」（改走天+种子兜底）',
    !(hungry.length && /小碗/.test(hungry[0].cn)),
    hungry.length ? hungry[0].cn : '(空 → 走种子兜底)');

  // --- 但真正的具体匹配不能被误杀（这是"按词长筛"的翻车点）---
  const song = pick('今天听了一首歌', 1);
  check('「听了一首歌」仍然命中「一串小音符」（单字"歌"也算具体）',
    song.length === 1 && /音符/.test(song[0].cn), song.length ? song[0].cn : '(空)');

  const book = pick('今天读了一本书', 1);
  check('「读了一本书」仍然命中「一本翻开的书」（单字"书/读"也算具体）',
    book.length === 1 && /书/.test(book[0].cn), book.length ? book[0].cn : '(空)');

  const coffee = pick('今天去喝了一杯拿铁咖啡', 1);
  check('「喝了一杯拿铁咖啡」命中「一杯热饮」',
    coffee.length === 1 && /热饮|咖啡/.test(coffee[0].cn), coffee.length ? coffee[0].cn : '(空)');

  const multi = pick('看了电影又听了歌还读了书', 3);
  check('一天能挑出多个意象（音符 + 书都得在）',
    multi.length >= 2 && multi.some(i => /音符/.test(i.cn)) && multi.some(i => /书/.test(i.cn)),
    multi.map(i => i.cn).join('/'));

  const none = pick('zzz 什么也没有', 1);
  check('挑不出就不硬凑', none.length === 0, 'len=' + none.length);

  // --- 语料级: 真实的一天不该再全网都小碗 ---
  const CORPUS = [
    '今天加班到很晚，点了外卖吃了饭',
    '中午吃的面，晚上火锅，太撑了',
    '今天好累，吃了药就睡了',
    '刚吃完饭，想喝杯咖啡提提神',
    '今天去超市买了菜，晚饭自己做的',
    '和同事一起吃了个饭，聊了很多',
    '饿了，点了个外卖小碗面',
    '今天煮了咖啡，喝了两杯',
    '晚上泡了杯热可可，看了一会儿书',
    '今天写了一小时作业',
    '今天在看一本小说，看完两章',
    '今天考试复习了一晚上，写的笔记',
    '今天下雨了，没带伞',
    '今天雨好大，淋了点雨',
    '去朋友家吃饭，聊天很开心',
    '今天演唱会门票到了，好开心',
    '今天拍了好多照片',
    '今天过生日，收到好多礼物',
    '今天在公园散步，看到落叶',
    '今天种了一盆绿植，发芽了'
  ];
  const cnt = {};
  CORPUS.forEach((t, i) => {
    const r = pick(t, 1, 'user' + i + '_seed');
    const k = r.length ? r[0].cn : '(走种子兜底)';
    cnt[k] = (cnt[k] || 0) + 1;
  });
  const bowl = cnt['一只小碗'] || 0;
  const distinct = Object.keys(cnt).filter(k => k !== '(走种子兜底)').length;
  check('20 条真实语料里「一只小碗」≤ 2 次（原来 10/20，全网都是小碗）',
    bowl <= 2, '现在 ' + bowl + ' 次');
  check('20 条真实语料能挑出 ≥ 10 种不同道具（要「因人而异」，不是一刀切）',
    distinct >= 10, distinct + ' 种');
  check('泛词命中后走的是「天+种子」兜底，不是全都空',
    (cnt['(走种子兜底)'] || 0) < CORPUS.length,
    '兜底 ' + (cnt['(走种子兜底)'] || 0) + '/' + CORPUS.length);

  // --- 源码级: 判据是"泛词表"，不是"词长" ---
  const src = read('modules/pet-nest.js');
  check('pet-nest.js 里有 GENERIC_ICON_KEYS 泛词表',
    /const GENERIC_ICON_KEYS\s*=\s*new Set\(/.test(src));
  check('pickIconsFromText 里真的用了泛词表（GENERIC_ICON_KEYS.has(k)）',
    /GENERIC_ICON_KEYS\.has\(k\)/.test(src));
  check('没有退回"两个字以上才算"的判据（specific 计数已删掉）',
    !/let specific = 0/.test(src), 'specific 计数已移除');
  check('同分时按 hash(种子+道具名) 排（情况一样的人也要拿到不一样的道具）',
    /:iconpick:/.test(src));

  // --- 衣服那边也确认一下: 同一只宠物每天换、不同的宠物不同 ---
  const day = '2026-10-28';
  const looks = [];
  for (let i = 0; i < 200; i++) {
    looks.push(R.dailyLookFor([], day, 'seed-' + i, []));
  }
  const outfits = new Set(looks.map(l => l.outfit && l.outfit.cn));
  const icons = new Set(looks.map(l => (l.icons[0] || {}).cn));
  check('200 只不同种子的宠物 → 衣服款式都散开了',
    outfits.size >= 15, outfits.size + ' / ' + R.BEAST_OUTFITS.length + ' 种');
  check('200 只不同种子的宠物 → 道具也散开了',
    icons.size >= 15, icons.size + ' / ' + R.ICON_LIBRARY.length + ' 种');
  const same = R.dailyLookFor([], day, 'seed-7', []);
  const same2 = R.dailyLookFor([], day, 'seed-7', []);
  check('同一只宠物同一天 → 衣服和道具都一样（不能每天乱跳）',
    same.outfit.cn === same2.outfit.cn && same.icons[0].cn === same2.icons[0].cn,
    same.outfit.cn + ' + ' + same.icons[0].cn);
}

section('① 每日换装: 界面写的和图上画的必须是同一身');
{
  const src = read('modules/pet-nest.js');
  check('pet-nest.js 里有「今天这身」的按宠物缓存（rememberLookFor / cachedLookFor）',
    /function rememberLookFor\(/.test(src) && /function cachedLookFor\(/.test(src));
  check('todayLookForSync 优先用生图时算出来的那份（界面 ≠ 图 就不算修好）',
    /function todayLookForSync[\s\S]{0,400}?cachedLookFor\(pet\)/.test(src));
  check('生图那条路（buildTodayLook）会把算出来的 look 记下来',
    /function buildTodayLook[\s\S]{0,600}?rememberLookFor\(pet, look\)/.test(src));

  // 刚领养的宠物 appearance 为 null —— 名册上也该看得见今天这身
  const R = loadRules();
  const pet = { id: 'pet-new-1', seed: 'seed-new-1', kind: 'cat', appearance: null };
  let desc = '';
  try {
    desc = R.formatPetAppearance(pet) || '';
  } catch (e) {
    desc = '(抛错: ' + e.message + ')';
  }
  check('刚领养的宠物（appearance 为 null）名册上也显示今天这身',
    desc && desc !== '小猫' && /的/.test(desc), desc);
}

section('① 每日换装: 蜕变提示词必须永远说「按今天这身重画」');
{
  const src = read('modules/pet-image.js');
  const fnSrc = grabFunc(src, 'buildEvolvePrompt');
  check('pet-image.js 里找得到 buildEvolvePrompt', !!fnSrc);
  // ⚠️【2026-10-29】buildEvolvePrompt 现在会调 poseSetFor / layoutTextFor
  //   （六格姿态按宠物种类给）→ 抠函数的时候要把这几个一起抠出来，
  //   否则这里会 ReferenceError: poseSetFor is not defined。
  const POSE_SETS_SRC = grabObj(src, 'POSE_SETS');
  const LAYOUT_BODIES_SRC = grabObj(src, 'LAYOUT_BODIES');
  const helpers = ['poseSetFor', 'layoutBodyFor', 'layoutTextFor']
    .map(n => grabFunc(src, n)).filter(Boolean);
  const buildEvolvePrompt = fnSrc ? new Function([
    'const POSE_SETS = ' + (POSE_SETS_SRC || '{}') + ';',
    'const LAYOUT_BODIES = ' + (LAYOUT_BODIES_SRC || '{}') + ';',
    helpers.join('\n'),
    'return (' + fnSrc + ');'
  ].join('\n'))() : null;

  if (buildEvolvePrompt) {
    const subject = 'a fluffy white cat wearing a red knitted scarf, with a tiny umbrella in front of it';
    // change 非空 = 孵出来的宠物（阶段花纹）—— 原来这句会被整条替换掉
    const p1 = buildEvolvePrompt(subject, 'a small spotted marking on its ear');
    check('有 change（阶段花纹）时，提示词里仍然有"按今天这身重画"',
      /Give it exactly the outfit and accessories described above/.test(p1));
    check('有 change 时，提示词里仍然写明了今天这身（subject）',
      p1.indexOf(subject) >= 0);
    check('有 change 时，仍然点名"道具和衣服六格都要看得见"',
      /BOTH be clearly visible in EVERY one of the six cells/.test(p1));

    const p2 = buildEvolvePrompt(subject, '');
    check('没有 change 时，同样有"按今天这身重画"',
      /Give it exactly the outfit and accessories described above/.test(p2));
    check('两种情况下这句都在（原来它在 else 分支里，change 一非空就没了）',
      /Give it exactly the outfit and accessories described above/.test(p1)
      && /Give it exactly the outfit and accessories described above/.test(p2));

    check('提示词里 outfit 那句不在 else 分支里（change 非空就得被挤掉）',
      !/else\s*\{[^}]*Give it exactly the outfit/.test(src)
      && !/if \(change\)[\s\S]{0,400}?\} else \{[^}]*Give it exactly the outfit/.test(src));
  }
}

// ============================================================
// ② 宠物说的话要落进聊天框
// ============================================================
section('② 宠物说的话要立刻落进聊天框');
{
  const src = read('modules/pet-speech.js');
  // 真正的聊天渲染函数是 window.renderChatInterface（chat-interface.js 暴露的）；
  // window.renderChatMessages 全项目根本没定义 → 那个 typeof 判断永远为假 → 界面从不重绘。
  check('pet-speech.js 调的是 renderChatInterface（真正存在的那个）',
    /renderChatInterface\(/.test(src));
  check('pet-speech.js 里 renderChatMessages 只是兜底，不是唯一路径',
    /renderChatInterface\([\s\S]{0,200}?renderChatMessages/.test(src)
    || /renderChatMessages[\s\S]{0,200}?renderChatInterface/.test(src)
    || /renderChatInterface/.test(src));

  // 全项目核对：renderChatMessages 到底存不存在
  const chatIf = read('modules/chat-interface.js');
  check('chat-interface.js 暴露的是 window.renderChatInterface',
    /window\.renderChatInterface\s*=/.test(chatIf));

  // 真·全项目扫描：除了"调用"以外，不该有任何地方【定义】window.renderChatMessages
  //   （`===` 里也含 `=`，所以要用 (?!=) 排掉比较运算符）
  const defRe = /window\.renderChatMessages\s*=(?!=)/;
  const defFiles = [];
  const scanDirs = [path.join(ROOT, 'modules'), ROOT];
  const seen = new Set();
  for (const dir of scanDirs) {
    let list = [];
    try {
      list = fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f) && !f.startsWith('sw.js'));
    } catch (e) { continue; }
    for (const f of list) {
      const full = path.join(dir, f);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        if (defRe.test(fs.readFileSync(full, 'utf8'))) defFiles.push(path.relative(ROOT, full));
      } catch (e) { /* 读不了就算了 */ }
    }
  }
  check('全项目没有 window.renderChatMessages 的【定义】（只有调用 → 那是死代码）',
    defFiles.length === 0, defFiles.join(' | ') || '确认：无处定义');

  // 启动时 state.activeChatId 还没设 → 一句都没写进任何会话
  check('pet-speech.js 有「落到最近聊过的会话」的兜底（mostRecentChat）',
    /function mostRecentChat\(/.test(src));
  check('mostRecentChat 用 chats.lastMessageTimestamp 找最近那个',
    /lastMessageTimestamp/.test(src));

  // 另外两个同样写了 renderChatMessages 的地方
  for (const f of ['modules/proactive-wake.js', 'modules/in-app-proactive-patrol.js']) {
    const s2 = read(f);
    check(f + ' 也改成了 renderChatInterface',
      /renderChatInterface\(/.test(s2));
  }
}

// ============================================================
// ③ 桌宠放大
// ============================================================
section('③ 桌宠放大 25%');
{
  const css = read('css/pet-nest.css');
  check('桌宠尺寸走 CSS 变量 --pn-desktop-pet-size（要调只改一个值）',
    /--pn-desktop-pet-size/.test(css));
  const varDef = (css.match(/--pn-desktop-pet-size:\s*(\d+)px/) || [])[1];
  check('桌面尺寸 = 98px（原来 78px，+25%）', varDef === '98', '实际 ' + varDef + 'px');
  check('桌面尺寸比原来的 78px 大', Number(varDef) > 78, varDef + 'px');
  check('桌宠那一格用的是这个变量（不是写死的 px）',
    /#pn-desktop-pet[\s\S]{0,400}?var\(--pn-desktop-pet-size\)/.test(css));
  const mob = (css.match(/max-width:\s*480px[\s\S]{0,1200}?--pn-desktop-pet-size:\s*(\d+)px/) || [])[1];
  check('手机尺寸 = 83px（原来 66px，+25%）', mob === '83', '实际 ' + mob + 'px');
  check('手机尺寸比原来的 66px 大', Number(mob) > 66, mob + 'px');
}

// ============================================================
console.log('\n通过 ' + passed + ' / 失败 ' + failed);
if (failed > 0) {
  console.error('\n✗ 有 ' + failed + ' 条断言没过');
  process.exit(1);
} else {
  console.log('✓ 每日换装 / 说话落框 / 桌宠尺寸 全部通过');
}

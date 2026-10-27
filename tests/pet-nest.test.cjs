// ============================================================
// tests/pet-nest.test.cjs
// 宠物屋（Cove 灵宠屋前端移植版）的规则与接线回归测试
//
// 跑法: node tests/pet-nest.test.cjs
//
// 【本测试守什么】
//   ① 规则: 换粮曲线 / 饱腹衰减 / 阶段门槛 / 性格哈希 / 六格切帧
//      —— 这些数字是照上游源码逐条移植的, 改错了玩法就变形了
//   ② 接线: index.html 的屏 + script 标签 + 桌宠容器、sw.js 预缓存 + CACHE_VERSION、
//      提示词里的 {{petNestContext}} 和 pet_action 指令、ai-response.js 的
//      contextMap 注入和 case 分发
//   ③ 下线: 邮箱必须彻底没影 (界面 / 代码 / 表 / 备份导出 / 图标槽位)
//
// 【为什么用 vm 而不是 jsdom】
//   项目里没有 jsdom 依赖(见 cinema-episode-sheet.test.cjs 的说明)。
//   pet-nest.js 的规则部分全是纯函数, 把模块塞进一个假 window/document 的
//   vm 沙箱里, 走 window.PetNest.rules 暴露出来的入口直接验算。
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
// 把 pet-nest.js 塞进 vm 沙箱, 取出纯规则
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
    // 备份/恢复要用 Blob ↔ base64（Node 18+ 自带）
    Blob,
    btoa,
    atob,
    document: {
      readyState: 'loading',       // 故意不进 init(), 免得真去开 Dexie
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

// ============================================================
// ① 规则
// ============================================================
section('规则: 换粮曲线（上游 ledger.py _grains）');
{
  const R = loadRules();
  const g = R.grainsFor;
  check('0 token = 0 粒', g(0) === 0, 'got ' + g(0));
  check('3999 token = 19 粒', g(3999) === 19, 'got ' + g(3999));
  check('4000 token = 20 粒', g(4000) === 20, 'got ' + g(4000));
  // 上游公式: min(total,4000)//200 + max(0,total-4000)//800
  // 4800 = 4000//200(20) + 800//800(1) = 21, 不是 24
  check('4800 token = 21 粒（20 + 800/800）', g(4800) === 21, 'got ' + g(4800));
  check('8000 token = 25 粒（20 + 4000/800）', g(8000) === 25, 'got ' + g(8000));
  check('20000 token = 40 粒', g(20000) === 40, 'got ' + g(20000));
  check('超过 20000 仍封顶 40 粒', g(999999) === 40, 'got ' + g(999999));
  check('负数不炸', g(-5) === 0, 'got ' + g(-5));
}

section('规则: 饱腹随时间衰减（上游 store.py）');
{
  const R = loadRules();
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  // 【2026-10-25 用户定】「饿得太慢了，至少 100 的饱腹，一天要喂两次嘛」
  //   → 每小时 -8：满值 100 撑 12.5 小时 ≈ 一天两次
  const pet = { satiety: 60, settledAt: now - 5 * 3600 * 1000 };
  const s = R.currentSatiety(pet, now);
  check('60 饱腹过 5 小时 → 20（每小时 -8）', Math.abs(s - 20) < 0.01, 'got ' + s);
  const pet2 = { satiety: 60, settledAt: now - 100 * 3600 * 1000 };
  check('衰减到 0 不会变负', R.currentSatiety(pet2, now) === 0, 'got ' + R.currentSatiety(pet2, now));
  const pet3 = { satiety: 60, settledAt: now };
  check('刚喂完不衰减', R.currentSatiety(pet3, now) === 60, 'got ' + R.currentSatiety(pet3, now));

  // 满值 100 能撑多久
  const full = { satiety: 100, settledAt: now };
  const half = R.currentSatiety(full, now + 12.5 * 3600 * 1000);
  check('满值 100 撑约 12.5 小时见底（一天正好喂两次）',
    half >= 0 && half <= 0.01, '12.5h 后剩 ' + half);
  check('衰减速度是每小时 8 点', R.SATIETY_DECAY_PER_HOUR === 8, String(R.SATIETY_DECAY_PER_HOUR));
  check('每颗粮给半饱（吃 2 颗刚好吃饱）', R.FEED_SATIETY_PER_GRAIN === 50, String(R.FEED_SATIETY_PER_GRAIN));
  // ⚠️【2026-10-25 用户定】「一开始喂一次一颗，升级后一次两颗什么的」
  check('喂一顿吃的粮随阶段变多（0阶段1颗 / 1阶段2颗 / 3阶段4颗）',
    R.feedGrainCost({ stage: 0 }) === 1 && R.feedGrainCost({ stage: 1 }) === 2
    && R.feedGrainCost({ stage: 3 }) === 4,
    JSON.stringify([0, 1, 3].map(s => R.feedGrainCost({ stage: s }))));
}

section('规则: 饿死（用户 2026-10-25 定的：饿满 3 天真没了）');
{
  const R = loadRules();
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  const H = 3600 * 1000, D = 86400000;

  check('饿满 3 天的阈值是 3 天', R.STARVE_DAYS === 3, String(R.STARVE_DAYS));

  // 刚喂饱 → 不饿
  const fed = { satiety: 100, settledAt: now };
  check('刚喂饱不饿', R.starveState(fed, now).hungry === false);

  // 12.5 小时后归零 → 开始饿
  const zeroAt = now + 12.5 * H;
  const st0 = R.starveState(fed, zeroAt + 1000);
  check('饱腹归零后开始饿', st0.hungry === true);
  check('饿的开始时间算得对（≈12.5 小时后）',
    Math.abs(st0.since - zeroAt) < 2000, 'since=' + st0.since + ' 期望≈' + zeroAt);
  check('刚饿的时候还有 3 天（不会马上没）', st0.leftMs > 2.9 * D, String(Math.round(st0.leftMs / D)));

  // 饿 2 天 → 还在，但快不行了
  const twoDays = R.starveState(fed, zeroAt + 2 * D);
  check('饿了 2 天还没消失', twoDays.leftMs > 0, String(Math.round(twoDays.leftMs / D)));
  check('饿了 2 天要提醒了（dying）', twoDays.dying === true);

  // 饿满 3 天 → 消失
  const threeDays = R.starveState(fed, zeroAt + 3 * D + 1000);
  check('饿满 3 天就消失（leftMs = 0）', threeDays.leftMs === 0, String(threeDays.leftMs));

  // 不饿的时候不能判死（还没归零的那段时间）
  check('不饿的宠物不会被判饿死', R.starveState(fed, now + 5 * H).leftMs === Infinity,
    String(R.starveState(fed, now + 5 * H).leftMs));

  // 饱腹本来就是 0 的老数据 → 从结算时间开始算
  const zeroBase = { satiety: 0, settledAt: now };
  check('本来就是 0 饱腹的，从结算时间开始饿',
    R.starveState(zeroBase, now + 1000).since === now);
}

section('规则: 成长阶段门槛（上游 growth.py + 用户定新刻度）');
{
  const R = loadRules();
  const day = 86400000;
  const created = Date.UTC(2026, 0, 1);
  const now = created + 10 * day;

  // 普通宠物（猫狗没有蛋期）: 第 1 阶段要成长 130 + 相处 10 天
  const cat = { kind: 'cat', stage: 0, growth: 135, createdAt: created };
  const t1 = R.growthTarget(cat, null, now);
  check('猫: 阶段1 门槛 = 成长130 / 10天', t1.requiredGrowth === 130 && t1.requiredDays === 10,
    'got ' + t1.requiredGrowth + '/' + t1.requiredDays);
  check('猫: 成长135 + 10天 → 第1阶段就绪', t1.ready === true);
  check('猫: 成长值不够就不就绪',
    R.growthTarget({ kind: 'cat', stage: 0, growth: 10, createdAt: created }, null, now).ready === false);
  check('猫: 天数不够就不就绪',
    R.growthTarget({ kind: 'cat', stage: 0, growth: 135, createdAt: now - 2 * day }, null, now).ready === false);

  // 第 2 阶段: 成长 324 + 25 天, 从上一阶段激活时间算
  const cat2 = { kind: 'cat', stage: 1, growth: 330, createdAt: created };
  const t2 = R.growthTarget(cat2, { stage: 1, activatedAt: now - 3 * day, growthAtActivation: 135 }, now);
  check('猫: 阶段2 门槛 = 成长324 / 25天', t2.requiredGrowth === 324 && t2.requiredDays === 25,
    'got ' + t2.requiredGrowth + '/' + t2.requiredDays);
  check('猫: 天数从【上一阶段激活】起算, 不是从领养起算', t2.elapsedDays === 3, 'got ' + t2.elapsedDays);

  // 蛋: 第 1 阶段只要成长 26 + 2 天
  const egg = { kind: 'egg', stage: 0, growth: 26, createdAt: created };
  const te = R.growthTarget(egg, null, now);
  check('蛋: 阶段1 门槛 = 成长26 / 2天', te.requiredGrowth === 26 && te.requiredDays === 2,
    'got ' + te.requiredGrowth + '/' + te.requiredDays);
  check('蛋: 成长26 + 满2天 → 可孵化',
    R.canHatch({ kind: 'egg', growth: 26, createdAt: now - 2 * day }, now) === true);
  check('蛋: 差一天不能孵化',
    R.canHatch({ kind: 'egg', growth: 26, createdAt: now - 1 * day }, now) === false);
  check('蛋: 成长不够不能孵化',
    R.canHatch({ kind: 'egg', growth: 25, createdAt: now - 5 * day }, now) === false);
  check('已经孵出来的（stage>0）→ 不再算「蛋可以孵化」',
    R.canHatch({ kind: 'egg', stage: 3, growth: 999, createdAt: now - 40 * day }, now) === false);
  check('鹦鹉羽化成神兽后 → 也不再算「蛋可以孵化」',
    R.canHatch({ kind: 'parrot', stage: 4, growth: 999, createdAt: now - 40 * day }, now) === false);

  // 门槛表本身（用户 2026-10-25 拍板的中档刻度）
  check('蛋类门槛表 = 26/130/324/648 + 2/10/25/50 天',
    JSON.stringify(R.STAGE_RULES_HATCH) === JSON.stringify({ 1: [26, 2], 2: [130, 10], 3: [324, 25], 4: [648, 50] }),
    'got ' + JSON.stringify(R.STAGE_RULES_HATCH));
  check('猫狗门槛表 = 130/324/648 + 10/25/50 天（对齐蛋类第 2/3/4 档）',
    JSON.stringify(R.STAGE_RULES_PLAIN) === JSON.stringify({ 1: [130, 10], 2: [324, 25], 3: [648, 50] }),
    'got ' + JSON.stringify(R.STAGE_RULES_PLAIN));
  check('猫狗没有蛋期 → 第 1 阶段就要求成长 130',
    R.growthTarget({ kind: 'cat', stage: 0, growth: 129, createdAt: created }, null, now).ready === false);
  check('猫狗第 3 阶段门槛 = 成长 648 / 50 天',
    (() => {
      const t3 = R.growthTarget({ kind: 'cat', stage: 2, growth: 700, createdAt: created },
        { stage: 2, activatedAt: now - 60 * day, growthAtActivation: 330 }, now);
      return t3.requiredGrowth === 648 && t3.requiredDays === 50;
    })());
  check('猫狗第 3 阶段之后（表里没第 4 档）→ 兜底按最后一档继续往上叠 648',
    (() => {
      const t4 = R.growthTarget({ kind: 'cat', stage: 3, growth: 2000, createdAt: created },
        { stage: 3, activatedAt: now - 90 * day, growthAtActivation: 648 }, now);
      return t4.requiredGrowth === 1296 && t4.requiredDays === 30;
    })());
  const src = read('modules/pet-nest.js');
  check('孵化提示写的是门槛常量（不是写死的 12）',
    src.includes("'还是一颗蛋（孵化需要成长 ' + STAGE_RULES_HATCH[1][0]") && !src.includes('孵化需要成长 12'));
}

section('规则: 陪玩/摸摸多久回一点成长值（上游秒 → 330 是毫秒）');
{
  const R = loadRules();
  const H = 3600 * 1000;
  const t0 = Date.UTC(2026, 0, 10);

  // 上游 store.py: recovery = 3600*(5-trait/50)，now 是秒 → 性格 50 = 4 小时回满 1 点
  check('第一次陪玩直接给满 1 点', R.interactionDelta('play', { traits: { energy: 50 } }, t0) === 1);
  check('第一次摸摸直接给满 1 点', R.interactionDelta('comfort', { traits: { attachment: 50 } }, t0) === 1);

  const pet = { traits: { energy: 50, attachment: 50 }, lastPlay: t0, lastComfort: t0 };
  check('陪玩：刚点完不给点', R.interactionDelta('play', pet, t0) === 0);
  check('陪玩：4 分钟后只有 1/60 点',
    Math.abs(R.interactionDelta('play', pet, t0 + 4 * 60 * 1000) - 1 / 60) < 1e-9,
    'got ' + R.interactionDelta('play', pet, t0 + 4 * 60 * 1000));
  check('陪玩：4 小时后回满 1 点', R.interactionDelta('play', pet, t0 + 4 * H) === 1);
  check('陪玩：8 小时后仍然封顶 1 点', R.interactionDelta('play', pet, t0 + 8 * H) === 1);
  check('陪玩：15 秒不会回满（老 bug 是 14.4 秒就满）',
    R.interactionDelta('play', pet, t0 + 15 * 1000) < 0.01,
    'got ' + R.interactionDelta('play', pet, t0 + 15 * 1000));
  check('摸摸走 attachment（性格 50 → 4 小时）',
    R.interactionDelta('comfort', pet, t0 + 4 * H) === 1);
  check('性格越高回得越快（活力 90 → 3.2 小时）',
    R.interactionDelta('play', { traits: { energy: 90 }, lastPlay: t0 }, t0 + 3.2 * H) === 1);
  check('性格越低回得越慢（活力 10 → 4.8 小时）',
    R.interactionDelta('play', { traits: { energy: 10 }, lastPlay: t0 }, t0 + 4.8 * H) === 1);
  check('没有性格数据时按 50 算（4 小时）',
    R.interactionDelta('play', { lastPlay: t0 }, t0 + 4 * H) === 1);
}

section('规则: 性格由 seed 决定且稳定');
{
  const R = loadRules();
  const a = R.temperament('seed-alpha');
  const b = R.temperament('seed-alpha');
  const c = R.temperament('seed-beta');
  check('同一个 seed → 同样的性格', JSON.stringify(a) === JSON.stringify(b));
  check('不同 seed → 性格不同', JSON.stringify(a) !== JSON.stringify(c));
  const vals = Object.values(a);
  check('6 项性格', vals.length === 6, 'got ' + vals.length);
  check('每项落在 10~90', vals.every(v => v >= 10 && v <= 90), JSON.stringify(vals));
}

section('规则: 六格图集切帧（3×2 → background-position）');
{
  const R = loadRules();
  const pos = [];
  const fake = { style: {} };
  for (let f = 0; f < 6; f++) {
    R.setSpriteFrame(fake, f);
    pos.push(fake.style.backgroundPosition);
  }
  check('第1格 = 0% 0%', pos[0] === '0% 0%', 'got ' + pos[0]);
  check('第2格 = 50% 0%（列偏移 50%）', pos[1] === '50% 0%', 'got ' + pos[1]);
  check('第3格 = 100% 0%', pos[2] === '100% 0%', 'got ' + pos[2]);
  check('第4格 = 0% 100%（行偏移 100%）', pos[3] === '0% 100%', 'got ' + pos[3]);
  check('第5格 = 50% 100%', pos[4] === '50% 100%', 'got ' + pos[4]);
  check('第6格 = 100% 100%', pos[5] === '100% 100%', 'got ' + pos[5]);
}

section('规则: 切天固定东八区（跟设备时区无关）');
{
  const R = loadRules();
  // 2026-01-01 23:30 UTC = 北京时间 2026-01-02 07:30 → 属于 01-02
  const ts = Date.UTC(2026, 0, 1, 23, 30, 0);
  check('东八区切天', R.dayKey(ts) === '2026-01-02', 'got ' + R.dayKey(ts));
  // 2026-01-01 04:00 UTC = 北京 01-01 12:00 ; 2026-01-02 04:00 UTC = 北京 01-02 12:00
  check('跨天差值 = 1', R.dayDiff(Date.UTC(2026, 0, 1, 4, 0), Date.UTC(2026, 0, 2, 4, 0)) === 1,
    'got ' + R.dayDiff(Date.UTC(2026, 0, 1, 4, 0), Date.UTC(2026, 0, 2, 4, 0)));
  // 北京时间 01-02 00:30 (= 01-01 16:30 UTC) 跟 01-01 23:00 北京 (= 01-01 15:00 UTC) 差一天
  check('同一 UTC 日但北京跨天 → 差 1',
    R.dayDiff(Date.UTC(2026, 0, 1, 15, 0), Date.UTC(2026, 0, 1, 16, 30)) === 1,
    'got ' + R.dayDiff(Date.UTC(2026, 0, 1, 15, 0), Date.UTC(2026, 0, 1, 16, 30)));
}

section('规则: 鹦鹉（从蛋里出来 → 定品种 → 羽化神兽）');
{
  const R = loadRules();
  const day = 86400000;
  const created = Date.UTC(2026, 0, 1);
  const now = created + 10 * day;

  // ① 也是从蛋里出来的
  check('鹦鹉算「从蛋里孵出来的」', R.isHatchKind('parrot') === true);
  check('灵宠蛋也算', R.isHatchKind('egg') === true);
  check('猫不算', R.isHatchKind('cat') === false);

  // ② 蛋期规则跟灵宠蛋一样：成长 26 + 相处 2 天
  const tp = R.growthTarget({ kind: 'parrot', stage: 0, growth: 26, createdAt: created }, null, now);
  check('鹦鹉: 阶段1 门槛 = 成长26 / 2天', tp.requiredGrowth === 26 && tp.requiredDays === 2,
    'got ' + tp.requiredGrowth + '/' + tp.requiredDays);
  check('鹦鹉: 成长26 + 满2天 → 可孵化',
    R.canHatch({ kind: 'parrot', growth: 26, createdAt: now - 2 * day }, now) === true);
  check('鹦鹉: 差一天不能孵化',
    R.canHatch({ kind: 'parrot', growth: 26, createdAt: now - 1 * day }, now) === false);

  // ③ 能走到第 4 阶段（羽化神兽）
  const t4 = R.growthTarget({ kind: 'parrot', stage: 3, growth: 999, createdAt: created },
    { stage: 3, activatedAt: now - 30 * day, growthAtActivation: 200 }, now);
  check('鹦鹉: 有第 4 阶段（羽化神兽）', t4.stage === 4, 'got ' + t4.stage);
  check('鹦鹉: 第4阶段门槛 = 成长648 / 50天', t4.requiredGrowth === 648 && t4.requiredDays === 50,
    'got ' + t4.requiredGrowth + '/' + t4.requiredDays);
  check('神兽阶段号 = 4', R.DIVINE_STAGE === 4, 'got ' + R.DIVINE_STAGE);

  // ④ 品种库：都是艳色，字段齐全
  check('品种库有 8 种', R.PARROT_BREEDS.length === 8, 'got ' + R.PARROT_BREEDS.length);
  check('每个品种都有中文名/英文名/配色/性格',
    R.PARROT_BREEDS.every(b => b.label && b.en && b.colorCn && b.colorEn && b.note));
  check('品种 key 不重复', new Set(R.PARROT_BREEDS.map(b => b.key)).size === R.PARROT_BREEDS.length);
  check('英文配色里没有中文', R.PARROT_BREEDS.every(b => !/[一-龥]/.test(b.colorEn)));
  check('没有灰不拉几的品种（不出现 grey / gray）',
    !R.PARROT_BREEDS.some(b => /grey|gray/i.test(b.en + ' ' + b.colorEn)));
  check('每个品种的英文名都带 parrot 或 conure 之类可识别的词',
    R.PARROT_BREEDS.every(b => /parrot|conure|parakeet|macaw|lorikeet|budgerigar/i.test(b.en)));

  // ⑤ 神兽库
  check('神兽有 4 种', R.DIVINE_BIRDS.length === 4, 'got ' + R.DIVINE_BIRDS.length);
  check('每个神兽都有中英文名和配色',
    R.DIVINE_BIRDS.every(b => b.label && b.en && b.colorCn && b.colorEn));
  check('神兽英文名里没有中文', R.DIVINE_BIRDS.every(b => !/[一-龥]/.test(b.en + b.colorEn)));

  // ⑥ 品种由 seed 定，同一只永远同一品种；8 种都抽得到
  check('同一个 seed → 同一品种',
    R.parrotBreedFor('seed-abc').key === R.parrotBreedFor('seed-abc').key);
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(R.parrotBreedFor('seed-' + i).key);
  check('8 个品种都能被抽到', seen.size === 8, 'got ' + seen.size);

  // ⑦ 这一步走哪条路：破壳 / 羽化 / 普通成长
  check('鹦鹉第0阶段 → 破壳',
    R.stageBriefKind({ kind: 'parrot', stage: 0 }, { stage: 1 }) === 'hatch');
  check('灵宠蛋第0阶段 → 破壳',
    R.stageBriefKind({ kind: 'egg', stage: 0 }, { stage: 1 }) === 'hatch');
  check('鹦鹉走到第4阶段 → 羽化神兽',
    R.stageBriefKind({ kind: 'parrot', stage: 3 }, { stage: 4 }) === 'divine');
  check('鹦鹉中途（第2/3阶段）→ 普通成长',
    R.stageBriefKind({ kind: 'parrot', stage: 1 }, { stage: 2 }) === 'normal' &&
    R.stageBriefKind({ kind: 'parrot', stage: 2 }, { stage: 3 }) === 'normal');
  check('猫永远走普通成长',
    R.stageBriefKind({ kind: 'cat', stage: 0 }, { stage: 1 }) === 'normal' &&
    R.stageBriefKind({ kind: 'cat', stage: 2 }, { stage: 3 }) === 'normal');
  // ⚠️【2026-10-25 用户定】「羽化不会是每个神兽最后的设定吧？不能最后都长翅膀吧？」
  //   → 灵宠蛋孵出来的幻兽【也要】有终形态，只是按族群分（龙神/灵瑞/灵幻），不是都长翅膀
  check('灵宠蛋长到第4阶段 → 羽化（按族群挑终形态，不是都变神鸟）',
    R.stageBriefKind({ kind: 'egg', stage: 3 }, { stage: 4 }) === 'divine');

  // ⑧ 羽化：血脉不变，形态换成神鸟
  const b1 = R.parrotBreedFor('seed-abc');
  const pet = { id: 'p1', seed: 'seed-abc', kind: 'parrot', stage: 3, traits: { attachment: 50 } };  const cur = {
    stage: 3, features: ['心形胸羽'],
    appearance: { kind: 'parrot', breedKey: b1.key, dimension: 'affection' }
  };
  const divine = R.divineBriefFor(pet, cur);
  check('羽化后形态 = divine', divine.appearance.kind === 'divine');
  check('羽化后血脉还是原来那只（breedKey 保留）', divine.appearance.breedKey === b1.key);
  check('羽化后有神兽名和 key', !!divine.appearance.identity && !!divine.appearance.beastKey);
  check('羽化后 features 追加「羽化神兽」', divine.features.indexOf('羽化神兽') >= 0);
  check('羽化保留原来的花纹记录', divine.features.indexOf('心形胸羽') >= 0);
  // 走真实升级路径时，中间阶段的记录里 appearance 是空的（普通阶段不返回 appearance），
  // 血脉只存在宠物身上 —— 羽化必须能从宠物身上兜底拿到，否则品种会丢
  const divineRealPath = R.divineBriefFor(
    { id: 'p2', seed: 'seed-abc', kind: 'parrot', stage: 3, traits: {},
      appearance: { kind: 'parrot', breedKey: b1.key, dimension: 'affection' } },
    { stage: 3, features: ['心形胸羽'], appearance: null }
  );
  check('走真实升级路径羽化 → 血脉仍然保住（breedKey 没丢）',
    divineRealPath.appearance.breedKey === b1.key);
  check('走真实升级路径羽化 → dimension 也保住',
    divineRealPath.appearance.dimension === 'affection');
  check('同一个 seed → 同一个神兽',
    R.divineBriefFor(pet, cur).appearance.beastKey === divine.appearance.beastKey);
  const seenBeasts = new Set();
  for (let i = 0; i < 300; i++) {
    seenBeasts.add(R.divineBriefFor({ id: 'p' + i, seed: 'seed-' + i, kind: 'parrot', traits: {} }, null).appearance.beastKey);
  }
  check('4 个神兽都能被抽到', seenBeasts.size === 4, 'got ' + seenBeasts.size);
}

section('规则: 生图提示词（鹦鹉 / 神兽 / 幻兽）');
{
  const R = loadRules();
  const breed = R.PARROT_BREEDS[0];
  const beast = R.DIVINE_BIRDS[0];

  // 没孵的鹦鹉 → 画成蛋
  const eggSubject = R.subjectForPet({ kind: 'parrot', stage: 0, appearance: null });
  check('没孵的鹦鹉 → 提示词是蛋', /egg/i.test(eggSubject), eggSubject);

  // 孵了的鹦鹉 → 画成那只鹦鹉
  const parrotSubject = R.subjectForPet({
    kind: 'parrot', stage: 1,
    appearance: {
      kind: 'parrot', breedKey: breed.key, identity: breed.label, palette: breed.colorCn,
      marking: '心形胸羽', markEn: 'a small heart-shaped plume on the breast'
    }
  });
  check('孵了的鹦鹉 → 提示词里有品种英文名', parrotSubject.indexOf(breed.en) >= 0, parrotSubject);
  check('孵了的鹦鹉 → 提示词里有英文配色', parrotSubject.indexOf(breed.colorEn) >= 0, parrotSubject);
  check('孵了的鹦鹉 → 提示词里有花纹英文', /heart-shaped/.test(parrotSubject), parrotSubject);
  check('鹦鹉提示词里没有中文', !/[一-龥]/.test(parrotSubject), parrotSubject);

  // 神兽 → 提示词是神鸟
  const divineSubject = R.subjectForPet({
    kind: 'parrot', stage: 4,
    appearance: { kind: 'divine', identity: beast.label, palette: beast.colorCn, marking: '羽化神兽', beastKey: beast.key }
  });
  check('神兽 → 提示词里有神鸟英文名', divineSubject.indexOf(beast.en) >= 0, divineSubject);
  check('神兽提示词里没有中文', !/[一-龥]/.test(divineSubject), divineSubject);

  // 幻想蛋孵出来 → 必须画成幻兽，不是蛋（这是修掉的 bug）
  const fantasySubject = R.subjectForPet({
    kind: 'egg', stage: 1,
    appearance: {
      kind: 'fantasy', identity: '月光绒兽', palette: '奶油银白',
      marking: '心形绒纹', markEn: 'a soft heart-shaped tuft on the chest'
    }
  });
  check('灵宠蛋孵出来后 → 提示词是幻兽不是蛋', !/egg/i.test(fantasySubject), fantasySubject);
  check('幻兽提示词含英文身份', /fuzz beast/i.test(fantasySubject), fantasySubject);
  check('幻兽提示词里没有中文', !/[一-龥]/.test(fantasySubject), fantasySubject);

  // 新幻兽（2026-10-25 物种盲盒）：appearance 里带 beastSpeciesEn
  const newBeastSubject = R.subjectForPet({
    kind: 'egg', stage: 2,
    appearance: {
      kind: 'fantasy', beastSpecies: '奶龙',
      beastSpeciesEn: 'a chubby round baby dragon with big friendly eyes',
      palette: '粉红', beastPaletteEn: 'pastel pink',
      marking: '心形绒纹', markEn: 'a soft heart-shaped tuft on the chest'
    }
  });
  check('新幻兽孵出来后 → 提示词是那只幻兽不是蛋', !/egg/i.test(newBeastSubject), newBeastSubject);
  check('新幻兽提示词里有物种英文名',
    newBeastSubject.indexOf('a chubby round baby dragon with big friendly eyes') >= 0, newBeastSubject);
  check('新幻兽提示词里有配色英文名', newBeastSubject.indexOf('pastel pink') >= 0, newBeastSubject);
  check('新幻兽提示词里没有中文', !/[一-龥]/.test(newBeastSubject), newBeastSubject);
  check('提示词不会拼成 "a a ..."（物种英文自带冠词，别补两次）',
    !/\ba a\b/i.test(newBeastSubject) && !/\ban an\b/i.test(newBeastSubject), newBeastSubject);

  // 猫狗的老样子别动
  check('猫的提示词还是 fluffy cat',
    R.subjectForPet({ kind: 'cat', stage: 0, appearance: null }).indexOf('fluffy cat') === 0);
  check('狗的提示词还是 fluffy puppy',
    R.subjectForPet({ kind: 'dog', stage: 0, appearance: null }).indexOf('fluffy puppy') === 0);
}

// ============================================================
// 【2026-10-27】用户提的三件事
//   ① 灵兽有「每日换装」，但重新生图画不出那身衣服 → 蜕变提示词把 subject 丢了
//   ② 鹦鹉/猫狗没有接换装（说明文字没有、生图提示词也没有、每日调度也跳过）
//   ③ 六格挤太紧，耳朵尾巴被切 → 改成宠物只占格子 75%，动作数不变
// ============================================================
section('每日换装: 所有宠物都参与 + 衣服道具都进提示词（2026-10-27）');
{
  const R = loadRules();
  const nestSrc = read('modules/pet-nest.js');
  const imgSrc = read('modules/pet-image.js');

  // --- ① 谁参与每日换装 ---
  check('每日换装不再只给灵宠蛋（鹦鹉、猫狗也要每天换）',
    !/row\.kind !== 'egg'/.test(nestSrc) &&
    /isHatchKind\(row\.kind\) && Number\(row\.stage \|\| 0\) <= 0/.test(nestSrc));
  check('守卫是「每只宠物一个 key」（一个全局 key → 一天只有一只能换）',
    /AUTO_LOOK_DAY_PREFIX \+ pid/.test(nestSrc) && /petNestAutoLookDay::/.test(nestSrc));
  check('每日换装遍历所有宠物（不是只画最早领养的那只）',
    /for \(const row of live\)[\s\S]{0,160}maybeDailyRedraw/.test(nestSrc) &&
    !/first\(\);\s*\n\s*if \(first\) await maybeDailyRedraw/.test(nestSrc));
  check('自动换装和手动生图分开计数（自动的不该吃掉手动「换个模样」的名额）',
    /counter: o\.auto \? 'auto' : 'manual'/.test(nestSrc) &&
    /autoCount: 'petNestImageAutoCount'/.test(imgSrc));

  // --- ② 蜕变提示词必须用上 subject（这就是「小水壶画不出来」的根因）---
  check('蜕变提示词把 subject 写进去了（以前收了却一次没用）',
    /Redraw it exactly as described here: ' \+ subject/.test(imgSrc));
  check('蜕变提示词不再只让模型改一处（那样穿搭永远进不去）',
    !/Make ONLY this change/.test(imgSrc));
  check('没给 change 时，明确要求换上今天这身',
    /Give it exactly the outfit and accessories described above/.test(imgSrc));

  // --- ③ 今天的衣服 + 道具，鹦鹉和猫狗都不能漏 ---
  const look = R.dailyLookFor([], '2026-01-01', 'seed-A', ['今天喝了一杯拿铁']);
  check('当天挑出来的道具在 look 里', look.icons.length === 1, look.icons[0] && look.icons[0].cn);
  check('每天有一件衣服', !!look.outfit && !!look.outfit.cn);

  const breed = R.PARROT_BREEDS[0];
  const parrot = R.subjectForPet({
    kind: 'parrot', stage: 1, seed: 'seed-A',
    appearance: {
      kind: 'parrot', breedKey: breed.key, identity: breed.label, palette: breed.colorCn,
      marking: '心形胸羽', markEn: 'a small heart-shaped plume on the breast'
    }
  }, look);
  check('鹦鹉提示词里有今天的衣服', parrot.indexOf(look.outfit.en) >= 0, parrot);
  check('鹦鹉提示词里有今天的道具', parrot.indexOf(look.icons[0].en) >= 0, parrot);
  check('鹦鹉提示词里没有中文', !/[一-龥]/.test(parrot), parrot);

  const cat = R.subjectForPet({ kind: 'cat', stage: 1, seed: 'seed-A', appearance: null }, look);
  check('猫的提示词里有今天的衣服', cat.indexOf(look.outfit.en) >= 0, cat);
  check('猫的提示词里有今天的道具', cat.indexOf(look.icons[0].en) >= 0, cat);
  check('猫狗提示词里没有中文（以前把中文 appearance 直接塞进英文提示词）',
    !/[一-龥]/.test(cat), cat);

  // --- ④ 换装文字说明：所有种类都要有 ---
  const today = R.dayKey(Date.now());
  const todayLook = R.dailyLookFor([], today, 'seed-A', []);
  const parrotCn = R.formatPetAppearance({
    kind: 'parrot', stage: 1, seed: 'seed-A',
    appearance: {
      kind: 'parrot', breedKey: breed.key, identity: breed.label, palette: breed.colorCn,
      marking: '心形胸羽'
    }
  });
  check('鹦鹉的说明里有今天这身（用户说「鹦鹉没看见换装文字说明」）',
    parrotCn.indexOf(todayLook.outfit.cn) >= 0, parrotCn);
  const catCn = R.formatPetAppearance({
    kind: 'cat', stage: 1, seed: 'seed-A',
    appearance: { kind: 'starter', identity: '小猫', palette: '', marking: '' }
  });
  check('猫狗的说明里也有今天这身', catCn.indexOf(todayLook.outfit.cn) >= 0, catCn);

  // --- ⑤ 道具兜底：今天聊不到东西也要有道具（衣服 + 道具一起换）---
  const noText = R.dailyLookFor([], '2026-01-01', 'seed-A', []);
  check('今天没聊到东西也有道具（衣服 + 道具一起换）',
    noText.icons.length === 1, noText.icons[0] && noText.icons[0].cn);

  // --- ⑥ 界面和提示词算的要是同一套（petView 必须带 seed）---
  check('petView 带着 seed（不带 → 界面和提示词算出的穿搭不是同一套）',
    /seed: pet\.seed \|\| pet\.id/.test(nestSrc));

  // --- ⑦ Q4：宠物只占格子 70-80%，动作数不变 ---
  check('生图提示词要求宠物只占格子 75%（用户 2026-10-27 定的）',
    /filling only about 75% of that cell/.test(imgSrc));
  check('提示词不再要求「每格塞满」（那会让耳朵尾巴画进隔壁格 → 被切掉）',
    !/each cell fully filled/.test(imgSrc));
  check('还是六格 3×2（用户说动作数不改）',
    /3 columns by 2 rows grid of six equal SQUARE cells/.test(imgSrc));
}

// ============================================================
// ② 接线
// ============================================================
section('规则: 谁需要「专属模样」（没自己的图，只能靠生图）');
{
  const R = loadRules();
  check('鹦鹉破壳后还没画像 → 需要',
    R.needsLook({ kind: 'parrot', stage: 1, assetRef: null }) === true);
  check('灵宠蛋孵出来还没画像 → 需要',
    R.needsLook({ kind: 'egg', stage: 1, assetRef: null }) === true);
  check('鹦鹉还在蛋里 → 不需要',
    R.needsLook({ kind: 'parrot', stage: 0, assetRef: null }) === false);
  check('鹦鹉已经画过了 → 不需要',
    R.needsLook({ kind: 'parrot', stage: 1, assetRef: 'a1' }) === false);
  check('画过图的鹦鹉长到第 3 阶段 → 形态没大变，不需要重画',
    R.needsLook({ kind: 'parrot', stage: 3, assetRef: 'a1' }) === false);
  check('羽化成神兽（needsRedraw）→ 旧图对不上，要重画',
    R.needsLook({ kind: 'parrot', stage: 4, assetRef: 'a1', needsRedraw: true }) === true);
  check('猫狗有自己的图 → 永远不需要',
    R.needsLook({ kind: 'cat', stage: 2, assetRef: null }) === false &&
    R.needsLook({ kind: 'dog', stage: 2, assetRef: null }) === false);
  check('没这宠物 → 不需要', R.needsLook(null) === false);
}

section('规则: 「该画一张」的说法按阶段/形态走');
{
  const R = loadRules();
  const h1 = R.lookHint({ name: '小翠', kind: 'parrot', stage: 1, assetRef: null });
  const h3 = R.lookHint({ name: '小翠', kind: 'parrot', stage: 3, assetRef: null });
  const hD = R.lookHint({
    name: '小翠', kind: 'parrot', stage: 4, assetRef: 'a1', needsRedraw: true,
    appearance: { identity: '金辉鸾凤' }
  });
  check('刚破壳 → 说「破壳了」', h1.text.includes('破壳了') && h1.icon === '🎨');
  check('长到第 3 阶段还没画 → 说「第 3 阶段」，不再是「破壳了」',
    h3.text.includes('第 3 阶段') && !h3.text.includes('破壳了'));
  check('羽化成神兽 → 说「羽化」并带上神兽名，图标换成 ✨',
    hD.text.includes('羽化') && hD.text.includes('金辉鸾凤') && hD.icon === '✨');
  check('羽化的说法里不能说「破壳了」', !hD.text.includes('破壳了'));
  check('没这宠物 → 没有提示', R.lookHint(null) === null);
  check('每种情况都备齐 提示条/金点/弹窗/AI 四句话',
    ['text', 'dot', 'dialog', 'ai'].every(k =>
      typeof h1[k] === 'string' && h1[k].length > 0 &&
      typeof h3[k] === 'string' && h3[k].length > 0 &&
      typeof hD[k] === 'string' && hD[k].length > 0));
  check('AI 那句只陈述事实，不下命令', !h1.ai.includes('必须') && !hD.ai.includes('必须'));
}

section('接线: 提醒（破壳要说一声 + 小窝提示条 + 金点）');
{
  const html = read('index.html');
  const src = read('modules/pet-nest.js');
  const css = read('css/pet-nest.css');
  check('小窝有提示条 #pn-hint-bar', html.includes('id="pn-hint-bar"'));
  check('提示条有按钮 #pn-hint-go', html.includes('id="pn-hint-go"'));
  check('照顾弹窗有「换个模样」按钮', html.includes('id="pn-evolve-btn"'));
  check('破壳/羽化会当场说一句（announceStageAdvance）', src.includes('announceStageAdvance'));
  check('照顾之后真的会调 announceStageAdvance',
    /if \(adv\) await announceStageAdvance\(adv, row\);/.test(src));
  check('破壳/羽化会记进事件流', /d\.events\.add\(\{[\s\S]{0,160}action,[\s\S]{0,80}note: text/.test(src));
  check('提示条会渲染', src.includes('renderHintBar'));
  check('renderAll 里会调 renderHintBar',
    /renderEvents\(state\);[\s\S]{0,80}renderHintBar\(state\)/.test(src));
  check('提示条的「去看看」会打开照顾弹窗',
    /pn-hint-go[\s\S]{0,320}openCareDialog\(pid\)/.test(src));
  check('没画像的宠物头上会挂金点', src.includes('pn-pet-dot'));
  check('该画脸时「换个模样」会点亮', src.includes('pn-btn-glow'));
  check('AI 上下文里会说明「还没有专属模样」', src.includes('它还没有专属模样'));
  check('css 有提示条样式', css.includes('.pn-hint-bar'));
  check('css 有金点样式', css.includes('.pn-pet-dot'));
  check('css 有按钮发光样式', css.includes('.pn-btn-glow'));
}

section('接线: 羽化后要提醒换新样（形态变了，旧图对不上）');
{
  const src = read('modules/pet-nest.js');
  check('羽化时会打上 needsRedraw 标记',
    /const divineNow = !!\(brief\.appearance && brief\.appearance\.kind === 'divine'\)/.test(src) &&
    /needsRedraw: divineNow \? true : !!pet\.needsRedraw/.test(src));
  check('画完新样会清掉 needsRedraw',
    /assetRef: asset\.id, needsRedraw: false/.test(src));
  check('新领养的宠物默认 needsRedraw=false',
    /assetRef: null,\s*\n\s*needsRedraw: false,/.test(src));
  check('提示条文案走 lookHint（不再写死「破壳了」）',
    /const hint = lookHint\(target\) \|\| \{\}/.test(src) &&
    /msg = hint\.text \|\| \(look\[0\]\.name \+ ' 还没有专属模样'\)/.test(src) &&
    !/msg = look\[0\]\.name \+ ' 破壳了/.test(src));
  check('金点提示走 lookHint',
    /dot\.title = \(lookHint\(pet\) \|\| \{\}\)\.dot/.test(src));
  check('照顾弹窗的说明走 lookHint',
    /p\.textContent = \(lookHint\(pet\) \|\| \{\}\)\.dialog/.test(src));
  check('AI 上下文走 lookHint',
    /\(lookHint\(pet\) \|\| \{\}\)\.ai/.test(src));
  check('羽化 toast 会顺带引导去画一张',
    /羽化成[了]?「[\s\S]{0,80}画一张新样子/.test(src));
  check('按钮会区分「换个新模样」', /pet\.needsRedraw \? '✨ 换个新模样'/.test(src));
  check('lookHint 导出到 rules（方便外部复用）',
    /rules\s*=|needsLook,\s*\n\s*lookHint,/.test(src));
  check('petView 要把 needsRedraw 带出来（不然 UI 层收不到，整个提醒机制失效）',
    /needsRedraw: !!pet\.needsRedraw/.test(src));
  check('canHatch 要排除已经孵出来的（stage>0 不该再说「蛋可以孵化了」）',
    /if \(Number\(pet\.stage \|\| 0\) > 0\) return false;/.test(src));
}

section('接线: 桌宠被弹窗挡住（用户实测点不动）');
{
  const src = read('modules/pet-nest.js');
  check('anyDialogOpen 既查 dialog[open] 也查 #custom-modal-overlay.visible',
    /function anyDialogOpen\(\)/.test(src) &&
    /document\.querySelector\('dialog\[open\]'\)/.test(src) &&
    /document\.querySelector\('#custom-modal-overlay\.visible'\)/.test(src));
  check('有统一的可见性出口 syncDesktopPetVisibility',
    /function syncDesktopPetVisibility\(\)/.test(src) &&
    /desktopPetEnabled\(\) && onChatScreen\(\) && !anyDialogOpen\(\)/.test(src));
  check('渲染桌宠走 syncDesktopPetVisibility',
    /syncDesktopPetVisibility\(\);\s*\n\s*if \(wrap\.hidden\) return;/.test(src));
  check('切屏时也走 syncDesktopPetVisibility',
    /const patched = function \(screenId\)[\s\S]{0,200}syncDesktopPetVisibility\(\);/.test(src) &&
    /window\.showScreen = patched;/.test(src));
  check('有没有在聊天界面看 .screen.active',
    /function onChatScreen\(\)[\s\S]{0,300}querySelectorAll\('\.screen\.active'\)/.test(src) &&
    /'chat-interface-screen'/.test(src));
  check('监听 open 和 class 两种变化（遮罩是加 class 不是加 open 属性）',
    /attributeFilter: \['open', 'class'\]/.test(src) &&
    /new MutationObserver/.test(src));
  check('有命中测试兜底：桌宠正中心被全屏遮罩吃掉就藏起来',
    /function computePetHitBlocked\(\)/.test(src) &&
    /document\.elementFromPoint\(x, y\)/.test(src) &&
    /function findFullScreenMask\(start\)/.test(src));
  check('命中测试要沿着父链往上找遮罩（命中的是遮罩里的小元素也得认出来）',
    /node = node\.parentElement;/.test(src));
  check('命中测试要放过「命中的是桌宠自己」的情况',
    /if \(hit === wrap \|\| wrap\.contains\(hit\)\) return false;/.test(src));
  check('重算带节流，不跟着页面 class 变化狂跑',
    /function scheduleVisibilitySync\(\)/.test(src) &&
    /const wait = 100 - \(now - lastVisibilitySyncAt\)/.test(src));
  check('「隐藏桌宠」改成幂等隐藏（不是来回切换）',
    /localStorage\.setItem\(STORAGE_KEYS\.desktopPetVisible, 'false'\)/.test(src) &&
    !/const next = !desktopPetEnabled\(\);/.test(src));
  // ===== 菜单按钮点不动（用户实测：两个按钮都没反应）=====
  check('菜单要用【id】判定，不是 class（菜单在 HTML 里只有 id，class 判定永远判不中）',
    /e\.target\.closest\('#pn-desktop-pet-menu'\)/.test(src) &&
    !/closest\('\.pn-desktop-pet-menu'\)/.test(src));
  check('index.html 的菜单要补上 class（双保险）',
    read('index.html').includes('id="pn-desktop-pet-menu" class="pn-desktop-pet-menu"'));
  check('菜单的两个按钮用事件委托（不靠按钮自己的 onclick，被覆盖也不怕）',
    /e\.target\.closest\('#pn-desktop-pet-enter'\)/.test(src) &&
    /e\.target\.closest\('#pn-desktop-pet-toggle'\)/.test(src));
  // ===== 进去没有桌宠（用户实测）=====
  check('桌宠的事件绑定和观察器要先装，不等 messageStore（否则要等 9 秒才生效）',
    /bindUi\(\);\s*\n\s*initDesktopPet\(\);\s*\n\s*startDesktopPetWatchdog\(\);/.test(src));
  check('有看门狗兜底：定期比对激活的屏 + 补丁被覆盖就重打',
    /function startDesktopPetWatchdog\(\)/.test(src) &&
    /readActiveScreenId\(\)/.test(src) &&
    /setInterval/.test(src));
  check('补丁用函数身上的标记判断，才能在被覆盖后重打',
    /window\.showScreen\.__pnPatched/.test(src) &&
    /patched\.__pnPatched = true/.test(src));
  check('库要先打开、界面先画出来（桌宠的图不能干等 messageStore）',
    /startDesktopPetWatchdog\(\);[\s\S]{0,300}await openDb\(\);[\s\S]{0,200}await refreshAll\(\);/.test(src));
}

section('幻兽盲盒: 物种 + 每天换一次造型');
{
  const R = loadRules();
  const src = read('modules/pet-nest.js');

  // --- 物种池 ---
  check('物种池够大（≥50 种）', R.BEAST_SPECIES.length >= 50, R.BEAST_SPECIES.length + ' 种');
  check('龙之九子全在',
    ['囚牛', '睚眦', '嘲风', '蒲牢', '狻猊', '霸下', '狴犴', '蚣蝮', '螭吻'].every(k => R.BEAST_SPECIES.some(s => s.cn === k)));
  check('保留了最初的四个（月光绒兽那批，老玩家还能抽到）',
    ['月光绒兽', '森林长耳兽', '星尘角兽', '潮汐软鳞兽'].every(k => R.BEAST_SPECIES.some(s => s.cn === k)));
  check('物种池不含家猫/家狗/鹦鹉（这三个有专门的；小熊猫、小龙猫不算）',
    !R.BEAST_SPECIES.some(s => /小猫|小狗|鹦鹉|犬|喵|家猫|猫狗|幼猫/.test(s.cn)));
  check('每个物种都有中文名和英文描述', R.BEAST_SPECIES.every(s => s.cn && s.en && s.en.length > 8));

  // --- 意象库 ---
  check('意象库够大（≥40 条）', R.ICON_LIBRARY.length >= 40, R.ICON_LIBRARY.length + ' 条');
  check('每条意象都有 cn/en/keys', R.ICON_LIBRARY.every(i => i.cn && i.en && Array.isArray(i.keys) && i.keys.length));
  check('意象不做身体结构变异（不出现翅膀/角/尾巴/鳞）',
    !R.ICON_LIBRARY.some(i => /翅膀|鹿角|龙尾|鳞片/.test(i.cn)));

  // --- 从当天内容现挑意象 ---
  const pickCoffee = R.pickIconsFromText('今天去喝了一杯拿铁咖啡', 1);
  check('能从当天聊的内容里挑出对应意象',
    pickCoffee.length === 1 && /咖啡|热饮/.test(pickCoffee[0].cn), pickCoffee[0] && pickCoffee[0].cn);
  check('挑不出就不硬凑', R.pickIconsFromText('zzz 什么也没有', 1).length === 0);
  const pickMulti = R.pickIconsFromText('看了电影又听了歌还读了书', 3);
  check('一天能挑出多个意象', pickMulti.length >= 2, pickMulti.map(i => i.cn).join('/'));

  // --- 物种盲盒 ---
  const b1 = R.beastSpeciesForSeed('seed-A');
  const b2 = R.beastSpeciesForSeed('seed-A');
  const b3 = R.beastSpeciesForSeed('seed-B');
  check('同一只永远同一物种（同一只不能变脸）',
    b1.species === b2.species && b1.palette === b2.palette, b1.species + '/' + b1.palette);
  check('不同种子能出不同物种', b1.species !== b3.species || b1.palette !== b3.palette,
    b1.species + ' vs ' + b3.species);
  check('物种/配色都在池子里',
    R.BEAST_SPECIES.some(s => s.cn === b1.species) && R.BEAST_PALETTES.some(p => p.cn === b1.palette));

  // --- 每天的造型 ---
  const look = R.dailyLookFor([{ type: 'reading', count: 1 }], '2026-01-01', 'seed-A', ['今天读了一本书']);
  check('当天内容能挑出小装饰', look.icons.length === 1, look.icons[0] && look.icons[0].cn);
  check('每天有一件穿搭', !!look.outfit && !!look.outfit.cn);

  // ⚠️ 用户 2026-10-25 定的：「听歌，看剧，摸摸，陪玩都不低频，
  //    干脆不根据这些加装饰了」→ 后来拍板「全删」——
  //    行为**一律**不体现在长相上，每天只靠「记忆小装饰 + 随机穿搭」变。
  const ALL_BEHAVIORS = ['listening', 'watching', 'reading', 'playing',
    'comforting', 'feeding', 'idle', 'chatting'];
  const withFeature = ALL_BEHAVIORS.filter(t =>
    R.dailyLookFor([{ type: t, count: 99 }], '2026-01-01', 'seed-A', []).features.length > 0);
  check('任何行为都不再产生形态特征（行为完全不体现在长相上）',
    withFeature.length === 0, '还长着的: ' + withFeature.join('/'));
  check('形态特征表是空的', Object.keys(R.BEHAVIOR_FEATURES).length === 0,
    Object.keys(R.BEHAVIOR_FEATURES).join('/'));
  check('喂食门槛常量已删（没有形态特征就不需要门槛，别留半死的代码）',
    !/FEEDING_FEATURE_MIN/.test(read('modules/pet-nest.js')),
    (read('modules/pet-nest.js').match(/FEEDING_FEATURE_MIN/g) || []).length + ' 处残留');
  check('行为仍然会被记录（听歌/看剧要记关系维度分，其余当「今天有动静」的触发）',
    ['listening', 'watching', 'reading', 'playing', 'comforting', 'feeding', 'chatting']
      .every(t => R.TRIGGER_SIGNALS.indexOf(t) >= 0), R.TRIGGER_SIGNALS.join('/'));

  // --- 提示词 ---
  const app = {
    beastSpecies: b1.species, beastSpeciesEn: b1.speciesEn, beastPaletteEn: b1.paletteEn,
    palette: b1.palette, marking: '心形绒纹'
  };
  const prompt = R.beastPrompt(app, look, 'a soft heart-shaped tuft on the chest');
  check('提示词里有物种', prompt.indexOf(b1.speciesEn) >= 0);
  check('提示词里有当天挑出来的装饰', look.icons.length ? prompt.indexOf(look.icons[0].en) >= 0 : true);
  check('提示词带审美锁（不许丑）',
    prompt.indexOf(R.ART_STYLE_LOCK) >= 0 && /chibi/.test(R.ART_STYLE_LOCK) && /big sparkly eyes/.test(R.ART_STYLE_LOCK));
  check('提示词全英文（不塞中文给生图模型）', !/[\u4e00-\u9fa5]/.test(prompt));

  const name = R.beastDisplayName(app, look);
  check('中文组合名能读出来', name.indexOf(b1.species) >= 0 && name.indexOf(b1.palette) >= 0, name);
  check('组合名不会出现「的的」（20 件穿搭的中文名全都以「的」结尾）',
    name.indexOf('的的') < 0, name);
  // 每一件穿搭单独用一次，都不能拼出「的的」
  const badNames = R.BEAST_OUTFITS.filter(o => {
    const n = R.beastDisplayName({ beastSpecies: '奶龙', palette: '粉红' },
      { features: [], icons: [], outfit: o });
    return n.indexOf('的的') >= 0;
  });
  check('20 件穿搭逐个试都不会拼出「的的」', badNames.length === 0,
    badNames.map(o => o.cn).join('/'));
}


section('接线: 行为信号上报到宠物屋');
{
  const musicSrc = read('modules/music-player.js');
  const cinemaSrc = read('modules/cinema-room.js');
  const readingSrc = read('modules/reading-room.js');
  const nestSrc = read('modules/pet-nest.js');
  const countOf = (s, re) => (s.match(re) || []).length;

  check('听歌会上报 listening', /reportSignal\('listening'/.test(musicSrc));
  check('看剧会上报 watching（放电影 + 追剧两处都要有，缺一处就漏记）',
    countOf(cinemaSrc, /reportSignal\('watching'/g) >= 2,
    countOf(cinemaSrc, /reportSignal\('watching'/g) + ' 处');
  check('阅读会上报 reading', /reportSignal\('reading'/.test(readingSrc));
  check('聊天会上报 chatting', /reportSignal\('chatting'/.test(nestSrc));
  check('喂食/陪玩/摸摸会上报', /'feeding'/.test(nestSrc) && /'playing'/.test(nestSrc) && /'comforting'/.test(nestSrc));
  check('TRIGGER_SIGNALS 是数组，判断得用 indexOf（`key in 数组` 查的是下标 → 信号永远不落库）',
    /TRIGGER_SIGNALS\.indexOf\(key\)\s*>=\s*0/.test(nestSrc) && !/key in TRIGGER_SIGNALS/.test(nestSrc));
  check('PetNestDB 升到 v3，有 dailySignals / dailyNotes',
    /d\.version\(3\)\.stores/.test(nestSrc) &&
    /dailySignals/.test(nestSrc) && /dailyNotes/.test(nestSrc));
  check('每天最多自动换一次造型',
    // ⚠️【2026-10-27】守卫改成【每只宠物一个 key】（原来一个全局 key → 一天只有一只能换）
    /petNestAutoLookDay::/.test(nestSrc));
  check('画不成就跳过，不报错不影响别的', /换造型失败（忽略/.test(nestSrc));
  check('生图有每日上限兜底', /window\.PetImage\.CFG/.test(nestSrc) && /dailyLimit/.test(nestSrc));
}

section('接线: index.html');
{
  const html = read('index.html');
  check('有宠物屋屏 #pet-nest-screen', html.includes('id="pet-nest-screen"'));
  check('有桌宠挂件容器 #pn-desktop-pet', html.includes('id="pn-desktop-pet"'));
  check('桌宠菜单有「进入小屋」', html.includes('id="pn-desktop-pet-enter"'));
  check('桌宠菜单有隐藏/显示开关', html.includes('id="pn-desktop-pet-toggle"'));
  check('引用了 pet-nest.js', /src="modules\/pet-nest\.js\?v=/.test(html));
  check('引用了 pet-nest.css', /href="css\/pet-nest\.css\?v=/.test(html));
  check('房间图指向 assets/pet-nest/', html.includes('assets/pet-nest/room-light.webp'));
  check('第二页是宠物屋入口', html.includes('onclick="openPetNest()"'));
  check('宠物屋图标槽位是 icon-img-pet-nest', html.includes('id="icon-img-pet-nest"'));
  check('小窝有返回键 #pn-back-btn', html.includes('id="pn-back-btn"'));
  check('领养下拉框有鹦鹉', html.includes('<option value="parrot">鹦鹉</option>'));
  check('邮箱入口已删', !html.includes('openEmailApp()') && !html.includes('id="email-screen"'));
  // script 必须在 message-store.js 之后, 否则攒粮钩子包不到
  const msIdx = html.indexOf('modules/message-store.js');
  const pnIdx = html.indexOf('modules/pet-nest.js');
  check('pet-nest.js 排在 message-store.js 之后', msIdx > 0 && pnIdx > msIdx,
    'message-store@' + msIdx + ' pet-nest@' + pnIdx);
}

section('接线: sw.js 预缓存');
{
  const sw = read('sw.js');
  check('预缓存了 pet-nest.js', sw.includes("'./modules/pet-nest.js'"));
  check('预缓存了 pet-nest.css', sw.includes("'./css/pet-nest.css'"));
  check('预缓存了 4 张图集',
    sw.includes("'./assets/pet-nest/room-light.webp'") &&
    sw.includes("'./assets/pet-nest/cat-sprites-light.webp'") &&
    sw.includes("'./assets/pet-nest/dog-sprites-light.webp'") &&
    sw.includes("'./assets/pet-nest/egg-sprites-light.webp'"));
  check('fetch 拦截白名单里有宠物屋',
    sw.includes("/modules/pet-nest.js") && sw.includes("/css/pet-nest.css") && sw.includes("/assets/pet-nest/"));
  const m = sw.match(/const CACHE_VERSION\s*=\s*'([^']+)'/);
  // 【为什么要比大小, 而不是只断言“不是旧值”】
  //   踩过的坑: 返回键那次只 bump 了 index.html 里模块的 ?v= (pet-nest.js 0.0.1→0.0.2),
  //   忘了 bump CACHE_VERSION。而 index.html 自己【不带 ?v=】, sw.js 对它是 cache-first ——
  //   SW 一直吐缓存里的旧 index.html, 返回键根本不出现, 只 bump 模块版本号完全没用。
  //   所以这里锁一个下限: 任何再改 index.html 的活, CACHE_VERSION 必须 >= 这个值。
  const ver = m ? m[1].replace(/^v/, '').split('.').map(Number) : null;
  const MIN = [0, 2, 78, 0];
  function verGte(a, b) {
    if (!a || a.length !== 4 || a.some((n) => !Number.isFinite(n))) return false;
    for (let i = 0; i < 4; i++) {
      if (a[i] > b[i]) return true;
      if (a[i] < b[i]) return false;
    }
    return true;
  }
  check('CACHE_VERSION >= v0.2.78.0（改过 index.html 就必须 bump，只 bump 模块 ?v= 没用）',
    verGte(ver, MIN), m ? m[1] : 'not found');
  check('index.html 在预缓存清单里（它走 cache-first，漏了会一直吐旧页面）',
    sw.includes("'./index.html'"));

  // 【本轮教训】改过模块文件就必须 bump 它在 index.html 里的 ?v= ——
  //   不 bump 的话手机上吃的是浏览器 HTTP 缓存里的旧模块，新功能（齿轮面板/饿死）根本不出现。
  //   这条断言把「改了 pet-nest.js / pet-nest.css / pet-image.js 却忘了 bump」变成会报红。
  const html = read('index.html');
  const EXPECT_V = {
    'modules/pet-nest.js': '0.0.23',
    'modules/pet-image.js': '0.0.4',
    'modules/pet-speech.js': '0.0.2',
    'modules/backup-import-export.js': '0.0.39',
    'modules/data-management.js': '0.0.39',
    'css/pet-nest.css': '0.0.13'
  };
  for (const [file, want] of Object.entries(EXPECT_V)) {
    const re = new RegExp(file.replace(/[/.]/g, '\\$&') + '\\?v=([0-9.]+)');
    const got = (html.match(re) || [])[1];
    check(file + ' 的 ?v= 已 bump 到 ' + want + '（不 bump 手机上吃旧版，新功能不出现）',
      got === want, '实际 ' + (got || '没找到'));
  }
}

section('接线: 鹦鹉（modules/pet-nest.js 源码级）');
{
  const src = read('modules/pet-nest.js');
  check('buildStageBrief 真的按 kind 分派（破壳 / 神兽 / 普通）',
    /stageBriefKind\(pet, target\)/.test(src));
  check('buildStageBrief 真的走了神兽分支',
    /if \(kind === 'divine'\)[\s\S]{0,160}buildDivineBrief/.test(src));
  check('破壳分支真的走了 computeHatchBrief',
    /if \(kind === 'hatch'\)[\s\S]{0,400}computeHatchBrief/.test(src));
  check('鹦鹉品种靠 parrotBreedFor 定（不是各写各的）',
    /parrotBreedFor\(pet\.seed \|\| pet\.id\)/.test(src));
  check('生图提示词认得鹦鹉', /pet\.kind === 'parrot'/.test(src));
  check('生图提示词认得神兽', /app\.kind === 'divine'/.test(src));
  check('场景会给孵出来的宠物加金辉 class',
    /btn\.classList\.add\('pn-pet-hatched'\)/.test(src));
  check('场景会给神兽加神兽 class',
    /btn\.classList\.add\('pn-pet-divine'\)/.test(src));
  check('桌面宠物也会吃光效',
    /sprite\.classList\.add\('pn-sprite-divine'\)/.test(src));
  check('AI 上下文会写鹦鹉的性子',
    /pet\.appearance && pet\.appearance\.note/.test(src));
}

section('接线: 动画与光效（css/pet-nest.css）');
{
  const css = read('css/pet-nest.css');
  check('有 6 格循环的关键帧 pn-frame-x', css.includes('@keyframes pn-frame-x'));
  check('有 6 格循环的关键帧 pn-frame-y', css.includes('@keyframes pn-frame-y'));
  check('切帧用 step-end（steps(2) 会让第三格一闪而过）',
    css.includes('pn-frame-x 9s step-end') && css.includes('pn-frame-y 18s step-end'));
  check('x 走 3 格 0/50/100', /pn-frame-x[\s\S]*?0%[\s\S]*?50%[\s\S]*?100%/.test(css));
  check('y 走 2 行 0/100', /pn-frame-y[\s\S]*?background-position-y: 0%[\s\S]*?background-position-y: 100%/.test(css));
  check('场景宠物带 pn-sprite-anim 才会动', css.includes('.pn-sprite-anim'));
  check('孵化有金辉 pn-hatch-glow', css.includes('@keyframes pn-hatch-glow'));
  check('神兽有更强的光 pn-divine-glow', css.includes('@keyframes pn-divine-glow'));
  check('神兽在场景里有独立 class', css.includes('.pn-pet-divine'));
  check('桌宠也吃得到光效', css.includes('#pn-desktop-pet-sprite.pn-sprite-divine'));
}

section('接线: 提示词与 AI 链路');
{
  const sp = read('modules/settings-presets.js');
  check('单聊提示词有 {{petNestContext}} 占位', sp.includes('{{petNestContext}}'));
  check('指令列表里有 pet_action', sp.includes('"type": "pet_action"'));
  check('pet_action 带 action 和 pet 字段', sp.includes('"action": "feed|play|comfort"') && sp.includes('"pet": "宠物名"'));

  const ar = read('modules/ai-response.js');
  check('contextMap 注入了 petNestContext', ar.includes("'petNestContext':"));
  check('有 case \'pet_action\' 分发', ar.includes("case 'pet_action':"));
  check('分发里调用 PetNest.handlePetAction', ar.includes('PetNest.handlePetAction'));
  check('分发里用 window.PetNest.getCachedContext 取上下文', ar.includes('window.PetNest.getCachedContext'));
}

section('接线: 悬浮球菜单');
{
  const fb = read('modules/floating-ball.js');
  check('菜单有宠物屋入口', fb.includes('data-action="pet-nest"'));
  check('菜单有桌宠开关', fb.includes('data-action="toggle-desktop-pet"'));
  check('桌宠开关文案跟着状态走', fb.includes('fb-desktop-pet-label'));
}

section('接线: 小窝的返回键');
{
  const pn = read('modules/pet-nest.js');
  const css = read('css/pet-nest.css');
  check('pet-nest.js 有 closePetNest', pn.includes('function closePetNest'));
  check('返回时回到进来时那一屏（不是写死主屏）', /pnReturnScreen/.test(pn));
  check('返回键绑上了 closePetNest', /backBtn\.onclick\s*=\s*closePetNest/.test(pn));
  check('window.PetNest 暴露了 close', /close:\s*closePetNest/.test(pn));
  check('CSS 有 .pn-back-btn 样式', css.includes('.pn-back-btn'));
  check('CSS 里返回键绝对定位（标题保持居中）', /\.pn-back-btn\s*\{[^}]*position:\s*absolute/.test(css));
}

section('接线: 图标可自定义');
{
  const ut = read('modules/utils.js');
  const at = read('modules/appearance-theme.js');
  check('DEFAULT_APP_ICONS 有 pet-nest 槽位', /'pet-nest':\s*''/.test(ut));
  check('图标设置页有「宠物屋」标签', at.includes("'pet-nest': '宠物屋'"));
  check('邮箱图标槽位已删', !/'mail':\s*''/.test(ut) && !at.includes("'mail': '邮箱'"));
}

// ============================================================
// ③ 邮箱下线
// ============================================================
section('下线: 邮箱必须没影');
{
  const files = ['index.html', 'sw.js', 'modules/misc-features.js', 'modules/init-event-bindingsB.js',
    'modules/backup-import-export.js', 'modules/data-management.js', 'modules/init-db-schema.js',
    'modules/utils.js', 'modules/appearance-theme.js', 'css/features-2.css'];
  const banned = [
    'db.emails', 'openEmailApp', 'renderEmailList', 'openEmailDetail',
    'email-screen', 'email-detail-screen', 'email-generator-modal', 'start-generate-email-btn'
  ];
  let bad = [];
  for (const f of files) {
    const txt = read(f);
    for (const b of banned) {
      // 备份导入端那句兼容注释里故意提到 db.emails, 放行注释行
      const hits = txt.split('\n').filter(line =>
        line.includes(b) && !line.trim().startsWith('//') && !line.trim().startsWith('*'));
      if (hits.length) bad.push(f + ' :: ' + b + ' (' + hits.length + ')');
    }
  }
  check('没有残留的邮箱代码引用', bad.length === 0, bad.join(' | '));

  const schema = read('modules/init-db-schema.js');
  check('主库升到 v71 并把 emails 设成 null', /db\.version\(71\)\.stores\(\{[\s\S]{0,120}emails:\s*null/.test(schema));
  check('v51 里不再声明 emails 表', !/emails:\s*'\+\+id, sender/.test(schema));

  const html = read('index.html');
  check('index.html 里 init-db-schema.js 的 ?v= 已 bump', /init-db-schema\.js\?v=0\.0\.4[3-9]/.test(html),
    (html.match(/init-db-schema\.js\?v=([0-9.]+)/) || [])[1]);
}

section('接线: 素材齐了');
{
  const dir = P('assets', 'pet-nest');
  const need = ['room-light.webp', 'cat-sprites-light.webp', 'dog-sprites-light.webp', 'egg-sprites-light.webp'];
  for (const n of need) {
    const p = path.join(dir, n);
    check('素材存在 ' + n, fs.existsSync(p), fs.existsSync(p) ? (fs.statSync(p).size + ' bytes') : 'MISSING');
  }
  check('署名文件在（MIT 要求保留版权声明）', fs.existsSync(path.join(dir, 'LICENSE-ASSETS.md')));
  const lic = fs.existsSync(path.join(dir, 'LICENSE-ASSETS.md'))
    ? fs.readFileSync(path.join(dir, 'LICENSE-ASSETS.md'), 'utf8') : '';
  check('署名里含 MIT 版权声明', lic.includes('Copyright (c) 2026 death34018-hue'));
  check('署名里含上游仓库地址', lic.includes('github.com/moonlin1213/cove-pet-nest'));
}


// ============================================================
// 桌宠可见性（要真跑 DOM, 所以单独一个沙箱）
//   2026-10-25 用户实测：「每次新进聊天页面，可移动宠物都看不见，
//   要先关掉再开才出现」—— 根因是【可见性】和【sprite 渲染】是两条路：
//   renderDesktopPet() 在「当前不在聊天页」时会提前 return，sprite 一直空着；
//   切进聊天页只走了 syncDesktopPetVisibility()（只管 hidden），没人去画 sprite。
// ============================================================
function loadDesktopPetSandbox() {
  const src = read('modules/pet-nest.js');
  const store = {};
  const screenState = { chat: false };
  const els = {};
  function mkEl(id) {
    return {
      id: id,
      hidden: false,
      dataset: {},
      style: {},
      textContent: '',
      classList: { _s: [], add() {}, remove() {}, contains() { return false; } },
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 60, height: 60 }),
      contains: () => false,
      addEventListener() {},
      append() {},
      appendChild() {},
      replaceChildren() {},
      querySelectorAll: () => []
    };
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn) => ({ fn: fn }),
    clearTimeout: () => {},
    setInterval: () => ({ fn: null }),
    clearInterval: () => {},
    TextEncoder,
    crypto: { randomUUID: () => 'test-uuid-0000' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    document: {
      readyState: 'loading',          // 不进 init()
      addEventListener() {},
      getElementById: (id) => {
        if (!els[id]) els[id] = mkEl(id);
        return els[id];
      },
      createElement: (tag) => mkEl(tag),
      querySelectorAll: (sel) =>
        (sel === '.screen.active' && screenState.chat ? [{ id: 'chat-interface-screen' }] : []),
      elementFromPoint: () => els['pn-desktop-pet-sprite'] || null,
      body: mkEl('body'),
      documentElement: mkEl('html')
    },
    Dexie: function () { throw new Error('规则测试不该碰 Dexie'); },
    innerWidth: 390,
    innerHeight: 844
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'pet-nest.js' });
  return {
    rules: sandbox.window.PetNest.rules,
    els: els,
    sandbox: sandbox,
    screenState: screenState,
    // getElementById 是懒创建的 → 元素要用过之后才在 els 里
    getEl: (id) => sandbox.document.getElementById(id)
  };
}

section('桌宠: 新进聊天页必须立刻画出来（用户 2026-10-25 实测）');
{
  const D = loadDesktopPetSandbox();
  const R = D.rules;
  const pet = { id: 'p1', name: '小花', kind: 'cat', stage: 0, sprite: 'cat-sprites-light.webp', satiety: 80 };
  const state = { pets: [pet], events: [], grains: 10, total: 1 };

  // ① 先在【别的界面】渲染一次 → 桌宠是藏着的，sprite 也没画
  D.screenState.chat = false;
  R.renderDesktopPet(state);
  const wrap = D.getEl('pn-desktop-pet');
  const sprite = D.getEl('pn-desktop-pet-sprite');
  check('不在聊天页时桌宠是藏着的', wrap.hidden === true);

  // ② 切进聊天页 → 只走可见性重算（这正是切屏时会发生的事）
  D.screenState.chat = true;
  sprite.style.backgroundImage = '';
  sprite.hidden = true;
  R.syncDesktopPetVisibility();
  check('切进聊天页后桌宠不藏了', wrap.hidden === false);
  check('切进聊天页后 sprite 【必须】被画出来（不然就是个空壳，看不见）',
    !!sprite.style.backgroundImage && sprite.hidden === false,
    'backgroundImage=' + String(sprite.style.backgroundImage));

  // ③ 再切走 → 又藏起来；再切回来 → 依然有图（不能画一次就丢）
  D.screenState.chat = false;
  R.syncDesktopPetVisibility();
  check('切走聊天页后桌宠又藏起来了', wrap.hidden === true);
  D.screenState.chat = true;
  R.syncDesktopPetVisibility();
  check('再切回聊天页，sprite 还是画好的', !!sprite.style.backgroundImage);
}

section('事件流: AI 用角色名 + 带时间戳（用户 2026-10-25 提）');
{
  const src = read('modules/pet-nest.js');
  check('事件里记下了是谁做的（actorName）',
    /actorName:\s*\(opts\.actorName \|\| ''\)/.test(src));
  check('AI 的名字是从聊天对象读的（单聊 chat.name / 群聊成员昵称）',
    /function assistantNameFor/.test(src) && /chat\.name \|\| chat\.originalName/.test(src)
    && /groupNickname \|\| m\.originalName/.test(src));
  check('handlePetAction 把角色名传给了 care()',
    /actorName:\s*assistantNameFor\(msgData, chat\)/.test(src));
  check('事件流不再写死「TA」，改用记录下来的角色名',
    /ev\.actorName \|\| 'TA'/.test(src) && !/ev\.actor === 'user' \? '我' : 'TA'/.test(src));
  check('事件流带时间戳', /function eventTimeLabel/.test(src) && /pn-event-time/.test(src));
  check('时间戳有样式（别跟正文一样大）',
    /#pet-nest-screen \.pn-event-time \{/.test(read('css/pet-nest.css')));
}

section('返回键: 别被手机状态栏挡住（用户 2026-10-25 实测）');
{
  const css = read('css/pet-nest.css');
  check('头部让开安全区（env(safe-area-inset-top)）',
    /padding:\s*calc\(18px \+ env\(safe-area-inset-top/.test(css));
  check('返回键也往下挪了安全区',
    /top:\s*calc\(12px \+ env\(safe-area-inset-top/.test(css));
  check('返回键不再是死写的 12px', !/#pet-nest-screen \.pn-back-btn \{[^}]*top:\s*12px;/.test(css));
}

// ============================================================
// 异步段: 调度守卫 + 代表词来源（要真跑 promise, 所以放最后）
// ============================================================
(async () => {

section('备份: 宠物屋得跟着走（用户 2026-10-26 提：换窗不能重新养一只）');
{
  const R = loadRules();

  // ① 哪些样貌图进备份：每只宠物最新几张 + 当前这张必带
  const assets = [
    { id: 'a1', petId: 'p1', createdAt: 100 },
    { id: 'a2', petId: 'p1', createdAt: 200 },
    { id: 'a3', petId: 'p1', createdAt: 300 },
    { id: 'a4', petId: 'p1', createdAt: 400 },
    { id: 'b1', petId: 'p2', createdAt: 50 }
  ];
  const capped = R.selectAssetsForBackup(assets, [{ id: 'p1', assetRef: 'a3' }], 2);
  const ids = capped.map(r => r.id);
  check('超上限时只带最新的两张 + 当前这张（当前这张不占配额）',
    ids.includes('a4') && ids.includes('a3') && ids.includes('a2') && !ids.includes('a1'),
    ids.join(','));
  check('每只宠物分开算（p2 的图不受 p1 的上限影响）', ids.includes('b1'), ids.join(','));
  const withOldCurrent = R.selectAssetsForBackup(assets, [{ id: 'p1', assetRef: 'a1' }], 2);
  check('当前这张哪怕最旧也必带（不然恢复后宠物没脸）',
    withOldCurrent.map(r => r.id).includes('a1'), withOldCurrent.map(r => r.id).join(','));
  check('没有宠物时也不会炸', Array.isArray(R.selectAssetsForBackup([], [], 2)));

  // ② Blob ↔ base64（备份里存的是 data URL）
  const blob = new Blob([new Uint8Array([1, 2, 3, 250, 0, 255])], { type: 'image/webp' });
  const url = await R.blobToDataUrl(blob);
  check('Blob 能转成 data URL', String(url).startsWith('data:image/webp;base64,'), String(url).slice(0, 40));
  const back = await R.dataUrlToBlob(url);
  check('data URL 能转回 Blob', !!back && back.type === 'image/webp');
  check('转回来的内容一模一样',
    !!back && new Uint8Array(await back.arrayBuffer()).length === 6);
  check('空数据不会炸', (await R.blobToDataUrl(null)) === '' && (await R.dataUrlToBlob('')) === null);

  // ③ 接线：备份模块要把宠物屋这一节带进去/还回来
  const pn = read('modules/pet-nest.js');
  const bi = read('modules/backup-import-export.js');
  check('宠物屋自己提供导出/恢复两个口子',
    /exportBackupData,/.test(pn) && /importBackupData,/.test(pn));
  check('导出会带全部九张表（宠物/阶段/事件/粮仓/图…）',
    /const BACKUP_TABLES = \[[\s\S]{0,300}'assets'/.test(pn));
  check('样貌图上限是按只算的（免得备份被撑爆）',
    /BACKUP_ASSET_KEEP_PER_PET = \d+/.test(pn));
  check('备份导出时把宠物屋带上了', /petNest: await exportPetNestBackup\(\)/.test(bi));
  check('四条导出路径都带了宠物屋（JSON/流式/分片ZIP）',
    (bi.match(/exportPetNestBackup\(\)/g) || []).length >= 4,
    (bi.match(/exportPetNestBackup\(\)/g) || []).length + ' 处');
  check('导入时把宠物屋还回去了（新版 + 旧版两条路）',
    (bi.match(/importPetNestBackup\(backupData\.petNest\)/g) || []).length >= 2);
  check('选择性导入时宠物屋不走主库表', /if \(type === 'petNest'\) continue;/.test(bi));
  check('localStorage 前缀清单里有 petNest / petSpeech（桌宠开关、生图配置、上次开口时间）',
    /'petNest',\s*\/\/ 宠物屋/.test(bi) && /'petSpeech',/.test(bi));
  check('老备份（没有宠物屋这一节）不会报错',
    /reason: 'no_data'/.test(pn) && /备份中没有宠物屋数据/.test(bi));
  check('「重置所有数据」也会把宠物屋一起清掉（不然宠物比数据活得久）',
    /清理宠物屋数据失败/.test(read('modules/data-management.js')));
}
// ============================================================
// 调度守卫 + 代表词来源（要真跑 promise, 所以放最后）
//   守卫是【钱】的防线；代表词是「当天挑什么小装饰」的来源。
//   光用正则查源码查不出行为 = 没测到，
//   所以这里起一个假 Dexie + 假 PetImage 探针, 把整套流程真跑一遍。
// ============================================================
section('调度守卫 + 代表词来源（真跑一遍）');
{
  const petNestSrc = read('modules/pet-nest.js');
  const ARRAY_TABLES = ['dailySignals', 'dailyNotes'];
  const OBJ_TABLES = ['pets', 'events', 'stages', 'days', 'turns', 'meta', 'assets'];

  /**
   * 起一个能跑 PetNest 整套流程的沙箱。
   * cfg: { lastLookDay, used, noSignals, chats, memory }
   * 返回 { sandbox, calls, day, meta, rows }
   *   calls.atlas = 「真的去调生图接口」的次数
   *   rows.dailySignals / rows.dailyNotes = 落库的原始行
   */
  function makeSandbox(cfg) {
    cfg = cfg || {};
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const calls = { atlas: 0 };
    const rows = {
      pets: {
        'pet-1': {
          id: 'pet-1', kind: 'egg', stage: 2, seed: 'seed-A', createdAt: 1, name: '团子',
          // 饱腹要像样：默认 0 + settledAt=1（1970 年）会被当成「饿了 3 天」一 refresh 就扫掉
          satiety: 60, settledAt: Date.now(),
          appearance: {
            beastSpecies: '奶龙', beastSpeciesEn: 'a chubby round baby dragon with big friendly eyes',
            palette: '粉红', beastPaletteEn: 'pastel pink', marking: '心形绒纹'
          }
        }
      },
      events: {}, stages: {}, assets: {}, days: {}, turns: {},
      dailyNotes: [],
      dailySignals: cfg.noSignals ? [] : [{ day: day, type: 'listening', at: Date.now() }]
    };
    const meta = { petNestLastAutoLookDay: cfg.lastLookDay === undefined ? '' : cfg.lastLookDay };
    // ⚠️【2026-10-27】每日换装的守卫改成【每只宠物一个 key】：
    //   原来只有一个全局 key → 一天只有一只（最早领养的那只）能换装。
    meta['petNestAutoLookDay::pet-1'] = cfg.lastLookDay === undefined ? '' : cfg.lastLookDay;

    const all = ARRAY_TABLES.concat(OBJ_TABLES);
    let autoId = 0;
    const d = {};
    for (const n of all) {
      const isArr = ARRAY_TABLES.indexOf(n) >= 0;
      const listOf = () => (isArr ? rows[n] : Object.keys(rows[n]).map(kk => rows[n][kk]));
      d[n] = {
        async get(k) {
          if (n === 'meta') return meta[k] === undefined ? undefined : { key: k, value: meta[k] };
          if (isArr) return rows[n].find(r => r.id === k);
          return rows[n][k];
        },
        async put(v) {
          if (n === 'meta') { meta[v.key] = v.value; return v.key; }
          if (isArr) { rows[n].push(v); return v.id; }
          const k = (v.id || v.key || ('auto' + (++autoId)));
          rows[n][k] = v; return k;
        },
        async add(v) {
          if (n === 'meta') { meta[v.key] = v.value; return v.key; }
          if (isArr) { rows[n].push(v); return v.id; }
          const k = (v.id || v.key || ('auto' + (++autoId)));
          rows[n][k] = v; return k;
        },
        async delete(k) {
          if (n === 'meta') { delete meta[k]; return; }
          if (isArr) {
            const i = rows[n].findIndex(r => r.id === k);
            if (i >= 0) rows[n].splice(i, 1);
            return;
          }
          delete rows[n][k];
        },
        async update(k, patch) {
          if (rows[n] && rows[n][k]) Object.assign(rows[n][k], patch);
          return 1;
        },
        where(field) {
          return {
            equals(v) {
              return {
                async toArray() { return listOf().filter(r => r[field] === v); },
                async delete() {
                  if (isArr) {
                    const keep = rows[n].filter(r => r[field] !== v);
                    rows[n].length = 0;
                    for (const r of keep) rows[n].push(r);
                    return;
                  }
                  for (const kk of Object.keys(rows[n])) {
                    if (rows[n][kk] && rows[n][kk][field] === v) delete rows[n][kk];
                  }
                }
              };
            },
            belowOrEqual(v) { return { async count() { return listOf().filter(r => Number(r[field]) <= Number(v)).length; } }; }
          };
        },
        orderBy(field) {
          const api = {
            async first() {
              const arr = listOf().slice().sort((a, b) => Number(a[field] || 0) - Number(b[field] || 0));
              return arr[0];
            },
            async toArray() {
              return listOf().slice().sort((a, b) => Number(a[field] || 0) - Number(b[field] || 0));
            },
            // 假 Dexie：reverse / limit 只为让链式调用不炸，语义不严格
            reverse() { return api; },
            limit() { return api; }
          };
          return api;
        },
        async toArray() { return listOf(); }
      };
    }
    d.version = () => d;
    d.stores = () => d;
    d.open = async () => d;

    // 沙箱里 console 默认静音，但 warn/error 要放出来 —— 渲染路径静默失败会让人误判成「没数据」。
    // 探针的报错是预期的（它就是拿来探到底的），滤掉免得刷屏。
    const quiet = {
      log() {},
      warn() { if (!/探针/.test(String(arguments[0]))) console.warn('[沙箱 warn]', ...arguments); },
      error() { console.error('[沙箱 error]', ...arguments); },
      info() {}
    };
    // DOM 桩：只在 cfg.dom 时启用，且只认下面这些 id，
    // 免得把 renderAll 里别的渲染路径也拉进来（那些路径不该影响本组断言）
    const DEFAULT_DOM_IDS = [
      'pn-manage-dialog', 'pn-manage-rules', 'pn-manage-list',
      'pn-hint-bar', 'pn-hint-text', 'pn-hint-icon', 'pn-hint-go'
    ];
    const domIds = cfg.domIds || DEFAULT_DOM_IDS;
    const domEls = {};
    function mkStub(id) {
      return {
        id: id,
        open: false,
        hidden: false,
        textContent: '',
        className: '',
        type: '',
        onclick: null,
        dataset: {},
        style: {},
        children: [],
        classList: {
          _s: [],
          add(c) { this._s.push(c); },
          remove(c) { this._s = this._s.filter(x => x !== c); },
          contains(c) { return this._s.indexOf(c) >= 0; },
          toggle(c, on) { if (on === false) this.remove(c); else this.add(c); }
        },
        setAttribute() {},
        removeAttribute() {},
        append() { this.children.push(...arguments); },
        appendChild(n) { this.children.push(n); return n; },
        replaceChildren() { this.children = Array.from(arguments); },
        showModal() { this.open = true; },
        close() { this.open = false; },
        addEventListener() {},
        removeEventListener() {}
      };
    }
    const toasts = [];
    const confirmCalls = [];
    const sandbox = {
      console: quiet,
      // 假定时器: reportSignal 会排一个 60 秒的「换造型」定时器,
      // 真定时器会把 node 卡住 60 秒, 所以这里只登记不执行
      setTimeout: (fn, ms) => ({ fn: fn, ms: ms }),
      clearTimeout: () => {},
      setInterval: (fn, ms) => ({ fn: fn, ms: ms }),
      clearInterval: () => {},
      TextEncoder,
      crypto: { randomUUID: () => 'test-uuid-0000' },
      localStorage: { getItem: () => null, setItem() {} },
      document: {
        readyState: 'loading',       // 不进 init(), 免得真去开 Dexie
        addEventListener() {},
        getElementById: (id) => {
          if (!cfg.dom) return null;
          if (domIds.indexOf(id) < 0) return null;
          if (!domEls[id]) domEls[id] = mkStub(id);
          return domEls[id];
        },
        createElement: (tag) => mkStub(tag),
        // renderEvents 拼文本节点用（系统事件的原文）
        createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
        querySelectorAll: () => []
      },
      Dexie: function () { return d; },
      state: { chats: cfg.chats || {} },
      // 放弃宠物的二次确认（用户点了「取消」就绝不能删）
      showCustomConfirm: async (title, message, opts) => {
        confirmCalls.push({ title: title, message: message, opts: opts });
        return cfg.confirmResult !== false;
      },
      showToast: (text, type) => { toasts.push({ text: text, type: type }); },
      PetImage: {
        CFG: { dailyLimit: 3 },
        todayCount: () => Number(cfg.used || 0),
        async generateAtlas() { calls.atlas++; throw new Error('探针：到这一步就停'); },
        async evolveAtlas() { calls.atlas++; throw new Error('探针：到这一步就停'); },
        async saveAsset() { return { id: 'asset-1' }; }
      }
    };
    if (cfg.memory) {
      sandbox.vectorMemoryManager = { getAllFragments: () => (cfg.memory || []) };
    }
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(petNestSrc, sandbox, { filename: 'pet-nest.js' });
    return { sandbox, calls, day, meta, rows, domEls, toasts, confirmCalls };
  }

  // ===== 调度守卫（钱）=====
  // --- 基准: 什么都不拦着的时候, 确实会真的去调生图（证明探针是通的）---
  const base = makeSandbox({ lastLookDay: '', used: 0 });
  await base.sandbox.window.PetNest.refreshDailyLook('pet-1');
  check('基准：没有守卫时会真的去调生图（探针是通的，不然守卫测试就是假通过）',
    base.calls.atlas === 1, 'atlas 调用 ' + base.calls.atlas + ' 次');

  // --- 守卫 1: 今天已经画过了, 不能再画 ---
  const g1 = makeSandbox({ lastLookDay: base.day, used: 0 });
  await g1.sandbox.window.PetNest.refreshDailyLook('pet-1');
  check('今天画过了就不再画（一天一次，别烧钱）',
    g1.calls.atlas === 0, 'atlas 调用 ' + g1.calls.atlas + ' 次');
  check('今天画过了：也不会把守卫标记往后推',
    g1.meta['petNestAutoLookDay::pet-1'] === base.day, g1.meta['petNestAutoLookDay::pet-1']);

  // --- 守卫 2: 每日上限 ---
  const g2 = makeSandbox({ lastLookDay: '', used: 3 });
  await g2.sandbox.window.PetNest.refreshDailyLook('pet-1');
  check('每日上限用满了就不再画（dailyLimit=3）',
    g2.calls.atlas === 0, 'atlas 调用 ' + g2.calls.atlas + ' 次');

  // --- 前置闸门: 当天啥也没发生, 不画（没东西可挑, 硬画就是随机凑）---
  const g3 = makeSandbox({ lastLookDay: '', used: 0, noSignals: true });
  await g3.sandbox.window.PetNest.refreshDailyLook('pet-1');
  check('当天没有任何行为就不画（没代表词可挑）',
    g3.calls.atlas === 0, 'atlas 调用 ' + g3.calls.atlas + ' 次');

  // --- 画失败要静默（不能把别的功能带崩）---
  const g4 = makeSandbox({ lastLookDay: '', used: 0 });
  const r4 = await g4.sandbox.window.PetNest.refreshDailyLook('pet-1');
  check('画失败不抛错（静默跳过，造型保持上一张）', r4 === null || r4 === false, String(r4));

  // ===== 代表词来源 ①: 长期记忆碎片的【标签】也要参与 =====
  const m1 = makeSandbox({
    lastLookDay: '', used: 0,
    chats: { c1: { id: 'c1' } },
    memory: [{ content: '今天有点累', tags: ['咖啡'], createdAt: Date.now() }]
  });
  const m1texts = await m1.sandbox.window.PetNest.rules.todayRepresentativeTexts();
  check('长期记忆碎片的标签也参与代表词（不然只打了标签的碎片挑不出装饰）',
    /咖啡/.test(m1texts.join(' ')), JSON.stringify(m1texts));
  const m1icons = m1.sandbox.window.PetNest.rules.pickIconsFromText(m1texts.join(' '), 1);
  check('记忆标签里的词能挑出小装饰（咖啡 → 一杯热饮）',
    m1icons.length === 1 && /咖啡|热饮/.test(m1icons[0].cn), m1icons[0] && m1icons[0].cn);

  // ===== 代表词来源 ②: 当天聊过的话要存进 dailyNotes =====
  const m2 = makeSandbox({ lastLookDay: '', used: 0 });
  await m2.sandbox.window.PetNest.recordConversation({
    chatId: 'c1', turnId: 't1', userText: '今天去喝了杯拿铁', aiText: '好喝'
  });
  check('当天聊的话存进了 dailyNotes（代表词的第二个来源）',
    m2.rows.dailyNotes.length === 1 && /拿铁/.test(m2.rows.dailyNotes[0].text || ''),
    JSON.stringify(m2.rows.dailyNotes));
  const m2texts = await m2.sandbox.window.PetNest.rules.todayRepresentativeTexts();
  check('当天聊的话能在代表词里找到',
    /拿铁/.test(m2texts.join(' ')), JSON.stringify(m2texts));
  check('聊天会上报 chatting 信号（触发换造型）',
    m2.rows.dailySignals.some(s => s.type === 'chatting'),
    JSON.stringify(m2.rows.dailySignals.map(s => s.type)));

  // ===== 代表词来源 ③: 聊天里提到什么 → 也算今天经历的一部分 =====
  const m3 = makeSandbox({ lastLookDay: '', used: 0 });
  await m3.sandbox.window.PetNest.recordConversation({
    chatId: 'c1', turnId: 't2', userText: '今天看了一部电影', aiText: '好看'
  });
  check('聊天里提到电影 → 上报 watching 信号',
    m3.rows.dailySignals.some(s => s.type === 'watching'),
    JSON.stringify(m3.rows.dailySignals.map(s => s.type)));

  // ===== 饿死 + 放弃（真跑一遍）=====
  const D = 86400000;
  const now = Date.now();

  // ① 饿了 4 天的 → 扫掉
  const X = makeSandbox({ lastLookDay: '', used: 0 });
  X.rows.pets['pet-1'].satiety = 0;
  X.rows.pets['pet-1'].settledAt = now - 4 * D;
  X.rows.stages['pet-1::2'] = { key: 'pet-1::2', petId: 'pet-1', stage: 2 };
  X.rows.events.e1 = { id: 'e1', petId: 'pet-1', actor: 'user', action: 'feed', createdAt: now - D };
  X.rows.assets.a1 = { id: 'a1', petId: 'pet-1', stage: 2 };
  const gone = await X.sandbox.window.PetNest.rules.sweepStarvedPets(now);
  check('饿过 3 天的会被扫掉', gone.length === 1 && gone[0] === '团子', JSON.stringify(gone));
  check('饿死：本体被删了', !X.rows.pets['pet-1']);
  check('饿死：阶段记录被删了', !X.rows.stages['pet-1::2']);
  check('饿死：照顾事件被删了', !Object.values(X.rows.events).some(e => e.petId === 'pet-1'));
  check('饿死：生图资产被删了', !X.rows.assets.a1);
  check('饿死：留了一条系统事件说明它走了',
    Object.values(X.rows.events).some(e => e.actor === 'system' && /离开/.test(e.note || '')),
    JSON.stringify(Object.values(X.rows.events).map(e => e.note)));

  // ② 只饿 2 天的 → 不动
  const Y = makeSandbox({ lastLookDay: '', used: 0 });
  Y.rows.pets['pet-1'].satiety = 0;
  Y.rows.pets['pet-1'].settledAt = now - 2 * D;
  const gone2 = await Y.sandbox.window.PetNest.rules.sweepStarvedPets(now);
  check('只饿 2 天的不会被删', gone2.length === 0 && !!Y.rows.pets['pet-1'], JSON.stringify(gone2));

  // ③ 手动放弃 → 也删干净
  const Z = makeSandbox({ lastLookDay: '', used: 0 });
  Z.rows.stages['pet-1::2'] = { key: 'pet-1::2', petId: 'pet-1', stage: 2 };
  Z.rows.events.e1 = { id: 'e1', petId: 'pet-1', actor: 'user', action: 'feed', createdAt: now };
  Z.rows.assets.a1 = { id: 'a1', petId: 'pet-1', stage: 2 };
  const rm = await Z.sandbox.window.PetNest.rules.removePet('pet-1', 'remove');
  check('手动放弃：返回成功', rm && rm.ok === true, JSON.stringify(rm));
  check('手动放弃：本体没了', !Z.rows.pets['pet-1']);
  check('手动放弃：阶段/事件/资产也清了',
    !Z.rows.stages['pet-1::2']
    && !Object.values(Z.rows.events).some(e => e.petId === 'pet-1')
    && !Z.rows.assets.a1);
  check('手动放弃：也留了一条系统事件',
    Object.values(Z.rows.events).some(e => e.actor === 'system' && /送走/.test(e.note || '')));
}

section('弹窗: 确认框别被自家 dialog 压住 + 换成宠物屋的样式（用户 2026-10-26 实测）');
{
  const S = makeSandbox({
    dom: true,
    domIds: ['pn-care-dialog', 'pn-manage-dialog', 'custom-modal-overlay']
  });
  const dlg = S.sandbox.document.getElementById('pn-care-dialog');
  const overlay = S.sandbox.document.getElementById('custom-modal-overlay');
  dlg.open = true;   // 照顾弹窗开着（真实场景：点「换样貌」的时候它就是开着的）

  let openAtConfirm = null;
  let skinAtConfirm = null;
  S.sandbox.showCustomConfirm = async () => {
    openAtConfirm = dlg.open;
    skinAtConfirm = overlay.classList.contains('pn-modal-skin');
    return true;
  };

  const ok = await S.sandbox.window.PetNest.rules.petConfirm('放弃 团子', '确定吗？', {});
  check('问确认的时候，自家的 <dialog> 已经先收起来了',
    openAtConfirm === false, 'dialog 还开着=' + openAtConfirm);
  check('确认框套上了宠物屋的暖色皮肤', skinAtConfirm === true);
  check('问完把 <dialog> 开回去（用户不用再点一次）', dlg.open === true);
  check('皮肤用完就摘掉（不影响全应用其它弹窗）',
    overlay.classList.contains('pn-modal-skin') === false);
  check('确认结果照常返回', ok === true);

  // 取消也要把 dialog 开回去
  const S2 = makeSandbox({
    dom: true,
    domIds: ['pn-care-dialog', 'custom-modal-overlay']
  });
  const dlg2 = S2.sandbox.document.getElementById('pn-care-dialog');
  dlg2.open = true;
  S2.sandbox.showCustomConfirm = async () => false;
  const ok2 = await S2.sandbox.window.PetNest.rules.petConfirm('放弃 团子', '确定吗？', {});
  check('点了取消 → 不删，但 <dialog> 照样开回去', ok2 === false && dlg2.open === true);

  // CSS：动画放慢了 + 皮肤规则在
  const css = read('css/pet-nest.css');
  check('6 格姿势循环：每格停 3 秒（x 9s / y 18s，一轮 18 秒）',
    /pn-frame-x 9s step-end/.test(css) && /pn-frame-y 18s step-end/.test(css));
  check('皮肤规则只挂在 pn-modal-skin 上（不污染全应用弹窗）',
    /#custom-modal-overlay\.pn-modal-skin #custom-modal/.test(css)
    && !/^\s*#custom-modal \{/m.test(css));
  const pnSrc = read('modules/pet-nest.js');
  check('放弃宠物 / 换样貌都走 petConfirm（不然照样被自家 dialog 压住）',
    (pnSrc.match(/await petConfirm\(/g) || []).length >= 2,
    (pnSrc.match(/await petConfirm\(/g) || []).length + ' 处');
}

section('蛋还没孵化：说话开关是灰的，而且写清楚为什么（用户 2026-10-26 提）');
{
  const html = read('index.html');
  const pn = read('modules/pet-nest.js');
  const ps = read('modules/pet-speech.js');
  check('照顾弹窗里有一句「为什么开关是灰的」说明',
    /id="pn-speech-hint"/.test(html));
  check('蛋阶段把说明显示出来（并算出还差多少成长值）',
    /swHint\.hidden = false/.test(pn) && /成长还差/.test(pn));
  check('不是蛋就把说明藏起来',
    /swHint\.hidden = true/.test(pn));
  check('蛋阶段的两个开关确实是禁用的',
    /swSpeak\.disabled = isEgg/.test(pn) && /swInsert\.disabled = isEgg/.test(pn));
  check('说话系统那边也有一道蛋的关卡（双重保险，不是只靠界面禁用）',
    /还是颗蛋就不会说话/.test(ps) && /isEggPet\(petRow\)/.test(ps));
  check('「是不是蛋」按物种判，不是光看阶段（猫狗第 0 阶段不是蛋）',
    /isHatchKind\(pet\.kind\) && Number\(pet\.stage \|\| 0\) <= 0/.test(pn)
    && /isHatchKind/.test(ps));
  check('成长值差多少是按门槛常量算的（门槛改了这里跟着改）',
    /STAGE_RULES_HATCH\[1\]\[0\]/.test(pn));
}

section('桌宠气泡: 宠物说话的时候别被饥饿提示盖掉（宠物说话系统 2026-10-26）');
{
  const D = loadDesktopPetSandbox();
  const hungry = { id: 'p1', name: '小花', kind: 'cat', stage: 0, sprite: 'cat-sprites-light.webp', satiety: 0, starving: true };

  // ① 没人说话的时候 → 照旧弹饥饿提示
  D.sandbox.window.PetSpeech = { isBubbleActive: () => false };
  D.rules.renderDesktopPetContent(hungry);
  const bubble = D.getEl('pn-desktop-pet-bubble');
  check('没人说话时桌宠照旧催你喂',
    bubble.hidden === false && /喂/.test(String(bubble.textContent)),
    String(bubble.textContent));

  // ② 宠物正在说话 → 气泡归它用，饥饿提示不许盖掉
  D.sandbox.window.PetSpeech = { isBubbleActive: () => true };
  bubble.hidden = false;
  bubble.textContent = '我想睡觉了';
  D.rules.renderDesktopPetContent(hungry);
  check('宠物说话时不会被饥饿提示盖掉',
    String(bubble.textContent) === '我想睡觉了',
    String(bubble.textContent));

  // ③ 宠物说完了 → 饥饿提示重新接管
  D.sandbox.window.PetSpeech = { isBubbleActive: () => false };
  D.rules.renderDesktopPetContent(hungry);
  check('宠物说完之后饥饿提示重新接管',
    /喂/.test(String(bubble.textContent)),
    String(bubble.textContent));
}

section('小屋管理: 齿轮面板 + 放弃宠物（用户 2026-10-25 提）');
{
  const html = read('index.html');
  const css = read('css/pet-nest.css');
  const src = read('modules/pet-nest.js');

  // ① 接线：齿轮按钮 + 面板在 HTML 里
  check('小窝右上角有齿轮按钮', /id="pn-manage-btn"/.test(html));
  check('齿轮按钮是 ⚙', /id="pn-manage-btn"[^>]*>⚙</.test(html));
  check('有管理面板 dialog', /<dialog id="pn-manage-dialog">/.test(html));
  check('面板里有规则说明位和列表位',
    /id="pn-manage-rules"/.test(html) && /id="pn-manage-list"/.test(html));
  check('齿轮按钮点了会开面板', /manageBtn\.onclick = \(\) => openManageDialog\(\)/.test(src));
  check('面板有危险按钮样式', /\.pn-manage-danger \{/.test(css));

  // ② 行为：点放弃 → 弹二次确认 → 确认后才真删
  const M = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  M.rows.stages['pet-1::2'] = { key: 'pet-1::2', petId: 'pet-1', stage: 2 };
  M.rows.events.e1 = { id: 'e1', petId: 'pet-1', actor: 'user', action: 'feed', createdAt: Date.now() };
  M.rows.assets.a1 = { id: 'a1', petId: 'pet-1', stage: 2 };
  await M.sandbox.window.PetNest.rules.doRemovePet({ id: 'pet-1', name: '团子' });
  check('放弃前要弹二次确认（防止手滑删掉）',
    M.confirmCalls.length === 1, JSON.stringify(M.confirmCalls.map(c => c.title)));
  check('二次确认里写清楚了「不可恢复」',
    /不可恢复/.test(String(M.confirmCalls[0] && M.confirmCalls[0].message)));
  check('确认后宠物真的没了', !M.rows.pets['pet-1']);
  check('确认后阶段/事件/资产也清了',
    !M.rows.stages['pet-1::2']
    && !Object.values(M.rows.events).some(e => e.petId === 'pet-1')
    && !M.rows.assets.a1);

  // ③ 用户点「取消」→ 绝不能删
  const N = makeSandbox({ lastLookDay: '', used: 0, dom: true, confirmResult: false });
  await N.sandbox.window.PetNest.rules.doRemovePet({ id: 'pet-1', name: '团子' });
  check('用户点了取消 → 宠物还在（没误删）', !!N.rows.pets['pet-1']);
  check('用户点了取消 → 也没弹「送走了」的提示',
    !N.toasts.some(t => /送走/.test(t.text || '')),
    JSON.stringify(N.toasts.map(t => t.text)));

  // ④ 面板列表：列出每只宠物 + 饱腹/饥饿信息
  const P2 = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  P2.rows.pets['pet-1'].satiety = 0;
  P2.rows.pets['pet-1'].settledAt = Date.now() - 2.5 * 86400000;
  await P2.sandbox.window.PetNest.refresh();
  P2.sandbox.window.PetNest.rules.renderManageList();
  const listEl = P2.domEls['pn-manage-list'];
  const rulesEl = P2.domEls['pn-manage-rules'];
  const petRows = listEl ? listEl.children.filter(c => c.className === 'pn-manage-row') : [];
  check('面板里列出了宠物', petRows.length === 1,
    '宠物行 ' + petRows.length);
  check('规则说明写了「3 天会离开」',
    /3 天/.test(String(rulesEl && rulesEl.textContent)),
    String(rulesEl && rulesEl.textContent));
  check('规则说明写了每小时掉多少',
    /每小时/.test(String(rulesEl && rulesEl.textContent)));

  // ⑤ 饥饿状态在各个地方都能看见
  const R2 = P2.sandbox.window.PetNest.rules;
  const starvingPet = R2.petView(
    { id: 'pet-1', name: '团子', kind: 'egg', stage: 2, satiety: 0, settledAt: Date.now() - 2.5 * 86400000, createdAt: 1 },
    Date.now()
  );
  check('快撑不住的宠物 starving = true', starvingPet.starving === true);
  check('快撑不住的宠物带「已经饿了几天」', starvingPet.hungryDays >= 2, String(starvingPet.hungryDays));
  check('快撑不住的宠物带「还剩几天会离开」（2.5 天饿 → 还剩 0.5 天）',
    starvingPet.starveDaysLeft === 0.5, String(starvingPet.starveDaysLeft));

  const fedPet = R2.petView(
    { id: 'pet-2', name: '花卷', kind: 'cat', stage: 1, satiety: 90, settledAt: Date.now(), createdAt: 1 },
    Date.now()
  );
  check('刚喂饱的宠物不算 starving', fedPet.starving === false);
  check('刚喂饱的宠物没有「还剩几天」（null = 没在饿）', fedPet.starveDaysLeft === null, String(fedPet.starveDaysLeft));

  // ⑥ 提示条：饥饿优先级最高（比「该画一张」「能孵了」都高）
  const H = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  H.rows.pets['pet-1'].satiety = 0;
  H.rows.pets['pet-1'].settledAt = Date.now() - 2.5 * 86400000;
  await H.sandbox.window.PetNest.refresh();
  const bar = H.domEls['pn-hint-bar'];
  const barText = H.domEls['pn-hint-text'];
  check('饿到要没了的时候，提示条会弹出来', bar && bar.hidden === false);
  check('提示条写的是「撑不住了」而不是别的',
    /撑不住/.test(String(barText && barText.textContent)),
    String(barText && barText.textContent));

  // ⑦ 桌宠也要看得出在饿
  const Dp = loadDesktopPetSandbox();
  Dp.rules.renderDesktopPetContent({ id: 'p1', name: '小花', kind: 'cat', stage: 0, sprite: 'cat-sprites-light.webp', satiety: 0, starving: true });
  check('桌宠名字写着「快撑不住了」',
    /快撑不住了/.test(String(Dp.getEl('pn-desktop-pet-name').textContent)),
    String(Dp.getEl('pn-desktop-pet-name').textContent));
  check('桌宠气泡弹出来催你喂',
    Dp.getEl('pn-desktop-pet-bubble').hidden === false
    && /喂/.test(String(Dp.getEl('pn-desktop-pet-bubble').textContent)),
    String(Dp.getEl('pn-desktop-pet-bubble').textContent));

  // ⑧ 打开小窝时会自动扫饿死（忘了喂 → 回来它真没了，不是还杵在那儿）
  const S1 = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  S1.rows.pets['pet-1'].satiety = 0;
  S1.rows.pets['pet-1'].settledAt = Date.now() - 4 * 86400000;
  await S1.sandbox.window.PetNest.refresh();
  check('打开小窝时会自动扫掉饿死的（不用手动去点齿轮）',
    !S1.rows.pets['pet-1'], '还在就说明没扫');
  check('扫掉时会告诉用户它走了',
    S1.toasts.some(t => /离开/.test(t.text || '')),
    JSON.stringify(S1.toasts.map(t => t.text)));

  // ⑨ 放弃之后界面要跟着刷新（列表里不该还显示着已删掉的宠物）
  const S2 = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  await S2.sandbox.window.PetNest.refresh();
  S2.sandbox.window.PetNest.rules.renderManageList();
  const listS2 = S2.domEls['pn-manage-list'];
  // 只数「宠物行」，别把空态提示段算进去（那是 .pn-quiet，不是 .pn-manage-row）
  const rowsBefore = listS2.children.filter(c => c.className === 'pn-manage-row');
  check('放弃前：面板里有一只宠物的行', rowsBefore.length === 1,
    '宠物行 ' + rowsBefore.length + ' / 子节点 ' + listS2.children.length);
  await S2.sandbox.window.PetNest.rules.doRemovePet({ id: 'pet-1', name: '团子' });
  const rowsLeft = listS2.children.filter(c => c.className === 'pn-manage-row');
  check('放弃后面板里不再有它的行（界面跟着刷新了）', rowsLeft.length === 0,
    '还剩 ' + rowsLeft.length + ' 行');
}

// ============================================================
// 桌宠菜单的快捷照顾（2026-10-26）
//   用户提「喂食、摸摸、陪玩还得点进宠物屋才做得到，太麻烦」
//   → 点桌宠弹出的菜单里直接加三个按钮。
// 【这组为什么必须测】
//   ① 三个按钮的 id 要跟 JS 里的 closest() 对得上（对不上 = 点了没反应）
//   ② 快捷照顾的判断必须在「菜单整体早退」之前 —— 放后面会被早退吃掉
//   ③ 行为：quickCare 走的是同一份 care()，喂食照样扣粮食、没粮照样会报错
// ============================================================
section('桌宠菜单快捷照顾（喂食 / 摸摸 / 陪玩）');
{
  const html2 = read('index.html');
  const src2 = read('modules/pet-nest.js');
  const css2 = read('css/pet-nest.css');
  const sw2 = read('sw.js');

  // ① 三个按钮在菜单里
  const menuBlock = (html2.match(/<div id="pn-desktop-pet-menu"[\s\S]*?隐藏桌宠[\s\S]*?<\/div>/) || [''])[0];
  check('桌宠菜单里有「喂食」按钮', /id="pn-desktop-pet-feed"/.test(menuBlock));
  check('桌宠菜单里有「摸摸」按钮', /id="pn-desktop-pet-comfort"/.test(menuBlock));
  check('桌宠菜单里有「陪玩」按钮', /id="pn-desktop-pet-play"/.test(menuBlock));

  // ② JS 接上了这三个按钮
  check('JS 用 closest 一次命中这三个按钮',
    /closest\('#pn-desktop-pet-feed, #pn-desktop-pet-comfort, #pn-desktop-pet-play'\)/.test(src2));
  check('点击处理走的是 careActionForButton（不是散在三元表达式里）',
    /quickCare\(careActionForButton\(quickBtn\.id\)\)/.test(src2));

  // ②b 按钮 → 动作的对应关系（行为级：调纯函数，不查源码）
  const CB = makeSandbox({ lastLookDay: '', used: 0 });
  const CBR = CB.sandbox.window.PetNest.rules;
  check('桌宠菜单「喂食」按钮 → feed 动作',
    CBR.careActionForButton('pn-desktop-pet-feed') === 'feed',
    String(CBR.careActionForButton('pn-desktop-pet-feed')));
  check('桌宠菜单「摸摸」按钮 → comfort 动作',
    CBR.careActionForButton('pn-desktop-pet-comfort') === 'comfort',
    String(CBR.careActionForButton('pn-desktop-pet-comfort')));
  check('桌宠菜单「陪玩」按钮 → play 动作',
    CBR.careActionForButton('pn-desktop-pet-play') === 'play',
    String(CBR.careActionForButton('pn-desktop-pet-play')));
  check('不是照顾按钮就不给动作（「进入小屋」不能被当成喂食）',
    CBR.careActionForButton('pn-desktop-pet-enter') === '',
    '"' + CBR.careActionForButton('pn-desktop-pet-enter') + '"');

  // ③ 顺序：快捷照顾必须在「菜单整体早退」之前
  //   ⚠️ 这两个位置都要限定在【click 处理函数】里 —— pointerdown 里也有一句一模一样的早退，
  //     全局 indexOf 会先搜到 pointerdown 那句，顺序判断就反了
  const clickIdx = src2.indexOf("wrap.addEventListener('click'");
  const quickIdx = src2.indexOf("closest('#pn-desktop-pet-feed", clickIdx);
  const guardIdx = src2.indexOf("if (e.target.closest('#pn-desktop-pet-menu')) return;", clickIdx);
  check('快捷照顾的判断排在「菜单整体早退」之前（放后面点了就没反应）',
    clickIdx > -1 && quickIdx > -1 && guardIdx > -1 && quickIdx < guardIdx,
    'click=' + clickIdx + ' quick=' + quickIdx + ' guard=' + guardIdx);

  // ④ 样式
  check('快捷照顾按钮有专门的样式', /\.pn-menu-act\s*\{/.test(css2));
  check('照顾项跟功能项之间有分隔线', /\.pn-menu-sep\s*\{/.test(css2));

  // ⑤ 版本号（SW 对 index.html 是 cache-first，不 bump 等于没改）
  check('index.html 的 pet-nest.js ?v= 已 bump', /pet-nest\.js\?v=0\.0\.2[2-9]/.test(html2),
    (html2.match(/pet-nest\.js\?v=([0-9.]+)/) || [])[1]);
  check('index.html 的 pet-nest.css ?v= 已 bump', /pet-nest\.css\?v=0\.0\.1[3-9]/.test(html2),
    (html2.match(/pet-nest\.css\?v=([0-9.]+)/) || [])[1]);
  check('sw.js 的 CACHE_VERSION 已 bump', /const CACHE_VERSION = 'v0\.2\.8[2-9]\.\d+'/.test(sw2),
    (sw2.match(/const CACHE_VERSION = '([^']+)'/) || [])[1]);

  // ⑥ 行为：喂食走同一份 care()（扣粮食 + 涨饱腹 + 涨成长）
  const F = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  F.rows.pets['pet-1'].status = 'ready';
  F.rows.pets['pet-1'].satiety = 40;
  F.rows.pets['pet-1'].settledAt = Date.now();
  F.meta.grains = 5;
  await F.sandbox.window.PetNest.rules.quickCare('feed');
  check('喂食：提示「吃饱啦」',
    F.toasts.some(t => /吃饱啦/.test(t.text || '')),
    JSON.stringify(F.toasts.map(t => t.text)));
  check('喂食：粮食扣掉了（第 2 阶段一顿吃 3 颗）',
    Number(F.meta.grains) === 2, 'grains=' + F.meta.grains);
  check('喂食：饱腹涨上去了',
    Number(F.rows.pets['pet-1'].satiety) > 40, 'satiety=' + F.rows.pets['pet-1'].satiety);
  check('喂食：成长值也涨了',
    Number(F.rows.pets['pet-1'].growth) > 0, 'growth=' + F.rows.pets['pet-1'].growth);

  // ⑦ 没粮食：不能让用户以为喂上了
  const G = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  G.rows.pets['pet-1'].status = 'ready';
  G.rows.pets['pet-1'].satiety = 40;
  G.rows.pets['pet-1'].settledAt = Date.now();
  G.meta.grains = 0;
  await G.sandbox.window.PetNest.rules.quickCare('feed');
  check('没粮食时喂食会告诉用户「粮食不够喂这一顿」',
    G.toasts.some(t => /粮食不够/.test(t.text || '')),
    JSON.stringify(G.toasts.map(t => t.text)));

  // ⑧ 摸摸 / 陪玩
  const CM = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  CM.rows.pets['pet-1'].status = 'ready';
  CM.rows.pets['pet-1'].satiety = 40;
  CM.rows.pets['pet-1'].settledAt = Date.now();
  await CM.sandbox.window.PetNest.rules.quickCare('comfort');
  check('摸摸：提示「收到了摸摸」',
    CM.toasts.some(t => /收到了摸摸/.test(t.text || '')),
    JSON.stringify(CM.toasts.map(t => t.text)));

  const PL = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  PL.rows.pets['pet-1'].status = 'ready';
  PL.rows.pets['pet-1'].satiety = 40;
  PL.rows.pets['pet-1'].settledAt = Date.now();
  await PL.sandbox.window.PetNest.rules.quickCare('play');
  check('陪玩：提示「一起玩了一会儿」',
    PL.toasts.some(t => /一起玩了一会儿/.test(t.text || '')),
    JSON.stringify(PL.toasts.map(t => t.text)));

  // ⑨ 小窝里一只都没有：要说清楚，别静默失败
  const NB = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  NB.rows.pets = {};
  await NB.sandbox.window.PetNest.rules.quickCare('feed');
  check('小窝里没有宝宝时提示「小窝里还没有宝宝」',
    NB.toasts.some(t => /还没有宝宝/.test(t.text || '')),
    JSON.stringify(NB.toasts.map(t => t.text)));

  // ⑩ 照顾完把菜单收起来（不然菜单一直挂着挡住桌宠的反应）
  const DM = makeSandbox({ lastLookDay: '', used: 0, dom: true, domIds: ['pn-desktop-pet-menu'] });
  DM.rows.pets['pet-1'].status = 'ready';
  DM.rows.pets['pet-1'].satiety = 40;
  DM.rows.pets['pet-1'].settledAt = Date.now();
  const menuEl = DM.sandbox.document.getElementById('pn-desktop-pet-menu');
  menuEl.hidden = false;
  await DM.sandbox.window.PetNest.rules.quickCare('comfort');
  check('照顾完菜单自动收起',
    DM.domEls['pn-desktop-pet-menu'] && DM.domEls['pn-desktop-pet-menu'].hidden === true);

  // ⑪ 照顾要记成【用户】做的（不然事件流里会写成 AI 照顾的）
  const EV = makeSandbox({ lastLookDay: '', used: 0, dom: true });
  EV.rows.pets['pet-1'].status = 'ready';
  EV.rows.pets['pet-1'].satiety = 40;
  EV.rows.pets['pet-1'].settledAt = Date.now();
  await EV.sandbox.window.PetNest.rules.quickCare('comfort');
  const ev = Object.values(EV.rows.events)[0];
  check('照顾记录里 actor 是 user（是用户照顾的，不是 AI 替它做的）',
    !!ev && ev.actor === 'user', ev ? 'actor=' + ev.actor : '没写事件');
  check('照顾记录里 action 是这次点的那个',
    !!ev && ev.action === 'comfort', ev ? 'action=' + ev.action : '没写事件');
}

  printSummary();
})().catch(e => { console.error(e); process.exit(1); });

function printSummary() {
  console.log('\n================================');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  console.log('================================');
  if (failed > 0) process.exit(1);
}

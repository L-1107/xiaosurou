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
  const pet = { satiety: 60, settledAt: now - 5 * 3600 * 1000 };
  const s = R.currentSatiety(pet, now);
  check('60 饱腹过 5 小时 → 50', Math.abs(s - 50) < 0.01, 'got ' + s);
  const pet2 = { satiety: 60, settledAt: now - 100 * 3600 * 1000 };
  check('衰减到 0 不会变负', R.currentSatiety(pet2, now) === 0, 'got ' + R.currentSatiety(pet2, now));
  const pet3 = { satiety: 60, settledAt: now };
  check('刚喂完不衰减', R.currentSatiety(pet3, now) === 60, 'got ' + R.currentSatiety(pet3, now));
}

section('规则: 成长阶段门槛（上游 growth.py）');
{
  const R = loadRules();
  const day = 86400000;
  const created = Date.UTC(2026, 0, 1);
  const now = created + 10 * day;

  // 普通宠物: 第 1 阶段要成长 40 + 相处 7 天
  const cat = { kind: 'cat', stage: 0, growth: 45, createdAt: created };
  const t1 = R.growthTarget(cat, null, now);
  check('猫: 阶段1 门槛 = 成长40 / 7天', t1.requiredGrowth === 40 && t1.requiredDays === 7,
    'got ' + t1.requiredGrowth + '/' + t1.requiredDays);
  check('猫: 成长45 + 10天 → 第1阶段就绪', t1.ready === true);
  check('猫: 成长值不够就不就绪',
    R.growthTarget({ kind: 'cat', stage: 0, growth: 10, createdAt: created }, null, now).ready === false);
  check('猫: 天数不够就不就绪',
    R.growthTarget({ kind: 'cat', stage: 0, growth: 45, createdAt: now - 2 * day }, null, now).ready === false);

  // 第 2 阶段: 成长 100 + 14 天, 从上一阶段激活时间算
  const cat2 = { kind: 'cat', stage: 1, growth: 120, createdAt: created };
  const t2 = R.growthTarget(cat2, { stage: 1, activatedAt: now - 3 * day, growthAtActivation: 45 }, now);
  check('猫: 阶段2 门槛 = 成长100 / 14天', t2.requiredGrowth === 100 && t2.requiredDays === 14,
    'got ' + t2.requiredGrowth + '/' + t2.requiredDays);
  check('猫: 天数从【上一阶段激活】起算, 不是从领养起算', t2.elapsedDays === 3, 'got ' + t2.elapsedDays);

  // 蛋: 第 1 阶段只要成长 12 + 2 天
  const egg = { kind: 'egg', stage: 0, growth: 12, createdAt: created };
  const te = R.growthTarget(egg, null, now);
  check('蛋: 阶段1 门槛 = 成长12 / 2天', te.requiredGrowth === 12 && te.requiredDays === 2,
    'got ' + te.requiredGrowth + '/' + te.requiredDays);
  check('蛋: 成长12 + 满2天 → 可孵化',
    R.canHatch({ kind: 'egg', growth: 12, createdAt: now - 2 * day }, now) === true);
  check('蛋: 差一天不能孵化',
    R.canHatch({ kind: 'egg', growth: 12, createdAt: now - 1 * day }, now) === false);
  check('蛋: 成长不够不能孵化',
    R.canHatch({ kind: 'egg', growth: 11, createdAt: now - 5 * day }, now) === false);
  check('已经孵出来的（stage>0）→ 不再算「蛋可以孵化」',
    R.canHatch({ kind: 'egg', stage: 3, growth: 999, createdAt: now - 40 * day }, now) === false);
  check('鹦鹉羽化成神兽后 → 也不再算「蛋可以孵化」',
    R.canHatch({ kind: 'parrot', stage: 4, growth: 999, createdAt: now - 40 * day }, now) === false);
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

  // ② 蛋期规则跟灵宠蛋一样：成长 12 + 相处 2 天
  const tp = R.growthTarget({ kind: 'parrot', stage: 0, growth: 12, createdAt: created }, null, now);
  check('鹦鹉: 阶段1 门槛 = 成长12 / 2天', tp.requiredGrowth === 12 && tp.requiredDays === 2,
    'got ' + tp.requiredGrowth + '/' + tp.requiredDays);
  check('鹦鹉: 成长12 + 满2天 → 可孵化',
    R.canHatch({ kind: 'parrot', growth: 12, createdAt: now - 2 * day }, now) === true);
  check('鹦鹉: 差一天不能孵化',
    R.canHatch({ kind: 'parrot', growth: 12, createdAt: now - 1 * day }, now) === false);

  // ③ 能走到第 4 阶段（羽化神兽）
  const t4 = R.growthTarget({ kind: 'parrot', stage: 3, growth: 999, createdAt: created },
    { stage: 3, activatedAt: now - 30 * day, growthAtActivation: 200 }, now);
  check('鹦鹉: 有第 4 阶段（羽化神兽）', t4.stage === 4, 'got ' + t4.stage);
  check('鹦鹉: 第4阶段门槛 = 成长220 / 21天', t4.requiredGrowth === 220 && t4.requiredDays === 21,
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
    R.stageBriefKind({ kind: 'cat', stage: 3 }, { stage: 4 }) === 'normal');
  check('灵宠蛋不会羽化成神兽',
    R.stageBriefKind({ kind: 'egg', stage: 3 }, { stage: 4 }) === 'normal');

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

  // 猫狗的老样子别动
  check('猫的提示词还是 fluffy cat',
    R.subjectForPet({ kind: 'cat', stage: 0, appearance: null }).indexOf('fluffy cat') === 0);
  check('狗的提示词还是 fluffy puppy',
    R.subjectForPet({ kind: 'dog', stage: 0, appearance: null }).indexOf('fluffy puppy') === 0);
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
    /羽化成神兽了[\s\S]{0,80}画一张新样子/.test(src));
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
  const MIN = [0, 2, 69, 0];
  function verGte(a, b) {
    if (!a || a.length !== 4 || a.some((n) => !Number.isFinite(n))) return false;
    for (let i = 0; i < 4; i++) {
      if (a[i] > b[i]) return true;
      if (a[i] < b[i]) return false;
    }
    return true;
  }
  check('CACHE_VERSION >= v0.2.69.0（改过 index.html 就必须 bump，只 bump 模块 ?v= 没用）',
    verGte(ver, MIN), m ? m[1] : 'not found');
  check('index.html 在预缓存清单里（它走 cache-first，漏了会一直吐旧页面）',
    sw.includes("'./index.html'"));
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
    css.includes('pn-frame-x 1.8s step-end') && css.includes('pn-frame-y 3.6s step-end'));
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

console.log('\n================================');
console.log('通过 ' + passed + ' / 失败 ' + failed);
console.log('================================');
if (failed > 0) process.exit(1);

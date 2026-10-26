// ============================================================
// tests/pet-speech.test.cjs
// 宠物说话系统（modules/pet-speech.js）的规则与接线回归测试
//
// 跑法: node tests/pet-speech.test.cjs
//
// 【本测试守什么 —— 全是用户 2026-10-25/26 亲口拍板的硬规矩】
//   ① 提示词里绝对不能出现任何【说话示例】
//      （用户原话「不然有的蠢模型会原味儿句句说出来」）
//   ② 身份只给名字，【不给物种特征】
//      （用户原话「囚牛…喜欢抱着琴听人唱歌，这都不要给」）
//   ③ 话题方向是【候选菜单】，明写「挑一个，或者都不选」
//   ④ 智力随成长阶段涨，但【上限 10 岁人类儿童】
//   ⑤ API 走【后台活动槽位】（background），没配才回落主 API
//   ⑥ 巡视到点就说，不让模型自己决定说不说
//   ⑦ 每只宠物独立开关：允许说话 / 允许插话到聊天框
//   ⑧ 提示词里【不判谁是妈妈谁是爸爸】
//
// 【为什么用 vm 而不是 jsdom】
//   项目里没有 jsdom 依赖。pet-speech.js 的规则部分全是纯函数，
//   把模块塞进一个假 window/document 的 vm 沙箱里直接验算。
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
// 沙箱
// ============================================================

/**
 * 造一个能跑 pet-speech.js 的沙箱。
 * cfg:
 *   pets      —— PetNest.listPets() 返回的宠物行
 *   chat      —— 当前聊天
 *   api       —— fetch 要返回的内容（默认一句话）
 *   fetchLog  —— 记录每次请求
 *   bubble    —— 是否提供桌宠气泡 DOM
 */
function makeSandbox(cfg) {
  cfg = cfg || {};
  const store = {};
  const fetchLog = cfg.fetchLog || [];
  const bubbles = [];
  const added = [];

  const bubbleEl = {
    id: 'pn-desktop-pet-bubble',
    hidden: true,
    textContent: '',
    className: '',
    classList: {
      _s: [],
      add(c) { this._s.push(c); },
      remove(c) { this._s = this._s.filter(x => x !== c); },
      contains(c) { return this._s.indexOf(c) >= 0; }
    }
  };

  // 桌宠容器（它藏起来时里面的气泡用户看不见）
  const petWrap = {
    id: 'pn-desktop-pet',
    hidden: cfg.petHidden === true
  };

  const toasts = [];

  const chat = cfg.chat === undefined ? {
    id: 'c1',
    name: '小雅',
    settings: { myNickname: '阿乐' },
    history: []
  } : cfg.chat;

  // 假时钟：只接管 getHours()，别的照旧（Date.now() 还是真实时间）
  // 用它把「晚上 2 点」这种时间相关的场景测成【确定的】，不靠现在几点
  const RealDate = Date;
  class FakeDate extends RealDate {
    getHours() {
      return (cfg.nowHour !== undefined) ? cfg.nowHour : super.getHours();
    }
  }

  const pets = cfg.pets || [{
    id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, satiety: 70,
    traits: { attachment: 80, energy: 40, curiosity: 60, sociability: 70, calm: 50, sensitivity: 55 },
    appearance: {
      beastSpecies: '囚牛',
      beastSpeciesEn: 'a chubby round baby dragon hugging a tiny golden harp',
      identity: '囚牛'
    },
    createdAt: 1
  }];

  const sandbox = {
    console,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: (id) => {
        if (id === 'pn-desktop-pet-bubble' && cfg.bubble !== false) return bubbleEl;
        if (id === 'pn-desktop-pet') return petWrap;
        return null;
      },
      querySelectorAll: () => []
    },
    showToast: (text) => { toasts.push(String(text)); },
    state: {
      activeChatId: chat ? chat.id : null,
      chats: chat ? { [chat.id]: chat } : {},
      qzoneSettings: { nickname: '阿乐' },
      globalSettings: {},
      apiConfig: { proxyUrl: 'https://main.example.com/v1', apiKey: 'main-key', model: 'main-model' }
    },
    PetNest: {
      listPets: async () => pets,
      rules: {
        petView: (row, now) => Object.assign({}, row, { satiety: row.satiety }),
        dimensionScores: async () => ({ affection: 30, reading: 20, watching: 10, listening: 40, exploration: 5 })
      }
    },
    resolveApiSlotConfig: async (slot) => {
      if (cfg.slotThrows) throw new Error('槽位炸了');
      if (cfg.slotMissing) return null;
      if (cfg.slot) return cfg.slot;
      return { proxyUrl: 'https://bg.example.com/v1', apiKey: 'bg-key', model: 'bg-model' };
    },
    messageStore: {
      addMessageToChat: async (c, msg) => { added.push(msg); if (c) c.history.push(msg); },
      getRecentMessages: async () => (cfg.messages || [])
    },
    renderChatMessages: () => { sandbox.renderCalls = (sandbox.renderCalls || 0) + 1; },
    fetch: async (url, init) => {
      fetchLog.push({ url: url, init: init });
      const body = cfg.api === undefined ? '我想睡觉了' : cfg.api;
      return {
        ok: cfg.httpOk !== false,
        status: cfg.httpStatus || 200,
        async json() { return cfg.rawResponse || { choices: [{ message: { content: body } }] }; },
        async text() { return String(body); }
      };
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('modules/pet-speech.js'), sandbox, { filename: 'pet-speech.js' });
  if (!sandbox.window.PetSpeech) throw new Error('pet-speech.js 没暴露 window.PetSpeech');

  return {
    sandbox,
    fetchLog,
    added,
    bubbleEl,
    petWrap,
    toasts,
    bubbles,
    getBubbleText: () => bubbleEl.textContent,
    getBubbleHidden: () => bubbleEl.hidden,
    store
  };
}

// ============================================================
// ① 硬规矩：提示词里不能有说话示例
// ============================================================
(async function () {

/**
 * 调一次 petSpeak，但不让异常把整个测试脚本打断。
 * 【为什么要有这个】宠物说话失败时【应该】静默吞掉异常；
 *   万一实现把它抛出来了，测试要能报红，而不是「脚本崩了什么都看不到」。
 */
async function safeSpeak(ps, petRow, event) {
  try {
    return { value: await ps.petSpeak(petRow, event), threw: null };
  } catch (e) {
    return { value: null, threw: e };
  }
}

section('硬规矩①：提示词里绝对不能出现说话示例');
{
  const S = makeSandbox();
  const R = S.sandbox.window.PetSpeech.rules;
  const pet = {
    name: '啾啾', stage: 3, satiety: 70,
    traits: { attachment: 80, energy: 40, curiosity: 60, sociability: 70, calm: 50, sensitivity: 55 },
    appearance: { beastSpecies: '囚牛' }
  };
  const prompt = R.buildSpeechPrompt(pet, {
    event: 'feed',
    relationScores: { affection: 30, listening: 40 },
    parents: { user: '阿乐', ai: '小雅' },
    chatLines: ['阿乐：今天吃什么', '小雅：随便']
  });

  // ①a 提示词里不能出现「举例 / 例如 / 比如」这类引导词
  const GUIDE_WORDS = ['例如', '比如', '举例', '示例', '例句', '示范', '像这样', '这样写', '参考话', '话术'];
  const hitGuide = GUIDE_WORDS.filter(w => prompt.includes(w));
  check('提示词里没有「例如/比如/示范」这类引导词', hitGuide.length === 0, hitGuide.join(','));

  // ①b 不能出现「冒号 + 引号」这种最容易被模型原样照抄的台词句式
  check('提示词里没有「冒号 + 引号」的示范台词',
    !/[:：]\s*["'“”「『]/.test(prompt),
    (prompt.match(/[:：]\s*["'“”「『][^\n]{0,30}/) || [''])[0]);

  // ①c 不能出现英文引号包住的一整句
  check('提示词里没有用引号包起来的英文整句',
    !/"[A-Za-z][^"]{6,}"/.test(prompt) && !/'[A-Za-z][^']{6,}'/.test(prompt),
    (prompt.match(/"[A-Za-z][^"]{6,}"/) || [''])[0]);

  // ①d 话题菜单是【方向】，不是台词 —— 每一条都不能带引号
  const quoteInMenu = R.TOPIC_MENU.filter(t => /["'“”「『]/.test(t));
  check('话题菜单里没有引号（是方向不是台词）', quoteInMenu.length === 0, quoteInMenu.join(' | '));

  // ①e 话题菜单要够长，且每条都要短
  check('话题菜单至少有 3 个方向', R.TOPIC_MENU.length >= 3, '共 ' + R.TOPIC_MENU.length + ' 个');
  check('话题菜单每条都短（不是长句示范）',
    R.TOPIC_MENU.every(t => t.length <= 30),
    JSON.stringify(R.TOPIC_MENU.map(t => t.length)));

  // ①f 明写「可以都不选」
  check('提示词明写「挑一个，或者都不选」', /都不选/.test(prompt));
}

// ============================================================
// ② 硬规矩：身份只给名字，不给物种特征
// ============================================================
section('硬规矩②：身份只给名字，不给物种特征');
{
  const S = makeSandbox();
  const R = S.sandbox.window.PetSpeech.rules;
  const pet = {
    name: '啾啾', stage: 3, satiety: 70,
    traits: { attachment: 80 },
    appearance: {
      beastSpecies: '囚牛',
      beastSpeciesEn: 'a chubby round baby dragon hugging a tiny golden harp'
    }
  };
  const prompt = R.buildSpeechPrompt(pet, { event: 'idle', parents: { user: '阿乐', ai: '小雅' } });

  check('提示词里给了名字', /啾啾/.test(prompt));
  check('提示词里给了物种名（只是名字，不展开）', /囚牛/.test(prompt));

  // 最强的一条：pet-nest.js 里每个物种的英文特征描述，
  // 一个都不许出现在提示词里（那才是「物种特征」的载体）
  const NestS = makeSandbox();
  const nestRules = (function () {
    const sb = {
      console, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
      Dexie: function () { throw new Error('规则测试不该碰 Dexie'); }
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(read('modules/pet-nest.js'), sb, { filename: 'pet-nest.js' });
    return sb.window.PetNest.rules;
  })();
  const species = nestRules.BEAST_SPECIES || [];
  const enDescs = species
    .map(s => s.en || s.enDesc || s.description || '')
    .filter(Boolean);
  const leaked = enDescs.filter(d => prompt.includes(d));
  check('提示词里没有泄露任何物种的英文特征描述',
    leaked.length === 0,
    leaked.length ? leaked[0].substring(0, 60) : ('共检查 ' + enDescs.length + ' 条描述'));

  // 中文物种特征也不能给：囚牛是「龙之九子里的老大，喜欢抱着琴听人唱歌」
  const FORBIDDEN = ['抱着琴', '弹琴', '听人唱歌', '龙之九子', '九子'];
  const hitForbidden = FORBIDDEN.filter(w => prompt.includes(w));
  check('提示词里没有「抱着琴/弹琴」这类物种特征', hitForbidden.length === 0, hitForbidden.join(','));
}

// ============================================================
// ③ 硬规矩：话题是候选菜单
// ============================================================
section('硬规矩③：话题方向是候选菜单');
{
  const S = makeSandbox();
  const R = S.sandbox.window.PetSpeech.rules;
  const prompt = R.buildSpeechPrompt(
    { name: '啾啾', stage: 3, satiety: 70, traits: {}, appearance: { beastSpecies: '囚牛' } },
    { event: 'idle', parents: { user: '阿乐', ai: '小雅' } }
  );
  const missing = R.TOPIC_MENU.filter(t => !prompt.includes(t));
  check('候选菜单的每一条都进了提示词', missing.length === 0, missing.join(' | '));
  check('提示词里写了「可以选的方向」这种候选语气', /可以选的方向/.test(prompt));
}

// ============================================================
// ④ 硬规矩：智力随阶段涨，上限 10 岁
// ============================================================
section('硬规矩④：智力随成长阶段增长，上限 10 岁人类儿童');
{
  const S = makeSandbox();
  const R = S.sandbox.window.PetSpeech.rules;

  check('第 0 阶段（蛋）不会说话', R.iqFor(0).canSpeak === false);
  check('第 1 阶段 ≈ 2 岁', R.iqFor(1).age === 2, String(R.iqFor(1).age));
  check('第 2 阶段 ≈ 4 岁', R.iqFor(2).age === 4, String(R.iqFor(2).age));
  check('第 3 阶段 ≈ 7 岁', R.iqFor(3).age === 7, String(R.iqFor(3).age));
  check('第 4 阶段 ≈ 10 岁', R.iqFor(4).age === 10, String(R.iqFor(4).age));
  check('再大的阶段也封顶在 10 岁', R.iqFor(99).age === 10, String(R.iqFor(99).age));
  check('负数阶段兜底到 0', R.iqFor(-5).age === 0, String(R.iqFor(-5).age));

  const ages = [0, 1, 2, 3, 4].map(s => R.iqFor(s).age);
  const growing = ages.every((a, i) => i === 0 || a > ages[i - 1]);
  check('智力是【递增】的', growing, JSON.stringify(ages));

  const p1 = R.buildSpeechPrompt({ name: '啾啾', stage: 1, traits: {} }, {});
  const p4 = R.buildSpeechPrompt({ name: '啾啾', stage: 4, traits: {} }, {});
  check('不同阶段的智力描述不一样', p1 !== p4);
  check('第 0 阶段的提示词明说「说不出话」', /说不出话/.test(p1) || /说不/.test(p1));
  check('第 4 阶段的提示词提到 10 岁', /10 岁/.test(p4));
}

// ============================================================
// ⑤ 硬规矩：不判谁是妈妈谁是爸爸
// ============================================================
section('硬规矩⑤：不判谁是谁妈谁是谁爸');
{
  const S = makeSandbox();
  const R = S.sandbox.window.PetSpeech.rules;
  const prompt = R.buildSpeechPrompt(
    { name: '啾啾', stage: 3, traits: {} },
    { event: 'idle', parents: { user: '阿乐', ai: '小雅' } }
  );
  check('提示词里写了「爸爸妈妈」', /爸爸妈妈/.test(prompt));
  check('提示词里写了「两个家长」', /两个家长/.test(prompt));
  // 「妈妈」只允许出现在「爸爸妈妈」这个词里；出现「是妈妈」「妈妈是」就是判了性别
  const badAssign = [];
  let idx = -1;
  while ((idx = prompt.indexOf('妈妈', idx + 1)) >= 0) {
    if (prompt[idx - 1] !== '爸') badAssign.push(prompt.substring(Math.max(0, idx - 8), idx + 8));
  }
  idx = -1;
  while ((idx = prompt.indexOf('爸爸', idx + 1)) >= 0) {
    if (prompt[idx + 2] !== '妈') badAssign.push(prompt.substring(Math.max(0, idx - 8), idx + 8));
  }
  check('提示词里没有指定「妈妈是阿乐」这种指派',
    badAssign.length === 0, badAssign.join(' | '));
  check('提示词里没出现「母亲 / 父亲」这种字眼',
    !/母亲|父亲/.test(prompt));
}

// ============================================================
// ⑥ 纯规则：性格 / 关系 / 事件 / 状态 / 取文本
// ============================================================
section('纯规则：性格翻译 / 关系 / 事件 / 状态');
{
  const S = makeSandbox();
  const R = S.sandbox.window.PetSpeech.rules;

  check('性格高 → 高档描述', /黏人|撒娇/.test(R.traitDesc('attachment', 90)));
  check('性格中 → 中档描述', /小脾气|一般|正常/.test(R.traitDesc('attachment', 55)));
  check('性格低 → 低档描述', /独立|慢热|淡定/.test(R.traitDesc('attachment', 10)));
  check('性格中位不落到高档', !/黏人|撒娇/.test(R.traitDesc('attachment', 60)));

  const pl = R.personalityLines({ attachment: 90, energy: 10 });
  check('性格清单有内容（六个维度都翻译了一遍）', pl.length === 6, '条数 ' + pl.length);
  check('性格清单带数值', /\d/.test(pl.join(' ')), pl.join(' | '));

  check('关系取最高的那条', /一起听东西/.test(R.relationLine({ affection: 10, listening: 80 })));
  check('关系全 0 → 返回空', R.relationLine({ affection: 0, listening: 0 }) === '');

  check('事件 feed 有对应描述', /吃了饭/.test(R.eventLine('feed')));
  check('事件 comfort 有对应描述', /摸了摸/.test(R.eventLine('comfort')));
  check('未知事件 → 空', R.eventLine('__nope__') === '');

  check('饱腹低 → 饿了', /饿/.test(R.stateLine({ satiety: 20, stage: 2 })));
  check('饱腹高 → 饱饱的', /饱/.test(R.stateLine({ satiety: 95, stage: 2 })));
  check('快饿死了 → 说撑不住', /撑不住/.test(R.stateLine({ satiety: 0, stage: 2, starving: true })));

  check('取文本: OpenAI 结构', R.extractText({ choices: [{ message: { content: '你好' } }] }) === '你好');
  check('取文本: Gemini 结构', R.extractText({ candidates: [{ content: { parts: [{ text: '你好' }] } }] }) === '你好');
  check('取文本: output_text', R.extractText({ output_text: '你好' }) === '你好');
  check('取文本: 剥掉中文引号', R.extractText({ output_text: '「你好」' }) === '你好');
  check('取文本: 剥掉「宠物：」前缀', R.extractText({ output_text: '啾啾：你好' }) === '你好');
  check('取文本: 空 → 空串', R.extractText(null) === '');
}

// ============================================================
// ⑦ 开关（每只宠物独立）
// ============================================================
section('硬规矩⑦：每只宠物独立开关');
{
  const S = makeSandbox();
  const PS = S.sandbox.window.PetSpeech;
  check('没设过 → 允许说话（默认开）', PS.speechEnabled({ id: 'p1' }) === true);
  check('没设过 → 允许插话（默认开）', PS.chatInsertEnabled({ id: 'p1' }) === true);
  check('canSpeak=false → 不许说话', PS.speechEnabled({ id: 'p1', canSpeak: false }) === false);
  check('canChatInsert=false → 不许插话', PS.chatInsertEnabled({ id: 'p1', canChatInsert: false }) === false);
  check('不许说话时也不许插话（说话是前提）',
    PS.chatInsertEnabled({ id: 'p1', canSpeak: false }) === false
    || PS.speechEnabled({ id: 'p1', canSpeak: false }) === false);
}

// ============================================================
// ⑧ 行为：说话 → 气泡 → 落库
// ============================================================
section('行为：宠物开口（气泡 + 落进聊天框）');
{
  // ① 正常说一句
  const S = makeSandbox({ bubble: true });
  const text = await S.sandbox.window.PetSpeech.petSpeak(
    { id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, satiety: 70, traits: {}, appearance: { beastSpecies: '囚牛' } },
    'feed'
  );
  check('能说出一句话', typeof text === 'string' && text.length > 0, String(text));
  check('气泡里显示了那句话', S.getBubbleText() === text, S.getBubbleText());
  check('气泡是显示出来的', S.getBubbleHidden() === false);
  check('消息落进了聊天记录', S.added.length === 1, '落库 ' + S.added.length + ' 条');
  check('落库的消息 type = pet_say', S.added[0] && S.added[0].type === 'pet_say');
  check('落库的消息 role = system（AI 才知道这不是自己说的）',
    S.added[0] && S.added[0].role === 'system');
  check('落库的消息带宠物名', S.added[0] && S.added[0].petName === '啾啾');
  check('聊天界面重新渲染了', (S.sandbox.renderCalls || 0) >= 1, String(S.sandbox.renderCalls));

  // ② 走的是 background 槽位
  check('API 走的是后台活动槽位的地址',
    S.fetchLog.length === 1 && /bg\.example\.com/.test(S.fetchLog[0].url),
    S.fetchLog[0] && S.fetchLog[0].url);

  // ③ 蛋不会说话
  const Egg = makeSandbox({ bubble: true });
  const eggText = await Egg.sandbox.window.PetSpeech.petSpeak(
    { id: 'pet-1', name: '蛋蛋', kind: 'egg', stage: 0, satiety: 70, traits: {}, appearance: {} }, 'feed'
  );
  check('还是蛋的时候不会说话', eggText === null, String(eggText));
  check('还是蛋的时候不会去调 API', Egg.fetchLog.length === 0, '调了 ' + Egg.fetchLog.length + ' 次');

  // ④ 关掉「允许说话」→ 不说话
  const Off = makeSandbox({ bubble: true });
  const offText = await Off.sandbox.window.PetSpeech.petSpeak(
    { id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, canSpeak: false, traits: {}, appearance: {} }, 'feed'
  );
  check('关掉「允许说话」就不说话', offText === null, String(offText));
  check('关掉「允许说话」就不调 API', Off.fetchLog.length === 0);

  // ⑤ 关掉「允许插话」→ 气泡有话说，但不进聊天框
  const NoIns = makeSandbox({ bubble: true });
  const noInsText = await NoIns.sandbox.window.PetSpeech.petSpeak(
    { id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, canChatInsert: false, traits: {}, appearance: {} }, 'feed'
  );
  check('关掉「允许插话」它还是会说话', typeof noInsText === 'string' && noInsText.length > 0, String(noInsText));
  check('关掉「允许插话」就不进聊天框', NoIns.added.length === 0, '落库 ' + NoIns.added.length + ' 条');

  // ⑥ 模型抽风 → 静默跳过，不崩
  const Bad = makeSandbox({ bubble: true, httpOk: false, httpStatus: 500 });
  const bad = await safeSpeak(Bad.sandbox.window.PetSpeech, {
    id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, traits: {}, appearance: {}
  }, 'feed');
  check('模型失败时静默跳过（返回 null，不抛）', bad.value === null && !bad.threw,
    bad.threw ? ('抛了：' + (bad.threw && bad.threw.message)) : String(bad.value));
  check('模型失败时不落库', Bad.added.length === 0);
  check('模型失败后气泡收起来了', Bad.getBubbleHidden() === true);

  // ⑦ 没配 API → 静默
  const NoApi = makeSandbox({ bubble: true });
  NoApi.sandbox.window.state.apiConfig = {};
  NoApi.sandbox.resolveApiSlotConfig = async () => null;
  const noApi = await safeSpeak(NoApi.sandbox.window.PetSpeech, {
    id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, traits: {}, appearance: {}
  }, 'feed');
  check('没配 API 时静默跳过', noApi.value === null && !noApi.threw,
    noApi.threw ? ('抛了：' + (noApi.threw && noApi.threw.message)) : String(noApi.value));

  // ⑧ 桌宠看不见的时候（不在聊天页）→ 用 toast 兜住，别让这句话白说
  const Hidden = makeSandbox({ bubble: true, petHidden: true });
  await safeSpeak(Hidden.sandbox.window.PetSpeech, {
    id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, traits: {}, appearance: {}
  }, 'feed');
  check('桌宠藏起来时用 toast 兜底（不然「重新打开 App 立刻说一句」白说了）',
    Hidden.toasts.length === 1 && /啾啾/.test(Hidden.toasts[0]),
    JSON.stringify(Hidden.toasts));

  // ⑨ 桌宠在聊天页（看得见）→ 不用 toast 打扰
  const Visible = makeSandbox({ bubble: true, petHidden: false });
  await safeSpeak(Visible.sandbox.window.PetSpeech, {
    id: 'pet-1', name: '啾啾', kind: 'egg', stage: 2, traits: {}, appearance: {}
  }, 'feed');
  check('桌宠看得见时不弹 toast（气泡就够了）',
    Visible.toasts.length === 0, JSON.stringify(Visible.toasts));
}

// ============================================================
// ⑨ API 配置解析：background 槽位优先，没配回落主 API
// ============================================================
section('API 配置：走后台活动槽位，没配才回落主 API');
{
  const S = makeSandbox({ slot: { proxyUrl: 'https://slot.example.com/v1', apiKey: 'k', model: 'm' } });
  const ps = S.sandbox.window.PetSpeech;
  await safeSpeak(ps, { id: 'pet-1', name: '啾啾', stage: 2, traits: {}, appearance: {} }, 'feed');
  check('优先用槽位地址', /slot\.example\.com/.test(S.fetchLog[0].url), S.fetchLog[0].url);

  const Fallback = makeSandbox({ slotMissing: true });
  await safeSpeak(Fallback.sandbox.window.PetSpeech,
    { id: 'pet-1', name: '啾啾', stage: 2, traits: {}, appearance: {} }, 'feed');
  check('槽位没配 → 回落主 API',
    /main\.example\.com/.test(Fallback.fetchLog[0].url), Fallback.fetchLog[0].url);

  const Threw = makeSandbox({ slotThrows: true });
  const threw = await safeSpeak(Threw.sandbox.window.PetSpeech,
    { id: 'pet-1', name: '啾啾', stage: 2, traits: {}, appearance: {} }, 'feed');
  check('槽位解析炸了 → 回落主 API而不是崩',
    threw.value !== null && !threw.threw && /main\.example\.com/.test(Threw.fetchLog[0].url),
    threw.threw ? ('抛了：' + (threw.threw && threw.threw.message)) : (Threw.fetchLog[0] && Threw.fetchLog[0].url));
}

// ============================================================
// ⑩ 巡视：到点就说，各自带表
// ============================================================
section('硬规矩⑥：巡视到点就说，每只各自计时');
{
  // ① 到点 → 说
  const S = makeSandbox({ bubble: true });
  const t = await S.sandbox.window.PetSpeech.patrolTick();
  check('巡视到点会说话', typeof t === 'string' && t.length > 0, String(t));

  // ② 刚说过 → 不到点，不再说
  const t2 = await S.sandbox.window.PetSpeech.patrolTick();
  check('同一只没到点就不再说了（15 分钟一次）', t2 === null, String(t2));
  check('没到点时也没多调 API', S.fetchLog.length === 1, '调了 ' + S.fetchLog.length + ' 次');

  // ③ 强制（唤醒）→ 立刻说
  const t3 = await S.sandbox.window.PetSpeech.patrolTick({ force: true });
  check('强制巡视会立刻说（重新打开 App → 立刻说一句）', typeof t3 === 'string' && t3.length > 0, String(t3));

  // ④ 多只：各自独立计时，同一时刻只让一只说
  const Multi = makeSandbox({
    bubble: true,
    pets: [
      { id: 'pet-1', name: '啾啾', stage: 2, traits: {}, appearance: {} },
      { id: 'pet-2', name: '团团', stage: 2, traits: {}, appearance: {} }
    ]
  });
  const m1 = await Multi.sandbox.window.PetSpeech.patrolTick();
  check('多只时也会说（只让一只）', typeof m1 === 'string' && m1.length > 0, String(m1));
  check('多只时一次只调一次 API（同一时刻只让一只说）',
    Multi.fetchLog.length === 1, '调了 ' + Multi.fetchLog.length + ' 次');
  const spokeIds = Object.keys(Multi.store).filter(k => k.indexOf('petSpeechLastAt') === 0);
  check('每只宠物各自记着自己的时间（键里带自己的 id）',
    spokeIds.length === 1 && /pet-[12]$/.test(spokeIds[0]),
    spokeIds.join(','));

  // 各自独立计时的【行为】验证：第一只刚说完，第二只还能接着说
  //   （如果两只共用一个时间戳，第二只会被 15 分钟门挡掉 → 永远轮不上）
  const Multi2 = makeSandbox({
    bubble: true,
    pets: [
      { id: 'pet-1', name: '啾啾', stage: 2, traits: {}, appearance: {} },
      { id: 'pet-2', name: '团团', stage: 2, traits: {}, appearance: {} }
    ]
  });
  const first = await Multi2.sandbox.window.PetSpeech.patrolTick();
  check('多只时第一只先说', typeof first === 'string' && first.length > 0, String(first));
  const second = await Multi2.sandbox.window.PetSpeech.patrolTick();
  check('第二只紧接着也能说（各自独立计时，不共用一个时间戳）',
    typeof second === 'string' && second.length > 0, String(second));
  const twoKeys = Object.keys(Multi2.store).filter(k => k.indexOf('petSpeechLastAt') === 0);
  check('两只各记各的时间戳', twoKeys.length === 2, twoKeys.join(','));

  // ⑤ 还是颗蛋的不参与巡视（猫狗第 0 阶段是刚领养的幼崽，是能说话的）
  const OnlyEgg = makeSandbox({
    bubble: true,
    pets: [{ id: 'pet-1', name: '蛋蛋', kind: 'egg', stage: 0, traits: {}, appearance: {} }]
  });
  const eggT = await OnlyEgg.sandbox.window.PetSpeech.patrolTick();
  check('还是颗蛋的时候巡视不说话', eggT === null, String(eggT));

  const NewCat = makeSandbox({
    bubble: true,
    pets: [{ id: 'pet-1', name: '新猫', kind: 'cat', stage: 0, traits: {}, appearance: {} }]
  });
  const catT = await NewCat.sandbox.window.PetSpeech.patrolTick();
  check('刚领养的猫（第 0 阶段）照说 —— 它不是蛋',
    typeof catT === 'string' && catT.length > 0, String(catT));

  // ⑥ 关掉「允许说话」的宠物不参与巡视
  const Muted = makeSandbox({
    bubble: true,
    pets: [{ id: 'pet-1', name: '啾啾', stage: 2, canSpeak: false, traits: {}, appearance: {} }]
  });
  const mutedT = await Muted.sandbox.window.PetSpeech.patrolTick();
  check('关掉「允许说话」的宠物不参与巡视', mutedT === null, String(mutedT));

  // ⑦ 没有夜间静默：用户定的「重新打开 App → 立刻说一句」在任何时候都得算数
  //   （假时钟拨到凌晨 2 点，别靠现在几点 —— 否则这条测试是「看天吃饭」的）
  const Night = makeSandbox({ bubble: true, nowHour: 2 });
  Night.sandbox.state.globalSettings = { petSpeechSleepEnabled: true, petSpeechSleepStartHour: 0, petSpeechSleepEndHour: 24 };
  const nightT = await Night.sandbox.window.PetSpeech.patrolTick({ force: true });
  check('没有夜间静默（凌晨两点也照说，不然「立刻说一句」会失效）',
    typeof nightT === 'string' && nightT.length > 0, String(nightT));
  const speechSrc = read('modules/pet-speech.js');
  check('代码里没有夜间静默那套判断', !/isSleepTime/.test(speechSrc));
  check('巡视时也过滤掉「不许说话」的宠物',
    /filter\(r => speechEnabled\(r\)/.test(speechSrc));
}

// ============================================================
// ⑪ 气泡：说话的时候归说话管
// ============================================================
section('气泡：说话时占住气泡，不跟饥饿提示打架');
{
  const S = makeSandbox({ bubble: true });
  S.sandbox.window.PetSpeech.showBubble('我想睡觉了');
  check('气泡显示出来了', S.getBubbleHidden() === false);
  check('气泡内容是对的', S.getBubbleText() === '我想睡觉了');
  check('气泡被标记为「正在说话」', S.sandbox.window.PetSpeech.isBubbleActive() === true);
  S.sandbox.window.PetSpeech.hideBubble();
  check('收起来之后不再是「正在说话」', S.sandbox.window.PetSpeech.isBubbleActive() === false);
  check('收起来之后气泡隐藏', S.getBubbleHidden() === true);
}

// ============================================================
// ⑫ 接线：index.html / sw.js / chat-interface.js / ai-response.js
// ============================================================
section('接线：index.html / sw.js / 聊天渲染 / AI 上下文');
{
  const html = read('index.html');
  const sw = read('sw.js');
  const chatSrc = read('modules/chat-interface.js');
  const aiSrc = read('modules/ai-response.js');
  const nestSrc = read('modules/pet-nest.js');
  const css = read('css/pet-nest.css');

  // ① index.html
  check('index.html 挂了 pet-speech.js', /modules\/pet-speech\.js\?v=/.test(html));
  check('index.html 有「允许说话」开关', /id="pn-switch-speak"/.test(html));
  check('index.html 有「允许插话到聊天框」开关', /id="pn-switch-insert"/.test(html));
  check('两个开关在照顾弹窗里', /<dialog id="pn-care-dialog">[\s\S]*pn-switch-speak[\s\S]*<\/dialog>/.test(html));

  // ② sw.js
  check('sw.js 预缓存里有 pet-speech.js', sw.includes("'./modules/pet-speech.js'"));
  check('sw.js 的 fetch 拦截里有 pet-speech.js', sw.includes("url.includes('/modules/pet-speech.js')"));
  const cv = (sw.match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
  check('sw.js 的 CACHE_VERSION 已经 bump 到 v0.2.80.0', cv === 'v0.2.80.0', String(cv));

  // ③ 聊天框渲染
  check('chat-interface.js 认得 pet_say', /msg\.type === 'pet_say'/.test(chatSrc));
  check('聊天气泡带宠物名', /pet-say-name/.test(chatSrc));

  // ④ AI 上下文：三处都认得 pet_say
  const petSayInAi = (aiSrc.match(/msg\.type === 'pet_say'/g) || []).length;
  check('ai-response.js 三处都认得 pet_say（群聊/单聊/线下）',
    petSayInAi >= 3, '认了 ' + petSayInAi + ' 处');
  check('AI 上下文里标出「宠物 + 名字」',
    /\[宠物\s*\$\{/.test(aiSrc) || /\[宠物/.test(aiSrc));

  // ⑤ pet-nest.js 顶层导出 listPets（pet-speech.js 调的是顶层的，不是 rules 里的）
  const pnStart = nestSrc.indexOf('window.PetNest = {');
  const rulesStart = nestSrc.indexOf('rules: {', pnStart);
  const topBlock = nestSrc.slice(pnStart, rulesStart > 0 ? rulesStart : pnStart + 3000);
  check('PetNest 顶层导出 listPets（不是只在 rules 里）',
    /\n\s*listPets,/.test(topBlock),
    '顶层块里没找到 listPets');

  // ⑥ 事件触发点
  const speakCalls = (nestSrc.match(/PetSpeech\.petSpeak\(/g) || []).length;
  check('pet-nest.js 里有三处事件触发说话', speakCalls >= 3, '有 ' + speakCalls + ' 处');

  // ⑦ 巡视 + 唤醒接线
  check('pet-nest.js 启动时开巡视', /PetSpeech\.startPatrol\(\)/.test(nestSrc));
  check('重新打开 App 会立刻说一句', /PetSpeech\.speakOnWake\(\)/.test(nestSrc));

  // ⑧ 样式
  check('有 .pet-say-name 样式', /\.pet-say-name/.test(css));
  check('有开关样式 .pn-switch', /\.pn-switch/.test(css));

  // ⑨ 气泡共享：宠物说话时别被饥饿提示盖掉
  check('桌宠饥饿提示会避让「正在说话」的宠物', /isBubbleActive/.test(nestSrc));
}

// ============================================================
// ⑬ AI 上下文里 pet_say 的实际渲染文本
// ============================================================
section('AI 上下文：宠物的话会被标成「[宠物 名字]」');
{
  const aiSrc = read('modules/ai-response.js');
  // 找出三处 pet_say 分支（按出现位置切窗口，别用正则找分号 —— 会被前面的 const 截断）
  const idxs = [];
  let at = aiSrc.indexOf("msg.type === 'pet_say'");
  while (at >= 0) {
    idxs.push(at);
    at = aiSrc.indexOf("msg.type === 'pet_say'", at + 1);
  }
  check('找到 3 处 pet_say 分支', idxs.length >= 3, '找到 ' + idxs.length + ' 处');
  const blocks = idxs.map(i => aiSrc.slice(i, i + 700));
  const tagged = blocks.filter(b => /\[宠物/.test(b));
  check('每处都带「[宠物 …]」标记（AI 不会误认成自己说的）',
    tagged.length === blocks.length, '带标记 ' + tagged.length + ' / ' + blocks.length + ' 处');
  const withName = blocks.filter(b => /petName|senderName/.test(b));
  check('每处都带上宠物名字', withName.length === blocks.length,
    '带名字 ' + withName.length + ' / ' + blocks.length + ' 处');
  const asUser = blocks.filter(b => /role:\s*'user'/.test(b));
  check('每处都当成「对方说的」喂给模型（而不是当成自己的输出）',
    asUser.length === blocks.length, 'role=user ' + asUser.length + ' / ' + blocks.length + ' 处');
}

// ============================================================
printSummary();
})().catch(e => { console.error(e); process.exit(1); });

function printSummary() {
  console.log('\n================================');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  console.log('================================');
  if (failed > 0) process.exit(1);
}

// ============================================================
// tests/api-slot-config-sync.test.cjs
// 「API 站点预设」快照同步的回归测试
//
// 跑法: node tests/api-slot-config-sync.test.cjs
//
// 【背景】(2026-10-23)
//   站点预设启用后, 数据库里只留"预设引用", 静态的 proxyUrl/apiKey 会被清空
//   (clearReferencedSlotStaticEndpoints)。
//   应用启动时会把解析结果回填进 state.apiConfig, 所以老代码读
//   state.apiConfig.proxyUrl 大多能拿到值 —— 但那是【启动时的一份快照】。
//   用户换一个预设之后, 只有"预设引用"变了, 快照还是旧的 →
//   所有还读 state.apiConfig 的地方(几十处: cphone / werewolf / 通话 / 狼人杀 …)
//   会继续用旧地址, 最坑的是"旧地址 + 新模型"的错配。
//
//   修法: 新增 syncApiSlotConfigIntoState() —— 换预设/改预设之后立刻刷新快照。
//   本测试守着这个行为。
//
// 【沙箱要补什么】modules/api-endpoint-presets.js 是 IIFE, 加载期要 document,
//   运行期要 state / db.apiPresets。
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'modules', 'api-endpoint-presets.js');

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
function makeSandbox(opts) {
  const options = opts || {};
  const presets = new Map(options.presets || []);

  const db = {
    apiPresets: {
      async get(id) { return presets.get(Number(id)); },
      async toArray() { return Array.from(presets.values()); },
    },
    apiEndpointPresets: {
      async get() { return undefined; },
    },
  };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Promise: Promise,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    Set: Set,
    Map: Map,
    RegExp: RegExp,
    Error: Error,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    document: {
      readyState: 'complete',
      addEventListener: () => {},
      getElementById: () => null,
      createElement: () => ({ value: '', textContent: '', appendChild() {}, options: [] }),
    },
    alert: () => {},
    showCustomPrompt: async () => '',
    showCustomConfirm: async () => false,
    state: options.state,
    db: db,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox, { filename: 'api-endpoint-presets.js' });

  return { sandbox, presets };
}

const PRESET_A = { id: 1, name: '站点A', proxyUrl: 'https://a.example/v1', apiKey: 'sk-a', defaultModel: 'model-a' };
const PRESET_B = { id: 2, name: '站点B', proxyUrl: 'https://b.example/v1', apiKey: 'sk-b', defaultModel: 'model-b' };
const PRESET_V = { id: 3, name: '识图站', proxyUrl: 'https://v.example/v1', apiKey: 'sk-v', defaultModel: 'model-v' };

// ============================================================
// 用例
// ============================================================
async function main() {
  console.log('========================================');
  console.log(' API 站点预设 · 快照同步回归测试');
  console.log('========================================');

  // ------------------------------------------------------------
  section('① 预设引用存在 → 快照被刷新进 state.apiConfig');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A]],
      state: {
        apiConfig: { mainEndpointPresetId: 1, proxyUrl: '', apiKey: '', model: '' },
        globalSettings: {},
      },
    });
    await sandbox.window.syncApiSlotConfigIntoState();
    const cfg = sandbox.state.apiConfig;
    check('地址被写回 state.apiConfig', cfg.proxyUrl === 'https://a.example/v1', 'proxyUrl=' + cfg.proxyUrl);
    check('密钥被写回', cfg.apiKey === 'sk-a', 'apiKey=' + cfg.apiKey);
    check('模型名用预设的默认模型', cfg.model === 'model-a', 'model=' + cfg.model);
    check('globalSettings 也同步了 (老字段有人用)',
      sandbox.state.globalSettings.proxyUrl === 'https://a.example/v1',
      'gs.proxyUrl=' + sandbox.state.globalSettings.proxyUrl);
  }

  // ------------------------------------------------------------
  section('② 换预设 → 快照跟着变 (这次修的核心)');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [2, PRESET_B]],
      state: {
        apiConfig: { mainEndpointPresetId: 1, proxyUrl: '', apiKey: '', model: '' },
        globalSettings: {},
      },
    });
    await sandbox.window.syncApiSlotConfigIntoState();
    const before = sandbox.state.apiConfig.proxyUrl;
    const beforeModel = sandbox.state.apiConfig.model;

    // 模拟"悬浮球/设置页换了一个预设": 改引用 + 改模型
    //   (悬浮球就是连模型一起改的 —— 新MainModel 来自新预设)
    sandbox.state.apiConfig.mainEndpointPresetId = 2;
    sandbox.state.apiConfig.model = 'model-b';
    await sandbox.window.syncApiSlotConfigIntoState();

    check('换预设后地址立刻变成新的', sandbox.state.apiConfig.proxyUrl === 'https://b.example/v1',
      'before=' + before + ' after=' + sandbox.state.apiConfig.proxyUrl);
    check('换预设后密钥也是新的', sandbox.state.apiConfig.apiKey === 'sk-b');
    check('换预设后模型也是新的 (不会出现"旧地址+新模型"的错配)',
      sandbox.state.apiConfig.model === 'model-b' && beforeModel === 'model-a',
      'before=' + beforeModel + ' after=' + sandbox.state.apiConfig.model);

    // 槽位单独指定了模型时, 静态模型优先于预设默认模型 —— 这是设计, 不是 bug
    sandbox.state.apiConfig.model = 'my-own-model';
    await sandbox.window.syncApiSlotConfigIntoState();
    check('槽位自己指定的模型优先于预设默认模型',
      sandbox.state.apiConfig.model === 'my-own-model',
      'model=' + sandbox.state.apiConfig.model);
  }

  // ------------------------------------------------------------
  section('③ 没用预设的老用户 → 静态字段原样保留');
  {
    const { sandbox } = makeSandbox({
      presets: [],
      state: {
        apiConfig: { proxyUrl: 'https://manual.example/v1', apiKey: 'sk-manual', model: 'm-manual' },
        globalSettings: {},
      },
    });
    await sandbox.window.syncApiSlotConfigIntoState();
    const cfg = sandbox.state.apiConfig;
    check('手填的地址没被动过', cfg.proxyUrl === 'https://manual.example/v1', 'proxyUrl=' + cfg.proxyUrl);
    check('手填的密钥没被动过', cfg.apiKey === 'sk-manual');
    check('手填的模型没被动过', cfg.model === 'm-manual');
  }

  // ------------------------------------------------------------
  section('④ 预设指向不存在的 id → 不炸, 也不清空已有值');
  {
    const { sandbox } = makeSandbox({
      presets: [],
      state: {
        apiConfig: { mainEndpointPresetId: 99, proxyUrl: 'https://keep.example/v1', apiKey: 'sk-keep', model: 'm-keep' },
        globalSettings: {},
      },
    });
    let threw = null;
    try {
      await sandbox.window.syncApiSlotConfigIntoState();
    } catch (e) {
      threw = e;
    }
    check('没有抛异常', !threw, threw ? String(threw.message || threw) : '');
    check('原有地址没被清空', sandbox.state.apiConfig.proxyUrl === 'https://keep.example/v1',
      'proxyUrl=' + sandbox.state.apiConfig.proxyUrl);
  }

  // ------------------------------------------------------------
  section('⑤ 各槽位互相独立 (主站 / 识图 各用各的)');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [3, PRESET_V]],
      state: {
        apiConfig: { mainEndpointPresetId: 1, visionEndpointPresetId: 3 },
        globalSettings: {},
      },
    });
    await sandbox.window.syncApiSlotConfigIntoState();
    const cfg = sandbox.state.apiConfig;
    check('主站用主站预设', cfg.proxyUrl === 'https://a.example/v1', 'proxyUrl=' + cfg.proxyUrl);
    check('识图槽位用识图预设', cfg.visionProxyUrl === 'https://v.example/v1', 'visionProxyUrl=' + cfg.visionProxyUrl);
    check('两个槽位的模型互不干扰', cfg.model === 'model-a' && cfg.visionModel === 'model-v',
      'model=' + cfg.model + ' visionModel=' + cfg.visionModel);
  }

  // ------------------------------------------------------------
  section('⑥ clearReferencedSlotStaticEndpoints 行为不变 (回归保护)');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A]],
      state: { apiConfig: {}, globalSettings: {} },
    });
    const cfg = {
      mainEndpointPresetId: 1,
      proxyUrl: 'https://a.example/v1',
      apiKey: 'sk-a',
      // 没引用预设的槽位 → 不该被动
      secondaryProxyUrl: 'https://sec.example/v1',
      secondaryApiKey: 'sk-sec',
    };
    sandbox.window.clearReferencedSlotStaticEndpoints(cfg);
    check('引用了预设的槽位: 静态字段被清空',
      cfg.proxyUrl === '' && cfg.apiKey === '',
      'proxyUrl=' + JSON.stringify(cfg.proxyUrl));
    check('没引用预设的槽位: 静态字段保留',
      cfg.secondaryProxyUrl === 'https://sec.example/v1' && cfg.secondaryApiKey === 'sk-sec',
      'secondaryProxyUrl=' + cfg.secondaryProxyUrl);
  }

  // ------------------------------------------------------------
  section('⑦ resolveApiSlotConfig 的槽位语义');
  {
    const { sandbox } = makeSandbox({
      presets: [[1, PRESET_A], [3, PRESET_V]],
      state: {
        apiConfig: { mainEndpointPresetId: 1, visionEndpointPresetId: 3 },
        globalSettings: {},
      },
    });
    const main = await sandbox.window.resolveApiSlotConfig('main');
    check('main 槽位拿到主站预设', main.proxyUrl === 'https://a.example/v1', 'proxyUrl=' + main.proxyUrl);

    const vision = await sandbox.window.resolveApiSlotConfig('vision');
    check('vision 槽位拿到识图预设', vision.proxyUrl === 'https://v.example/v1', 'proxyUrl=' + vision.proxyUrl);

    const visionNoInherit = await sandbox.window.resolveApiSlotConfig('vision', { inheritMain: false });
    check('vision 不继承主站时仍拿到自己的预设',
      visionNoInherit.proxyUrl === 'https://v.example/v1', 'proxyUrl=' + visionNoInherit.proxyUrl);

    // 副槽位没配自己的 → 继承主站
    const secondary = await sandbox.window.resolveApiSlotConfig('secondary');
    check('副槽位没配自己的预设时沿用主站', secondary.proxyUrl === 'https://a.example/v1',
      'proxyUrl=' + secondary.proxyUrl);
  }

  // ------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n测试崩了:', e);
  process.exit(1);
});

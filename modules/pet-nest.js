/* ============================================================
 * 宠物屋 · Cove 灵宠屋（前端移植版）
 * ------------------------------------------------------------
 * 纯前端实现：没有后端、没有 Python、没有 MCP。
 * 数据全部存本机 IndexedDB（独立库 PetNestDB，不碰主库 GeminiChatDB）。
 *
 * 规则移植自 https://github.com/moonlin1213/cove-pet-nest
 *   代码 MIT，© 2026 death34018-hue
 *   4 张 starter 素材（room/cat/dog/egg）同属 MIT 共享，见 assets/pet-nest/LICENSE-ASSETS.md
 *
 * 与上游的一处有意分歧（重要）：
 *   上游的「阶段推进」绑在图片服务上 —— 只有新样貌生成成功，宠物才会长大。
 *   没有生图服务时，宠物永远停在第 0 阶段。
 *   本移植把两件事拆开：
 *     · 阶段推进 = 成长值 + 相处天数达标（纯计算，照上游规则表）
 *     · 生图 = 锦上添花的「换新模样」，没有它也照样长大
 *
 * 依赖：全局 Dexie（index.html 已从 unpkg 加载）、全局 state/db。
 * 加载顺序：必须在 modules/message-store.js 之后（要包它的落库函数算粮食）。
 * ============================================================ */
(function () {
  'use strict';

  // ============================================================
  // 0. 常量
  // ============================================================

  const DB_NAME = 'PetNestDB';

  const MAX_TOKENS_PER_DAY = 20000;   // 每日计量封顶
  const GRAIN_BAND_1 = 4000;          // 前 4000 token 密集计粒
  const GRAIN_STEP_1 = 200;           // 每 200 token 一粒
  const GRAIN_STEP_2 = 800;           // 之后每 800 token 一粒
  const BASELINE_MAX = 6;             // 当天首次对话基础粮上限
  const FIRST_ADOPT_BONUS = 36;       // 首次领养奖励

  const SATIETY_MAX = 100;
  const SATIETY_DECAY_PER_HOUR = 2;   // 饱腹每小时 -2
  const FEED_SATIETY = 40;
  const FEED_GROWTH = 2;
  const FEED_COST = 1;                // 喂一次扣 1 粒粮
  const FULL_THRESHOLD = 60;          // 饱腹高于这个值再喂就是「已经吃饱了」

  const KINDS = {
    cat: { label: '小猫', sprite: 'cat-sprites-light.webp' },
    dog: { label: '小狗', sprite: 'dog-sprites-light.webp' },
    egg: { label: '神秘灵宠蛋', sprite: 'egg-sprites-light.webp' },
    // 鹦鹉：暂时没有专属素材, 先顶着蛋的图集, 孵出来以后靠生图换新模样
    parrot: { label: '鹦鹉', sprite: 'egg-sprites-light.webp' },
    snow_leopard: { label: '雪豹', sprite: null },
    snake: { label: '蛇', sprite: null },
    lizard: { label: '蜥蜴', sprite: null }
  };
  const STARTER_KINDS = ['cat', 'dog', 'egg', 'parrot'];   // 能直接开始照顾的
  const HATCH_KINDS = ['egg', 'parrot'];                   // 从蛋里孵出来的
  /** 这两种是从蛋里孵出来的（灵宠蛋 / 鹦鹉） */
  function isHatchKind(kind) {
    return HATCH_KINDS.indexOf(kind) >= 0;
  }
  const TRAITS = ['attachment', 'energy', 'curiosity', 'sociability', 'calm', 'sensitivity'];
  const TRAIT_LABEL = {
    attachment: '依恋', energy: '活力', curiosity: '好奇',
    sociability: '社交', calm: '沉静', sensitivity: '敏锐'
  };

  // 关系维度 → 花纹 / 性格（上游 growth.py 的 DIMENSIONS）
  const DIMENSIONS = {
    affection: { label: '亲昵', marking: '心形绒纹', trait: 'attachment', markEn: 'a soft heart-shaped tuft on the chest' },
    reading: { label: '共读', marking: '书页月纹', trait: 'calm', markEn: 'layered page-shaped markings on the flank' },
    watching: { label: '同看', marking: '流光肩纹', trait: 'curiosity', markEn: 'a shimmering streak across the shoulders' },
    listening: { label: '共听', marking: '风铃耳尖', trait: 'sensitivity', markEn: 'a delicate bell-shaped tuft beside the ear' },
    exploration: { label: '同游', marking: '森林尾尖', trait: 'energy', markEn: 'a tiny sprout-shaped marking on the tail tip' }
  };
  const IDENTITY_NAMES = ['月光绒兽', '森林长耳兽', '星尘角兽', '潮汐软鳞兽'];
  const PALETTES = ['奶油银白', '青绿蜜金', '莓紫暖灰', '湖蓝珊瑚'];
  // 幻兽身份/配色的英文说法（生图提示词是英文的，别把中文塞进去）
  const IDENTITY_EN = {
    '月光绒兽': 'a moonlit silver-white fuzz beast',
    '森林长耳兽': 'a forest long-eared fuzz beast',
    '星尘角兽': 'a stardust horned fuzz beast',
    '潮汐软鳞兽': 'a tide-pool soft-scaled fuzz beast'
  };
  const PALETTE_EN = {
    '奶油银白': 'creamy silver-white fur',
    '青绿蜜金': 'jade-green and honey-gold fur',
    '莓紫暖灰': 'berry-purple and warm grey fur',
    '湖蓝珊瑚': 'lake-blue and coral fur'
  };

  // ============================================================
  // 鹦鹉品种库（挑的都是羽色艳丽的；非洲灰那种灰不拉几的没放进来）
  // 【colorEn 直接进生图提示词, 改的时候别把配色写错】
  // 【note 是给 AI 看的一句话性格, 会拼进 {{petNestContext}}】
  // ============================================================
  const PARROT_BREEDS = [
    {
      key: 'sun_conure', label: '金太阳鹦鹉', en: 'sun conure parrot',
      colorCn: '一身金灿灿的橙黄羽毛',
      colorEn: 'a brilliant golden-orange body with sun-yellow wing tips',
      note: '安静粘人，最爱贴着肩膀待着'
    },
    {
      key: 'jenday', label: '太阳锥尾鹦鹉', en: 'jenday conure parrot',
      colorCn: '翠绿身子、明黄头顶、橙红肚皮',
      colorEn: 'a vivid green body, bright yellow head and warm orange belly',
      note: '胆大爱闹，是家里的小喇叭'
    },
    {
      key: 'lovebird', label: '牡丹鹦鹉', en: 'peach-faced lovebird parrot',
      colorCn: '翠绿身子配一张桃红小脸',
      colorEn: 'a bright green body with a rosy peach-red face',
      note: '黏人爱照镜子，成双养最开心'
    },
    {
      key: 'budgie', label: '虎皮鹦鹉', en: 'budgerigar parakeet',
      colorCn: '嫩黄脑袋、翠绿身子、黑波纹',
      colorEn: 'a soft yellow head, bright green body and dark wavy barring',
      note: '机灵爱闹，会歪头看人'
    },
    {
      key: 'scarlet_macaw', label: '金刚鹦鹉', en: 'scarlet macaw parrot',
      colorCn: '正红羽翼、金黄胸腹、湛蓝尾羽',
      colorEn: 'vivid scarlet wings, a golden-yellow chest and deep blue tail feathers',
      note: '嗓门大，最爱学人说话'
    },
    {
      key: 'blue_macaw', label: '青金刚鹦鹉', en: 'blue-and-yellow macaw parrot',
      colorCn: '通体宝蓝、腹部金灿灿',
      colorEn: 'a deep sapphire-blue body with a brilliant golden-yellow belly',
      note: '沉稳温顺，力气却大得惊人'
    },
    {
      key: 'lorikeet', label: '吸蜜鹦鹉', en: 'rainbow lorikeet parrot',
      colorCn: '红蓝绿黄一身的彩虹色',
      colorEn: 'a rainbow of scarlet, cobalt blue, emerald green and golden yellow',
      note: '花枝招展，走起路来像在跳舞'
    },
    {
      key: 'lutino_cockatiel', label: '白化玄凤鹦鹉', en: 'lutino cockatiel parrot',
      colorCn: '奶油白的羽毛、头顶一撮柠檬黄冠羽',
      colorEn: 'creamy white plumage with a lemon-yellow crest on the head',
      note: '温柔乖巧，会歪头用脸颊蹭人'
    }
  ];

  // ============================================================
  // 神兽形态（鹦鹉长到最后一关 → 羽化）
  // ============================================================
  const DIVINE_BIRDS = [
    {
      key: 'zhuque', label: '朱雀', en: 'vermilion Zhuque phoenix',
      colorCn: '赤金羽翼拖着燃烧般的长尾',
      colorEn: 'vermilion-and-gold plumage trailing a burning crimson tail',
      note: '浴火而生，尾羽像烧红的云'
    },
    {
      key: 'qingluan', label: '青鸾', en: 'blue-green Qingluan phoenix',
      colorCn: '青翠流光的羽色与舒展的凤尾',
      colorEn: 'luminous blue-green plumage and a long sweeping phoenix tail',
      note: '梧桐引凤，一飞就是千里'
    },
    {
      key: 'xuandiao', label: '雪羽鹓鶵', en: 'snow-white Xuandiao bird',
      colorCn: '雪白无瑕的羽毛，翼尖泛着银光',
      colorEn: 'pure snow-white plumage with silver-glinting wingtips',
      note: '传说中的祥瑞鸟，见之则喜'
    },
    {
      key: 'luanfeng', label: '金辉鸾凤', en: 'golden Luan phoenix',
      colorCn: '金橙色的霞光羽毛和层叠凤冠',
      colorEn: 'golden-orange iridescent plumage with a layered crown of feathers',
      note: '五色成文，百鸟之上的那一只'
    }
  ];

  // 关系维度 → 鸟身上的花纹（中文进 AI 上下文, 英文进生图提示词）
  const PARROT_MARKS = {
    affection: { cn: '心形胸羽', en: 'a small heart-shaped plume on the breast' },
    reading: { cn: '层叠书页翼纹', en: 'layered page-shaped bars across the wing' },
    watching: { cn: '流星尾羽', en: 'a comet-shaped streak across the tail feathers' },
    listening: { cn: '风铃耳羽', en: 'a delicate bell-shaped tuft beside the cheek' },
    exploration: { cn: '嫩芽冠羽', en: 'a fresh sprout-shaped crest feather' }
  };
  const DIVINE_STAGE = 4;   // 鹦鹉长到第 4 阶段就羽化成神兽

  /** 品种由种子定：同一只永远同一品种（纯函数，好测） */
  function parrotBreedFor(seed) {
    const h = hash32(String(seed || ''));
    return PARROT_BREEDS[h % PARROT_BREEDS.length];
  }

  const STATUS_TEXT = {
    fed: '吃饱啦',
    played: '一起玩了一会儿',
    comforted: '收到了摸摸',
    full: '已经吃饱了',
    no_food: '粮仓暂时没有粮食',
    pending: '宝宝的模样还在准备'
  };

  const STORAGE_KEYS = {
    desktopPetVisible: 'petNestDesktopPetVisible',
    desktopPetPos: 'petNestDesktopPetPos',
    petNestEnabled: 'petNestEnabled'
  };

  // ============================================================
  // 1. 小工具
  // ============================================================

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID().replace(/-/g, '');
      }
    } catch (e) { /* 降级 */ }
    return 'p' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  }

  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function hashUnit(str) { return hash32(str) / 0xFFFFFFFF; }

  /** 同步版 sha256 的替代：只需要稳定的伪随机，不需要密码学强度 */
  function hashUnitOf(seed, key) { return hashUnit(seed + ':' + key); }

  const _encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  function utf8Length(text) {
    const s = String(text == null ? '' : text);
    if (_encoder) return _encoder.encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  /** 固定按东八区切天，跟设备时区无关 */
  function dayKey(ts) {
    const d = new Date(Number(ts) + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function dayIndex(ts) {
    return Math.floor((Number(ts) + 8 * 3600 * 1000) / 86400000);
  }

  function dayDiff(fromTs, toTs) { return dayIndex(toTs) - dayIndex(fromTs); }

  function round2(n) { return Math.round(Number(n) * 100) / 100; }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToastSafe(text, type) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(text, type); return; } catch (e) { /* 忽略 */ }
    }
    console.log('[宠物屋]', text);
  }

  // ============================================================
  // 2. 存储层（独立 Dexie 库）
  // ============================================================

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      const d = new Dexie(DB_NAME);
      d.version(1).stores({
        pets: '&id, createdAt',          // 宠物本体
        events: '++id, createdAt, petId', // 照顾事件（谁喂的）
        stages: '&key, petId, stage',     // 成长阶段记录
        days: '&day',                     // 每日计量
        turns: '&key',                    // 每轮去重
        meta: '&key',                     // 粮仓等零散状态
        assets: '&id, petId, stage'       // 生图资产（Blob 本体，不存 base64）
      });
      await d.open();
      return d;
    })();
    return dbPromise;
  }

  async function getMeta(key, fallback) {
    const d = await openDb();
    const row = await d.meta.get(key);
    return row ? row.value : fallback;
  }

  async function setMeta(key, value) {
    const d = await openDb();
    await d.meta.put({ key, value });
  }

  async function getGrains() {
    const v = await getMeta('grains', 0);
    return Number(v) || 0;
  }

  async function addGrains(delta) {
    const d = await openDb();
    const current = await getGrains();
    const next = Math.max(0, current + (Number(delta) || 0));
    await setMeta('grains', next);
    return next;
  }

  // ============================================================
  // 3. 规则层（移植自上游 store.py / growth.py / ledger.py）
  // ============================================================

  /** 性格：由领养时的随机 seed 决定，之后永远不变 */
  function temperament(seed) {
    const out = {};
    for (const key of TRAITS) {
      out[key] = round2(10 + 80 * hashUnitOf(seed, key));
    }
    return out;
  }

  /** 换粮曲线：前 4000 每 200 一粒，之后每 800 一粒，每日封顶 20000 token */
  function grainsFor(total) {
    const t = Math.min(Math.max(0, total), MAX_TOKENS_PER_DAY);
    return Math.floor(Math.min(t, GRAIN_BAND_1) / GRAIN_STEP_1)
      + Math.floor(Math.max(0, t - GRAIN_BAND_1) / GRAIN_STEP_2);
  }

  /** 饱腹随时间衰减（读取时计算，不写库） */
  function currentSatiety(pet, now) {
    const settledAt = Number(pet.settledAt || pet.createdAt || now);
    const decay = Math.max(0, (now - settledAt) / 3600000) * SATIETY_DECAY_PER_HOUR;
    return round2(Math.max(0, Number(pet.satiety || 0) - decay));
  }

  /** 下一阶段目标：成长值 + 相处天数（上游 growth.py 的规则表） */
  function growthTarget(pet, currentStage, now) {
    const target = Number(pet.stage || 0) + 1;
    const rules = isHatchKind(pet.kind)
      ? { 1: [12, 2], 2: [40, 7], 3: [100, 14], 4: [220, 21] }
      : { 1: [40, 7], 2: [100, 14], 3: [220, 21] };
    const fallbackGrowth = currentStage && currentStage.growthAtActivation
      ? currentStage.growthAtActivation + 120
      : 120;
    const pair = rules[target] || [fallbackGrowth, 30];
    const requiredGrowth = pair[0];
    const requiredDays = pair[1];
    const anchor = target === 1
      ? Number(pet.createdAt || now)
      : Number(currentStage && currentStage.activatedAt ? currentStage.activatedAt : pet.createdAt || now);
    const elapsedDays = Math.max(0, dayDiff(anchor, now));
    return {
      stage: target,
      requiredGrowth,
      requiredDays,
      elapsedDays,
      ready: Number(pet.growth || 0) >= requiredGrowth && elapsedDays >= requiredDays
    };
  }

  /** 首次孵化条件：成长 ≥12 且年龄 ≥2 天（已经孵出来的就不再是"蛋"了） */
  function canHatch(pet, now) {
    if (!isHatchKind(pet.kind)) return false;
    if (Number(pet.stage || 0) > 0) return false;
    const age = Math.max(0, dayDiff(pet.createdAt, now));
    return Number(pet.growth || 0) >= 12 && age >= 2;
  }

  /** 蛋孵化成什么样：按关系维度 + 照顾次数算出身份/配色/花纹（上游 prepare_hatch） */
  async function computeHatchBrief(pet, now) {
    const d = await openDb();
    const scores = {};
    for (const key of Object.keys(DIMENSIONS)) scores[key] = 0;

    // 关系信号按天封顶 3 分
    const signals = await getMeta('relationshipSignals', []);
    const daily = {};
    for (const item of signals) {
      if (item.at < pet.createdAt || item.at > now) continue;
      const bucket = dayKey(item.at) + '::' + item.key;
      daily[bucket] = Math.min(3, (daily[bucket] || 0) + Number(item.weight || 0));
    }
    for (const bucket of Object.keys(daily)) {
      const key = bucket.split('::')[1];
      if (key in scores) scores[key] += daily[bucket];
    }

    // 真实照顾给一点次要影响
    const events = await d.events.where('petId').equals(pet.id).toArray();
    const experience = {};
    for (const ev of events) experience[ev.action] = (experience[ev.action] || 0) + 1;
    scores.affection += Math.min(1, (experience.comfort || 0) * 0.1);
    scores.exploration += Math.min(1, (experience.play || 0) * 0.1);

    let dimension = 'random';
    let best = 0;
    for (const key of Object.keys(scores)) {
      if (scores[key] > best) { best = scores[key]; dimension = key; }
    }
    const customized = Object.keys(scores).some(k => scores[k] > 0);

    const traits = pet.traits && typeof pet.traits === 'object'
      ? Object.assign({}, pet.traits)
      : temperament(pet.seed);
    if (dimension !== 'random') {
      const traitKey = DIMENSIONS[dimension].trait;
      traits[traitKey] = round2(Math.min(100, traits[traitKey] + Math.min(20, scores[dimension] * 3)));
    }

    const seedHash = hash32(pet.seed || pet.id);

    // 鹦鹉：品种由种子哈希定（同一只永远同一品种），花纹由关系维度定
    if (pet.kind === 'parrot') {
      const breed = parrotBreedFor(pet.seed || pet.id);
      const mark = PARROT_MARKS[dimension] || PARROT_MARKS.affection;
      return {
        stage: 1,
        kind: 'parrot',
        breedKey: breed.key,
        identity: breed.label,
        palette: breed.colorCn,
        dimension,
        dimensionLabel: dimension === 'random' ? '随性' : DIMENSIONS[dimension].label,
        marking: mark.cn,
        markEn: mark.en,
        customized,
        traits,
        features: [mark.cn],
        note: breed.note
      };
    }

    const identity = IDENTITY_NAMES[seedHash % IDENTITY_NAMES.length];
    const palette = PALETTES[(seedHash >>> 8) % PALETTES.length];
    const marking = dimension === 'random' ? '柔和星屑纹' : DIMENSIONS[dimension].marking;

    return {
      stage: 1,
      kind: 'fantasy',
      identity,
      palette,
      dimension,
      dimensionLabel: dimension === 'random' ? '随性' : DIMENSIONS[dimension].label,
      marking,
      markEn: dimension === 'random'
        ? 'soft scattered stardust markings'
        : DIMENSIONS[dimension].markEn,
      customized,
      traits,
      features: [marking]
    };
  }

  // ============================================================
  // 4. 宠物操作
  // ============================================================

  function petView(pet, now) {
    const stages = {};
    return {
      id: pet.id,
      name: pet.name,
      kind: pet.kind,
      status: pet.status || 'ready',
      satiety: currentSatiety(pet, now),
      growth: round2(pet.growth || 0),
      stage: Number(pet.stage || 0),
      traits: pet.traits || temperament(pet.seed),
      appearance: pet.appearance || null,
      assetRef: pet.assetRef || null,
      needsRedraw: !!pet.needsRedraw,
      createdAt: pet.createdAt,
      sprite: (KINDS[pet.kind] && KINDS[pet.kind].sprite) || null
    };
  }

  async function adopt(kind, name, actor) {
    const d = await openDb();
    const now = Date.now();
    const cleanName = String(name || '').trim().slice(0, 32);
    if (!cleanName) throw new Error('得给它起个名字');
    if (!KINDS[kind]) throw new Error('没有这种宝宝');

    const existingCount = await d.pets.count();
    const id = uuid();
    const seed = uuid();
    const status = STARTER_KINDS.indexOf(kind) >= 0 ? 'ready' : 'pending';
    const pet = {
      id,
      kind,
      name: cleanName,
      seed,
      createdAt: now,
      satiety: 60,
      settledAt: now,
      growth: 0,
      stage: 0,
      status,
      assetRef: null,
      needsRedraw: false,
      appearance: null,
      traits: temperament(seed),
      lastFeed: null,
      lastPlay: null,
      lastComfort: null
    };
    await d.pets.add(pet);

    // 首次领养送粮
    if (existingCount === 0) await addGrains(FIRST_ADOPT_BONUS);

    // 阶段 0 记录（相册第一页）
    await d.stages.put({
      key: id + '::0',
      petId: id,
      stage: 0,
      title: '刚到家的样子',
      features: [],
      marking: '',
      identity: KINDS[kind] ? KINDS[kind].label : kind,
      palette: '',
      activatedAt: now,
      growthAtActivation: 0,
      appearance: null,
      isCurrent: true
    });

    return { pet: petView(pet, now), grains: await getGrains(), bonus: existingCount === 0 ? FIRST_ADOPT_BONUS : 0 };
  }

  /**
   * 照顾。user 和 AI 走同一份数据、同一个粮仓。
   * actor: 'user' | 'assistant'
   */
  async function care(action, options) {
    const opts = options || {};
    const actor = opts.actor === 'assistant' ? 'assistant' : 'user';
    const now = Date.now();
    const d = await openDb();

    let rows;
    if (opts.scope === 'all') {
      rows = await d.pets.toArray();
    } else {
      const ids = (opts.petIds || []).filter(Boolean);
      rows = [];
      for (const pid of ids) {
        const row = await d.pets.get(pid);
        if (!row) throw new Error('找不到这只宝宝');
        rows.push(row);
      }
    }

    // 上游的排序：最饿的先照顾
    rows.sort((a, b) => {
      const sa = currentSatiety(a, now), sb = currentSatiety(b, now);
      if (sa !== sb) return sa - sb;
      const la = a.lastFeed || 0, lb = b.lastFeed || 0;
      if (la !== lb) return la - lb;
      return String(a.id).localeCompare(String(b.id));
    });

    let grains = await getGrains();
    const results = [];

    for (const row of rows) {
      let satiety = currentSatiety(row, now);
      let delta = 0;
      let status;

      if (row.status !== 'ready') {
        status = 'pending';
      } else if (action === 'feed' && satiety > FULL_THRESHOLD) {
        status = 'full';
      } else if (action === 'feed' && grains === 0) {
        status = 'no_food';
      } else {
        status = { feed: 'fed', play: 'played', comfort: 'comforted' }[action] || 'played';
        if (action === 'feed') {
          satiety = Math.min(SATIETY_MAX, satiety + FEED_SATIETY);
          grains -= FEED_COST;
          delta = FEED_GROWTH;
        } else {
          const traitKey = action === 'comfort' ? 'attachment' : 'energy';
          const trait = Number((row.traits && row.traits[traitKey]) || 50);
          const recovery = 3600 * (5 - trait / 50); // 毫秒
          const last = row['last' + (action === 'comfort' ? 'Comfort' : 'Play')];
          delta = last == null ? 1 : Math.min(1, Math.max(0, (now - last) / recovery));
        }
        const column = action === 'comfort' ? 'lastComfort' : action === 'play' ? 'lastPlay' : 'lastFeed';
        const update = {
          satiety: round2(satiety),
          settledAt: now,
          growth: round2(Number(row.growth || 0) + delta),
          [column]: now
        };
        await d.pets.update(row.id, update);
        await d.events.add({
          petId: row.id,
          actor,
          action,
          createdAt: now,
          growthDelta: round2(delta)
        });
        row.growth = update.growth;
        row.satiety = update.satiety;
      }

      results.push({ petId: row.id, petName: row.name, status, growthDelta: round2(delta) });
    }

    await setMeta('grains', Math.max(0, grains));

    // 照顾之后检查阶段推进 / 孵化（破壳、羽化会当场告诉你一声）
    for (const row of rows) {
      try {
        const adv = await checkStageProgress(row.id, now);
        if (adv) await announceStageAdvance(adv, row);
      } catch (e) { console.warn('[宠物屋] 阶段检查失败', e); }
    }

    return { results, grains: Math.max(0, grains) };
  }

  /** 破壳 / 羽化 / 升阶 → 当场告诉用户一声，也记进事件流 */
  async function announceStageAdvance(adv, row) {
    if (!adv || !adv.brief) return;
    const name = (row && row.name) || '它';
    const app = adv.brief.appearance || {};
    let text = '';
    let action = 'stage';
    if (app.kind === 'divine') {
      action = 'divine';
      text = name + ' 羽化成神兽了 —— 「' + app.identity + '」，去给它画一张新样子吧';
    } else if (app.kind === 'parrot' || app.kind === 'fantasy') {
      action = 'hatch';
      text = name + ' 破壳了！是一只「' + app.identity + '」';
    } else {
      text = name + ' 成长到第 ' + adv.stage + ' 阶段';
    }
    try {
      const d = await openDb();
      await d.events.add({
        petId: row.id, actor: 'system', action,
        createdAt: Date.now(), note: text
      });
    } catch (e) { /* 忽略 */ }
    showToastSafe(text, 'success');
  }

  /** 阶段推进（纯计算，不依赖生图） */
  async function checkStageProgress(petId, now) {
    const d = await openDb();
    const pet = await d.pets.get(petId);
    if (!pet || pet.status !== 'ready') return null;

    const stageKey = petId + '::' + pet.stage;
    const current = await d.stages.get(stageKey);
    const target = growthTarget(pet, current, now);
    if (!target.ready) return null;

    const brief = await buildStageBrief(pet, current, target, now);
    const nextKey = petId + '::' + target.stage;
    await d.stages.put({
      key: nextKey,
      petId,
      stage: target.stage,
      title: brief.title,
      features: brief.features || [],
      marking: brief.marking || '',
      identity: brief.identity || '',
      palette: brief.palette || '',
      activatedAt: now,
      growthAtActivation: round2(pet.growth || 0),
      appearance: brief.appearance || null,
      isCurrent: true
    });
    await d.stages.update(stageKey, { isCurrent: false });
    // 羽化成神兽 = 形态整个换了 → 身上那张旧图不再对得上，标记「该换一张」
    const divineNow = !!(brief.appearance && brief.appearance.kind === 'divine');
    await d.pets.update(petId, {
      stage: target.stage,
      traits: brief.traits || pet.traits,
      needsRedraw: divineNow ? true : !!pet.needsRedraw
    });

    return { stage: target.stage, brief };
  }

  /** 这一步该走哪条路：破壳 / 羽化 / 普通成长（纯函数, 好测） */
  function stageBriefKind(pet, target) {
    if (isHatchKind(pet.kind) && Number(pet.stage || 0) === 0) return 'hatch';
    const to = Number((target && target.stage) || 0);
    if (pet.kind === 'parrot' && to >= DIVINE_STAGE) return 'divine';
    return 'normal';
  }

  async function buildStageBrief(pet, current, target, now) {
    const kind = stageBriefKind(pet, target);
    if (kind === 'hatch') {
      const hatch = await computeHatchBrief(pet, now);
      await d_pets_update(pet.id, { appearance: hatch });
      return {
        title: hatch.identity,
        features: hatch.features,
        marking: hatch.marking,
        identity: hatch.identity,
        palette: hatch.palette,
        traits: hatch.traits,
        appearance: {
          kind: hatch.kind,                       // 'fantasy' | 'parrot'
          identity: hatch.identity,
          palette: hatch.palette,
          marking: hatch.marking,
          markEn: hatch.markEn || '',
          breedKey: hatch.breedKey || '',
          note: hatch.note || '',
          dimension: hatch.dimension || ''
        }
      };
    }
    // 鹦鹉长到最后一关 → 羽化成神兽
    if (kind === 'divine') {
      return await buildDivineBrief(pet, current, target);
    }
    // 后续阶段：加一簇花纹
    const features = [];
    if (current && Array.isArray(current.features)) features.push(...current.features);
    const dimension = await pickDimension(pet, current, now);
    const theme = {
      reading: '层叠书页形', watching: '流星形', listening: '风铃形',
      affection: '心形', exploration: '叶芽形'
    }[dimension] || '柔和星屑纹';
    const surface = { snake: '软鳞', lizard: '软鳞', parrot: '羽簇' }[pet.kind] || '绒簇';
    const placement = ['额心', '背侧', '尾尖'][(target.stage - 1) % 3];
    const feature = placement + '新增第' + (Math.floor((target.stage - 1) / 3) + 1) + '簇' + theme + surface;
    features.push(feature);
    return {
      title: '第 ' + target.stage + ' 阶段',
      features,
      marking: feature,
      identity: (current && current.identity) || (KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind),
      palette: (current && current.palette) || '',
      traits: pet.traits
    };
  }

  /** 鹦鹉羽化成神兽（最后一关）：形态换成神鸟，但血脉还是原来那只鹦鹉 */
  function divineBriefFor(pet, current) {
    const seedHash = hash32((pet.seed || pet.id) + ':divine');
    const beast = DIVINE_BIRDS[seedHash % DIVINE_BIRDS.length];
    // 血脉（breedKey / dimension）优先取当前阶段的 appearance；
    // 没有就退回宠物自己的 appearance ——
    // 走真实升级路径时，中间阶段（2/3）的记录里 appearance 是空的
    // （buildStageBrief 的普通分支不返回 appearance），血脉只存在宠物身上
    const prev = (current && current.appearance) || (pet && pet.appearance) || {};
    const features = (current && Array.isArray(current.features)) ? current.features.slice() : [];
    features.push('羽化神兽');
    const appearance = {
      kind: 'divine',
      identity: beast.label,
      palette: beast.colorCn,
      marking: '羽化神兽',
      beastKey: beast.key,
      breedKey: prev.breedKey || '',
      note: beast.note,
      dimension: prev.dimension || ''
    };
    return {
      title: '羽化 · ' + beast.label,
      features,
      marking: '羽化神兽',
      identity: beast.label,
      palette: beast.colorCn,
      traits: pet.traits,
      appearance
    };
  }

  async function buildDivineBrief(pet, current, target) {
    const brief = divineBriefFor(pet, current);
    await d_pets_update(pet.id, { appearance: brief.appearance });
    return brief;
  }

  async function d_pets_update(petId, patch) {
    const d = await openDb();
    await d.pets.update(petId, patch);
  }

  async function pickDimension(pet, current, now) {
    const d = await openDb();
    const scores = {};
    for (const key of Object.keys(DIMENSIONS)) scores[key] = 0;
    const signals = await getMeta('relationshipSignals', []);
    const daily = {};
    for (const item of signals) {
      const from = current ? current.activatedAt : pet.createdAt;
      if (item.at < from || item.at > now) continue;
      const bucket = dayKey(item.at) + '::' + item.key;
      daily[bucket] = Math.min(3, (daily[bucket] || 0) + Number(item.weight || 0));
    }
    for (const bucket of Object.keys(daily)) {
      const key = bucket.split('::')[1];
      if (key in scores) scores[key] += daily[bucket];
    }
    let best = 0, dim = '';
    for (const key of Object.keys(scores)) {
      if (scores[key] > best) { best = scores[key]; dim = key; }
    }
    if (dim) return dim;
    const keys = Object.keys(DIMENSIONS);
    return keys[hash32((pet.id || '') + ':' + target_stage_seed(current)) % keys.length];
  }

  function target_stage_seed(current) { return current ? current.stage : 0; }

  // ============================================================
  // 5. 对话计量（攒粮）
  // ============================================================

  /**
   * 上游口径 bounded_visible_estimate_v1：
   *   contribution = min(用户可见字节/3, 输入token) + min(回复可见字节/3, 输出token)
   * 前端拿不到 provider token 时，用字节估算即可（误差不影响游戏）。
   */
  async function recordConversation(payload) {
    const p = payload || {};
    const d = await openDb();
    const now = Number(p.at || Date.now());

    const first = await d.pets.orderBy('createdAt').first();
    if (!first) return { credited: 0, reason: 'no_pet' };
    if (now < first.createdAt) return { credited: 0, reason: 'before_adopt' };

    const contribution = Math.floor((utf8Length(p.userText) + 2) / 3)
      + Math.floor((utf8Length(p.aiText) + 2) / 3);

    const key = String(p.chatId || 'default') + '::' + (p.turnId || now);
    const oldTurn = await d.turns.get(key);
    if (oldTurn && Number(oldTurn.tokens) >= contribution) {
      return { credited: 0, reason: 'duplicate' };
    }

    const day = dayKey(now);
    const dayRow = await d.days.get(day);
    const before = dayRow ? Number(dayRow.tokens || 0) : 0;
    const delta = Math.max(0, contribution - (oldTurn ? Number(oldTurn.tokens || 0) : 0));
    const after = Math.min(MAX_TOKENS_PER_DAY, before + delta);

    let baseline = 0;
    if (!dayRow) {
      const count = await d.pets.where('createdAt').belowOrEqual(now).count();
      baseline = Math.min(BASELINE_MAX, 2 + Math.ceil(Math.sqrt(count)));
    }

    const tokenGrains = grainsFor(after) - grainsFor(before);
    const credited = tokenGrains + baseline;

    await d.turns.put({ key, day, tokens: contribution });
    await d.days.put({
      day,
      tokens: after,
      baseline: (dayRow ? Number(dayRow.baseline || 0) : 0) + baseline
    });
    if (credited > 0) await addGrains(credited);

    return { credited, tokenGrains, baseline };
  }

  /** 关系信号上报（阅读/看剧/听歌/浏览 → 蛋的孵化性格） */
  async function reportSignal(key, weight) {
    if (!(key in DIMENSIONS)) return;
    const w = Math.max(0, Math.min(3, Number(weight) || 1));
    const list = await getMeta('relationshipSignals', []);
    list.push({ key, weight: w, at: Date.now() });
    // 只保留最近 400 条
    while (list.length > 400) list.shift();
    await setMeta('relationshipSignals', list);
  }

  // ============================================================
  // 6. 给 AI 的上下文 + pet_action 执行
  // ============================================================

  function formatPetAppearance(pet) {
    const a = pet.appearance;
    if (!a) {
      const base = KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind;
      return base;
    }
    const parts = [];
    if (a.identity) parts.push(a.identity);
    if (a.palette) parts.push(a.palette);
    if (a.marking) parts.push(a.marking);
    return parts.length ? parts.join('，') : (KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind);
  }

  /** 注入提示词的「当前小窝状态」 */
  async function buildPromptContext() {
    const d = await openDb();
    const pets = await d.pets.orderBy('createdAt').toArray();
    if (!pets.length) return '';
    const now = Date.now();
    const grains = await getGrains();
    const recentEvents = await d.events.orderBy('createdAt').reverse().limit(4).toArray();

    const lines = [];
    lines.push('');
    lines.push('# 当前小窝状态');
    lines.push('你和用户一起养着下面这些小生命。它们是你们共同的宠物，不只是用户的。');
    for (const row of pets) {
      const pet = petView(row, now);
      const stageInfo = isHatchKind(pet.kind) && pet.stage === 0
        ? '还是一颗蛋（孵化需要成长 12 + 相处 2 天）'
        : (pet.kind === 'parrot' && pet.stage >= DIVINE_STAGE ? '已羽化成神兽' : '第 ' + pet.stage + ' 阶段');
      const hunger = pet.satiety <= 30 ? ' · 饿了' : pet.satiety > FULL_THRESHOLD ? ' · 吃得饱饱的' : '';
      lines.push('- ' + pet.name + '（' + (KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind) + ' · ' + stageInfo
        + ' · 饱腹 ' + Math.round(pet.satiety) + '/100 · 成长 ' + Math.round(pet.growth) + hunger + '）');
      lines.push('  模样：' + formatPetAppearance(pet));
      if (pet.appearance && pet.appearance.note) {
        lines.push('  性子：' + pet.appearance.note);
      }
      if (needsLook(pet)) {
        // 只是陈述事实，AI 可以顺口提一句，但不强制
        lines.push('  ' + ((lookHint(pet) || {}).ai || '它还没有专属模样（现在顶着的还是蛋的样子）。'));
      }
    }
    lines.push('- 粮仓剩余 ' + grains + ' 粒（喂一次消耗 1 粒）');

    if (recentEvents.length) {
      lines.push('- 最近的照顾：');
      for (const ev of recentEvents) {
        const row = pets.find(p => p.id === ev.petId);
        const who = ev.actor === 'user' ? '用户' : '你';
        const what = { feed: '喂了', play: '陪玩了', comfort: '摸了摸' }[ev.action] || '照顾了';
        const ago = Math.max(0, Math.round((now - ev.createdAt) / 60000));
        const when = ago < 1 ? '刚刚' : (ago < 60 ? ago + ' 分钟前' : Math.round(ago / 60) + ' 小时前');
        if (ev.note) {
          // 系统自己记的那几条（破壳 / 羽化 / 升阶）——直接用原文，别套「你照顾了」
          lines.push('  · ' + when + '，' + ev.note);
          continue;
        }
        lines.push('  · ' + when + '，' + who + what + (row ? '「' + row.name + '」' : '它')
          + (ev.growthDelta ? '（成长 +' + ev.growthDelta + '）' : ''));
      }
    }

    lines.push('');
    lines.push('# 照顾小窝的规则');
    lines.push('- 你可以照顾它们：用 `pet_action` 指令喂食、陪玩、摸摸（`{"type": "pet_action", "action": "feed|play|comfort", "pet": "宠物名"}`）。');
    lines.push('- **按你自己的心情和当时的聊天氛围来决定**：想喂就喂，想陪它玩就陪它玩，');
    lines.push('  也可以只是随口提一句「它好像有点饿了」。把它当成你们一起养的一个小生命，');
    lines.push('  别机械地每轮都喂——不饿的时候喂它，它不会吃，你也会白费粮食。');
    lines.push('- 粮仓见底时喂不动，你收到的结果会是「粮仓暂时没有粮食」，这时就该提醒用户去聊天攒粮。');
    lines.push('- 照顾宠物这件事要自然，别变成每轮都汇报任务。用 `pet_action` 之后，');
    lines.push('  请在下一条 text 里顺带提一句这件小事，让它像是真的发生在你们之间。');
    lines.push('');
    return lines.join('\n');
  }

  // 提示词上下文缓存：主聊天组装提示词时是同步取值的，不能 await
  let cachedContext = '';

  async function refreshCachedContext() {
    try {
      cachedContext = await buildPromptContext();
    } catch (e) {
      console.warn('[宠物屋] 上下文刷新失败', e);
      cachedContext = '';
    }
    return cachedContext;
  }

  function getCachedContext() {
    return cachedContext;
  }

  /** AI 的 pet_action → 真正执行照顾，并把收据回灌给 AI */
  async function handlePetAction(msgData, chat) {
    const action = String(msgData.action || '').toLowerCase();
    if (['feed', 'play', 'comfort'].indexOf(action) < 0) return null;

    const d = await openDb();
    const pets = await d.pets.toArray();
    let target = null;
    const wanted = String(msgData.pet || msgData.pet_name || '').trim();
    if (wanted) {
      target = pets.find(p => p.name === wanted) || null;
    }
    if (!target && pets.length === 1) target = pets[0];
    if (!target) {
      return { ok: false, reason: 'pet_not_found' };
    }

    let result;
    try {
      result = await care(action, { petIds: [target.id], actor: 'assistant' });
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    const receipt = result.results[0] || { status: 'unknown', growthDelta: 0 };
    const text = STATUS_TEXT[receipt.status] || '这次没什么反应';

    // 收据不塞进聊天记录（避免聊天里多一条奇怪的气泡），
    // 而是通过下一轮的【当前小窝状态】告诉 AI：刚刚发生了什么。
    const receiptText = '你' + (action === 'feed' ? '喂了' : action === 'play' ? '陪玩了' : '摸了摸')
      + '「' + target.name + '」——' + text
      + (receipt.growthDelta ? '，成长 +' + receipt.growthDelta : '')
      + (receipt.status === 'no_food' ? '。粮仓空了，用户得去聊天攒粮了。' : '。');

    // 桌宠/小屋/提示词上下文一起刷新
    await refreshAll();

    return { ok: true, status: receipt.status, text: receiptText, petName: target.name };
  }

  // ============================================================
  // 7. 状态读取
  // ============================================================

  async function getState() {
    const d = await openDb();
    const now = Date.now();
    const rows = await d.pets.orderBy('createdAt').toArray();
    const grains = await getGrains();
    const events = await d.events.orderBy('createdAt').reverse().limit(30).toArray();
    const pets = [];
    for (const row of rows) {
      const pet = petView(row, now);
      const stageKey = row.id + '::' + row.stage;
      const current = await d.stages.get(stageKey);
      pet.growthProgress = (row.status === 'ready' && current) ? growthTarget(row, current, now) : null;
      pet.canHatch = canHatch(row, now);
      pet.lastCare = events.find(e => e.petId === row.id) || null;
      pets.push(pet);
    }
    return {
      grains,
      total: pets.length,
      pets,
      events: events.map(e => ({
        ...e,
        petName: (pets.find(p => p.id === e.petId) || {}).name || '宝宝'
      }))
    };
  }

  // ============================================================
  // 8. UI —— 宠物屋屏幕
  // ============================================================

  let uiState = null;
  let albumPets = [];

  function el(id) { return document.getElementById(id); }

  // 生图样貌的 objectURL 缓存（assetId → url），渲染时同步取用
  const assetUrlMap = {};

  function petSpriteUrl(pet) {
    if (pet.assetRef && assetUrlMap[pet.assetRef]) return assetUrlMap[pet.assetRef];
    if (pet.sprite) return 'assets/pet-nest/' + pet.sprite;
    return null;
  }

  async function loadAssetUrls(pets) {
    if (!window.PetImage || typeof window.PetImage.getAssetUrl !== 'function') return;
    for (const pet of pets) {
      if (!pet.assetRef || assetUrlMap[pet.assetRef]) continue;
      try {
        const url = await window.PetImage.getAssetUrl(pet.assetRef);
        if (url) assetUrlMap[pet.assetRef] = url;
      } catch (e) { /* 忽略 */ }
    }
  }

  function renderScene(state) {
    const host = el('pn-pets');
    if (!host) return;
    host.replaceChildren();
    const empty = el('pn-empty');
    if (empty) empty.hidden = state.total > 0;

    state.pets.slice(0, 12).forEach((pet, i) => {
      const divine = !!(pet.appearance && pet.appearance.kind === 'divine');
      const hatched = !divine && isHatchKind(pet.kind) && pet.stage > 0;
      const btn = document.createElement('button');
      btn.className = 'pn-pet';
      btn.type = 'button';
      btn.setAttribute('aria-label', '照顾' + pet.name);
      btn.style.left = (22 + (i % 4) * 19) + '%';
      btn.style.top = (51 + Math.floor(i / 4) * 12) + '%';
      if (isHatchKind(pet.kind) && pet.stage === 0) {
        btn.style.left = (82 - (i % 3) * 5) + '%';
        btn.style.top = (32 + Math.floor(i / 3) * 2) + '%';
      }
      if (divine) btn.classList.add('pn-pet-divine');
      else if (hatched) btn.classList.add('pn-pet-hatched');

      const sprite = document.createElement('span');
      sprite.className = 'pn-sprite';
      const url = petSpriteUrl(pet);
      if (url) {
        sprite.style.backgroundImage = 'url("' + url + '")';
        // 6 格姿势真循环播（CSS steps 动画，这里只留静态兜底帧）
        sprite.classList.add('pn-sprite-anim');
        setSpriteFrame(sprite, 0);
      } else {
        sprite.classList.add('pn-sprite-empty');
        sprite.textContent = '✧';
      }

      const label = document.createElement('span');
      label.className = 'pn-pet-label';
      label.textContent = pet.name;
      // 品种 / 形态另起一行（小字），别跟名字挤在一行里
      const sub = pet.appearance && pet.appearance.identity;
      if (sub) {
        const subEl = document.createElement('span');
        subEl.className = 'pn-pet-sub' + (divine ? ' pn-pet-sub-divine' : '');
        subEl.textContent = divine ? '神兽 · ' + sub : sub;
        label.append(subEl);
      } else if (pet.status === 'pending') {
        label.textContent = pet.name + ' · 准备中';
      }

      btn.append(sprite, label);
      if (needsLook(pet)) {
        const dot = document.createElement('span');
        dot.className = 'pn-pet-dot';
        dot.title = (lookHint(pet) || {}).dot || '还没专属模样，点一下给它画一张';
        btn.append(dot);
      }
      btn.onclick = () => openCareDialog(pet.id);
      host.append(btn);
    });
  }

  function setSpriteFrame(node, frame) {
    const col = frame % 3;
    const row = Math.floor(frame / 3) % 2;
    // background-size 是 300% 200%，所以列偏移 0%/50%/100%，行偏移 0%/100%
    node.style.backgroundPosition = (col * 50) + '% ' + (row * 100) + '%';
  }

  function renderRoster(state) {
    const host = el('pn-roster');
    if (!host) return;
    host.replaceChildren();
    for (const pet of state.pets) {
      const b = document.createElement('button');
      b.type = 'button';
      const tag = (pet.appearance && pet.appearance.identity)
        || (KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind);
      b.textContent = pet.name + ' · ' + tag;
      b.onclick = () => openCareDialog(pet.id);
      host.append(b);
    }
  }

  function renderEvents(state) {
    const host = el('pn-events');
    if (!host) return;
    host.replaceChildren();
    if (!state.events.length) {
      const li = document.createElement('li');
      li.className = 'pn-quiet';
      li.textContent = '第一段共同照顾，会从这里开始。';
      host.append(li);
      return;
    }
    for (const ev of state.events.slice(0, 8)) {
      const li = document.createElement('li');
      if (ev.note) {
        // 系统自己记的那几条（破壳 / 羽化 / 升阶）
        li.className = 'pn-event-system';
        li.textContent = ev.note;
        host.append(li);
        continue;
      }
      const who = ev.actor === 'user' ? '我' : 'TA';
      const what = { feed: '喂了', play: '陪玩了', comfort: '摸摸了' }[ev.action] || '照顾了';
      li.textContent = who + what + ev.petName;
      host.append(li);
    }
  }

  /** 这只宠物是不是「没自己的图、只能靠生图才有脸」的那种（蛋孵出来的） */
  function needsLook(pet) {
    if (!pet || !isHatchKind(pet.kind)) return false;
    if (Number(pet.stage || 0) <= 0) return false;
    if (pet.needsRedraw) return true;      // 形态变了（羽化成神兽），旧图对不上
    return !pet.assetRef;                  // 从来没给它画过
  }

  /**
   * 「该给它画一张」的具体说法（纯函数，好测）
   * 三种情况：刚破壳 / 长大了还没画 / 羽化成神兽了该换新样
   */
  function lookHint(pet) {
    if (!pet) return null;
    const name = pet.name || '它';
    const stage = Number(pet.stage || 0);
    const app = pet.appearance || {};
    if (pet.needsRedraw) {
      const who = app.identity ? '「' + app.identity + '」' : '新形态';
      return {
        icon: '✨',
        text: name + ' 羽化成' + who + '了，还没换新的专属模样',
        dot: '变成新形态了，点一下给它换张新样子',
        dialog: '它已经羽化成' + who + '了，可身上还是原来的样子 —— 点下面的「换个模样」换一张新的。',
        ai: '它已经羽化成' + who + '了，但身上的样子还是原来的。'
      };
    }
    if (stage <= 1) {
      return {
        icon: '🎨',
        text: name + ' 破壳了，还没有专属模样',
        dot: '还没专属模样，点一下给它画一张',
        dialog: '它已经孵出来了，但还没有专属模样 —— 点下面的「换个模样」给它画一张。',
        ai: '它还没有专属模样（现在顶着的还是蛋的样子）。'
      };
    }
    return {
      icon: '🎨',
      text: name + ' 长到第 ' + stage + ' 阶段了，还没有专属模样',
      dot: '还没专属模样，点一下给它画一张',
      dialog: '它已经长到第 ' + stage + ' 阶段，但还没有专属模样 —— 点下面的「换个模样」给它画一张。',
      ai: '它还没有专属模样（现在顶着的还是蛋的样子）。'
    };
  }

  /** 小窝顶部提示条：① 有蛋可以孵了 ② 有宠物破壳了但还没画像 */
  function renderHintBar(state) {
    const bar = el('pn-hint-bar');
    const text = el('pn-hint-text');
    const icon = el('pn-hint-icon');
    const go = el('pn-hint-go');
    if (!bar || !text) return;
    const ready = state.pets.filter(p => p.status === 'ready');
    const look = ready.filter(needsLook);
    const hatchable = ready.filter(p => p.canHatch);
    let target = null;
    let msg = '';
    let ic = '🐣';
    let btn = '去看看';
    if (look.length) {
      target = look[0];
      const hint = lookHint(target) || {};
      if (look.length > 1) {
        msg = look[0].name + ' 等 ' + look.length + ' 只还没有专属模样';
      } else {
        msg = hint.text || (look[0].name + ' 还没有专属模样');
      }
      ic = hint.icon || '🎨';
      btn = '给它画一张';
    } else if (hatchable.length) {
      target = hatchable[0];
      msg = target.name + ' 的蛋可以孵化了';
      ic = '🐣';
      btn = '去照顾';
    }
    if (!target) {
      bar.hidden = true;
      bar.removeAttribute('data-pet-id');
      return;
    }
    text.textContent = msg;
    if (icon) icon.textContent = ic;
    if (go) go.textContent = btn;
    bar.dataset.petId = target.id;
    bar.hidden = false;
  }

  async function renderAll() {
    const state = await getState();
    uiState = state;
    const grains = el('pn-grains');
    if (grains) grains.textContent = String(state.grains);
    await loadAssetUrls(state.pets);
    renderScene(state);
    renderRoster(state);
    renderEvents(state);
    renderHintBar(state);
    renderDesktopPet(state);
    await refreshCachedContext();
    return state;
  }

  async function refreshAll() {
    try { await renderAll(); } catch (e) { console.warn('[宠物屋] 刷新失败', e); }
  }

  function openCareDialog(petId) {
    const pet = (uiState ? uiState.pets : []).find(p => p.id === petId);
    if (!pet) return;
    const title = el('pn-care-title');
    const details = el('pn-care-details');
    const info = el('pn-care-info');
    if (title) title.textContent = pet.name;
    if (details) {
      let text = (KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind) + ' · 第 ' + pet.stage + ' 阶段'
        + ' · 饱腹 ' + Math.round(pet.satiety) + ' · 成长 ' + Math.round(pet.growth);
      if (pet.appearance && pet.appearance.identity) {
        text += ' · ' + formatPetAppearance(pet);
      }
      if (pet.growthProgress) {
        text += '。下一阶段：成长 ' + pet.growthProgress.requiredGrowth
          + '，相处 ' + pet.growthProgress.elapsedDays + '/' + pet.growthProgress.requiredDays + ' 天。';
      }
      details.textContent = text;
    }
    if (info) {
      info.replaceChildren();
      if (isHatchKind(pet.kind) && pet.stage === 0) {
        const p = document.createElement('p');
        p.textContent = pet.kind === 'parrot'
          ? '这是一颗鹦鹉蛋。照顾与共同相处会影响它孵出来是什么品种、什么羽色；成长达到门槛、相处满两天后，它就会破壳。'
          : '照顾与共同相处会影响它未来的模样。成长达到门槛、相处满两天后，它就会开始孵化。';
        info.append(p);
      }
      if (needsLook(pet)) {
        const p = document.createElement('p');
        p.className = 'pn-quiet';
        p.textContent = (lookHint(pet) || {}).dialog
          || '它还没有专属模样 —— 点下面的「换个模样」给它画一张。';
        info.append(p);
      }
      const traitLine = document.createElement('p');
      traitLine.className = 'pn-quiet';
      traitLine.textContent = '性格：' + TRAITS.map(k => TRAIT_LABEL[k] + ' ' + Math.round(pet.traits[k] || 0)).join(' · ');
      info.append(traitLine);
    }
    // 该给它画脸的时候，把「换个模样」这个按钮点亮
    const evolveBtn = el('pn-evolve-btn');
    if (evolveBtn) {
      const want = needsLook(pet);
      evolveBtn.classList.toggle('pn-btn-primary', want);
      evolveBtn.classList.toggle('pn-btn-glow', want);
      evolveBtn.textContent = want ? (pet.needsRedraw ? '✨ 换个新模样' : '✨ 换个模样') : '换个模样';
    }
    const actions = el('pn-care-actions');
    if (actions) actions.hidden = pet.status !== 'ready';
    const dlg = el('pn-care-dialog');
    if (dlg && !dlg.open) dlg.showModal();
    dlg.dataset.petId = petId;
  }

  async function doCare(action) {
    const dlg = el('pn-care-dialog');
    const petId = dlg ? dlg.dataset.petId : null;
    if (!petId) return;
    try {
      const result = await care(action, { petIds: [petId], actor: 'user' });
      const receipt = result.results[0] || {};
      const msg = STATUS_TEXT[receipt.status] || '这次没什么反应';
      const grainsEl = el('pn-grains');
      if (grainsEl) grainsEl.textContent = String(result.grains);
      showToastSafe(msg, receipt.status === 'no_food' ? 'warning' : 'success');
      if (dlg.open) dlg.close();
      await refreshAll();
    } catch (e) {
      showToastSafe('照顾失败：' + (e.message || e), 'error');
    }
  }

  async function doAdopt(form) {
    const kind = el('pn-adopt-kind') ? el('pn-adopt-kind').value : 'cat';
    const nameInput = el('pn-adopt-name');
    const name = nameInput ? nameInput.value : '';
    try {
      const result = await adopt(kind, name, 'user');
      if (nameInput) nameInput.value = '';
      const dlg = el('pn-adopt-dialog');
      if (dlg && dlg.open) dlg.close();
      showToastSafe(result.bonus ? ('「' + result.pet.name + '」到家了，还送你 ' + result.bonus + ' 粒粮！') : ('「' + result.pet.name + '」到家了'), 'success');
      await refreshAll();
    } catch (e) {
      showToastSafe('领养失败：' + (e.message || e), 'error');
    }
  }

  async function renderAlbum() {
    const host = el('pn-album-list');
    if (!host) return;
    host.replaceChildren();
    const d = await openDb();
    const pets = await d.pets.orderBy('createdAt').toArray();
    for (const row of pets) {
      const stages = await d.stages.where('petId').equals(row.id).sortBy('stage');
      const card = document.createElement('div');
      card.className = 'pn-album-card';
      const h = document.createElement('h3');
      h.textContent = row.name + ' · 一起长大的日子';
      card.append(h);
      if (!stages.length) {
        const p = document.createElement('p');
        p.className = 'pn-quiet';
        p.textContent = '它刚到家，故事还没开始。';
        card.append(p);
      }
      for (const st of stages) {
        const line = document.createElement('div');
        line.className = 'pn-album-row' + (st.isCurrent ? ' is-current' : '');
        const t = document.createElement('strong');
        t.textContent = '第 ' + st.stage + ' 阶段 · ' + (st.title || '');
        const d2 = document.createElement('span');
        d2.className = 'pn-quiet';
        d2.textContent = ' ' + new Date(st.activatedAt).toLocaleDateString('zh-CN');
        const f = document.createElement('p');
        f.textContent = (Array.isArray(st.features) && st.features.length)
          ? st.features.join('；')
          : (st.marking || '刚来时的样子');
        line.append(t, d2, f);
        card.append(line);
      }
      host.append(card);
    }
  }

  // 「回哪儿去」——小窝没有全局返回栈, 所以自己记下进来时所在的屏。
  // 从主屏图标进 → 回主屏; 从桌宠「进入小屋」进 → 回聊天页; 从悬浮球进 → 回原处。
  let pnReturnScreen = null;

  function currentScreenId() {
    const active = document.querySelector('.screen.active');
    if (!active || !active.id) return null;
    return active.id === 'pet-nest-screen' ? null : active.id;
  }

  function openPetNest() {
    const from = currentScreenId();
    if (from) pnReturnScreen = from;
    if (typeof window.showScreen === 'function') {
      window.showScreen('pet-nest-screen');
    }
    refreshAll();
    const dlg = el('pn-adopt-dialog');
    if (dlg && dlg.open) dlg.close();
  }

  /** 关掉小窝，回到进来时的那一屏（默认回主屏） */
  function closePetNest() {
    const target = pnReturnScreen || 'home-screen';
    pnReturnScreen = null;
    if (typeof window.showScreen === 'function') {
      window.showScreen(target);
    }
  }

  // ============================================================
  // 9. 桌宠挂件（可拖动）
  // ============================================================

  function desktopPetEnabled() {
    try { return localStorage.getItem(STORAGE_KEYS.desktopPetVisible) !== 'false'; }
    catch (e) { return true; }
  }

  function saveDesktopPetPos(x, y) {
    try { localStorage.setItem(STORAGE_KEYS.desktopPetPos, JSON.stringify({ x, y })); } catch (e) { /* 忽略 */ }
  }

  function loadDesktopPetPos() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.desktopPetPos);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (typeof v.x === 'number' && typeof v.y === 'number') return v;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  let desktopPetFrame = 0;
  let desktopPetTimer = null;

  /**
   * 页面上现在有没有「全屏遮罩」弹着。
   * 330 的弹窗要么是 <dialog>（showModal 进 top layer，backdrop 盖全屏），
   * 要么是 #custom-modal-overlay.visible（z-index 999999）——
   * 桌宠 z-index 只有 900，压不过，只能「主动让位」把自己藏起来。
   * 纯属性/类选择器，不触发重排，可以放心高频调。
   */
  function anyDialogOpen() {
    try {
      if (document.querySelector('dialog[open]')) return true;
      if (document.querySelector('#custom-modal-overlay.visible')) return true;
      return false;
    } catch (e) { return false; }
  }

  /** 当前激活的屏的 id（330 用 .screen.active 标记） */
  function readActiveScreenId() {
    try {
      const actives = document.querySelectorAll('.screen.active');
      for (let i = 0; i < actives.length; i++) return actives[i].id;
      return '';
    } catch (e) { return ''; }
  }

  /** 当前激活的是不是聊天界面（桌宠只在这里常驻） */
  function onChatScreen() {
    try {
      const actives = document.querySelectorAll('.screen.active');
      for (let i = 0; i < actives.length; i++) {
        if (actives[i].id === 'chat-interface-screen') return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /** 节点是不是「盖住整个视口」的遮罩 */
  function isFullScreenMask(node) {
    try {
      if (!node) return false;
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
    } catch (e) { return false; }
  }

  /** 从命中点往上找：有没有一层盖住整个视口的遮罩 */
  function findFullScreenMask(start) {
    let node = start;
    for (let i = 0; i < 8 && node; i++) {
      if (node === document.body || node === document.documentElement) break;
      if (isFullScreenMask(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 命中测试：桌宠现在到底还能不能被点到？
   * 直接量「桌宠正中心那个点，命中的是不是自己」——
   * 被全屏遮罩吃掉就返回 true。小东西挡一下不算（不藏，否则桌宠会永远消失）。
   */
  function computePetHitBlocked() {
    const wrap = el('pn-desktop-pet');
    if (!wrap || wrap.hidden) return false;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === wrap || wrap.contains(hit)) return false;   // 命中的就是自己 → 没被挡
    return !!findFullScreenMask(hit);
  }

  let petBlockedCache = false;
  let petBlockedCheckedAt = 0;

  function petHitBlocked() {
    const now = Date.now();
    if (now - petBlockedCheckedAt < 400) return petBlockedCache;
    petBlockedCheckedAt = now;
    petBlockedCache = computePetHitBlocked();
    return petBlockedCache;
  }

  /**
   * 桌宠可见性的唯一出口：
   * 不在聊天界面 / 用户关了 / 有全屏遮罩 → 藏；
   * 否则显示，并用命中测试兜底（防止还有别的遮罩把它整个吃掉）。
   */
  function syncDesktopPetVisibility() {
    const wrap = el('pn-desktop-pet');
    if (!wrap) return;
    const shouldShow = desktopPetEnabled() && onChatScreen() && !anyDialogOpen();
    if (!shouldShow) {
      if (!wrap.hidden) wrap.hidden = true;
      return;
    }
    const wasHidden = wrap.hidden;
    wrap.hidden = false;
    if (wasHidden) { petBlockedCache = false; petBlockedCheckedAt = 0; }  // 刚放出来，重新判定
    if (petHitBlocked()) wrap.hidden = true;
  }

  let lastVisibilitySyncAt = 0;
  let visibilitySyncTimer = null;

  function runVisibilitySync() {
    lastVisibilitySyncAt = Date.now();
    try { syncDesktopPetVisibility(); } catch (e) { /* 忽略 */ }
  }

  /** 带节流的重算：已知遮罩立刻让位，其余情况最多 100ms 一次 */
  function scheduleVisibilitySync() {
    try {
      if (anyDialogOpen()) { runVisibilitySync(); return; }
    } catch (e) { /* 忽略 */ }
    const now = Date.now();
    const wait = 100 - (now - lastVisibilitySyncAt);
    if (wait <= 0) { runVisibilitySync(); return; }
    if (visibilitySyncTimer) return;
    visibilitySyncTimer = setTimeout(() => { visibilitySyncTimer = null; runVisibilitySync(); }, wait);
  }

  function renderDesktopPet(state) {
    const wrap = el('pn-desktop-pet');
    if (!wrap) return;
    const pet = state && state.pets.length ? state.pets[0] : null;
    // 有弹窗/遮罩的时候桌宠必须让位 —— 否则遮罩会把整块盖住，
    // 桌宠和它的菜单都点不动（用户实测：点「隐藏桌宠」「进入小屋」都没反应）
    syncDesktopPetVisibility();
    if (wrap.hidden) return;

    const sprite = el('pn-desktop-pet-sprite');
    const name = el('pn-desktop-pet-name');
    if (sprite) {
      sprite.classList.remove('pn-sprite-hatched', 'pn-sprite-divine');
      if (pet) {
        const url = petSpriteUrl(pet);
        if (url) {
          sprite.style.backgroundImage = 'url("' + url + '")';
          sprite.hidden = false;
          const divine = !!(pet.appearance && pet.appearance.kind === 'divine');
          if (divine) sprite.classList.add('pn-sprite-divine');
          else if (isHatchKind(pet.kind) && pet.stage > 0) sprite.classList.add('pn-sprite-hatched');
        } else {
          sprite.hidden = true;
        }
      } else {
        sprite.hidden = true;
      }
    }
    if (name) {
      if (!pet) name.textContent = '';
      else {
        const hunger = pet.satiety <= 30 ? '饿了' : pet.satiety > FULL_THRESHOLD ? '饱饱的' : '在等你';
        name.textContent = pet.name + ' · ' + hunger;
      }
    }
    const bubble = el('pn-desktop-pet-bubble');
    if (bubble && pet) {
      bubble.hidden = !(pet.satiety <= 30);
      if (!bubble.hidden) bubble.textContent = '它好像饿了…';
    }
  }

  function initDesktopPet() {
    const wrap = el('pn-desktop-pet');
    if (!wrap || wrap.dataset.pnInit === '1') return;
    wrap.dataset.pnInit = '1';

    const saved = loadDesktopPetPos();
    if (saved) {
      wrap.style.left = saved.x + 'px';
      wrap.style.top = saved.y + 'px';
    }

    // 待机动画：呼吸 + 偶尔换姿态
    if (!desktopPetTimer) {
      desktopPetTimer = setInterval(() => {
        if (document.hidden) return;
        desktopPetFrame = (desktopPetFrame + 1) % 6;
        const sprite = el('pn-desktop-pet-sprite');
        if (sprite && sprite.style.backgroundImage) setSpriteFrame(sprite, desktopPetFrame);
      }, 5200);
    }

    // 拖动
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originX = 0, originY = 0;

    wrap.addEventListener('pointerdown', (e) => {
      // ⚠️ 菜单必须用【id】判定：它在 HTML 里只有 id、没有 class，
      // 用 class 的话这里永远判不中 → 按菜单按钮也会进拖动 + setPointerCapture，
      // 指针捕获会把后续 click 全抢到 wrap 上 → 按钮的 onclick 根本不触发（用户实测：两个按钮都点不动）
      if (e.target.closest('#pn-desktop-pet-menu')) return;
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      const rect = wrap.getBoundingClientRect();
      originX = rect.left; originY = rect.top;
      wrap.classList.add('is-dragging');
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const maxX = Math.max(0, window.innerWidth - wrap.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - wrap.offsetHeight);
      const nx = Math.min(maxX, Math.max(0, originX + dx));
      const ny = Math.min(maxY, Math.max(0, originY + dy));
      wrap.style.left = nx + 'px';
      wrap.style.top = ny + 'px';
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove('is-dragging');
      try { wrap.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (moved) {
        saveDesktopPetPos(parseInt(wrap.style.left, 10) || 0, parseInt(wrap.style.top, 10) || 0);
      }
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    // 点击 → 菜单
    wrap.addEventListener('click', (e) => {
      if (moved) { moved = false; return; }
      // 菜单里的两个按钮用【事件委托】处理，不给按钮自己绑 onclick ——
      // 委托在 wrap 上，只要 wrap 收到 click 就一定生效（按钮的 onclick 被谁覆盖了也不怕）
      const enterBtn = e.target.closest('#pn-desktop-pet-enter');
      if (enterBtn) {
        e.stopPropagation();
        openPetNest();
        const m = el('pn-desktop-pet-menu');
        if (m) m.hidden = true;
        return;
      }
      const toggleBtn = e.target.closest('#pn-desktop-pet-toggle');
      if (toggleBtn) {
        e.stopPropagation();
        // 只做「隐藏」，不做来回切换 —— 桌宠藏了以后菜单也跟着藏了，
        // 用户没法再点一次把它点回来（只能靠悬浮球菜单的「桌宠」开关）
        try { localStorage.setItem(STORAGE_KEYS.desktopPetVisible, 'false'); } catch (err) { /* 忽略 */ }
        const m = el('pn-desktop-pet-menu');
        if (m) m.hidden = true;
        refreshAll();
        return;
      }
      // 同上：菜单用 id 判定，点菜单里的空白处不能把菜单又切回去
      if (e.target.closest('#pn-desktop-pet-menu')) return;
      const menu = el('pn-desktop-pet-menu');
      if (menu) menu.hidden = !menu.hidden;
    });

    document.addEventListener('click', (e) => {
      const menu = el('pn-desktop-pet-menu');
      if (!menu || menu.hidden) return;
      if (!e.target.closest('#pn-desktop-pet')) menu.hidden = true;
    });

    // 任何 <dialog> 开 / 关，都要立刻重算桌宠的可见性
    // （不然弹窗打开时桌宠还杵在那儿，被 backdrop 挡住点不动）
    if (typeof MutationObserver === 'function') {
      try {
        const mo = new MutationObserver(() => {
          try { scheduleVisibilitySync(); } catch (e) { /* 忽略 */ }
        });
        mo.observe(document.documentElement, {
          attributes: true, subtree: true, attributeFilter: ['open', 'class']
        });
      } catch (e) { /* 忽略 */ }
    }
  }

  // ============================================================
  // 10. 对外 API + 钩子
  // ============================================================

  async function handleAiReply(chat, aiMessage) {
    try {
      const chatId = chat && chat.id ? chat.id : (window.state && window.state.activeChatId);
      const userText = findLastUserText(chat);
      const aiText = typeof aiMessage.content === 'string' ? aiMessage.content : '';
      const result = await recordConversation({
        chatId,
        userText,
        aiText,
        turnId: aiMessage && aiMessage.timestamp ? aiMessage.timestamp : Date.now()
      });
      if (result.credited > 0) {
        console.log('[宠物屋] 攒粮 +' + result.credited);
        await refreshAll();
      }
    } catch (e) {
      console.warn('[宠物屋] 计量失败', e);
    }
  }

  function findLastUserText(chat) {
    if (!chat || !Array.isArray(chat.history)) return '';
    for (let i = chat.history.length - 1; i >= 0; i--) {
      const m = chat.history[i];
      if (m && m.role === 'user' && !m.isHidden && typeof m.content === 'string') return m.content;
    }
    return '';
  }

  function installMessageHook() {
    const store = window.messageStore;
    if (!store || typeof store.addMessageToChat !== 'function') return false;
    if (store.__petNestHooked) return true;
    const original = store.addMessageToChat.bind(store);
    store.addMessageToChat = async function (chat, message, ...rest) {
      const result = await original(chat, message, ...rest);
      try {
        if (message && message.role === 'assistant') {
          handleAiReply(chat, message);
        }
      } catch (e) { /* 忽略 */ }
      return result;
    };
    store.__petNestHooked = true;
    return true;
  }

  function patchShowScreen() {
    if (typeof window.showScreen !== 'function') return;
    // 330 的 init-event-bindingsA.js 会把 window.showScreen 【赋值两次】（835 / 922 行），
    // 后一次可能把我们的补丁整个盖掉 → 所以用「函数身上的标记」判断，而不是全局标志，
    // 补丁被覆盖后（标记没了）看门狗会重新打上。
    if (window.showScreen.__pnPatched) return;
    const original = window.showScreen;
    const patched = function (screenId) {
      const out = original.apply(this, arguments);
      try {
        // 桌宠只在聊天界面常驻，其他界面收起；有弹窗/遮罩时也要让位
        syncDesktopPetVisibility();
      } catch (e) { /* 忽略 */ }
      return out;
    };
    patched.__pnPatched = true;
    patched.__pnOriginal = original;
    window.showScreen = patched;
    window.__petNestShowScreenPatched = true;
  }

  let desktopPetWatchdog = null;

  /**
   * 桌宠看门狗（兜底，不依赖任何一方配合）：
   * ① 每 1.2 秒比对一次「当前激活的屏」，变了就重算桌宠可见性
   *    —— 330 内部怎么切屏都无所谓（window.showScreen 的补丁可能被覆盖）
   * ② 补丁被覆盖时自动重打
   */
  function startDesktopPetWatchdog() {
    if (desktopPetWatchdog) return;
    let lastScreenId = readActiveScreenId();
    desktopPetWatchdog = setInterval(() => {
      try {
        const now = readActiveScreenId();
        if (now !== lastScreenId) {
          lastScreenId = now;
          syncDesktopPetVisibility();
        }
        if (typeof window.showScreen === 'function' && !window.showScreen.__pnPatched) {
          patchShowScreen();
        }
      } catch (e) { /* 忽略 */ }
    }, 1200);
  }

  function bindUi() {
    const adoptBtn = el('pn-adopt-open');
    if (adoptBtn) {
      adoptBtn.onclick = () => {
        const dlg = el('pn-adopt-dialog');
        if (dlg && !dlg.open) dlg.showModal();
      };
    }
    const adoptForm = el('pn-adopt-form');
    if (adoptForm) {
      adoptForm.onsubmit = (e) => { e.preventDefault(); doAdopt(); };
    }
    const kindSel = el('pn-adopt-kind');
    if (kindSel) {
      kindSel.onchange = () => {
        const hint = el('pn-adopt-hint');
        if (!hint) return;
        const v = kindSel.value;
        if (v === 'cat' || v === 'dog') hint.textContent = '小猫和小狗有现成的模样，可以直接到家。';
        else if (v === 'egg') hint.textContent = '先领一颗未知的蛋；未来的模样由你们的相处共同塑造。';
        else if (v === 'parrot') hint.textContent = '鹦鹉也是从蛋里出来的：先把它领回家，孵出来会是一只艳丽的鹦鹉，再给它画一张专属模样。';
        else hint.textContent = '这一种宝宝需要图片服务或导入专属模样，准备好后才会来到小屋。';
      };
    }
    const feedAll = el('pn-feed-all');
    if (feedAll) {
      feedAll.onclick = async () => {
        try {
          const result = await care('feed', { scope: 'all', actor: 'user' });
          showToastSafe(result.results.map(r => STATUS_TEXT[r.status]).filter(Boolean).join('；') || '小窝里还没有宝宝。', 'success');
          await refreshAll();
        } catch (e) {
          showToastSafe('照顾失败：' + (e.message || e), 'error');
        }
      };
    }
    document.querySelectorAll('[data-pn-action]').forEach(b => {
      b.onclick = () => doCare(b.getAttribute('data-pn-action'));
    });
    document.querySelectorAll('[data-pn-close]').forEach(b => {
      b.onclick = () => {
        const dlg = b.closest('dialog');
        if (dlg) dlg.close();
      };
    });
    const albumBtn = el('pn-album-open');
    if (albumBtn) {
      albumBtn.onclick = async () => {
        await renderAlbum();
        const dlg = el('pn-album-dialog');
        if (dlg && !dlg.open) dlg.showModal();
      };
    }

    const backBtn = el('pn-back-btn');
    if (backBtn) backBtn.onclick = closePetNest;

    // 顶部提示条 → 直接打开那只宠物的照顾弹窗
    const hintGo = el('pn-hint-go');
    if (hintGo) {
      hintGo.onclick = () => {
        const bar = el('pn-hint-bar');
        const pid = bar ? bar.getAttribute('data-pet-id') : '';
        if (pid) openCareDialog(pid);
      };
    }

    const probeBtn = el('pn-probe-btn');
    if (probeBtn) {
      probeBtn.onclick = async () => {
        if (!window.PetImage || typeof window.PetImage.probe !== 'function') {
          showToastSafe('生图模块没加载好，刷新一下页面', 'error');
          return;
        }
        probeBtn.disabled = true;
        probeBtn.textContent = '检测中…';
        try {
          const report = await window.PetImage.probe();
          const lines = (report.steps || []).slice();
          if (report.error) lines.unshift('❌ ' + report.error);
          showToastSafe(lines.join(' ｜ ') || (report.ok ? '生图通道正常' : '检测没出结果'), report.ok ? 'success' : 'error');
          console.log('[宠物屋] 生图自检:', report);
        } catch (e) {
          showToastSafe('自检失败：' + (e.message || e), 'error');
        } finally {
          probeBtn.disabled = false;
          probeBtn.textContent = '生图自检';
        }
      };
    }

    const evolveBtn = el('pn-evolve-btn');
    if (evolveBtn) {
      evolveBtn.onclick = async () => {
        const dlg = el('pn-care-dialog');
        const petId = dlg ? dlg.dataset.petId : null;
        const pet = (uiState ? uiState.pets : []).find(p => p.id === petId);
        if (!pet) return;
        if (!window.PetImage || typeof window.PetImage.generateAtlas !== 'function') {
          showToastSafe('生图模块没加载好，刷新一下页面', 'error');
          return;
        }
        const confirmed = await confirmImageCost();
        if (!confirmed) return;
        evolveBtn.disabled = true;
        const oldText = evolveBtn.textContent;
        evolveBtn.textContent = '画着呢…';
        try {
          await generateNewLook(pet);
        } catch (e) {
          showToastSafe('生成失败：' + (e.message || e), 'error');
        } finally {
          evolveBtn.disabled = false;
          evolveBtn.textContent = oldText;
        }
      };
    }
  }

  /** 生图要花钱, 先问一句 */
  async function confirmImageCost() {
    if (typeof window.showCustomConfirm === 'function') {
      try {
        return await window.showCustomConfirm(
          '生成新模样',
          '这会调用一次生图接口（可能产生费用）。<br><br>要给它画一张新的样子吗？',
          { confirmButtonClass: 'btn-primary', confirmText: '画吧' }
        );
      } catch (e) { /* 忽略 */ }
    }
    return window.confirm('这会调用一次生图接口（可能产生费用），要画吗？');
  }

  function subjectForPet(pet) {
    const look = formatPetAppearance(pet);
    const app = pet.appearance || null;

    // 已经羽化成神兽
    if (app && app.kind === 'divine') {
      const beast = DIVINE_BIRDS.find(b => b.key === app.beastKey) || DIVINE_BIRDS[0];
      return 'a mythical ' + beast.en + ', ' + beast.colorEn
        + ', majestic layered tail feathers, a soft warm halo of light around it';
    }

    // 还没孵出来（灵宠蛋 / 鹦鹉蛋）：画成蛋
    if (isHatchKind(pet.kind) && Number(pet.stage || 0) === 0) {
      return pet.kind === 'parrot'
        ? 'a speckled magical parrot egg resting on a nest of soft grass and small flowers'
        : 'speckled magical egg resting on a nest of soft grass and small flowers';
    }

    // 鹦鹉：品种配色全用英文说法（colorEn 是给生图模型看的）
    if (pet.kind === 'parrot') {
      const breed = PARROT_BREEDS.find(b => b.key === (app && app.breedKey)) || PARROT_BREEDS[0];
      const mark = app && app.markEn ? ', ' + app.markEn : '';
      return 'a fluffy ' + breed.en + ' with ' + breed.colorEn + mark;
    }

    // 灵宠蛋：孵出来了 → 要画成那只幻兽。
    // （这里原来一直返回 "speckled magical egg"，孵出来的幻兽又被画回蛋，是个 bug）
    if (pet.kind === 'egg') {
      const identity = app && app.identity ? (IDENTITY_EN[app.identity] || app.identity) : '';
      const palette = app && app.palette ? (PALETTE_EN[app.palette] || app.palette) : '';
      const mark = app && app.markEn ? ', ' + app.markEn : '';
      return 'a cute fantasy spirit beast with soft glowing fur'
        + (identity ? ', ' + identity : '')
        + (palette ? ', ' + palette : '') + mark;
    }

    const kindText = {
      cat: 'fluffy cat', dog: 'fluffy puppy'
    }[pet.kind] || 'cute fantasy pet';
    return kindText + (look ? ', ' + look : '');
  }

  /** 给这只宠物生成（或更新）样貌，并把新样子塞给 AI 看 */
  async function generateNewLook(pet) {
    const d = await openDb();
    const row = await d.pets.get(pet.id);
    if (!row) throw new Error('找不到这只宝宝');

    const stageKey = pet.id + '::' + row.stage;
    const stageRow = await d.stages.get(stageKey);
    const subject = subjectForPet(pet);
    const change = (stageRow && stageRow.marking) ? stageRow.marking : '';

    let processed;
    if (row.assetRef) {
      // 已经有样貌了 → 带参考图蜕变, 保持是同一只
      const refRow = await d.assets.get(row.assetRef);
      const refBlob = refRow ? refRow.blob : null;
      if (!refBlob) throw new Error('找不到原来的样貌图，不能蜕变');
      processed = await window.PetImage.evolveAtlas(subject, change || 'grow a little more mature and keep the same look', refBlob);
    } else {
      processed = await window.PetImage.generateAtlas(subject, { quality: 'medium' });
    }

    const asset = await window.PetImage.saveAsset(pet.id, row.stage, processed.blob, {
      transparent: processed.transparent,
      sourceSize: processed.sourceSize
    });
    await d.pets.update(pet.id, { assetRef: asset.id, needsRedraw: false });
    if (stageRow) await d.stages.update(stageKey, { appearance: asset.id });

    await refreshAll();

    // 让 AI 也看见它的新样子
    try {
      const chatId = window.state && window.state.activeChatId;
      const chat = chatId && window.state.chats ? window.state.chats[chatId] : null;
      if (chat && window.PetImage.injectSnapshot) {
        const okSnap = await window.PetImage.injectSnapshot(chat, pet, asset.id);
        if (okSnap) showToastSafe('新样子画好了，也已经给 TA 看过啦', 'success');
      }
    } catch (e) {
      console.warn('[宠物屋] 快照注入失败', e);
    }

    showToastSafe('新模样画好了：' + (processed.transparent ? '透明底 ✓' : '不透明底（已本地抠图）'), 'success');
    return asset;
  }

  async function init() {
    // ⚠️ 顺序很重要：桌宠的事件绑定和可见性观察器必须【先】装上。
    // 以前这里先干等 messageStore（最多 6 秒）+ showScreen（最多 3 秒），
    // 桌宠的 observer 要等 9 秒后才挂上 —— 用户几秒内点进聊天页，
    // 桌宠还停在「主屏时算出来的 hidden」状态，就出现「进去没有桌宠」。
    bindUi();
    initDesktopPet();
    startDesktopPetWatchdog();

    // 先把库打开、把界面画出来 —— 桌宠的图要马上有，不能等 messageStore
    try {
      await openDb();
      await refreshAll();
    } catch (e) {
      console.warn('[宠物屋] 初始化失败', e);
    }

    // showScreen 定义在 chat-list.js，由 init-event-bindingsA 挂到 window —— 稍等一下再挂钩
    for (let i = 0; i < 30 && typeof window.showScreen !== 'function'; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    patchShowScreen();
    // 等主库和 messageStore 就绪
    for (let i = 0; i < 60 && !window.messageStore; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    installMessageHook();
  }

  // ============================================================
  // 11. 导出
  // ============================================================

  window.PetNest = {
    open: openPetNest,
    close: closePetNest,
    getState,
    getDb: openDb,
    adopt,
    care,
    recordConversation,
    reportSignal,
    buildPromptContext,
    getCachedContext,
    handlePetAction,
    refresh: refreshAll,
    renderAlbum,
    toggleDesktopPet: function (visible) {
      try {
        localStorage.setItem(STORAGE_KEYS.desktopPetVisible, visible ? 'true' : 'false');
      } catch (e) { /* 忽略 */ }
      refreshAll();
    },
    desktopPetEnabled,
    // 给测试用：把纯规则函数暴露出来（tests/pet-nest.test.cjs 直接验算，不用起浏览器）
    rules: {
      grainsFor,
      temperament,
      growthTarget,
      currentSatiety,
      canHatch,
      dayKey,
      dayDiff,
      setSpriteFrame,
      subjectForPet,
      formatPetAppearance,
      isHatchKind,
      needsLook,
      lookHint,
      anyDialogOpen,
      onChatScreen,
      isFullScreenMask,
      findFullScreenMask,
      computePetHitBlocked,
      syncDesktopPetVisibility,
      scheduleVisibilitySync,
      stageBriefKind,
      parrotBreedFor,
      divineBriefFor,
      PARROT_BREEDS,
      DIVINE_BIRDS,
      PARROT_MARKS,
      DIVINE_STAGE,
      STATUS_TEXT,
      KINDS,
      DIMENSIONS,
      MAX_TOKENS_PER_DAY,
      GRAIN_BAND_1,
      GRAIN_STEP_1,
      GRAIN_STEP_2,
      BASELINE_MAX,
      FIRST_ADOPT_BONUS,
      SATIETY_DECAY_PER_HOUR,
      FEED_SATIETY,
      FEED_GROWTH,
      FEED_COST,
      FULL_THRESHOLD
    }
  };
  window.openPetNest = openPetNest;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

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
  // 【2026-10-25 用户定】「饿得太慢了，至少 100 的饱腹，一天要喂两次嘛」
  //   → 满值按每小时 -8 掉 → 大约 12.5 小时见底 → 一天正好两次
  const SATIETY_DECAY_PER_HOUR = 8;
  const FEED_GROWTH = 2;
  // 【2026-10-25 用户定】「一开始喂一次一颗，升级后一次两颗什么的」
  //   → 一次喂的粮 = 阶段数 + 1（第 0 阶段吃 1 颗，第 1 阶段吃 2 颗…）
  //   → 每颗粮给半饱（FEED_SATIETY_PER_GRAIN），吃 2 颗刚好吃饱
  const FEED_SATIETY_PER_GRAIN = 50;
  const FULL_THRESHOLD = 60;          // 饱腹高于这个值再喂就是「已经吃饱了」
  // 【2026-10-25 用户定】「一直没人喂会饿死吗」→ 饿满 3 天就真没了（永久删除，不可恢复）
  const STARVE_DAYS = 3;

  /** 喂一次要吃几颗粮（长大一点食量就大一倍） */
  function feedGrainCost(pet) {
    const stage = Math.max(0, Number((pet && pet.stage) || 0));
    return stage + 1;
  }

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

  // ============================================================
  // 1·五、灵宠蛋孵出来的那只「幻兽」
  //   物种 + 配色 = 领养时按 seed 盲盒定死（同一只永远同一只）
  //   每天的造型 = 当天你们做了什么（听歌→音符、看剧→幕布…）+ 当天穿搭
  //   升级时      = 只加花纹，形态不动
  // ============================================================

  /** 领养时定死「它是只什么」—— 物种 + 配色，纯盲盒（纯函数，好测） */
  function beastSpeciesForSeed(seed) {
    const h = hash32(String(seed || 'beast'));
    const species = BEAST_SPECIES[h % BEAST_SPECIES.length];
    const palette = BEAST_PALETTES[(h >>> 17) % BEAST_PALETTES.length];
    return { species: species.cn, speciesEn: species.en, palette: palette.cn, paletteEn: palette.en };
  }

  /**
   * 今天它该长什么样（纯函数，好测）
   * @param {Array}  behaviors  今天发生过的行为 [{type, count}]
   * @param {string} dayKeyStr  哪一天（决定当天穿搭）
   * @param {string} seed       这只宠物的种子
   * @param {Array}  texts      当天聊过的内容（代表词）→ 从里面现挑一个小装饰
   */
  function dailyLookFor(behaviors, dayKeyStr, seed, texts) {
    const list = Array.isArray(behaviors) ? behaviors : [];
    const features = [];
    for (const b of list) {
      const type = typeof b === 'string' ? b : (b && b.type);
      if (!type) continue;
      // ⚠️ BEHAVIOR_FEATURES 现在是空表（用户 2026-10-25 定的：行为一律不加装饰）
      //    → 这一段目前恒为空；留着是为了以后往表里加一条就能自动生效。
      const f = BEHAVIOR_FEATURES[type];
      if (f && !features.some(x => x.en === f.en)) features.push(f);
      if (features.length >= 3) break;
    }
    // 当天聊的内容 → 现挑一个能物化的小装饰（用户要的「惊喜感」在这）
    const icons = pickIconsFromText((texts || []).join(' \n'), 1);
    // 当天穿搭：按「天 + 种子」定，同一天同一只永远同一套
    const h = hash32(String(dayKeyStr || 'day') + ':outfit:' + String(seed || ''));
    const outfit = BEAST_OUTFITS[h % BEAST_OUTFITS.length];
    return { features, icons, outfit, behaviors: list.slice() };
  }

  /**
   * 从当天聊的内容里挑一个「能物化的小装饰」
   * 打分：命中【不同的同义词】越多越准（10 分/个），
   *      同一个词重复出现只补最多 5 分 —— 免得「歌」刷屏把别的都压掉。
   */
  function pickIconsFromText(text, limit) {
    const s = String(text || '');
    if (!s.trim()) return [];
    const scored = [];
    for (const icon of ICON_LIBRARY) {
      let hits = 0;
      let freq = 0;
      for (const k of icon.keys) {
        let idx = s.indexOf(k);
        if (idx < 0) continue;
        hits++;
        while (idx >= 0) { freq++; idx = s.indexOf(k, idx + k.length); }
      }
      if (!hits) continue;
      scored.push({ icon, score: hits * 10 + Math.min(freq, 5) });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.icon.cn < b.icon.cn ? -1 : 1));
    return scored.slice(0, limit || 1).map(x => x.icon);
  }

  /** 某一天 0 点的毫秒时间戳（东八区，跟设备时区无关） */
  function dayStartTs(day) {
    const s = day || dayKey(Date.now());
    const t = Date.parse(s + 'T00:00:00+08:00');
    return isNaN(t) ? 0 : t;
  }

  /**
   * 当天的「代表词」：长期记忆里今天新增的碎片 + 今天聊过的话
   * 【用户原话】「当天向量到什么内容」「在当天的长期记忆里找代表词」
   */
  let dayTextCache = { day: '', texts: [] };

  async function todayRepresentativeTexts() {
    const day = dayKey(Date.now());
    const dayStart = dayStartTs(day);
    const out = [];
    // ① 长期记忆（向量记忆）里今天新增的碎片 —— content + tags
    try {
      const vm = window.vectorMemoryManager;
      const chats = (window.state && window.state.chats) || {};
      if (vm && typeof vm.getAllFragments === 'function') {
        for (const id of Object.keys(chats)) {
          const chat = chats[id];
          if (!chat) continue;
          const frags = vm.getAllFragments(chat) || [];
          for (const f of frags) {
            if (!f) continue;
            const at = Number(f.createdAt || f.time || 0);
            if (at && at < dayStart) continue;
            const txt = [f.content || '', (f.tags || []).join(' ')].join(' ');
            if (txt.trim()) out.push(txt);
          }
        }
      }
    } catch (e) { /* 忽略 */ }
    // ② 今天聊过的话
    try {
      const d = await openDb();
      const notes = await d.dailyNotes.where('day').equals(day).toArray();
      for (const n of notes) if (n && n.text) out.push(String(n.text));
    } catch (e) { /* 忽略 */ }
    dayTextCache = { day, texts: out };
    return out;
  }

  function cachedDayTexts() {
    const day = dayKey(Date.now());
    if (dayTextCache.day !== day) dayTextCache = { day, texts: [] };
    return dayTextCache.texts;
  }

  /** 生图时用：现收集当天的行为 + 代表词，算出今天它该长什么样 */
  async function buildTodayLook(pet) {
    const day = dayKey(Date.now());
    const behaviors = await todayBehaviors(day);
    const texts = await todayRepresentativeTexts();
    return dailyLookFor(behaviors, day, (pet && (pet.seed || pet.id)) || '', texts);
  }

  /** 中文组合名：「脑袋上飘着几个小音符的粉红奶龙」/「穿旗袍的奶龙」 */
  function beastDisplayName(app, look) {
    const species = (app && app.beastSpecies) || (app && app.identity) || '灵兽';
    const palette = (app && app.palette) || '';
    const parts = [];
    const lk = look || { features: [], icons: [], outfit: null };
    for (const i of lk.icons || []) parts.push(i.cn);
    for (const f of lk.features || []) parts.push(f.cn);
    if (lk.outfit) parts.push(lk.outfit.cn);
    const head = parts.length ? parts.join('、') : '';
    // ⚠️ 20 件穿搭的中文名全都以「的」结尾（穿旗袍的 / 戴着白手套的…），
    //    原来这里再补一个「的」→ 「穿着白手套的的星尘角兽」。补之前先看一句。
    const tail = head && !/的$/.test(head) ? head + '的' : head;
    return (palette ? palette : '') + tail + species;
  }

  /** 英文生图提示词：物种 + 配色 + 今天挑出来的小装饰 + 今天的特征 + 穿搭 + 花纹 + 审美锁 */
  function beastPrompt(app, look, markEn) {
    const speciesEn = (app && app.beastSpeciesEn) || 'a round cute fantasy beast';
    const paletteEn = (app && app.beastPaletteEn) || 'pastel pink';
    const lk = look || { features: [], icons: [], outfit: null };
    // 物种英文自带 "a/an/the"（不然拼出来是 "a a chubby dragon"），别再补一次冠词
    const sp = String(speciesEn).trim();
    const spWithArticle = /^(a|an|the)\s/i.test(sp) ? sp : 'a ' + sp;
    const bits = [spWithArticle, 'with ' + paletteEn + ' fur'];
    for (const i of lk.icons || []) bits.push(i.en);
    for (const f of lk.features || []) bits.push(f.en);
    if (lk.outfit) bits.push(lk.outfit.en);
    if (markEn) bits.push(markEn);
    return bits.join(', ') + ', ' + ART_STYLE_LOCK;
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
  // ============================================================
  // 幻兽库（灵宠蛋孵出来的那只）
  // 【设计意图】用户原话：「孵出来的是个什么，想随机的、天马行空的，
  //   不是固定一个什么形象」—— 大家都在猜「会不会是穿旗袍的奶龙」。
  //   所以物种不能是固定几种，而是一个大盲盒池：
  //   龙之九子 + 东西方神话神兽/精灵 + 软萌幻想生物。
  //   【不含猫 / 狗 / 鹦鹉】—— 那三个已经有专门的（猫狗是现成素材，鹦鹉有品种库）。
  //   英文只写通用描述、不写具体作品名（奶龙 = chubby round baby dragon）。
  // ============================================================
  const BEAST_SPECIES = [
    // ---- 最初的四个（月光绒兽那一批）—— 保留在池子里，新蛋也抽得到 ----
    { cn: '月光绒兽', en: 'a round moonlit beast with soft silver-white fluffy fur', lineage: 'spirit' },
    { cn: '森林长耳兽', en: 'a round beast with long forest-green ears and soft fluffy fur', lineage: 'spirit' },
    { cn: '星尘角兽', en: 'a round beast with a tiny curved horn and soft starry fur', lineage: 'spirit' },
    { cn: '潮汐软鳞兽', en: 'a round beast with soft shimmering scales and tiny fin ears', lineage: 'spirit' },
    // ---- 龙之九子 ----
    { cn: '囚牛', en: 'a chubby round baby dragon hugging a tiny golden harp', lineage: 'dragon' },
    { cn: '睚眦', en: 'a round baby dragon with comically huge fierce eyes', lineage: 'dragon' },
    { cn: '嘲风', en: 'a little dragon-beast perched on a tiny curved rooftop', lineage: 'dragon' },
    { cn: '蒲牢', en: 'a chubby baby dragon with a little bronze bell on its neck', lineage: 'dragon' },
    { cn: '狻猊', en: 'a round lion-dragon cub with a soft curly mane', lineage: 'dragon' },
    { cn: '霸下', en: 'a stout baby turtle-dragon carrying a tiny stone tablet', lineage: 'dragon' },
    { cn: '狴犴', en: 'a small lion-like beast with a very serious expression', lineage: 'dragon' },
    { cn: '蚣蝮', en: 'a round dragon-turtle surrounded by tiny water ripples', lineage: 'dragon' },
    { cn: '螭吻', en: 'a wide-mouthed baby dragon that loves swallowing little flames', lineage: 'dragon' },
    // ---- 东方神话神兽 ----
    { cn: '麒麟', en: 'a tiny qilin with one glowing horn and soft flame-like fur', lineage: 'auspice' },
    { cn: '白泽', en: 'a round white mythical beast with a tiny book-shaped mark on its forehead', lineage: 'auspice' },
    { cn: '九尾狐', en: 'a fluffy fox spirit with nine tiny ribbon-like tails', lineage: 'auspice' },
    { cn: '穷奇', en: 'a chunky winged beast with a fierce little face', lineage: 'auspice' },
    { cn: '饕餮', en: 'a chubby beast with a huge round mouth and tiny sparkling eyes', lineage: 'auspice' },
    { cn: '烛龙', en: 'a long round dragon with one big glowing lantern eye', lineage: 'auspice' },
    { cn: '帝江', en: 'a round six-legged blob creature with a red pouch on its head', lineage: 'auspice' },
    { cn: '窈窕', en: 'a slender shy forest spirit with a gentle smile', lineage: 'auspice' },
    { cn: '鹿蜀', en: 'a little deer-like beast with horses hooves and a tiny bird tail', lineage: 'auspice' },
    { cn: '鲲', en: 'a round baby kun-fish with tiny shimmering wing fins', lineage: 'auspice' },
    { cn: '陆吾', en: 'a tiger-headed guardian beast with soft round paws', lineage: 'auspice' },
    { cn: '月兔', en: 'a round moon-rabbit spirit with silvery ears', lineage: 'auspice' },
    // ---- 西方神话精灵 ----
    { cn: '梦貘', en: 'a round dream-eater beast with soft fluffy fur and a tiny dream bubble', lineage: 'spirit' },
    { cn: '独角兽', en: 'a tiny round unicorn with a pastel spiral horn', lineage: 'spirit' },
    { cn: '狮鹫', en: 'a small gryphon with a fluffy feathered body and small wings', lineage: 'spirit' },
    { cn: '美人鱼', en: 'a round baby mermaid with a sparkly tail and a tiny seashell', lineage: 'spirit' },
    { cn: '小精灵', en: 'a tiny woodland pixie with iridescent butterfly wings', lineage: 'spirit' },
    { cn: '妖精', en: 'a round forest faerie with tiny glowing petals', lineage: 'spirit' },
    { cn: '火蜥蜴', en: 'a plump salamander with a soft glowing ember tail', lineage: 'spirit' },
    { cn: '小龙', en: 'a tiny western dragon with a rounded snout and small round wings', lineage: 'dragon' },
    { cn: '水灵', en: 'a round translucent water spirit with jelly-soft skin', lineage: 'spirit' },
    { cn: '树精', en: 'a small forest spirit with leaf-green hair', lineage: 'spirit' },
    { cn: '雪精', en: 'a puffy snow-spirit with tiny ice-crystal ears', lineage: 'spirit' },
    { cn: '独眼巨人', en: 'a friendly round cyclops with one big gentle eye', lineage: 'spirit' },
    // ---- 软萌幻想 ----
    { cn: '奶龙', en: 'a chubby round baby dragon with big friendly eyes', lineage: 'dragon' },
    { cn: '小龙猫', en: 'a round chinchilla-like fantasy creature with huge fluffy cheeks', lineage: 'spirit' },
    { cn: '棉花糖团子', en: 'a puffy marshmallow-creature with a soft cloud-like body', lineage: 'spirit' },
    { cn: '小云朵灵', en: 'a tiny cloud spirit with a fluffy misty body', lineage: 'spirit' },
    { cn: '软糖精灵', en: 'a translucent gummy sprite with sparkly jelly skin', lineage: 'spirit' },
    { cn: '小星星精', en: 'a small five-pointed star creature with a cute glowing face', lineage: 'spirit' },
    { cn: '圆耳兔', en: 'a round bunny with huge soft ears', lineage: 'spirit' },
    { cn: '小熊猫', en: 'a chubby red-panda-like fantasy creature with a fluffy striped tail', lineage: 'spirit' },
    { cn: '蘑菇精', en: 'a round mushroom-creature with a polka-dot cap', lineage: 'spirit' },
    { cn: '雪团子', en: 'a round snowball spirit with tiny ice-crystal ears', lineage: 'spirit' },
    { cn: '灯泡精', en: 'a round glass-bulb spirit with a warm glowing heart inside', lineage: 'spirit' },
    { cn: '雨滴精', en: 'a plump teardrop water spirit with tiny wings', lineage: 'spirit' },
    { cn: '团子羊', en: 'a round fluffy sheep-creature with a cloud-like wool coat', lineage: 'spirit' },
    { cn: '小鹿精', en: 'a tiny deer fawn with soft rounded antlers', lineage: 'spirit' },
    { cn: '泡泡鱼', en: 'a round pufferfish-like creature with tiny fins', lineage: 'spirit' },
    { cn: '小水母', en: 'a tiny jellyfish spirit with a glowing bell-shaped head', lineage: 'spirit' },
    { cn: '雪人精', en: 'a tiny snowman spirit with a scarf and round coal eyes', lineage: 'spirit' },
    { cn: '小熊糖', en: 'a chubby bear cub made of spun sugar', lineage: 'spirit' },
    { cn: '小飞象', en: 'a tiny round elephant spirit with big floppy ears', lineage: 'spirit' },
    { cn: '小鲸灵', en: 'a chubby baby whale spirit with a tiny spout', lineage: 'spirit' },
    { cn: '小云兔', en: 'a tiny round bunny spirit with clouds instead of fur', lineage: 'spirit' }
  ];

  // ---- 终形态（羽化）按族群分 ----
  // ⚠️【2026-10-25 用户定】「羽化不会是每个神兽最后的设定吧？不能最后都长翅膀吧？」
  //   → 终形态按【族群】分，每族有自己的终形态，不是所有神兽都变神鸟。
  //   → dragon = 龙神 / auspice = 灵瑞 / spirit = 灵幻 / 鹦鹉 = 神鸟
  const DIVINE_FORMS = {
    dragon: [
      { key: 'longwang', label: '龙君', en: 'a chubby round dragon lord', colorEn: 'glossy azure scales with soft golden horns', note: '小龙长大了，气度也跟着长' },
      { key: 'zhenlong', label: '真龙', en: 'a plump serpentine dragon beast', colorEn: 'deep teal and pearl scales with a tiny forked beard', note: '尾巴一甩就有风' },
      { key: 'yinglong', label: '应龙', en: 'a round winged dragon beast', colorEn: 'frost-white and silver scales with tiny feathered wings', note: '会飞一点点，就已经很高兴了' },
      { key: 'jiaolong', label: '蛟龙', en: 'a chubby horned dragon cub', colorEn: 'ink-blue scales shimmering with violet light', note: '还小呢，就已经会腾云了' }
    ],
    auspice: [
      { key: 'xuanwu', label: '玄武', en: 'a round turtle-spirit beast', colorEn: 'deep jade shell with soft swirling mist', note: '沉稳得像座小山' },
      { key: 'qinglong', label: '青龙', en: 'a chubby serpentine azure beast', colorEn: 'bright jade-green scales with soft luminous whiskers', note: '生气起来眉毛会抖' },
      { key: 'baihu', label: '白虎', en: 'a round white tiger spirit', colorEn: 'snow-white fur with pale silver stripes', note: '平时眯着眼睛晒太阳' },
      { key: 'luanhou', label: '鸾鸟', en: 'a round phoenix-like spirit', colorEn: 'rose-gold plumage with soft glowing feathers', note: '飞不高，但很好看' }
    ],
    spirit: [
      { key: 'lingxi', label: '灵犀', en: 'a round luminous spirit beast', colorEn: 'iridescent opal sheen with drifting sparkles', note: '身上总飘着一点点光' },
      { key: 'yuling', label: '玉灵', en: 'a chubby jade-colored spirit', colorEn: 'milky jade translucence with soft inner glow', note: '看着像一块会动的玉' },
      { key: 'xingling', label: '星灵', en: 'a round star-fairy creature', colorEn: 'twinkling star-blue fur with tiny floating motes', note: '一说话就有星星掉下来' },
      { key: 'yunjing', label: '云精', en: 'a puffy cloud spirit beast', colorEn: 'soft mist-white fur with drifting vapor', note: '摸上去像棉花' }
    ]
  };

  /** 这只宠物的族群（决定它羽化成什么样） */
  function beastLineage(pet, app) {
    if (!pet) return 'spirit';
    if (pet.kind === 'parrot') return 'bird';
    const a = app || pet.appearance || {};
    const speciesCn = a.beastSpecies || a.identity || '';
    const found = BEAST_SPECIES.find(s => s.cn === speciesCn);
    if (found && found.lineage) return found.lineage;
    // 老数据 / 找不到 → 从名字里猜（龙/神兽关键词），猜不到就归到灵幻
    if (/龙|螭|吻/.test(speciesCn)) return 'dragon';
    if (/麒麟|白泽|狐|穷奇|饕餮|烛龙|帝江|窈窕|鹿蜀|鲲|陆吾|月兔/.test(speciesCn)) return 'auspice';
    return 'spirit';
  }

  /** 终形态列表（鹦鹉走神鸟，其余按族群） */
  function divineFormsFor(lineage) {
    if (lineage === 'bird') return DIVINE_BIRDS;
    return DIVINE_FORMS[lineage] || DIVINE_FORMS.spirit;
  }


  // 「今天它经历了什么」→ 今天长出来什么（全部往可爱方向走，不做滑稽的解剖变异）
  //
  // ⚠️【2026-10-25 用户定的】形态特征**全删** —— 行为完全不体现在长相上。
  //   之前是「低频行为配形态特征」（读书→书页 / 喂食→围兜 / 听歌→音符 / 看剧→幕布 /
  //   陪玩→皮球 / 摸摸→绒毛），用户判定这些行为「都不低频」→
  //   「干脆不根据这些加装饰了」。所以这里是**空表**。
  //
  //   现在每天的长相只由三样决定：
  //     ① 物种 + 配色 —— 领养时盲盒定死，同一只永远同一只
  //     ② 当天记忆内容现挑的**一个小装饰**（ICON_LIBRARY，同义词匹配）← 惊喜感在这
  //     ③ 当天随机**一件穿搭**（BEAST_OUTFITS，按天+种子定）
  //   外加升级长出来的花纹（关系维度分 → 花纹、性格）。
  //
  //   ⚠️ 行为**仍然会被记录**（见 TRIGGER_SIGNALS / DIMENSIONS）：
  //     听歌/看剧/阅读要记关系维度分（花纹、性格），其余当「今天有动静」的触发。
  //     「记录行为」≠「根据行为改长相」，这两件事是分开的。
  //
  //   以后想再加行为类形态特征，往这张表里加一条就行（下面 dailyLookFor 会自动认）。
  const BEHAVIOR_FEATURES = {};
  // 「今天有动静」的行为 —— 只当「要不要给它换造型」的触发，不占形态特征
  const TRIGGER_SIGNALS = ['chatting', 'feeding', 'comforting', 'listening', 'watching', 'reading', 'playing'];

  // ============================================================
  // 「可物化意象库」—— 从当天聊的内容里现挑一个小装饰
  // 【用户原话】「当天向量到什么内容，挑一个能物化的小装饰加上更有惊喜」
  //   keys = 同义词（跟当天的记忆/聊天内容匹配）
  //   en   = 喂给生图模型的英文（保证画得出来）
  //   cn   = 给用户看的名字
  // 想加新意象 → 加一行就行
  // ============================================================
  const ICON_LIBRARY = [
    { cn: '一串小音符', en: 'a few tiny floating music notes above its head', keys: ['歌', '音乐', '唱', '旋律', '耳机', '单曲', '歌单', '演唱会', '钢琴'] },
    { cn: '一把小伞', en: 'a tiny umbrella resting on its head', keys: ['伞', '下雨', '雨', '淋雨', '梅雨'] },
    { cn: '一杯热饮', en: 'a tiny cup of warm drink in its paws', keys: ['咖啡', '奶茶', '茶', '喝', '热可可', '拿铁'] },
    { cn: '一本翻开的书', en: 'a tiny open book resting on its back', keys: ['书', '读', '学习', '知识', '看完', '小说', '论文'] },
    { cn: '一支小铅笔', en: 'a tiny pencil tucked behind its ear', keys: ['写', '作业', '考试', '笔', '笔记', '论文', '复习'] },
    { cn: '一颗小星星', en: 'a tiny glowing star above its head', keys: ['星', '梦想', '希望', '夜空', '星星', '闪耀'] },
    { cn: '一串小铃铛', en: 'a tiny string of bells hanging from its collar', keys: ['铃', '声音', '开心', '笑', '高兴', '叮'] },
    { cn: '一个小相机', en: 'a tiny camera hanging around its neck', keys: ['拍照', '照片', '相机', '记录', '拍'] },
    { cn: '一串小气球', en: 'a few tiny balloons tied to its tail', keys: ['生日', '庆祝', '派对', '气球', '纪念日'] },
    { cn: '一片小树叶', en: 'a tiny green leaf tucked on its head', keys: ['树', '自然', '秋天', '叶子', '公园', '植物'] },
    { cn: '一颗小糖果', en: 'a tiny candy in its cheek', keys: ['糖', '甜', '好吃', '零食', '蛋糕', '甜品'] },
    { cn: '一顶小帽子', en: 'a tiny hat perched on its head', keys: ['帽子', '穿搭', '衣服', '搭配', '穿'] },
    { cn: '一枚小钥匙', en: 'a tiny golden key on a ribbon', keys: ['钥匙', '门', '家', '锁', '开门'] },
    { cn: '一块小手表', en: 'a tiny watch on its wrist', keys: ['时间', '几点', '迟到', '闹钟', '日程', '赶时间'] },
    { cn: '一根小天线', en: 'a tiny antenna on its head with a blinking tip', keys: ['信号', '网络', '消息', '回复', '上线', '断联'] },
    { cn: '一片小羽毛', en: 'a tiny soft feather floating beside it', keys: ['羽毛', '鸟', '飞', '轻', '飘'] },
    { cn: '一个救生圈', en: 'a tiny striped swim ring around its belly', keys: ['游泳', '海', '水', '旅行', '海边', '泳池'] },
    { cn: '一块小砖头', en: 'a tiny brick in its paws', keys: ['盖', '房子', '装修', '建', '施工', '搬家'] },
    { cn: '一顶小皇冠', en: 'a tiny golden crown on its head', keys: ['赢', '第一', '厉害', '冠军', '厉害啦', '成功'] },
    { cn: '一只小碗', en: 'a tiny bowl in front of it', keys: ['吃', '饭', '饿', '喂', '饿坏'] },
    { cn: '一颗小灯泡', en: 'a tiny light bulb glowing above its head', keys: ['想法', '灵感', '突然', '主意', '想到', '明白'] },
    { cn: '一株小嫩芽', en: 'a tiny sprout growing from its head', keys: ['种', '成长', '开始', '发芽', '新'] },
    { cn: '一弯小月亮', en: 'a tiny crescent moon resting on its head', keys: ['晚安', '睡', '夜', '梦', '困'] },
    { cn: '一只小风筝', en: 'a tiny kite floating above it', keys: ['风', '放风筝', '天空', '飞', '自由'] },
    { cn: '一块小拼图', en: 'a tiny puzzle piece in its paws', keys: ['拼', '谜', '问题', '解决', '推理', '线索'] },
    { cn: '一张小地图', en: 'a tiny folded map in its paws', keys: ['地图', '路', '旅行', '去哪', '出发', '导航'] },
    { cn: '一把小梳子', en: 'a tiny comb in its fur', keys: ['梳', '头发', '毛', '打理'] },
    { cn: '一个救生圈小旗', en: 'a tiny pennant flag on a stick', keys: ['旗', '比赛', '加油', '出发'] },
    { cn: '一只小篮子', en: 'a tiny woven basket beside it', keys: ['篮子', '野餐', '装', '摘'] },
    { cn: '一块小磨刀石', en: 'a tiny whetstone in its paws', keys: ['磨', '锋利', '刀', '准备'] },
    { cn: '一把小扇子', en: 'a tiny fan in its paw', keys: ['扇', '凉快', '热', '空调', '风扇'] },
    { cn: '一枚小硬币', en: 'a tiny shiny coin in its paw', keys: ['钱', '零花钱', '买', '价格', '省'] },
    { cn: '一颗小桃子', en: 'a tiny peach held in its paws', keys: ['桃', '水果', '吃', '甜'] },
    { cn: '一个小风筝线轴', en: 'a tiny spool of string in its paws', keys: ['线', '风筝', '缝', '手工'] },
    { cn: '一朵小雪花', en: 'a tiny snowflake resting on its head', keys: ['雪', '冬天', '冷', '下雪', '冰'] },
    { cn: '一枚小印章', en: 'a tiny red stamp in its paws', keys: ['盖章', '文件', '合同', '签', '证明'] },
    { cn: '一条小围巾', en: 'a tiny knitted scarf around its neck', keys: ['围巾', '冷', '冬天', '保暖'] },
    { cn: '一个小背包', en: 'a tiny backpack on its back', keys: ['背包', '出门', '旅行', '装东西', '上学'] },
    { cn: '一串小灯泡', en: 'a string of tiny warm lights around it', keys: ['灯', '亮', '电', '装饰', '温暖'] },
    { cn: '一片小羽毛扇', en: 'a tiny feather fan in its paws', keys: ['扇子', '优雅', '表演'] },
    { cn: '一个小铃铛球', en: 'a tiny bell on a toy ball', keys: ['玩具', '球', '玩'] },
    { cn: '一本小菜谱', en: 'a tiny cookbook in its paws', keys: ['菜谱', '做饭', '煮', '厨房', '烘焙'] },
    { cn: '一顶小渔夫帽', en: 'a tiny bucket hat on its head', keys: ['渔夫帽', '遮阳', '钓鱼'] }
  ];

  // 聊天里提到什么 → 也算今天经历的一部分（关键词表，想加随时加）
  const CHAT_KEYWORD_FEATURES = [
    { keys: ['歌', '音乐', '唱', '旋律', '耳机', '单曲'], feature: 'listening' },
    { keys: ['电影', '剧', '追剧', '片'], feature: 'watching' },
    { keys: ['书', '读完', '看完', '小说'], feature: 'reading' },
    { keys: ['吃', '饿', '饭', '奶茶', '零食'], feature: 'feeding' },
    { keys: ['游戏', '段位', '上分'], feature: 'playing' },
    { keys: ['困', '睡', '晚安', '熬夜'], feature: 'idle' },
    { keys: ['天气', '太阳', '下雨', '好热', '好冷'], feature: 'idle' }
  ];

  // 生图审美锁：不管抽到什么组合，都不许画出恐怖谷 / 写实动物
  const ART_STYLE_LOCK = 'chibi, round and soft, big sparkly eyes, pastel candy colors, '
    + 'cute fantasy creature, plush rounded shapes, friendly and gentle expression, '
    + 'clean simple background, full body, game art style';

  // 羽化（终形态）专属的「绚丽」词条 —— 【用户原话 2026-10-25】「羽化以后要绚丽」
  // ⚠️ 必须在 ART_STYLE_LOCK【之后】加：lock 里是「圆润可爱」，绚丽是「更华丽」，
  //   两者不冲突（华丽 ≠ 写实凶猛），但要保证 Q 版化不被冲掉。
  const DIVINE_STYLE_LOCK = 'ornate and luminous, jewel-toned accents, glowing filigree, '
    + 'radiant sparkling aura, still chibi and adorable';

  // 「穿搭」—— 用户原话「穿搭倒是可以随便」，天马行空的安全出口放这儿
  const BEAST_OUTFITS = [
    { cn: '穿旗袍的', en: 'wearing a red silk qipao dress' },
    { cn: '戴着草帽的', en: 'wearing a straw hat' },
    { cn: '系着蝴蝶结的', en: 'with a big ribbon bow on its head' },
    { cn: '披着小斗篷的', en: 'wearing a tiny cape' },
    { cn: '穿小西装的', en: 'wearing a tiny formal suit' },
    { cn: '顶着小皇冠的', en: 'wearing a small golden crown' },
    { cn: '背着书包的', en: 'carrying a little school backpack' },
    { cn: '穿着小袜子的', en: 'wearing tiny knitted socks' },
    { cn: '戴着圆框眼镜的', en: 'wearing round glasses' },
    { cn: '系着围裙的', en: 'wearing a little apron' },
    { cn: '披着毛线围巾的', en: 'wearing a chunky knitted scarf' },
    { cn: '穿着花衬衫的', en: 'wearing a floral shirt' },
    { cn: '戴着大耳机的', en: 'wearing oversized headphones' },
    { cn: '套着小雨衣的', en: 'wearing a little yellow raincoat' },
    { cn: '提着小灯笼的', en: 'holding a tiny paper lantern' },
    { cn: '扎着小辫子的', en: 'with two tiny braided pigtails' },
    { cn: '戴着白手套的', en: 'wearing little white gloves' },
    { cn: '抱着小水壶的', en: 'holding a tiny watering can' },
    { cn: '穿着溜冰鞋的', en: 'wearing tiny ice skates' },
    { cn: '举着小旗子的', en: 'holding a tiny flag' }
  ];
  const BEAST_PALETTES = [
    { cn: '粉红', en: 'bubblegum pink' },
    { cn: '奶油', en: 'warm cream' },
    { cn: '蜜橘', en: 'bright tangerine' },
    { cn: '薄荷绿', en: 'fresh mint green' },
    { cn: '湖蓝', en: 'clear lake blue' },
    { cn: '樱花粉', en: 'sakura pink' },
    { cn: '莓紫', en: 'deep berry purple' },
    { cn: '奶咖', en: 'milky coffee brown' },
    { cn: '雾灰蓝', en: 'misty grey-blue' },
    { cn: '柠檬黄', en: 'bright lemon yellow' },
    { cn: '天青', en: 'pale sky blue' },
    { cn: '玫瑰金', en: 'rose gold' },
    { cn: '抹茶绿', en: 'matcha green' },
    { cn: '淡珊瑚', en: 'soft coral' },
    { cn: '可可棕', en: 'cocoa brown' },
    { cn: '雪白', en: 'snowy white' }
  ];

  // 老版本只有 4 个固定幻兽（老数据还在库里，得继续认、继续能生图）
  const LEGACY_IDENTITY_NAMES = ['月光绒兽', '森林长耳兽', '星尘角兽', '潮汐软鳞兽'];
  const LEGACY_PALETTES = ['奶油银白', '青绿蜜金', '莓紫暖灰', '湖蓝珊瑚'];
  // 幻兽身份/配色的英文说法（生图提示词是英文的，别把中文塞进去）
  const LEGACY_IDENTITY_EN = {
    '月光绒兽': 'a moonlit silver-white fuzz beast',
    '森林长耳兽': 'a forest long-eared fuzz beast',
    '星尘角兽': 'a stardust horned fuzz beast',
    '潮汐软鳞兽': 'a tide-pool soft-scaled fuzz beast'
  };
  const LEGACY_PALETTE_EN = {
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
    no_food: '粮食不够喂这一顿',
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
      // v2: 每天的行为信号（听歌/看剧/阅读/聊天…）→ 今天它长什么样
      d.version(2).stores({
        pets: '&id, createdAt',
        events: '++id, createdAt, petId',
        stages: '&key, petId, stage',
        days: '&day',
        turns: '&key',
        meta: '&key',
        assets: '&id, petId, stage',
        dailySignals: '++id, day, type, at'
      });
      // v3: 当天聊过的话（代表词）→ 从里面现挑一个能物化的小装饰
      d.version(3).stores({
        pets: '&id, createdAt',
        events: '++id, createdAt, petId',
        stages: '&key, petId, stage',
        days: '&day',
        turns: '&key',
        meta: '&key',
        assets: '&id, petId, stage',
        dailySignals: '++id, day, type, at',
        dailyNotes: '++id, day, at'
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

  /**
   * 从什么时候开始饿的？（纯计算，不写库）
   * 饱腹是线性掉的，所以「归零时刻」能直接算出来：
   *   归零时刻 = 上次结算时间 + 当时饱腹 / 每小时衰减 × 一小时
   * 没饿到就返回 null。
   */
  function hungrySinceOf(pet, now) {
    const settledAt = Number(pet.settledAt || pet.createdAt || now);
    const base = Number(pet.satiety || 0);
    if (base <= 0) return settledAt;                       // 本来就是 0
    if (!(SATIETY_DECAY_PER_HOUR > 0)) return null;
    const zeroAt = settledAt + (base / SATIETY_DECAY_PER_HOUR) * 3600000;
    return zeroAt <= now ? zeroAt : null;
  }

  /**
   * 饥饿状态（纯函数，好测）
   *   days   —— 已经饿了几天（没饿是 0）
   *   dying  —— 再饿 STARVE_DAYS 天就会消失（用户定的：饿满 3 天真没了）
   */
  function starveState(pet, now) {
    const t = Number(now || Date.now());
    const since = hungrySinceOf(pet, t);
    if (!since) return { hungry: false, since: null, days: 0, dying: false, leftMs: Infinity };
    const ms = Math.max(0, t - since);
    const days = ms / 86400000;
    const leftMs = Math.max(0, STARVE_DAYS * 86400000 - ms);
    return {
      hungry: true,
      since: since,
      days: round2(days),
      dying: leftMs <= 86400000,          // 只剩一天以内 → 要催一下
      leftMs: leftMs
    };
  }

  /** 还剩几天会消失（没饿就返回 null） */
  function starveDaysLeft(pet, now) {
    const s = starveState(pet, now);
    if (!s.hungry) return null;
    return round2(Math.max(0, STARVE_DAYS - s.days));
  }

  /**
   * 下一阶段目标：成长值 + 相处天数
   *
   * ⚠️【2026-10-25 用户定】「孵蛋 2 天，后面的成长阶段逐步拉长，不需要很快长大」
   *   → 天数从 2/7/14/21 拉长到 2/10/25/50（升到第 1/2/3/4 阶段各要相处几天）
   *   →【2026-10-25 用户定】成长值门槛同步抬高（蛋类 26/130/324/648，猫狗 130/324/648）
   *     理由：天数只管"不能速成"，成长值才是"必须真的照顾"那把锁
   *     （前提是陪玩/摸摸 4 小时才回 1 点 —— 见 interactionDelta，单位修好之后才成立）
   *     —— 认真照顾 ≈ 21.6 点/天：蛋类阶段 1/2/3/4 约 1.2 / 6.0 / 15.0 / 30.0 天到
   *     —— 躺平 ≈ 8 点/天：蛋类阶段 1/2/3/4 约 3.3 / 16.3 / 40.5 / 81 天到（阶段 2 起被成长值卡住）
   *   → 猫狗没有蛋期，从领养算起就是第 1 阶段 → 门槛对齐蛋类的第 2/3/4 档
   */
  const STAGE_RULES_HATCH = { 1: [26, 2], 2: [130, 10], 3: [324, 25], 4: [648, 50] };
  const STAGE_RULES_PLAIN = { 1: [130, 10], 2: [324, 25], 3: [648, 50] };

  function growthTarget(pet, currentStage, now) {
    const target = Number(pet.stage || 0) + 1;
    const rules = isHatchKind(pet.kind) ? STAGE_RULES_HATCH : STAGE_RULES_PLAIN;
    // 表里没有的更高阶段（理论上到不了）→ 按最后一档的成长值继续往上叠，别留旧尺度魔法数
    const lastKey = Math.max.apply(null, Object.keys(rules).map(Number));
    const step = rules[lastKey][0];
    const fallbackGrowth = currentStage && currentStage.growthAtActivation
      ? currentStage.growthAtActivation + step
      : step;
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

  /** 首次孵化条件：成长达到第 1 阶段门槛且年龄达标（已经孵出来的就不再是"蛋"了） */
  function canHatch(pet, now) {
    if (!isHatchKind(pet.kind)) return false;
    if (Number(pet.stage || 0) > 0) return false;
    const age = Math.max(0, dayDiff(pet.createdAt, now));
    return Number(pet.growth || 0) >= STAGE_RULES_HATCH[1][0]
      && age >= STAGE_RULES_HATCH[1][1];
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

    // 灵宠蛋：物种 + 配色 = 领养时按 seed 盲盒定死（同一只永远同一只）
    const beast = beastSpeciesForSeed(pet.seed || pet.id);
    const marking = dimension === 'random' ? '柔和星屑纹' : DIMENSIONS[dimension].marking;

    return {
      stage: 1,
      kind: 'fantasy',
      identity: beast.species,
      palette: beast.palette,
      beastSpecies: beast.species,
      beastSpeciesEn: beast.speciesEn,
      beastPaletteEn: beast.paletteEn,
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
    const hunger = starveState(pet, now);
    return {
      id: pet.id,
      name: pet.name,
      kind: pet.kind,
      status: pet.status || 'ready',
      satiety: currentSatiety(pet, now),
      // 饿了多少天 / 还剩几天会消失（用户定的：饿满 3 天真没了）
      hungryDays: hunger.days,
      starveDaysLeft: hunger.hungry ? round2(Math.max(0, STARVE_DAYS - hunger.days)) : null,
      starving: hunger.dying,
      growth: round2(pet.growth || 0),
      stage: Number(pet.stage || 0),
      traits: pet.traits || temperament(pet.seed),
      appearance: pet.appearance || null,
      assetRef: pet.assetRef || null,
      needsRedraw: !!pet.needsRedraw,
      // 说话开关（每只宠物独立）：默认都开
      canSpeak: pet.canSpeak !== false,
      canChatInsert: pet.canChatInsert !== false,
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
   * 陪玩 / 摸了摸能回多少成长值（纯计算，好测）
   *
   * ⚠️【2026-10-25 修】上游 store.py 的 now 是**秒**（time.time()），330 这边是**毫秒**
   *   → recovery 必须按毫秒算：原来 3600*(5-trait/50) 被当成毫秒，性格 50 时
   *      14.4 秒就回满 1 点成长值（上游是 4 小时）→ 成长门槛形同虚设
   *   → 现在：性格 50 → 4 小时回满 1 点（性格越高回得越快，最多 3.2 小时）
   */
  function interactionDelta(action, pet, now) {
    const traitKey = action === 'comfort' ? 'attachment' : 'energy';
    const trait = Number((pet && pet.traits && pet.traits[traitKey]) || 50);
    const recovery = 3600 * 1000 * (5 - trait / 50); // 毫秒
    const last = pet ? pet['last' + (action === 'comfort' ? 'Comfort' : 'Play')] : null;
    if (last == null) return 1;                     // 第一次陪玩/摸摸直接给满 1 点
    return Math.min(1, Math.max(0, (now - last) / recovery));
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
      } else if (action === 'feed' && grains < feedGrainCost(row)) {
        // ⚠️ 粮食「有几颗但不够这一顿」也算没粮（以前固定吃 1 颗，只判 grains === 0 就够）
        status = 'no_food';
      } else {
        status = { feed: 'fed', play: 'played', comfort: 'comforted' }[action] || 'played';
        if (action === 'feed') {
          // ⚠️【2026-10-25 用户定】「一开始喂一次一颗，升级后一次两颗什么的」
          //   → 吃几颗 = 阶段数（0 阶段=1 颗，1 阶段=2 颗…），长大一点食量就大一倍
          //   → 每颗给 FEED_SATIETY_PER_GRAIN 点饱腹（一颗 = 半饱）
          const need = feedGrainCost(row);
          if (grains < need) {
            status = 'no_food';
          } else {
            satiety = Math.min(SATIETY_MAX, satiety + need * FEED_SATIETY_PER_GRAIN);
            grains -= need;
            delta = FEED_GROWTH;
          }
        } else {
          delta = interactionDelta(action, row, now);
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
          // AI 是谁：把当时的角色名记下来，事件流里显示「小雨喂了小花」而不是「TA喂了小花」
          actorName: (opts.actorName || '').trim(),
          action,
          createdAt: now,
          growthDelta: round2(delta)
        });
        row.growth = update.growth;
        row.satiety = update.satiety;
        // 今天的行为信号 → 今天它长什么样（喂食→围兜 / 陪玩→皮球 / 摸摸→绒毛）
        try {
          const sigKey = action === 'feed' ? 'feeding' : action === 'comfort' ? 'comforting' : 'playing';
          await reportSignal(sigKey, 1);
        } catch (e) { /* 忽略 */ }
        // 真的照顾成功了 → 让它自己说一句（用户 2026-10-25：要「每次摸摸了、陪玩了、喂了…自己说一句」）
        if (status === 'fed' || status === 'played' || status === 'comforted') {
          try {
            if (window.PetSpeech && typeof window.PetSpeech.petSpeak === 'function') {
              window.PetSpeech.petSpeak(row, action === 'feed' ? 'feed' : action === 'play' ? 'play' : 'comfort', {});
            }
          } catch (e) { /* 忽略 —— 说话失败不能影响照顾 */ }
        }
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

  // ============================================================
  // 4·六、放弃一只宠物 / 饿死消失（2026-10-25 用户定的）
  //   · 「这个宠物不想养了可以删除吗」→ 齿轮面板里「放弃」
  //   · 「一直没人喂会饿死吗」→ 饿满 STARVE_DAYS 天就真没了（永久，不可恢复）
  // ============================================================

  /**
   * 彻底删掉一只宠物：本体 + 阶段记录 + 照顾事件 + 生图资产（连 objectURL 一起回收）
   * @param reason 'remove'（用户主动放弃）| 'starve'（饿死）
   */
  async function removePet(petId, reason) {
    const d = await openDb();
    const row = await d.pets.get(petId);
    if (!row) return { ok: false, reason: 'pet_not_found' };
    const name = row.name || '宝宝';
    const why = reason === 'starve' ? 'starve' : 'remove';

    // 生图资产：数据库里的行我们自己删（各管各的），
    // 内存里的 objectURL 让 pet-image 那边回收（它才有那个缓存）
    try { await d.assets.where('petId').equals(petId).delete(); } catch (e) { /* 忽略 */ }
    try {
      if (window.PetImage && typeof window.PetImage.releaseAssetUrls === 'function') {
        await window.PetImage.releaseAssetUrls(petId);
      } else if (window.PetImage && typeof window.PetImage.deleteAssetsByPet === 'function') {
        await window.PetImage.deleteAssetsByPet(petId);
      }
    } catch (e) { console.warn('[宠物屋] 回收生图资源失败', e); }

    await d.pets.delete(petId);
    try { await d.stages.where('petId').equals(petId).delete(); } catch (e) { /* 忽略 */ }
    try { await d.events.where('petId').equals(petId).delete(); } catch (e) { /* 忽略 */ }

    // 留一条系统事件，让用户知道这只怎么了（不能悄悄消失）
    const note = why === 'starve'
      ? name + ' 太久没吃东西，离开了……'
      : name + ' 被送走了';
    try {
      await d.events.add({
        petId: '', actor: 'system', action: why,
        createdAt: Date.now(), note: note, petName: name
      });
    } catch (e) { /* 忽略 */ }

    return { ok: true, name: name, reason: why };
  }

  /**
   * 扫一遍有没有饿够 STARVE_DAYS 天的宠物 → 直接删掉
   * 每次刷新界面都会跑一次，所以「忘了喂 → 几天后回来发现它没了」是自动发生的。
   */
  async function sweepStarvedPets(now) {
    const t = Number(now || Date.now());
    try {
      const d = await openDb();
      const rows = await d.pets.toArray();
      const gone = [];
      for (const row of rows) {
        const s = starveState(row, t);
        if (!s.hungry) continue;
        if (s.leftMs > 0) continue;            // 还没到 3 天
        const r = await removePet(row.id, 'starve');
        if (r && r.ok) gone.push(r.name);
      }
      if (gone.length) {
        showToastSafe(gone.join('、') + ' 太久没吃东西，离开了……', 'warning');
      }
      return gone;
    } catch (e) {
      console.warn('[宠物屋] 检查饿死失败', e);
      return [];
    }
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
      text = name + ' 羽化成了「' + app.identity + '」，去给它画一张新样子吧';
    } else if (app.kind === 'parrot' || app.kind === 'fantasy') {
      action = 'hatch';
      let who = app.identity;
      if (app.kind === 'fantasy') {
        // 灵宠蛋：说出它今天具体长什么样（物种 + 当天特征 + 当天穿搭）
        try {
          const db = await openDb();
          const prow = await db.pets.get(row.id);
          const behaviors = await todayBehaviors();
          const look = dailyLookFor(behaviors, dayKey(Date.now()), (prow && prow.seed) || (prow && prow.id));
          who = beastDisplayName(app, look);
        } catch (e) { /* 用 identity 兜底 */ }
      }
      text = name + ' 破壳了！是一只「' + who + '」';
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
    // 破壳/升级/羽化 → 让它自己说一句（用户 2026-10-25：要「升级了…自己说一句」）
    try {
      if (window.PetSpeech && typeof window.PetSpeech.petSpeak === 'function') {
        const ev = action === 'divine' ? 'divine' : action === 'hatch' ? 'hatch' : 'stage';
        const prow = await d.pets.get(row.id);
        window.PetSpeech.petSpeak(prow || row, ev, {});
      }
    } catch (e) { /* 忽略 —— 说话失败不能影响升级 */ }
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

  /** 列出所有宠物（宠物说话系统要遍历它们） */
  async function listPets() {
    try {
      const d = await openDb();
      const rows = await d.pets.toArray();
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('[宠物屋] 读宠物列表失败', e);
      return [];
    }
  }

  /** 这一步该走哪条路：破壳 / 羽化 / 普通成长（纯函数, 好测） */
  function stageBriefKind(pet, target) {
    if (isHatchKind(pet.kind) && Number(pet.stage || 0) === 0) return 'hatch';
    const to = Number((target && target.stage) || 0);
    // ⚠️【2026-10-25 用户定】「羽化不会是每个神兽最后的设定吧？不能最后都长翅膀吧？」
    //   → 灵宠蛋孵出来的幻兽【也要】有终形态，只是按族群分（龙神/灵瑞/灵幻），不是都长翅膀
    if (to >= DIVINE_STAGE) return 'divine';
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
          dimension: hatch.dimension || '',
          // 灵宠蛋的新字段：物种 + 配色（盲盒定死）；老数据没这三个字段 → 走老路径
          beastSpecies: hatch.beastSpecies || '',
          beastSpeciesEn: hatch.beastSpeciesEn || '',
          beastPaletteEn: hatch.beastPaletteEn || ''
        }
      };
    }
    // 长到最后一关 → 羽化成终形态（按族群：龙神 / 灵瑞 / 灵幻 / 神鸟）
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

  /**
   * 羽化成终形态（最后一关）：形态整个换掉
   * ⚠️【2026-10-25 用户定】「羽化不会是每个神兽最后的设定吧？不能最后都长翅膀吧？」
   *   → 终形态按【族群】挑：dragon=龙神 / auspice=灵瑞 / spirit=灵幻 / 鹦鹉=神鸟
   *   → 血脉（breedKey / dimension）不变，还是原来那只
   */
  function divineBriefFor(pet, current) {
    const seedHash = hash32((pet.seed || pet.id) + ':divine');
    const lineage = beastLineage(pet, (current && current.appearance) || (pet && pet.appearance));
    const forms = divineFormsFor(lineage);
    const beast = forms[seedHash % forms.length];
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
      lineage: lineage,
      // 物种名要留着 —— 羽化后它还是「那只囚牛」，只是长成了龙君
      beastSpecies: prev.beastSpecies || prev.identity || '',
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

  /**
   * 关系维度累计分（纯计算，不写库）
   * ⚠️ pickDimension 和「宠物说话」都要用 → 抽出来共用
   */
  async function dimensionScores(pet, current, now) {
    const at = Number(now || Date.now());
    const scores = {};
    for (const key of Object.keys(DIMENSIONS)) scores[key] = 0;
    const signals = await getMeta('relationshipSignals', []);
    const daily = {};
    for (const item of signals) {
      const from = current ? current.activatedAt : (pet && pet.createdAt);
      if (item.at < from || item.at > at) continue;
      const bucket = dayKey(item.at) + '::' + item.key;
      daily[bucket] = Math.min(3, (daily[bucket] || 0) + Number(item.weight || 0));
    }
    for (const bucket of Object.keys(daily)) {
      const key = bucket.split('::')[1];
      if (key in scores) scores[key] += daily[bucket];
    }
    return scores;
  }

  async function pickDimension(pet, current, now) {
    const scores = await dimensionScores(pet, current, now);
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

    // 今天聊过的话 → 当天的代表词（用来现挑一个能物化的小装饰）
    try {
      const text = String(p.userText || '').trim();
      if (text) {
        const db = await openDb();
        await db.dailyNotes.add({ day, at: now, text: text.slice(0, 300) });
        todayRepresentativeTexts().catch(() => { /* 忽略 */ });
      }
    } catch (e) { /* 忽略 */ }

    // 今天的行为信号：聊过天 → 触发换造型；
    // 聊到歌 / 书 / 剧 / 吃的 / 游戏 → 各自对应的特征（「听了歌长出音符」）
    try {
      await reportSignal('chatting', 1);
      const text = String(p.userText || '') + ' ' + String(p.aiText || '');
      if (text) {
        for (const rule of CHAT_KEYWORD_FEATURES) {
          for (const k of rule.keys) {
            if (text.indexOf(k) >= 0) { await reportSignal(rule.feature, 1); break; }
          }
        }
      }
    } catch (e) { /* 忽略 */ }

    return { credited, tokenGrains, baseline };
  }

  /**
   * 行为信号上报 —— 「今天你做了什么」
   *
   * 【两种用途，一个入口】
   * ① key 在 DIMENSIONS 里（affection / reading / watching / listening / exploration）
   *    → 记关系维度分（性格、花纹用）
   * ② key 在 TRIGGER_SIGNALS 里（chatting / feeding / comforting / listening /
   *    watching / reading / playing）
   *    → 记 dailySignals（今天有没有动静 → 要不要给它换造型）
   * 两边都中的（reading/watching/listening）→ 两个都记。
   *
   * ⚠️ 记信号 ≠ 长形态特征：形态特征只有 BEHAVIOR_FEATURES 里那几条才会长，
   *    听歌/看剧/陪玩/摸摸已经不配特征了（用户 2026-10-25 定的）。
   *
   * ⚠️ 以前这个函数全项目【零调用】，维度分一直是 0 —— 用户养了一天没感觉就是这个原因。
   */
  async function reportSignal(key, weight, extra) {
    const now = Date.now();
    const day = dayKey(now);
    if (key in DIMENSIONS) {
      const w = Math.max(0, Math.min(3, Number(weight) || 1));
      const list = await getMeta('relationshipSignals', []);
      list.push({ key, weight: w, at: now });
      // 只保留最近 400 条
      while (list.length > 400) list.shift();
      await setMeta('relationshipSignals', list);
    }
    // ⚠️ TRIGGER_SIGNALS 是【数组】, `key in 数组` 查的是下标不是值 → 永远 false,
    //    害得 dailySignals 一天都没被写过, 每天自动换造型压根没触发过。
    if (TRIGGER_SIGNALS.indexOf(key) >= 0) {
      try {
        const d = await openDb();
        await d.dailySignals.add({ day, type: key, weight: Number(weight) || 1, at: now, title: (extra && extra.title) || '' });
      } catch (e) { /* 忽略 */ }
      // 同步给提示词用（生图提示词是同步拼的）
      const cache = cachedBehaviors();
      const hit = cache.find(x => x.type === key);
      if (hit) hit.count = (hit.count || 1) + 1;
      else cache.push({ type: key, count: 1 });
      // 今天有动静了 → 一会儿给它换一次造型
      scheduleAutoLook();
    }
    return { ok: true };
  }

  /**
   * 当天行为缓存 —— 生图提示词是【同步】拼的（主聊天组装也是同步路径，不能 await），
   * 所以这里留一份内存缓存，由 reportSignal / todayBehaviors 更新。
   * 格式：[{ type, count }]
   */
  let todayBehaviorCache = { day: '', list: [] };

  function cachedBehaviors() {
    const day = dayKey(Date.now());
    if (todayBehaviorCache.day !== day) todayBehaviorCache = { day, list: [] };
    return todayBehaviorCache.list;
  }

  /** 今天发生过哪些行为（去重 + 计数，按第一次出现的顺序） */
  async function todayBehaviors(day) {
    const d = day || dayKey(Date.now());
    try {
      const db = await openDb();
      const rows = await db.dailySignals.where('day').equals(d).toArray();
      const out = [];
      const idx = {};
      for (const r of rows) {
        if (!r || !r.type) continue;
        if (idx[r.type] == null) { idx[r.type] = out.length; out.push({ type: r.type, count: 1 }); }
        else out[idx[r.type]].count++;
      }
      todayBehaviorCache = { day: d, list: out };
      return out;
    } catch (e) {
      if (todayBehaviorCache.day !== d) todayBehaviorCache = { day: d, list: [] };
      return todayBehaviorCache.list;
    }
  }

  /** 今天这只要长什么样（物种 + 配色 + 当天特征 + 当天穿搭） */
  async function currentLook(pet, day) {
    const d = day || dayKey(Date.now());
    const behaviors = await todayBehaviors(d);
    const row = await openDb().then(db => db.pets.get(pet.id));
    const app = (row && row.appearance) || pet.appearance || null;
    const look = dailyLookFor(behaviors, d, (row && row.seed) || pet.seed || pet.id);
    return { behaviors, look, appearance: app };
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
    // 灵宠蛋：说出它今天具体长什么样（AI 才好描述给用户听）
    if (pet.kind === 'egg' && a.kind === 'fantasy') {
      const lk = dailyLookFor(cachedBehaviors(), dayKey(Date.now()), pet.seed || pet.id, cachedDayTexts());
      const parts = [beastDisplayName(a, lk)];
      if (a.marking) parts.push(a.marking);
      return parts.join('，');
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
        ? '还是一颗蛋（孵化需要成长 ' + STAGE_RULES_HATCH[1][0] + ' + 相处 ' + STAGE_RULES_HATCH[1][1] + ' 天）'
        : (pet.stage >= DIVINE_STAGE && pet.appearance && pet.appearance.kind === 'divine'
          ? '已羽化成「' + pet.appearance.identity + '」'
          : '第 ' + pet.stage + ' 阶段');
      const hunger = pet.starving ? ' · 已经饿了 ' + Math.floor(pet.hungryDays) + ' 天，再不喂就要撑不住了'
        : pet.satiety <= 30 ? ' · 饿了'
          : pet.satiety > FULL_THRESHOLD ? ' · 吃得饱饱的' : '';
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
    lines.push('- 粮仓剩余 ' + grains + ' 粒（喂一顿的消耗随它长大而变：越小越省，越大越费）');

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

  /**
   * AI 照顾宠物时，TA 是谁？
   * 【用户原话 2026-10-25】「喂食的记录，AI 的一律称 Ta 喂了……最好是读 AI 角色名」
   * 单聊 → 聊天列表里显示的那个名字；群聊 → 群里那个成员的昵称。
   */
  function assistantNameFor(msgData, chat) {
    try {
      const md = msgData || {};
      if (chat && chat.isGroup && Array.isArray(chat.members)) {
        const m = chat.members.find(x => x && (x.originalName === md.name || x.groupNickname === md.name));
        if (m) return String(m.groupNickname || m.originalName || '');
        if (md.name) return String(md.name);
        return '';
      }
      if (chat) return String(chat.name || chat.originalName || '');
      return String(md.name || '');
    } catch (e) { return ''; }
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
      result = await care(action, {
        petIds: [target.id],
        actor: 'assistant',
        actorName: assistantNameFor(msgData, chat)
      });
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
      + (receipt.status === 'no_food' ? '。粮食不够喂这一顿，用户得去聊天攒粮了。' : '。');

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
      // 快撑不住的（饿到只剩不到一天）→ 直接标出来，别让人以为它没事
      if (pet.starving) {
        const warn = document.createElement('span');
        warn.className = 'pn-pet-sub pn-pet-sub-starving';
        warn.textContent = '🆘 已经饿了 ' + Math.floor(pet.hungryDays) + ' 天';
        label.append(warn);
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

  /** 事件时间：今天只显示 时:分，更早的加 月-日 */
  function eventTimeLabel(ts) {
    const t = Number(ts || 0);
    if (!t) return '';
    try {
      const d = new Date(t);
      const now = new Date();
      const p2 = (n) => (n < 10 ? '0' + n : String(n));
      const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
      const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      return sameDay ? hm : (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm;
    } catch (e) { return ''; }
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
      // 时间戳：不然不知道是什么时候喂的（用户 2026-10-25 提的）
      const when = eventTimeLabel(ev.createdAt);
      if (when) {
        const ts = document.createElement('span');
        ts.className = 'pn-event-time';
        ts.textContent = when;
        li.append(ts);
      }
      if (ev.note) {
        // 系统自己记的那几条（破壳 / 羽化 / 升阶）
        li.className = 'pn-event-system';
        li.append(document.createTextNode(ev.note));
      } else {
        // AI 那条显示角色名（以前一律写死 'TA' → 「TA喂了小花」）
        const who = ev.actor === 'user' ? '我' : (ev.actorName || 'TA');
        const what = { feed: '喂了', play: '陪玩了', comfort: '摸摸了' }[ev.action] || '照顾了';
        li.append(document.createTextNode(who + what + ev.petName));
      }
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
    // 快撑不住的（饿到只剩不到一天）—— 优先级最高，这是命
    const starving = ready.filter(p => p.starving);
    let target = null;
    let msg = '';
    let ic = '🐣';
    let btn = '去看看';
    if (starving.length) {
      target = starving[0];
      msg = starving.length > 1
        ? starving[0].name + ' 等 ' + starving.length + ' 只已经饿了很久，再不喂就撑不住了'
        : target.name + ' 已经饿了 ' + Math.floor(target.hungryDays) + ' 天，再不喂就撑不住了';
      ic = '🆘';
      btn = '去喂它';
    } else if (look.length) {
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
    // 先看看有没有饿够 3 天的 → 直接删掉（用户定的：饿满 3 天真没了）
    try { await sweepStarvedPets(); } catch (e) { /* 忽略 */ }
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
          ? '这是一颗鹦鹉蛋。照顾与共同相处会影响它孵出来是什么品种、什么羽色；成长达到 ' + STAGE_RULES_HATCH[1][0] + '、相处满 ' + STAGE_RULES_HATCH[1][1] + ' 天后，它就会破壳。'
          : '照顾与共同相处会影响它未来的模样。成长达到 ' + STAGE_RULES_HATCH[1][0] + '、相处满 ' + STAGE_RULES_HATCH[1][1] + ' 天后，它就会开始孵化。';
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
    // 每只宠物独立开关：允许说话 / 允许插话到聊天框
    //   【用户 2026-10-26】「喜欢闹的宠物开着，不喜欢闹的别开」
    const swSpeak = el('pn-switch-speak');
    const swInsert = el('pn-switch-insert');
    const swBox = el('pn-speech-toggles');
    // ⚠️【2026-10-26 修】原来只判 stage<=0 → **刚领养的猫狗（stage 0）也被当成蛋禁言**，
    //   等于新养的猫 10 天里一句话都不说，跟用户定的「重新打开 App → 立刻说一句」冲突。
    //   现在只把「真的还是颗蛋」（蛋类 + 第 0 阶段）禁言，猫狗第 0 阶段是活蹦乱跳的幼崽，照样能说话。
    const isEgg = isHatchKind(pet.kind) && Number(pet.stage || 0) <= 0;
    if (swBox) {
      swBox.hidden = false;
      if (swSpeak) {
        swSpeak.checked = pet.canSpeak !== false;
        swSpeak.disabled = isEgg;      // 还是颗蛋，说不了话
        swSpeak.onchange = () => setSpeechFlag(pet.id, 'canSpeak', swSpeak.checked);
      }
      if (swInsert) {
        swInsert.checked = pet.canChatInsert !== false;
        swInsert.disabled = isEgg;
        swInsert.onchange = () => setSpeechFlag(pet.id, 'canChatInsert', swInsert.checked);
      }
      // 【用户 2026-10-26】「点那个允许说话和允许插话到聊天窗口怎么没动静呢？也没见宠物说话」
      //   → 是因为它还是颗蛋，开关是故意禁用的（灰的）。
      //   光灰着不说原因 → 用户以为功能坏了 → 这里写一句为什么 + 怎么才能孵化。
      const swHint = el('pn-speech-hint');
      if (swHint) {
        const need = STAGE_RULES_HATCH[1][0];
        const left = Math.max(0, need - Math.round(Number(pet.growth || 0)));
        if (isEgg) {
          swHint.textContent = '还颗蛋，说不了话 —— 孵化之后这两个开关就能用了。'
            + '（成长还差 ' + left + '，喂食 / 陪玩 / 摸摸都能攒成长值）';
          swHint.hidden = false;
        } else {
          swHint.textContent = '';
          swHint.hidden = true;
        }
      }
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

  /**
   * 存宠物的说话开关（canSpeak / canChatInsert）
   * 开关存在 pets 表的宠物行上 —— 每只独立。
   */
  async function setSpeechFlag(petId, field, value) {
    if (!petId || (field !== 'canSpeak' && field !== 'canChatInsert')) return;
    try {
      const d = await openDb();
      const row = await d.pets.get(petId);
      if (!row) return;
      await d.pets.update(petId, { [field]: !!value });
      // 内存里那份也更新，不然关掉再打开弹窗还是旧值
      if (uiState && Array.isArray(uiState.pets)) {
        const p = uiState.pets.find(x => x.id === petId);
        if (p) p[field] = !!value;
      }
    } catch (e) {
      console.warn('[宠物屋] 保存说话开关失败', e);
      showToastSafe('保存失败：' + (e.message || e), 'error');
    }
  }

  // ============================================================
  // 小屋管理（齿轮按钮）：规则说明 + 放弃一只宠物
  //   【用户原话 2026-10-25】「如果这个宠物不想养了可以删除吗」
  // ============================================================

  function openManageDialog() {
    const dlg = el('pn-manage-dialog');
    if (!dlg) return;
    renderManageList();
    if (!dlg.open) dlg.showModal();
  }

  function renderManageList() {
    const rules = el('pn-manage-rules');
    if (rules) {
      rules.textContent = '喂一顿就饱（' + SATIETY_MAX + '），但饱腹每小时掉 '
        + SATIETY_DECAY_PER_HOUR + ' 点 —— 满值大概撑半天，所以一天得喂两次。'
        + '连续 ' + STARVE_DAYS + ' 天没吃上饭的宝宝会离开（不可恢复）。';
    }
    const host = el('pn-manage-list');
    if (!host) return;
    host.replaceChildren();
    const pets = (uiState ? uiState.pets : []);
    if (!pets.length) {
      const p = document.createElement('p');
      p.className = 'pn-quiet';
      p.textContent = '小窝里还没有宝宝。';
      host.append(p);
      return;
    }
    for (const pet of pets) {
      const row = document.createElement('div');
      row.className = 'pn-manage-row';

      const info = document.createElement('div');
      info.className = 'pn-manage-info';
      const nm = document.createElement('div');
      nm.className = 'pn-manage-name';
      nm.textContent = pet.name + '（' + (KINDS[pet.kind] ? KINDS[pet.kind].label : pet.kind) + '）';
      const note = document.createElement('div');
      note.className = 'pn-manage-note';
      note.textContent = (pet.starveDaysLeft != null)
        ? '已经饿了 ' + Math.floor(pet.hungryDays) + ' 天，再 ' + Math.ceil(pet.starveDaysLeft) + ' 天就会离开'
        : '饱腹 ' + Math.round(pet.satiety) + '/' + SATIETY_MAX;
      info.append(nm, note);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pn-btn pn-manage-danger';
      btn.textContent = '放弃';
      btn.onclick = () => doRemovePet(pet);

      row.append(info, btn);
      host.append(row);
    }
  }

  /**
   * 问一句确认（宠物屋版）
   *
   * ⚠️【2026-10-26 用户实测】「点删除宠物 / 换样貌画图，那个确定提示弹窗被压在下面看不见，
   *   要关掉上层页面才能看见」
   *   → 真凶：我们的界面用的是原生 <dialog>，showModal() 会把它送进 **top layer**，
   *     而 330 的确认框是 #custom-modal-overlay（普通 z-index 999999）——
   *     **top layer 永远盖在 z-index 之上**，所以确认框被我们的 dialog 压在下面。
   *   → 修法：问确认之前先把我们的 dialog 关掉，问完再开回去。
   *
   * 顺便：给确认框套一层宠物屋的暖色皮肤（pn-modal-skin），
   *   免得跟全应用那个灰白弹窗一个样（用户 2026-10-26 提）。
   */
  const PN_DIALOG_IDS = ['pn-care-dialog', 'pn-manage-dialog', 'pn-adopt-dialog', 'pn-album-dialog'];

  async function petConfirm(title, message, options) {
    // ① 把开着的自家 dialog 收起来（不然确认框看不见）
    const opened = [];
    for (const id of PN_DIALOG_IDS) {
      const d = document.getElementById(id);
      if (d && d.open) opened.push(d);
    }
    for (const d of opened) {
      try { d.close(); } catch (e) { /* 忽略 */ }
    }

    // ② 套皮肤 → 问 → 脱皮肤 → 把 dialog 开回去
    const overlay = document.getElementById('custom-modal-overlay');
    if (overlay) overlay.classList.add('pn-modal-skin');
    let ok = false;
    try {
      if (typeof window.showCustomConfirm === 'function') {
        ok = await window.showCustomConfirm(title, message, options);
      }
    } catch (e) {
      ok = false;
    } finally {
      if (overlay) overlay.classList.remove('pn-modal-skin');
      for (const d of opened) {
        if (!d.open && typeof d.showModal === 'function') {
          try { d.showModal(); } catch (e) { /* 忽略 */ }
        }
      }
    }
    return ok;
  }

  async function doRemovePet(pet) {
    if (!pet || !pet.id) return;
    const name = pet.name || '这只宝宝';
    let ok = false;
    if (typeof window.showCustomConfirm === 'function') {
      ok = await petConfirm(
        '放弃 ' + name,
        '「' + name + '」会从小窝里消失：它的记录、相册、生图都会一起删掉。<br><br><b>不可恢复。</b>确定吗？',
        { confirmButtonClass: 'btn-danger', confirmText: '放弃它' }
      );
    } else {
      ok = window.confirm('放弃「' + name + '」？它的记录会一起删掉，不可恢复。');
    }
    if (!ok) return;
    try {
      const r = await removePet(pet.id, 'remove');
      if (r && r.ok) {
        showToastSafe(name + ' 已经送走了', 'success');
        await refreshAll();
        renderManageList();
      }
    } catch (e) {
      showToastSafe('放弃失败：' + (e.message || e), 'error');
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
    // 进小窝时补画：白天玩过但当时没画（页面关了 / 定时器没跑完）→ 现在换一次
    try {
      openDb().then(async (d) => {
        const first = await d.pets.orderBy('createdAt').first();
        if (first) await maybeDailyRedraw(first, { silent: true });
      }).catch(() => { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
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
    if (wasHidden) {
      petBlockedCache = false; petBlockedCheckedAt = 0;  // 刚放出来，重新判定
      // ⚠️ 关键修复：刚从隐藏变成显示时【必须把 sprite 画出来】。
      //   以前只有 renderDesktopPet() 会画 sprite，而它在「当前不在聊天页」时
      //   会提前 return → 第一次进聊天页时 sprite 还是空的 → 桌宠看不见
      //   （用户实测 2026-10-25：每次新进聊天页都不显示，
      //     要去悬浮球菜单关掉再开才出现 —— 因为那条路会走 refreshAll → renderDesktopPet）
      renderDesktopPetContent(currentDesktopPet());
    }
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

  // 最近一次拿到的 state —— 让「桌宠刚显示出来」的时候能补画 sprite
  let desktopPetState = null;

  function currentDesktopPet() {
    const st = desktopPetState;
    return st && st.pets && st.pets.length ? st.pets[0] : null;
  }

  /** 只画内容（sprite / 名字 / 气泡），不管可见性 */
  function renderDesktopPetContent(pet) {
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
        const hunger = pet.starving ? '快撑不住了'
          : pet.satiety <= 30 ? '饿了'
            : pet.satiety > FULL_THRESHOLD ? '饱饱的' : '在等你';
        name.textContent = pet.name + ' · ' + hunger;
      }
    }
    const bubble = el('pn-desktop-pet-bubble');
    // 宠物正在说话时，气泡归它用 —— 别用饥饿提示把它盖掉（两个功能共用一个气泡）
    const speaking = !!(window.PetSpeech && typeof window.PetSpeech.isBubbleActive === 'function'
      && window.PetSpeech.isBubbleActive());
    if (bubble && pet && !speaking) {
      bubble.hidden = !(pet.satiety <= 30 || pet.starving);
      if (!bubble.hidden) bubble.textContent = pet.starving ? '它快撑不住了…快喂它！' : '它好像饿了…';
    }
  }

  function renderDesktopPet(state) {
    const wrap = el('pn-desktop-pet');
    if (!wrap) return;
    desktopPetState = state || null;
    const pet = currentDesktopPet();
    // 有弹窗/遮罩的时候桌宠必须让位 —— 否则遮罩会把整块盖住，
    // 桌宠和它的菜单都点不动（用户实测：点「隐藏桌宠」「进入小屋」都没反应）
    syncDesktopPetVisibility();
    if (wrap.hidden) return;
    renderDesktopPetContent(pet);
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
    // 齿轮 → 小屋管理（规则说明 + 放弃一只宠物）
    const manageBtn = el('pn-manage-btn');
    if (manageBtn) {
      manageBtn.onclick = () => openManageDialog();
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
      // ⚠️ 用 petConfirm：不然确认框会被照顾弹窗（原生 dialog → top layer）压在下面看不见
      return await petConfirm(
        '生成新模样',
        '这会调用一次生图接口（可能产生费用）。<br><br>要给它画一张新的样子吗？',
        { confirmButtonClass: 'btn-primary', confirmText: '画吧' }
      );
    }
    return window.confirm('这会调用一次生图接口（可能产生费用），要画吗？');
  }

  function subjectForPet(pet, lookOverride) {
    const look = formatPetAppearance(pet);
    const app = pet.appearance || null;

    // ⚠️【2026-10-25 用户定】「宠物的形象必须是Q版化的可爱形象哦，不能是真猛兽」
    //   → 所有分支都要带 ART_STYLE_LOCK（以前只有幻兽那支有，鹦鹉/羽化都没有，
    //     羽化那支还写着 "majestic layered tail feathers" —— 很容易画出真凤凰）
    //   → 羽化额外加 DIVINE_STYLE_LOCK（「羽化以后要绚丽」）

    // 已经羽化成终形态
    if (app && app.kind === 'divine') {
      const lineage = app.lineage || beastLineage(pet, app);
      const forms = divineFormsFor(lineage);
      const beast = forms.find(b => b.key === app.beastKey) || forms[0];
      return 'a mythical ' + beast.en + ', ' + beast.colorEn
        + ', ornate glowing accents, a soft warm halo of light around it'
        + ', ' + ART_STYLE_LOCK + ', ' + DIVINE_STYLE_LOCK;
    }

    // 还没孵出来（灵宠蛋 / 鹦鹉蛋）：画成蛋
    if (isHatchKind(pet.kind) && Number(pet.stage || 0) === 0) {
      return (pet.kind === 'parrot'
        ? 'a speckled magical parrot egg resting on a nest of soft grass and small flowers'
        : 'speckled magical egg resting on a nest of soft grass and small flowers')
        + ', ' + ART_STYLE_LOCK;
    }

    // 鹦鹉：品种配色全用英文说法（colorEn 是给生图模型看的）
    if (pet.kind === 'parrot') {
      const breed = PARROT_BREEDS.find(b => b.key === (app && app.breedKey)) || PARROT_BREEDS[0];
      const mark = app && app.markEn ? ', ' + app.markEn : '';
      return 'a fluffy ' + breed.en + ' with ' + breed.colorEn + mark + ', ' + ART_STYLE_LOCK;
    }

    // 灵宠蛋：孵出来了 → 要画成那只幻兽。
    // （这里原来一直返回 "speckled magical egg"，孵出来的幻兽又被画回蛋，是个 bug）
    if (pet.kind === 'egg') {
      const mark = app && app.markEn ? app.markEn : '';
      const lk = lookOverride || dailyLookFor(cachedBehaviors(), dayKey(Date.now()), pet.seed || pet.id, cachedDayTexts());
      if (app && app.beastSpeciesEn) {
        // 新幻兽：物种 + 配色 + 今天挑出来的小装饰 + 审美锁
        return beastPrompt(app, lk, mark);
      }
      // 老数据（2026-10-24 之前孵出来的）：物种英文从老表找，行为特征照样生效
      const speciesEn = app && app.identity
        ? (LEGACY_IDENTITY_EN[app.identity]
          || (BEAST_SPECIES.find(s => s.cn === app.identity) || {}).en
          || 'a round cute fantasy beast')
        : 'a round cute fantasy beast';
      const paletteEn = app && app.palette
        ? (LEGACY_PALETTE_EN[app.palette]
          || (BEAST_PALETTES.find(p => p.cn === app.palette) || {}).en
          || 'pastel pink')
        : 'pastel pink';
      return beastPrompt({ beastSpeciesEn: speciesEn, beastPaletteEn: paletteEn }, lk, mark);
    }

    const kindText = {
      cat: 'fluffy cat', dog: 'fluffy puppy'
    }[pet.kind] || 'cute fantasy pet';
    return kindText + (look ? ', ' + look : '') + ', ' + ART_STYLE_LOCK;
  }

  /** 给这只宠物生成（或更新）样貌，并把新样子塞给 AI 看 */
  async function generateNewLook(pet) {
    const d = await openDb();
    const row = await d.pets.get(pet.id);
    if (!row) throw new Error('找不到这只宝宝');

    const stageKey = pet.id + '::' + row.stage;
    const stageRow = await d.stages.get(stageKey);
    const subject = subjectForPet(row, await buildTodayLook(row));
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

    // 换了新模样 → 让它自己说一句（用户 2026-10-25：要「换装了自己说一句」）
    try {
      if (window.PetSpeech && typeof window.PetSpeech.petSpeak === 'function') {
        const fresh = await d.pets.get(pet.id);
        window.PetSpeech.petSpeak(fresh || row, 'redraw', {});
      }
    } catch (e) { /* 忽略 —— 说话失败不能影响生图 */ }

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

  // ============================================================
  // 10·五、每天自动换一次造型
  //   用户定的规矩：
  //   - 每天最多自动 1 次（手动再点「换个模样」另外算，但都受每日 3 张上限管）
  //   - 画不成就跳过：不报错、不弹窗、造型不变（「大不了不换」）
  //   - 不累积：今天这套直接替换昨天那套
  //   - 用上一张当参考图蜕变 → 保证「还是同一只」
  // ============================================================

  let autoLookRunning = false;
  let autoLookTimer = null;

  async function maybeDailyRedraw(petOrId, opts) {
    if (autoLookRunning) return null;
    try {
      const d = await openDb();
      const pid = typeof petOrId === 'string' ? petOrId : (petOrId && petOrId.id);
      const row = await d.pets.get(pid);
      if (!row) return null;
      if (row.kind !== 'egg') return null;              // 鹦鹉 / 猫狗走原来的手动逻辑
      if (Number(row.stage || 0) <= 0) return null;     // 还没孵出来
      const day = dayKey(Date.now());
      if (await getMeta('petNestLastAutoLookDay', '') === day) return null;  // 今天画过了
      const behaviors = await todayBehaviors(day);
      if (!behaviors.length) return null;               // 今天还没发生什么，先不画
      if (!window.PetImage || typeof window.PetImage.generateAtlas !== 'function') return null;
      const used = Number(window.PetImage.todayCount ? window.PetImage.todayCount() : 0);
      const limit = Number(window.PetImage.CFG && window.PetImage.CFG.dailyLimit) || 3;
      if (used >= limit) return null;                   // 每日上限
      await setMeta('petNestLastAutoLookDay', day);
      autoLookRunning = true;
      try {
        await generateNewLook(row);
        if (!(opts && opts.silent)) showToastSafe('它今天的样子换好啦', 'success');
        return true;
      } catch (e) {
        console.warn('[宠物屋] 换造型失败（忽略，不影响别的功能）', e);
        return null;
      } finally {
        autoLookRunning = false;
      }
    } catch (e) {
      console.warn('[宠物屋] 每日换造型调度失败', e);
      return null;
    }
  }

  /** 攒一会儿再画 —— 让当天互动先积累一点，一次画到位 */
  function scheduleAutoLook() {
    if (autoLookTimer) return;
    autoLookTimer = setTimeout(async () => {
      autoLookTimer = null;
      try {
        const d = await openDb();
        const first = await d.pets.orderBy('createdAt').first();
        if (first) await maybeDailyRedraw(first, { silent: true });
      } catch (e) { /* 忽略 */ }
    }, 60000);
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

    // ---- 宠物说话：本地巡视（15 分钟）+ 重新打开 App 立刻说一句 ----
    //   【用户 2026-10-26】「不用服务器，PWA 活着就行」「重新打开 App 立刻让宠物说一句」
    // ⚠️ pet-speech.js 是 defer 脚本、排在 pet-nest.js 【后面】→ 它执行完 window.PetSpeech 才在。
    //    这里显式等一下，别赌加载顺序。
    for (let i = 0; i < 50 && !window.PetSpeech; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    try {
      if (window.PetSpeech && typeof window.PetSpeech.startPatrol === 'function') {
        window.PetSpeech.startPatrol();
        // 稍微等一下，等界面和 messageStore 都稳了再开口
        setTimeout(() => {
          try { window.PetSpeech.speakOnWake(); } catch (e) { /* 忽略 */ }
        }, 2500);
      }
    } catch (e) {
      console.warn('[宠物屋] 启动说话巡视失败', e);
    }
  }

  // ============================================================
  // 11. 备份 / 恢复
  // ============================================================
  // ⚠️【2026-10-26 用户提】「备份的时候是不是没带宠物信息走？换个窗就得重新养一只」
  //   → 真的没带：PetNestDB 是**独立于主库 GeminiChatDB 的另一个 IndexedDB 库**，
  //     主库的备份只扫 db.tables，扫不到它 → 换设备/清缓存 = 宠物全没了。
  //   → 所以这里自己实现导出/恢复，备份模块通过 window.PetNest.exportBackupData()
  //     / importBackupData() 两个口子把这一节带进/写回备份文件。

  /** 备份要带的表（顺序不重要，整库覆盖） */
  const BACKUP_TABLES = [
    'pets', 'stages', 'events', 'days', 'turns', 'meta',
    'dailySignals', 'dailyNotes', 'assets'
  ];

  /** 每只宠物最多带几张样貌图进备份（当前那张必带） */
  const BACKUP_ASSET_KEEP_PER_PET = 12;

  /**
   * 挑要带进备份的样貌图（纯函数，好测）
   * 规则：每只宠物「当前这张」必带 + 最新的若干张（免得一年下来几千张把备份撑爆）
   */
  function selectAssetsForBackup(assets, pets, keepPerPet) {
    const keep = Math.max(1, Number(keepPerPet) || 1);
    const rows = (Array.isArray(assets) ? assets : []).filter(r => r && r.id);
    const current = new Set();
    for (const p of (Array.isArray(pets) ? pets : [])) {
      if (p && p.assetRef) current.add(String(p.assetRef));
    }
    const byPet = new Map();
    for (const r of rows) {
      const pid = String(r.petId || '');
      if (!byPet.has(pid)) byPet.set(pid, []);
      byPet.get(pid).push(r);
    }
    const out = [];
    for (const list of byPet.values()) {
      // 新的在前
      list.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      let taken = 0;
      for (const r of list) {
        const isCurrent = current.has(String(r.id));
        if (!isCurrent && taken >= keep) continue;
        out.push(r);
        if (!isCurrent) taken++;
      }
    }
    return out;
  }

  /** Blob → data URL（备份里存 base64；纯函数，好测） */
  async function blobToDataUrl(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') return '';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(bin);
  }

  /** data URL → Blob（纯函数，好测） */
  async function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]*)((?:;[^,;]*)*),(.*)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const isBase64 = /;base64/i.test(m[2] || '');
    if (isBase64) {
      const bin = atob(m[3] || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(m[3] || '')], { type: mime });
  }

  /** 导出整个宠物屋（备份用） */
  async function exportBackupData() {
    const d = await openDb();
    const [pets, stages, events, days, turns, meta, dailySignals, dailyNotes, assets] = await Promise.all([
      d.pets.toArray(),
      d.stages.toArray(),
      d.events.toArray(),
      d.days.toArray(),
      d.turns.toArray(),
      d.meta.toArray(),
      d.dailySignals.toArray(),
      d.dailyNotes.toArray(),
      d.assets.toArray()
    ]);
    const kept = selectAssetsForBackup(assets, pets, BACKUP_ASSET_KEEP_PER_PET);
    const outAssets = [];
    for (const row of kept) {
      const dataUrl = await blobToDataUrl(row.blob);
      if (!dataUrl) continue;
      outAssets.push({
        id: row.id,
        petId: row.petId,
        stage: row.stage,
        mime: row.mime || 'image/webp',
        size: row.size || 0,
        createdAt: row.createdAt || 0,
        transparent: !!row.transparent,
        sourceSize: row.sourceSize || null,
        dataUrl
      });
    }
    return {
      version: 1,
      exportedAt: Date.now(),
      pets,
      stages,
      events,
      days,
      turns,
      meta,
      dailySignals,
      dailyNotes,
      assets: outAssets,
      assetTotal: assets.length,
      assetKept: outAssets.length
    };
  }

  /** 恢复整个宠物屋（导入用）：整库覆盖 */
  async function importBackupData(payload) {
    const p = payload && typeof payload === 'object' ? payload : null;
    if (!p) return { ok: false, reason: 'no_data' };

    // 先把 base64 解回 Blob（放在事务外，别在 Dexie 事务里等非数据库的 promise）
    const decoded = [];
    for (const a of (Array.isArray(p.assets) ? p.assets : [])) {
      if (!a || !a.id) continue;
      const blob = await dataUrlToBlob(a.dataUrl);
      if (!blob) continue;
      decoded.push({
        id: a.id,
        petId: a.petId,
        stage: a.stage,
        blob,
        mime: a.mime || blob.type || 'image/webp',
        size: a.size || blob.size || 0,
        createdAt: a.createdAt || Date.now(),
        transparent: !!a.transparent,
        sourceSize: a.sourceSize || null
      });
    }

    const d = await openDb();
    const counts = {};
    await d.transaction('rw', d.tables, async () => {
      for (const t of BACKUP_TABLES) {
        try { await d[t].clear(); } catch (e) { /* 这张表在老版本里没有 */ }
      }
      const put = async (table, rows) => {
        if (!Array.isArray(rows) || !rows.length) { counts[table] = 0; return; }
        await d[table].bulkPut(rows);
        counts[table] = rows.length;
      };
      await put('pets', p.pets);
      await put('stages', p.stages);
      await put('events', p.events);
      await put('days', p.days);
      await put('turns', p.turns);
      await put('meta', p.meta);
      await put('dailySignals', p.dailySignals);
      await put('dailyNotes', p.dailyNotes);
      counts.assets = decoded.length;
      if (decoded.length) await d.assets.bulkPut(decoded);
    });
    return { ok: true, counts, petCount: (p.pets || []).length };
  }

  // ============================================================
  // 12. 导出
  // ============================================================

  window.PetNest = {
    open: openPetNest,
    // 备份 / 恢复（主库备份带不走独立库 PetNestDB，得走这两个口子）
    exportBackupData,
    importBackupData,
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
    // 所有宠物（pet-speech.js 巡视时要用）
    listPets,
    // 每天自动换一次造型（手动也可以调）
    refreshDailyLook: function (petId) {
      return maybeDailyRedraw(petId || '', { silent: false });
    },
    // 给测试用：把纯规则函数暴露出来（tests/pet-nest.test.cjs 直接验算，不用起浏览器）
    rules: {
      grainsFor,
      temperament,
      growthTarget,
      currentSatiety,
      petView,
      hungrySinceOf,
      starveState,
      starveDaysLeft,
      removePet,
      sweepStarvedPets,
      listPets,
      dimensionScores,
      setSpeechFlag,
      openManageDialog,
      renderManageList,
      doRemovePet,
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
      renderDesktopPet,
      renderDesktopPetContent,
      // 幻兽（灵宠蛋孵出来的那只）
      beastSpeciesForSeed,
      dailyLookFor,
      beastDisplayName,
      beastPrompt,
      todayBehaviors,
      cachedBehaviors,
      pickIconsFromText,
      todayRepresentativeTexts,
      buildTodayLook,
      dayStartTs,
      BEAST_SPECIES,
      BEAST_OUTFITS,
      BEAST_PALETTES,
      DIVINE_FORMS,
      DIVINE_STYLE_LOCK,
      beastLineage,
      divineFormsFor,
      BEHAVIOR_FEATURES,
      ICON_LIBRARY,
      CHAT_KEYWORD_FEATURES,
      TRIGGER_SIGNALS,
      ART_STYLE_LOCK,
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
      FEED_SATIETY_PER_GRAIN,
      STARVE_DAYS,
      FEED_GROWTH,
      feedGrainCost,
      interactionDelta,
      petConfirm,
      selectAssetsForBackup,
      blobToDataUrl,
      dataUrlToBlob,
      STAGE_RULES_HATCH,
      STAGE_RULES_PLAIN,
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

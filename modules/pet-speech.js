// ============================================================
// pet-speech.js — 宠物说话系统
// 2026-10-26
//
// 【它是干什么的】
//   让宠物自己开口说话：
//   · 事件触发：刚被摸了 / 陪玩了 / 喂了 / 升级了 / 换了新模样 → 说一句
//   · 定时巡视：每 15 分钟（唤醒时也会立刻补一次）→ 自己嘟囔一句
//   说的话会冒在桌宠气泡上，也可以落进聊天框（显示成「啾啾：……」）
//
// 【用户 2026-10-25/26 拍板的几条硬规矩，改动前先看】
//   ① **提示词里不能写任何【说话示例】**
//      用户原话：「不要在提示词里写说话示例，不然有的蠢模型会原味儿句句说出来」
//      → 本文件所有 prompt 拼装函数里【不许出现举例句】。
//      → 智力档位只给「上限 + 禁止项」，性格只给「描述 + 数值」，不给示范。
//   ② **身份只给名字，不给物种特征**
//      用户原话：「囚牛是龙之九子里的老大，喜欢抱着琴听人唱歌，这都不要给，
//      不然蠢模型天天抱琴唱歌」
//      → 只写「你是「啾啾」，一只囚牛」。让模型自己理解，不要喂特征。
//   ③ **话题方向是【候选菜单】，不是命题作文**
//      用户原话：「只是一个话题选择，也可以说符合自己性格的话」
//      → 明写「挑一个，或者都不选，说点别的也行」→ 不会句句念神话。
//   ④ **智力随成长阶段涨，但不超过 10 岁人类儿童**
//      用户原话：「它的智商根据成长阶段逐步增加…但总体智商不要超过10岁人类儿童智商」
//   ⑤ **不用服务器**：本地巡视，PWA 活着就行。
//      API 走【后台活动槽位】（resolveApiSlotConfig('background')），不是主 API。
//   ⑥ **巡视到点就说**，不让模型自己决定说不说。
//   ⑦ **每个宠物独立开关**：允许说话 / 允许插话到聊天框。
//
// 【为什么单独一个文件】
//   pet-nest.js 已经 3000+ 行了，这个功能自成一块，拆开好维护也好测。
// ============================================================

(function () {
  'use strict';

  // ============================================================
  // 1. 纯规则（好测，不碰 DOM / 不调 API）
  // ============================================================

  // ---- 智力档位：阶段 → 相当于几岁的人类小孩 ----
  // ⚠️ 只有「上限 + 禁止项」，【不许写示例句】（用户规矩 ①）
  const IQ_STAGES = {
    0: {
      age: 0,
      canSpeak: false,
      note: '你还只是一颗蛋，说不出话。'
    },
    1: {
      age: 2,
      canSpeak: true,
      note: '你的智力相当于 2 岁的小孩：只会表达自己的感受和想要什么，说不了因果，说不了为什么。'
    },
    2: {
      age: 4,
      canSpeak: true,
      note: '你的智力相当于 4 岁的小孩：能说简单的因果（先…然后…），但想不了太复杂的事。'
    },
    3: {
      age: 7,
      canSpeak: true,
      note: '你的智力相当于 7 岁的小孩：能问问题、能提自己的想法，但还不太会绕弯子。'
    },
    4: {
      age: 10,
      canSpeak: true,
      note: '你的智力相当于 10 岁的小孩：能讲清楚自己的小心思，但不许说成年人的话、不许说教。'
    }
  };

  function iqFor(stage) {
    const s = Math.max(0, Math.min(4, Number(stage || 0)));
    return IQ_STAGES[s] || IQ_STAGES[0];
  }

  // ---- 性格：6 维数值 → 一句人话（不给示例句）----
  const TRAIT_DESC = {
    attachment: {
      high: '很黏人、爱撒娇',
      mid: '亲昵，但也有自己的小脾气',
      low: '独立、慢热，不太黏人'
    },
    energy: {
      high: '闹腾、坐不住',
      mid: '活力一般',
      low: '懒、爱睡、慢吞吞'
    },
    curiosity: {
      high: '什么都想问、什么都想试',
      mid: '偶尔好奇',
      low: '淡定、没什么好奇心'
    },
    sociability: {
      high: '话多、爱主动搭话',
      mid: '正常',
      low: '安静、话少'
    },
    calm: {
      high: '安静、沉得住气',
      mid: '一般',
      low: '坐不住、容易兴奋'
    },
    sensitivity: {
      high: '细腻、能察觉到别人的情绪',
      mid: '一般',
      low: '大大咧咧、什么都感觉不到'
    }
  };

  function traitDesc(key, value) {
    const d = TRAIT_DESC[key];
    if (!d) return '';
    const v = Number(value || 50);
    if (v >= 70) return d.high;
    if (v >= 40) return d.mid;
    return d.low;
  }

  /** 性格 → 一段人话（纯函数） */
  function personalityLines(traits) {
    const t = traits || {};
    const order = ['attachment', 'energy', 'curiosity', 'sociability', 'calm', 'sensitivity'];
    const out = [];
    for (const k of order) {
      const v = Number(t[k] || 50);
      const desc = traitDesc(k, v);
      if (desc) out.push(desc + '（' + Math.round(v) + '）');
    }
    return out;
  }

  // ---- 关系维度：5 维 → 关系感 ----
  const RELATION_DESC = {
    affection: '最喜欢被抱着、最黏你们',
    reading: '最喜欢你们一起看书的时候',
    watching: '最喜欢你们一起看东西的时候',
    listening: '最喜欢你们一起听东西的时候',
    exploration: '最喜欢跟你们一起出去乱跑'
  };

  /** 关系维度分 → 一句关系感（只取最高的那个，纯函数） */
  function relationLine(scores) {
    const s = scores || {};
    let bestKey = '';
    let best = 0;
    for (const k of Object.keys(RELATION_DESC)) {
      const v = Number(s[k] || 0);
      if (v > best) { best = v; bestKey = k; }
    }
    if (!bestKey || best <= 0) return '';
    return RELATION_DESC[bestKey];
  }

  // ---- 事件 → 一句「刚发生什么」 ----
  const EVENT_LINES = {
    feed: '刚吃了饭，肚子饱饱的',
    play: '刚被陪玩了一会儿',
    comfort: '刚被摸了摸',
    hatch: '刚刚破壳，第一次见到你们',
    stage: '刚刚长大了一点点',
    divine: '刚刚长成了终形态',
    redraw: '刚刚换了新样子',
    idle: '一个人在窝里待着'
  };

  function eventLine(event) {
    return EVENT_LINES[event] || '';
  }

  // ---- 状态 → 一句现在怎么样 ----
  function stateLine(pet) {
    if (!pet) return '';
    const bits = [];
    const s = Math.round(Number(pet.satiety || 0));
    if (pet.starving) bits.push('已经饿了好几天，快撑不住了');
    else if (s <= 30) bits.push('有点饿了');
    else if (s >= 80) bits.push('吃得饱饱的');
    const stage = Number(pet.stage || 0);
    if (stage >= 1) bits.push('第 ' + stage + ' 阶段');
    return bits.join('，');
  }

  // ---- 话题方向：候选菜单（用户规矩 ③）----
  const TOPIC_MENU = [
    '爸爸妈妈刚才聊的那件事，你的看法',
    '你自己现在的小心思（饿、困、想玩、想被抱）',
    '你作为你自己这个小家伙的一些小经历',
    '你今天注意到的事'
  ];

  // ============================================================
  // 2. Prompt 拼装（纯函数 —— ⚠️ 这里绝对不能出现说话示例）
  // ============================================================

  /**
   * 拼宠物的 system prompt
   * @param pet  { name, kind, stage, satiety, starving, traits, appearance, ... }
   * @param ctx  { event, relationScores, parents: {user, ai}, chatLines: [..] }
   */
  function buildSpeechPrompt(pet, ctx) {
    const c = ctx || {};
    const name = (pet && pet.name) || '小家伙';
    const iq = iqFor(pet && pet.stage);
    const L = [];

    // ---- 你是谁（只给名字，不给物种特征 —— 用户规矩 ②）----
    const species = speciesCnOf(pet);
    L.push('# 你是谁');
    L.push('你是「' + name + '」' + (species ? '，一只' + species : '') + '。');
    L.push('你住在你们的窝里，跟他们一起生活。');

    // ---- 你的智力（上限 + 禁止项，无示例）----
    L.push('');
    L.push('# 你的智力');
    if (!iq.canSpeak) {
      L.push(iq.note);
    } else {
      L.push(iq.note);
      L.push('- 用短句、口语、可以叠字');
      L.push('- 不要说教、不要讲道理、不要用书面语');
      L.push('- 不要说出深刻的话，不要装大人');
    }

    // ---- 你的性格（描述 + 数值，倾向不是命令）----
    const pLines = personalityLines(pet && pet.traits);
    if (pLines.length) {
      L.push('');
      L.push('# 你的性格');
      for (const line of pLines) L.push('- ' + line);
    }

    // ---- 你和他们的关系 ----
    const rel = relationLine(c.relationScores);
    if (rel) {
      L.push('');
      L.push('# 你和他们的关系');
      L.push('- ' + rel);
    }

    // ---- 你的两个家长（不判谁是谁）----
    const parents = c.parents || {};
    L.push('');
    L.push('# 你的两个家长');
    const un = String(parents.user || '').trim();
    const an = String(parents.ai || '').trim();
    if (un && an) {
      L.push('- ' + un + ' 和 ' + an + ' 是你的两个家长，你管他们叫爸爸妈妈。');
    } else if (un || an) {
      L.push('- ' + (un || an) + ' 是你的家长，你管 TA 叫爸爸妈妈。');
    } else {
      L.push('- 他们是你的两个家长，你管他们叫爸爸妈妈。');
    }

    // ---- 现在的你 ----
    const st = stateLine(pet);
    if (st) {
      L.push('');
      L.push('# 现在的你');
      L.push('- ' + st);
    }

    // ---- 刚发生什么 ----
    const ev = eventLine(c.event);
    if (ev) {
      L.push('');
      L.push('# 刚发生什么');
      L.push('- ' + ev);
    }

    // ---- 爸爸妈妈最近在聊什么（真实聊天记录当上文）----
    const chatLines = Array.isArray(c.chatLines) ? c.chatLines.filter(Boolean) : [];
    if (chatLines.length) {
      L.push('');
      L.push('# 爸爸妈妈最近在聊什么');
      for (const line of chatLines) L.push(line);
    }

    // ---- 这次可以聊的方向（候选菜单！明写可以都不选）----
    L.push('');
    L.push('# 这次可以聊的方向');
    L.push('下面是一些【可以选的方向】，不是必须说的内容。挑一个，或者都不选，说点别的也行。');
    for (const t of TOPIC_MENU) L.push('- ' + t);

    // ---- 输出要求 ----
    L.push('');
    L.push('# 怎么说话');
    L.push('- 只说你自己的一句话，短一点。');
    L.push('- 不要解释你在想什么，不要说教，不要用引号包起来。');
    L.push('- 直接输出那句话本身，不要输出任何格式、标签、解释。');

    return L.join('\n');
  }

  /** 这只宠物的物种中文名（只用来告诉它「你是谁」，不展开特征） */
  function speciesCnOf(pet) {
    if (!pet) return '';
    const app = pet.appearance || {};
    return app.beastSpecies || app.identity || '';
  }

  // ============================================================
  // 3. API 调用（走后台活动槽位）
  // ============================================================

  /**
   * 取 API 配置：优先「后台活动」槽位（用户规矩 ⑤），没配就回落主 API。
   * ⚠️ 跟 modules/ai-group.js 的 triggerInactiveAiAction 同一套写法。
   */
  async function resolveApiConfig() {
    try {
      if (typeof window.resolveApiSlotConfig === 'function') {
        const resolved = await window.resolveApiSlotConfig('background');
        if (resolved && resolved.proxyUrl && resolved.apiKey && resolved.model) {
          return { proxyUrl: resolved.proxyUrl, apiKey: resolved.apiKey, model: resolved.model };
        }
      }
    } catch (e) {
      console.warn('[宠物说话] 解析后台 API 槽位失败，回落主 API:', (e && e.message) || e);
    }
    const cfg = (window.state && window.state.apiConfig) || {};
    if (cfg.backgroundProxyUrl && cfg.backgroundApiKey && cfg.backgroundModel) {
      return {
        proxyUrl: cfg.backgroundProxyUrl,
        apiKey: cfg.backgroundApiKey,
        model: cfg.backgroundModel
      };
    }
    return { proxyUrl: cfg.proxyUrl, apiKey: cfg.apiKey, model: cfg.model };
  }

  /** 调一次 LLM 拿宠物的话（返回纯文本） */
  async function callModel(systemPrompt, opts) {
    const o = opts || {};
    const cfg = await resolveApiConfig();
    if (!cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      throw new Error('没配 API');
    }
    const url = String(cfg.proxyUrl).replace(/\/+$/, '') + '/chat/completions';
    const payload = {
      model: cfg.model,
      messages: [{ role: 'system', content: systemPrompt }],
      temperature: typeof o.temperature === 'number' ? o.temperature : 0.95,
      max_tokens: o.maxTokens || 120
    };
    const isGemini = /generativelanguage\.googleapis\.com/.test(String(cfg.proxyUrl));
    let response;
    if (isGemini && typeof window.toGeminiRequestData === 'function') {
      const g = window.toGeminiRequestData(cfg.model, cfg.apiKey, systemPrompt, payload.messages);
      response = await fetch(g.url, g.data);
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(payload)
      });
    }
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      throw new Error('API 失败 HTTP ' + response.status + ' ' + String(t).substring(0, 120));
    }
    const data = await response.json().catch(() => null);
    const raw = extractText(data);
    if (!raw) throw new Error('模型没返回内容');
    return raw;
  }

  /** 从各种返回结构里抠出纯文本 */
  function extractText(data) {
    if (!data) return '';
    let raw = '';
    if (typeof data.output_text === 'string') raw = data.output_text;
    else if (data.choices && data.choices[0]) {
      const c = data.choices[0];
      raw = (c.message && c.message.content) || c.text || '';
    } else if (data.candidates && data.candidates[0]) {
      const parts = (data.candidates[0].content && data.candidates[0].content.parts) || [];
      raw = parts.map(p => p.text || '').join('');
    }
    if (typeof raw !== 'string') return '';
    raw = raw.trim();
    // 模型偶尔会套引号 / 加前缀，剥掉
    raw = raw.replace(/^["'「『](.*)["'」』]$/s, '$1').trim();
    // 去掉「宠物：」这种前缀
    raw = raw.replace(/^[^：:]{1,8}[：:]\s*/, '').trim();
    return raw;
  }

  // ============================================================
  // 4. 气泡 + 落库
  // ============================================================

  // 桌宠气泡是【共用】的：平时显示「它好像饿了…」，宠物说话时显示它的话。
  // 用 bubbleActive 标记「现在气泡归说话管」，pet-nest.js 的饥饿提示就会让位。
  let bubbleActive = false;
  let bubbleTimer = null;

  /** 桌宠气泡：先冒省略号，出结果再替换 */
  function showBubble(text) {
    const bubble = document.getElementById('pn-desktop-pet-bubble');
    if (!bubble) return;
    bubbleActive = true;
    bubble.hidden = false;
    bubble.textContent = text || '…';
    bubble.classList.add('pn-say');
    // 自动消失，别一直挂在那儿挡着聊天
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubbleTimer = null;
      hideBubble();
    }, 9000);
  }

  function hideBubble() {
    const bubble = document.getElementById('pn-desktop-pet-bubble');
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    bubbleActive = false;
    if (!bubble) return;
    bubble.hidden = true;
    bubble.textContent = '';
    bubble.classList.remove('pn-say');
  }

  /** 现在气泡是不是被「宠物说话」占着（pet-nest.js 饥饿提示会让位） */
  function isBubbleActive() {
    return bubbleActive;
  }

  /**
   * 桌宠现在看得见吗？
   * 桌宠只在聊天页常驻 —— 不在聊天页时整个容器是藏的，
   * 这时候气泡（它在桌宠里面）用户根本看不到 → 得用 toast 兜一下，
   * 不然宠物说了话等于白说（「重新打开 App 立刻说一句」就白说了）。
   */
  function desktopPetVisible() {
    try {
      const wrap = document.getElementById('pn-desktop-pet');
      if (!wrap) return false;
      return !wrap.hidden;
    } catch (e) {
      return false;
    }
  }

  function toastSafe(text) {
    try {
      if (typeof window.showToast === 'function') window.showToast(text, 'info');
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 把宠物的话落进聊天记录
   * ⚠️ role='system' + type='pet_say' —— AI 上下文里会转成「[宠物 啾啾] …」，
   *    这样 AI 明确知道是宠物说的，不会误以为是自己说的（混淆问题的根治办法）。
   */
  async function persistToChat(chat, pet, text) {
    if (!chat || !text) return null;
    const msg = {
      role: 'system',
      type: 'pet_say',
      content: text,
      senderName: (pet && pet.name) || '宠物',
      petName: (pet && pet.name) || '宠物',
      petId: (pet && pet.id) || '',
      timestamp: Date.now()
    };
    try {
      if (window.messageStore && typeof window.messageStore.addMessageToChat === 'function') {
        await window.messageStore.addMessageToChat(chat, msg);
      } else {
        if (!Array.isArray(chat.history)) chat.history = [];
        chat.history.push(msg);
        if (window.db && window.db.chats) {
          const { history, ...cleanChat } = chat;
          await window.db.chats.put(cleanChat);
        }
      }
    } catch (e) {
      console.warn('[宠物说话] 写入聊天记录失败:', (e && e.message) || e);
      return null;
    }
    return msg;
  }

  /** 聊天记录最近 N 条 → 给宠物当上文 */
  async function recentChatLines(chat, limit) {
    const n = Math.max(0, Number(limit || 30));
    if (!chat || !n) return [];
    let rows = [];
    try {
      if (window.messageStore && typeof window.messageStore.getRecentMessages === 'function') {
        rows = await window.messageStore.getRecentMessages(chat.id, n, () => true);
      }
    } catch (e) { /* 忽略 */ }
    if (!Array.isArray(rows) || !rows.length) {
      rows = Array.isArray(chat.history) ? chat.history.slice(-n) : [];
    }
    const userName = (chat.settings && chat.settings.myNickname)
      || (window.state && window.state.qzoneSettings && window.state.qzoneSettings.nickname)
      || '我';
    const out = [];
    for (const m of rows) {
      if (!m || m.isHidden) continue;
      if (m.type === 'pet_say') continue;         // 宠物自己说的话不用回灌给自己
      const content = textOf(m);
      if (!content) continue;
      if (m.role === 'user') {
        out.push(userName + '：' + content);
      } else if (m.role === 'assistant') {
        const who = m.senderName || chat.name || chat.originalName || 'TA';
        out.push(who + '：' + content);
      } else if (m.role === 'system') {
        out.push('（系统）' + content);
      }
    }
    return out.slice(-n);
  }

  function textOf(m) {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      return m.content.filter(c => c && c.type === 'text')
        .map(c => c.text || '').join('').trim();
    }
    return '';
  }

  // ============================================================
  // 5. 开关（每只宠物独立）
  // ============================================================

  function speechEnabled(pet) {
    if (!pet) return false;
    return pet.canSpeak !== false;      // 默认开
  }

  /**
   * 还是颗蛋吗？
   * ⚠️【2026-10-26 修】不能只看 stage<=0 —— 猫狗刚领养时也是 stage 0，
   *   但它是活的，应该能说话。只有「蛋类 + 第 0 阶段」才是真的还是颗蛋。
   */
  function isEggPet(petRow) {
    if (!petRow) return false;
    if (Number(petRow.stage || 0) > 0) return false;
    const kind = String(petRow.kind || '');
    try {
      const rules = window.PetNest && window.PetNest.rules;
      if (rules && typeof rules.isHatchKind === 'function') return !!rules.isHatchKind(kind);
    } catch (e) { /* 忽略 */ }
    return kind === 'egg' || kind === 'parrot';   // 兜底
  }

  function chatInsertEnabled(pet) {
    if (!pet) return false;
    return pet.canChatInsert !== false; // 默认开
  }

  // ============================================================
  // 6. 说话主流程
  // ============================================================

  let speaking = false;   // 同一时刻只让一只说

  /**
   * 让这只宠物说一句
   * @param petRow  宠物 DB 行
   * @param event   'feed'|'play'|'comfort'|'hatch'|'stage'|'divine'|'redraw'|'idle'
   * @param opts    { chat, silent }
   */
  async function petSpeak(petRow, event, opts) {
    const o = opts || {};
    if (!petRow) return null;
    if (!speechEnabled(petRow)) return null;
    if (speaking) return null;          // 一次只说一句，避免刷屏
    speaking = true;
    try {
      const chat = o.chat || currentChat();
      const pet = window.PetNest && typeof window.PetNest.rules.petView === 'function'
        ? window.PetNest.rules.petView(petRow, Date.now())
        : petRow;

      // 还是颗蛋就不会说话
      // ⚠️【2026-10-26 修】原来只判 stage<=0 → 刚领养的猫狗（stage 0）也被当成蛋，
      //   新养的猫要等 10 天升到第 1 阶段才能开口，跟用户定的「唤醒即说」直接冲突。
      //   现在只把「真的还是颗蛋」（蛋类 + 第 0 阶段）禁言。
      if (isEggPet(petRow)) return null;

      // 上下文
      const relationScores = await relationScoresOf(petRow);
      const parents = parentsOf(chat);
      const chatLines = chat ? await recentChatLines(chat, 30) : [];

      const prompt = buildSpeechPrompt(pet, {
        event: event,
        relationScores: relationScores,
        parents: parents,
        chatLines: chatLines
      });

      // 气泡先冒省略号（用户定的）
      if (!o.silent) showBubble('…');

      let text = '';
      try {
        text = await callModel(prompt, { temperature: 0.95, maxTokens: 120 });
      } catch (e) {
        console.warn('[宠物说话] 生成失败（忽略，不影响别的功能）:', (e && e.message) || e);
        if (!o.silent) hideBubble();
        return null;
      }
      text = String(text || '').trim();
      if (!text) {
        if (!o.silent) hideBubble();
        return null;
      }
      // 别让它说太长
      if (text.length > 120) text = text.slice(0, 120);

      if (!o.silent) showBubble(text);

      // 桌宠不在聊天页 → 气泡看不见 → 补一个 toast，别让这句话白说
      if (!o.silent && !desktopPetVisible()) {
        toastSafe(((pet && pet.name) || '宠物') + '：' + text);
      }

      // 落进聊天框（受「允许插话」开关控制）
      if (chat && chatInsertEnabled(petRow)) {
        await persistToChat(chat, petRow, text);
        renderChatIfActive(chat.id);
      }

      return text;
    } finally {
      speaking = false;
    }
  }

  function currentChat() {
    try {
      const state = window.state;
      const id = state && state.activeChatId;
      if (!id) return null;
      return (state.chats && state.chats[id]) || null;
    } catch (e) {
      return null;
    }
  }

  function renderChatIfActive(chatId) {
    try {
      if (window.state && window.state.activeChatId === chatId
        && typeof window.renderChatMessages === 'function') {
        window.renderChatMessages();
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 关系维度分（跟花纹那套同源） */
  async function relationScoresOf(petRow) {
    const out = {};
    try {
      const rules = window.PetNest && window.PetNest.rules;
      if (rules && typeof rules.dimensionScores === 'function') {
        const s = await rules.dimensionScores(petRow);
        if (s) return s;
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /** 两个家长是谁（不判性别） */
  function parentsOf(chat) {
    const out = { user: '', ai: '' };
    if (!chat) return out;
    const state = window.state || {};
    out.user = (chat.settings && chat.settings.myNickname)
      || (state.qzoneSettings && state.qzoneSettings.nickname)
      || '我';
    out.ai = chat.name || chat.originalName || '';
    if (out.ai === '{{user}}') out.ai = '';
    return out;
  }

  // ============================================================
  // 7. 巡视频器（本地，PWA 活着就行）
  // ============================================================

  const DEFAULT_INTERVAL_MIN = 15;
  // 每只宠物一个「上次说话时间」→ 各自独立计时（用户 2026-10-26 定的）
  const STORAGE_PREFIX = 'petSpeechLastAt:';

  let patrolTimer = null;

  function patrolIntervalMin() {
    const v = window.state && window.state.globalSettings
      && window.state.globalSettings.petSpeechIntervalMin;
    return (typeof v === 'number' && v > 0) ? v : DEFAULT_INTERVAL_MIN;
  }

  /** 这只上次是什么时候开口的 */
  function lastSpokeAt(petId) {
    try {
      return Number(localStorage.getItem(STORAGE_PREFIX + petId) || 0);
    } catch (e) {
      return 0;
    }
  }

  function markSpoke(petId) {
    try { localStorage.setItem(STORAGE_PREFIX + petId, String(Date.now())); } catch (e) { /* 忽略 */ }
  }

  // ⚠️ 这里【刻意没有】夜间静默开关。
  //   用户 2026-10-26 原话：「重新打开 App → 立刻让宠物说一句」「巡视到点就说」。
  //   巡视本来就得 App 开着才跑（本地定时器），App 开着就说明人醒着 ——
  //   加个夜间静默反而会让「立刻说一句」在晚上失效，是跟用户要求打架的。

  function startPatrol() {
    stopPatrol();
    const ms = Math.max(1, patrolIntervalMin()) * 60 * 1000;
    patrolTimer = setInterval(() => { patrolTick(); }, ms);
    if (patrolTimer && typeof patrolTimer.unref === 'function') patrolTimer.unref();
  }

  function stopPatrol() {
    if (patrolTimer) {
      clearInterval(patrolTimer);
      patrolTimer = null;
    }
  }

  /** 一次巡视：到点就说（用户规矩 ⑥，不让模型决定说不说） */
  async function patrolTick(options) {
    const o = options || {};
    try {
      if (!window.PetNest || typeof window.PetNest.listPets !== 'function') return null;
      const rows = await window.PetNest.listPets();
      const able = (rows || []).filter(r => speechEnabled(r) && !isEggPet(r));
      if (!able.length) return null;

      const now = Date.now();
      const gapMs = Math.max(1, patrolIntervalMin()) * 60 * 1000;

      // 每只各自独立计时：只有到自己那 15 分钟到了的才是候选
      let due = o.force
        ? able.slice()
        : able.filter(r => now - lastSpokeAt(r.id) >= gapMs);
      if (!due.length) return null;

      // 多只都在等 → 挑「等得最久」的那只（自然错开，同一时刻只让一只说）
      due.sort((a, b) => lastSpokeAt(a.id) - lastSpokeAt(b.id));
      const pick = due[0];

      const text = await petSpeak(pick, o.event || 'idle', {});
      if (text) markSpoke(pick.id);
      return text;
    } catch (e) {
      console.warn('[宠物说话] 巡视出错:', (e && e.message) || e);
      return null;
    }
  }

  /** PWA 被唤醒 → 立刻补一句（用户原话「重新打开 App → 立刻让宠物说一句」） */
  async function speakOnWake() {
    try {
      return await patrolTick({ force: true, event: 'idle' });
    } catch (e) {
      return null;
    }
  }

  // ============================================================
  // 8. 导出
  // ============================================================

  window.PetSpeech = {
    // 纯规则（测试用）
    rules: {
      IQ_STAGES,
      iqFor,
      isEggPet,
      traitDesc,
      personalityLines,
      relationLine,
      eventLine,
      stateLine,
      buildSpeechPrompt,
      extractText,
      TOPIC_MENU
    },
    // 流程
    petSpeak,
    patrolTick,
    startPatrol,
    stopPatrol,
    speakOnWake,
    showBubble,
    hideBubble,
    isBubbleActive,
    desktopPetVisible,
    speechEnabled,
    chatInsertEnabled,
    recentChatLines,
    lastSpokeAt,
    markSpoke
  };
})();

/* ====================================================================
 * 通用 MCP 工具桥接 (Tool Bridge)
 *
 * 跟糯米机 utils/mcpToolBridge.ts + useChatAI.ts 的 vanilla JS 版
 *
 * 不依赖 330 原 minified 代码：
 *   - 通过 window.fetch hook 拦截 /v1/chat/completions 请求
 *   - 把所有 enabled MCP server 的 tools 合并成 OpenAI function-calling 格式
 *   - 跨 server 重名自动加 <serverSlug>_ 前缀
 *   - LLM 返回 tool_calls 时自动循环调 McpGenericClient.callTool
 *   - 工具结果以 tool 消息回填 messages 继续循环, 直至 finish_reason != 'tool_calls'
 *   - 把每次工具调用的结果写成一条 mcp_card (server 维度), 渲染用于 UI
 *
 * 跟旧 mcd/luckin 版的差异:
 *   - 去掉 McdClient / LuckinClient 硬编码引用
 *   - 去掉 brand-specific (McdEmoji / LuckinEmoji / McdTriggers / LuckinTriggers)
 *   - 去掉 brand-specific system prompt (McdBridgePrompt / LuckinBridgePrompt)
 *   - 改用 McpGenericClient.getEnabledServers() 拿所有 enabled server
 *   - 改用 McpGenericClient.callTool(server, toolName, args) 路由工具调用
 *   - 卡片/进度事件用 serverName 替代 brand
 *
 * 暴露: window.McpBridge
 *   - onCard(fn) / onProgress(fn)     ← UI 监听
 *   - getCardHistory() / clearCardHistory()
 *   - installHook() / uninstallHook()
 *   - getStatus() / resetAll()        ← 诊断
 *   - getEnabledServerCount()         ← UI 显示 MCP 状态
 *   - isAvailable()                   ← UI 判断要不要激活
 *
 * 依赖: McpGenericClient (必须先加载)
 * ==================================================================== */

(function (global) {
    'use strict';

    // ========== 常量 ==========

    const MCP_RESULT_MAX_CHARS = 20_000;
    const CARD_HISTORY_KEY = 'aphone.mcp.lastCards';
    const MAX_CARD_HISTORY = 12;
    const TOOL_LOOP_MAX = 6;

    // ========== 工具命名 (跟糯米机 sanitizeToolName / serverSlug 等价) ==========

    function sanitizeToolName(name) {
        return (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
    }
    function serverSlug(server) {
        return sanitizeToolName(server && server.name).slice(0, 20) || 'srv';
    }

    // ========== 合并多 server 的 tools + resolve map ==========

    /**
     * 聚合当前可见 server 的所有 tools 成 OpenAI function-calling 格式
     * 跨 server 重名自动加 <serverSlug>_ 前缀; resolve map 记录 exposed name → 真实 server+tool
     */
    function buildMcpOpenAITools() {
        if (!global.McpGenericClient) return { tools: [], resolve: new Map() };
        const servers = global.McpGenericClient.getEnabledServers();
        const tools = [];
        const resolve = new Map();
        const multi = servers.length > 1;
        for (let si = 0; si < servers.length; si++) {
            const server = servers[si];
            const list = Array.isArray(server.tools) ? server.tools : [];
            for (let ti = 0; ti < list.length; ti++) {
                const t = list[ti];
                if (!t || !t.name) continue;
                let exposed = sanitizeToolName(t.name);
                if (resolve.has(exposed)) {
                    let baseExposed = sanitizeToolName(serverSlug(server) + '_' + t.name);
                    exposed = baseExposed;
                    let i = 2;
                    while (resolve.has(exposed)) {
                        exposed = sanitizeToolName(serverSlug(server) + '_' + t.name + '_' + (i++));
                    }
                }
                resolve.set(exposed, { server: server, toolName: t.name });
                const desc = (t.description || '').trim();
                tools.push({
                    type: 'function',
                    function: {
                        name: exposed,
                        description: multi ? ('[' + server.name + '] ' + desc) : desc,
                        parameters: t.inputSchema || { type: 'object', properties: {} },
                    },
                });
            }
        }
        return { tools: tools, resolve: resolve };
    }

    // ========== System prompt 注入 ==========

    function buildMcpSystemBlock() {
        if (!global.McpGenericClient) return '';
        const servers = global.McpGenericClient.getEnabledServers();
        if (!servers.length) return '';
        const lines = servers.map(function (s) {
            const names = (s.tools || []).map(function (t) { return t.name; }).filter(Boolean).join(', ');
            return '- ' + s.name + ': ' + (names || '(无工具)');
        });
        // 端点使用教程 (按 server.url 识别, 只 include 已知 MCP 服务的踩坑指南, 避免 context 爆炸)
        const guides = servers.map(function (s) { return getServerUsageGuide(s.url); }).filter(Boolean);
        const guideText = guides.length
            ? '\n\n**端点使用教程** (踩过的坑, 不同模型都按这个调):\n' + guides.join('\n\n')
            : '';
        return '\n\n---\n' +
            '[外部工具已接入] 用户在设置里给你接了 MCP 工具服务器。\n\n' +
            '**核心**: 你还是原来的角色、原来的语气、原来的记忆。工具只是你顺手能用的能力, **每轮都要有角色化的文本**, 别乾巴巴复报结果。\n' +
            '可用工具来源:\n' + lines.join('\n') + '\n\n' +
            '**使用规则**:\n' +
            '- 需要时直接调工具（系统会自动执行并把结果给你），不需要时正常聊天。**别硬凑理由调工具**。\n' +
            '- 工具必须通过系统的 function calling 接口发起, **绝对不要把工具名和参数写进聊天正文**（比如输出 `工具名(参数)` 这种文字），用户会看到乱码一样的东西。\n' +
            '- 工具结果只写与对话相关的部分, 用角色语气转述, **别整段复述 JSON**。\n' +
            '- 工具失败就如实说, 并根据报错调整参数重试或换个方法, **别编造结果**。\n' +
            '- 涉及真实世界副作用的操作（发布内容、下单、删除等），先跟用户确认一句再动手。' +
            guideText + '\n---\n';
    }

    // ========== 端点使用教程 (按 server.url 匹配, 注入到 system prompt) ==========
    // 解决不同模型调工具能力差异大问题 (Gemini 漏参数, Deepseek 流程不对, M3 较稳) —
    // 把踩过的坑明确写出来, 三个模型都按这个调

    const SERVER_USAGE_GUIDES = [
        {
            match: 'mcp.mcd.cn',
            guide: '【麦当劳 MCP 调用流程 (2026-08-02 按官方文档 https://open.mcd.cn/mcp/guide.md 重写, 共 21 个工具)】\n' +
                '⚠️ 协议版本: 文档说支持 2025-06-18 及之前, 330 用 2024-11-05 兼容, 实测 work\n' +
                '⚠️ 限流: 600 次/分钟/Token, 超了返 429\n' +
                '\n' +
                '========== 到店自提 / 得来速流程 ==========\n' +
                '① 查门店 query-nearby-stores(beType=1到店自提/5得来速, searchType=2按位置, city+keyword):\n' +
                '   · keyword 填地址或店名都行 (如 "青羊区洛阳路" / "青龙街餐厅"), 内部自动 geocoding + 距离排序\n' +
                '   · ⚠️ 实测 longitude/latitude 全 0.0 (坐标脱敏防爬), 别靠坐标判断距离, 靠返回的 distance 字段\n' +
                '   · 返 storeCode + businessStartTime/EndTime (营业时段, 0:00-24:00 是 24h店) + distance, 记 storeCode\n' +
                '② 查菜单 query-meals(storeCode, orderType=1堂食/2外送, beType):\n' +
                '   · ⚠️ 凌晨/非营业时段必加 reservationDate="yyyy-MM-dd HH:mm" (不带秒!), 否则返"门店已关闭" code:600057\n' +
                '   · 到店自提: orderType=1, beType=1, 不传 beCode / 得来速: orderType=1, beType=5, 传 beCode (从步骤①拿)\n' +
                '   · 返 14 个分类 116 个餐品, 每项有 mealCode + price + tags\n' +
                '③ (可选) 查套餐详情 query-meal-detail(mealCode): 套餐组成 / 默认选择 / 配料, 复杂套餐才需要\n' +
                '④ 算价 calculate-price(选中的商品列表, 优惠券ID?): 返 amount / 优惠 / 应付\n' +
                '⑤ 下单 create-order(有副作用, 必先跟用户确认整份订单): 返订单详情 + 支付链接. 系统会自动 inline 渲染支付卡片, AI 自由发挥确认话术, **不要复述链接/描述支付方式/复述订单内容** —— 那是系统渲染的\n' +
                '\n' +
                '========== 外送流程 ==========\n' +
                '① 查用户地址 delivery-query-addresses: 看用户已有的可配送地址 (可跳过)\n' +
                '② (首次/换地址) 新增地址 delivery-create-address(联系人, 电话, 地址详情): 创建配送地址\n' +
                '③ 查可配送门店 delivery-query-stores(用户地址ID): 外送场景下, 哪些门店能配送到这个地址\n' +
                '④ 查菜单 query-meals(storeCode, orderType=2外送, beType): 同到店流程, 但 orderType 改 2\n' +
                '⑤ 算价 + 下单 (同上)\n' +
                '\n' +
                '========== 优惠券工具 ==========\n' +
                '· query-store-coupons(storeCode): 当前门店可用券 (下单时挑哪张)\n' +
                '· available-coupons: 麦麦省可领取的券 (营销活动)\n' +
                '· auto-bind-coupons: 一键领所有当前可用的麦麦省券 (用户说"把能领的券都领了"用这个)\n' +
                '· query-my-coupons: 我的所有券 (跟 query-store-coupons 区别: 后者限定当前门店)\n' +
                '\n' +
                '========== 订单管理 ==========\n' +
                '· create-order: 下单 (有副作用, 必先确认)\n' +
                '· query-order(orderId): 查订单状态 / 取餐码 / 配送信息 — 文档里有, 不是没做!\n' +
                '· 文档没列 cancel-order 工具, 取消订单走 query-order 看实际状态再告知用户怎么操作\n' +
                '\n' +
                '========== 辅助工具 ==========\n' +
                '· now-time-info: 当前时间 — 调 reservationDate 前先拿时间 (避免用错日期)\n' +
                '· list-nutrition-foods: 餐品营养信息 (能量/蛋白/脂肪/碳水/钠/钙)\n' +
                '· campaign-calendar: 当月营销活动日历\n' +
                '· query-meal-assistance: 企业团餐助餐服务 (个人用户用不到)\n' +
                '· query-my-account: 我的积分账户信息\n' +
                '· mall-points-products: 麦麦商城可积分兑换的餐品券\n' +
                '· mall-product-detail(productId): 积分兑换商品详情\n' +
                '· mall-create-order: 积分兑换下单 (有副作用)\n' +
                '\n' +
                '========== 数据依赖链 ==========\n' +
                '· storeCode (query-nearby-stores/delivery-query-stores → query-meals/calculate-price/create-order)\n' +
                '· mealCode (query-meals → query-meal-detail/calculate-price/create-order)\n' +
                '· 用户地址ID (delivery-query-stores → 外送下单)\n' +
                '· orderId (create-order → query-order)'
        },
        {
            match: 'lkcoffee.com',
            guide: '【瑞幸 MCP 完整调用流程】 (按顺序, 别跳步; 必填参数漏了会返 code:1000 非法参数)\n' +
                '① 查门店 queryShopList(longitude, latitude): 必填经纬度, 没 city/keyword 字段. 没经纬度先用高德 geocode("地址") 拿. 返 deptId (不是 storeCode) + workTimeStart/End\n' +
                '② 搜商品 searchProductForMcp(deptId, query): 必填 2 个, 缺一非法参数. query 是用户原始文本 (如 "生椰拿铁"). 没"列全量菜单"工具, 搜啥返啥, 2-3 个最相关就是真没货, 别瞎试\n' +
                '③ 切属性 switchProduct(deptId, productId, skuCode, attrOperationParam, amount): 必填 5 个, attrOperationParam = { attributeId: 属性组ID, subAttr: { attributeId: 属性值ID, operation: 3(选中) } }\n' +
                '④ 查详情 queryProductDetailInfo(deptId, productId): 拿完整 productAttrs + 价格\n' +
                '⑤ 算价 previewOrder(deptId, productList: [{amount, productId, skuCode}]): 必填 2 个, 返 discountPrice(实付价) + couponCodeList\n' +
                '⑥ 下单 createOrder(deptId, productList, longitude, latitude, couponCodeList?, remark?): ⚠️ longitude/latitude 必填, couponCodeList 从 ⑤ 拿 (选哪张传哪张), 返 payOrderUrl + payOrderQrCodeUrl. 系统会自动 inline 渲染支付卡片 (含可点链接 + 二维码), AI 自由发挥确认话术, **不要复述链接/解释二维码/复述订单内容** —— 那是系统渲染的\n' +
                '   · 副作用大, 必先跟用户确认 (商品/数量/价格/优惠券/备注) 再调\n' +
                '⑦ 查订单 queryOrderDetailInfo(orderId): orderStatus 10待付/20下单/30制作/60取餐/80完成/100取消, 60 时 takeMealCodeInfo.code 是取餐码, 告诉用户\n' +
                '⑧ 取消 cancelOrder(orderId): 仅待付/下单状态能取消\n' +
                '⚠️ 数据依赖链: deptId (①→所有) / productId+skuCode (②→③④⑤⑥) / couponCodeList (⑤→⑥)'
        },
        {
            match: 'mcp.amap.com',
            guide: '【高德 MCP 调用流程】 (2026-08-01 实测, 部分端点 MCP 有 bug)\n' +
                '✅ WORK 的端点 (实测正常):\n' +
                '① 算距离 maps_distance(origins, destination, type): type 1驾车/2直线/3步行 (string!), 返 {results: [{origin_id, dest_id, distance, duration}]}\n' +
                '② 查经纬度 maps_geo(address, city?): 必填 address, city 选填提高精度. ⚠️ MCP 端点偶发 ENGINE_RESPONSE_DATA_ERROR, 失败让用户调高德 REST API 兜底 (https://restapi.amap.com/v3/geocode/geo?address=...&key=...)\n' +
                '③ 逆地址解析 maps_regeocode(location): 必填 location (经纬度)\n' +
                '④ 路径规划: walking/driving/bicycling(origin, destination) / transit_integrated(origin, destination, city, cityd) — 后者还要起终点城市名\n' +
                '⑤ IP 定位 maps_ip_location(ip)\n' +
                '❌ 端点 BUG (实测, MCP 端点坏, 2026-08-01 测两 key 都坏):\n' +
                '· maps_text_search (返空) / maps_around_search (返空) / maps_weather (返 null)\n' +
                '· 这 3 个别走 MCP, 让用户调高德 REST API: https://restapi.amap.com/v3/place/text?keywords=...&city=...&key=... (POI 搜索) / .../v3/place/around?keywords=...&location=...&key=... (周边) / .../v3/weather/weatherInfo?city=...&key=... (天气)\n' +
                '⚠️ 数据依赖: 大多数工具必填经纬度 (lng,lat), 没经纬度先调 maps_geo. location 字段统一 "lng,lat" 字符串 (不是 lat,lng). 距离/方向/逆地址都靠经纬度串联'
        },
    ];

    function getServerUsageGuide(url) {
        if (!url || typeof url !== 'string') return null;
        const u = url.toLowerCase();
        for (let i = 0; i < SERVER_USAGE_GUIDES.length; i++) {
            if (u.indexOf(SERVER_USAGE_GUIDES[i].match) >= 0) return SERVER_USAGE_GUIDES[i].guide;
        }
        return null;
    }

    const MCP_TAIL_REMINDER = '[MCP 工具 ON · 永远用角色语气回复别空回; 工具只能走 function calling 接口、严禁写成正文文字; 工具结果别整段复述 JSON; 有副作用的操作先确认再执行]';

    // ========== 工具结果格式化 ==========

    function formatMcpToolResult(data) {
        let s;
        try { s = typeof data === 'string' ? data : JSON.stringify(data); }
        catch (e) { s = String(data); }
        if (s && s.length > MCP_RESULT_MAX_CHARS) {
            return s.slice(0, MCP_RESULT_MAX_CHARS) + '…[结果过长已截断 · 全文共 ' + s.length + ' 字符]';
        }
        return s;
    }

    // ========== 通用工具摘要 (基于工具名关键词, 不基于 brand) ==========

    function summarizeToolAction(toolName, args) {
        const n = String(toolName || '').toLowerCase();
        if (/search|query_|find|filter/.test(n)) return '🔍 查询';
        if (/create|publish|post|send|submit|write|upload/.test(n)) return '📝 创建/发布';
        if (/update|edit|modify|set_|change/.test(n)) return '✏️ 更新';
        if (/delete|remove|cancel|drop|unsubscribe/.test(n)) return '🗑️ 删除/取消';
        if (/^list|^get_.*list|browse|recommend|all_/.test(n)) return '📋 拉列表';
        if (/detail|^get_.*info|^get_.*by|view|read/.test(n)) return '🔎 看详情';
        if (/like|love|favor|collect|favorite|star|bookmark/.test(n)) return '❤️ 收藏/点赞';
        if (/comment|reply|message/.test(n)) return '💬 评论/回复';
        if (/login|auth|sign|oauth/.test(n)) return '🔐 登录';
        if (/order|pay|checkout|cart|purchase/.test(n)) return '🧾 订单/支付';
        if (/price|calculate|estimate|cost/.test(n)) return '💰 算价';
        if (/address|delivery|location/.test(n)) return '📍 地址/位置';
        if (/coupon|voucher|discount|promo/.test(n)) return '🎟️ 优惠/券';
        return '⚙️ ' + toolName;
    }

    function summarizeToolResult(toolName, callResult) {
        if (!callResult || !callResult.success) {
            return '❌ ' + ((callResult && callResult.error) || '失败');
        }
        const data = callResult.data;
        if (data == null) return '✓ 完成';
        if (typeof data === 'string') {
            const t = data.trim();
            if (t.length > 60) return '✓ 完成 (' + t.length + ' 字符)';
            return '✓ ' + t;
        }
        if (Array.isArray(data)) {
            return '✓ 拿到 ' + data.length + ' 条';
        }
        if (typeof data === 'object') {
            const keys = Object.keys(data);
            return '✓ 完成 (' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '') + ')';
        }
        return '✓ 完成';
    }

    // ========== 卡片 / 进度事件总线 ==========

    const cardListeners = [];
    function onCard(fn) { cardListeners.push(fn); }
    function emitCardMessage(server, toolName, args, result) {
        const card = {
            serverId: server && server.id,
            serverName: server && server.name,
            toolName: toolName,
            args: args,
            result: result,
            ts: Date.now(),
        };
        for (let i = 0; i < cardListeners.length; i++) {
            try { cardListeners[i](card); } catch (e) { console.warn('[McpBridge] card listener err', e); }
        }
        saveCardToHistory(card);
    }

    const progressListeners = [];
    function onProgress(fn) { progressListeners.push(fn); }
    function emitProgress(progress) {
        progress.ts = progress.ts || Date.now();
        for (let i = 0; i < progressListeners.length; i++) {
            try { progressListeners[i](progress); } catch (e) { console.warn('[McpBridge] progress listener err', e); }
        }
    }

    function saveCardToHistory(card) {
        try {
            const raw = localStorage.getItem(CARD_HISTORY_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return;
            arr.push(card);
            while (arr.length > MAX_CARD_HISTORY) arr.shift();
            localStorage.setItem(CARD_HISTORY_KEY, JSON.stringify(arr));
        } catch (e) {}
    }
    function getCardHistory() {
        try {
            const raw = localStorage.getItem(CARD_HISTORY_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function clearCardHistory() {
        try { localStorage.removeItem(CARD_HISTORY_KEY); } catch (e) {}
    }

    // ========== 工具循环 (fetch hook 注入处) ==========

    function safeParseJson(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    // ========== Gemini 原生 API 格式转换 (OpenAI ↔ Gemini) ==========
    // 解决 Gemini 直连原生 API (:generateContent) 看不到工具的 bug
    // 策略: Gemini body → OpenAI body → 复用 OpenAI 内部逻辑 → OpenAI response → Gemini response
    // 工具结果按 Gemini 风格 role:function + parts:[{functionResponse}] 存

    function isGeminiNativeRequest(url) {
        if (typeof url !== 'string') return false;
        if (url.indexOf('generativelanguage.googleapis.com') < 0) return false;
        // OpenAI 兼容端点走老逻辑, 不算原生
        if (url.indexOf('/v1beta/openai/chat/completions') >= 0) return false;
        return true;
    }

    // 2026-08-05 v0.1.75: 删 Gemini schema 转换函数 (convertSchemaToGemini / openAIToolsToGemini)
    //   和 formatGeminiFunctionResponseContent — Gemini 调工具功能放弃 (user 决定), Gemini native 永远 bypass
    //   普通聊天 + 视频/语音 + 总结记忆 走 Gemini native, 调工具走 M3 / Gemini OpenAI 兼容端点
    //   (v0.1.71 试过, 提示词污染 + role:'function' 400 + 调用工具时间掐断, 试了 2 天问题没修干净, 认命回退)

    function wrapAsJsonResp(data, originalResp) {
        const status = originalResp ? originalResp.status : 200;
        const statusText = originalResp ? originalResp.statusText : 'OK';
        const headers = originalResp ? originalResp.headers : new Headers();
        return new Response(JSON.stringify(data), {
            status: status,
            statusText: statusText,
            headers: headers,
        });
    }

    // 2026-08-05 v0.1.75: 删 runChatWithToolLoopGemini (v0.1.71 写, 试了 2 天修不干净)
    //   Gemini native 调工具问题:
    //     1. 提示词里的工具列表会影响 AI, 不要求调工具也会调, 然后报错
    //     2. role:'function' 报 400 (虽然 v0.1.74 修了, 但还有别的问题)
    //     3. 调工具时间一长就被 _patch_ai_timeout.js 掐断 (虽然 v0.1.72 改了 10 分钟, 仍然不够稳)
    //     4. 流式 + 调工具没做, 普通聊天 stream=true 走 v0.1.69 bypass 不会触发
    //   user 决定: 放弃 Gemini 调工具, 走 v0.1.69 行为 — Gemini native 永远 bypass
    //   调工具用 M3 / Gemini OpenAI 兼容端点 / 公益站 (这些都是 OpenAI 风格, 走 runChatWithToolLoop)

    // ========== Gemini 调工具 ==========

    // type 大写 (Gemini proto3 枚举要求 STRING/INTEGER/OBJECT, OpenAI 给小写)
    function convertSchemaToGemini(schema) {
        if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
        const typeMap = {
            'string': 'STRING', 'number': 'NUMBER', 'integer': 'INTEGER',
            'boolean': 'BOOLEAN', 'object': 'OBJECT', 'array': 'ARRAY',
            'STRING': 'STRING', 'NUMBER': 'NUMBER', 'INTEGER': 'INTEGER',
            'BOOLEAN': 'BOOLEAN', 'OBJECT': 'OBJECT', 'ARRAY': 'ARRAY',
        };
        const rawType = schema.type || 'object';
        const out = { type: typeMap[String(rawType).toLowerCase()] || 'TYPE_UNSPECIFIED' };
        if (schema.description) out.description = schema.description;
        if (Array.isArray(schema.enum)) {
            out.enum = schema.enum.map(function (v) { return String(v); });
        }
        if (schema.properties) {
            out.properties = {};
            for (const k in schema.properties) {
                out.properties[k] = convertSchemaToGemini(schema.properties[k]);
            }
        }
        if (Array.isArray(schema.required)) out.required = schema.required;
        if (schema.items) out.items = convertSchemaToGemini(schema.items);
        return out;
    }

    // OpenAI function-calling tools[] → Gemini tools[{functionDeclarations}]
    function openAIToolsToGemini(openAITools) {
        const declarations = (openAITools || []).map(function (t) {
            if (!t || t.type !== 'function') return null;
            const f = t.function || {};
            return {
                name: f.name,
                description: f.description || '',
                parameters: convertSchemaToGemini(f.parameters || { type: 'object', properties: {} })
            };
        }).filter(Boolean);
        if (!declarations.length) return undefined;
        return [{ functionDeclarations: declarations }];
    }

    // 工具结果 → JSON Object 包装 (Gemini functionResponse.response 必须 object, 塞 string 必 400)
    function formatGeminiFunctionResponseContent(callResult) {
        if (!callResult || !callResult.success) {
            return { success: false, error: (callResult && callResult.error) || '工具调用失败' };
        }
        return { success: true, result: formatMcpToolResult(callResult.data) };
    }

    // OpenAI messages → Gemini {contents, systemText} (第一版只处理 system/user/assistant 纯文本)
    function convertOpenAIMessagesToGemini(messages) {
        const contents = [];
        let systemText = '';
        for (const m of (messages || [])) {
            if (!m || !m.role) continue;
            if (m.role === 'system' || m.role === 'developer') {
                systemText += (systemText ? '\n\n' : '') + (m.content || '');
            } else if (m.role === 'user') {
                contents.push({ role: 'user', parts: [{ text: String(m.content || '') }] });
            } else if (m.role === 'assistant') {
                contents.push({ role: 'model', parts: [{ text: String(m.content || '') }] });
            }
        }
        return { contents: contents, systemText: systemText };
    }

    // Gemini native 调工具主循环 (systemInstruction 顶级字段 + 每轮 90s 独立 timer + functionResponse.response 严格 object)
    async function runChatWithToolLoopGemini(url, init) {
        if (!global.McpGenericClient) return (originalFetch || fetch)(url, init);
        const built = buildMcpOpenAITools();
        const tools = built.tools;
        const resolve = built.resolve;
        if (!tools.length) return (originalFetch || fetch)(url, init);

        let baseBody;
        try { baseBody = JSON.parse(init.body); }
        catch (e) { return (originalFetch || fetch)(url, init); }

        const append = buildMcpSystemBlock() + '\n' + MCP_TAIL_REMINDER;
        // 2026-08-26 fix: ai-response.js 调 Gemini 时 body 已经是 Gemini 格式 ({contents:[...]}),
        // 不是 OpenAI 格式 ({messages:[...]}). 直接用 + 添加工具, 不要走 OpenAI 转换 (会拿不到 contents)
        let geminiBody;
        if (Array.isArray(baseBody.contents)) {
            geminiBody = Object.assign({}, baseBody);
            geminiBody.tools = openAIToolsToGemini(tools);
            const origText = (geminiBody.systemInstruction && geminiBody.systemInstruction.parts && geminiBody.systemInstruction.parts[0] && geminiBody.systemInstruction.parts[0].text) || '';
            geminiBody.systemInstruction = { parts: [{ text: (origText ? origText + '\n\n' : '') + append }] };
        } else {
            const converted = convertOpenAIMessagesToGemini(baseBody.messages);
            geminiBody = {
                contents: converted.contents,
                systemInstruction: { parts: [{ text: (converted.systemText ? converted.systemText + '\n\n' : '') + append }] },
                tools: openAIToolsToGemini(tools),
            };
        }

        const fetchForLLM = originalFetch || fetch;
        const SINGLE_ROUND_TIMEOUT_MS = 90000;
        let iteration = 0;
        let lastRespData = null;
        let lastResp = null;
        emitProgress({ phase: 'session_start', summary: 'Gemini 已合并 ' + tools.length + ' 个 MCP 工具' });

        while (iteration < TOOL_LOOP_MAX) {
            iteration++;
            const controller = new AbortController();
            const externalSignal = init && init.signal;
            const onExternalAbort = () => { try { controller.abort(); } catch (e) {} };
            if (externalSignal) {
                if (externalSignal.aborted) {
                    const err = new Error('aborted'); err.name = 'AbortError'; throw err;
                }
                externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            }
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SINGLE_ROUND_TIMEOUT_MS);

            try {
                const iterHeaders = Object.assign({ 'Content-Type': 'application/json' }, (init && init.headers) || {});
                const resp = await fetchForLLM(url, {
                    method: 'POST',
                    headers: iterHeaders,
                    body: JSON.stringify(geminiBody),
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
                lastResp = resp;
                if (!resp.ok) return resp;
                const data = await resp.json();
                lastRespData = data;

                const candidate = data.candidates && data.candidates[0];
                if (!candidate) {
                    emitProgress({ phase: 'session_done', summary: 'Gemini 响应无 candidate' });
                    return wrapAsJsonResp(data, resp);
                }
                const parts = (candidate.content && candidate.content.parts) || [];
                const functionCalls = parts.filter(p => p && p.functionCall);
                if (functionCalls.length === 0) {
                    emitProgress({ phase: 'session_done', summary: 'AI 已完成' });
                    return wrapAsJsonResp(data, resp);
                }

                // 把整轮 model parts 推回 (含 text + functionCall + thoughtSignature, 按 Gemini 响应顺序)
                // Gemini 2.5+/3.x: thoughtSignature 必须完整保留回传 (part 级别), 否则下一轮 400 'missing thought_signature'
                const modelParts = [];
                for (const p of parts) {
                    if (p && p.text !== undefined) {
                        const part = { text: p.text };
                        if (p.thoughtSignature) part.thoughtSignature = p.thoughtSignature;
                        modelParts.push(part);
                    } else if (p && p.functionCall) {
                        const part = { functionCall: { name: p.functionCall.name, args: p.functionCall.args || {} } };
                        if (p.thoughtSignature) part.thoughtSignature = p.thoughtSignature;
                        modelParts.push(part);
                    }
                }
                geminiBody.contents.push({ role: 'model', parts: modelParts });

                // 调所有工具, 收集 functionResponse parts (按 Gemini 响应顺序, response 严格 object)
                const functionResponseParts = [];
                for (const fc of functionCalls) {
                    const fn = fc.functionCall.name;
                    const args = fc.functionCall.args || {};
                    const resolved = resolve.get(fn);
                    if (!resolved) {
                        emitProgress({ phase: 'tool_err', toolName: fn, summary: '工具未注册: ' + fn });
                        functionResponseParts.push({
                            functionResponse: { name: fn, response: { success: false, error: '工具未注册: ' + fn } }
                        });
                        continue;
                    }
                    emitProgress({ phase: 'tool_start', toolName: fn, summary: summarizeToolAction(resolved.toolName, args) });
                    let callResult;
                    try {
                        callResult = await global.McpGenericClient.callTool(resolved.server, resolved.toolName, args);
                    } catch (e) {
                        callResult = { success: false, error: '工具调用异常: ' + ((e && e.message) || String(e)) };
                    }
                    emitCardMessage(resolved.server, resolved.toolName, args, callResult);
                    emitProgress({
                        phase: callResult.success ? 'tool_ok' : 'tool_err',
                        toolName: fn,
                        summary: callResult.success
                            ? summarizeToolResult(resolved.toolName, callResult)
                            : ('失败: ' + (callResult.error || '')).slice(0, 80),
                    });
                    functionResponseParts.push({
                        functionResponse: {
                            name: resolved.toolName,
                            response: formatGeminiFunctionResponseContent(callResult),
                        }
                    });
                }
                geminiBody.contents.push({ role: 'user', parts: functionResponseParts });
            } catch (err) {
                clearTimeout(timer);
                if (err && err.name === 'AbortError') {
                    if (timedOut) {
                        emitProgress({ phase: 'session_done', summary: 'Gemini 单轮超时, 回退无工具模式' });
                        return (originalFetch || fetch)(url, init);
                    }
                    throw err;
                }
                throw err;
            }
        }
        emitProgress({ phase: 'session_done', summary: '达到工具循环上限, 安全退出' });
        return wrapAsJsonResp(lastRespData || { error: 'no_response' }, lastResp);
    }

    async function runChatWithToolLoop(url, options) {
        if (!global.McpGenericClient) {
            return (originalFetch || fetch)(url, options);
        }

        try {
            const built = buildMcpOpenAITools();
            const tools = built.tools;
            const resolve = built.resolve;
            if (!tools.length) {
                return (originalFetch || fetch)(url, options);
            }

            const baseBody = safeParseJson(options && options.body) || {};
            baseBody.tools = (Array.isArray(baseBody.tools) ? baseBody.tools : []).concat(tools);
            const append = buildMcpSystemBlock() + '\n' + MCP_TAIL_REMINDER;
            if (Array.isArray(baseBody.messages)) {
                baseBody.messages = baseBody.messages.map(function (m) {
                    if (m.role === 'system' || m.role === 'developer') {
                        return Object.assign({}, m, { content: (m.content || '') + append });
                    }
                    return m;
                });
                if (!baseBody.messages.some(function (m) { return m.role === 'system' || m.role === 'developer'; })) {
                    baseBody.messages.unshift({ role: 'system', content: append.trim() });
                }
            }

            const newOpts = Object.assign({}, options, {
                body: JSON.stringify(baseBody),
                headers: Object.assign({}, options.headers || {}, { 'Content-Type': 'application/json' }),
            });

            let iteration = 0;
            let conversationMessages = baseBody.messages.slice();
            let lastAssistant = null;

            emitProgress({ phase: 'session_start', summary: '已合并 ' + tools.length + ' 个 MCP 工具' });

            const fetchForLLM = originalFetch || fetch;
            while (iteration < TOOL_LOOP_MAX) {
                iteration++;
                const reqBody = Object.assign({}, baseBody, { messages: conversationMessages });
                const iterOpts = Object.assign({}, newOpts, { body: JSON.stringify(reqBody) });
                const resp = await fetchForLLM(url, iterOpts);
                if (!resp.ok) {
                    emitProgress({ phase: 'session_done', summary: 'LLM 接口返回 ' + resp.status });
                    return resp;
                }
                const data = await resp.json();
                if (!data || !data.choices || !data.choices[0]) {
                    emitProgress({ phase: 'session_done', summary: 'LLM 响应异常' });
                    return wrapAsJsonResp(data, resp);
                }

                const msg = data.choices[0].message;
                lastAssistant = msg;
                const toolCalls = msg.tool_calls || [];
                if (!toolCalls.length) {
                    emitProgress({ phase: 'session_done', summary: 'AI 已完成' });
                    return wrapAsJsonResp(data, resp);
                }

                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const fn = (tc.function && tc.function.name) || '';
                    let args = {};
                    try {
                        args = (tc.function && tc.function.arguments) ? JSON.parse(tc.function.arguments) : {};
                    } catch (e) { args = {}; }

                    const resolved = resolve.get(fn);
                    if (!resolved) {
                        // LLM 编了不存在的工具, 报告并跳过
                        emitProgress({ phase: 'tool_err', toolName: fn, summary: '工具未注册: ' + fn });
                        conversationMessages.push(msg);
                        conversationMessages.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            content: 'error: 工具 ' + fn + ' 未在当前会话注册, 请用 resolve map 里有的工具名',
                        });
                        continue;
                    }

                    emitProgress({ phase: 'tool_start', toolName: fn, summary: summarizeToolAction(resolved.toolName, args) });

                    let callResult;
                    try {
                        callResult = await global.McpGenericClient.callTool(resolved.server, resolved.toolName, args);
                    } catch (toolErr) {
                        callResult = { success: false, error: '工具调用异常: ' + ((toolErr && toolErr.message) || String(toolErr)) };
                    }
                    emitCardMessage(resolved.server, resolved.toolName, args, callResult);

                    emitProgress({
                        phase: callResult.success ? 'tool_ok' : 'tool_err',
                        toolName: fn,
                        summary: callResult.success
                            ? summarizeToolResult(resolved.toolName, callResult)
                            : ('失败: ' + ((callResult.error || '')).slice(0, 80)),
                    });

                    conversationMessages.push(msg);
                    conversationMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: callResult.success
                            ? formatMcpToolResult(callResult.data)
                            : ('error: ' + callResult.error),
                    });
                }
            }

            emitProgress({ phase: 'session_done', summary: '达到工具循环上限, 安全退出' });
            return wrapAsJsonResp({ choices: [{ message: lastAssistant }], usage: {} }, null);
        } catch (loopErr) {
            console.error('[McpBridge] runChatWithToolLoop 完全失败, 回退原 fetch:', loopErr);
            lastPreloadError = { message: '工具循环异常: ' + ((loopErr && loopErr.message) || String(loopErr)), at: Date.now() };
            try { emitProgress({ phase: 'session_done', summary: '工具循环异常, 回退无工具模式' }); }
            catch (e) {}
            return (originalFetch || fetch)(url, options);
        }
    }

    // ========== fetch hook ==========

    let originalFetch = null;
    let hookInstalled = false;
    // [2026-11-26 谷歌直连 Key 池] hookActive + wrappedFetchRef：
    // 卸载时如果 window.fetch 已经被别的包装叠在上面（Key 池的拦截器就是），
    // 直接还原成 originalFetch 会把人家的包装抹掉 → 故障转移失效。
    // 所以改成「只关行为（hookActive=false），window.fetch 是不是自己的才还原」。
    let hookActive = false;
    let wrappedFetchRef = null;
    let lastPreloadError = { message: null, at: 0 };
    let lastInterceptLog = [];

    function pushIntercept(entry) {
        entry.t = Date.now();
        lastInterceptLog.unshift(entry);
        while (lastInterceptLog.length > 5) lastInterceptLog.pop();
    }
    function describeUrl(url) {
        try { return String(url).replace(/^https?:\/\//, '').split('?')[0]; }
        catch (e) { return String(url); }
    }
    function isLLMRequest(url) {
        // 2026-07-31: 用户 API proxyUrl 都带 /v1, 实际 URL 是 /v1/chat/completions, 老匹配就是对的
        // 不动用户接口补全规则, 老逻辑保留
        if (typeof url !== 'string') return false;
        // 1. OpenAI 风格 (老规则, 不动 — M3/MiniMax/Deepseek 都用)
        if (url.indexOf('/v1/chat/completions') >= 0) return true;
        // 2. Gemini OpenAI 兼容端点 (新增, 2026-08-01, Gemini 直连修)
        if (url.indexOf('/v1beta/openai/chat/completions') >= 0) return true;
        // 3. Gemini 原生 API 域名 (新增, 2026-08-01, Gemini 直连修)
        if (url.indexOf('generativelanguage.googleapis.com') >= 0) return true;
        return false;
    }

    function installHook() {
        if (hookInstalled) return;
        if (!global.McpGenericClient) {
            console.warn('[McpBridge] McpGenericClient 未加载, 推迟 hook 安装');
            return false;
        }
        originalFetch = window.fetch;
        wrappedFetchRef = async function (input, init) {
            // [2026-11-26 Key池] 已卸载 → 不再拦截，直接放行（但仍留在 fetch 链里，
            // 避免把叠在上面的别的包装抹掉）
            if (!hookActive) return originalFetch.apply(this, arguments);
            const url = (typeof input === 'string' ? input : (input && input.url)) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';

            // 拦截判断 (按优先级, 越前越安全):
            // 1. 非 POST 请求 (GET/HEAD 等) 跳过
            // 2. 非 LLM 请求 (不是 /v1/chat/completions 或 Gemini 端点) 跳过
            // 3. Gemini 原生 API 端点 → 永远 bypass (v0.1.75 回退, 试了 2 天 Gemini 调工具修不干净)
            //    普通聊天 + 视频/语音 + 总结记忆 全部走 Gemini native, 不调工具
            //    调工具用 M3 / Gemini OpenAI 兼容端点 / 公益站 (走下面分支)
            // 4. 其他 LLM 端点 (OpenAI 风格 / Gemini OpenAI 兼容) + 工具 ON → 调 runChatWithToolLoop (老逻辑)
            if (method.toUpperCase() !== 'POST') {
                return originalFetch.apply(this, arguments);
            }
            if (!isLLMRequest(url)) {
                return originalFetch.apply(this, arguments);
            }
            if (isGeminiNativeRequest(url)) {
                try {
                    return await runChatWithToolLoopGemini(url, init);
                } catch (geminiLoopErr) {
                    console.error('[McpBridge] Gemini 工具循环异常, 回退无工具模式:', geminiLoopErr);
                    try { emitProgress({ phase: 'session_done', summary: 'Gemini 循环异常, 回退' }); } catch (e) {}
                    return originalFetch.apply(this, arguments);
                }
            }

            const servers = global.McpGenericClient.getEnabledServers();
            const toolsReady = servers.length > 0;
            pushIntercept({
                at: 'hook',
                kind: toolsReady ? 'intercepted' : 'no-tools',
                url: describeUrl(url),
                toolsReady: toolsReady,
                serverCount: servers.length,
                mode: 'openai'
            });

            if (toolsReady) {
                try {
                    return await runChatWithToolLoop(url, init);
                } catch (e) {
                    console.warn('[McpBridge] 工具循环出错, 回退原 fetch:', e);
                    return originalFetch.apply(this, arguments);
                }
            }
            return originalFetch.apply(this, arguments);
        };
        const wrappedFetch = wrappedFetchRef;

        let installErr = null;
        try {
            window.fetch = wrappedFetch;
        } catch (e) {
            installErr = e;
            try {
                Object.defineProperty(window, 'fetch', {
                    value: wrappedFetch,
                    writable: true,
                    configurable: true,
                });
            } catch (e2) {
                console.warn('[McpBridge] 装 fetch hook 双 fallback 都失败:', e2);
                lastPreloadError = { message: 'fetch hook install failed: ' + ((e2 && e2.message) || String(e2)), at: Date.now() };
                return false;
            }
        }
        hookActive = true;
        hookInstalled = true;
        console.log('[McpBridge] fetch hook 已安装 (通用 MCP, mode=' + (installErr ? 'defineProperty' : 'direct') + ')');
        return true;
    }

    function uninstallHook() {
        if (!hookInstalled) return;
        // [2026-11-26 Key池] 先关行为；只有 window.fetch 还是自己的包装时才还原，
        // 否则会把别人叠在上面的包装抹掉。
        hookActive = false;
        if (originalFetch && window.fetch === wrappedFetchRef) {
            try { window.fetch = originalFetch; }
            catch (e) {
                try { Object.defineProperty(window, 'fetch', { value: originalFetch, writable: true, configurable: true }); }
                catch (e2) { console.warn('[McpBridge] uninstallHook 失败:', e2); }
            }
        }
        hookInstalled = false;
        console.log('[McpBridge] fetch hook 已卸载');
    }

    // ========== 诊断 ==========

    function getStatus() {
        const all = (global.McpGenericClient && global.McpGenericClient.loadServers) ? global.McpGenericClient.loadServers() : [];
        const enabled = (global.McpGenericClient && global.McpGenericClient.getEnabledServers) ? global.McpGenericClient.getEnabledServers() : [];
        return {
            bridge: !!global.McpGenericClient && !!global.McpBridge,
            client: !!global.McpGenericClient,
            totalServers: all.length,
            enabledServers: enabled.length,
            enabledList: enabled.map(function (s) {
                return { id: s.id, name: s.name, toolsCount: (s.tools || []).length };
            }),
            hookInstalled: hookInstalled,
            useNativeTools: (global.McpGenericClient && global.McpGenericClient.getUseNativeTools) ? global.McpGenericClient.getUseNativeTools() : true,
            recentIntercept: lastInterceptLog.slice(0, 5),
            lastPreloadError: lastPreloadError,
        };
    }

    function resetAll() {
        try {
            if (global.McpGenericClient) {
                const all = global.McpGenericClient.loadServers();
                for (let i = 0; i < all.length; i++) {
                    global.McpGenericClient.resetSession(all[i].id);
                }
            }
            uninstallHook();
            lastInterceptLog = [];
            lastPreloadError = { message: null, at: 0 };
            console.log('[McpBridge] all reset (保留 user config / enabled 状态)');
        } catch (e) {
            console.warn('[McpBridge] reset error:', e);
        }
    }

    // ========== 暴露 API ==========

    global.McpBridge = {
        VERSION: 'v1.0.0-generic',
        isHookInstalled: function () { return hookInstalled; },
        installHook: installHook,
        uninstallHook: uninstallHook,

        // 事件
        onCard: onCard,
        onProgress: onProgress,
        getCardHistory: getCardHistory,
        clearCardHistory: clearCardHistory,

        // UI 状态
        getEnabledServerCount: function () {
            return global.McpGenericClient ? global.McpGenericClient.getEnabledServers().length : 0;
        },
        isAvailable: function () {
            return global.McpGenericClient ? global.McpGenericClient.isAvailable() : false;
        },
        getEnabledServers: function () {
            return global.McpGenericClient ? global.McpGenericClient.getEnabledServers() : [];
        },

        // 诊断
        getStatus: getStatus,
        resetAll: resetAll,
        lastInterceptLog: lastInterceptLog,
    };

    // ========== 自动安装 hook (等 McpGenericClient 加载完) ==========
    // 跟旧版不同: 旧版等用户点工具栏按钮再装; 新版只要 McpGenericClient 加载就装
    // 因为 "启用 server = 自动激活" 的新语义下, hook 总是应该就绪
    function tryInstall() {
        if (global.McpGenericClient) {
            installHook();
            return;
        }
        setTimeout(tryInstall, 100);
    }
    if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInstall, 50); });
    } else {
        setTimeout(tryInstall, 50);
    }

    console.log('[McpBridge] 通用 MCP 工具桥接已加载 (依赖 McpGenericClient)');

})(typeof window !== 'undefined' ? window : globalThis);

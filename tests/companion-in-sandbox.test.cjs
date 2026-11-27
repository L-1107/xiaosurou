// ============================================================
// tests/companion-in-sandbox.test.cjs
// 「桌宠 + 悬浮球 跟着用户进影院 / 读书屋」的回归测试 (2026-11-26)
//
// 跑法: node tests/companion-in-sandbox.test.cjs
//
// 【用户原话】
//   「那个宠物桌宠哦还有外面的悬浮球能也一起放进影院和图书馆吗, 跟用户一起,
//     用户进影院, 这两个也进」
//   「本来隐藏宿主页是为了避免影院和图书馆发烫, 只把这两放进来会不会导致
//     使用影院和图书馆的时候手机发烫呢? 这个问题先搞清楚」
//   「现在的意思是, 宿主的任何东西都进不来, 所以你打算在沙盒里复刻这两样是吗?
//     那宠物被摸回话的时候收到的上文要和外面一样哦」
//
// 【本测试守什么】
//   ① 两个沙盒都加载了 companion-layer (js + css), 并用正确的 ns 初始化
//   ② 宿主把桌宠信息下发给沙盒 (同一只宠物: 同 id / 同名字 / 同一张图)
//   ③ 沙盒里的照顾动作 (摸摸/喂食/陪玩) 交回宿主执行, 结果回传给沙盒提示
//   ④ ★ 宠物【说的话】必须由宿主生成 —— 沙盒里不许有任何"自己造台词"的路径
//      (这一条是用户明确要求的: 收到的上文要和外面一样)
//   ⑤ 宠物说话时沙盒冒气泡 (看得见它在说话)
//   ⑥ ★ 不发烫: 宿主静默规则一个字没动, iframe 的 z-index 没降级,
//      陪伴件是画在沙盒里面的 (不新增合成图层), 空闲时没有持续开销
//   ⑦ 桌面可见性误判修好了 (宿主静默时 toast 兜底要能触发)
//   ⑧ 陪伴件的 z-index 高过沙盒自己的面板, 但低于读书屋的模态浮层
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');
const exists = (rel) => fs.existsSync(P(...rel.split('/')));

/**
 * 去掉注释再判断。
 * ⚠️ 这几个文件的注释里【故意】写了很多关键词 (messageStore / PetSpeech.petSpeak /
 *   requestAnimationFrame / #floating-ball …) —— 那是给人看的说明, 不是代码路径。
 *   直接全文匹配会把注释当成"沙盒自己造台词", 那是误判。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

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
// ① 沙盒加载陪伴件
// ============================================================
section('① 两个沙盒都加载了 companion-layer');
{
  const cinema = read('cinema-sandbox/index.html');
  const reading = read('reading-sandbox/index.html');

  check('文件都在', exists('modules/companion-layer.js') && exists('css/companion-layer.css'),
    'modules/companion-layer.js + css/companion-layer.css');

  check('影院沙盒引了 companion-layer.js',
    /<script src="\.\.\/modules\/companion-layer\.js\?v=/.test(cinema));
  check('影院沙盒引了 companion-layer.css',
    /<link rel="stylesheet" href="\.\.\/css\/companion-layer\.css\?v=/.test(cinema));
  check('读书屋沙盒引了 companion-layer.js',
    /<script src="\.\.\/modules\/companion-layer\.js\?v=/.test(reading));
  check('读书屋沙盒引了 companion-layer.css',
    /<link rel="stylesheet" href="\.\.\/css\/companion-layer\.css\?v=/.test(reading));

  check('影院用 ns=cinema 初始化', /CompanionLayer\.init\(\{[\s\S]{0,120}ns:\s*'cinema'/.test(cinema));
  check('读书屋用 ns=reading 初始化', /CompanionLayer\.init\(\{[\s\S]{0,120}ns:\s*'reading'/.test(reading));

  // 两个沙盒的 ?v= 要一致 —— 不一致就会出现"一边新一边旧"
  const cv = (cinema.match(/companion-layer\.js\?v=([\d.]+)/) || [])[1];
  const rv = (reading.match(/companion-layer\.js\?v=([\d.]+)/) || [])[1];
  check('两个沙盒的 ?v= 一致', cv && cv === rv, 'cinema=' + cv + ' reading=' + rv);
}

// ============================================================
// ② 宿主下发桌宠信息
// ============================================================
section('② 宿主把桌宠下发给沙盒');
{
  const pet = read('modules/pet-nest.js');
  const cinema = read('modules/cinema-room.js');
  const reading = read('modules/reading-room.js');

  check('PetNest 导出了 desktopPetInfo', /desktopPetInfo:\s*desktopPetInfo/.test(pet));
  check('desktopPetInfo 带 id / name / spriteUrl',
    /function desktopPetInfo\(\)[\s\S]{0,1400}spriteUrl:\s*abs/.test(pet) &&
    /id:\s*pet\.id/.test(pet) && /name:\s*pet\.name/.test(pet));
  check('静态资源转成了绝对地址 (沙盒在子目录, 相对路径会 404)',
    /new URL\(url,\s*href\)\.href/.test(pet));

  check('影院宿主会发 cinema:companion',
    /type:\s*'cinema:companion'/.test(cinema) && /function sendCompanion\(\)/.test(cinema));
  check('读书屋宿主会发 reading:companion',
    /type:\s*'reading:companion'/.test(reading) && /function sendCompanion\(\)/.test(reading));
  check('两边的下发都取自 PetNest.desktopPetInfo()',
    /desktopPetInfo\(\)/.test(cinema) && /desktopPetInfo\(\)/.test(reading));

  check('iframe 加载完就会下发 (不用等用户干点什么)',
    /frame\.addEventListener\('load'[\s\S]{0,120}sendCompanion\(\)/.test(cinema) &&
    /frame\.addEventListener\('load'[\s\S]{0,120}sendCompanion\(\)/.test(reading));
}

// ============================================================
// ③ 动作回宿主
// ============================================================
section('③ 沙盒里的动作交回宿主做');
{
  const cinema = read('modules/cinema-room.js');
  const reading = read('modules/reading-room.js');
  const pet = read('modules/pet-nest.js');

  check('影院收 cinema:petAction', /d\.type === 'cinema:petAction'/.test(cinema));
  check('影院收 cinema:ballAction', /d\.type === 'cinema:ballAction'/.test(cinema));
  check('读书屋收 reading:petAction', /case 'reading:petAction'/.test(reading));
  check('读书屋收 reading:ballAction', /case 'reading:ballAction'/.test(reading));

  check('照顾动作走宿主的 quickCare', /quickCare\(action,\s*\{\s*silent:\s*true\s*\}/.test(cinema) &&
    /quickCare\(action,\s*\{\s*silent:\s*true\s*\}/.test(reading));
  check('silent: true —— 宿主那条 toast 在 iframe 底下, 用户看不见',
    /silent:\s*true/.test(cinema) && /silent:\s*true/.test(reading));
  check('结果回传给沙盒 (沙盒自己提示)',
    /cinema:petActionResult/.test(cinema) && /reading:petActionResult/.test(reading));

  check('悬浮球菜单动作交给宿主的 FloatingBall.handleMenuAction',
    /FloatingBall[\s\S]{0,400}handleMenuAction\(action\)/.test(cinema) &&
    /FloatingBall[\s\S]{0,400}handleMenuAction\(action\)/.test(reading));

  check('quickCare 支持安静模式 (不弹宿主 toast)',
    /async function quickCare\(action,\s*opts\)/.test(pet) && /if \(!o\.silent\) showToastSafe/.test(pet));
  check('quickCare 会把结果返回给调用方',
    /return \{ ok: true, status: receipt\.status, message: msg \}/.test(pet));

  check('floating-ball.js 暴露了 window.FloatingBall',
    /window\.FloatingBall\s*=\s*\{/.test(read('modules/floating-ball.js')));
  check('暴露的接口里有 handleMenuAction 和 syncFromStorage',
    /handleMenuAction:\s*handleMenuAction/.test(read('modules/floating-ball.js')) &&
    /syncFromStorage:\s*syncFromStorage/.test(read('modules/floating-ball.js')));
}

// ============================================================
// ④ ★ 宠物说的话必须由宿主生成 (用户明确要求: 上文跟外面一样)
// ============================================================
section('④ ★ 宠物的话只能由宿主说, 沙盒不许自己造');
{
  const layer = stripComments(read('modules/companion-layer.js'));

  check('沙盒层里没有任何模型调用', !/fetch\s*\(|XMLHttpRequest|EventSource/.test(layer));
  check('沙盒层里没有调用模型的那套东西',
    !/petSpeak|buildSpeechPrompt|callModel|chatCompletion|apiKey/i.test(layer));
  check('沙盒层里没有直接落库',
    !/messageStore|Dexie|indexedDB|PetNestDB/.test(layer));

  check('沙盒层只把动作交回宿主 (postMessage)', /postToHost\(\{\s*type:\s*S\.ns\s*\+\s*':petAction'/.test(layer));
  check('沙盒层只把悬浮球动作交回宿主', /postToHost\(\{\s*type:\s*S\.ns\s*\+\s*':ballAction'/.test(layer));

  // 宠物的上文: 宿主那边取的是真实聊天记录
  const speech = read('modules/pet-speech.js');
  check('宿主取上文用的是真实聊天记录 (messageStore.getRecentMessages)',
    /messageStore\.getRecentMessages\(chat\.id/.test(speech));
  check('宿主的 petSpeak 还在原地 (没有被搬走)',
    /async function petSpeak\(petRow, event, opts\)/.test(speech));

  // 照顾成功 → 宠物自己说一句 (这条链路没被改)
  const pet = read('modules/pet-nest.js');
  check('照顾成功后宠物会自己开口 (care → petSpeak)',
    /status === 'fed' \|\| status === 'played' \|\| status === 'comforted'[\s\S]{0,200}PetSpeech\.petSpeak/.test(pet));
}

// ============================================================
// ⑤ 说话时冒气泡
// ============================================================
section('⑤ 宠物说话时沙盒冒气泡');
{
  const layer = read('modules/companion-layer.js');
  const cinema = read('cinema-sandbox/index.html');
  const reading = read('modules/reading-sandbox.js');

  check('沙盒层有 say() (只显示, 不落库)', /function say\(petName, text\)/.test(layer) &&
    /showBubble\('🐾 ' \+ name \+ '：' \+ body\)/.test(layer));
  check('气泡挂在桌宠头顶 (沙盒层建 DOM, CSS 定位置)',
    /cx-pet-bubble/.test(layer) && /#cx-pet-bubble\s*\{[\s\S]{0,200}bottom:\s*100%/.test(read('css/companion-layer.css')));

  check('影院收到 petSay 会冒气泡', /CompanionLayer\.say\(d\.petName,\s*d\.text\)/.test(cinema));
  check('读书屋收到 petSay 会冒气泡', /CompanionLayer\.say\(d\.petName,\s*d\.text\)/.test(reading));
}

// ============================================================
// ⑥ ★ 不发烫
// ============================================================
section('⑥ ★ 不发烫 (结构性保证)');
{
  const layer = stripComments(read('modules/companion-layer.js'));
  const cssRaw = read('css/companion-layer.css');
  const css = stripComments(cssRaw);
  const cinemaCss = read('modules/cinema-room.css');
  const mainCss = read('css/main-ui.css');
  const cinemaJs = read('modules/cinema-room.js');

  // ① 宿主静默规则一个字没动 (这是 2026-11-05 / 11-19 两次实测换来的)
  check('影院宿主静默规则还在 (桌宠/悬浮球照旧藏起来)',
    /body\.cinema-room-active #pn-desktop-pet/.test(cinemaCss) &&
    /body\.cinema-room-active #floating-ball/.test(cinemaCss));
  check('读书屋宿主静默规则还在',
    /body\.reading-room-active #pn-desktop-pet/.test(mainCss) &&
    /body\.reading-room-active #floating-ball/.test(mainCss));

  // ② iframe 的 z-index 没降级 (降了宿主就能浮上来 = 又变成"宿主+iframe 叠加")
  check('影院 iframe 的 z-index 还是 2147483647 (没降级)',
    /z-index:2147483647/.test(cinemaJs));
  check('读书屋 iframe 的 z-index 还是 2147483647 (没降级)',
    /z-index:2147483647/.test(read('modules/reading-room.js')));

  // ③ 陪伴件画在沙盒里 → 不新增合成图层
  check('陪伴件用的是 cx- 前缀的独立 id (没有复活宿主那两个元素)',
    /#cx-pet/.test(css) && /#cx-ball/.test(css) &&
    !/#pn-desktop-pet\s*\{/.test(css) && !/#floating-ball\s*\{/.test(css));
  check('沙盒层里没有把宿主那两个元素改回可见',
    !/pn-desktop-pet[^\n]*display:\s*(block|flex)/.test(css) &&
    !/floating-ball[^\n]*display:\s*(block|flex)/.test(css));

  // ④ 空闲开销
  check('沙盒层里没有 setInterval 跑模型 (只有换帧)', /setInterval/.test(layer) &&
    /frameMs:\s*5200/.test(layer));
  check('沙盒层里没有 requestAnimationFrame', !/requestAnimationFrame/.test(layer));
  check('换帧定时器只换 background-position (不重绘)',
    /backgroundPosition = \(col \* 50\) \+ '% ' \+ \(row \* 100\) \+ '%'/.test(layer));

  // ⑤ 桌宠动画只有 transform / opacity → GPU 合成, 不触发 layout/paint
  const breathe = (css.match(/@keyframes pn-breathe \{[\s\S]*?\}/) || [''])[0];
  check('呼吸动画只动 transform (不触发 layout/paint)',
    /transform/.test(breathe) &&
    !/background|box-shadow|filter|width|height|top|left/.test(breathe),
    breathe.replace(/\s+/g, ' ').slice(0, 70));
  check('桌宠很小 (98px, 跟宿主一致)', /--cx-pet-size:\s*98px/.test(css));
}

// ============================================================
// ⑦ 桌面可见性误判
// ============================================================
section('⑦ 桌宠可见性判断修好了');
{
  const speech = read('modules/pet-speech.js');
  check('desktopPetVisible 查了计算样式 (不只看 hidden 属性)',
    /function desktopPetVisible\(\)[\s\S]{0,900}getComputedStyle/.test(speech));
  check('display:none / visibility:hidden 都算"看不见"',
    /cs\.display === 'none' \|\| cs\.visibility === 'hidden'/.test(speech));
}

// ============================================================
// ⑧ z-index 层级
// ============================================================
section('⑧ 陪伴件的层级');
{
  const css = read('css/companion-layer.css');
  const z = (re) => {
    const m = css.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  const petZ = z(/#cx-pet \{[\s\S]{0,400}?z-index:\s*(\d+)/);
  const ballZ = z(/#cx-ball \{[\s\S]{0,400}?z-index:\s*(\d+)/);
  const menuZ = z(/\.cx-ball-menu \{[\s\S]{0,400}?z-index:\s*(\d+)/);

  check('桌宠高于影院顶栏 (99996)', petZ > 99996, 'z=' + petZ);
  check('悬浮球高于影院顶栏 (99996)', ballZ > 99996, 'z=' + ballZ);
  check('菜单高于读书屋的悬浮按钮 (2147483000)', menuZ > 2147483000, 'z=' + menuZ);
  check('但低于读书屋的换封面浮层 (2147483200) —— 模态还是盖得住',
    petZ < 2147483200 && ballZ < 2147483200 && menuZ < 2147483200);
  check('没有超过 int32 上限', petZ < 2147483647 && ballZ < 2147483647 && menuZ < 2147483647);
}

// ============================================================
// ⑨ 交互: 点桌宠开菜单 / 菜单按钮转交宿主 / 气泡不和菜单打架
//    (这几个是 2026-11-26 真机点出来才发现的, 不锁住以后会被改回去)
// ============================================================
section('⑨ 桌宠交互 (真机点出来的坑)');
{
  const layer = read('modules/companion-layer.js');
  const click = (layer.match(/D\.pet\.addEventListener\('click'[\s\S]*?\n    \}\);/) || [''])[0];

  check('点桌宠本身要能开/收菜单 (不是只认菜单里的按钮)',
    /D\.petMenu\.hidden = !D\.petMenu\.hidden/.test(click),
    click ? 'click 处理 ' + click.length + ' 字符' : '没找到 click 处理');
  check('菜单按钮的委托判断在"切菜单"之前 (否则菜单里点啥都点不动)',
    click.indexOf("closest('#cx-pet-menu .cx-menu-act')") > -1 &&
    click.indexOf("closest('#cx-pet-menu .cx-menu-act')") < click.indexOf('D.petMenu.hidden = !D.petMenu.hidden'));
  check('点宠物下方的透明区域不弹菜单 (精灵图是六格图集)',
    /pointOnPet\(e\.clientX, e\.clientY\)/.test(click));
  check('菜单按钮按 data-act 分发', /getAttribute\('data-act'\)/.test(click));

  check('菜单开着的时候不冒气泡 (两个都在头顶, 会叠在一起)',
    /if \(D\.petMenu && !D\.petMenu\.hidden\) return;/.test(layer));
  check('打开菜单时把气泡收掉',
    /if \(D\.petMenu && !D\.petMenu\.hidden\) hideBubble\(\);/.test(layer));

  check('桌宠开关跟宿主共用一份 localStorage',
    /petVisible: 'petNestDesktopPetVisible'/.test(layer) &&
    /global\.localStorage\.setItem\(KEYS\.petVisible, 'false'\)/.test(layer));
  check('宿主把桌宠藏了, 沙盒里也不冒出来',
    /S\.petVisible = global\.localStorage\.getItem\(KEYS\.petVisible\) !== 'false'/.test(layer) &&
    /if \(!S\.petVisible\) \{ hidePet\(\); return; \}/.test(layer));
}

// ============================================================
console.log('\n========================================');
console.log('  通过 ' + passed + ' / 失败 ' + failed);
if (failed) {
  console.log('__FAILURES__');
  console.log('  ✗ ' + failed + ' 条没过');
}
console.log('========================================');
process.exit(failed ? 1 : 0);

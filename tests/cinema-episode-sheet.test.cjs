// ============================================================
// tests/cinema-episode-sheet.test.cjs
// 短剧「选集面板」最后几排点不到的回归测试
//
// 跑法: node tests/cinema-episode-sheet.test.cjs
//
// 【背景】(2026-10-23)
//   用户报: 短剧「兽世女配」148 集, 选集面板只显示到 73–96 集,
//   第 97 集起被手机底部边框(home indicator)盖住, 往上拉也拉不动。
//
//   真因不是 CSS, 是【HTML 嵌套错位】:
//   .cinema-episode-sheet(选集面板)被写在了 .cinema-source-sheet(添加影片面板)
//   【里面】。添加影片面板关掉时是 transform: translateY(100%)(滑出屏幕),
//   选集面板作为它的子元素被【整体一起下移了自身高度】——
//   实测整个面板底边落到屏幕外 319px, 最后几排按钮永远在可视区之外。
//
//   修法: 把 .cinema-source-sheet 的收尾 </div> 上移, 让选集面板变成
//   .cinema-room 的【直接子元素】。bottom:0 这时以房间为基准,
//   面板底边贴住房间底部, 集数在 grid 内部滚动, 最后几排能点到。
//
// 【本测试守什么】
//   ① 结构: 选集面板必须是 .cinema-room 的直接子元素, 不能被塞进别的面板里
//      (嵌套一改回来, 面板就被那个面板的 translateY 拖出屏幕)
//   ② CSS: 面板 position:absolute + bottom:0, 集数区 overflow-y:auto
//      (贴房间底 + 内部可滚, 两个条件缺一个都会复现)
//   ③ JS: 打开选集面板的顺序 —— 先加 .open 再关添加影片面板
//
// 【为什么用"自己解析 HTML"而不是 jsdom】
//   项目里没有 jsdom 依赖。ROOM_HTML 是我们自己生成的、结构规整的 HTML,
//   一个标签栈解析器就够用了, 不引入新依赖。
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ROOM_JS = path.join(ROOT, 'modules', 'cinema-room.js');
const ROOM_CSS = path.join(ROOT, 'modules', 'cinema-room.css');

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
// 从 cinema-room.js 里把 ROOM_HTML 取出来
// ============================================================
// CINEMA_ICON 是个纯对象, ROOM_HTML 是个纯字符串数组,
// 所以这两段可以单独抽出来在 vm 里求值, 不用跑整个模块。
function extractRoomHtml() {
  const src = fs.readFileSync(ROOM_JS, 'utf8');
  const lines = src.split(/\r?\n/);

  const start = lines.findIndex((l) => /const\s+CINEMA_ICON\s*=\s*\{/.test(l));
  if (start < 0) throw new Error('没找到 CINEMA_ICON 定义');

  // ROOM_HTML 数组的收尾是 "].join('\n');"
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (/^\s*\]\.join\(/i.test(lines[i])) { end = i; break; }
  }
  if (end < 0) throw new Error('没找到 ROOM_HTML 数组的收尾');

  const block = lines.slice(start, end + 1).join('\n');
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(block + '\n;this.__ROOM_HTML = ROOM_HTML;', sandbox, { timeout: 5000 });
  if (typeof sandbox.__ROOM_HTML !== 'string') throw new Error('ROOM_HTML 不是字符串');
  return sandbox.__ROOM_HTML;
}

// ============================================================
// 极简 HTML 标签栈解析器 —— 只为算祖先链
// ============================================================
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  let cur = root;

  const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].indexOf('<!--') === 0) continue;

    if (m[1]) {
      // 收尾标签 —— 弹到匹配的那个
      const want = m[1].toLowerCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === want) {
          stack.length = i;
          cur = stack[i - 1];
          break;
        }
      }
      continue;
    }

    const tag = m[2].toLowerCase();
    const attrs = {};
    const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)(?=\s|$)/g;
    let a;
    while ((a = attrRe.exec(m[3] || '')) !== null) {
      if (a[1]) attrs[a[1].toLowerCase()] = a[2];
      else if (a[3]) attrs[a[3].toLowerCase()] = '';
    }

    const node = { tag: tag, attrs: attrs, children: [], parent: cur };
    cur.children.push(node);

    const selfClosed = m[4] === '/';
    if (!selfClosed && !VOID_TAGS.has(tag)) {
      stack.push(node);
      cur = node;
    }
  }

  return { root: root, unclosed: stack.slice(1).map((n) => n.tag + (n.attrs.id ? '#' + n.attrs.id : '')) };
}

function findById(root, id) {
  if (root.attrs && root.attrs.id === id) return root;
  for (const c of root.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

function ancestorIds(node) {
  const out = [];
  let p = node.parent;
  while (p) {
    if (p.attrs && p.attrs.id) out.push(p.attrs.id);
    p = p.parent;
  }
  return out;
}

function isDescendantOf(node, maybeAncestor) {
  let p = node.parent;
  while (p) {
    if (p === maybeAncestor) return true;
    p = p.parent;
  }
  return false;
}

// ============================================================
// CSS: 解析成规则表, 按【完整选择器】取规则体
// ============================================================
// ⚠️ 不能直接用正则找 ".cinema-episode-sheet {" ——
//   前面还有 ".cinema-room.kb-open .cinema-episode-sheet {" 这种复合选择器,
//   会被先匹配到, 拿到的是另一条规则的内容。
//   所以这里把 CSS 拆成 (选择器们, 声明体) 的列表, 再按逗号拆开逐个比。
function parseCssRules(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

function cssRule(rules, selector) {
  for (const r of rules) {
    const parts = r.selector.split(',').map((s) => s.trim());
    if (parts.indexOf(selector) >= 0) return r.body;
  }
  return null;
}

function cssHas(body, prop, value) {
  if (!body) return false;
  const decls = body.split(';');
  for (const d of decls) {
    const m = d.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1].toLowerCase() === prop.toLowerCase() && m[2].toLowerCase() === value.toLowerCase()) return true;
  }
  return false;
}

// ============================================================
function main() {
  const html = extractRoomHtml();
  const css = fs.readFileSync(ROOM_CSS, 'utf8');
  const rules = parseCssRules(css);
  const parsed = parseHtml(html);

  // ------------------------------------------------------------
  section('① HTML 结构 —— 选集面板必须是房间的直接子元素');
  {
    const room = findById(parsed.root, 'cinema-room');
    const sheet = findById(parsed.root, 'cinema-episode-sheet');
    const srcSheet = findById(parsed.root, 'cinema-source-sheet');

    check('能找到 #cinema-room', !!room);
    check('能找到 #cinema-episode-sheet', !!sheet);
    check('能找到 #cinema-source-sheet', !!srcSheet);

    if (room && sheet) {
      const anc = ancestorIds(sheet);
      check('选集面板的父元素就是 #cinema-room',
        anc.length >= 1 && anc[0] === 'cinema-room',
        '祖先链=' + (anc.join(' > ') || '(无)'));
    }

    if (sheet && srcSheet) {
      check('选集面板【不在】添加影片面板里面',
        !isDescendantOf(sheet, srcSheet),
        'isDescendant=' + isDescendantOf(sheet, srcSheet));
    }

    if (srcSheet && room) {
      const anc = ancestorIds(srcSheet);
      check('添加影片面板也是 #cinema-room 的直接子元素',
        anc.length >= 1 && anc[0] === 'cinema-room',
        '祖先链=' + (anc.join(' > ') || '(无)'));
    }
  }

  // ------------------------------------------------------------
  section('② 三个底部面板层级一致');
  {
    // 剧情记忆面板 / 设置面板本来就该跟选集面板一样挂在房间底下
    const ids = ['cinema-episode-sheet', 'cinema-plot-sheet', 'cinema-settings-sheet', 'cinema-source-sheet'];
    for (const id of ids) {
      const node = findById(parsed.root, id);
      if (!node) { fail('能找到 #' + id); continue; }
      const anc = ancestorIds(node);
      check('#' + id + ' 直接挂在 #cinema-room 下',
        anc.length >= 1 && anc[0] === 'cinema-room',
        '祖先链=' + (anc.join(' > ') || '(无)'));
    }
  }

  // ------------------------------------------------------------
  section('③ 标签全部闭合（改嵌套最容易漏掉收尾 </div>）');
  {
    check('没有没闭合的标签', parsed.unclosed.length === 0,
      parsed.unclosed.length ? '漏了: ' + parsed.unclosed.join(', ') : '');
  }

  // ------------------------------------------------------------
  section('④ CSS —— 面板贴房间底 + 集数区可滚');
  {
    const sheetBody = cssRule(rules, '.cinema-episode-sheet');
    check('找得到 .cinema-episode-sheet 规则', !!sheetBody);
    if (sheetBody) {
      check('面板 position: absolute', cssHas(sheetBody, 'position', 'absolute'));
      check('面板 bottom: 0（以房间为基准贴底）', cssHas(sheetBody, 'bottom', '0'));
      check('面板是 flex 列（头 + 集数区上下排）', cssHas(sheetBody, 'display', 'flex'));
    }

    const gridBody = cssRule(rules, '.cinema-episode-grid');
    check('找得到 .cinema-episode-grid 规则', !!gridBody);
    if (gridBody) {
      check('集数区 overflow-y: auto（能向上滚）', cssHas(gridBody, 'overflow-y', 'auto'));
      check('集数区 flex: 1（吃掉面板剩余高度，自己滚）', cssHas(gridBody, 'flex', '1'));
    }

    const roomBody = cssRule(rules, '.cinema-room');
    if (roomBody) {
      check('房间自己 overflow: hidden（页面不跟着滚）', cssHas(roomBody, 'overflow', 'hidden'));
    } else {
      fail('找得到 .cinema-room 规则');
    }
  }

  // ------------------------------------------------------------
  section('⑤ JS —— 打开选集面板的顺序');
  {
    const src = fs.readFileSync(ROOM_JS, 'utf8');
    const fnStart = src.indexOf('function openEpisodeSheet');
    const fnEnd = src.indexOf('function renderEpisodeGrid', fnStart);
    const fn = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';

    check('找到 openEpisodeSheet', fnStart >= 0);
    if (fn) {
      const addIdx = fn.indexOf("episodeSheet.classList.add('open')");
      const closeIdx = fn.indexOf('closeSourceSheet()');
      check('先给选集面板加 .open', addIdx >= 0, 'index=' + addIdx);
      check('再关闭添加影片面板', closeIdx >= 0, 'index=' + closeIdx);
      check('顺序对：先开选集面板，后关添加影片面板',
        addIdx >= 0 && closeIdx >= 0 && addIdx < closeIdx);
    }
  }

  // ------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main();

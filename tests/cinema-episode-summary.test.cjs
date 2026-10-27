// ============================================================
// tests/cinema-episode-summary.test.cjs
// 短剧「单集剧情」总结的回归测试 (2026-10-27)
//
// 跑法: node tests/cinema-episode-summary.test.cjs
//
// 【背景】(用户 2026-10-26 实测)
//   "一集短剧看完第一次不总结单集剧情了, 再放一遍又总结了"
//
// 【真因】
//   摘要只有一条通道 (watchSession.pendingSummary)。requestEpisodeSummary
//   抢不到通道就【静默放弃】:
//       if (watchSession.pendingSummary) return Promise.resolve('');
//   没有日志 / 没有重试 / 界面上什么都看不出来, 而 onVideoEnded 还会照样
//   推进 seriesLastEp → 状态条写着"看到第 N 集", 库里其实根本没这一集。
//
//   撞上的元凶是 2026-10-23 新加的「此刻画面」实况: Live 每 30 秒写一句,
//   走的正是同一条通道。短剧一集才 1~2 分钟, 播完那一刻正好撞上在途实况,
//   这一集的单集剧情就被扔了。
//
// 【本测试守什么】
//   ① 通道被占时【等】, 不再静默放弃
//   ② 等不到时要有【看得见】的失败记录 (面板上那行红字)
//   ③ 播完一集时, 在途的【实况】要主动让路 (单集剧情 > 实况)
//   ④ 总结失败时【不】推进"看到第几集"
//   ⑤ 后面补上的成功要把失败记录撤掉
//
// 【手法】
//   从真实源码里抠出这几个函数, 在 vm 沙箱里注入假的 watchSession / S /
//   requestSummary / addEpisodeMemory, 直接跑行为。
//   (跟 tests/cinema-chat.test.cjs 同一套路)
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
// 允许用环境变量指向别的副本 (反向验证时用临时还原出来的 bug 版本跑)
//   CINEMA_LIVE_PATH=... node tests/cinema-episode-summary.test.cjs
const LIVE_PATH = process.env.CINEMA_LIVE_PATH || path.join(ROOT, 'modules', 'cinema-live.js');

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
// 从源码里抠出一个【顶层函数声明】
// 边界 = 下一个同缩进(2 空格)的声明。注释行(  // )不算声明, 所以不会误切。
// ============================================================
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  const rest = src.slice(start + 1);
  const m = rest.match(/\n  (?:function |const |let |var |window\.)/);
  if (!m) return src.slice(start);
  return src.slice(start, start + 1 + m.index);
}

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 沙箱: 抠出来的真函数 + 假的依赖
// ============================================================
function makeLiveSandbox(opts) {
  const o = opts || {};
  const watchSession = {
    kind: 'series',
    pendingSummary: null,
    summaryGhostUntil: 0,
    summaryBusy: false,
    episodeMemories: [],
    episodeErrors: [],
    persistErrors: [],
    seriesLastEp: 0,
    nowPlayingEp: 0,
    seriesTitle: '某部短剧'
  };
  const calls = { requestSummary: [], addEpisodeMemory: [], abort: [], warns: [] };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    Promise: Promise,
    watchSession: watchSession,
    calls: calls,
    // 测试里把这个上限调小, 免得等 25 秒
    EPISODE_SUMMARY_WAIT_MS: o.waitMs === undefined ? 600 : o.waitMs,
    SERIES_EPISODE_HINT: '用 300~400 字写完整。',
    S: {
      _leaving: false,
      enabled: true,
      paused: false,
      client: { isReady: () => true, sendUserText: () => true }
    },
    log: function () {},
    logWarn: function (m) { calls.warns.push(String(m)); },
    renderStatus: function () {},
    renderPlotPanel: function () {},
    stopStageSummary: function () {},
    scheduleStageSummary: function () {},
    markPaused: function () {},
    markPlaying: function () {},
    totalPlayedMs: function () { return 0; },
    runStageSummary: function () { return Promise.resolve(false); },
    maybeMergeSeriesRecap: function () { return Promise.resolve(false); },
    // 假的模型通道
    requestSummary: function (kind, instruction) {
      calls.requestSummary.push({ kind: kind, instruction: instruction });
      if (o.throwOnRequest) return Promise.reject(new Error('模型炸了'));
      var text = o.summaryText === undefined
        ? ('这是第 3 集讲了什么剧情。').repeat(20)
        : o.summaryText;
      return Promise.resolve(text);
    },
    // 假的落库
    addEpisodeMemory: function (ep, text) {
      calls.addEpisodeMemory.push({ ep: ep, text: text });
      if (o.addOk === false) return false;
      if (ep > watchSession.seriesLastEp) watchSession.seriesLastEp = ep;
      return true;
    },
    // 假的作废 (跟真的 abortPendingSummary 一个效果: 清通道 + 开静默窗口)
    abortPendingSummary: function (reason) {
      calls.abort.push(String(reason));
      watchSession.pendingSummary = null;
      watchSession.summaryGhostUntil = Date.now() + 3000;
      return true;
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const src = fs.readFileSync(LIVE_PATH, 'utf8');
  const names = [
    'summaryChannelFree',
    'waitForSummaryChannel',
    'yieldChannelToEpisodeSummary',
    'noteEpisodeFail',
    'clearEpisodeFail',
    'requestEpisodeSummary',
    'doRequestEpisodeSummary',
    'onVideoEnded'
  ];
  const code = names.map((n) => extractFn(src, n)).join('\n\n');
  vm.runInContext(code, sandbox, { filename: 'cinema-live-extracted.js' });

  return { sandbox: sandbox, watchSession: watchSession, calls: calls };
}

// ============================================================
async function main() {
  // ------------------------------------------------------------
  section('① 通道被占时【等】, 不再静默放弃');
  {
    const { sandbox, calls } = makeLiveSandbox({ waitMs: 1500 });
    // 一开始通道被【实况】占着, 300ms 后它自己收尾
    sandbox.watchSession.pendingSummary = { kind: 'live', buffer: '' };
    setTimeout(function () { sandbox.watchSession.pendingSummary = null; }, 300);

    const text = await sandbox.requestEpisodeSummary(3);

    check('等到了通道, 真的发起了单集总结', calls.requestSummary.length === 1,
      'requestSummary 调用 ' + calls.requestSummary.length + ' 次');
    check('用的是 episode 这一路请求',
      calls.requestSummary.length === 1 && calls.requestSummary[0].kind === 'episode');
    check('这一集真的记下来了', calls.addEpisodeMemory.length === 1 &&
      calls.addEpisodeMemory[0].ep === 3);
    check('拿回了正文', typeof text === 'string' && text.length > 0);
  }

  // ------------------------------------------------------------
  section('② 等不到通道 → 放弃但必须【看得见】');
  {
    const { sandbox, watchSession, calls } = makeLiveSandbox({ waitMs: 400 });
    // 通道一直被占着 (模拟阶段摘要/精炼赖着不走)
    sandbox.watchSession.pendingSummary = { kind: 'stage', buffer: '' };

    const text = await sandbox.requestEpisodeSummary(5);

    check('没有发出请求', calls.requestSummary.length === 0);
    check('返回空', text === '');
    check('面板上留了一条失败记录', watchSession.episodeErrors.length === 1,
      'episodeErrors=' + JSON.stringify(watchSession.episodeErrors));
    check('失败记录带集号', watchSession.episodeErrors.length === 1 &&
      watchSession.episodeErrors[0].ep === 5);
    check('失败记录带原因', watchSession.episodeErrors.length === 1 &&
      String(watchSession.episodeErrors[0].msg).length > 0,
      watchSession.episodeErrors.length ? watchSession.episodeErrors[0].msg : '');
  }

  // ------------------------------------------------------------
  section('③ 播完一集: 在途的【实况】要主动让路');
  {
    const { sandbox, calls } = makeLiveSandbox();
    sandbox.watchSession.pendingSummary = { kind: 'live', buffer: '此刻屏幕上是谁' };
    const yielded = sandbox.yieldChannelToEpisodeSummary();
    check('实况被作废了', yielded === true && calls.abort.length === 1,
      calls.abort[0] || '');
    check('通道空出来了', !sandbox.watchSession.pendingSummary);

    sandbox.watchSession.pendingSummary = { kind: 'stage', buffer: '' };
    const notYielded = sandbox.yieldChannelToEpisodeSummary();
    check('阶段摘要不动 (不是实况就别乱动)', notYielded === false && calls.abort.length === 1);
  }

  // ------------------------------------------------------------
  section('④ 总结失败时【不】推进"看到第几集"');
  {
    const { sandbox, watchSession } = makeLiveSandbox({ addOk: false });
    watchSession.nowPlayingEp = 3;
    sandbox.onVideoEnded();
    await tick(80);
    check('失败时 seriesLastEp 没动', watchSession.seriesLastEp === 0,
      'seriesLastEp=' + watchSession.seriesLastEp);
    check('失败留了记录', watchSession.episodeErrors.length === 1);
  }
  {
    const { sandbox, watchSession, calls } = makeLiveSandbox();
    watchSession.nowPlayingEp = 3;
    sandbox.onVideoEnded();
    await tick(80);
    check('成功时 seriesLastEp 推进到这一集', watchSession.seriesLastEp === 3,
      'seriesLastEp=' + watchSession.seriesLastEp);
    check('成功时没有失败记录', watchSession.episodeErrors.length === 0);
    check('确实调了单集总结', calls.requestSummary.length === 1);
  }

  // ------------------------------------------------------------
  section('⑤ 后面补上的成功要把失败记录撤掉');
  {
    const { sandbox, watchSession } = makeLiveSandbox();
    sandbox.noteEpisodeFail(7, '通道被占');
    check('先记上了', watchSession.episodeErrors.length === 1);
    sandbox.clearEpisodeFail(7);
    check('成功后又撤掉了', watchSession.episodeErrors.length === 0);
  }

  // ------------------------------------------------------------
  section('⑥ 面板上要显示"没总结出来"');
  {
    const live = fs.readFileSync(LIVE_PATH, 'utf8');
    check('有 episodeWarnHtml 这一段', live.indexOf('episodeWarnHtml') >= 0);
    check('文案说的是"没总结出来"', live.indexOf('没总结出来') >= 0);
    check('跟"没存进库"是两段 (两种病)', live.indexOf('persistWarnHtml') >= 0 &&
      live.indexOf('没存进库') >= 0);
    check('失败记录有独立的存放处', /episodeErrors:\s*\[\]/.test(live));
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

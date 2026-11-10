// ============================================================
// tests/cinema-backup.test.cjs
// 家庭影院「进备份」这一轮的回归测试
//
// 跑法: node tests/cinema-backup.test.cjs
//
// 【守什么】用户 2026-10-29 原话：
//   「发现一个问题，家庭影院记录是不是没进备份？」
//
//   查出来的事实（_reports/pet-test/check-cinema-backup.cjs 实测）：
//   宿主主库有 6 张影院表，其中两张带二进制 ——
//     cinemaChars { id, image: Blob }  ← 人物立绘 + 房间背景
//     cinemaBlobs { id, file: File }   ← 影片本体
//   备份是 JSON.stringify 出来的 → Blob/File 一律被压成 {}：
//     JSON.stringify({id:'f1', file: new File([..])}) -> {"id":"f1","file":{}}
//   ⇒ 立绘和背景【整个丢掉】，换设备后只剩几个空位。
//
//   这一轮定的规矩：
//     ① 立绘/背景（小，base64 走得动）→ 转 dataURL 带走，导入时还原成 Blob
//     ② 影片本体（可能几百 MB）→ 不进备份，导入时连空壳一起丢掉
//     ③ 所有导出链路都要过滤 cinemaBlobs，所有导入链路都要还原 Blob
//
// 【为什么每条断言都写"缺了也不算崩"】
//   反向验证时（_reports/pet-test/reverse-verify-cinema-backup.cjs）
//   要把代码还原成 bug 版 —— 那时 helper 根本不存在。
//   如果测试直接抛异常，后面的断言一条都跑不到，就只剩"崩了"这一个信号，
//   看不出到底哪几条守住了。所以每条都做存在性保护，缺了只报红这一条。
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

// ---------------------------------------------------------------------------
// 把 backup-import-export.js 装进 vm 沙盒
// ---------------------------------------------------------------------------
function loadBackupModule() {
  const src = read('modules/backup-import-export.js');
  const fakeTable = {
    toArray: async () => [],
    each: async () => {},
    count: async () => 0,
    offset: () => fakeTable,
    limit: () => fakeTable,
    bulkPut: async () => {},
    put: async () => {},
    clear: async () => {}
  };
  const fakeDb = {
    tables: [],
    table: () => fakeTable
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    Blob,
    btoa,
    atob,
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => 'test-uuid-0000' },
    localStorage: {
      _s: {},
      getItem(k) { return k in this._s ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
      key() { return null; },
      length: 0
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { classList: { add() {}, remove() {} } }
    },
    navigator: { userAgent: 'node' },
    fetch: async () => { throw new Error('no fetch in unit test'); },
    db: fakeDb,
    state: {},
    showToast: () => {},
    showCustomAlert: async () => true,
    showCustomConfirm: async () => true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'backup-import-export.js' });
  return { ctx, src };
}

const { ctx, src } = loadBackupModule();

// 存在性保护：helper 没了就只让依赖它的断言报红，别把整个测试带崩
const has = (n) => typeof ctx[n] === 'function';
const H = {
  encode: has('encodeCinemaTable'),
  decode: has('decodeCinemaTable'),
  prepare: has('prepareBackupTablesForImport'),
  skip: has('isCinemaSkipTable'),
  blobTable: has('isCinemaBlobTable')
};
const anyHelper = H.encode || H.decode || H.prepare || H.skip || H.blobTable;

// ---------------------------------------------------------------------------
section('1. 影院 Blob 编解码 —— 立绘能跟着备份走');
// ---------------------------------------------------------------------------

(async function () {
  // 造一张 3x2 的假立绘
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
  const blob = new Blob([bytes], { type: 'image/png' });
  const rows = [
    { id: 'bg', image: blob, updatedAt: 123 },
    { id: 'left', image: blob, x: 10, y: 20, scale: 1.2 }
  ];

  check('helper 存在', H.encode && H.decode && H.prepare && H.skip && H.blobTable,
    'encode=' + H.encode + ' decode=' + H.decode + ' prepare=' + H.prepare);

  let encoded = null;
  if (H.encode) encoded = await ctx.encodeCinemaTable('cinemaChars', rows);

  check('image 变成 base64 dataURL 字符串',
    !!encoded && typeof encoded[0].image === 'string' && encoded[0].image.startsWith('data:image/png;base64,'),
    encoded ? String(encoded[0].image).slice(0, 40) : 'helper 缺失');

  // 关键断言：JSON.stringify 之后不再是 {}
  let json = '{}';
  let parsed = [];
  if (encoded) {
    json = JSON.stringify(encoded);
    parsed = JSON.parse(json);
  }
  check('JSON.stringify 之后 image 不再是 {}',
    !!parsed[0] && parsed[0].image && parsed[0].image !== '{}' && parsed[0].image.length > 20);

  // 守卫: 没 encode 函数时这条恒真, 反向验证时反而会变成"漏网的假绿"
  check('原记录没被就地修改', H.encode && !!rows[0] && rows[0].image instanceof Blob);

  let decoded = null;
  if (H.decode && parsed.length) decoded = await ctx.decodeCinemaTable('cinemaChars', parsed);

  check('还原成 Blob', !!decoded && decoded[0].image instanceof Blob);

  let back = null;
  if (decoded && decoded[0].image instanceof Blob) {
    back = new Uint8Array(await decoded[0].image.arrayBuffer());
  }
  check('字节一模一样', !!back && back.length === bytes.length && back.every((v, i) => v === bytes[i]),
    back ? back.length + ' bytes' : '没还原出来');
  check('位置字段还在', !!decoded && decoded[1].x === 10 && decoded[1].y === 20 && decoded[1].scale === 1.2);
  check('mime 还在', !!decoded && decoded[0].image.type === 'image/png');

  // 非 Blob 表原样返回
  const plain = [{ id: 'c1', text: 'hi' }];
  const same = H.encode ? await ctx.encodeCinemaTable('chats', plain) : null;
  check('非影院表原样返回（同一个引用）', H.encode && same === plain);

  // -------------------------------------------------------------------------
  section('2. 老备份里的空壳会被清掉（不会炸 createObjectURL）');
  // -------------------------------------------------------------------------
  const legacyRows = [{ id: 'bg', image: {}, updatedAt: 1 }, { id: 'left', image: {} }];
  const legacyDecoded = H.decode ? await ctx.decodeCinemaTable('cinemaChars', legacyRows) : null;
  check('空壳 image 字段被清掉',
    !!legacyDecoded && !('image' in legacyDecoded[0]) && !('image' in legacyDecoded[1]));
  check('其余字段保留', !!legacyDecoded && legacyDecoded[0].id === 'bg' && legacyDecoded[0].updatedAt === 1);
  check('清掉之后不再是 truthy 的假图片', !!legacyDecoded && !legacyDecoded[0].image);

  // 已经是 dataURL 的字符串 → 不重复处理
  const alreadyUrl = [{ id: 'bg', image: 'data:image/png;base64,AAAA' }];
  const again = H.decode ? await ctx.decodeCinemaTable('cinemaChars', alreadyUrl) : null;
  check('dataURL 字符串被还原成 Blob', !!again && again[0].image instanceof Blob);

  // 本来就是 Blob（重复导入）→ 不动
  const stillBlob = [{ id: 'bg', image: blob }];
  const keep = H.decode ? await ctx.decodeCinemaTable('cinemaChars', stillBlob) : null;
  check('本来就是 Blob 的不动', !!keep && keep[0].image === blob);

  // -------------------------------------------------------------------------
  section('3. 影片本体不进备份（也不能把 {} 当文件写回去）');
  // -------------------------------------------------------------------------
  check('cinemaBlobs 被标成跳过', H.skip && ctx.isCinemaSkipTable('cinemaBlobs') === true);
  check('cinemaChars 不被跳过', H.skip && ctx.isCinemaSkipTable('cinemaChars') === false);
  check('cinemaChars 被标成 Blob 表', H.blobTable && ctx.isCinemaBlobTable('cinemaChars') === true);

  let prepared = null;
  if (H.prepare) {
    prepared = await ctx.prepareBackupTablesForImport({
      chats: [{ id: 'c1' }],
      cinemaChars: [{ id: 'bg', image: 'data:image/png;base64,AAAA' }],
      cinemaBlobs: [{ id: 'f1', file: {} }],
      localStorage: { couple: 'x' }
    });
  }
  check('预处理后 cinemaBlobs 整表没了', !!prepared && !('cinemaBlobs' in prepared));
  check('预处理把 dataURL 还原成 Blob', !!prepared && prepared.cinemaChars[0].image instanceof Blob);
  check('普通表原样保留', !!prepared && prepared.chats.length === 1 && prepared.chats[0].id === 'c1');
  check('localStorage 不受影响', !!prepared && !!prepared.localStorage);

  // -------------------------------------------------------------------------
  section('4. 六条导出链路都接上了（逐条查）');
  // -------------------------------------------------------------------------
  function bodyOf(name, nextName) {
    const i = src.indexOf('async function ' + name);
    if (i < 0) return '';
    const j = nextName ? src.indexOf('async function ' + nextName, i + 1) : -1;
    return src.slice(i, j > -1 ? j : i + 9000);
  }

  const exportPaths = [
    ['exportDataAsSlicedZip', 'exportDataAsStream', '分片 ZIP'],
    ['exportDataAsStream', 'exportDataAsBlob', '流式'],
    ['exportDataAsBlob', 'window.ephoneExportBackupFromPopup', '传统 Blob'],
    ['exportSelectedTables', 'filterDataByChatIds', '选择性导出'],
    ['uploadToGitHub', 'uploadToGitHubLargeData', 'GitHub 分片'],
    ['uploadToGitHubLargeData', 'startAutoBackupTimer', 'GitHub 大数据']
  ];
  for (const [fn, nextFn, label] of exportPaths) {
    const body = bodyOf(fn, nextFn);
    check(label + '：剔除 cinemaBlobs', body.indexOf('isCinemaSkipTable(') > -1);
    check(label + '：立绘转 base64', body.indexOf('encodeCinemaTable(') > -1);
  }

  const encodeCount = (src.match(/encodeCinemaTable\(/g) || []).length;
  check('encodeCinemaTable 调用点共 7 处（1 定义 + 6 条链路）', encodeCount === 7, encodeCount + ' 处');

  // -------------------------------------------------------------------------
  section('5. 四条导入链路都接上了（逐条查）');
  // -------------------------------------------------------------------------
  const importPaths = [
    ['importStreamedBackup', 'handleSmartImport', '整库覆盖导入'],
    ['handleSelectiveImport', 'importLegacyBackup', '选择性合并导入'],
    ['executeAdvancedImport', 'utf8_to_b64', '高级合并导入'],
    ['restoreFromGitHub', null, 'GitHub 恢复']
  ];
  for (const [fn, nextFn, label] of importPaths) {
    const body = bodyOf(fn, nextFn);
    const restores = body.indexOf('decodeCinemaTable(') > -1
      || body.indexOf('prepareBackupTablesForImport(') > -1
      || body.indexOf('importTableRecords(') > -1;
    check(label + '：还原 Blob / 跳过影片本体', restores);
  }

  const importTableRecordsCalls = (src.match(/importTableRecords\(/g) || []).length;
  check('importTableRecords 共 5 处（定义 + 4 处调用）',
    importTableRecordsCalls === 5, importTableRecordsCalls + ' 处');

  check('整库导入先在事务外还原 Blob',
    /const prepared = await prepareBackupTablesForImport\(backupData\)/.test(src));
  check('选择性导入先在事务外还原 Blob',
    /preparedRows\[type\] = await decodeCinemaTable\(type, rows\)/.test(src));
  check('导入时会清掉老备份的空壳', /delete copy\[field\]/.test(src));

  // -------------------------------------------------------------------------
  section('6. 事务里不能 await blob.arrayBuffer()（会提前提交）');
  // -------------------------------------------------------------------------
  const streamedBlock = src.slice(src.indexOf('async function importStreamedBackup'), src.indexOf('async function handleSmartImport'));
  const prepareIdx = streamedBlock.indexOf('prepareBackupTablesForImport(backupData)');
  const txIdx = streamedBlock.indexOf("db.transaction('rw'");
  check('整库导入：还原在事务之前', prepareIdx > -1 && txIdx > -1 && prepareIdx < txIdx,
    'prepare@' + prepareIdx + ' tx@' + txIdx);

  const selectiveBlock = src.slice(src.indexOf('async function handleSelectiveImport'), src.indexOf('async function importLegacyBackup'));
  const pRowsIdx = selectiveBlock.indexOf('preparedRows[type] = await decodeCinemaTable');
  const selTxIdx = selectiveBlock.indexOf("db.transaction('rw'");
  check('选择性导入：还原在事务之前', pRowsIdx > -1 && selTxIdx > -1 && pRowsIdx < selTxIdx,
    'prepare@' + pRowsIdx + ' tx@' + selTxIdx);

  // -------------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  通过: ' + passed + '   失败: ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
})().catch(function (e) {
  console.error('\n测试崩了:', e && e.stack ? e.stack : e);
  process.exit(1);
});

// ============================================================
// init-data-protection.js
// 数据保护机制：持久化存储、操作日志、双写、崩溃恢复检测
// 从 init-and-state.js 拆分
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const db = window.db;

  // ========================================
  // 浏览器持久化存储保护
  // 防止浏览器在存储压力下自动清除站点数据
  // ========================================
  async function requestStoragePersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const alreadyPersisted = await navigator.storage.persisted();
        if (alreadyPersisted) {
          console.log('✅ 存储已处于持久化保护状态');
          return true;
        }

        const granted = await navigator.storage.persist();
        if (granted) {
          console.log('✅ 浏览器已授予持久化存储权限，数据不会被自动清除');
        } else {
          console.warn('⚠️ 浏览器拒绝了持久化存储请求，数据在存储压力下可能被清除，建议定期备份');
        }
        return granted;
      } else {
        console.warn('⚠️ 当前浏览器不支持 Storage Persistence API');
        return false;
      }
    } catch (error) {
      console.error('请求持久化存储失败:', error);
      return false;
    }
  }

  // 暴露给全局，供设置页面查询状态
  window.checkStoragePersistence = async function () {
    try {
      if (navigator.storage && navigator.storage.persisted) {
        return await navigator.storage.persisted();
      }
      return null; // 不支持
    } catch (e) {
      return null;
    }
  };

  window.getStorageEstimate = async function () {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return {
          usage: estimate.usage,
          quota: estimate.quota,
          usagePercent: ((estimate.usage / estimate.quota) * 100).toFixed(2)
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // ============================================================
  // 🛟 开库看门狗 (2026-11-02)
  //
  // 【为什么加这个】
  //   用户实测「app 白屏起不来」。查下来是: db.open() 一直 pending
  //   (IndexedDB 的升级请求被别的连接挡住了), 而启动链要等库
  //   (init-event-bindingsA.js → await loadAllDataFromDB()) →
  //   首页永远出不来, 控制台又一条红字都没有 —— 纯白屏, 根本猜不到原因。
  //
  // 【这个看门狗干什么】
  //   开库超过 20 秒还没好, 就把「可能的原因 + 怎么办」直接摆到屏幕上,
  //   别再让人对着白屏干等。以后再出这个问题, 一眼就知道是数据库卡住了。
  // ============================================================
  var dbStallTimer = null;
  var dbStallNode = null;

  function clearDbStallNotice() {
    if (dbStallTimer) { clearTimeout(dbStallTimer); dbStallTimer = null; }
    if (dbStallNode && dbStallNode.parentNode) {
      dbStallNode.parentNode.removeChild(dbStallNode);
    }
    dbStallNode = null;
  }

  function showDbStallNotice(headline, detail) {
    if (dbStallNode) return;
    try {
      var box = document.createElement('div');
      box.id = 'db-stall-notice';
      box.setAttribute('style', [
        'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
        'z-index:2147483647', 'width:min(420px,86vw)',
        'background:#fffaf0', 'color:#3c3026', 'border:2px solid #9a6b3f',
        'border-radius:14px', 'padding:20px 22px', 'line-height:1.75',
        'font-size:15px', 'box-shadow:0 14px 44px rgba(0,0,0,.3)', 'text-align:left'
      ].join(';'));

      var h = document.createElement('div');
      h.textContent = headline;
      h.setAttribute('style', 'font-weight:700;font-size:17px;margin-bottom:10px');
      box.appendChild(h);

      var p = document.createElement('div');
      p.textContent = detail;
      p.setAttribute('style', 'font-size:14px');
      box.appendChild(p);

      var tip = document.createElement('div');
      tip.setAttribute('style', 'margin-top:12px;font-size:13px;opacity:.78');
      tip.textContent = '先试: 把 330 的所有页面/窗口全部关掉(最好连浏览器整个退出一次), 再重新打开。';
      box.appendChild(tip);

      var btn = document.createElement('button');
      btn.textContent = '重新加载';
      btn.setAttribute('style', [
        'margin-top:16px', 'padding:9px 20px', 'border:1px solid #9a6b3f',
        'background:#9a6b3f', 'color:#fff', 'border-radius:9px',
        'font-size:15px', 'cursor:pointer'
      ].join(';'));
      btn.addEventListener('click', function () { location.reload(); });
      box.appendChild(btn);

      document.body.appendChild(box);
      dbStallNode = box;
    } catch (e) {
      // 提示画不出来就算了, 千万别因为提示失败把 app 弄挂
    }
  }

  // 被 init-db-schema.js 的 blocked 事件调用 (那边会先注册监听)
  // ⚠️ 这个文件里没有 global 这个标识符 —— 它是别的文件 IIFE 的形参,
  //    这里必须用 window.xxx, 写成 global.xxx 会直接 ReferenceError。
  window.markDbBlocked = function () {
    showDbStallNotice(
      '数据库升级被挡住了',
      '还有别的 330 页面/窗口开着旧版本, 占着数据库不让升级 —— 关掉它们就会自动恢复。'
    );
  };

  dbStallTimer = setTimeout(function () {
    if (window.dbReady) return;
    showDbStallNotice(
      '数据库还没打开',
      '打开本地数据库超过 20 秒还没完成。多半是数据库在升级, 或者被别的 330 页面挡住了。'
    );
  }, 20000);

  // 确保数据库完全打开和就绪
  window.dbReady = false;

  // 【这里刻意没有"版本自动跟进"】
  //   2026-11-03 试过一版: 开库前先 await indexedDB.databases() 看磁盘版本,
  //   比代码新就 db.version(磁盘版本).stores({}) 顶上去。实测【不能用】:
  //     · await 会让出事件循环, 这期间别的模块已经访问 db 触发了 Dexie 自动开库
  //       → 再调 db.version() 直接报 Cannot add version when database is open
  //     · 而 Dexie 自己就带这个兜底: 发现磁盘 schema 跟代码不一致时,
  //       会自己 workaround 并抬高 native 版本号, 实测【不会】抛 VersionError
  //   ⇒ 与其自己写一套半吊子的, 不如交给 Dexie。主库版本停在 72 才是根本解法。
  window.dbReadyPromise = db.open().then(() => {
    console.log('数据库已完全初始化并打开');
    console.log('数据库表状态检查:', {
      chats: !!db.chats,
      messages: !!db.messages,
      chatsType: typeof db.chats,
      messagesType: typeof db.messages
    });
    window.dbReady = true;
    clearDbStallNotice();
    // 触发自定义事件通知数据库已就绪
    window.dispatchEvent(new Event('dbready'));

    // 请求浏览器持久化存储，防止自动清除 IndexedDB / localStorage 数据
    requestStoragePersistence();

    return db;
  }).catch(err => {
    console.error('数据库打开失败:', err);
    window.dbReady = false;
    showDbStallNotice('数据库打开失败', ((err && err.message) || String(err)));
    throw err;
  });

  // ========================================
  // 🛡️ 增强数据保护机制
  // ========================================
  
  /**
   * 操作日志管理器（OP Log）
   * 只保留最近 50 条或 30 分钟内的操作，防止数据膨胀
   * 优化：批量异步写入，减少性能影响
   */
  const OperationLogger = {
    MAX_LOGS: 50, // 最多保留 50 条日志
    MAX_AGE_MS: 30 * 60 * 1000, // 最多保留 30 分钟
    STORAGE_KEY: 'ephone-operation-logs',
    _pendingLogs: [], // 待写入的日志缓冲区
    _flushTimer: null, // 批量写入定时器
    _flushInterval: 3000, // 每 3 秒批量写入一次
    
    // 记录操作（异步批量）
    log(operation, tableName, recordId, data) {
      try {
        // 先加入缓冲区，不立即写入 localStorage
        this._pendingLogs.push({
          timestamp: Date.now(),
          operation, // 'add', 'update', 'delete'
          tableName,
          recordId,
          data: this._compress(data) // 压缩数据
        });
        
        // 如果缓冲区过大，立即刷新
        if (this._pendingLogs.length >= 10) {
          this._flushNow();
        } else {
          // 否则延迟批量写入
          this._scheduleFlush();
        }
      } catch (error) {
        console.warn('⚠️ 操作日志缓冲失败:', error);
      }
    },
    
    // 调度批量写入
    _scheduleFlush() {
      if (this._flushTimer) return; // 已经有定时器了
      
      this._flushTimer = setTimeout(() => {
        this._flushNow();
      }, this._flushInterval);
    },
    
    // 立即刷新到 localStorage
    _flushNow() {
      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
      }
      
      if (this._pendingLogs.length === 0) return;
      
      try {
        // 读取现有日志
        const existingLogs = this.getLogs();
        
        // 合并待写入的日志
        existingLogs.push(...this._pendingLogs);
        
        // 清理旧日志
        this._cleanup(existingLogs);
        
        // 批量写入 localStorage
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(existingLogs));
        
        // 清空缓冲区
        this._pendingLogs = [];
      } catch (error) {
        console.warn('⚠️ 操作日志写入失败:', error);
        // 如果 localStorage 满了，清空旧日志
        if (error.name === 'QuotaExceededError') {
          localStorage.removeItem(this.STORAGE_KEY);
          this._pendingLogs = [];
        }
      }
    },
    
    // 获取所有日志
    getLogs() {
      try {
        const logsStr = localStorage.getItem(this.STORAGE_KEY);
        return logsStr ? JSON.parse(logsStr) : [];
      } catch {
        return [];
      }
    },
    
    // 清理旧日志
    _cleanup(logs) {
      const now = Date.now();
      // 只保留最近的日志
      let cleaned = logs.filter(log => (now - log.timestamp) < this.MAX_AGE_MS);
      // 如果还是太多，只保留最新的
      if (cleaned.length > this.MAX_LOGS) {
        cleaned = cleaned.slice(-this.MAX_LOGS);
      }
      logs.length = 0;
      logs.push(...cleaned);
    },
    
    // 简单压缩（只保留关键字段）
    _compress(data) {
      if (!data || typeof data !== 'object') return data;
      
      // 对于大对象，只保留关键信息
      if (JSON.stringify(data).length > 5000) {
        return {
          _compressed: true,
          id: data.id,
          timestamp: data.timestamp || Date.now(),
          _note: '数据过大，已省略详细内容'
        };
      }
      return data;
    },
    
    // 清除所有日志
    clear() {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  };
  
  window.OperationLogger = OperationLogger;

  /**
   * 双写机制管理器
   * localStorage 只存最新的关键数据快照（压缩）
   */
  const DualWriteManager = {
    SNAPSHOT_KEY: 'ephone-data-snapshot',
    LAST_SAVE_KEY: 'ephone-last-save-time',
    MAX_SNAPSHOT_SIZE: 2 * 1024 * 1024, // 2MB 限制
    
    // 保存关键数据快照
    async saveSnapshot() {
      try {
        if (!db || !window.dbReady) return;
        
        // 只保存最关键的数据
        const snapshot = {
          timestamp: Date.now(),
          version: 1,
          // 只保存关键表的摘要信息
          summary: {
            chatsCount: await db.chats?.count() || 0,
            qzonePostsCount: await db.qzonePosts?.count() || 0,
            npcsCount: await db.npcs?.count() || 0
          },
          // 保存最后修改的几条数据（用于恢复）
          recentData: {
            lastChat: null,
            lastPost: null
          }
        };
        
        // 获取最后一条聊天记录（摘要）
        try {
          const lastChat = await db.chats?.orderBy('id').last();
          if (lastChat) {
            snapshot.recentData.lastChat = {
              id: lastChat.id,
              name: lastChat.name,
              timestamp: Date.now()
            };
          }
        } catch (e) {
          console.warn('无法获取最后聊天记录:', e);
        }
        
        // 检查大小
        const snapshotStr = JSON.stringify(snapshot);
        if (snapshotStr.length > this.MAX_SNAPSHOT_SIZE) {
          console.warn('⚠️ 快照过大，跳过保存');
          return;
        }
        
        // 保存到 localStorage
        localStorage.setItem(this.SNAPSHOT_KEY, snapshotStr);
        localStorage.setItem(this.LAST_SAVE_KEY, Date.now().toString());
        
        console.log('✅ 数据快照已保存到 localStorage');
      } catch (error) {
        console.warn('⚠️ 数据快照保存失败:', error);
        if (error.name === 'QuotaExceededError') {
          // localStorage 满了，清理旧快照
          localStorage.removeItem(this.SNAPSHOT_KEY);
        }
      }
    },
    
    // 获取快照
    getSnapshot() {
      try {
        const snapshotStr = localStorage.getItem(this.SNAPSHOT_KEY);
        return snapshotStr ? JSON.parse(snapshotStr) : null;
      } catch {
        return null;
      }
    },
    
    // 获取最后保存时间
    getLastSaveTime() {
      const time = localStorage.getItem(this.LAST_SAVE_KEY);
      return time ? parseInt(time) : null;
    }
  };
  
  window.DualWriteManager = DualWriteManager;
  
  /**
   * 崩溃恢复检测器
   */
  const CrashRecoveryDetector = {
    SESSION_KEY: 'ephone-session-active',
    CRASH_FLAG_KEY: 'ephone-possible-crash',
    LAST_HEARTBEAT_KEY: 'ephone-last-heartbeat',
    CRASH_TIME_THRESHOLD: 60 * 1000, // 1分钟内重启才算异常退出
    
    // 标记会话开始
    markSessionStart() {
      sessionStorage.setItem(this.SESSION_KEY, 'true');
      const now = Date.now();
      
      // 检查是否可能崩溃过
      const possibleCrash = localStorage.getItem(this.CRASH_FLAG_KEY);
      const lastHeartbeat = localStorage.getItem(this.LAST_HEARTBEAT_KEY);
      
      let isCrash = false;
      if (possibleCrash === 'true' && lastHeartbeat) {
        const timeSinceLastHeartbeat = now - parseInt(lastHeartbeat);
        // 只有在很短时间内（10秒）重启才认为是异常退出
        if (timeSinceLastHeartbeat < this.CRASH_TIME_THRESHOLD) {
          console.warn('⚠️ 检测到异常退出（距上次心跳 ' + Math.round(timeSinceLastHeartbeat / 1000) + ' 秒）');
          isCrash = true;
        } else {
          console.log('✅ 正常关闭（距上次心跳 ' + Math.round(timeSinceLastHeartbeat / 1000) + ' 秒，超过阈值）');
        }
      }
      
      // 更新心跳和崩溃标记
      localStorage.setItem(this.LAST_HEARTBEAT_KEY, now.toString());
      localStorage.setItem(this.CRASH_FLAG_KEY, 'true');
      
      return isCrash;
    },
    
    // 标记正常退出
    markNormalExit() {
      sessionStorage.removeItem(this.SESSION_KEY);
      localStorage.removeItem(this.CRASH_FLAG_KEY);
      console.log('✅ 正常退出，已清除崩溃标记');
    },
    
    // 心跳（证明应用还活着）
    heartbeat() {
      localStorage.setItem(this.LAST_HEARTBEAT_KEY, Date.now().toString());
    },
    
    // 检查是否有未保存的操作日志
    hasUnsavedLogs() {
      const logs = OperationLogger.getLogs();
      return logs.length > 0;
    }
  };
  
  window.CrashRecoveryDetector = CrashRecoveryDetector;

  /**
   * 包装 db.put() 操作，自动记录日志
   */
  function wrapDatabaseOperations() {
    if (!db || !window.dbReady) return;

    // ⚠️ 2026-11-03: Dexie 4 的 CDN 构建 (unpkg.com/dexie/dist/dexie.js) 里
    //   【没有 Dexie.Table】—— 实测那份文件里连 "Dexie.Table" 这个字符串都搜不到。
    //   以前这里直接取 Dexie.Table.prototype.put, 只要这段跑到就必抛
    //   TypeError: Cannot read properties of undefined (reading 'prototype'),
    //   于是每次启动控制台都留一条红字。功能不受影响, 但极容易把人带偏 ——
    //   排查"起不来"的时候, 这条红字会让人以为是什么别的地方坏了。
    //   (反过来也是证据: 用户控制台里【没有】这条红字, 说明 window.dbReady 从没变 true,
    //    也就是数据库压根没打开过 —— 跟 db.open() 永久 pending 那个诊断对得上。)
    //   这里没 Table 就安静跳过: 操作日志少了这一层而已, 不影响任何数据。
    const TableCtor = (typeof Dexie !== 'undefined' && Dexie) ? Dexie.Table : null;
    if (!TableCtor || !TableCtor.prototype) return;

    const originalPut = TableCtor.prototype.put;
    const originalAdd = TableCtor.prototype.add;
    const originalDelete = TableCtor.prototype.delete;
    
    // 包装 put 操作
    TableCtor.prototype.put = function(data, key) {
      const tableName = this.name;
      
      // 记录操作日志
      OperationLogger.log('update', tableName, data.id || key, data);
      
      // 调用原始方法
      return originalPut.call(this, data, key);
    };
    
    // 包装 add 操作
    TableCtor.prototype.add = function(data, key) {
      const tableName = this.name;
      
      // 记录操作日志
      OperationLogger.log('add', tableName, data.id || key, data);
      
      // 调用原始方法
      return originalAdd.call(this, data, key);
    };
    
    // 包装 delete 操作
    TableCtor.prototype.delete = function(key) {
      const tableName = this.name;
      
      // 记录操作日志
      OperationLogger.log('delete', tableName, key, { id: key });
      
      // 调用原始方法
      return originalDelete.call(this, key);
    };
    
    console.log('✅ 数据库操作监控已启动（双写 + 操作日志）');
  }
  
  // 在数据库就绪后启动包装
  window.dbReadyPromise.then(() => {
    wrapDatabaseOperations();
  });
  
  /**
   * 增强实时保存机制
   */
  let autoSaveTimer = null;
  
  function triggerAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      console.log('🔄 触发自动保存...');
      await DualWriteManager.saveSnapshot();
      CrashRecoveryDetector.heartbeat();
    }, 1000); // 防抖 1 秒
  }
  
  window.triggerAutoSave = triggerAutoSave;

  // 页面可见性变化时保存
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      console.log('📱 页面进入后台，立即保存数据...');
      
      // 立即刷新所有待写入的日志
      OperationLogger._flushNow();
      
      DualWriteManager.saveSnapshot();
      CrashRecoveryDetector.heartbeat();
    }
  });
  
  // 页面关闭前保存
  window.addEventListener('beforeunload', (event) => {
    console.log('👋 页面即将关闭，保存数据并标记正常退出...');
    
    // 立即刷新所有待写入的日志
    OperationLogger._flushNow();
    
    DualWriteManager.saveSnapshot();
    CrashRecoveryDetector.markNormalExit();
    // 不阻止页面关闭
  });
  
  // 定期心跳（每 30 秒）
  setInterval(() => {
    CrashRecoveryDetector.heartbeat();
  }, 30 * 1000);
  
  // 定期保存快照（每 2 分钟）
  setInterval(() => {
    DualWriteManager.saveSnapshot();
  }, 2 * 60 * 1000);
  
  console.log('✅ 增强数据保护机制已启动（性能优化版）');
  console.log('   - 双写机制: localStorage 快照保护');
  console.log('   - 操作日志: 批量异步写入（每 3 秒或累积 10 条）');
  console.log('   - 数据限制: 最多 50 条或 30 分钟内的操作');
  console.log('   - 实时保存: visibilitychange + beforeunload');
  console.log('   - 崩溃检测: 异常退出自动检测');
  console.log('   - 性能影响: 读取零影响，写入基本无感知');

  /**
   * 🔧 调试工具 - 供用户在控制台查看数据保护状态
   */
  window.DataProtectionDebug = {
    // 查看所有操作日志
    viewLogs() {
      const logs = OperationLogger.getLogs();
      const pendingCount = OperationLogger._pendingLogs.length;
      
      console.log(`📋 操作日志 (已保存: ${logs.length} 条, 待写入: ${pendingCount} 条):`);
      
      // 显示已保存的日志
      logs.forEach((log, index) => {
        const time = new Date(log.timestamp).toLocaleString();
        console.log(`${index + 1}. [${time}] ${log.operation.toUpperCase()} ${log.tableName} (ID: ${log.recordId})`);
      });
      
      // 显示待写入的日志
      if (pendingCount > 0) {
        console.log(`\n⏳ 待写入缓冲区 (${pendingCount} 条):`);
        OperationLogger._pendingLogs.forEach((log, index) => {
          const time = new Date(log.timestamp).toLocaleString();
          console.log(`${index + 1}. [${time}] ${log.operation.toUpperCase()} ${log.tableName} (ID: ${log.recordId})`);
        });
      }
      
      return { saved: logs, pending: OperationLogger._pendingLogs };
    },
    
    // 查看快照状态
    viewSnapshot() {
      const snapshot = DualWriteManager.getSnapshot();
      const lastSaveTime = DualWriteManager.getLastSaveTime();
      
      if (!snapshot) {
        console.log('⚠️ 暂无数据快照');
        return null;
      }
      
      console.log('📸 数据快照状态:');
      console.log(`  创建时间: ${new Date(snapshot.timestamp).toLocaleString()}`);
      console.log(`  最后保存: ${lastSaveTime ? new Date(lastSaveTime).toLocaleString() : '未知'}`);
      console.log(`  聊天数: ${snapshot.summary?.chatsCount || 0}`);
      console.log(`  说说数: ${snapshot.summary?.qzonePostsCount || 0}`);
      console.log(`  NPC数: ${snapshot.summary?.npcsCount || 0}`);
      
      return snapshot;
    },
    
    // 查看数据保护整体状态
    viewStatus() {
      const logs = OperationLogger.getLogs();
      const snapshot = DualWriteManager.getSnapshot();
      const lastSaveTime = DualWriteManager.getLastSaveTime();
      const lastHeartbeat = localStorage.getItem(CrashRecoveryDetector.LAST_HEARTBEAT_KEY);
      
      console.log('🛡️ 数据保护机制状态:');
      console.log('────────────────────────────');
      console.log(`📋 操作日志: ${logs.length} 条`);
      console.log(`📸 快照状态: ${snapshot ? '已保存' : '未保存'}`);
      console.log(`💾 最后保存: ${lastSaveTime ? new Date(lastSaveTime).toLocaleString() : '未保存'}`);
      console.log(`💓 最后心跳: ${lastHeartbeat ? new Date(parseInt(lastHeartbeat)).toLocaleString() : '未知'}`);
      console.log(`🔧 数据库状态: ${window.dbReady ? '就绪' : '未就绪'}`);
      console.log('────────────────────────────');
      
      // localStorage 使用情况
      try {
        const used = new Blob(Object.values(localStorage)).size;
        console.log(`💽 localStorage 使用: ${(used / 1024).toFixed(2)} KB`);
      } catch (e) {
        console.log('💽 localStorage 使用: 无法计算');
      }
      
      return {
        logsCount: logs.length,
        hasSnapshot: !!snapshot,
        lastSaveTime: lastSaveTime ? new Date(lastSaveTime) : null,
        lastHeartbeat: lastHeartbeat ? new Date(parseInt(lastHeartbeat)) : null,
        dbReady: window.dbReady
      };
    },
    
    // 清除所有操作日志
    clearLogs() {
      if (confirm('确定要清除所有操作日志吗？这不会影响实际数据。')) {
        OperationLogger.clear();
        console.log('✅ 操作日志已清除');
      }
    },
    
    // 手动触发快照保存
    async saveNow() {
      console.log('💾 正在手动保存快照...');
      OperationLogger._flushNow(); // 先刷新日志
      await DualWriteManager.saveSnapshot();
      console.log('✅ 快照保存完成');
    },
    
    // 手动刷新操作日志
    flushLogs() {
      const pendingCount = OperationLogger._pendingLogs.length;
      if (pendingCount === 0) {
        console.log('✅ 没有待写入的日志');
        return;
      }
      
      console.log(`💾 正在刷新 ${pendingCount} 条待写入日志...`);
      OperationLogger._flushNow();
      console.log('✅ 日志已刷新到 localStorage');
    },
    
    // 查看 localStorage 存储大小
    checkStorage() {
      console.log('💽 localStorage 存储分析:');
      console.log('────────────────────────────');
      
      const keys = [
        OperationLogger.STORAGE_KEY,
        DualWriteManager.SNAPSHOT_KEY,
        CrashRecoveryDetector.LAST_HEARTBEAT_KEY,
        CrashRecoveryDetector.CRASH_FLAG_KEY
      ];
      
      keys.forEach(key => {
        const value = localStorage.getItem(key);
        if (value) {
          const size = new Blob([value]).size;
          console.log(`  ${key}: ${(size / 1024).toFixed(2)} KB`);
        } else {
          console.log(`  ${key}: (未设置)`);
        }
      });
      
      console.log('────────────────────────────');
      
      // 总体存储估算
      try {
        const total = new Blob(Object.values(localStorage)).size;
        console.log(`📊 总计: ${(total / 1024).toFixed(2)} KB / ~5-10 MB 限制`);
      } catch (e) {
        console.log('📊 总计: 无法计算');
      }
    }
  };
  
  // 提示用户可以使用调试工具
  console.log('');
  console.log('💡 数据保护调试工具已加载！');
  console.log('   使用 DataProtectionDebug.viewStatus() 查看状态');
  console.log('   使用 DataProtectionDebug.viewLogs() 查看操作日志');
  console.log('   使用 DataProtectionDebug.viewSnapshot() 查看快照');
  console.log('   使用 DataProtectionDebug.checkStorage() 查看存储使用');
  console.log('   使用 DataProtectionDebug.flushLogs() 手动刷新日志');
  console.log('');
  
  // ========================================
  // 🛡️ 增强数据保护机制结束
  // ========================================

});

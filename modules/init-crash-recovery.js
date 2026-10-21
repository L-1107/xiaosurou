// ============================================================
// init-crash-recovery.js
// 崩溃恢复检测 - 应用启动时执行
// 从 init-and-state.js 拆分
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  // ========================================
  // 🛡️ 崩溃恢复检测 - 应用启动时执行
  // ========================================
  (async () => {
    // 等待数据库就绪
    await window.dbReadyPromise;
    
    const CrashRecoveryDetector = window.CrashRecoveryDetector;
    const OperationLogger = window.OperationLogger;
    const DualWriteManager = window.DualWriteManager;

    // 检测是否有异常退出
    const hadCrash = CrashRecoveryDetector.markSessionStart();
    
    if (hadCrash) {
      console.warn('⚠️ 检测到上次异常退出');
      
      // 检查是否有未保存的操作日志
      const unsavedLogs = OperationLogger.getLogs();
      const lastSnapshot = DualWriteManager.getSnapshot();
      const lastSaveTime = DualWriteManager.getLastSaveTime();
      
      // 构建恢复信息
      let recoveryInfo = '【您的数据是安全的，请放心！】\n\n';
      recoveryInfo += '检测到应用上次没有正常关闭（可能是浏览器崩溃、电脑断电或强制关闭）。\n\n';
      recoveryInfo += '【为什么会有这个提示？】\n';
      recoveryInfo += '应用具有异常退出检测功能，当检测到上次没有正常退出时，会自动显示这个提示，让您了解当前的数据状态。\n\n';
      recoveryInfo += '【数据保存机制说明】\n';
      recoveryInfo += '• 您的所有数据都实时自动保存在浏览器本地数据库中\n';
      recoveryInfo += '• 即使异常退出，已保存的数据也不会丢失\n';
      recoveryInfo += '• 系统会定期创建数据快照，确保数据安全\n';
      recoveryInfo += '• 如果您开启了云备份，数据还会同步到云端\n\n';
      
      recoveryInfo += '【当前数据状态】\n';
      
      if (lastSaveTime) {
        const timeDiff = Date.now() - lastSaveTime;
        const minutesAgo = Math.floor(timeDiff / 60000);
        recoveryInfo += `最后保存时间：${minutesAgo} 分钟前\n`;
      }
      
      if (lastSnapshot) {
        recoveryInfo += `聊天数：${lastSnapshot.summary?.chatsCount || 0}\n`;
        recoveryInfo += `说说数：${lastSnapshot.summary?.qzonePostsCount || 0}\n`;
        recoveryInfo += `NPC数：${lastSnapshot.summary?.npcsCount || 0}\n`;
      }
      
      if (unsavedLogs.length > 0) {
        recoveryInfo += `\n检测到 ${unsavedLogs.length} 条未保存的操作记录\n`;
        
        // 显示最近的几条操作
        const recentOps = unsavedLogs.slice(-5).map(log => {
          const time = new Date(log.timestamp).toLocaleTimeString();
          return `  • ${time}：${log.operation} ${log.tableName}`;
        }).join('\n');
        
        recoveryInfo += '\n最近的操作：\n' + recentOps;
      }
      
      recoveryInfo += '\n\n您可以继续正常使用，数据已经恢复完成。如有任何疑问，可以检查云备份记录。';

      // ============================================================
      // 🛡️ 通话崩溃诊断 (2026-10-16 新增)
      // ------------------------------------------------------------
      // 为什么加在这里: iPhone PWA 装到主屏后打不开 console, 这个弹窗是唯一
      // 的复盘入口。而"长通话挂断时闪退"光知道"崩了"没用, 必须知道"崩在哪一步"。
      // video-voice-call.js 把挂断流程拆成若干步, 每推进一步就往 localStorage
      // 写一次 stage —— 万一崩在挂断途中, 下次打开就能直接看出死在哪一步。
      // ============================================================
      try {
        const rawDiag = localStorage.getItem('mavis-call-diag-v1');
        if (rawDiag) {
          const d = JSON.parse(rawDiag);
          const when = new Date(d.startedAt || d.updatedAt || Date.now());
          const mins = Math.round((Date.now() - (d.startedAt || 0)) / 60000);
          const typeText = d.type === 'voice' ? '语音通话' : '视频通话';

          // 阶段翻译成人话 —— 用户看到中文才有意义
          const STAGE_TEXT = {
            'in-call': '通话中 (还没走到挂断)',
            'hangup:start': '1. 刚点下挂断',
            'hangup:live2d-released': '2. 释放 Live2D 画布后',
            'hangup:hardware-released': '3. 关摄像头/麦克风后',
            'hangup:record-saved': '4. 通话记录写库后',
            'hangup:chat-saved': '5. 聊天记录写库后',
            'hangup:back-to-chat': '6. 切回聊天界面后',
            'hangup:done': '7. 挂断流程全部完成'
          };
          const stageText = STAGE_TEXT[d.stage] || d.stage || '未知';

          recoveryInfo += '\n\n【上次' + typeText + '诊断 · 供排查闪退】';
          recoveryInfo += '\n• 这通电话记录于：' + when.toLocaleString('zh-CN');
          if (mins >= 0 && mins < 600) recoveryInfo += '（约 ' + mins + ' 分钟前）';
          recoveryInfo += '\n• 最后执行到：' + stageText;
          recoveryInfo += '\n• 当时已对话 ' + (d.historyLen || 0) + ' 条，页面共 ' + (d.domNodes || 0)
            + ' 个节点，通话区 ' + (d.bubbles || 0) + ' 个';
          if (d.bgSwitches) recoveryInfo += '，换背景 ' + d.bgSwitches + ' 次';
          if (d.webglLost) recoveryInfo += '\n• ⚠️ 期间发生过 WebGL 显存耗尽（GPU 侧先撑不住）';
          if (d.stage && String(d.stage).indexOf('hangup:') === 0 && d.stage !== 'hangup:done') {
            recoveryInfo += '\n• 也就是说：闪退发生在【挂断流程】中途，卡在「' + stageText + '」这一步';
          }
          if (Array.isArray(d.events) && d.events.length) {
            recoveryInfo += '\n• 最后几步：' + d.events.slice(-5).join(' / ');
          }
          recoveryInfo += '\n（这段诊断只记录数字，不含聊天内容）';
        }
      } catch (diagErr) {
        /* 诊断记录损坏不该影响恢复提示本身 */
      }
      
      // 显示恢复提示（使用原有的 showCustomAlert）
      if (typeof showCustomAlert === 'function') {
        await showCustomAlert('正常启动提示', recoveryInfo);
      } else {
        // 如果 showCustomAlert 还未定义，使用 alert
        alert('正常启动提示\n\n' + recoveryInfo);
      }
      
      console.log('[崩溃恢复] 恢复信息:', {
        unsavedLogs: unsavedLogs.length,
        lastSnapshot,
        lastSaveTime: lastSaveTime ? new Date(lastSaveTime).toLocaleString() : null
      });
    } else {
      console.log('[崩溃恢复] 正常启动，无需恢复');
    }
    
    // 启动初始快照保存
    setTimeout(() => {
      DualWriteManager.saveSnapshot();
    }, 5000); // 启动 5 秒后保存第一个快照
  })();
  // ========================================
  // 🛡️ 崩溃恢复检测结束
  // ========================================

});

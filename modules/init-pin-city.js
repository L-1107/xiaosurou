// ============================================================
// init-pin-city.js
// PIN 激活逻辑、更新检查
// 从 init-and-state.js 拆分
//
// 🔴 2026-11-19: 原来的「城市搜索」那一段 (searchCityGeo + 两个搜索按钮)
//    连同「实时天气同步」一起删掉了 —— 位置信息现在走高德那条线。
//    ⚠️ 本文件剩下的部分 (PIN 激活 / 手动总结弹窗 / 暂停调用 / SW 更新检查) 都还在用。
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  // 手动总结弹窗事件监听器
  document.getElementById('manual-summary-btn').addEventListener('click', () => window.openManualSummaryModal());
  document.getElementById('manual-summary-close-btn').addEventListener('click', () => window.closeManualSummaryModal());
  document.getElementById('manual-summary-cancel-btn').addEventListener('click', () => window.closeManualSummaryModal());
  document.getElementById('manual-summary-confirm-btn').addEventListener('click', () => window.executeManualSummary());

  // 暂停调用按钮事件监听器
  const stopApiCallBtn = document.getElementById('stop-api-call-btn');
  if (stopApiCallBtn) {
    stopApiCallBtn.addEventListener('click', () => {
      if (currentApiController) {
        console.log('用户点击暂停调用按钮，正在取消API请求...');
        currentApiController.abort();

        // 立即隐藏按钮并移除动画
        stopApiCallBtn.style.display = 'none';
        stopApiCallBtn.classList.remove('active');

        // 显示取消提示（仅给用户看，不会进入聊天历史）
        showCustomAlert('已停止', '对话已停止生成');
      }
    });
  }

  const PREFILLED_SALT = "bu_wan_jiu_guan_bu_yao_huo_qu";


  async function generatePin(deviceId, salt) {
    if (!deviceId || !salt) {
      throw new Error("设备ID和密钥盐不能为空。");
    }
    const dataToHash = deviceId + salt;
    const dataBuffer = new TextEncoder().encode(dataToHash);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 6).toUpperCase();
  }


  function requirePinActivation() {

    return new Promise(async (resolve, reject) => {

      if (isPinActivated) {
        resolve(true);
        return;
      }


      const modal = document.getElementById('pin-modal-overlay');
      const deviceIdDisplay = document.getElementById('pin-device-id-display');
      const pinInput = document.getElementById('pin-input');
      const confirmBtn = document.getElementById('pin-modal-confirm-btn');
      const cancelBtn = document.getElementById('pin-modal-cancel-btn');


      deviceIdDisplay.value = EPHONE_DEVICE_ID;
      pinInput.value = '';



      const onConfirmClick = async () => {
        const userPin = pinInput.value;


        modal.classList.remove('visible');


        confirmBtn.removeEventListener('click', onConfirmClick);
        cancelBtn.removeEventListener('click', onCancelClick);

        if (!userPin || !userPin.trim()) {
          await showCustomAlert('操作取消', '您没有输入激活码。');
          reject(new Error('用户取消了输入。'));
          return;
        }


        await showCustomAlert("请稍候...", "正在验证激活码...");


        try {

          const correctPin = await generatePin(EPHONE_DEVICE_ID, PREFILLED_SALT);


          if (userPin.trim().toUpperCase() === correctPin) {

            localStorage.setItem('ephonePinActivated', 'true');
            isPinActivated = true;
            await showCustomAlert('激活成功！', '此功能已为您的设备永久解锁。');


            updateLockedFeatureUI();


            resolve(true);
          } else {

            await showCustomAlert('激活失败', '您输入的激活码不正确。');
            reject(new Error('激活码不正确。'));
          }
        } catch (error) {

          console.error("本地PIN码验证过程出错:", error);
          await showCustomAlert('激活失败', `验证过程中发生错误：${error.message}`);
          reject(error);
        }

      };


      const onCancelClick = async () => { // <--- 添加 async
        modal.classList.remove('visible');

        confirmBtn.removeEventListener('click', onConfirmClick);
        cancelBtn.removeEventListener('click', onCancelClick);


        await showCustomAlert('操作取消', '激活流程已取消。');
        reject(new Error('用户取消了激活。'));
      };


      confirmBtn.addEventListener('click', onConfirmClick);
      cancelBtn.addEventListener('click', onCancelClick);


      modal.classList.add('visible');
      pinInput.focus();
    });
  }

  window.requirePinActivation = requirePinActivation;

  function updateLockedFeatureUI() {
    const isActivated = localStorage.getItem('ephonePinActivated') === 'true';
    const presetImportBtn = document.getElementById('import-preset-btn');


    const worldBookImportBtn = document.getElementById('import-world-book-btn');



    if (presetImportBtn) {
      presetImportBtn.classList.toggle('locked-feature', !isActivated);
    }


    if (worldBookImportBtn) {
      worldBookImportBtn.classList.toggle('locked-feature', !isActivated);
    }

  }

  window.updateLockedFeatureUI = updateLockedFeatureUI;

  document.addEventListener('visibilitychange', () => {

    if (document.visibilityState === 'visible') {
      console.log('应用已返回前台，正在检查更新...');

      navigator.serviceWorker.ready.then(registration => {

        registration.update();
      });
    }
  });

});

/**
 * 网易云音乐 App (新增 0.0.37)
 * 参照糯米机 MusicApp + NeteaseProfilePage 的 4 view 结构
 * 主题: 粉红 + 嫩黄 (D 方案)
 *
 * 4 个 view:
 * - profile: 我的 (banner + 用户卡 + 红心/歌单/云盘 tab + 网易云歌单同步)
 * - search: 搜索 (走 NeteaseMusic.search + VIP 标签)
 * - player: 播放 (复用现有 music-player.js 的 playSong, 占位)
 * - settings: 设置 (cookie / 音质 / 诊断, 占位)
 *
 * 入口: 从 330 桌面/设置 添加"网易云音乐"按钮 → openNeteaseMusicApp()
 */
(function (global) {
  'use strict';

  // ====== 状态 ======
  const state = {
    view: 'profile',        // 当前 view
    profileTab: 'playlist', // 我的页 tab
    playlists: [],          // 用户歌单
    playlistDetail: null,   // 当前查看的歌单详情
    playlistSongs: [],      // 当前歌单歌曲
    likedSongs: [],         // 红心歌曲
    cloudSongs: [],         // 云盘歌曲
    subcount: null,         // 统计
    user: null,             // 用户信息
    loading: false,
    // 「今日私选」(2026-10-21)
    dailyCard: null,        // 当前展示的日推卡
    dailyLoading: false,    // 生成中 (防重复点)
    dailyChatId: null,      // 这张卡属于哪个角色
  };

  // ====== 入口 ======
  function openNeteaseMusicApp(opts) {
    opts = opts || {};
    let overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) {
      overlay = createOverlay();
      document.body.appendChild(overlay);
    }
    overlay.classList.add('visible');
    // 启动时: 如果指定 initialTab, 切过去
    if (opts.initialTab && opts.initialTab !== 'profile') {
      // 延后到 DOM 渲染后
      setTimeout(() => switchView(opts.initialTab), 50);
    }
    // 启动时: 拉用户信息 + 歌单
    if (!state.user) {
      loadProfile();
    }
  }

  function closeNeteaseMusicApp() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (overlay) overlay.classList.remove('visible');
  }

  // 【2026-07-04 防卡死】轻量 toast 提示，替代 alert（alert 会阻塞主线程，部署环境易卡死）
  function showNmaToast(text, type) {
    let host = document.getElementById('nma-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'nma-toast-host';
      host.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100000;pointer-events:none;';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    const isError = type === 'error';
    t.style.cssText = 'background:' + (isError ? 'rgba(220,80,80,.95)' : 'rgba(60,60,60,.9)') + ';color:#fff;padding:12px 18px;border-radius:10px;margin-top:8px;font-size:14px;line-height:1.4;max-width:80vw;box-shadow:0 4px 12px rgba(0,0,0,.2);opacity:0;transition:opacity .2s;';
    t.textContent = text;
    host.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 250);
    }, 3000);
  }

  // ====== 创建 DOM ======
  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'netease-music-app-overlay';
    overlay.className = 'nma-overlay';
    overlay.innerHTML = `
      <div class="nma-window">
        <!-- 顶部 tab 切换 -->
        <div class="nma-tabs">
          <button class="nma-tab active" data-view="profile">我的</button>
          <button class="nma-tab" data-view="search">搜索</button>
          <button class="nma-tab" data-view="daily">今日私选</button>
          <button class="nma-tab" data-view="player">播放</button>
          <button class="nma-tab" data-view="settings">设置</button>
          <span class="nma-close" id="nma-close-btn">×</span>
        </div>

        <!-- 我的 view -->
        <div class="nma-view nma-view-profile active" data-view="profile">
          <div class="nma-profile-loading" id="nma-profile-loading">
            <div class="nma-spinner"></div>
            <div class="nma-loading-text">加载中...</div>
          </div>

          <!-- Banner + 用户卡 -->
          <div class="nma-profile-header" id="nma-profile-header" style="display:none;">
            <div class="nma-banner">
              <div class="nma-user-card">
                <img id="nma-user-avatar" class="nma-user-avatar" alt="" />
                <div class="nma-user-info">
                  <div class="nma-user-name" id="nma-user-name">--</div>
                  <span id="nma-user-vip" class="nma-user-vip" style="display:none;">★ 黑胶 VIP</span>
                </div>
                <div class="nma-stats">
                  <div class="nma-stat"><div class="nma-stat-num" id="nma-stat-red">0</div><div class="nma-stat-label">红心</div></div>
                  <div class="nma-stat"><div class="nma-stat-num" id="nma-stat-playlist">0</div><div class="nma-stat-label">歌单</div></div>
                  <div class="nma-stat"><div class="nma-stat-num" id="nma-stat-cloud">0</div><div class="nma-stat-label">云盘</div></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Tab 切换 (歌单/红心/云盘) -->
          <div class="nma-profile-tabs" id="nma-profile-tabs" style="display:none;">
            <button class="nma-ptab active" data-ptab="playlist">歌单</button>
            <button class="nma-ptab" data-ptab="liked">红心</button>
            <button class="nma-ptab" data-ptab="cloud">云盘</button>
          </div>

          <!-- 歌单列表 -->
          <div class="nma-list" id="nma-playlist-list"></div>
          <!-- 红心列表 -->
          <div class="nma-list" id="nma-liked-list" style="display:none;"></div>
          <!-- 云盘列表 -->
          <div class="nma-list" id="nma-cloud-list" style="display:none;"></div>

          <!-- 未登录提示 -->
          <div class="nma-empty" id="nma-profile-empty" style="display:none;">
            <div class="nma-empty-icon">🎵</div>
            <div class="nma-empty-text">登录后查看你的音乐</div>
            <button class="nma-empty-btn" id="nma-go-login-btn">去登录</button>
          </div>
        </div>

        <!-- 搜索 view -->
        <div class="nma-view nma-view-search" data-view="search">
          <div class="nma-search-bar">
            <input type="text" id="nma-search-input" class="nma-search-input" placeholder="搜歌曲/歌手/歌单..." />
            <button id="nma-search-btn" class="nma-search-btn">搜索</button>
          </div>
          <div class="nma-list" id="nma-search-results"></div>
        </div>

        <!-- 今日私选 view (2026-10-21 新增: AI 每日荐歌) -->
        <div class="nma-view nma-view-daily" data-view="daily">
          <div class="nmd-head">
            <div class="nmd-head-main">
              <div class="nmd-title" id="nmd-title">今日私选</div>
              <div class="nmd-sub" id="nmd-sub"></div>
            </div>
            <div class="nmd-head-actions">
              <button class="nmd-btn" id="nmd-refresh-btn" type="button">换一批</button>
              <button class="nmd-btn nmd-btn-primary" id="nmd-playall-btn" type="button">播放全部</button>
            </div>
          </div>
          <div class="nmd-note" id="nmd-note" style="display:none;"></div>
          <div class="nma-list" id="nmd-list"></div>
        </div>

        <!-- 播放 view -->
        <div class="nma-view nma-view-player" data-view="player">
          <div class="nma-player-placeholder">
            <div class="nma-player-icon">♪</div>
            <div class="nma-player-text">点这里切到"一起听"播放器</div>
            <button class="nma-player-btn" id="nma-go-listen-btn">打开一起听</button>
          </div>
        </div>

        <!-- 设置 view -->
        <div class="nma-view nma-view-settings" data-view="settings">
          <div class="nma-setting-item">
            <div class="nma-setting-label">登录状态</div>
            <div class="nma-setting-value" id="nma-setting-login">--</div>
          </div>
          <div class="nma-setting-item">
            <div class="nma-setting-label">音质</div>
            <div class="nma-setting-value" id="nma-setting-quality">--</div>
          </div>
          <div class="nma-setting-item">
            <div class="nma-setting-label">代理地址</div>
            <div class="nma-setting-value">/.netlify/functions/netease-proxy</div>
          </div>
          <div class="nma-setting-item">
            <button class="nma-setting-btn" id="nma-relogin-btn">重新登录</button>
            <button class="nma-setting-btn" id="nma-clear-cache-btn">清除缓存</button>
          </div>
        </div>

        <!-- 歌单详情子页 -->
        <div class="nma-view nma-view-playlist-detail" data-view="playlist-detail">
          <div class="nma-detail-header">
            <span class="nma-back-btn" id="nma-back-to-profile">‹</span>
            <span class="nma-detail-title" id="nma-detail-title">歌单</span>
            <button class="nma-import-btn" id="nma-import-playlist-btn" type="button">导入一起听</button>
          </div>
          <div class="nma-list" id="nma-detail-songs"></div>
        </div>
      </div>
    `;
    bindEvents(overlay);
    return overlay;
  }

  // ====== 事件绑定 ======
  function bindEvents(overlay) {
    // 关闭
    overlay.querySelector('#nma-close-btn').addEventListener('click', closeNeteaseMusicApp);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeNeteaseMusicApp();
    });

    // 顶部 tab 切换
    overlay.querySelectorAll('.nma-tab').forEach((t) => {
      t.addEventListener('click', () => switchView(t.dataset.view));
    });

    // 我的页 tab 切换
    overlay.querySelectorAll('.nma-ptab').forEach((t) => {
      t.addEventListener('click', () => switchProfileTab(t.dataset.ptab));
    });

    // 搜索按钮
    overlay.querySelector('#nma-search-btn').addEventListener('click', doSearch);
    overlay.querySelector('#nma-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // 去登录
    const goLogin = overlay.querySelector('#nma-go-login-btn');
    if (goLogin) {
      goLogin.addEventListener('click', () => {
        closeNeteaseMusicApp();
        if (global.NeteaseMusic && global.NeteaseMusic.isLoggedIn && !global.NeteaseMusic.isLoggedIn()) {
          const loginBtn = document.getElementById('netease-login-btn');
          if (loginBtn) loginBtn.click();
        }
      });
    }

    // 播放占位 → 打开一起听
    // 【2026-07-04 修复】之前 click #listen-together-btn 会触发 handleListenTogetherClick，
    //   而 handleListenTogetherClick 检查到 NeteaseMusicApp 存在就又打开 App → 死循环 + 不弹 overlay
    //   现在直接调 window.startListenTogetherSession 跳过 App 判断
    const goListen = overlay.querySelector('#nma-go-listen-btn');
    if (goListen) {
      goListen.addEventListener('click', () => {
        closeNeteaseMusicApp();
        const targetChatId = (window.state && window.state.activeChatId);
        if (targetChatId && window.musicState && window.musicState.isActive && window.musicState.activeChatId === targetChatId && window.showMusicPlayerOverlay) {
          window.showMusicPlayerOverlay();
        } else if (targetChatId && window.startListenTogetherSession) {
          window.startListenTogetherSession(targetChatId);
        } else if (window.NeteaseMusicApp) {
          // 没 activeChatId 或函数没加载，重新打开 App 让用户选
          window.NeteaseMusicApp.open({ initialTab: 'search' });
        } else {
          // 完全兜底
          const listenBtn = document.querySelector('#listen-together-btn');
          if (listenBtn) listenBtn.click();
        }
      });
    }

    // 歌单详情返回
    overlay.querySelector('#nma-back-to-profile').addEventListener('click', () => switchView('profile'));
    const importPlaylistBtn = overlay.querySelector('#nma-import-playlist-btn');
    if (importPlaylistBtn) {
      importPlaylistBtn.addEventListener('click', importCurrentPlaylistToPlayer);
    }

    // 「今日私选」: 换一批 / 播放全部 (2026-10-21)
    const dailyRefreshBtn = overlay.querySelector('#nmd-refresh-btn');
    if (dailyRefreshBtn) {
      dailyRefreshBtn.addEventListener('click', () => loadDailyDiscovery(true));
    }
    const dailyPlayAllBtn = overlay.querySelector('#nmd-playall-btn');
    if (dailyPlayAllBtn) {
      dailyPlayAllBtn.addEventListener('click', () => playAllDailySongs());
    }

    // 设置按钮
    const reloginBtn = overlay.querySelector('#nma-relogin-btn');
    if (reloginBtn) {
      reloginBtn.addEventListener('click', () => {
        closeNeteaseMusicApp();
        const loginBtn = document.getElementById('netease-login-btn');
        if (loginBtn) loginBtn.click();
      });
    }
    const clearCacheBtn = overlay.querySelector('#nma-clear-cache-btn');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', () => {
        if (global.NeteaseMusic && global.NeteaseMusic.clearAllCache) {
          global.NeteaseMusic.clearAllCache();
          alert('缓存已清除');
        }
      });
    }
  }

  // ====== View 切换 ======
  function switchView(view) {
    state.view = view;
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.nma-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.view === view);
    });
    overlay.querySelectorAll('.nma-view').forEach((v) => {
      v.classList.toggle('active', v.dataset.view === view);
    });
    if (view === 'profile' && state.user) {
      // 已加载过, 切回去刷一下
      renderProfile();
    } else if (view === 'search') {
      const input = overlay.querySelector('#nma-search-input');
      if (input) setTimeout(() => input.focus(), 100);
    } else if (view === 'daily') {
      loadDailyDiscovery(false);
    } else if (view === 'settings') {
      renderSettings();
    }
  }

  function switchProfileTab(tab) {
    state.profileTab = tab;
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.nma-ptab').forEach((t) => {
      t.classList.toggle('active', t.dataset.ptab === tab);
    });
    overlay.querySelector('#nma-playlist-list').style.display = tab === 'playlist' ? '' : 'none';
    overlay.querySelector('#nma-liked-list').style.display = tab === 'liked' ? '' : 'none';
    overlay.querySelector('#nma-cloud-list').style.display = tab === 'cloud' ? '' : 'none';

    // 按需加载
    if (tab === 'liked' && state.likedSongs.length === 0) {
      loadLikedSongs();
    } else if (tab === 'cloud' && state.cloudSongs.length === 0) {
      loadCloudSongs();
    } else if (tab === 'liked') {
      renderLikedList();
    } else if (tab === 'cloud') {
      renderCloudList();
    }
  }

  // ====== 加载"我的"页数据 ======
  async function loadProfile() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const loadingEl = overlay.querySelector('#nma-profile-loading');
    const emptyEl = overlay.querySelector('#nma-profile-empty');

    // 检查登录态
    if (!global.NeteaseMusic || !global.NeteaseMusic.isLoggedIn()) {
      loadingEl.style.display = 'none';
      emptyEl.style.display = '';
      return;
    }

    try {
      state.loading = true;
      // 1. 用户信息
      const user = await global.NeteaseMusic.getLoginStatus();
      if (!user) throw new Error('未登录');
      state.user = user;

      // 2. 用户统计
      state.subcount = await global.NeteaseMusic.userSubcount();

      // 3. 用户歌单
      state.playlists = await global.NeteaseMusic.userPlaylist(user.userId, 50);

      loadingEl.style.display = 'none';
      renderProfile();
    } catch (e) {
      console.error('[NMA] loadProfile failed:', e);
      loadingEl.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.querySelector('.nma-empty-text').textContent = `加载失败: ${e.message || e}`;
    } finally {
      state.loading = false;
    }
  }

  // ====== 渲染"我的"页 ======
  function renderProfile() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay || !state.user) return;

    const header = overlay.querySelector('#nma-profile-header');
    const tabs = overlay.querySelector('#nma-profile-tabs');
    header.style.display = '';
    tabs.style.display = '';

    const avatar = overlay.querySelector('#nma-user-avatar');
    avatar.src = state.user.avatarUrl || '';
    avatar.onerror = () => { avatar.style.display = 'none'; };
    overlay.querySelector('#nma-user-name').textContent = state.user.nickname || '--';
    const vipBadge = overlay.querySelector('#nma-user-vip');
    // 简化为总是显示 VIP 徽章, 真实场景需要 user.vipType 字段
    vipBadge.style.display = '';

    overlay.querySelector('#nma-stat-red').textContent = state.subcount?.subCount || 0;
    overlay.querySelector('#nma-stat-playlist').textContent = (state.subcount?.createdPlaylistCount || 0) + (state.subcount?.subPlaylistCount || 0);
    overlay.querySelector('#nma-stat-cloud').textContent = '0'; // cloud count 需要 user/cloud 长度

    // 歌单列表
    renderPlaylistList();
  }

  function renderPlaylistList() {
    const overlay = document.getElementById('netease-music-app-overlay');
    const listEl = overlay.querySelector('#nma-playlist-list');
    if (!listEl) return;

    if (state.playlists.length === 0) {
      listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">还没有歌单</div></div>';
      return;
    }

    listEl.innerHTML = state.playlists.map((p) => `
      <div class="nma-list-item" data-playlist-id="${p.id}">
        <img class="nma-list-cover" src="${p.coverImgUrl || ''}" alt="" onerror="this.style.background='linear-gradient(135deg,#FFB6C1,#FFE4A0)';this.src='';" />
        <div class="nma-list-info">
          <div class="nma-list-title">${escapeHtml(p.name)}</div>
          <div class="nma-list-count">${p.trackCount || 0} 首 · ${formatPlayCount(p.playCount)} 次播放</div>
        </div>
      </div>
    `).join('');

    // 绑定点击 → 打开歌单详情
    listEl.querySelectorAll('.nma-list-item').forEach((el) => {
      el.addEventListener('click', () => openPlaylistDetail(parseInt(el.dataset.playlistId, 10)));
    });
  }

  // ====== 歌单详情 ======
  async function openPlaylistDetail(playlistId) {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const detailSongs = overlay.querySelector('#nma-detail-songs');
    const detailTitle = overlay.querySelector('#nma-detail-title');
    detailSongs.innerHTML = '<div class="nma-loading-text">加载歌曲...</div>';

    switchView('playlist-detail');
    detailTitle.textContent = '加载中...';

    try {
      const detail = await global.NeteaseMusic.playlistDetail(playlistId);
      const songs = await global.NeteaseMusic.playlistTracks(playlistId, 500);
      state.playlistDetail = detail;
      state.playlistSongs = songs;
      detailTitle.textContent = detail?.name || '歌单';
      renderDetailSongs();
    } catch (e) {
      console.error('[NMA] openPlaylistDetail failed:', e);
      detailSongs.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">加载失败</div></div>';
    }
  }
  function getNmaPreferredQuality() {
    try {
      return localStorage.getItem('netease_music_quality') || 'exhigh';
    } catch (e) {
      return 'exhigh';
    }
  }

  function ensureNeteasePlayerPlaylist() {
    const musicState = window.musicState;
    if (!musicState) return null;
    if (!Array.isArray(musicState.playlists)) {
      musicState.playlists = [{ id: 'default', name: '默认', createdAt: Date.now() }];
    }

    const detail = state.playlistDetail || {};
    const playlistId = detail.id ? `netease_${detail.id}` : `netease_${Date.now()}`;
    const playlistName = detail.name ? `网易云 - ${detail.name}` : '网易云歌单';
    let playerPlaylist = musicState.playlists.find(p => p.id === playlistId);
    if (!playerPlaylist) {
      playerPlaylist = {
        id: playlistId,
        name: playlistName,
        createdAt: Date.now(),
        source: 'netease_real',
        neteasePlaylistId: detail.id || null
      };
      musicState.playlists.push(playerPlaylist);
    } else {
      playerPlaylist.name = playlistName;
    }

    musicState.activePlaylistId = playlistId;
    return playlistId;
  }

  function buildNeteasePlayerTrack(song, playlistId) {
    if (!song || song.id == null) return null;
    return {
      name: song.name || '未知歌曲',
      artist: song.artist || '',
      album: song.album || '',
      cover: song.cover || '',
      isLocal: false,
      source: 'netease_real',
      id: song.id,
      artists: song.artists || [],
      albumId: song.albumId,
      duration: song.duration,
      fee: song.fee,
      preferredQuality: getNmaPreferredQuality(),
      playlistId: playlistId
    };
  }

  async function importCurrentPlaylistToPlayer() {
    const overlay = document.getElementById('netease-music-app-overlay');
    const btn = overlay ? overlay.querySelector('#nma-import-playlist-btn') : null;
    if (!state.playlistSongs || state.playlistSongs.length === 0) {
      showNmaToast('当前歌单没有可导入歌曲', 'error');
      return;
    }
    if (!window.musicState || typeof window.addOrUpdateMusicTrack !== 'function') {
      showNmaToast('一起听播放器还没准备好', 'error');
      return;
    }

    const oldText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '导入中...';
    }

    try {
      const playlistId = ensureNeteasePlayerPlaylist();
      if (!playlistId) throw new Error('播放器歌单不可用');

      let added = 0;
      let updated = 0;
      // 【2026-07-07 修复】导入网易云歌单时同步拉 lyric 注入 track.lrcContent，
      //   避免「网易云导入歌单后切歌不显示歌词」（用户档案: 现搜能显示，导入不行）
      //   原因: buildNeteasePlayerTrack 没填 lrcContent；现搜路径走 getPlayableSongDetails 有填。
      //   注: lyric 有 24h localStorage 缓存 (netease-music.js CACHE_TTL.lyric)，所以重复拉不重发请求。
      await Promise.all(state.playlistSongs.map(async (song) => {
        const track = buildNeteasePlayerTrack(song, playlistId);
        if (!track) return;
        try {
          if (global.NeteaseMusic && typeof global.NeteaseMusic.getLyric === 'function') {
            const lrc = await global.NeteaseMusic.getLyric(song.id);
            if (lrc) track.lrcContent = lrc;
          }
        } catch (e) {
          console.warn('[NMA] import getLyric failed for', song.id, e);
        }
        const result = window.addOrUpdateMusicTrack(track);
        if (result.added) added++;
        else updated++;
      }));

      if (typeof window.saveGlobalPlaylist === 'function') await window.saveGlobalPlaylist();
      if (typeof window.updatePlaylistUI === 'function') window.updatePlaylistUI();
      showNmaToast(`已导入 ${added} 首，更新 ${updated} 首`);
    } catch (e) {
      console.error('[NMA] importCurrentPlaylistToPlayer failed:', e);
      showNmaToast('导入失败: ' + (e.message || e), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || '导入一起听';
      }
    }
  }

  function renderDetailSongs() {
    const overlay = document.getElementById('netease-music-app-overlay');
    const listEl = overlay.querySelector('#nma-detail-songs');
    if (!listEl || !state.playlistSongs.length) {
      listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">空歌单</div></div>';
      return;
    }
    listEl.innerHTML = state.playlistSongs.map((s, i) => `
      <div class="nma-song-item" data-song-id="${s.id}" data-song-index="${i}">
        <div class="nma-song-idx">${i + 1}</div>
        <div class="nma-song-info">
          <div class="nma-song-title">${escapeHtml(s.name)}${s.fee === 1 ? ' <span class="nma-vip-badge">VIP</span>' : ''}</div>
          <div class="nma-song-artist">${escapeHtml(s.artist)} · ${escapeHtml(s.album || '')}</div>
        </div>
        <button class="nma-song-play" data-play-id="${s.id}">▶</button>
      </div>
    `).join('');

    listEl.querySelectorAll('.nma-song-play').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.playId, 10);
        playSingleSong(id);
      });
    });
  }

  // ====== 播放单首 (走"一起听"机制) ======
  async function playSingleSong(songId) {
    if (!global.NeteaseMusic) return;
    try {
      // 拿歌曲详情
      const detail = await global.NeteaseMusic.getSongDetail(songId);
      if (!detail) {
        showNmaToast('拿不到歌曲信息', 'error');
        return;
      }
      // 拿 url
      const urlResult = await global.NeteaseMusic.getSongUrl(songId, 'exhigh');
      if (!urlResult || !urlResult.url) {
        showNmaToast('拿不到播放链接（可能是 VIP 限制 / cookie 失效）', 'error');
        return;
      }
      // 拿歌词 (供一起听播放器显示 + AI prompt 注入)
      let lrcContent = '';
      try {
        lrcContent = await global.NeteaseMusic.getLyric(songId);
      } catch (e) {
        console.warn('[NMA] getLyric failed:', e);
      }

      // 构造一起听播放器的 song 对象
      const songInfo = {
        name: detail.name || '未知歌曲',
        artist: detail.artist || '',
        album: detail.albumName || '',
        cover: detail.cover || '',
        src: urlResult.url,
        isLocal: false,
        lrcContent: lrcContent,
        // 额外元数据供 AI prompt 使用
        artists: detail.artists || [],
        albumId: detail.albumId,
        publishTime: detail.publishTime,
        duration: detail.duration,
        fee: detail.fee,
        // 标记为网易云真实源
        source: 'netease_real',
        id: songId,
      };

      // 关闭网易云 App
      closeNeteaseMusicApp();

      if (window.playTemporaryNeteaseTrack) {
        const activeChatId = state.activeChatId || (window.state && window.state.activeChatId);
        const ok = await window.playTemporaryNeteaseTrack(songInfo, activeChatId);
        if (!ok) {
          console.error('[NMA] playTemporaryNeteaseTrack failed');
        }
      } else {
        // 兜底: 只临时播放, 不写入播放器歌单
        console.warn('[NMA] playTemporaryNeteaseTrack not found, using direct audio fallback');
        const listenBtn = document.querySelector('#listen-together-btn');
        if (listenBtn) listenBtn.click();
        setTimeout(() => {
          const ap = window.audioPlayer || document.getElementById('audio-player');
          if (ap) {
            ap.src = songInfo.src;
            ap.play().catch(() => {});
          }
        }, 500);
      }
    } catch (e) {
      console.error('[NMA] playSingleSong failed:', e);
      showNmaToast('播放失败: ' + (e.message || e), 'error');
    }
  }

  // ====== 红心 / 云盘 ======
  async function loadLikedSongs() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay || !state.user) return;
    const listEl = overlay.querySelector('#nma-liked-list');
    listEl.innerHTML = '<div class="nma-loading-text">加载红心...</div>';
    try {
      const ids = await global.NeteaseMusic.likelist(state.user.userId);
      // ids 列表, 显示简单 ID + 名字 (完整列表需要再调 song/detail batch, 这里简化)
      listEl.innerHTML = ids.length === 0
        ? '<div class="nma-empty"><div class="nma-empty-text">还没有红心歌</div></div>'
        : ids.slice(0, 100).map((id, i) => `
          <div class="nma-song-item" data-song-id="${id}">
            <div class="nma-song-idx">${i + 1}</div>
            <div class="nma-song-info">
              <div class="nma-song-title">红心歌曲 #${id}</div>
              <div class="nma-song-artist">点击 ▶ 播放</div>
            </div>
            <button class="nma-song-play" data-play-id="${id}">▶</button>
          </div>
        `).join('');
      listEl.querySelectorAll('.nma-song-play').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          playSingleSong(parseInt(btn.dataset.playId, 10));
        });
      });
    } catch (e) {
      listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">加载失败</div></div>';
    }
  }

  async function loadCloudSongs() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const listEl = overlay.querySelector('#nma-cloud-list');
    listEl.innerHTML = '<div class="nma-loading-text">加载云盘...</div>';
    try {
      const songs = await global.NeteaseMusic.userCloud(100, 0);
      if (songs.length === 0) {
        listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">云盘是空的</div></div>';
        return;
      }
      listEl.innerHTML = songs.map((s, i) => `
        <div class="nma-song-item" data-song-id="${s.id}">
          <div class="nma-song-idx">${i + 1}</div>
          <div class="nma-song-info">
            <div class="nma-song-title">${escapeHtml(s.name)}</div>
            <div class="nma-song-artist">${escapeHtml(s.artist)} · ${formatSize(s.size)}</div>
          </div>
          <button class="nma-song-play" data-play-id="${s.id}">▶</button>
        </div>
      `).join('');
      listEl.querySelectorAll('.nma-song-play').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          playSingleSong(parseInt(btn.dataset.playId, 10));
        });
      });
    } catch (e) {
      listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">加载失败</div></div>';
    }
  }

  function renderLikedList() {} // 占位
  function renderCloudList() {}  // 占位

  // ============================================================
  // 「今日私选」(2026-10-21) —— AI 每日荐歌
  //
  // 【一条播放链路原则】这里不造第二个播放器:
  //   - 点单曲   → 复用 playSingleSong() → playTemporaryNeteaseTrack()
  //   - 播放全部 → 复用「导入一起听」那套: 建一个专属歌单 + 塞进 musicState.playlist
  //     然后走 playSong()。这样「下一首」按钮、歌词、进度条全是现成的。
  // ============================================================

  const DAILY_PLAYLIST_ID = 'daily_discovery';

  function resolveDailyChatId() {
    if (global.MusicDailyDiscovery && typeof global.MusicDailyDiscovery.resolveChatId === 'function') {
      return global.MusicDailyDiscovery.resolveChatId();
    }
    const st = global.state;
    if (!st) return null;
    if (st.activeChatId && st.chats && st.chats[st.activeChatId]) return st.activeChatId;
    if (st.chats) {
      const ids = Object.keys(st.chats);
      if (ids.length === 1) return ids[0];
    }
    return null;
  }

  /** 最近一张非空的日推卡 —— 刷新失败时兜底 (教程 Ch18) */
  async function findLatestDailyCard(chatId) {
    const dbi = global.db;
    if (!dbi || !dbi.dailyDiscovery) return null;
    try {
      const cards = await dbi.dailyDiscovery.where('chatId').equals(chatId).toArray();
      cards.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return cards.find((c) => c.songs && c.songs.length) || null;
    } catch (e) {
      return null;
    }
  }

  async function loadDailyDiscovery(refresh) {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const listEl = overlay.querySelector('#nmd-list');
    const MD = global.MusicDailyDiscovery;
    if (!MD) {
      if (listEl) listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">今日私选模块没加载</div></div>';
      return;
    }
    if (state.dailyLoading) return;
    state.dailyLoading = true;

    const chatId = resolveDailyChatId();
    if (!chatId) {
      state.dailyLoading = false;
      if (listEl) listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">没找到角色, 先开个聊天再来</div></div>';
      return;
    }
    state.dailyChatId = chatId;

    const refreshBtn = overlay.querySelector('#nmd-refresh-btn');
    const playAllBtn = overlay.querySelector('#nmd-playall-btn');
    if (refreshBtn) refreshBtn.disabled = true;
    if (playAllBtn) playAllBtn.disabled = true;

    // 【别让用户干等】秒数在跑, 说明它还活着; 超时会自己变成一行报错 + 重试按钮
    const startedAt = Date.now();
    const baseText = refresh ? '正在重新挑歌, 稍等一下...' : '正在挑今天的歌...';
    let tickTimer = null;
    if (listEl) {
      listEl.innerHTML = `<div class="nma-loading-text">${baseText} <span id="nmd-elapsed">0</span>s</div>`;
      const elapsedEl = () => overlay.querySelector('#nmd-elapsed');
      tickTimer = setInterval(() => {
        const el = elapsedEl();
        if (!el || !el.isConnected) { clearInterval(tickTimer); tickTimer = null; return; }
        el.textContent = String(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);
    }

    try {
      const card = await MD.ensureTodayCard(chatId, { refresh: !!refresh });
      state.dailyCard = card;
      renderDailyDiscovery();
    } catch (e) {
      console.error('[NMA] loadDailyDiscovery failed:', e);
      const fallback = await findLatestDailyCard(chatId);
      if (fallback) {
        state.dailyCard = fallback;
        renderDailyDiscovery('今天没生成出来, 先看最近一批');
      } else {
        const msg = (e && e.message) || String(e);
        renderDailyDiscovery(null, '生成失败: ' + msg);
        if (listEl) {
          const retry = document.createElement('button');
          retry.className = 'nmd-btn nmd-daily-retry';
          retry.type = 'button';
          retry.textContent = '再试一次';
          retry.addEventListener('click', () => { loadDailyDiscovery(true); });
          listEl.appendChild(retry);
        }
      }
    } finally {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      state.dailyLoading = false;
      if (refreshBtn) refreshBtn.disabled = false;
      if (playAllBtn) playAllBtn.disabled = false;
    }
  }

  function renderDailyDiscovery(warning, errorText) {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const listEl = overlay.querySelector('#nmd-list');
    const titleEl = overlay.querySelector('#nmd-title');
    const subEl = overlay.querySelector('#nmd-sub');
    const noteEl = overlay.querySelector('#nmd-note');
    const playAllBtn = overlay.querySelector('#nmd-playall-btn');
    const card = state.dailyCard;

    if (!card) {
      if (titleEl) titleEl.textContent = '今日私选';
      if (subEl) subEl.textContent = errorText || '';
      if (noteEl) noteEl.style.display = 'none';
      if (playAllBtn) playAllBtn.style.display = 'none';
      if (listEl) {
        listEl.innerHTML = `<div class="nma-empty"><div class="nma-empty-text">${escapeHtml(errorText || '今天还没挑好')}</div></div>`;
      }
      return;
    }

    if (titleEl) titleEl.textContent = `今日私选 · ${card.date}`;
    if (subEl) subEl.textContent = warning ? warning : (card.subtitle || '');
    if (noteEl) {
      if (card.note) { noteEl.textContent = card.note; noteEl.style.display = ''; }
      else noteEl.style.display = 'none';
    }
    if (playAllBtn) playAllBtn.style.display = '';

    if (!listEl) return;
    if (!card.songs || !card.songs.length) {
      listEl.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">今天没挑到歌</div></div>';
      return;
    }

    listEl.innerHTML = card.songs.map((s, i) => `
      <div class="nmd-song" data-song-id="${escapeHtml(s.id)}">
        <div class="nmd-idx">${i + 1}</div>
        ${s.cover
          ? `<img class="nmd-cover" src="${escapeHtml(s.cover)}" loading="lazy" decoding="async" alt="" />`
          : '<div class="nmd-cover"></div>'}
        <div class="nmd-info">
          <div class="nmd-name">${escapeHtml(s.name)}<span class="nmd-tag">${escapeHtml(s.tag || '旁白')}</span></div>
          <div class="nmd-artist">${escapeHtml(s.artist)}${s.album ? ' · ' + escapeHtml(s.album) : ''}</div>
          <div class="nmd-reason">${escapeHtml(s.reason || '')}</div>
        </div>
        <div class="nmd-actions">
          <button class="nmd-play" data-play-id="${escapeHtml(s.id)}" type="button">▶</button>
          <button class="nmd-fb-btn" data-fb-id="${escapeHtml(s.id)}" type="button" title="反馈">⋯</button>
        </div>
      </div>
      <div class="nmd-feedback" data-fb-row="${escapeHtml(s.id)}" style="display:none;"></div>
    `).join('');

    listEl.querySelectorAll('.nmd-play').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        playDailySong(btn.dataset.playId);
      });
    });

    listEl.querySelectorAll('.nmd-fb-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDailyFeedback(btn.dataset.fbId);
      });
    });
  }

  function findDailySong(songId) {
    const card = state.dailyCard;
    if (!card || !card.songs) return null;
    return card.songs.find((s) => String(s.id) === String(songId)) || null;
  }

  /** 播放单曲 —— 复用已有的单曲播放链路 */
  async function playDailySong(songId) {
    const song = findDailySong(songId);
    if (!song) {
      showNmaToast('找不到这首歌', 'error');
      return;
    }
    await playSingleSong(song.id);
  }

  /** 反馈菜单 —— 展开一排小 chip, 同一时间只开一个 (移动端不挤) */
  function toggleDailyFeedback(songId) {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const rows = overlay.querySelectorAll('.nmd-feedback');
    let row = null;
    rows.forEach((r) => { if (r.dataset.fbRow === String(songId)) row = r; });
    if (!row) return;

    const wasOpen = row.style.display !== 'none';
    rows.forEach((r) => { r.style.display = 'none'; });
    if (wasOpen) return;

    const MD = global.MusicDailyDiscovery;
    const labels = MD && typeof MD.feedbackLabels === 'function' ? MD.feedbackLabels() : {};
    const actions = ['like', 'heard', 'more_like_this', 'less_like_this', 'dislike'];
    row.innerHTML = actions
      .map((a) => `<button class="nmd-chip" data-fb-action="${a}" type="button">${escapeHtml(labels[a] || a)}</button>`)
      .join('');
    row.style.display = '';

    row.querySelectorAll('.nmd-chip').forEach((chip) => {
      chip.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const action = chip.dataset.fbAction;
        const song = findDailySong(songId);
        let ok = false;
        try {
          ok = await MD.submitFeedback(state.dailyChatId, songId, action, song ? song.artist : '');
        } catch (e) {
          console.error('[NMA] submitFeedback failed:', e);
        }
        if (ok) {
          showNmaToast(`记下了: ${labels[action] || action} —— 下次会照着来`);
          row.style.display = 'none';
        } else {
          showNmaToast('反馈没记上', 'error');
        }
      });
    });
  }

  /** 播放全部 —— 建一个专属歌单塞进队列, 然后走现成的 playSong */
  async function playAllDailySongs() {
    const overlay = document.getElementById('netease-music-app-overlay');
    const card = state.dailyCard;
    if (!card || !card.songs || !card.songs.length) {
      showNmaToast('今天还没有歌', 'error');
      return;
    }
    const musicState = global.musicState;
    if (!musicState || typeof global.playSong !== 'function') {
      showNmaToast('一起听播放器还没准备好', 'error');
      return;
    }

    const btn = overlay ? overlay.querySelector('#nmd-playall-btn') : null;
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '准备中...'; }

    try {
      // 1. 准备一个固定 id 的歌单 (每天覆盖, 不会越攒越多)
      if (!Array.isArray(musicState.playlists)) musicState.playlists = [];
      let pl = musicState.playlists.find((p) => p.id === DAILY_PLAYLIST_ID);
      if (!pl) {
        pl = { id: DAILY_PLAYLIST_ID, name: '今日私选', createdAt: Date.now(), source: 'daily_discovery' };
        musicState.playlists.push(pl);
      } else {
        pl.name = '今日私选';
      }
      musicState.activePlaylistId = DAILY_PLAYLIST_ID;

      // 2. 把上一批今日私选的条目清掉
      if (!Array.isArray(musicState.playlist)) musicState.playlist = [];
      musicState.playlist = musicState.playlist.filter((t) => (t.playlistId || 'default') !== DAILY_PLAYLIST_ID);

      // 3. 塞今天的歌
      //    ⚠️ 这里【故意不用】addOrUpdateMusicTrack —— 它按 songId 全局去重,
      //    已经在别的歌单里的歌会被"合并"回原歌单, 导致今日私选歌单里少歌。
      const firstIndex = musicState.playlist.length;
      card.songs.forEach((song) => {
        const track = buildNeteasePlayerTrack(song, DAILY_PLAYLIST_ID);
        if (track) musicState.playlist.push(track);
      });

      if (typeof global.saveGlobalPlaylist === 'function') await global.saveGlobalPlaylist();
      if (typeof global.updatePlaylistUI === 'function') global.updatePlaylistUI();

      // 4. 确保一起听会话是开着的 (播放器要绑当前聊天)
      const chatId = state.dailyChatId || resolveDailyChatId();

      // v60 拆表之后, chat.history 只在"消息窗口加载过"的聊天上才是数组
      // (而且 push 被 message-store 包过, 会自动写 messages 表)。
      // 窗口没加载过的聊天上它是 undefined → playSong 里的
      // addMusicActionSystemMessage 一 push 就抛, 歌根本放不出来。
      // 这里先让 messageStore 把窗口挂上, 保证播放链路不断。
      if (chatId && global.messageStore && typeof global.messageStore.loadRecentMessages === 'function') {
        try {
          await global.messageStore.loadRecentMessages(chatId, 50);
        } catch (e) {
          console.warn('[NMA] loadRecentMessages failed:', e);
        }
      }

      if (chatId && (!musicState.isActive || musicState.activeChatId !== chatId)) {
        if (typeof global.startListenTogetherSession === 'function') {
          global.startListenTogetherSession(chatId, false);
        }
      }

      // 5. 打开全屏播放器并开播
      const playerOverlay = document.getElementById('music-player-overlay');
      if (playerOverlay) playerOverlay.classList.add('visible');
      await global.playSong(firstIndex);

      showNmaToast(`开始播放今天这 ${card.songs.length} 首`);
    } catch (e) {
      console.error('[NMA] playAllDailySongs failed:', e);
      showNmaToast('播放全部失败: ' + (e.message || e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText || '播放全部'; }
    }
  }

  // ====== 搜索 ======
  // 【2026-07-04 防卡死】doSearch 加状态管理 + 串行执行（防止用户狂点搜索按钮触发并发 fetch）
  let _searching = false;
  let _searchSeq = 0;  // 序列号，丢弃过期结果
  async function doSearch() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    if (_searching) return;  // 已经在搜，丢弃这次请求
    const input = overlay.querySelector('#nma-search-input');
    const results = overlay.querySelector('#nma-search-results');
    const keyword = (input?.value || '').trim();
    if (!keyword) return;
    if (!global.NeteaseMusic || !global.NeteaseMusic.isLoggedIn()) {
      results.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">请先登录</div></div>';
      return;
    }
    const seq = ++_searchSeq;  // 当前请求序列号
    _searching = true;
    results.innerHTML = '<div class="nma-loading-text">搜索中...</div>';
    try {
      const songs = await global.NeteaseMusic.search(keyword, 30);
      // 过期请求丢弃
      if (seq !== _searchSeq) return;
      if (songs.length === 0) {
        results.innerHTML = '<div class="nma-empty"><div class="nma-empty-text">没搜到</div></div>';
        return;
      }
      results.innerHTML = songs.map((s) => `
        <div class="nma-song-item">
          <img class="nma-list-cover" src="${s.cover || ''}" loading="lazy" decoding="async" />
          <div class="nma-song-info">
            <div class="nma-song-title">${escapeHtml(s.name)}</div>
            <div class="nma-song-artist">${escapeHtml(s.artist)}</div>
          </div>
          <button class="nma-song-play" data-play-id="${s.id}">▶</button>
        </div>
      `).join('');
      results.querySelectorAll('.nma-song-play').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          playSingleSong(parseInt(btn.dataset.playId, 10));
        });
      });
    } catch (e) {
      if (seq !== _searchSeq) return;
      console.error('[NMA] search failed:', e);
      results.innerHTML = `<div class="nma-empty"><div class="nma-empty-text">搜索失败: ${escapeHtml(String(e.message || e))}</div></div>`;
    } finally {
      if (seq === _searchSeq) _searching = false;
    }
  }

  // ====== 设置 ======
  function renderSettings() {
    const overlay = document.getElementById('netease-music-app-overlay');
    if (!overlay) return;
    const loginEl = overlay.querySelector('#nma-setting-login');
    const qualityEl = overlay.querySelector('#nma-setting-quality');
    if (global.NeteaseMusic) {
      const isLogin = global.NeteaseMusic.isLoggedIn();
      loginEl.textContent = isLogin ? '已登录' : '未登录';
      let quality = 'exhigh';
      try { quality = localStorage.getItem('netease_music_quality') || 'exhigh'; } catch (e) {}
      qualityEl.textContent = quality;
    }
  }

  // ====== 工具函数 ======
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  function formatPlayCount(n) {
    n = n || 0;
    if (n > 10000) return (n / 10000).toFixed(1) + '万';
    return n.toString();
  }
  function formatSize(b) {
    b = b || 0;
    if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
    return (b / 1024).toFixed(0) + 'KB';
  }

  // ====== 暴露 ======
  global.NeteaseMusicApp = {
    open: openNeteaseMusicApp,
    close: closeNeteaseMusicApp,
  };
})(window);

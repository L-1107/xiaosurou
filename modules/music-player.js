// ============================================================
// music-player.js
// 来源：script.js 第 19473~20210 + 31283~31535 + 38006~38870 行
//       以及散落的辅助函数（saveGlobalPlaylist、addMusicActionSystemMessage、
//       applyLyricsBarPosition、getLrcContent、togglePlaylistManagementMode、
//       handlePlaylistSelection 等）
// 功能：一起听、播放器 UI、歌单管理、播放控制、歌词解析/渲染、
//       音乐搜索（网易云/腾讯/Toubiec）、添加歌曲、删除歌曲
// ============================================================

(function () {
  // 延迟获取全局变量 - 使用 Proxy 确保在访问时才从 window 获取
  // 这样可以避免模块加载时 init-and-state.js 还未执行导致的 undefined 问题
  const state = new Proxy({}, {
    get: (target, prop) => window.state?.[prop]
  });
  
  const musicState = new Proxy({}, {
    get: (target, prop) => window.musicState?.[prop],
    set: (target, prop, value) => {
      if (window.musicState) {
        window.musicState[prop] = value;
        return true;
      }
      return false;
    }
  });
  
  const audioPlayer = new Proxy({}, {
    get: (target, prop) => {
      const player = window.audioPlayer;
      if (!player) return undefined;
      const value = player[prop];
      return typeof value === 'function' ? value.bind(player) : value;
    },
    set: (target, prop, value) => {
      if (window.audioPlayer) {
        window.audioPlayer[prop] = value;
        return true;
      }
      return false;
    }
  });

  // 【2026-07-25 修复】自定义胶片封面兜底——
  // 网易云/腾讯那些有 track.cover 的歌继续用专辑封面；
  // AI 生成 / 本地歌曲没封面的，fallback 到用户上传的胶片图；
  // 都没有再走默认 URL。
  // 之前 3 个地方硬写 `track.cover || '...默认URL'`，自定义封面永远不显示。
  const DEFAULT_COVER_URL = 'https://s3plus.meituan.net/opapisdk/op_ticket_885190757_1757748720126_qdqqd_1jt5sv.jpeg';
  function getEffectiveCoverUrl(track) {
    const trackCover = track && track.cover ? track.cover : '';
    if (trackCover) return trackCover;
    try {
      // custom-music-cover.js 暴露的全局方法，读不到时返回空串
      return (window.MusicCustomCover && window.MusicCustomCover.getCustomCover()) || '';
    } catch (e) {
      return '';
    }
  }

  // 来源：script.js 第 3020~3060 行
  function applyLyricsBarPosition(chat) {
    const lyricsBar = document.getElementById('global-lyrics-bar');

    const settings = chat.settings.lyricsPosition || {
      vertical: 'top',
      horizontal: 'center',
      offset: 10
    };


    lyricsBar.style.top = 'auto';
    lyricsBar.style.bottom = 'auto';
    lyricsBar.style.left = 'auto';
    lyricsBar.style.right = 'auto';
    lyricsBar.style.transform = 'none';


    if (settings.vertical === 'top') {
      lyricsBar.style.top = `${settings.offset}px`;
    } else {
      lyricsBar.style.bottom = `${settings.offset}px`;
    }


    switch (settings.horizontal) {
      case 'left':
        lyricsBar.style.left = '15px';
        break;
      case 'right':
        lyricsBar.style.right = '15px';
        break;
      case 'center':
      default:
        lyricsBar.style.left = '50%';
        lyricsBar.style.transform = 'translateX(-50%)';
        break;
    }
  }

  // 来源：script.js 第 4212~4260 行
  async function getLrcContent() {

    const choice = await showChoiceModal('选择歌词导入方式', [{
      text: '📁 从本地文件 (.lrc)',
      value: 'file'
    },
    {
      text: '📋 直接粘贴歌词文本',
      value: 'paste'
    }
    ]);


    if (choice === 'file') {

      return new Promise(resolve => {
        const lrcInput = document.getElementById('lrc-upload-input');
        const lrcChangeHandler = (e) => {
          const lrcFile = e.target.files[0];
          if (lrcFile) {
            const reader = new FileReader();
            reader.onload = (readEvent) => resolve(readEvent.target.result);
            reader.onerror = () => resolve("");
            reader.readAsText(lrcFile);
          } else {
            resolve(null);
          }
          lrcInput.removeEventListener('change', lrcChangeHandler);
          lrcInput.value = '';
        };
        lrcInput.addEventListener('change', lrcChangeHandler, {
          once: true
        });
        lrcInput.click();
      });
    } else if (choice === 'paste') {

      const pastedText = await showCustomPrompt(
        '粘贴歌词',
        '请在此处粘贴完整的LRC格式歌词...',
        '',
        'textarea'
      );


      if (pastedText) {


        const formattedText = pastedText.replace(/\[/g, '\n[').trim();
        return formattedText;
      }
      return pastedText;


    } else {

      return null;
    }
  }

  // 来源：script.js 第 7588~7596 行
  async function saveGlobalPlaylist() {
    await db.musicLibrary.put({
      id: 'main',
      playlist: musicState.playlist,
      playlists: musicState.playlists,
      activePlaylistId: musicState.activePlaylistId
    });
  }

  // 来源：script.js 第 32842~32868 行
  async function addMusicActionSystemMessage(actionText) {

    if (!musicState.isActive || !musicState.activeChatId) return;
    const chat = state.chats[musicState.activeChatId];
    if (!chat) return;


    const myNickname = chat.isGroup ? (chat.settings.myNickname || '我') : '我';
    const fullMessage = `[系统提示：用户 (${myNickname}) ${actionText}]`;


    const systemMessage = {
      role: 'system',
      content: fullMessage,
      timestamp: Date.now(),
      isHidden: true
    };


    chat.history.push(systemMessage);
    await db.chats.put(chat);
  }

  // ========== AI 原创曲 / 翻唱 相关（2026-07-21 新增）==========
  const AI_ORIGINAL_PLAYLIST_ID = 'pl_ai_original';
  const AI_ORIGINAL_PLAYLIST_NAME = 'AI 原创';

  // 确保 "AI 原创" 歌单存在（自动创建一次）
  function ensureAiOriginalPlaylist() {
    if (!Array.isArray(musicState.playlists)) musicState.playlists = [];
    let pl = musicState.playlists.find(p => p.id === AI_ORIGINAL_PLAYLIST_ID);
    if (!pl) {
      pl = {
        id: AI_ORIGINAL_PLAYLIST_ID,
        name: AI_ORIGINAL_PLAYLIST_NAME,
        createdAt: Date.now()
      };
      musicState.playlists.push(pl);
    }
    return pl;
  }

  // 推一条系统消息：AI 为你唱了《XX》
  // 跟 addMusicActionSystemMessage 类似但带 aiSong: true 标记
  async function addAiSongActionMessage({ chatId, songId, title, blob }) {
    if (!chatId) return;
    const chat = state.chats[chatId];
    if (!chat) return;
    const titleStr = String(title || songId || 'AI 原创').trim() || 'AI 原创';
    const sizeKB = blob && typeof blob.size === 'number' ? Math.round(blob.size / 1024) : 0;
    const msgContent = `♪ ${chat.name} 为你唱了《${titleStr}》${sizeKB ? ` (${sizeKB}KB)` : ''}`;
    const systemMessage = {
      role: 'system',
      type: 'ai_song_action',
      content: msgContent,
      timestamp: Date.now(),
      isHidden: false,
      aiSong: true,
      songId: songId || null,
      title: titleStr
    };
    chat.history.push(systemMessage);
    try { await db.chats.put(chat); } catch (e) { console.error('[MusicPlayer] addAiSongActionMessage save failed', e); }
    // 实时显示（用户在 chat 界面时立刻渲染）
    const isViewingThisChat = document.getElementById('chat-interface-screen').classList.contains('active') && state.activeChatId === chatId;
    if (isViewingThisChat && typeof appendMessage === 'function') {
      try { appendMessage(systemMessage, chat); } catch (e) { console.error('[MusicPlayer] appendMessage failed', e); }
      // 【2026-07-22 新增】给刚加的消息 DOM 注入下载按钮（消息本身只显示文字，没渲染下载链接）
      // 不依赖 createMessageElement 改 type——避免影响其他消息类型渲染
      setTimeout(() => injectAiSongDownloadButton(systemMessage, blob, titleStr), 30);
    }
  }

  // 给 AI 原创/翻唱的消息 DOM 注入原生下载按钮（用 data:audio/mpeg;base64 绕过 file:// 协议的 blob:null 限制）
  async function injectAiSongDownloadButton(systemMessage, blob, title) {
    try {
      const container = document.getElementById('chat-messages');
      if (!container) return;
      // 找刚加的消息节点：按 timestamp + type 精确定位
      const ts = systemMessage.timestamp;
      const allMessages = container.querySelectorAll('.message, [class*="message-"], [data-message-timestamp]');
      let targetEl = null;
      for (const el of allMessages) {
        const elTs = Number(el.dataset?.messageTimestamp || el.getAttribute('data-timestamp') || 0);
        if (elTs === ts) { targetEl = el; break; }
      }
      // 兜底：找最后一个非 typing-indicator 子节点
      if (!targetEl) {
        const children = container.children;
        for (let i = children.length - 1; i >= 0; i--) {
          if (children[i].id === 'typing-indicator') continue;
          targetEl = children[i];
          break;
        }
      }
      if (!targetEl) return;
      // 避免重复注入
      if (targetEl.querySelector('.ai-song-download-btn')) return;
      // blob → data URI（base64），绕过 file:// 协议下 blob:null/... 不能被 audio 元素播放的限制
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const btn = document.createElement('a');
      btn.className = 'ai-song-download-btn';
      btn.href = dataUrl;
      btn.download = (title || 'ai-song') + '.mp3';
      btn.textContent = '⤓ 下载 mp3';
      btn.style.cssText = 'display: inline-block; margin-top: 8px; padding: 4px 10px; background: #1a73e8; color: #fff; border-radius: 4px; font-size: 12px; text-decoration: none; cursor: pointer; user-select: none;';
      // 找消息内容容器，避免破坏外层布局
      const contentEl = targetEl.querySelector('.message-content, .msg-content, .message-bubble, .bubble, .content, .text') || targetEl;
      contentEl.appendChild(btn);
    } catch (e) {
      console.error('[MusicPlayer] injectAiSongDownloadButton failed:', e);
    }
  }

  // 【2026-07-22 新增】把 AI 写的歌词转成 LRC 格式（每行 4s 时间戳估算）
  // AI 生成的歌词没时间戳（生成时只输出文字），但播放器 parseLRC 需要 [mm:ss] 格式（见 line 1319）
  // 算法：每行歌词 4s 间隔，[Verse][Chorus] 这种结构标签作为分隔行也带时间戳
  function buildLrcFromLyrics(lyrics) {
    if (!lyrics || !String(lyrics).trim()) return '';
    const STEP = 4; // 秒
    const lines = String(lyrics).split(/\r?\n/);
    const lrcLines = [];
    let t = 0;
    const formatTime = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.00';
    };
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue; // 空行跳过
      lrcLines.push('[' + formatTime(t) + '] ' + trimmed);
      // 结构标签行（[Verse] / [Chorus] 等）只显示但不累计时间，避免结构行占用播放时长
      if (/^\[.*\]$/.test(trimmed)) {
        // 不增加 t
      } else {
        t += STEP;
      }
    }
    return lrcLines.join('\n');
  }

  // 把 AI 原创/翻唱 加到当前播放列表 + AI 原创 专辑
  // 返回 { index, added } 跟 addOrUpdateMusicTrack 一致
  // 【2026-07-22 改】src 不再用 blobUrl（file:// 协议下 <audio> 元素拒绝 blob:null/...）——改用 base64 data URI
  async function addAiSongToPlaylist(blob, metadata) {
    if (!blob || typeof blob.size !== 'number' || blob.size === 0) {
      console.error('[MusicPlayer] addAiSongToPlaylist: invalid blob');
      return { index: -1, added: false, track: null };
    }
    // 【2026-07-22 修】强制 mime type = audio/mpeg——IDB 取出的 blob 经常 type=''，
    //  FileReader.readAsDataURL 对 type='' blob 输出 'data:;base64,xxx'（没 mime 前缀），
    //  <audio> 元素看到 src 没 mime 不知道是音频 → MEDIA_ELEMENT_ERROR 拒绝播放
    //  强制包装成 audio/mpeg → data URI 前缀变 'data:audio/mpeg;base64,xxx' → audio 元素认
    const safeBlob = blob.type === 'audio/mpeg' ? blob : new Blob([blob], { type: 'audio/mpeg' });
    const meta = metadata || {};
    const songId = meta.songId || ('ai_' + Date.now());
    const title = String(meta.title || 'AI 原创').trim() || 'AI 原创';
    const isCover = meta.isCover === true;
    const chatId = meta.chatId || null;
    const createdAt = meta.createdAt || Date.now();

    // 确保 AI 原创 歌单存在
    ensureAiOriginalPlaylist();

    // 【2026-07-22 改】用 base64 data URI 替代 blob URL——绕过 file:// 协议下 blob:null/... 的 safety check
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(safeBlob);
    });

    // 【2026-07-22 新增】把 AI 写的歌词转成 LRC 格式（每行 4s 时间戳估算）
    // AI 生成的歌词没有时间戳，但播放器 parseLRC 需要 [mm:ss] 格式
    const lrcContent = buildLrcFromLyrics(meta.lyrics);

    const track = {
      name: title,
      artist: chatId && state.chats[chatId] ? state.chats[chatId].name : 'AI 原创',
      album: isCover ? 'AI 翻唱' : 'AI 原创',
      cover: '',
      src: dataUrl,
      isLocal: true,
      source: 'ai_song',
      lrcContent: lrcContent,
      playlistId: AI_ORIGINAL_PLAYLIST_ID,
      isAiSong: true,
      isCover: isCover,
      songId: songId,
      chatId: chatId,
      createdAt: createdAt,
      duration: 0
    };
    // 【2026-07-22 修】先按 songId 自己去重一次——getMusicTrackKey 不认 songId 字段,
    //  老歌从 IDB 取出来时 blob mime 可能丢了 (data:audio/mpeg 变成 data:), 每次 src 不一样 → 重复 push
    if (Array.isArray(musicState.playlist)) {
      const dupIdx = musicState.playlist.findIndex(t => t && t.songId === songId);
      if (dupIdx > -1) {
        const existing = musicState.playlist[dupIdx];
        // 顺手刷新 src（用本次最新的 dataUrl）和歌词
        existing.src = dataUrl;
        if (lrcContent) existing.lrcContent = lrcContent;
        if (typeof saveGlobalPlaylist === 'function') {
          try { saveGlobalPlaylist(); } catch (e) { /* ignore */ }
        }
        if (typeof updatePlaylistUI === 'function') {
          try { updatePlaylistUI(); } catch (e) { /* ignore */ }
        }
        console.log('[MusicPlayer] addAiSongToPlaylist: 命中已存在 songId=' + songId + ', index=' + dupIdx + ', 刷新 src/歌词, 不重复 push');
        return { index: dupIdx, added: false, track: existing };
      }
    }

    // 用 addOrUpdateMusicTrack 加到主 playlist（这样能复用去重逻辑）
    const result = addOrUpdateMusicTrack(track);
    if (result.index < 0) {
      console.error('[MusicPlayer] addAiSongToPlaylist: addOrUpdateMusicTrack failed');
      return { index: -1, added: false, track: null };
    }
    // 持久化（包含新歌单 + 新歌曲）
    if (typeof saveGlobalPlaylist === 'function') {
      try { saveGlobalPlaylist(); } catch (e) { console.error('[MusicPlayer] saveGlobalPlaylist failed', e); }
    }
    if (typeof updatePlaylistUI === 'function') {
      try { updatePlaylistUI(); } catch (e) { /* ignore */ }
    }
    return result;
  }

  // 根据 songId 找到对应歌曲并播放
  async function playAiSongImmediately(songId) {
    if (!songId) return false;
    if (!Array.isArray(musicState.playlist)) return false;
    const idx = musicState.playlist.findIndex(t => t && t.songId === songId);
    if (idx < 0) {
      console.warn('[MusicPlayer] playAiSongImmediately: songId not found in playlist:', songId);
      return false;
    }
    try {
      await playSong(idx, true);
      return true;
    } catch (e) {
      console.error('[MusicPlayer] playAiSongImmediately failed:', e);
      return false;
    }
  }

  // ========== 主要音乐播放器功能（来自 script.js 第 19473~20210 行） ==========

  async function handleListenTogetherClick() {
    const targetChatId = state.activeChatId;
    if (!targetChatId) return;
    // If a listen-together session is already active in this chat, the button is a restore action.
    // Opening the NetEase app first makes it hard to get back to the hidden player.
    if (musicState.isActive && musicState.activeChatId === targetChatId && musicState.playlist.length > 0) {
      showMusicPlayerOverlay();
      return;
    }

    if (window.NeteaseMusicApp && window.NeteaseMusicApp.open) {
      window.NeteaseMusicApp.open({ activeChatId: targetChatId });
    } else {
      if (!musicState.isActive) {
        startListenTogetherSession(targetChatId);
      } else {
        showMusicPlayerOverlay();
      }
    }
  }

  async function startListenTogetherSession(chatId, autoPlay = true) {
    const chat = state.chats[chatId];
    if (!chat) return;
    musicState.totalElapsedTime = chat.musicData.totalTime || 0;
    musicState.isActive = true;
    musicState.activeChatId = chatId;
    if (musicState.playlist.length > 0) {
      musicState.currentIndex = 0;
    } else {
      musicState.currentIndex = -1;
    }
    if (musicState.timerId) clearInterval(musicState.timerId);
    musicState.timerId = setInterval(() => {
      if (musicState.isPlaying) {
        musicState.totalElapsedTime++;
        updateElapsedTimeDisplay();
      }
    }, 1000);
    updatePlayerUI();
    updatePlaylistUI();
    document.getElementById('music-player-overlay').classList.add('visible');

    // 【2026-07-04 修复】autoplay 解锁 + 避免"按下一首不能出声"——
    //   nma-go-listen-btn 流程不调 audio.play()，Chrome autoplay policy 仍 lock
    //   —— 用户按下一首时 play() 被 reject NotAllowedError → catch 调 pause → 静默
    //   解决：startListenTogetherSession 末尾如果 playlist 有歌，自动 playSong(0, true)
    //   — 触发 audio.play() 解锁 autoplay，同时启动第一首歌
    if (autoPlay && musicState.playlist.length > 0) {
      playSong(0, true);
    }
  }

  async function endListenTogetherSession(saveState = true) {
    if (!musicState.isActive) return;
    const oldChatId = musicState.activeChatId;
    document.getElementById('global-lyrics-bar').classList.remove('visible');
    const cleanupLogic = async () => {
      if (musicState.timerId) clearInterval(musicState.timerId);
      if (musicState.isPlaying) audioPlayer.pause();
      if (saveState && oldChatId && state.chats[oldChatId]) {
        const chat = state.chats[oldChatId];
        chat.musicData.totalTime = musicState.totalElapsedTime;
        await db.chats.put(chat);
      }
      musicState.isActive = false;
      musicState.activeChatId = null;
      musicState.totalElapsedTime = 0;
      musicState.timerId = null;
      updateListenTogetherIcon(oldChatId, true);
    };
    closeMusicPlayerWithAnimation(cleanupLogic);
  }

  function showMusicPlayerOverlay() {
    const overlay = document.getElementById('music-player-overlay');
    if (!overlay) return false;
    updatePlayerUI();
    updatePlaylistUI();
    overlay.classList.add('visible');
    return true;
  }

  function showMusicIslandRestoreEntry() {
    if (!musicState.isActive) return;
    const phoneScreen = document.getElementById('phone-screen');
    const lyricBar = document.getElementById('global-lyrics-bar');
    const albumArt = document.getElementById('island-album-art');
    const track = musicState.tempTrack || musicState.playlist[musicState.currentIndex];
    if (!phoneScreen || !track) return;
    phoneScreen.classList.add('dynamic-island-active');
    if (albumArt) {
      albumArt.src = getEffectiveCoverUrl(track) || DEFAULT_COVER_URL;
    }
    lyricBar?.classList.remove('visible');
  }

  function returnToChat() {
    closeMusicPlayerWithAnimation(showMusicIslandRestoreEntry);
  }

  function updateListenTogetherIcon(chatId, forceReset = false) {
    const iconImg = document.querySelector('#listen-together-btn img');
    if (!iconImg) return;
    if (forceReset || !musicState.isActive || musicState.activeChatId !== chatId) {
      iconImg.src = 'https://i.postimg.cc/8kYShvrJ/90-UI-2.png';
      iconImg.className = '';
      return;
    }
    iconImg.src = 'https://i.postimg.cc/D0pq6qS2/E30078-DC-8-B99-4-C01-AFDA-74728-DBF7-BEA.png';
    iconImg.classList.add('rotating');
    if (musicState.isPlaying) iconImg.classList.remove('paused');
    else iconImg.classList.add('paused');
  }
  window.updateListenTogetherIconProxy = updateListenTogetherIcon;

  function updatePlayerUI() {
    updateListenTogetherIcon(musicState.activeChatId);
    updateElapsedTimeDisplay();
    const titleEl = document.getElementById('music-player-song-title');
    const artistEl = document.getElementById('music-player-artist');
    const playPauseBtn = document.getElementById('music-play-pause-btn');
    if (musicState.currentIndex > -1 && musicState.playlist.length > 0) {
      const track = musicState.playlist[musicState.currentIndex];
      titleEl.textContent = track.name;
      artistEl.textContent = track.artist;
    } else if (musicState.tempTrack) {
      titleEl.textContent = musicState.tempTrack.name || '临时播放';
      artistEl.textContent = musicState.tempTrack.artist || '';
    } else {
      titleEl.textContent = '请添加歌曲';
      artistEl.textContent = '...';
    }
    playPauseBtn.textContent = musicState.isPlaying ? '❚❚' : '▶';
  }

  function updateElapsedTimeDisplay() {
    const hours = (musicState.totalElapsedTime / 3600).toFixed(1);
    document.getElementById('music-time-counter').textContent = `已经一起听了${hours}小时`;
  }

  function updatePlaylistUI() {
    const playlistBody = document.getElementById('playlist-body');
    playlistBody.innerHTML = '';

    // 渲染歌单标签栏
    renderPlaylistTabs();

    // 按当前歌单过滤
    const currentPlaylistId = musicState.activePlaylistId || 'default';
    const filteredSongs = musicState.playlist
      .map((track, originalIndex) => ({ track, originalIndex }))
      .filter(item => (item.track.playlistId || 'default') === currentPlaylistId);

    if (filteredSongs.length === 0) {
      playlistBody.innerHTML = '<p style="text-align:center; padding: 20px; color: #888;">播放列表是空的~</p>';
      return;
    }
    filteredSongs.forEach(({ track, originalIndex }) => {
      const item = document.createElement('div');
      item.className = 'playlist-item';
      if (originalIndex === musicState.currentIndex) item.classList.add('playing');

      item.dataset.index = originalIndex;

      const checkboxDisplay = isPlaylistManagementMode ? 'block' : 'none';

      const aiTag = track.isAiSong
        ? `<span class="playlist-item-ai-tag" style="font-size:10px; background:linear-gradient(135deg,#7b8cff,#a974ff); color:#fff; padding:1px 6px; border-radius:8px; margin-left:6px; vertical-align:middle;">${track.isCover ? '翻唱' : 'AI原创'}</span>`
        : '';
      item.innerHTML = `
        <input type="checkbox" class="playlist-item-checkbox" style="display: ${checkboxDisplay};" data-index="${originalIndex}">
        <div class="playlist-item-info">
            <div class="title">${track.name}${aiTag}</div>
            <div class="artist">${track.artist}</div>
        </div>
        <div class="playlist-item-actions">
            <span class="playlist-action-btn album-art-btn" data-index="${originalIndex}">专辑</span>
            <span class="playlist-action-btn lyrics-btn" data-index="${originalIndex}">词</span>
            <span class="playlist-action-btn bg-btn" data-index="${originalIndex}">背景</span>
            <span class="playlist-action-btn delete-track-btn" data-index="${originalIndex}">×</span>
        </div>
      `;

      item.addEventListener('click', (e) => {
        if (isPlaylistManagementMode) {
          if (e.target.tagName !== 'INPUT') {
            e.stopPropagation();
          }
          handlePlaylistSelection(originalIndex);
        }
      });

      const infoEl = item.querySelector('.playlist-item-info');
      if (infoEl) {
        infoEl.addEventListener('click', (e) => {
          if (!isPlaylistManagementMode) {
            e.stopPropagation();
            playSong(originalIndex, false);
          }
        });
      }

      playlistBody.appendChild(item);
    });
  }

  // 获取当前歌单的歌曲索引列表（在全局playlist中的索引）
  function getActivePlaylistIndices() {
    const pid = musicState.activePlaylistId || 'default';
    const indices = [];
    musicState.playlist.forEach((track, i) => {
      if ((track.playlistId || 'default') === pid) indices.push(i);
    });
    return indices;
  }

  // 渲染歌单标签栏
  function renderPlaylistTabs() {
    let tabsContainer = document.getElementById('playlist-tabs-container');
    if (!tabsContainer) {
      tabsContainer = document.createElement('div');
      tabsContainer.id = 'playlist-tabs-container';
      tabsContainer.className = 'playlist-tabs-container';
      const playlistBody = document.getElementById('playlist-body');
      playlistBody.parentNode.insertBefore(tabsContainer, playlistBody);
    }
    tabsContainer.innerHTML = '';
    musicState.playlists.forEach(pl => {
      const tab = document.createElement('span');
      tab.className = 'playlist-tab' + (pl.id === musicState.activePlaylistId ? ' active' : '');
      tab.textContent = pl.name;
      tab.dataset.playlistId = pl.id;
      // 统计歌曲数
      const count = musicState.playlist.filter(t => (t.playlistId || 'default') === pl.id).length;
      tab.textContent = `${pl.name} (${count})`;
      tab.addEventListener('click', () => {
        musicState.activePlaylistId = pl.id;
        updatePlaylistUI();
      });

      // 长按（手机）分享歌单给角色
      addLongPressListener(tab, () => showSharePlaylistMenu(pl.id));
      // 右键（PC）分享歌单给角色
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showSharePlaylistMenu(pl.id);
      });

      tabsContainer.appendChild(tab);
    });
  }

  // 分享歌单给角色 - 弹出菜单
  async function showSharePlaylistMenu(playlistId) {
    const pl = musicState.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const songs = musicState.playlist.filter(t => (t.playlistId || 'default') === playlistId);
    if (songs.length === 0) {
      await showCustomAlert('提示', '这个歌单是空的，没有歌曲可以分享');
      return;
    }
    if (!musicState.isActive || !musicState.activeChatId) {
      await showCustomAlert('提示', '请先开启一起听，才能分享歌单给角色');
      return;
    }
    const activeChat = state.chats[musicState.activeChatId];
    const charName = activeChat ? activeChat.name : '角色';
    const options = [
      { text: `分享「${pl.name}」给${charName}`, value: 'share' }
    ];
    const choice = await showChoiceModal('歌单操作', options);
    if (choice === 'share') {
      await sharePlaylistToCharacter(playlistId);
    }
  }

  // 分享歌单给角色 - 发送卡片消息，不自动触发回复
  async function sharePlaylistToCharacter(playlistId) {
    const pl = musicState.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const chat = state.chats[musicState.activeChatId];
    if (!chat) return;
    const songs = musicState.playlist.filter(t => (t.playlistId || 'default') === playlistId);
    if (songs.length === 0) return;

    const charName = chat.name || '角色';
    const songList = songs.map((s, i) => `${i + 1}. ${s.name} - ${s.artist || '未知歌手'}`).join('\n');
    const shareText = `[分享歌单「${pl.name}」]\n${songList}`;

    // 作为用户消息发送，带上 playlist_share 类型
    const msg = {
      role: 'user',
      content: shareText,
      type: 'playlist_share',
      playlistName: pl.name,
      songs: songs.map(s => ({ name: s.name, artist: s.artist || '未知歌手' })),
      timestamp: Date.now()
    };
    chat.history.push(msg);
    await db.chats.put(chat);

    // 如果当前正在看这个聊天，渲染消息
    if (state.activeChatId === musicState.activeChatId) {
      appendMessage(msg, chat);
    }

    // 不自动触发AI回复，让用户可以继续补充消息

    await showCustomAlert('已分享', `已将歌单「${pl.name}」(${songs.length}首) 分享给${charName}`);
  }

  // 选择歌单弹窗（添加歌曲时用）
  async function showPlaylistPicker(title = '选择歌单') {
    const options = musicState.playlists.map(pl => ({
      text: pl.name,
      value: pl.id
    }));
    const choice = await showChoiceModal(title, options);
    return choice || 'default';
  }

  // 歌单管理面板
  async function openPlaylistManager() {
    const actions = [
      { text: '新建歌单', value: 'create' },
      { text: '删除歌单', value: 'delete' }
    ];
    const choice = await showChoiceModal('歌单管理', actions);
    if (!choice) return;

    if (choice === 'create') {
      const name = await showCustomPrompt('新建歌单', '请输入歌单名称');
      if (!name || !name.trim()) return;
      const newPlaylist = {
        id: 'pl_' + Date.now(),
        name: name.trim(),
        createdAt: Date.now()
      };
      musicState.playlists.push(newPlaylist);
      await saveGlobalPlaylist();
      updatePlaylistUI();
      await showCustomAlert('成功', `歌单「${name.trim()}」已创建`);
    } else if (choice === 'delete') {
      // 过滤掉默认歌单
      const deletable = musicState.playlists.filter(pl => pl.id !== 'default');
      if (deletable.length === 0) {
        await showCustomAlert('提示', '没有可删除的歌单（默认歌单不可删除）');
        return;
      }
      const options = deletable.map(pl => {
        const count = musicState.playlist.filter(t => (t.playlistId || 'default') === pl.id).length;
        return { text: `${pl.name} (${count}首)`, value: pl.id };
      });
      const toDelete = await showChoiceModal('选择要删除的歌单', options);
      if (!toDelete) return;
      const plName = musicState.playlists.find(p => p.id === toDelete)?.name;
      const confirmed = await showCustomConfirm('确认删除', `删除歌单「${plName}」？其中的歌曲将移回默认歌单。`, { confirmText: '确认删除' });
      if (!confirmed) return;
      // 把该歌单的歌曲移到默认
      musicState.playlist.forEach(t => {
        if (t.playlistId === toDelete) t.playlistId = 'default';
      });
      musicState.playlists = musicState.playlists.filter(pl => pl.id !== toDelete);
      if (musicState.activePlaylistId === toDelete) musicState.activePlaylistId = 'default';
      await saveGlobalPlaylist();
      updatePlaylistUI();
      await showCustomAlert('成功', `歌单「${plName}」已删除，歌曲已移回默认`);
    }
  }


  async function togglePlayPause() {
    if (audioPlayer.paused) {
      if (musicState.currentIndex === -1 && musicState.playlist.length > 0) {
        const indices = getActivePlaylistIndices();
        if (indices.length > 0) playSong(indices[0], true);
      } else if (musicState.currentIndex > -1) {
        playSong(musicState.currentIndex, true);
      }
    } else {
      audioPlayer.pause();
      // await addMusicActionSystemMessage('暂停了音乐');
    }
  }

  function playNext(isAutomatic = false) {
    const indices = getActivePlaylistIndices();
    if (indices.length === 0) return;
    const posInList = indices.indexOf(musicState.currentIndex);
    let nextIndex;
    switch (musicState.playMode) {
      case 'random':
        nextIndex = indices[Math.floor(Math.random() * indices.length)];
        break;
      case 'single':
        playSong(musicState.currentIndex, isAutomatic);
        return;
      case 'order':
      default:
        if (posInList === -1) {
          nextIndex = indices[0];
        } else {
          nextIndex = indices[(posInList + 1) % indices.length];
        }
        break;
    }
    playSong(nextIndex, isAutomatic);
  }

  function playPrev() {
    const indices = getActivePlaylistIndices();
    if (indices.length === 0) return;
    const posInList = indices.indexOf(musicState.currentIndex);
    let prevIndex;
    if (posInList === -1) {
      prevIndex = indices[indices.length - 1];
    } else {
      prevIndex = indices[(posInList - 1 + indices.length) % indices.length];
    }
    playSong(prevIndex, false);
  }

  function changePlayMode() {
    const modes = ['order', 'random', 'single'];
    const currentModeIndex = modes.indexOf(musicState.playMode);
    musicState.playMode = modes[(currentModeIndex + 1) % modes.length];
    document.getElementById('music-mode-btn').textContent = {
      'order': '顺序',
      'random': '随机',
      'single': '单曲'
    }[musicState.playMode];
  }

  async function addSongFromURL() {
    const url = await showCustomPrompt("添加网络歌曲", "请输入歌曲的URL", "", "url");
    if (!url) return;
    const name = await showCustomPrompt("歌曲信息", "请输入歌名");
    if (!name) return;
    const artist = await showCustomPrompt("歌曲信息", "请输入歌手名");
    if (!artist) return;
    // 选择歌单
    const playlistId = await showPlaylistPicker('添加到哪个歌单？');
    musicState.playlist.push({
      name,
      artist,
      src: url,
      isLocal: false,
      playlistId: playlistId
    });
    await saveGlobalPlaylist();
    updatePlaylistUI();
    if (musicState.currentIndex === -1) {
      musicState.currentIndex = musicState.playlist.length - 1;
      updatePlayerUI();
    }
  }


  // 【2026-07-04 新增】抽出切歌时的所有 UI 更新成 helper —
  // playSong() 和 ephAddToPlaylistAndPlay() 都调它，避免漏改
  // 包含：头像 / 背景图 / 视觉容器 / 唱片封面 / 歌词 / 单行歌词
  // 【重要】每个子项 try/catch —— defaultAvatar 等跨模块变量可能未定义，
  // 一个失败不能影响 audio 主流程
  function applyTrackUI(track, chat) {
    // 1. 头像 (chat 角色 + user) —— try/catch 防 defaultAvatar ReferenceError
    try {
      const avatarDisplay = document.getElementById('music-player-avatar-display');
      if (chat && avatarDisplay) {
        avatarDisplay.innerHTML = '';
        // 用 typeof 检查避免 ReferenceError
        const fallbackAvatar = (typeof defaultAvatar !== 'undefined') ? defaultAvatar : '';
        const charAvatarUrl = chat.isGroup ?
          (chat.members.find(m => m.originalName === track.artist)?.avatar || fallbackAvatar) :
          (chat.settings.aiAvatar || fallbackAvatar);
        const userAvatarUrl = chat.settings.myAvatar || fallbackAvatar;
        const charAvatarEl = document.createElement('img');
        charAvatarEl.src = charAvatarUrl;
        charAvatarEl.className = 'participant-display-avatar';
        charAvatarEl.alt = 'Character Avatar';
        avatarDisplay.appendChild(charAvatarEl);
        const userAvatarEl = document.createElement('img');
        userAvatarEl.src = userAvatarUrl;
        userAvatarEl.className = 'participant-display-avatar';
        userAvatarEl.alt = 'User Avatar';
        avatarDisplay.appendChild(userAvatarEl);

        const avatarToggleBtn = document.getElementById('show-avatars-btn');
        if (avatarToggleBtn) {
          avatarToggleBtn.innerHTML = '';
          avatarToggleBtn.classList.add('has-inline-avatars');
          avatarToggleBtn.title = '显示/隐藏头像';

          const miniCharAvatar = document.createElement('img');
          miniCharAvatar.src = charAvatarUrl;
          miniCharAvatar.className = 'music-inline-avatar';
          miniCharAvatar.alt = 'Character Avatar';
          avatarToggleBtn.appendChild(miniCharAvatar);

          const miniUserAvatar = document.createElement('img');
          miniUserAvatar.src = userAvatarUrl;
          miniUserAvatar.className = 'music-inline-avatar';
          miniUserAvatar.alt = 'User Avatar';
          avatarToggleBtn.appendChild(miniUserAvatar);
        }
      }
    } catch (e) {
      console.warn('[applyTrackUI] 头像更新失败（不影响主流程）:', e);
    }

    // 2. 背景图 + 模糊背景
    try {
      const playerWindow = document.querySelector('.music-player-window');
      const toggleBtn = document.getElementById('toggle-blur-btn');
      if (playerWindow) {
        playerWindow.style.setProperty('--music-bg-image', track.background ? `url(${track.background})` : 'none');
        playerWindow.classList.toggle('bg-clear', !!track.isBgClear);
      }
      if (toggleBtn) {
        toggleBtn.classList.toggle('active', !!track.isBgClear);
      }
    } catch (e) {
      console.warn('[applyTrackUI] 背景更新失败:', e);
    }

    // 3. 视觉容器（移除歌词高亮）
    try {
      const visualContainer = document.getElementById('music-visual-container');
      if (visualContainer) visualContainer.classList.remove('lyrics-active');
    } catch (e) {
      console.warn('[applyTrackUI] 视觉容器更新失败:', e);
    }

    // 4. 唱片封面
    try {
      const coverEl = document.getElementById('music-player-cover');
      if (coverEl) {
        coverEl.src = getEffectiveCoverUrl(track) || DEFAULT_COVER_URL;
      }
    } catch (e) {
      console.warn('[applyTrackUI] 封面更新失败:', e);
    }

    // 5. 歌词
    try {
      musicState.parsedLyrics = parseLRC(track.lrcContent || '');
      musicState.currentLyricIndex = -1;
      if (typeof renderLyrics === 'function') renderLyrics();
      const singleLyricEl = document.getElementById('single-lyric-display');
      if (singleLyricEl) {
        singleLyricEl.textContent = (!musicState.parsedLyrics || musicState.parsedLyrics.length === 0)
          ? '纯音乐，请欣赏' : '♪ ♪ ♪';
      }
    } catch (e) {
      console.warn('[applyTrackUI] 歌词更新失败:', e);
    }
  }

  function getMusicTrackKey(track) {
    if (!track) return '';
    if (track.source === 'netease_real' && track.id != null) {
      return `netease_real:${String(track.id)}`;
    }
    if (track.src) return `src:${String(track.src)}`;
    const name = String(track.name || '').trim().toLowerCase();
    const artist = String(track.artist || '').trim().toLowerCase();
    return name ? `meta:${name}|${artist}` : '';
  }

  function findExistingMusicTrackIndex(track) {
    const key = getMusicTrackKey(track);
    if (!key || !Array.isArray(musicState.playlist)) return -1;
    return musicState.playlist.findIndex(existing => getMusicTrackKey(existing) === key);
  }

  function mergeMusicTrack(existing, incoming) {
    if (!existing || !incoming) return existing || incoming;
    const merged = { ...existing };
    Object.keys(incoming).forEach((key) => {
      const value = incoming[key];
      if (value !== undefined && value !== null && value !== '') {
        merged[key] = value;
      }
    });
    return merged;
  }

  function addOrUpdateMusicTrack(track) {
    if (!track) return { index: -1, added: false, track: null };
    if (!musicState.playlist) musicState.playlist = [];
    if (!track.playlistId) track.playlistId = musicState.activePlaylistId || 'default';

    const existingIndex = findExistingMusicTrackIndex(track);
    if (existingIndex > -1) {
      musicState.playlist[existingIndex] = mergeMusicTrack(musicState.playlist[existingIndex], track);
      return { index: existingIndex, added: false, track: musicState.playlist[existingIndex] };
    }

    musicState.playlist.push(track);
    return { index: musicState.playlist.length - 1, added: true, track };
  }

  function getPreferredNeteaseQuality(track) {
    try {
      return track?.preferredQuality || localStorage.getItem('netease_music_quality') || track?.quality || 'exhigh';
    } catch (e) {
      return track?.preferredQuality || track?.quality || 'exhigh';
    }
  }

  async function refreshNeteaseTrackUrl(track) {
    if (!track || track.source !== 'netease_real' || track.id == null) return true;
    if (!window.NeteaseMusic || typeof window.NeteaseMusic.getSongUrl !== 'function') {
      console.warn('[music] NeteaseMusic module is unavailable, using cached url');
      return !!track.src;
    }

    try {
      const level = getPreferredNeteaseQuality(track);
      const result = await window.NeteaseMusic.getSongUrl(track.id, level);
      if (result && result.url) {
        track.src = result.url;
        track.quality = result.level || level;
        track.preferredQuality = level;
      }
    } catch (e) {
      console.warn('[music] refresh netease url failed:', e);
    }

    // 【2026-07-07 兜底】老已导入的网易云 track 可能缺 lrcContent（之前 buildNeteasePlayerTrack 没填），
    //   顺带拉一次 lyric 注入。lyric 走 24h localStorage 缓存，重复拉不重发请求。
    if (!track.lrcContent && typeof window.NeteaseMusic.getLyric === 'function') {
      try {
        const lrc = await window.NeteaseMusic.getLyric(track.id);
        if (lrc) track.lrcContent = lrc;
      } catch (e) {
        console.warn('[music] lyric fallback failed:', e);
      }
    }

    return !!track.src;
  }

  async function playTemporaryNeteaseTrack(songInfo, chatId) {
    if (!songInfo || !songInfo.src) return false;

    const targetChatId = chatId || state.activeChatId;
    if (targetChatId) {
      if (!musicState.isActive || musicState.activeChatId !== targetChatId) {
        startListenTogetherSession(targetChatId, false);
      } else {
        document.getElementById('music-player-overlay').classList.add('visible');
      }
    } else {
      document.getElementById('music-player-overlay').classList.add('visible');
    }

    audioPlayer.pause();
    if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioPlayer.src);
    }

    musicState.tempTrack = { ...songInfo, isTemporary: true };
    musicState.currentIndex = -1;

    const track = musicState.tempTrack;
    const chat = state.chats[musicState.activeChatId];
    applyTrackUI(track, chat);

    audioPlayer.src = track.src;
    audioPlayer.load();
    const playPromise = audioPlayer.play();
    if (playPromise !== undefined) {
      playPromise.catch((e) => console.warn('[music] temporary play failed:', e));
    }

    updatePlayerUI();
    updatePlaylistUI();
    return true;
  }

  async function playSong(index, isAutomatic = false) {
    if (index < 0 || index >= musicState.playlist.length) return;

    // 自动切换到该歌曲所在的歌单
    const songPlaylistId = (musicState.playlist[index].playlistId) || 'default';
    if (musicState.activePlaylistId !== songPlaylistId) {
      musicState.activePlaylistId = songPlaylistId;
    }

    audioPlayer.pause();

    // ★ 释放旧的 Blob URL，防止内存泄漏
    if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioPlayer.src);
    }

    musicState.tempTrack = null;
    musicState.currentIndex = index;
    const track = musicState.playlist[index];
    const chat = state.chats[musicState.activeChatId];

    // 告诉宠物屋：今天听了歌 → 它脑袋上飘几个小音符
    try {
      if (window.PetNest && typeof window.PetNest.reportSignal === 'function') {
        window.PetNest.reportSignal('listening', 1, { title: String((track && track.name) || '') });
      }
    } catch (e) { /* 忽略 */ }

    if (!track.isLocal && track.source === 'netease_real') {
      const refreshed = await refreshNeteaseTrackUrl(track);
      if (!refreshed || !track.src) {
        console.warn('[music] netease track has no playable url:', track);
        updatePlaylistUI();
        updatePlayerUI();
        return;
      }
    }

    // 【2026-07-04 重构】所有切歌 UI 更新（头像/背景/封面/歌词/单行歌词）走 helper
    applyTrackUI(track, chat);

    if (!isAutomatic) {
      await addMusicActionSystemMessage(`将歌曲切换为了《${track.name}》`);
    }

    if (track.isLocal && track.src instanceof ArrayBuffer) {
      const blob = new Blob([track.src], {
        type: track.fileType || 'audio/mpeg'
      });
      audioPlayer.src = URL.createObjectURL(blob);
    } else if (track.isLocal && track.src instanceof Blob) {
      audioPlayer.src = URL.createObjectURL(track.src);
    } else if (track.isLocal && typeof track.src === 'string' && track.src) {
      // 【2026-07-22 修】AI 原创曲的 src 是 blob URL 字符串（addAiSongToPlaylist 写的就是 string）
      // 之前漏了这个分支，导致点 AI 原创歌直接报"本地歌曲源错误"——见 playSong 1033 行
      audioPlayer.src = track.src;
      console.log(`[音乐播放] 加载本地 AI 原创: ${track.name}, URL: ${track.src}`);
    } else if (!track.isLocal) {
      // 直接使用音频URL，不使用代理
      // 音频文件通常已经支持CORS，不需要像图片那样使用代理
      audioPlayer.src = track.src;
      console.log(`[音乐播放] 加载音频: ${track.name}, URL: ${track.src}`);
    } else {
      console.error('本地歌曲源错误:', track);
      return;
    }

    // 【2026-07-04 修复】删掉重复的 audioPlayer.load() ——
    //    调两次 load() 会让第二次取消第一次的 pending play，
    //    表现为"旧歌停了但新歌没唱出来"（playSong 抛 promise 后被吞掉）
    audioPlayer.load();

    const playPromise = audioPlayer.play();
    if (playPromise !== undefined) {
      playPromise.catch(error => {
        if (error.name === 'NotAllowedError') {
          console.warn('Autoplay was prevented by the browser.');
          audioPlayer.pause();

        } else if (error.name !== 'AbortError') {
          console.error('Playback error:', error);
        }
      });
    }
    updatePlaylistUI();
    updatePlayerUI();
    const isFrameMode = document.body.classList.contains('frame-mode-active');
    const isAlwaysIslandMode = state.globalSettings.alwaysShowMusicIsland || false;
    const lyricBar = document.getElementById('global-lyrics-bar');

    if (isFrameMode || isAlwaysIslandMode) {

      phoneScreenForIsland.classList.add('dynamic-island-active');
      islandAlbumArt.src = getEffectiveCoverUrl(track) || DEFAULT_COVER_URL;
      lyricBar.classList.remove('visible');
    } else {

      phoneScreenForIsland.classList.remove('dynamic-island-active');
      if (musicState.parsedLyrics && musicState.parsedLyrics.length > 0) {
        lyricBar.textContent = '♪';
        lyricBar.classList.add('visible');
      } else {
        lyricBar.classList.remove('visible');
      }
    }
  }


  async function handleChangeBackground(trackIndex) {
    if (trackIndex < 0 || trackIndex >= musicState.playlist.length) return;


    const choice = await showChoiceModal("更换歌曲背景", [{
      text: '📁 从本地上传',
      value: 'local'
    },
    {
      text: '🌐 使用网络URL',
      value: 'url'
    }
    ]);

    let newBackgroundUrl = null;


    if (choice === 'local') {
      newBackgroundUrl = await uploadImageLocally();
    } else if (choice === 'url') {
      newBackgroundUrl = await showCustomPrompt("输入图片URL", "请输入新的背景图片链接", "", "url");
    }


    if (newBackgroundUrl && newBackgroundUrl.trim()) {
      musicState.playlist[trackIndex].background = newBackgroundUrl.trim();
      await saveGlobalPlaylist();


      if (musicState.currentIndex === trackIndex) {
        const playerWindow = document.querySelector('.music-player-window');
        playerWindow.style.setProperty('--music-bg-image', `url(${newBackgroundUrl.trim()})`);
      }

      await showCustomAlert("成功", "歌曲背景已更新！");
    }
  }

  async function handleChangeAlbumArt(trackIndex) {
    if (trackIndex < 0 || trackIndex >= musicState.playlist.length) return;

    const choice = await showChoiceModal("更换专辑封面", [{
      text: '📁 从本地上传',
      value: 'local'
    },
    {
      text: '🌐 使用网络URL',
      value: 'url'
    }
    ]);

    let newCoverUrl = null;

    if (choice === 'local') {
      newCoverUrl = await uploadImageLocally();
    } else if (choice === 'url') {
      newCoverUrl = await showCustomPrompt("输入图片URL", "请输入新的封面图片链接", "", "url");
    }

    if (newCoverUrl && newCoverUrl.trim()) {
      musicState.playlist[trackIndex].cover = newCoverUrl.trim();
      await saveGlobalPlaylist();


      if (musicState.currentIndex === trackIndex) {
        document.getElementById('music-player-cover').src = newCoverUrl.trim();

        const vinylCover = document.querySelector('#vinyl-view #music-player-cover');
        if (vinylCover) vinylCover.src = newCoverUrl.trim();
      }

      await showCustomAlert("成功", "专辑封面已更新！");
    }
  }

  async function addSongFromLocal(event) {
    const files = event.target.files;
    if (!files.length) return;

    // 先选择歌单
    const playlistId = await showPlaylistPicker('添加到哪个歌单？');

    let uploadedCount = 0;
    for (const file of files) {
      let name = file.name.replace(/\.[^/.]+$/, "");
      name = await showCustomPrompt("歌曲信息", "请输入歌名", name);
      if (name === null) continue;

      const artist = await showCustomPrompt("歌曲信息", "请输入歌手名", "未知歌手");
      if (artist === null) continue;

      let lrcContent = "";
      const wantLrc = await showCustomConfirm("导入歌词", `要为《${name}》添加歌词吗？`);
      if (wantLrc) {
        lrcContent = await getLrcContent() || "";
      }


      let songSrc = null;
      let isLocal = true;

      try {
        // 尝试上传到 Catbox
        const catboxUrl = await uploadFileToCatbox(file); // 'file' 是现成的 File 对象

        if (catboxUrl) {
          // 上传成功
          songSrc = catboxUrl;
          isLocal = false; // 这是一个网络 URL
          await showCustomAlert("上传成功", `歌曲 "${file.name}" 已成功上传并保存到您的 Catbox 账户！`);
        } else {

          console.log("Catbox 未配置，将歌曲保存为本地 ArrayBuffer。");
          songSrc = await file.arrayBuffer();
          isLocal = true;
        }
      } catch (uploadError) {

        console.error("Catbox 上传失败:", uploadError);
        await showCustomAlert("上传失败", `歌曲上传到 Catbox 失败: ${uploadError.message}\n\n将改为本地保存。`);
        songSrc = await file.arrayBuffer();
        isLocal = true;
      }


      musicState.playlist.push({
        name,
        artist,
        src: songSrc,       // <-- 修改
        fileType: file.type,
        isLocal: isLocal,     // <-- 修改
        lrcContent: lrcContent,
        // 【2026-07-25 修复】不存默认 URL，存空串——getEffectiveCoverUrl 会 fallback 到用户自定义胶片
        cover: '',
        playlistId: playlistId
      });
      uploadedCount++;
    }

    if (uploadedCount > 0) {
      await saveGlobalPlaylist();
      updatePlaylistUI();
      if (musicState.currentIndex === -1 && musicState.playlist.length > 0) {
        musicState.currentIndex = 0;
        updatePlayerUI();
      }
    }
    event.target.value = null;
  }


  async function deleteTrack(index) {
    if (index < 0 || index >= musicState.playlist.length) return;
    const track = musicState.playlist[index];
    const wasPlaying = musicState.isPlaying && musicState.currentIndex === index;
    if (track.isLocal && audioPlayer.src.startsWith('blob:') && musicState.currentIndex === index) URL.revokeObjectURL(audioPlayer.src);
    musicState.playlist.splice(index, 1);
    await saveGlobalPlaylist();
    if (musicState.playlist.length === 0) {
      if (musicState.isPlaying) audioPlayer.pause();
      audioPlayer.src = '';
      musicState.currentIndex = -1;
      musicState.isPlaying = false;
    } else {
      if (wasPlaying) {
        playNext();
      } else {
        if (musicState.currentIndex >= index) musicState.currentIndex = Math.max(0, musicState.currentIndex - 1);
      }
    }
    updatePlayerUI();
    updatePlaylistUI();
  }

  // ========== 歌词解析与渲染（来自 script.js 第 31283~31535 行） ==========

  function closeMusicPlayerWithAnimation(callback) {
    const overlay = document.getElementById('music-player-overlay');
    if (!overlay.classList.contains('visible')) {
      if (callback) callback();
      return;
    }
    overlay.classList.remove('visible');
    setTimeout(() => {
      document.getElementById('music-playlist-panel').classList.remove('visible');
      if (callback) callback();
    }, 400);
  }

  function parseLRC(lrcContent) {
    if (!lrcContent) return [];
    const lines = String(lrcContent).split(/\r\n?|\n/);
    const lyrics = [];
    // 【2026-07-15 修复】兼容 [mm:ss] / [mm:ss.x] / [mm:ss.xx] / [mm:ss.xxx] 各种变体
    // 旧正则只认带毫秒的 [mm:ss.xx]，导致按字数估算生成的无毫秒时间戳 ([00:00]xxx) 全部被拒
    const timeRegex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of lines) {
      const text = line.replace(timeRegex, '').trim();
      if (!text) continue;
      timeRegex.lastIndex = 0;
      let match;
      while ((match = timeRegex.exec(line)) !== null) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        // match[3] 可能 undefined（无毫秒情况），padEnd 兼容
        const msRaw = (match[3] || '0').padEnd(3, '0').slice(0, 3);
        const milliseconds = parseInt(msRaw, 10) || 0;
        const time = minutes * 60 + seconds + milliseconds / 1000;
        lyrics.push({
          time,
          text
        });
      }
    }
    return lyrics.sort((a, b) => a.time - b.time);
  }

  function renderLyrics() {
    const lyricsList = document.getElementById('music-lyrics-list');
    lyricsList.innerHTML = '';
    if (!musicState.parsedLyrics || musicState.parsedLyrics.length === 0) {
      lyricsList.innerHTML = '<div class="lyric-line">♪ 暂无歌词 ♪</div>';
      return;
    }
    musicState.parsedLyrics.forEach((line, index) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'lyric-line';
      lineEl.textContent = line.text;
      lineEl.dataset.index = index;
      lyricsList.appendChild(lineEl);
    });
    lyricsList.style.transform = `translateY(0px)`;
  }

  function updateIslandScrollAnimation() {

  }

  function checkLyricScroll() {

    if (!islandLyricText || !islandLyricContainer) return;

    const textWidth = islandLyricText.scrollWidth;
    const containerWidth = islandLyricContainer.clientWidth;


    if (textWidth > containerWidth) {

      const scrollRatio = textWidth / containerWidth;
      const animationDuration = Math.max(5, scrollRatio * 5);


      islandLyricText.style.setProperty('--animation-duration', `${animationDuration}s`);
      islandLyricText.style.setProperty('--container-width', `${containerWidth}px`);
      islandLyricText.style.setProperty('--text-width', `${textWidth}px`);


      islandLyricText.classList.add('scrolling');
    } else {

      islandLyricText.classList.remove('scrolling');
    }
  }

  function updateActiveLyric(currentTime) {
    if (musicState.parsedLyrics.length === 0) return;
    let newLyricIndex = -1;
    for (let i = 0; i < musicState.parsedLyrics.length; i++) {
      if (currentTime >= musicState.parsedLyrics[i].time) {
        newLyricIndex = i;
      } else {
        break;
      }
    }
    if (newLyricIndex === musicState.currentLyricIndex) return;
    musicState.currentLyricIndex = newLyricIndex;
    updateLyricsUI();

    const singleLyricEl = document.getElementById('single-lyric-display');
    if (singleLyricEl) {
      if (newLyricIndex > -1 && musicState.parsedLyrics[newLyricIndex]) {
        singleLyricEl.textContent = musicState.parsedLyrics[newLyricIndex].text;
      } else {
        singleLyricEl.textContent = '♪ ♪ ♪';
      }
    }

    const lyricBar = document.getElementById('global-lyrics-bar');
    if (lyricBar.classList.contains('visible')) {
      if (newLyricIndex > -1 && musicState.parsedLyrics[newLyricIndex]) {
        lyricBar.textContent = musicState.parsedLyrics[newLyricIndex].text;
      } else {
        lyricBar.textContent = '♪';
      }
    }


    if (phoneScreenForIsland.classList.contains('dynamic-island-active')) {
      const lyricText = (newLyricIndex > -1 && musicState.parsedLyrics[newLyricIndex]) ?
        musicState.parsedLyrics[newLyricIndex].text :
        '♪ ♪ ♪';


      const firstSpan = islandLyricText.querySelector('span:first-child');
      if (firstSpan && firstSpan.textContent === lyricText) {
        return;
      }


      islandLyricText.style.opacity = 0;


      setTimeout(() => {



        islandLyricText.classList.remove('scrolling');
        islandLyricContainer.classList.remove('center-content');
        islandLyricText.style.animation = 'none';

        let span1 = islandLyricText.querySelector('span:first-child');
        let span2 = islandLyricText.querySelector('span:last-child');
        if (!span1) {
          span1 = document.createElement('span');
          islandLyricText.appendChild(span1);
        }
        if (!span2) {
          span2 = document.createElement('span');
          islandLyricText.appendChild(span2);
        }

        span1.textContent = lyricText;
        span2.textContent = lyricText;

        const textWidth = span1.offsetWidth;
        const containerWidth = islandLyricContainer.clientWidth;


        if (textWidth > containerWidth) {

          const scrollRatio = textWidth / containerWidth;
          const duration = Math.max(5, scrollRatio * 5);

          islandLyricText.style.setProperty('--marquee-duration', `${duration}s`);
          islandLyricText.classList.add('scrolling');

          islandLyricText.style.animation = `marquee var(--marquee-duration, 10s) linear infinite`;
        } else {

          islandLyricContainer.classList.add('center-content');
        }




        islandLyricText.style.opacity = 1;

      }, 200);
    }

  }


  function updateLyricsUI(isFullscreen = false) {
    const listSelector = isFullscreen ? '#fullscreen-lyrics-container .music-lyrics-list' : '#music-lyrics-container #music-lyrics-list';
    const containerSelector = isFullscreen ? '#fullscreen-lyrics-container' : '#music-lyrics-container';

    const lyricsList = document.querySelector(listSelector);
    const container = document.querySelector(containerSelector);
    if (!lyricsList || !container) return;

    const lines = lyricsList.querySelectorAll('.lyric-line');
    lines.forEach(line => line.classList.remove('active'));

    if (musicState.currentLyricIndex === -1) {
      lyricsList.style.transform = `translateY(0px)`;
      return;
    }

    const activeLine = lyricsList.querySelector(`.lyric-line[data-index="${musicState.currentLyricIndex}"]`);
    if (activeLine) {
      activeLine.classList.add('active');
      const containerHeight = container.offsetHeight;
      const offset = (containerHeight / 2.2) - activeLine.offsetTop - (activeLine.offsetHeight / 2);
      lyricsList.style.transform = `translateY(${offset}px)`;
    }
  }

  function formatMusicTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  let lastTimeUpdate = 0;
  let animationFrameId;

  function updateMusicProgressBar() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    function step() {
      if (!musicState.isPlaying || !audioPlayer.duration) {
        return;
      }

      const now = performance.now();
      const currentTime = audioPlayer.currentTime;
      const duration = audioPlayer.duration;

      const progressPercent = (currentTime / duration) * 100;
      document.getElementById('music-progress-fill').style.width = `${progressPercent}%`;

      if (now - lastTimeUpdate > 1000) {
        document.getElementById('music-current-time').textContent = formatMusicTime(currentTime);
        document.getElementById('music-total-time').textContent = formatMusicTime(duration);
        updateActiveLyric(currentTime);
        updateIslandScrollAnimation();
        lastTimeUpdate = now;
      }


      animationFrameId = requestAnimationFrame(step);
    }

    animationFrameId = requestAnimationFrame(step);
  }

  // ========== 音乐搜索 API（来自 script.js 第 38006~38870 行） ==========

  if (typeof Http_Get_External === 'undefined') {
    window.Http_Get_External = function (url) {
      return new Promise((resolve) => {
        fetch(url).then(res => res.json().catch(() => res.text())).then(resolve).catch(() => resolve(null));
      });
    }
  }
  async function Http_Get(url) {
    return await Http_Get_External(url);
  }

  function checkAudioAvailability(url) {
    return new Promise(resolve => {
      const tester = new Audio();
      tester.addEventListener('loadedmetadata', () => resolve(true), {
        once: true
      });
      tester.addEventListener('error', () => resolve(false), {
        once: true
      });
      tester.src = url;
    });
  }


  async function searchNeteaseMusic(name, singer) {
    try {
      let searchTerm = name.replace(/\s/g, "");
      if (singer) {
        searchTerm += ` ${singer.replace(/\s/g, "")}`;
      }

      const apiUrl = `https://api.vkeys.cn/v2/music/netease?word=${encodeURIComponent(searchTerm)}`;

      console.log("正在请求网易云音乐API:", apiUrl);

      const response = await fetch(apiUrl);

      if (!response.ok) {
        throw new Error(`API 请求失败，状态码: ${response.status}`);
      }

      const result = await response.json();

      if (result.code !== 200 || !result.data || result.data.length === 0) {
        console.log("网易云音乐API未返回有效结果:", result);
        return [];
      }


      return result.data.map(song => ({
        name: song.song,
        artist: song.singer,
        id: song.id,
        cover: song.cover || 'https://i.postimg.cc/pT2xKzPz/album-cover-placeholder.png',
        source: 'netease'
      })).slice(0, 30);

    } catch (e) {
      console.error("网易云音乐搜索失败:", e);

      return [];
    }
  }
  // --- Toubiec API 核心逻辑 (修复版) ---
  const TOUBIEC_BASE_URL = 'https://wyapi-1.toubiec.cn/api/music';

  async function fetchToubiec(endpoint, bodyData) {
    try {
      const response = await fetch(`${TOUBIEC_BASE_URL}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData)
      });
      const result = await response.json();
      return result;
    } catch (error) {
      console.error(`Toubiec API Error [${endpoint}]:`, error);
      return null;
    }
  }

  // 1. 搜索功能 (修复了数据结构解析)
  // 1. 搜索功能 (修复字段映射)
  // 1. 搜索功能 (修复字段映射：适配 picimg 和 singer)
  async function searchToubiec(keyword) {
    const res = await fetchToubiec('search', { keywords: keyword, page: 1 });

    // 兼容处理：数据可能在 data, data.list, data.songs 中
    let songList = [];
    if (res) {
      if (Array.isArray(res)) {
        songList = res;
      } else if (res.data) {
        if (Array.isArray(res.data)) {
          songList = res.data;
        } else if (Array.isArray(res.data.list)) {
          songList = res.data.list;
        } else if (Array.isArray(res.data.songs)) {
          songList = res.data.songs;
        }
        // 针对你提供的JSON结构：直接返回了 data 对象的情况（虽不少见但为了保险）
        else if (typeof res.data === 'object') {
          songList = [res.data];
        }
      }
    }

    if (songList.length === 0) return [];

    return songList.map(song => ({
      name: song.name,
      // 【修复】优先读取 singer (你的API返回字段)，其次 artists
      artist: song.singer || song.artists || (Array.isArray(song.ar) ? song.ar.map(a => a.name).join('/') : (song.artist || '未知歌手')),
      id: String(song.id),
      // 【修复】优先读取 picimg (你的API返回字段)
      // 【2026-07-25 修复】没封面存空串——getEffectiveCoverUrl 会 fallback 到用户自定义胶片
      cover: song.picimg || song.cover || song.al?.picUrl || '',
      source: 'toubiec',
      albumId: song.al?.id
    }));
  }

  // 2. 解析歌单 (输入歌单ID)
  async function getToubiecPlaylist(playlistId) {
    const res = await fetchToubiec('playlist', { id: String(playlistId) });
    if (!res || !res.data || !res.data.tracks) return [];

    return res.data.tracks.map(song => ({
      name: song.name,
      artist: Array.isArray(song.ar) ? song.ar.map(a => a.name).join('/') : (song.artist || '未知歌手'),
      id: String(song.id),
      // 【2026-07-25 修复】没封面存空串——getEffectiveCoverUrl 会 fallback 到用户自定义胶片
      cover: song.al?.picUrl || song.cover || '',
      source: 'toubiec'
    }));
  }

  // 3. 解析专辑 (输入专辑ID)
  async function getToubiecAlbum(albumId) {
    const res = await fetchToubiec('album', { id: String(albumId) });
    if (!res || !res.data || !res.data.songs) return [];

    return res.data.songs.map(song => ({
      name: song.name,
      artist: Array.isArray(song.ar) ? song.ar.map(a => a.name).join('/') : '未知歌手',
      id: String(song.id),
      cover: song.al?.picUrl || res.data.album?.picUrl, // 优先用单曲封面，没有则用专辑封面
      source: 'toubiec'
    }));
  }
  // 6. [新增] 获取歌曲详情 (用于修复封面和歌手信息)
  async function getToubiecDetail(id) {
    // 调用 detail 接口
    const res = await fetchToubiec('detail', { id: String(id) });
    if (res && res.code === 200 && res.data) {
      return res.data; // 返回包含 picimg, singer 等信息的对象
    }
    return null;
  }
  // 4. 获取高音质播放链接 (修复版：适配 data 为数组的情况)
  async function getToubiecUrl(id, preferredLevel = 'exhigh') {
    // 定义音质降级链
    const qualityLadder = ['jymaster', 'dolby', 'sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'standard'];

    let startIndex = qualityLadder.indexOf(preferredLevel);
    if (startIndex === -1) startIndex = 5;

    for (let i = startIndex; i < qualityLadder.length; i++) {
      const level = qualityLadder[i];
      const res = await fetchToubiec('url', { id: String(id), level: level });

      if (res && res.code === 200 && res.data) {
        let url = null;

        // 【核心修复】你提供的JSON显示 data 是一个数组 [{id:..., url:...}]
        if (Array.isArray(res.data) && res.data.length > 0) {
          // 取数组第一个元素的 url 字段
          url = res.data[0].url;
        }
        // 兼容 data 是对象的情况
        else if (!Array.isArray(res.data) && res.data.url) {
          url = res.data.url;
        }

        if (url) {
          console.log(`[Toubiec] 成功获取链接 (${level}): ${url}`);
          // 确保 HTTPS，防止混合内容报错
          return url.replace(/^http:\/\//i, 'https://');
        }
      }
    }
    console.warn(`[Toubiec] 未能获取任何音质的链接: ID ${id}`);
    return null;
  }

  // 5. 获取歌词
  async function getToubiecLyric(id) {
    const res = await fetchToubiec('lyric', { id: String(id) });
    if (res && res.data) {
      // 组合原词(lrc)和翻译(tlyric)
      const lrc = res.data.lrc || "";
      const tlyric = res.data.tlyric || "";
      return lrc + "\n" + tlyric;
    }
    return "";
  }
  // --- Toubiec API 集成结束 ---

  async function searchTencentMusic(name) {
    try {
      name = name.replace(/\s/g, "");
      const result = await Http_Get(`https://api.vkeys.cn/v2/music/tencent?word=${encodeURIComponent(name)}`);
      if (!result?.data?.length) return [];
      return result.data.map(song => ({
        name: song.song,
        artist: song.singer,
        id: song.id,
        // 【2026-07-25 修复】没封面存空串——getEffectiveCoverUrl 会 fallback 到用户自定义胶片
        cover: song.cover || '',
        source: 'tencent'
      })).slice(0, 30);
    } catch (e) {
      console.error("QQ音乐搜索API失败:", e);
      return [];
    }
  }

  // --- 3. 重构搜索主入口 (已去除图标) ---
  // --- 3. 重构搜索主入口 (已去除图标) ---
  async function addSongFromSearch() {
    // 1. 第一步：选择模式 (去除了 Emoji)
    const modeChoice = await showChoiceModal("请选择操作模式", [
      { text: '搜索歌曲 (新源·支持选音质)', value: 'search_new' },
      { text: '解析歌单 (输入ID)', value: 'playlist_new' },
      { text: '解析专辑 (输入ID)', value: 'album_new' },
      { text: '普通搜索 (网易/腾讯旧源)', value: 'search_old' },
      { text: '搜索歌曲 (网易云真实源·需登录)', value: 'search_netease_real' }
    ]);

    if (!modeChoice) return;

    let searchResults = [];
    let selectedQuality = 'exhigh'; // 默认极高

    // 2. 第二步：如果是新源，选择音质 (去除了 Emoji)
    if (modeChoice.includes('_new')) {
      const qualityChoice = await showChoiceModal("请选择期望音质", [
        { text: '无损 (Lossless - FLAC)', value: 'lossless' },
        { text: '高解析 (Hi-Res - FLAC)', value: 'hires' },
        { text: '母带级 (Master - FLAC)', value: 'jymaster' },
        { text: '杜比全景声 (Dolby - MP4)', value: 'dolby' },
        { text: '极高 (ExHigh - MP3)', value: 'exhigh' },
        { text: '标准 (Standard - MP3)', value: 'standard' },
        { text: '环绕沉浸 (Sky)', value: 'sky' },
        { text: '空间音效 (Effect)', value: 'jyeffect' }
      ]);
      if (!qualityChoice) return;
      selectedQuality = qualityChoice;
    }

    // 3. 第三步：输入关键词或ID
    let promptText = "请输入歌曲名称";
    if (modeChoice === 'playlist_new') promptText = "请输入歌单 ID (数字)";
    if (modeChoice === 'album_new') promptText = "请输入专辑 ID (数字)";

    const input = await showCustomPrompt(promptText, "在此输入...");
    if (!input || !input.trim()) return;
    const query = input.trim();

    await showCustomAlert("请稍候...", "正在请求资源...");

    // 4. 执行搜索/解析 (保持原逻辑不变)
    try {
      if (modeChoice === 'search_new') {
        searchResults = await searchToubiec(query);
      }
      else if (modeChoice === 'playlist_new') {
        searchResults = await getToubiecPlaylist(query);
        if (searchResults.length > 0) {
          await showCustomAlert("解析成功", `成功解析歌单，共 ${searchResults.length} 首歌曲。`);
        }
      }
      else if (modeChoice === 'album_new') {
        searchResults = await getToubiecAlbum(query);
        if (searchResults.length > 0) {
          await showCustomAlert("解析成功", `成功解析专辑，共 ${searchResults.length} 首歌曲。`);
        }
      }
      else if (modeChoice === 'search_old') {
        // 旧版并行搜索逻辑
        let musicName = query;
        let singerName = "";
        if (query.includes('-')) {
          const parts = query.split('-');
          musicName = parts[0].trim();
          singerName = parts[1].trim();
        }
        const [netease, tencent] = await Promise.all([
          searchNeteaseMusic(musicName, singerName),
          searchTencentMusic(musicName)
        ]);
        searchResults = [...netease, ...tencent];
      }
      // 【新增】网易云真实源 - 走 NeteaseMusic.search (需登录)
      else if (modeChoice === 'search_netease_real') {
        if (!window.NeteaseMusic) {
          await showCustomAlert("错误", "网易云模块未加载, 请刷新页面重试");
          return;
        }
        if (!window.NeteaseMusic.isLoggedIn()) {
          await showCustomAlert("未登录", "请先点击播放器右上角的「登录」按钮, 粘贴网易云 MUSIC_U cookie 后再试");
          return;
        }
        searchResults = await window.NeteaseMusic.search(query, 30);
        if (searchResults.length === 0) {
          // 给个提示, 可能是 cookie 失效
          await showCustomAlert("无结果", "未找到相关歌曲。如已登录仍无结果, 可能是 MUSIC_U cookie 已失效, 请重新粘贴。");
          return;
        }
      }
    } catch (e) {
      console.error(e);
      await showCustomAlert("错误", "搜索或解析过程中发生错误，请检查ID是否正确。");
      return;
    }

    // 5. 渲染结果
    if (searchResults.length === 0) {
      await showCustomAlert("无结果", "未找到相关内容。");
      return;
    }

    const modal = document.getElementById('music-search-results-modal');
    const listEl = document.getElementById('search-results-list');
    listEl.innerHTML = '';
    document.getElementById('select-all-music-search').checked = false;

    searchResults.forEach(song => {
      // 【关键】将用户选择的音质写入歌曲对象
      if (modeChoice.includes('_new')) {
        song.preferredQuality = selectedQuality;
      }

      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.dataset.songJson = JSON.stringify(song);

      // 显示来源标签 (去除了 Emoji)
      let sourceTag = '';
      if (song.source === 'toubiec') {
        // 显示具体的音质标签
        const qualityLabels = {
          'lossless': '无损', 'hires': 'Hi-Res', 'jymaster': '母带',
          'dolby': '杜比', 'exhigh': '极高', 'standard': '标准',
          'sky': '全景', 'jyeffect': '空间'
        };
        const qLabel = qualityLabels[selectedQuality] || 'Pro';
        sourceTag = `<span class="source" style="color:#ff3b30; border-color:#ff3b30;">${qLabel}</span>`;
      } else if (song.source === 'netease') {
        sourceTag = '<span class="source" style="color:#c20c0c; border-color:#c20c0c;">网易云</span>';
      } else if (song.source === 'netease_real') {
        // 【新增】网易云真实源 (走自部署 API)
        const qualityLabels = {
          'lossless': '无损', 'hires': 'Hi-Res', 'jymaster': '母带',
          'dolby': '杜比', 'exhigh': '极高', 'standard': '标准',
          'sky': '全景', 'jyeffect': '空间'
        };
        const qLabel = qualityLabels[song.preferredQuality] || qualityLabels['exhigh'];
        sourceTag = `<span class="source" style="color:#c20c0c; border-color:#c20c0c;">网易云·${qLabel}</span>`;
      } else {
        sourceTag = '<span class="source" style="color:#00e09e; border-color:#00e09e;">QQ音乐</span>';
      }

      item.innerHTML = `
            <input type="checkbox" class="music-search-checkbox" style="margin-right: 15px;">
            <div class="search-result-info">
                <div class="title">${song.name}</div>
                <div class="artist">${song.artist} ${sourceTag}</div>
            </div>
        `;
      listEl.appendChild(item);
    });

    modal.classList.add('visible');
  }


  // --- 2. 修改详情获取逻辑 (修复版：增加 detail 解析以获取封面) ---
  async function getPlayableSongDetails(songData) {
    let playableResult = null;
    let finalSource = songData.source;

    // --- 处理 Toubiec 源 ---
    if (songData.source === 'toubiec') {
      const quality = songData.preferredQuality || 'exhigh';

      // 1. 获取播放链接
      const url = await getToubiecUrl(songData.id, quality);

      // 2. 【核心修复】获取歌曲详情 (为了拿到 picimg 封面)
      try {
        const detail = await getToubiecDetail(songData.id);
        if (detail) {
          // 如果API返回了封面，强制更新
          if (detail.picimg) {
            console.log(`[Toubiec] 获取到封面: ${detail.picimg}`);
            songData.cover = detail.picimg;
          }
          // 同步更新歌手名
          if (detail.singer) {
            songData.artist = detail.singer;
          }
        }
      } catch (e) {
        console.warn("[Toubiec] 获取详情失败，将使用默认封面", e);
      }

      if (url) {
        playableResult = {
          url: url.replace(/^http:\/\//i, 'https://'), // 强制 HTTPS
          id: songData.id,
          source: 'toubiec'
        };
      }
    }
    // --- 原有逻辑 (网易/腾讯) ---
    else if (songData.source === 'netease') {
      const primaryApiUrl = `https://api.vkeys.cn/v2/music/netease?id=${songData.id}`;
      let primaryResult = await Http_Get(primaryApiUrl);
      if (primaryResult?.data?.url) {
        playableResult = { url: primaryResult.data.url, id: songData.id, source: songData.source };
      }
    }
    // 【新增】网易云真实源 - 走 NeteaseMusic.getSongUrl (需登录)
    else if (songData.source === 'netease_real') {
      if (!window.NeteaseMusic) {
        console.error('[netease_real] NeteaseMusic module not loaded');
        return null;
      }
      const quality = songData.preferredQuality || 'exhigh';
      const urlResult = await window.NeteaseMusic.getSongUrl(songData.id, quality);
      if (urlResult && urlResult.url) {
        playableResult = { url: urlResult.url, id: urlResult.id, source: 'netease_real' };
        // 优先用 NeteaseMusic 拿到的详情更新歌曲元数据 (供 AI prompt 注入使用)
        try {
          const detail = await window.NeteaseMusic.getSongDetail(songData.id);
          if (detail) {
            if (detail.cover) songData.cover = detail.cover;
            if (detail.artist) songData.artist = detail.artist;
            if (detail.albumName) songData.album = detail.albumName;
            // 【0.0.37 新增】扩展字段, 让 AI 能"显得更懂行"
            if (detail.albumId) songData.albumId = detail.albumId;
            if (Array.isArray(detail.artists) && detail.artists.length) {
              songData.artists = detail.artists;          // [{id, name}, ...]
            }
            if (detail.duration) songData.duration = detail.duration;  // ms
            if (detail.publishTime) songData.publishTime = detail.publishTime;  // ms 时间戳
            if (typeof detail.fee === 'number') songData.fee = detail.fee;
          }
        } catch (e) {
          console.warn('[netease_real] getSongDetail failed, use search result', e);
        }
        // 记录实际拿到的音质 (供 AI 显示)
        songData.quality = urlResult.level || quality;
      } else {
        // 真实源拿不到 url, 可能是 cookie 失效 / VIP 限制
        console.warn('[netease_real] no playable url, cookie 可能失效');
      }
    } else {
      const primaryApiUrl = `https://api.vkeys.cn/v2/music/tencent?id=${songData.id}`;
      let primaryResult = await Http_Get(primaryApiUrl);
      if (primaryResult?.data?.url) {
        playableResult = { url: primaryResult.data.url, id: songData.id, source: songData.source };
      }
    }

    // --- 统一返回处理 ---
    if (playableResult) {
      let lrcContent = "";
      // 获取歌词
      if (finalSource === 'toubiec') {
        lrcContent = await getToubiecLyric(playableResult.id);
      } else if (finalSource === 'netease_real') {
        // 【新增】网易云真实源 - 走 NeteaseMusic.getLyric
        lrcContent = (window.NeteaseMusic && (await window.NeteaseMusic.getLyric(playableResult.id))) || "";
      } else {
        lrcContent = await getLyricsForSong(playableResult.id, finalSource) || "";
      }

      return {
        name: songData.name,
        artist: songData.artist,
        src: playableResult.url,
        cover: songData.cover, // 这里现在已经是更新过的封面了
        isLocal: false,
        lrcContent: lrcContent
      };
    }

    return null;
  }


  async function getLyricsForSong(songId, source) {
    const url = source === 'netease' ?
      `https://api.vkeys.cn/v2/music/netease/lyric?id=${songId}` :
      `https://api.vkeys.cn/v2/music/tencent/lyric?id=${songId}`;

    const response = await Http_Get(url);
    if (response?.data) {
      const lrc = response.data.lrc || response.data.lyric || "";
      const tlyric = response.data.trans || response.data.tlyric || "";
      return lrc + "\n" + tlyric;
    }
    return "";
  }

  async function handleManualLrcImport(trackIndex) {
    if (trackIndex < 0 || trackIndex >= musicState.playlist.length) return;

    const choice = await showChoiceModal('选择歌词导入方式', [{
      text: '📁 从本地文件 (.lrc)',
      value: 'file'
    },
    {
      text: '📋 直接粘贴歌词文本',
      value: 'paste'
    }
    ]);

    let lrcContent = null;

    if (choice === 'file') {
      lrcContent = await new Promise(resolve => {
        const lrcInput = document.getElementById('lrc-upload-input');
        const lrcChangeHandler = e => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = readEvent => resolve(readEvent.target.result);
            reader.onerror = () => resolve(null);
            reader.readAsText(file);
          } else {
            resolve(null);
          }
          lrcInput.removeEventListener('change', lrcChangeHandler);
          lrcInput.value = '';
        };
        lrcInput.addEventListener('change', lrcChangeHandler, {
          once: true
        });
        lrcInput.click();
      });
    } else if (choice === 'paste') {
      const pastedText = await showCustomPrompt('粘贴歌词', '请在此处粘贴歌词（LRC 格式或纯文本都行，纯文本会自动按字数估算每行时长）', '', 'textarea');
      if (pastedText) {
        let raw = pastedText.replace(/\[/g, '\n[').trim();
        // 【2026-07-10 修复】纯文本兜底：如果整段没有 [mm:ss 时间戳，按字数估算每行时长
        //   - 中文 3 字/秒（中等语速）
        //   - 英文/数字/标点 5 字符/秒
        //   - 每行最少 2s、最多 10s，防止超长行/超短行
        //   - 时间戳累计推进（第一行从 0 开始）
        // 原因：自己上传的原创歌没现成 LRC，parseLRC 不识别纯文本 → 灵动岛/歌词面板都不显示
        if (!/\[\d{1,2}:\d{1,2}/.test(raw)) {
          const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          let acc = 0;
          raw = lines.map((line) => {
            const cjkCount = (line.match(/[\u4e00-\u9fa5\u3400-\u4dbf]/g) || []).length;
            const nonCjkCount = line.replace(/[\u4e00-\u9fa5\u3400-\u4dbf]/g, '').replace(/\s+/g, '').length;
            const sec = Math.max(2, Math.min(10, cjkCount / 3 + nonCjkCount / 5));
            const startSec = Math.round(acc);
            acc += sec;
            const m = String(Math.floor(startSec / 60)).padStart(2, '0');
            const s = String(startSec % 60).padStart(2, '0');
            return `[${m}:${s}]${line}`;
          }).join('\n');
        }
        lrcContent = raw;
      }
    }

    if (lrcContent !== null) {
      musicState.playlist[trackIndex].lrcContent = lrcContent;


      await saveGlobalPlaylist();

      if (musicState.currentIndex === trackIndex) {
        musicState.parsedLyrics = parseLRC(lrcContent);
        renderLyrics();
        updateLyricsUI();
      }
      await showCustomAlert('成功', `《${musicState.playlist[trackIndex].name}》的歌词已成功保存！`);
    }
  }


  async function toggleBackgroundBlur() {
    if (musicState.currentIndex === -1) return;

    const track = musicState.playlist[musicState.currentIndex];
    if (!track) return;


    track.isBgClear = !track.isBgClear;


    await saveGlobalPlaylist();


    const playerWindow = document.querySelector('.music-player-window');
    const toggleBtn = document.getElementById('toggle-blur-btn');

    playerWindow.classList.toggle('bg-clear', track.isBgClear);
    toggleBtn.classList.toggle('active', track.isBgClear);
  }


  function toggleMusicPlayerAvatars() {
    const avatarDisplay = document.getElementById('music-player-avatar-display');
    const toggleBtn = document.getElementById('show-avatars-btn');
    if (avatarDisplay && toggleBtn) {
      avatarDisplay.classList.toggle('visible');
      toggleBtn.classList.toggle('active');
    }
  }


  function togglePlayerFullscreen() {
    const playerWindow = document.querySelector('.music-player-window');
    const overlay = document.getElementById('music-player-overlay');
    if (playerWindow && overlay) {

      playerWindow.classList.toggle('fullscreen');
      overlay.classList.toggle('fullscreen-active');
    }
  }

  window.togglePlayerFullscreen = togglePlayerFullscreen;


  async function cleanupInvalidSongs() {
    if (musicState.playlist.length === 0) {
      alert("播放列表是空的，无需清理。");
      return;
    }

    const confirmed = await showCustomConfirm(
      '确认清理无效歌曲？',
      '此操作将检查播放列表中的每一首网络歌曲，并移除所有无法播放的"死链"。本地歌曲不会受影响。', {
      confirmText: '开始清理'
    }
    );

    if (!confirmed) return;

    await showCustomAlert("请稍候...", `正在检查 ${musicState.playlist.length} 首歌曲，这可能需要一些时间...`);

    const originalCount = musicState.playlist.length;
    const validPlaylist = [];
    const invalidSongs = [];

    const checkPromises = musicState.playlist.map(async (track) => {
      if (track.isLocal) {
        validPlaylist.push(track);
        return;
      }

      const isAvailable = await checkAudioAvailability(track.src);
      if (isAvailable) {
        validPlaylist.push(track);
      } else {
        invalidSongs.push({
          name: track.name,
          artist: track.artist || '未知歌手'
        });
        console.warn(`无效链接: ${track.name} - ${track.src}`);
      }
    });

    await Promise.all(checkPromises);

    const removedCount = originalCount - validPlaylist.length;

    if (removedCount > 0) {
      const currentPlayingTrack = musicState.playlist[musicState.currentIndex];
      const isCurrentTrackRemoved = invalidSongs.some(s => s.name === currentPlayingTrack?.name);

      musicState.playlist = validPlaylist;
      await saveGlobalPlaylist();

      if (isCurrentTrackRemoved) {
        audioPlayer.pause();
        audioPlayer.src = '';
        musicState.currentIndex = musicState.playlist.length > 0 ? 0 : -1;
        musicState.isPlaying = false;
      } else if (currentPlayingTrack) {
        musicState.currentIndex = musicState.playlist.findIndex(t => t.src === currentPlayingTrack.src);
      }

      updatePlaylistUI();
      updatePlayerUI();

      // 显示被清理的歌曲列表模态框
      showCleanedSongsModal(invalidSongs);
    } else {
      await showCustomAlert("检查完成", "所有歌曲链接均有效，无需清理！");
    }
  }

  // 显示被清理歌曲的模态框
  function showCleanedSongsModal(cleanedSongs) {
    const modal = document.getElementById('cleaned-songs-modal');
    const listEl = document.getElementById('cleaned-songs-list');
    listEl.innerHTML = '';
    document.getElementById('select-all-cleaned-songs').checked = false;

    cleanedSongs.forEach(song => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.dataset.songJson = JSON.stringify(song);

      item.innerHTML = `
        <input type="checkbox" class="cleaned-song-checkbox" style="margin-right: 15px;">
        <div class="search-result-info">
          <div class="title">${song.name}</div>
          <div class="artist">${song.artist}</div>
        </div>
      `;
      listEl.appendChild(item);
    });

    modal.classList.add('visible');
  }

  // 处理重新搜索选中的歌曲
  async function handleResearchSelectedSongs() {
    const modal = document.getElementById('cleaned-songs-modal');
    const checkboxes = modal.querySelectorAll('.cleaned-song-checkbox:checked');

    if (checkboxes.length === 0) {
      await showCustomAlert("提示", "请先选择要重新搜索的歌曲");
      return;
    }

    const selectedSongs = [];
    checkboxes.forEach(cb => {
      const item = cb.closest('.search-result-item');
      const songData = JSON.parse(item.dataset.songJson);
      selectedSongs.push(songData);
    });

    // 关闭被清理歌曲模态框
    modal.classList.remove('visible');

    // 逐个处理
    await processResearchSongsOneByOne(selectedSongs);
  }

  // 逐个处理重新搜索的歌曲
  async function processResearchSongsOneByOne(songs) {
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      let searchQuery = `${song.name} ${song.artist}`;

      // 让用户确认或修改搜索关键词
      const userQuery = prompt(`第 ${i + 1}/${songs.length} 首\n\n请确认或修改搜索关键词：`, searchQuery);

      if (userQuery === null) {
        // 用户点击取消，询问是否继续下一首
        const continueNext = await showCustomConfirm(
          "已取消",
          `是否继续搜索下一首歌曲？`,
          { confirmText: '继续' }
        );
        if (!continueNext) break;
        continue;
      }

      searchQuery = userQuery.trim();
      if (!searchQuery) {
        await showCustomAlert("提示", "搜索关键词不能为空");
        i--; // 重新处理当前歌曲
        continue;
      }

      // 搜索循环，允许重新输入关键词
      let searchSuccess = false;
      while (!searchSuccess) {
        await showCustomAlert("搜索中...", `正在搜索：${searchQuery}`);

        try {
          // 使用默认的 exhigh 音质搜索
          const searchResults = await searchToubiec(searchQuery);

          if (searchResults.length === 0) {
            // 未找到结果，询问是否重新输入关键词
            const choice = await showChoiceModal("未找到结果", [
              { text: `"${searchQuery}" 没有搜索到结果`, value: 'info' },
              { text: '重新输入关键词', value: 'retry' },
              { text: '跳过此歌曲', value: 'skip' },
              { text: '结束搜索', value: 'quit' }
            ]);

            if (choice === 'retry') {
              const newQuery = prompt(`请重新输入搜索关键词：`, searchQuery);
              if (newQuery && newQuery.trim()) {
                searchQuery = newQuery.trim();
                continue; // 继续搜索循环
              } else {
                searchSuccess = true; // 退出搜索循环，继续下一首
                break;
              }
            } else if (choice === 'skip') {
              searchSuccess = true; // 跳过，继续下一首
              break;
            } else if (choice === 'quit') {
              return; // 结束整个搜索流程
            }
            continue;
          }

          // 显示搜索结果让用户选择
          const selectedTrack = await showSongSelectionModal(searchResults, song.name, i + 1, songs.length);

          if (selectedTrack) {
            // 获取歌曲详情并添加到播放列表
            const trackDetails = await getPlayableSongDetails(selectedTrack);

            if (trackDetails) {
              trackDetails.playlistId = trackDetails.playlistId || musicState.activePlaylistId || 'default';
              musicState.playlist.push(trackDetails);
              await saveGlobalPlaylist();
              updatePlaylistUI();
              await showCustomAlert("添加成功", `"${song.name}" 已添加到播放列表`);
              searchSuccess = true; // 成功，继续下一首
            } else {
              await showCustomAlert("添加失败", `无法获取 "${song.name}" 的播放链接`);
              searchSuccess = true; // 失败也继续下一首
            }
          } else {
            // 用户取消或跳过
            searchSuccess = true; // 继续下一首
          }

        } catch (e) {
          console.error(`搜索 "${searchQuery}" 失败:`, e);
          const retry = await showCustomConfirm(
            "搜索出错",
            `搜索 "${searchQuery}" 时出错，是否重新尝试？`,
            { confirmText: '重新尝试' }
          );
          if (!retry) {
            searchSuccess = true; // 不重试，继续下一首
          }
        }
      }
    }

    await showCustomAlert("完成", "所有选中的歌曲已处理完毕");
  }

  // 显示歌曲选择模态框
  function showSongSelectionModal(searchResults, songName, currentIndex, totalCount) {
    return new Promise((resolve) => {
      const modal = document.getElementById('music-search-results-modal');
      const listEl = document.getElementById('search-results-list');
      const headerSpan = modal.querySelector('.modal-header span');

      // 修改标题显示当前进度
      headerSpan.textContent = `选择歌曲 (${currentIndex}/${totalCount}): ${songName}`;

      listEl.innerHTML = '';
      document.getElementById('select-all-music-search').checked = false;

      // 渲染搜索结果（单选模式）
      searchResults.forEach(song => {
        song.preferredQuality = 'exhigh'; // 默认极高音质

        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.dataset.songJson = JSON.stringify(song);
        item.style.cursor = 'pointer';

        let sourceTag = '';
        if (song.source === 'toubiec') {
          sourceTag = '<span class="source" style="color:#ff3b30; border-color:#ff3b30;">极高</span>';
        } else if (song.source === 'netease') {
          sourceTag = '<span class="source" style="color:#c20c0c; border-color:#c20c0c;">网易云</span>';
        } else {
          sourceTag = '<span class="source" style="color:#00e09e; border-color:#00e09e;">QQ音乐</span>';
        }

        item.innerHTML = `
          <input type="radio" name="song-selection-radio" class="music-search-radio" style="margin-right: 15px;">
          <div class="search-result-info">
            <div class="title">${song.name}</div>
            <div class="artist">${song.artist} ${sourceTag}</div>
          </div>
        `;

        // 点击整行也能选中
        item.addEventListener('click', (e) => {
          if (e.target.type !== 'radio') {
            const radio = item.querySelector('.music-search-radio');
            radio.checked = true;
          }
        });

        listEl.appendChild(item);
      });

      modal.classList.add('visible');

      // 临时修改按钮文本和功能
      const cancelBtn = document.getElementById('cancel-music-search-btn');
      const confirmBtn = document.getElementById('add-selected-music-btn');

      const originalCancelText = cancelBtn.textContent;
      const originalConfirmText = confirmBtn.textContent;

      cancelBtn.textContent = '跳过';
      confirmBtn.textContent = '确认添加';

      // 取消/跳过按钮
      const handleCancel = () => {
        cleanup();
        resolve(null);
      };

      // 确认按钮
      const handleConfirm = () => {
        const selectedRadio = modal.querySelector('.music-search-radio:checked');
        if (!selectedRadio) {
          alert('请先选择一首歌曲');
          return;
        }

        const item = selectedRadio.closest('.search-result-item');
        const songData = JSON.parse(item.dataset.songJson);
        cleanup();
        resolve(songData);
      };

      const cleanup = () => {
        modal.classList.remove('visible');
        headerSpan.textContent = '搜索结果'; // 恢复标题
        cancelBtn.textContent = originalCancelText;
        confirmBtn.textContent = originalConfirmText;
        cancelBtn.removeEventListener('click', handleCancel);
        confirmBtn.removeEventListener('click', handleConfirm);
      };

      cancelBtn.addEventListener('click', handleCancel);
      confirmBtn.addEventListener('click', handleConfirm);
    });
  }

  // ========== 歌单管理模式（来自 script.js 第 11197~11500 行） ==========

  let isPlaylistManagementMode = false;
  let selectedPlaylistItems = new Set();

  function togglePlaylistManagementMode() {
    isPlaylistManagementMode = !isPlaylistManagementMode;
    const panel = document.getElementById('music-playlist-panel');
    const manageBtn = document.getElementById('manage-playlist-btn');
    const actionBar = document.getElementById('playlist-action-bar');
    const selectAllCheckbox = document.getElementById('select-all-playlist-checkbox');

    panel.classList.toggle('management-mode', isPlaylistManagementMode);

    if (isPlaylistManagementMode) {
      manageBtn.textContent = translations[currentLanguage].done;
      manageBtn.setAttribute('data-lang-key', 'done');
      actionBar.style.display = 'flex';
      selectedPlaylistItems.clear();
      selectAllCheckbox.checked = false;
      updatePlaylistActionBar();
      // 显示复选框
      panel.querySelectorAll('.playlist-item-checkbox').forEach(cb => cb.style.display = 'block');
    } else {
      manageBtn.textContent = translations[currentLanguage].manage;
      manageBtn.setAttribute('data-lang-key', 'manage');
      actionBar.style.display = 'none';
      // 隐藏复选框并取消选中
      panel.querySelectorAll('.playlist-item').forEach(item => {
        item.classList.remove('selected');
        const cb = item.querySelector('.playlist-item-checkbox');
        if (cb) {
          cb.style.display = 'none';
          cb.checked = false;
        }
      });
    }
  }

  function handlePlaylistSelection(index) {
    if (!isPlaylistManagementMode) return;

    const item = document.querySelector(`.playlist-item[data-index="${index}"]`);
    if (!item) return;
    const checkbox = item.querySelector('.playlist-item-checkbox');

    // 切换状态
    const isSelected = selectedPlaylistItems.has(index);
    item.classList.toggle('selected', !isSelected);
    checkbox.checked = !isSelected;

    if (isSelected) {
      selectedPlaylistItems.delete(index);
    } else {
      selectedPlaylistItems.add(index);
    }
    updatePlaylistActionBar();
  }

  function updatePlaylistActionBar() {
    const uploadBtn = document.getElementById('upload-selected-to-catbox-btn');
    const deleteBtn = document.getElementById('delete-selected-songs-btn');
    const moveBtn = document.getElementById('move-to-playlist-btn');
    const count = selectedPlaylistItems.size;
    if (uploadBtn) uploadBtn.textContent = `上传Catbox (${count})`;
    if (deleteBtn) deleteBtn.textContent = `删除 (${count})`;
    if (moveBtn) moveBtn.textContent = `移到歌单 (${count})`;
  }

  function handleSelectAllPlaylistItems() {
    const checkbox = document.getElementById('select-all-playlist-checkbox');
    const shouldSelect = checkbox.checked;

    document.querySelectorAll('.playlist-item').forEach(item => {
      const index = parseInt(item.dataset.index);
      if (isNaN(index)) return;

      item.classList.toggle('selected', shouldSelect);
      item.querySelector('.playlist-item-checkbox').checked = shouldSelect;

      if (shouldSelect) {
        selectedPlaylistItems.add(index);
      } else {
        selectedPlaylistItems.delete(index);
      }
    });
    updatePlaylistActionBar();
  }

  async function executeDeleteSelectedSongs() {
    if (selectedPlaylistItems.size === 0) {
      await showCustomAlert("未选择", "请先选择要删除的歌曲。");
      return;
    }

    const confirmed = await showCustomConfirm(
      '确认删除？',
      `确定要删除选中的 ${selectedPlaylistItems.size} 首歌曲吗？此操作无法撤销。`,
      { confirmText: '确认删除', cancelText: '取消' }
    );

    if (!confirmed) return;

    // 将选中的索引转为数组并从大到小排序（避免删除时索引错乱）
    const indicesToDelete = Array.from(selectedPlaylistItems).sort((a, b) => b - a);

    // 从播放列表中删除歌曲
    for (const index of indicesToDelete) {
      if (index >= 0 && index < musicState.playlist.length) {
        musicState.playlist.splice(index, 1);
      }
    }

    // 如果当前正在播放的歌曲被删除，需要调整currentIndex
    if (indicesToDelete.includes(musicState.currentIndex)) {
      if (musicState.playlist.length > 0) {
        musicState.currentIndex = 0;
        loadCurrentSong();
      } else {
        musicState.currentIndex = -1;
        if (musicState.audio) {
          musicState.audio.pause();
          musicState.audio.src = '';
        }
      }
    } else if (musicState.currentIndex >= musicState.playlist.length) {
      musicState.currentIndex = Math.max(0, musicState.playlist.length - 1);
    }

    await saveGlobalPlaylist();

    await showCustomAlert("删除成功", `已删除 ${indicesToDelete.length} 首歌曲。`);

    selectedPlaylistItems.clear();
    togglePlaylistManagementMode();
    updatePlaylistUI();
  }

  async function executeMoveToPlaylist() {
    if (selectedPlaylistItems.size === 0) {
      await showCustomAlert("未选择", "请先选择要移动的歌曲。");
      return;
    }
    const targetId = await showPlaylistPicker('移动到哪个歌单？');
    if (!targetId) return;
    const targetName = musicState.playlists.find(p => p.id === targetId)?.name || '默认';
    for (const index of selectedPlaylistItems) {
      if (index >= 0 && index < musicState.playlist.length) {
        musicState.playlist[index].playlistId = targetId;
      }
    }
    await saveGlobalPlaylist();
    selectedPlaylistItems.clear();
    togglePlaylistManagementMode();
    updatePlaylistUI();
    await showCustomAlert("移动成功", `已将选中歌曲移到「${targetName}」`);
  }

  async function executeBatchUploadToCatbox() {
    if (!state.apiConfig.catboxEnable || !state.apiConfig.catboxUserHash) {
      await showCustomAlert("功能未开启", "请先在\u201CAPI设置\u201D -> \u201CCatbox.moe\u201D中开启此功能并填写您的 User Hash。");
      return;
    }

    if (selectedPlaylistItems.size === 0) {
      await showCustomAlert("未选择", "请先选择要上传的歌曲。");
      return;
    }

    const indicesToUpload = Array.from(selectedPlaylistItems).filter(index => {
      const song = musicState.playlist[index];
      return song && song.src && !String(song.src).includes('catbox.moe');
    });

    if (indicesToUpload.length === 0) {
      await showCustomAlert("无需上传", "您选择的所有歌曲均已在 Catbox 上。");
      togglePlaylistManagementMode();
      return;
    }

    const confirmed = await showCustomConfirm(
      '确认上传？',
      `即将上传 ${indicesToUpload.length} 首歌曲到 Catbox.moe。\n\n这会转换本地音乐和外部链接，可能需要一些时间并消耗流量。\n（已在 Catbox 上的歌曲将被自动跳过）`,
      { confirmText: '开始上传' }
    );

    if (!confirmed) return;

    await showCustomAlert("请稍候...", `正在开始上传 ${indicesToUpload.length} 首歌曲，请勿关闭页面...`);

    let successCount = 0;
    let failCount = 0;
    const failedNames = [];

    const proxySettings = getNovelAISettings();
    let corsProxy = proxySettings.cors_proxy;
    if (corsProxy === 'custom') {
      corsProxy = proxySettings.custom_proxy_url || '';
    }


    for (const index of indicesToUpload) {
      const song = musicState.playlist[index];
      try {
        let fileToUpload;
        let songName = song.name || 'unknown_track.mp3';

        if (song.isLocal) {
          console.log(`[Catbox 批量上传] 处理本地歌曲: ${song.name}`);
          fileToUpload = new Blob([song.src], { type: song.fileType || 'audio/mpeg' });
        } else {
          console.log(`[Catbox 批量上传] 处理网络歌曲: ${song.name} from ${song.src}`);

          let fetchUrl = song.src;
          if (corsProxy && corsProxy !== '' && !fetchUrl.startsWith('data:')) {
            fetchUrl = corsProxy + encodeURIComponent(song.src);
            console.log(`[Catbox 批量上传] 使用代理下载: ${fetchUrl}`);
          } else {
            console.log(`[Catbox 批量上传] 不使用代理，尝试直连下载... (这在Safari上会失败)`);
          }

          const response = await fetch(fetchUrl);
          if (!response.ok) throw new Error(`下载歌曲失败，状态: ${response.status}`);
          fileToUpload = await response.blob();
        }

        if (!songName.match(/\.(mp3|wav|flac|m4a|ogg)$/i)) {
          songName += '.mp3';
        }

        const newCatboxUrl = await uploadFileToCatbox(new File([fileToUpload], songName, { type: fileToUpload.type }));

        song.src = newCatboxUrl;
        song.isLocal = false;
        delete song.fileType;
        successCount++;

      } catch (error) {
        console.error(`[Catbox 批量上传] 上传失败: ${song.name}`, error);
        failCount++;
        failedNames.push(song.name);
      }
    }

    await saveGlobalPlaylist();

    let summary = `上传完成！\n\n成功: ${successCount} 首`;
    if (failCount > 0) {
      summary += `\n失败: ${failCount} 首\n(${failedNames.join(', ')})`;
    }
    await showCustomAlert("操作完成", summary);

    togglePlaylistManagementMode();
    updatePlaylistUI();
  }

  // 【0.0.37 新增】网易云 App 调用: 加入 playlist + 触发一起听 + 播放 + AI 联动
  window.ephAddToPlaylistAndPlay = function (songInfo, chatId) {
    if (!songInfo) {
      console.error('[eph] songInfo missing');
      return false;
    }

    const result = addOrUpdateMusicTrack(songInfo);
    if (result.index < 0) {
      console.error('[eph] addOrUpdateMusicTrack failed');
      return false;
    }

    const targetChatId = chatId || state.activeChatId;
    if (targetChatId) {
      startListenTogetherSession(targetChatId, false);
    } else {
      document.getElementById('music-player-overlay').classList.add('visible');
    }

    playSong(result.index, true);

    if (typeof updatePlayerUI === 'function') updatePlayerUI();
    if (typeof updatePlaylistUI === 'function') updatePlaylistUI();
    if (typeof saveGlobalPlaylist === 'function') saveGlobalPlaylist();
    return true;
  };

  // ========== 导出到全局作用域 ==========
  window.applyLyricsBarPosition = applyLyricsBarPosition;
  window.getLrcContent = getLrcContent;
  window.saveGlobalPlaylist = saveGlobalPlaylist;
  window.addMusicActionSystemMessage = addMusicActionSystemMessage;
  window.handleListenTogetherClick = handleListenTogetherClick;
  window.startListenTogetherSession = startListenTogetherSession;
  window.endListenTogetherSession = endListenTogetherSession;
  window.returnToChat = returnToChat;
  window.showMusicPlayerOverlay = showMusicPlayerOverlay;
  window.updateListenTogetherIcon = updateListenTogetherIcon;
  window.updatePlayerUI = updatePlayerUI;
  window.updateElapsedTimeDisplay = updateElapsedTimeDisplay;
  window.updatePlaylistUI = updatePlaylistUI;
  window.getMusicTrackKey = getMusicTrackKey;
  window.findExistingMusicTrackIndex = findExistingMusicTrackIndex;
  window.addOrUpdateMusicTrack = addOrUpdateMusicTrack;
  window.refreshNeteaseTrackUrl = refreshNeteaseTrackUrl;
  window.playTemporaryNeteaseTrack = playTemporaryNeteaseTrack;
  window.getActivePlaylistIndices = getActivePlaylistIndices;
  window.renderPlaylistTabs = renderPlaylistTabs;
  window.showSharePlaylistMenu = showSharePlaylistMenu;
  window.sharePlaylistToCharacter = sharePlaylistToCharacter;
  window.showPlaylistPicker = showPlaylistPicker;
  window.openPlaylistManager = openPlaylistManager;
  window.togglePlayPause = togglePlayPause;
  window.playNext = playNext;
  window.playPrev = playPrev;
  window.changePlayMode = changePlayMode;
  window.addSongFromURL = addSongFromURL;
  window.playSong = playSong;
  window.handleChangeBackground = handleChangeBackground;
  window.handleChangeAlbumArt = handleChangeAlbumArt;
  window.addSongFromLocal = addSongFromLocal;
  window.deleteTrack = deleteTrack;
  window.closeMusicPlayerWithAnimation = closeMusicPlayerWithAnimation;
  window.parseLRC = parseLRC;
  window.renderLyrics = renderLyrics;
  window.updateIslandScrollAnimation = updateIslandScrollAnimation;
  window.checkLyricScroll = checkLyricScroll;
  window.updateActiveLyric = updateActiveLyric;
  window.updateLyricsUI = updateLyricsUI;
  window.formatMusicTime = formatMusicTime;
  window.updateMusicProgressBar = updateMusicProgressBar;
  window.Http_Get = Http_Get;
  window.checkAudioAvailability = checkAudioAvailability;
  window.searchNeteaseMusic = searchNeteaseMusic;
  window.fetchToubiec = fetchToubiec;
  window.searchToubiec = searchToubiec;
  window.getToubiecPlaylist = getToubiecPlaylist;
  window.getToubiecAlbum = getToubiecAlbum;
  window.getToubiecDetail = getToubiecDetail;
  window.getToubiecUrl = getToubiecUrl;
  window.getToubiecLyric = getToubiecLyric;
  window.searchTencentMusic = searchTencentMusic;
  window.addSongFromSearch = addSongFromSearch;
  window.getPlayableSongDetails = getPlayableSongDetails;
  window.getLyricsForSong = getLyricsForSong;
  window.handleManualLrcImport = handleManualLrcImport;
  window.toggleBackgroundBlur = toggleBackgroundBlur;
  window.toggleMusicPlayerAvatars = toggleMusicPlayerAvatars;
  window.cleanupInvalidSongs = cleanupInvalidSongs;
  window.showCleanedSongsModal = showCleanedSongsModal;
  window.handleResearchSelectedSongs = handleResearchSelectedSongs;
  window.processResearchSongsOneByOne = processResearchSongsOneByOne;
  window.showSongSelectionModal = showSongSelectionModal;
  window.togglePlaylistManagementMode = togglePlaylistManagementMode;
  window.handlePlaylistSelection = handlePlaylistSelection;
  window.updatePlaylistActionBar = updatePlaylistActionBar;
  window.handleSelectAllPlaylistItems = handleSelectAllPlaylistItems;
  window.executeDeleteSelectedSongs = executeDeleteSelectedSongs;
  window.executeMoveToPlaylist = executeMoveToPlaylist;
  window.executeBatchUploadToCatbox = executeBatchUploadToCatbox;

  // ========== AI 原创曲 / 翻唱 API（Step 5）==========
  // 暴露给 ai-response.js / ai-group.js / background-activity.js 调用
  window.MusicPlayer = {
    addAiSongActionMessage: addAiSongActionMessage,
    addAiSongToPlaylist: addAiSongToPlaylist,
    playAiSongImmediately: playAiSongImmediately,
    playSong: playSong,
    addOrUpdateMusicTrack: addOrUpdateMusicTrack,
    updatePlaylistUI: updatePlaylistUI,
    updatePlayerUI: updatePlayerUI,
    saveGlobalPlaylist: saveGlobalPlaylist,
    ensureAiOriginalPlaylist: ensureAiOriginalPlaylist,
    AI_ORIGINAL_PLAYLIST_ID: AI_ORIGINAL_PLAYLIST_ID,
    AI_ORIGINAL_PLAYLIST_NAME: AI_ORIGINAL_PLAYLIST_NAME
  };
})();

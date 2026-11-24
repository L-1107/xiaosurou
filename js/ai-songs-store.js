// ============================================================
// ai-songs-store.js — AI 原创曲 / 翻唱 的 IndexedDB 持久化
// 功能：存 AI 唱的歌到独立 store，跨 session 不丢
//       提供 window.persistAiSongBlob 全局函数（被 background-activity.js / ai-response.js 调用）
// 来源：参考 js/music-voice-sample.js（音色样本的 IndexedDB 模式）
// ============================================================

(function () {
  const DB_NAME = 'ai-songs';
  // 【2026-07-22 bump】1 → 2，触发 onupgradeneeded 修正老 store 的 keyPath（之前老 schema keyPath 不是 'songId' 导致 DataError）
  // 老数据本来就没存进去（DataError 失败），删了重建安全
  const DB_VERSION = 2;
  const STORE_NAME = 'songs';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // 如果 store 存在但 keyPath 不对，删了重建（兼容老 schema）
        if (db.objectStoreNames.contains(STORE_NAME)) {
          const existing = e.target.transaction.objectStore(STORE_NAME);
          if (existing.keyPath !== 'songId') {
            console.warn('[AiSongsStore] 老 store keyPath 是 ' + existing.keyPath + '，删了重建为 songId');
            db.deleteObjectStore(STORE_NAME);
          }
        }
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'songId' });
          // 给 chatId 建索引（按角色查所有原创曲）
          store.createIndex('chatId', 'chatId', { unique: false });
          // 按创建时间排序用
          store.createIndex('createdAt', 'createdAt', { unique: false });
          console.log('[AiSongsStore] 创建新 store, keyPath=songId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // 存一首 AI 原创 / 翻唱
  // metadata 字段：{ chatId, blob, title, prompt, lyrics, instrumental, createdAt }
  //   (2026-11-19: useVoiceSample 字段随 Cover 模式一起没了)
  async function persistSong(songId, metadata) {
    if (!songId || !metadata) {
      console.error('[AiSongsStore] persistSong: missing songId or metadata', { songId, hasMetadata: !!metadata });
      return false;
    }
    const blobSize = metadata.blob && typeof metadata.blob.size === 'number' ? metadata.blob.size : 0;
    const blobType = metadata.blob && metadata.blob.type;
    const stageLog = (stage, extra) => {
      console.log('[AiSongsStore] persistSong stage=' + stage, JSON.stringify(Object.assign({
        songId, blobSize, blobType, titleLen: (metadata.title || '').length, chatId: metadata.chatId
      }, extra || {})));
    };
    let db;
    try {
      stageLog('openDb-start');
      db = await openDb();
      stageLog('openDb-ok', { dbName: db.name, version: db.version, stores: Array.from(db.objectStoreNames) });
    } catch (e) {
      console.error('[AiSongsStore] persistSong openDb failed:', e && e.name, e && e.message);
      return false;
    }
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        // 【2026-07-22 修】songId 显式 set 在前，避免 Object.assign 把 undefined 合并覆盖
        // 之前用 Object.assign({}, metadata, { songId }) 在 metadata.songId 已是 undefined 时会出现 keyPath 取不到值
        const record = { songId: songId, ...metadata };
        // 【2026-07-22 修】强制 blob mime type = audio/mpeg——避免 IDB 反序列化时 type 字段丢失
        //  没 mime 的 blob 经 FileReader 转 data URI 会输出 'data:;base64,xxx' 没 mime 前缀 → <audio> 拒绝播
        if (record.blob && record.blob.type !== 'audio/mpeg') {
          record.blob = new Blob([record.blob], { type: 'audio/mpeg' });
        }
        stageLog('put-start', {
          recordKeys: Object.keys(record),
          songIdValue: record.songId,
          songIdType: typeof record.songId,
          songIdInput: songId,
          songIdInputType: typeof songId,
          hasChatId: record.chatId !== undefined,
          hasBlob: record.blob instanceof Blob,
          blobSize: record.blob && record.blob.size
        });
        const req = store.put(record);
        req.onsuccess = () => {
          stageLog('put-success');
          resolve(true);
        };
        req.onerror = (ev) => {
          const err = req.error || (ev && ev.target && ev.target.error);
          console.error('[AiSongsStore] persistSong store.put onerror:', err && err.name, err && err.message);
          reject(err);
        };
        tx.oncomplete = () => { /* ignore */ };
        tx.onerror = (ev) => {
          const err = tx.error || (ev && ev.target && ev.target.error);
          console.error('[AiSongsStore] persistSong tx.onerror:', err && err.name, err && err.message);
        };
        tx.onabort = (ev) => {
          const err = tx.error || (ev && ev.target && ev.target.error);
          console.error('[AiSongsStore] persistSong tx.onabort:', err && err.name, err && err.message);
        };
      });
    } catch (e) {
      console.error('[AiSongsStore] persistSong outer catch:', e && e.name, e && e.message, e && e.stack);
      return false;
    }
  }

  async function getSong(songId) {
    if (!songId) return null;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(songId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[AiSongsStore] getSong failed:', e);
      return null;
    }
  }

  async function deleteSong(songId) {
    if (!songId) return false;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(songId);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[AiSongsStore] deleteSong failed:', e);
      return false;
    }
  }

  // 列某角色所有原创曲（不含 blob，只元信息）
  async function listSongsByChat(chatId) {
    if (!chatId) return [];
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const idx = store.index('chatId');
        const req = idx.getAll(chatId);
        req.onsuccess = () => {
          const list = (req.result || []).map(r => ({
            songId: r.songId,
            title: r.title,
            createdAt: r.createdAt,
            size: r.blob ? r.blob.size : 0,
            isCover: false   // 2026-11-19: Cover 模式删掉了, 一律 false
          }));
          list.sort((a, b) => b.createdAt - a.createdAt);
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[AiSongsStore] listSongsByChat failed:', e);
      return [];
    }
  }

  // 暴露 API + 全局函数（被 background-activity.js / ai-response.js 直接调）
  // 【2026-07-22 加】listAllSongs — 悬浮球"AI 原创曲管理"用的全量列表
  async function listAllSongs() {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result || []).map(r => ({
            songId: r.songId,
            title: r.title,
            chatId: r.chatId,
            createdAt: r.createdAt,
            size: r.blob ? r.blob.size : 0,
            isCover: false,   // 2026-11-19: Cover 模式删掉了, 一律 false
            hasLyrics: !!r.lyrics,
            lyrics: r.lyrics || '',
            blob: r.blob
          }));
          list.sort((a, b) => b.createdAt - a.createdAt);
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[AiSongsStore] listAllSongs failed:', e);
      return [];
    }
  }

  window.AiSongsStore = {
    persistSong: persistSong,
    getSong: getSong,
    deleteSong: deleteSong,
    listSongsByChat: listSongsByChat,
    listAllSongs: listAllSongs
  };
  // 全局便捷函数，跟"被 background-activity.js 调"那行匹配
  window.persistAiSongBlob = persistSong;
})();

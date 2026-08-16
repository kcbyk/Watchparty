// ══════════════════════════════════════════════════════════════════════════════
// WatchParty SQLite High-Performance Persistence Layer
// ══════════════════════════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'watchparty.sqlite');
const db = new Database(dbPath);

// Enable WAL (Write-Ahead Logging) mode for lightning-fast concurrent reads & writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── Initialize Tables ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    current_video TEXT,
    video_state TEXT,
    queue TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    user TEXT,
    text TEXT NOT NULL,
    type TEXT DEFAULT 'user',
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS search_cache (
    cache_key TEXT PRIMARY KEY,
    query TEXT,
    results_json TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS liked_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    video_id TEXT,
    video_json TEXT,
    created_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
  CREATE INDEX IF NOT EXISTS idx_search_key ON search_cache(cache_key);
`);

// ─── Prepared Statements for Max Speed ───────────────────────────────────────
const stmts = {
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  upsertRoom: db.prepare(`
    INSERT INTO rooms (id, current_video, video_state, queue, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      current_video = excluded.current_video,
      video_state = excluded.video_state,
      queue = excluded.queue,
      updated_at = excluded.updated_at
  `),
  getAllRooms: db.prepare('SELECT * FROM rooms'),
  deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),

  // Messages
  addMessage: db.prepare(`
    INSERT INTO messages (room_id, user, text, type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getRoomMessages: db.prepare(`
    SELECT user, text, type, created_at as time
    FROM messages
    WHERE room_id = ?
    ORDER BY id ASC
    LIMIT 100
  `),

  // Search Cache
  getSearchCache: db.prepare('SELECT results_json, created_at FROM search_cache WHERE cache_key = ?'),
  setSearchCache: db.prepare(`
    INSERT INTO search_cache (cache_key, query, results_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      results_json = excluded.results_json,
      created_at = excluded.created_at
  `),
  cleanOldSearchCache: db.prepare('DELETE FROM search_cache WHERE created_at < ?')
};

// ─── Exported DB Helper Methods ──────────────────────────────────────────────
module.exports = {
  // Room persistence
  saveRoom(roomId, roomData) {
    try {
      const currentVideo = roomData.currentVideo ? JSON.stringify(roomData.currentVideo) : null;
      const videoState = roomData.videoState ? JSON.stringify(roomData.videoState) : null;
      const queue = Array.isArray(roomData.queue) ? JSON.stringify(roomData.queue) : '[]';
      const now = Date.now();
      stmts.upsertRoom.run(roomId, currentVideo, videoState, queue, now, now);
    } catch (e) {
      console.warn('[DB saveRoom Error]', e.message);
    }
  },

  loadAllRooms() {
    try {
      const rows = stmts.getAllRooms.all();
      const loaded = new Map();
      rows.forEach(r => {
        loaded.set(r.id, {
          currentVideo: r.current_video ? JSON.parse(r.current_video) : null,
          videoState: r.video_state ? JSON.parse(r.video_state) : { playing: false, time: 0, updatedAt: Date.now() },
          queue: r.queue ? JSON.parse(r.queue) : [],
          users: [],
          messages: []
        });
      });
      return loaded;
    } catch (e) {
      console.warn('[DB loadAllRooms Error]', e.message);
      return new Map();
    }
  },

  // Message persistence
  saveMessage(roomId, msg) {
    try {
      stmts.addMessage.run(roomId, msg.user || null, msg.text || '', msg.type || 'user', msg.time || Date.now());
    } catch (e) {
      console.warn('[DB saveMessage Error]', e.message);
    }
  },

  getRecentMessages(roomId) {
    try {
      return stmts.getRoomMessages.all(roomId);
    } catch (e) {
      console.warn('[DB getRecentMessages Error]', e.message);
      return [];
    }
  },

  // Search cache persistence
  getCachedSearch(key, maxAgeMs = 3 * 24 * 60 * 60 * 1000) { // 3 days cache
    try {
      const row = stmts.getSearchCache.get(key);
      if (!row) return null;
      if (Date.now() - row.created_at > maxAgeMs) return null;
      return JSON.parse(row.results_json);
    } catch (e) {
      return null;
    }
  },

  setCachedSearch(key, query, results) {
    try {
      if (!Array.isArray(results) || results.length === 0) return;
      stmts.setSearchCache.run(key, query, JSON.stringify(results), Date.now());
    } catch (e) {
      console.warn('[DB setSearchCache Error]', e.message);
    }
  }
};

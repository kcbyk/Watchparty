/* ── Room App — room.js ──────────────────────────────────────────────────────
   WatchParty — YouTube-style UI
   Socket.IO + YouTube IFrame API
   ────────────────────────────────────────────────────────────────────────── */

// ─── URL Params ──────────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const ROOM_ID  = (params.get('room') || '').toUpperCase().trim();
const USERNAME = (params.get('user') || 'Misafir').trim();

if (!ROOM_ID) window.location.href = '/';

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const sidebarEl        = document.getElementById('yt-sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const searchInput      = document.getElementById('search-input');
const searchBtn        = document.getElementById('search-btn');
const chipBar          = document.getElementById('chip-bar');
const gridSpinner      = document.getElementById('grid-spinner');
const gridEmpty        = document.getElementById('grid-empty');
const videoGrid        = document.getElementById('video-grid');
const roomCodeDisplay  = document.getElementById('room-code-display');
const roomCodePill     = document.getElementById('room-code-pill');
const mpRoomCode       = document.getElementById('mp-room-code');
const headerUsers      = document.getElementById('header-users');
const usersTooltip     = document.getElementById('users-tooltip');
const userCountLabel   = document.getElementById('user-count-label');
const leaveBtn         = document.getElementById('leave-btn');
const miniPlayer       = document.getElementById('mini-player');
const mpThumb          = document.getElementById('mp-thumb');
const mpTitle          = document.getElementById('mp-title');
const mpChannel        = document.getElementById('mp-channel');
const mpPlayBtn        = document.getElementById('mp-play-btn');
const mpSkipBtn        = document.getElementById('mp-skip-btn');
const mpProgressBar    = document.getElementById('mp-progress-bar');
const chatDrawer       = document.getElementById('chat-drawer');
const chatToggleBtn    = document.getElementById('chat-toggle-btn');
const chatCloseBtn     = document.getElementById('chat-close-btn');
const chatMsgs         = document.getElementById('chat-msgs');
const chatInput        = document.getElementById('chat-input');
const chatSendBtn      = document.getElementById('chat-send-btn');
const chatBadge        = document.getElementById('chat-badge');
const queueDrawer      = document.getElementById('queue-drawer');
const queueToggleBtn   = document.getElementById('queue-toggle-btn');
const queueCloseBtn    = document.getElementById('queue-close-btn');
const queueItems       = document.getElementById('queue-items');
const queueCountBadge  = document.getElementById('queue-count-badge');
const queueNowPlaying  = document.getElementById('queue-now-playing');
const qnpThumb         = document.getElementById('qnp-thumb');
const qnpTitle         = document.getElementById('qnp-title');
const qnpMeta          = document.getElementById('qnp-meta');
const toastEl          = document.getElementById('toast');

// ─── State ────────────────────────────────────────────────────────────────────
let player         = null;
let playerReady    = false;
let isSyncing      = false;
let currentVideo   = null;
let isPlaying      = false;
let seekPollLast   = 0;
let unreadChat     = 0;
let chatOpen       = false;
let queueOpen      = false;
let sidebarExpanded= false;

// ─── Avatar Colors ─────────────────────────────────────────────────────────
const COLORS = ['#ff0033','#7c3aed','#059669','#d97706','#2563eb','#db2777','#0891b2','#ea580c'];
const colorMap = {};
let colorIdx = 0;
function getColor(name) {
  if (!colorMap[name]) { colorMap[name] = COLORS[colorIdx % COLORS.length]; colorIdx++; }
  return colorMap[name];
}
function initial(name) { return (name||'?').charAt(0).toUpperCase(); }

// ─── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, dur = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

// ─── Room Code ────────────────────────────────────────────────────────────────
roomCodeDisplay.textContent = ROOM_ID;
mpRoomCode.textContent = ROOM_ID;

roomCodePill.addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM_ID).then(() => {
    roomCodePill.classList.add('copied');
    showToast('✅ Oda kodu kopyalandı!');
    setTimeout(() => roomCodePill.classList.remove('copied'), 2000);
  });
});

// ─── Sidebar Toggle ───────────────────────────────────────────────────────────
sidebarToggleBtn.addEventListener('click', () => {
  sidebarExpanded = !sidebarExpanded;
  sidebarEl.classList.toggle('expanded', sidebarExpanded);
});

// Sidebar items
document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    const action = item.dataset.action;
    const actionQueries = { home: '', trending: 'trend', music: 'müzik', gaming: 'oyun gameplay', live: 'canlı yayın' };
    const q = actionQueries[action];
    if (q !== undefined) {
      if (q) triggerSearch(q);
      else showGridEmpty();
    }
  });
});

// ─── Chat Drawer ──────────────────────────────────────────────────────────────
function openChat() {
  chatOpen = true; queueOpen = false;
  chatDrawer.classList.add('open');
  queueDrawer.classList.remove('open');
  chatToggleBtn.classList.add('active');
  chatToggleBtn.setAttribute('aria-expanded', 'true');
  unreadChat = 0;
  chatBadge.textContent = '0';
  chatBadge.classList.remove('visible');
}
function closeChat() {
  chatOpen = false;
  chatDrawer.classList.remove('open');
  chatToggleBtn.classList.remove('active');
  chatToggleBtn.setAttribute('aria-expanded', 'false');
}

chatToggleBtn.addEventListener('click', () => { chatOpen ? closeChat() : openChat(); });
chatCloseBtn.addEventListener('click', closeChat);

// ─── Queue Drawer ──────────────────────────────────────────────────────────────
function openQueue() {
  queueOpen = true; chatOpen = false;
  queueDrawer.classList.add('open');
  chatDrawer.classList.remove('open');
  chatToggleBtn.classList.remove('active');
}
function closeQueue() {
  queueOpen = false;
  queueDrawer.classList.remove('open');
}

queueToggleBtn.addEventListener('click', () => { queueOpen ? closeQueue() : openQueue(); });
queueCloseBtn.addEventListener('click', closeQueue);

// ─── Users UI ─────────────────────────────────────────────────────────────────
function renderUsers(users) {
  userCountLabel.textContent = `${users.length}`;
  headerUsers.innerHTML = '';
  users.slice(0, 4).forEach(u => {
    const el = document.createElement('div');
    el.className = 'u-avatar';
    el.style.background = getColor(u.name);
    el.textContent = initial(u.name);
    el.title = u.name;
    el.setAttribute('role', 'listitem');
    headerUsers.appendChild(el);
  });
  if (users.length > 4) {
    const more = document.createElement('div');
    more.className = 'u-avatar';
    more.style.background = '#444';
    more.textContent = `+${users.length - 4}`;
    headerUsers.appendChild(more);
  }
  usersTooltip.innerHTML = `<h4>Odadaki kullanıcılar</h4>` +
    users.map(u => `
      <div class="tooltip-user">
        <span class="t-dot" style="background:${getColor(u.name)}"></span>
        <span>${escHtml(u.name)}${u.name === USERNAME ? ' <em style="color:var(--text-3)">(sen)</em>' : ''}</span>
      </div>`).join('');
}

headerUsers.addEventListener('click', () => usersTooltip.classList.toggle('visible'));
document.addEventListener('click', (e) => {
  if (!headerUsers.contains(e.target) && !usersTooltip.contains(e.target))
    usersTooltip.classList.remove('visible');
});

// ─── Leave ─────────────────────────────────────────────────────────────────────
leaveBtn.addEventListener('click', () => window.location.href = '/');

// ─── Mini Player ──────────────────────────────────────────────────────────────
function updateMiniPlayer(video, playing) {
  if (!video) {
    miniPlayer.classList.remove('visible');
    return;
  }
  miniPlayer.classList.add('visible');
  mpThumb.src = video.thumbnail || '';
  mpTitle.textContent = video.title || 'Video';
  mpChannel.textContent = video.author || '—';
  mpPlayBtn.textContent = playing ? '⏸' : '▶';
}

function updateProgress() {
  if (!playerReady || !player.getDuration) return;
  const dur = player.getDuration();
  const cur = player.getCurrentTime();
  if (dur > 0) {
    mpProgressBar.style.width = `${(cur / dur) * 100}%`;
  }
}
setInterval(updateProgress, 1000);

mpPlayBtn.addEventListener('click', () => {
  if (!playerReady) return;
  if (isPlaying) player.pauseVideo(); else player.playVideo();
});

mpSkipBtn.addEventListener('click', () => {
  socket.emit('skip');
  showToast('⏭ Sonraki video');
});

// ─── Queue UI ─────────────────────────────────────────────────────────────────
function renderQueue(queue) {
  queueCountBadge.textContent = `(${queue.length})`;
  queueItems.innerHTML = '';

  if (queue.length === 0) {
    queueItems.innerHTML = `
      <div class="queue-empty">
        <div class="qe-icon">📭</div>
        <p>Sıra boş. Video kartlarına tıklayarak ekle!</p>
      </div>`;
    return;
  }

  queue.forEach((v, i) => {
    const li = document.createElement('div');
    li.className = 'q-item';
    li.setAttribute('role', 'listitem');
    li.innerHTML = `
      <span class="q-item-num">${i + 1}</span>
      <img class="q-item-thumb" src="${escHtml(v.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'" />
      <div class="q-item-info">
        <div class="q-item-title">${escHtml(v.title)}</div>
        <div class="q-item-meta">${escHtml(v.duration)} · ${escHtml(v.author)}</div>
      </div>
      <button class="q-item-remove" data-index="${i}" aria-label="Kaldır">✕</button>
    `;
    queueItems.appendChild(li);
  });

  queueItems.querySelectorAll('.q-item-remove').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('remove-from-queue', parseInt(btn.dataset.index)));
  });
}

// ─── Category Chips ──────────────────────────────────────────────────────────
chipBar.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  const q = chip.dataset.query;
  if (q) triggerSearch(q);
  else showGridEmpty();
});

// ─── Search ───────────────────────────────────────────────────────────────────
let searchDebounce = null;

searchBtn.addEventListener('click', () => {
  const q = searchInput.value.trim();
  if (q) triggerSearch(q);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (q) triggerSearch(q);
  }
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length >= 2) {
    searchDebounce = setTimeout(() => triggerSearch(q), 600);
  }
});

async function triggerSearch(query) {
  showGridSpinner();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const videos = await res.json();
    if (!Array.isArray(videos) || videos.length === 0) {
      showGridNoResults(query);
      return;
    }
    renderVideoGrid(videos);
  } catch {
    showGridError();
  }
}

// ─── Grid States ──────────────────────────────────────────────────────────────
function showGridSpinner() {
  gridSpinner.classList.add('visible');
  gridEmpty.style.display = 'none';
  videoGrid.innerHTML = '';
}
function showGridEmpty() {
  gridSpinner.classList.remove('visible');
  gridEmpty.style.display = 'flex';
  videoGrid.innerHTML = '';
}
function showGridNoResults(q) {
  gridSpinner.classList.remove('visible');
  gridEmpty.style.display = 'flex';
  gridEmpty.innerHTML = `
    <div class="ge-icon">🔍</div>
    <h3>"${escHtml(q)}" için sonuç bulunamadı</h3>
    <p>Farklı bir arama dene</p>
  `;
  videoGrid.innerHTML = '';
}
function showGridError() {
  gridSpinner.classList.remove('visible');
  gridEmpty.style.display = 'flex';
  gridEmpty.innerHTML = `
    <div class="ge-icon">⚠️</div>
    <h3>Arama başarısız oldu</h3>
    <p>İnternet bağlantını kontrol et ve tekrar dene</p>
  `;
  videoGrid.innerHTML = '';
}

// ─── Video Grid ───────────────────────────────────────────────────────────────
function renderVideoGrid(videos) {
  gridSpinner.classList.remove('visible');
  gridEmpty.style.display = 'none';
  videoGrid.innerHTML = '';

  videos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'yt-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${v.title} — Ekle`);

    card.innerHTML = `
      <div class="yt-card-thumb">
        <img src="${escHtml(v.thumbnail)}" alt="${escHtml(v.title)}" loading="lazy" onerror="this.style.display='none'" />
        <span class="thumb-duration">${escHtml(v.duration)}</span>
        <div class="add-overlay">
          <div class="add-overlay-btn">
            <span>＋</span> Kuyruğa Ekle
          </div>
        </div>
      </div>
      <div class="yt-card-info">
        <div class="card-channel-icon" style="background:${getColor(v.author)}">
          ${initial(v.author)}
        </div>
        <div class="card-meta">
          <div class="card-title">${escHtml(v.title)}</div>
          <div class="card-channel">${escHtml(v.author)}</div>
          <div class="card-stats">${escHtml(v.duration)}</div>
        </div>
      </div>
    `;

    function addCard() {
      const overlay = card.querySelector('.add-overlay-btn');
      if (overlay.classList.contains('added')) return;
      socket.emit('add-to-queue', v);
      overlay.classList.add('added');
      overlay.innerHTML = '<span>✓</span> Eklendi';
      showToast(`✅ "${v.title.substring(0, 35)}…" eklendi`);
      setTimeout(() => {
        overlay.classList.remove('added');
        overlay.innerHTML = '<span>＋</span> Kuyruğa Ekle';
      }, 3000);
    }

    card.addEventListener('click', addCard);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addCard(); } });
    videoGrid.appendChild(card);
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function addChatMessage(msg) {
  const el = document.createElement('div');
  if (msg.type === 'system') {
    el.className = 'chat-msg system-msg';
    el.textContent = msg.text;
  } else {
    const isMe = msg.name === USERNAME;
    el.className = `chat-msg ${isMe ? 'my-msg' : 'user-msg'}`;
    el.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-msg-name" style="color:${getColor(msg.name)}">${escHtml(msg.name)}</span>
        <span class="chat-msg-time">${formatTime(msg.time)}</span>
      </div>
      <div class="chat-msg-text">${escHtml(msg.text)}</div>
    `;
  }
  chatMsgs.appendChild(el);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;

  if (!chatOpen && msg.type !== 'system') {
    unreadChat++;
    chatBadge.textContent = unreadChat > 9 ? '9+' : unreadChat;
    chatBadge.classList.add('visible');
  }
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('send-message', text);
  chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  socket.emit('join-room', { room: ROOM_ID, user: USERNAME });
});

socket.on('disconnect', () => showToast('🔴 Bağlantı kesildi…', 4000));

socket.on('room-state', ({ video, videoState, queue, users, messages }) => {
  renderUsers(users);
  renderQueue(queue);
  messages.forEach(addChatMessage);
  if (video) loadVideo(video, videoState);
});

socket.on('users-updated', renderUsers);
socket.on('new-message',   addChatMessage);
socket.on('queue-updated', renderQueue);

socket.on('video-changed', (video) => {
  if (!video) { currentVideo = null; updateMiniPlayer(null, false); return; }
  loadVideo(video, { playing: true, time: 0 });
});

socket.on('video-play',  (time) => { if (!playerReady) return; doSync(() => { player.seekTo(time, true); player.playVideo(); }); });
socket.on('video-pause', (time) => { if (!playerReady) return; doSync(() => { player.seekTo(time, true); player.pauseVideo(); }); });
socket.on('video-seek',  (time) => { if (!playerReady) return; doSync(() => player.seekTo(time, true)); });

socket.on('sync', ({ video, time, playing }) => {
  if (!video) return;
  if (!currentVideo || currentVideo.id !== video.id) {
    loadVideo(video, { playing, time });
  } else {
    doSync(() => {
      player.seekTo(time, true);
      if (playing) player.playVideo(); else player.pauseVideo();
    });
  }
});

// ─── Sync ─────────────────────────────────────────────────────────────────────
function doSync(fn) {
  isSyncing = true;
  fn();
  setTimeout(() => { isSyncing = false; }, 600);
}

// ─── YouTube IFrame API ────────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
  // Make the container a bit bigger for actual playback (hidden but functional)
  const container = document.getElementById('yt-player-container');
  container.style.width  = '320px';
  container.style.height = '180px';
  container.style.bottom = '72px';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';

  player = new YT.Player('yt-player', {
    height: '180',
    width: '320',
    playerVars: { rel: 0, modestbranding: 1, iv_load_policy: 3 },
    events: {
      onReady: () => {
        playerReady = true;
        setTimeout(() => socket.emit('request-sync'), 600);
      },
      onStateChange: onPlayerStateChange
    }
  });
};

function onPlayerStateChange(event) {
  if (isSyncing) return;
  const s = event.data;
  if (s === YT.PlayerState.PLAYING) {
    isPlaying = true;
    mpPlayBtn.textContent = '⏸';
    socket.emit('video-play', player.getCurrentTime());
  } else if (s === YT.PlayerState.PAUSED) {
    isPlaying = false;
    mpPlayBtn.textContent = '▶';
    socket.emit('video-pause', player.getCurrentTime());
  } else if (s === YT.PlayerState.ENDED) {
    isPlaying = false;
    mpPlayBtn.textContent = '▶';
    socket.emit('video-ended');
  }
}

// Seek detection
setInterval(() => {
  if (!playerReady || !player.getCurrentTime || isSyncing) return;
  const t = player.getCurrentTime();
  if (seekPollLast > 0 && Math.abs(t - seekPollLast - 1) > 2.5) socket.emit('video-seek', t);
  seekPollLast = t;
}, 1000);

// ─── Load Video ───────────────────────────────────────────────────────────────
function loadVideo(video, state) {
  currentVideo = video;
  updateMiniPlayer(video, state?.playing !== false);

  // Update queue now playing
  queueNowPlaying.style.display = 'block';
  qnpThumb.src = video.thumbnail || '';
  qnpTitle.textContent = video.title || '';
  qnpMeta.textContent = `${video.duration || ''} · ${video.author || ''}`;

  if (!playerReady) {
    const wait = setInterval(() => {
      if (playerReady) {
        clearInterval(wait);
        _loadVideo(video, state);
      }
    }, 200);
    return;
  }
  _loadVideo(video, state);
  seekPollLast = state?.time || 0;
}

function _loadVideo(video, state) {
  doSync(() => {
    player.loadVideoById({ videoId: video.id, startSeconds: state?.time || 0 });
    if (state?.playing === false) setTimeout(() => { player.pauseVideo(); isPlaying = false; mpPlayBtn.textContent = '▶'; }, 800);
    else { isPlaying = true; mpPlayBtn.textContent = '⏸'; }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

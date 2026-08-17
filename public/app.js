/* ──────────────────────────────────────────────────────────────────────────
   WatchParty — Official YouTube App Client
   Real-time YouTube search, feed rendering & synced playback
   ────────────────────────────────────────────────────────────────────────── */

// ─── App State ─────────────────────────────────────────────────────────────
let socket = null;
let roomId = '';
let username = localStorage.getItem('yt_wp_user') || 'Kullanıcı ' + Math.floor(Math.random() * 1000);
let player = null;
let playerReady = false;
let isSyncing = false;
let currentPlayingVideo = null;
let isPlaying = false;
let queueList = [];

// Ekran kilidi / arka plan geçişini gerçek kullanıcı pause'undan ayırt etmek için
let _wasPlayingBeforeHide = false;  // Ekran kilitlenmeden önceki oynatma durumu
let _screenLockPause = false;       // Ekran kilidi kaynaklı pause mi?

// ─── DOM References ────────────────────────────────────────────────────────
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const videoGrid = document.getElementById('video-grid');
const chipsContainer = document.getElementById('chips-container');
const chipsNextBtn = document.getElementById('chips-next');
const roomStatusBtn = document.getElementById('room-status-btn');
const roomCodeDisplay = document.getElementById('room-code-display');
const userAvatarBadge = document.getElementById('user-avatar-badge');
const roomModal = document.getElementById('room-modal');
const usernameInput = document.getElementById('username-input');
const roomInput = document.getElementById('room-input');
const modalJoinBtn = document.getElementById('modal-join-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const toastEl = document.getElementById('toast');

// Drawers & Watch Queue Elements
const watchQueueChip = document.getElementById('watch-queue-chip');
const watchQueueBadge = document.getElementById('watch-queue-badge');

const usersSidebarBtn = document.getElementById('users-sidebar-btn');
const chatSidebarBtn = document.getElementById('chat-sidebar-btn');
const callSidebarBtn = document.getElementById('call-sidebar-btn');
const sidebarCallDot = document.getElementById('sidebar-call-dot');
const usersDrawer = document.getElementById('users-drawer');
const usersCloseBtn = document.getElementById('users-close-btn');
const usersDrawerCount = document.getElementById('users-drawer-count');
const sidebarUserCount = document.getElementById('sidebar-user-count');
const usersItemsContainer = document.getElementById('users-items-container');

const queueDrawer = document.getElementById('queue-drawer');
const chatDrawer = document.getElementById('chat-drawer');
const queueCloseBtn = document.getElementById('queue-close-btn');
const chatCloseBtn = document.getElementById('chat-close-btn');
const queueBadgeCount = document.getElementById('queue-badge-count');
const queueItemsContainer = document.getElementById('queue-items-container');
const chatMsgsContainer = document.getElementById('chat-msgs-container');
const chatForm = document.getElementById('chat-form');
const chatMsgInput = document.getElementById('chat-msg-input');

let connectedUsers = [];

// ─── Helpers ───────────────────────────────────────────────────────────────
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function getAvatarColor(name) {
  const colors = ['#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#009688', '#4caf50', '#ff9800', '#795548'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function generateNewRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ─── Socket & Room Logic ───────────────────────────────────────────────────
function initRoom() {
  const urlParams = new URLSearchParams(window.location.search);
  const paramUser = urlParams.get('user');

  if (paramUser) username = paramUser;
  if (usernameInput) usernameInput.value = username;
  if (userAvatarBadge) {
    userAvatarBadge.textContent = username.charAt(0).toUpperCase();
    userAvatarBadge.style.backgroundColor = getAvatarColor(username);
  }

  try {
    if (typeof io !== 'function') {
      console.warn('[Socket] io() not available');
      return;
    }

    socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      timeout: 15000
    });

    setupSocketEvents();

    // When socket connects, join the room that was already set in startApp
    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket.id);
      // roomId is already set by startApp — just join it
      joinRoom(roomId, username);
    });

    socket.on('connect_error', (err) => {
      console.warn('[Socket] Connection error:', err.message);
    });

  } catch (err) {
    console.warn('[Socket Init Error]', err);
  }
}

function joinRoom(rId, uName) {
  roomId = rId;
  if (roomCodeDisplay) roomCodeDisplay.textContent = roomId;
  localStorage.setItem('yt_wp_user', uName);

  // Proactively ensure local user is in connectedUsers list so drawer never shows empty
  if (!connectedUsers.some(u => u.name === uName)) {
    connectedUsers = [{ id: socket?.id || 'me', name: uName }, ...connectedUsers];
    renderUsersList();
  }

  if (socket && typeof socket.emit === 'function') {
    socket.emit('join-room', { room: roomId, user: uName });
  }
  
  // Update URL without reload
  try {
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('room', roomId);
    newUrl.searchParams.set('user', uName);
    window.history.replaceState({}, '', newUrl);
  } catch (e) {}
}

function setupSocketEvents() {
  socket.on('room-state', (state) => {
    if (state.users) {
      connectedUsers = state.users;
      renderUsersList();
    }
    if (state.queue) {
      queueList = state.queue;
      renderQueue();
    }
    if (state.messages) {
      chatMsgsContainer.innerHTML = '';
      state.messages.forEach(addChatMessage);
    }
    if (state.video) {
      loadVideo(state.video, state.videoState);
    }
  });

  socket.on('users-updated', (users) => {
    connectedUsers = users;
    renderUsersList();
  });

  socket.on('queue-updated', (queue) => {
    queueList = queue;
    renderQueue();
  });

  socket.on('new-message', (msg) => {
    addChatMessage(msg);
  });

  socket.on('video-changed', (video) => {
    if (!video) {
      currentPlayingVideo = null;
      return;
    }
    loadVideo(video, { playing: true, time: 0 });
  });

  socket.on('video-play', (time) => {
    if (!playerReady || !player) return;
    doSync(() => {
      try { player.seekTo(time, true); player.playVideo(); updatePlayIcon(true); } catch (_) {}
    });
  });

  socket.on('video-pause', (time) => {
    if (!playerReady || !player) return;
    doSync(() => {
      try { player.seekTo(time, true); player.pauseVideo(); updatePlayIcon(false); } catch (_) {}
    });
  });

  socket.on('video-seek', (time) => {
    if (!playerReady || !player) return;
    doSync(() => { try { player.seekTo(time, true); } catch (_) {} });
  });

  // ─── Sync Handler — sunucudan gelen anlık durum ───────────────────────────
  socket.on('sync', ({ video, time, playing }) => {
    if (!video) return;
    // Video farklıysa yükle, aynıysa sadece seek et
    if (!currentPlayingVideo || currentPlayingVideo.id !== video.id) {
      loadVideo(video, { time, playing });
    } else if (playerReady && player && typeof player.seekTo === 'function') {
      doSync(() => {
        try {
          player.seekTo(time, true);
          if (playing) {
            player.playVideo();
          } else {
            player.pauseVideo();
          }
        } catch (_) {}
      });
    }
  });

  // ─── Call Socket Handlers ────────────────────────────────────────────────
  socket.on('incoming-call', handleIncomingCall);

  socket.on('call-accepted', async ({ targetSocketId }) => {
    activeCallTargetId = targetSocketId;
    await startCallStream(true);
  });

  socket.on('call-rejected', ({ targetName }) => {
    outgoingCallModal.classList.remove('active');
    endActiveCall();
    showToast(`${targetName} aramayı reddetti`);
  });

  socket.on('call-ended', () => {
    endActiveCall();
    showToast('Arama sonlandırıldı');
  });

  socket.on('user-disconnected-call', ({ socketId }) => {
    if (activeCallTargetId && activeCallTargetId === socketId) {
      endActiveCall();
      showToast('Kullanıcı odadan ayrıldı, görüşme sonlandırıldı');
    }
  });

  socket.on('user-speaking', ({ isSpeaking }) => {
    const remoteSpeakerItem = document.getElementById('remote-speaker-item');
    if (remoteSpeakerItem) {
      remoteSpeakerItem.classList.toggle('speaking', isSpeaking);
    }
  });

  socket.on('webrtc-offer', async ({ fromSocketId, offer }) => {
    if (!peerConnection) {
      setupPeerConnection(false);
    }
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc-answer', { targetSocketId: fromSocketId, answer: peerConnection.localDescription });
    } catch (e) {
      console.error('[WebRTC Offer Error]', e);
    }
  });

  socket.on('webrtc-answer', async ({ answer }) => {
    if (!peerConnection) return;
    try {
      if (peerConnection.signalingState !== 'stable') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch (e) {
      console.error('[WebRTC Answer Error]', e);
    }
  });

  socket.on('webrtc-ice', async ({ candidate }) => {
    if (!peerConnection || !candidate) return;
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[WebRTC ICE Error]', e);
    }
  });
}

function doSync(fn) {
  isSyncing = true;
  fn();
  setTimeout(() => { isSyncing = false; }, 1000);
}

// ─── Infinite Scroll & Feed State ──────────────────────────────────────────
let currentFeedQuery = 'popüler';
let currentFeedPage = 1;
let isFeedLoading = false;
let hasMoreFeed = true;

const videoGridScroll = document.querySelector('.video-grid-scroll');

if (videoGridScroll) {
  videoGridScroll.addEventListener('scroll', () => {
    if (isFeedLoading || !hasMoreFeed) return;
    const { scrollTop, scrollHeight, clientHeight } = videoGridScroll;
    if (scrollTop + clientHeight >= scrollHeight - 350) {
      loadMoreFeedVideos();
    }
  });
}

async function loadMoreFeedVideos() {
  if (isFeedLoading || !hasMoreFeed) return;
  isFeedLoading = true;
  currentFeedPage++;

  // Add subtle loading indicator at bottom
  let loadingIndicator = document.getElementById('feed-loading-indicator');
  if (!loadingIndicator) {
    loadingIndicator = document.createElement('div');
    loadingIndicator.id = 'feed-loading-indicator';
    loadingIndicator.style.cssText = 'grid-column: 1/-1; padding: 24px; text-align: center; color: var(--yt-text-secondary); font-size: 14px; font-weight: 500;';
    loadingIndicator.innerHTML = '<span class="status-dot" style="display:inline-block; margin-right:8px;"></span> Daha fazla video yükleniyor...';
    videoGrid.appendChild(loadingIndicator);
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(currentFeedQuery)}&page=${currentFeedPage}&limit=16`);
    const newVideos = await res.json();
    loadingIndicator.remove();

    if (!Array.isArray(newVideos) || newVideos.length === 0) {
      hasMoreFeed = false;
      return;
    }

    appendVideosToGrid(newVideos);
  } catch (err) {
    if (loadingIndicator) loadingIndicator.remove();
    console.error('[Feed Pagination Error]', err);
  } finally {
    isFeedLoading = false;
  }
}

// ─── DOM References for Watch Layout ──────────────────────────────────────
const feedView = document.getElementById('feed-view');
const watchView = document.getElementById('watch-view');
const watchTitle = document.getElementById('watch-title');
const watchChannelName = document.getElementById('watch-channel-name');
const watchChannelAvatar = document.getElementById('watch-channel-avatar');
const watchStats = document.getElementById('watch-stats');
const relatedVideosList = document.getElementById('related-videos-list');
const watchSidebarChips = document.getElementById('watch-sidebar-chips');
const watchLikeBtn = document.getElementById('watch-like-btn');
const watchShareBtn = document.getElementById('watch-share-btn');
const watchAddQueueBtn = document.getElementById('watch-add-queue-btn');
const watchDownloadBtn = document.getElementById('watch-download-btn');

let relatedVideosCache = [];
let currentWatchSidebarTab = 'related'; // 'related' | 'queue'

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function openWatchView(video) {
  if (!video) return;
  feedView.classList.remove('active');
  watchView.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Kullanıcı tercihlerini Yapay Zeka modeline kaydet
  recordAiWatchInteraction(video);

  watchTitle.textContent = decodeHtmlEntities(video.title) || 'Video';
  watchChannelName.textContent = decodeHtmlEntities(video.author) || 'YouTube';

  const subCountEl = document.querySelector('.watch-sub-count');
  if (subCountEl) {
    subCountEl.textContent = video.subCount || '1,24 Mn abone';
  }

  const avatarUrl = video.channelAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(video.author || 'Y')}&background=random&color=fff&size=128&bold=true&format=svg`;
  watchChannelAvatar.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(video.author)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(video.author || 'Y')}&background=random&color=fff&size=128&bold=true&format=svg';">`;
  watchChannelAvatar.style.backgroundColor = 'transparent';
  
  const views = video.views || '245 B görüntüleme';
  const ago = video.ago || '3 gün önce';
  watchStats.textContent = `${views} • ${ago}`;

  // Reset chips to 'Tümü'
  if (watchSidebarChips) {
    watchSidebarChips.querySelectorAll('.chip-item').forEach((c, idx) => c.classList.toggle('active', idx === 0));
  }
  currentWatchSidebarTab = 'related';

  // Setup Media Session API for lock screen / notification controls
  setupMediaSession(video);
  updateMediaSessionState('playing');

  // Fetch and render recommended videos on the right sidebar (Screenshot match)
  fetchAndRenderRelated(video.title || video.author || 'müzik');
}

function openFeedView() {
  watchView.classList.remove('active');
  feedView.classList.add('active');
}

async function fetchAndRenderRelated(query) {
  if (!relatedVideosList) return;
  relatedVideosList.innerHTML = `
    <div style="padding: 20px; text-align: center; color: var(--yt-text-secondary); font-size: 13px;">
      Önerilen videolar yükleniyor...
    </div>
  `;

  try {
    const q = query.split(' ').slice(0, 3).join(' ') || 'popüler';
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const videos = await res.json();

    if (!Array.isArray(videos) || videos.length === 0) {
      relatedVideosList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--yt-text-secondary);">Video bulunamadı</div>`;
      return;
    }

    relatedVideosCache = videos;
    renderRelatedList(videos);
  } catch (_) {
    relatedVideosList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--yt-text-secondary);">Öneriler yüklenemedi</div>`;
  }
}

function renderRelatedList(videos) {
  relatedVideosList.innerHTML = '';

  videos.forEach((video) => {
    const item = document.createElement('div');
    item.className = 'watch-related-item';
    const views = video.views || (Math.floor(Math.random() * 500 + 10) + ' B görüntüleme');
    const timeAgo = video.ago || '1 hafta önce';

    item.innerHTML = `
      <div class="watch-related-thumb">
        <img src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy">
        <span class="watch-related-duration">${escapeHtml(video.duration)}</span>
      </div>
      <div class="watch-related-meta">
        <div class="watch-related-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
        <div class="watch-related-channel">
          <span>${escapeHtml(video.author)}</span>
          <svg class="verified-icon" viewBox="0 0 24 24" style="width:12px;height:12px;"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM9.8 17.3l-4.2-4.1L7 11.8l2.8 2.7L17 7.4l1.4 1.4-8.6 8.5z"></path></svg>
        </div>
        <div class="watch-related-stats">${views} • ${timeAgo}</div>
      </div>
      <button class="icon-button watch-related-actions-btn" title="Daha fazla">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>
      </button>
    `;

    item.addEventListener('click', () => {
      openWatchView(video);
      showToast('Oynatılıyor: ' + video.title);
      if (socket && socket.connected) socket.emit('play-video-now', video);
    });

    relatedVideosList.appendChild(item);
  });
}

// Render Queue Videos in the Right Sidebar (When Sıra chip is active - Exactly matches Oyun/Tümü layout)
function renderQueueInSidebar() {
  if (!relatedVideosList) return;
  relatedVideosList.innerHTML = '';

  if (queueList.length === 0) {
    relatedVideosList.innerHTML = `
      <div class="watch-queue-empty-box">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="#aaaaaa"><path d="M19 15v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3zM3 5v14h10v-2H5V7h14v4h2V5H3z"></path></svg>
        <div class="watch-queue-empty-title">Oynatma Sırası Boş</div>
        <div class="watch-queue-empty-desc">Videoların altındaki "+ Sıraya Ekle" butonunu kullanarak buraya video ekleyebilirsiniz.</div>
      </div>
    `;
    return;
  }

  queueList.forEach((video, index) => {
    const item = document.createElement('div');
    item.className = 'watch-related-item';
    const views = video.views || (Math.floor(Math.random() * 500 + 10) + ' B görüntüleme');
    const timeAgo = video.ago || '1 hafta önce';

    item.innerHTML = `
      <div class="watch-related-thumb">
        <img src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy">
        <span class="watch-related-duration">${escapeHtml(video.duration)}</span>
      </div>
      <div class="watch-related-meta">
        <div class="watch-related-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
        <div class="watch-related-channel">
          <span>${escapeHtml(video.author)}</span>
          <svg class="verified-icon" viewBox="0 0 24 24" style="width:12px;height:12px;"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM9.8 17.3l-4.2-4.1L7 11.8l2.8 2.7L17 7.4l1.4 1.4-8.6 8.5z"></path></svg>
        </div>
        <div class="watch-related-stats">${views} • ${timeAgo}</div>
      </div>
      <button class="watch-queue-remove-btn" title="Sıradan Kaldır">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>
      </button>
    `;

    // Click on item to play immediately
    item.addEventListener('click', (e) => {
      if (e.target.closest('.watch-queue-remove-btn')) return;
      if (socket && socket.connected) socket.emit('skip');
    });

    // Remove from queue
    const removeBtn = item.querySelector('.watch-queue-remove-btn');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (socket && socket.connected) socket.emit('remove-from-queue', index);
      showToast('Sıradan kaldırıldı');
    });

    relatedVideosList.appendChild(item);
  });
}

// Watch Sidebar Chips click (Tümü, İlgili, Müzik, Oyun, Sıra)
if (watchSidebarChips) {
  watchSidebarChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-item');
    if (!chip) return;

    watchSidebarChips.querySelectorAll('.chip-item').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    const q = chip.getAttribute('data-q') || 'tümü';
    if (q === 'queue') {
      currentWatchSidebarTab = 'queue';
      renderQueueInSidebar();
    } else {
      currentWatchSidebarTab = 'related';
      fetchAndRenderRelated(q === 'tümü' ? (currentPlayingVideo?.title || 'müzik') : q);
    }
  });
}

// Watch Action Buttons
if (watchLikeBtn) {
  watchLikeBtn.addEventListener('click', () => {
    watchLikeBtn.classList.toggle('active');
    const countEl = document.getElementById('watch-like-count');
    if (countEl) countEl.textContent = watchLikeBtn.classList.contains('active') ? '13 B' : '12 B';
    showToast(watchLikeBtn.classList.contains('active') ? 'Beğenildi' : 'Beğeni kaldırıldı');
  });
}
if (watchShareBtn) {
  watchShareBtn.addEventListener('click', () => {
    navigator.clipboard?.writeText(window.location.href);
    showToast('Oda ve video bağlantısı kopyalandı! 📋');
  });
}
if (watchAddQueueBtn) {
  watchAddQueueBtn.addEventListener('click', () => {
    if (currentPlayingVideo) {
      if (socket && socket.connected) socket.emit('add-to-queue', currentPlayingVideo);
      showToast('Sıraya eklendi');
    }
  });
}

const CLIENT_FALLBACK_VIDEOS = [
  {
    id: "dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    duration: "3:33",
    author: "Rick Astley",
    channelAvatar: "",
    subCount: "4,2 Mn abone",
    ago: "14 yıl önce",
    views: "1,5 Mr görüntüleme"
  },
  {
    id: "kJQP7kiw5Fk",
    title: "Luis Fonsi - Despacito ft. Daddy Yankee",
    thumbnail: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    duration: "4:42",
    author: "Luis Fonsi",
    channelAvatar: "",
    subCount: "31 Mn abone",
    ago: "7 yıl önce",
    views: "8,4 Mr görüntüleme"
  },
  {
    id: "9bZkp7q19f0",
    title: "PSY - GANGNAM STYLE (강남스타일) M/V",
    thumbnail: "https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg",
    duration: "4:13",
    author: "officialpsy",
    channelAvatar: "",
    subCount: "19 Mn abone",
    ago: "12 yıl önce",
    views: "5,1 Mr görüntüleme"
  },
  {
    id: "fJ9rUzIMcZQ",
    title: "Queen – Bohemian Rhapsody (Official Video Remastered)",
    thumbnail: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg",
    duration: "5:59",
    author: "Queen Official",
    channelAvatar: "",
    subCount: "17 Mn abone",
    ago: "15 yıl önce",
    views: "1,7 Mr görüntüleme"
  },
  {
    id: "JGwWNGJdvx8",
    title: "Ed Sheeran - Shape of You (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg",
    duration: "4:24",
    author: "Ed Sheeran",
    channelAvatar: "",
    subCount: "54 Mn abone",
    ago: "7 yıl önce",
    views: "6,2 Mr görüntüleme"
  },
  {
    id: "OPf0YbXqDm0",
    title: "Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars",
    thumbnail: "https://i.ytimg.com/vi/OPf0YbXqDm0/hqdefault.jpg",
    duration: "4:31",
    author: "Mark Ronson",
    channelAvatar: "",
    subCount: "11 Mn abone",
    ago: "9 yıl önce",
    views: "5,2 Mr görüntüleme"
  }
];

// ─── AI Personalized Recommendation Engine ────────────────────────────────
let aiFeedSeed = 0;

function recordAiWatchInteraction(video) {
  if (!video) return;
  try {
    let history = JSON.parse(localStorage.getItem('yt_wp_ai_interests') || '[]');
    if (!Array.isArray(history)) history = [];
    
    // Video başlığındaki gereksiz kelimeleri filtrele
    const cleanTitle = (video.title || '')
      .replace(/[\(\)\[\]\{\}\-_|:;.,!?\/\\~"']/g, ' ')
      .replace(/\b(official|video|music|klip|remastered|audio|lyric|lyrics|hd|4k|feat|ft|full|clip)\b/gi, '')
      .trim();
    
    const words = cleanTitle.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
    if (video.author && video.author.length > 1) {
      words.unshift(video.author.trim());
    }

    words.forEach(k => {
      if (k && !history.includes(k)) {
        history.unshift(k);
      }
    });

    history = history.slice(0, 20);
    localStorage.setItem('yt_wp_ai_interests', JSON.stringify(history));
  } catch (_) {}
}

// ─── Search & Feed Rendering with AI Engine ────────────────────────────────
async function fetchAndRenderFeed(query, showSpinner = true) {
  currentFeedQuery = query || 'Tümü';
  currentFeedPage = 1;
  hasMoreFeed = true;
  if (videoGridScroll) videoGridScroll.scrollTop = 0;

  if (showSpinner && videoGrid) {
    videoGrid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 48px 0; text-align: center; color: var(--yt-text-secondary); font-size: 14px;">
        <div style="display:inline-block; width:30px; height:30px; border:3px solid rgba(255,255,255,0.15); border-top-color:#ff0000; border-radius:50%; animation:ptr-spin 0.75s linear infinite; margin-bottom:12px;"></div>
        <div style="font-weight:500; color:#fff;">Videolar yükleniyor...</div>
      </div>
    `;
  }

  try {
    let url = '';
    const isMainFeed = !query || query === 'Tümü' || query === 'trend popüler türkiye';
    // Cache-busting timestamp so each call gets fresh data
    const ts = Date.now();
    
    if (isMainFeed) {
      let userInterests = [];
      try {
        userInterests = JSON.parse(localStorage.getItem('yt_wp_ai_interests') || '[]');
      } catch (_) {}
      aiFeedSeed++;
      url = `/api/ai-feed?context=${encodeURIComponent(userInterests.join(','))}&seed=${aiFeedSeed}&_t=${ts}`;
    } else {
      url = `/api/search?q=${encodeURIComponent(query)}&page=1&limit=20&_t=${ts}`;
    }

    const res = await fetch(url);
    const videos = await res.json();

    if (!Array.isArray(videos) || videos.length === 0) {
      if (!showSpinner) return;
      // Show proper empty state for search, not fallback videos
      if (!isMainFeed) {
        if (videoGrid) videoGrid.innerHTML = `
          <div style="grid-column: 1/-1; padding: 64px 24px; text-align: center; color: var(--yt-text-secondary);">
            <svg viewBox="0 0 24 24" width="52" height="52" fill="#555" style="margin: 0 auto 16px; display: block;">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
            <div style="font-size:17px; font-weight:600; color:#fff; margin-bottom:8px;">"${escapeHtml(query)}" için sonuç bulunamadı</div>
            <div style="font-size:13px; color:#888; margin-bottom:20px;">Farklı anahtar kelimeler deneyin veya yazım hatası olup olmadığını kontrol edin.</div>
            <button onclick="fetchAndRenderFeed('Tümü')" style="background:#ff0000; color:#fff; border:none; border-radius:20px; padding:10px 24px; font-size:14px; font-weight:600; cursor:pointer;">Ana Sayfaya Dön</button>
          </div>
        `;
      } else {
        renderVideoGrid(CLIENT_FALLBACK_VIDEOS);
      }
      return;
    }

    if (videos[0]?.thumbnail && query && !isMainFeed) {
      updateSearchHistoryThumbnail(query, videos[0].thumbnail);
    }

    renderVideoGrid(videos);
  } catch (err) {
    console.warn('[Feed Fetch Error - Using Fallback]', err);
    if (showSpinner) renderVideoGrid(CLIENT_FALLBACK_VIDEOS);
  }
}

function renderVideoGrid(videos) {
  videoGrid.innerHTML = '';
  appendVideosToGrid(videos);
}

function appendVideosToGrid(videos) {
  videos.forEach((video, index) => {
    const card = createVideoCardElement(video, index);
    videoGrid.appendChild(card);
  });
}

function createVideoCardElement(video, index) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.setAttribute('data-testid', `video-card-${index}`);
  if (index === 0) {
    card.id = 'first-video-card';
  }
  
  const views = video.views || (Math.floor(Math.random() * 850 + 20) + ' B görüntüleme');
  const timeAgo = video.ago || ['3 gün önce', '1 hafta önce', '2 hafta önce', '1 ay önce', '3 ay önce', '1 yıl önce'][(index || 0) % 6];
  
  // Kesin olarak her videoda profil fotoğrafı göster
  const avatarUrl = video.channelAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(video.author || 'Y')}&background=random&color=fff&size=128&bold=true&format=svg`;

  card.innerHTML = `
    <div class="thumbnail-wrapper" ${index === 0 ? 'id="first-video-thumb"' : ''}>
      <img class="thumbnail-img" src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy">
      <span class="video-duration">${escapeHtml(video.duration)}</span>
    </div>
    <div class="card-details">
      <div class="channel-avatar">
        <img class="channel-avatar-img" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(video.author)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.onerror=null; this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(video.author || 'Y')}&background=random&color=fff&size=128&bold=true&format=svg';" loading="lazy">
      </div>
      <div class="meta-container">
        <h3 class="video-title" ${index === 0 ? 'id="first-video-title"' : ''} title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
        <div class="channel-name-wrapper">
          <span>${escapeHtml(video.author)}</span>
          <svg class="verified-icon" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM9.8 17.3l-4.2-4.1L7 11.8l2.8 2.7L17 7.4l1.4 1.4-8.6 8.5z"></path></svg>
        </div>
        <div class="video-stats">${views} • ${timeAgo}</div>
        
        <div class="card-button-row">
          <button class="card-action-pill primary play-now-btn" ${index === 0 ? 'id="first-play-btn"' : ''}>İzle</button>
          <button class="card-action-pill add-queue-btn">+ Sıraya Ekle</button>
        </div>
      </div>
      <button class="icon-button card-actions-btn" title="Daha fazla">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>
      </button>
    </div>
  `;

  // Instant play on click
  const playNowBtn = card.querySelector('.play-now-btn');
  const addQueueBtn = card.querySelector('.add-queue-btn');
  const thumbWrap = card.querySelector('.thumbnail-wrapper');
  const titleEl = card.querySelector('.video-title');

  function triggerPlay() {
    // Open the video locally regardless of socket state
    openWatchView(video);
    showToast('Oynatılıyor: ' + video.title);
    // Sync with room if socket is connected
    if (socket && socket.connected) {
      socket.emit('play-video-now', video);
    }
  }

  function triggerAddToQueue(e) {
    e.stopPropagation();
    showToast('Sıraya eklendi');
    if (socket && socket.connected) {
      socket.emit('add-to-queue', video);
    }
  }

  playNowBtn.addEventListener('click', (e) => { e.stopPropagation(); triggerPlay(); });
  thumbWrap.addEventListener('click', triggerPlay);
  titleEl.addEventListener('click', triggerPlay);
  addQueueBtn.addEventListener('click', triggerAddToQueue);

  return card;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Chips Filter Event ────────────────────────────────────────────────────
if (chipsContainer) {
  chipsContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-item');
    if (!chip) return;

    document.querySelectorAll('.chip-item').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    const query = chip.getAttribute('data-q') || 'trend popüler türkiye';
    openFeedView();
    fetchAndRenderFeed(query);
  });
}

if (chipsNextBtn && chipsContainer) {
  chipsNextBtn.addEventListener('click', () => {
    chipsContainer.scrollBy({ left: 200, behavior: 'smooth' });
  });
}

// ─── Search Bar Events ─────────────────────────────────────────────────────
if (searchForm) {
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = (searchInput?.value || '').trim();
    if (q) {
      addSearchToHistory(q);
      openFeedView();
      fetchAndRenderFeed(q);
    }
  });
}

if (searchInput) {
  searchInput.addEventListener('input', () => {
    if (clearSearchBtn) clearSearchBtn.classList.toggle('visible', !!searchInput.value);
  });
}

if (clearSearchBtn) {
  clearSearchBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    clearSearchBtn.classList.remove('visible');
    if (searchInput) searchInput.focus();
  });
}

// ─── YouTube IFrame API Setup ──────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function() {
  player = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: { 
      autoplay: 1,
      rel: 0, 
      modestbranding: 1, 
      iv_load_policy: 3,
      controls: 1,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin
    },
    events: {
      onReady: (event) => {
        playerReady = true;
        if (socket && socket.connected) socket.emit('request-sync');
      },
      onStateChange: (event) => {
        if (isSyncing) return;
        const s = event.data;
        if (s === YT.PlayerState.PLAYING) {
          isPlaying = true;
          _screenLockPause = false; // Gerçekten oynatılıyor
          updatePlayIcon(true);
          updateMediaSessionState('playing');
          updateMediaSessionPosition();
          startBackgroundAudioSession();
          requestWakeLock().catch(() => {});
          if (socket && socket.connected) socket.emit('video-play', player.getCurrentTime());
        } else if (s === YT.PlayerState.PAUSED) {
          // Eğer ekran kilidi kaynaklıysa: isPlaying'i değiştirme, sokete gönderme
          if (_screenLockPause) {
            // Kilit ekranı pause — sadece UI güncelle, durum değişmesin
            updatePlayIcon(false);
            updateMediaSessionState('paused');
            // isPlaying TRUE kalsın — kilit açılınca devam ettireceğiz
            return;
          }
          isPlaying = false;
          updatePlayIcon(false);
          updateMediaSessionState('paused');
          updateMediaSessionPosition();
          releaseWakeLock();
          if (socket && socket.connected) socket.emit('video-pause', player.getCurrentTime());
        } else if (s === YT.PlayerState.ENDED) {
          isPlaying = false;
          _screenLockPause = false;
          updatePlayIcon(false);
          updateMediaSessionState('none');
          releaseWakeLock();
          stopBackgroundAudioSession();
          if (socket && socket.connected) socket.emit('video-ended');
        }
      }
    }
  });
};

function loadVideo(video, state) {
  if (!video || !video.id) return;
  currentPlayingVideo = video;
  openWatchView(video);

  if (!playerReady || !player || typeof player.loadVideoById !== 'function') {
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      if (playerReady && player && typeof player.loadVideoById === 'function') {
        clearInterval(check);
        _execLoad(video, state);
      } else if (attempts > 20) { // Reduced from 50 to 20 (2 seconds max wait)
        clearInterval(check);
        // Fallback to direct nocookie iframe immediately
        _loadVideoViaIframe(video.id);
      }
    }, 100);
    return;
  }
  _execLoad(video, state);
}

function _execLoad(video, state) {
  if (!player || typeof player.loadVideoById !== 'function') {
    _loadVideoViaIframe(video.id);
    return;
  }
  doSync(() => {
    try {
      player.loadVideoById({
        videoId: video.id,
        startSeconds: state?.time || 0
      });
      if (state?.playing !== false) {
        isPlaying = true;
        setTimeout(() => {
          try { player.playVideo(); } catch(_) {}
        }, 300);
      } else {
        setTimeout(() => {
          try { player.pauseVideo(); isPlaying = false; } catch(_) {}
        }, 300);
      }
    } catch (err) {
      console.warn('[Video Load Error - Trying iframe fallback]', err);
      _loadVideoViaIframe(video.id);
    }
  });
}

// Direct iframe fallback when YouTube API fails or CORS blocks
function _loadVideoViaIframe(videoId) {
  const wrapper = document.getElementById('watch-player-wrapper');
  if (!wrapper) return;
  const origin = encodeURIComponent(window.location.origin);
  wrapper.innerHTML = `
    <iframe
      id="yt-player-fallback"
      src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1&controls=1&origin=${origin}"
      width="100%"
      height="100%"
      frameborder="0"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen
      style="border:0; width:100%; height:100%; min-height:400px;"
    ></iframe>
  `;
  playerReady = false; // player API no longer valid
  player = null;
}

function updatePlayIcon(playing) {
  // Watch page uses YouTube iframe native controls
  updateMediaSessionState(playing ? 'playing' : 'paused');
}

// ─── Professional Media Session & Real Background Lock-Screen Audio Engine ─
let _bgAudioEl = null;
let _mediaSessionPositionInterval = null;
let _wakeLock = null;
let _currentAudioStreamVideoId = null;

// Clean 2-Second Silent Stereo WAV PCM Data URI (Universally supported fallback carrier)
function _getSilentWavDataUri() {
  const sampleRate = 8000;
  const numSamples = sampleRate * 2;
  const dataSize = numSamples;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  ws(36, 'data'); v.setUint32(40, dataSize, true);
  for (let i = 44; i < 44 + dataSize; i++) v.setUint8(i, 128);
  
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

function initBackgroundAudioEngine() {
  if (_bgAudioEl) return _bgAudioEl;
  
  _bgAudioEl = document.getElementById('wp-bg-audio-engine');
  if (!_bgAudioEl) {
    _bgAudioEl = document.createElement('audio');
    _bgAudioEl.id = 'wp-bg-audio-engine';
    _bgAudioEl.setAttribute('playsinline', '');
    _bgAudioEl.setAttribute('webkit-playsinline', '');
    _bgAudioEl.setAttribute('preload', 'auto');
    _bgAudioEl.style.cssText = 'position:fixed; bottom:0; left:0; width:1px; height:1px; opacity:0.001; pointer-events:none; z-index:-1;';
    document.body.appendChild(_bgAudioEl);

    // Audio stream bittiğinde otomatik sonraki videoya geç
    _bgAudioEl.addEventListener('ended', () => {
      if (document.visibilityState === 'hidden' && socket && socket.connected) {
        socket.emit('video-ended');
      }
    });
  }
  return _bgAudioEl;
}

function prepareAudioStream(videoId) {
  if (!videoId) return;
  const el = initBackgroundAudioEngine();
  if (_currentAudioStreamVideoId !== videoId) {
    _currentAudioStreamVideoId = videoId;
    el.src = `/api/stream-audio/${videoId}`;
    el.preload = 'auto';
    el.pause(); // Ekran açıkken ASLA arka plan sesi çalmaz
  }
}

function startBackgroundAudioSession() {
  // Yalnızca ekran kilitliyken/gizliyken arka plan sesini çal
  if (document.visibilityState === 'hidden') {
    const el = initBackgroundAudioEngine();
    if (el && el.paused) {
      el.play().catch(() => {});
    }
  } else {
    // Ekran açıkken arka plan sesini durdur (çift ses olmasını kesin olarak engeller)
    stopBackgroundAudioSession();
  }
}

function stopBackgroundAudioSession() {
  if (_bgAudioEl && !_bgAudioEl.paused) {
    _bgAudioEl.pause();
  }
}

function setupMediaSession(video) {
  if (!('mediaSession' in navigator) || !video) return;

  const title = decodeHtmlEntities(video.title) || 'WatchParty';
  const artist = decodeHtmlEntities(video.author) || 'YouTube';
  const thumbUrl = video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;

  // Ekran açıkken arka plan sesini durdur (çift ses engelleme)
  stopBackgroundAudioSession();
  prepareAudioStream(video.id);

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: artist,
      album: 'WatchParty Müzik & Video',
      artwork: [
        { src: thumbUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: thumbUrl, sizes: '256x256', type: 'image/jpeg' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }
      ]
    });
  } catch (e) {
    console.warn('[MediaSession Metadata Error]', e);
  }

  // Register Handlers
  try {
    navigator.mediaSession.setActionHandler('play', () => {
      if (document.visibilityState === 'hidden' && _bgAudioEl) {
        _bgAudioEl.play().catch(() => {});
      } else if (player && typeof player.playVideo === 'function') {
        try { player.playVideo(); } catch(_) {}
      }
      if (socket && socket.connected) {
        const currentTime = _bgAudioEl && !_bgAudioEl.paused ? _bgAudioEl.currentTime : (player?.getCurrentTime ? player.getCurrentTime() : 0);
        socket.emit('video-play', currentTime);
      }
      updateMediaSessionState('playing');
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      if (_bgAudioEl && !_bgAudioEl.paused) {
        _bgAudioEl.pause();
      }
      if (player && typeof player.pauseVideo === 'function') {
        try { player.pauseVideo(); } catch(_) {}
      }
      if (socket && socket.connected) {
        const currentTime = _bgAudioEl ? _bgAudioEl.currentTime : (player?.getCurrentTime ? player.getCurrentTime() : 0);
        socket.emit('video-pause', currentTime);
      }
      updateMediaSessionState('paused');
    });

    navigator.mediaSession.setActionHandler('stop', () => {
      if (_bgAudioEl) _bgAudioEl.pause();
      if (player && typeof player.stopVideo === 'function') {
        try { player.stopVideo(); } catch(_) {}
      }
      updateMediaSessionState('none');
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (socket && socket.connected) {
        socket.emit('skip');
      }
      showToast('Sonraki videoya geçildi ⏭️');
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      const currentTime = _bgAudioEl && !_bgAudioEl.paused ? _bgAudioEl.currentTime : (player?.getCurrentTime ? player.getCurrentTime() : 0);
      if (currentTime > 5) {
        if (_bgAudioEl) _bgAudioEl.currentTime = 0;
        if (player && typeof player.seekTo === 'function') player.seekTo(0, true);
        if (socket && socket.connected) socket.emit('video-seek', 0);
        showToast('Başa alındı ⏮️');
      } else {
        if (socket && socket.connected) socket.emit('previous-track');
        showToast('Önceki video ⏮️');
      }
      updateMediaSessionPosition();
    });

    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      try {
        const skipTime = details.seekOffset || 10;
        const cur = _bgAudioEl && !_bgAudioEl.paused ? _bgAudioEl.currentTime : (player?.getCurrentTime ? player.getCurrentTime() : 0);
        const newTime = Math.max(0, cur - skipTime);
        if (_bgAudioEl) _bgAudioEl.currentTime = newTime;
        if (player && typeof player.seekTo === 'function') player.seekTo(newTime, true);
        if (socket && socket.connected) socket.emit('video-seek', newTime);
        updateMediaSessionPosition();
      } catch(_) {}
    });

    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      try {
        const skipTime = details.seekOffset || 10;
        const dur = player?.getDuration ? (player.getDuration() || 9999) : 9999;
        const cur = _bgAudioEl && !_bgAudioEl.paused ? _bgAudioEl.currentTime : (player?.getCurrentTime ? player.getCurrentTime() : 0);
        const newTime = Math.min(dur, cur + skipTime);
        if (_bgAudioEl) _bgAudioEl.currentTime = newTime;
        if (player && typeof player.seekTo === 'function') player.seekTo(newTime, true);
        if (socket && socket.connected) socket.emit('video-seek', newTime);
        updateMediaSessionPosition();
      } catch(_) {}
    });

    navigator.mediaSession.setActionHandler('seekto', (details) => {
      try {
        if (_bgAudioEl) _bgAudioEl.currentTime = details.seekTime;
        if (player && typeof player.seekTo === 'function') player.seekTo(details.seekTime, true);
        if (socket && socket.connected) socket.emit('video-seek', details.seekTime);
        updateMediaSessionPosition();
      } catch(_) {}
    });
  } catch(e) {}

  updateMediaSessionState('playing');
  startMediaSessionPositionTracking();
  requestWakeLock().catch(() => {});
}

function updateMediaSessionState(state) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = state; // 'playing' | 'paused' | 'none'
  } catch(_) {}
}

function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator)) return;
  try {
    let position = 0;
    let duration = 0;
    if (_bgAudioEl && !_bgAudioEl.paused && _bgAudioEl.currentTime > 0) {
      position = _bgAudioEl.currentTime;
      duration = _bgAudioEl.duration || (player?.getDuration ? player.getDuration() : 0);
    } else if (player && typeof player.getCurrentTime === 'function') {
      position = player.getCurrentTime();
      duration = player.getDuration();
    }
    const playbackRate = player?.getPlaybackRate ? (player.getPlaybackRate() || 1.0) : 1.0;
    if (duration && duration > 0) {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate,
        position: Math.min(position, duration)
      });
    }
  } catch(_) {}
}

function startMediaSessionPositionTracking() {
  if (_mediaSessionPositionInterval) clearInterval(_mediaSessionPositionInterval);
  _mediaSessionPositionInterval = setInterval(() => {
    if (isPlaying) {
      updateMediaSessionPosition();
    }
  }, 1000);
}

// ─── Wake Lock API (Screen Dim Prevention) ──────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
}

async function releaseWakeLock() {
  if (_wakeLock) {
    try { await _wakeLock.release(); } catch (_) {}
    _wakeLock = null;
  }
}

// ─── Visibility Change Handler (Seamless Iframe <-> Audio Handoff) ──────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Telefon kilitlendi / ekran kapandı:
    _wasPlayingBeforeHide = isPlaying;
    if (isPlaying && currentPlayingVideo) {
      _screenLockPause = true;

      // YouTube iframe kilitlenince ses kesilir; gerçek ses akışını devreye sok:
      const el = initBackgroundAudioEngine();
      if (_currentAudioStreamVideoId !== currentPlayingVideo.id) {
        prepareAudioStream(currentPlayingVideo.id);
      }
      
      let seekT = 0;
      if (player && typeof player.getCurrentTime === 'function') {
        try { seekT = player.getCurrentTime() || 0; } catch(_) {}
      }
      
      try {
        el.currentTime = seekT;
        el.volume = 1.0; // Gerçek müzik sesi
        el.play().catch(() => {});
      } catch(_) {}

      console.log('[WatchParty] Kilit ekranı modu: Kesintisiz arka plan ses akışı devrede 🎵');
    }
  } else {
    // Telefon kilidi açıldı / ekrana dönüldü:
    _screenLockPause = false;
    if (_wasPlayingBeforeHide && player && playerReady) {
      isPlaying = true;
      updateMediaSessionState('playing');
      
      // Arka plan sesinden süreyi al ve YouTube iframe'e aktar:
      const el = _bgAudioEl;
      let resumeTime = null;
      if (el && !el.paused && el.currentTime > 0) {
        resumeTime = el.currentTime;
        el.pause(); // İki kat ses çıkmaması için durdur
      }

      setTimeout(() => {
        try {
          if (player && typeof player.playVideo === 'function') {
            if (resumeTime !== null) {
              player.seekTo(resumeTime, true);
              if (socket && socket.connected) socket.emit('video-seek', resumeTime);
            }
            player.playVideo();
            updateMediaSessionPosition();
          }
        } catch (_) {}
      }, 250);
    }
    _wasPlayingBeforeHide = false;
    if (isPlaying) requestWakeLock().catch(() => {});
  }
});

// ─── Header & Navigation Event Listeners ─────────────────────────────────
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const logoBtn = document.getElementById('logo-btn');
const createActionBtn = document.getElementById('create-action-btn');
const sidebar = document.getElementById('sidebar');

if (sidebarToggleBtn && sidebar) {
  sidebarToggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
}

// ─── Double-Tap / Click to Refresh on Logo and Home Nav Button ─────────────
let lastHomeTapTime = 0;

function handleHomeClickOrDoubleTap() {
  const now = Date.now();
  if (now - lastHomeTapTime < 450) {
    // Çift basıldı: Yapay zekâ akışını ve sayfayı sıfırdan yenile
    lastHomeTapTime = 0;
    openFeedView();
    if (searchInput) searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.classList.remove('visible');
    triggerPullRefresh();
    showToast('Öneriler yenileniyor... 🤖✨');
    return;
  }
  
  lastHomeTapTime = now;
  openFeedView();
  if (searchInput) searchInput.value = '';
  if (clearSearchBtn) clearSearchBtn.classList.remove('visible');
  fetchAndRenderFeed('Tümü');
  document.querySelectorAll('.chip-item').forEach((c, idx) => c.classList.toggle('active', idx === 0));
}

if (logoBtn) {
  logoBtn.addEventListener('click', handleHomeClickOrDoubleTap);
}

const homeNavBtn = document.querySelector('.sidebar-nav-item[data-category="Tümü"]');
if (homeNavBtn) {
  homeNavBtn.addEventListener('click', handleHomeClickOrDoubleTap);
}

if (createActionBtn) {
  createActionBtn.addEventListener('click', () => {
    roomModal.classList.add('active');
  });
}

// ─── Queue, Chat & Users Drawers ─────────────────────────────────────────
if (usersSidebarBtn) {
  usersSidebarBtn.addEventListener('click', () => {
    usersDrawer.classList.toggle('open');
    queueDrawer.classList.remove('open');
    chatDrawer.classList.remove('open');
  });
}
if (usersCloseBtn) {
  usersCloseBtn.addEventListener('click', () => usersDrawer.classList.remove('open'));
}

if (chatSidebarBtn) {
  chatSidebarBtn.addEventListener('click', () => {
    const isOpen = chatDrawer.classList.toggle('open');
    usersDrawer.classList.remove('open');
    queueDrawer.classList.remove('open');
    if (isOpen) {
      setTimeout(() => chatMsgInput.focus(), 150);
    }
  });
}
if (chatCloseBtn) {
  chatCloseBtn.addEventListener('click', () => {
    chatDrawer.classList.remove('open');
  });
}

if (callSidebarBtn) {
  callSidebarBtn.addEventListener('click', () => {
    if (activeCallTargetId || localStream) {
      const isOverlayActive = activeCallOverlay.classList.toggle('active');
      showToast(isOverlayActive ? 'Görüşme ekranı açıldı' : 'Görüşme ekranı gizlendi');
    } else {
      usersDrawer.classList.add('open');
      queueDrawer.classList.remove('open');
      chatDrawer.classList.remove('open');
      showToast('Henüz aktif bir görüşme yok. Bir kullanıcıyı arayabilirsiniz.');
    }
  });
}

if (queueCloseBtn) {
  queueCloseBtn.addEventListener('click', () => queueDrawer.classList.remove('open'));
}

// ─── Call & WebRTC State ──────────────────────────────────────────────────
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let activeCallTargetId = null;
let activeCallType = 'video'; // 'audio' | 'video'
let isAudioMuted = false;
let isVideoMuted = false;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Call DOM Elements
const incomingCallModal = document.getElementById('incoming-call-modal');
const incomingCallerAvatar = document.getElementById('incoming-caller-avatar');
const incomingCallerName = document.getElementById('incoming-caller-name');
const incomingCallTypeTxt = document.getElementById('incoming-call-type-txt');
const incomingAcceptBtn = document.getElementById('incoming-accept-btn');
const incomingDeclineBtn = document.getElementById('incoming-decline-btn');

const outgoingCallModal = document.getElementById('outgoing-call-modal');
const outgoingTargetAvatar = document.getElementById('outgoing-target-avatar');
const outgoingTargetName = document.getElementById('outgoing-target-name');
const outgoingCallTypeTxt = document.getElementById('outgoing-call-type-txt');
const outgoingCancelBtn = document.getElementById('outgoing-cancel-btn');

const activeCallOverlay = document.getElementById('active-call-overlay');
const callWindowHeader = document.getElementById('call-window-header');
const callTimerBadge = document.getElementById('call-timer-badge');
const callMinimizeBtn = document.getElementById('call-minimize-btn');
const callHideBtn = document.getElementById('call-hide-btn');
const minMaxIcon = document.getElementById('min-max-icon');

const remoteAudioAvatar = document.getElementById('remote-audio-avatar');
const remoteAudioWrapper = document.getElementById('remote-audio-wrapper');
const remoteUserLabel = document.getElementById('remote-user-label');
const toggleMicBtn = document.getElementById('toggle-mic-btn');
const hangupCallBtn = document.getElementById('hangup-call-btn');

let currentIncomingCallerId = null;
let callTimerInterval = null;
let callDurationSeconds = 0;

// ─── Draggable Floating Call Window Logic ─────────────────────────────────
let isDraggingCallWindow = false;
let dragStartX, dragStartY, initialLeft, initialTop;

if (callWindowHeader) {
  callWindowHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.call-win-btn')) return; // Ignore buttons
    isDraggingCallWindow = true;

    const rect = activeCallOverlay.getBoundingClientRect();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    initialLeft = rect.left;
    initialTop = rect.top;

    // Set explicit left/top so bottom/right don't interfere
    activeCallOverlay.style.left = `${initialLeft}px`;
    activeCallOverlay.style.top = `${initialTop}px`;
    activeCallOverlay.style.right = 'auto';
    activeCallOverlay.style.bottom = 'auto';

    callWindowHeader.setPointerCapture(e.pointerId);
  });

  callWindowHeader.addEventListener('pointermove', (e) => {
    if (!isDraggingCallWindow) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const overlayW = activeCallOverlay.offsetWidth;
    const overlayH = activeCallOverlay.offsetHeight;

    const newLeft = Math.max(10, Math.min(winW - overlayW - 10, initialLeft + dx));
    const newTop = Math.max(65, Math.min(winH - overlayH - 10, initialTop + dy));

    activeCallOverlay.style.left = `${newLeft}px`;
    activeCallOverlay.style.top = `${newTop}px`;
  });

  callWindowHeader.addEventListener('pointerup', (e) => {
    isDraggingCallWindow = false;
    try { callWindowHeader.releasePointerCapture(e.pointerId); } catch (_) {}
  });
}

// Minimize / Maximize Window
if (callMinimizeBtn) {
  callMinimizeBtn.addEventListener('click', () => {
    const isMin = activeCallOverlay.classList.toggle('minimized');
    if (isMin) {
      if (minMaxIcon) minMaxIcon.innerHTML = '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"></path>';
    } else {
      if (minMaxIcon) minMaxIcon.innerHTML = '<path d="M19 13H5v-2h14v2z"></path>';
    }
  });
}

// Hide Window (continues in background)
if (callHideBtn) {
  callHideBtn.addEventListener('click', () => {
    if (activeCallOverlay) activeCallOverlay.classList.remove('active');
    showToast('Sesli görüşme devam ediyor. Sol menüdeki "Görüşme" butonundan açabilirsiniz.');
  });
}

// Call Timer functions
function startCallTimer() {
  clearInterval(callTimerInterval);
  callDurationSeconds = 0;
  callTimerBadge.textContent = '00:00';
  callTimerInterval = setInterval(() => {
    callDurationSeconds++;
    const m = String(Math.floor(callDurationSeconds / 60)).padStart(2, '0');
    const s = String(callDurationSeconds % 60).padStart(2, '0');
    callTimerBadge.textContent = `${m}:${s}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callDurationSeconds = 0;
}

function renderUsersList() {
  const count = connectedUsers.length;
  sidebarUserCount.textContent = count;
  usersDrawerCount.textContent = count;
  usersItemsContainer.innerHTML = '';

  if (count === 0) {
    usersItemsContainer.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--yt-text-secondary); font-size: 13px;">
        Odada kimse yok
      </div>
    `;
    return;
  }

  connectedUsers.forEach((u) => {
    // socket.id'yi öncelikli kullan, yoksa isim karşılaştır
    const isMe = socket && socket.id ? (u.id === socket.id) : (u.name === username);
    const initial = (u.name || 'K')[0].toUpperCase();
    const bg = getAvatarColor(u.name);

    const item = document.createElement('div');
    item.className = 'drawer-user-item';
    item.innerHTML = `
      <div class="drawer-user-avatar" style="background-color: ${bg};">
        ${initial}
      </div>
      <div class="drawer-user-info">
        <div class="drawer-user-name">
          <span>${escapeHtml(u.name)}</span>
          ${isMe ? '<span class="you-pill-badge">Sen</span>' : ''}
        </div>
        <div class="drawer-user-status">
          <span class="status-dot"></span>
          <span>Birlikte izliyor</span>
        </div>
      </div>
      ${!isMe ? `
        <div class="drawer-user-actions">
          <button class="user-call-btn audio" data-id="${u.id}" data-name="${escapeHtml(u.name)}" title="Sesli Ara">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"></path></svg>
          </button>
        </div>
      ` : ''}
    `;

    if (!isMe) {
      const audioBtn = item.querySelector('.user-call-btn.audio');
      audioBtn.addEventListener('click', () => initiateCall(u.id, u.name));
    }

    usersItemsContainer.appendChild(item);
  });
}

// ─── Call Initiation & Signaling Handlers ─────────────────────────────────
async function initiateCall(targetSocketId, targetName) {
  activeCallTargetId = targetSocketId;

  outgoingTargetAvatar.textContent = targetName.charAt(0).toUpperCase();
  outgoingTargetAvatar.style.backgroundColor = getAvatarColor(targetName);
  outgoingTargetName.textContent = targetName;
  outgoingCallTypeTxt.textContent = 'Sesli aranıyor...';
  outgoingCallModal.classList.add('active');

  socket.emit('call-user', { targetSocketId, callType: 'audio' });
}

outgoingCancelBtn.addEventListener('click', () => {
  if (activeCallTargetId) {
    socket.emit('call-ended', { targetSocketId: activeCallTargetId });
  }
  endActiveCall();
  outgoingCallModal.classList.remove('active');
});

// Incoming Call Event
function handleIncomingCall({ callerSocketId, callerName, callType }) {
  currentIncomingCallerId = callerSocketId;
  activeCallType = callType;

  incomingCallerAvatar.textContent = callerName.charAt(0).toUpperCase();
  incomingCallerAvatar.style.backgroundColor = getAvatarColor(callerName);
  incomingCallerName.textContent = callerName;
  incomingCallTypeTxt.textContent = callType === 'video' ? 'Seni görüntülü arıyor...' : 'Seni sesli arıyor...';
  incomingCallModal.classList.add('active');
}

incomingDeclineBtn.addEventListener('click', () => {
  if (currentIncomingCallerId) {
    socket.emit('call-rejected', { callerSocketId: currentIncomingCallerId });
  }
  incomingCallModal.classList.remove('active');
  currentIncomingCallerId = null;
});

incomingAcceptBtn.addEventListener('click', async () => {
  incomingCallModal.classList.remove('active');
  activeCallTargetId = currentIncomingCallerId;
  socket.emit('call-accepted', { callerSocketId: currentIncomingCallerId });
  await startCallStream(false);
});

// ─── Voice Activity Detection (Discord Style) ─────────────────────────────
let audioContext = null;
let analyserNode = null;
let microphoneSource = null;
let voiceDetectionInterval = null;
let lastSpeakingState = false;
let silenceTimer = null;

const localSpeakerItem = document.getElementById('local-speaker-item');
const localSpeakerAvatar = document.getElementById('local-speaker-avatar');
const localSpeakerName = document.getElementById('local-speaker-name');
const remoteSpeakerItem = document.getElementById('remote-speaker-item');
const remoteSpeakerAvatar = document.getElementById('remote-speaker-avatar');
const remoteSpeakerName = document.getElementById('remote-speaker-name');

function setupVoiceActivityDetection() {
  if (!localStream || !localStream.getAudioTracks().length) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 512;
    analyserNode.smoothingTimeConstant = 0.4;

    microphoneSource = audioContext.createMediaStreamSource(localStream);
    microphoneSource.connect(analyserNode);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    voiceDetectionInterval = setInterval(() => {
      if (isAudioMuted || !localStream) {
        setLocalSpeaking(false);
        return;
      }

      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const averageVolume = sum / bufferLength;

      // Desibel / Ses Seviyesi Eşiği (Threshold: 14)
      if (averageVolume > 14) {
        clearTimeout(silenceTimer);
        setLocalSpeaking(true);
      } else {
        if (!silenceTimer && lastSpeakingState) {
          silenceTimer = setTimeout(() => {
            setLocalSpeaking(false);
            silenceTimer = null;
          }, 350); // Sustuktan 350ms sonra kapanır
        }
      }
    }, 80);
  } catch (e) {
    console.warn('[AudioContext Error]', e);
  }
}

function setLocalSpeaking(isSpeaking) {
  if (lastSpeakingState === isSpeaking) return;
  lastSpeakingState = isSpeaking;

  localSpeakerItem.classList.toggle('speaking', isSpeaking);

  if (activeCallTargetId) {
    socket.emit('user-speaking', {
      targetSocketId: activeCallTargetId,
      isSpeaking
    });
  }
}

// Start WebRTC Connection & Media Stream
async function startCallStream(isCaller) {
  outgoingCallModal.classList.remove('active');
  activeCallOverlay.classList.add('active');
  activeCallOverlay.classList.remove('minimized');
  sidebarCallDot.classList.add('active');
  isAudioMuted = false;
  startCallTimer();

  const remoteName = outgoingTargetName.textContent || incomingCallerName.textContent || 'Kullanıcı';
  remoteUserLabel.textContent = remoteName;
  remoteAudioAvatar.textContent = (remoteName || 'K')[0].toUpperCase();
  remoteAudioAvatar.style.backgroundColor = getAvatarColor(remoteName);

  // Setup Discord Speaking Overlay
  const discordOverlay = document.getElementById('discord-voice-overlay');
  if (discordOverlay) discordOverlay.classList.add('call-active');

  localSpeakerAvatar.textContent = (username || 'S')[0].toUpperCase();
  localSpeakerAvatar.style.backgroundColor = getAvatarColor(username);
  localSpeakerName.textContent = username;

  remoteSpeakerAvatar.textContent = (remoteName || 'K')[0].toUpperCase();
  remoteSpeakerAvatar.style.backgroundColor = getAvatarColor(remoteName);
  remoteSpeakerName.textContent = remoteName;

  try {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    remoteAudioWrapper.style.display = 'flex';

    // Initialize Voice Activity Detection for glowing profile
    setupVoiceActivityDetection();

  } catch (err) {
    console.warn('[Media Access Warning]', err.message);
    showToast('Mikrofon izni alınamadı (Sesli arayüz simüle ediliyor)');
  }

  setupPeerConnection(isCaller);
}

function setupPeerConnection(isCaller) {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    remoteStream = event.streams[0];
    remoteAudioWrapper.style.display = 'flex';

    const remoteAudioEl = document.getElementById('webrtc-remote-audio');
    if (remoteAudioEl) {
      remoteAudioEl.srcObject = remoteStream;
      remoteAudioEl.play().catch(e => console.warn('[Remote Audio Play Error]', e));
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && activeCallTargetId) {
      socket.emit('webrtc-ice', { targetSocketId: activeCallTargetId, candidate: event.candidate });
    }
  };

  if (isCaller) {
    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => {
        socket.emit('webrtc-offer', { targetSocketId: activeCallTargetId, offer: peerConnection.localDescription });
      })
      .catch(console.error);
  }
}

// Call Control Buttons
toggleMicBtn.addEventListener('click', () => {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      isAudioMuted = !isAudioMuted;
      audioTrack.enabled = !isAudioMuted;
      toggleMicBtn.classList.toggle('off', isAudioMuted);
      showToast(isAudioMuted ? 'Mikrofon kapatıldı' : 'Mikrofon açıldı');
    }
  }
});

hangupCallBtn.addEventListener('click', () => {
  if (activeCallTargetId) {
    socket.emit('call-ended', { targetSocketId: activeCallTargetId });
  }
  endActiveCall();
  showToast('Görüşme sonlandırıldı');
});

function endActiveCall() {
  stopCallTimer();

  if (voiceDetectionInterval) {
    clearInterval(voiceDetectionInterval);
    voiceDetectionInterval = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  setLocalSpeaking(false);
  if (remoteSpeakerItem) remoteSpeakerItem.classList.remove('speaking');

  // Hide Discord Speaking Overlay
  const discordOverlay = document.getElementById('discord-voice-overlay');
  if (discordOverlay) discordOverlay.classList.remove('call-active');

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  isAudioMuted = false;
  activeCallOverlay.classList.remove('active');
  activeCallOverlay.classList.remove('minimized');
  sidebarCallDot.classList.remove('active');
  incomingCallModal.classList.remove('active');
  outgoingCallModal.classList.remove('active');
  activeCallTargetId = null;
  currentIncomingCallerId = null;
}

// ─── Download Modal ───────────────────────────────────────────────────────────
const downloadModal = document.getElementById('download-modal');
const downloadModalClose = document.getElementById('download-modal-close');
const downloadLoading = document.getElementById('download-loading');
const downloadOptions = document.getElementById('download-options');
const downloadError = document.getElementById('download-error');
const downloadMp3Btn = document.getElementById('download-mp3-btn');
const downloadThumb = document.getElementById('download-thumb');
const downloadTitle = document.getElementById('download-title');
const downloadMp3Size = document.getElementById('download-mp3-size');

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

async function openDownloadModal(video) {
  if (!video || !video.id) return;
  if (!downloadModal) return;

  // Reset state
  downloadLoading.style.display = 'block';
  downloadOptions.style.display = 'none';
  downloadError.style.display = 'none';
  downloadThumb.src = video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  downloadTitle.textContent = decodeHtmlEntities(video.title) || 'Video';
  downloadModal.classList.add('active');

  try {
    const res = await fetch(`/api/download-info/${video.id}`);
    const data = await res.json();

    if (data.error) {
      downloadLoading.style.display = 'none';
      downloadError.style.display = 'block';
      downloadError.textContent = data.error;
      return;
    }

    // MP3 kartı — tıklanınca anında indir
    if (downloadMp3Btn) {
      if (downloadMp3Size) downloadMp3Size.textContent = data.mp3?.size ? formatFileSize(data.mp3.size) : 'Ses kalitesi: yüksek (320kbps)';
      downloadMp3Btn.onclick = () => {
        const cleanName = `${(decodeHtmlEntities(data.title || video.title || 'sarki')).replace(/[/\\?%*:|"<>]/g, '').trim()}.mp3`;
        if (data.mp3?.url) {
          triggerProxyDownload(data.mp3.url, cleanName);
        } else {
          // Doğrudan backend ses çözücü endpoint'ine bağlan
          triggerProxyDownload(`/api/download-audio/${video.id}?title=${encodeURIComponent(cleanName)}`, cleanName);
        }
      };
    }

    downloadLoading.style.display = 'none';
    downloadOptions.style.display = 'block';
  } catch (err) {
    downloadLoading.style.display = 'none';
    downloadError.style.display = 'block';
    downloadError.textContent = 'İndirme bilgisi alınamadı. Lütfen tekrar deneyin.';
  }
}

// API + proxy ile sayfadan ayrılmadan doğrudan indir
function triggerProxyDownload(url, filename) {
  showToast('Şarkı indiriliyor... ⬇️');
  if (downloadModal) downloadModal.classList.remove('active');

  const safeFilename = filename || 'sarki.mp3';
  const downloadUrl = url.startsWith('/') 
    ? url 
    : `/api/proxy-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(safeFilename)}`;

  // Gizli <a> etiketi tıklaması ile tarayıcı arka planda indirmeyi başlatır, sayfa bembeyaz olmaz!
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = safeFilename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 2000);
}

function triggerDownload(url, filename) {
  showToast('İndirme başladı ⬇️');
  if (downloadModal) downloadModal.classList.remove('active');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 2000);
}

if (downloadModalClose) {
  downloadModalClose.addEventListener('click', () => downloadModal.classList.remove('active'));
}
if (downloadModal) {
  downloadModal.addEventListener('click', (e) => {
    if (e.target === downloadModal) downloadModal.classList.remove('active');
  });
}
if (watchDownloadBtn) {
  watchDownloadBtn.addEventListener('click', () => {
    if (currentPlayingVideo) openDownloadModal(currentPlayingVideo);
    else showToast('Önce bir video seçin');
  });
}

function renderQueue() {
  const count = queueList.length;
  if (queueBadgeCount) queueBadgeCount.textContent = count;
  if (watchQueueBadge) watchQueueBadge.textContent = count;
  
  // If user is currently viewing Sıra tab on the right sidebar, refresh it live
  if (currentWatchSidebarTab === 'queue') {
    renderQueueInSidebar();
  }

  queueItemsContainer.innerHTML = '';

  if (queueList.length === 0) {
    queueItemsContainer.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--yt-text-secondary); font-size: 13px;">
        Sırada video yok
      </div>
    `;
    return;
  }

  queueList.forEach((item, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 8px; margin-bottom: 4px; background: #222; font-size: 13px;';
    row.innerHTML = `
      <span style="color:var(--yt-text-secondary); width: 16px;">${idx + 1}</span>
      <img src="${escapeHtml(item.thumbnail)}" style="width: 50px; height: 30px; border-radius: 4px; object-fit: cover;">
      <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        ${escapeHtml(item.title)}
      </div>
      <button style="color:var(--yt-text-secondary);" title="Kaldır">✕</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      if (socket && socket.connected) socket.emit('remove-from-queue', idx);
    });
    queueItemsContainer.appendChild(row);
  });
}

function addChatMessage(msg) {
  const line = document.createElement('div');
  line.style.cssText = 'padding: 6px 12px; font-size: 13px; line-height: 18px; margin-bottom: 4px;';
  
  if (msg.type === 'system') {
    line.style.color = 'var(--yt-text-secondary)';
    line.style.fontStyle = 'italic';
    line.textContent = msg.text;
  } else {
    const isMe = msg.name === username;
    line.innerHTML = `
      <span style="font-weight: 700; color: ${getAvatarColor(msg.name)};">${escapeHtml(msg.name)}: </span>
      <span style="color: #fff;">${escapeHtml(msg.text)}</span>
    `;
  }
  chatMsgsContainer.appendChild(line);
  chatMsgsContainer.scrollTop = chatMsgsContainer.scrollHeight;
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const txt = chatMsgInput.value.trim();
  if (txt) {
    if (socket && socket.connected) socket.emit('send-message', txt);
    chatMsgInput.value = '';
  }
});

// ─── Room Management Modal Handlers ────────────────────────────────────────
const btnCreateNewRoom = document.getElementById('btn-create-new-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const btnLeaveRoom = document.getElementById('btn-leave-room');
const modalCopyLinkBtn = document.getElementById('modal-copy-link-btn');
const modalCloseIconBtn = document.getElementById('modal-close-icon-btn');
const modalCurrentRoomCode = document.getElementById('modal-current-room-code');

function openRoomModal() {
  if (modalCurrentRoomCode) {
    modalCurrentRoomCode.textContent = roomId || 'LOBİ';
  }
  if (usernameInput) {
    usernameInput.value = username || 'Kullanıcı';
  }
  if (roomInput) {
    roomInput.value = '';
  }
  roomModal.classList.add('active');
}

function closeRoomModal() {
  roomModal.classList.remove('active');
}

function copyRoomShareLink() {
  const shareUrl = `${window.location.origin}/?room=${roomId}`;
  navigator.clipboard?.writeText(shareUrl).then(() => {
    showToast('Oda davet linki kopyalandı! 📋');
  }).catch(() => {
    showToast(`Oda Kodu: ${roomId}`);
  });
}

function generateNewRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Open modal triggers (Header 'Oluştur' button + Room Status pill)
if (createActionBtn) {
  createActionBtn.addEventListener('click', openRoomModal);
}
if (roomStatusBtn) {
  roomStatusBtn.addEventListener('click', openRoomModal);
}
if (modalCloseIconBtn) {
  modalCloseIconBtn.addEventListener('click', closeRoomModal);
}

// Copy link button
if (modalCopyLinkBtn) {
  modalCopyLinkBtn.addEventListener('click', copyRoomShareLink);
}

// 1. Create New Room
if (btnCreateNewRoom) {
  btnCreateNewRoom.addEventListener('click', () => {
    const newRoomCode = generateNewRoomCode();
    const updatedUser = usernameInput?.value.trim() || username || 'Kullanıcı';
    username = updatedUser;
    localStorage.setItem('yt_wp_user', username);
    userAvatarBadge.textContent = username.charAt(0).toUpperCase();
    userAvatarBadge.style.backgroundColor = getAvatarColor(username);

    joinRoom(newRoomCode, username);
    window.history.pushState({}, '', `/?room=${newRoomCode}`);
    closeRoomModal();
    copyRoomShareLink();
    showToast(`Yeni Oda Kuruldu: #${newRoomCode} 🎉 Link Kopyalandı!`);
  });
}

// 2. Join Existing Room
if (btnJoinRoom) {
  btnJoinRoom.addEventListener('click', () => {
    const targetRoom = (roomInput?.value || '').trim().toUpperCase();
    if (!targetRoom) {
      showToast('Lütfen geçerli bir oda kodu girin');
      return;
    }
    const updatedUser = usernameInput?.value.trim() || username || 'Kullanıcı';
    username = updatedUser;
    localStorage.setItem('yt_wp_user', username);
    userAvatarBadge.textContent = username.charAt(0).toUpperCase();
    userAvatarBadge.style.backgroundColor = getAvatarColor(username);

    joinRoom(targetRoom, username);
    window.history.pushState({}, '', `/?room=${targetRoom}`);
    closeRoomModal();
    showToast(`Odaya Katıldınız: #${targetRoom} 👋`);
  });
}

// 3. Leave Room
if (btnLeaveRoom) {
  btnLeaveRoom.addEventListener('click', () => {
    const lobbyRoom = generateNewRoomCode();
    joinRoom(lobbyRoom, username);
    window.history.pushState({}, '', `/?room=${lobbyRoom}`);
    closeRoomModal();
    showToast('Odadan ayrıldınız. Yeni lobi odasına geçildi.');
  });
}

// ─── Search History & Mobile Full-Screen Search System ────────────────────
const SEARCH_HISTORY_STORAGE_KEY = 'yt_wp_user_search_history';

function getSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveSearchHistory(history) {
  try {
    localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 30)));
  } catch (e) {}
}

function addSearchToHistory(text, thumb = '') {
  if (!text || typeof text !== 'string') return;
  const clean = text.trim();
  if (!clean) return;

  let history = getSearchHistory();
  const existing = history.find(item => item.text.toLowerCase() === clean.toLowerCase());
  const finalThumb = thumb || existing?.thumb || '';

  // Mevcut olanı kaldırıp en başa taşı
  history = history.filter(item => item.text.toLowerCase() !== clean.toLowerCase());
  history.unshift({ text: clean, thumb: finalThumb, isHistory: true, time: Date.now() });

  saveSearchHistory(history);
}

function removeSearchFromHistory(text) {
  let history = getSearchHistory();
  history = history.filter(item => item.text.toLowerCase() !== text.toLowerCase().trim());
  saveSearchHistory(history);
  renderMobileSearchSuggestions();
}

function updateSearchHistoryThumbnail(query, thumb) {
  if (!query || !thumb) return;
  const clean = query.trim().toLowerCase();
  let history = getSearchHistory();
  let found = false;
  history = history.map(item => {
    if (item.text.toLowerCase() === clean) {
      found = true;
      return { ...item, thumb, isHistory: true };
    }
    return item;
  });
  if (!found) {
    history.unshift({ text: query.trim(), thumb, isHistory: true, time: Date.now() });
  }
  saveSearchHistory(history);
}

// ─── Mobile Full-Screen Search & Suggestions (YouTube Mobile Style) ────────
const mobileSearchTriggerBtn = document.getElementById('mobile-search-trigger-btn');
const mobileSearchOverlay = document.getElementById('mobile-search-overlay');
const mobSearchInput = document.getElementById('mob-search-input');
const mobSearchCloseBtn = document.getElementById('mob-search-close-btn');
const mobSearchClearBtn = document.getElementById('mob-search-clear-btn');
const mobSearchSuggestionsList = document.getElementById('mob-search-suggestions-list');

// Mobile Bottom Nav
const mobNavHome = document.getElementById('mob-nav-home');
const mobNavReels = document.getElementById('mob-nav-reels');
const mobNavRoom = document.getElementById('mob-nav-room');
const mobNavChat = document.getElementById('mob-nav-chat');
const mobNavUsers = document.getElementById('mob-nav-users');

let suggestDebounceTimer = null;

function renderMobileSearchSuggestions(customItems = null) {
  if (!mobSearchSuggestionsList) return;
  mobSearchSuggestionsList.innerHTML = '';

  const items = customItems || getSearchHistory();

  if (items.length === 0) {
    mobSearchSuggestionsList.innerHTML = `
      <div style="padding: 48px 24px; text-align: center; color: var(--yt-text-secondary); font-size: 14px;">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="#666" style="margin: 0 auto 14px; display: block; opacity: 0.6;">
          <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <div style="font-weight: 500; font-size: 15px; color: #fff; margin-bottom: 4px;">Arama geçmişiniz henüz boş</div>
        <div style="font-size: 12px; color: #888;">Yaptığınız aramalar burada kaydedilecektir</div>
      </div>
    `;
    return;
  }

  items.forEach(entry => {
    const text = typeof entry === 'string' ? entry : entry.text;
    const thumb = typeof entry === 'string' ? '' : (entry.thumb || '');
    const isHistory = typeof entry === 'object' && (entry.isHistory !== false);

    const item = document.createElement('div');
    item.className = 'mob-suggest-item';

    const iconSvg = isHistory
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
           <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
         </svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
           <path d="M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/>
         </svg>`;

    item.innerHTML = `
      <div class="mob-suggest-icon">${iconSvg}</div>
      <div class="mob-suggest-text">${escapeHtml(text)}</div>
      ${thumb
        ? `<img class="mob-suggest-thumb" src="${escapeHtml(thumb)}" alt="" onerror="this.style.display='none'">`
        : `<div class="mob-suggest-thumb-placeholder"></div>`
      }
      <button class="mob-suggest-arrow" title="Aramaya Ekle" type="button">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"></path></svg>
      </button>
      ${isHistory 
        ? `<button class="mob-suggest-delete-btn" title="Geçmişten Kaldır" type="button">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
           </button>`
        : ''
      }
    `;

    // 1. Arrow click -> fill input without closing
    const arrowBtn = item.querySelector('.mob-suggest-arrow');
    if (arrowBtn) {
      arrowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mobSearchInput) {
          mobSearchInput.value = text;
          mobSearchInput.focus();
          if (mobSearchClearBtn) mobSearchClearBtn.style.display = 'flex';
          handleMobSearchInput(text);
        }
      });
    }

    // 2. Delete button click -> remove from history
    const deleteBtn = item.querySelector('.mob-suggest-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSearchFromHistory(text);
        showToast('Arama geçmişten silindi');
      });
    }

    // 3. Row click -> Execute search
    item.addEventListener('click', () => {
      executeSearch(text);
    });

    mobSearchSuggestionsList.appendChild(item);
  });
}

function executeSearch(query) {
  if (!query || !query.trim()) return;
  const q = query.trim();
  addSearchToHistory(q);
  // Close mobile search overlay
  if (mobileSearchOverlay) mobileSearchOverlay.classList.remove('active');
  // Update both search inputs to show the query
  if (searchInput) searchInput.value = q;
  if (clearSearchBtn) clearSearchBtn.classList.toggle('visible', !!q);
  if (mobSearchInput) mobSearchInput.value = q;
  // Open feed view and fetch results
  openFeedView();
  fetchAndRenderFeed(q);
  showToast(`Aranıyor: "${q}" 🔍`);
}

async function handleMobSearchInput(val) {
  if (!val) {
    renderMobileSearchSuggestions();
    return;
  }

  const history = getSearchHistory();
  const filteredHistory = history.filter(s => s.text.toLowerCase().includes(val.toLowerCase()));

  clearTimeout(suggestDebounceTimer);
  suggestDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/suggestions?q=${encodeURIComponent(val)}`);
      const apiSuggestions = await res.json();
      
      const combined = [...filteredHistory];
      if (Array.isArray(apiSuggestions)) {
        apiSuggestions.forEach(sugText => {
          if (!combined.some(c => c.text.toLowerCase() === sugText.toLowerCase())) {
            combined.push({ text: sugText, thumb: '', isHistory: false });
          }
        });
      }

      if (combined.length === 0) {
        combined.push({ text: val, thumb: '', isHistory: false });
      }

      renderMobileSearchSuggestions(combined);
    } catch (_) {
      renderMobileSearchSuggestions(filteredHistory.length > 0 ? filteredHistory : [{ text: val, thumb: '', isHistory: false }]);
    }
  }, 120);
}

if (mobileSearchTriggerBtn && mobileSearchOverlay) {
  mobileSearchTriggerBtn.addEventListener('click', () => {
    mobileSearchOverlay.classList.add('active');
    mobSearchInput.value = searchInput.value || '';
    if (mobSearchClearBtn) mobSearchClearBtn.style.display = mobSearchInput.value ? 'flex' : 'none';
    renderMobileSearchSuggestions();
    setTimeout(() => mobSearchInput.focus(), 100);
  });
}

if (mobSearchCloseBtn && mobileSearchOverlay) {
  mobSearchCloseBtn.addEventListener('click', () => {
    mobileSearchOverlay.classList.remove('active');
  });
}

// Also handle the header back button on mobile (visible when search bar is focused)
const mobileSearchBackBtn = document.getElementById('mobile-search-back-btn');
if (mobileSearchBackBtn && mobileSearchOverlay) {
  mobileSearchBackBtn.addEventListener('click', () => {
    mobileSearchOverlay.classList.remove('active');
  });
}

if (mobSearchClearBtn && mobSearchInput) {
  mobSearchClearBtn.addEventListener('click', () => {
    mobSearchInput.value = '';
    mobSearchClearBtn.style.display = 'none';
    renderMobileSearchSuggestions();
    mobSearchInput.focus();
  });
}

if (mobSearchInput) {
  mobSearchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (mobSearchClearBtn) mobSearchClearBtn.style.display = val ? 'flex' : 'none';
    handleMobSearchInput(val);
  });

  mobSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = mobSearchInput.value.trim();
      if (val) {
        executeSearch(val);
      }
    }
  });
}

// Mobile Bottom Nav Item Click Handlers
if (mobNavHome) {
  mobNavHome.addEventListener('click', () => {
    document.querySelectorAll('.mobile-nav-item').forEach(i => i.classList.remove('active'));
    mobNavHome.classList.add('active');
    usersDrawer.classList.remove('open');
    chatDrawer.classList.remove('open');
    openFeedView();
  });
}

if (mobNavReels) {
  mobNavReels.addEventListener('click', () => {
    document.querySelectorAll('.mobile-nav-item').forEach(i => i.classList.remove('active'));
    mobNavReels.classList.add('active');
    usersDrawer.classList.remove('open');
    chatDrawer.classList.remove('open');
    openFeedView();
    fetchAndRenderFeed('short reels kısa video');
    showToast('Reels yükleniyor...');
  });
}

if (mobNavRoom) {
  mobNavRoom.addEventListener('click', () => {
    document.querySelectorAll('.mobile-nav-item').forEach(i => i.classList.remove('active'));
    usersDrawer.classList.remove('open');
    chatDrawer.classList.remove('open');
    openRoomModal();
  });
}

if (mobNavChat) {
  mobNavChat.addEventListener('click', () => {
    usersDrawer.classList.remove('open');
    chatDrawer.classList.toggle('open');
  });
}

if (mobNavUsers) {
  mobNavUsers.addEventListener('click', () => {
    chatDrawer.classList.remove('open');
    usersDrawer.classList.toggle('open');
  });
}

// ─── Initialize ────────────────────────────────────────────────────────────
// Pool of diverse feed queries that rotate on each page load for fresh content
const FEED_ROTATION_QUERIES = [
  'trend türkçe pop şarkılar 2025',
  'viral hit müzikler 2025',
  'en çok dinlenen türkçe şarkılar',
  'türkçe rap hiphop yeni',
  'dünya hit müzikleri trend',
  'türkçe arabesk pop yeni şarkılar',
  'pop müzik yeni çıkanlar',
  'türkçe rock alternatif müzik',
  'elektronik müzik trap 2025',
  'klasik rock pop en iyi',
  'chill lo-fi müzik çalma listesi',
  'akustik söz yazarı şarkılar'
];

function startApp() {
  try {
    if (searchInput) searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.classList.remove('visible');

    // ─── Startup Cleanup: Remove any internal/AI queries from search history ─
    try {
      const INTERNAL_QUERIES = ['yapay zeka', 'yapay zekâ', 'trend popüler türkiye', 'popüler müzik trend'];
      const history = JSON.parse(localStorage.getItem('yt_wp_user_search_history') || '[]');
      const cleaned = history.filter(item => {
        const text = (typeof item === 'string' ? item : item?.text || '').toLowerCase().trim();
        return !INTERNAL_QUERIES.includes(text);
      });
      if (cleaned.length !== history.length) {
        localStorage.setItem('yt_wp_user_search_history', JSON.stringify(cleaned));
      }
    } catch (_) {}

    // 1. Generate a room code immediately so the pill shows a code, not BAĞLANIYOR
    const urlParams = new URLSearchParams(window.location.search);
    const paramRoom = urlParams.get('room');
    const instantRoom = paramRoom ? paramRoom.toUpperCase() : generateNewRoomCode();
    roomId = instantRoom;
    if (roomCodeDisplay) roomCodeDisplay.textContent = roomId;

    // 2. Instantly show fallback video cards - visible immediately on page load
    if (videoGrid) {
      renderVideoGrid(CLIENT_FALLBACK_VIDEOS);
    }

    // 3. In background: fetch real videos from AI feed (fresh content on every load)
    //    Use user interests if available, otherwise rotate through diverse queries
    let userInterests = [];
    try { userInterests = JSON.parse(localStorage.getItem('yt_wp_ai_interests') || '[]'); } catch (_) {}
    aiFeedSeed = Math.floor(Math.random() * FEED_ROTATION_QUERIES.length);
    const ts = Date.now();
    const feedUrl = `/api/ai-feed?context=${encodeURIComponent(userInterests.join(','))}&seed=${aiFeedSeed}&_t=${ts}`;
    currentFeedQuery = FEED_ROTATION_QUERIES[aiFeedSeed % FEED_ROTATION_QUERIES.length];
    
    fetch(feedUrl)
      .then(r => r.json())
      .then(videos => {
        if (Array.isArray(videos) && videos.length > 0) {
          renderVideoGrid(videos);
        } else {
          // fallback to a rotating query with cache bust
          _fetchFeedInBackground(currentFeedQuery);
        }
      })
      .catch(() => _fetchFeedInBackground(currentFeedQuery));

    // 4. Connect to socket and join room
    initRoom();
  } catch (err) {
    console.error('[startApp Error]', err);
    if (videoGrid) renderVideoGrid(CLIENT_FALLBACK_VIDEOS);
  }
}

// startApp'ı DOMContentLoaded'a bağla — her koşulda çalışsın
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  // DOM zaten hazır (script body sonunda)
  startApp();
}

// Fetch feed videos silently in the background without showing loading spinner
async function _fetchFeedInBackground(query) {
  currentFeedQuery = query;
  currentFeedPage = 1;
  hasMoreFeed = true;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=1&limit=16`);
    const videos = await res.json();
    if (Array.isArray(videos) && videos.length > 0) {
      renderVideoGrid(videos);
    }
  } catch (err) {
    console.warn('[Background Feed Fetch Error - Keeping Fallback]', err);
  }
}

// ─── Global Keyboard Shortcuts (Space = Play/Pause, Arrows = Seek) ──────────
window.addEventListener('keydown', (e) => {
  // If user is currently typing in an input, textarea or search box, don't trigger shortcut
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
    return;
  }

  // Spacebar or 'k' toggles Play/Pause
  if (e.code === 'Space' || e.key === ' ' || e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    if (!player || !playerReady || typeof player.getPlayerState !== 'function') return;

    try {
      const state = player.getPlayerState();
      if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        if (socket && socket.connected) socket.emit('video-pause', player.getCurrentTime());
        showToast('Duraklatıldı ⏸️');
      } else {
        player.playVideo();
        if (socket && socket.connected) socket.emit('video-play', player.getCurrentTime());
        showToast('Oynatılıyor ▶️');
      }
    } catch (_) {}
  }

  // Arrow Right = +5s Seek
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (!player || !playerReady || typeof player.getCurrentTime !== 'function') return;
    try {
      const newTime = Math.min(player.getDuration() || 9999, player.getCurrentTime() + 5);
      player.seekTo(newTime, true);
      if (socket && socket.connected) socket.emit('video-seek', newTime);
      showToast('+5 sn ⏩');
    } catch (_) {}
  }

  // Arrow Left = -5s Seek
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (!player || !playerReady || typeof player.getCurrentTime !== 'function') return;
    try {
      const newTime = Math.max(0, player.getCurrentTime() - 5);
      player.seekTo(newTime, true);
      if (socket && socket.connected) socket.emit('video-seek', newTime);
      showToast('-5 sn ⏪');
    } catch (_) {}
  }
});

// ─── Pull-To-Refresh (Üst Bardan Aşağı Çekerek Yenileme) ────────────────────
const ptrContainer = document.getElementById('pull-to-refresh-container');
const ptrPill = document.getElementById('ptr-pill');
const ptrIcon = document.getElementById('ptr-icon');
const ptrText = document.getElementById('ptr-text');

let ptrStartY = 0;
let ptrCurrentY = 0;
let isPtrDragging = false;
let isPtrRefreshing = false;

function isAtPageTop() {
  const windowTop = window.scrollY <= 2;
  const gridTop = !videoGridScroll || videoGridScroll.scrollTop <= 2;
  return windowTop && gridTop;
}

function triggerPullRefresh() {
  if (isPtrRefreshing) return;
  isPtrRefreshing = true;
  if (ptrContainer) ptrContainer.classList.add('refreshing', 'visible');
  if (ptrIcon) ptrIcon.classList.add('spinning');
  if (ptrText) ptrText.textContent = 'Yenileniyor...';
  try { navigator.vibrate?.(30); } catch (_) {}

  // Feed ekranındaysa içeriği sıfırdan çek, video/oda ekranındaysa odayı eşitle
  if (feedView && feedView.classList.contains('active')) {
    const activeChip = document.querySelector('.chip-item.active');
    const query = activeChip?.getAttribute('data-q') || currentFeedQuery || 'trend popüler türkiye';
    fetchAndRenderFeed(query, true)
      .finally(() => {
        setTimeout(() => {
          if (ptrContainer) {
            ptrContainer.classList.remove('refreshing', 'visible');
            ptrContainer.style.transform = '';
          }
          if (ptrIcon) {
            ptrIcon.classList.remove('spinning');
            ptrIcon.style.transform = '';
          }
          if (ptrText) ptrText.textContent = 'Yenilemek için çekin';
          isPtrRefreshing = false;
          showToast('Sayfa yenilendi 🔄');
        }, 500);
      });
  } else {
    // İzleme / Oda sayfasındaysa anlık senkronizasyon yap veya yenile
    if (socket && socket.connected) {
      socket.emit('request-sync');
    }
    setTimeout(() => {
      window.location.reload();
    }, 400);
  }
}

// Butona tıklandığında da doğrudan yenile
if (ptrPill) {
  ptrPill.addEventListener('click', triggerPullRefresh);
}

// Dokunmatik / Touch Desteği (Mobil & PWA)
window.addEventListener('touchstart', (e) => {
  if (isPtrRefreshing) return;
  if (isAtPageTop()) {
    ptrStartY = e.touches[0].clientY;
    isPtrDragging = true;
  }
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (!isPtrDragging || isPtrRefreshing) return;
  if (!isAtPageTop()) {
    isPtrDragging = false;
    if (ptrContainer) ptrContainer.classList.remove('visible');
    return;
  }

  ptrCurrentY = e.touches[0].clientY;
  const deltaY = ptrCurrentY - ptrStartY;

  if (deltaY > 15) {
    const pullDist = Math.min(75, deltaY * 0.45);
    if (ptrContainer) {
      ptrContainer.classList.add('visible');
      ptrContainer.style.transform = `translateX(-50%) translateY(${-80 + pullDist * 1.3}px)`;
    }
    if (ptrIcon) {
      ptrIcon.style.transform = `rotate(${pullDist * 5}deg)`;
    }
    if (ptrText) {
      ptrText.textContent = pullDist >= 48 ? 'Bırakınca yenilenecek' : 'Yenilemek için çekin';
    }
  }
}, { passive: true });

window.addEventListener('touchend', () => {
  if (!isPtrDragging || isPtrRefreshing) return;
  isPtrDragging = false;

  const deltaY = ptrCurrentY - ptrStartY;
  const pullDist = Math.min(75, deltaY * 0.45);

  if (pullDist >= 48) {
    triggerPullRefresh();
  } else {
    if (ptrContainer) {
      ptrContainer.classList.remove('visible');
      ptrContainer.style.transform = '';
    }
    if (ptrIcon) ptrIcon.style.transform = '';
  }
  ptrStartY = 0;
  ptrCurrentY = 0;
});

// Masaüstü / Mouse Pointer Desteği (Header'dan aşağı çekince)
const ytHeader = document.querySelector('.yt-header');
if (ytHeader) {
  ytHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, a, form')) return;
    if (isAtPageTop() && !isPtrRefreshing) {
      ptrStartY = e.clientY;
      isPtrDragging = true;
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!isPtrDragging || isPtrRefreshing) return;
    ptrCurrentY = e.clientY;
    const deltaY = ptrCurrentY - ptrStartY;

    if (deltaY > 15) {
      const pullDist = Math.min(75, deltaY * 0.4);
      if (ptrContainer) {
        ptrContainer.classList.add('visible');
        ptrContainer.style.transform = `translateX(-50%) translateY(${-80 + pullDist * 1.3}px)`;
      }
      if (ptrIcon) {
        ptrIcon.style.transform = `rotate(${pullDist * 5}deg)`;
      }
      if (ptrText) {
        ptrText.textContent = pullDist >= 45 ? 'Bırakınca yenilenecek' : 'Yenilemek için çekin';
      }
    }
  });

  window.addEventListener('pointerup', () => {
    if (!isPtrDragging || isPtrRefreshing) return;
    isPtrDragging = false;
    const deltaY = ptrCurrentY - ptrStartY;
    const pullDist = Math.min(75, deltaY * 0.4);

    if (pullDist >= 45) {
      triggerPullRefresh();
    } else {
      if (ptrContainer) {
        ptrContainer.classList.remove('visible');
        ptrContainer.style.transform = '';
      }
      if (ptrIcon) ptrIcon.style.transform = '';
    }
    ptrStartY = 0;
    ptrCurrentY = 0;
  });
}

// ─── PWA Service Worker Registration ───────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[PWA] Service Worker registered successfully, scope:', reg.scope);
      })
      .catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  });
}


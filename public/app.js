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
  const paramRoom = urlParams.get('room');
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

    // When socket connects, get room from server then join
    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket.id);
      if (paramRoom) {
        // Join existing room from URL
        roomId = paramRoom.toUpperCase();
        joinRoom(roomId, username);
      } else {
        // Get a fresh room ID from server
        fetch('/api/new-room')
          .then(res => res.json())
          .then(data => {
            roomId = (data && data.roomId) ? data.roomId : generateNewRoomCode();
            joinRoom(roomId, username);
          })
          .catch(() => {
            roomId = generateNewRoomCode();
            joinRoom(roomId, username);
          });
      }
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
    if (!playerReady) return;
    doSync(() => {
      player.seekTo(time, true);
      player.playVideo();
      updatePlayIcon(true);
    });
  });

  socket.on('video-pause', (time) => {
    if (!playerReady) return;
    doSync(() => {
      player.seekTo(time, true);
      player.pauseVideo();
      updatePlayIcon(false);
    });
  });

  socket.on('video-seek', (time) => {
    if (!playerReady) return;
    doSync(() => player.seekTo(time, true));
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
  setTimeout(() => { isSyncing = false; }, 250);
}

// ─── Infinite Scroll & Feed State ──────────────────────────────────────────
let currentFeedQuery = 'yapay zeka';
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

let relatedVideosCache = [];
let currentWatchSidebarTab = 'related'; // 'related' | 'queue'

function openWatchView(video) {
  if (!video) return;
  feedView.classList.remove('active');
  watchView.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  watchTitle.textContent = video.title || 'Video';
  watchChannelName.textContent = video.author || 'YouTube';

  const subCountEl = document.querySelector('.watch-sub-count');
  if (subCountEl) {
    subCountEl.textContent = video.subCount || '1,24 Mn abone';
  }

  if (video.channelAvatar) {
    watchChannelAvatar.innerHTML = `<img src="${escapeHtml(video.channelAvatar)}" alt="${escapeHtml(video.author)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    watchChannelAvatar.style.backgroundColor = 'transparent';
  } else {
    watchChannelAvatar.textContent = (video.author || 'Y')[0].toUpperCase();
    watchChannelAvatar.style.backgroundColor = getAvatarColor(video.author);
  }
  
  const views = video.views || '245 B görüntüleme';
  const ago = video.ago || '3 gün önce';
  watchStats.textContent = `${views} • ${ago}`;

  // Reset chips to 'Tümü'
  if (watchSidebarChips) {
    watchSidebarChips.querySelectorAll('.chip-item').forEach((c, idx) => c.classList.toggle('active', idx === 0));
  }
  currentWatchSidebarTab = 'related';

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

// ─── Search & Feed Rendering ───────────────────────────────────────────────
async function fetchAndRenderFeed(query) {
  currentFeedQuery = query || 'yapay zeka';
  currentFeedPage = 1;
  hasMoreFeed = true;
  if (videoGridScroll) videoGridScroll.scrollTop = 0;

  if (videoGrid) {
    videoGrid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px 0; text-align: center; color: var(--yt-text-secondary); font-size: 15px;">
        Yükleniyor...
      </div>
    `;
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(currentFeedQuery)}&page=1&limit=16`);
    const videos = await res.json();

    if (!Array.isArray(videos) || videos.length === 0) {
      renderVideoGrid(CLIENT_FALLBACK_VIDEOS);
      return;
    }

    renderVideoGrid(videos);
  } catch (err) {
    console.warn('[Feed Fetch Error - Using Fallback]', err);
    renderVideoGrid(CLIENT_FALLBACK_VIDEOS);
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
  
  const views = video.views || (Math.floor(Math.random() * 850 + 20) + ' B görüntüleme');
  const timeAgo = video.ago || ['3 gün önce', '1 hafta önce', '2 hafta önce', '1 ay önce', '3 ay önce', '1 yıl önce'][(index || 0) % 6];
  const initial = (video.author || 'Y')[0].toUpperCase();
  const avatarBg = getAvatarColor(video.author);
  const avatarHtml = video.channelAvatar
    ? `<img src="${escapeHtml(video.channelAvatar)}" alt="${escapeHtml(video.author)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`
    : initial;

  card.innerHTML = `
    <div class="thumbnail-wrapper">
      <img class="thumbnail-img" src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy">
      <span class="video-duration">${escapeHtml(video.duration)}</span>
    </div>
    <div class="card-details">
      <div class="channel-avatar" style="${video.channelAvatar ? 'background:transparent;' : `background-color: ${avatarBg};`}">
        ${avatarHtml}
      </div>
      <div class="meta-container">
        <h3 class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
        <div class="channel-name-wrapper">
          <span>${escapeHtml(video.author)}</span>
          <svg class="verified-icon" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM9.8 17.3l-4.2-4.1L7 11.8l2.8 2.7L17 7.4l1.4 1.4-8.6 8.5z"></path></svg>
        </div>
        <div class="video-stats">${views} • ${timeAgo}</div>
        
        <div class="card-button-row">
          <button class="card-action-pill primary play-now-btn">İzle</button>
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
          updatePlayIcon(true);
          if (socket && socket.connected) socket.emit('video-play', player.getCurrentTime());
        } else if (s === YT.PlayerState.PAUSED) {
          isPlaying = false;
          updatePlayIcon(false);
          if (socket && socket.connected) socket.emit('video-pause', player.getCurrentTime());
        } else if (s === YT.PlayerState.ENDED) {
          isPlaying = false;
          updatePlayIcon(false);
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
      } else if (attempts > 30) {
        clearInterval(check);
      }
    }, 100);
    return;
  }
  _execLoad(video, state);
}

function _execLoad(video, state) {
  if (!player || typeof player.loadVideoById !== 'function') return;
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
        }, 100);
      } else {
        setTimeout(() => {
          try { player.pauseVideo(); isPlaying = false; } catch(_) {}
        }, 200);
      }
    } catch (err) {
      console.warn('[Video Load Error]', err);
    }
  });
}

function updatePlayIcon(playing) {
  // Watch page uses YouTube iframe native controls
}

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

if (logoBtn) {
  logoBtn.addEventListener('click', () => {
    openFeedView();
    searchInput.value = '';
    clearSearchBtn.classList.remove('visible');
    fetchAndRenderFeed('trend popüler türkiye');
    document.querySelectorAll('.chip-item').forEach((c, idx) => c.classList.toggle('active', idx === 0));
  });
}

const homeNavBtn = document.querySelector('.sidebar-nav-item[data-category="Tümü"]');
if (homeNavBtn) {
  homeNavBtn.addEventListener('click', () => {
    openFeedView();
    searchInput.value = '';
    clearSearchBtn.classList.remove('visible');
    fetchAndRenderFeed('trend popüler türkiye');
    document.querySelectorAll('.chip-item').forEach((c, idx) => c.classList.toggle('active', idx === 0));
  });
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
    const isMe = u.name === username;
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
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"></path></svg>
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

// ─── Mobile Full-Screen Search & Suggestions (YouTube Mobile Style) ────────
const mobileSearchOverlay = document.getElementById('mobile-search-overlay');
const mobSearchInput = document.getElementById('mob-search-input');
const mobSearchCloseBtn = document.getElementById('mob-search-close-btn');
const mobSearchClearBtn = document.getElementById('mob-search-clear-btn');
const mobSearchSuggestionsList = document.getElementById('mob-search-suggestions-list');

const initialMobileSuggestions = [
  'galatasaray çorum',
  'ataberk doğan',
  'izliyor',
  'wegh',
  'yapay zeka',
  'jahrein cenk bey',
  'guldur guldur show',
  'fenerbahçe maç özeti',
  'kısmetse olur 4 sezon',
  'trabzonspor',
  'yıldız tilbe',
  'müslüm gürses',
  'erkan kolçak köstendil',
  'valorant fps arttırma unlost'
];

function renderMobileSearchSuggestions(items) {
  if (!mobSearchSuggestionsList) return;
  mobSearchSuggestionsList.innerHTML = '';

  items.forEach(text => {
    const item = document.createElement('div');
    item.className = 'mob-suggest-item';
    item.innerHTML = `
      <div class="mob-suggest-icon">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"></path></svg>
      </div>
      <div class="mob-suggest-text">${escapeHtml(text)}</div>
      <div class="mob-suggest-arrow">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"></path></svg>
      </div>
    `;

    item.addEventListener('click', () => {
      mobileSearchOverlay.classList.remove('active');
      searchInput.value = text;
      openFeedView();
      fetchAndRenderFeed(text);
      showToast(`Aranıyor: "${text}" 🔍`);
    });

    mobSearchSuggestionsList.appendChild(item);
  });
}

if (mobileSearchTriggerBtn && mobileSearchOverlay) {
  mobileSearchTriggerBtn.addEventListener('click', () => {
    mobileSearchOverlay.classList.add('active');
    mobSearchInput.value = searchInput.value || '';
    if (mobSearchClearBtn) mobSearchClearBtn.style.display = mobSearchInput.value ? 'flex' : 'none';
    renderMobileSearchSuggestions(initialMobileSuggestions);
    setTimeout(() => mobSearchInput.focus(), 100);
  });
}

if (mobSearchCloseBtn && mobileSearchOverlay) {
  mobSearchCloseBtn.addEventListener('click', () => {
    mobileSearchOverlay.classList.remove('active');
  });
}

if (mobSearchClearBtn && mobSearchInput) {
  mobSearchClearBtn.addEventListener('click', () => {
    mobSearchInput.value = '';
    mobSearchClearBtn.style.display = 'none';
    renderMobileSearchSuggestions(initialMobileSuggestions);
    mobSearchInput.focus();
  });
}

if (mobSearchInput) {
  mobSearchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim().toLowerCase();
    if (mobSearchClearBtn) mobSearchClearBtn.style.display = val ? 'flex' : 'none';

    if (!val) {
      renderMobileSearchSuggestions(initialMobileSuggestions);
      return;
    }

    const filtered = initialMobileSuggestions.filter(s => s.toLowerCase().includes(val));
    if (!filtered.includes(val)) {
      filtered.unshift(val);
    }
    renderMobileSearchSuggestions(filtered);
  });

  mobSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = mobSearchInput.value.trim();
      if (val) {
        mobileSearchOverlay.classList.remove('active');
        searchInput.value = val;
        openFeedView();
        fetchAndRenderFeed(val);
        showToast(`Aranıyor: "${val}" 🔍`);
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

if (mobNavRoom) {
  mobNavRoom.addEventListener('click', () => {
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
function startApp() {
  try {
    if (searchInput) searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.classList.remove('visible');
    
    // Always fetch and render feed first
    fetchAndRenderFeed('trend popüler türkiye');

    // Connect to room & socket
    initRoom();
  } catch (err) {
    console.error('[startApp Error]', err);
    // Fallback feed load
    fetchAndRenderFeed('trend popüler türkiye');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
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

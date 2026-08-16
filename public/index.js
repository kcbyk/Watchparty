/* ── Landing Page Logic ─────────────────────────────────────────────────── */

const usernameInput  = document.getElementById('username-input');
const usernameError  = document.getElementById('username-error');
const createRoomBtn  = document.getElementById('create-room-btn');
const toggleJoinBtn  = document.getElementById('toggle-join-btn');
const joinForm       = document.getElementById('join-form');
const roomCodeInput  = document.getElementById('room-code-input');
const roomCodeError  = document.getElementById('room-code-error');
const joinRoomBtn    = document.getElementById('join-room-btn');
const toastEl        = document.getElementById('toast');

// ─── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// ─── Validation ─────────────────────────────────────────────────────────────
function getUsername() {
  const v = usernameInput.value.trim();
  if (!v) { usernameError.classList.add('visible'); usernameInput.focus(); return null; }
  usernameError.classList.remove('visible');
  return v;
}

usernameInput.addEventListener('input', () => usernameError.classList.remove('visible'));
roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
  roomCodeError.classList.remove('visible');
});

// ─── Create Room ─────────────────────────────────────────────────────────────
createRoomBtn.addEventListener('click', async () => {
  const user = getUsername();
  if (!user) return;

  createRoomBtn.disabled = true;
  createRoomBtn.textContent = 'Oluşturuluyor…';

  try {
    const res = await fetch('/api/new-room');
    const { roomId } = await res.json();
    navigateToRoom(roomId, user);
  } catch {
    showToast('❌ Sunucuya bağlanılamadı!');
    createRoomBtn.disabled = false;
    createRoomBtn.innerHTML = '<span>✨</span> Oda Oluştur';
  }
});

// ─── Toggle Join Form ────────────────────────────────────────────────────────
toggleJoinBtn.addEventListener('click', () => {
  const isOpen = joinForm.classList.toggle('visible');
  toggleJoinBtn.setAttribute('aria-expanded', isOpen);
  if (isOpen) roomCodeInput.focus();
});

// ─── Join Room ───────────────────────────────────────────────────────────────
joinRoomBtn.addEventListener('click', () => {
  const user = getUsername();
  if (!user) return;

  const code = roomCodeInput.value.trim().toUpperCase();
  if (code.length < 3) { roomCodeError.classList.add('visible'); roomCodeInput.focus(); return; }

  navigateToRoom(code, user);
});

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoomBtn.click();
});
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (joinForm.classList.contains('visible')) joinRoomBtn.click();
    else createRoomBtn.click();
  }
});

// ─── Navigate ─────────────────────────────────────────────────────────────────
function navigateToRoom(roomId, user) {
  const params = new URLSearchParams({ room: roomId, user });
  window.location.href = `/room.html?${params}`;
}

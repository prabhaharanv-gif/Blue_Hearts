/* TicketDesk — two-person chat client, wearing a booking app's name and
   icon so that is all it looks like from a home screen or a browser tab.
   Every message lives in this page's memory only. Refresh = gone. */

const $ = (id) => document.getElementById(id);

/* When the page is served by the chat server itself, the socket just talks to
   its own origin. Inside the packaged Android app there is no origin to talk
   to, so the first screen asks for the server address and remembers it. */
const PACKAGED = !!window.Capacitor || location.protocol === 'file:';
const SERVER_KEY = 'bh-server';

function savedServer() {
  try { return localStorage.getItem(SERVER_KEY) || ''; } catch (_) { return ''; }
}

/* Closing the app, or letting the screen lock, is not logging out. The name
   and the booking reference stay on this device so the next launch goes
   straight into the chat; only the Log out button clears them. They never
   leave the phone -- the server still keeps no account of anybody. */
const SESSION_KEY = 'bh-session';

function savedSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
}
function saveSession(name, pass) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ name, pass })); } catch (_) { /* private mode */ }
}
function forgetSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* private mode */ }
}

/* The other person's name outlives the server's memory of them. The free tier
   sleeps after fifteen idle minutes and wakes up having forgotten everyone, and
   a header that then goes back to naming nobody is worse than one that still
   says who it is waiting for. So the name, and when they were last around, are
   kept here too. Logging out drops them along with everything else. */
const PEER_KEY = 'bh-peer';

function savedPeer() {
  try { return JSON.parse(localStorage.getItem(PEER_KEY) || 'null'); } catch (_) { return null; }
}
function rememberPeer(p) {
  if (!p || !p.name) return;
  try { localStorage.setItem(PEER_KEY, JSON.stringify({ name: p.name, at: p.at })); } catch (_) { /* private mode */ }
}
function forgetPeer() {
  try { localStorage.removeItem(PEER_KEY); } catch (_) { /* private mode */ }
}
function normaliseServer(raw) {
  let v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}

// In the browser the socket exists from the start; in the packaged app it is
// created once the person has told us which server to reach.
let socket = PACKAGED ? null : io({ autoConnect: true });

const loginView = $('login');
const appView = $('app');
const loginForm = $('login-form');
const nameInput = $('name-input');
const loginError = $('login-error');
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send-btn');
const peerNameEl = $('peer-name');
const peerStatusEl = $('peer-status');
const peerAvatarEl = $('peer-avatar');
const replyBar = $('reply-bar');
const replyNameEl = $('reply-name');
const replyTextEl = $('reply-text');
const emojiPanel = $('emoji-panel');
const editBar = $('edit-bar');
const editTextEl = $('edit-text');
const attachTray = $('attach-tray');
const fileInput = $('file-input');
const lightbox = $('lightbox');
const lightboxImg = $('lightbox-img');

let me = null;
let peer = null;
let replyTo = null;
let editing = null;       // id of the message currently being reworded
let lastSide = null;
let unread = 0;
let peerLastSeen = savedPeer();  // { name, at } — who the header names when nobody is here
const sent = new Map();   // id -> { el, tickEl }
const seenText = new Map(); // id -> { from, text }  (for reply quotes, in memory only)
const bubbles = new Map();  // id -> { bubble, body, meta, mine }
let pending = [];           // attachments picked but not sent yet
// Attachments are shown from blob: URLs, so they never touch disk. Every one
// is released when the chat is cleared or on log out.
const blobUrls = new Set();

/* ── theme ── */
const savedTheme = localStorage.getItem('bh-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('theme-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('bh-theme', next);
});

/* ── notifications ── */
/* One switch for both halves of an alert: the blip and, where the browser
   allows it, a banner while the tab is in the background. */
const NOTIFY_KEY = 'bh-notify';
const notifyBtn = $('notify-btn');
const bellOn = $('bell-on');
const bellOff = $('bell-off');
let notifyOn = true;
try { notifyOn = localStorage.getItem(NOTIFY_KEY) !== 'off'; } catch (_) { /* private mode */ }

function paintNotify() {
  bellOn.classList.toggle('hidden', !notifyOn);
  bellOff.classList.toggle('hidden', notifyOn);
  notifyBtn.classList.toggle('off', !notifyOn);
  const label = notifyOn ? 'Notifications on' : 'Notifications off';
  notifyBtn.title = label;
  notifyBtn.setAttribute('aria-label', label);
  notifyBtn.setAttribute('aria-pressed', String(notifyOn));
}
paintNotify();

/* Three different places can raise a banner and only one of them is the
   plain `new Notification`, which is why none appeared before:

   - the packaged Android app has no web Notification API at all, and goes
     through the Capacitor plugin;
   - Android browsers refuse the constructor outright and insist the banner
     comes from the service worker;
   - desktop browsers are happy with the constructor.

   They are tried in that order, and whichever one answers is used. */
function localNotifications() {
  const c = window.Capacitor;
  return (c && c.Plugins && c.Plugins.LocalNotifications) || null;
}

let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then((r) => {
    swReg = r;
    // A banner can outlive the page that raised it. If the switch was already
    // off when this launched, anything left in the shade goes now.
    if (!notifyOn) hushBanners();
  }).catch(() => {});
}

// Permission has to be asked for before the first message lands, and off the
// back of a tap -- browsers throw away a request that has no gesture behind
// it, which is the other half of why banners never showed up.
function askForBanners() {
  if (!notifyOn) return;
  const ln = localNotifications();
  if (ln) { Promise.resolve(ln.requestPermissions()).catch(() => {}); return; }
  if ('Notification' in window && Notification.permission === 'default') {
    Promise.resolve(Notification.requestPermission()).catch(() => {});
  }
}

let bannerSeq = 1;
let lastBanner = null;   // the one the plain constructor raised, so it can be taken back
function banner(title, body) {
  const ln = localNotifications();
  if (ln) {
    Promise.resolve(ln.schedule({
      notifications: [{ id: (bannerSeq = (bannerSeq % 2000000) + 1), title, body }],
    })).catch(() => {});
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'td-message', renotify: true };
  if (swReg) { Promise.resolve(swReg.showNotification(title, opts)).catch(() => {}); return; }
  try {
    lastBanner = new Notification(title, opts);
    lastBanner.onclick = () => { window.focus(); lastBanner.close(); };
  } catch (_) { /* the constructor is the one browsers refuse; blip only */ }
}

// Silencing takes back what is already on the screen as well as stopping the
// next one. A banner raised a moment earlier sits in the shade until it is
// pulled, and the point of the switch is that nothing of ours is showing.
function hushBanners() {
  const ln = localNotifications();
  if (ln) { Promise.resolve(ln.removeAllDeliveredNotifications()).catch(() => {}); return; }
  if (swReg) {
    Promise.resolve(swReg.getNotifications({ tag: 'td-message' }))
      .then((open) => open.forEach((n) => n.close()))
      .catch(() => {});
  }
  if (lastBanner) {
    try { lastBanner.close(); } catch (_) { /* already gone */ }
    lastBanner = null;
  }
}

notifyBtn.addEventListener('click', () => {
  notifyOn = !notifyOn;
  try { localStorage.setItem(NOTIFY_KEY, notifyOn ? 'on' : 'off'); } catch (_) { /* private mode */ }
  paintNotify();
  if (!notifyOn) { hushBanners(); return; }
  askForBanners();  // the click is the gesture the ask needs
  ping();           // a short blip, so turning it back on says so out loud
});

// The packaged app has no service worker to hand the leftovers back, so it
// clears its own on the way in.
if (!notifyOn) hushBanners();

function notifyIncoming(msg) {
  if (!notifyOn) return;
  ping();
  banner(msg.from || 'TicketDesk', msg.text || mediaLabel(msg.media));
}

/* ── helpers ── */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function linkify(s) {
  return esc(s).replace(/\b(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function atBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}
function scrollDown(force) {
  if (force || atBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
}
const TICKS = {
  pending: '<svg class="tick" viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6Zm0 2.2v3.4l2.3 1.3"/></svg>',
  sent: '<svg class="tick" viewBox="0 0 16 15"><path fill="currentColor" d="M10.91 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/></svg>',
  double: '<svg class="tick" viewBox="0 0 16 15"><path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/></svg>',
};

function sysline(text) {
  const d = document.createElement('div');
  d.className = 'sysline';
  d.textContent = text;
  messagesEl.appendChild(d);
  lastSide = null;
  scrollDown();
}

/* ── attachments ── */
// Matches the server's ceiling. Photos are shrunk under it automatically;
// anything still over is refused here rather than half-sent.
const MAX_SEND_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_EDGE = 1600;
const IMAGE_SHRINK_OVER = 700 * 1024;

function kindOf(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'file';
}
function prettySize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function blobUrl(data, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime || 'application/octet-stream' }));
  blobUrls.add(url);
  return url;
}
function dropUrl(url) {
  if (!url) return;
  URL.revokeObjectURL(url);
  blobUrls.delete(url);
}
function releaseBlobs() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
}
// What a reply quote says when the message it points at is an attachment.
function mediaLabel(m) {
  if (!m) return '';
  return m.kind === 'image' ? '\uD83D\uDCF7 Photo'
    : m.kind === 'video' ? '\uD83C\uDFAC Video'
    : m.kind === 'audio' ? '\uD83C\uDFB5 Audio'
    : '\uD83D\uDCC4 ' + m.name;
}

// A photo straight off a phone is many times larger than a chat needs, so it
// is redrawn smaller before it goes anywhere. GIFs are left alone -- a canvas
// would flatten them to one frame.
function shrinkImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => resolve(b && b.size < file.size ? b : file), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function toAttachment(file) {
  const kind = kindOf(file.type);
  let blob = file;
  if (kind === 'image' && file.type !== 'image/gif' && file.size > IMAGE_SHRINK_OVER) {
    blob = await shrinkImage(file);
  }
  if (blob.size > MAX_SEND_BYTES) {
    return { error: `${file.name} is ${prettySize(blob.size)} \u2014 too big to send (limit ${prettySize(MAX_SEND_BYTES)}).` };
  }
  const mime = blob.type || file.type || 'application/octet-stream';
  let name = file.name || 'file';
  if (blob !== file) name = name.replace(/\.[^.]+$/, '') + '.jpg';
  return { kind, mime, name, size: blob.size, data: await blob.arrayBuffer() };
}

async function addFiles(files) {
  for (const f of files) {
    const a = await toAttachment(f);
    if (a.error) { sysline(a.error); continue; }
    if (a.kind === 'image') a.preview = blobUrl(a.data, a.mime);
    pending.push(a);
  }
  renderTray();
  inputEl.focus();
}

// Thumbnails of what is about to be sent, each one removable before it goes.
function renderTray() {
  attachTray.classList.toggle('hidden', pending.length === 0);
  attachTray.textContent = '';
  pending.forEach((a) => {
    const chip = document.createElement('div');
    chip.className = 'chip';

    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.preview;
      img.alt = '';
      chip.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'chip-icon';
      icon.textContent = a.kind === 'video' ? '\uD83C\uDFAC' : a.kind === 'audio' ? '\uD83C\uDFB5' : '\uD83D\uDCC4';
      chip.appendChild(icon);
    }

    const label = document.createElement('span');
    label.className = 'chip-name';
    label.textContent = a.name;
    chip.appendChild(label);

    const size = document.createElement('span');
    size.className = 'chip-size';
    size.textContent = prettySize(a.size);
    chip.appendChild(size);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '\u00D7';
    x.setAttribute('aria-label', 'Remove ' + a.name);
    x.addEventListener('click', () => {
      dropUrl(a.preview);
      pending = pending.filter((item) => item !== a);
      renderTray();
    });
    chip.appendChild(x);

    attachTray.appendChild(chip);
  });
}

$('attach-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';   // so picking the same file twice still fires
  addFiles(files);
});

// Paste a screenshot straight in, or drop a file anywhere on the chat.
inputEl.addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
appView.addEventListener('dragover', (e) => { e.preventDefault(); appView.classList.add('dropping'); });
appView.addEventListener('dragleave', (e) => {
  if (e.target === appView) appView.classList.remove('dropping');
});
appView.addEventListener('drop', (e) => {
  e.preventDefault();
  appView.classList.remove('dropping');
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (files.length) addFiles(files);
});

/* ── lightbox ── */
function openLightbox(url, name) {
  lightboxImg.src = url;
  lightboxImg.alt = name || '';
  lightbox.classList.remove('hidden');
}
function closeLightbox() {
  lightbox.classList.add('hidden');
  lightboxImg.removeAttribute('src');
}
lightbox.addEventListener('click', closeLightbox);

/* ── rendering ── */
function renderMedia(m) {
  const url = blobUrl(m.data, m.mime);
  const wrap = document.createElement('div');
  wrap.className = 'media media-' + m.kind;

  if (m.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = m.name;
    // A picture arriving changes the height of the thread, so follow it down.
    img.addEventListener('load', () => scrollDown());
    img.addEventListener('click', () => openLightbox(url, m.name));
    wrap.appendChild(img);
  } else if (m.kind === 'video') {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    wrap.appendChild(v);
  } else if (m.kind === 'audio') {
    const a = document.createElement('audio');
    a.src = url;
    a.controls = true;
    a.preload = 'metadata';
    wrap.appendChild(a);
  } else {
    const link = document.createElement('a');
    link.className = 'file-chip';
    link.href = url;
    link.download = m.name;
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '\uD83D\uDCC4';
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    const nm = document.createElement('span');
    nm.className = 'file-name';
    nm.textContent = m.name;
    const sz = document.createElement('span');
    sz.className = 'file-size';
    sz.textContent = prettySize(m.size) + ' \u00B7 tap to save';
    meta.append(nm, sz);
    link.append(icon, meta);
    wrap.appendChild(link);
  }
  return wrap;
}

function addMessage(msg, mine) {
  const row = document.createElement('div');
  row.className = 'row ' + (mine ? 'out' : 'in') + (lastSide === (mine ? 'out' : 'in') ? '' : ' tail');
  lastSide = mine ? 'out' : 'in';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.replyTo && seenText.has(msg.replyTo)) {
    const q = seenText.get(msg.replyTo);
    const quote = document.createElement('div');
    quote.className = 'quote';
    quote.innerHTML = `<div class="qn">${esc(q.from === me ? 'You' : q.from)}</div><div class="qt">${esc(q.text)}</div>`;
    bubble.appendChild(quote);
  }

  if (msg.media) bubble.appendChild(renderMedia(msg.media));

  // Kept even when empty, so an edit can add a caption to a bare photo.
  const body = document.createElement('div');
  body.className = 'body' + (msg.text ? '' : ' hidden');
  body.innerHTML = linkify(msg.text || '');
  bubble.appendChild(body);

  const meta = document.createElement('div');
  // A photo or clip with no caption has nowhere to put the time but over the
  // picture. A file or audio row keeps it below, where there is space.
  const overMedia = !!msg.media && !msg.text && (msg.media.kind === 'image' || msg.media.kind === 'video');
  meta.className = 'meta' + (overMedia ? ' on-media' : '');
  meta.innerHTML = `<span class="edited hidden">edited</span><span>${clock(msg.at)}</span>${mine ? TICKS.pending : ''}`;
  bubble.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.appendChild(actionBtn('\u21A9', 'Reply', () => startReply(msg.id)));
  // Only your own wording is yours to change, and only where there is text.
  if (mine && msg.text) {
    actions.appendChild(actionBtn('\u270E', 'Edit', () => startEdit(msg.id)));
  }
  bubble.appendChild(actions);

  bubble.addEventListener('dblclick', () => startReply(msg.id));

  // Sits just left of the bubble and is covered by it until a swipe pulls
  // the bubble aside, so it costs no room in the row.
  const hint = document.createElement('div');
  hint.className = 'swipe-hint';
  hint.textContent = '↩';
  hint.setAttribute('aria-hidden', 'true');
  row.append(hint, bubble);
  swipeToReply(row, bubble, msg.id);
  messagesEl.appendChild(row);
  seenText.set(msg.id, { from: msg.from, text: msg.text || mediaLabel(msg.media) });
  bubbles.set(msg.id, { bubble, body, meta, mine });

  if (mine) sent.set(msg.id, { meta });
  scrollDown(mine);
  return bubble;
}

function setTick(id, state) {
  const rec = sent.get(id);
  if (!rec) return;
  const old = rec.meta.querySelector('.tick');
  if (old) old.remove();
  rec.meta.insertAdjacentHTML('beforeend',
    state === 'read' ? TICKS.double.replace('class="tick"', 'class="tick read"')
    : state === 'delivered' ? TICKS.double
    : TICKS.sent);
}

function actionBtn(glyph, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'act';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.textContent = glyph;
  b.addEventListener('click', onClick);
  return b;
}

/* ── typing indicator ── */
let typingRow = null;
function showTyping(on) {
  if (on && !typingRow) {
    typingRow = document.createElement('div');
    typingRow.className = 'row in typing-row tail';
    typingRow.innerHTML = '<div class="bubble"><div class="dots"><span></span><span></span><span></span></div></div>';
    messagesEl.appendChild(typingRow);
    scrollDown();
  } else if (!on && typingRow) {
    typingRow.remove();
    typingRow = null;
  }
}

/* ── reply ── */
// Drag a bubble to the right and let go to answer it, the way a thumb expects
// to. Every listener is passive, so a normal up-and-down scroll is untouched;
// a drag that turns out to be more vertical than sideways hands the gesture
// straight back to the list.
const SWIPE_REPLY = 52;   // px of travel that counts as "reply to this"
const SWIPE_MAX = 74;

function swipeToReply(row, bubble, id) {
  let x0 = 0, y0 = 0, dx = 0, tracking = false;

  const stop = () => {
    tracking = false;
    bubble.style.transition = 'transform .16s ease-out';
    bubble.style.transform = '';
    row.classList.remove('swiping', 'will-reply');
  };

  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    dx = 0;
    tracking = true;
    bubble.style.transition = '';
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const mx = e.touches[0].clientX - x0;
    const my = e.touches[0].clientY - y0;
    if (Math.abs(my) > Math.abs(mx)) { dx = 0; stop(); return; }
    dx = Math.max(0, Math.min(mx, SWIPE_MAX));
    bubble.style.transform = `translateX(${dx}px)`;
    row.classList.add('swiping');
    row.classList.toggle('will-reply', dx >= SWIPE_REPLY);
  }, { passive: true });

  const release = () => {
    if (!tracking) return;
    const far = dx >= SWIPE_REPLY;
    dx = 0;
    stop();
    if (far) startReply(id);
  };
  row.addEventListener('touchend', release, { passive: true });
  row.addEventListener('touchcancel', release, { passive: true });
}

function startReply(id) {
  const q = seenText.get(id);
  if (!q) return;
  replyTo = id;
  replyNameEl.textContent = q.from === me ? 'You' : q.from;
  replyTextEl.textContent = q.text;
  replyBar.classList.remove('hidden');
  inputEl.focus();
}
function cancelReply() {
  replyTo = null;
  replyBar.classList.add('hidden');
}
$('reply-cancel').addEventListener('click', cancelReply);

/* ── edit ── */
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
}

function startEdit(id) {
  const rec = bubbles.get(id);
  const q = seenText.get(id);
  if (!rec || !rec.mine || !q) return;
  cancelReply();
  editing = id;
  editTextEl.textContent = q.text;
  editBar.classList.remove('hidden');
  inputEl.value = q.text;
  autosize();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}
function cancelEdit() {
  if (!editing) return;
  editing = null;
  editBar.classList.add('hidden');
  inputEl.value = '';
  autosize();
}
$('edit-cancel').addEventListener('click', cancelEdit);

// Rewrites one bubble in place and marks it, on whichever screen this runs.
function applyEdit(id, text) {
  const rec = bubbles.get(id);
  if (!rec) return;
  rec.body.innerHTML = linkify(text);
  rec.body.classList.remove('hidden');
  rec.meta.classList.remove('on-media');
  rec.bubble.classList.add('was-edited');
  const tag = rec.meta.querySelector('.edited');
  if (tag) tag.classList.remove('hidden');
  const q = seenText.get(id);
  if (q) q.text = text;
}

/* ── login ── */
const passInput = $('pass-input');
const passField = $('pass-field');
const serverInput = $('server-input');
let myPass = '';

// Show/hide the passcode, so a typo is visible before it is submitted.
$('eye-btn').addEventListener('click', () => {
  const show = passInput.type === 'password';
  passInput.type = show ? 'text' : 'password';
  $('eye-open').classList.toggle('hidden', show);
  $('eye-shut').classList.toggle('hidden', !show);
  $('eye-btn').setAttribute('aria-label', show ? 'Hide booking reference' : 'Show booking reference');
  $('eye-btn').title = show ? 'Hide booking reference' : 'Show booking reference';
  passInput.focus();
});

// A packaged build uses the address baked into server-config.js, or the one
// entered last time. Either way the field stays out of sight until needed.
const DEFAULT_SERVER = normaliseServer(window.BLUE_HEARTS_SERVER || '');
const knownServer = () => savedServer() || DEFAULT_SERVER;

const changeServerBtn = $('change-server');
function revealServerField() {
  serverInput.classList.remove('hidden');
  changeServerBtn.classList.add('hidden');
  serverInput.focus();
}
changeServerBtn.addEventListener('click', revealServerField);

if (PACKAGED) {
  // No origin to probe, so the passcode field is always offered; it may be
  // left blank when the server does not ask for one.
  passField.classList.remove('hidden');
  passInput.placeholder = 'Booking reference';

  const known = knownServer();
  serverInput.value = known;
  if (known) loadConfig(known);  // hides the passcode box if that server wants none
  if (!known) {
    serverInput.classList.remove('hidden');
  } else if (!DEFAULT_SERVER) {
    // Only offer the link when the address was typed in rather than built in;
    // a baked-in build stays a plain name-and-passcode screen. Either way the
    // field comes back by itself if the server cannot be reached.
    changeServerBtn.classList.remove('hidden');
  }
}

// Asks the server whether it wants a passcode, so the field only shows when
// it is actually needed. `base` is '' in the browser (same origin).
function loadConfig(base) {
  return fetch(base + '/config')
    .then((r) => r.json())
    .then((cfg) => { passField.classList.toggle('hidden', !cfg.passcodeRequired); })
    .catch(() => {});
}
if (!PACKAGED) loadConfig('');

// Opens (or reuses) the socket for a packaged build. The socket reconnects on
// its own for as long as the app is running -- a locked screen or a dead
// signal is a pause, never a sign-out.
function connectTo(url) {
  if (socket && socket.io.uri === url) return;
  if (socket) socket.close();
  socket = io(url, { transports: ['websocket', 'polling'] });
  wireSocket(socket);
  socket.on('connect_error', () => {
    // A signed-in app, or one signing itself back in, is simply waiting: the
    // socket retries on its own and a sleeping free-tier server takes half a
    // minute to answer the first knock. Only somebody standing at the form
    // gets told the address looks wrong.
    if (me || restoringAs) return;
    setSigningIn(false);
    loginError.textContent = 'Cannot reach that server. Check the address.';
    if (!DEFAULT_SERVER) revealServerField();
  });
}

// While a kept sign-in is going through there is nothing to fill in, so the
// form steps aside rather than inviting the details to be typed again.
function setSigningIn(on) {
  loginForm.classList.toggle('hidden', on);
  if (on) installBtn.classList.add('hidden');
  loginError.textContent = on ? 'Signing in…' : '';
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  myPass = passInput.value;
  restoringAs = null;
  loginError.textContent = '';
  askForBanners();   // the submit is the gesture the permission ask needs

  if (PACKAGED) {
    const url = normaliseServer(serverInput.value) || knownServer();
    if (!url) {
      loginError.textContent = 'Enter the server address.';
      revealServerField();
      return;
    }
    try { localStorage.setItem(SERVER_KEY, url); } catch (_) {}
    connectTo(url);
  }
  loginError.textContent = 'Checking…';
  joinAs(name);
});

// The one way into the chat, used by the form, by a kept sign-in, and by
// every reconnect afterwards. The name the server hands back is the one that
// counts, so the two sides can never end up disagreeing about who this is.
function joinAs(name) {
  socket.emit('join', { name, passcode: myPass }, (res) => {
    if (!res || !res.ok) {
      // A kept sign-in the server turns down puts the form back with the
      // details still in it, so whichever one changed can just be corrected.
      restoringAs = null;
      setSigningIn(false);
      loginError.textContent = (res && res.error) || 'Cannot reach that server.';
      return;
    }
    const returning = !!me;
    restoringAs = null;
    me = res.name;
    saveSession(me, myPass);
    if (!returning) {
      // Held messages are only ever handed back to the name that left them;
      // anyone else signing in starts on a clean pane. A reconnect is not a
      // sign-in and leaves any running hold timer to updatePresence.
      if (heldFor && heldFor !== me) resetConversation();
      keepHeld();
      setSigningIn(false);
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
      inputEl.focus();
    }
    updatePresence(res.members, res.lastSeen);
  });
}

/* ── staying signed in ── */
// Name of a kept sign-in that has not gone through yet. The socket's connect
// handler joins with it the moment there is a line to the server, so a launch
// with no signal waits rather than dropping back to the login screen.
let restoringAs = null;

function restoreSession() {
  const s = savedSession();
  if (!s || !s.name) return;
  myPass = s.pass || '';
  nameInput.value = s.name;
  passInput.value = myPass;

  if (PACKAGED) {
    const url = knownServer();
    if (!url) return;   // nowhere to sign in to; the form asks for an address
    connectTo(url);
  }
  restoringAs = s.name;
  setSigningIn(true);
  if (socket && socket.connected) joinAs(restoringAs);

  // A sleeping free-tier server takes half a minute to wake. Rather than sit
  // on "Signing in…" indefinitely, the form comes back after a while -- the
  // automatic attempt is still running underneath and wins if it lands first.
  setTimeout(() => {
    if (!restoringAs || me) return;
    setSigningIn(false);
    loginError.textContent = 'Still connecting…';
  }, 15000);
}

/* ── presence ── */
function setStatus(text) {
  peerStatusEl.textContent = text;
  peerStatusEl.classList.remove('typing');
}

// The header says who is here, or "Offline" and when they were last around.
// Today needs no saying, so only a crossed day names itself.
function lastSeenText() {
  if (!peerLastSeen || !peerLastSeen.at || peerLastSeen.name === me) return '';
  const then = new Date(peerLastSeen.at);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight - then) / 86400000) + 1;
  const day = days <= 0 ? ''
    : days === 1 ? 'yesterday'
    : then.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return ['last seen', day, clock(peerLastSeen.at)].filter(Boolean).join(' ');
}

// The server remembers when each name was last here. Anything newer than what
// this device already had is kept, so the name survives a server restart.
function pickLastSeen(seen) {
  let best = null;
  if (Array.isArray(seen)) {
    for (const e of seen) {
      if (!e || !e.name || e.name === me) continue;
      if (!best || e.at > best.at) best = e;
    }
  }
  if (!best) return peerLastSeen;
  rememberPeer(best);
  return best;
}

// The header carries a name and one word about it: Online, or when they were
// last here. Nothing is ever "waiting" or "connecting" -- there is only one
// other person, and either they are here or they are not.
function paintAway() {
  const known = peerLastSeen && peerLastSeen.name !== me ? peerLastSeen : null;
  peerNameEl.textContent = known ? known.name : 'No one yet';
  peerAvatarEl.textContent = known ? known.name[0] : '·';
  // A name with no time behind it is simply offline; the line stays empty only
  // on a device that has never seen the other person at all.
  setStatus(known ? (lastSeenText() || 'Offline') : '');
  showTyping(false);
}

function updatePresence(list, seen) {
  if (!me) return;   // the login screen has no header to fill in
  peerLastSeen = pickLastSeen(seen);
  const others = (list || []).filter((n) => n !== me);
  const had = peer;
  peer = others[0] || null;
  if (peer) {
    // A held conversation belongs to whoever walked out of it. If someone
    // else takes the seat it goes now rather than waiting out the timer.
    if (heldFor && heldFor !== peer) dropHeld();
    else keepHeld();
    // Seeing them is the freshest "last seen" there is, for when they go.
    peerLastSeen = { name: peer, at: Date.now() };
    rememberPeer(peerLastSeen);
    peerNameEl.textContent = peer;
    peerAvatarEl.textContent = peer[0];
    setStatus('Online');
  } else {
    if (had) holdConversation(had);
    paintAway();
  }
}

/* ── sending ── */
function emitMessage(text, media, rt) {
  const id = 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
  addMessage({ id, from: me, text, at: Date.now(), replyTo: rt, media }, true);
  const wire = { id, text, replyTo: rt };
  if (media) wire.media = { kind: media.kind, mime: media.mime, name: media.name, data: media.data };
  socket.emit('message', wire, (res) => {
    if (res && res.ok) setTick(id, res.delivered ? 'delivered' : 'sent');
    else if (res && res.error) sysline(res.error);
  });
}

function send() {
  const text = inputEl.value.replace(/\s+$/, '');

  // While editing, the composer stands in for one existing bubble. Emptying
  // the box is not a delete, so an empty edit is simply ignored.
  if (editing) {
    if (!text.trim()) return;
    const id = editing;
    const q = seenText.get(id);
    if (!q || q.text !== text) {
      applyEdit(id, text);
      socket.emit('edit', { id, text });
    }
    cancelEdit();
    sendTyping(false);
    inputEl.focus();
    return;
  }

  const items = pending;
  if (!text.trim() && !items.length) return;
  pending = [];
  renderTray();

  if (!items.length) {
    emitMessage(text, null, replyTo);
  } else {
    // What was typed becomes the caption on the first attachment; the rest
    // go as messages of their own, and the reply stays with the first.
    items.forEach((a, i) => {
      emitMessage(i === 0 ? text : '', a, i === 0 ? replyTo : null);
      dropUrl(a.preview);   // the bubble made its own URL for the same bytes
    });
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  cancelReply();
  sendTyping(false);
  inputEl.focus();
}
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') { editing ? cancelEdit() : cancelReply(); }
});
inputEl.addEventListener('input', () => {
  autosize();
  sendTyping(inputEl.value.trim().length > 0);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) closeLightbox();
});

let typingSent = false, typingTimer = null;
function sendTyping(on) {
  if (on !== typingSent) { typingSent = on; socket.emit('typing', on); }
  clearTimeout(typingTimer);
  if (on) typingTimer = setTimeout(() => sendTyping(false), 2500);
}

/* ── incoming ── */
function wireSocket(s) {
s.on('message', (msg) => {
  showTyping(false);
  addMessage(msg, false);
  s.emit('seen', [msg.id]);
  // Hidden covers a locked screen and a backgrounded app; the focus check
  // adds a window that is simply behind another one on a desktop.
  if (document.hidden) { unread++; document.title = `(${unread}) TicketDesk`; }
  if (document.hidden || !document.hasFocus()) notifyIncoming(msg);
});
// Guarded so an edit can only ever rewrite the other person's own bubble.
s.on('edit', ({ id, text }) => {
  const rec = bubbles.get(id);
  if (!rec || rec.mine) return;
  applyEdit(id, text);
});
s.on('seen', (ids) => ids.forEach((id) => setTick(id, 'read')));
s.on('typing', ({ typing }) => {
  if (!peer) return;
  peerStatusEl.textContent = typing ? 'typing…' : 'Online';
  peerStatusEl.classList.toggle('typing', typing);
  showTyping(typing);
});
s.on('presence', ({ members, lastSeen }) => {
  updatePresence(members, lastSeen);
  if (members.length > 1) sent.forEach((_, id) => setTick(id, 'delivered'));
});
s.on('clear', () => wipe(false));
s.on('disconnect', () => {
  if (!me) return;
  // The socket comes back by itself, so there is no "reconnecting…" to put in
  // the header. From this screen's side, now is simply the last moment the
  // other person could be seen -- nothing newer can arrive down a dead line.
  if (peer) { peerLastSeen = { name: peer, at: Date.now() }; rememberPeer(peerLastSeen); }
  peer = null;
  paintAway();
});
s.on('connect', () => {
  // `me` is a session already in the chat; `restoringAs` is one kept from
  // last time that has been waiting for a line to the server.
  const name = me || restoringAs;
  if (name) joinAs(name);
});
}
if (socket) wireSocket(socket);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unread = 0; document.title = 'TicketDesk'; }
});

/* ── holding a chat after someone leaves ── */
// Leaving does not throw the conversation away at once. Both screens start
// the same ten-minute timer from the moment the seat empties -- the one who
// left, on their way back to the login screen, and the one still sitting in
// the chat -- so coming straight back finds everything where it was, and
// otherwise it goes on both sides at about the same moment. Clearing by hand
// still works exactly as before and does not wait for any of this.
const HOLD_MS = 10 * 60 * 1000;
let holdTimer = null;
let heldFor = null;   // name the held conversation belongs to

function holdConversation(owner) {
  heldFor = owner;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { holdTimer = null; dropHeld(true); }, HOLD_MS);
}
// Called when whoever left is back before the timer: the chat simply stays.
function keepHeld() {
  clearTimeout(holdTimer);
  holdTimer = null;
  heldFor = null;
}
function dropHeld(timedOut) {
  clearTimeout(holdTimer);
  holdTimer = null;
  heldFor = null;
  if (me) wipe(false, timedOut ? 'Chat cleared — 10 minutes since the other person left' : 'Chat cleared');
  else resetConversation();
}

// Everything the chat pane holds, back to the empty screen it starts as.
function resetConversation() {
  closeLightbox();
  sent.clear();
  seenText.clear();
  bubbles.clear();
  releaseBlobs();
  messagesEl.innerHTML = '';
  lastSide = null;
  typingRow = null;
}

/* ── clear ── */
function wipe(tellPeer, note) {
  closeLightbox();
  messagesEl.innerHTML = '';
  sent.clear();
  seenText.clear();
  bubbles.clear();
  cancelEdit();
  pending = [];
  renderTray();
  releaseBlobs();
  lastSide = null;
  typingRow = null;
  sysline(note || 'Chat cleared');
  if (tellPeer) socket.emit('clear');
}
$('clear-btn').addEventListener('click', () => {
  if (confirm('Clear this chat on both screens?')) wipe(true);
});

/* ── log out ── */
$('logout-btn').addEventListener('click', () => {
  if (!confirm('Log out of this chat?')) return;

  // The conversation itself is left standing behind the login screen for ten
  // minutes, in case this is the same person stepping away and coming back.
  holdConversation(me);

  // Drop the identity first: the reconnect handler re-joins only while there
  // is a name to re-join as. Forgetting the kept sign-in is what makes this
  // button the only way out -- closing the app no longer signs anyone out.
  forgetSession();
  forgetPeer();
  peerLastSeen = null;
  restoringAs = null;
  me = null;
  peer = null;
  myPass = '';
  replyTo = null;
  unread = 0;
  document.title = 'TicketDesk';
  pending = [];        // attachments picked but never sent are not a chat
  renderTray();
  closeLightbox();
  showTyping(false);
  cancelEdit();
  cancelReply();
  inputEl.value = '';
  inputEl.style.height = 'auto';
  passInput.value = '';
  loginError.textContent = '';

  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  nameInput.focus();

  // Bounce the socket so the other side sees us leave and the seat frees up.
  if (socket) {
    socket.disconnect();
    socket.connect();
  }
});

/* ── emoji ── */
const EMOJI = '💙 😀 😂 🥹 😍 🥰 😘 😉 😎 🤗 🤔 😴 😭 😅 🙃 😇 🤭 🥳 😤 🙄 👍 👏 🙏 🤝 💪 🫶 ❤️ 💔 ✨ 🔥 🎉 🎂 🌸 🌙 ☕ 🍕 🚀 📞 ⏰ ✅'.split(' ');
emojiPanel.innerHTML = EMOJI.map((e) => `<button type="button">${e}</button>`).join('');
emojiPanel.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  inputEl.value += e.target.textContent;
  inputEl.focus();
  sendTyping(true);
});
$('emoji-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!emojiPanel.contains(e.target)) emojiPanel.classList.add('hidden');
});

/* ── notification blip ── */
let ac = null;
function ping() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.setValueAtTime(880, ac.currentTime);
    g.gain.setValueAtTime(0.001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.28);
    o.start(); o.stop(ac.currentTime + 0.3);
  } catch (_) { /* sound is optional */ }
}

/* ── installable app ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Android/desktop Chrome fires this when the app qualifies to be installed.
let installPrompt = null;
const installBtn = $('install-btn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installBtn.classList.add('hidden');
});
window.addEventListener('appinstalled', () => installBtn.classList.add('hidden'));

// A kept sign-in arrives with no tap behind it, so the permission ask waits
// for the first touch of the chat rather than being thrown away unasked.
appView.addEventListener('pointerdown', () => askForBanners(), { once: true });

nameInput.focus();
restoreSession();

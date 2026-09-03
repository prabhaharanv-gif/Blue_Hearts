/* Blue Hearts — two-person chat client.
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

  row.appendChild(bubble);
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
  $('eye-btn').setAttribute('aria-label', show ? 'Hide passcode' : 'Show passcode');
  $('eye-btn').title = show ? 'Hide passcode' : 'Show passcode';
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
  passInput.placeholder = 'Passcode';

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

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  myPass = passInput.value;
  loginError.textContent = '';

  if (PACKAGED) {
    const url = normaliseServer(serverInput.value) || knownServer();
    if (!url) {
      loginError.textContent = 'Enter the server address.';
      revealServerField();
      return;
    }
    try { localStorage.setItem(SERVER_KEY, url); } catch (_) {}
    if (!socket || socket.io.uri !== url) {
      if (socket) socket.close();
      socket = io(url, { transports: ['websocket', 'polling'], reconnectionAttempts: 8 });
      wireSocket(socket);
      socket.on('connect_error', () => {
        // Surface the field again so a wrong address can be corrected.
        loginError.textContent = 'Cannot reach that server. Check the address.';
        revealServerField();
      });
    }
  }
  doJoin(name);
});

function doJoin(name) {
  loginError.textContent = 'Connecting…';
  socket.emit('join', { name, passcode: myPass }, (res) => {
    if (!res.ok) { loginError.textContent = res.error; return; }
    loginError.textContent = '';
    me = res.name;
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    inputEl.focus();
    updatePresence(res.members);
  });
}

/* ── presence ── */
function updatePresence(list) {
  const others = (list || []).filter((n) => n !== me);
  peer = others[0] || null;
  if (peer) {
    peerNameEl.textContent = peer;
    peerAvatarEl.textContent = peer[0];
    peerStatusEl.textContent = 'online';
    peerStatusEl.classList.remove('typing');
  } else {
    peerNameEl.textContent = 'Waiting…';
    peerAvatarEl.textContent = '·';
    peerStatusEl.textContent = 'no one else here yet';
    peerStatusEl.classList.remove('typing');
    showTyping(false);
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
  if (document.hidden) { unread++; document.title = `(${unread}) Blue Hearts`; ping(); }
});
// Guarded so an edit can only ever rewrite the other person's own bubble.
s.on('edit', ({ id, text }) => {
  const rec = bubbles.get(id);
  if (!rec || rec.mine) return;
  applyEdit(id, text);
});
s.on('seen', (ids) => ids.forEach((id) => setTick(id, 'read')));
s.on('typing', ({ typing }) => {
  peerStatusEl.textContent = typing ? 'typing…' : 'online';
  peerStatusEl.classList.toggle('typing', typing);
  showTyping(typing);
});
s.on('presence', ({ members }) => {
  updatePresence(members);
  if (members.length > 1) sent.forEach((_, id) => setTick(id, 'delivered'));
});
s.on('system', ({ text }) => sysline(text));
s.on('clear', () => wipe(false));
s.on('disconnect', () => { peerStatusEl.textContent = 'reconnecting…'; });
s.on('connect', () => {
  if (me) s.emit('join', { name: me, passcode: myPass }, (res) => {
    if (res.ok) updatePresence(res.members);
  });
});
}
if (socket) wireSocket(socket);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unread = 0; document.title = 'Blue Hearts'; }
});

/* ── clear ── */
function wipe(tellPeer) {
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
  sysline('Chat cleared');
  if (tellPeer) socket.emit('clear');
}
$('clear-btn').addEventListener('click', () => {
  if (confirm('Clear this chat on both screens?')) wipe(true);
});

/* ── log out ── */
// Captured before anything is appended, so a logout restores the day chip
// and the privacy notice exactly as they started.
const MESSAGES_INITIAL = messagesEl.innerHTML;

$('logout-btn').addEventListener('click', () => {
  if (!confirm('Log out of this chat?')) return;

  // Drop the identity first: the reconnect handler re-joins only when `me`
  // is still set, and this leaves nothing of the conversation behind.
  me = null;
  peer = null;
  myPass = '';
  replyTo = null;
  unread = 0;
  document.title = 'Blue Hearts';
  sent.clear();
  seenText.clear();
  bubbles.clear();
  pending = [];
  renderTray();
  closeLightbox();
  releaseBlobs();
  lastSide = null;
  typingRow = null;
  messagesEl.innerHTML = MESSAGES_INITIAL;
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

nameInput.focus();

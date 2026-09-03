/* Blue Hearts — two-person chat client.
   Every message lives in this page's memory only. Refresh = gone. */

const socket = io({ autoConnect: true });

const $ = (id) => document.getElementById(id);
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

let me = null;
let peer = null;
let replyTo = null;
let lastSide = null;
let unread = 0;
const sent = new Map();   // id -> { el, tickEl }
const seenText = new Map(); // id -> { from, text }  (for reply quotes, in memory only)

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

/* ── rendering ── */
function addMessage(msg, mine) {
  const row = document.createElement('div');
  row.className = 'row ' + (mine ? 'out' : 'in') + (lastSide === (mine ? 'out' : 'in') ? '' : ' tail');
  lastSide = mine ? 'out' : 'in';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  let html = '';
  if (msg.replyTo && seenText.has(msg.replyTo)) {
    const q = seenText.get(msg.replyTo);
    html += `<div class="quote"><div class="qn">${esc(q.from === me ? 'You' : q.from)}</div><div class="qt">${esc(q.text)}</div></div>`;
  }
  html += `<div class="body">${linkify(msg.text)}</div>`;
  html += `<div class="meta"><span>${clock(msg.at)}</span>${mine ? TICKS.pending : ''}</div>`;
  html += `<button class="reply-btn" title="Reply">↩</button>`;
  bubble.innerHTML = html;

  bubble.querySelector('.reply-btn').addEventListener('click', () => startReply(msg.id));
  bubble.addEventListener('dblclick', () => startReply(msg.id));

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  seenText.set(msg.id, { from: msg.from, text: msg.text });

  if (mine) sent.set(msg.id, { meta: bubble.querySelector('.meta') });
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

/* ── login ── */
const passInput = $('pass-input');
let myPass = '';

fetch('/config')
  .then((r) => r.json())
  .then((cfg) => { if (cfg.passcodeRequired) passInput.classList.remove('hidden'); })
  .catch(() => {});

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  myPass = passInput.value;
  loginError.textContent = '';
  socket.emit('join', { name, passcode: myPass }, (res) => {
    if (!res.ok) { loginError.textContent = res.error; return; }
    me = res.name;
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    inputEl.focus();
    updatePresence(res.members);
  });
});

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
function send() {
  const text = inputEl.value.replace(/\s+$/, '');
  if (!text.trim()) return;
  const id = 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
  const msg = { id, from: me, text, at: Date.now(), replyTo };
  addMessage(msg, true);
  socket.emit('message', { id, text, replyTo }, (res) => {
    if (res && res.ok) setTick(id, res.delivered ? 'delivered' : 'sent');
  });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  cancelReply();
  sendTyping(false);
  inputEl.focus();
}
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
  sendTyping(inputEl.value.trim().length > 0);
});

let typingSent = false, typingTimer = null;
function sendTyping(on) {
  if (on !== typingSent) { typingSent = on; socket.emit('typing', on); }
  clearTimeout(typingTimer);
  if (on) typingTimer = setTimeout(() => sendTyping(false), 2500);
}

/* ── incoming ── */
socket.on('message', (msg) => {
  showTyping(false);
  addMessage(msg, false);
  socket.emit('seen', [msg.id]);
  if (document.hidden) { unread++; document.title = `(${unread}) Blue Hearts`; ping(); }
});
socket.on('seen', (ids) => ids.forEach((id) => setTick(id, 'read')));
socket.on('typing', ({ typing }) => {
  peerStatusEl.textContent = typing ? 'typing…' : 'online';
  peerStatusEl.classList.toggle('typing', typing);
  showTyping(typing);
});
socket.on('presence', ({ members }) => {
  updatePresence(members);
  if (members.length > 1) sent.forEach((_, id) => setTick(id, 'delivered'));
});
socket.on('system', ({ text }) => sysline(text));
socket.on('clear', () => wipe(false));
socket.on('disconnect', () => { peerStatusEl.textContent = 'reconnecting…'; });
socket.on('connect', () => {
  if (me) socket.emit('join', { name: me, passcode: myPass }, (res) => {
    if (res.ok) updatePresence(res.members);
  });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unread = 0; document.title = 'Blue Hearts'; }
});

/* ── clear ── */
function wipe(tellPeer) {
  messagesEl.innerHTML = '';
  sent.clear();
  seenText.clear();
  lastSide = null;
  typingRow = null;
  sysline('Chat cleared');
  if (tellPeer) socket.emit('clear');
}
$('clear-btn').addEventListener('click', () => {
  if (confirm('Clear this chat on both screens?')) wipe(true);
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

nameInput.focus();

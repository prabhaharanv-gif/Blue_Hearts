const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// The packaged Android app loads from its own origin, so the socket and the
// /config probe have to be reachable cross-origin. The passcode is what
// actually guards the room.
const io = new Server(server, {
  maxHttpBufferSize: 12e6,
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = 2;
// Biggest attachment we relay. Photos are shrunk in the browser before they
// get here; anything larger is refused there with a message.
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'file']);
// Shared secret both of you type at login. Set PASSCODE in the host's
// environment; empty means anyone with the link can walk in.
const PASSCODE = (process.env.PASSCODE || '').trim();

// Everything here lives in RAM only. Nothing is written to disk, and this map
// is emptied the moment a socket disconnects -- no message history is kept.
const members = new Map(); // socketId -> { name }

// The one thing that outlives a socket: when each name was last here, so the
// other screen can keep that name in its header and say when it was around.
// Still RAM only, still no message ever kept, and it goes with the process.
const lastSeen = new Map(); // name -> timestamp
const LAST_SEEN_KEPT = 8;

function markSeen(name) {
  lastSeen.delete(name);
  lastSeen.set(name, Date.now());
  while (lastSeen.size > LAST_SEEN_KEPT) {
    lastSeen.delete(lastSeen.keys().next().value);
  }
}

function seenList() {
  return [...lastSeen].map(([name, at]) => ({ name, at }));
}

function roster() {
  return [...members.values()].map((m) => m.name);
}

function broadcastPresence() {
  io.emit('presence', { members: roster(), lastSeen: seenList() });
}

app.use(express.static(path.join(__dirname, 'public')));

// Lets the login screen know whether to show the passcode field.
app.get('/config', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ passcodeRequired: !!PASSCODE });
});

// Attachments arrive as binary and are handed straight to the other socket.
// Nothing is decoded, written down, or kept once the relay call returns.
function cleanMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const data = m.data;
  const bytes = data && typeof data.byteLength === 'number' ? data.byteLength : 0;
  if (!bytes || bytes > MAX_MEDIA_BYTES) return null;
  return {
    kind: MEDIA_KINDS.has(m.kind) ? m.kind : 'file',
    mime: String(m.mime || 'application/octet-stream').slice(0, 100),
    name: String(m.name || 'file').slice(0, 120),
    size: bytes,
    data,
  };
}

io.on('connection', (socket) => {
  socket.on('join', (payload, ack) => {
    const raw = typeof payload === 'string' ? { name: payload } : payload || {};
    const name = String(raw.name || '').trim().slice(0, 24);
    if (!name) {
      return ack && ack({ ok: false, error: 'Enter the passenger name.' });
    }
    if (PASSCODE && String(raw.passcode || '').trim() !== PASSCODE) {
      return ack && ack({ ok: false, error: 'No booking found.' });
    }
    // A phone that slept, or a screen that reloaded, comes back on a fresh
    // socket while the old one is still counted. Rather than tell the same
    // person their own name is taken, the stale seat is handed over. Taking
    // it out of the roster first leaves its disconnect nothing to report, so
    // no departure is announced and no last-seen time is written for it.
    for (const [id, m] of members) {
      if (id === socket.id || m.name.toLowerCase() !== name.toLowerCase()) continue;
      members.delete(id);
      const stale = io.sockets.sockets.get(id);
      if (stale) stale.disconnect(true);
    }
    if (members.size >= MAX_MEMBERS && !members.has(socket.id)) {
      return ack && ack({ ok: false, error: 'Not allowed.' });
    }

    members.set(socket.id, { name });
    socket.data.name = name;
    ack && ack({ ok: true, name, members: roster(), lastSeen: seenList() });
    broadcastPresence();
  });

  socket.on('message', (payload, ack) => {
    const me = members.get(socket.id);
    if (!me) return;
    const text = String(payload && payload.text ? payload.text : '').slice(0, 4000);
    const wanted = payload && payload.media;
    const media = cleanMedia(wanted);
    // An attachment that cannot be relayed fails the whole message, rather
    // than quietly arriving as a caption with no picture under it.
    if (wanted && !media) {
      return ack && ack({ ok: false, error: 'That file is too large to send.' });
    }
    // A picture on its own is a message; plain text still has to say something.
    if (!text.trim() && !media) {
      return ack && ack({ ok: false, error: 'Empty message.' });
    }

    const msg = {
      id: payload && payload.id ? String(payload.id).slice(0, 40) : String(Date.now()),
      from: me.name,
      text,
      at: Date.now(),
      replyTo: payload && payload.replyTo ? payload.replyTo : null,
      media,
    };
    // Relayed straight through to the other socket and then forgotten.
    socket.broadcast.emit('message', msg);
    ack && ack({ ok: true, id: msg.id, at: msg.at, delivered: members.size > 1 });
  });

  // The server keeps no history, so there is nothing here to rewrite -- the
  // new wording is passed on and each screen updates its own copy. The sender
  // only offers this on its own messages, and the receiver only applies it to
  // messages that came from the other person.
  socket.on('edit', (payload, ack) => {
    const me = members.get(socket.id);
    if (!me) return;
    const id = String((payload && payload.id) || '').slice(0, 40);
    const text = String((payload && payload.text) || '').slice(0, 4000);
    if (!id || !text.trim()) return;
    socket.broadcast.emit('edit', { id, from: me.name, text, at: Date.now() });
    ack && ack({ ok: true });
  });

  socket.on('typing', (isTyping) => {
    const me = members.get(socket.id);
    if (!me) return;
    socket.broadcast.emit('typing', { name: me.name, typing: !!isTyping });
  });

  socket.on('seen', (ids) => {
    if (!members.get(socket.id)) return;
    socket.broadcast.emit('seen', Array.isArray(ids) ? ids.slice(0, 200) : []);
  });

  socket.on('clear', () => {
    if (!members.get(socket.id)) return;
    socket.broadcast.emit('clear');
  });

  socket.on('disconnect', () => {
    const me = members.get(socket.id);
    if (!me) return;
    members.delete(socket.id);
    markSeen(me.name);
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`TicketDesk running:`);
  console.log(`  local    http://localhost:${PORT}`);
  for (const [, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  network  http://${a.address}:${PORT}`);
      }
    }
  }
});

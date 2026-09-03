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
  maxHttpBufferSize: 2e6,
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = 2;
// Shared secret both of you type at login. Set PASSCODE in the host's
// environment; empty means anyone with the link can walk in.
const PASSCODE = (process.env.PASSCODE || '').trim();

// Everything here lives in RAM only. Nothing is written to disk, and this map
// is emptied the moment a socket disconnects -- no message history is kept.
const members = new Map(); // socketId -> { name }

function roster() {
  return [...members.values()].map((m) => m.name);
}

function broadcastPresence() {
  io.emit('presence', { members: roster() });
}

app.use(express.static(path.join(__dirname, 'public')));

// Lets the login screen know whether to show the passcode field.
app.get('/config', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ passcodeRequired: !!PASSCODE });
});

io.on('connection', (socket) => {
  socket.on('join', (payload, ack) => {
    const raw = typeof payload === 'string' ? { name: payload } : payload || {};
    const name = String(raw.name || '').trim().slice(0, 24);
    if (!name) {
      return ack && ack({ ok: false, error: 'Please enter a name.' });
    }
    if (PASSCODE && String(raw.passcode || '').trim() !== PASSCODE) {
      return ack && ack({ ok: false, error: 'Wrong passcode.' });
    }
    if (members.size >= MAX_MEMBERS) {
      return ack && ack({ ok: false, error: 'Not allowed.' });
    }
    const taken = [...members.values()].some(
      (m) => m.name.toLowerCase() === name.toLowerCase()
    );
    if (taken) {
      return ack && ack({ ok: false, error: 'That name is already in the chat.' });
    }

    members.set(socket.id, { name });
    socket.data.name = name;
    ack && ack({ ok: true, name, members: roster() });
    socket.broadcast.emit('system', { text: `${name} joined` });
    broadcastPresence();
  });

  socket.on('message', (payload, ack) => {
    const me = members.get(socket.id);
    if (!me) return;
    const text = String(payload && payload.text ? payload.text : '').slice(0, 4000);
    if (!text.trim()) return;

    const msg = {
      id: payload && payload.id ? String(payload.id).slice(0, 40) : String(Date.now()),
      from: me.name,
      text,
      at: Date.now(),
      replyTo: payload && payload.replyTo ? payload.replyTo : null,
    };
    // Relayed straight through to the other socket and then forgotten.
    socket.broadcast.emit('message', msg);
    ack && ack({ ok: true, id: msg.id, at: msg.at, delivered: members.size > 1 });
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
    io.emit('system', { text: `${me.name} left` });
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Blue Hearts chat running:`);
  console.log(`  local    http://localhost:${PORT}`);
  for (const [, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  network  http://${a.address}:${PORT}`);
      }
    }
  }
});

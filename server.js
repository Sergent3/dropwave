'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookie     = require('cookie');
const Database   = require('better-sqlite3');

// Genera un token monouso crittograficamente sicuro (32 byte hex = 64 char)
const genPeerToken = () => crypto.randomBytes(32).toString('hex');

// ── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dropwave-dev-secret-CHANGE-IN-PRODUCTION';
const JWT_TTL    = '7d';
const COOKIE     = 'dw_token';
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'data', 'users.db');

// ── Database ──────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    username   TEXT    NOT NULL,
    password   TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// ── Helpers ───────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_TTL });
}

function verifyToken(raw) {
  try   { return jwt.verify(raw, JWT_SECRET); }
  catch { return null; }
}

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   7 * 24 * 60 * 60 * 1000,
};

// ── Express ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes ───────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body ?? {};
  if (!email || !username || !password)
    return res.status(400).json({ error: 'Tutti i campi sono obbligatori.' });
  if (username.trim().length < 2 || username.trim().length > 32)
    return res.status(400).json({ error: 'Nome utente: 2–32 caratteri.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email non valida.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password: minimo 8 caratteri.' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const info = db.prepare(
      'INSERT INTO users (email, username, password) VALUES (?, ?, ?)'
    ).run(email.trim().toLowerCase(), username.trim(), hash);

    const user  = { id: info.lastInsertRowid, username: username.trim() };
    const token = signToken(user);
    res.cookie(COOKIE, token, cookieOpts).status(201).json({ ok: true, username: user.username });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'Email già registrata.' });
    console.error(e);
    res.status(500).json({ error: 'Errore interno. Riprova.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password)
    return res.status(400).json({ error: 'Inserisci email e password.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Email o password errati.' });

  const token = signToken(user);
  res.cookie(COOKIE, token, cookieOpts).json({ ok: true, username: user.username });
});

app.post('/api/auth/logout', (_, res) => {
  res.clearCookie(COOKIE).json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const raw     = cookie.parse(req.headers.cookie || '')[COOKIE];
  const payload = verifyToken(raw);
  if (!payload) return res.status(401).json({ error: 'Non autenticato.' });
  res.json({ id: payload.sub, username: payload.username });
});

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

// ── Socket.io ─────────────────────────────────────────────────────────────
const io = new Server(server);

// Auth middleware — runs before every connection
io.use((socket, next) => {
  const raw     = cookie.parse(socket.handshake.headers.cookie || '')[COOKIE];
  const payload = verifyToken(raw);
  if (!payload) return next(new Error('AUTH_REQUIRED'));
  socket.data.userId   = payload.sub;
  socket.data.username = payload.username;
  next();
});

// Rooms: roomId → { sender: {socketId, username, token}, receiver?: {socketId, username, token} }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[+] ${socket.data.username} (${socket.id})`);

  socket.on('create-room', (roomId) => {
    if (rooms.has(roomId)) { socket.emit('room-error', 'Stanza già esistente. Riprova.'); return; }

    // Genera il token monouso del sender
    const senderToken = genPeerToken();
    rooms.set(roomId, {
      sender: { socketId: socket.id, username: socket.data.username, token: senderToken },
    });
    socket.join(roomId);
    socket.data.roomId = roomId;

    // Il sender riceve solo il suo token (non sa ancora chi arriverà)
    socket.emit('room-created', roomId, senderToken);
    console.log(`[R] created: ${roomId} by ${socket.data.username}`);
  });

  socket.on('join-room', (roomId) => {
    const room = rooms.get(roomId);
    if (!room)          { socket.emit('room-error', 'Stanza non trovata. Controlla il codice.'); return; }
    if (room.receiver)  { socket.emit('room-error', 'Stanza piena (max 2 partecipanti).'); return; }

    // Genera il token monouso del receiver
    const receiverToken = genPeerToken();
    room.receiver = { socketId: socket.id, username: socket.data.username, token: receiverToken };
    socket.join(roomId);
    socket.data.roomId = roomId;

    // Il receiver riceve: il suo token + il token atteso del sender (per verificarlo sul DC)
    socket.emit('room-joined', roomId, receiverToken, room.sender.token);

    // Il sender riceve: username del peer + token atteso del receiver (per verificarlo sul DC)
    socket.to(roomId).emit('peer-joined', {
      username:      socket.data.username,
      expectedToken: receiverToken,   // il sender dovrà ricevere questo dal DC
    });
    console.log(`[R] joined: ${roomId} by ${socket.data.username}`);
  });

  // WebRTC signaling — pure relay
  socket.on('offer',         ({ roomId, offer })     => socket.to(roomId).emit('offer', offer));
  socket.on('answer',        ({ roomId, answer })    => socket.to(roomId).emit('answer', answer));
  socket.on('ice-candidate', ({ roomId, candidate }) => socket.to(roomId).emit('ice-candidate', candidate));

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      rooms.delete(roomId);   // elimina anche i token monouso
      socket.to(roomId).emit('peer-disconnected');
      console.log(`[-] Room ${roomId} closed`);
    }
    console.log(`[-] ${socket.data.username} (${socket.id})`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌊  DropWave v2  —  http://0.0.0.0:${PORT}\n`);
});

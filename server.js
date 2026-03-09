'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookie     = require('cookie');
const Database   = require('better-sqlite3');

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

// ── JWT helpers ───────────────────────────────────────────────────────────
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
    // token nel body: usato dai client CLI; httpOnly cookie: usato dai browser
    res.cookie(COOKIE, token, cookieOpts)
       .status(201)
       .json({ ok: true, username: user.username, token });
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
  // token nel body per CLI, cookie per browser
  res.cookie(COOKIE, token, cookieOpts)
     .json({ ok: true, username: user.username, token });
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

// Auth middleware: browser invia cookie httpOnly, CLI invia token in handshake.auth
io.use((socket, next) => {
  const fromCookie = cookie.parse(socket.handshake.headers.cookie || '')[COOKIE];
  const fromAuth   = socket.handshake.auth?.token;
  const payload    = verifyToken(fromCookie) || verifyToken(fromAuth);
  if (!payload) return next(new Error('AUTH_REQUIRED'));
  socket.data.userId   = payload.sub;
  socket.data.username = payload.username;
  next();
});

// Rooms: roomId → { sender: {socketId, username}, receiver?: {socketId, username} }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[+] ${socket.data.username} (${socket.id})`);

  socket.on('create-room', (roomId) => {
    if (rooms.has(roomId)) { socket.emit('room-error', 'Stanza già esistente. Riprova.'); return; }
    rooms.set(roomId, {
      sender: { socketId: socket.id, username: socket.data.username },
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('room-created', roomId);
    console.log(`[R] created: ${roomId} by ${socket.data.username}`);
  });

  socket.on('join-room', (roomId) => {
    const room = rooms.get(roomId);
    if (!room)         { socket.emit('room-error', 'Stanza non trovata. Controlla il codice.'); return; }
    if (room.receiver) { socket.emit('room-error', 'Stanza piena (max 2 partecipanti).'); return; }

    room.receiver = { socketId: socket.id, username: socket.data.username };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('room-joined', roomId);
    socket.to(roomId).emit('peer-joined', { username: socket.data.username });
    console.log(`[R] joined: ${roomId} by ${socket.data.username}`);
  });

  // ── Relay — il server è un puro corriere, non tocca il contenuto ─────────

  // Messaggi di controllo JSON (file-list, file-start, file-end, xfer-done)
  socket.on('relay-ctrl', (msg) => {
    if (!socket.data.roomId) return;
    socket.to(socket.data.roomId).emit('relay-ctrl', msg);
  });

  // Chunk binari (Buffer dal CLI, ArrayBuffer dal browser)
  socket.on('relay-chunk', (chunk, ack) => {
    if (!socket.data.roomId) return;
    socket.to(socket.data.roomId).emit('relay-chunk', chunk);
    if (typeof ack === 'function') ack(); // conferma al CLI sender
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      rooms.delete(roomId);
      socket.to(roomId).emit('peer-disconnected');
      console.log(`[-] Room ${roomId} closed`);
    }
    console.log(`[-] ${socket.data.username} (${socket.id})`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌊  DropWave v3  —  http://0.0.0.0:${PORT}\n`);
});

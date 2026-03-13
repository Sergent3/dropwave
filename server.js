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
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id          TEXT    NOT NULL UNIQUE,
    sender_user_id  INTEGER NOT NULL,
    sender_socket_id TEXT,
    receiver_user_id INTEGER NOT NULL,
    receiver_socket_id TEXT,
    file_manifest   TEXT    NOT NULL DEFAULT '[]',
    status          TEXT    NOT NULL DEFAULT 'queued',
    scheduled_at    INTEGER,
    started_at      INTEGER,
    finished_at     INTEGER,
    error_msg       TEXT,
    room_id         TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS transfer_integrity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL,
    filename     TEXT NOT NULL,
    expected_sha TEXT NOT NULL,
    received_sha TEXT,
    ok           INTEGER,
    checked_at   INTEGER
  );
`);

// ── JWT ───────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_TTL });
}
function verifyToken(raw) {
  try   { return jwt.verify(raw, JWT_SECRET); }
  catch { return null; }
}
const cookieOpts = {
  httpOnly: true, sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ── Express ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve la SPA anche su /device
app.get('/device', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Serve il CLI client scaricabile
app.get('/client.js', (_, res) =>
  res.sendFile(path.join(__dirname, 'client.js')));

app.get('/agent.js',   (_, res) => res.sendFile(path.join(__dirname, 'agent.js')));
app.get('/install.sh', (_, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'install.sh'));
});

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
    res.cookie(COOKIE, token, cookieOpts).status(201)
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
  res.cookie(COOKIE, token, cookieOpts).json({ ok: true, username: user.username, token });
});

app.post('/api/auth/logout', (_, res) => res.clearCookie(COOKIE).json({ ok: true }));

app.get('/api/auth/me', (req, res) => {
  const raw     = cookie.parse(req.headers.cookie || '')[COOKIE];
  const payload = verifyToken(raw);
  if (!payload) return res.status(401).json({ error: 'Non autenticato.' });
  res.json({ id: payload.sub, username: payload.username });
});

app.get('/health', (_, res) => res.json({ status: 'ok', devices: devices.size, rooms: rooms.size }));

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const payload = verifyToken(cookies[COOKIE]);
  if (!payload) return res.status(401).json({ error: 'Non autenticato' });
  req.user = payload;
  next();
}

// ── REST API trasferimenti ─────────────────────────────────────────────────
app.get('/api/transfers', requireAuth, function(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows  = db.prepare(`
    SELECT t.*,
           su.username AS sender_username,
           ru.username AS receiver_username
    FROM transfers t
    LEFT JOIN users su ON su.id = t.sender_user_id
    LEFT JOIN users ru ON ru.id = t.receiver_user_id
    ORDER BY t.created_at DESC LIMIT ?
  `).all(limit);
  res.json(rows.map(function(r) { return Object.assign({}, r, { file_manifest: JSON.parse(r.file_manifest || '[]') }); }));
});

app.patch('/api/transfers/:jobId', requireAuth, function(req, res) {
  const jobId = req.params.jobId;
  const job = db.prepare('SELECT * FROM transfers WHERE job_id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job non trovato' });

  if (req.body.status === 'cancelled') {
    db.prepare("UPDATE transfers SET status='cancelled', finished_at=unixepoch() WHERE job_id=?").run(jobId);
    if (job.room_id) { io.to(job.room_id).emit('peer-disconnected'); rooms.delete(job.room_id); }
    scheduleNext();
    return res.json({ ok: true });
  }

  if (req.body.scheduledAt) {
    const ts = Math.floor(new Date(req.body.scheduledAt).getTime() / 1000);
    db.prepare("UPDATE transfers SET scheduled_at=? WHERE job_id=? AND status='queued'").run(ts, jobId);
    scheduleNext();
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Azione non supportata' });
});

app.delete('/api/transfers/:jobId', requireAuth, function(req, res) {
  var jobId = req.params.jobId;
  db.prepare('DELETE FROM transfer_integrity WHERE job_id = ?').run(jobId);
  var result = db.prepare('DELETE FROM transfers WHERE job_id = ?').run(jobId);
  if (!result.changes) return res.status(404).json({ error: 'Job non trovato' });
  res.json({ ok: true });
});

app.delete('/api/transfers', requireAuth, function(req, res) {
  db.prepare('DELETE FROM transfer_integrity').run();
  db.prepare('DELETE FROM transfers').run();
  res.json({ ok: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────
const io = new Server(server);

// Auth middleware: cookie (browser) oppure handshake.auth.token (CLI)
io.use((socket, next) => {
  const fromCookie = cookie.parse(socket.handshake.headers.cookie || '')[COOKIE];
  const fromAuth   = socket.handshake.auth?.token;
  const payload    = verifyToken(fromCookie) || verifyToken(fromAuth);
  if (!payload) return next(new Error('AUTH_REQUIRED'));
  socket.data.userId   = payload.sub;
  socket.data.username = payload.username;
  next();
});

// ── Stato globale ─────────────────────────────────────────────────────────
// devices:  socketId → { socketId, username, ip, status, connectedAt }
// rooms:    roomId   → { sender: {socketId, username}, receiver: {socketId, username} }
const devices          = new Map();
const rooms            = new Map();
const userSockets      = new Map(); // userId → Set<socketId>
const pendingReceivers = new Map(); // senderSocketId → { receiverSock, data, timer }
const fsPendingRequests = new Map(); // reqId → adminSocketId

// ── LAN direct: sender-first session pairing ──────────────────────────────
// Sends session-ready to sender first; when sender reports local-addrs (HTTP port),
// forwards session-ready to receiver with senderLocalAddrs. Falls back to relay after 3s.
function sendSessionReadyPair(senderSock, senderData, receiverSock, receiverData) {
  senderSock.emit('session-ready', senderData);

  var fallbackTimer = setTimeout(function() {
    pendingReceivers.delete(senderSock.id);
    receiverData.senderLocalAddrs = null;
    receiverSock.emit('session-ready', receiverData);
  }, 3000);

  pendingReceivers.set(senderSock.id, {
    receiverSock:  receiverSock,
    receiverData:  receiverData,
    timer:         fallbackTimer,
  });
}

// ── Scheduler ─────────────────────────────────────────────────────────────
let schedulerTimer = null;

function scheduleNext() {
  clearTimeout(schedulerTimer);
  const next = db.prepare(
    "SELECT job_id, scheduled_at FROM transfers WHERE status='queued' AND scheduled_at IS NOT NULL ORDER BY scheduled_at ASC LIMIT 1"
  ).get();
  if (!next) return;
  const delay = Math.max(0, next.scheduled_at * 1000 - Date.now());
  schedulerTimer = setTimeout(function() {
    dispatchJob(next.job_id);
    scheduleNext();
  }, delay);
}

function dispatchJob(jobId) {
  const job = db.prepare('SELECT * FROM transfers WHERE job_id = ?').get(jobId);
  if (!job || job.status !== 'queued') return;

  const senderSocket   = job.sender_socket_id ? io.sockets.sockets.get(job.sender_socket_id) : null;
  const receiverSocket = job.receiver_socket_id ? io.sockets.sockets.get(job.receiver_socket_id) : null;

  if (!senderSocket || !receiverSocket) {
    db.prepare("UPDATE transfers SET status='failed', error_msg=?, finished_at=unixepoch() WHERE job_id=?")
      .run('Dispositivi non connessi al momento dell\'esecuzione', jobId);
    io.to('_admins').emit('server-transfer-failed', { jobId: jobId, error: 'Dispositivi non connessi' });
    return;
  }

  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();

  db.prepare("UPDATE transfers SET status='running', started_at=unixepoch(), room_id=? WHERE job_id=?")
    .run(roomId, jobId);

  rooms.set(roomId, {
    sender:   { socketId: job.sender_socket_id,   username: senderSocket.data.username },
    receiver: { socketId: job.receiver_socket_id, username: receiverSocket.data.username },
    jobId: jobId,
  });

  senderSocket.join(roomId);
  receiverSocket.join(roomId);
  senderSocket.data.roomId   = roomId;
  receiverSocket.data.roomId = roomId;

  if (devices.has(job.sender_socket_id))   devices.get(job.sender_socket_id).status   = 'in-session';
  if (devices.has(job.receiver_socket_id)) devices.get(job.receiver_socket_id).status = 'in-session';
  broadcastDevices();

  sendSessionReadyPair(
    senderSocket,
    { role: 'sender',   roomId: roomId, peerUsername: receiverSocket.data.username, jobId: jobId },
    receiverSocket,
    { role: 'receiver', roomId: roomId, peerUsername: senderSocket.data.username,   jobId: jobId }
  );

  io.to('_admins').emit('server-transfer-started', {
    jobId: jobId, roomId: roomId,
    sender: senderSocket.data.username, receiver: receiverSocket.data.username,
  });
}

// Snapshot devices da inviare agli admin (senza campi interni)
function devicesSnapshot() {
  return [...devices.values()].map(function(d) {
    return {
      socketId:    d.socketId,
      username:    d.username,
      ip:          d.ip,
      label:       d.label || d.username,
      isAgent:     d.isAgent || false,
      localAddrs:  d.localAddrs,
      status:      d.status,
      connectedAt: d.connectedAt,
    };
  });
}

// Notifica tutti gli admin della lista aggiornata
function broadcastDevices() {
  io.to('_admins').emit('devices-update', devicesSnapshot());
}

// ── Connessione ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '')
    .split(',')[0].trim().replace('::ffff:', '');

  console.log(`[+] ${socket.data.username} (${socket.id}) da ${ip}`);

  // ── Registrazione come ADMIN ────────────────────────────────────────────
  socket.on('register-admin', () => {
    socket.join('_admins');
    socket.emit('devices-update', devicesSnapshot());
    console.log(`[A] Admin: ${socket.data.username}`);
  });

  // ── Registrazione come DEVICE ───────────────────────────────────────────
  socket.on('register-device', function(data) {
    data = data || {};
    devices.set(socket.id, {
      socketId:    socket.id,
      username:    socket.data.username,
      ip,
      label:       data.label || socket.data.username,
      isAgent:     data.isAgent || false,
      localAddrs:  null,
      status:      'idle',
      connectedAt: Date.now(),
    });
    if (!userSockets.has(socket.data.userId)) userSockets.set(socket.data.userId, new Set());
    userSockets.get(socket.data.userId).add(socket.id);
    broadcastDevices();
    console.log('[D] Device: ' + socket.data.username + (data.isAgent ? ' [agent]' : '') + ' (' + ip + ')');
  });

  // ── Device riporta i suoi indirizzi locali (HTTP server avviato) ──────────
  socket.on('report-local-addrs', function(addrs) {
    const dev = devices.get(socket.id);
    if (dev) dev.localAddrs = addrs;

    // Se c'è un receiver in attesa per questo sender, mandagli session-ready ora
    if (pendingReceivers.has(socket.id)) {
      var pending = pendingReceivers.get(socket.id);
      clearTimeout(pending.timer);
      pendingReceivers.delete(socket.id);
      pending.receiverData.senderLocalAddrs = addrs;
      pending.receiverSock.emit('session-ready', pending.receiverData);
    }
  });

  // ── Admin crea sessione ─────────────────────────────────────────────────
  socket.on('admin-create-session', ({ senderSocketId, receiverSocketId }) => {
    const senderSock   = io.sockets.sockets.get(senderSocketId);
    const receiverSock = io.sockets.sockets.get(receiverSocketId);

    if (!senderSock || !receiverSock) {
      socket.emit('admin-error', 'Uno dei dispositivi si è disconnesso. Riprova.');
      return;
    }
    if (senderSocketId === receiverSocketId) {
      socket.emit('admin-error', 'Mittente e ricevente devono essere dispositivi diversi.');
      return;
    }

    // Genera roomId e crea la stanza direttamente lato server
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomId, {
      sender:   { socketId: senderSocketId,   username: senderSock.data.username },
      receiver: { socketId: receiverSocketId, username: receiverSock.data.username },
    });

    // Unisce i socket alla stanza Socket.io
    senderSock.join(roomId);
    receiverSock.join(roomId);
    senderSock.data.roomId   = roomId;
    receiverSock.data.roomId = roomId;

    // Aggiorna stato dispositivi
    if (devices.has(senderSocketId))   devices.get(senderSocketId).status   = 'in-session';
    if (devices.has(receiverSocketId)) devices.get(receiverSocketId).status = 'in-session';
    broadcastDevices();

    sendSessionReadyPair(
      senderSock,
      { role: 'sender',   roomId, peerUsername: receiverSock.data.username },
      receiverSock,
      { role: 'receiver', roomId, peerUsername: senderSock.data.username }
    );

    // Notifica l'admin del successo
    socket.emit('session-created', {
      roomId,
      sender:   senderSock.data.username,
      receiver: receiverSock.data.username,
    });

    console.log(`[S] Sessione ${roomId}: ${senderSock.data.username} → ${receiverSock.data.username}`);
  });

  // ── Admin pianifica trasferimento ────────────────────────────────────────
  socket.on('admin-queue-transfer', function(data) {
    var senderSocketId   = data.senderSocketId;
    var receiverSocketId = data.receiverSocketId;
    var scheduledAt      = data.scheduledAt;
    var senderSock   = io.sockets.sockets.get(senderSocketId);
    var receiverSock = io.sockets.sockets.get(receiverSocketId);
    if (!senderSock || !receiverSock) {
      socket.emit('admin-error', 'Uno dei dispositivi non è connesso.');
      return;
    }

    var jobId = Math.random().toString(36).substring(2, 12).toUpperCase();
    var scheduledTs = scheduledAt ? Math.floor(new Date(scheduledAt).getTime() / 1000) : Math.floor(Date.now() / 1000);

    db.prepare('INSERT INTO transfers (job_id, sender_user_id, sender_socket_id, receiver_user_id, receiver_socket_id, status, scheduled_at) VALUES (?, ?, ?, ?, ?, \'queued\', ?)')
      .run(jobId, senderSock.data.userId || 0, senderSocketId, receiverSock.data.userId || 0, receiverSocketId, scheduledTs);

    io.to('_admins').emit('server-transfer-queued', {
      jobId: jobId,
      scheduledAt: scheduledTs * 1000,
      sender:   senderSock.data.username,
      receiver: receiverSock.data.username,
      status:   'queued',
    });

    if (scheduledAt && new Date(scheduledAt) > new Date()) {
      scheduleNext();
      socket.emit('admin-error', null);
    } else {
      dispatchJob(jobId);
    }
  });

  // ── Admin cancella trasferimento ─────────────────────────────────────────
  socket.on('admin-cancel-transfer', function(data) {
    var jobId = data.jobId;
    var job = db.prepare('SELECT * FROM transfers WHERE job_id = ?').get(jobId);
    if (!job) return;
    if (job.status === 'running') {
      if (job.room_id) {
        io.to(job.room_id).emit('peer-disconnected');
        rooms.delete(job.room_id);
      }
    }
    db.prepare("UPDATE transfers SET status='cancelled', finished_at=unixepoch() WHERE job_id=?").run(jobId);
    io.to('_admins').emit('server-transfer-cancelled', { jobId: jobId });
    scheduleNext();
  });

  // ── Integrity report dal receiver ─────────────────────────────────────────
  socket.on('device-integrity-report', function(data) {
    var jobId    = data.jobId;
    var filename = data.filename;
    var sha256   = data.sha256;

    var expected = db.prepare('SELECT expected_sha FROM transfer_integrity WHERE job_id=? AND filename=?')
      .get(jobId, filename);

    var ok = expected ? (expected.expected_sha === sha256 ? 1 : 0) : null;

    db.prepare('INSERT OR REPLACE INTO transfer_integrity (job_id, filename, expected_sha, received_sha, ok, checked_at) VALUES (?, ?, ?, ?, ?, unixepoch())')
      .run(jobId, filename, expected ? expected.expected_sha : sha256, sha256, ok);

    io.to('_admins').emit('server-integrity-result', {
      jobId:       jobId,
      filename:    filename,
      ok:          ok === 1,
      expectedSha: expected ? expected.expected_sha : null,
      receivedSha: sha256,
    });

    if (ok !== null) {
      db.prepare("UPDATE transfers SET status='done', finished_at=unixepoch() WHERE job_id=? AND status='running'")
        .run(jobId);
    }
  });

  // ── Filesystem browsing (admin → device → admin) ──────────────────────────
  socket.on('admin-fs-list', function(data) {
    var targetSocket = io.sockets.sockets.get(data.targetSocketId);
    if (!targetSocket) {
      socket.emit('fs-list-result', { reqId: data.reqId, error: 'Dispositivo non connesso', entries: [] });
      return;
    }
    fsPendingRequests.set(data.reqId, socket.id);
    targetSocket.emit('fs-list-dir', { path: data.path, reqId: data.reqId });
  });

  socket.on('admin-fs-roots', function(data) {
    var targetSocket = io.sockets.sockets.get(data.targetSocketId);
    if (!targetSocket) {
      socket.emit('fs-roots-result', { reqId: data.reqId, roots: [] });
      return;
    }
    fsPendingRequests.set(data.reqId, socket.id);
    targetSocket.emit('fs-get-roots', { reqId: data.reqId });
  });

  // Device risponde con listing
  socket.on('fs-list-result', function(data) {
    var adminSocketId = fsPendingRequests.get(data.reqId);
    if (!adminSocketId) return;
    fsPendingRequests.delete(data.reqId);
    var adminSocket = io.sockets.sockets.get(adminSocketId);
    if (adminSocket) adminSocket.emit('fs-list-result', Object.assign({}, data, { deviceSocketId: socket.id }));
  });

  socket.on('fs-roots-result', function(data) {
    var adminSocketId = fsPendingRequests.get(data.reqId);
    if (!adminSocketId) return;
    fsPendingRequests.delete(data.reqId);
    var adminSocket = io.sockets.sockets.get(adminSocketId);
    if (adminSocket) adminSocket.emit('fs-roots-result', Object.assign({}, data, { deviceSocketId: socket.id }));
  });

  // ── Admin avvia trasferimento agent-driven ────────────────────────────────
  socket.on('admin-start-agent-transfer', function(data) {
    var senderSocketId   = data.senderSocketId;
    var receiverSocketId = data.receiverSocketId;
    var filePaths        = data.filePaths;
    var outputPath       = data.outputPath;

    var senderSock   = io.sockets.sockets.get(senderSocketId);
    var receiverSock = io.sockets.sockets.get(receiverSocketId);

    if (!senderSock || !receiverSock) {
      socket.emit('admin-error', 'Uno dei dispositivi non è connesso.');
      return;
    }
    if (!filePaths || !filePaths.length) {
      socket.emit('admin-error', 'Nessun file selezionato.');
      return;
    }
    if (!outputPath) {
      socket.emit('admin-error', 'Nessuna cartella destinazione selezionata.');
      return;
    }

    var roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    var jobId  = Math.random().toString(36).substring(2, 12).toUpperCase();

    rooms.set(roomId, {
      sender:   { socketId: senderSocketId,   username: senderSock.data.username },
      receiver: { socketId: receiverSocketId, username: receiverSock.data.username },
      jobId,
    });

    senderSock.join(roomId);
    receiverSock.join(roomId);
    senderSock.data.roomId   = roomId;
    receiverSock.data.roomId = roomId;

    if (devices.has(senderSocketId))   devices.get(senderSocketId).status   = 'in-session';
    if (devices.has(receiverSocketId)) devices.get(receiverSocketId).status = 'in-session';
    broadcastDevices();

    // Salva job nel DB
    try {
      db.prepare('INSERT INTO transfers (job_id, sender_user_id, sender_socket_id, receiver_user_id, receiver_socket_id, file_manifest, status, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, \'running\', unixepoch())')
        .run(jobId, senderSock.data.userId || 0, senderSocketId, receiverSock.data.userId || 0, receiverSocketId, JSON.stringify(filePaths.map(function(fp) { return { path: fp }; })));
    } catch(e) { /* ignora errori DB */ }

    sendSessionReadyPair(
      senderSock,
      { role: 'sender',   roomId, jobId, peerUsername: receiverSock.data.username, filePaths: filePaths },
      receiverSock,
      { role: 'receiver', roomId, jobId, peerUsername: senderSock.data.username,   outputPath: outputPath }
    );

    socket.emit('session-created', {
      roomId, jobId,
      sender:   senderSock.data.username,
      receiver: receiverSock.data.username,
    });

    io.to('_admins').emit('server-transfer-started', {
      jobId, roomId,
      sender: senderSock.data.username,
      receiver: receiverSock.data.username,
    });

    console.log('[S] Agent transfer ' + jobId + ': ' + senderSock.data.username + ' → ' + receiverSock.data.username);
  });

  // ── Relay ─────────────────────────────────────────────────────────────────
  socket.on('relay-ctrl', function(msg) {
    if (!socket.data.roomId) return;

    // Cattura sha256 dal sender per verificarla dopo
    if (msg.type === 'file-start' && msg.sha256) {
      var room = rooms.get(socket.data.roomId);
      if (room && room.jobId) {
        db.prepare('INSERT OR REPLACE INTO transfer_integrity (job_id, filename, expected_sha) VALUES (?, ?, ?)')
          .run(room.jobId, msg.name, msg.sha256);
      }
    }

    // Se il transfer è completo, segna done (fallback)
    if (msg.type === 'xfer-done') {
      var room2 = rooms.get(socket.data.roomId);
      if (room2 && room2.jobId) {
        db.prepare("UPDATE transfers SET status='done', finished_at=unixepoch() WHERE job_id=? AND status='running'")
          .run(room2.jobId);
        io.to('_admins').emit('server-transfer-done', { jobId: room2.jobId });
      }
    }

    socket.to(socket.data.roomId).emit('relay-ctrl', msg);
  });

  socket.on('relay-chunk', (chunk, ack) => {
    if (!socket.data.roomId) return;
    socket.to(socket.data.roomId).emit('relay-chunk', chunk);
    if (typeof ack === 'function') ack();
  });

  socket.on('transfer-progress', function(data) {
    if (!socket.data.roomId) return;
    data.roomId = socket.data.roomId;
    io.to('_admins').emit('transfer-progress', data);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Rimuovi dai device se era un device
    if (devices.has(socket.id)) {
      devices.delete(socket.id);
      broadcastDevices();
    }
    // Aggiorna userSockets
    if (socket.data.userId && userSockets.has(socket.data.userId)) {
      userSockets.get(socket.data.userId).delete(socket.id);
    }
    // Pulisci la stanza se era in una sessione
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      // Aggiorna job running se il device era in sessione
      const runningJob = db.prepare("SELECT job_id FROM transfers WHERE room_id=? AND status='running'").get(roomId);
      if (runningJob) {
        db.prepare("UPDATE transfers SET status='failed', error_msg='Dispositivo disconnesso', finished_at=unixepoch() WHERE job_id=?")
          .run(runningJob.job_id);
        io.to('_admins').emit('server-transfer-failed', { jobId: runningJob.job_id, error: 'Dispositivo disconnesso' });
      }
      rooms.delete(roomId);
      socket.to(roomId).emit('peer-disconnected');
      console.log(`[-] Room ${roomId} closed`);
    }
    console.log(`[-] ${socket.data.username} (${socket.id})`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌊  DropWave v5  —  http://0.0.0.0:${PORT}`);
  console.log(`   Admin panel:  http://0.0.0.0:${PORT}/`);
  console.log(`   Device page:  http://0.0.0.0:${PORT}/device\n`);
  // Segna come failed i transfer "running" orfani (rimasti dal crash/restart precedente)
  const orphans = db.prepare("UPDATE transfers SET status='failed', error_msg='Server riavviato', finished_at=unixepoch() WHERE status='running'").run();
  if (orphans.changes > 0) console.log('[!] Marcati ' + orphans.changes + ' transfer orfani come failed');
  // Avvia scheduler per job già in coda dal DB (sopravvissuti al restart)
  scheduleNext();
});

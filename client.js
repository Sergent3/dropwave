#!/usr/bin/env node
'use strict';

/**
 * DropWave CLI Client v3
 *
 * Comandi:
 *   node client.js login
 *   node client.js send [--server URL] [--room XXXX] file1 file2 ...
 *   node client.js receive --room XXXX [--output ./cartella] [--server URL]
 *
 * Variabili d'ambiente:
 *   DROPWAVE_URL   URL del server (default: http://localhost:3000)
 */

const { io }   = require('socket.io-client');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');
const http     = require('http');
const https    = require('https');
const net      = require('net');
const crypto   = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────
const CHUNK_SIZE    = 256 * 1024;  // 256 KB per chunk
const MAX_IN_FLIGHT = 8;           // max chunk in volo prima di aspettare ack
const TOKEN_FILE    = path.join(os.homedir(), '.dropwave', 'token');

// ── Token storage ─────────────────────────────────────────────────────────
function loadToken() {
  try   { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch { return null; }
}

function saveToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); // leggibile solo dal proprietario
}

// ── HTTP helper (senza dipendenze esterne) ────────────────────────────────
function apiPost(serverUrl, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    const parsed = new URL(serverUrl + urlPath);
    const mod    = parsed.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let raw = '';
      res.on('data', c  => raw += c);
      res.on('end',  () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { reject(new Error(`Risposta non valida dal server: ${raw}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Prompt helpers ────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function askPassword(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    let pwd = '';

    const isTTY = process.stdin.isTTY;
    if (isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const handler = ch => {
      if (ch === '\r' || ch === '\n' || ch === '\u0003') {
        if (isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(pwd);
      } else if (ch === '\u007f') {
        pwd = pwd.slice(0, -1);
      } else {
        pwd += ch;
      }
    };
    process.stdin.on('data', handler);
  });
}

// ── Arg parser (nessun commander) ────────────────────────────────────────
function parseArgs() {
  const argv  = process.argv.slice(2);
  const cmd   = argv[0];
  const flags = { server: process.env.DROPWAVE_URL || 'http://localhost:3000' };
  const files = [];

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case '--server': flags.server = argv[++i]; break;
      case '--room':   flags.room   = argv[++i]; break;
      case '--output': flags.output = argv[++i]; break;
      default:
        if (!argv[i].startsWith('--')) files.push(argv[i]);
    }
  }

  return { cmd, flags, files };
}

// ── Progress bar ──────────────────────────────────────────────────────────
function progress(label, current, total) {
  const pct  = total > 0 ? Math.min(100, current / total * 100) : 0;
  const fill = Math.round(pct / 5); // 20 blocchi totali
  const bar  = '█'.repeat(fill) + '░'.repeat(20 - fill);
  process.stdout.write(`\r  [${bar}] ${pct.toFixed(2)}%  ${fmtBytes(current)} / ${fmtBytes(total)}   `);
}

// ── LAN direct transfer helpers ──────────────────────────────────────────

// Ottieni IPv4 locali (non loopback)
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  Object.values(ifaces).forEach(function(list) {
    (list || []).forEach(function(iface) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    });
  });
  return ips;
}

// Avvia server HTTP locale che serve i file per download diretto
// GET /manifest  → JSON con lista file
// GET /file/:idx → stream del file
function startLocalServer(filePaths) {
  return new Promise(function(resolve) {
    const fileMeta = filePaths.map(function(fp) {
      return { name: path.basename(fp), size: fs.statSync(fp).size, path: fp };
    });

    const srv = http.createServer(function(req, res) {
      if (req.url === '/manifest') {
        const body = JSON.stringify(fileMeta.map(function(f) {
          return { name: f.name, size: f.size };
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }

      const m = req.url.match(/^\/file\/(\d+)$/);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (idx < 0 || idx >= fileMeta.length) { res.writeHead(404); res.end(); return; }
        const f = fileMeta[idx];
        const rangeHeader = req.headers['range'];
        var start = 0;
        if (rangeHeader) {
          var rm = rangeHeader.match(/bytes=(\d+)-/);
          if (rm) start = parseInt(rm[1], 10);
        }
        var remaining = f.size - start;
        res.writeHead(start > 0 ? 206 : 200, {
          'Content-Type':        'application/octet-stream',
          'Content-Length':      remaining,
          'Content-Disposition': 'attachment; filename="' + f.name + '"',
          'Accept-Ranges':       'bytes',
        });
        if (remaining <= 0) { res.end(); return; }
        fs.createReadStream(f.path, { start: start }).pipe(res);
        return;
      }

      res.writeHead(404); res.end();
    });

    srv.listen(0, '0.0.0.0', function() {
      const port = srv.address().port;
      const ips  = getLocalIPs();
      resolve({ server: srv, port, addrs: ips.map(function(ip) { return { ip, port }; }) });
    });
  });
}

// Controlla se un indirizzo locale è raggiungibile entro timeout ms
function isReachable(ip, port, timeout) {
  return new Promise(function(resolve) {
    const sock = new net.Socket();
    const done = function(ok) { try { sock.destroy(); } catch(e) {} resolve(ok); };
    sock.setTimeout(timeout || 1500);
    sock.on('connect',  function() { done(true);  });
    sock.on('error',    function() { done(false); });
    sock.on('timeout',  function() { done(false); });
    sock.connect(port, ip);
  });
}

// Scarica direttamente dal server HTTP locale del sender
async function directDownload(addrs, outputDir, socket) {
  // Trova il primo indirizzo raggiungibile
  let target = null;
  for (let i = 0; i < addrs.length; i++) {
    const ok = await isReachable(addrs[i].ip, addrs[i].port);
    if (ok) { target = addrs[i]; break; }
  }
  if (!target) return false;

  console.log(`  Connessione diretta LAN: ${target.ip}:${target.port}`);

  // Scarica manifest
  const manifest = await httpGet(target.ip, target.port, '/manifest');
  const files = JSON.parse(manifest);
  const total = files.reduce(function(s, f) { return s + f.size; }, 0);
  console.log(`Ricezione diretta ${files.length} file (${fmtBytes(total)} totali):`);
  files.forEach(function(f, i) { console.log(`  [${i+1}] ${f.name} — ${fmtBytes(f.size)}`); });
  console.log('');

  for (let i = 0; i < files.length; i++) {
    const f        = files[i];
    const safeName = path.basename(f.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
    const dest     = path.join(outputDir, safeName);
    console.log(`Ricezione: ${f.name}\n  → ${dest}`);
    await httpDownload(target.ip, target.port, '/file/' + i, dest, f.size, socket);
    process.stdout.write('\n');
    console.log(`  ✓ Salvato: ${f.name}\n`);
  }

  console.log(`✓ Completato. ${files.length} file in:\n  ${outputDir}`);
  return true;
}

function httpGet(ip, port, urlPath) {
  return new Promise(function(resolve, reject) {
    http.get({ hostname: ip, port, path: urlPath }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end',  function()  { resolve(data); });
    }).on('error', reject);
  });
}

function httpDownload(ip, port, urlPath, dest, totalSize, socket) {
  return new Promise(function(resolve, reject) {
    var existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (existing >= totalSize) { resolve(); return; }

    var ws = fs.createWriteStream(dest, existing > 0 ? { flags: 'a' } : {});
    var received = existing;
    if (existing > 0) console.log('  Resume da ' + fmtBytes(existing));

    var options = { hostname: ip, port: port, path: urlPath };
    if (existing > 0) options.headers = { 'Range': 'bytes=' + existing + '-' };

    var chunkCount = 0;
    http.get(options, function(res) {
      res.on('data', function(chunk) {
        ws.write(chunk);
        received += chunk.length;
        chunkCount++;
        progress(path.basename(dest), received, totalSize);
        if (socket && chunkCount % 40 === 0) {
          socket.emit('transfer-progress', {
            fileIndex: 0, fileName: path.basename(dest),
            bytesDone: received, bytesTotal: totalSize,
            totalDone: received, totalSize: totalSize,
          });
        }
      });
      res.on('end', function() { ws.end(); resolve(); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── SHA-256 hash di un file ───────────────────────────────────────────────
function hashFile(filePath) {
  return new Promise(function(resolve, reject) {
    var hash   = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath);
    stream.on('data', function(d) { hash.update(d); });
    stream.on('end',  function()  { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

// ── Async generator: legge file a chunk ──────────────────────────────────
async function* readChunks(filePath, startOffset) {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  var pos   = startOffset || 0;
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK_SIZE, pos)) > 0) {
      pos += n;
      yield Buffer.from(buf.slice(0, n)); // copia per sicurezza
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  COMANDO: login
// ══════════════════════════════════════════════════════════════════════════
async function cmdLogin(flags) {
  const email    = await ask('Email: ');
  const password = await askPassword('Password: ');

  let res = await apiPost(flags.server, '/api/auth/login', { email, password });

  if (res.status === 401) {
    const doReg = await ask('Account non trovato. Vuoi registrarti? [s/N] ');
    if (!doReg.toLowerCase().startsWith('s')) { console.log('Annullato.'); process.exit(0); }
    const username = await ask('Username: ');
    res = await apiPost(flags.server, '/api/auth/register', { email, username, password });
  }

  if (!res.body || !res.body.ok) {
    console.error('\n❌ Errore:', (res.body && res.body.error) || 'risposta non valida');
    process.exit(1);
  }

  saveToken(res.body.token);
  console.log(`\n✓ Autenticato come "${res.body.username}"`);
  console.log(`  Token salvato in ${TOKEN_FILE}`);
}

// ══════════════════════════════════════════════════════════════════════════
//  COMANDO: send
// ══════════════════════════════════════════════════════════════════════════
async function cmdSend(flags, filePaths) {
  if (!filePaths.length) {
    console.error('Specifica almeno un file. Es: node client.js send --room XXXX file.zip');
    process.exit(1);
  }

  const token = loadToken();
  if (!token) {
    console.error('Non autenticato. Esegui prima: node client.js login');
    process.exit(1);
  }

  // Verifica che tutti i file esistano prima di connettersi
  for (const fp of filePaths) {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      console.error(`File non trovato: ${fp}`);
      process.exit(1);
    }
  }

  const roomId = flags.room || Math.random().toString(36).substring(2, 8).toUpperCase();

  console.log(`\n🌊 DropWave — Modalità invio`);
  console.log(`   Server: ${flags.server}`);
  console.log(`   Stanza: ${roomId}\n`);

  const socket = io(flags.server, {
    auth:         { token },
    reconnection: false,
    transports:   ['websocket'],
  });

  socket.on('connect_error', err => {
    if (err.message === 'AUTH_REQUIRED') {
      console.error('Sessione scaduta. Esegui: node client.js login');
    } else {
      console.error('Connessione fallita:', err.message);
    }
    process.exit(1);
  });

  socket.on('connect', () => {
    socket.emit('create-room', roomId);
  });

  socket.on('room-error', msg => {
    console.error('Errore stanza:', msg);
    socket.disconnect();
    process.exit(1);
  });

  socket.on('room-created', () => {
    console.log(`Stanza creata: ${roomId}`);
    console.log(`In attesa del destinatario…`);
    console.log(`\nComando per il ricevente:`);
    console.log(`  node client.js receive --room ${roomId} --output ./cartella\n`);
  });

  socket.on('peer-joined', async ({ username } = {}) => {
    console.log(`Destinatario connesso: ${username || 'anonimo'}\n`);
    try {
      await transferFiles(socket, filePaths);
      console.log('\n✓ Trasferimento completato.');
    } catch (err) {
      console.error('\n❌ Errore durante il trasferimento:', err.message);
    } finally {
      socket.disconnect();
      process.exit(0);
    }
  });

  socket.on('peer-disconnected', () => {
    console.error('\nIl destinatario si è disconnesso.');
    socket.disconnect();
    process.exit(1);
  });
}

async function transferFiles(socket, filePaths, jobId) {
  var fileMeta = filePaths.map(function(fp) {
    return { name: path.basename(fp), size: fs.statSync(fp).size, type: 'application/octet-stream' };
  });

  var totalBytes = fileMeta.reduce(function(s, f) { return s + f.size; }, 0);
  console.log('File da inviare: ' + fileMeta.length + ' (' + fmtBytes(totalBytes) + ' totali)');
  fileMeta.forEach(function(f, i) { console.log('  [' + (i+1) + '] ' + f.name + ' — ' + fmtBytes(f.size)); });

  // Pre-calcola hash SHA-256
  console.log('\nCalcolo SHA-256...');
  var hashes = [];
  for (var hi = 0; hi < filePaths.length; hi++) {
    hashes.push(await hashFile(filePaths[hi]));
    console.log('  v ' + fileMeta[hi].name + ': ' + hashes[hi].substring(0, 16) + '...');
  }
  console.log('');

  socket.emit('relay-ctrl', { type: 'file-list', files: fileMeta });

  // Aspetta max 2 secondi un eventuale resume-info dal receiver
  var resumeOffsets = await new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve({}); }, 2000);
    socket.once('relay-ctrl', function(msg) {
      if (msg.type === 'resume-info') {
        clearTimeout(timer);
        resolve(msg.offsets || {});
      } else {
        clearTimeout(timer);
        resolve({});
      }
    });
  });

  for (var i = 0; i < filePaths.length; i++) {
    var fp          = filePaths[i];
    var meta        = fileMeta[i];
    var startOffset = resumeOffsets[i] ? resumeOffsets[i] : 0;

    socket.emit('relay-ctrl', {
      type: 'file-start', index: i,
      name: meta.name, size: meta.size, fileType: meta.type,
      sha256: hashes[i],
    });

    console.log('Invio [' + (i+1) + '/' + filePaths.length + ']: ' + meta.name +
      (startOffset > 0 ? ' (resume da ' + fmtBytes(startOffset) + ')' : ''));

    var bytesDoneBefore = fileMeta.slice(0, i).reduce(function(s, f) { return s + f.size; }, 0);
    await sendChunks(socket, fp, meta, i, startOffset, bytesDoneBefore, totalBytes, fileMeta, jobId);

    process.stdout.write('\n');
    socket.emit('relay-ctrl', { type: 'file-end', index: i, sha256: hashes[i] });
    console.log('  v ' + meta.name + ' [SHA: ' + hashes[i].substring(0, 12) + '...]\n');
  }

  socket.emit('relay-ctrl', { type: 'xfer-done' });
}

async function sendChunks(socket, fp, meta, fileIndex, startOffset, bytesDoneBefore, totalBytes, fileMeta, jobId) {
  let inFlight  = 0;
  let bytesSent = startOffset;
  let chunkCount = 0;

  for await (const chunk of readChunks(fp, startOffset)) {
    // Backpressure: aspetta che l'ack del server riduca i chunk in volo
    while (inFlight >= MAX_IN_FLIGHT) {
      await new Promise(r => setImmediate(r));
    }

    inFlight++;
    socket.emit('relay-chunk', chunk, () => { inFlight--; });

    bytesSent += chunk.length;
    chunkCount++;
    progress(meta.name, bytesSent, meta.size);

    // Emetti progress ogni 10 chunk
    if (chunkCount % 10 === 0) {
      const totalDone = bytesDoneBefore + bytesSent;
      socket.emit('transfer-progress', {
        fileIndex: fileIndex,
        fileName: meta.name,
        bytesDone: bytesSent,
        bytesTotal: meta.size,
        totalDone: totalDone,
        totalSize: totalBytes,
        jobId: jobId || null,
      });
    }
  }

  // Emetti progress finale per il file
  const totalDone = bytesDoneBefore + bytesSent;
  socket.emit('transfer-progress', {
    fileIndex: fileIndex,
    fileName: meta.name,
    bytesDone: bytesSent,
    bytesTotal: meta.size,
    totalDone: totalDone,
    totalSize: totalBytes,
    jobId: jobId || null,
  });

  // Aspetta che tutti i chunk siano confermati dal server
  while (inFlight > 0) {
    await new Promise(r => setImmediate(r));
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  COMANDO: receive
// ══════════════════════════════════════════════════════════════════════════
async function cmdReceive(flags) {
  if (!flags.room) {
    console.error('Specifica il codice stanza: --room XXXX');
    process.exit(1);
  }

  const token = loadToken();
  if (!token) {
    console.error('Non autenticato. Esegui prima: node client.js login');
    process.exit(1);
  }

  // Cartella di output: --output oppure directory corrente
  const outputDir = flags.output ? path.resolve(flags.output) : process.cwd();
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n🌊 DropWave — Modalità ricezione`);
  console.log(`   Server:  ${flags.server}`);
  console.log(`   Stanza:  ${flags.room.toUpperCase()}`);
  console.log(`   Output:  ${outputDir}\n`);

  const socket = io(flags.server, {
    auth:         { token },
    reconnection: false,
    transports:   ['websocket'],
  });

  socket.on('connect_error', err => {
    if (err.message === 'AUTH_REQUIRED') {
      console.error('Sessione scaduta. Esegui: node client.js login');
    } else {
      console.error('Connessione fallita:', err.message);
    }
    process.exit(1);
  });

  socket.on('connect', () => {
    socket.emit('join-room', flags.room.toUpperCase());
  });

  socket.on('room-error', msg => {
    console.error('Errore stanza:', msg);
    socket.disconnect();
    process.exit(1);
  });

  socket.on('room-joined', () => {
    console.log('Connesso alla stanza. In attesa del mittente…');
  });

  // Stato ricezione
  const rx = {
    currentFile:  null,
    writeStream:  null,
    bytesRx:      0,
    filesDone:    0,
  };

  socket.on('relay-ctrl', msg => {
    switch (msg.type) {

      case 'file-list': {
        const total = msg.files.reduce((s, f) => s + f.size, 0);
        console.log(`\nRicezione ${msg.files.length} file (${fmtBytes(total)} totali):`);
        msg.files.forEach((f, i) => console.log(`  [${i+1}] ${f.name} — ${fmtBytes(f.size)}`));
        console.log('');
        break;
      }

      case 'file-start': {
        rx.currentFile = msg;
        rx.bytesRx     = 0;

        // Sanifica il nome per prevenire path traversal
        const safeName = path.basename(msg.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
        const dest     = path.join(outputDir, safeName);
        rx.writeStream = fs.createWriteStream(dest);

        rx.writeStream.on('error', err => {
          console.error(`\n❌ Errore scrittura ${dest}: ${err.message}`);
          socket.disconnect();
          process.exit(1);
        });

        console.log(`Ricezione: ${msg.name}`);
        console.log(`  → ${dest}`);
        break;
      }

      case 'file-end': {
        if (rx.writeStream) rx.writeStream.end();
        rx.writeStream = null;
        process.stdout.write('\n');
        console.log(`  ✓ Salvato: ${rx.currentFile && rx.currentFile.name}\n`);
        rx.filesDone++;
        rx.currentFile = null;
        break;
      }

      case 'xfer-done': {
        console.log(`✓ Trasferimento completato. ${rx.filesDone} file salvati in:\n  ${outputDir}`);
        socket.disconnect();
        process.exit(0);
        break;
      }
    }
  });

  socket.on('relay-chunk', chunk => {
    if (!rx.writeStream || !rx.currentFile) return;
    rx.writeStream.write(chunk);
    rx.bytesRx += chunk.length;
    progress(rx.currentFile.name, rx.bytesRx, rx.currentFile.size);
  });

  socket.on('peer-disconnected', () => {
    console.error('\nIl mittente si è disconnesso prima del completamento.');
    if (rx.writeStream) rx.writeStream.destroy();
    socket.disconnect();
    process.exit(1);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  COMANDO: device  (v4 — ruolo assegnato dall'admin)
// ══════════════════════════════════════════════════════════════════════════
async function cmdDevice(flags, filePaths) {
  const token = loadToken();
  if (!token) {
    console.error('Non autenticato. Esegui prima: node client.js login');
    process.exit(1);
  }

  for (const fp of filePaths) {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      console.error(`File non trovato: ${fp}`);
      process.exit(1);
    }
  }

  const outputDir = flags.output ? path.resolve(flags.output) : process.cwd();

  // Se ci sono file da inviare, avvia subito il server HTTP locale
  let localServer = null;
  if (filePaths.length) {
    localServer = await startLocalServer(filePaths);
    console.log(`\n🌊 DropWave — Modalità dispositivo`);
    console.log(`   Server: ${flags.server}`);
    console.log(`   File pronti: ${filePaths.length} — server locale :${localServer.port}`);
    console.log(`   IPs locali: ${localServer.addrs.map(function(a) { return a.ip; }).join(', ')}`);
  } else {
    console.log(`\n🌊 DropWave — Modalità dispositivo`);
    console.log(`   Server: ${flags.server}`);
    console.log(`   Output ricezione: ${outputDir}`);
  }
  console.log(`\n   In attesa di istruzioni dall'admin…\n`);

  // Stato trasferimento per gestire riconnessione
  var sessionRole      = null;
  var sessionActive    = false;

  const socket = io(flags.server, {
    auth:                { token },
    reconnection:        true,
    reconnectionAttempts: 20,
    reconnectionDelay:   2000,
    reconnectionDelayMax: 10000,
    transports:          ['websocket'],
  });

  socket.on('connect_error', function(err) {
    if (err.message === 'AUTH_REQUIRED' || err.message === 'AUTH_INVALID') {
      console.error('Sessione scaduta. Esegui: node client.js login');
      process.exit(1);
    }
    // Altri errori: Socket.io riproverà automaticamente
    console.error('Connessione fallita, riprovo… (' + err.message + ')');
  });

  socket.on('reconnect', function(attempt) {
    console.log('Riconnesso (tentativo ' + attempt + ')');
  });

  socket.on('reconnect_failed', function() {
    console.error('Impossibile riconnettersi dopo tutti i tentativi. Uscita.');
    if (localServer) localServer.server.close();
    process.exit(1);
  });

  socket.on('connect', function() {
    // Se eravamo già in sessione, non ri-registrarci come device idle
    if (sessionActive) return;
    socket.emit('register-device');
    if (localServer) {
      socket.emit('report-local-addrs', localServer.addrs);
    }
    console.log('Connesso — in attesa di istruzioni dall\'admin…');
  });

  socket.on('session-ready', async function(data) {
    const role             = data.role;
    const roomId           = data.roomId;
    const peerUsername     = data.peerUsername;
    const senderLocalAddrs = data.senderLocalAddrs || null;
    const jobId            = data.jobId || null;

    sessionRole   = role;
    sessionActive = true;

    console.log('✓ Sessione ' + roomId + ' — ruolo: ' + role.toUpperCase());
    console.log('  Peer: ' + peerUsername + '\n');

    if (role === 'sender') {
      if (!filePaths.length) {
        console.error('❌ Sei mittente ma non hai specificato file.');
        console.error('   Riavvia con: node client.js device <file1> [file2 …]');
        socket.disconnect();
        process.exit(1);
      }
      try {
        await transferFiles(socket, filePaths, jobId);
        console.log('\n✓ Trasferimento completato.');
      } catch (err) {
        console.error('\n❌ Errore:', err.message);
      } finally {
        if (localServer) localServer.server.close();
        socket.disconnect();
        process.exit(0);
      }

    } else {
      fs.mkdirSync(outputDir, { recursive: true });

      if (senderLocalAddrs && senderLocalAddrs.length) {
        console.log('  Provo connessione diretta LAN…');
        const ok = await directDownload(senderLocalAddrs, outputDir, socket);
        if (ok) {
          socket.disconnect();
          process.exit(0);
        }
        console.log('  Connessione diretta non riuscita — uso relay.\n');
      }

      console.log('In attesa dei file via relay… (salvataggio in: ' + outputDir + ')\n');
      startReceiving(socket, outputDir, jobId);
    }
  });

  socket.on('peer-disconnected', function() {
    console.error('\nL\'altro peer si è disconnesso.');
    if (localServer) localServer.server.close();
    socket.disconnect();
    process.exit(1);
  });
}

function startReceiving(socket, outputDir, jobId) {
  const rx = {
    currentFile:  null,
    writeStream:  null,
    bytesRx:      0,
    filesDone:    0,
    resumeOffsets: {},
    hashers:      {},
    jobId:        jobId || null,
  };

  socket.on('relay-ctrl', function(msg) {
    switch (msg.type) {
      case 'file-list': {
        const total = msg.files.reduce(function(s, f) { return s + f.size; }, 0);
        console.log('Ricezione ' + msg.files.length + ' file (' + fmtBytes(total) + ' totali):');
        msg.files.forEach(function(f, i) { console.log('  [' + (i+1) + '] ' + f.name + ' — ' + fmtBytes(f.size)); });
        console.log('');
        rx.hashers = {};

        // Controlla file parziali e notifica il sender
        var resumeOffsets = {};
        msg.files.forEach(function(f, i) {
          var safeName = path.basename(f.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
          var dest = path.join(outputDir, safeName);
          if (fs.existsSync(dest)) {
            var sz = fs.statSync(dest).size;
            if (sz > 0 && sz < f.size) resumeOffsets[i] = sz;
          }
        });
        rx.resumeOffsets = resumeOffsets;
        if (Object.keys(resumeOffsets).length > 0) {
          socket.emit('relay-ctrl', { type: 'resume-info', offsets: resumeOffsets });
        }
        break;
      }
      case 'file-start': {
        rx.currentFile = msg; // msg contiene msg.sha256 se inviato dal sender
        rx.hashers[msg.index] = crypto.createHash('sha256');
        const safeName = path.basename(msg.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
        const dest     = path.join(outputDir, safeName);
        const isResume = rx.resumeOffsets && rx.resumeOffsets[msg.index] > 0;
        rx.writeStream = fs.createWriteStream(dest, isResume ? { flags: 'a' } : {});
        rx.bytesRx     = isResume ? rx.resumeOffsets[msg.index] : 0;
        rx.writeStream.on('error', function(err) {
          console.error('\n❌ Errore scrittura ' + dest + ': ' + err.message);
          socket.disconnect(); process.exit(1);
        });
        console.log('Ricezione: ' + msg.name + (isResume ? ' (resume da ' + fmtBytes(rx.bytesRx) + ')' : '') + '\n  → ' + dest);
        break;
      }
      case 'file-end': {
        if (rx.writeStream) rx.writeStream.end();
        rx.writeStream = null;
        process.stdout.write('\n');

        // Verifica integrità SHA-256
        var idx = msg.index;
        if (rx.hashers[idx] && rx.currentFile) {
          var computedHash = rx.hashers[idx].digest('hex');
          var expectedHash = rx.currentFile.sha256 || null;
          var integrityOk  = expectedHash ? (computedHash === expectedHash) : null;

          if (integrityOk === true)  console.log('  v SHA-256 OK: ' + computedHash.substring(0, 16) + '...');
          if (integrityOk === false) console.log('  x SHA-256 FAIL! Atteso: ' + expectedHash.substring(0, 16) + '... Ricevuto: ' + computedHash.substring(0, 16) + '...');

          // Invia report al server
          socket.emit('device-integrity-report', {
            jobId:    rx.jobId,
            filename: rx.currentFile.name,
            sha256:   computedHash,
          });

          delete rx.hashers[idx];
        }

        console.log('  v Salvato: ' + (rx.currentFile && rx.currentFile.name) + '\n');
        rx.filesDone++; rx.currentFile = null;
        break;
      }
      case 'xfer-done': {
        console.log('✓ Completato. ' + rx.filesDone + ' file in:\n  ' + outputDir);
        socket.disconnect(); process.exit(0);
        break;
      }
    }
  });

  socket.on('relay-chunk', function(chunk) {
    if (!rx.writeStream || !rx.currentFile) return;
    rx.writeStream.write(chunk);
    if (rx.hashers[rx.currentFile.index]) rx.hashers[rx.currentFile.index].update(chunk);
    rx.bytesRx += chunk.length;
    progress(rx.currentFile.name, rx.bytesRx, rx.currentFile.size);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════════════════
function fmtBytes(b) {
  if (!b) return '0 B';
  const k = 1024, u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / k ** i).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

// ══════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════
(async () => {
  const { cmd, flags, files } = parseArgs();

  switch (cmd) {
    case 'login':   await cmdLogin(flags);              break;
    case 'device':  await cmdDevice(flags, files);      break;
    case 'send':    await cmdSend(flags, files);        break;
    case 'receive': await cmdReceive(flags);            break;
    default:
      console.log(`
🌊  DropWave CLI v4

Utilizzo:
  node client.js login
      Autentica e salva il token in ~/.dropwave/token

  node client.js device [--server URL] [--output DIR] [file1 file2 ...]
      Registra questo terminale come dispositivo controllabile dall'admin.
      L'admin assegnerà il ruolo (mittente o ricevente) dal pannello web.
      Passa i file se pensi di essere mittente; --output se pensi di ricevere.

  node client.js send [--server URL] [--room XXXX] <file1> [file2 ...]
      (v3) Crea stanza e invia file direttamente con codice.

  node client.js receive --room XXXX [--output DIR] [--server URL]
      (v3) Riceve file da una stanza con codice.

Variabili d'ambiente:
  DROPWAVE_URL   URL del server (default: http://localhost:3000)

Esempi:
  node client.js login
  node client.js device --server http://51.38.82.241:9000 report.pdf video.mp4
  node client.js device --server http://51.38.82.241:9000 --output ~/Downloads
`);
      process.exit(0);
  }
})();

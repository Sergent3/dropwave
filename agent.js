#!/usr/bin/env node
'use strict';

/**
 * DropWave Agent — daemon persistente per dispositivi
 * Config: ~/.dropwave/agent.json
 *
 * Installa con: curl http://SERVER/install.sh | bash
 */

const { io }   = require('socket.io-client');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const http     = require('http');
const net      = require('net');
const crypto   = require('crypto');

const CONFIG_FILE = path.join(os.homedir(), '.dropwave', 'agent.json');
const CHUNK_SIZE  = 256 * 1024;
const MAX_IN_FLIGHT = 8;

// ── Config ────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch(e) {
    console.error('Config non trovata: ' + CONFIG_FILE);
    console.error('Esegui prima: curl http://SERVER/install.sh | bash');
    process.exit(1);
  }
}

const config = loadConfig();
const SERVER        = config.server || 'http://localhost:9000';
const TOKEN         = config.token;
const LABEL         = config.label || os.hostname();
const ALLOWED_PATHS = (config.allowedPaths || [os.homedir()]).map(function(p) { return path.resolve(p); });

if (!TOKEN) {
  console.error('Token mancante nella config. Reinstalla l\'agent.');
  process.exit(1);
}

// ── Filesystem browser ────────────────────────────────────────────────────
function isAllowed(p) {
  var resolved = path.resolve(p);
  return ALLOWED_PATHS.some(function(allowed) {
    if (allowed === path.sep) return true;
    return resolved === allowed || resolved.startsWith(allowed + path.sep);
  });
}

function listDir(dirPath) {
  if (!dirPath) dirPath = ALLOWED_PATHS[0];

  if (!isAllowed(dirPath)) {
    return { error: 'Percorso non consentito', path: dirPath, entries: [] };
  }

  try {
    var resolved = path.resolve(dirPath);
    var raw = fs.readdirSync(resolved, { withFileTypes: true });
    var entries = [];

    raw.forEach(function(e) {
      if (e.name.startsWith('.')) return; // nasconde file nascosti
      try {
        var fullPath = path.join(resolved, e.name);
        var stat = fs.statSync(fullPath);
        entries.push({
          name:  e.name,
          type:  e.isDirectory() ? 'dir' : 'file',
          size:  e.isFile() ? stat.size : null,
          mtime: stat.mtimeMs,
          path:  fullPath,
        });
      } catch(statErr) {
        // file non accessibile, skip
      }
    });

    // Dir prima, poi file; entrambi alfabetici
    entries.sort(function(a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    // Aggiunge parent se non siamo alla root consentita
    var isRoot = ALLOWED_PATHS.some(function(r) { return r === resolved; });
    var parent = isRoot ? null : path.dirname(resolved);
    if (parent && isAllowed(parent)) {
      entries.unshift({ name: '..', type: 'parent', path: parent });
    }

    return { path: resolved, entries: entries };
  } catch(err) {
    return { error: err.message, path: dirPath, entries: [] };
  }
}

function getRoots() {
  return ALLOWED_PATHS.map(function(p) {
    return { name: path.basename(p) || p, path: p, type: 'dir' };
  }).filter(function(r) {
    try { fs.accessSync(r.path); return true; } catch(e) { return false; }
  });
}

// ── Progress ──────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b) return '0 B';
  var k = 1024, u = ['B','KB','MB','GB','TB'];
  var i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

function progress(label, current, total) {
  var pct  = total > 0 ? Math.min(100, current / total * 100) : 0;
  var fill = Math.round(pct / 5);
  var bar  = Array(fill+1).join('█') + Array(21-fill).join('░');
  process.stdout.write('\r  [' + bar + '] ' + pct.toFixed(1) + '%  ' + fmtBytes(current) + ' / ' + fmtBytes(total) + '   ');
}

// ── SHA-256 ───────────────────────────────────────────────────────────────
function hashFile(filePath) {
  return new Promise(function(resolve, reject) {
    var hash   = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath);
    stream.on('data', function(d) { hash.update(d); });
    stream.on('end',  function()  { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

// ── Chunk reader ──────────────────────────────────────────────────────────
async function* readChunks(filePath, startOffset) {
  var fd  = fs.openSync(filePath, 'r');
  var buf = Buffer.allocUnsafe(CHUNK_SIZE);
  var pos = startOffset || 0;
  try {
    var n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK_SIZE, pos)) > 0) {
      pos += n;
      yield Buffer.from(buf.slice(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ── LAN direct server ─────────────────────────────────────────────────────
function startLocalServer(filePaths) {
  return new Promise(function(resolve) {
    var fileMeta = filePaths.map(function(fp) {
      return { name: path.basename(fp), size: fs.statSync(fp).size, path: fp };
    });

    var srv = http.createServer(function(req, res) {
      if (req.url === '/manifest') {
        var body = JSON.stringify(fileMeta.map(function(f) {
          return { name: f.name, size: f.size };
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }
      var m = req.url.match(/^\/file\/(\d+)$/);
      if (m) {
        var idx = parseInt(m[1], 10);
        if (idx < 0 || idx >= fileMeta.length) { res.writeHead(404); res.end(); return; }
        var f = fileMeta[idx];
        var rangeHeader = req.headers['range'];
        var start = 0;
        if (rangeHeader) {
          var rm = rangeHeader.match(/bytes=(\d+)-/);
          if (rm) start = parseInt(rm[1], 10);
        }
        var remaining = f.size - start;
        res.writeHead(start > 0 ? 206 : 200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': remaining,
          'Accept-Ranges': 'bytes',
        });
        if (remaining <= 0) { res.end(); return; }
        fs.createReadStream(f.path, { start: start }).pipe(res);
        return;
      }
      res.writeHead(404); res.end();
    });

    srv.listen(0, '0.0.0.0', function() {
      var port = srv.address().port;
      var ifaces = os.networkInterfaces();
      var ips = [];
      Object.values(ifaces).forEach(function(list) {
        (list || []).forEach(function(iface) {
          if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        });
      });
      resolve({ server: srv, port: port, addrs: ips.map(function(ip) { return { ip: ip, port: port }; }) });
    });
  });
}

function isReachable(ip, port, timeout) {
  return new Promise(function(resolve) {
    var sock = new net.Socket();
    var done = function(ok) { try { sock.destroy(); } catch(e) {} resolve(ok); };
    sock.setTimeout(timeout || 1500);
    sock.on('connect', function() { done(true); });
    sock.on('error',   function() { done(false); });
    sock.on('timeout', function() { done(false); });
    sock.connect(port, ip);
  });
}

function httpGet(ip, port, urlPath) {
  return new Promise(function(resolve, reject) {
    http.get({ hostname: ip, port: port, path: urlPath }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end',  function()  { resolve(data); });
    }).on('error', reject);
  });
}

function httpDownload(ip, port, urlPath, dest, totalSize, socket, jobId) {
  return new Promise(function(resolve, reject) {
    var existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (existing >= totalSize) { resolve(); return; }

    var ws = fs.createWriteStream(dest, existing > 0 ? { flags: 'a' } : {});
    var received  = existing;
    var hasher    = crypto.createHash('sha256');
    var chunkCnt  = 0;
    if (existing > 0) console.log('  Resume da ' + fmtBytes(existing));

    var options = { hostname: ip, port: port, path: urlPath };
    if (existing > 0) options.headers = { 'Range': 'bytes=' + existing + '-' };

    http.get(options, function(res) {
      res.on('data', function(chunk) {
        ws.write(chunk);
        hasher.update(chunk);
        received += chunk.length;
        chunkCnt++;
        progress(path.basename(dest), received, totalSize);
        if (socket && chunkCnt % 40 === 0) {
          socket.emit('transfer-progress', {
            jobId: jobId, fileIndex: 0, fileName: path.basename(dest),
            bytesDone: received, bytesTotal: totalSize,
            totalDone: received, totalSize: totalSize,
          });
        }
      });
      res.on('end', function() {
        ws.end();
        resolve({ hash: hasher.digest('hex') });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Transfer: sender ──────────────────────────────────────────────────────
async function transferFiles(socket, filePaths, jobId) {
  var fileMeta = filePaths.map(function(fp) {
    return { name: path.basename(fp), size: fs.statSync(fp).size, type: 'application/octet-stream', path: fp };
  });

  var totalBytes = fileMeta.reduce(function(s, f) { return s + f.size; }, 0);
  console.log('File da inviare: ' + fileMeta.length + ' (' + fmtBytes(totalBytes) + ')');

  socket.emit('relay-ctrl', {
    type: 'file-list',
    files: fileMeta.map(function(f) { return { name: f.name, size: f.size, type: f.type }; }),
  });

  // Aspetta resume-info (max 2s)
  var resumeOffsets = await new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve({}); }, 2000);
    socket.once('relay-ctrl', function(msg) {
      clearTimeout(timer);
      if (msg.type === 'resume-info') resolve(msg.offsets || {});
      else resolve({});
    });
  });

  for (var i = 0; i < filePaths.length; i++) {
    var fp          = filePaths[i];
    var meta        = fileMeta[i];
    var startOffset = resumeOffsets[i] ? resumeOffsets[i] : 0;

    socket.emit('relay-ctrl', {
      type: 'file-start', index: i,
      name: meta.name, size: meta.size, fileType: meta.type,
    });

    console.log('Invio [' + (i+1) + '/' + filePaths.length + ']: ' + meta.name);

    var bytesDoneBefore = fileMeta.slice(0, i).reduce(function(s, f) { return s + f.size; }, 0);
    // SHA-256 calcolato in streaming durante l'invio (nessuna doppia lettura)
    var hash = await sendChunks(socket, fp, meta, i, startOffset, bytesDoneBefore, totalBytes, jobId);

    process.stdout.write('\n');
    console.log('  ✓ ' + meta.name + ' [SHA: ' + hash.substring(0, 12) + '...]');
    socket.emit('relay-ctrl', { type: 'file-end', index: i, sha256: hash });
  }

  socket.emit('relay-ctrl', { type: 'xfer-done' });
}

// Restituisce il SHA-256 del file calcolato in streaming durante l'invio
async function sendChunks(socket, fp, meta, fileIndex, startOffset, bytesDoneBefore, totalBytes, jobId) {
  var inFlight  = 0;
  var bytesSent = startOffset;
  var chunkCnt  = 0;
  var hasher    = crypto.createHash('sha256');

  for await (var chunk of readChunks(fp, startOffset)) {
    while (inFlight >= MAX_IN_FLIGHT) {
      await new Promise(function(r) { setImmediate(r); });
    }
    inFlight++;
    hasher.update(chunk);
    socket.emit('relay-chunk', chunk, function() { inFlight--; });
    bytesSent += chunk.length;
    chunkCnt++;
    progress(meta.name, bytesSent, meta.size);

    if (chunkCnt % 10 === 0) {
      socket.emit('transfer-progress', {
        jobId: jobId, fileIndex: fileIndex, fileName: meta.name,
        bytesDone: bytesSent, bytesTotal: meta.size,
        totalDone: bytesDoneBefore + bytesSent, totalSize: totalBytes,
      });
    }
  }

  socket.emit('transfer-progress', {
    jobId: jobId, fileIndex: fileIndex, fileName: meta.name,
    bytesDone: bytesSent, bytesTotal: meta.size,
    totalDone: bytesDoneBefore + bytesSent, totalSize: totalBytes,
  });

  while (inFlight > 0) {
    await new Promise(function(r) { setImmediate(r); });
  }

  return hasher.digest('hex');
}

// ── Transfer: receiver ────────────────────────────────────────────────────
function startReceiving(socket, outputDir, jobId) {
  var rx = {
    currentFile: null, writeStream: null,
    bytesRx: 0, filesDone: 0,
    resumeOffsets: {}, hashers: {}, jobId: jobId || null,
  };

  socket.on('relay-ctrl', function(msg) {
    switch (msg.type) {
      case 'file-list': {
        var total = msg.files.reduce(function(s, f) { return s + f.size; }, 0);
        console.log('Ricezione ' + msg.files.length + ' file (' + fmtBytes(total) + '):');
        msg.files.forEach(function(f, i) { console.log('  [' + (i+1) + '] ' + f.name); });

        // Controlla file parziali
        var offsets = {};
        msg.files.forEach(function(f, i) {
          var safeName = path.basename(f.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
          var dest = path.join(outputDir, safeName);
          if (fs.existsSync(dest)) {
            var sz = fs.statSync(dest).size;
            if (sz > 0 && sz < f.size) offsets[i] = sz;
          }
        });
        rx.resumeOffsets = offsets;
        if (Object.keys(offsets).length > 0) {
          socket.emit('relay-ctrl', { type: 'resume-info', offsets: offsets });
        }
        break;
      }
      case 'file-start': {
        rx.currentFile = msg;
        rx.hashers[msg.index] = crypto.createHash('sha256');
        var isResume = rx.resumeOffsets && rx.resumeOffsets[msg.index] > 0;
        rx.bytesRx   = isResume ? rx.resumeOffsets[msg.index] : 0;
        var safeName = path.basename(msg.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
        var dest = path.join(outputDir, safeName);
        rx.writeStream = fs.createWriteStream(dest, isResume ? { flags: 'a' } : {});
        rx.writeStream.on('error', function(err) {
          console.error('Errore scrittura: ' + err.message);
          socket.disconnect(); process.exit(1);
        });
        console.log('Ricezione: ' + msg.name + (isResume ? ' (resume da ' + fmtBytes(rx.bytesRx) + ')' : '') + '\n  → ' + dest);
        break;
      }
      case 'file-end': {
        if (rx.writeStream) rx.writeStream.end();
        rx.writeStream = null;
        process.stdout.write('\n');
        var idx = msg.index;
        if (rx.hashers[idx] && rx.currentFile) {
          var computed = rx.hashers[idx].digest('hex');
          var expected = msg.sha256 || null;  // sha256 è in file-end (calcolato in streaming dal sender)
          var ok = expected ? (computed === expected) : null;
          if (ok === true)  console.log('  ✓ SHA-256 OK');
          if (ok === false) console.log('  ✗ SHA-256 FAIL! atteso=' + (expected && expected.substring(0,12)) + ' ricevuto=' + computed.substring(0,12));
          socket.emit('device-integrity-report', {
            jobId: rx.jobId, filename: rx.currentFile.name, sha256: computed,
          });
          delete rx.hashers[idx];
        }
        console.log('  ✓ Salvato: ' + (rx.currentFile && rx.currentFile.name));
        rx.filesDone++; rx.currentFile = null;
        break;
      }
      case 'xfer-done': {
        console.log('✓ Completato. ' + rx.filesDone + ' file in: ' + outputDir);
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

// ── Main ──────────────────────────────────────────────────────────────────
console.log('\n🌊 DropWave Agent — ' + LABEL);
console.log('   Server: ' + SERVER);
console.log('   Percorsi consentiti: ' + ALLOWED_PATHS.join(', '));
console.log('');

var sessionActive = false;
var localServer   = null;

var socket = io(SERVER, {
  auth:                { token: TOKEN },
  reconnection:        true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:   2000,
  reconnectionDelayMax: 30000,
  transports:          ['websocket'],
});

socket.on('connect_error', function(err) {
  if (err.message === 'AUTH_REQUIRED' || err.message === 'AUTH_INVALID') {
    console.error('Token non valido. Reinstalla l\'agent.');
    process.exit(1);
  }
  console.log('Riconnessione in corso...');
});

socket.on('connect', function() {
  sessionActive = false;
  socket.emit('register-device', { isAgent: true, label: LABEL });
  console.log('[' + new Date().toLocaleTimeString() + '] Connesso come: ' + LABEL);
});

// ── Filesystem browsing ───────────────────────────────────────────────────
socket.on('fs-list-dir', function(data) {
  var result = listDir(data.path);
  result.reqId = data.reqId;
  socket.emit('fs-list-result', result);
});

socket.on('fs-get-roots', function(data) {
  socket.emit('fs-roots-result', { reqId: data.reqId, roots: getRoots() });
});

// ── Session handling ──────────────────────────────────────────────────────
socket.on('session-ready', async function(data) {
  var role             = data.role;
  var roomId           = data.roomId;
  var peerUsername     = data.peerUsername;
  var filePaths        = data.filePaths || [];      // per sender: percorsi assoluti
  var outputPath       = data.outputPath || null;   // per receiver: cartella destinazione
  var senderLocalAddrs = data.senderLocalAddrs || null;
  var jobId            = data.jobId || null;

  sessionActive = true;
  console.log('\n[' + new Date().toLocaleTimeString() + '] Sessione ' + roomId + ' — ' + role.toUpperCase() + ' (peer: ' + peerUsername + ')');

  if (role === 'sender') {
    if (!filePaths.length) {
      console.error('Nessun file specificato per il sender. Sessione annullata.');
      socket.disconnect(); return;
    }
    // Verifica file
    for (var i = 0; i < filePaths.length; i++) {
      if (!fs.existsSync(filePaths[i])) {
        console.error('File non trovato: ' + filePaths[i]);
        socket.disconnect(); return;
      }
    }

    // Avvia server locale per direct transfer LAN
    localServer = await startLocalServer(filePaths);
    socket.emit('report-local-addrs', localServer.addrs);

    try {
      await transferFiles(socket, filePaths, jobId);
      console.log('\n✓ Trasferimento completato.');
    } catch(err) {
      console.error('Errore trasferimento: ' + err.message);
    } finally {
      if (localServer) { localServer.server.close(); localServer = null; }
      sessionActive = false;
      socket.disconnect();
      // Riconnetti dopo trasferimento completato
      setTimeout(function() { socket.connect(); }, 1000);
    }

  } else {
    // receiver
    var outDir = outputPath || os.homedir();
    fs.mkdirSync(outDir, { recursive: true });

    if (senderLocalAddrs && senderLocalAddrs.length) {
      console.log('  Provo connessione diretta LAN...');
      var ok = await tryDirectDownload(senderLocalAddrs, outDir, socket, jobId);
      if (ok) {
        sessionActive = false;
        socket.disconnect();
        setTimeout(function() { socket.connect(); }, 1000);
        return;
      }
      console.log('  Connessione diretta non riuscita — relay.');
    }

    console.log('In attesa file via relay in: ' + outDir);
    startReceiving(socket, outDir, jobId);
  }
});

async function tryDirectDownload(addrs, outputDir, sock, jobId) {
  var target = null;
  for (var i = 0; i < addrs.length; i++) {
    var ok = await isReachable(addrs[i].ip, addrs[i].port);
    if (ok) { target = addrs[i]; break; }
  }
  if (!target) return false;

  console.log('  Connessione diretta: ' + target.ip + ':' + target.port);
  try {
    var manifest = await httpGet(target.ip, target.port, '/manifest');
    var files    = JSON.parse(manifest);
    var total    = files.reduce(function(s, f) { return s + f.size; }, 0);
    console.log('Ricezione diretta ' + files.length + ' file (' + fmtBytes(total) + ')');

    for (var i = 0; i < files.length; i++) {
      var f       = files[i];
      var safe    = path.basename(f.name).replace(/[/\\?%*:|"<>]/g, '_') || 'file';
      var dest    = path.join(outputDir, safe);
      console.log('  ' + f.name + ' → ' + dest);
      var result  = await httpDownload(target.ip, target.port, '/file/' + i, dest, f.size, sock, jobId);
      process.stdout.write('\n');
      if (result && result.hash) {
        sock.emit('device-integrity-report', { jobId: jobId, filename: f.name, sha256: result.hash });
      }
      console.log('  ✓ ' + f.name);
    }
    console.log('✓ Completato in: ' + outputDir);
    return true;
  } catch(err) {
    console.error('Errore direct download: ' + err.message);
    return false;
  }
}

socket.on('peer-disconnected', function() {
  console.log('Peer disconnesso.');
  if (localServer) { localServer.server.close(); localServer = null; }
  sessionActive = false;
});

process.on('SIGTERM', function() { socket.disconnect(); process.exit(0); });
process.on('SIGINT',  function() { socket.disconnect(); process.exit(0); });

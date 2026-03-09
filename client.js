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
  const pct  = total > 0 ? Math.min(100, Math.round(current / total * 100)) : 0;
  const fill = Math.round(pct / 5); // 20 blocchi totali
  const bar  = '█'.repeat(fill) + '░'.repeat(20 - fill);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${fmtBytes(current)} / ${fmtBytes(total)}  ${label}   `);
}

// ── Async generator: legge file a chunk ──────────────────────────────────
async function* readChunks(filePath) {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK_SIZE, null)) > 0) {
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

  if (!res.body?.ok) {
    console.error('\n❌ Errore:', res.body?.error || 'risposta non valida');
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

async function transferFiles(socket, filePaths) {
  const fileMeta = filePaths.map(fp => ({
    name: path.basename(fp),
    size: fs.statSync(fp).size,
    type: 'application/octet-stream',
  }));

  const totalBytes = fileMeta.reduce((s, f) => s + f.size, 0);
  console.log(`File da inviare: ${fileMeta.length} (${fmtBytes(totalBytes)} totali)`);
  fileMeta.forEach((f, i) => console.log(`  [${i+1}] ${f.name} — ${fmtBytes(f.size)}`));
  console.log('');

  socket.emit('relay-ctrl', { type: 'file-list', files: fileMeta });

  for (let i = 0; i < filePaths.length; i++) {
    const fp   = filePaths[i];
    const meta = fileMeta[i];

    socket.emit('relay-ctrl', {
      type: 'file-start', index: i,
      name: meta.name, size: meta.size, fileType: meta.type,
    });

    console.log(`Invio [${i + 1}/${filePaths.length}]: ${meta.name}`);

    let inFlight  = 0;
    let bytesSent = 0;

    for await (const chunk of readChunks(fp)) {
      // Backpressure: aspetta che l'ack del server riduca i chunk in volo
      while (inFlight >= MAX_IN_FLIGHT) {
        await new Promise(r => setImmediate(r));
      }

      inFlight++;
      socket.emit('relay-chunk', chunk, () => { inFlight--; });

      bytesSent += chunk.length;
      progress(meta.name, bytesSent, meta.size);
    }

    // Aspetta che tutti i chunk siano confermati dal server
    while (inFlight > 0) {
      await new Promise(r => setImmediate(r));
    }

    process.stdout.write('\n');
    socket.emit('relay-ctrl', { type: 'file-end', index: i });
    console.log(`  ✓ ${meta.name}\n`);
  }

  socket.emit('relay-ctrl', { type: 'xfer-done' });
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
        rx.writeStream?.end();
        rx.writeStream = null;
        process.stdout.write('\n');
        console.log(`  ✓ Salvato: ${rx.currentFile?.name}\n`);
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
    // In Node.js, Socket.IO v4 consegna i binari come Buffer
    rx.writeStream.write(chunk);
    rx.bytesRx += chunk.length;
    progress(rx.currentFile.name, rx.bytesRx, rx.currentFile.size);
  });

  socket.on('peer-disconnected', () => {
    console.error('\nIl mittente si è disconnesso prima del completamento.');
    rx.writeStream?.destroy();
    socket.disconnect();
    process.exit(1);
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
    case 'send':    await cmdSend(flags, files);        break;
    case 'receive': await cmdReceive(flags);            break;
    default:
      console.log(`
🌊  DropWave CLI v3

Utilizzo:
  node client.js login
      Autentica e salva il token in ~/.dropwave/token

  node client.js send [--server URL] [--room XXXX] <file1> [file2 ...]
      Invia file. Se --room è omesso, crea una stanza con codice casuale.

  node client.js receive --room XXXX [--output ./cartella] [--server URL]
      Riceve file nella cartella specificata (default: directory corrente).

Variabili d'ambiente:
  DROPWAVE_URL   URL del server (default: http://localhost:3000)

Esempi:
  node client.js login
  node client.js send --room AB12CD report.pdf video.mp4
  node client.js receive --room AB12CD --output ~/Downloads/dropwave
`);
      process.exit(0);
  }
})();

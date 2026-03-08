/* ============================================================
   DropWave v2 — script.js
   Auth + WebRTC P2P File Transfer
   ============================================================ */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────
  const CHUNK_SIZE  = 16 * 1024;       // 16 KB per chunk
  const BUF_HIGH    = 8 * 1024 * 1024; // 8 MB — pause sending
  const BUF_LOW     = 1 * 1024 * 1024; // 1 MB — resume sending

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302'  },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  // ── State ────────────────────────────────────────────────────────────────
  const S = {
    socket:  null,
    pc:      null,    // RTCPeerConnection
    dc:      null,    // RTCDataChannel
    roomId:  null,
    role:    null,    // 'sender' | 'receiver'
    user:    null,    // { id, username }

    // ── Peer auth ──────────────────────────────────────────────────────────
    myPeerToken:       null,  // token che devo mandare all'altro peer
    expectedPeerToken: null,  // token che devo ricevere dall'altro peer
    peerAuthenticated: false, // true solo dopo handshake verificato sul DC

    // Sender
    files:     [],
    txIdx:     0,
    txOffset:  0,
    txStart:   null,
    txPaused:  false,
    _bufLowFn: null,  // resolve fn for buffer-low wait

    // Receiver
    rxFile:    null,  // current file metadata
    rxChunks:  [],
    rxSize:    0,
    rxList:    [],
    rxTotal:   0,
    rxDone:    0,
    rxStart:   null,
  };

  // ── DOM ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ══════════════════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ══════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async () => {
    bindAuthUI();
    bindAvatarUI();

    // Check existing session via httpOnly cookie
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        S.user = await res.json();
        onLoggedIn(false); // false = don't scroll/animate, just restore
      } else {
        showSection('auth-section');
      }
    } catch {
      showSection('auth-section');
    }

    // Auto-fill join code from URL ?join=XXXX
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) $('room-input').value = joinCode.toUpperCase();
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  AUTH UI
  // ══════════════════════════════════════════════════════════════════════════
  function bindAuthUI() {
    $('tab-login').addEventListener('click',    () => switchTab('login'));
    $('tab-register').addEventListener('click', () => switchTab('register'));

    $('form-login').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('li-submit');
      btn.disabled = true;
      btn.textContent = 'Accesso in corso…';
      $('li-err').textContent = '';

      const res  = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: $('li-email').value.trim(), password: $('li-pwd').value }),
      });
      const data = await res.json();

      btn.disabled = false;
      btn.textContent = 'Accedi';

      if (!res.ok) { $('li-err').textContent = data.error; return; }
      S.user = { username: data.username };
      onLoggedIn(true);
    });

    $('form-register').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('rg-submit');
      btn.disabled = true;
      btn.textContent = 'Creazione account…';
      $('rg-err').textContent = '';

      const res  = await fetch('/api/auth/register', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          username: $('rg-name').value.trim(),
          email:    $('rg-email').value.trim(),
          password: $('rg-pwd').value,
        }),
      });
      const data = await res.json();

      btn.disabled = false;
      btn.textContent = 'Crea account';

      if (!res.ok) { $('rg-err').textContent = data.error; return; }
      S.user = { username: data.username };
      onLoggedIn(true);
    });
  }

  function switchTab(tab) {
    const isLogin = tab === 'login';
    $('tab-login').classList.toggle('active', isLogin);
    $('tab-register').classList.toggle('active', !isLogin);
    $('form-login').classList.toggle('hidden', !isLogin);
    $('form-register').classList.toggle('hidden', isLogin);
    $('li-err').textContent = '';
    $('rg-err').textContent = '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  POST-LOGIN FLOW
  // ══════════════════════════════════════════════════════════════════════════
  function onLoggedIn(welcome) {
    // Avatar
    const initials = S.user.username.charAt(0).toUpperCase();
    $('avatar-btn').textContent  = initials;
    $('menu-username').textContent = S.user.username;
    $('avatar-wrap').classList.remove('hidden');

    showSection('home-section');
    if (welcome) showSuccess(`Benvenuto, ${S.user.username}! 👋`);

    connectSocket();
    bindMainUI();
  }

  function connectSocket() {
    // io() called here, after the httpOnly cookie is set.
    // The browser automatically includes it in the WS upgrade request.
    S.socket = io({ reconnectionAttempts: 5 });

    S.socket.on('connect_error', err => {
      if (err.message === 'AUTH_REQUIRED' || err.message === 'AUTH_INVALID') {
        S.user = null;
        $('avatar-wrap').classList.add('hidden');
        showSection('auth-section');
        showError('Sessione scaduta. Accedi di nuovo.');
      }
    });

    bindSocketHandlers();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  AVATAR MENU & LOGOUT
  // ══════════════════════════════════════════════════════════════════════════
  function bindAvatarUI() {
    $('avatar-btn').addEventListener('click', e => {
      e.stopPropagation();
      $('avatar-menu').classList.toggle('hidden');
    });
    document.addEventListener('click', () => $('avatar-menu').classList.add('hidden'));

    $('btn-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      S.socket?.disconnect();
      S.socket = null;
      S.user   = null;
      resetAll();
      $('avatar-wrap').classList.add('hidden');
      $('connection-status').classList.add('hidden');
      showSection('auth-section');
    });

    $('btn-go-home').addEventListener('click', () => {
      $('avatar-menu').classList.add('hidden');
      resetAll();
      showSection('home-section');
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SOCKET HANDLERS
  // ══════════════════════════════════════════════════════════════════════════
  function bindSocketHandlers() {
    const sk = S.socket;

    // room-created: (roomId, myToken)
    sk.on('room-created', (id, myToken) => {
      S.roomId       = id;
      S.myPeerToken  = myToken;
      showSection('sender-panel');
      $('room-code-display').textContent = id;
      setStatus('In attesa del destinatario…', 'waiting');
    });

    // room-joined: (roomId, myToken, expectedSenderToken)
    sk.on('room-joined', (id, myToken, expectedToken) => {
      S.roomId            = id;
      S.myPeerToken       = myToken;
      S.expectedPeerToken = expectedToken;
      showSection('receiver-panel');
      setStatus('Connesso — in attesa del mittente…', 'info');
    });

    // peer-joined: { username, expectedToken } — il sender impara chi attendersi sul DC
    sk.on('peer-joined', ({ username, expectedToken } = {}) => {
      S.expectedPeerToken = expectedToken;
      const name = username
        ? `<span class="peer-name">${esc(username)}</span>`
        : 'Destinatario';
      setStatusHTML(`${name} connesso. Verifica identità…`, 'info');
      initSenderPeer();
    });

    sk.on('offer',         offer     => handleOffer(offer));
    sk.on('answer',        answer    => S.pc?.setRemoteDescription(answer));
    sk.on('ice-candidate', candidate => {
      if (candidate && S.pc) S.pc.addIceCandidate(candidate).catch(console.warn);
    });

    sk.on('room-error',        msg => showError(msg));
    sk.on('peer-disconnected', ()  => {
      setStatus('Peer disconnesso', 'error');
      showError('L\'altro peer si è disconnesso.');
      cleanupPeer();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WebRTC
  // ══════════════════════════════════════════════════════════════════════════
  function createPC() {
    const pc = new RTCPeerConnection(ICE);
    S.pc = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) S.socket.emit('ice-candidate', { roomId: S.roomId, candidate });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
        setStatus('Connessione P2P stabilita ✓', 'success');
      else if (pc.iceConnectionState === 'failed')
        setStatus('Connessione P2P fallita', 'error');
    };

    return pc;
  }

  async function initSenderPeer() {
    const pc = createPC();
    const dc = pc.createDataChannel('dw', { ordered: true });
    setupDC(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.socket.emit('offer', { roomId: S.roomId, offer });
  }

  async function handleOffer(offer) {
    const pc = createPC();
    pc.ondatachannel = e => setupDC(e.channel);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    S.socket.emit('answer', { roomId: S.roomId, answer });
  }

  function setupDC(dc) {
    S.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUF_LOW;

    dc.addEventListener('open', () => {
      // Appena il canale apre, manda subito il proprio token di identità.
      // NESSUN altro messaggio viene accettato finché l'handshake non è completo.
      S.peerAuthenticated = false;
      sendCtrl({ type: 'peer-auth', token: S.myPeerToken, username: S.user.username });
      setStatus('Verifica identità peer…', 'info');
    });

    dc.addEventListener('message',  e => onDCMessage(e.data));
    dc.addEventListener('error',    e => { console.error('DC', e); setStatus('Errore canale dati', 'error'); });
    dc.addEventListener('bufferedamountlow', () => {
      if (S.txPaused && S._bufLowFn) {
        S.txPaused = false;
        const fn = S._bufLowFn;
        S._bufLowFn = null;
        fn();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN UI BINDINGS
  // ══════════════════════════════════════════════════════════════════════════
  function bindMainUI() {
    // Prevent double-binding on reconnect
    if (bindMainUI._done) return;
    bindMainUI._done = true;

    $('btn-create').addEventListener('click', () => {
      S.role = 'sender';
      S.socket.emit('create-room', genId());
    });

    $('btn-join').addEventListener('click', joinRoom);
    $('room-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

    // Drop zone
    const dz = $('drop-zone');
    dz.addEventListener('dragover',  e  => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('over');
      addFiles([...e.dataTransfer.files]);
    });
    dz.addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });

    $('btn-send').addEventListener('click',  startTransfer);
    $('btn-clear').addEventListener('click', clearFiles);

    $('btn-copy-code').addEventListener('click', () => {
      navigator.clipboard.writeText(S.roomId).catch(() => {});
      flashBtn('btn-copy-code', 'Copiato!', 'Copia');
    });

    $('btn-copy-link').addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}?join=${S.roomId}`;
      navigator.clipboard.writeText(url).catch(() => {});
      flashBtn('btn-copy-link', 'Copiato!', 'Link');
    });
  }

  function joinRoom() {
    const code = $('room-input').value.trim().toUpperCase();
    if (code.length < 4) { showError('Codice troppo corto — minimo 4 caratteri.'); return; }
    S.role = 'receiver';
    S.socket.emit('join-room', code);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SENDER — File Management
  // ══════════════════════════════════════════════════════════════════════════
  function addFiles(newFiles) {
    const seen = new Set(S.files.map(f => f.name + f.size));
    newFiles.forEach(f => { if (!seen.has(f.name + f.size)) S.files.push(f); });
    renderTxList();
  }

  function clearFiles() { S.files = []; renderTxList(); }

  function renderTxList() {
    const list = $('tx-file-list');
    list.innerHTML = '';

    if (!S.files.length) { $('tx-files-section').classList.add('hidden'); return; }

    $('tx-files-section').classList.remove('hidden');
    $('tx-count').textContent = S.files.length;

    S.files.forEach((f, i) => {
      const item = makeFileItem(i, f.name, f.size, 'tx');
      // Remove button
      const rm = document.createElement('button');
      rm.className = 'btn btn-ghost';
      rm.title = 'Rimuovi';
      rm.innerHTML = '✕';
      rm.style.cssText = 'font-size:16px;padding:0 7px;margin-left:4px;flex-shrink:0';
      rm.addEventListener('click', ev => { ev.stopPropagation(); S.files.splice(i, 1); renderTxList(); });
      item.querySelector('.fi-top').appendChild(rm);
      list.appendChild(item);
    });

    const total = S.files.reduce((s, f) => s + f.size, 0);
    $('tx-total-info').textContent = `${S.files.length} file · ${fmt(total)}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SENDER — Transfer
  // ══════════════════════════════════════════════════════════════════════════
  async function startTransfer() {
    if (!S.dc || S.dc.readyState !== 'open') { showError('Canale non disponibile.'); return; }
    if (!S.files.length)                     { showError('Aggiungi almeno un file.'); return; }

    $('btn-send').disabled = true;
    $('tx-progress-block').classList.remove('hidden');

    S.txIdx   = 0;
    S.txOffset = 0;
    S.txStart  = Date.now();

    sendCtrl({ type: 'file-list', files: S.files.map(f => ({ name: f.name, size: f.size, type: f.type })) });
    await sendAll();
  }

  async function sendAll() {
    while (S.txIdx < S.files.length) {
      const file = S.files[S.txIdx];
      S.txOffset = 0;

      sendCtrl({ type: 'file-start', index: S.txIdx, name: file.name, size: file.size, fileType: file.type });
      setFileStatus('tx', S.txIdx, 'Invio…', 'active');
      $(`tx-item-${S.txIdx}`).classList.add('is-active');

      await sendChunks(file);

      sendCtrl({ type: 'file-end', index: S.txIdx });
      setFileStatus('tx', S.txIdx, 'Inviato ✓', 'done');
      $(`tx-item-${S.txIdx}`)?.classList.replace('is-active', 'is-done');
      setPbar('tx', S.txIdx, 100, true);

      S.txIdx++;
      await sleep(30);
    }

    sendCtrl({ type: 'xfer-done' });
    setStatus('Trasferimento completato! 🎉', 'success');
    showSuccess('Tutti i file inviati con successo!');
    $('btn-send').textContent = '✓ Completato';
  }

  async function sendChunks(file) {
    while (S.txOffset < file.size) {
      // Backpressure
      if (S.dc.bufferedAmount > BUF_HIGH) {
        S.txPaused = true;
        await waitBufLow();
      }

      const slice  = file.slice(S.txOffset, S.txOffset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      S.dc.send(buffer);
      S.txOffset += buffer.byteLength;

      const pct = Math.round(S.txOffset / file.size * 100);
      setPbar('tx', S.txIdx, pct);
      updateTotalBar('tx');
    }
  }

  function waitBufLow() {
    return new Promise(resolve => {
      if (!S.dc || S.dc.bufferedAmount <= BUF_LOW) { resolve(); return; }
      S._bufLowFn = resolve;
      // Safety poll every 80 ms
      const iv = setInterval(() => {
        if (!S.dc || S.dc.bufferedAmount <= BUF_LOW) {
          clearInterval(iv);
          if (S._bufLowFn) { const fn = S._bufLowFn; S._bufLowFn = null; fn(); }
        }
      }, 80);
    });
  }

  function sendCtrl(obj) { S.dc.send(JSON.stringify(obj)); }

  // ══════════════════════════════════════════════════════════════════════════
  //  RECEIVER — Incoming Messages
  // ══════════════════════════════════════════════════════════════════════════
  function onDCMessage(data) {
    if (typeof data === 'string') handleCtrl(JSON.parse(data));
    else handleChunk(data);
  }

  function handleCtrl(msg) {
    // ── Peer auth handshake — DEVE essere il primo messaggio ────────────────
    if (msg.type === 'peer-auth') {
      handlePeerAuth(msg);
      return;
    }

    // Blocca qualsiasi altro messaggio se l'identità non è ancora verificata
    if (!S.peerAuthenticated) {
      console.warn('[DC] Messaggio ricevuto prima del completamento dell\'handshake. Ignorato.');
      S.dc.close();
      showError('Errore di autenticazione: sequenza handshake non valida.');
      return;
    }

    switch (msg.type) {
      case 'file-list':   initRxList(msg.files);           break;
      case 'file-start':  startRxFile(msg);                break;
      case 'file-end':    finishRxFile(msg.index);         break;
      case 'xfer-done':   onRxDone();                      break;
    }
  }

  function handlePeerAuth(msg) {
    // Confronto time-safe per prevenire timing attacks
    const expected = S.expectedPeerToken || '';
    const received = msg.token            || '';

    // Usa lunghezza fissa per il confronto (entrambi 64 char hex)
    const ok = expected.length === 64
            && received.length === 64
            && timingSafeEqual(expected, received);

    if (!ok) {
      console.error('[DC] Autenticazione peer FALLITA', { expected, received });
      S.dc.close();
      cleanupPeer();
      setStatus('Autenticazione peer fallita!', 'error');
      showError('Identità del peer non verificata. Connessione chiusa.');
      return;
    }

    S.peerAuthenticated = true;
    const peerName = msg.username ? `<span class="peer-name">${esc(msg.username)}</span>` : 'Peer';
    console.log(`[DC] Peer autenticato: ${msg.username}`);

    if (S.role === 'sender') {
      setStatusHTML(`${peerName} autenticato ✓ — Pronto per inviare.`, 'success');
      $('btn-send').disabled = false;
    } else {
      setStatusHTML(`${peerName} autenticato ✓ — In attesa dei file…`, 'success');
    }
  }

  // Confronto stringa sicuro contro timing attacks (implementazione JS pura)
  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  function initRxList(files) {
    S.rxList  = files;
    S.rxTotal = files.reduce((s, f) => s + f.size, 0);
    S.rxDone  = 0;
    S.rxStart = Date.now();

    $('rx-waiting').classList.add('hidden');
    $('rx-files-section').classList.remove('hidden');
    $('rx-progress-block').classList.remove('hidden');
    $('rx-count').textContent = files.length;
    $('rx-total-info').textContent = `${files.length} file · ${fmt(S.rxTotal)}`;

    const list = $('rx-file-list');
    list.innerHTML = '';
    files.forEach((f, i) => list.appendChild(makeFileItem(i, f.name, f.size, 'rx')));
  }

  function startRxFile(info) {
    S.rxFile   = info;
    S.rxChunks = [];
    S.rxSize   = 0;
    setFileStatus('rx', info.index, 'Ricezione…', 'active');
    $(`rx-item-${info.index}`)?.classList.add('is-active');
  }

  function handleChunk(buf) {
    if (!S.peerAuthenticated) { S.dc.close(); showError('Chunk binario ricevuto prima dell\'auth. Connessione chiusa.'); return; }
    if (!S.rxFile) return;
    S.rxChunks.push(buf);
    S.rxSize += buf.byteLength;
    S.rxDone  += buf.byteLength;
    const pct = Math.round(S.rxSize / S.rxFile.size * 100);
    setPbar('rx', S.rxFile.index, pct);
    updateTotalBar('rx');
  }

  function finishRxFile(idx) {
    const info = S.rxFile;
    if (!info) return;

    // Reconstruct and auto-download
    const blob = new Blob(S.rxChunks, { type: info.fileType || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: info.name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    // Free memory immediately
    S.rxChunks = [];

    setFileStatus('rx', idx, '⬇ Scaricato ✓', 'done');
    $(`rx-item-${idx}`)?.classList.replace('is-active', 'is-done');
    setPbar('rx', idx, 100, true);
  }

  function onRxDone() {
    setStatus('Ricezione completata! 🎉', 'success');
    showSuccess('Tutti i file sono stati scaricati!');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PROGRESS HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  function setPbar(side, idx, pct, done = false) {
    const bar  = $(`${side}-bar-${idx}`);
    const pctEl = $(`${side}-pct-${idx}`);
    if (bar)  { bar.style.width = pct + '%'; if (done) bar.classList.add('done'); }
    if (pctEl) pctEl.textContent = pct + '%';
  }

  function setFileStatus(side, idx, text, cls = '') {
    const el = $(`${side}-stat-${idx}`);
    if (!el) return;
    el.textContent = text;
    el.className   = `fi-status${cls ? ' ' + cls : ''}`;
  }

  function updateTotalBar(side) {
    if (side === 'tx') {
      const done  = S.files.slice(0, S.txIdx).reduce((s, f) => s + f.size, 0) + S.txOffset;
      const total = S.files.reduce((s, f) => s + f.size, 0);
      renderTotalBar('tx', done, total, S.txStart);
    } else {
      renderTotalBar('rx', S.rxDone, S.rxTotal, S.rxStart);
    }
  }

  function renderTotalBar(side, done, total, t0) {
    const pct   = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    const barEl = $(`${side}-total-bar`);
    const pctEl = $(`${side}-total-pct`);
    const spEl  = $(`${side}-total-speed`);

    if (barEl) barEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = `${pct}% · ${fmt(done)} / ${fmt(total)}`;
    if (spEl && t0) {
      const elapsed = (Date.now() - t0) / 1000;
      if (elapsed > 0.5) spEl.textContent = fmt(done / elapsed) + '/s';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DOM BUILDERS
  // ══════════════════════════════════════════════════════════════════════════
  function makeFileItem(idx, name, size, side) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.id = `${side}-item-${idx}`;
    div.innerHTML = `
      <div class="fi-top">
        <span class="fi-icon">${icon(name)}</span>
        <div class="fi-meta">
          <span class="fi-name">${esc(name)}</span>
          <span class="fi-size">${fmt(size)}</span>
        </div>
        <span class="fi-status" id="${side}-stat-${idx}">In attesa</span>
      </div>
      <div class="pbar-wrap"><div class="pbar" id="${side}-bar-${idx}"></div></div>
      <div class="fi-foot">
        <span id="${side}-pct-${idx}">0%</span>
        <span id="${side}-spd-${idx}"></span>
      </div>`;
    return div;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI UTILITIES
  // ══════════════════════════════════════════════════════════════════════════
  function showSection(id) {
    ['auth-section', 'home-section', 'sender-panel', 'receiver-panel'].forEach(s => {
      const el = $(s);
      if (el) el.classList.toggle('hidden', s !== id);
    });
    const inApp = !['auth-section'].includes(id);
    if (!inApp) $('connection-status').classList.add('hidden');
  }

  function setStatus(msg, type) {
    const el = $('connection-status');
    el.textContent = msg;
    el.className = `st-${type}`;
    el.classList.remove('hidden');
  }

  function setStatusHTML(html, type) {
    const el = $('connection-status');
    el.innerHTML = html;
    el.className = `st-${type}`;
    el.classList.remove('hidden');
  }

  function showError(msg) {
    const el = $('error-toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.add('hidden'), 5000);
  }

  function showSuccess(msg) {
    const el = $('success-toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showSuccess._t);
    showSuccess._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function flashBtn(id, tempText, origText) {
    const btn = $(id);
    btn.textContent = tempText;
    clearTimeout(flashBtn[id]);
    flashBtn[id] = setTimeout(() => { btn.textContent = origText; }, 2000);
  }

  function resetAll() {
    cleanupPeer();
    S.role = null; S.roomId = null;
    S.myPeerToken = null; S.expectedPeerToken = null; S.peerAuthenticated = false;
    S.files = []; S.txIdx = 0; S.txOffset = 0;
    S.rxFile = null; S.rxChunks = []; S.rxList = [];
    bindMainUI._done = false; // allow re-binding on next login
    $('tx-file-list').innerHTML = '';
    $('rx-file-list').innerHTML = '';
    $('tx-files-section').classList.add('hidden');
    $('tx-progress-block').classList.add('hidden');
    $('rx-files-section').classList.add('hidden');
    $('rx-progress-block').classList.add('hidden');
    $('rx-waiting').classList.remove('hidden');
    $('btn-send').disabled = true;
    $('btn-send').textContent = '⚡ Avvia Trasferimento';
    $('room-code-display').textContent = '——————';
  }

  function cleanupPeer() {
    if (S.pc) { S.pc.close(); S.pc = null; }
    S.dc = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PURE UTILS
  // ══════════════════════════════════════════════════════════════════════════
  function genId()  { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function fmt(b) {
    if (!b) return '0 B';
    const k = 1024, u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / k ** i).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function icon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const m = {
      pdf: '📄', jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', svg: '🖼', ico: '🖼',
      mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
      mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', aac: '🎵',
      zip: '📦', rar: '📦', tar: '📦', gz: '📦', '7z': '📦', bz2: '📦',
      js: '💻', ts: '💻', py: '💻', java: '💻', go: '💻', rs: '💻',
      html: '🌐', css: '🎨',
      doc: '📝', docx: '📝', txt: '📝', md: '📝',
      xls: '📊', xlsx: '📊', csv: '📊',
      ppt: '📋', pptx: '📋',
      exe: '⚙️', dmg: '⚙️', deb: '⚙️', iso: '💿',
      json: '📋', xml: '📋', yaml: '📋', yml: '📋',
    };
    return m[ext] || '📎';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();

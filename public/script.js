/* ============================================================
   DropWave v3 — script.js
   Auth + WebSocket relay file transfer (no WebRTC)
   ============================================================ */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────
  const CHUNK_SIZE    = 256 * 1024;  // 256 KB — WebSocket gestisce chunk grandi
  const SOCK_BUF_MAX  = 16;          // pausa se sendBuffer ha più di N elementi
  const BACKPRESSURE_MS = 20;        // ms di attesa quando il buffer è pieno

  // ── State ────────────────────────────────────────────────────────────────
  const S = {
    socket: null,
    roomId: null,
    role:   null,   // 'sender' | 'receiver'
    user:   null,   // { id, username }

    // Sender
    files:    [],
    txIdx:    0,
    txOffset: 0,
    txStart:  null,

    // Receiver
    rxFile:   null,
    rxChunks: [],
    rxSize:   0,
    rxList:   [],
    rxTotal:  0,
    rxDone:   0,
    rxStart:  null,
  };

  // ── DOM ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ══════════════════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ══════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async () => {
    bindAuthUI();
    bindAvatarUI();

    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        S.user = await res.json();
        onLoggedIn(false);
      } else {
        showSection('auth-section');
      }
    } catch {
      showSection('auth-section');
    }

    // Auto-fill join code from URL ?join=XXXX
    const joinCode = new URLSearchParams(window.location.search).get('join');
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
      btn.disabled = true; btn.textContent = 'Accesso in corso…';
      $('li-err').textContent = '';

      const res  = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('li-email').value.trim(), password: $('li-pwd').value }),
      });
      const data = await res.json();
      btn.disabled = false; btn.textContent = 'Accedi';
      if (!res.ok) { $('li-err').textContent = data.error; return; }
      S.user = { username: data.username };
      onLoggedIn(true);
    });

    $('form-register').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('rg-submit');
      btn.disabled = true; btn.textContent = 'Creazione account…';
      $('rg-err').textContent = '';

      const res  = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('rg-name').value.trim(),
          email:    $('rg-email').value.trim(),
          password: $('rg-pwd').value,
        }),
      });
      const data = await res.json();
      btn.disabled = false; btn.textContent = 'Crea account';
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
  //  POST-LOGIN
  // ══════════════════════════════════════════════════════════════════════════
  function onLoggedIn(welcome) {
    $('avatar-btn').textContent    = S.user.username.charAt(0).toUpperCase();
    $('menu-username').textContent = S.user.username;
    $('avatar-wrap').classList.remove('hidden');

    showSection('home-section');
    if (welcome) showSuccess(`Benvenuto, ${S.user.username}! 👋`);

    connectSocket();
    bindMainUI();
  }

  function connectSocket() {
    // Il browser invia automaticamente il cookie httpOnly nella richiesta WS
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

    sk.on('room-created', (id) => {
      S.roomId = id;
      showSection('sender-panel');
      $('room-code-display').textContent = id;
      setStatus('In attesa del destinatario…', 'waiting');
    });

    sk.on('room-joined', (id) => {
      S.roomId = id;
      showSection('receiver-panel');
      setStatus('Connesso — in attesa del mittente…', 'info');
    });

    // Il sender viene avvisato: peer arrivato → abilita il tasto di invio
    sk.on('peer-joined', ({ username } = {}) => {
      const name = username
        ? `<span class="peer-name">${esc(username)}</span>`
        : 'Destinatario';
      setStatusHTML(`${name} connesso. Pronto per inviare.`, 'success');
      $('btn-send').disabled = false;
    });

    // Messaggi di controllo relayati dal server
    sk.on('relay-ctrl',  msg => handleCtrl(msg));

    // Chunk binari relayati dal server
    sk.on('relay-chunk', buf => handleChunk(buf));

    sk.on('room-error', msg => showError(msg));

    sk.on('peer-disconnected', () => {
      setStatus('Peer disconnesso', 'error');
      showError('L\'altro peer si è disconnesso.');
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN UI BINDINGS
  // ══════════════════════════════════════════════════════════════════════════
  function bindMainUI() {
    if (bindMainUI._done) return;
    bindMainUI._done = true;

    $('btn-create').addEventListener('click', () => {
      S.role = 'sender';
      S.socket.emit('create-room', genId());
    });

    $('btn-join').addEventListener('click', joinRoom);
    $('room-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

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
      navigator.clipboard.writeText(`${location.origin}${location.pathname}?join=${S.roomId}`).catch(() => {});
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
      const rm   = document.createElement('button');
      rm.className = 'btn btn-ghost';
      rm.title     = 'Rimuovi';
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
  //  SENDER — Transfer via Socket.io relay
  // ══════════════════════════════════════════════════════════════════════════
  async function startTransfer() {
    if (!S.socket?.connected) { showError('Socket non connesso.'); return; }
    if (!S.files.length)      { showError('Aggiungi almeno un file.'); return; }

    $('btn-send').disabled = true;
    $('tx-progress-block').classList.remove('hidden');

    S.txIdx    = 0;
    S.txOffset = 0;
    S.txStart  = Date.now();

    S.socket.emit('relay-ctrl', {
      type:  'file-list',
      files: S.files.map(f => ({ name: f.name, size: f.size, type: f.type })),
    });

    await sendAll();
  }

  async function sendAll() {
    while (S.txIdx < S.files.length) {
      const file = S.files[S.txIdx];
      S.txOffset = 0;

      S.socket.emit('relay-ctrl', {
        type: 'file-start', index: S.txIdx,
        name: file.name, size: file.size, fileType: file.type,
      });
      setFileStatus('tx', S.txIdx, 'Invio…', 'active');
      $(`tx-item-${S.txIdx}`)?.classList.add('is-active');

      await sendChunks(file);

      S.socket.emit('relay-ctrl', { type: 'file-end', index: S.txIdx });
      setFileStatus('tx', S.txIdx, 'Inviato ✓', 'done');
      $(`tx-item-${S.txIdx}`)?.classList.replace('is-active', 'is-done');
      setPbar('tx', S.txIdx, 100, true);

      S.txIdx++;
      await sleep(30);
    }

    S.socket.emit('relay-ctrl', { type: 'xfer-done' });
    setStatus('Trasferimento completato! 🎉', 'success');
    showSuccess('Tutti i file inviati con successo!');
    $('btn-send').textContent = '✓ Completato';
  }

  async function sendChunks(file) {
    while (S.txOffset < file.size) {
      // Backpressure: aspetta se il buffer interno di socket.io è troppo pieno
      while (S.socket.sendBuffer && S.socket.sendBuffer.length > SOCK_BUF_MAX) {
        await sleep(BACKPRESSURE_MS);
      }

      const slice  = file.slice(S.txOffset, S.txOffset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      S.socket.emit('relay-chunk', buffer);
      S.txOffset += buffer.byteLength;

      setPbar('tx', S.txIdx, Math.round(S.txOffset / file.size * 100));
      updateTotalBar('tx');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RECEIVER — Incoming Messages
  // ══════════════════════════════════════════════════════════════════════════
  function handleCtrl(msg) {
    switch (msg.type) {
      case 'file-list':  initRxList(msg.files);   break;
      case 'file-start': startRxFile(msg);         break;
      case 'file-end':   finishRxFile(msg.index);  break;
      case 'xfer-done':  onRxDone();               break;
    }
  }

  function initRxList(files) {
    S.rxList  = files;
    S.rxTotal = files.reduce((s, f) => s + f.size, 0);
    S.rxDone  = 0;
    S.rxStart = Date.now();

    $('rx-waiting').classList.add('hidden');
    $('rx-files-section').classList.remove('hidden');
    $('rx-progress-block').classList.remove('hidden');
    $('rx-count').textContent      = files.length;
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
    if (!S.rxFile) return;
    // Socket.IO v4 nel browser consegna i binari come ArrayBuffer
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer ?? buf;
    S.rxChunks.push(ab);
    S.rxSize += ab.byteLength;
    S.rxDone += ab.byteLength;
    setPbar('rx', S.rxFile.index, Math.round(S.rxSize / S.rxFile.size * 100));
    updateTotalBar('rx');
  }

  function finishRxFile(idx) {
    const info = S.rxFile;
    if (!info) return;

    const blob = new Blob(S.rxChunks, { type: info.fileType || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: info.name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    S.rxChunks = []; // libera memoria subito
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
    const bar   = $(`${side}-bar-${idx}`);
    const pctEl = $(`${side}-pct-${idx}`);
    if (bar)   { bar.style.width = pct + '%'; if (done) bar.classList.add('done'); }
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
      renderTotalBar('tx', done, S.files.reduce((s, f) => s + f.size, 0), S.txStart);
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
    div.id        = `${side}-item-${idx}`;
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
    if (id === 'auth-section') $('connection-status').classList.add('hidden');
  }

  function setStatus(msg, type) {
    const el = $('connection-status');
    el.textContent = msg;
    el.className   = `st-${type}`;
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

  function flashBtn(id, tmp, orig) {
    const btn = $(id);
    btn.textContent = tmp;
    clearTimeout(flashBtn[id]);
    flashBtn[id] = setTimeout(() => { btn.textContent = orig; }, 2000);
  }

  function resetAll() {
    S.role = null; S.roomId = null;
    S.files = []; S.txIdx = 0; S.txOffset = 0;
    S.rxFile = null; S.rxChunks = []; S.rxList = [];
    bindMainUI._done = false;
    $('tx-file-list').innerHTML = '';
    $('rx-file-list').innerHTML = '';
    $('tx-files-section').classList.add('hidden');
    $('tx-progress-block').classList.add('hidden');
    $('rx-files-section').classList.add('hidden');
    $('rx-progress-block').classList.add('hidden');
    $('rx-waiting').classList.remove('hidden');
    $('btn-send').disabled     = true;
    $('btn-send').textContent  = '⚡ Avvia Trasferimento';
    $('room-code-display').textContent = '——————';
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
      pdf:'📄', jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',svg:'🖼',
      mp4:'🎬',mov:'🎬',avi:'🎬',mkv:'🎬',webm:'🎬',
      mp3:'🎵',wav:'🎵',flac:'🎵',ogg:'🎵',aac:'🎵',
      zip:'📦',rar:'📦',tar:'📦',gz:'📦','7z':'📦',
      js:'💻',ts:'💻',py:'💻',java:'💻',go:'💻',rs:'💻',
      html:'🌐',css:'🎨',
      doc:'📝',docx:'📝',txt:'📝',md:'📝',
      xls:'📊',xlsx:'📊',csv:'📊',
      json:'📋',xml:'📋',yaml:'📋',yml:'📋',
    };
    return m[ext] || '📎';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();

/* ============================================================
   DropWave v4 — script.js
   Admin panel + Device mode + WebSocket relay file transfer
   ============================================================ */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────
  const CHUNK_SIZE      = 256 * 1024;  // 256 KB
  const SOCK_BUF_MAX    = 16;
  const BACKPRESSURE_MS = 20;

  // ── Mode detection ───────────────────────────────────────────────────────
  const MODE = window.location.pathname.startsWith('/device') ? 'device' : 'admin';

  // ── State ────────────────────────────────────────────────────────────────
  const S = {
    socket: null,
    roomId: null,
    role:   null,   // 'sender' | 'receiver'
    user:   null,   // { id, username }

    // Admin
    selectedSender:   null,  // socketId
    selectedReceiver: null,  // socketId
    lastDevices:      [],    // last devices-update snapshot

    // Agent file browser
    fbMode:          null,   // 'sender' | 'receiver'
    fbDeviceId:      null,   // socketId del device che si sta sfogliando
    fbCurrentPath:   null,
    fbSelectedFiles: [],     // array di {path, name, size}
    fbSelectedDir:   null,   // {path, name} (per receiver)
    selectedFiles:   [],     // file selezionati sul sender (confermati)
    selectedOutputPath: null, // cartella destinazione sul receiver (confermata)

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
    // Update subtitle and badge based on mode
    const sub = $('logo-sub');
    if (sub) sub.textContent = MODE === 'admin' ? 'ADMIN PANEL' : 'DEVICE';

    const badge = $('menu-role-badge');
    if (badge) badge.textContent = MODE === 'admin' ? 'Admin' : 'Device';

    // Show device URL hint in placeholder
    const devUrl = $('device-url');
    if (devUrl) devUrl.textContent = `${location.origin}/device`;

    bindAuthUI();
    bindAvatarUI();
    bindAdminUI();

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

    if (welcome) showSuccess(`Benvenuto, ${S.user.username}!`);

    connectSocket();
  }

  function connectSocket() {
    S.socket = io({ reconnectionAttempts: 5 });

    S.socket.on('connect', () => {
      if (MODE === 'admin') {
        S.socket.emit('register-admin');
        showSection('admin-section');
      } else {
        S.socket.emit('register-device');
        showSection('device-section');
        const pill = $('device-pill-text');
        if (pill && S.user) pill.textContent = `Connesso come ${S.user.username}`;
      }
    });

    S.socket.on('connect_error', err => {
      if (err.message === 'AUTH_REQUIRED' || err.message === 'AUTH_INVALID') {
        S.user = null;
        $('avatar-wrap').classList.add('hidden');
        showSection('auth-section');
        showError('Sessione scaduta. Accedi di nuovo.');
      }
    });

    bindSocketHandlers();
    bindFileBrowser();
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
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SOCKET HANDLERS
  // ══════════════════════════════════════════════════════════════════════════
  function bindSocketHandlers() {
    const sk = S.socket;

    // ── Admin handlers ───────────────────────────────────────────────────
    sk.on('devices-update', devices => {
      S.lastDevices = devices;
      renderDeviceGrid(devices);
    });

    sk.on('session-created', function(data) {
      var roomId = data.roomId, sender = data.sender, receiver = data.receiver;
      showSuccess('Sessione ' + roomId + ': ' + sender + ' → ' + receiver);
      addActiveSession(roomId, sender, receiver);
      S.selectedSender     = null;
      S.selectedReceiver   = null;
      S.selectedFiles      = [];
      S.selectedOutputPath = null;
      updateSessionBar();
      updateAgentTransferBtn();
    });

    sk.on('admin-error', msg => showError(msg));

    // ── Device handlers ──────────────────────────────────────────────────
    sk.on('session-ready', ({ role, roomId, peerUsername }) => {
      S.role   = role;
      S.roomId = roomId;

      if (role === 'sender') {
        showSection('sender-panel');
        $('room-code-display').textContent = roomId;
        setStatus(`Connesso con ${esc(peerUsername)}. Seleziona i file.`, 'success');
        $('btn-send').disabled = false;
        bindSenderUI();
      } else {
        showSection('receiver-panel');
        setStatus(`Connesso con ${esc(peerUsername)}. In attesa dei file…`, 'info');
      }
    });

    // ── Relay handlers ───────────────────────────────────────────────────
    sk.on('relay-ctrl',  msg => handleCtrl(msg));
    sk.on('relay-chunk', buf => handleChunk(buf));

    sk.on('peer-disconnected', () => {
      setStatus('Peer disconnesso', 'error');
      showError("L'altro peer si è disconnesso.");
    });

    sk.on('transfer-progress', function(data) {
      updateSessionProgress(data);
    });

    // ── Queue events ─────────────────────────────────────────────────────
    sk.on('server-transfer-queued', function(data) {
      addQueueItem(data);
      showSuccess('Trasferimento pianificato: ' + data.jobId);
    });
    sk.on('server-transfer-started', function(data) {
      updateQueueItem(data.jobId, 'running');
    });
    sk.on('server-transfer-done', function(data) {
      updateQueueItem(data.jobId, 'done');
    });
    sk.on('server-transfer-failed', function(data) {
      updateQueueItem(data.jobId, 'failed');
      showError('Trasferimento fallito: ' + (data.error || data.jobId));
    });
    sk.on('server-transfer-cancelled', function(data) {
      updateQueueItem(data.jobId, 'cancelled');
    });

    // ── Integrity ─────────────────────────────────────────────────────────
    sk.on('server-integrity-result', function(data) {
      updateIntegrityBadge(data.jobId, data.ok);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN — Device Grid
  // ══════════════════════════════════════════════════════════════════════════
  function renderDeviceGrid(devices) {
    const grid  = $('device-grid');
    const count = $('device-count');
    if (count) count.textContent = `${devices.length} dispositiv${devices.length === 1 ? 'o' : 'i'}`;
    if (!grid) return;

    if (devices.length === 0) {
      grid.innerHTML = `
        <div class="no-devices">
          <div class="nd-icon">📡</div>
          <p>Nessun dispositivo connesso.<br>
             Fai aprire questa URL sui dispositivi da controllare:</p>
          <code>${esc(location.origin)}/device</code>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    devices.forEach(dev => {
      const isSender   = S.selectedSender   === dev.socketId;
      const isReceiver = S.selectedReceiver === dev.socketId;
      const statusCls  = dev.status === 'in-session' ? 'in-session' : 'idle';
      const statusTxt  = dev.status === 'in-session' ? 'In sessione' : 'Disponibile';

      const card = document.createElement('div');
      card.className = `device-card${isSender ? ' is-sender' : ''}${isReceiver ? ' is-receiver' : ''}`;
      card.dataset.socketId = dev.socketId;

      card.innerHTML =
        '<div class="dc-top">' +
          '<div class="dc-avatar">' + esc(dev.username.charAt(0).toUpperCase()) + '</div>' +
          '<div>' +
            '<div class="dc-name">' + esc(dev.label || dev.username) + (dev.isAgent ? '<span class="agent-badge">agent</span>' : '') + '</div>' +
            '<div class="dc-ip">' + esc(dev.ip) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="dc-status ' + statusCls + '">' + statusTxt + ' · ' + msAgo(dev.connectedAt) + '</div>' +
        '<div class="dc-actions">' +
          '<button class="dc-btn sender-btn' + (isSender ? ' sel-sender' : '') + '" data-sid="' + esc(dev.socketId) + '">↑ Mittente</button>' +
          '<button class="dc-btn receiver-btn' + (isReceiver ? ' sel-receiver' : '') + '" data-sid="' + esc(dev.socketId) + '">↓ Ricevente</button>' +
          '<button class="dc-btn browse-btn" data-sid="' + esc(dev.socketId) + '" title="Sfoglia filesystem">📁</button>' +
        '</div>';

      card.querySelector('.sender-btn').addEventListener('click', e => {
        e.stopPropagation();
        const sid = e.currentTarget.dataset.sid;
        S.selectedSender = S.selectedSender === sid ? null : sid;
        if (S.selectedSender && S.selectedSender === S.selectedReceiver) S.selectedReceiver = null;
        updateSessionBar();
        renderDeviceGrid(S.lastDevices);
      });

      card.querySelector('.receiver-btn').addEventListener('click', e => {
        e.stopPropagation();
        const sid = e.currentTarget.dataset.sid;
        S.selectedReceiver = S.selectedReceiver === sid ? null : sid;
        if (S.selectedReceiver && S.selectedReceiver === S.selectedSender) S.selectedSender = null;
        updateSessionBar();
        renderDeviceGrid(S.lastDevices);
      });

      card.querySelector('.browse-btn').addEventListener('click', function(e) {
        e.stopPropagation();
        var sid  = e.currentTarget.dataset.sid;
        var mode = S.selectedSender === sid ? 'sender' : S.selectedReceiver === sid ? 'receiver' : null;
        if (!mode) {
          showError('Seleziona prima il ruolo del dispositivo (↑ Mittente o ↓ Ricevente).');
          return;
        }
        openFileBrowser(sid, mode);
      });

      grid.appendChild(card);
    });
  }

  function updateSessionBar() {
    const senderVal   = $('slot-sender-val');
    const receiverVal = $('slot-receiver-val');
    const slotSender  = $('slot-sender');
    const slotRcv     = $('slot-receiver');
    const startBtn    = $('btn-start-session');

    // Find names from current devices snapshot
    const senderDev   = S.lastDevices.find(d => d.socketId === S.selectedSender);
    const receiverDev = S.lastDevices.find(d => d.socketId === S.selectedReceiver);

    if (senderVal) {
      senderVal.textContent = senderDev ? senderDev.username : 'Nessuno selezionato';
      senderVal.className   = `slot-value${senderDev ? '' : ' empty'}`;
    }
    if (slotSender) slotSender.className = `session-slot${senderDev ? ' filled-sender' : ''}`;

    if (receiverVal) {
      receiverVal.textContent = receiverDev ? receiverDev.username : 'Nessuno selezionato';
      receiverVal.className   = `slot-value${receiverDev ? '' : ' empty'}`;
    }
    if (slotRcv) slotRcv.className = `session-slot${receiverDev ? ' filled-receiver' : ''}`;

    if (startBtn) startBtn.disabled = !(S.selectedSender && S.selectedReceiver);
    var schedBtn = $('btn-schedule-session');
    if (schedBtn) schedBtn.disabled = !(S.selectedSender && S.selectedReceiver);
    updateAgentTransferBtn();
  }

  function addActiveSession(roomId, sender, receiver) {
    const block = $('active-sessions-block');
    const list  = $('sessions-list');
    if (block) block.classList.remove('hidden');
    if (!list)  return;

    const cnt = $('sessions-count');
    if (cnt) cnt.textContent = list.children.length + 1;

    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.room = roomId;
    item.innerHTML = `
      <span class="session-room">${esc(roomId)}</span>
      <span class="session-peers">
        ${esc(sender)} <span class="arrow">→</span> ${esc(receiver)}
      </span>
      <span style="font-size:12px;color:var(--muted)">${new Date().toLocaleTimeString()}</span>
      <div class="si-progress">
        <div class="si-pbar-wrap"><div class="si-pbar"></div></div>
        <span class="si-pct">0%</span>
      </div>`;
    list.insertBefore(item, list.firstChild);
  }

  function updateSessionProgress(data) {
    const item = document.querySelector('.session-item[data-room="' + data.roomId + '"]');
    if (item) {
      const pct = data.totalSize > 0 ? Math.min(100, data.totalDone / data.totalSize * 100) : 0;
      const barEl = item.querySelector('.si-pbar');
      const pctEl = item.querySelector('.si-pct');
      if (barEl) barEl.style.width = pct.toFixed(1) + '%';
      if (pctEl) pctEl.textContent = pct.toFixed(1) + '% — ' + fmtBytes(data.totalDone) + ' / ' + fmtBytes(data.totalSize);
    }
    // Aggiorna queue-item se esiste un jobId
    if (data.jobId) {
      var pct2 = data.totalSize > 0 ? Math.min(100, data.totalDone / data.totalSize * 100) : 0;
      var qbar = $('qp-' + data.jobId);
      var qpct = $('qpct-' + data.jobId);
      if (qbar) qbar.style.width = pct2.toFixed(1) + '%';
      if (qpct) qpct.textContent = pct2.toFixed(1) + '%';
    }
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    const k = 1024, u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / k ** i).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function bindAdminUI() {
    // Bound on DOMContentLoaded; btn-start-session may not exist yet if mode=device
    const btn = $('btn-start-session');
    if (!btn) return;
    btn.addEventListener('click', function() {
      if (!S.selectedSender || !S.selectedReceiver) {
        showError('Seleziona mittente e ricevente prima di avviare la sessione.');
        return;
      }
      S.socket.emit('admin-create-session', {
        senderSocketId:   S.selectedSender,
        receiverSocketId: S.selectedReceiver,
      });
    });

    // Scheduling modal
    var scheduleBtn = $('btn-schedule-session');
    if (scheduleBtn) {
      scheduleBtn.addEventListener('click', function() {
        if (!S.selectedSender || !S.selectedReceiver) {
          showError('Seleziona mittente e ricevente.');
          return;
        }
        var senderDev   = S.lastDevices.find(function(d) { return d.socketId === S.selectedSender; });
        var receiverDev = S.lastDevices.find(function(d) { return d.socketId === S.selectedReceiver; });
        $('modal-sender-name').textContent   = senderDev   ? senderDev.username   : S.selectedSender;
        $('modal-receiver-name').textContent = receiverDev ? receiverDev.username : S.selectedReceiver;
        $('modal-schedule').classList.remove('hidden');
      });
    }

    var modalCancel = $('modal-cancel-btn');
    if (modalCancel) {
      modalCancel.addEventListener('click', function() {
        $('modal-schedule').classList.add('hidden');
      });
    }

    var modalConfirm = $('modal-confirm-btn');
    if (modalConfirm) {
      modalConfirm.addEventListener('click', function() {
        var dt = $('schedule-datetime').value;
        S.socket.emit('admin-queue-transfer', {
          senderSocketId:   S.selectedSender,
          receiverSocketId: S.selectedReceiver,
          scheduledAt:      dt ? new Date(dt).toISOString() : null,
        });
        $('modal-schedule').classList.add('hidden');
        // Passa al tab coda
        var queueTabBtn = document.querySelector('.tab-btn[data-tab="queue"]');
        if (queueTabBtn) queueTabBtn.click();
      });
    }

    var refreshQueue = $('btn-refresh-queue');
    if (refreshQueue) {
      refreshQueue.addEventListener('click', function() { loadQueue(); });
    }

    var agentBtn = $('btn-agent-transfer');
    if (agentBtn) {
      agentBtn.addEventListener('click', function() {
        if (!S.selectedSender || !S.selectedReceiver) {
          showError('Seleziona mittente e ricevente.');
          return;
        }
        if (!S.selectedFiles || !S.selectedFiles.length) {
          showError('Sfoglia il mittente e seleziona i file da inviare.');
          return;
        }
        if (!S.selectedOutputPath) {
          showError('Sfoglia il ricevente e seleziona la cartella di destinazione.');
          return;
        }
        S.socket.emit('admin-start-agent-transfer', {
          senderSocketId:   S.selectedSender,
          receiverSocketId: S.selectedReceiver,
          filePaths:   S.selectedFiles.map(function(f) { return f.path; }),
          outputPath:  S.selectedOutputPath,
        });
        // Reset selezione file
        S.selectedFiles      = [];
        S.selectedOutputPath = null;
        updateAgentTransferBtn();
      });
    }

    bindTabNav();
  }

  function bindTabNav() {
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.add('hidden'); });
        btn.classList.add('active');
        var pane = document.getElementById('tab-' + tab);
        if (pane) pane.classList.remove('hidden');
        if (tab === 'queue') loadQueue();
      });
    });
  }

  function addQueueItem(data) {
    var list  = $('queue-list');
    var empty = $('queue-empty');
    if (empty) empty.classList.add('hidden');
    if (!list) return;

    var item = document.createElement('div');
    item.className = 'queue-item';
    item.id = 'qi-' + data.jobId;
    item.innerHTML =
      '<div class="qi-header">' +
        '<span class="qi-id">' + esc(data.jobId) + '</span>' +
        '<span class="qi-status ' + esc(data.status) + '">' + statusLabel(data.status) + '</span>' +
      '</div>' +
      '<div class="qi-peers">' + esc(data.sender) + '<span class="arrow">→</span>' + esc(data.receiver) + '</div>' +
      '<div class="si-progress">' +
        '<div class="si-pbar-wrap"><div class="si-pbar" id="qp-' + esc(data.jobId) + '"></div></div>' +
        '<span class="si-pct" id="qpct-' + esc(data.jobId) + '">0%</span>' +
        '<span class="integrity-badge integrity-pending" id="qi-int-' + esc(data.jobId) + '">SHA-256</span>' +
      '</div>' +
      '<div class="qi-footer">' +
        '<span class="qi-time">' + (data.scheduledAt ? 'Pianificato: ' + new Date(data.scheduledAt).toLocaleString() : 'Immediato') + '</span>' +
        '<div class="qi-actions">' +
          '<button class="btn btn-ghost" onclick="cancelTransfer(\'' + esc(data.jobId) + '\')">✕ Cancella</button>' +
        '</div>' +
      '</div>';
    list.insertBefore(item, list.firstChild);
  }

  function updateQueueItem(jobId, status) {
    var item = $('qi-' + jobId);
    if (!item) return;
    var badge = item.querySelector('.qi-status');
    if (badge) { badge.className = 'qi-status ' + status; badge.textContent = statusLabel(status); }
  }

  function updateIntegrityBadge(jobId, ok) {
    var badge = $('qi-int-' + jobId);
    if (!badge) return;
    badge.className = 'integrity-badge ' + (ok ? 'integrity-ok' : 'integrity-fail');
    badge.textContent = ok ? 'v SHA-256' : 'x SHA-256';
  }

  function statusLabel(s) {
    var labels = { queued: 'In coda', running: 'In corso', done: 'Completato', failed: 'Fallito', cancelled: 'Cancellato' };
    return labels[s] || s;
  }

  function loadQueue() {
    fetch('/api/transfers')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        var list = $('queue-list');
        if (!list) return;
        list.innerHTML = '';
        if (!rows.length) {
          list.innerHTML = '<div class="queue-empty">Nessun trasferimento registrato.</div>';
          return;
        }
        rows.forEach(function(row) {
          addQueueItem({
            jobId:       row.job_id,
            status:      row.status,
            sender:      row.sender_socket_id || '—',
            receiver:    row.receiver_socket_id || '—',
            scheduledAt: row.scheduled_at ? row.scheduled_at * 1000 : null,
          });
        });
      });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SENDER — UI Bindings (called once when session-ready role=sender)
  // ══════════════════════════════════════════════════════════════════════════
  function bindSenderUI() {
    if (bindSenderUI._done) return;
    bindSenderUI._done = true;

    const dz = $('drop-zone');
    if (dz) {
      dz.addEventListener('dragover',  e  => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('over');
        addFiles([...e.dataTransfer.files]);
      });
      dz.addEventListener('click', () => $('file-input').click());
    }
    $('file-input')?.addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
    $('btn-send')?.addEventListener('click',  startTransfer);
    $('btn-clear')?.addEventListener('click', clearFiles);
    $('btn-copy-code')?.addEventListener('click', () => {
      navigator.clipboard.writeText(S.roomId).catch(() => {});
      flashBtn('btn-copy-code', 'Copiato!', 'Copia');
    });
    $('btn-copy-link')?.addEventListener('click', () => {
      navigator.clipboard.writeText(`${location.origin}/device`).catch(() => {});
      flashBtn('btn-copy-link', 'Copiato!', 'Link');
    });
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
      rm.className = 'btn btn-ghost'; rm.title = 'Rimuovi'; rm.innerHTML = '✕';
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
    if (!S.socket?.connected) { showError('Socket non connesso.'); return; }
    if (!S.files.length)      { showError('Aggiungi almeno un file.'); return; }

    $('btn-send').disabled = true;
    $('tx-progress-block').classList.remove('hidden');
    S.txIdx = 0; S.txOffset = 0; S.txStart = Date.now();

    S.socket.emit('relay-ctrl', {
      type: 'file-list',
      files: S.files.map(f => ({ name: f.name, size: f.size, type: f.type })),
    });
    await sendAll();
  }

  async function sendAll() {
    while (S.txIdx < S.files.length) {
      const file = S.files[S.txIdx];
      S.txOffset = 0;
      S.socket.emit('relay-ctrl', { type: 'file-start', index: S.txIdx, name: file.name, size: file.size, fileType: file.type });
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
    S.rxList = files; S.rxTotal = files.reduce((s, f) => s + f.size, 0);
    S.rxDone = 0; S.rxStart = Date.now();
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
    S.rxFile = info; S.rxChunks = []; S.rxSize = 0;
    setFileStatus('rx', info.index, 'Ricezione…', 'active');
    $(`rx-item-${info.index}`)?.classList.add('is-active');
  }

  function handleChunk(buf) {
    if (!S.rxFile) return;
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
      const done = S.files.slice(0, S.txIdx).reduce((s, f) => s + f.size, 0) + S.txOffset;
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
    div.className = 'file-item'; div.id = `${side}-item-${idx}`;
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
    ['auth-section','admin-section','device-section','sender-panel','receiver-panel'].forEach(s => {
      const el = $(s);
      if (el) el.classList.toggle('hidden', s !== id);
    });
    if (id === 'auth-section') $('connection-status')?.classList.add('hidden');
  }

  function setStatus(msg, type) {
    const el = $('connection-status');
    if (!el) return;
    el.textContent = msg; el.className = `st-${type}`;
    el.classList.remove('hidden');
  }

  function showError(msg) {
    const el = $('error-toast'); if (!el) return;
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.add('hidden'), 5000);
  }

  function showSuccess(msg) {
    const el = $('success-toast'); if (!el) return;
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(showSuccess._t);
    showSuccess._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function flashBtn(id, tmp, orig) {
    const btn = $(id); if (!btn) return;
    btn.textContent = tmp;
    clearTimeout(flashBtn[id]);
    flashBtn[id] = setTimeout(() => { btn.textContent = orig; }, 2000);
  }

  function resetAll() {
    S.role = null; S.roomId = null;
    S.selectedSender = null; S.selectedReceiver = null; S.lastDevices = [];
    S.files = []; S.txIdx = 0; S.txOffset = 0;
    S.rxFile = null; S.rxChunks = []; S.rxList = [];
    bindSenderUI._done = false;
    $('tx-file-list')?.replaceChildren();
    $('rx-file-list')?.replaceChildren();
    $('tx-files-section')?.classList.add('hidden');
    $('tx-progress-block')?.classList.add('hidden');
    $('rx-files-section')?.classList.add('hidden');
    $('rx-progress-block')?.classList.add('hidden');
    $('rx-waiting')?.classList.remove('hidden');
    const sendBtn = $('btn-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⚡ Avvia Trasferimento'; }
    $('room-code-display') && ($('room-code-display').textContent = '——————');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PURE UTILS
  // ══════════════════════════════════════════════════════════════════════════
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function msAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60)   return `${sec}s fa`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m fa`;
    return `${Math.floor(sec / 3600)}h fa`;
  }

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

  // ── File Browser ───────────────────────────────────────────────────────────
  function openFileBrowser(deviceSocketId, mode) {
    S.fbMode     = mode;
    S.fbDeviceId = deviceSocketId;
    S.fbCurrentPath  = null;
    S.fbSelectedFiles = [];
    S.fbSelectedDir   = null;

    var dev = S.lastDevices.find(function(d) { return d.socketId === deviceSocketId; });
    $('fb-title').textContent = mode === 'sender'
      ? '📤 Seleziona file da ' + (dev ? dev.label || dev.username : deviceSocketId)
      : '📥 Seleziona cartella su ' + (dev ? dev.label || dev.username : deviceSocketId);

    $('fb-modal').classList.remove('hidden');
    $('fb-list').innerHTML = '<div class="fb-loading">Caricamento...</div>';
    $('fb-selection').textContent = 'Nessuna selezione';
    $('fb-confirm-btn').disabled = true;
    updateFbBreadcrumb(null);

    // Chiedi le root
    var reqId = 'roots-' + Date.now();
    S.socket.emit('admin-fs-roots', { targetSocketId: deviceSocketId, reqId: reqId });
  }

  function fbListDir(p) {
    S.fbCurrentPath = p;
    $('fb-list').innerHTML = '<div class="fb-loading">Caricamento...</div>';
    var reqId = 'ls-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    S.socket.emit('admin-fs-list', { targetSocketId: S.fbDeviceId, path: p, reqId: reqId });
  }

  function renderFbEntries(data) {
    var list = $('fb-list');
    if (data.error) {
      list.innerHTML = '<div class="fb-loading" style="color:var(--error)">' + esc(data.error) + '</div>';
      return;
    }
    updateFbBreadcrumb(data.path);
    list.innerHTML = '';

    if (!data.entries || !data.entries.length) {
      list.innerHTML = '<div class="fb-loading">Cartella vuota</div>';
      return;
    }

    data.entries.forEach(function(entry) {
      var row = document.createElement('div');
      row.className = 'fb-entry';

      var isSelected = S.fbMode === 'sender'
        ? S.fbSelectedFiles.some(function(f) { return f.path === entry.path; })
        : (S.fbSelectedDir && S.fbSelectedDir.path === entry.path);

      if (isSelected) row.classList.add('selected');

      var icon = entry.type === 'parent' ? '⬆' :
                 entry.type === 'dir'    ? '📁' : fileIcon(entry.name);

      row.innerHTML =
        '<span class="fb-icon">' + icon + '</span>' +
        '<span class="fb-name">' + esc(entry.name) + '</span>' +
        '<span class="fb-size">' + (entry.size != null ? fmtBytes(entry.size) : '') + '</span>';

      if (S.fbMode === 'sender' && entry.type === 'file') {
        var cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.className = 'fb-check';
        cb.checked = isSelected;
        cb.addEventListener('change', function() {
          if (cb.checked) {
            S.fbSelectedFiles.push({ path: entry.path, name: entry.name, size: entry.size });
          } else {
            S.fbSelectedFiles = S.fbSelectedFiles.filter(function(f) { return f.path !== entry.path; });
          }
          updateFbFooter();
        });
        row.appendChild(cb);
        row.addEventListener('click', function(e) {
          if (e.target === cb) return;
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        });

      } else if (entry.type === 'dir' || entry.type === 'parent') {
        row.addEventListener('click', function() {
          fbListDir(entry.path);
        });
        if (S.fbMode === 'receiver' && entry.type === 'dir') {
          var selBtn = document.createElement('button');
          selBtn.className = 'btn btn-outline';
          selBtn.style.cssText = 'font-size:11px;padding:3px 10px;flex-shrink:0';
          selBtn.textContent = isSelected ? '✓ Selezionata' : 'Seleziona';
          selBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            S.fbSelectedDir = { path: entry.path, name: entry.name };
            updateFbFooter();
            renderFbEntries(data); // re-render per aggiornare highlight
          });
          row.appendChild(selBtn);
        }
      }

      list.appendChild(row);
    });
  }

  function updateFbBreadcrumb(p) {
    var el = $('fb-breadcrumb');
    if (!p) { el.textContent = '/'; return; }
    el.innerHTML = '<span>' + esc(p) + '</span>';
  }

  function updateFbFooter() {
    var sel = $('fb-selection');
    var btn = $('fb-confirm-btn');
    if (S.fbMode === 'sender') {
      var n = S.fbSelectedFiles.length;
      var tot = S.fbSelectedFiles.reduce(function(s, f) { return s + (f.size || 0); }, 0);
      sel.textContent = n > 0 ? n + ' file selezionati (' + fmtBytes(tot) + ')' : 'Nessun file selezionato';
      btn.disabled = n === 0;
    } else {
      sel.textContent = S.fbSelectedDir ? 'Destinazione: ' + S.fbSelectedDir.path : 'Nessuna cartella selezionata';
      btn.disabled = !S.fbSelectedDir;
    }
  }

  function fileIcon(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var m = {
      pdf:'📄', jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼',
      mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬',
      mp3:'🎵', wav:'🎵', flac:'🎵',
      zip:'📦', rar:'📦', tar:'📦', gz:'📦',
      js:'💻', ts:'💻', py:'💻',
      doc:'📝', docx:'📝', txt:'📝',
    };
    return m[ext] || '📎';
  }

  function bindFileBrowser() {
    $('fb-close').addEventListener('click', function() {
      $('fb-modal').classList.add('hidden');
    });
    $('fb-cancel-btn').addEventListener('click', function() {
      $('fb-modal').classList.add('hidden');
    });
    $('fb-confirm-btn').addEventListener('click', function() {
      if (S.fbMode === 'sender') {
        S.selectedFiles = S.fbSelectedFiles.slice();
        showSuccess(S.selectedFiles.length + ' file selezionati per l\'invio');
      } else {
        S.selectedOutputPath = S.fbSelectedDir.path;
        showSuccess('Destinazione: ' + S.selectedOutputPath);
      }
      $('fb-modal').classList.add('hidden');
      updateAgentTransferBtn();
    });

    // Socket handlers per fs browsing
    S.socket.on('fs-roots-result', function(data) {
      if (!data.roots || !data.roots.length) {
        $('fb-list').innerHTML = '<div class="fb-loading">Nessuna root disponibile</div>';
        return;
      }
      // Vai direttamente alla prima root
      fbListDir(data.roots[0].path);
    });

    S.socket.on('fs-list-result', function(data) {
      if (data.deviceSocketId !== S.fbDeviceId) return; // risposta per altro device
      renderFbEntries(data);
    });
  }

  function updateAgentTransferBtn() {
    var btn = $('btn-agent-transfer');
    if (!btn) return;
    var ready = S.selectedSender && S.selectedReceiver &&
                S.selectedFiles && S.selectedFiles.length > 0 &&
                S.selectedOutputPath;
    btn.disabled = !ready;
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    var k = 1024, u = ['B','KB','MB','GB','TB'];
    var i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  // Esposta globalmente per i handler onclick inline
  window.cancelTransfer = function(jobId) {
    if (!S.socket) return;
    S.socket.emit('admin-cancel-transfer', { jobId: jobId });
  };

})();

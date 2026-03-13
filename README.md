# 🌊 DropWave

Sistema di trasferimento file P2P con pannello admin web, agent daemon persistente e CLI.
Il server funge da relay WebSocket e da centro di controllo — i file transitano attraverso di esso oppure direttamente via LAN.

---

## Architettura

```
[Admin Panel (browser)]  ──┐
                           ├──▶  [Server]  ◀──▶  [Agent / CLI / Device browser]
[Device (browser / CLI)]  ──┘
```

| Componente | Descrizione |
|---|---|
| `server.js` | Server centrale — Express + Socket.io, auth JWT, DB SQLite |
| `agent.js` | Daemon persistente installabile su qualsiasi macchina Linux |
| `client.js` | CLI interattiva — login, send, receive, device mode |
| `public/` | SPA — pannello admin + modalità device browser |
| `install.sh` | Installer agent (systemd / OpenRC / nohup) |

---

## Funzionalità

- **Pannello admin web** — seleziona mittente e ricevente tra i dispositivi connessi, avvia trasferimenti, sfoglia il filesystem remoto
- **Agent daemon** — si installa con un comando, riconnessione automatica, controllabile da remoto
- **LAN direct transfer** — se i due device sono sulla stessa rete il file viaggia direttamente via HTTP (senza passare dal server relay); fallback automatico al relay
- **Transfer scheduling** — pianifica trasferimenti a data/ora futura; sopravvivono al restart del server
- **SHA-256 streaming** — hash calcolato durante l'invio senza doppia lettura del file; verifica lato receiver con report al server
- **Resume trasferimenti** — file parziali ripresi dall'offset corretto
- **Filesystem browser** — l'admin sfoglia il filesystem di qualsiasi device/agent connesso
- **Coda e cronologia** — tutti i job sono tracciati nel DB con stato, progresso e integrità
- **CLI multi-comando** — `login`, `device`, `send`, `receive`
- **Autenticazione** — JWT httpOnly cookie (browser) + token nell'handshake Socket.io (CLI/agent)

---

## Stack

| Layer | Tecnologia |
|---|---|
| Server | Node.js + Express + Socket.io |
| Database | SQLite via `better-sqlite3` |
| Autenticazione | JWT + bcrypt (12 round) |
| Trasferimento relay | Socket.io binary chunks (256 KB, backpressure 8 in-flight) |
| Trasferimento diretto | HTTP chunked con Range support (resume) |
| Integrità | SHA-256 streaming (crypto Node.js built-in) |
| Frontend | HTML5 / CSS3 / JavaScript vanilla |
| Container | Docker + Docker Compose |

---

## Avvio rapido

### Locale

```bash
git clone https://github.com/Sergent3/dropwave.git
cd dropwave
npm install
JWT_SECRET=cambia-questo-in-produzione node server.js
# → http://localhost:3000
```

### Docker

```bash
docker compose up --build
# → http://localhost:3000
```

### Variabili d'ambiente

| Variabile | Descrizione | Default |
|---|---|---|
| `JWT_SECRET` | Chiave firma JWT — **obbligatoria in produzione** | stringa di sviluppo |
| `PORT` | Porta del server | `3000` |
| `DB_PATH` | Percorso del file SQLite | `./data/users.db` |

---

## Installazione agent su un device remoto

```bash
curl http://<SERVER>/install.sh | bash
# oppure, per preservare stdin:
bash <(curl -s http://<SERVER>/install.sh)
```

Lo script:
1. Verifica / installa Node.js
2. Scarica `agent.js` dal server
3. Chiede le credenziali e salva il token in `~/.dropwave/agent.json`
4. Registra il servizio (systemd root → systemd user → OpenRC → nohup)

Il device compare automaticamente nel pannello admin.

**Config agent** (`~/.dropwave/agent.json`):

```json
{
  "server": "http://<SERVER>",
  "token": "<JWT>",
  "label": "nome-macchina",
  "allowedPaths": ["/"]
}
```

---

## CLI

```bash
# Autenticazione (salva token in ~/.dropwave/token)
node client.js login

# Modalità device — controllabile dall'admin
node client.js device --server http://<SERVER> [--output ~/Downloads] [file1 file2 ...]

# Invio diretto con codice stanza (v3)
node client.js send --server http://<SERVER> --room XXXX file.zip

# Ricezione diretta con codice stanza (v3)
node client.js receive --server http://<SERVER> --room XXXX --output ./cartella
```

---

## Flusso trasferimento agent-driven

```
Admin sfoglia il filesystem del sender → seleziona file
Admin sfoglia il filesystem del receiver → seleziona cartella destinazione
Admin clicca 🚀 Trasferisci
  └▶ server crea roomId + jobId, notifica entrambi i device
       ├▶ sender avvia HTTP server locale, riporta IP:porta
       └▶ receiver tenta connessione diretta LAN
            ├▶ successo → download HTTP diretto (resume supportato)
            └▶ fallback → relay WebSocket
  └▶ receiver calcola SHA-256, invia report al server
  └▶ job marcato "done" nel DB
```

---

## Struttura del progetto

```
dropwave/
├── server.js          # Server centrale, REST API, Socket.io relay
├── agent.js           # Daemon device — filesystem browser, sender/receiver
├── client.js          # CLI — login, send, receive, device mode
├── install.sh         # Installer agent
├── public/
│   ├── index.html     # SPA admin panel + device mode
│   └── script.js      # UI, file browser, relay sender/receiver
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## API REST

| Metodo | Endpoint | Descrizione |
|---|---|---|
| `POST` | `/api/auth/register` | Registrazione |
| `POST` | `/api/auth/login` | Login (imposta cookie JWT) |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/auth/me` | Utente corrente |
| `GET` | `/api/transfers` | Lista trasferimenti |
| `PATCH` | `/api/transfers/:jobId` | Cancella / ripianifica job |
| `DELETE` | `/api/transfers/:jobId` | Elimina job dalla cronologia |
| `DELETE` | `/api/transfers` | Elimina tutta la cronologia |
| `GET` | `/health` | Status server |

---

## Licenza

MIT

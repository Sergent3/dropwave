# 🌊 DropWave

**Trasferimento file P2P direttamente tra browser, senza toccare il server.**

DropWave usa WebRTC DataChannel per connettere due peer in modo diretto e cifrato (DTLS). Il server Node.js funge esclusivamente da **signaling server** e da **notaio di autenticazione** — nessun byte dei file viene mai caricato su di esso.

---

## Funzionalità

- **P2P puro** — i file viaggiano direttamente tra i due browser via WebRTC DataChannel
- **Autenticazione a 3 livelli** — JWT per il server, token monouso per il canale P2P, handshake mutuo sul DataChannel
- **File grandi** — chunking a 16 KB con backpressure, supporta file da 1 GB+
- **Liste di file** — invio sequenziale di più file con progress bar individuale e totale
- **Download automatico** — ogni file viene scaricato non appena ricevuto, senza aspettare la fine
- **Velocità in tempo reale** — MB/s aggiornato durante il trasferimento
- **Link diretto** — genera un URL `?join=CODICE` da condividere al destinatario
- **UI dark moderna** — Inter font, glassmorphism, orbs animati, avatar dropdown

---

## Stack

| Layer | Tecnologia |
|---|---|
| Signaling server | Node.js + Express + Socket.io |
| Database utenti | SQLite via `better-sqlite3` |
| Autenticazione | JWT (httpOnly cookie, 7 giorni) + bcrypt (12 round) |
| Trasferimento | WebRTC DataChannel (DTLS cifrato) |
| Frontend | HTML5 / CSS3 / JavaScript vanilla |
| Container | Docker + Docker Compose |

---

## Come funziona l'autenticazione

```
1. Entrambi i peer fanno login → ricevono un JWT in httpOnly cookie
2. Il server valida il JWT su ogni connessione Socket.io
3. Alla creazione/join della stanza, il server genera token monouso
   e li distribuisce via canale Socket.io (già autenticato)
4. Quando il DataChannel WebRTC apre, i peer si scambiano i token
   e verificano l'identità dell'altro prima di accettare qualsiasi file
```

Un peer non autenticato o con token errato viene disconnesso immediatamente.

---

## Avvio rapido

### Locale

```bash
git clone https://github.com/Sergent3/dropwave.git
cd dropwave
npm install
JWT_SECRET=un-segreto-lungo-e-random npm start
# → http://localhost:3000
```

### Docker

```bash
cp .env.example .env
# Modifica .env: imposta JWT_SECRET con una stringa casuale sicura
docker compose up --build
# → http://localhost:3000
```

> **Nota:** Su reti diverse con NAT simmetrico, aggiungere un server TURN alla configurazione ICE in `public/script.js` per garantire la connettività.

---

## Variabili d'ambiente

| Variabile | Descrizione | Default |
|---|---|---|
| `JWT_SECRET` | Chiave di firma JWT — **obbligatoria in produzione** | stringa di sviluppo |
| `PORT` | Porta del server | `3000` |
| `DB_PATH` | Percorso del file SQLite | `./data/users.db` |

---

## Struttura del progetto

```
dropwave/
├── server.js          # Signaling server, auth REST API, Socket.io
├── public/
│   ├── index.html     # SPA — UI con auth, sender, receiver
│   └── script.js      # WebRTC, chunking, handshake P2P
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## Flusso di utilizzo

1. **Mittente** → *Crea Sessione* → condivide il codice a 6 caratteri (o il link diretto)
2. **Destinatario** → inserisce il codice → *Unisciti*
3. Handshake WebRTC automatico + verifica token mutua
4. Mittente trascina i file → *Avvia Trasferimento*
5. Il destinatario vede il progresso e scarica ogni file automaticamente al termine

---

## Licenza

MIT

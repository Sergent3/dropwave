#!/bin/bash
set -e

SERVER="http://51.38.82.241:9000"
INSTALL_DIR="$HOME/.dropwave"
AGENT_JS="$INSTALL_DIR/agent.js"
CONFIG_FILE="$INSTALL_DIR/agent.json"
NODE_MODULES="$INSTALL_DIR/node_modules"

echo ""
echo "🌊 DropWave Agent Installer"
echo "   Server: $SERVER"
echo ""

mkdir -p "$INSTALL_DIR"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Node.js non trovato. Installazione..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
  elif command -v apk &>/dev/null; then
    apk add --no-cache nodejs npm
  else
    echo "Installa Node.js manualmente: https://nodejs.org"
    exit 1
  fi
fi

echo "✓ Node.js $(node --version)"

# Download agent
echo "Download agent.js..."
curl -fsSL "$SERVER/agent.js" -o "$AGENT_JS"
chmod +x "$AGENT_JS"

# Install dipendenze
echo "Installazione dipendenze..."
cd "$INSTALL_DIR"
cat > package.json << 'PKGJSON'
{"name":"dropwave-agent","version":"5.0.0","private":true}
PKGJSON
npm install socket.io-client --save --silent

echo "✓ Dipendenze installate"

# Login
echo ""
echo "Credenziali DropWave (account esistente o nuovo):"
read -p "Email: " DW_EMAIL
read -s -p "Password: " DW_PASSWORD
echo ""

RESPONSE=$(curl -s -X POST "$SERVER/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DW_EMAIL\",\"password\":\"$DW_PASSWORD\"}")

TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"//')
USERNAME=$(echo "$RESPONSE" | grep -o '"username":"[^"]*"' | sed 's/"username":"//;s/"//')

if [ -z "$TOKEN" ]; then
  echo "❌ Login fallito. Verifica email e password."
  exit 1
fi

echo "✓ Autenticato come: $USERNAME"

# Allowed paths
ALLOWED="\"$HOME\""
[ -d "/media" ]      && ALLOWED="$ALLOWED,\"/media\""
[ -d "/mnt" ]        && ALLOWED="$ALLOWED,\"/mnt\""
[ -d "/home/movie" ] && ALLOWED="$ALLOWED,\"/home/movie\""
[ -d "/data" ]       && ALLOWED="$ALLOWED,\"/data\""

HOSTNAME_LABEL=$(hostname)

# Config
cat > "$CONFIG_FILE" << CONFIGEOF
{
  "server": "$SERVER",
  "token": "$TOKEN",
  "label": "$HOSTNAME_LABEL",
  "allowedPaths": [$ALLOWED]
}
CONFIGEOF
chmod 600 "$CONFIG_FILE"

echo "✓ Config salvata: $CONFIG_FILE"

# Installa servizio
echo ""
SYSTEMD_UNIT="[Unit]
Description=DropWave Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(which node) $AGENT_JS
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target"

OPENRC_SCRIPT="#!/sbin/openrc-run
description=\"DropWave Agent\"
command=\"$(which node)\"
command_args=\"$AGENT_JS\"
command_background=true
pidfile=\"/run/dropwave-agent.pid\"
output_log=\"/var/log/dropwave-agent.log\"
error_log=\"/var/log/dropwave-agent.log\""

if [ "$(id -u)" = "0" ] && command -v systemctl &>/dev/null; then
  echo "$SYSTEMD_UNIT" > /etc/systemd/system/dropwave-agent.service
  systemctl daemon-reload
  systemctl enable dropwave-agent
  systemctl restart dropwave-agent
  echo "✓ Servizio systemd (root) avviato"
  echo "  Log: journalctl -u dropwave-agent -f"

elif command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  SYSTEMD_USER="${SYSTEMD_UNIT/WantedBy=multi-user.target/WantedBy=default.target}"
  echo "$SYSTEMD_USER" > "$HOME/.config/systemd/user/dropwave-agent.service"
  systemctl --user daemon-reload
  systemctl --user enable dropwave-agent
  systemctl --user restart dropwave-agent
  echo "✓ Servizio systemd (utente) avviato"
  echo "  Log: journalctl --user -u dropwave-agent -f"

elif [ "$(id -u)" = "0" ] && command -v rc-update &>/dev/null; then
  echo "$OPENRC_SCRIPT" > /etc/init.d/dropwave-agent
  chmod +x /etc/init.d/dropwave-agent
  rc-update add dropwave-agent default
  rc-service dropwave-agent start
  echo "✓ Servizio OpenRC avviato"

else
  # Fallback: nohup
  pkill -f "node $AGENT_JS" 2>/dev/null || true
  nohup node "$AGENT_JS" > "$INSTALL_DIR/agent.log" 2>&1 &
  echo "✓ Agent avviato (background, PID: $!)"
  echo "  Log: tail -f $INSTALL_DIR/agent.log"

  # Aggiungi a .bashrc per persistenza
  BASHRC_LINE="# DropWave Agent
[ -f $AGENT_JS ] && pgrep -f 'node $AGENT_JS' > /dev/null || nohup node $AGENT_JS >> $INSTALL_DIR/agent.log 2>&1 &"
  if ! grep -q "dropwave-agent" "$HOME/.bashrc" 2>/dev/null; then
    echo "$BASHRC_LINE" >> "$HOME/.bashrc"
  fi
fi

echo ""
echo "✅ DropWave Agent installato!"
echo "   Il dispositivo apparirà automaticamente nel pannello admin."
echo "   Pannello: $SERVER"
echo ""

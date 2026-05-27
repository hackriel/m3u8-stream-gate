#!/bin/bash
# ════════════════════════════════════════════════════════════
#  🚀 Install FOX SRT Pusher en Raspberry Pi 5
#  Uso:  sudo bash install.sh
# ════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[1;33m'; NC='\033[0m'
ok(){ echo -e "${GREEN}✅ $1${NC}"; }
warn(){ echo -e "${YEL}⚠️  $1${NC}"; }
fail(){ echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecutá como root: sudo bash install.sh"

INSTALL_DIR="/opt/fox-srt-pusher"
SERVICE_NAME="fox-srt-pusher"
ENV_FILE="/etc/${SERVICE_NAME}.env"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo ""
echo "════════════════════════════════════════════"
echo "  🛰️  FOX SRT Pusher (Pi5 → VPS:9006)"
echo "════════════════════════════════════════════"
echo ""

# 1) Dependencias del SO
echo "📦 [1/5] Instalando dependencias del sistema (ffmpeg + srt-tools + node)…"
apt-get update -qq
apt-get install -y -qq ffmpeg srt-tools curl ca-certificates
command -v srt-live-transmit &>/dev/null || fail "No se instaló srt-live-transmit; revisá el paquete srt-tools"
if ! command -v node &>/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  echo "  ↳ Instalando Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}') / srt-live-transmit OK / node $(node -v)"

# 2) Copiar archivos
echo "📂 [2/5] Copiando archivos a ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/index.js" "$INSTALL_DIR/index.js"
chmod +x "$INSTALL_DIR/index.js"
ok "Archivos copiados"

# 3) Variables de entorno
echo "🔐 [3/5] Configurando ${ENV_FILE}…"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENV_EOF'
# === FOX SRT pusher — configuración ===
VPS_HOST=167.17.69.116
VPS_PORT=9006
SRT_STREAMID=fox
SRT_LATENCY_MS=3000
# SRT_PASSPHRASE=
LOCAL_UDP_PORT=10006
STALL_TIMEOUT_MS=25000
STARTUP_DELAY_MS=0

# Credenciales TDMax (cuenta dedicada Raspberry — info@media.cr)
TDMAX_EMAIL=info@media.cr
TDMAX_PASSWORD=Boanerges12*
DEVICE_ID=2f64f7b8-7d75-4cf4-9a8c-b7e2e99a9006

# Supabase (para el botón "Refresh Pi5" del dashboard)
SUPABASE_URL=https://zbrkijgnkckcutydsmkt.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpicmtpamdua2NrY3V0eWRzbWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI4OTE3NzMsImV4cCI6MjA3ODQ2Nzc3M30.igte07DdM7xmA3A-nsWXOTIno89-15i2d0PlEiIC7L8

LOG_VERBOSE=0
ENV_EOF
  chmod 600 "$ENV_FILE"
  ok "Archivo .env creado"
else
  warn "Ya existe $ENV_FILE — lo dejo como está"
  grep -q '^SRT_LATENCY_MS=' "$ENV_FILE" || echo 'SRT_LATENCY_MS=3000' >> "$ENV_FILE"
  grep -q '^LOCAL_UDP_PORT=' "$ENV_FILE" || echo 'LOCAL_UDP_PORT=10006' >> "$ENV_FILE"
  grep -q '^STALL_TIMEOUT_MS=' "$ENV_FILE" || echo 'STALL_TIMEOUT_MS=25000' >> "$ENV_FILE"
  grep -q '^STARTUP_DELAY_MS=' "$ENV_FILE" || echo 'STARTUP_DELAY_MS=0' >> "$ENV_FILE"
  if ! grep -q '^DEVICE_ID=' "$ENV_FILE"; then
    echo 'DEVICE_ID=2f64f7b8-7d75-4cf4-9a8c-b7e2e99a9006' >> "$ENV_FILE"
    ok "DEVICE_ID exclusivo agregado a $ENV_FILE"
  fi
fi

# 4) Servicio systemd
echo "⚙️  [4/5] Creando systemd service…"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<UNIT_EOF
[Unit]
Description=FOX SRT Pusher (Pi5 → VPS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/index.js
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=append:/var/log/${SERVICE_NAME}.log
StandardError=append:/var/log/${SERVICE_NAME}.log
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT_EOF

cat > /etc/logrotate.d/${SERVICE_NAME} <<LOGROT_EOF
/var/log/${SERVICE_NAME}.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
LOGROT_EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}
sleep 2

# 5) Resultado
echo "🩺 [5/5] Verificando…"
if systemctl is-active --quiet ${SERVICE_NAME}; then
  ok "${SERVICE_NAME} ACTIVO"
  echo ""
  echo "Comandos útiles:"
  echo "  Estado:   systemctl status ${SERVICE_NAME}"
  echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
  echo "  Editar:   sudo nano ${ENV_FILE} && sudo systemctl restart ${SERVICE_NAME}"
  echo ""
  echo "✅ El Pi5 está empujando SRT 24/7. El VPS lo recibirá solo cuando"
  echo "   actives el switch del tab 'FOX SRT' desde el dashboard."
else
  fail "El servicio no arrancó. Mirá: journalctl -u ${SERVICE_NAME} -n 80"
fi

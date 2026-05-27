#!/bin/bash
# ════════════════════════════════════════════════════════════
#  🚀 Install Teletica SRT Pusher en Raspberry Pi 5
#  Uso:  sudo bash install.sh
# ════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[1;33m'; NC='\033[0m'
ok(){ echo -e "${GREEN}✅ $1${NC}"; }
warn(){ echo -e "${YEL}⚠️  $1${NC}"; }
fail(){ echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecutá como root: sudo bash install.sh"

INSTALL_DIR="/opt/teletica-srt-pusher"
SERVICE_NAME="teletica-srt-pusher"
ENV_FILE="/etc/${SERVICE_NAME}.env"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo ""
echo "════════════════════════════════════════════"
echo "  🛰️  Teletica SRT Pusher (Pi5 → VPS:9004)"
echo "════════════════════════════════════════════"
echo ""

# 1) Dependencias del SO ──────────────────────────────────────
echo "📦 [1/5] Instalando dependencias del sistema (ffmpeg + node)…"
apt-get update -qq
apt-get install -y -qq ffmpeg curl ca-certificates

# FFmpeg de Debian/Raspbian ya trae SRT; verificar:
if ! ffmpeg -hide_banner -protocols 2>/dev/null | grep -q '^ *srt$'; then
  warn "Este ffmpeg no tiene soporte SRT. Instalando build alternativo…"
  apt-get install -y -qq libsrt-openssl-dev || true
fi

if ! command -v node &>/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  echo "  ↳ Instalando Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}') / node $(node -v)"

# 2) Copiar archivos ──────────────────────────────────────────
echo "📂 [2/5] Copiando archivos a ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/index.js" "$INSTALL_DIR/index.js"
chmod +x "$INSTALL_DIR/index.js"
ok "Archivos copiados"

# 3) Variables de entorno ─────────────────────────────────────
echo "🔐 [3/5] Configurando ${ENV_FILE}…"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# === Teletica SRT pusher — configuración ===
VPS_HOST=167.17.69.116
VPS_PORT=9004
SRT_STREAMID=teletica
SRT_LATENCY_US=2000000
# SRT_PASSPHRASE=

# Credenciales TDMax (cuenta dedicada Raspberry — info@media.cr)
TDMAX_EMAIL=info@media.cr
TDMAX_PASSWORD=Boanerges12*
DEVICE_ID=2f64f7b8-7d75-4cf4-9a8c-b7e2e99a9004

# Supabase (para el botón "Refresh Pi5" del dashboard)
SUPABASE_URL=https://zbrkijgnkckcutydsmkt.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpicmtpamdua2NrY3V0eWRzbWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI4OTE3NzMsImV4cCI6MjA3ODQ2Nzc3M30.igte07DdM7xmA3A-nsWXOTIno89-15i2d0PlEiIC7L8

LOG_VERBOSE=0
EOF
  chmod 600 "$ENV_FILE"
  ok "Archivo .env creado (editalo si necesitás otras credenciales)"
else
  warn "Ya existe $ENV_FILE — lo dejo como está"
  if ! grep -q '^DEVICE_ID=' "$ENV_FILE"; then
    echo 'DEVICE_ID=2f64f7b8-7d75-4cf4-9a8c-b7e2e99a9004' >> "$ENV_FILE"
    ok "DEVICE_ID exclusivo agregado a $ENV_FILE"
  fi
fi

# 4) Servicio systemd ─────────────────────────────────────────
echo "⚙️  [4/5] Creando systemd service…"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Teletica SRT Pusher (Pi5 → VPS)
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
EOF

# Rotación de logs
cat > /etc/logrotate.d/${SERVICE_NAME} <<EOF
/var/log/${SERVICE_NAME}.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}
sleep 2

# 5) Resultado ────────────────────────────────────────────────
echo "🩺 [5/5] Verificando…"
if systemctl is-active --quiet ${SERVICE_NAME}; then
  ok "${SERVICE_NAME} ACTIVO"
  echo ""
  echo "Comandos útiles:"
  echo "  Estado:   systemctl status ${SERVICE_NAME}"
  echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
  echo "  Tail:     tail -f /var/log/${SERVICE_NAME}.log"
  echo "  Editar:   sudo nano ${ENV_FILE} && sudo systemctl restart ${SERVICE_NAME}"
  echo ""
  echo "✅ El Pi5 está empujando SRT 24/7. El VPS lo recibirá solo cuando"
  echo "   actives el switch del tab 'Teletica SRT' desde el dashboard."
else
  fail "El servicio no arrancó. Mirá: journalctl -u ${SERVICE_NAME} -n 80"
fi
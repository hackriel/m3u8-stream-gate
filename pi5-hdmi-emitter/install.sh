#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════
#  📡 Instalador Tigo HDMI Emitter (Pi5 → VPS via SRT)
#  Captura HDMI con Elgato Cam Link 4K y empuja SRT
# ═══════════════════════════════════════════════════════

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecuta como root: sudo bash install.sh"

VPS_HOST="${VPS_HOST:-167.17.69.116}"
VPS_PORT="${VPS_PORT:-9000}"
LATENCY_MS="${LATENCY_MS:-2000}"
INSTALL_DIR="/opt/tigo-hdmi-emitter"
SERVICE_NAME="tigo-hdmi-emitter"

echo ""
echo "═══════════════════════════════════════════"
echo "  📡 Tigo HDMI Emitter (Pi5 → VPS)"
echo "  Destino SRT: srt://${VPS_HOST}:${VPS_PORT}"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Dependencias ──
echo "📦 [1/5] Instalando dependencias (ffmpeg, v4l-utils, alsa-utils)..."
apt update -qq
apt install -y ffmpeg v4l-utils alsa-utils usbutils
ok "Dependencias instaladas"

# ── 2. Detectar Cam Link 4K ──
echo "🔍 [2/5] Detectando Elgato Cam Link 4K..."
if ! lsusb | grep -qi "elgato"; then
  warn "No veo 'Elgato' en lsusb. ¿Está conectada la Cam Link 4K?"
  warn "Continuando — el script igual usará /dev/video0 como fallback."
fi

VIDEO_DEV=$(v4l2-ctl --list-devices 2>/dev/null | awk '/Cam Link|Elgato/{getline; gsub(/^[ \t]+/,""); print; exit}')
[ -z "$VIDEO_DEV" ] && VIDEO_DEV="/dev/video0"
ok "Video device: $VIDEO_DEV"

AUDIO_CARD=$(arecord -l 2>/dev/null | awk '/Cam Link|Elgato/{match($0,/card ([0-9]+)/,a); print a[1]; exit}')
[ -z "$AUDIO_CARD" ] && AUDIO_CARD="1"
AUDIO_DEV="hw:${AUDIO_CARD},0"
ok "Audio device: $AUDIO_DEV"

# ── 3. Copiar scripts ──
echo "📂 [3/5] Instalando scripts en $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cp "$SCRIPT_DIR/tigo-hdmi.sh" "$INSTALL_DIR/tigo-hdmi.sh"
chmod +x "$INSTALL_DIR/tigo-hdmi.sh"
ok "Scripts instalados"

# ── 4. systemd service ──
echo "⚙️  [4/5] Configurando servicio systemd..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Tigo HDMI Capture → SRT to VPS
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=VPS_HOST=${VPS_HOST}
Environment=VPS_PORT=${VPS_PORT}
Environment=LATENCY_MS=${LATENCY_MS}
Environment=VIDEO_DEV=${VIDEO_DEV}
Environment=AUDIO_DEV=${AUDIO_DEV}
ExecStart=${INSTALL_DIR}/tigo-hdmi.sh
Restart=always
RestartSec=2
StandardOutput=append:/var/log/${SERVICE_NAME}.log
StandardError=append:/var/log/${SERVICE_NAME}-error.log
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
ok "Servicio systemd configurado"

# ── 5. Logrotate ──
cat > /etc/logrotate.d/${SERVICE_NAME} << EOF
/var/log/${SERVICE_NAME}*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0640 root root
}
EOF
ok "Logrotate configurado"

# ── Iniciar ──
echo ""
echo "🚀 [5/5] Iniciando servicio..."
systemctl start "$SERVICE_NAME"
sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo ""
  echo "═══════════════════════════════════════════"
  echo -e "${GREEN}  ✅ INSTALACIÓN COMPLETADA${NC}"
  echo "═══════════════════════════════════════════"
  echo ""
  echo "  📡 Empujando SRT → ${VPS_HOST}:${VPS_PORT}"
  echo ""
  echo "  Comandos útiles:"
  echo "    Ver estado:   systemctl status ${SERVICE_NAME}"
  echo "    Ver logs:     journalctl -u ${SERVICE_NAME} -f"
  echo "    Reiniciar:    systemctl restart ${SERVICE_NAME}"
  echo "    Detener:      systemctl stop ${SERVICE_NAME}"
  echo ""
  echo "  ✅ Corre 24/7 (auto-restart cada 2s si cae)"
  echo "  ✅ Reintenta SRT solo si el VPS se cae"
  echo "  ✅ El VPS solo procesa cuando vos pulsas 'Emitir' en el dashboard"
  echo ""
else
  fail "El servicio no arrancó. Revisa: journalctl -u ${SERVICE_NAME} -n 50"
fi

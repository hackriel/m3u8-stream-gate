#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════
#  🚀 Setup VPS - Emisor M3U8 → RTMP
#  Un solo script para instalar todo desde cero
# ═══════════════════════════════════════════════════════

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

# Verificar root
[ "$EUID" -eq 0 ] || fail "Ejecuta como root: sudo bash setup-vps.sh"

INSTALL_DIR="/opt/m3u8-emitter"
SERVICE_NAME="m3u8-emitter"

echo ""
echo "═══════════════════════════════════════════"
echo "  🚀 Instalación Emisor M3U8 → RTMP"
echo "═══════════════════════════════════════════"
echo ""

# ── Paso 1: Actualizar sistema ──
echo "📦 [1/8] Actualizando sistema..."
apt update -qq && apt upgrade -y -qq
ok "Sistema actualizado"

# ── Paso 2: Instalar Node.js 20 ──
echo "📦 [2/8] Instalando Node.js..."
if command -v node &>/dev/null; then
  NODE_V=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_V" -ge 18 ]; then
    ok "Node.js $(node -v) ya instalado"
  else
    warn "Node.js muy viejo, actualizando..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
    ok "Node.js actualizado a $(node -v)"
  fi
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
  ok "Node.js $(node -v) instalado"
fi

# ── Paso 3: Instalar FFmpeg ──
echo "🎥 [3/8] Instalando FFmpeg..."
if command -v ffmpeg &>/dev/null; then
  ok "FFmpeg ya instalado"
else
  apt install -y ffmpeg
  ok "FFmpeg instalado"
fi

# ── Paso 3.5: Instalar proxychains4 (necesario para Tigo URL vía Pi 5) ──
echo "🌐 [3.5/8] Instalando proxychains4 (proxy SOCKS5 para Tigo)..."
if command -v proxychains4 &>/dev/null; then
  ok "proxychains4 ya instalado"
else
  apt install -y proxychains4
  ok "proxychains4 instalado"
fi

# ── Paso 3b: Optimizar TCP keepalive para RTMP ──
echo "🔧 [3b/8] Configurando TCP keepalive para estabilidad RTMP..."
sysctl -w net.ipv4.tcp_keepalive_time=60 > /dev/null 2>&1
sysctl -w net.ipv4.tcp_keepalive_intvl=10 > /dev/null 2>&1
sysctl -w net.ipv4.tcp_keepalive_probes=6 > /dev/null 2>&1
# Persistir en reboot
grep -q 'tcp_keepalive_time' /etc/sysctl.conf 2>/dev/null || {
  echo "net.ipv4.tcp_keepalive_time = 60" >> /etc/sysctl.conf
  echo "net.ipv4.tcp_keepalive_intvl = 10" >> /etc/sysctl.conf
  echo "net.ipv4.tcp_keepalive_probes = 6" >> /etc/sysctl.conf
}
ok "TCP keepalive optimizado (60s/10s/6 probes)"

# ── Paso 4: Instalar dependencias ──
echo "📥 [4/8] Instalando dependencias del proyecto..."
[ -f "package.json" ] || fail "No se encontró package.json. Ejecuta este script desde el directorio del proyecto."
npm install 2>&1 | tail -1
ok "Dependencias instaladas"

# ── Paso 5: Build del frontend ──
echo "🔨 [5/8] Compilando frontend..."
npm run build 2>&1 | tail -3
ok "Frontend compilado"

# Podar dependencias de desarrollo después del build
npm prune --omit=dev 2>&1 | tail -1

# ── Paso 6: Crear servicio systemd ──
echo "⚙️  [6/8] Configurando servicio systemd..."

# Detener si ya existe
systemctl stop $SERVICE_NAME 2>/dev/null || true
systemctl disable $SERVICE_NAME 2>/dev/null || true

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=M3U8 to RTMP Emitter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=SUPABASE_URL=https://zbrkijgnkckcutydsmkt.supabase.co
Environment=SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpicmtpamdua2NrY3V0eWRzbWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI4OTE3NzMsImV4cCI6MjA3ODQ2Nzc3M30.igte07DdM7xmA3A-nsWXOTIno89-15i2d0PlEiIC7L8
Environment=TDMAX_EMAIL=arlopfa@gmail.com
Environment=TDMAX_PASSWORD=vM5SdnKpPjlypvJW
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/${SERVICE_NAME}.log
StandardError=append:/var/log/${SERVICE_NAME}-error.log
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME
ok "Servicio systemd configurado"

# ── Paso 7: Logrotate ──
echo "📋 [7/8] Configurando rotación de logs..."
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
ok "Logrotate configurado (7 días)"

# ── Paso 8: Reinicio diario a las 3 AM ──
echo "⏰ [8/8] Programando reinicio diario a las 3:00 AM..."
(crontab -l 2>/dev/null | grep -v "$SERVICE_NAME"; echo "0 3 * * * systemctl restart $SERVICE_NAME") | crontab -
ok "Cron configurado: reinicio a las 3:00 AM"

# ── Iniciar servicio ──
echo ""
echo "🚀 Iniciando servicio..."
systemctl start $SERVICE_NAME
sleep 3

if systemctl is-active --quiet $SERVICE_NAME; then
  SERVER_IP=$(hostname -I | awk '{print $1}')
  echo ""
  echo "═══════════════════════════════════════════"
  echo -e "${GREEN}  ✅ ¡INSTALACIÓN COMPLETADA!${NC}"
  echo "═══════════════════════════════════════════"
  echo ""
  echo -e "  📡 Panel: ${GREEN}http://${SERVER_IP}:3001${NC}"
  echo ""
  echo "  Comandos útiles:"
  echo "    Ver estado:     systemctl status $SERVICE_NAME"
  echo "    Ver logs:       journalctl -u $SERVICE_NAME -f"
  echo "    Reiniciar:      systemctl restart $SERVICE_NAME"
  echo "    Detener:        systemctl stop $SERVICE_NAME"
  echo ""
  echo "  ✅ Corre en background (puedes cerrar SSH)"
  echo "  ✅ Se inicia automáticamente al reiniciar el VPS"
  echo "  ✅ Se reinicia solo si falla"
  echo "  ✅ Se reinicia cada día a las 3:00 AM"
  echo ""
else
  fail "Error al iniciar. Revisa: journalctl -u $SERVICE_NAME -n 50"
fi

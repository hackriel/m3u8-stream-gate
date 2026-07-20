#!/usr/bin/env bash
# ============================================================================
# pi5-cr-gateway/rebuild.sh — Instalación LIMPIA y consolidada del Pi 5 como
# gateway WireGuard residencial CR. Reemplaza install.sh + setup-pi5.sh viejos.
#
# Idempotente: se puede correr N veces. Deja estado predecible.
#
# Uso (en el Pi, como root):
#   sudo bash pi5-cr-gateway/rebuild.sh
#
# Requisitos:
#   - Raspberry Pi OS Lite Bookworm 64-bit
#   - Cableado ethernet (NO WiFi)
#   - Router con IP pública no-CGNAT + port-forward UDP 51820
# ============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "❌ Ejecutar como root:  sudo bash pi5-cr-gateway/rebuild.sh" >&2
  exit 1
fi

WG_DIR=/etc/wireguard
KEY_DIR=$WG_DIR/keys
WG_CONF=$WG_DIR/wg0.conf
WG_PORT=51820
WG_SUBNET=10.77.0.0/24
PI_WG_IP=10.77.0.1/24
PROXY_USER="${PROXY_USER:-pi}"
PROXY_DIR="${PROXY_DIR:-/home/${PROXY_USER}/proxy}"
PROXY_ENTRY="${PROXY_ENTRY:-server.js}"

echo "════════════════════════════════════════════════════════════"
echo "  pi5-cr-gateway — REBUILD limpio"
echo "════════════════════════════════════════════════════════════"

# ---------------------------------------------------------------------------
# 0) LIMPIEZA de estado previo (no borra keys — se reusan si existen)
# ---------------------------------------------------------------------------
echo "[0/13] Limpiando estado previo (si existe)..."
systemctl stop wg-quick@wg0 2>/dev/null || true
systemctl stop pi-proxy.service 2>/dev/null || true
iptables -t nat -F POSTROUTING 2>/dev/null || true
iptables -F FORWARD 2>/dev/null || true

# ---------------------------------------------------------------------------
# 1) Paquetes base
# ---------------------------------------------------------------------------
echo "[1/13] apt update + paquetes base..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  wireguard-tools iptables iptables-persistent \
  watchdog unattended-upgrades chrony \
  qrencode curl ca-certificates git

# ---------------------------------------------------------------------------
# 2) Kernel: ip_forward on, ipv6 forwarding off
# ---------------------------------------------------------------------------
echo "[2/13] Habilitando ip_forward..."
install -d /etc/sysctl.d
cat > /etc/sysctl.d/99-cr-gw.conf <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=0
net.core.rmem_max=2500000
net.core.wmem_max=2500000
EOF
sysctl --system >/dev/null

# ---------------------------------------------------------------------------
# 3) Chrony (reloj sincronizado — crítico para handshake WG)
# ---------------------------------------------------------------------------
echo "[3/13] Habilitando chrony (reloj)..."
systemctl enable --now chrony >/dev/null 2>&1 || true
timedatectl set-timezone America/Costa_Rica || true

# ---------------------------------------------------------------------------
# 4) Detectar WAN
# ---------------------------------------------------------------------------
echo "[4/13] Detectando interfaz WAN..."
WAN_IF=$(ip -4 route show default | awk '/default/{print $5; exit}')
if [[ -z "${WAN_IF}" ]]; then
  echo "❌ No se detectó WAN. ¿El Pi tiene internet cableado?" >&2
  exit 1
fi
echo "    WAN_IF = $WAN_IF"
if [[ "$WAN_IF" == wlan* ]]; then
  echo "⚠️  WAN es WiFi ($WAN_IF). Se recomienda MUY fuertemente cable ethernet."
  echo "   WiFi es la causa #1 de handshakes intermitentes."
fi

# ---------------------------------------------------------------------------
# 5) Claves WireGuard (persistentes)
# ---------------------------------------------------------------------------
echo "[5/13] Generando/reutilizando claves WG..."
install -d -m 700 "$KEY_DIR"
if [[ ! -f "$KEY_DIR/pi.key" ]]; then
  umask 077
  wg genkey | tee "$KEY_DIR/pi.key" | wg pubkey > "$KEY_DIR/pi.pub"
  chmod 600 "$KEY_DIR/pi.key" "$KEY_DIR/pi.pub"
fi
PI_PRIV=$(cat "$KEY_DIR/pi.key")
PI_PUB=$(cat "$KEY_DIR/pi.pub")

# ---------------------------------------------------------------------------
# 6) wg0.conf (preserva peers existentes si los hay)
# ---------------------------------------------------------------------------
echo "[6/13] Escribiendo $WG_CONF ..."
EXISTING_PEERS=""
if [[ -f "$WG_CONF" ]]; then
  # extrae bloques [Peer] existentes para no perderlos
  EXISTING_PEERS=$(awk '/^\[Peer\]/{flag=1} flag' "$WG_CONF" || true)
fi
cat > "$WG_CONF" <<EOF
# Generado por pi5-cr-gateway/rebuild.sh
[Interface]
Address    = $PI_WG_IP
ListenPort = $WG_PORT
PrivateKey = $PI_PRIV
MTU        = 1380

PostUp   = iptables -t nat -C POSTROUTING -s $WG_SUBNET -o $WAN_IF -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s $WG_SUBNET -o $WAN_IF -j MASQUERADE
PostUp   = iptables -C FORWARD -i %i -o $WAN_IF -j ACCEPT 2>/dev/null || iptables -A FORWARD -i %i -o $WAN_IF -j ACCEPT
PostUp   = iptables -C FORWARD -i $WAN_IF -o %i -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -i $WAN_IF -o %i -m state --state RELATED,ESTABLISHED -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s $WG_SUBNET -o $WAN_IF -j MASQUERADE 2>/dev/null || true
PostDown = iptables -D FORWARD -i %i -o $WAN_IF -j ACCEPT 2>/dev/null || true
PostDown = iptables -D FORWARD -i $WAN_IF -o %i -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true

EOF
if [[ -n "$EXISTING_PEERS" ]]; then
  echo "# Peers preservados del wg0.conf anterior:" >> "$WG_CONF"
  echo "$EXISTING_PEERS" >> "$WG_CONF"
else
  echo "# Los [Peer] del VPS se agregan con add-vps-peer.sh <vps_pubkey>" >> "$WG_CONF"
fi
chmod 600 "$WG_CONF"

# ---------------------------------------------------------------------------
# 7) wg-quick@wg0 al boot
# ---------------------------------------------------------------------------
echo "[7/13] Habilitando wg-quick@wg0..."
systemctl daemon-reload
systemctl enable wg-quick@wg0 >/dev/null
systemctl restart wg-quick@wg0
sleep 1

# ---------------------------------------------------------------------------
# 8) pi-proxy.service (Node HTTP proxy) con Restart + WatchdogSec
# ---------------------------------------------------------------------------
echo "[8/13] Configurando pi-proxy.service..."
NODE_BIN="$(command -v node || echo /usr/bin/node)"
cat > /etc/systemd/system/pi-proxy.service <<EOF
[Unit]
Description=HTTP Proxy Pi5 para scraping desde VPS (CR)
After=network-online.target wg-quick@wg0.service chrony.service
Wants=network-online.target

[Service]
Type=simple
User=${PROXY_USER}
WorkingDirectory=${PROXY_DIR}
ExecStart=${NODE_BIN} ${PROXY_DIR}/${PROXY_ENTRY}
Restart=always
RestartSec=5
StartLimitIntervalSec=0
# systemd mata + reinicia si el proxy no hace sd_notify en 30s (si el proxy
# no soporta notify, WatchdogSec se ignora silenciosamente — no rompe nada)
WatchdogSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pi-proxy.service >/dev/null
if [[ -d "$PROXY_DIR" && -f "$PROXY_DIR/$PROXY_ENTRY" ]]; then
  systemctl restart pi-proxy.service || true
  echo "    OK: pi-proxy.service activo"
else
  echo "    AVISO: $PROXY_DIR/$PROXY_ENTRY no existe todavía (subilo y systemctl restart pi-proxy)."
fi

# ---------------------------------------------------------------------------
# 9) Watchdog hardware BCM2712
# ---------------------------------------------------------------------------
echo "[9/13] Configurando watchdog hardware..."
CFG_FILE=""
if [ -f /boot/firmware/config.txt ]; then CFG_FILE=/boot/firmware/config.txt
elif [ -f /boot/config.txt ]; then CFG_FILE=/boot/config.txt
fi
if [ -n "$CFG_FILE" ] && ! grep -q "^dtparam=watchdog=on" "$CFG_FILE"; then
  echo "dtparam=watchdog=on" >> "$CFG_FILE"
  echo "    OK: dtparam=watchdog=on agregado (aplica al próximo reboot)"
fi
cat >/etc/watchdog.conf <<'EOF'
watchdog-device = /dev/watchdog
watchdog-timeout = 15
interval = 5
max-load-1 = 24
max-load-5 = 18
min-memory = 1
realtime = yes
priority = 1
EOF
systemctl enable watchdog >/dev/null
systemctl restart watchdog || true

# ---------------------------------------------------------------------------
# 10) EEPROM: encendido tras corte de luz
# ---------------------------------------------------------------------------
echo "[10/13] EEPROM (POWER_OFF_ON_HALT=0, WAKE_ON_GPIO=1)..."
if command -v rpi-eeprom-config >/dev/null 2>&1; then
  TMP=$(mktemp)
  rpi-eeprom-config > "$TMP"
  if grep -q "^POWER_OFF_ON_HALT=" "$TMP"; then
    sed -i 's/^POWER_OFF_ON_HALT=.*/POWER_OFF_ON_HALT=0/' "$TMP"
  else
    echo "POWER_OFF_ON_HALT=0" >> "$TMP"
  fi
  grep -q "^WAKE_ON_GPIO=" "$TMP" || echo "WAKE_ON_GPIO=1" >> "$TMP"
  rpi-eeprom-config --apply "$TMP" >/dev/null 2>&1 || echo "    AVISO: revisar EEPROM manualmente"
  rm -f "$TMP"
fi

# ---------------------------------------------------------------------------
# 11) unattended-upgrades solo security
# ---------------------------------------------------------------------------
echo "[11/13] unattended-upgrades (solo security)..."
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 12) Reboot semanal (domingo 4 AM CR) — limpia estado
# ---------------------------------------------------------------------------
echo "[12/13] Reboot semanal programado (dom 4 AM CR)..."
cat >/etc/cron.d/pi5-weekly-reboot <<'EOF'
# Reinicio semanal del Pi5 gateway para higiene de estado
0 4 * * 0 root /sbin/shutdown -r now "pi5 weekly reboot"
EOF
chmod 644 /etc/cron.d/pi5-weekly-reboot

# ---------------------------------------------------------------------------
# 13) Detectar IP pública y CGNAT
# ---------------------------------------------------------------------------
echo "[13/13] Detectando IP pública..."
PUB_IP=$(curl -fsS --max-time 6 https://api.ipify.org || curl -fsS --max-time 6 https://ifconfig.me || echo "")
CGNAT_WARN=""
if [[ -n "$PUB_IP" ]]; then
  IFS=. read -r o1 o2 _ _ <<< "$PUB_IP"
  if [[ "$o1" == "100" && "$o2" -ge 64 && "$o2" -le 127 ]]; then
    CGNAT_WARN="❌ IP pública en rango CGNAT ($PUB_IP). NO recibirás UDP/$WG_PORT entrante. Pedí IP pública real al ISP."
  fi
fi

cat <<EOF

════════════════════════════════════════════════════════════
  ✅ pi5-cr-gateway REBUILD listo
════════════════════════════════════════════════════════════

  WAN..................... $WAN_IF
  WG interfaz............. wg0 ($PI_WG_IP, UDP $WG_PORT)
  IP pública del Pi....... ${PUB_IP:-DESCONOCIDA}
  Pubkey del Pi:
    $PI_PUB

SIGUIENTE PASO (en el VPS):
  sudo PI_PUBKEY="$PI_PUB" \\
       PI_ENDPOINT="${PUB_IP:-IP_DEL_PI}:$WG_PORT" \\
       bash setup-vps-cr-wireguard.sh

Luego, volvé al Pi:
  sudo bash pi5-cr-gateway/add-vps-peer.sh <vps_pubkey>
  sudo bash pi5-cr-gateway/status.sh

Router:
  Port-forward UDP/$WG_PORT → IP local del Pi + DHCP reservation.

${CGNAT_WARN}
EOF
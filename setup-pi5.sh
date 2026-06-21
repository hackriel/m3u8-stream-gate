#!/usr/bin/env bash
# ============================================================================
# setup-pi5.sh — Auto-recuperación del Raspberry Pi 5 (proxy HTTP para VPS)
# ----------------------------------------------------------------------------
# Configura:
#   1. Servicio systemd del proxy HTTP (Restart=always, arranca al boot)
#   2. WireGuard wg0 habilitado al boot
#   3. Watchdog hardware del BCM2712 (reinicia el Pi si el kernel se cuelga)
#   4. EEPROM: vuelve a encender tras corte de luz
#
# Uso:  sudo bash setup-pi5.sh
# ============================================================================
set -eo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Ejecutar con sudo: sudo bash setup-pi5.sh"
  exit 1
fi

PROXY_USER="${PROXY_USER:-pi}"
PROXY_DIR="${PROXY_DIR:-/home/${PROXY_USER}/proxy}"
PROXY_ENTRY="${PROXY_ENTRY:-server.js}"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
WG_IFACE="${WG_IFACE:-wg0}"

echo "==> Usuario proxy: $PROXY_USER"
echo "==> Directorio:   $PROXY_DIR"
echo "==> Entry:        $PROXY_ENTRY"
echo "==> Node:         $NODE_BIN"
echo "==> WG iface:     $WG_IFACE"
echo

# ---------------------------------------------------------------------------
# 1) Servicio systemd del proxy
# ---------------------------------------------------------------------------
echo "==> [1/4] Creando pi-proxy.service"
cat >/etc/systemd/system/pi-proxy.service <<EOF
[Unit]
Description=HTTP Proxy Pi5 para scraping desde VPS
After=network-online.target wg-quick@${WG_IFACE}.service
Wants=network-online.target

[Service]
Type=simple
User=${PROXY_USER}
WorkingDirectory=${PROXY_DIR}
ExecStart=${NODE_BIN} ${PROXY_DIR}/${PROXY_ENTRY}
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pi-proxy.service
if [[ -d "$PROXY_DIR" && -f "$PROXY_DIR/$PROXY_ENTRY" ]]; then
  systemctl restart pi-proxy.service || true
  echo "   OK: pi-proxy.service activo"
else
  echo "   AVISO: $PROXY_DIR/$PROXY_ENTRY no existe todavia."
fi

# ---------------------------------------------------------------------------
# 2) WireGuard al boot
# ---------------------------------------------------------------------------
echo "==> [2/4] Habilitando wg-quick@${WG_IFACE} al boot"
if [[ -f "/etc/wireguard/${WG_IFACE}.conf" ]]; then
  systemctl enable "wg-quick@${WG_IFACE}.service"
  systemctl restart "wg-quick@${WG_IFACE}.service" || true
  echo "   OK: wg-quick@${WG_IFACE} habilitado"
else
  echo "   AVISO: /etc/wireguard/${WG_IFACE}.conf no existe."
fi

# ---------------------------------------------------------------------------
# 3) Watchdog hardware (BCM2712)
# ---------------------------------------------------------------------------
echo "==> [3/4] Configurando watchdog hardware"
apt-get update -qq
apt-get install -y watchdog

CFG_FILE=""
if [ -f /boot/firmware/config.txt ]; then
  CFG_FILE=/boot/firmware/config.txt
elif [ -f /boot/config.txt ]; then
  CFG_FILE=/boot/config.txt
fi
if [ -n "$CFG_FILE" ]; then
  if ! grep -q "^dtparam=watchdog=on" "$CFG_FILE"; then
    echo "dtparam=watchdog=on" >>"$CFG_FILE"
    echo "   OK: dtparam=watchdog=on agregado a $CFG_FILE"
  fi
else
  echo "   AVISO: no se encontro config.txt"
fi

cat >/etc/watchdog.conf <<'EOF'
# Watchdog BCM2712 Pi5 — reinicia el Pi si el kernel se cuelga
watchdog-device = /dev/watchdog
watchdog-timeout = 15
interval = 5
max-load-1 = 24
max-load-5 = 18
min-memory = 1
realtime = yes
priority = 1
EOF

systemctl enable watchdog
systemctl restart watchdog || true
echo "   OK: watchdog activo"

# ---------------------------------------------------------------------------
# 4) EEPROM: encendido tras corte de luz
# ---------------------------------------------------------------------------
echo "==> [4/4] EEPROM (POWER_OFF_ON_HALT=0, WAKE_ON_GPIO=1)"
if command -v rpi-eeprom-config >/dev/null 2>&1; then
  TMP_EEPROM=$(mktemp)
  rpi-eeprom-config >"$TMP_EEPROM"
  if grep -q "^POWER_OFF_ON_HALT=" "$TMP_EEPROM"; then
    sed -i 's/^POWER_OFF_ON_HALT=.*/POWER_OFF_ON_HALT=0/' "$TMP_EEPROM"
  else
    echo "POWER_OFF_ON_HALT=0" >>"$TMP_EEPROM"
  fi
  grep -q "^WAKE_ON_GPIO=" "$TMP_EEPROM" || echo "WAKE_ON_GPIO=1" >>"$TMP_EEPROM"
  rpi-eeprom-config --apply "$TMP_EEPROM" || echo "   AVISO: revisa EEPROM manualmente"
  rm -f "$TMP_EEPROM"
  echo "   OK: EEPROM actualizada (aplica al proximo reboot)"
else
  echo "   AVISO: rpi-eeprom-config no disponible."
fi

echo
echo "============================================================"
echo " Pi5 configurado para auto-recuperacion"
echo "------------------------------------------------------------"
echo " Proxy:    systemctl status pi-proxy"
echo " VPN:      systemctl status wg-quick@${WG_IFACE}"
echo " Watchdog: systemctl status watchdog"
echo " Logs:     journalctl -u pi-proxy -f"
echo "============================================================"
echo " Reinicia una vez:  sudo reboot"

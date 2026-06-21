#!/usr/bin/env bash
# setup-vps-cr-wireguard.sh
# Configura el VPS como cliente WireGuard del Pi 5 SIN cambiar la ruta default
# del sistema. Solo los procesos lanzados como usuario "croute" (los FFmpegs de
# CANAL 6 URL · 15, FOX+ URL · 24, FOX URL · 25) y los sockets con source-IP
# 10.77.0.2 (scraping TDMax de esos 3 canales) salen por el túnel.
#
# Uso (en el VPS, como root):
#   sudo PI_PUBKEY="..." PI_ENDPOINT="ip-publica-pi:51820" \
#        bash setup-vps-cr-wireguard.sh
#
# Idempotente. Verifica al final que la IP del usuario croute sea distinta a
# la IP por defecto del VPS.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "❌ Requiere root." >&2
  exit 1
fi

PI_PUBKEY="${PI_PUBKEY:-}"
PI_ENDPOINT="${PI_ENDPOINT:-}"
if [[ -z "$PI_PUBKEY" || -z "$PI_ENDPOINT" ]]; then
  echo "Uso: sudo PI_PUBKEY=... PI_ENDPOINT=ip:51820 bash $0" >&2
  exit 1
fi

WG_DIR=/etc/wireguard
KEY_DIR=$WG_DIR/keys
WG_CONF=$WG_DIR/wg0.conf
WG_IP=10.77.0.2/24
WG_PEER_IP=10.77.0.1/32
FWMARK=0x77
RT_TABLE_ID=100
RT_TABLE_NAME=cr_routed
CROUTE_USER=croute

echo "════════════════════════════════════════════════════════════"
echo "  setup-vps-cr-wireguard"
echo "════════════════════════════════════════════════════════════"

echo "[1/9] Instalando wireguard-tools + iptables-persistent..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard-tools iptables iptables-persistent curl

echo "[2/9] Creando usuario sistema '$CROUTE_USER' (si no existe)..."
if ! id -u "$CROUTE_USER" >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -M -d /nonexistent "$CROUTE_USER"
fi

echo "[3/9] Generando keys del VPS (si no existen)..."
install -d -m 700 "$KEY_DIR"
if [[ ! -f "$KEY_DIR/vps.key" ]]; then
  umask 077
  wg genkey | tee "$KEY_DIR/vps.key" | wg pubkey > "$KEY_DIR/vps.pub"
  chmod 600 "$KEY_DIR/vps.key" "$KEY_DIR/vps.pub"
fi
VPS_PRIV=$(cat "$KEY_DIR/vps.key")
VPS_PUB=$(cat "$KEY_DIR/vps.pub")

echo "[4/9] Registrando tabla de ruteo '$RT_TABLE_NAME' (id $RT_TABLE_ID)..."
if ! grep -qE "^\s*$RT_TABLE_ID\s+$RT_TABLE_NAME\s*$" /etc/iproute2/rt_tables; then
  echo "$RT_TABLE_ID    $RT_TABLE_NAME" >> /etc/iproute2/rt_tables
fi

echo "[5/9] Escribiendo $WG_CONF (Table = off — NO toca ruta default)..."
# Crítico: Table = off → wg-quick NO instala ninguna ruta. Nosotros decidimos
# qué cae por wg0 vía policy routing.
cat > "$WG_CONF" <<EOF
# Generado por setup-vps-cr-wireguard.sh
[Interface]
Address    = $WG_IP
PrivateKey = $VPS_PRIV
MTU        = 1380
Table      = off

[Peer]
# Raspberry Pi 5 en casa CR
PublicKey           = $PI_PUBKEY
Endpoint            = $PI_ENDPOINT
# 0.0.0.0/0 = todo el tráfico que el kernel mande por wg0 sale por el Pi (gateway CR).
# El policy-routing limita qué procesos llegan a wg0 (solo uid:croute).
AllowedIPs          = 0.0.0.0/0
PersistentKeepalive = 25
EOF
chmod 600 "$WG_CONF"

echo "[6/9] Creando servicio cr-policy-routing.service..."
cat > /usr/local/sbin/cr-policy-routing.sh <<EOF
#!/usr/bin/env bash
# Aplica el policy-routing CR. Idempotente: cada regla se chequea antes.
set -e

FWMARK=$FWMARK
TABLE=$RT_TABLE_ID
WG_SRC_IP=10.77.0.2
CROUTE_USER=$CROUTE_USER

# 1) Marca de paquete para procesos del usuario croute
iptables -t mangle -C OUTPUT -m owner --uid-owner "\$CROUTE_USER" -j MARK --set-mark "\$FWMARK" 2>/dev/null \\
  || iptables -t mangle -A OUTPUT -m owner --uid-owner "\$CROUTE_USER" -j MARK --set-mark "\$FWMARK"

# 2) Regla por marca → tabla cr_routed
ip rule del fwmark "\$FWMARK" table "\$TABLE" 2>/dev/null || true
ip rule add fwmark "\$FWMARK" table "\$TABLE" priority 100

# 3) Regla por source-IP (sockets que bindean a 10.77.0.2 → scraping)
ip rule del from "\$WG_SRC_IP" table "\$TABLE" 2>/dev/null || true
ip rule add from "\$WG_SRC_IP" table "\$TABLE" priority 101

# 4) Ruta default en la tabla cr_routed → wg0
ip route replace default dev wg0 table "\$TABLE"
EOF
chmod 755 /usr/local/sbin/cr-policy-routing.sh

cat > /etc/systemd/system/cr-policy-routing.service <<'EOF'
[Unit]
Description=CR selective policy routing (uid:croute + src:10.77.0.2 -> wg0)
After=network-online.target wg-quick@wg0.service
Requires=wg-quick@wg0.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cr-policy-routing.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

echo "[7/9] Habilitando servicios..."
systemctl daemon-reload
systemctl enable wg-quick@wg0 cr-policy-routing >/dev/null
systemctl restart wg-quick@wg0
sleep 2
systemctl restart cr-policy-routing

echo "[8/9] Probando handshake con el Pi..."
sleep 3
wg show

echo
echo "[9/9] Verificando IPs (USA vs CR)..."
VPS_IP=$(curl -fsS --max-time 6 https://api.ipify.org || echo "")
CR_IP=$(sudo -u "$CROUTE_USER" curl -fsS --max-time 8 https://api.ipify.org || echo "")

echo
echo "════════════════════════════════════════════════════════════"
echo "  Resultado:"
echo "════════════════════════════════════════════════════════════"
echo "  IP del VPS (default).......... ${VPS_IP:-DESCONOCIDA}"
echo "  IP vista por usuario croute... ${CR_IP:-DESCONOCIDA}"

if [[ -z "$CR_IP" ]]; then
  echo
  echo "❌ El usuario croute no pudo salir a internet. Revisar:"
  echo "   - wg show (handshake con el Pi)"
  echo "   - router del Pi (port-forward UDP/51820)"
  echo "   - /etc/wireguard/wg0.conf en el Pi"
  exit 2
fi
if [[ "$CR_IP" == "$VPS_IP" ]]; then
  echo
  echo "❌ croute está saliendo por la MISMA IP que el VPS — el ruteo CR NO funciona."
  echo "   Probable causa: handshake WG caído, o iptables/ip-rule no se aplicaron."
  exit 3
fi

cat <<EOF

✅ Túnel CR operativo. croute sale por IP $CR_IP (Costa Rica).

>>> PUBKEY DEL VPS (pegar en el Pi con add-vps-peer.sh) <<<
$VPS_PUB

Próximos pasos:
  - Reiniciar el servicio: sudo systemctl restart m3u8-emitter
  - Levantar Canal 6 URL / FOX+ URL / FOX URL desde el dashboard.
  - Validar badge "🇨🇷 IP CR" en la card del canal.
EOF
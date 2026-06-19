#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  🌐 WireGuard Client + Policy Routing CR — VPS DigitalOcean
#  Levanta wg0 hacia el Pi 5 en casa y rutea SELECTIVAMENTE
#  el tráfico hacia *.teletica.com / cf.streann.tech por el túnel.
#  El resto del tráfico del VPS sigue saliendo por su IP normal.
# ═══════════════════════════════════════════════════════════════

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecutá como root: sudo bash setup-vps-wireguard-client.sh"

SRC_CONF="${1:-/root/vps-wireguard-client.conf}"
[ -f "$SRC_CONF" ] || fail "No encontré $SRC_CONF. Copialo desde el Pi 5 con scp primero."

WG_IFACE="wg0"
WG_DIR="/etc/wireguard"
WG_SERVER_IP="10.77.0.1"   # Pi 5 dentro del túnel
FWMARK="0x77"
RT_TABLE="200"
DOMAINS_FILE="$WG_DIR/cr-routed-domains.txt"
REFRESH_BIN="/usr/local/bin/cr-routed-refresh.sh"
IPSET_NAME="cr_routed"

echo ""
echo "═══════════════════════════════════════════════"
echo "  🌐 VPS WireGuard Client + Policy Routing CR"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. Paquetes ──
echo "📦 Instalando WireGuard, ipset, iptables..."
apt update -qq
apt install -y wireguard wireguard-tools ipset iptables iproute2 curl dnsutils >/dev/null
ok "Paquetes instalados"

# ── 2. Copiar config a /etc/wireguard/wg0.conf ──
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"
cp "$SRC_CONF" "$WG_DIR/${WG_IFACE}.conf"
chmod 600 "$WG_DIR/${WG_IFACE}.conf"
ok "Config copiada a $WG_DIR/${WG_IFACE}.conf"

# ── 3. Tabla de ruteo persistente ──
if ! grep -qE "^\s*${RT_TABLE}\s+cr_routed" /etc/iproute2/rt_tables; then
  echo "${RT_TABLE} cr_routed" >> /etc/iproute2/rt_tables
  ok "Tabla rt_tables 'cr_routed' (id ${RT_TABLE}) registrada"
else
  warn "Tabla cr_routed ya existía"
fi

# ── 4. Dominios a rutear por CR ──
if [ ! -f "$DOMAINS_FILE" ]; then
  cat > "$DOMAINS_FILE" << 'EOF'
# Un dominio por línea. Líneas con # se ignoran.
# Se resuelven cada 5 min y se cargan en ipset cr_routed.
cdn01.teletica.com
cdn02.teletica.com
cdn03.teletica.com
cdn04.teletica.com
cdn05.teletica.com
cdn06.teletica.com
cdn07.teletica.com
cdn08.teletica.com
cdn09.teletica.com
cdn10.teletica.com
cdn11.teletica.com
cdn12.teletica.com
www.teletica.com
teletica.com
cf.streann.tech
EOF
  ok "Lista de dominios creada en $DOMAINS_FILE"
else
  warn "$DOMAINS_FILE ya existía — no lo toco"
fi

# ── 5. Script de refresh de ipset ──
cat > "$REFRESH_BIN" << EOF
#!/bin/bash
# Resuelve los dominios CR y los carga en el ipset ${IPSET_NAME}.
# Idempotente. Se puede correr a mano o por cron.
set -e
IPSET_NAME="${IPSET_NAME}"
DOMAINS_FILE="${DOMAINS_FILE}"
TMP_SET="\${IPSET_NAME}_tmp"

ipset create -exist "\$IPSET_NAME" hash:ip family inet timeout 0
ipset create -exist "\$TMP_SET"    hash:ip family inet timeout 0
ipset flush "\$TMP_SET"

while IFS= read -r dom; do
  dom=\$(echo "\$dom" | sed 's/#.*//' | xargs)
  [ -z "\$dom" ] && continue
  for ip in \$(getent ahostsv4 "\$dom" 2>/dev/null | awk '{print \$1}' | sort -u); do
    ipset add -exist "\$TMP_SET" "\$ip"
  done
done < "\$DOMAINS_FILE"

ipset swap "\$TMP_SET" "\$IPSET_NAME"
ipset destroy "\$TMP_SET"
EOF
chmod +x "$REFRESH_BIN"
ok "Script $REFRESH_BIN instalado"

# ── 6. Servicio systemd que arma reglas al boot ──
cat > /etc/systemd/system/cr-policy-routing.service << EOF
[Unit]
Description=CR Policy Routing (Teletica/Streann por túnel wg0)
After=network-online.target wg-quick@${WG_IFACE}.service
Wants=network-online.target wg-quick@${WG_IFACE}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '\
  ipset create -exist ${IPSET_NAME} hash:ip family inet timeout 0; \
  ${REFRESH_BIN}; \
  ip route replace default via ${WG_SERVER_IP} dev ${WG_IFACE} table ${RT_TABLE}; \
  ip rule del fwmark ${FWMARK} table ${RT_TABLE} 2>/dev/null || true; \
  ip rule add fwmark ${FWMARK} table ${RT_TABLE}; \
  iptables -t mangle -C OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null || \
    iptables -t mangle -A OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK}; \
  iptables -t nat -C POSTROUTING -o ${WG_IFACE} -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -o ${WG_IFACE} -j MASQUERADE'
ExecStop=/bin/bash -c '\
  ip rule del fwmark ${FWMARK} table ${RT_TABLE} 2>/dev/null || true; \
  ip route flush table ${RT_TABLE} 2>/dev/null || true; \
  iptables -t mangle -D OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null || true; \
  iptables -t nat -D POSTROUTING -o ${WG_IFACE} -j MASQUERADE 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
ok "Servicio cr-policy-routing.service creado"

# ── 7. Cron de refresh cada 5 min ──
CRON_LINE="*/5 * * * * root ${REFRESH_BIN} >/dev/null 2>&1"
CRON_FILE="/etc/cron.d/cr-routed-refresh"
echo "$CRON_LINE" > "$CRON_FILE"
chmod 644 "$CRON_FILE"
ok "Cron de refresh instalado en $CRON_FILE"

# ── 8. Levantar túnel y servicio ──
echo "🚀 Habilitando wg-quick@${WG_IFACE}..."
systemctl enable wg-quick@${WG_IFACE} >/dev/null 2>&1
systemctl restart wg-quick@${WG_IFACE}
sleep 2

if ! wg show ${WG_IFACE} >/dev/null 2>&1; then
  fail "wg0 no levantó. Revisá: journalctl -u wg-quick@${WG_IFACE} -n 30"
fi
ok "Túnel wg0 arriba"

systemctl daemon-reload
systemctl enable cr-policy-routing.service >/dev/null 2>&1
systemctl restart cr-policy-routing.service
ok "Policy routing aplicado"

# ── 9. Esperar handshake ──
echo "⏳ Esperando handshake con el Pi..."
for i in $(seq 1 15); do
  HS=$(wg show ${WG_IFACE} latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)
  if [ -n "$HS" ] && [ "$HS" != "0" ]; then
    ok "Handshake OK (hace $(( $(date +%s) - HS ))s)"
    break
  fi
  sleep 1
done

# ── 10. Verificación de IPs ──
echo ""
echo "🔍 Verificando salida de IPs..."
VPS_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "?")
CR_IP=$(curl -s --max-time 10 --interface ${WG_IFACE} https://api.ipify.org || echo "?")

echo "   IP normal del VPS:   $VPS_IP"
echo "   IP vía túnel (Pi):   $CR_IP"

if [ "$VPS_IP" != "$CR_IP" ] && [ "$CR_IP" != "?" ]; then
  ok "Túnel funcionando — el VPS puede salir con IP CR"
else
  warn "Las IPs coinciden o no se pudo verificar. Revisá handshake y port forward."
fi

echo ""
echo "═══════════════════════════════════════════════"
echo -e "${GREEN}  ✅ VPS configurado${NC}"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Comandos útiles:"
echo "    wg show"
echo "    ipset list ${IPSET_NAME} | head"
echo "    ip route show table ${RT_TABLE}"
echo "    ip rule | grep ${FWMARK}"
echo "    curl --interface ${WG_IFACE} https://api.ipify.org"
echo ""
echo "  Reiniciá el emisor:"
echo "    sudo systemctl restart m3u8-emitter"
echo ""
exit 0
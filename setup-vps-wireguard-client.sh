#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  🌐 VPS WireGuard Client + Policy Routing CR
#  Rutea SOLO tráfico TDMax/Teletica por túnel al Pi 5 en CR.
#  El resto del tráfico del VPS sigue por su IP normal (no afecta
#  RTMP, dashboard, ni ninguna otra emisión).
# ═══════════════════════════════════════════════════════════════

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecuta como root: sudo bash setup-vps-wireguard-client.sh"

# ── Config ──
WG_IFACE="wg0"
WG_CLIENT_IP="10.77.0.2"
WG_SERVER_IP="10.77.0.1"
ROUTE_TABLE="200"           # tabla de routing dedicada
FWMARK="0x77"               # marca para los paquetes a rutear por CR
IPSET_NAME="cr_routed"
DOMAINS_FILE="/etc/wireguard/cr-routed-domains.txt"
REFRESH_SCRIPT="/usr/local/bin/cr-routed-refresh.sh"
CLIENT_CONFIG_SRC="${1:-/root/vps-wireguard-client.conf}"

echo ""
echo "═══════════════════════════════════════════════"
echo "  🌐 VPS → Pi 5 CR (policy routing)"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. Verificar config recibida del Pi ──
[ -f "$CLIENT_CONFIG_SRC" ] || fail "No encontré $CLIENT_CONFIG_SRC. Copialo primero desde el Pi:\n    scp pi@<IP-PI>:/root/vps-wireguard-client.conf /root/"
grep -q "Endpoint" "$CLIENT_CONFIG_SRC" || fail "El archivo no parece config WireGuard válida"
ok "Config WireGuard del Pi encontrada"

# ── 2. Instalar paquetes ──
echo "📦 Instalando WireGuard + ipset..."
apt update -qq
apt install -y wireguard wireguard-tools iptables ipset dnsutils >/dev/null
ok "Paquetes instalados"

# ── 3. Instalar config WireGuard ──
mkdir -p /etc/wireguard
cp "$CLIENT_CONFIG_SRC" /etc/wireguard/${WG_IFACE}.conf
chmod 600 /etc/wireguard/${WG_IFACE}.conf
# Forzar Table = off para que NO sobrescriba la default route
if ! grep -q "^Table" /etc/wireguard/${WG_IFACE}.conf; then
  sed -i '/^\[Interface\]/a Table = off' /etc/wireguard/${WG_IFACE}.conf
fi
ok "Config instalada en /etc/wireguard/${WG_IFACE}.conf"

# ── 4. Levantar túnel ──
systemctl enable wg-quick@${WG_IFACE} >/dev/null 2>&1
systemctl restart wg-quick@${WG_IFACE}
sleep 2
wg show ${WG_IFACE} >/dev/null 2>&1 || fail "WireGuard no levantó. journalctl -u wg-quick@${WG_IFACE} -n 30"
ok "Túnel WireGuard activo (${WG_CLIENT_IP} → ${WG_SERVER_IP})"

# ── 5. Dominios a rutear por CR ──
cat > "$DOMAINS_FILE" << 'EOF'
# Dominios cuyo tráfico HTTPS sale por IP costarricense (Pi 5).
# Una línea por dominio. Comentarios con #.
# Para agregar más, editar este archivo y correr:
#   /usr/local/bin/cr-routed-refresh.sh

# ── TDMax / Streann (login + loadbalancer) ──
cf.streann.tech
streann.com
cdnstreann.com

# ── Teletica CDN (chunks HLS) ──
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
cdn13.teletica.com
cdn14.teletica.com
cdn15.teletica.com
www.teletica.com
teletica.com
EOF
ok "Lista de dominios escrita en $DOMAINS_FILE"

# ── 6. Crear ipset persistente ──
ipset create ${IPSET_NAME} hash:ip family inet timeout 0 -exist
ok "ipset '${IPSET_NAME}' creado"

# ── 7. Script de refresh DNS → ipset ──
cat > "$REFRESH_SCRIPT" << REFRESHEOF
#!/bin/bash
# Resuelve los dominios de $DOMAINS_FILE y agrega sus IPs al ipset ${IPSET_NAME}.
# Idempotente. Corre cada 5 min vía cron.
set -e
IPSET="${IPSET_NAME}"
DOMAINS_FILE="${DOMAINS_FILE}"
ipset create \$IPSET hash:ip family inet timeout 0 -exist
while IFS= read -r line; do
  domain=\$(echo "\$line" | sed 's/#.*//' | xargs)
  [ -z "\$domain" ] && continue
  # +short da una IP por línea (A records). Tolerante a fallos.
  for ip in \$(dig +short +time=3 +tries=1 "\$domain" A 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\$'); do
    ipset add \$IPSET "\$ip" -exist 2>/dev/null || true
  done
done < "\$DOMAINS_FILE"
REFRESHEOF
chmod +x "$REFRESH_SCRIPT"
ok "Script de refresh DNS instalado en $REFRESH_SCRIPT"

# Primer poblado inmediato
"$REFRESH_SCRIPT"
IPSET_COUNT=$(ipset list ${IPSET_NAME} | grep -c '^[0-9]' || true)
ok "ipset poblado con ${IPSET_COUNT} IPs iniciales"

# ── 8. Cron cada 5 min ──
CRON_LINE="*/5 * * * * ${REFRESH_SCRIPT} >/dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v cr-routed-refresh; echo "$CRON_LINE") | crontab -
ok "Cron de refresh cada 5 min instalado"

# ── 9. Policy routing: marcar paquetes hacia IPs del ipset ──
# Limpiar reglas previas (idempotente)
iptables -t mangle -D OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null || true
ip rule del fwmark ${FWMARK} table ${ROUTE_TABLE} 2>/dev/null || true
ip route flush table ${ROUTE_TABLE} 2>/dev/null || true

# Marcar
iptables -t mangle -A OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK}
# Regla: paquetes marcados usan la tabla custom
ip rule add fwmark ${FWMARK} table ${ROUTE_TABLE}
# Tabla custom: default vía el Pi por wg0
ip route add default via ${WG_SERVER_IP} dev ${WG_IFACE} table ${ROUTE_TABLE}
ok "Policy routing activo (fwmark ${FWMARK} → tabla ${ROUTE_TABLE} → ${WG_IFACE})"

# ── 10. Persistir reglas (iptables-persistent) ──
DEBIAN_FRONTEND=noninteractive apt install -y iptables-persistent ipset-persistent >/dev/null 2>&1 || true
netfilter-persistent save >/dev/null 2>&1 || true

# Servicio para restaurar policy routing al boot (ip rule/route no son persistentes)
cat > /etc/systemd/system/cr-policy-routing.service << SVCEOF
[Unit]
Description=CR Policy Routing (mark + ip rule + ip route)
After=wg-quick@${WG_IFACE}.service network-online.target
Wants=wg-quick@${WG_IFACE}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '${REFRESH_SCRIPT}; \
  iptables -t mangle -C OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null || \
  iptables -t mangle -A OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK}; \
  ip rule show | grep -q "fwmark ${FWMARK}" || ip rule add fwmark ${FWMARK} table ${ROUTE_TABLE}; \
  ip route show table ${ROUTE_TABLE} | grep -q default || ip route add default via ${WG_SERVER_IP} dev ${WG_IFACE} table ${ROUTE_TABLE}'
ExecStop=/bin/bash -c 'iptables -t mangle -D OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null; \
  ip rule del fwmark ${FWMARK} table ${ROUTE_TABLE} 2>/dev/null; \
  ip route flush table ${ROUTE_TABLE} 2>/dev/null'

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable cr-policy-routing.service >/dev/null 2>&1
ok "Servicio cr-policy-routing instalado (auto-restore al boot)"

# ── 11. Verificación ──
echo ""
echo "🔍 Verificando que el tráfico CR sale por la IP correcta..."
sleep 1
# IP pública vía la red CR (rutea cf.streann.tech-like)
CR_IP=$(curl -s --max-time 8 --interface ${WG_IFACE} https://api.ipify.org 2>/dev/null || echo "")
VPS_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
echo "  IP del VPS (normal):     ${VPS_IP:-no detectada}"
echo "  IP vía túnel CR (wg0):   ${CR_IP:-no detectada}"
if [ -n "$CR_IP" ] && [ "$CR_IP" != "$VPS_IP" ]; then
  ok "Túnel CR funcional — IP distinta confirmada"
else
  warn "No pude confirmar IP CR distinta. Verificá handshake: wg show"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo -e "${GREEN}  ✅ Policy routing CR activo${NC}"
echo "═══════════════════════════════════════════════"
echo ""
echo "  📝 Dominios ruteados:  ${DOMAINS_FILE}"
echo "  🔄 Refresh DNS:        ${REFRESH_SCRIPT} (cron cada 5min)"
echo "  📊 Ver ipset:          ipset list ${IPSET_NAME}"
echo "  📊 Ver túnel:          wg show"
echo "  📊 Ver rutas CR:       ip route show table ${ROUTE_TABLE}"
echo ""
echo "  Prueba rápida:"
echo "    curl -s https://cf.streann.tech/  # debería responder con tu IP CR"
echo ""
echo "  Reiniciá el emisor para aplicar:  systemctl restart m3u8-emitter"
echo ""
exit 0
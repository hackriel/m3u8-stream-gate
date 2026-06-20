#!/bin/bash
# ════════════════════════════════════════════════════════════════════
#  Migrar ruteo CR de "por destino (ipset)" a "por UID (croute)"
#
#  Antes: TODO tráfico del VPS a cdn0x.teletica.com / cf.streann.tech
#         salía por el túnel CR. Si el Pi se caía, se rompían también
#         TELETICA URL, TDMAS URL y FUTV URL aunque no debían.
#
#  Después: solo el FFmpeg de FOX URL / FOX+ URL / Canal 6 URL
#           (lanzado por server.js como usuario `croute`) sale por el
#           túnel. cf.streann.tech sigue ruteado por destino para que
#           el login TDMax desde el VPS también vaya por CR.
#           El resto del VPS sale por su IP normal.
#
#  Correr en el VPS como root:
#     sudo bash migrate-to-uid-routing.sh
# ════════════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Correr como root: sudo bash $0"

WG_IFACE="wg0"
WG_SERVER_IP="10.77.0.1"
FWMARK="0x77"
RT_TABLE="cr_routed"
IPSET_NAME="cr_routed"
DOMAINS_FILE="/etc/wireguard/cr-routed-domains.txt"
REFRESH_BIN="/usr/local/bin/cr-routed-refresh.sh"

# ── 1. Reducir lista de dominios ruteados por destino a solo cf.streann.tech ──
#     (Los CDNs cdn0x.teletica.com ya NO se rutean por destino. Para FOX/FOX+/
#      Canal 6 se rutean por UID croute. Para TELETICA/TDMAS/FUTV URL salen
#      directo por la IP del VPS.)
mkdir -p /etc/wireguard
cat > "$DOMAINS_FILE" << 'EOF'
# Dominios ruteados por DESTINO vía túnel CR.
# Solo dejamos cf.streann.tech para que el login TDMax desde el VPS (server.js
# scrapeStreamUrlLocal) salga por CR. Los CDNs (cdn0x.teletica.com) ya NO van
# acá — se rutean por UID `croute` solo para los FFmpegs de FOX/FOX+/Canal 6.
cf.streann.tech
EOF
ok "Lista de dominios reducida a cf.streann.tech"

# ── 2. Refrescar ipset (debe existir refresh script ya instalado) ──
if [ -x "$REFRESH_BIN" ]; then
  "$REFRESH_BIN"
  ok "ipset $IPSET_NAME refrescado"
else
  warn "$REFRESH_BIN no existe. Saltando refresh (si nunca corriste setup-vps-wireguard-client.sh, hacelo primero)."
fi

# ── 3. Crear usuario sistema 'croute' ──
if id croute >/dev/null 2>&1; then
  warn "Usuario croute ya existía"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin croute
  ok "Usuario croute creado"
fi
CROUTE_UID=$(id -u croute)
echo "   croute UID = $CROUTE_UID"

# ── 4. Agregar regla mangle por UID (idempotente) ──
iptables -t mangle -C OUTPUT -m owner --uid-owner "$CROUTE_UID" -j MARK --set-mark "$FWMARK" 2>/dev/null \
  || iptables -t mangle -A OUTPUT -m owner --uid-owner "$CROUTE_UID" -j MARK --set-mark "$FWMARK"
ok "iptables mangle OUTPUT owner-uid=$CROUTE_UID → MARK $FWMARK"

# ── 5. Garantizar ip rule + tabla + MASQUERADE (idempotente) ──
ip rule del fwmark "$FWMARK" table "$RT_TABLE" 2>/dev/null || true
ip rule add fwmark "$FWMARK" table "$RT_TABLE"
ip route replace default via "$WG_SERVER_IP" dev "$WG_IFACE" table "$RT_TABLE"
iptables -t nat -C POSTROUTING -o "$WG_IFACE" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -o "$WG_IFACE" -j MASQUERADE
ok "ip rule + tabla + MASQUERADE OK"

# ── 6. Re-escribir systemd unit para que sobreviva al reboot ──
cat > /etc/systemd/system/cr-policy-routing.service << EOF
[Unit]
Description=CR Policy Routing (cf.streann.tech por destino + FFmpegs FOX/FOX+/Canal6 por UID croute)
After=network-online.target wg-quick@${WG_IFACE}.service
Wants=network-online.target wg-quick@${WG_IFACE}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '\\
  ipset create -exist ${IPSET_NAME} hash:ip family inet timeout 0; \\
  [ -x ${REFRESH_BIN} ] && ${REFRESH_BIN}; \\
  ip route replace default via ${WG_SERVER_IP} dev ${WG_IFACE} table ${RT_TABLE}; \\
  ip rule del fwmark ${FWMARK} table ${RT_TABLE} 2>/dev/null || true; \\
  ip rule add fwmark ${FWMARK} table ${RT_TABLE}; \\
  iptables -t mangle -C OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null || \\
    iptables -t mangle -A OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK}; \\
  iptables -t mangle -C OUTPUT -m owner --uid-owner ${CROUTE_UID} -j MARK --set-mark ${FWMARK} 2>/dev/null || \\
    iptables -t mangle -A OUTPUT -m owner --uid-owner ${CROUTE_UID} -j MARK --set-mark ${FWMARK}; \\
  iptables -t nat -C POSTROUTING -o ${WG_IFACE} -j MASQUERADE 2>/dev/null || \\
    iptables -t nat -A POSTROUTING -o ${WG_IFACE} -j MASQUERADE'
ExecStop=/bin/bash -c '\\
  ip rule del fwmark ${FWMARK} table ${RT_TABLE} 2>/dev/null || true; \\
  ip route flush table ${RT_TABLE} 2>/dev/null || true; \\
  iptables -t mangle -D OUTPUT -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK} 2>/dev/null || true; \\
  iptables -t mangle -D OUTPUT -m owner --uid-owner ${CROUTE_UID} -j MARK --set-mark ${FWMARK} 2>/dev/null || true; \\
  iptables -t nat -D POSTROUTING -o ${WG_IFACE} -j MASQUERADE 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cr-policy-routing.service >/dev/null 2>&1
systemctl restart cr-policy-routing.service
ok "Servicio cr-policy-routing.service actualizado y reiniciado"

# ── 7. Verificación ──
echo ""
echo "🔍 Verificación de IPs:"
VPS_IP=$(curl -s --max-time 6 https://api.ipify.org || echo "?")
CROUTE_IP=$(sudo -u croute curl -s --max-time 12 https://api.ipify.org || echo "?")
echo "   IP normal del VPS (root):    $VPS_IP"
echo "   IP saliendo como 'croute':   $CROUTE_IP   ← debe ser la IP CR del Pi"

if [ "$VPS_IP" != "$CROUTE_IP" ] && [ "$CROUTE_IP" != "?" ]; then
  ok "✅ Ruteo por UID funcionando — FOX/FOX+/Canal 6 saldrán por CR, los demás por VPS"
else
  warn "Las IPs coinciden o falló la verificación. Revisá: wg show, ip rule, iptables -t mangle -L OUTPUT -n -v"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Ahora reiniciá el emisor para que server.js use runuser:"
echo "     sudo systemctl restart m3u8-emitter"
echo "═══════════════════════════════════════════════════════════════"
#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  🧹 Reset limpio del Pi 5 — borra cualquier estado WireGuard
#  previo, mata procesos colgados y deja la red en estado virgen
#  para una instalación fresca.
# ═══════════════════════════════════════════════════════════════
set +e  # tolerante: si algo no existía, seguimos

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

[ "$EUID" -eq 0 ] || { echo "Ejecuta como root: sudo bash reset.sh"; exit 1; }

echo ""
echo "═══════════════════════════════════════════════"
echo "  🧹 Reset WireGuard Gateway (Pi 5)"
echo "═══════════════════════════════════════════════"
echo ""

# 1. Parar y deshabilitar servicios WG existentes
for svc in wg-quick@wg0 cr-policy-routing; do
  if systemctl list-unit-files | grep -q "^${svc}"; then
    systemctl stop "$svc" 2>/dev/null && ok "Stopped $svc" || warn "$svc no estaba activo"
    systemctl disable "$svc" 2>/dev/null
  fi
done

# 2. Tumbar interfaces wg0/wg1 si quedaron
for iface in wg0 wg1; do
  if ip link show "$iface" >/dev/null 2>&1; then
    wg-quick down "$iface" 2>/dev/null
    ip link delete "$iface" 2>/dev/null && ok "Removed interface $iface"
  fi
done

# 3. Limpiar reglas iptables FORWARD + MASQUERADE residuales
iptables -F FORWARD 2>/dev/null
iptables -t nat -F POSTROUTING 2>/dev/null
ok "iptables FORWARD + nat POSTROUTING limpiados"

# 4. Backup y borrar configs viejas
if [ -d /etc/wireguard ]; then
  BACKUP="/root/wireguard-backup-$(date +%Y%m%d-%H%M%S)"
  mv /etc/wireguard "$BACKUP" 2>/dev/null && ok "Config previa respaldada en $BACKUP"
fi

# 5. Matar procesos huérfanos
pkill -9 wg-quick 2>/dev/null
pkill -9 wireguard 2>/dev/null

# 6. Restaurar persistencia iptables (sin reglas WG)
command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1

echo ""
ok "Pi 5 limpio — listo para instalación fresca"
echo ""

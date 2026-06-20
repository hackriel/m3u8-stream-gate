#!/usr/bin/env bash
# pi5-cr-gateway / uninstall.sh
# Limpieza total. Útil para arrancar de cero después de un install roto.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "❌ Requiere root (sudo)." >&2
  exit 1
fi

echo "[uninstall] Bajando wg0 y removiendo unidad..."
systemctl stop wg-quick@wg0 2>/dev/null || true
systemctl disable wg-quick@wg0 2>/dev/null || true

echo "[uninstall] Borrando /etc/wireguard/wg0.conf y /etc/wireguard/keys/ ..."
rm -f /etc/wireguard/wg0.conf
rm -rf /etc/wireguard/keys

echo "[uninstall] Removiendo sysctl 99-cr-gw.conf ..."
rm -f /etc/sysctl.d/99-cr-gw.conf
sysctl -w net.ipv4.ip_forward=0 >/dev/null || true

echo "[uninstall] Limpiando reglas iptables NAT residuales (best-effort)..."
iptables-save | grep -v '10.77.0.0/24' | iptables-restore || true

echo "✅ Listo. Ahora podés correr install.sh limpio."
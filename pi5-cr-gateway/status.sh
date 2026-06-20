#!/usr/bin/env bash
# pi5-cr-gateway / status.sh — diagnóstico rápido del gateway
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "❌ Requiere root." >&2
  exit 1
fi

echo "── wg show ─────────────────────────────────────"
wg show || echo "(wg0 no levantado)"

echo
echo "── ip a show wg0 ───────────────────────────────"
ip a show wg0 2>/dev/null || echo "(wg0 inexistente)"

echo
echo "── ping al VPS (10.77.0.2) ─────────────────────"
ping -c 3 -W 2 10.77.0.2 || echo "(sin respuesta — el VPS quizás aún no conectó)"

echo
echo "── IP pública vista por el Pi ──────────────────"
curl -fsS --max-time 6 https://api.ipify.org && echo

echo
echo "── ip_forward ──────────────────────────────────"
sysctl net.ipv4.ip_forward

echo
echo "── puerto 51820/UDP ────────────────────────────"
ss -lnup | grep -E '(:51820|wireguard)' || echo "(no se ve listening — wg-quick puede usar raw socket)"
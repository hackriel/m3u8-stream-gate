#!/usr/bin/env bash
# pi5-cr-gateway/install-proxy.sh
# Instala tinyproxy en el Pi5 escuchando SOLO en 10.77.0.1:8888 (interfaz wg0).
# Uso: sudo bash pi5-cr-gateway/install-proxy.sh
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "❌ correr como root"; exit 1; fi

echo "[1/4] apt install tinyproxy..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tinyproxy

echo "[2/4] Escribiendo /etc/tinyproxy/tinyproxy.conf ..."
cat > /etc/tinyproxy/tinyproxy.conf <<'CFG'
User tinyproxy
Group tinyproxy
Port 8888
Listen 10.77.0.1
Timeout 600
DefaultErrorFile "/usr/share/tinyproxy/default.html"
StatFile "/usr/share/tinyproxy/stats.html"
LogLevel Info
Syslog On
MaxClients 100
# Solo aceptar clientes desde el túnel WireGuard
Allow 10.77.0.0/24
# Permitir CONNECT para HTTPS (todos los puertos comunes de streaming)
ConnectPort 443
ConnectPort 80
ConnectPort 8080
ConnectPort 8443
DisableViaHeader Yes
CFG

echo "[3/4] Enable + restart tinyproxy..."
systemctl enable tinyproxy >/dev/null
systemctl restart tinyproxy
sleep 1

echo "[4/4] Verificando..."
ss -tlnp | grep ':8888' || { echo "❌ tinyproxy no está escuchando"; exit 1; }
echo "✅ tinyproxy activo en 10.77.0.1:8888"
echo ""
echo "Test desde el VPS:"
echo "  curl -x http://10.77.0.1:8888 -s --max-time 8 https://api.ipify.org"
echo "  → debe devolver la IP pública del Pi (Costa Rica)"

#!/bin/bash
set -e

echo "🗑️  Desinstalación del Servicio M3U8 Emitter"
echo "============================================="

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# Verificar que se ejecute como root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}❌ Ejecuta este script como root: sudo bash uninstall-service.sh${NC}"
    exit 1
fi

# 1. Detener servicio
if systemctl is-active --quiet m3u8-emitter; then
    print_warning "Deteniendo servicio..."
    systemctl stop m3u8-emitter
fi

# 2. Deshabilitar servicio
if systemctl is-enabled --quiet m3u8-emitter 2>/dev/null; then
    print_warning "Deshabilitando servicio..."
    systemctl disable m3u8-emitter
fi

# 3. Eliminar archivo de servicio
if [ -f "/etc/systemd/system/m3u8-emitter.service" ]; then
    rm /etc/systemd/system/m3u8-emitter.service
    print_status "Archivo de servicio eliminado"
fi

# 4. Eliminar logrotate
if [ -f "/etc/logrotate.d/m3u8-emitter" ]; then
    rm /etc/logrotate.d/m3u8-emitter
    print_status "Configuración de logrotate eliminada"
fi

# 5. Eliminar cron job
(crontab -l 2>/dev/null | grep -v "m3u8-emitter") | crontab -
print_status "Cron job eliminado"

# 6. Recargar systemd
systemctl daemon-reload

print_status "Servicio desinstalado completamente"
echo ""
echo "Los logs permanecen en /var/log/m3u8-emitter*.log"
echo "Para eliminarlos: sudo rm /var/log/m3u8-emitter*.log"

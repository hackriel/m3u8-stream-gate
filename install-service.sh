#!/bin/bash
set -e

echo "🔧 Instalación del Servicio M3U8 Emitter"
echo "========================================="

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

# Verificar que se ejecute como root
if [ "$EUID" -ne 0 ]; then
    print_error "Ejecuta este script como root: sudo bash install-service.sh"
    exit 1
fi

# Obtener directorio actual
INSTALL_DIR=$(pwd)
SERVICE_FILE="/etc/systemd/system/m3u8-emitter.service"

# 1. Verificar que existan archivos necesarios
if [[ ! -f "server.js" ]] || [[ ! -d "dist" ]]; then
    print_error "Primero ejecuta: bash fix-and-run.sh"
    print_warning "Este script instala el servicio, fix-and-run.sh construye la app"
    exit 1
fi

# 2. Detener servicio existente si existe
if systemctl is-active --quiet m3u8-emitter; then
    print_warning "Deteniendo servicio existente..."
    systemctl stop m3u8-emitter
fi

# 3. Liberar puerto 3001
print_warning "Liberando puerto 3001..."
fuser -k 3001/tcp 2>/dev/null || true
pkill -9 -f "node.*server.js" 2>/dev/null || true
sleep 2

# 4. Crear archivo de servicio systemd
print_status "Creando servicio systemd..."
cat > $SERVICE_FILE << EOF
[Unit]
Description=M3U8 to RTMP Emitter Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=PORT=3001
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/m3u8-emitter.log
StandardError=append:/var/log/m3u8-emitter-error.log
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

print_status "Archivo de servicio creado en $SERVICE_FILE"

# 5. Crear logrotate para los logs
cat > /etc/logrotate.d/m3u8-emitter << EOF
/var/log/m3u8-emitter*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0640 root root
    postrotate
        systemctl reload m3u8-emitter 2>/dev/null || true
    endscript
}
EOF

print_status "Logrotate configurado (logs rotan cada día, máximo 7 días)"

# 6. Crear cron para reinicio diario (opcional)
CRON_JOB="0 4 * * * systemctl restart m3u8-emitter"
(crontab -l 2>/dev/null | grep -v "m3u8-emitter"; echo "$CRON_JOB") | crontab -
print_status "Reinicio diario programado a las 4:00 AM"

# 7. Recargar systemd y habilitar servicio
systemctl daemon-reload
systemctl enable m3u8-emitter
print_status "Servicio habilitado para inicio automático"

# 8. Iniciar servicio
systemctl start m3u8-emitter
sleep 3

# 9. Verificar estado
if systemctl is-active --quiet m3u8-emitter; then
    print_status "¡Servicio iniciado correctamente!"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}📡 Accede a: http://$(hostname -I | awk '{print $1}'):3001${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "🔧 Comandos útiles:"
    echo "   Ver estado:    sudo systemctl status m3u8-emitter"
    echo "   Ver logs:      sudo journalctl -u m3u8-emitter -f"
    echo "   Reiniciar:     sudo systemctl restart m3u8-emitter"
    echo "   Detener:       sudo systemctl stop m3u8-emitter"
    echo "   Deshabilitar:  sudo systemctl disable m3u8-emitter"
    echo ""
else
    print_error "Error al iniciar el servicio"
    echo "Verifica los logs con: sudo journalctl -u m3u8-emitter -n 50"
    exit 1
fi

print_status "✨ Instalación completada"
echo ""
echo -e "${GREEN}El servicio ahora:${NC}"
echo "  ✅ Se inicia automáticamente al reiniciar el servidor"
echo "  ✅ Se reinicia automáticamente si falla"
echo "  ✅ Se reinicia cada día a las 4:00 AM"
echo "  ✅ Los logs rotan automáticamente"

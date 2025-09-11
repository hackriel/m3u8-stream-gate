#!/bin/bash
set -e

echo "🚀 Instalación automática - Emisor M3U8 to RTMP"

# Verificar e instalar Node.js 20
if ! command -v node &> /dev/null || [ "$(node --version | cut -d'v' -f2 | cut -d'.' -f1)" -lt 18 ]; then
    echo "📦 Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Verificar e instalar FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "🎥 Instalando FFmpeg..."
    sudo apt update && sudo apt install -y ffmpeg
fi

# Limpiar e instalar dependencias
echo "📚 Instalando dependencias..."
npm cache clean --force
rm -rf node_modules package-lock.json
npm install

# Construir aplicación
echo "🔨 Construyendo aplicación..."
npm run build

# Dar permisos
chmod +x server.js start-server.js 2>/dev/null || true

# Matar procesos en puerto 3001 si existen
sudo fuser -k 3001/tcp 2>/dev/null || true

echo "✅ ¡Listo! Iniciando servidor en puerto 3001..."
echo "🌐 Accede desde: http://$(hostname -I | awk '{print $1}'):3001"

NODE_ENV=production PORT=3001 node server.js
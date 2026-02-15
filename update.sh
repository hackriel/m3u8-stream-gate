#!/bin/bash
set -e

cd /opt/m3u8-emitter

echo "📥 Actualizando código..."
git pull

echo "📦 Instalando dependencias..."
npm install

echo "🔨 Compilando frontend..."
npm run build

echo "🧹 Limpiando dependencias de desarrollo..."
npm prune --omit=dev

echo "🔄 Reiniciando servicio..."
sudo systemctl restart m3u8-emitter

echo "✅ ¡Actualización completada!"

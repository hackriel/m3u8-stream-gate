#!/bin/bash
set -e

cd /opt/m3u8-emitter

echo "🧹 Limpiando archivos generados que bloquean el merge..."
# Playlists HLS que FFmpeg deja en disco — no deben estar versionadas
find live -name 'playlist.m3u8' -delete 2>/dev/null || true
find live -name '*.ts' -delete 2>/dev/null || true

echo "📥 Actualizando código..."
# Descarta cambios locales en archivos trackeados (output-profiles.json, etc.)
# para que git pull no aborte. La config real vive en Supabase / .env.
git fetch origin
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git reset --hard "origin/${BRANCH}"

echo "📦 Instalando dependencias..."
npm install

echo "🔨 Compilando frontend..."
npm run build

echo "🧹 Limpiando dependencias de desarrollo..."
npm prune --omit=dev

echo "🔄 Reiniciando servicio..."
sudo systemctl restart m3u8-emitter

echo "✅ ¡Actualización completada!"

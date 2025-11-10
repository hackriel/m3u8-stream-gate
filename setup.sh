#!/bin/bash
set -e

echo "🚀 Instalación - Emisor M3U8 to RTMP"
echo ""

# Verificar FFmpeg
echo "🎥 Verificando FFmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    echo "⚠️  FFmpeg no encontrado. Instalando..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y ffmpeg
    elif command -v yum &> /dev/null; then
        sudo yum install -y ffmpeg
    elif command -v brew &> /dev/null; then
        brew install ffmpeg
    else
        echo "❌ No se pudo instalar FFmpeg automáticamente."
        echo "Por favor instala FFmpeg manualmente: https://ffmpeg.org/download.html"
        exit 1
    fi
else
    echo "✓ FFmpeg ya está instalado"
fi

echo ""
echo "🧹 Limpiando instalación anterior..."
rm -rf node_modules
rm -f package-lock.json

echo "📦 Limpiando caché de npm..."
npm cache clean --force

echo "📥 Instalando dependencias..."
npm install

echo "✅ Verificando instalación de paquetes críticos del servidor..."
if [ -d "node_modules/ws" ]; then
    echo "  ✓ ws instalado"
else
    echo "  ❌ ERROR: ws NO instalado"
    exit 1
fi

if [ -d "node_modules/express" ]; then
    echo "  ✓ express instalado"
else
    echo "  ❌ ERROR: express NO instalado"
    exit 1
fi

if [ -d "node_modules/multer" ]; then
    echo "  ✓ multer instalado"
else
    echo "  ❌ ERROR: multer NO instalado"
    exit 1
fi

if [ -d "node_modules/cors" ]; then
    echo "  ✓ cors instalado"
else
    echo "  ❌ ERROR: cors NO instalado"
    exit 1
fi

echo ""
echo "🎉 ¡Instalación completada exitosamente!"
echo ""
echo "Para iniciar el servidor, ejecuta:"
echo "  node server.js"
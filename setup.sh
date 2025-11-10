#!/bin/bash
set -e

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
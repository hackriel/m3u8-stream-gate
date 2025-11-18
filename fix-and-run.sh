#!/bin/bash
set -e

echo "🔧 Script de Reparación - Emisor M3U8 to RTMP"
echo "=============================================="

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

# 1. Verificar que existan archivos del proyecto
if [[ ! -f "package.json" ]] || [[ ! -f "server.js" ]]; then
    print_error "Ejecuta este script desde el directorio raíz del proyecto (donde están package.json y server.js)"
    exit 1
fi

# 2. Limpiar caché y dependencias
echo "🧹 Limpiando proyecto..."
rm -rf node_modules dist .vite vite.config.ts.timestamp-* 2>/dev/null || true
rm -rf ~/.cache/vite 2>/dev/null || true
npm cache clean --force
print_status "Caché limpiado"

# 3. Instalar dependencias
echo "📦 Instalando dependencias..."
npm install

if [ $? -ne 0 ]; then
    print_error "Error instalando dependencias"
    exit 1
fi

print_status "Dependencias instaladas"

# 3.5. Verificar que archivos críticos existan
if [ ! -d "node_modules/@supabase/supabase-js" ]; then
    print_error "@supabase/supabase-js no se instaló correctamente"
    print_warning "Intentando reinstalar @supabase/supabase-js..."
    npm install @supabase/supabase-js@^2.83.0
    if [ ! -d "node_modules/@supabase/supabase-js" ]; then
        exit 1
    fi
fi

if [ ! -f "src/integrations/supabase/client.ts" ]; then
    print_error "src/integrations/supabase/client.ts no existe"
    exit 1
fi

print_status "Verificaciones completadas"

# 3.6. Verificar que el archivo .env exista con las variables de Supabase
if [ ! -f ".env" ]; then
    print_error "Archivo .env no encontrado"
    exit 1
fi

# Verificar que las variables críticas existan
if ! grep -q "VITE_SUPABASE_URL" .env; then
    print_error "VITE_SUPABASE_URL no encontrada en .env"
    exit 1
fi

if ! grep -q "VITE_SUPABASE_PUBLISHABLE_KEY" .env; then
    print_error "VITE_SUPABASE_PUBLISHABLE_KEY no encontrada en .env"
    exit 1
fi

print_status "Variables de entorno verificadas"

# 4. Build de la aplicación
echo "🔨 Construyendo aplicación..."
npm run build

if [ $? -ne 0 ]; then
    print_error "Error en el build"
    print_warning "Tip: Verifica que el archivo .env tenga las variables correctas"
    exit 1
fi

print_status "Aplicación construida"

# 5. Liberar puerto 3001
print_warning "Liberando puerto 3001..."

# Intentar múltiples métodos de forma agresiva
echo "Método 1: fuser..."
sudo fuser -k 3001/tcp 2>/dev/null || true
sleep 1

echo "Método 2: lsof..."
PORT_PID=$(sudo lsof -ti:3001 2>/dev/null || true)
if [ ! -z "$PORT_PID" ]; then
    echo "Matando proceso $PORT_PID..."
    sudo kill -9 $PORT_PID 2>/dev/null || true
    sleep 1
fi

echo "Método 3: pkill procesos node..."
sudo pkill -9 -f "node.*server.js" 2>/dev/null || true
sudo pkill -9 -f "PORT=3001" 2>/dev/null || true
sleep 2

# Verificar si el puerto está libre
if sudo lsof -ti:3001 >/dev/null 2>&1; then
    print_error "El puerto 3001 sigue ocupado."
    print_warning "Ejecuta manualmente: sudo lsof -ti:3001 | xargs sudo kill -9"
    print_warning "Luego ejecuta: NODE_ENV=production PORT=3001 node server.js"
    exit 1
fi

print_status "Puerto 3001 liberado"

# 6. Iniciar servidor
echo ""
print_status "🚀 Iniciando servidor en puerto 3001"
print_status "🌐 Accede a: http://$(hostname -I | awk '{print $1}'):3001"
print_status "🏠 Local: http://localhost:3001"
echo ""
echo "🎯 Presiona Ctrl+C para detener"
echo ""

NODE_ENV=production PORT=3001 node server.js

print_status "✨ Proceso completado"
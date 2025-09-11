#!/bin/bash

# 🚀 Script de Instalación Completa - Emisor M3U8 to RTMP
# Este script instala todo lo necesario y ejecuta la aplicación

set -e  # Salir si hay algún error

echo "🚀 Iniciando instalación completa..."

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Función para imprimir mensajes
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# 1. Verificar e instalar Node.js
echo "📦 Verificando Node.js..."
if ! command -v node &> /dev/null; then
    print_warning "Node.js no encontrado. Instalando..."
    
    # Instalar NodeSource repository
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    
    print_status "Node.js instalado"
else
    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js versión $NODE_VERSION no compatible. Necesitas versión 18+"
        exit 1
    fi
    print_status "Node.js versión $(node --version) OK"
fi

# 2. Verificar e instalar FFmpeg
echo "🎥 Verificando FFmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    print_warning "FFmpeg no encontrado. Instalando..."
    sudo apt update
    sudo apt install -y ffmpeg
    print_status "FFmpeg instalado"
else
    print_status "FFmpeg encontrado: $(ffmpeg -version | head -n1)"
fi

# 3. Instalar dependencias del proyecto
echo "📚 Instalando dependencias del proyecto..."
npm cache clean --force
rm -rf node_modules package-lock.json
npm install

if [ $? -eq 0 ]; then
    print_status "Dependencias instaladas correctamente"
else
    print_error "Error instalando dependencias"
    exit 1
fi

# 4. Construir la aplicación
echo "🔨 Construyendo la aplicación..."
npm run build

if [ $? -eq 0 ]; then
    print_status "Aplicación construida correctamente"
else
    print_error "Error construyendo la aplicación"
    exit 1
fi

# 5. Verificar que server.js existe y tiene permisos
if [ ! -f "server.js" ]; then
    print_error "Archivo server.js no encontrado"
    exit 1
fi

chmod +x server.js 2>/dev/null || true
chmod +x start-server.js 2>/dev/null || true

# 6. Crear script de inicio si no existe
if [ ! -f "start.sh" ]; then
    cat > start.sh << 'EOF'
#!/bin/bash
export NODE_ENV=production
export PORT=3001
node server.js
EOF
    chmod +x start.sh
    print_status "Script de inicio creado"
fi

# 7. Verificar puertos disponibles
PORT=3001
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    print_warning "Puerto $PORT en uso. Intentando detener procesos..."
    sudo fuser -k $PORT/tcp || true
    sleep 2
fi

# 8. Iniciar el servidor
echo "🚀 Iniciando servidor..."
print_status "Servidor iniciándose en puerto $PORT"
print_status "Accede a: http://$(hostname -I | awk '{print $1}'):$PORT"
print_status "O localmente: http://localhost:$PORT"

echo ""
echo "🎯 Para detener el servidor, presiona Ctrl+C"
echo ""

# Iniciar servidor con manejo de errores
NODE_ENV=production PORT=3001 node server.js

echo ""
print_status "Instalación y ejecución completada ✨"
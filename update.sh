#!/bin/bash
set -Eeuo pipefail

INSTALL_DIR="/opt/m3u8-emitter"
SERVICE_NAME="m3u8-emitter"
PORT="3001"
CONFIGURE_TELECABLE=false

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }

if [[ "${1:-}" == "--configure-telecable" ]]; then
  CONFIGURE_TELECABLE=true
elif [[ -n "${1:-}" ]]; then
  fail "Opción desconocida: $1. Usa --configure-telecable para cambiar las credenciales."
fi

[[ "$EUID" -eq 0 ]] || fail "Ejecuta: sudo bash ${INSTALL_DIR}/update.sh"
[[ -d "${INSTALL_DIR}/.git" ]] || fail "No existe el proyecto Git en ${INSTALL_DIR}"
cd "$INSTALL_DIR"

if $CONFIGURE_TELECABLE; then
  echo "🔐 Configurando credenciales Telecable (no se mostrarán en pantalla)..."
  read -r -p "TELECABLE_DEVICE_ID nuevo: " TELECABLE_DEVICE_ID
  read -r -s -p "TELECABLE_DEVICE_PASSWORD nuevo: " TELECABLE_DEVICE_PASSWORD
  echo ""
  [[ "$TELECABLE_DEVICE_ID" =~ ^[A-Za-z0-9_-]+$ ]] || fail "DEVICE_ID inválido"
  [[ "$TELECABLE_DEVICE_PASSWORD" =~ ^[A-Za-z0-9_-]+$ ]] || fail "DEVICE_PASSWORD inválido"

  install -d -m 0755 "/etc/systemd/system/${SERVICE_NAME}.service.d"
  umask 077
  cat > "/etc/systemd/system/${SERVICE_NAME}.service.d/20-telecable.conf" <<EOF
[Service]
Environment="TELECABLE_DEVICE_ID=${TELECABLE_DEVICE_ID}"
Environment="TELECABLE_DEVICE_PASSWORD=${TELECABLE_DEVICE_PASSWORD}"
EOF
  unset TELECABLE_DEVICE_ID TELECABLE_DEVICE_PASSWORD
  ok "Credenciales guardadas en systemd"
fi

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
systemctl daemon-reload

# Verifica presencia, nunca imprime los valores secretos.
ENVIRONMENT=$(systemctl show "$SERVICE_NAME" -p Environment --value)
[[ "$ENVIRONMENT" == *"TELECABLE_DEVICE_ID="* ]] || fail "Falta TELECABLE_DEVICE_ID en systemd. Repite con --configure-telecable"
[[ "$ENVIRONMENT" == *"TELECABLE_DEVICE_PASSWORD="* ]] || fail "Falta TELECABLE_DEVICE_PASSWORD en systemd. Repite con --configure-telecable"
ok "Variables Telecable presentes"

systemctl restart "$SERVICE_NAME"

echo "⏳ Esperando que el servicio responda..."
READY=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done
$READY || {
  systemctl status "$SERVICE_NAME" --no-pager -l || true
  fail "El servicio no respondió en 30 segundos"
}
ok "Servicio activo y API disponible"

echo "📺 Validando extracción real de Canal 6 (pid 15)..."
VALIDATION_FILE=$(mktemp)
trap 'rm -f "${VALIDATION_FILE:-}"' EXIT
HTTP_CODE=$(curl -sS --max-time 45 -o "$VALIDATION_FILE" -w '%{http_code}' \
  "http://127.0.0.1:${PORT}/api/telecable/15/validate") || fail "No se pudo consultar la validación Telecable"

if [[ "$HTTP_CODE" != "200" ]]; then
  ERROR_SUMMARY=$(node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(j.error||'respuesta inválida')}catch{console.log('respuesta inválida')}" "$VALIDATION_FILE")
  fail "Extracción falló (API HTTP ${HTTP_CODE}): ${ERROR_SUMMARY}"
fi

VALIDATION_SUMMARY=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(j.ok!==true||j.source_http!==200)process.exit(2);console.log('canal='+j.channel+', calidad='+j.quality+', origen HTTP '+j.source_http)" "$VALIDATION_FILE") \
  || fail "La API respondió 200, pero la fuente del canal no quedó validada"
ok "Extracción confirmada: ${VALIDATION_SUMMARY}"

echo ""
ok "¡Actualización y validación completadas!"

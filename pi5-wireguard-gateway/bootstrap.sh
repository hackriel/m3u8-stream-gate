#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  🚀 Bootstrap WireGuard Gateway CR — Pi 5
#  Entry point único. Descarga la última versión del repo y corre
#  reset + install. Pensado para ejecutarse así:
#
#    curl -fsSL <REPO_RAW>/pi5-wireguard-gateway/bootstrap.sh | sudo bash
#
#  Variables opcionales:
#    REPO_RAW   URL base raw de GitHub (default: el del repo del proyecto)
#    BRANCH     rama a usar (default: main)
#    SKIP_RESET =1 para no limpiar estado previo
# ═══════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecuta como root: curl ... | sudo bash"

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/hackriel/m3u8-stream-gate}"
BRANCH="${BRANCH:-main}"
BASE_URL="${REPO_RAW}/${BRANCH}/pi5-wireguard-gateway"

echo ""
echo "═══════════════════════════════════════════════"
echo "  🚀 Bootstrap WireGuard Gateway CR"
echo "  Repo:   ${REPO_RAW}"
echo "  Branch: ${BRANCH}"
echo "═══════════════════════════════════════════════"
echo ""

# Espacio de trabajo temporal
WORK_DIR="/opt/pi5-wireguard-gateway"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# Instalar curl si falta (poco común pero por si acaso)
command -v curl >/dev/null || { apt update -qq && apt install -y curl; }

# Descargar scripts a la última versión
echo "📥 Descargando última versión desde GitHub..."
for f in reset.sh install.sh README.md; do
  curl -fsSL "${BASE_URL}/${f}" -o "${WORK_DIR}/${f}" || fail "No pude descargar ${f}. Verificá REPO_RAW y BRANCH."
done
chmod +x "${WORK_DIR}/reset.sh" "${WORK_DIR}/install.sh"
ok "Scripts actualizados en ${WORK_DIR}"

# Paso 1: reset (a menos que el user lo salte explícitamente)
if [ "${SKIP_RESET:-0}" != "1" ]; then
  echo ""
  echo "── Paso 1/2: Reset limpio ──"
  bash "${WORK_DIR}/reset.sh"
else
  warn "SKIP_RESET=1 — saltando limpieza previa"
fi

# Paso 2: install
echo ""
echo "── Paso 2/2: Instalación WireGuard + Gateway ──"
bash "${WORK_DIR}/install.sh"

echo ""
ok "Bootstrap completo. Próximo paso: copiar /root/vps-wireguard-client.conf al VPS"
echo "   scp /root/vps-wireguard-client.conf root@<IP-VPS>:/root/"
echo ""

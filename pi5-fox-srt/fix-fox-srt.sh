#!/bin/bash
# ============================================================
# fix-fox-srt.sh — Ajustes de estabilidad SRT para FOX (Stage A)
# Se ejecuta EN LA RASPBERRY PI 5 (no en el VPS)
#
# Cambios que aplica:
#   1. muxrate 4500k → 6000k (margen para picos de TDMax ~4.5 Mbps)
#   2. m3u8_hold_counters 1000 → 10 (evita hold excesivo)
#   3. QUITA -re de Stage A (FFmpeg lee HLS lo más rápido posible)
#   4. Agrega buffers de entrada HLS antes de -http_seekable '0'
#
# Uso:  ssh pi@tu-ip
#       cd /opt/fox-srt-pusher
#       sudo bash fix-fox-srt.sh
# ============================================================

set -e

FILE="/opt/fox-srt-pusher/index.js"

if [ ! -f "$FILE" ]; then
    echo "❌ No encontré $FILE"
    echo "¿Estás en la Raspberry Pi y el servicio está instalado en /opt/fox-srt-pusher?"
    exit 1
fi

echo "📋 Backup del original → index.js.backup.$(date +%s)"
cp "$FILE" "$FILE.backup.$(date +%s)"

# 1) muxrate 4500k → 6000k
python3 << 'PY'
import re
with open('/opt/fox-srt-pusher/index.js', 'r') as f:
    text = f.read()

text = text.replace("'-muxrate', '4500k',", "'-muxrate', '6000k',")

count = text.count("'-muxrate', '6000k'")
with open('/opt/fox-srt-pusher/index.js', 'w') as f:
    f.write(text)
print(f"✅ muxrate cambiado ({count} instancia/s)")
PY

# 2) m3u8_hold_counters 1000 → 10
python3 << 'PY'
import re
with open('/opt/fox-srt-pusher/index.js', 'r') as f:
    text = f.read()

text = text.replace("'-m3u8_hold_counters', '1000',", "'-m3u8_hold_counters', '10',")

count = text.count("'-m3u8_hold_counters', '10'")
with open('/opt/fox-srt-pusher/index.js', 'w') as f:
    f.write(text)
print(f"✅ m3u8_hold_counters cambiado ({count} instancia/s)")
PY

# 3) Quitar -re de spawnSourceFfmpeg (Stage A)
python3 << 'PY'
with open('/opt/fox-srt-pusher/index.js', 'r') as f:
    text = f.read()

# Eliminamos la linea "'-re'," que aparece DENTRO de spawnSourceFfmpeg (Stage A)
# No tocamos -re si existe en otra funcion (Stage B no deberia tenerlo)
import re

# Buscar el bloque spawnSourceFfmpeg y quitar -re dentro de el
# Estrategia: reemplazar el patron exacto en args de Stage A
old = """    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '10',
    '-re',
    '-i', hlsUrl,"""

new = """    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '10',
    '-i', hlsUrl,"""

if old in text:
    text = text.replace(old, new)
    print("✅ -re quitado de Stage A")
else:
    # Si no matchea exacto, intentamos regex
    text2 = re.sub(
        r"(spawnSourceFfmpeg\(session\) \{[\s\S]*?)(    '-re',\n)([\s\S]*?\}\nfunction |\}\nasync function )",
        r"\1\3",
        text,
        count=1
    )
    if text2 != text:
        text = text2
        print("✅ -re quitado de Stage A (regex)")
    else:
        print("⚠️  No se pudo quitar -re (¿ya estaba quitado?)")

with open('/opt/fox-srt-pusher/index.js', 'w') as f:
    f.write(text)
PY

# 4) Agregar buffers HLS antes de -http_seekable '0'
python3 << 'PY'
with open('/opt/fox-srt-pusher/index.js', 'r') as f:
    text = f.read()

old = """    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '10',"""

new = """    '-thread_queue_size', '4096',
    '-http_persistent', '1',
    '-multiple_requests', '1',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '10',"""

if old in text:
    text = text.replace(old, new)
    print("✅ Buffers HLS agregados")
else:
    print("⚠️  No se encontró el bloque exacto para inyectar buffers")

with open('/opt/fox-srt-pusher/index.js', 'w') as f:
    f.write(text)
PY

echo ""
echo "📋 Verificación final:"
grep -n "muxrate" "$FILE" | head -3
grep -n "m3u8_hold_counters" "$FILE" | head -3
grep -n "\-re" "$FILE" | grep -E "spawnSource|Stage A" || echo "  -re no encontrado en Stage A (bien)"
grep -n "thread_queue_size\|http_persistent" "$FILE" | head -3

echo ""
echo "🔄 Reiniciando servicio..."
sudo systemctl restart fox-srt-pusher || true
sleep 2
sudo systemctl status fox-srt-pusher --no-pager -l

echo ""
echo "✅ Listo. Revisá el log con: sudo journalctl -u fox-srt-pusher -f"

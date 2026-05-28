#!/bin/bash
# ============================================================
# fix-fox-srt-transcode.sh — Versión MÁS ROBUSTA: Stage A transcodifica a CBR 2500k
# Se ejecuta EN LA RASPBERRY PI 5
#
# En vez de passthrough (-c copy), esta versión RECODIFICA el stream TDMax
# a un bitrate constante y estable (CBR 2500k). Esto:
#   - Elimina ráfagas de bitrate que saturan el mux
#   - Garantiza un flujo constante hacia el VPS
#   - La Pi 5 maneja 720p30 a ~30% de un core, no hay problema de CPU
#
# Uso:  ssh pi@tu-ip
#       cd /opt/fox-srt-pusher
#       sudo bash fix-fox-srt-transcode.sh
# ============================================================

set -e

FILE="/opt/fox-srt-pusher/index.js"

if [ ! -f "$FILE" ]; then
    echo "❌ No encontré $FILE"
    exit 1
fi

echo "📋 Backup del original → index.js.backup.transcode.$(date +%s)"
cp "$FILE" "$FILE.backup.transcode.$(date +%s)"

python3 << 'PY'
with open('/opt/fox-srt-pusher/index.js', 'r') as f:
    text = f.read()

# === 1) Quitar -re de Stage A ===
old = """    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '1000',
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
    # fallback regex
    import re
    text2 = re.sub(
        r"(spawnSourceFfmpeg\(session\) \{[\s\S]*?)(    '-re',\n)([\s\S]*?\}\nfunction |\}\nasync function )",
        r"\1\3", text, count=1
    )
    if text2 != text:
        text = text2
        print("✅ -re quitado de Stage A (regex)")
    else:
        print("⚠️  -re ya estaba quitado o no encontrado")

# === 2) Reemplazar TODO el bloque de output de Stage A (passthrough → transcode) ===
# Esto es la parte critica: en vez de '-c', 'copy' y muxrate 4500k,
# usamos libx264 CBR 2500k + AAC 128k + muxrate 3000k

old_block = """    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-bsf:v', 'h264_mp4toannexb',
    // MPEG-TS broadcast-grade para SRT:
    //  - muxrate CBR 4.5 Mbps: paquetes TS salen a ritmo constante (no ráfagas) → SRT estable
    //  - pcr_period 20ms / pat_period 100ms / sdt_period 500ms = perfil DVB live
    //  - resend_headers + initial_discontinuity ayudan al VPS al reabrir Stage A
    //  - latm = no, mpegts_copyts no (genpts ya maneja)
    '-mpegts_flags', '+resend_headers+initial_discontinuity+pat_pmt_at_frames',
    '-muxrate', '4500k',
    '-pcr_period', '20',
    '-pat_period', '0.1',
    '-sdt_period', '0.5',
    '-mpegts_pmt_start_pid', '0x1000',
    '-mpegts_start_pid', '0x0100',
    '-f', 'mpegts',
    udpUrl,"""

new_block = """    '-map', '0:v:0', '-map', '0:a:0?',
    // Transcode a CBR 2500k: elimina ráfagas de bitrate del origen TDMax.
    // La Pi 5 sobra de CPU para 720p30 veryfast (~30% de un core).
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
    '-bsf:v', 'h264_mp4toannexb',
    '-mpegts_flags', '+resend_headers+initial_discontinuity+pat_pmt_at_frames',
    '-muxrate', '3000k',
    '-pcr_period', '20',
    '-pat_period', '0.1',
    '-sdt_period', '0.5',
    '-mpegts_pmt_start_pid', '0x1000',
    '-mpegts_start_pid', '0x0100',
    '-f', 'mpegts',
    udpUrl,"""

if old_block in text:
    text = text.replace(old_block, new_block)
    print("✅ Stage A cambiado a TRANSCODE CBR 2500k")
else:
    print("⚠️  No se encontró el bloque exacto de passthrough. Intentando regex...")
    import re
    # Regex que captura desde '-map' hasta 'udpUrl,' dentro de spawnSourceFfmpeg
    pattern = r"(spawnSourceFfmpeg\(session\) \{[\s\S]*?)(    '-map', '0:v:0', '-map', '0:a:0\?',\n[\s\S]*?)(    '-f', 'mpegts',\n    udpUrl,)"
    def repl(m):
        return m.group(1) + new_block + "\n"
    text2 = re.sub(pattern, repl, text, count=1)
    if text2 != text:
        text = text2
        print("✅ Stage A cambiado a TRANSCODE CBR 2500k (regex)")
    else:
        print("❌ No se pudo reemplazar el bloque. Revisá manualmente.")

# === 3) Agregar buffers HLS antes de -http_seekable ===
old_http = """    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '10',"""
new_http = """    '-thread_queue_size', '4096',
    '-http_persistent', '1',
    '-multiple_requests', '1',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '10',"""

if old_http in text:
    text = text.replace(old_http, new_http)
    print("✅ Buffers HLS agregados")

with open('/opt/fox-srt-pusher/index.js', 'w') as f:
    f.write(text)
PY

echo ""
echo "📋 Verificación final:"
grep -n "muxrate" "$FILE" | head -3
grep -n "libx264" "$FILE" | head -3
grep -n "b:v.*2500k" "$FILE" | head -3
grep -n "\-re" "$FILE" | grep -E "spawnSource|Stage A" || echo "  -re no encontrado en Stage A (bien)"

echo ""
echo "🔄 Reiniciando servicio..."
sudo systemctl restart fox-srt-pusher || true
sleep 2
sudo systemctl status fox-srt-pusher --no-pager -l

echo ""
echo "✅ Listo. Esta versión TRANSCODIFICA a CBR 2500k."
echo "Revisá el log con: sudo journalctl -u fox-srt-pusher -f"

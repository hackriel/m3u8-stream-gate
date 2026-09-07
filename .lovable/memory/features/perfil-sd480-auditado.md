---
name: Perfil SD 480p auditado (anti micro-freeze)
description: sd480 usa VBV contenido 1700k, audio 48kHz nativo, CFR al fps detectado y aresample suave en vez de -async 1
type: feature
---
Causa detectada del micro-freeze periódico (~1 min) en SD:
1. Audio re-muestreado 48kHz → 44.1kHz + `-async 1`: FFmpeg acumulaba drift A/V y lo corregía a saltos.
2. maxrate 2100k sobre 1500k (+40%): bursts que vacían el buffer del player en conexiones débiles.
3. Cadencia natural (`-vsync passthrough`) sobre HLS scrapeado: ritmo no uniforme, perceptible en fútbol.

Cambios (SOLO sd480, resto de perfiles intactos):
- maxrate 1700k, bufsize 3400k (2x bitrate ≈ 2s VBV), vbv-init=0.9, scenecut=0.
- `audioRate: '48000'` + `-ac 2` (sin resampleo).
- `forceCfr: true` → excluido de isNaturalCadence, sale `-r <fps detectado por ffprobe> -vsync cfr`.
- En perfiles forceCfr, `-async 1` se sustituye por `-af aresample=async=1:min_hard_comp=0.100:first_pts=0`.
- Auditoría en stderr cada 60s (`🧪 Auditoría SD`): fps real, dup/drop del tramo, speed medio/mínimo, bitrate medio/pico y avisos de timestamp.

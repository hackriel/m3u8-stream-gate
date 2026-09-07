---
name: Perfil Intermedio 576p auditado (1800k)
description: mid576 pasa de 2350k a 1800k con el mismo tratamiento anti-freeze del sd480 (VBV contenido, audio 48kHz nativo, CFR, aresample)
type: feature
---
mid576 vigente: 576p, 1800k promedio, maxrate 2000k (+11%), bufsize 3600k (2s), AAC 128k a 48000 nativo, preset faster, threads 5.
x264Params: rc-lookahead=30:ref=4:bframes=3:aq-mode=3:aq-strength=1.1:scenecut=0:vbv-init=0.9.
forceCfr: true → excluido de isNaturalCadence (isStandardProfile ahora exige !forceCfr) y usa `-af aresample=async=1:...` en vez de `-async 1`.
Motivo: replicar la corrección que eliminó el micro-freeze en sd480, bajando consumo de red frente a hd720 (~40% menos).

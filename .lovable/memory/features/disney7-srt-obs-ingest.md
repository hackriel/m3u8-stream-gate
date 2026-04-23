# Disney 7 (ID 16) — Ingest SRT desde OBS

## Resumen
Disney 7 acepta señal SRT directamente desde OBS (modo caller) en el puerto UDP 9001 del VPS, eliminando la dependencia de RTMP (que sufre cortes con jitter de internet residencial).

## Arquitectura
```
[OBS caller] ──SRT (latency 2000ms)──> [VPS :9001 listener]
                                              │
                                              ▼
                                    [/tmp/disney7-buffer-16/buf.m3u8]
                                              │ (≥3 segs ~30s buffer)
                                              ▼
                              [FFmpeg ETAPA 2 transcode 720p CBR 2000k @ 30fps]
                                              │
                                              ▼
                              [/live/Disney7/playlist.m3u8] → IPTV
```

## Activación
- El listener arranca automáticamente cuando se llama `/api/emit` con `process_id=16` y `source_m3u8` vacío o que empiece con `srt://obs` o `srt://0.0.0.0`.
- Independiente del flujo Tigo (no comparte buffer ni puertos).

## URL de OBS
```
srt://167.17.69.116:9001?streamid=disney7&latency=2000000&pbkeylen=16&passphrase=<DISNEY7_SRT_PASSPHRASE>
```

## Variables de entorno (opcionales)
- `DISNEY7_SRT_PORT` (default 9001)
- `DISNEY7_SRT_LATENCY_MS` (default 2000)
- `DISNEY7_SRT_PASSPHRASE` (default vacío = sin encriptación)

## Watchdog
Timeout de arranque ampliado a 120s (vs 25s default) porque OBS necesita tiempo para handshake SRT + llenar buffer 30s + arrancar ETAPA 2.

## Tigo NO afectado
El refactor mantiene Tigo (ID 12) idéntico con su flujo proxy SOCKS5 existente. Disney 7 es paralelo.

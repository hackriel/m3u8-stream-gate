# Tigo HDMI Emitter (Raspberry Pi 5)

Captura HDMI desde **Tigo Stick → Elgato Cam Link 4K → Pi5** y empuja SRT 24/7 al VPS de emisión.

## Arquitectura

```
Tigo Stick ──HDMI──▶ Cam Link 4K ──USB──▶ Pi5 ──SRT/UDP:9000──▶ VPS (167.17.69.116)
                                            │                        │
                                            └─ FFmpeg 720p30 H264    └─ Listener SRT
                                               + AAC 128k @ 48kHz       + transcode + HLS
```

El Pi5 **siempre está empujando SRT**. El VPS solo abre el listener cuando vos pulsás "Emitir" en el dashboard (proceso ID 12 = TIGO URL). Cuando lo apagás, el Pi5 reintenta cada 2s sin saturar nada (los paquetes UDP simplemente se pierden hasta que el VPS vuelva a escuchar).

## Hardware requerido

- Raspberry Pi 5 (4GB o más) con Raspberry Pi OS 64-bit
- Elgato Cam Link 4K (USB 3.0)
- Cable HDMI desde Tigo Stick
- Conexión a internet con upstream estable (~3 Mbps mínimo)

## Instalación

```bash
# En el Pi5, vía SSH como root o con sudo
git clone https://github.com/hackriel/m3u8-stream-gate.git /tmp/m3u8-stream-gate
cd /tmp/m3u8-stream-gate/pi5-hdmi-emitter
sudo bash install.sh
```

El instalador:
1. Instala `ffmpeg`, `v4l-utils`, `alsa-utils`
2. Detecta automáticamente el dispositivo de video y audio de la Cam Link
3. Copia los scripts a `/opt/tigo-hdmi-emitter/`
4. Crea el servicio systemd `tigo-hdmi-emitter.service`
5. Lo arranca y lo habilita en boot

## Variables de entorno (opcional)

Si querés cambiar destino o latencia antes de instalar:

```bash
sudo VPS_HOST=167.17.69.116 VPS_PORT=9000 LATENCY_MS=2000 bash install.sh
```

## Verificación

```bash
# Estado del servicio
systemctl status tigo-hdmi-emitter

# Logs en vivo
journalctl -u tigo-hdmi-emitter -f

# Confirmar que ffmpeg está corriendo
pgrep -a ffmpeg
```

En el dashboard del VPS, en el tab **TIGO URL**, verás el panel "Tigo HDMI · Ingest SRT" con bitrate, paquetes perdidos y estado de conexión en vivo.

## Comandos útiles

```bash
sudo systemctl restart tigo-hdmi-emitter   # Reiniciar
sudo systemctl stop tigo-hdmi-emitter      # Detener (ej. cambiar cable HDMI)
sudo systemctl start tigo-hdmi-emitter     # Volver a arrancar
```

## Troubleshooting

**Pantalla negra / sin video:**
- Verificá HDCP: si Tigo Stick activa HDCP, la Cam Link entrega negro. Solución: splitter HDMI 1×2 que strippea HDCP (~$15 Amazon).
- `v4l2-ctl --list-devices` debe mostrar la Cam Link.

**Sin audio:**
- `arecord -l` debe mostrar la Cam Link como tarjeta.
- El instalador detecta el card number; si cambiaste de USB, reinstalá.

**SRT no llega al VPS:**
- Confirmá que el VPS tiene `ufw allow 9000/udp`.
- Probá: `nc -u -v 167.17.69.116 9000` desde el Pi5.
- Revisá `/api/tigo-srt-status` en el dashboard — debe mostrar `connected: true` cuando emitís.

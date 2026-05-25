# 🛰️ Teletica SRT Pusher — Raspberry Pi 5

Logueá el Pi5 a TDMax con la **misma IP** desde la que ffmpeg lee los segments
(requisito del CDN), captura la señal HLS de Teletica y la reenvía vía **SRT
caller** al VPS en `srt://167.17.69.116:9004?streamid=teletica`.

El VPS solo arranca el SRT listener cuando se activa el switch del tab
**Teletica SRT** desde el dashboard. Mutuamente excluyente con **TELETICA URL**
(comparten `/live/Teletica/playlist.m3u8`).

## Instalación rápida

```bash
# En el Pi5 (Raspberry Pi OS 64-bit):
git clone <tu-repo> /tmp/m3u8-emitter
cd /tmp/m3u8-emitter/pi5-teletica-srt
sudo bash install.sh
```

## Variables (en `/etc/teletica-srt-pusher.env`)

| Variable | Default | Notas |
|---|---|---|
| `VPS_HOST` | `167.17.69.116` | IP/host público del VPS |
| `VPS_PORT` | `9004` | Puerto SRT del VPS |
| `SRT_STREAMID` | `teletica` | streamid SRT |
| `SRT_LATENCY_US` | `2000000` | 2 s de buffer |
| `SRT_PASSPHRASE` | *(vacío)* | Si lo activás, definí `TELETICA_SRT_PASSPHRASE` en el VPS con el mismo valor |
| `TDMAX_EMAIL` / `TDMAX_PASSWORD` | — | Cuenta TDMax válida |
| `REFRESH_MIN` | `8` | Re-loguear cada N minutos (token IP-locked ≈ 10 min) |
| `LOG_VERBOSE` | `0` | `1` para ver todo el stderr de ffmpeg |

## Comandos útiles

```bash
systemctl status teletica-srt-pusher       # estado
journalctl -u teletica-srt-pusher -f       # logs en vivo
sudo systemctl restart teletica-srt-pusher # reiniciar
```

## Resiliencia

- Si TDMax falla → backoff incremental (3 → 30 s).
- Si ffmpeg muere → reintenta automáticamente.
- Refresh proactivo cada `REFRESH_MIN` minutos para evitar 403 por token expirado.
- systemd `Restart=always` y `StartLimitIntervalSec=0` → nunca queda apagado.
- El SRT caller falla suave si el VPS aún no escucha (switch OFF) y reintenta.

## ¿Cómo lo paro desde el dashboard?

No hace falta apagar el Pi5. Mientras el switch del tab esté **OFF**, el VPS
no abre el listener SRT, el Pi5 intenta conectarse en bucle silencioso y
**no se envía ningún paquete de video** (solo handshakes pequeñísimos).
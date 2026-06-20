## Objetivo

1. Reintroducir el ruteo selectivo CR (solo IDs **15 Canal 6 URL, 24 FOX+ URL, 25 FOX URL**) sin que afecte a los canales USA si el túnel se cae.
2. Re-crear todos los scripts del Pi 5 y del VPS dentro del repo (versionados), para correrlos remotamente sin tocar archivos a mano.
3. Mostrar en el dashboard un badge visible cuando un canal está emitiendo con IP de Costa Rica.
4. Replicar en Canal 6 URL el toggle "Oficial / Scraping" que ya tiene Teletica, con tabs estables (no se mueven, no se quedan pegados).

---

## Arquitectura de la separación quirúrgica

**Regla de oro:** la tabla principal del VPS jamás se modifica. WireGuard `wg0` se levanta SIN `AllowedIPs = 0.0.0.0/0` agresivo y SIN cambiar `default route`. Solo los procesos marcados salen por el túnel.

Mecanismo (UID-based routing, ya probado antes):

- Se crea un usuario sistema `croute` en el VPS (sin login, sin home real, sin sudo).
- `iptables -t mangle -A OUTPUT -m owner --uid-owner croute -j MARK --set-mark 0x77`
- `ip rule add fwmark 0x77 table 100 priority 100`
- `ip route add default dev wg0 table 100`
- Cualquier proceso lanzado como `croute` → marca 0x77 → tabla 100 → wg0 → Pi 5 → internet CR. Todo lo demás → tabla `main` → IP USA.

En `server.js`:

```js
const CHANNELS_VIA_PI_WG = new Set(['15', '24', '25']); // Canal 6, FOX+, FOX
const wrapFfmpegForCrTunnel = (pid, argv) =>
  CHANNELS_VIA_PI_WG.has(String(pid))
    ? ['runuser', '-u', 'croute', '--', 'ffmpeg', ...argv]
    : ['ffmpeg', ...argv];
```

El scraping HTTP de esos 3 IDs se hace vía `undici` con un `Agent` que abre el socket bind-to-source 10.77.0.2 (la IP WG del VPS), de modo que TDMax también vea IP CR. Implementado en un helper `crFetch(url, opts)` usado SOLO en los flujos de scrape de 15/24/25.

**Fail-safe:** Si `wg0` se cae, los 3 canales CR fallan limpio (FFmpeg cierra, autoRecovery con circuit breaker). Los otros 17 canales no se enteran.

---

## Plan de cambios

### 1. Pi 5 — `pi5-cr-gateway/` (nuevo en el repo)

Carpeta nueva con todo lo necesario para dejar el Pi como gateway WG:

- `install.sh` — idempotente, ejecutable como root en el Pi (Raspberry Pi OS Bookworm 64-bit). Hace:
  1. `apt update && apt install -y wireguard-tools iptables-persistent qrencode curl`
  2. Habilita `net.ipv4.ip_forward=1` permanente en `/etc/sysctl.d/99-cr-gw.conf`
  3. Detecta interfaz WAN (`ip route show default | awk '/default/{print $5; exit}'`) → `eth0`/`wlan0`
  4. Genera par de claves del Pi en `/etc/wireguard/keys/` si no existen
  5. Escribe `/etc/wireguard/wg0.conf` (Pi = 10.77.0.1/24, listen 51820, MASQUERADE de 10.77.0.0/24 → WAN)
  6. `systemctl enable --now wg-quick@wg0`
  7. **Detecta y muestra la IP pública del Pi** con `curl -s https://api.ipify.org` y la imprime en pantalla con un banner claro: `>>> IP pública del Pi5: X.X.X.X — usar esta IP como Endpoint en el VPS si no tenés DDNS <<<`
  8. Imprime la public key del Pi y un bloque `[Peer]` listo para pegar en el VPS.
- `add-vps-peer.sh <vps_pubkey>` — agrega/actualiza el peer del VPS en `wg0.conf` y recarga.
- `status.sh` — `wg show`, `ip a show wg0`, ping a 10.77.0.2, IP pública vista por curl, tamaño de tráfico tx/rx.
- `uninstall.sh` — limpieza total para empezar de cero (porque venimos de un estado roto).
- `README.md` — pasos en orden: `uninstall.sh` → `install.sh` → copiar pubkey al VPS → ejecutar `add-vps-peer.sh` con la pubkey que devolverá el setup del VPS → `status.sh`.

**Requisitos físicos** (lo confirmamos en el momento desde el output de `install.sh`):
- IP pública en casa (no CGNAT). El `install.sh` advierte si la IP pública detectada está en rangos CGNAT (100.64.0.0/10) y aborta con instrucción.
- Port forward UDP/51820 → Pi en el router.

### 2. VPS — `setup-vps-cr-wireguard.sh` (nuevo, en raíz)

Script idempotente para correr en el VPS como root:

1. `apt install -y wireguard-tools iptables-persistent`
2. Crea usuario `croute` (`useradd -r -s /usr/sbin/nologin croute`) si no existe
3. Genera claves del VPS en `/etc/wireguard/keys/` si no existen
4. Pide por env var o argumento: `PI_PUBKEY`, `PI_ENDPOINT` (IP:51820 del Pi)
5. Escribe `/etc/wireguard/wg0.conf` (VPS = 10.77.0.2/24, `Table = off` ← crítico: WG no toca rutas principales)
6. Crea `/etc/systemd/system/cr-policy-routing.service` que al boot ejecuta:
   ```
   iptables -t mangle -C OUTPUT -m owner --uid-owner croute -j MARK --set-mark 0x77 || iptables -t mangle -A ...
   ip rule add fwmark 0x77 table 100 priority 100 2>/dev/null || true
   ip route replace default dev wg0 table 100
   ```
7. `systemctl enable --now wg-quick@wg0 cr-policy-routing`
8. Test de verificación: `sudo -u croute curl -s https://api.ipify.org` debe imprimir IP CR; `curl -s https://api.ipify.org` debe imprimir IP USA. Aborta con mensaje claro si no.
9. Imprime la pubkey del VPS para pegar en el Pi.

### 3. `server.js` — wiring del wrapper

- Constante `CHANNELS_VIA_PI_WG = new Set(['15','24','25'])`.
- Helper `wrapFfmpegForCrTunnel(pid, ffmpegArgs)` que devuelve `[cmd, args]`. Cambiar los 2-3 puntos donde se hace `spawn('ffmpeg', args, ...)` para esos pids → `spawn(cmd, args, ...)`. (Para el resto de pids el comportamiento es idéntico.)
- Helper `crFetch(url, opts)` usando `undici.Agent` con `connect: { localAddress: '10.77.0.2' }`. Reemplazar los `fetch` del scrape de pids 15/24/25 (login TDMax, master HLS preflight) por `crFetch`.
- Endpoint `GET /api/cr-tunnel/health` → devuelve `{ wg_up: bool, cr_ip: string|null, last_check: ts }`. Cachea 10s, hace `sudo -u croute curl https://api.ipify.org` (timeout 4s) y verifica que la IP empiece con un rango CR conocido o simplemente que sea distinta a la IP USA del VPS.
- En `/api/status` (o donde se serializa por proceso) incluir `via_cr_tunnel: CHANNELS_VIA_PI_WG.has(String(id))` para que el frontend lo lea sin lógica extra.

### 4. Canal 6 URL (15) — toggle Oficial / Scraping

Espejo de Teletica:

- Columna `source_mode` ya existe en `emission_processes`. Reusarla para pid 15.
- Server: `canal6SourceMode` Map, `setCanal6SourceMode`, persistencia DB, carga al boot.
- Endpoint `GET /api/canal6/source-mode`.
- En `/api/emit`: si `process_id === '15'` y `source_mode in {official, scraping}` → set + log.
- Fallback unidireccional `official → scraping` en los 3 puntos de recovery (idéntico al patrón Teletica).
- Modo `official`: usa el `m3u8` que el usuario haya pegado en el input (no hay URL "fija" tipo Bradmax porque acá la url oficial varía). FFmpeg igual sale por el túnel CR (porque pid 15 ∈ CHANNELS_VIA_PI_WG), con su perfil Canal 6 actual (master vivo + program-map). Logs claros: `🎛️ Canal 6 modo OFICIAL: usando URL pegada por usuario`.
- Modo `scraping`: TDMax → cdn12 (flujo actual).

Frontend (`EmisorM3U8Panel.tsx`):

- Replicar el bloque de `teleticaMode` para `canal6Mode` (key `canal6_15_source_mode` en localStorage).
- En el tab Canal 6 URL renderizar el mismo componente de tabs que Teletica. Usar `<Tabs value={canal6Mode} onValueChange={...}>` con `TabsList` de ancho fijo y `TabsTrigger` con `flex-1` para que NO se muevan. Memoizar el componente de tabs (`React.memo`) con `value` como prop para evitar re-mounts que causan el "se queda pegado".
- En modo `official` NO auto-rellena el input (a diferencia de Teletica). El usuario pega lo que quiera.
- Mandar `source_mode: canal6Mode` en `/api/emit` cuando `processIndex === CANAL6_URL_INDEX`.
- Poll a `/api/canal6/source-mode` cada 5s con el mismo patrón anti-overwrite.

### 5. Badge "Emitiendo con IP CR" en el dashboard

- En `EmisorM3U8Panel.tsx`, conjunto local `CR_TUNNEL_CHANNELS = new Set([15, 24, 25])`.
- Estado `crTunnelHealth: { wg_up, cr_ip }` poll cada 15s a `/api/cr-tunnel/health`.
- En la card de cada proceso que esté `running` Y `CR_TUNNEL_CHANNELS.has(id)`:
  - Badge verde: 🇨🇷 `IP CR · {cr_ip}` si `wg_up` y `cr_ip` válida.
  - Badge ámbar: `Túnel CR caído` si `!wg_up`.
- Tooltip con texto: `"Este canal está saliendo al CDN desde Costa Rica vía Pi5 (10.77.0.1)"`.
- Color/tipografía via tokens semánticos del design system (no hardcoded).

### 6. Documentación / README

- `pi5-cr-gateway/README.md`: pasos de arranque desde cero (reset → install → intercambiar keys → status).
- Sección en `README.md` raíz: "Salida CR selectiva (Pi 5)" con el orden VPS↔Pi y troubleshooting (qué hacer si el badge muestra ámbar).

### 7. Memoria del proyecto

Actualizar `mem://architecture/cr-wireguard-gateway.md`: lista blanca actual `[15, 24, 25]`, scripts viven en `pi5-cr-gateway/` y `setup-vps-cr-wireguard.sh`, `Table = off` es obligatorio, badge UI activo.

---

## Orden de ejecución

1. **Implementar todo en el repo** (scripts Pi + VPS + server.js + UI + badge + toggle Canal 6 + memoria).
2. **En el Pi 5**: `git pull` (o copiar la carpeta), `sudo bash pi5-cr-gateway/uninstall.sh && sudo bash pi5-cr-gateway/install.sh`. Anotar pubkey + IP pública que imprime.
3. **En el VPS**: `git pull && sudo PI_PUBKEY=... PI_ENDPOINT=IP:51820 bash setup-vps-cr-wireguard.sh`. Anotar pubkey del VPS que imprime.
4. **En el Pi**: `sudo bash pi5-cr-gateway/add-vps-peer.sh <vps_pubkey>`.
5. **Verificar**: `sudo bash pi5-cr-gateway/status.sh` (Pi) y `curl localhost:3000/api/cr-tunnel/health` (VPS).
6. Reiniciar `m3u8-emitter.service`, levantar Canal 6 URL, ver el badge 🇨🇷 IP CR en el dashboard.

---

## Riesgos y mitigaciones

- **CGNAT en CR**: el `install.sh` lo detecta y aborta con instrucción de pedirle al ISP IP pública o usar Tailscale Funnel como plan B.
- **MTU**: `wg0` con MTU 1380 por defecto en el setup, para evitar fragmentación con CDNs HTTPS.
- **Killswitch accidental**: usamos `Table = off` en wg0.conf — WireGuard NO instala rutas. Si el script de policy routing falla, los canales CR fallan, pero los USA siguen.
- **Caída del Pi**: solo afecta IDs 15/24/25; badge ámbar avisa.

---

## Detalles técnicos clave

- WG subred: `10.77.0.0/24` (Pi=.1, VPS=.2), puerto UDP 51820, MTU 1380, PersistentKeepalive 25s.
- Marca de paquete: `0x77`, tabla de ruteo: `100` (nombre `cr_routed` en `/etc/iproute2/rt_tables`).
- Usuario VPS: `croute` (system, nologin).
- Verificación de IP CR: rangos AS conocidos (Tigo/Liberty/Kolbi) cargados como prefijos en una whitelist pequeña, o simplemente `cr_ip !== vps_public_ip`.
- `crFetch` usa `undici@^6` (ya en `package.json` por Supabase).

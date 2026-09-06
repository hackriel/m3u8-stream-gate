
- [Pantalla /uptime](mem://features/uptime-public-screen) — Ruta pública sin password con relojes de uptime rotativos según forma de pantalla
- [Disney 8 Telecable dropdown](mem://features/disney8-telecable-dropdown) — ID 10: sub-tabs Oficial m3u pegado / Telecable dropdown, salida RTMP manual
- [Telecable Dropdown Reset](mem://features/telecable-dropdown-reset) — limpieza de canal/URL en pids 0 y 10 al detener o cambiar de modo
- [Diagnóstico Streaming](mem://features/streaming-diagnostics-module) — /api/diag + página /diagnostico: red, kernel, NIC, MTR vs YouTube, stress iperf3
- [SRT Feed-Loss Guard](mem://features/srt-feed-loss-guard) — borra playlist HLS cuando el publisher SRT corta, evita loop del último fragmento en XUI
- [Uptime Viewers](mem://features/uptime-viewers-counter) — Badge ojo+número por canal en /uptime vía /api/viewers (IP+UA únicos 45s)
- [Alta Calidad](mem://features/output-profile-alta-calidad) — perfil 'highquality' 720p CBR 4000k + AAC 192k, disponible en todos los canales
- [TDMax Source Probe](mem://features/tdmax-source-health-probe) — vigía read-only de la fuente TDMax (11/13/14/24/25): recovery anticipado por 403/404/ENDLIST o media-sequence congelada

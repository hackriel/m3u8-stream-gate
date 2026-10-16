---
name: Cuentas TDMax por canal
description: Qué cuenta TDMax usa cada proceso al scrapear
type: constraint
---
- Cuenta preferida: `info@media.cr` (`TDMAX_EMAIL_PI` / `TDMAX_PASSWORD_PI`), vigente hasta 2027.
- `arlopfa@gmail.com` (`TDMAX_EMAIL` / `TDMAX_PASSWORD`) está por caducar; no asignar canales nuevos a esa cuenta.
- `PI_ACCOUNT_PROCESSES` en server.js = `11, 14, 15, 17, 24, 25, 26` → FUTV URL, TDMAS 1 URL, CANAL 6 URL, FUTV ALTERNO, FOX+ URL, FOX URL, FOX+ ALTERNO.
- Queda en cuenta default sólo TELETICA URL (13), porque Teletica usa cuenta/sesión aparte.
- Cada proceso usa un device-id determinista distinto, así que compartir cuenta no invalida sesiones entre canales, pero sí consume cupo de devices.

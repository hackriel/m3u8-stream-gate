---
name: Perfil SD 480p — RETIRADO
description: sd480 eliminado en Oct 2026; el usuario reportó que se pegaba en producción pese a la auditoría anti-freeze
type: feature
---
RETIRADO (Oct 2026). sd480 (480p 1500k/1700k, VBV 3400k, audio 48kHz nativo, CFR, aresample suave) funcionó bien en la prueba inicial de FUTV, pero el usuario reportó que en producción "se pegaba" y pidió eliminarlo junto con mid576.

Lecciones que SÍ se conservan y aplican a otros perfiles:
- Audio 48kHz nativo sin resampleo + `aresample=async=1` en vez de `-async 1` (evita drift A/V).
- VBV contenido (pico ≤ +13%, buffer ~2s) para no vaciar el buffer del player.
- `scenecut=0` para GOP determinista de 2s.

Remapeo: LEGACY_PROFILE_ALIASES sd480→normal. Constraint DB ya no incluye sd480.

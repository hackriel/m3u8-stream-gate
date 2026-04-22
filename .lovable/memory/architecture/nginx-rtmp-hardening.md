---
name: NGINX-RTMP hardening for OBS publishers
description: Stability params added to nginx.conf so OBS publishers (Tigo URL ingest) survive >2 min sessions
type: feature
---
NGINX-RTMP default config drops idle connections after ~60s. To survive long OBS sessions:
- `timeout 300s` (server scope) — TCP silence tolerance
- `ping 30s; ping_timeout 15s` — RTMP-level keepalive
- `buflen 3000ms; max_message 10M` — absorb network jitter and large keyframes
- `application live { drop_idle_publisher 30s; sync 300ms; wait_key on; wait_video on; publish_notify off; }`

Symptom of missing config: OBS disconnects ~2 min into a session with no clear error. Lives in `setup-vps.sh` step [3/8] (NGINX install). To apply on existing VPS without reinstall, edit `/etc/nginx/nginx.conf` and `nginx -t && systemctl reload nginx`.

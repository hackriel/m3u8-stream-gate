-- FOX+ ALTERNO (id=26): nuevo proceso eventual con URL pegada por el usuario.
-- Mismo patrón que FUTV ALTERNO (id=17), pero emite al slug HLS 'foxmas'
-- (compartido con FOX+ URL/24 y FOX+ SRT/22 — mutex automático por slug).
insert into public.emission_processes (id, m3u8, rtmp, preview_suffix, is_emitting, active_time, down_time, elapsed, start_time, emit_status, emit_msg)
values (26, '', '', '/video.m3u8', false, 0, 0, 0, 0, 'idle', '')
on conflict (id) do nothing;

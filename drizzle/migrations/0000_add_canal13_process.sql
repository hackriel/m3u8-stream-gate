INSERT INTO public.emission_processes (id, emit_status, is_emitting, rtmp, m3u8, source_mode, output_profile)
VALUES (29, 'idle', false, 'hls-local', '', 'telecable', 'normal')
ON CONFLICT (id) DO NOTHING;
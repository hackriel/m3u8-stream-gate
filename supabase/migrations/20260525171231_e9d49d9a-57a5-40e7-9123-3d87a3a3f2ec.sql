ALTER TABLE public.emission_processes DROP CONSTRAINT IF EXISTS emission_processes_id_check;
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_id_check CHECK (id >= 0 AND id <= 30);

INSERT INTO public.emission_processes (id, m3u8, rtmp, preview_suffix, is_emitting, elapsed, start_time, emit_status, emit_msg, is_active, active_time, down_time, source_url, recovery_count, last_signal_duration, night_rest, always_on)
VALUES (21, 'srt://obs', 'hls-local', '/video.m3u8', false, 0, 0, 'idle', '', false, 0, 0, '', 0, 0, false, false)
ON CONFLICT (id) DO NOTHING;
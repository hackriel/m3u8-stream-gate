ALTER TABLE public.emission_processes DROP CONSTRAINT IF EXISTS emission_processes_id_check;
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_id_check CHECK (id >= 0 AND id <= 19);

INSERT INTO public.emission_processes (id, m3u8, m3u8_backup, rtmp, preview_suffix, is_emitting, elapsed, active_time, start_time, emit_status, emit_msg, recovery_count, last_signal_duration, night_rest, always_on)
VALUES (19, '', '', '', '/video.m3u8', false, 0, 0, 0, 'idle', '', 0, 0, false, false)
ON CONFLICT (id) DO NOTHING;
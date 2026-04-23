ALTER TABLE public.emission_processes DROP CONSTRAINT IF EXISTS emission_processes_id_check;
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_id_check CHECK (id >= 0 AND id <= 17);

INSERT INTO public.emission_processes (id, m3u8, rtmp, preview_suffix, is_emitting, active_time, down_time, elapsed, start_time, emit_status, emit_msg, source_url)
VALUES 
  (16, '', 'hls-local', '/video.m3u8', false, 0, 0, 0, 0, 'idle', '', ''),
  (17, '', 'hls-local', '/video.m3u8', false, 0, 0, 0, 0, 'idle', '', '')
ON CONFLICT (id) DO NOTHING;

-- Drop the id check constraint to allow process 9+
ALTER TABLE public.emission_processes DROP CONSTRAINT emission_processes_id_check;

-- Add new constraint allowing 0-9
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_id_check CHECK (id >= 0 AND id <= 9);

-- Insert row for process 9 (Demo TIGO)
INSERT INTO public.emission_processes (id, m3u8, rtmp, preview_suffix, is_emitting, elapsed, start_time, emit_status, emit_msg)
VALUES (9, '', '', '/video.m3u8', false, 0, 0, 'idle', '')
ON CONFLICT (id) DO NOTHING;

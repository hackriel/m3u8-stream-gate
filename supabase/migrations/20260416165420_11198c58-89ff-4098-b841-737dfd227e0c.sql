ALTER TABLE emission_processes DROP CONSTRAINT emission_processes_id_check;
ALTER TABLE emission_processes ADD CONSTRAINT emission_processes_id_check CHECK (id >= 0 AND id <= 12);

ALTER TABLE emission_processes DROP CONSTRAINT emission_processes_emit_status_check;
ALTER TABLE emission_processes ADD CONSTRAINT emission_processes_emit_status_check CHECK (emit_status = ANY (ARRAY['idle', 'starting', 'running', 'stopping', 'error', 'waiting_cdn']));

INSERT INTO emission_processes (id, active_time, down_time, elapsed, emit_msg, emit_status, is_active, is_emitting, last_signal_duration, m3u8, night_rest, preview_suffix, recovery_count, rtmp, source_url, start_time)
VALUES (12, 0, 0, 0, '', 'idle', false, false, 0, '', false, '/video.m3u8', 0, 'hls-local', '', 0)
ON CONFLICT (id) DO NOTHING;
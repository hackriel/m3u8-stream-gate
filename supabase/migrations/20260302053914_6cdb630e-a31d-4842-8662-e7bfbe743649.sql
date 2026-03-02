
ALTER TABLE public.emission_processes
ADD COLUMN IF NOT EXISTS last_signal_duration INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.emission_processes.last_signal_duration IS 'Duración en segundos de la última señal antes de reiniciar';

-- Agregar políticas RLS para permitir INSERT y DELETE en emission_processes
CREATE POLICY "Permitir inserción pública de procesos"
ON public.emission_processes
FOR INSERT
TO public
WITH CHECK (true);

CREATE POLICY "Permitir eliminación pública de procesos"
ON public.emission_processes
FOR DELETE
TO public
USING (true);

-- Agregar columna para guardar el PID del proceso FFmpeg
ALTER TABLE public.emission_processes
ADD COLUMN IF NOT EXISTS ffmpeg_pid integer DEFAULT NULL;

-- Agregar columna para logs del proceso
ALTER TABLE public.emission_processes
ADD COLUMN IF NOT EXISTS process_logs text DEFAULT ''::text;

-- Agregar columna para la fecha de finalización
ALTER TABLE public.emission_processes
ADD COLUMN IF NOT EXISTS ended_at timestamp with time zone DEFAULT NULL;
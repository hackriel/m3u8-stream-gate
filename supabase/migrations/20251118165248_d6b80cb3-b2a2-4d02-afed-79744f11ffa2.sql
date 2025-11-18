-- Crear tabla para almacenar los procesos de emisión
CREATE TABLE IF NOT EXISTS public.emission_processes (
  id INTEGER PRIMARY KEY CHECK (id >= 0 AND id <= 3),
  m3u8 TEXT NOT NULL DEFAULT '',
  rtmp TEXT NOT NULL DEFAULT '',
  preview_suffix TEXT NOT NULL DEFAULT '/video.m3u8',
  is_emitting BOOLEAN NOT NULL DEFAULT false,
  elapsed INTEGER NOT NULL DEFAULT 0,
  start_time BIGINT NOT NULL DEFAULT 0,
  emit_status TEXT NOT NULL DEFAULT 'idle' CHECK (emit_status IN ('idle', 'starting', 'running', 'stopping', 'error')),
  emit_msg TEXT NOT NULL DEFAULT '',
  failure_reason TEXT,
  failure_details TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  active_time INTEGER NOT NULL DEFAULT 0,
  down_time INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Insertar los 4 procesos por defecto
INSERT INTO public.emission_processes (id) 
VALUES (0), (1), (2), (3)
ON CONFLICT (id) DO NOTHING;

-- Habilitar Row Level Security
ALTER TABLE public.emission_processes ENABLE ROW LEVEL SECURITY;

-- Políticas: Cualquiera puede leer y modificar (ajusta según tus necesidades de seguridad)
CREATE POLICY "Permitir lectura pública de procesos"
ON public.emission_processes
FOR SELECT
USING (true);

CREATE POLICY "Permitir actualización pública de procesos"
ON public.emission_processes
FOR UPDATE
USING (true);

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_emission_processes_updated_at
BEFORE UPDATE ON public.emission_processes
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Habilitar realtime para esta tabla
ALTER PUBLICATION supabase_realtime ADD TABLE public.emission_processes;
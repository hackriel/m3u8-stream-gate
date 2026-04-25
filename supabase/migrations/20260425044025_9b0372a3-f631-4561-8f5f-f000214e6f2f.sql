-- Tabla para guardar snapshots de logs (últimos 3 por proceso)
CREATE TABLE public.process_log_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  process_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  log_content TEXT NOT NULL,
  emit_status TEXT,
  emit_msg TEXT,
  failure_reason TEXT,
  failure_details TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index para query rápido por proceso
CREATE INDEX idx_process_log_snapshots_process_id_created
  ON public.process_log_snapshots(process_id, created_at DESC);

-- Habilitar RLS
ALTER TABLE public.process_log_snapshots ENABLE ROW LEVEL SECURITY;

-- Acceso público (mismo modelo que emission_processes — dashboard protegido por PasswordGate)
CREATE POLICY "Snapshots públicamente visibles"
  ON public.process_log_snapshots FOR SELECT USING (true);

CREATE POLICY "Snapshots públicamente insertables"
  ON public.process_log_snapshots FOR INSERT WITH CHECK (true);

CREATE POLICY "Snapshots públicamente eliminables"
  ON public.process_log_snapshots FOR DELETE USING (true);

-- Función trigger: cuando se inserta un snapshot, mantener solo los últimos 3 por process_id
CREATE OR REPLACE FUNCTION public.rotate_log_snapshots()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.process_log_snapshots
  WHERE process_id = NEW.process_id
    AND id NOT IN (
      SELECT id FROM public.process_log_snapshots
      WHERE process_id = NEW.process_id
      ORDER BY created_at DESC
      LIMIT 3
    );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rotate_log_snapshots
  AFTER INSERT ON public.process_log_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.rotate_log_snapshots();
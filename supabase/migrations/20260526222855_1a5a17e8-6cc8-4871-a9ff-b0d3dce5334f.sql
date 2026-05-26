CREATE TABLE public.pi5_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL CHECK (target IN ('teletica','foxmas','fox')),
  command text NOT NULL CHECK (command IN ('refresh')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by text
);

CREATE INDEX idx_pi5_commands_pending
  ON public.pi5_commands(target, created_at)
  WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pi5_commands TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pi5_commands TO authenticated;
GRANT ALL ON public.pi5_commands TO service_role;

ALTER TABLE public.pi5_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lectura pública de comandos Pi5"
  ON public.pi5_commands FOR SELECT USING (true);

CREATE POLICY "Inserción pública de comandos Pi5"
  ON public.pi5_commands FOR INSERT WITH CHECK (true);

CREATE POLICY "Actualización pública de comandos Pi5"
  ON public.pi5_commands FOR UPDATE USING (true);

CREATE POLICY "Eliminación pública de comandos Pi5"
  ON public.pi5_commands FOR DELETE USING (true);
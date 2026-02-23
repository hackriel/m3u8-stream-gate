
-- Expand ID constraint to support 9 processes (0-8)
ALTER TABLE public.emission_processes DROP CONSTRAINT emission_processes_id_check;
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_id_check CHECK (id >= 0 AND id <= 8);

-- Insert missing rows (4-8)
INSERT INTO public.emission_processes (id) VALUES (4), (5), (6), (7), (8)
ON CONFLICT (id) DO NOTHING;

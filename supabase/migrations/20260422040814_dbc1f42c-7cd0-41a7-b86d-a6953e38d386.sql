ALTER TABLE public.emission_processes
  ADD COLUMN IF NOT EXISTS always_on boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_refresh_at timestamp with time zone;
ALTER TABLE public.emission_processes
  ADD COLUMN IF NOT EXISTS output_profile text NOT NULL DEFAULT 'normal';

ALTER TABLE public.emission_processes
  DROP CONSTRAINT IF EXISTS emission_processes_output_profile_check;

ALTER TABLE public.emission_processes
  ADD CONSTRAINT emission_processes_output_profile_check
  CHECK (output_profile IN ('normal', 'balanced', 'optimized'));
ALTER TABLE public.emission_processes
  DROP CONSTRAINT IF EXISTS emission_processes_output_profile_check;

ALTER TABLE public.emission_processes
  ADD CONSTRAINT emission_processes_output_profile_check
  CHECK (output_profile = ANY (ARRAY['normal'::text, 'balanced'::text, 'optimized'::text, 'passthrough'::text]));

UPDATE public.emission_processes
SET output_profile = 'passthrough',
    updated_at = now()
WHERE id = 22
  AND output_profile <> 'passthrough';
UPDATE public.emission_processes SET output_profile = 'normal' WHERE output_profile = 'sd480';
UPDATE public.emission_processes SET output_profile = 'normalpro' WHERE output_profile = 'mid576';
ALTER TABLE public.emission_processes DROP CONSTRAINT emission_processes_output_profile_check;
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_output_profile_check CHECK (output_profile IN ('passthrough', 'highquality', 'hd720', 'normal', 'normalpro'));
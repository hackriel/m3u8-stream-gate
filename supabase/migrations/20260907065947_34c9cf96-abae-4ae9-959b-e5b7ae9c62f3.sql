ALTER TABLE public.emission_processes DROP CONSTRAINT IF EXISTS emission_processes_output_profile_check;
UPDATE public.emission_processes SET output_profile = CASE output_profile
  WHEN 'sportspro' THEN 'hd720'
  WHEN 'sports1800' THEN 'hd720'
  WHEN 'sharp1800' THEN 'mid576'
  WHEN 'balanced' THEN 'mid576'
  WHEN 'eco1100' THEN 'sd480'
  WHEN 'optimized' THEN 'sd480'
  WHEN 'sports1500' THEN 'sd480'
  ELSE output_profile END
WHERE output_profile IN ('sportspro','sports1800','sharp1800','balanced','eco1100','optimized','sports1500');
ALTER TABLE public.emission_processes ADD CONSTRAINT emission_processes_output_profile_check
  CHECK (output_profile IN ('passthrough','highquality','hd720','normal','mid576','sd480'));
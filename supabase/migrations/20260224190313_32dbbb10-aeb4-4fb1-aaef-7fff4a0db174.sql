
CREATE OR REPLACE FUNCTION public.increment_recovery_count(process_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.emission_processes
  SET recovery_count = recovery_count + 1
  WHERE id = process_id;
END;
$function$;

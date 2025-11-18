-- Crear funciones para incrementar los timers
CREATE OR REPLACE FUNCTION public.increment_active_time(process_id INTEGER)
RETURNS VOID AS $$
BEGIN
  UPDATE public.emission_processes
  SET active_time = active_time + 1,
      is_active = true
  WHERE id = process_id AND is_emitting = true AND emit_status = 'running';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.increment_down_time(process_id INTEGER)
RETURNS VOID AS $$
BEGIN
  UPDATE public.emission_processes
  SET down_time = down_time + 1,
      is_active = false
  WHERE id = process_id AND is_emitting = true AND emit_status = 'error';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
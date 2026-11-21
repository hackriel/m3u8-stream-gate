DO $$ DECLARE r record; BEGIN FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='pi5_commands' LOOP EXECUTE format('DROP POLICY %I ON public.pi5_commands', r.policyname); END LOOP; END $$;
REVOKE ALL ON public.pi5_commands FROM anon, authenticated;
COMMENT ON TABLE public.pi5_commands IS 'DEPRECATED: Raspberry Pi bridge no longer used';
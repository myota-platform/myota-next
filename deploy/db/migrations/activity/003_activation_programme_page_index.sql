CREATE INDEX activity_activation_programme_started_idx
  ON public.activity_activation USING btree (programme_slug, started_at DESC);

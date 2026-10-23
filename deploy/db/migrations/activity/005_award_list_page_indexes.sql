CREATE INDEX activity_asset_created_idx
  ON public.activity_asset USING btree (created_at, id);
CREATE INDEX activity_asset_object_lookup_idx
  ON public.activity_asset USING btree (kind, object_key, created_at, id);
CREATE INDEX activity_award_issuance_created_idx
  ON public.activity_award_issuance USING btree (created_at DESC, id DESC);

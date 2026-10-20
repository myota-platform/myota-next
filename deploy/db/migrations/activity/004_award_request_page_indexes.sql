CREATE INDEX activity_award_request_created_idx
  ON public.activity_award_request USING btree (requested_at DESC, id DESC);
CREATE INDEX activity_award_request_subject_created_idx
  ON public.activity_award_request USING btree (subject_id, requested_at DESC, id DESC);

CREATE INDEX activity_notification_recipient_created_idx
  ON public.activity_notification USING btree (recipient_id, created_at DESC, id DESC);

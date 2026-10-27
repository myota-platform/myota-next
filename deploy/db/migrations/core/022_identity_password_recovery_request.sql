CREATE TABLE IF NOT EXISTS public.identity_password_recovery_request (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  CONSTRAINT identity_password_recovery_request_expiry
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS identity_password_recovery_request_account_idx
  ON public.identity_password_recovery_request(account_id, created_at DESC);

ALTER TABLE public.account_recovery_token
  ADD COLUMN IF NOT EXISTS request_id uuid
    REFERENCES public.identity_password_recovery_request(id) ON DELETE CASCADE;

UPDATE public.account_recovery_token
   SET used_at = clock_timestamp()
 WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS account_recovery_token_request_idx
  ON public.account_recovery_token(request_id, expires_at DESC);

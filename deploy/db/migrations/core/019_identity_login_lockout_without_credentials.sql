-- Accounts without a password still accumulate failed login attempts in the
-- credential row, matching the Python implementation's account lockout state.
ALTER TABLE public.account_credential
  ALTER COLUMN password_hash DROP NOT NULL,
  ALTER COLUMN password_changed_at DROP NOT NULL,
  ADD CONSTRAINT account_credential_password_fields_pair_check
    CHECK ((password_hash IS NULL) = (password_changed_at IS NULL));

-- The Python handler rejects empty OIDC fields but preserves non-empty values,
-- including strings containing only whitespace. Match that behavior here.
ALTER TABLE public.identity_oidc_provider_mapping
  DROP CONSTRAINT IF EXISTS identity_oidc_programme_slug_nonempty,
  DROP CONSTRAINT IF EXISTS identity_oidc_issuer_nonempty,
  DROP CONSTRAINT IF EXISTS identity_oidc_client_id_nonempty;

ALTER TABLE public.identity_oidc_provider_mapping
  ADD CONSTRAINT identity_oidc_programme_slug_nonempty
    CHECK (length(programme_slug) > 0),
  ADD CONSTRAINT identity_oidc_issuer_nonempty
    CHECK (length(issuer) > 0),
  ADD CONSTRAINT identity_oidc_client_id_nonempty
    CHECK (length(client_id) > 0);

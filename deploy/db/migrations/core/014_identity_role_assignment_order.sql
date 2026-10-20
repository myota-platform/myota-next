BEGIN;

CREATE SEQUENCE public.account_role_assignment_order_seq AS bigint;

ALTER TABLE public.account_role
  ADD COLUMN assignment_order bigint;

WITH ordered_roles AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_id
           ORDER BY created_at, id
         ) AS assignment_order
    FROM public.account_role
)
UPDATE public.account_role AS role
   SET assignment_order = ordered_roles.assignment_order
  FROM ordered_roles
 WHERE role.id = ordered_roles.id;

SELECT setval(
  'public.account_role_assignment_order_seq',
  (SELECT coalesce(max(assignment_order), 0) + 1 FROM public.account_role),
  false
);

ALTER SEQUENCE public.account_role_assignment_order_seq
  OWNED BY public.account_role.assignment_order;

ALTER TABLE public.account_role
  ALTER COLUMN assignment_order
    SET DEFAULT nextval('public.account_role_assignment_order_seq'),
  ALTER COLUMN assignment_order SET NOT NULL;

CREATE INDEX account_role_account_order_idx
  ON public.account_role USING btree (account_id, assignment_order)
  WHERE valid_to IS NULL;

COMMIT;

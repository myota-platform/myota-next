UPDATE public.identity_role_definition
   SET scopes = array_remove(scopes, 'operations.read'),
       updated_at = now()
 WHERE 'operations.read' = ANY(scopes);

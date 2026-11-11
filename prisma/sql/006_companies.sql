-- Bloque Empresas: incremento revisable sobre 000–005. NO aplicar en DEV existente sin autorización.
-- Contexto A, runtime EXECUTE-only; plataforma NO obtiene acceso comercial ni credenciales.
BEGIN;
CREATE ROLE wc_platform_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_platform_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_platform_owner REVOKE ALL ON TABLES FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private, app_api TO wc_platform_owner;
GRANT CREATE ON SCHEMA app_api TO wc_platform_owner, wc_tenant_owner;
GRANT SELECT, INSERT ON app_private.company, app_private.branch TO wc_platform_owner;
GRANT UPDATE (trade_name,legal_name,tax_address,contact_email,contact_phone,status) ON app_private.company TO wc_platform_owner;
GRANT UPDATE (name,address,email,phone) ON app_private.branch TO wc_platform_owner;
GRANT SELECT (id,user_id,absolute_expires_at,revoked_at) ON app_private.app_session TO wc_platform_owner;
GRANT SELECT (user_id) ON app_private.platform_admin TO wc_platform_owner;
GRANT UPDATE (id) ON app_private.app_session TO wc_platform_owner;
GRANT UPDATE (user_id) ON app_private.platform_admin TO wc_platform_owner;
GRANT SELECT ON app_private.branch TO wc_tenant_owner;
CREATE POLICY platform_read_company ON app_private.company FOR SELECT TO wc_platform_owner USING (true);
CREATE POLICY platform_insert_company ON app_private.company FOR INSERT TO wc_platform_owner WITH CHECK (true);
CREATE POLICY platform_update_company ON app_private.company FOR UPDATE TO wc_platform_owner USING (true) WITH CHECK (true);
CREATE POLICY platform_read_branch ON app_private.branch FOR SELECT TO wc_platform_owner USING (true);
CREATE POLICY platform_insert_branch ON app_private.branch FOR INSERT TO wc_platform_owner WITH CHECK (true);
CREATE POLICY platform_update_branch ON app_private.branch FOR UPDATE TO wc_platform_owner USING (true) WITH CHECK (true);
CREATE POLICY platform_read_session ON app_private.app_session FOR SELECT TO wc_platform_owner USING (true);
CREATE POLICY platform_lock_session ON app_private.app_session FOR UPDATE TO wc_platform_owner USING (true) WITH CHECK (false);
CREATE POLICY platform_read_admin ON app_private.platform_admin FOR SELECT TO wc_platform_owner USING (true);
CREATE POLICY platform_lock_admin ON app_private.platform_admin FOR UPDATE TO wc_platform_owner USING (true) WITH CHECK (false);
CREATE POLICY tenant_read_branch ON app_private.branch FOR SELECT TO wc_tenant_owner USING (true);
GRANT EXECUTE ON FUNCTION app_api._context_ok(text,uuid,uuid,uuid), app_api._utc(timestamptz) TO wc_platform_owner;

SET LOCAL ROLE wc_platform_owner;
-- Helpers son INVOKER, sin EXECUTE runtime/PUBLIC y sin SQL dinámico.
CREATE FUNCTION app_api._platform_precheck(uid uuid, sid uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record;
BEGIN
  -- Reject non-platform before reading/locking any target resource. This preliminary
  -- read is NOT final authorization: revalidate with locks after Company below.
  SELECT id,user_id,absolute_expires_at,revoked_at INTO s FROM app_private.app_session WHERE id=sid;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM uid THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN 'SESSION_REVOKED'; END IF;
  IF s.absolute_expires_at <= pg_catalog.clock_timestamp() THEN RETURN 'SESSION_EXPIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_admin WHERE user_id=uid) THEN RETURN 'FORBIDDEN'; END IF;
  RETURN 'OK';
END $$;
CREATE FUNCTION app_api._platform_authorize(uid uuid, sid uuid) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record;
BEGIN
  SELECT id,user_id,absolute_expires_at,revoked_at INTO s FROM app_private.app_session WHERE id=sid FOR SHARE;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM uid THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN 'SESSION_REVOKED'; END IF;
  IF s.absolute_expires_at <= pg_catalog.clock_timestamp() THEN RETURN 'SESSION_EXPIRED'; END IF;
  PERFORM user_id FROM app_private.platform_admin WHERE user_id=uid FOR SHARE;
  IF NOT FOUND THEN RETURN 'FORBIDDEN'; END IF;
  RETURN 'OK';
END $$;
CREATE FUNCTION app_api._company_full(c app_private.company) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('representation','FULL','id',c.id,'tradeName',c.trade_name,
    'legalName',c.legal_name,'ruc',c.ruc,'taxAddress',c.tax_address,'contactEmail',c.contact_email,
    'contactPhone',c.contact_phone,'status',c.status,'createdAt',app_api._utc(c.created_at),'updatedAt',app_api._utc(c.updated_at))
$$;
CREATE FUNCTION app_api._branch_full(b app_private.branch) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('id',b.id,'companyId',b.company_id,'name',b.name,'address',b.address,
    'email',b.email,'phone',b.phone,'createdAt',app_api._utc(b.created_at),'updatedAt',app_api._utc(b.updated_at))
$$;
CREATE FUNCTION app_api.platform_companies(uid uuid, sid uuid, after_created timestamptz, after_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; v jsonb;
BEGIN
  IF NOT app_api._context_ok('platform_companies',uid,sid,NULL) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  code := app_api._platform_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  IF (after_created IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'invalid position'; END IF;
  WITH page AS MATERIALIZED (
    SELECT c.* FROM app_private.company c WHERE after_id IS NULL OR (c.created_at,c.id) > (after_created,after_id)
    ORDER BY c.created_at,c.id LIMIT 20
  ), last_row AS (SELECT created_at,id FROM page ORDER BY created_at DESC,id DESC LIMIT 1)
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(app_api._company_full(p) ORDER BY p.created_at,p.id) FROM page p),'[]'::jsonb),
    'lastPosition',(SELECT jsonb_build_object('createdAt',app_api._utc(l.created_at),'id',l.id) FROM last_row l),
    'hasMore',EXISTS(SELECT 1 FROM app_private.company c WHERE (c.created_at,c.id) > (SELECT created_at,id FROM last_row))) INTO v;
  RETURN jsonb_build_object('code','OK','value',v);
END $$;
CREATE FUNCTION app_api.platform_create_company(uid uuid, sid uuid, cid uuid, data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; c app_private.company%ROWTYPE; constraint_name text;
BEGIN
  IF NOT app_api._context_ok('platform_create_company',uid,sid,NULL) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  code := app_api._platform_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  IF data IS NULL OR jsonb_typeof(data) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(data) k
    WHERE k NOT IN ('tradeName','legalName','ruc','taxAddress','contactEmail','contactPhone')) THEN RAISE EXCEPTION 'invalid fields'; END IF;
  BEGIN
    INSERT INTO app_private.company(id,trade_name,legal_name,ruc,tax_address,contact_email,contact_phone)
      VALUES(cid,data->>'tradeName',data->>'legalName',data->>'ruc',data->>'taxAddress',data->>'contactEmail',data->>'contactPhone') RETURNING * INTO c;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS constraint_name = CONSTRAINT_NAME;
    IF constraint_name='company_ruc_key' THEN RETURN jsonb_build_object('code','RUC_ALREADY_EXISTS'); END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('code','OK','value',app_api._company_full(c));
END $$;
CREATE FUNCTION app_api.platform_company(uid uuid, sid uuid, cid uuid, action text, data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; c app_private.company%ROWTYPE; present boolean; target app_private.company_status;
BEGIN
  IF action IS NULL OR action NOT IN ('read','patch','suspend','reactivate') THEN RAISE EXCEPTION 'invalid action'; END IF;
  IF NOT app_api._context_ok('platform_company_'||action,uid,sid,cid) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  code := app_api._platform_precheck(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  -- Company before Session and privilege. Do not disclose resource existence before authorization.
  IF action='read' THEN SELECT * INTO c FROM app_private.company WHERE id=cid FOR SHARE;
  ELSE SELECT * INTO c FROM app_private.company WHERE id=cid FOR UPDATE; END IF;
  present := FOUND;
  code := app_api._platform_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  IF NOT present THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  IF action='patch' THEN
    IF data IS NULL OR jsonb_typeof(data) <> 'object' OR data='{}'::jsonb OR EXISTS (SELECT 1 FROM jsonb_object_keys(data) k
      WHERE k NOT IN ('tradeName','legalName','taxAddress','contactEmail','contactPhone')) THEN RAISE EXCEPTION 'invalid fields'; END IF;
    UPDATE app_private.company SET trade_name=CASE WHEN data ? 'tradeName' THEN data->>'tradeName' ELSE trade_name END,
      legal_name=CASE WHEN data ? 'legalName' THEN data->>'legalName' ELSE legal_name END,
      tax_address=CASE WHEN data ? 'taxAddress' THEN data->>'taxAddress' ELSE tax_address END,
      contact_email=CASE WHEN data ? 'contactEmail' THEN data->>'contactEmail' ELSE contact_email END,
      contact_phone=CASE WHEN data ? 'contactPhone' THEN data->>'contactPhone' ELSE contact_phone END WHERE id=cid RETURNING * INTO c;
  ELSIF action IN ('suspend','reactivate') THEN
    target := CASE WHEN action='suspend' THEN 'SUSPENDED'::app_private.company_status
      WHEN c.status <> 'SUSPENDED' THEN c.status
      WHEN c.activated_at IS NULL THEN 'PENDING_ACTIVATION'::app_private.company_status ELSE 'ACTIVE'::app_private.company_status END;
    -- Repeating a transition does not mutate timestamps or create side effects.
    IF c.status <> target THEN UPDATE app_private.company SET status=target WHERE id=cid RETURNING * INTO c; END IF;
  END IF;
  RETURN jsonb_build_object('code','OK','value',app_api._company_full(c));
END $$;
CREATE FUNCTION app_api._branches_page(cid uuid, after_created timestamptz, after_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  WITH page AS MATERIALIZED (
    SELECT b.* FROM app_private.branch b WHERE b.company_id=cid AND (after_id IS NULL OR (b.created_at,b.id) > (after_created,after_id))
    ORDER BY b.created_at,b.id LIMIT 20
  ), last_row AS (SELECT created_at,id FROM page ORDER BY created_at DESC,id DESC LIMIT 1)
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(app_api._branch_full(p) ORDER BY p.created_at,p.id) FROM page p),'[]'::jsonb),
    'lastPosition',(SELECT jsonb_build_object('createdAt',app_api._utc(l.created_at),'id',l.id) FROM last_row l),
    'hasMore',EXISTS(SELECT 1 FROM app_private.branch b WHERE b.company_id=cid AND (b.created_at,b.id) > (SELECT created_at,id FROM last_row)))
$$;
CREATE FUNCTION app_api.platform_branches(uid uuid, sid uuid, cid uuid, after_created timestamptz, after_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; present boolean;
BEGIN
  IF NOT app_api._context_ok('platform_branches',uid,sid,cid) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  code := app_api._platform_precheck(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  PERFORM id FROM app_private.company WHERE id=cid FOR SHARE; present := FOUND;
  code := app_api._platform_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  IF NOT present THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  IF (after_created IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'invalid position'; END IF;
  RETURN jsonb_build_object('code','OK','value',app_api._branches_page(cid,after_created,after_id));
END $$;
CREATE FUNCTION app_api.platform_branch(uid uuid, sid uuid, cid uuid, bid uuid, action text, data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; present boolean; b app_private.branch%ROWTYPE;
BEGIN
  IF action IS NULL OR action NOT IN ('create','patch') THEN RAISE EXCEPTION 'invalid action'; END IF;
  IF NOT app_api._context_ok('platform_branch_'||action,uid,sid,cid) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  code := app_api._platform_precheck(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  PERFORM id FROM app_private.company WHERE id=cid FOR SHARE; present := FOUND;
  code := app_api._platform_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN jsonb_build_object('code',code); END IF;
  IF NOT present THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  IF data IS NULL OR jsonb_typeof(data) <> 'object' OR data='{}'::jsonb OR EXISTS (SELECT 1 FROM jsonb_object_keys(data) k
    WHERE k NOT IN ('name','address','email','phone')) THEN RAISE EXCEPTION 'invalid fields'; END IF;
  IF action='create' THEN
    INSERT INTO app_private.branch(id,company_id,name,address,email,phone)
      VALUES(bid,cid,data->>'name',data->>'address',data->>'email',data->>'phone') RETURNING * INTO b;
  ELSE
    SELECT * INTO b FROM app_private.branch WHERE id=bid AND company_id=cid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
    UPDATE app_private.branch SET name=CASE WHEN data ? 'name' THEN data->>'name' ELSE name END,
      address=CASE WHEN data ? 'address' THEN data->>'address' ELSE address END,
      email=CASE WHEN data ? 'email' THEN data->>'email' ELSE email END,
      phone=CASE WHEN data ? 'phone' THEN data->>'phone' ELSE phone END WHERE id=bid AND company_id=cid RETURNING * INTO b;
  END IF;
  RETURN jsonb_build_object('code','OK','value',app_api._branch_full(b));
END $$;
REVOKE ALL ON FUNCTION app_api._platform_precheck(uuid,uuid), app_api._platform_authorize(uuid,uuid), app_api._company_full(app_private.company),
  app_api._branch_full(app_private.branch), app_api._branches_page(uuid,timestamptz,uuid),
  app_api.platform_companies(uuid,uuid,timestamptz,uuid), app_api.platform_create_company(uuid,uuid,uuid,jsonb),
  app_api.platform_company(uuid,uuid,uuid,text,jsonb), app_api.platform_branches(uuid,uuid,uuid,timestamptz,uuid),
  app_api.platform_branch(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api.platform_companies(uuid,uuid,timestamptz,uuid), app_api.platform_create_company(uuid,uuid,uuid,jsonb),
  app_api.platform_company(uuid,uuid,uuid,text,jsonb), app_api.platform_branches(uuid,uuid,uuid,timestamptz,uuid),
  app_api.platform_branch(uuid,uuid,uuid,uuid,text,jsonb) TO wc_platform;
GRANT EXECUTE ON FUNCTION app_api._branch_full(app_private.branch), app_api._branches_page(uuid,timestamptz,uuid) TO wc_tenant_owner;
RESET ROLE;

SET LOCAL ROLE wc_tenant_owner;
CREATE FUNCTION app_api.tenant_branches(uid uuid, sid uuid, cid uuid, after_created timestamptz, after_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; s record; m record; present boolean;
BEGIN
  IF NOT app_api._context_ok('tenant_branches',uid,sid,cid) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  SELECT id,status INTO c FROM app_private.company WHERE id=cid FOR SHARE; present := FOUND;
  SELECT id,user_id,revoked_at,absolute_expires_at INTO s FROM app_private.app_session WHERE id=sid FOR SHARE;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM uid THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('code','SESSION_REVOKED'); END IF;
  IF s.absolute_expires_at <= pg_catalog.clock_timestamp() THEN RETURN jsonb_build_object('code','SESSION_EXPIRED'); END IF;
  IF NOT present THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  SELECT id,role INTO m FROM app_private.membership WHERE user_id=uid AND company_id=cid FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  IF m.role <> 'COMPANY_ADMIN' THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  IF c.status='SUSPENDED' THEN RETURN jsonb_build_object('code','COMPANY_SUSPENDED'); END IF;
  IF c.status='PENDING_ACTIVATION' THEN RETURN jsonb_build_object('code','COMPANY_PENDING_ACTIVATION'); END IF;
  IF (after_created IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'invalid position'; END IF;
  RETURN jsonb_build_object('code','OK','value',app_api._branches_page(cid,after_created,after_id));
END $$;
REVOKE ALL ON FUNCTION app_api.tenant_branches(uuid,uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api.tenant_branches(uuid,uuid,uuid,timestamptz,uuid) TO wc_tenant;
RESET ROLE;
REVOKE CREATE ON SCHEMA app_api FROM wc_platform_owner, wc_tenant_owner;
-- No cambios a LOGIN/password, modelos base, superusuarios ni grants runtime de tablas.
COMMIT;

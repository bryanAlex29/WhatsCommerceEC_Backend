-- SUBFASE 1.4: REVISABLE / NO APLICADO. PostgreSQL 17. Requiere 000–003.
-- Aplicacion futura exclusivamente administrativa y autorizada, NO runtime.
-- No habilita LOGIN/password, bootstrap, membresias, invitaciones ni CRUD.
-- Contexto A: backend confiable; GUC no es asercion criptografica de identidad.
BEGIN;

CREATE ROLE wc_identity_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE wc_tenant_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_identity_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_tenant_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_identity_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_tenant_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_identity_owner REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_tenant_owner REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_identity_owner REVOKE ALL ON SCHEMAS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_tenant_owner REVOKE ALL ON SCHEMAS FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private, app_api TO wc_identity_owner, wc_tenant_owner;
-- CREATE solo durante esta transaccion de definicion; revocado antes de COMMIT.
GRANT CREATE ON SCHEMA app_api TO wc_identity_owner, wc_tenant_owner;

-- Solo owners internos, nunca runtime. No recursion RLS ni acceso a tablas futuras.
GRANT SELECT (id,email_normalized,password_hash) ON app_private.app_user TO wc_identity_owner;
GRANT SELECT (user_id) ON app_private.platform_admin TO wc_identity_owner;
GRANT SELECT ON app_private.app_session, app_private.refresh_token_history TO wc_identity_owner;
GRANT SELECT (id,user_id,company_id,role,created_at) ON app_private.membership TO wc_identity_owner;
GRANT SELECT (id, trade_name, status) ON app_private.company TO wc_identity_owner;
GRANT INSERT ON app_private.app_session, app_private.refresh_token_history TO wc_identity_owner;
GRANT UPDATE (revoked_at, revocation_reason, current_refresh_generation) ON app_private.app_session TO wc_identity_owner;
GRANT UPDATE (replaced_at) ON app_private.refresh_token_history TO wc_identity_owner;
-- SELECT FOR SHARE requiere privilegio UPDATE sobre al menos una columna.
-- La politica WITH CHECK false impide mutar User/Company/Membership por este grant.
GRANT UPDATE (id) ON app_private.app_user TO wc_identity_owner;
GRANT SELECT ON app_private.company TO wc_tenant_owner;
GRANT SELECT (id,user_id,absolute_expires_at,revoked_at) ON app_private.app_session TO wc_tenant_owner;
GRANT SELECT (id,user_id,company_id,role) ON app_private.membership TO wc_tenant_owner;
GRANT UPDATE (id) ON app_private.company, app_private.app_session, app_private.membership TO wc_tenant_owner;

CREATE POLICY identity_read_user ON app_private.app_user FOR SELECT TO wc_identity_owner USING (true);
CREATE POLICY identity_lock_user ON app_private.app_user FOR UPDATE TO wc_identity_owner USING (true) WITH CHECK (false);
CREATE POLICY identity_read_admin ON app_private.platform_admin FOR SELECT TO wc_identity_owner USING (true);
CREATE POLICY identity_read_session ON app_private.app_session FOR SELECT TO wc_identity_owner USING (true);
CREATE POLICY identity_insert_session ON app_private.app_session FOR INSERT TO wc_identity_owner WITH CHECK (true);
CREATE POLICY identity_update_session ON app_private.app_session FOR UPDATE TO wc_identity_owner USING (true) WITH CHECK (true);
CREATE POLICY identity_read_history ON app_private.refresh_token_history FOR SELECT TO wc_identity_owner USING (true);
CREATE POLICY identity_insert_history ON app_private.refresh_token_history FOR INSERT TO wc_identity_owner WITH CHECK (true);
CREATE POLICY identity_replace_history ON app_private.refresh_token_history FOR UPDATE TO wc_identity_owner USING (true) WITH CHECK (true);
CREATE POLICY identity_read_membership ON app_private.membership FOR SELECT TO wc_identity_owner USING (true);
CREATE POLICY identity_read_company ON app_private.company FOR SELECT TO wc_identity_owner USING (true);
CREATE POLICY tenant_read_company ON app_private.company FOR SELECT TO wc_tenant_owner USING (true);
CREATE POLICY tenant_lock_company ON app_private.company FOR UPDATE TO wc_tenant_owner USING (true) WITH CHECK (false);
CREATE POLICY tenant_read_session ON app_private.app_session FOR SELECT TO wc_tenant_owner USING (true);
CREATE POLICY tenant_lock_session ON app_private.app_session FOR UPDATE TO wc_tenant_owner USING (true) WITH CHECK (false);
CREATE POLICY tenant_read_membership ON app_private.membership FOR SELECT TO wc_tenant_owner USING (true);
CREATE POLICY tenant_lock_membership ON app_private.membership FOR UPDATE TO wc_tenant_owner USING (true) WITH CHECK (false);
-- Las restrictivas deny_runtime_all de 003 siguen intactas, NO se aplican a owners.

SET LOCAL ROLE wc_identity_owner;
CREATE FUNCTION app_api._context_ok(op text, uid uuid, sid uuid, cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    pg_catalog.current_setting('wc.tx_marker', true) = pg_catalog.txid_current()::text
    AND pg_catalog.current_setting('wc.operation', true) = op
    AND pg_catalog.current_setting('wc.user_id', true) = coalesce(uid::text, '')
    AND pg_catalog.current_setting('wc.session_id', true) = coalesce(sid::text, '')
    AND pg_catalog.current_setting('wc.company_id', true) = coalesce(cid::text, ''), false)
$$;
CREATE FUNCTION app_api._utc(t timestamptz) RETURNS text
LANGUAGE sql STABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION app_api._identity_user(uid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('id', u.id, 'email', u.email_normalized, 'platformRole',
    CASE WHEN EXISTS (SELECT 1 FROM app_private.platform_admin p WHERE p.user_id = u.id)
      THEN 'PLATFORM_ADMIN'::text ELSE NULL::text END)
  FROM app_private.app_user u WHERE u.id = uid
$$;
CREATE FUNCTION app_api._identity_authorize(uid uuid, sid uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s app_private.app_session%ROWTYPE;
BEGIN
  SELECT * INTO s FROM app_private.app_session WHERE id = sid FOR SHARE;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM uid THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN 'SESSION_REVOKED'; END IF;
  IF s.absolute_expires_at <= pg_catalog.clock_timestamp() THEN RETURN 'SESSION_EXPIRED'; END IF;
  RETURN 'OK';
END $$;

CREATE FUNCTION app_api.identity_credential(email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT app_api._context_ok('credential', NULL, NULL, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  SELECT pg_catalog.jsonb_build_object('userId', id, 'passwordHash', password_hash) INTO v
    FROM app_private.app_user WHERE email_normalized = email;
  RETURN pg_catalog.jsonb_build_object('code','OK','value',v);
END $$;

CREATE FUNCTION app_api.identity_create_session(uid uuid, sid uuid, hid uuid, refresh_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE issued timestamptz(3); expires timestamptz(3); u jsonb;
BEGIN
  IF NOT app_api._context_ok('create_session', uid, sid, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF refresh_hash IS NULL OR refresh_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid hash'; END IF;
  -- User antes de Session; el FK diferible de 002 resuelve el ciclo inicial.
  PERFORM 1 FROM app_private.app_user WHERE id = uid FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  issued := pg_catalog.clock_timestamp(); expires := issued + interval '168 hours';
  INSERT INTO app_private.app_session(id,user_id,created_at,absolute_expires_at,current_refresh_generation)
    VALUES(sid,uid,issued,expires,1);
  INSERT INTO app_private.refresh_token_history(id,session_id,generation,token_hash,issued_at)
    VALUES(hid,sid,1,pg_catalog.decode(refresh_hash,'hex'),issued);
  u := app_api._identity_user(uid);
  RETURN pg_catalog.jsonb_build_object('code','OK','value',pg_catalog.jsonb_build_object(
    'principal',pg_catalog.jsonb_build_object('userId',uid,'sessionId',sid), 'user',u,
    'absoluteExpiresAt',app_api._utc(expires)));
END $$;

CREATE FUNCTION app_api.identity_refresh_session(refresh_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE sid uuid;
BEGIN
  IF NOT app_api._context_ok('refresh_lookup', NULL, NULL, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF refresh_hash IS NULL OR refresh_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid hash'; END IF;
  -- Solo llave interna de cuota. No autoriza ni confirma vigencia.
  SELECT session_id INTO sid FROM app_private.refresh_token_history WHERE token_hash = pg_catalog.decode(refresh_hash,'hex');
  RETURN pg_catalog.jsonb_build_object('code','OK','value',sid);
END $$;

CREATE FUNCTION app_api.identity_rotate(refresh_hash text, replacement_hash text, hid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE sid uuid; s app_private.app_session%ROWTYPE; h app_private.refresh_token_history%ROWTYPE;
  issued timestamptz(3); next_generation integer;
BEGIN
  IF NOT app_api._context_ok('rotate', NULL, NULL, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','INVALID_REFRESH_TOKEN'); END IF;
  IF refresh_hash IS NULL OR replacement_hash IS NULL OR refresh_hash = replacement_hash
    OR refresh_hash COLLATE "C" !~ '^[0-9a-f]{64}$' OR replacement_hash COLLATE "C" !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid hash'; END IF;
  SELECT session_id INTO sid FROM app_private.refresh_token_history WHERE token_hash = pg_catalog.decode(refresh_hash,'hex');
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('code','INVALID_REFRESH_TOKEN'); END IF;
  SELECT * INTO s FROM app_private.app_session WHERE id = sid FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('code','INVALID_REFRESH_TOKEN'); END IF;
  -- Statement nuevo tras esperar lock: READ COMMITTED ve la generacion confirmada.
  SELECT * INTO h FROM app_private.refresh_token_history
    WHERE session_id = sid AND token_hash = pg_catalog.decode(refresh_hash,'hex');
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('code','INVALID_REFRESH_TOKEN'); END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('code','SESSION_REVOKED'); END IF;
  issued := pg_catalog.clock_timestamp();
  IF s.absolute_expires_at <= issued THEN RETURN pg_catalog.jsonb_build_object('code','SESSION_EXPIRED'); END IF;
  IF h.generation <> s.current_refresh_generation OR h.replaced_at IS NOT NULL THEN
    UPDATE app_private.app_session SET revoked_at = issued, revocation_reason = 'REFRESH_REUSE' WHERE id = sid;
    -- NO RAISE: el adaptador confirma este cambio antes de convertir resultado en HTTP error.
    RETURN pg_catalog.jsonb_build_object('code','SESSION_REVOKED');
  END IF;
  next_generation := s.current_refresh_generation + 1;
  UPDATE app_private.refresh_token_history SET replaced_at = issued WHERE id = h.id;
  INSERT INTO app_private.refresh_token_history(id,session_id,generation,token_hash,issued_at)
    VALUES(hid,sid,next_generation,pg_catalog.decode(replacement_hash,'hex'),issued);
  UPDATE app_private.app_session SET current_refresh_generation = next_generation WHERE id = sid;
  RETURN pg_catalog.jsonb_build_object('code','OK','value',pg_catalog.jsonb_build_object(
    'principal',pg_catalog.jsonb_build_object('userId',s.user_id,'sessionId',s.id),
    'user',app_api._identity_user(s.user_id), 'absoluteExpiresAt',app_api._utc(s.absolute_expires_at)));
END $$;

CREATE FUNCTION app_api.identity_logout(refresh_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE sid uuid; s app_private.app_session%ROWTYPE;
BEGIN
  IF NOT app_api._context_ok('logout', NULL, NULL, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF refresh_hash IS NULL OR refresh_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid hash'; END IF;
  SELECT session_id INTO sid FROM app_private.refresh_token_history WHERE token_hash = pg_catalog.decode(refresh_hash,'hex');
  IF FOUND THEN
    SELECT * INTO s FROM app_private.app_session WHERE id = sid FOR UPDATE;
    IF FOUND AND s.revoked_at IS NULL AND EXISTS (SELECT 1 FROM app_private.refresh_token_history
      WHERE session_id = sid AND token_hash = pg_catalog.decode(refresh_hash,'hex')) THEN
      UPDATE app_private.app_session SET revoked_at = pg_catalog.clock_timestamp(), revocation_reason = 'LOGOUT' WHERE id = sid;
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('code','OK','value',NULL);
END $$;

CREATE FUNCTION app_api.identity_self(uid uuid, sid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; u jsonb;
BEGIN
  IF NOT app_api._context_ok('self', uid, sid, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  code := app_api._identity_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN pg_catalog.jsonb_build_object('code',code); END IF;
  u := app_api._identity_user(uid);
  IF u IS NULL THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  RETURN pg_catalog.jsonb_build_object('code','OK','value',u);
END $$;

CREATE FUNCTION app_api.identity_companies(uid uuid, sid uuid, after_created timestamptz, after_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE code text; v jsonb;
BEGIN
  IF NOT app_api._context_ok('companies', uid, sid, NULL) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF (after_created IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'invalid position'; END IF;
  code := app_api._identity_authorize(uid,sid);
  IF code <> 'OK' THEN RETURN pg_catalog.jsonb_build_object('code',code); END IF;
  -- Reautorizacion antes del LIMIT. Posicion sobre Membership, NO Company.
  WITH page AS MATERIALIZED (
    SELECT m.id, m.created_at, m.company_id, m.role, c.trade_name, c.status
      FROM app_private.membership m JOIN app_private.company c ON c.id = m.company_id
      WHERE m.user_id = uid AND (after_id IS NULL OR (m.created_at,m.id) > (after_created,after_id))
      ORDER BY m.created_at ASC,m.id ASC LIMIT 20
  ), last_row AS (SELECT id,created_at FROM page ORDER BY created_at DESC,id DESC LIMIT 1)
  SELECT pg_catalog.jsonb_build_object('items',coalesce((SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('companyId',p.company_id,'tradeName',p.trade_name,'status',p.status,'role',p.role)
      ORDER BY p.created_at,p.id) FROM page p),'[]'::jsonb),
    'lastPosition',(SELECT pg_catalog.jsonb_build_object('createdAt',app_api._utc(l.created_at),'id',l.id) FROM last_row l),
    'hasMore',EXISTS (SELECT 1 FROM app_private.membership m JOIN app_private.company c ON c.id = m.company_id
      WHERE m.user_id = uid AND (m.created_at,m.id) > (SELECT l.created_at,l.id FROM last_row l))) INTO v;
  RETURN pg_catalog.jsonb_build_object('code','OK','value',v);
END $$;

-- No EXECUTE implicito PUBLIC; helpers privados solo owners especializados.
REVOKE ALL ON FUNCTION app_api._context_ok(text,uuid,uuid,uuid), app_api._utc(timestamptz),
  app_api._identity_user(uuid), app_api._identity_authorize(uuid,uuid),
  app_api.identity_credential(text), app_api.identity_create_session(uuid,uuid,uuid,text),
  app_api.identity_refresh_session(text), app_api.identity_rotate(text,text,uuid),
  app_api.identity_logout(text), app_api.identity_self(uuid,uuid),
  app_api.identity_companies(uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api._context_ok(text,uuid,uuid,uuid), app_api._utc(timestamptz) TO wc_tenant_owner;
GRANT EXECUTE ON FUNCTION app_api.identity_credential(text), app_api.identity_create_session(uuid,uuid,uuid,text),
  app_api.identity_refresh_session(text), app_api.identity_rotate(text,text,uuid),
  app_api.identity_logout(text), app_api.identity_self(uuid,uuid),
  app_api.identity_companies(uuid,uuid,timestamptz,uuid) TO wc_identity;
RESET ROLE;

SET LOCAL ROLE wc_tenant_owner;
CREATE FUNCTION app_api.tenant_company(uid uuid, sid uuid, cid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c app_private.company%ROWTYPE; s record; company_exists boolean;
  m record; v jsonb;
BEGIN
  IF NOT app_api._context_ok('company', uid, sid, cid) THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  -- Frontera y orden: Company -> Session -> Membership. Lectura interna no es respuesta.
  SELECT * INTO c FROM app_private.company WHERE id = cid FOR SHARE;
  company_exists := FOUND;
  SELECT id,user_id,absolute_expires_at,revoked_at INTO s FROM app_private.app_session WHERE id = sid FOR SHARE;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM uid THEN RETURN pg_catalog.jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('code','SESSION_REVOKED'); END IF;
  IF s.absolute_expires_at <= pg_catalog.clock_timestamp() THEN RETURN pg_catalog.jsonb_build_object('code','SESSION_EXPIRED'); END IF;
  IF NOT company_exists THEN RETURN pg_catalog.jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  SELECT id,user_id,company_id,role INTO m FROM app_private.membership WHERE user_id = uid AND company_id = cid FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
  -- Solo despues de pertenencia vigente se revela estado empresarial.
  IF c.status = 'SUSPENDED' THEN RETURN pg_catalog.jsonb_build_object('code','COMPANY_SUSPENDED'); END IF;
  IF c.status = 'PENDING_ACTIVATION' THEN RETURN pg_catalog.jsonb_build_object('code','COMPANY_PENDING_ACTIVATION'); END IF;
  IF c.status <> 'ACTIVE' THEN RAISE EXCEPTION 'invalid status'; END IF;
  v := pg_catalog.jsonb_build_object('id',c.id,'tradeName',c.trade_name,'status',c.status);
  IF m.role = 'SELLER' THEN
    v := v || pg_catalog.jsonb_build_object('representation','BASIC');
  ELSIF m.role = 'COMPANY_ADMIN' THEN
    v := v || pg_catalog.jsonb_build_object('representation','FULL','legalName',c.legal_name,'ruc',c.ruc,
      'taxAddress',c.tax_address,'contactEmail',c.contact_email,'contactPhone',c.contact_phone,
      'createdAt',app_api._utc(c.created_at),'updatedAt',app_api._utc(c.updated_at));
  ELSE RAISE EXCEPTION 'invalid role'; END IF;
  RETURN pg_catalog.jsonb_build_object('code','OK','value',v);
END $$;
REVOKE ALL ON FUNCTION app_api.tenant_company(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api.tenant_company(uuid,uuid,uuid) TO wc_tenant;
RESET ROLE;

REVOKE CREATE ON SCHEMA app_api FROM wc_identity_owner, wc_tenant_owner;
-- Owners permanecen NOLOGIN, sin miembros, sin BYPASSRLS y sin ownership de tablas.
-- Runtime solo EXECUTE allowlist; defaults NOLOGIN de 000 sin alterar.
COMMIT;

-- Subfase1.5. Incremento revisable; requiere000–006. NO aplicado al DEV existente.
-- No LOGIN/password, registro público ni cambios a contratos/modelos base.
BEGIN;
CREATE ROLE wc_invitation_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE wc_invitation_delivery_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_invitation_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_invitation_delivery_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_invitation_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_invitation_delivery_owner REVOKE ALL ON TABLES FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private,app_api TO wc_invitation_owner,wc_invitation_delivery_owner;
GRANT CREATE ON SCHEMA app_api TO wc_invitation_owner,wc_invitation_delivery_owner;
GRANT SELECT (id,status,activated_at) ON app_private.company TO wc_invitation_owner;
GRANT UPDATE (status,activated_at) ON app_private.company TO wc_invitation_owner;
GRANT SELECT,INSERT,UPDATE ON app_private.invitation TO wc_invitation_owner;
GRANT SELECT,INSERT ON app_private.invitation_emission TO wc_invitation_owner;
GRANT SELECT,INSERT,UPDATE ON app_private.invitation_outbox TO wc_invitation_owner;
GRANT SELECT (id,email_normalized) ON app_private.app_user TO wc_invitation_owner;
GRANT INSERT ON app_private.app_user TO wc_invitation_owner;
GRANT UPDATE (id) ON app_private.app_user TO wc_invitation_owner;
GRANT SELECT (id,user_id,absolute_expires_at,revoked_at) ON app_private.app_session TO wc_invitation_owner;
GRANT UPDATE (id) ON app_private.app_session TO wc_invitation_owner;
GRANT SELECT (user_id) ON app_private.platform_admin TO wc_invitation_owner;
GRANT UPDATE (user_id) ON app_private.platform_admin TO wc_invitation_owner;
GRANT SELECT,INSERT ON app_private.membership TO wc_invitation_owner;
GRANT UPDATE (id) ON app_private.membership TO wc_invitation_owner;
GRANT SELECT ON app_private.invitation,app_private.invitation_outbox TO wc_invitation_delivery_owner;
GRANT UPDATE (id) ON app_private.invitation TO wc_invitation_delivery_owner;
GRANT UPDATE ON app_private.invitation_outbox TO wc_invitation_delivery_owner;
GRANT SELECT (id) ON app_private.invitation_emission TO wc_invitation_delivery_owner;

CREATE POLICY invitation_company_read ON app_private.company FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_company_update ON app_private.company FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(true);
CREATE POLICY invitation_read ON app_private.invitation FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_insert ON app_private.invitation FOR INSERT TO wc_invitation_owner WITH CHECK(true);
CREATE POLICY invitation_update ON app_private.invitation FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(true);
CREATE POLICY invitation_emission_read ON app_private.invitation_emission FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_emission_insert ON app_private.invitation_emission FOR INSERT TO wc_invitation_owner WITH CHECK(true);
CREATE POLICY invitation_outbox_read ON app_private.invitation_outbox FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_outbox_insert ON app_private.invitation_outbox FOR INSERT TO wc_invitation_owner WITH CHECK(true);
CREATE POLICY invitation_outbox_update ON app_private.invitation_outbox FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(true);
CREATE POLICY invitation_user_read ON app_private.app_user FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_user_insert ON app_private.app_user FOR INSERT TO wc_invitation_owner WITH CHECK(true);
CREATE POLICY invitation_user_lock ON app_private.app_user FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(false);
CREATE POLICY invitation_session_read ON app_private.app_session FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_session_lock ON app_private.app_session FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(false);
CREATE POLICY invitation_admin_read ON app_private.platform_admin FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_admin_lock ON app_private.platform_admin FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(false);
CREATE POLICY invitation_membership_read ON app_private.membership FOR SELECT TO wc_invitation_owner USING(true);
CREATE POLICY invitation_membership_insert ON app_private.membership FOR INSERT TO wc_invitation_owner WITH CHECK(true);
CREATE POLICY invitation_membership_lock ON app_private.membership FOR UPDATE TO wc_invitation_owner USING(true) WITH CHECK(false);
CREATE POLICY invitation_delivery_read ON app_private.invitation FOR SELECT TO wc_invitation_delivery_owner USING(true);
CREATE POLICY invitation_delivery_lock ON app_private.invitation FOR UPDATE TO wc_invitation_delivery_owner USING(true) WITH CHECK(false);
CREATE POLICY invitation_delivery_outbox_read ON app_private.invitation_outbox FOR SELECT TO wc_invitation_delivery_owner USING(true);
CREATE POLICY invitation_delivery_outbox_update ON app_private.invitation_outbox FOR UPDATE TO wc_invitation_delivery_owner USING(true) WITH CHECK(true);
CREATE POLICY invitation_delivery_emission_read ON app_private.invitation_emission FOR SELECT TO wc_invitation_delivery_owner USING(true);
GRANT EXECUTE ON FUNCTION app_api._context_ok(text,uuid,uuid,uuid),app_api._utc(timestamptz) TO wc_invitation_owner,wc_invitation_delivery_owner;
GRANT EXECUTE ON FUNCTION app_api._platform_precheck(uuid,uuid),app_api._platform_authorize(uuid,uuid) TO wc_invitation_owner;

SET LOCAL ROLE wc_invitation_owner;
CREATE FUNCTION app_api.invitation_prepare(uid uuid,sid uuid,cid uuid,email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE code text; c record; i app_private.invitation%ROWTYPE; present boolean;
BEGIN
 IF NOT app_api._context_ok('invitation_prepare',uid,sid,cid) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
 code:=app_api._platform_precheck(uid,sid); IF code<>'OK' THEN RETURN jsonb_build_object('code',code); END IF;
 SELECT id,status,activated_at INTO c FROM app_private.company WHERE id=cid FOR SHARE; present:=FOUND;
 SELECT * INTO i FROM app_private.invitation WHERE company_id=cid FOR SHARE;
 code:=app_api._platform_authorize(uid,sid); IF code<>'OK' THEN RETURN jsonb_build_object('code',code); END IF;
 IF NOT present THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
 IF c.status='SUSPENDED' THEN RETURN jsonb_build_object('code','COMPANY_SUSPENDED'); END IF;
 IF c.status<>'PENDING_ACTIVATION' OR c.activated_at IS NOT NULL OR (email IS NULL)<>(i.id IS NOT NULL) THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
 RETURN jsonb_build_object('code','OK','value',jsonb_build_object('invitationId',coalesce(i.id,gen_random_uuid()),
   'generation',coalesce(i.generation+1,1),'email',coalesce(i.email_normalized,email)));
END $$;
CREATE FUNCTION app_api._invitation_clean(iid uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 UPDATE app_private.invitation_outbox o SET encrypted_payload=NULL,
  state=CASE WHEN i.expires_at<=clock_timestamp() THEN 'EXPIRED'::app_private.outbox_state ELSE 'CANCELLED'::app_private.outbox_state END,
  lease_id=NULL,lease_expires_at=NULL,sanitized_error_code=NULL
 FROM app_private.invitation i WHERE i.id=iid AND o.invitation_id=i.id AND o.encrypted_payload IS NOT NULL
  AND (i.accepted_at IS NOT NULL OR i.generation<>o.generation OR i.expires_at<=clock_timestamp())
$$;
CREATE FUNCTION app_api.invitation_emit(uid uuid,sid uuid,cid uuid,opid uuid,iid uuid,gen integer,email text,token_hash text,payload text,iv text,tag text,resend boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE code text; c record; i app_private.invitation%ROWTYPE; present boolean; issued timestamptz(3); wait_seconds integer; n integer; first_at timestamptz;
BEGIN
 IF NOT app_api._context_ok('invitation_emit',uid,sid,cid) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
 code:=app_api._platform_precheck(uid,sid); IF code<>'OK' THEN RETURN jsonb_build_object('code',code); END IF;
 -- Serializes per-platform-user emissions across companies BEFORE Company locks.
 PERFORM pg_advisory_xact_lock(174015,hashtext(uid::text));
 SELECT id,status,activated_at INTO c FROM app_private.company WHERE id=cid FOR UPDATE; present:=FOUND;
 SELECT * INTO i FROM app_private.invitation WHERE company_id=cid FOR UPDATE;
 code:=app_api._platform_authorize(uid,sid); IF code<>'OK' THEN RETURN jsonb_build_object('code',code); END IF;
 IF NOT present THEN RETURN jsonb_build_object('code','RESOURCE_NOT_FOUND'); END IF;
 IF c.status='SUSPENDED' THEN RETURN jsonb_build_object('code','COMPANY_SUSPENDED'); END IF;
 IF c.status<>'PENDING_ACTIVATION' OR c.activated_at IS NOT NULL OR resend IS NULL
  OR (resend AND (i.id IS DISTINCT FROM iid OR i.generation+1 IS DISTINCT FROM gen OR i.email_normalized IS DISTINCT FROM email))
  OR (NOT resend AND (i.id IS NOT NULL OR gen IS DISTINCT FROM 1)) THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
 IF token_hash IS NULL OR token_hash COLLATE "C"!~'^[0-9a-f]{64}$' OR payload IS NULL OR payload COLLATE "C"!~'^([0-9a-f]{2})+$'
  OR iv IS NULL OR iv COLLATE "C"!~'^[0-9a-f]{24}$' OR tag IS NULL OR tag COLLATE "C"!~'^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'invalid payload'; END IF;
 issued:=clock_timestamp(); wait_seconds:=0;
 SELECT count(*),min(issued_at) INTO n,first_at FROM app_private.invitation_emission WHERE company_id=cid AND issued_at>issued-interval '60 seconds';
 IF n>=1 THEN wait_seconds:=greatest(wait_seconds,ceil(extract(epoch FROM first_at+interval '60 seconds'-issued))::int); END IF;
 SELECT count(*),min(issued_at) INTO n,first_at FROM app_private.invitation_emission WHERE company_id=cid AND issued_at>issued-interval '1 hour';
 IF n>=5 THEN wait_seconds:=greatest(wait_seconds,ceil(extract(epoch FROM first_at+interval '1 hour'-issued))::int); END IF;
 SELECT count(*),min(issued_at) INTO n,first_at FROM app_private.invitation_emission WHERE issued_by_user_id=uid AND issued_at>issued-interval '1 hour';
 IF n>=20 THEN wait_seconds:=greatest(wait_seconds,ceil(extract(epoch FROM first_at+interval '1 hour'-issued))::int); END IF;
 IF wait_seconds>0 THEN RETURN jsonb_build_object('code','RATE_LIMITED','retryAfter',wait_seconds); END IF;
 IF resend THEN UPDATE app_private.invitation SET generation=gen,token_hash=decode(invitation_emit.token_hash,'hex'),issued_at=issued,expires_at=issued+interval '48 hours' WHERE id=iid;
 ELSE INSERT INTO app_private.invitation(id,company_id,email_normalized,generation,token_hash,issued_at,expires_at)
  VALUES(iid,cid,email,gen,decode(token_hash,'hex'),issued,issued+interval '48 hours'); END IF;
 PERFORM app_api._invitation_clean(iid);
 INSERT INTO app_private.invitation_emission(id,invitation_id,generation,company_id,issued_by_user_id,issued_at) VALUES(opid,iid,gen,cid,uid,issued);
 INSERT INTO app_private.invitation_outbox(id,invitation_id,generation,encrypted_payload,key_id,nonce,auth_tag)
  VALUES(opid,iid,gen,decode(payload,'hex'),'v1',decode(iv,'hex'),decode(tag,'hex'));
 RETURN jsonb_build_object('code','OK','value',jsonb_build_object('invitationId',iid,'expiresAt',app_api._utc(issued+interval '48 hours')));
END $$;
CREATE FUNCTION app_api.invitation_accept(token_hash text,uid uuid,sid uuid,phc text,new_uid uuid,mid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cid uuid; iid uuid; i app_private.invitation%ROWTYPE; c record; u record; s record; accepted timestamptz(3); result_uid uuid;
BEGIN
 IF NOT app_api._context_ok(CASE WHEN uid IS NULL THEN 'invitation_accept_new' ELSE 'invitation_accept_existing' END,uid,sid,NULL)
  THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
 IF token_hash IS NULL OR token_hash COLLATE "C"!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid token'; END IF;
 SELECT company_id,id INTO cid,iid FROM app_private.invitation WHERE invitation.token_hash=decode(invitation_accept.token_hash,'hex');
 IF NOT FOUND THEN RETURN jsonb_build_object('code','INVITATION_NOT_FOUND'); END IF;
 SELECT id,status,activated_at INTO c FROM app_private.company WHERE id=cid FOR UPDATE;
 SELECT * INTO i FROM app_private.invitation WHERE id=iid FOR UPDATE;
 IF NOT FOUND OR i.token_hash IS DISTINCT FROM decode(invitation_accept.token_hash,'hex') OR i.accepted_at IS NOT NULL OR i.expires_at<=clock_timestamp()
  THEN RETURN jsonb_build_object('code','INVITATION_NOT_FOUND'); END IF;
 IF uid IS NOT NULL THEN
  SELECT id,email_normalized INTO u FROM app_private.app_user WHERE id=uid FOR SHARE;
  SELECT id,user_id,absolute_expires_at,revoked_at INTO s FROM app_private.app_session WHERE id=sid FOR SHARE;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM uid THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('code','SESSION_REVOKED'); END IF;
  IF s.absolute_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('code','SESSION_EXPIRED'); END IF;
  IF u.id IS NULL OR u.email_normalized IS DISTINCT FROM i.email_normalized THEN RETURN jsonb_build_object('code','INVITATION_NOT_FOUND'); END IF;
 END IF;
 -- Reveal state only after a valid token (and matching recipient for existing accounts).
 IF c.status='SUSPENDED' THEN RETURN jsonb_build_object('code','COMPANY_SUSPENDED'); END IF;
 IF c.status<>'PENDING_ACTIVATION' OR c.activated_at IS NOT NULL THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
 IF uid IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.membership WHERE user_id=uid AND company_id=cid)
  THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
 BEGIN
  IF uid IS NULL THEN
   IF phc IS NULL OR phc NOT LIKE '$argon2id$v=19$%' THEN RAISE EXCEPTION 'invalid hash'; END IF;
   INSERT INTO app_private.app_user(id,email_normalized,password_hash) VALUES(new_uid,i.email_normalized,phc)
    ON CONFLICT(email_normalized) DO NOTHING RETURNING id INTO result_uid;
   IF result_uid IS NULL THEN RETURN jsonb_build_object('code','INVITATION_REQUIRES_LOGIN'); END IF;
  ELSE result_uid:=uid; END IF;
  INSERT INTO app_private.membership(id,user_id,company_id,role) VALUES(mid,result_uid,cid,'COMPANY_ADMIN');
  accepted:=clock_timestamp();
  -- A deadline reached while waiting must roll back even a newly inserted user.
  IF accepted>=i.expires_at THEN RAISE EXCEPTION USING ERRCODE='WCI01',MESSAGE='invitation expired'; END IF;
  UPDATE app_private.invitation SET accepted_at=accepted,accepted_by_user_id=result_uid WHERE id=iid;
  UPDATE app_private.company SET status='ACTIVE',activated_at=accepted WHERE id=cid;
  PERFORM app_api._invitation_clean(iid);
 EXCEPTION WHEN SQLSTATE 'WCI01' THEN RETURN jsonb_build_object('code','INVITATION_NOT_FOUND');
 END;
 RETURN jsonb_build_object('code','OK','value',jsonb_build_object('userId',result_uid,'companyId',cid,'role','COMPANY_ADMIN','companyStatus','ACTIVE'));
END $$;
REVOKE ALL ON FUNCTION app_api.invitation_prepare(uuid,uuid,uuid,text),app_api._invitation_clean(uuid),
 app_api.invitation_emit(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean),app_api.invitation_accept(text,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api.invitation_prepare(uuid,uuid,uuid,text),app_api.invitation_emit(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean) TO wc_platform;
GRANT EXECUTE ON FUNCTION app_api.invitation_accept(text,uuid,uuid,text,uuid,uuid) TO wc_identity;
RESET ROLE;

SET LOCAL ROLE wc_invitation_delivery_owner;
CREATE FUNCTION app_api.invitation_pending() RETURNS TABLE(id uuid,generation integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT app_api._context_ok('invitation_pending',NULL,NULL,NULL) THEN RAISE EXCEPTION 'invalid context'; END IF;
 RETURN QUERY SELECT o.id,o.generation FROM app_private.invitation_outbox o JOIN app_private.invitation i ON i.id=o.invitation_id
  WHERE (o.encrypted_payload IS NOT NULL AND (i.accepted_at IS NOT NULL OR i.generation<>o.generation OR i.expires_at<=clock_timestamp()))
   OR (o.state IN ('PENDING','RETRY_PENDING','PROCESSING') AND o.available_at<=clock_timestamp() AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=clock_timestamp()))
  ORDER BY o.available_at,o.id LIMIT 20;
END $$;
CREATE FUNCTION app_api.invitation_claim(oid uuid,gen integer,lid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE iid uuid; i app_private.invitation%ROWTYPE; o app_private.invitation_outbox%ROWTYPE;
BEGIN
 IF NOT app_api._context_ok('invitation_claim',NULL,NULL,NULL) THEN RAISE EXCEPTION 'invalid context'; END IF;
 SELECT invitation_id INTO iid FROM app_private.invitation_outbox WHERE id=oid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO i FROM app_private.invitation WHERE id=iid FOR SHARE;
 SELECT * INTO o FROM app_private.invitation_outbox WHERE id=oid FOR UPDATE;
 IF o.generation IS DISTINCT FROM gen THEN RETURN NULL; END IF;
 IF i.accepted_at IS NOT NULL OR i.generation<>o.generation OR i.expires_at<=clock_timestamp() THEN
  IF o.encrypted_payload IS NOT NULL THEN UPDATE app_private.invitation_outbox SET encrypted_payload=NULL,lease_id=NULL,lease_expires_at=NULL,
   state=CASE WHEN i.expires_at<=clock_timestamp() THEN 'EXPIRED'::app_private.outbox_state ELSE 'CANCELLED'::app_private.outbox_state END WHERE id=oid; END IF;
  RETURN NULL;
 END IF;
 IF o.state NOT IN ('PENDING','RETRY_PENDING','PROCESSING') OR o.available_at>clock_timestamp() OR o.lease_expires_at>clock_timestamp() THEN RETURN NULL; END IF;
 IF o.attempts>=8 THEN UPDATE app_private.invitation_outbox SET state='FAILED',lease_id=NULL,lease_expires_at=NULL WHERE id=oid; RETURN NULL; END IF;
 UPDATE app_private.invitation_outbox SET attempts=attempts+1,state='PROCESSING',lease_id=lid,lease_expires_at=clock_timestamp()+interval '90 seconds' WHERE id=oid;
 RETURN jsonb_build_object('invitationId',iid,'generation',gen,'expiresAt',app_api._utc(i.expires_at),
  'payload',encode(o.encrypted_payload,'hex'),'nonce',encode(o.nonce,'hex'),'tag',encode(o.auth_tag,'hex'),'keyId',o.key_id);
END $$;
CREATE FUNCTION app_api.invitation_can_send(oid uuid,gen integer,lid uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE iid uuid; i app_private.invitation%ROWTYPE; o app_private.invitation_outbox%ROWTYPE;
BEGIN
 IF NOT app_api._context_ok('invitation_can_send',NULL,NULL,NULL) THEN RETURN false; END IF;
 SELECT invitation_id INTO iid FROM app_private.invitation_outbox WHERE id=oid;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO i FROM app_private.invitation WHERE id=iid FOR SHARE;
 SELECT * INTO o FROM app_private.invitation_outbox WHERE id=oid FOR SHARE;
 RETURN o.state='PROCESSING' AND o.generation=gen AND o.lease_id=lid AND o.lease_expires_at>clock_timestamp()
  AND i.generation=gen AND i.accepted_at IS NULL AND i.expires_at>clock_timestamp();
END $$;
CREATE FUNCTION app_api.invitation_finish(oid uuid,gen integer,lid uuid,accepted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE iid uuid; i app_private.invitation%ROWTYPE; o app_private.invitation_outbox%ROWTYPE;
BEGIN
 IF NOT app_api._context_ok('invitation_finish',NULL,NULL,NULL) THEN RAISE EXCEPTION 'invalid context'; END IF;
 SELECT invitation_id INTO iid FROM app_private.invitation_outbox WHERE id=oid;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO i FROM app_private.invitation WHERE id=iid FOR SHARE;
 SELECT * INTO o FROM app_private.invitation_outbox WHERE id=oid FOR UPDATE;
 IF o.state<>'PROCESSING' OR o.generation IS DISTINCT FROM gen OR o.lease_id IS DISTINCT FROM lid OR o.lease_expires_at<=clock_timestamp() THEN RETURN; END IF;
 IF i.accepted_at IS NOT NULL OR i.generation<>gen OR i.expires_at<=clock_timestamp() THEN
  UPDATE app_private.invitation_outbox SET encrypted_payload=NULL,lease_id=NULL,lease_expires_at=NULL,
   state=CASE WHEN i.expires_at<=clock_timestamp() THEN 'EXPIRED'::app_private.outbox_state ELSE 'CANCELLED'::app_private.outbox_state END WHERE id=oid;
 ELSIF accepted THEN UPDATE app_private.invitation_outbox SET state='SMTP_ACCEPTED',encrypted_payload=NULL,smtp_accepted_at=clock_timestamp(),
  lease_id=NULL,lease_expires_at=NULL,sanitized_error_code=NULL WHERE id=oid;
 ELSE UPDATE app_private.invitation_outbox SET state=CASE WHEN attempts>=8 THEN 'FAILED'::app_private.outbox_state ELSE 'RETRY_PENDING'::app_private.outbox_state END,
  available_at=clock_timestamp()+(10000*power(2,o.attempts-1)*(0.5+random()*0.5))*interval '1 millisecond',
  lease_id=NULL,lease_expires_at=NULL,sanitized_error_code='SMTP_UNCONFIRMED' WHERE id=oid;
 END IF;
END $$;
CREATE FUNCTION app_api.invitation_emitted(opid uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT app_api._context_ok('invitation_emitted',NULL,NULL,NULL) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM app_private.invitation_emission WHERE id=opid);
END $$;
REVOKE ALL ON FUNCTION app_api.invitation_pending(),app_api.invitation_claim(uuid,integer,uuid),app_api.invitation_can_send(uuid,integer,uuid),
 app_api.invitation_finish(uuid,integer,uuid,boolean),app_api.invitation_emitted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api.invitation_pending(),app_api.invitation_claim(uuid,integer,uuid),app_api.invitation_can_send(uuid,integer,uuid),
 app_api.invitation_finish(uuid,integer,uuid,boolean),app_api.invitation_emitted(uuid) TO wc_delivery;
RESET ROLE;
REVOKE CREATE ON SCHEMA app_api FROM wc_invitation_owner,wc_invitation_delivery_owner;
COMMIT;

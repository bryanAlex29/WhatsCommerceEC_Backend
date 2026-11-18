-- Incremento revisable. Requiere 000–004; NO ejecuta setup ni cambia credenciales.
BEGIN;
CREATE ROLE wc_recovery_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_recovery_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_recovery_owner REVOKE ALL ON TABLES FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private, app_api TO wc_recovery_owner;
GRANT CREATE ON SCHEMA app_api TO wc_recovery_owner;
SET LOCAL ROLE wc_data_owner;
CREATE TABLE app_private.password_recovery (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_private.app_user(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  code_mac bytea NOT NULL CHECK (octet_length(code_mac) = 32),
  issued_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  invalidated_at timestamptz(3),
  consumed_at timestamptz(3),
  verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts BETWEEN 0 AND 5),
  encrypted_payload bytea,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  state app_private.outbox_state NOT NULL DEFAULT 'PENDING',
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 8),
  available_at timestamptz(3) NOT NULL,
  lease_id uuid,
  lease_expires_at timestamptz(3),
  CHECK (isfinite(issued_at) AND expires_at = issued_at + interval '15 minutes'),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state <> 'PROCESSING' OR lease_id IS NOT NULL),
  CHECK (encrypted_payload IS NULL OR octet_length(encrypted_payload) > 0),
  CHECK (encrypted_payload IS NOT NULL OR state IN ('SMTP_ACCEPTED','CANCELLED','EXPIRED')),
  UNIQUE (nonce)
);
CREATE INDEX password_recovery_user_idx ON app_private.password_recovery(user_id, issued_at, id);
CREATE UNIQUE INDEX password_recovery_current_idx ON app_private.password_recovery(user_id)
  WHERE invalidated_at IS NULL AND consumed_at IS NULL;
CREATE INDEX password_recovery_delivery_idx ON app_private.password_recovery(state, available_at, id);
ALTER TABLE app_private.password_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.password_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY recovery_internal ON app_private.password_recovery TO wc_recovery_owner USING (true) WITH CHECK (true);
REVOKE ALL ON app_private.password_recovery FROM PUBLIC, wc_identity, wc_tenant, wc_platform, wc_delivery;
GRANT SELECT, INSERT, UPDATE ON app_private.password_recovery TO wc_recovery_owner;
GRANT SELECT (id,email_normalized,password_hash) ON app_private.app_user TO wc_recovery_owner;
GRANT UPDATE (password_hash,updated_at) ON app_private.app_user TO wc_recovery_owner;
GRANT SELECT ON app_private.app_session TO wc_recovery_owner;
GRANT UPDATE (revoked_at,revocation_reason) ON app_private.app_session TO wc_recovery_owner;
CREATE POLICY recovery_read_user ON app_private.app_user FOR SELECT TO wc_recovery_owner USING (true);
CREATE POLICY recovery_update_user ON app_private.app_user FOR UPDATE TO wc_recovery_owner USING (true) WITH CHECK (true);
CREATE POLICY recovery_read_session ON app_private.app_session FOR SELECT TO wc_recovery_owner USING (true);
CREATE POLICY recovery_revoke_session ON app_private.app_session FOR UPDATE TO wc_recovery_owner USING (true) WITH CHECK (true);
RESET ROLE;
GRANT EXECUTE ON FUNCTION app_api._context_ok(text,uuid,uuid,uuid) TO wc_recovery_owner;
SET LOCAL ROLE wc_recovery_owner;

CREATE FUNCTION app_api.recovery_request(email text, rid uuid, mac text, payload text, iv text, tag text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE uid uuid; issued timestamptz(3);
BEGIN
  IF NOT app_api._context_ok('recovery_request',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
  IF mac IS NULL OR mac COLLATE "C" !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'mac'; END IF;
  SELECT id INTO uid FROM app_private.app_user WHERE email_normalized = email FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','OK'); END IF;
  issued := clock_timestamp();
  UPDATE app_private.password_recovery SET invalidated_at=issued, encrypted_payload=NULL, state='CANCELLED', lease_id=NULL, lease_expires_at=NULL
    WHERE user_id=uid AND invalidated_at IS NULL AND consumed_at IS NULL;
  INSERT INTO app_private.password_recovery(id,user_id,code_mac,issued_at,expires_at,encrypted_payload,nonce,auth_tag,available_at)
    VALUES(rid,uid,decode(mac,'hex'),issued,issued+interval '15 minutes',decode(payload,'hex'),decode(iv,'hex'),decode(tag,'hex'),issued);
  RETURN jsonb_build_object('code','OK');
END $$;

CREATE FUNCTION app_api.recovery_reset(email text, mac text, phc text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE uid uuid; r app_private.password_recovery%ROWTYPE; changed timestamptz(3);
BEGIN
  IF NOT app_api._context_ok('recovery_reset',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
  IF mac IS NULL OR mac COLLATE "C" !~ '^[0-9a-f]{64}$' OR phc IS NULL OR NOT starts_with(phc,'$argon2id$v=19$') THEN RAISE EXCEPTION 'format'; END IF;
  SELECT id INTO uid FROM app_private.app_user WHERE email_normalized=email FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE'); END IF;
  SELECT * INTO r FROM app_private.password_recovery WHERE user_id=uid AND consumed_at IS NULL AND invalidated_at IS NULL FOR UPDATE;
  IF NOT FOUND OR r.expires_at <= clock_timestamp() OR r.verification_attempts >= 5 THEN
    RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
  END IF;
  UPDATE app_private.password_recovery SET verification_attempts=verification_attempts+1 WHERE id=r.id;
  IF r.code_mac <> decode(mac,'hex') THEN
    IF r.verification_attempts=4 THEN
      UPDATE app_private.password_recovery SET invalidated_at=clock_timestamp(),encrypted_payload=NULL,state='CANCELLED',lease_id=NULL,lease_expires_at=NULL WHERE id=r.id;
    END IF;
    RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
  END IF;
  changed := clock_timestamp();
  UPDATE app_private.app_user SET password_hash=phc, updated_at=changed WHERE id=uid;
  UPDATE app_private.app_session SET revoked_at=changed, revocation_reason='PASSWORD_RECOVERY' WHERE user_id=uid AND revoked_at IS NULL;
  UPDATE app_private.password_recovery SET consumed_at=changed, encrypted_payload=NULL, state='CANCELLED', lease_id=NULL, lease_expires_at=NULL WHERE id=r.id;
  RETURN jsonb_build_object('code','OK');
END $$;

-- La cola contiene referencias; estas funciones nunca entregan hashes de clave.
CREATE FUNCTION app_api.recovery_pending() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT id FROM app_private.password_recovery
  WHERE app_api._context_ok('recovery_pending',NULL,NULL,NULL)
    AND ((encrypted_payload IS NOT NULL AND expires_at<=clock_timestamp())
      OR (state IN ('PENDING','RETRY_PENDING') AND available_at<=clock_timestamp())
      OR (state='PROCESSING' AND lease_expires_at<=clock_timestamp()))
  ORDER BY available_at,id LIMIT 20
$$;

CREATE FUNCTION app_api.recovery_claim(rid uuid, lid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r app_private.password_recovery%ROWTYPE; uid uuid;
BEGIN
  IF NOT app_api._context_ok('recovery_claim',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
  SELECT user_id INTO uid FROM app_private.password_recovery WHERE id=rid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM app_private.app_user WHERE id=uid FOR SHARE;
  SELECT * INTO r FROM app_private.password_recovery WHERE id=rid FOR UPDATE;
  IF r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL THEN RETURN NULL; END IF;
  IF r.expires_at<=clock_timestamp() THEN
    UPDATE app_private.password_recovery SET state='EXPIRED',encrypted_payload=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id=rid;
    RETURN NULL;
  END IF;
  IF r.delivery_attempts>=8 THEN
    UPDATE app_private.password_recovery SET state='FAILED',lease_id=NULL,lease_expires_at=NULL WHERE id=rid AND state='PROCESSING';
    RETURN NULL;
  END IF;
  IF NOT ((r.state IN ('PENDING','RETRY_PENDING') AND r.available_at<=clock_timestamp()) OR
    (r.state='PROCESSING' AND r.lease_expires_at<=clock_timestamp())) THEN RETURN NULL; END IF;
  UPDATE app_private.password_recovery SET state='PROCESSING',delivery_attempts=delivery_attempts+1,
    lease_id=lid,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=rid;
  RETURN jsonb_build_object('payload',encode(r.encrypted_payload,'hex'),'nonce',encode(r.nonce,'hex'),'tag',encode(r.auth_tag,'hex'));
END $$;

CREATE FUNCTION app_api.recovery_finish(rid uuid, lid uuid, accepted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT app_api._context_ok('recovery_finish',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
  UPDATE app_private.password_recovery SET
    state=CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED'::app_private.outbox_state
      WHEN accepted THEN 'SMTP_ACCEPTED'::app_private.outbox_state
      WHEN delivery_attempts>=8 THEN 'FAILED'::app_private.outbox_state ELSE 'RETRY_PENDING'::app_private.outbox_state END,
    encrypted_payload=CASE WHEN accepted OR expires_at<=clock_timestamp() THEN NULL ELSE encrypted_payload END,
    available_at=clock_timestamp() + (10 * power(2,delivery_attempts-1) * (0.5+random())) * interval '1 second',
    lease_id=NULL,lease_expires_at=NULL
  WHERE id=rid AND lease_id=lid AND state='PROCESSING' AND lease_expires_at>clock_timestamp()
    AND consumed_at IS NULL AND invalidated_at IS NULL;
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA app_api FROM wc_recovery_owner;
GRANT EXECUTE ON FUNCTION app_api.recovery_request(text,uuid,text,text,text,text), app_api.recovery_reset(text,text,text) TO wc_identity;
GRANT EXECUTE ON FUNCTION app_api.recovery_pending(), app_api.recovery_claim(uuid,uuid), app_api.recovery_finish(uuid,uuid,boolean) TO wc_delivery;

-- Sustituye exclusivamente la entrada insegura para creacion de sesiones.
-- La credencial verificada se revalida bajo User FOR SHARE antes de Session.
GRANT CREATE ON SCHEMA app_api TO wc_identity_owner;
SET LOCAL ROLE wc_identity_owner;
CREATE FUNCTION app_api.identity_create_session_checked(uid uuid, sid uuid, hid uuid, refresh_hash text, expected_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE current_hash text;
BEGIN
  IF NOT app_api._context_ok('create_session',uid,sid,NULL) THEN RETURN jsonb_build_object('code','UNAUTHENTICATED'); END IF;
  SELECT password_hash INTO current_hash FROM app_private.app_user WHERE id=uid FOR SHARE;
  IF NOT FOUND OR current_hash IS DISTINCT FROM expected_hash THEN RETURN jsonb_build_object('code','INVALID_CREDENTIALS'); END IF;
  RETURN app_api.identity_create_session(uid,sid,hid,refresh_hash);
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA app_api FROM wc_identity_owner;
REVOKE EXECUTE ON FUNCTION app_api.identity_create_session(uuid,uuid,uuid,text) FROM wc_identity;
GRANT EXECUTE ON FUNCTION app_api.identity_create_session_checked(uuid,uuid,uuid,text,text) TO wc_identity;
COMMIT;

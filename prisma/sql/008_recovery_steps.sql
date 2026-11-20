-- Incremental recovery steps. Requires 000–005, NOT SQL007. No DEV application here.
BEGIN;
SET LOCAL ROLE wc_data_owner;
ALTER TABLE app_private.password_recovery
 ADD COLUMN verified_at timestamptz(3),
 ADD COLUMN reset_token_hash bytea,
 ADD CONSTRAINT recovery_grant_pair CHECK ((verified_at IS NULL)=(reset_token_hash IS NULL)),
 ADD CONSTRAINT recovery_grant_hash CHECK (reset_token_hash IS NULL OR octet_length(reset_token_hash)=32),
 ADD CONSTRAINT recovery_grant_time CHECK (verified_at IS NULL OR (isfinite(verified_at) AND verified_at>=issued_at AND verified_at<expires_at));
RESET ROLE;
GRANT CREATE ON SCHEMA app_api TO wc_recovery_owner;
SET LOCAL ROLE wc_recovery_owner;

CREATE FUNCTION app_api.recovery_verify(email text, mac text, grant_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE uid uuid; r app_private.password_recovery%ROWTYPE; checked timestamptz(3);
BEGIN
 IF NOT app_api._context_ok('recovery_verify',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
 IF mac IS NULL OR mac COLLATE "C"!~'^[0-9a-f]{64}$' OR grant_hash IS NULL OR grant_hash COLLATE "C"!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'format'; END IF;
 SELECT id INTO uid FROM app_private.app_user WHERE email_normalized=email FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE'); END IF;
 SELECT * INTO r FROM app_private.password_recovery WHERE user_id=uid AND consumed_at IS NULL AND invalidated_at IS NULL FOR UPDATE;
 IF NOT FOUND OR r.expires_at<=clock_timestamp() OR r.verification_attempts>=5 OR r.verified_at IS NOT NULL THEN
  RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
 END IF;
 UPDATE app_private.password_recovery SET verification_attempts=verification_attempts+1 WHERE id=r.id;
 IF r.code_mac<>decode(mac,'hex') THEN
  IF r.verification_attempts=4 THEN UPDATE app_private.password_recovery SET invalidated_at=clock_timestamp(),encrypted_payload=NULL,state='CANCELLED',lease_id=NULL,lease_expires_at=NULL WHERE id=r.id; END IF;
  RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
 END IF;
 checked:=clock_timestamp();
 IF checked>=r.expires_at THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE'); END IF;
 UPDATE app_private.password_recovery SET verified_at=checked,reset_token_hash=decode(grant_hash,'hex'),
  encrypted_payload=NULL,state='CANCELLED',lease_id=NULL,lease_expires_at=NULL WHERE id=r.id;
 RETURN jsonb_build_object('code','OK','expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;

CREATE FUNCTION app_api.recovery_complete(email text, grant_hash text, phc text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE uid uuid; r app_private.password_recovery%ROWTYPE; changed timestamptz(3);
BEGIN
 IF NOT app_api._context_ok('recovery_complete',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
 IF grant_hash IS NULL OR grant_hash COLLATE "C"!~'^[0-9a-f]{64}$' OR phc IS NULL OR NOT starts_with(phc,'$argon2id$v=19$') THEN RAISE EXCEPTION 'format'; END IF;
 SELECT id INTO uid FROM app_private.app_user WHERE email_normalized=email FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE'); END IF;
 SELECT * INTO r FROM app_private.password_recovery WHERE user_id=uid AND consumed_at IS NULL AND invalidated_at IS NULL FOR UPDATE;
 IF NOT FOUND OR r.verified_at IS NULL OR r.reset_token_hash IS DISTINCT FROM decode(grant_hash,'hex') OR r.expires_at<=clock_timestamp() THEN
  RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
 END IF;
 BEGIN
  changed:=clock_timestamp();
  UPDATE app_private.app_user SET password_hash=phc,updated_at=changed WHERE id=uid;
  UPDATE app_private.app_session SET revoked_at=changed,revocation_reason='PASSWORD_RECOVERY' WHERE user_id=uid AND revoked_at IS NULL;
  UPDATE app_private.password_recovery SET consumed_at=changed,encrypted_payload=NULL,state='CANCELLED',lease_id=NULL,lease_expires_at=NULL WHERE id=r.id;
  IF clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION USING ERRCODE='WCR01',MESSAGE='recovery expired'; END IF;
 EXCEPTION WHEN SQLSTATE 'WCR01' THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
 END;
 RETURN jsonb_build_object('code','OK');
END $$;

-- Preserve the old API for older clients, but a verified code cannot bypass its grant.
CREATE OR REPLACE FUNCTION app_api.recovery_reset(email text, mac text, phc text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE uid uuid; r app_private.password_recovery%ROWTYPE; changed timestamptz(3);
BEGIN
 IF NOT app_api._context_ok('recovery_reset',NULL,NULL,NULL) THEN RAISE EXCEPTION 'context'; END IF;
 IF mac IS NULL OR mac COLLATE "C"!~'^[0-9a-f]{64}$' OR phc IS NULL OR NOT starts_with(phc,'$argon2id$v=19$') THEN RAISE EXCEPTION 'format'; END IF;
 SELECT id INTO uid FROM app_private.app_user WHERE email_normalized=email FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE'); END IF;
 SELECT * INTO r FROM app_private.password_recovery WHERE user_id=uid AND consumed_at IS NULL AND invalidated_at IS NULL FOR UPDATE;
 IF NOT FOUND OR r.expires_at<=clock_timestamp() OR r.verification_attempts>=5 OR r.verified_at IS NOT NULL THEN RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE'); END IF;
 UPDATE app_private.password_recovery SET verification_attempts=verification_attempts+1 WHERE id=r.id;
 IF r.code_mac<>decode(mac,'hex') THEN
  IF r.verification_attempts=4 THEN UPDATE app_private.password_recovery SET invalidated_at=clock_timestamp(),encrypted_payload=NULL,state='CANCELLED',lease_id=NULL,lease_expires_at=NULL WHERE id=r.id; END IF;
  RETURN jsonb_build_object('code','INVALID_RECOVERY_CODE');
 END IF;
 changed:=clock_timestamp();
 UPDATE app_private.app_user SET password_hash=phc,updated_at=changed WHERE id=uid;
 UPDATE app_private.app_session SET revoked_at=changed,revocation_reason='PASSWORD_RECOVERY' WHERE user_id=uid AND revoked_at IS NULL;
 UPDATE app_private.password_recovery SET consumed_at=changed,encrypted_payload=NULL,state='CANCELLED',lease_id=NULL,lease_expires_at=NULL WHERE id=r.id;
 RETURN jsonb_build_object('code','OK');
END $$;
REVOKE ALL ON FUNCTION app_api.recovery_verify(text,text,text),app_api.recovery_complete(text,text,text),app_api.recovery_reset(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api.recovery_verify(text,text,text),app_api.recovery_complete(text,text,text) TO wc_identity;
RESET ROLE;
REVOKE CREATE ON SCHEMA app_api FROM wc_recovery_owner;
COMMIT;

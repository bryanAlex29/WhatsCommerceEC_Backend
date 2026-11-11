-- REVISABLE / NO APLICADO. Ejecutar solo tras autorización explícita futura.
-- Orden: 000_roles.sql, 001_schema.sql (Prisma), este archivo, 003_rls.sql.
-- No crea cuentas, grants runtime, CRUD, aceptación, refresh ni bootstrap.
-- PostgreSQL: CHECK/trigger complementan Prisma; no sustituyen autorización,
-- validación Unicode/IDNA/backend, locks ni transacciones por operación.
BEGIN;
-- Crear también las funciones como owner aplica sus defaults desde el origen.
SET LOCAL ROLE wc_data_owner;

-- La fila Session apunta a un historial obligatorio que se inserta en la misma
-- transacción. Prisma no representa DEFERRABLE: preservar este ajuste al diff.
-- RESTRICT sigue impidiendo borrar/alterar claves referenciadas; la comprobación
-- de existencia de la nueva referencia se pospone al commit.
ALTER TABLE app_private.app_session
  ALTER CONSTRAINT app_session_current_refresh_fkey
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE app_private.company
  ADD CONSTRAINT company_text_check CHECK (
    char_length(btrim(trade_name)) > 0 AND trade_name = btrim(trade_name)
    AND char_length(btrim(legal_name)) > 0 AND legal_name = btrim(legal_name)
    AND char_length(btrim(tax_address)) > 0 AND tax_address = btrim(tax_address)
  ),
  ADD CONSTRAINT company_ruc_check CHECK (ruc COLLATE "C" ~ '^[0-9]{13}$'),
  ADD CONSTRAINT company_phone_check CHECK (contact_phone COLLATE "C" ~ '^\+[0-9]{8,15}$'),
  -- Guarda genérica: ASCII imprimible, minúsculas, una @ y partes no vacías.
  -- NO es un validador RFC ni valida DNS/IDNA; esa validación queda en backend.
  ADD CONSTRAINT company_email_check CHECK (
    contact_email COLLATE "C" ~ '^[!-~]+$'
    AND contact_email = lower(contact_email COLLATE "C")
    AND cardinality(string_to_array(contact_email, '@')) = 2
    AND split_part(contact_email, '@', 1) <> ''
    AND split_part(contact_email, '@', 2) <> ''
  ),
  ADD CONSTRAINT company_activation_check CHECK (
    (status <> 'PENDING_ACTIVATION' OR activated_at IS NULL)
    AND (status <> 'ACTIVE' OR activated_at IS NOT NULL)
    AND (activated_at IS NULL OR (isfinite(activated_at) AND activated_at >= created_at))
  ),
  ADD CONSTRAINT company_dates_check CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
  );

ALTER TABLE app_private.app_user
  ADD CONSTRAINT app_user_email_check CHECK (
    email_normalized COLLATE "C" ~ '^[!-~]+$'
    AND email_normalized = lower(email_normalized COLLATE "C")
    AND cardinality(string_to_array(email_normalized, '@')) = 2
    AND split_part(email_normalized, '@', 1) <> ''
    AND split_part(email_normalized, '@', 2) <> ''
  ),
  -- Solo forma/prefijo PHC; no demuestra hashing, parámetros ni entropía.
  ADD CONSTRAINT app_user_password_hash_check CHECK (
    starts_with(password_hash, '$argon2id$v=19$')
    AND char_length(password_hash) > char_length('$argon2id$v=19$')
  ),
  ADD CONSTRAINT app_user_dates_check CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
  );

ALTER TABLE app_private.membership
  ADD CONSTRAINT membership_dates_check CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
  );

ALTER TABLE app_private.branch
  ADD CONSTRAINT branch_text_check CHECK (
    char_length(btrim(name)) > 0 AND name = btrim(name)
    AND char_length(btrim(address)) > 0 AND address = btrim(address)
  ),
  ADD CONSTRAINT branch_email_check CHECK (email IS NULL OR (
    email COLLATE "C" ~ '^[!-~]+$'
    AND email = lower(email COLLATE "C")
    AND cardinality(string_to_array(email, '@')) = 2
    AND split_part(email, '@', 1) <> '' AND split_part(email, '@', 2) <> ''
  )),
  ADD CONSTRAINT branch_phone_check CHECK (phone IS NULL OR phone COLLATE "C" ~ '^\+[0-9]{8,15}$'),
  ADD CONSTRAINT branch_dates_check CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
  );

ALTER TABLE app_private.platform_admin
  ADD CONSTRAINT platform_admin_date_check CHECK (isfinite(granted_at));

ALTER TABLE app_private.invitation
  ADD CONSTRAINT invitation_email_check CHECK (
    email_normalized COLLATE "C" ~ '^[!-~]+$'
    AND email_normalized = lower(email_normalized COLLATE "C")
    AND cardinality(string_to_array(email_normalized, '@')) = 2
    AND split_part(email_normalized, '@', 1) <> ''
    AND split_part(email_normalized, '@', 2) <> ''
  ),
  ADD CONSTRAINT invitation_generation_check CHECK (generation > 0),
  ADD CONSTRAINT invitation_hash_check CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT invitation_validity_check CHECK (
    isfinite(issued_at) AND isfinite(expires_at)
    AND expires_at = issued_at + interval '48 hours'
  ),
  ADD CONSTRAINT invitation_acceptance_check CHECK (
    (accepted_at IS NULL) = (accepted_by_user_id IS NULL)
    AND (accepted_at IS NULL OR (
      isfinite(accepted_at) AND accepted_at >= issued_at AND accepted_at < expires_at
    ))
  ),
  ADD CONSTRAINT invitation_dates_check CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
  );

ALTER TABLE app_private.app_session
  ADD CONSTRAINT app_session_generation_check CHECK (current_refresh_generation > 0),
  ADD CONSTRAINT app_session_expiry_check CHECK (
    isfinite(created_at) AND isfinite(absolute_expires_at)
    AND absolute_expires_at > created_at
    AND absolute_expires_at <= created_at + interval '168 hours'
  ),
  ADD CONSTRAINT app_session_revocation_check CHECK (
    (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= created_at))
    AND (revocation_reason IS NULL OR (
      revoked_at IS NOT NULL AND char_length(btrim(revocation_reason)) > 0
    ))
  );

ALTER TABLE app_private.refresh_token_history
  ADD CONSTRAINT refresh_token_history_generation_check CHECK (generation > 0),
  ADD CONSTRAINT refresh_token_history_hash_check CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT refresh_token_history_dates_check CHECK (
    isfinite(issued_at)
    AND (replaced_at IS NULL OR (isfinite(replaced_at) AND replaced_at >= issued_at))
  );

ALTER TABLE app_private.invitation_outbox
  ADD CONSTRAINT invitation_outbox_generation_check CHECK (generation > 0),
  ADD CONSTRAINT invitation_outbox_type_check CHECK (type = 'INITIAL_ADMIN_INVITATION'),
  ADD CONSTRAINT invitation_outbox_crypto_check CHECK (
    char_length(btrim(key_id)) > 0 AND key_id = btrim(key_id)
    AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND (encrypted_payload IS NULL OR octet_length(encrypted_payload) > 0)
    -- FAILED por agotar intentos conserva ciphertext hasta invalidez/vencimiento.
    AND (encrypted_payload IS NOT NULL OR state IN ('SMTP_ACCEPTED', 'CANCELLED', 'EXPIRED'))
  ),
  ADD CONSTRAINT invitation_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 8),
  ADD CONSTRAINT invitation_outbox_lease_check CHECK (
    (lease_id IS NULL) = (lease_expires_at IS NULL)
    AND (lease_expires_at IS NULL OR (isfinite(lease_expires_at) AND lease_expires_at > created_at))
    AND (state <> 'PROCESSING' OR lease_id IS NOT NULL)
  ),
  ADD CONSTRAINT invitation_outbox_smtp_check CHECK (
    (state = 'SMTP_ACCEPTED') = (smtp_accepted_at IS NOT NULL)
    AND (smtp_accepted_at IS NULL OR (isfinite(smtp_accepted_at) AND smtp_accepted_at >= created_at))
  ),
  -- Diagnóstico es código, nunca mensaje SMTP, dirección o secreto.
  ADD CONSTRAINT invitation_outbox_error_check CHECK (
    sanitized_error_code IS NULL OR sanitized_error_code COLLATE "C" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  ADD CONSTRAINT invitation_outbox_dates_check CHECK (
    isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at
    AND isfinite(available_at) AND available_at >= created_at
  );

ALTER TABLE app_private.invitation_emission
  ADD CONSTRAINT invitation_emission_generation_check CHECK (generation > 0),
  ADD CONSTRAINT invitation_emission_date_check CHECK (isfinite(issued_at));

-- Solo triggers de integridad, SECURITY INVOKER (sin elevación ni DML interno).
-- Fija timestamps también en escrituras SQL. created_at no se puede reescribir.
CREATE FUNCTION app_private.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'created_at is immutable';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;
ALTER FUNCTION app_private.touch_updated_at() OWNER TO wc_data_owner;
REVOKE ALL ON FUNCTION app_private.touch_updated_at() FROM PUBLIC;

CREATE TRIGGER company_touch_updated_at BEFORE UPDATE ON app_private.company
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER app_user_touch_updated_at BEFORE UPDATE ON app_private.app_user
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER membership_touch_updated_at BEFORE UPDATE ON app_private.membership
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER branch_touch_updated_at BEFORE UPDATE ON app_private.branch
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER invitation_touch_updated_at BEFORE UPDATE ON app_private.invitation
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER invitation_outbox_touch_updated_at BEFORE UPDATE ON app_private.invitation_outbox
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE FUNCTION app_private.guard_company_immutability() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.ruc IS DISTINCT FROM OLD.ruc THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ruc is immutable';
  END IF;
  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'initial activation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app_private.guard_company_immutability() OWNER TO wc_data_owner;
REVOKE ALL ON FUNCTION app_private.guard_company_immutability() FROM PUBLIC;
CREATE TRIGGER company_guard_immutability BEFORE UPDATE ON app_private.company
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_immutability();

CREATE FUNCTION app_private.guard_branch_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'branch owner is immutable';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app_private.guard_branch_owner() OWNER TO wc_data_owner;
REVOKE ALL ON FUNCTION app_private.guard_branch_owner() FROM PUBLIC;
CREATE TRIGGER branch_guard_owner BEFORE UPDATE ON app_private.branch
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_branch_owner();

CREATE FUNCTION app_private.guard_invitation_recipient() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invitation recipient and company are immutable';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app_private.guard_invitation_recipient() OWNER TO wc_data_owner;
REVOKE ALL ON FUNCTION app_private.guard_invitation_recipient() FROM PUBLIC;
CREATE TRIGGER invitation_guard_recipient BEFORE UPDATE ON app_private.invitation
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_invitation_recipient();

-- El máximo de siete días no puede eludirse moviendo el origen, ni extenderse
-- durante refresh aunque la nueva fecha siguiese dentro del máximo inicial.
CREATE FUNCTION app_private.guard_session_lifetime() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'session lifetime is immutable';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app_private.guard_session_lifetime() OWNER TO wc_data_owner;
REVOKE ALL ON FUNCTION app_private.guard_session_lifetime() FROM PUBLIC;
CREATE TRIGGER app_session_guard_lifetime BEFORE UPDATE ON app_private.app_session
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_session_lifetime();

-- Integridad cruzada de emisión/empresa ya declarada en Prisma:
-- (invitation_id, company_id) -> invitation(id, company_id).
-- Outbox/emisiones NO referencian generation mutable de Invitation.
-- No grants runtime ni políticas aquí: 003 debe ENABLE/FORCE RLS default-deny.
COMMIT;

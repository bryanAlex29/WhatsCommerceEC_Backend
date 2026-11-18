-- Entrega 1.4a: base default-deny revisable, NO aplicada ni probada en PG.
-- Trazabilidad: RF-01/RF-02, RNF-01/RNF-02; DERCAS 16.10 y 16.13.
-- Precondiciones de una futura ejecucion autorizada: 000_roles.sql y las
-- diez tablas del esquema aprobado ya creadas. No asume columnas ni GUC.
-- No es idempotente: objetos/politicas existentes provocan error, sin DROP
-- ni adopcion silenciosa. El aplicador debe detenerse ante cualquier error.
-- Ownership, ACL y politicas forman una unica transaccion.

BEGIN;

ALTER TABLE app_private.company OWNER TO wc_data_owner;
ALTER TABLE app_private.app_user OWNER TO wc_data_owner;
ALTER TABLE app_private.membership OWNER TO wc_data_owner;
ALTER TABLE app_private.branch OWNER TO wc_data_owner;
ALTER TABLE app_private.platform_admin OWNER TO wc_data_owner;
ALTER TABLE app_private.invitation OWNER TO wc_data_owner;
ALTER TABLE app_private.app_session OWNER TO wc_data_owner;
ALTER TABLE app_private.refresh_token_history OWNER TO wc_data_owner;
ALTER TABLE app_private.invitation_outbox OWNER TO wc_data_owner;
ALTER TABLE app_private.invitation_emission OWNER TO wc_data_owner;

REVOKE ALL PRIVILEGES ON TABLE
    app_private.company,
    app_private.app_user,
    app_private.membership,
    app_private.branch,
    app_private.platform_admin,
    app_private.invitation,
    app_private.app_session,
    app_private.refresh_token_history,
    app_private.invitation_outbox,
    app_private.invitation_emission
FROM PUBLIC, wc_identity, wc_tenant, wc_platform, wc_delivery;

ALTER TABLE app_private.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.company FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_user FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.membership FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.branch ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.branch FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.platform_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.platform_admin FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.app_session FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.refresh_token_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.refresh_token_history FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.invitation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.invitation_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.invitation_emission ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.invitation_emission FORCE ROW LEVEL SECURITY;

-- Restrictivas solo para los cuatro runtimes: tampoco un grant o una nueva
-- politica permisiva accidental habilita su acceso directo a filas.
-- NO usar TO PUBLIC: futuros owners especializados de funciones deben tener
-- grants/politicas explicitos propios y no pertenecer a estos runtimes.
-- Sin politicas permisivas, los restantes roles sujetos a RLS tambien quedan
-- default-deny. FORCE somete al owner a RLS, pero no impide su capacidad DDL
-- ni limita superusuarios; no sustituye separar administracion de runtime.

CREATE POLICY deny_runtime_all ON app_private.company
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.app_user
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.membership
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.branch
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.platform_admin
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.invitation
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.app_session
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.refresh_token_history
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.invitation_outbox
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);
CREATE POLICY deny_runtime_all ON app_private.invitation_emission
    AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
    USING (false) WITH CHECK (false);

-- RLS no controla columnas ni TRUNCATE/REFERENCES: las ACL revocadas son
-- necesarias. No se concede SELECT general, DML, TRUNCATE ni REFERENCES.
-- Las rutas aprobadas siguen SIN acceso SQL operativo en esta entrega.
-- Pendientes: owners internos especializados NOLOGIN, funciones/proyecciones
-- por operacion, autorizacion vigente de sesion/pertenencia/estado, contexto A
-- transaccional sin residuos, grants EXECUTE individuales y pruebas con roles
-- efectivos. No hay helpers ficticios ni funciones SECURITY DEFINER de allow.

COMMIT;

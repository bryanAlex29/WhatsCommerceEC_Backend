-- Entrega 1.4a: artefacto revisable, NO aplicado ni validado en PostgreSQL.
-- Trazabilidad: RF-01/RF-02, RNF-01/RNF-02; DERCAS 16.10 y 16.13.
-- Ejecutar en otra etapa requiere autorizacion expresa y una identidad
-- administrativa separada: este archivo no crea migrator ni bootstrap real.
-- CREATE ROLE falla si el nombre ya existe; no adopta roles preexistentes.
-- wc_data_owner permanece NOLOGIN. Los cuatro runtimes quedan estacionados
-- NOLOGIN, sin password: su aprovisionamiento LOGIN y fuente autorizada de
-- credenciales pertenecen a otra etapa, no a este artefacto.
-- No hay membresias, SET ROLE de runtime a owner, ni permisos entre ambitos.
-- Los objetos futuros deben crearse como wc_data_owner para recibir estos
-- defaults; transferirles ownership despues no aplica defaults retroactivos.
-- No modifica public, roles ajenos ni privilegios globales de otros owners.

BEGIN;

CREATE ROLE wc_data_owner
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE wc_identity
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE wc_tenant
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE wc_platform
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE wc_delivery
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

CREATE SCHEMA app_private AUTHORIZATION wc_data_owner;
CREATE SCHEMA app_api AUTHORIZATION wc_data_owner;

REVOKE ALL PRIVILEGES ON SCHEMA app_private, app_api FROM PUBLIC;
GRANT USAGE ON SCHEMA app_api TO wc_identity, wc_tenant, wc_platform, wc_delivery;

-- Defaults globales solo para objetos creados por wc_data_owner.
-- EXECUTE de funciones se revoca sin IN SCHEMA: un default por esquema no
-- eliminaria el EXECUTE concedido globalmente por defecto a PUBLIC.
ALTER DEFAULT PRIVILEGES FOR ROLE wc_data_owner
    REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_data_owner
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_data_owner
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wc_data_owner
    REVOKE ALL PRIVILEGES ON SCHEMAS FROM PUBLIC;

-- USAGE en app_api no concede CREATE, EXECUTE ni acceso a app_private.
-- No se crean funciones/proyecciones operativas ni grants sobre tablas.
-- Futuros owners especializados requieren defaults/revocaciones propios y
-- EXECUTE individual por operacion auditada; estos defaults no los cubren.

COMMIT;

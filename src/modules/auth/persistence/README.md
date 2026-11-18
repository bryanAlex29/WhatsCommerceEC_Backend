# Persistencia auth/contexto — código preparado, SQL NO aplicado

**Continuidad posterior:** SQL000–004 fue aplicado con autorización en un cluster DEV
aislado y pasó aceptación real PostgreSQL/Redis/API. Este documento conserva abajo la
entrega original del especialista, anterior a esa ejecución; ver
[`test/auth-real.md`](../../../../test/auth-real.md) y
[`scripts/auth-local.md`](../../../../scripts/auth-local.md). No equivale a producción.

Scope exclusivo: adaptadores aquí y `prisma/sql/004_auth_context.sql`. No se modifica
schema ni 000–003. SQL004 requiere 000–003; revisión y ejecución administrativa quedan
pendientes de autorización. No conecta, crea roles efectivos ni habilita LOGIN por sí solo.

## Integración para MAIN

`new PrismaIdentityPort(identityClient, cursor)` y `new PrismaTenantPort(tenantClient)`.
Los clientes vienen de URLs runtime separadas explícitas, nunca DATABASE_URL bootstrap.
Los imports Prisma son exclusivamente de tipos, no construyen/conectan clientes.

El cursor implementa `CompanyCursorPort` exportado en `adapters.ts`: decode/encode
sincrónicos con `{ createdAt: DateUTC milisegundos, id: UUID }`, ligados a Principal.
La posición es **Membership.created_at/id**, no Company; autorización se repite en SQL.
MAIN aplica AES-GCM, vinculación a colección/alcance y expiración. No hay secretos de
cursor en este adaptador ni inventamos otro formato. SQL usa LIMIT20 + EXISTS, no 21.

Cada método abre transacción interactiva READ COMMITTED, maxWait3s/timeout5s.
Primero verifica rol current/session exacto wc_identity o wc_tenant, sin superuser,
BYPASSRLS, administración/replicación/inherit, membresías o propiedad de objetos.
Después exige GUC vacíos y usa set_config(..., true) con:
`wc.user_id`, `wc.session_id`, `wc.company_id`, `wc.operation`, `wc.tx_marker`.
Este último coincide con txid_current(). No usar defaults/session-level para ninguno.
Operaciones por token comienzan sin principal/empresa: el hash reconocido deriva la
sesión dentro de la función, no de un userId de cliente. Contexto A no autentica GUC
frente a SQL arbitrario con credenciales comprometidas.

Funciones SQL internas consumidas automáticamente por cada método:

| Método | Función app_api |
| --- | --- |
| credential | identity_credential(text) |
| createSession | identity_create_session(uuid,uuid,uuid,text) |
| refreshSession | identity_refresh_session(text) |
| rotate | identity_rotate(text,text,uuid) |
| logout | identity_logout(text) |
| self | identity_self(uuid,uuid) |
| companies | identity_companies(uuid,uuid,timestamptz,uuid) |
| company | tenant_company(uuid,uuid,uuid) |

Todas devuelven jsonb `{code,value?}`. Hashes de entrada son SHA256 hex64 ya separado
por propósito en el servicio; SQL decode('hex') guarda bytea32. UUID nuevos para sesión
e historial se generan en servidor. SQL captura clock_timestamp después de bloquear;
sesión inicial tiene vencimiento absoluto de168h, refresh no lo extiende.

**Crítico:** rotate devuelve `SESSION_REVOKED` por reutilización como resultado normal
de la transacción; nunca lanza un AuthError dentro de ella para ese resultado. La capa
de servicio lo convierte en HTTP error **después** del commit. Dos refresh concurrentes
se serializan por SessionFORUPDATE; el segundo revalida y revoca. Logout admite hash
histórico/desconocido; sin JWT ni empresa. No reintentos de escrituras inciertas.

Tenant adquiere CompanyFORSHARE → SessionFORSHARE → MembershipFORSHARE. Nunca usa
el lock de identidad de otra transacción como autorización del tenant. FULL/BASIC y
estado se deciden en SQL después de pertenencia vigente. BASIC se valida sin extras.
Errores SQL conocidos se convierten a AuthError sanitizado; fallos driver/resultados
malformados/rol/configuración devuelven 503 sin SQL ni mensajes originales.

Owners especializados NOLOGIN no son dueños de tablas ni tienen BYPASSRLS/membresías.
Grants/policies internas explícitas no recursivas se limitan a tablas necesarias;
runtime conserva deny_runtime_all y solo EXECUTE allowlist. UPDATE(id) a tenant
permite FOR SHARE, pero WITH CHECK false impide modificar esas filas. Revisar esta
semántica con PG17 efectivo antes de aceptar RLS. No hay nuevas policies para PUBLIC.

## Evidencia y pendientes

Specs con Prisma transaccional **simulado** comprueban consultas parametrizadas,
contexto, denegación, proyecciones y que resultados de reutilización confirman sin
rollback. Specs SQL son controles textuales, **no parser PostgreSQL ni RLS real**.
Pendientes: revisión SQL, aplicación autorizada, roles LOGIN aprovisionados aparte,
pruebas efectivas ACL/RLS/FOR SHARE, contaminación pool y concurrencia/commit reales.
Redis/transport/config/cursor/validadores generales son responsabilidad de MAIN.

Checks ejecutados: typecheck, lint y build correctos; 22 pruebas focalizadas de esta
carpeta correctas (17 adaptadores simulados +5 controles SQL estáticos). En el árbol
compartido al verificar: 143 unitarias y29 e2e correctas; los totales incluyen trabajo
paralelo de MAIN. Prisma validate/generate con configuración offline sin dotenv,
prisma:sql:check y check:persistence correctos. Estos dos últimos conservan su alcance
previo de esquema/SQL000–003; no validan sintaxis ni ejecución de004.

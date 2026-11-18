# Subfase 1.5 — Backend de incorporación inicial

## Alcance y estado

Implementación local en `feature/incorporacion-empresa`, worktree separado desde `c56e068`. Reutiliza `POST /api/platform/companies`: no hay autorregistro público, formulario nuevo ni cambios al WIP de la 1.4.

Fuente funcional: DERCAS §16.3, §16.7–16.13 y contrato detallado aprobado, ambos en el workspace de contexto. Backend verificado con servicios desechables; **no aplicado a DEV ni validado como interfaz móvil/administrativa**. El propietario autorizó publicar esta entrega mediante rama y PR a `develop`, sin integración automática. Esto no cierra integralmente la Subfase 1.5 ni la aceptación nativa pendiente de la 1.4.

## Operaciones

| Ruta POST (prefijo `/api`) | Resultado |
| --- | --- |
| `/platform/companies/:companyId/initial-invitation` | Plataforma vigente; `{email}`; `202 {invitationId, expiresAt}` al persistir invitación, emisión y outbox. |
| `/platform/companies/:companyId/initial-invitation/resend` | Plataforma vigente, sin body; conserva destinatario e invalida generación anterior. |
| `/auth/invitations/accept-new` | `{invitationToken,password}`; `201` sin login automático. |
| `/auth/invitations/accept` | Sesión del destinatario; `{invitationToken}`; `200` sin promoción de IDs aportados por cliente. |

Aceptación devuelve únicamente `{userId,companyId,role:"COMPANY_ADMIN",companyStatus:"ACTIVE"}`. JSON estricto de 16 KiB, campos protegidos/desconocidos, duplicados y query rechazados; `Cache-Control: no-store`. Invitación inválida, ajena, sustituida, consumida o vencida: `404 INVITATION_NOT_FOUND`. Cuenta ya existente por ruta nueva: `409 INVITATION_REQUIRES_LOGIN`. No se revela suspensión a una identidad destinataria incorrecta.

La empresa queda `PENDING_ACTIVATION` hasta aceptación válida. Fallar entrega no elimina ni activa la empresa. Crear usuario (si corresponde), pertenencia, consumo y activación es una sola transacción. Una pertenencia ya existente produce `STATE_CONFLICT`: no se eleva silenciosamente un vendedor por una anomalía de datos.

## Persistencia y seguridad

- Solo se agrega `prisma/sql/007_initial_invitations.sql`; SQL000–006 conservan sus bytes. Reutiliza tablas existentes sin regenerar SQL001 ni cambiar modelos.
- Propietarios NOLOGIN sin BYPASSRLS, FORCE RLS existente, funciones allowlist y roles efectivos `wc_platform`, `wc_identity`, `wc_delivery`; runtime no accede directamente a tablas de invitación.
- Tokens aleatorios de 32 bytes, base64url canónico de 43 caracteres; SHA-256 con prefijo de propósito `invitation\0`. Contraseñas con Argon2id existente.
- Payload AES-256-GCM con AAD por invitación/generación y clave independiente. Nunca tokens en respuestas API, URL, jobs ni logs.
- Cuotas móviles Redis: empresa 1/min y 5/h; administrador 20/h; ambas aceptaciones comparten 10 intentos/IP/15 min. Conteo PostgreSQL de emisiones exitosas serializado por administrador y empresa. `429` incluye `Retry-After`.
- Reservas identificables: se libera solo rechazo definitivo, no un resultado PG incierto. Fallo Redis posterior a un commit confirmado no convierte un éxito en `503`; reconciliación solo confirma evidencia positiva de commit. No se promete atomicidad distribuida.
- Orden de locks: emisión serializa administrador → Company → Invitation → Session/PlatformAdmin; aceptación Company → Invitation → User → Session → Membership, con revalidación y rollback si vence durante la operación.

## Entrega de captura

`src/modules/invitations/worker.ts` usa BullMQ con referencias `{id,generation}` y reconciliación periódica, incluso después de publicar. PostgreSQL controla hasta ocho intentos, lease de 90 s, backoff exponencial desde 10 s y jitter 0.5; no se suman ocho reintentos independientes de cola.

Antes de enviar se revalida vigencia/generación/lease. La confirmación también es condicional. SMTP puede aceptar y perderse la respuesta: hay duplicados posibles, no entrega exactamente una vez. Una sustitución entre la última comprobación y SMTP no puede retirar un mensaje ya en tránsito, pero su código no será aceptable. Solo se elimina payload recuperable tras aceptación SMTP confirmada, consumo/invalidación o vencimiento; no por publicación, fallo o timeout incierto. Se retienen metadatos.

`mailpit.ts` fija `127.0.0.1`, sin autenticación, Gmail ni host externo configurable. Es **solo captura local**, nunca transporte productivo. Mensaje con código manual, sin enlaces/deep-links.

Imagen oficial revisada: `axllent/mailpit:v1.33.1`, fijada en pruebas a `sha256:aef2aacc11f075ec0fb6874275ee4a421e688e11a96ebb296134d1735c7761ce`. Sin relay, perfiles privados ni volúmenes DEV. Puertos SMTP/UI loopback efímeros en pruebas.

Referencias oficiales: [Mailpit Docker](https://mailpit.axllent.org/docs/install/docker/), [release v1.33.1](https://github.com/axllent/mailpit/releases/tag/v1.33.1), [BullMQ retries/jitter](https://docs.bullmq.io/guide/retrying-failing-jobs).

## Ejecución reproducible autorizada: solo pruebas aisladas

Con Docker Desktop disponible y dependencias existentes:

```powershell
npm run prisma:generate
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:invitations:postgres
npm run prisma:validate
npm run prisma:sql:check
```

El runner crea PostgreSQL17, Redis7 y Mailpit **nuevos**, con nombres aleatorios y bindings `127.0.0.1` efímeros; aplica SQL000–007 únicamente en esa base. Usa credenciales sintéticas aleatorias en memoria. Detiene solo sus propios contenedores en `finally`. No lee `.env`, no ejecuta migraciones DEV ni llama Gmail. Un corte abrupto del proceso puede dejar contenedores con prefijo `wc-invitations-test-`: revisar individualmente antes de limpiar, nunca detener por patrón servicios ajenos.

Comprobaciones reales: emisión/reenvío y aceptación nueva/existente; permisos y destinatario incorrecto; plazo y suspensión; carreras de emisión, reenvío y aceptación; fallos inyectados tras crear usuario y al insertar outbox; vencimiento durante aceptación; leases y confirmación ajena; ocho intentos duraderos; cuotas PostgreSQL/Redis; captura SMTP por BullMQ y aceptación con código capturado. Incluye 19 comprobaciones HTTP con JWT/Nest compilado y persistencia real.

### Resultados ejecutados en esta entrega

| Comprobación | Resultado |
| --- | --- |
| `npm test` | 293 pruebas, 23 suites; incluye 39 nuevas de invitación/configuración. |
| `npm run test:e2e` | 51 pruebas HTTP existentes con puertos simulados. |
| `npm run test:invitations:postgres` | 81 comprobaciones; PG/Redis/Mailpit/BullMQ reales, incluidas 19 HTTP/JWT/DB. |
| `npm run test:companies:postgres` | 75 comprobaciones reales de regresión. |
| `npm run test:recovery:postgres` | 38 comprobaciones reales, sin SMTP. |
| `typecheck`, `lint`, `build`, `prisma:validate`, `prisma:sql:check` | Correctos. |
| SQL000–006 comparados con `c56e068`; `git diff --check` | Sin diferencias en SQL previos ni errores de whitespace. |

El primer intento de Jest se interrumpió por timeout de 120 s; las ejecuciones completas posteriores terminaron correctamente. No se atribuye a ese intento un resultado válido. No se ejecutaron UI, Android/iOS, correo real ni aplicación SQL007 en DEV.

Antes de publicar se repitieron las comprobaciones. El fixture de reintentos falló en un host más rápido porque adelantaba `available_at` hasta antes de `created_at`; se corrigió para usar el instante de creación sin rebajar la restricción SQL. Las fechas emparejadas de los fixtures usan un único instante de sentencia para conservar las 48 horas exactas. Después pasaron **dos ejecuciones consecutivas de las 81 comprobaciones reales**, además de tipos, lint, build y Prisma. No se modificó la lógica de negocio por ese fallo del test.

## Configuración preparada, no habilitada

`.env.example` conserva `INVITATIONS_ENABLED=false`. Para una operación futura autorizada requiere auth/empresas habilitadas, `INVITATION_OUTBOX_KEY` exclusiva, URL `wc_delivery` y puerto Mailpit local. Producción se rechaza.

`npm run invitations:worker` valida **solo el entorno explícito del proceso**: no carga ni copia perfiles privados de recuperación. No ejecutar en el DEV actual antes de revisar/aprobar SQL007, aprovisionamiento y configuración local de captura. No hay credenciales predeterminadas o incluidas en código.

## Pendientes que requieren otra decisión/autorización

- Aplicar SQL007 y habilitar perfiles/servicios en DEV existente.
- Implementar el canal aprobado posteriormente: gestión de registro/invitaciones en AdminWeb y aceptación en móvil; diseño detallado, integración y aceptación nativa aparte. La política de sesión web todavía requiere confirmación.
- Revisar y aprobar los PR antes de integrar. La publicación fue autorizada separadamente; no autoriza merges ni despliegues.
- Transporte/TLS productivo, custodia/rotación de claves y retención productiva.

## Key Learnings:

1. La sesión sintética y su historial refresh deben crearse en una transacción por la FK diferida existente.
2. El test de vencimiento durante la inserción comprueba rollback del usuario, no solo del consumo de invitación.
3. `202` acredita outbox persistido; Mailpit acredita captura, nunca correo real ni lectura.

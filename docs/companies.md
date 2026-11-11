# Empresas y sucursales — bloque 1 (preparación DEV)

Implementa RF-01/RF-02 y RNF-01/02/03/04 según DERCAS §11/12/16 y el contrato detallado aprobado del workspace. **SQL006 aplicado y Empresas habilitado posteriormente en DEV local con autorización específica del propietario y respaldo restaurado de prueba.** Sin invitaciones, pantallas móviles, AdminWeb ni despliegue productivo.

## Operaciones

Todas las rutas requieren JWT y sesión vigentes; los privilegios se vuelven a comprobar dentro de cada transacción. Prefijo común `/api`.

| Método/ruta | Acceso | Resultado |
| --- | --- | --- |
| `GET /platform/companies` | Plataforma | `200 Page<CompanyFull>` |
| `POST /platform/companies` | Plataforma | `201 CompanyFull`, pendiente de activación |
| `GET /platform/companies/{companyId}` | Plataforma | `200 CompanyFull` |
| `PATCH /platform/companies/{companyId}` | Plataforma | `200 CompanyFull` |
| `POST /platform/companies/{companyId}/suspend` | Plataforma | `200 CompanyFull` |
| `POST /platform/companies/{companyId}/reactivate` | Plataforma | `200 CompanyFull` |
| `GET /platform/companies/{companyId}/branches` | Plataforma | `200 Page<BranchFull>` |
| `POST /platform/companies/{companyId}/branches` | Plataforma | `201 BranchFull` |
| `PATCH /platform/companies/{companyId}/branches/{branchId}` | Plataforma | `200 BranchFull` |
| `GET /companies/{companyId}/branches` | `COMPANY_ADMIN` propio, empresa activa | `200 Page<BranchFull>` |

No hay DELETE, traslado de sucursal, sucursal principal automática, editor de permisos ni acceso comercial global de plataforma. El vendedor no consulta sucursales; su consulta empresarial BASIC existente se conserva.

## Contrato conservado

- Alta empresa: seis campos obligatorios `tradeName`, `legalName`, `ruc`, `taxAddress`, `contactEmail`, `contactPhone`. No crea sucursal, usuario, pertenencia ni invitación.
- PATCH empresa: uno o más de los anteriores excepto `ruc`. RUC de trece dígitos ASCII, único en PostgreSQL e inmutable; sin consulta/verificación legal SRI.
- Sucursal: `name` y `address` obligatorios; `email`/`phone` opcionales. PATCH omite para conservar o usa `null` para quitar esos dos contactos; texto vacío se rechaza. Relación empresarial solo desde ruta autorizada y no modificable.
- Longitudes por puntos de código, Unicode válido, trim exterior, correos canónicos ASCII/IDNA y teléfonos `+` con 8–15 dígitos. No coerción ni normalización NFC silenciosa. JSON objeto ≤16 KiB, claves duplicadas/desconocidas/protegidas rechazadas.
- Consultas y transiciones sin body. Solo los listados admiten query `cursor`; máximo veinte, orden `createdAt ASC,id ASC`, `items`/`nextCursor`, sin totales.
- Cursores AES-GCM con el secreto de cursor existente y AAD separado para cada colección, empresa y ámbito; ligados también a identidad/sesión, vigencia quince minutos. No se pueden usar entre selector, plataforma y tenant. Siempre reautorizar cada página.
- `401` de sesión, `403 FORBIDDEN`/estado propio, `404 RESOURCE_NOT_FOUND` para inexistente/ajeno, `409 RUC_ALREADY_EXISTS`, `400` validación/cursor. Errores del driver/resultados inesperados fallan con `503` sanitizado. Respuestas `Cache-Control: no-store`.

## Estado empresarial y transacciones

Registro crea `PENDING_ACTIVATION`. La activación inicial pertenece al bloque posterior de aceptación de invitaciones; esta entrega no la simula con una ruta alternativa.

Suspender conserva registros y bloquea operaciones empresariales aun con sesiones previamente abiertas. Reactivar una empresa suspendida vuelve a `ACTIVE` solo si tiene activación inicial, o a `PENDING_ACTIVATION` si no la completó. Repetir suspensión/reactivación no vuelve a modificar timestamps. La identidad y las otras empresas del usuario conservan sus reglas de acceso independientes.

`006_companies.sql` agrega funciones allowlist y un propietario NOLOGIN sin BYPASSRLS. `wc_platform` solo ejecuta las funciones aprobadas; no obtiene SELECT general, credenciales, sesiones en bruto, modificación de pertenencias ni datos comerciales. `wc_tenant` solo agrega la función de sucursales propias. RLS forzado y restricciones anteriores se conservan; modelos Prisma y SQL000–005 no se reescriben.

La consulta preliminar de privilegio rechaza no-plataforma antes de leer/bloquear el recurso. No es autorización definitiva: después se adquieren locks Company → Session → PlatformAdmin y se revalida sesión/privilegio. Tenant usa Company → Session → Membership. Transacciones READ COMMITTED, contexto local con marcador de transacción y chequeo de conexiones sin residuos. La operación ya autorizada puede terminar antes del commit de suspensión; no se promete cancelación retroactiva. No reintentos automáticos de escrituras.

Contexto A supone backend confiable y consultas parametrizadas; no protege por sí solo frente a SQL arbitrario capaz de falsificar contexto. No hay bypass global ni rol administrativo de fallback.

## Habilitación DEV — estado y procedimiento

`COMPANIES_ENABLED=false` por defecto en una instalación nueva. No se conectan pools, aplican SQL ni aprovisionan roles al iniciar. En el DEV del propietario ya existe un overlay privado `.env.companies-dev` con el módulo habilitado y el pool restringido `wc_platform`. El overlay precede a los perfiles runtime existentes; no carga el perfil administrativo ni altera Gmail/recuperación.

Para otro entorno DEV autorizado se deben revisar/aplicar SQL006 incremental y aprovisionar exclusivamente el LOGIN restringido `wc_platform`, con credenciales privadas. Configuración validada:

- `AUTH_ENABLED=true` con su configuración actual válida y SQL previos aplicados.
- `COMPANIES_ENABLED=true`.
- `COMPANIES_PLATFORM_DATABASE_URL` con usuario `wc_platform`; nunca `DATABASE_URL` ni superusuario como fallback.
- Pool tenant existente `AUTH_TENANT_DATABASE_URL` y clave existente `AUTH_CURSOR_KEY`; sin credenciales nuevas en el móvil.

No copiar sobre perfiles existentes ni reaplicar SQL000–005. Habilitar el flag sin SQL/rol correctos falla cerrado; health sigue siendo liveness, no prueba de disponibilidad del módulo. Producción está excluida por validación de entorno.

Comandos de operación local (no ejecutarlos contra otra base ni como autorización implícita):

- `npm run companies:preflight:local`: comprueba destino Docker local, base/rol administrativos DEV y recibos de SQL000–005, sin aplicar SQL.
- `npm run companies:apply:local`: solo con aprobación explícita y API/worker pausados. Crea respaldo cifrado, comprueba restauración aislada, aplica únicamente006 y aprovisiona `wc_platform` en una transacción; registra checksum en `wc_ops.companies_receipt` y activa el overlay privado. **Rechaza si ya existe el overlay o la entrega**: no repetir este comando en el DEV ya habilitado.
- `npm run companies:verify:local`: comprueba recibo/configuración/rol real y denegación sin contexto; usa también Prisma con los pools reales de plataforma/tenant y principales aleatorios inexistentes, sin crear usuarios ni suplantar sesiones humanas.

El respaldo previo se guarda fuera de Git en `%LOCALAPPDATA%\WhatsCommerceEC\backups\`, con ACL solo para usuario Windows y SYSTEM. Incluye dump PostgreSQL, roles y perfiles privados dentro de `backup.aes-gcm.json` cifrado AES-256-GCM; `key.dpapi` protege la clave con Windows DPAPI CurrentUser y `verified.json` registra la restauración comprobada. Conservar los tres archivos y el contexto Windows original para poder descifrarlo. No publicar, enviar por chat ni subir el respaldo. No se restaura automáticamente sobre una base existente.

En esta puesta en marcha se verificó la restauración de trece tablas en un contenedor nuevo sin red ni volúmenes, y se compararon las once tablas de aplicación antes/después de006: mismas filas y contenido. Los perfiles previos conservaron sus bytes. Se reiniciaron API y worker conservando SMTP; no se solicitó ningún código ni se hizo un envío de prueba. La copia de respaldo persistente se verificó por hash; se conserva también la copia inicial cifrada en el directorio temporal privado del agente.

## Verificación ejecutada

- `npm run typecheck`, `npm run lint`, `npm run build`.
- `npm test`: 254 unitarias; `npm run test:e2e`: 51 HTTP (15 nuevas de empresas), con persistencia simulada en esa suite.
- `npm run prisma:validate` y `npm run prisma:sql:check`: esquema válido y SQL001 consistente.
- `npm run test:companies:postgres`: compila primero y ejecuta 75 comprobaciones con Prisma y PostgreSQL17 reales, contenedor nuevo con puerto loopback efímero, sin volúmenes ni perfiles DEV. Aplica000–006 solo en ese contenedor y lo elimina al terminar. Incluye RUC concurrente, estados/idempotencia, permisos de lecturas y escrituras, relaciones A/B, privilegios efectivos, ausencia de contexto, pool contaminado, cursores, revocaciones y frontera concurrente de suspensión. Ocho comprobaciones usan HTTP/Nest y JWT reales con los puertos Prisma reales; se inyectan las dependencias del runtime de prueba. Las cuotas de login no se ejercitan en ese segmento y fallan cerrado si se invocan.
- `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)` sobre consultas representativas con datos sintéticos confirma uso de `company_created_at_id_idx` y `branch_company_id_created_at_id_idx`. Justifican orden y filtro; no establecen SLA productivo ni un benchmark de extremo a extremo.
- `npm run test:recovery:postgres`: 38 comprobaciones de regresión en otro PostgreSQL desechable, con SQL006 incluido; no envía SMTP.

Comprobaciones posteriores en DEV: `companies:verify:local` correcto; health `200`, plataforma y sucursales sin JWT `401 UNAUTHENTICATED`, login con cuenta sintética inexistente `401 INVALID_CREDENTIALS`, recuperación y reset con body vacío `400 VALIDATION_ERROR` sin emisión ni consumo de códigos. No se crearon fixtures ni cuentas humanas en DEV.

El HTTP autenticado se ejecutó en la base desechable con cuentas sintéticas, no suplantando cuentas reales de DEV. No se verificó de nuevo un login correcto de una cuenta humana ni la entrega de un nuevo correo. No se acredita ejecución Android/iOS; las pantallas administrativas y las invitaciones siguen pendientes.

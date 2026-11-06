# Entrega 1.4a — SQL revisable, no aplicado

**Aplicación posterior autorizada:** el conjunto 000–004 se aplicó exclusivamente al
cluster DEV aislado `whatscommerceec-auth-dev`, con recibo SHA-256 administrativo y
pruebas reales de sus funciones/ACL/contexto. Los encabezados «no aplicado» de los
artefactos conservan el estado de su preparación original; no se modifican archivos
SQL ya registrados para cambiar ese texto. Ver [operación local](../../scripts/auth-local.md)
y [aceptación real](../../test/auth-real.md). Nada de ello autoriza aplicación productiva.

**Continuación Subfase 1.4:** `004_auth_context.sql` prepara funciones y propietarios internos
especializados para identidad/contexto empresarial, después de los archivos 000–003. Sigue
sin aplicar y requiere revisión/ejecución autorizadas. Ver
[`src/modules/auth/persistence/README.md`](../../src/modules/auth/persistence/README.md).
Los controles `check:persistence` de esta entrega base siguen limitados a los cuatro archivos
originales; las pruebas textuales específicas de SQL004 tampoco demuestran su sintaxis,
permisos efectivos ni RLS real. No habilitar roles LOGIN por la existencia de estos archivos.

Alcance parcial de RF-01/RF-02 y seguridad/integridad, conforme a DERCAS §16.10–16.13 del workspace. No acepta todavía los casos de uso empresariales ni demuestra aislamiento real.

## Archivos y orden de revisión

| Archivo | Contenido preparado |
| --- | --- |
| `000_roles.sql` | Cinco roles NOLOGIN sin privilegios elevados ni membresías; esquemas `app_private`/`app_api` y defaults restringidos. |
| `001_schema.sql` | DDL generado desde vacío con los diez modelos Prisma, enums, índices y FK Restrict. |
| `002_constraints.sql` | CHECK, triggers de integridad/timestamps y FK circular de refresh diferible hasta commit. |
| `003_rls.sql` | Ownership, revocaciones, ENABLE/FORCE RLS y políticas restrictivas de denegación para los cuatro runtimes. |

**No ejecutar estos archivos sin autorización posterior explícita**, tampoco como prueba con rollback. No son migraciones instaladas ni scripts idempotentes; no adoptan roles/políticas existentes. Su futura aplicación requiere revisar el estado de la base y un procedimiento que se detenga ante errores. Cada archivo tiene su transacción: el conjunto no es atómico entre archivos. No usarlo contra una base compartida/productiva ni exponer runtime mientras la preparación esté incompleta.

El aplicador futuro debe poder crear los roles/esquemas y asumir `wc_data_owner`, sin conceder ese rol al runtime. `001` y `002` crean objetos bajo ese owner para aplicar sus default privileges desde el origen; cambiar ownership después no aplica defaults retroactivamente. Las funciones trigger son SECURITY INVOKER, con `search_path` fijo y EXECUTE público revocado. No son funciones de negocio.

## Comprobaciones sin PostgreSQL

Desde el checkout backend, con las dependencias existentes:

```text
npm run prisma:validate
npm run prisma:generate
npm run prisma:sql:check
npm run check:persistence
npm run test:persistence
```

- `prisma:sql` prepara `001_schema.sql` con `migrate diff --from-empty --to-schema ... --script`; no conecta ni aplica SQL. El wrapper fija las rutas y no acepta parámetros de conexión. Prisma carga su configuración habitual, que puede cargar `.env`, sin imprimir sus valores.
- Si existe un archivo diferente, la generación no lo reemplaza automáticamente. Tras revisar, `npm run prisma:sql -- --write` permite actualizar únicamente un archivo con el marcador de generación reconocido. `prisma:sql:check` solo compara y falla ante diferencias.
- `check:persistence` lee exclusivamente el esquema y los cuatro SQL públicos, sin `.env` ni conexión. Revisa tokens y estructura de diez modelos/tablas, roles y políticas. **No es un parser PostgreSQL ni una auditoría exhaustiva de seguridad.**
- `test:persistence` prueba ese inspector y el renderizador con fixtures, y revisa los archivos reales. No prueba sintaxis SQL, permisos efectivos, triggers, integridad real, RLS ni concurrencia.

## Límites de esta entrega

- Los cuatro runtimes permanecen NOLOGIN y sin acceso directo a tablas. USAGE en `app_api` no concede funciones ni acceso privado. Aún no existen funciones/proyecciones operativas ni propietarios internos especializados para ellas.
- Las políticas restrictivas `false` apuntan a los runtimes, no a PUBLIC. Los futuros propietarios especializados necesitan permisos/políticas explícitos y no deben heredar esos runtimes. FORCE RLS no limita superusuarios ni la capacidad DDL del propietario.
- UUIDv4 se genera en Prisma/servidor, no mediante un default SQL; una futura inserción SQL debe proporcionarlo. `timestamptz` representa instantes; configurar salida UTC en la integración futura.
- Los CHECK de correo y prefijo PHC son guardas parciales, no validación completa IDNA/Unicode ni prueba de Argon2id. Las validaciones y parámetros aprobados requieren implementación backend.
- La FK `(Session.id, currentRefreshGeneration)` apunta al historial de su propia sesión y se difiere en `002`; la sesión y su primera generación deberán crearse juntas. Prisma no conserva esa diferibilidad por sí solo.
- Outbox y emisiones conservan generaciones históricas sin FK hacia la generación mutable de Invitation. Las emisiones sí relacionan invitación y empresa mediante FK compuesta. La nulabilidad del ciphertext permite únicamente los estados terminales previstos para limpieza; no hay worker ni limpieza ejecutándose.
- Faltan funciones autorizadas, verificación vigente de sesión/pertenencia/estado, contexto A dentro de transacciones Prisma, locks y operaciones atómicas, credenciales LOGIN autorizadas, endpoints y entrega de correo. No hay login, aceptación de invitaciones ni refresh funcional.
- Antes de afirmar seguridad real se necesita una etapa autorizada de ejecución PostgreSQL 17 y pruebas con roles efectivos: denegación sin contexto, empresa A/B, proyección de vendedor, restricciones/triggers, refresh y carreras. No se ejecutó SQL en esta entrega.

No ejecutar `prisma db push`, `migrate dev`, `migrate deploy` ni `db execute` por inferencia. Los cuatro archivos y su revisión completa deben preservarse: el esquema Prisma por sí solo no reproduce todas las garantías SQL.

## Evidencia de revisión — 6 de noviembre de 2026

Pasaron Prisma validate/generate, comparación offline del DDL, inspector estático, typecheck, lint y build. Jest: **82/82 unitarias** (incluidas **25/25 de artefactos**, también ejecutadas por separado) y **11/11 e2e HTTP**. Estas últimas preservan el bootstrap, no prueban rutas empresariales. `.env`, el cliente generado y `dist/` siguen ignorados por Git. No se instalaron dependencias ni se ejecutó SQL, migración, aprovisionamiento, commit, push o PR. Sintaxis SQL y seguridad efectiva PostgreSQL pendientes de verificación autorizada.

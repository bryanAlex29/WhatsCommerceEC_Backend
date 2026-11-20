# Recuperación de contraseña (DEV, sin dominio propio)

**Estado vigente al publicar (2026-11-10): Gmail SMTP.** El propietario decidió mantener SMTP, confirmó la recepción de un código y posteriormente indicó que el flujo funciona. La última prueba de conexión en Wi-Fi confirmó TCP465/587 y autenticación SMTP cifrada correcta. El worker debe permanecer activo; health por sí solo no verifica entrega.

La alternativa [Gmail API con autorización privada OAuth](gmail-api.md) se conserva desactivada, sin credenciales Google Cloud ni prueba de envío real. Su activación fue pausada por el propietario. No seguir esa guía ni contratar servicios para usar SMTP. Mailjet/Brevo solo se investigaron; no se integraron.

Implementa RF-02/RNF-01 según DERCAS §17 y ampliación §7 del contrato compartido del workspace. No habilita producción. La recepción por SMTP fue confirmada por el propietario; no equivale a aceptación nativa exhaustiva en Android/iOS.

## Flujo y persistencia

- `POST /api/auth/password-recovery/request`, JSON `{ email }`: `202` con mensaje genérico, incluso si la cuenta no existe. La cuenta debe haber sido registrada por los procedimientos autorizados; este flujo no crea usuarios.
- `POST /api/auth/password-recovery/reset`, JSON `{ email, code, password }`: `204` sin tokens. El código de ocho dígitos, su consumo, Argon2id y la revocación de todas las sesiones se comprueban en servidor. No convertir el código a número ni transformar la contraseña.
- Código válido quince minutos desde emisión, máximo cinco intentos. Reenvío invalida el anterior. Correo normalizado: una solicitud por minuto y tres por hora; IP: diez en quince minutos. Reset tiene cuota independiente de diez por IP en quince minutos. Redis falla cerrado.
- SQL005 introduce `app_private.password_recovery` con FORCE RLS, owner NOLOGIN específico y funciones limitadas para `wc_identity`/`wc_delivery`. El rol tenant/plataforma no recibe acceso. Código almacenado como HMAC, nunca SHA de baja entropía. Payload SMTP cifrado con AES-GCM/AAD por referencia, clave distinta. Historial conservado; ciphertext eliminado tras aceptación SMTP, invalidación, consumo o vencimiento reconciliado.
- Esta tabla incremental se accede mediante consultas Prisma parametrizadas a funciones, no mediante un modelo Prisma de acceso general. `schema.prisma`, `001_schema.sql` y su verificación describen la base original de diez modelos; no acreditan la tabla005. La prueba PostgreSQL de recuperación ejecuta también005 y sus garantías. No regenerar001 para añadirla ni usar `db push`/`migrate reset`.
- `identity_create_session_checked` revalida el hash bajo lock de usuario;005 revoca la función anterior al runtime para impedir que una verificación antigua permita crear sesión después del reset. **Activar `RECOVERY_ENABLED` requiere005 antes de iniciar la API**. Mientras esté desactivada y005 aún no esté aplicado, el login usa su función original para conservar el entorno existente. No hay fallback ante errores. Después de005 la configuración antigua falla cerrado; no mezclar versiones antiguas de API con005.
- Worker explícito BullMQ, concurrencia uno y trabajos con UUID solamente. Reconciliación PostgreSQL cada cinco segundos, leases de dos minutos y máximo ocho intentos reservados, backoff desde diez segundos con jitter. Duplicados posibles ante incertidumbre SMTP; no repetir el cambio de contraseña. Confirmaciones tardías de una emisión consumida/sustituida no alteran su estado. Un correo en tránsito puede llegar después de ser invalidado: solo el código vigente funciona.
- Gmail SMTP `smtp.gmail.com:465`, TLS verificado obligatorio, sin logs ni lectura de buzón. La aceptación del destinatario por SMTP no garantiza recepción en bandeja de entrada ni lectura. Remitente Gmail dedicado; destinatarios de cualquier proveedor con formato válido.

## Activación privada y coordinada

Los pasos siguientes son para preparar otro entorno autorizado. En el DEV del propietario, SQL005 y configuración SMTP ya fueron aplicados por él; no repetirlos ni reemplazar archivos privados. No se solicita la clave por chat.

1. Revisar `prisma/sql/005_password_recovery.sql` y pruebas. Detener API/worker antes de configurar, para no recargar una versión incompatible durante el cambio. Conservar perfiles y volúmenes actuales.
2. Desde una consola **interactiva privada**, en este repositorio:
   ```powershell
   npm run recovery:setup:local
   ```
   Escribir el Gmail remitente y la **contraseña de aplicación de Google**, no la normal. La clave aparece con asteriscos. Google puede mostrar espacios de agrupación: se omiten solo en esa credencial SMTP. Se crea `.env.recovery-dev` exclusivo, ignorado por Git, sin modificar `.env.auth-dev` ni `.env.auth-admin`. No enviar por argumentos. El comando no envía correo ni aplica SQL; rechaza archivos existentes, sin rotar claves silenciosamente. Proteger el archivo con ACL de Windows para el propietario; `mode: 0600` no garantiza ACL en Windows. No capturar ni compartir la consola con secretos.
3. Solo tras autorizar la aplicación en DEV:
   ```powershell
   npm run recovery:apply:local
   ```
   Exige TTY y confirmación `APLICAR RECUPERACION DEV`. Comprueba el entorno aislado, recibo SHA-256 de000–004, aplica005 en transacción y guarda su recibo separado. Habilita únicamente el rol delivery sin herencias/elevación usando el secreto aleatorio privado; no cambia contraseñas de usuarios. Si algo preexiste sin recibo o los bytes difieren, falla, sin adoptar ni borrar objetos.
4. Iniciar la nueva API con su comando habitual. En otra consola ejecutar:
   ```powershell
   npm run recovery:worker
   ```
   Solo este worker envía correo. API/worker no leen el perfil administrativo: solo el aplicador autorizado lo requiere. No pegar claves en Expo ni variables `EXPO_PUBLIC_*`. Producción sigue denegada en validación.
5. Con autorización para el envío, usar «¿Olvidaste tu contraseña?» con una cuenta registrada cuyo buzón controle el propietario. Verificar mensaje/spam, reset, login con clave nueva y rechazo de sesiones anteriores. No afirmar éxito antes de observarlo. Repetir la aceptación en el entorno de destino: una recepción previa no garantiza todas las entregas. La validación nativa exhaustiva Android/iOS sigue pendiente.

No volver a ejecutar el bootstrap para restablecer la contraseña. No borrar perfiles, sustituir claves de cifrado ni editar SQL aplicado para reintentar. Una rotación requiere diseño posterior y conservar la posibilidad de descifrar entregas pendientes.

## Verificación reproducible

```powershell
npm run typecheck
npm run lint
npm run build
npm test
npm run test:e2e
npm run prisma:validate
npm run prisma:sql:check
npm run test:recovery:postgres
```

La última prueba crea y detiene **su propio** PostgreSQL17 efímero Docker (`wc-recovery-test-<aleatorio>`), sin red, puertos ni volúmenes. Solo procesa cuentas sintéticas; no lee perfiles existentes. Comprueba SQL/RLS/permisos, intentos, expiración, aislamiento de identidades, sesiones y carreras concurrentes. HTTP usa puertos simulados en e2e; SMTP en unitarias es simulado. No acreditan correo externo ni ejecución nativa.

### Evidencia de esta implementación (2026-11-09)

- Backend: 194 pruebas unitarias, 36 HTTP e2e y 38 comprobaciones en PostgreSQL17 efímero aprobadas. Incluyen dos resets concurrentes (uno solo gana), seis fallos concurrentes (contador máximo cinco), sustitución y vencimiento de código, leases, limpieza de ciphertext y preservación de otra identidad/sesión.
- `typecheck`, `lint`, `build`, `prisma:validate`, `prisma:sql:check`, `check:persistence` y `git diff --check`: aprobados. Los comprobadores base de Prisma no sustituyen la prueba de005.
- Móvil: 76 Jest y tres pruebas de setup aprobadas; tipos/lint/diff aprobados. UI/API simuladas, no dispositivos.
- `npm audit --omit=dev --audit-level=high`: cero vulnerabilidades de ejecución. La instalación reportó 29 avisos en el árbol completo (cuatro bajos, veinticinco moderados); no se ejecutó `audit fix` ni actualizaciones ajenas a la tarea.
- Health del servicio local existente: HTTP200; no demuestra recuperación activa. No se detuvieron procesos existentes, no se leyeron sus credenciales, no se configuró SMTP ni se aplicó005 a esa base. Sin commits/push/PR nuevos.

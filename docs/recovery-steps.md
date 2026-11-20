# Recuperación por pasos y contraseña mínima8

Refinamiento aprobado de RF-02/RNF-01; fuente vigente `../docs/DERCAS.md` §18. No cambia arquitectura, transporte de correo ni credenciales privadas. No se aplica al DEV existente por ejecutar build/test.

## Contratos

Todas las rutas sonPOST públicas, JSON estricto, sin query/IDs protegidos, con `Cache-Control: no-store` y límite16KiB. Se conservan8 dígitos,15min,5 intentos y solicitud1/min+3/h por correo y10/15min porIP; las cuotas también consumen para cuentas desconocidas.

| Ruta `/api/auth/password-recovery/…` | Body | Éxito |
| --- | --- | --- |
| `request` | `{email}` |202, mensaje genérico existente; no acredita entrega. |
| `verify` | `{email,code}` |200 `{resetToken,expiresAt}` solo tras validar el código. |
| `complete` | `{email,resetToken,password}` |204 vacío, sin login automático. |
| `reset` (compatibilidad) | `{email,code,password}` |204, solo para solicitudes que aún no se verificaron por pasos. |

Código/pase inválido, expirado, usado, reemplazado o cuenta inexistente:400 `INVALID_RECOVERY_CODE`. Verify y complete comparten `recovery-reset-ip`10/15min con reset legado; no se duplica la cuota al separar pantallas. Los límites de emisión no se modifican. `Retry-After` se conserva.

Nueva contraseña:8–128 puntos de código, mayúscula UnicodeLu y símbolo/puntuaciónP/S, sin espacios/controles/invisibles. Números opcionales. No recortar/transformar; login sigue comparando hash, sin imponer composición a credenciales ya existentes. Bootstrap y validadores de creación/cambio reutilizan la política.

## Pase y persistencia

`008_recovery_steps.sql` **requiere000–005; no depende de006/007**. No modifica los bytes deSQL000–007 ni crea un propietario LOGIN. Agrega `verified_at` y `reset_token_hash` a la tabla privada ya existente y dos funciones permitidas a `wc_identity`, SECURITY DEFINER/search_path fijo/EXECUTE noPUBLIC/FORCE RLS existentes. No grants directos nuevos a runtime.

- Generación aleatoria32bytes/base64url43 canónico. Solo el hash SHA-256 con prefijo de propósito llega a PostgreSQL; token en respuesta de verify solo en memoria del cliente, no en logs/colas/URLs.
- Orden de locksUser→Recovery compartido por request/verify/reset/complete. Los intentos fallidos se confirman antes de devolver el errorHTTP, incluidos concurrentes. La quinta comprobación correcta puede obtener pase; una quinta incorrecta invalida.
- Verificar no cambia contraseña ni inicia/revoca sesiones. Marca verificación y hash, cancela el payload recuperable/lease de entrega ya no utilizable; no promete retirar un correo que un proveedor ya aceptó.
- Código verificado no vuelve a verificar ni sirve por `/reset`; perder la respuesta del pase requiere nueva solicitud. Reenvío invalida la fila anterior, incluido el pase.
- Complete revalida correo/fila vigente/pase/plazo bajo lock y confirma cambio/consumo/revocación atómicos. Una comprobación final del plazo revierte el subbloque si venció durante una espera; no se publica éxito falso.
- Hash del pase permanece como metadato; no hay borrado de usuarios/empresas/historial ni purga automática. La autorización termina por consumo/invalidez/expiración.

## Operación y verificación

SQL008 se probó primero en contenedores nuevos. **Estado actual: habilitado en DEV tras aprobación operativa posterior**, según el registro siguiente. No aplicar007 para habilitar esta recuperación; producción y publicación siguen fuera de la autorización.

Pruebas disponibles: `npm test`, `npm run test:e2e`, `npm run test:recovery:postgres`; integración con cliente móvil puro en el otro repositorio: `npm run test:recovery:isolated` con este backend compilado en `BACKEND_DIR`. No usa perfiles, datosDEV ni SMTP externo. Los códigos de ese harness se obtienen descifrando exclusivamente el outbox sintético de su DB desechable; no acredita entrega de correo.

El diseño móvil vive en su repositorio y usa un stack anidado con tres rutas sin secretos en params. Sus renders y exportaciones no acreditan ejecución física de teclado, accesibilidad, iOS o gestos.

### Resultado verificado

Checkout `WhatsCommerceEC_Backend_Subfase1_5`, rama `feature/incorporacion-empresa`:302 unitarias,54HTTP/e2e y67 comprobaciones PostgreSQL reales correctas. Incluyen quinta verificación correcta, dos verificaciones concurrentes con un único pase ganador, dos consumos concurrentes con un único éxito, expiración/reenvío, intento de bypass legado y permisos. Tipos, ESLint, build, Prisma validate, SQL generado y contrato estático correctos; SQL000–007 sin cambios.

El runner del móvil pasó25 comprobaciones reales con Nest/Prisma/PG17/Redis7 y clienteTypeScript, sin leer perfiles ni enviar correo. Prueba contraseña de ocho caracteres con Argon2id, revocación efectiva de la sesión anterior, rechazo de replay y respuesta genérica a cuentas inexistentes.

Durante la implementación inicial, una corrida agrupada agotó el timeout120s antes de finalizar PG/exportación; se retiró únicamente su contenedor de prueba confirmado y ambas comprobaciones se repitieron por separado, con éxito. Esa etapa terminó sin migrar DEV; la activación posterior se detalla abajo. No commit/push.

Antes de una futura aplicación008: respaldo cifrado reciente y restauración, preflight de destino/recibo000–005/ausencia008 y aplicación única con recibo atómico. La comparación de datos debe proyectar las columnas anteriores: `row_to_json` completo cambia al agregar las dos columnasNULL, por lo que el ensayo anterior de007 no puede reutilizar esa comparación sin adaptarla. No ejecutar el helper de invitaciones para aplicar008.

## Activación DEV aprobada y ejecutada — 20 de noviembre de 2026

El propietario aprobó «si habilito todo y actualiza lo que falta». Se acotó a recuperación/mínimo8 DEV, respaldo/restauración, SQL008 y reinicio API; no SQL007/invitaciones, producción, GitHub ni actualizaciones forzadas.

- `scripts/recovery-steps-local.ts`: preflight de Docker local/destinos/recibos000–006, ausencia007 y008, backup cifrado AES-GCM/DPAPI, restauración PG17 aislada sin red/puertos ni volumenDEV, ensayo008 y aplicación única. Para publicación, las guardas de lectura se separaron en `scripts/recovery-dev-preflight.ts`; no se incluye el WIP del ensayo007 ni se ejecuta desde recuperación.
- Respaldo verificado de14tablas en `%LOCALAPPDATA%/WhatsCommerceEC/backups/2026-11-20T04-54-58-946Z-b4cb7d47`; incluye perfiles privados cifrados. Conservar `verified.json`, `sql008-rehearsal.json`, `key.dpapi` y `backup.aes-gcm.json` juntos; no publicarlos.
- Ensayo y transacción DEV compararon todas las columnas anteriores de las tablas existentes. SQL008 no cambió los datos previos ni credenciales/atributos de los roles. Se usaron lock operativo, locks breves de tablas, timeouts y recibo `wc_ops.recovery_steps_receipt` en la misma transacción. Verificación posterior confirmó RLS, privilegios mínimos y ausencia007.
- `scripts/recovery-api-local.ts` carga explícitamente perfiles del checkout principal en memoria; no los copia, no carga el perfil administrativo en Nest ni hereda configuración arbitraria al ConfigService. Usa módulos compilados de este checkout, SMTP y empresas conservados; módulo de invitaciones excluido.
- API probada primero en loopback3001. Después se detuvo el watcher anterior y sus hijos comprobando su identidad, y se inició la nueva API en3000/LAN. La API temporal3001 fue retirada.
- `scripts/recovery-dev-smoke.ts` comprobó health200, ruta verify real/no-store, contraseña7 rechazada y8 aceptada por composición con pase inválido/correo sintéticoUUID, Empresas401 e invitaciones404. No solicita correos ni cambia cuentas existentes. Health solo demuestra liveness; los casos de recovery también ejercitaron Redis/Prisma/PG.
- Se inició el worker de recuperación existente del checkout principal tras comprobar ausencia de duplicados. Redis confirmó un worker activo y el arranque indicó SMTP. No se atribuye entrega de correo real: no hubo solicitud real de prueba en esta tarea.
- Regresión posterior:304unitarias/54HTTP backend,67checksPG desechable,25integradas móvilTS/Nest/PG/Redis, tipos/lint/build y comprobaciones Prisma correctas. Prisma validate tuvo un timeout en una corrida agrupada y pasó al repetirlo por separado.
- Parches Expo:58.0.26, SecureStore58.0.3, jest-expo58.0.15; se eliminó la duplicación de jest-expo entre dependencies/devDependencies mediante npm. `expo install --check`,174Jest+3setup+5assets y exportacionesAndroid/iOS correctos. Metro8081 reiniciado; npm reporta27vulnerabilidades moderadas, sin ejecutar auditfixforzado.

### Reinicio y recuperación de servicio

Desde este checkout, con las dependencias y `dist` existentes:

```powershell
node --import tsx scripts/recovery-api-local.ts --check ..\WhatsCommerceEC_Backend 3000
node --import tsx scripts/recovery-api-local.ts --serve ..\WhatsCommerceEC_Backend 3000
```

La verificación sin reaplicar008 es `node --import tsx scripts/recovery-steps-local.ts --verify ..\WhatsCommerceEC_Backend`. No usar `--apply-approved-dev` si ya existe el recibo. No ejecutar ambos servidores sobre3000 ni duplicar el worker; comprobar procesos/puertos primero.

Si se necesita volver al servicio anterior, detener solo el launcher nuevo identificado e iniciar `npm run dev` en el checkout principal. SQL008 es aditivo y la API anterior conserva `/reset`; no borrar columnas/recibos ni restaurar DEV automáticamente. Ese rollback de servicio deshabilitaría la recuperación nueva en el móvil y requeriría coordinación.

Pendiente aceptación física Android/iPhone, teclado, gestos, accesibilidad y recepción/cambio completo con una cuenta propia. No se compartieron códigos, pases ni credenciales. No hay autoinicio al reiniciar Windows configurado por esta tarea.

### Publicación posterior autorizada

El propietario reportó que el flujo ya funciona después de probar Android y autorizó subir los cambios a GitHub. Es una confirmación funcional del propietario, no una ejecución nativa instrumentada ni una aceptación exhaustiva de iOS/accesibilidad. La rama `feature/recuperacion-verificada` conserva como antecedentes los PR1–4 aún pendientes hacia `develop`; el diff acumulado no implica integración ni nueva habilitación de SQL007. La preparación007 WIP permanece en el checkout original, fuera de esta entrega. Sin merge automático y sin archivos privados.

La selección de publicación, con preflight de lectura independiente del WIP007, pasó300unitarias,54HTTP y67checksPGreales. Tipos/lint/build/Prisma(generate/validate/sqlcheck)/contrato estático correctos. El móvil de publicación pasó25checks integrados contra este backend compilado. Se verificó el recibo008 existente en modo lectura y la composición del launcher con `--check`, sin migrar/reiniciar ni enviar correos para publicar. El recuento menor frente al checkout original refleja la exclusión de pruebas de preparación007.

Auditoría npm al publicar:29avisos(26moderados,3altos) en el lock de backend **sin cambios respecto al antecedente**. La cadena `prisma`/`@prisma/config`/`effect` incluye ReDoS `GHSA-7589-6fvf-x4pw`. No se evaluó aquí una remediación completa ni se afirma ausencia de riesgo. npm propone degradar Prisma a6.12.0 como cambio mayor; no se ejecuta auditfixforzado ni se cambia la arquitectura/ORM por una publicación. Revisar esta deuda de dependencias en una tarea específica antes de preparar producción.

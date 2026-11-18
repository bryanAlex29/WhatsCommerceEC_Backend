# Subfase 1.4 — verificación para cierre

Alcance original: login, refresh, logout, identidad, selector de empresas y contexto propio BASIC/FULL. La recuperación y Empresas son ampliaciones posteriores; no se exige implementar invitaciones o pantallas administrativas para comprobar estas seis operaciones.

## Aceptación automatizada reproducible y sin modificar DEV

```text
npm run test:auth:isolated
```

Compila el backend y ejecuta `test/auth-real.ts` sobre PostgreSQL17 y Redis7 **nuevos**, con contenedores identificados por ejecución, puertos loopback efímeros y secretos técnicos solo en memoria. El proceso usa `NODE_ENV=test`, sin perfiles operativos ni worker de correo. Verifica el destino antes de crear datos y elimina sus contenedores al terminar. No ejecutar el comando legado `test:auth:real` contra el DEV existente para este cierre: ese comando mantiene su destino restringido original, pero inserta fixtures que no elimina.

Resultado observado: **24 casos correctos**, entre ellos credenciales indistinguibles, firmas/JWT vencidos, sesión vencida con JWT fresco, contexto ajeno, BASIC/FULL, paginación, cambio de permisos, suspensión/pendiente, logout y revocación, refresh concurrente/reutilizado, permisos SQL, contaminación de pool, cuotas Redis, HTTP429 y HTTP503 con Redis realmente detenido solo en el entorno desechable. Logout confirma revocación aunque la cuota no esté disponible.

El cliente TypeScript móvil se ejercita contra HTTP/DB reales; **SecureStore se sustituye** en esa prueba. No es React Native ejecutándose en un teléfono. Las pruebas Jest de componentes/almacenamiento también son simuladas.

Regresión de esta revisión: backend tipos/lint/build,254 unitarias,51 HTTP con puertos simulados y Prisma validate/sql check correctos; móvil tipos/lint,82 Jest+3 setup y exportación Android/iOS correctos. La exportación usa dotenv desactivado y URL sintética solo en el proceso; no altera el `.env` móvil ni demuestra ejecución nativa.

La primera corrida bajo carga agotó el límite de cinco segundos de la petición inicial; repetir secuencialmente pasó. El runner aislado ahora permite quince segundos acotados por petición, conserva un plazo global y pasó los 24 casos. No se cambió el timeout de la app ni se afirma un SLA del producto.

## Puerta nativa pendiente

El propietario eligió **«Validación nativa primero»** y solo dispone de Android. La subfase **no se declara cerrada integralmente**. No hay SDK/ADB/emulador Android en las ubicaciones revisadas de este equipo ni simulador iOS en Windows; no se instalaron herramientas.

Primera sesión manual en Android/Expo Go, sin compartir secretos:

1. Abrir el proyecto actual y comprobar el backend dentro de la app.
2. Iniciar sesión con la cuenta del propietario, ingresando contraseña solo en el teléfono.
3. Cerrar la app completamente desde recientes; reabrir el proyecto y pulsar **Restaurar sesión guardada**. Debe recuperar identidad sin volver a introducir contraseña.
4. Pulsar **Cerrar sesión y borrar acceso local**, cerrar/reabrir y volver a pulsar restauración. No debe recuperar la sesión anterior ni sus datos.

**Resultado reportado:** el propietario confirmó «los paso del 1 al 4 se cumplen correctamente» en Android/Expo Go. Registrar conexión, login correcto, restauración normal y logout/reapertura como correctos según su validación manual. Modelo y versión de Android no informados. No es una ejecución del agente en un dispositivo ni prueba de cifrado hardware o backup.

Queda pendiente el mensaje nativo de credenciales incorrectas, que no se solicitó en esa primera lista, además de los casos empresariales/estado/carreras y accesibilidad. Registrar resultados por caso, no inferirlos de «todo funciona». Después validar con fixtures aislados: A/B, BASIC/FULL, suspensión, foco, renovación/revocación, respuesta incierta y carreras. No crear fixtures, cambiar roles ni suspender empresas humanas en DEV para inducir esos estados. No provocar errores borrando datos personales del teléfono. iOS queda pendiente hasta disponer de dispositivo, sin dar por aprobado su almacenamiento nativo.

El acta compartida del workspace (`docs/SUBFASE-1.4.md`, distribuida por separado) contiene matriz y registro. Este documento portable no cambia contratos ni autoriza migraciones, merges o producción. El propietario autorizó posteriormente publicar estos scripts y esta guía mediante rama y PR a `develop`, sin integrar automáticamente ni declarar el cierre nativo.

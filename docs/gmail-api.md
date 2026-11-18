# Gmail API por HTTPS — recuperación DEV

**Alternativa conservada, no activada.** El 2026-11-10 el propietario mantuvo Gmail SMTP. No se completó OAuth real de Google Cloud ni se verificó envío por esta API. Esta guía no es un requisito para operar la recuperación por SMTP y no autoriza facturación.

Ampliación aprobada en DERCAS §17.1. Reutiliza cuenta remitente, tablas, códigos, endpoints, outbox, BullMQ y UI. No hay migración ni cambios a SQL005 aplicado. No habilita producción ni facturación.

## Motivo y límites de la evidencia

En la red del propietario se verificó timeout TCP en `smtp.gmail.com:465` y `:587`, con DNS coherente entre sistema y Google DNS. Gmail API por HTTPS443 respondió401 sin autenticar: demuestra conectividad, no autorización ni envío. PostgreSQL/Redis de entrega se comprobaron por separado. No se identificó con certeza qué equipo/proveedor filtra SMTP; no se desactivó el firewall.

`GmailApiMailer` usa HTTPS con certificados verificados por Node, URLs fijas, sin redirects ni logs de HTTP. Renueva el acceso OAuth en memoria con single-flight y margen de sesenta segundos. No repite un POST de envío automáticamente ante401, timeout o respuesta incierta. La política existente de outbox limita reintentos; la incertidumbre puede producir correos duplicados.

El nombre histórico `SMTP_ACCEPTED` en SQL005 se conserva: con este adaptador significa que Gmail API respondió200 y devolvió un identificador de mensaje válido. No significa recepción en inbox ni lectura. No editar SQL005 para renombrarlo. El permiso `gmail.send` no permite consultar el buzón.

## Paso 1: preparar Google Cloud personalmente

Con la cuenta del proyecto, en [Google Cloud Console](https://console.cloud.google.com/):

1. Seleccionar o crear un proyecto propio, por ejemplo **WhatsCommerce EC**. No activar facturación, pruebas pagadas, Compute Engine u otros servicios por seguir esta guía. Si aparece un requisito de pago, detenerse y revisarlo con el propietario.
2. En **APIs y servicios → Biblioteca**, buscar **Gmail API** y habilitarla para ese proyecto.
3. Abrir **Google Auth Platform** (o **Pantalla de consentimiento OAuth**, según la interfaz), configurar el nombre y los contactos del proyecto. Para Gmail personal elegir audiencia **Externa**, estado **Testing/Pruebas**, y añadir **la cuenta Gmail remitente** como usuario de prueba. No es el correo de cada destinatario ni todos los usuarios móviles.
4. En permisos/acceso a datos seleccionar únicamente `https://www.googleapis.com/auth/gmail.send`, `openid` y `email` (Google puede mostrar este último como `userinfo.email`). No habilitar lectura, borrado, administración ni `https://mail.google.com/`.
5. En **Clientes → Crear cliente**, tipo **Aplicación de escritorio / Desktop app**, por ejemplo **WhatsCommerce EC DEV Mail**. Es para la consola Windows confiable que conecta al remitente, **no** para Expo/Android/iOS ni para un servidor productivo. No usar cliente Web, cuenta de servicio ni delegación de dominio.
6. Descargar el JSON del cliente y conservarlo **fuera del repositorio**, con acceso exclusivo del propietario. No subirlo a Git ni enviarlo por chat. No cambiar ni pegar manualmente URLs de autorización de terceros.

Crear un proyecto no equivale a contratar alojamiento. El uso estándar de Gmail API es sin costo adicional, sujeto a las [cuotas y condiciones actuales](https://developers.google.com/workspace/gmail/api/reference/quota); Google anuncia condiciones para cargos por excedentes. No prometer gratuidad ilimitada. Gmail personal mantiene además sus propios límites de envío.

## Paso 2: autorizar desde consola privada del PC

Detener API y worker antes de cambiar el transporte. Conservar PostgreSQL/Redis y todos los perfiles existentes. No volver a ejecutar `recovery:setup:local` ni `recovery:apply:local` para este cambio.

Desde Backend, en una consola interactiva privada Windows:

```powershell
npm run gmail:authorize:local
```

- Confirmar con `CONECTAR GMAIL DEV` y escribir la ruta privada del JSON, no su contenido ni la contraseña Gmail.
- Se abrirá el navegador del sistema. Elegir la **misma cuenta remitente** configurada en `.env.recovery-dev`. Si la pantalla no corresponde a tu propio cliente/proyecto o pide permisos adicionales, cancelar y revisar. No ignorar advertencias de seguridad indiscriminadamente.
- El navegador vuelve automáticamente a un puerto aleatorio en `127.0.0.1`. La consola usa PKCE S256, estado aleatorio, nonce, callback único con tiempo máximo de cinco minutos y host/ruta validados. No pegar códigos OAuth ni tokens; tampoco compartir la URL de retorno. No abre puertos de la LAN ni configura el firewall.
- Se verifica la firma OIDC RS256 con JWKS fijo de Google, emisor, audiencia, antigüedad/vencimiento, nonce, correo verificado y remitente esperado; también los permisos concedidos. Cuenta equivocada, scopes excesivos o consentimiento parcial fallan sin guardar configuración.
- El resultado esperado es `GMAIL_API_AUTH_SAVED`. Se crea `.env.gmail-api-dev`, ignorado por Git, mediante escritura temporal y reemplazo final. Contiene cliente OAuth y refresh token, no la contraseña normal ni la de aplicación. Proteger ACL Windows; mode0600 no garantiza ACL en Windows. Los archivos base/SMTP/HMAC/cifrado/roles DB no se modifican.
- Ningún correo se envía durante esta autorización. El código y tokens no aparecen en logs ni mensajes de error. La contraseña de aplicación SMTP anterior no se utiliza con Gmail API; no es necesario revocarla para esta prueba y no se revoca automáticamente.

Si ya existe el overlay, el comando exige `REAUTORIZAR GMAIL DEV` antes de reemplazarlo. Una operación rechazada no sustituye el archivo anterior. Si Google concede acceso pero la validación posterior falla, revisar/revocar el acceso del proyecto desde la cuenta Google antes de repetir cuando corresponda; la consola no modifica permisos de la cuenta automáticamente.

**Importante:** en un proyecto externo en estado Testing, el refresh token de estos permisos normalmente expira a los **siete días**. También puede invalidarse al revocar permisos o cambiar la contraseña Google. Reautorizar explícitamente desde consola y reiniciar el worker. Publicación/verificación OAuth y custodia productiva requieren otro diseño/aprobación, no cambiar el estado a producción silenciosamente.

## Paso 3: verificar y arrancar

```powershell
npm run gmail:verify:local
```

Debe mostrar `GMAIL_API_OAUTH_OK`: renovación OAuth aceptada, **sin enviar mensajes**. No confirma por sí sola que Gmail API esté habilitada o que un mensaje será aceptado.

En consolas separadas:

```powershell
npm run dev
```

```powershell
npm run recovery:worker
```

El worker debe mostrar `transport=gmail-api`. No hay fallback automático a SMTP. Si el overlay existe pero es inválido, falla, en lugar de usar un canal inesperado. API/worker no leen el perfil administrativo.

Solicitar después un **código nuevo** desde el móvil para una cuenta ya registrada y controlada por el propietario, respetando cuotas y autorizando ese envío. Los códigos anteriores pueden haber vencido. Verificar recepción/spam, cambio de clave y login nuevo. No compartir el código ni contraseña. Hasta observar ese flujo, la entrega real permanece pendiente.

### Diagnósticos seguros del worker/verificador

- `GMAIL_AUTHORIZATION_REQUIRED`: autorización revocada/caducada o credenciales rechazadas; reautorizar, no cambiar claves de usuarios WhatsCommerce.
- `GMAIL_CONNECTION_UNAVAILABLE`: HTTPS/DNS/timeout; no concluye clave inválida.
- `GMAIL_SEND_REJECTED`: API rechaza el envío, por ejemplo permisos, API sin habilitar o cuota; revisar configuración en Google Console, sin pegar su respuesta privada en logs.
- `GMAIL_RESPONSE_INVALID`: respuesta incompleta o scopes fuera del allowlist; no marcar enviado.
- `GMAIL_API_CONFIG_UNAVAILABLE`: falta o no es válida la configuración OAuth; no degradar a SMTP.

Referencias oficiales: [OAuth Desktop y loopback](https://developers.google.com/identity/protocols/oauth2/native-app), [caducidad](https://developers.google.com/identity/protocols/oauth2#expiration), [envío Gmail API](https://developers.google.com/workspace/gmail/api/guides/sending).

## Verificación de código

Pruebas HTTP OAuth/API simuladas, excepto callback loopback HTTP local real, sin cuentas Google ni envíos. Cubren MIME, scopes mínimos, PKCE, estado erróneo/Unicode, denegación, cuenta/nonce/audiencia, cache/renovación/single-flight, timeouts y ausencia de reintentos de escritura. No acreditan OAuth real del propietario hasta completar los pasos anteriores.

Comprobaciones ejecutadas al incorporar este transporte: **221 unitarias, 36 HTTP e2e y 38 comprobaciones PostgreSQL17 desechable**, todas aprobadas; también tipos, lint, build, validación Prisma, correspondencia del SQL base y diff sin errores. No se agregaron dependencias, modificaron archivos de credenciales reales, reaplicaron migraciones ni realizaron envíos. El consentimiento Google y la recepción real siguen pendientes del propietario.

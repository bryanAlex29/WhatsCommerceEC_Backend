# WhatsCommerce EC — Backend

La especificación funcional vigente del workspace es `../docs/DERCAS.md`; el Word de `../Contexto/` se conserva como antecedente. El workspace de contexto se distribuye por separado: estas rutas no forman parte de este checkout. Solicitarlo antes de modificar reglas de negocio.

Backend NestJS modular con TypeScript estricto: autenticación y contexto empresarial mínimos de la Subfase 1.4, con cobertura parcial RF-01/RF-02. No implementa todavía registro empresarial/invitaciones, gestión general de usuarios, catálogo ni integraciones RF-03–RF-11. No implica preparación productiva ni aceptación nativa Android/iOS.

## Estado operativo y publicación

- Entorno DEV aislado autorizado y preparado con `npm run auth:setup:local`: SQL000–004 aplicado en una transacción, PostgreSQL 17 en `127.0.0.1:55432` y Redis 7 en `127.0.0.1:16379`, volumen independiente. No se modificó el volumen original ni se publican credenciales.
- Perfil runtime `.env.auth-dev` separado del administrativo `.env.auth-admin`; el arranque DEV no mezcla estos perfiles con el bootstrap original. Los archivos privados no se incluyen en Git. `auth:bootstrap:local` permite al propietario crear el primer administrador mediante correo visible y contraseña/confirmación enmascaradas; no hay credenciales predeterminadas.
- **Verificación:** tipos, lint, build y Prisma validate correctos; **161 unitarias y 31 e2e HTTP**. También pasaron **21 casos de aceptación real PostgreSQL/Redis/API**, incluido cliente TypeScript móvil con almacenamiento simulado; no acredita SecureStore o pantallas en un dispositivo. Ver [preparación local](scripts/auth-local.md) y [aceptación real](test/auth-real.md).
- Números permitidos, no obligatorios, conservando 15–128 caracteres, mayúscula y símbolo, sin espacios/controles/invisibles. La aclaración no cambia contraseñas existentes.
- La base se publica mediante rama de trabajo y PR a `develop`, sin integración automática. Los apartados históricos siguientes conservan la evidencia y limitaciones de cada corte; sus frases «no aplicado» no sustituyen este estado operativo posterior. Producción, recuperación, MFA y registro/invitaciones mantienen su alcance pendiente.

## Requisitos e inicio

- Node.js 22.12+ de la línea 22 y npm 10 (verificado con Node 22.18.0/npm 10.9.3).
- `npm ci` para instalación reproducible desde el lockfile.
- Opcional para infraestructura: `npm run setup:local` crea `.env` DEV únicamente si no existe (procedimiento más abajo). No versionar `.env` ni reutilizar placeholders en producción.
- `npm run dev`: compila con `tsc-watch` y reinicia tras compilación correcta, conservando metadatos de decoradores TypeScript (sin loaders de ejecución).
- `npm run build` y `npm start`: compilar/iniciar, puerto predeterminado 3000.

La API inicia sin PostgreSQL, Redis ni credenciales. Configuración incorrecta aborta el arranque con mensaje sanitizado, sin imprimir valores. `PORT` debe ser entero 1–65535; `NODE_ENV`: development/test/production. Si se declaran `DATABASE_URL`/`REDIS_URL`, sus protocolos deben ser PostgreSQL/Redis. Son opcionales en este bootstrap; no anticipan políticas productivas.

## Contrato inicial

`GET http://localhost:3000/api/health` — público, sin body ni autenticación. Respuesta HTTP 200:

```json
{"status":"ok","service":"whatscommerceec-backend"}
```

Es **liveness**, no readiness: no consulta DB/Redis ni garantiza disponibilidad de integraciones. Las seis rutas de autenticación/contexto se describen más abajo; no hay eventos WebSocket ni otros módulos comerciales. Rutas inexistentes devuelven el error 404 estándar NestJS. `ValidationPipe` global y el parser estricto de autenticación protegen sus respectivos límites de entrada, sin mostrar valores privados.

`CORS_ORIGINS` permite orígenes HTTP(S) exactos separados por comas, sin path, credenciales ni wildcard; por defecto `http://localhost:5173`. Las respuestas no habilitan credenciales CORS. Un origen no autorizado no recibe cabeceras de autorización CORS; CORS no sustituye autenticación ni permisos de servidor.

## Organización

- `src/modules/health`: módulo técnico de liveness.
- `src/config`: validación tipada del entorno, sin valores en errores.
- `src/configure-app.ts`: prefijo, CORS, pipe y shutdown compartidos.
- `prisma/` y `prisma.config.ts`: diez modelos aprobados y SQL revisable; aplicación SQL directa autorizada exclusivamente en el entorno DEV aislado, no migraciones Prisma automáticas.
- `test/`: pruebas HTTP incluyendo una ruta de validación exclusiva de pruebas.

Los módulos futuros separarán dominio, aplicación y adaptadores según casos aprobados; no se generan capas vacías ni modelos tentativos. No crear roles, estados ni reglas de aislamiento sin aprobación.

## Persistencia y tareas: separación de ejecución

Prisma 7 usa `prisma.config.ts` para la URL. Validate/generate no requieren DB activa; para no cargar `.env` usar `--config scripts/prisma-offline.config.ts`. El cliente se genera en `src/generated/prisma` (ignorado). AuthRuntime construye clientes con pools restringidos por ámbito y de forma diferida, no al boot. El script separado `check:infra` conserva su chequeo bootstrap `SELECT 1`; no es un adaptador de autenticación.

### Histórico: entrega 1.4a — modelos y SQL antes de aplicación autorizada

`prisma/schema.prisma` contiene las diez entidades aprobadas en DERCAS §16.10. En el corte 1.4a se prepararon cuatro SQL de roles NOLOGIN, tablas, restricciones y RLS cerrado por defecto, todavía sin aplicar ni añadir endpoints. La aplicación posterior y sus evidencias se distinguen en el estado operativo de este README; no convierten el arranque de health en readiness.

Consultar [prisma/sql/README.md](prisma/sql/README.md) para orden, límites y comprobaciones offline. Contexto A y funciones/proyecciones acotadas se incorporaron posteriormente con SQL004 y sus adaptadores. No usar `db push` ni migraciones automáticas: Prisma no representa todos los CHECK, triggers, privilegios, políticas ni diferibilidad complementarios.

BullMQ está instalado y `REDIS_URL` está validada si se proporciona. No hay Queue/Worker ni conexiones automáticas; la primera cola y sus políticas de reintento/idempotencia requieren un caso aprobado. No hay WhatsApp, pasarela de pago ni trabajos ficticios.

## Servicios locales opcionales — Subfase 1.2

Preparación técnica para RNF-01/RNF-04: **los comandos de esta sección no aceptan RF-01/RF-02 ni crean tablas, migraciones, políticas RLS, roles o jobs**. Los modelos y artefactos posteriores se describen en la entrega 1.4a. `GET /api/health` sigue siendo liveness y Nest no conecta al arrancar. No hace falta detener/reiniciar la API para estas comprobaciones.

### Procedimiento ordenado (responsable local autorizado)

Desde la raíz de este checkout, con Node/npm de las versiones indicadas y Docker Desktop/Engine **local** activo:

```text
npm ci
npm run setup:local
npm run prisma:validate
npm run prisma:generate
npm run prisma:sql:check
npm run check:persistence
npm run test:persistence
npm run infra:up
npm run infra:status
npm run check:infra
```

En ejecución coordinada por agentes, **MAIN es el único responsable de ejecutar setup:local e infra:up**. Los comandos no se ejecutan como parte de install, dev, build ni tests.

- `setup:local` exige que `.env` esté ignorado/no rastreado por Git; lo crea con escritura exclusiva (`wx`), secreto PostgreSQL aleatorio de 32 bytes (256 bits), usuario/base `whatscommerceec_dev`, `NODE_ENV=development`, PostgreSQL `127.0.0.1:5432`, Redis `127.0.0.1:6379`, API 3000 y CORS `http://localhost:5173`. No imprime el secreto ni URLs. Solicita modo de archivo 0600; en Windows revisar ACL/permisos locales: ese modo no sustituye las ACL.
- Si `.env` ya existe, se conserva **byte por byte**, incluso si es inválido; no se rotan credenciales ni se tocan volúmenes. `NODE_ENV` del shell, si existe, debe ser `development`. `.env.example` contiene solo placeholders y no es configuración operativa.
- `infra:up` usa `docker compose up -d --wait --wait-timeout 120` y requiere Compose v2 con `--wait`. No hace fallback que oculte fallos. `infra:status` usa `docker compose ps`. Ambos validan el entorno y rechazan endpoints Docker remotos (solo socket Unix/named pipe local); errores Docker se capturan y no se vuelcan crudos. Ninguno borra datos.
- `check:infra` es standalone: valida configuración **explícita DEV/local** antes de construir clientes. Rechaza production/test, remotos, puertos distintos de 5432/6379, usuarios/bases sin sufijo `_dev`, placeholders, secretos de menos de 32 caracteres y desacuerdos entre URL y variables Compose. Solo permite parámetro PostgreSQL `schema=public`; rechaza overrides de host/socket. `localhost` se normaliza a `127.0.0.1` sin DNS.
- Redis del Compose es sin autenticación, exclusivamente loopback (no usarlo en una máquina multiusuario no confiable). El chequeo acepta solo DB Redis 0 sin credenciales/parámetros. No usa BullMQ ni crea claves.
- El script ejecuta `SELECT 1 AS ok` **mediante Prisma Client 7.10.1 y adapter oficial `@prisma/adapter-pg` 7.10.1**, y Redis `PING` esperando `PONG`. Éxito solo después de cerrar clientes. Salida 0 si ambos pasan; 1 si hay error, timeout o cierre fallido, sin volcar errores originales. Se intentan ambas comprobaciones aun si falla una.
- Timeouts: conexión/comando 3 s, consulta pg 3–3.5 s, cada probe/cierre 5 s, límite global del proceso 25 s. Redis no reintenta; `finally` desconecta Redis y Prisma/pool pg. No dejar el script como servicio.
- Las variables del shell prevalecen sobre `.env` como en Compose: si hay configuración heredada, quitarla explícitamente y reintentar; el loader no sobrescribe `process.env`. No ejecutar `docker compose config` sin `--quiet`, ni compartir `.env`, URLs, errores crudos o logs con credenciales.

### Volumen y privilegios: no resetear

`compose.yaml` conserva PostgreSQL 17/Redis 7 y puertos **solo en 127.0.0.1**. PostgreSQL guarda datos en `postgres_data`. `POSTGRES_USER`, `POSTGRES_DB` y `POSTGRES_PASSWORD` se aplican **solo en la primera inicialización del volumen**: editar/recrear `.env` no modifica la contraseña persistida. Por eso no borrar `.env` para “arreglar” autenticación ni regenerar secretos. Recuperar la configuración local original o coordinar una modificación administrativa explícita; no ejecutar `down -v`, `volume rm`, reset ni migraciones destructivas.

El usuario inicial de la imagen PostgreSQL tiene privilegios administrativos/superusuario. Se usa **únicamente para este bootstrap DEV y su chequeo**, no autoriza usarlo como runtime empresarial. Antes del dominio hay que aprobar y separar credenciales/roles de administración, migraciones y ejecución restringida sin superusuario/BYPASSRLS, y verificar RLS con el rol efectivo (DERCAS 11.8). Este éxito no prueba aislamiento ni seguridad de negocio.

### Troubleshooting sin cambios al sistema operativo

1. **Docker no responde:** abrir Docker Desktop y esperar a que el Engine local esté listo; revisar su estado y `docker context show`. Si el contexto apunta a remoto, seleccionar el local autorizado antes de repetir. El script no instala ni configura Docker/WSL.
2. **WSL/backend no disponible:** revisar el diagnóstico de Docker Desktop y `wsl --status` con el responsable de la máquina. No instalar distribuciones, habilitar características de Windows ni modificar WSL/virtualización automáticamente.
3. **Compose no admite `--wait`:** actualizar Docker Desktop/Compose con autorización del responsable; `infra:up` falla de forma cerrada. No confundir un proceso iniciado con servicios saludables.
4. **Puerto ocupado:** identificar su propietario con herramientas locales de solo lectura. No detener servicios ajenos; coordinar el conflicto antes de continuar (esta receta fija 5432/6379).
5. **PostgreSQL rechaza autenticación:** comprobar de forma privada la coherencia de `.env` y variables del shell con las credenciales originales del volumen. No imprimir valores ni borrar volúmenes. `pg_isready` de Compose no valida la contraseña: la comprobación Prisma es necesaria.
6. **Cliente Prisma ausente:** repetir `npm ci` y `npm run prisma:generate`; no crear modelos ni tablas ficticias. Si el chequeo falla, la API/health puede seguir funcionando porque es liveness independiente.

### Dependencias y evidencia

Se declaran directamente `pg` 8.16.3 y `ioredis` 5.8.2 (compatible con Redis 7 y la línea ya usada por BullMQ), y adapter 7.10.1 igual al cliente/CLI Prisma. `@types/pg` 8.23.1 se alinea con los tipos del adapter para evitar dos definiciones incompatibles de Pool. `tsx` 4.20.6 es solo loader de scripts TS y del cliente generado, no reemplaza `tsc-watch`/decoradores Nest. El lockfile fija dependencias; no se hizo actualización masiva ni auditoría de red prolongada.

Fuentes técnicas: [Prisma PostgreSQL/adapter y timeouts](https://www.prisma.io/docs/orm/overview/databases/postgresql), [ioredis: conexión, eventos y retryStrategy](https://github.com/redis/ioredis/tree/v5#connect-to-redis).

`npm run test:infra` ejecuta pruebas sin servidores: configuración local/no remota, placeholders, redacción, creación de archivo de prueba sin overwrite, preservación de archivo inválido, overrides del shell, fakes explícitos de probes con fallos y timeouts/cierres. Esas pruebas crean y borran exclusivamente fixtures bajo `node_modules`; **no crean el `.env` operativo**, no arrancan contenedores y no prueban conectividad real. MAIN debe registrar separadamente el resultado real de `check:infra`.

Verificación del especialista (5 de noviembre de 2026): typecheck, lint, build, 55 pruebas unitarias (incluidas 34 de herramientas locales), 11 e2e HTTP y Prisma validate/generate correctos. No ejecutó setup operativo, arranque de contenedores ni conexión real; esas tres acciones quedan a cargo de MAIN. No se auditaron redes ni se modificó Compose.

Verificación posterior del coordinador: se creó `.env` DEV con secreto aleatorio, ignorado por Git y sin imprimir sus valores; repetir setup lo conservó byte por byte. `infra:up` terminó correctamente y `infra:status` mostró PostgreSQL y Redis saludables en `127.0.0.1:5432/6379`. `check:infra` ejecutó Prisma `SELECT 1` y Redis `PING/PONG` reales, cerrando conexiones. PostgreSQL tiene montado el volumen `whatscommerceec-local_postgres_data`. No se crearon tablas de negocio ni se ejecutaron migraciones.

Los CLI resuelven el checkout y su `.env` desde su propia ubicación, no desde un directorio de trabajo accidental. Los comandos Compose fijan el archivo absoluto y el nombre `whatscommerceec-local` para no operar sobre otro proyecto por overrides `COMPOSE_*`. Dos pruebas adicionales cubren ese alcance: el total pasó a 57 unitarias (36 de herramientas locales), además de 11 e2e. El rol administrativo DEV y estas pruebas no acreditan RLS empresarial ni despliegue productivo.

## Verificación

```text
npm run typecheck
npm run lint
npm run build
npm test
npm run test:e2e
npm run test:infra
npm run prisma:validate
npm run prisma:generate
```

Lint no modifica archivos. NestJS 12 es ESM; se usa NodeNext y Jest con `--experimental-vm-modules` en Node 22 (emite una advertencia experimental). Las pruebas cubren contrato health, configuración válida/inválida, errores HTTP, CORS y DTO global; no verifican persistencia, multi-tenancy, integraciones ni concurrencia de negocio todavía inexistentes.

Versiones principales fijadas: NestJS 12.3.3 (Config 12.1.0), Prisma 7.10.1 estable, BullMQ 6.6.0, TypeScript 5.9.3, Jest 30.5.2, ts-jest 29.4.15 y ESLint 10.14.0. El lockfile fija las transitivas. No actualizar Prisma al tag latest mientras apunte a Prisma 8 RC. La auditoría de dependencias de desarrollo puede reportar avisos de Jest/ESLint; revisar antes de CI y no aplicar `audit fix --force` ni overrides incompatibles sin evaluación.

### Resultado del bootstrap (4 de noviembre de 2026)

- `npm install` y posterior `npm ci` completados con lockfile reproducible.
- Typecheck, lint y build correctos; 21 pruebas unitarias y 11 HTTP aprobadas.
- Prisma validate/generate correctos sin DB activa, incluso con esquema sin modelos.
- Smoke real del servidor compilado y del comando de desarrollo: health HTTP 200 en puerto 3000 sin DB/Redis; procesos detenidos al finalizar.
- Arranque con configuración inválida: salida 1 y mensaje sanitizado, sin imprimir credenciales de prueba.
- `docker compose config --quiet` correcto con variables locales temporales; no se inició Docker Engine ni contenedores.
- `npm audit --omit=dev`: 0 vulnerabilidades. Auditoría completa: 30 avisos de desarrollo (4 bajos, 26 moderados), pendientes de evaluación; no se aplicaron correcciones forzadas.

No se verificaron conexiones reales de PostgreSQL/Redis, migraciones, integración de clientes móvil/web ni comportamiento productivo. El harness de una comprobación agrupada agotó su timeout después de imprimir todos los resultados; la ejecución anterior completa y el smoke final independiente terminaron correctamente.

Verificación posterior del orquestador: tipos, lint, build, 21 pruebas unitarias, 11 HTTP y Prisma validate/generate volvieron a pasar. Desde AdminWeb, `npm run integration:workspace` comprobó health con el cliente web en Edge, el cliente TypeScript puro del móvil bajo Node y CORS permitido/no permitido contra NestJS real; todos pasaron. No ejecuta UI nativa, DB/Redis ni casos empresariales. La auditoría productiva volvió a reportar cero; las repeticiones de auditoría completa agotaron el timeout, por lo que se conserva el resultado previo de 30 avisos de tooling sin presentarlo como una revisión nueva aprobada.

## Fuentes y siguientes decisiones

### Subfase 1.4 — entrega parcial de identidad (6 de noviembre de 2026)

**No es aceptación funcional de RF-02/RNF-02.** Las seis rutas previstas
(`POST auth/login`, `auth/refresh`, `auth/logout`, `GET auth/me`, `me/companies`,
`companies/:companyId`, todas bajo `/api`) están conectadas al servicio y a sus puertos.
Con `AUTH_ENABLED=false` (predeterminado) responden **503** sanitizado y `no-store`.
No hay modo mock runtime ni se reutiliza `DATABASE_URL` administrativa. Health conserva
su liveness independiente; los clientes de persistencia/Redis se construyen de forma
diferida solo al solicitar autenticación explícitamente habilitada, no al boot.

`src/modules/auth/auth.service.ts` coordina
credencial/dummy hash, firma, refresh y logout mediante puertos. El puerto de rotación
exige una transacción que confirme revocación por reutilización antes de retornar un
resultado de error. La excepción HTTP debe ocurrir fuera de esa transacción. Logout
intenta revocar incluso si el límite Redis falla. Los adaptadores deben conservar
históricos y el vencimiento absoluto de siete días; el servicio no los extiende.

Criptografía ejecutable: Argon2id 64 MiB/3/p1, sal 16 bytes/salida 32, JWT HS256
con verificación de firma y claims antes de clasificar expiración, refresh aleatorio
32 bytes/base64url y SHA-256 separado por propósito. IDNA usa `domainToASCII` de Node22,
rechazo de delimitadores URL y validación DNS. Parámetros Argon2 medidos sintéticamente
antes de adoptarlos: hash+verify 312/269/237 ms (tres muestras, Node22.18.0, máquina local;
no es un benchmark bajo carga ni una garantía de capacidad).

Dependencias fijadas: `argon2@0.45.2` (nativo Windows/Node22 probado) y `jose@6.2.15`
(ESM/WebCrypto), revisadas en npm y README oficiales. No actualización masiva.
La instalación agotó el timeout de la herramienta, pero paquetes/importaciones y
lockfile quedaron disponibles y las pruebas ejecutan sus implementaciones reales.

Preparados por el coordinador: parser JSON 16 KiB que detecta duplicados antes de perderlos,
rechazo de campos desconocidos/protegidos, errores sanitizados, cuotas Redis mediante Lua
y ventanas móviles, claves de cuota HMAC sin correo/IP en claro y cursor AES-GCM de quince
minutos ligado a identidad/sesión y colección. Pruebas Redis usan evaluador simulado; no
acreditan ventanas compartidas reales.

### Habilitación explícita, no ejecutada por esta entrega

`AUTH_ENABLED=true` exige URLs `AUTH_IDENTITY_DATABASE_URL` y `AUTH_TENANT_DATABASE_URL`
con usuarios `wc_identity`/`wc_tenant`, Redis configurado y tres claves diferentes de 32
bytes base64url canónico: `AUTH_JWT_KEY`, `AUTH_CURSOR_KEY`, `AUTH_RATE_LIMIT_KEY`.
No hay fallback al usuario de Compose. Configuración incompleta aborta con el nombre de
la variable, nunca su valor. Producción no está autorizada en este incremento y se rechaza.
La plantilla `.env.example` mantiene auth deshabilitada; no se modificó `.env` operativo.

Los adaptadores Prisma identity/tenant y `prisma/sql/004_auth_context.sql` están preparados
para revisión; sus detalles están en `src/modules/auth/persistence/README.md`.
La revisión estática conjunta e independiente no identificó bugs adicionales de SQL004;
eso no acredita sintaxis/ejecución ni seguridad efectiva PostgreSQL.
Antes de habilitarlo falta aplicar SQL y aprovisionar roles LOGIN
con autorización separada y probar privilegios/RLS
con roles efectivos. Disponer del interruptor no permite saltar esos pasos ni aceptar la
seguridad empresarial. `schema.prisma` y SQL 000–003 se conservan.

Pruebas del servicio usan puertos **simulados**: no prueban persistencia, concurrencia
PostgreSQL, RLS, cuotas Redis ni aislamiento A/B. Las e2e prueban transporte real, tanto
fail-closed como rutas con puertos simulados; un login exitoso allí no es un login real
contra PostgreSQL. Criptografía/IDNA/cursor sí se ejecutan realmente.
Para Prisma sin cargar `.env`: `npx prisma validate --config scripts/prisma-offline.config.ts`
y `npx prisma generate --config scripts/prisma-offline.config.ts` (solo artefactos locales).

Verificación del primer corte del especialista: typecheck, lint, build, **103 unitarias y 18 e2e** correctos;
Prisma validate/generate offline, `prisma:sql:check` y `check:persistence` correctos.
No se conectó PostgreSQL/Redis, no se ejecutó SQL ni migraciones ni se crearon roles/cuentas.
No se verificaron RLS, concurrencia real, selector, BASIC/FULL o integración móvil.

Verificación posterior del coordinador con transporte y adaptadores preparados:
typecheck, lint y build correctos, **144 unitarias y 31 e2e HTTP** aprobadas. Se añadieron
regresiones de rutas con mayúsculas, parte local Unicode que se convertía en ASCII y
fallos de contraseña rechazados antes del lookup. Adaptadores usan Prisma simulado y
SQL004 tiene controles textuales; ninguna de esas pruebas demuestra PostgreSQL/RLS,
concurrencia o cuotas Redis efectivos. Auth está deshabilitada por defecto; no se modificó
la configuración privada ni se aplicó SQL.


Consultar `AGENTS.md` local, `../AGENTS.md` y `../docs/DERCAS.md` en el workspace coordinado. El Word de `../Contexto/` es antecedente histórico. Mantener cambios de documentación compartida en el orquestador.

La estrategia de tablas compartidas + autorización backend + RLS está aprobada en `../docs/DERCAS.md` 11.8 y refinada en §16. Esta entrega prepara modelos, SQL de base y autenticación/contexto mínimos, sin ejecución autorizada de SQL ni aceptación funcional. Siguen pendientes pruebas PostgreSQL/Redis y móvil reales y las operaciones de registro/invitaciones de la siguiente entrega. No se realizaron commits, push ni PR; el checkout inicial conserva la rama unborn `feature/estructura-inicial` sin `develop` hasta la decisión del propietario sobre publicación.

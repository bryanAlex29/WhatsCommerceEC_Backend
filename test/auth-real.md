# Aceptación real auth — DEV aislada

Runner revisado y ejecutado por el coordinador contra el cluster DEV aislado autorizado.
Su autor inicial no lo ejecutó; la continuidad posterior añadió casos y corrigió el runner.
Solo ejecutar tras aprovisionamiento explícitamente autorizado del cluster DEV aislado.
No crea infraestructura, roles ni administrador humano; no aplica SQL ni borra filas.

Requisitos: Node 22, dependencias instaladas, SQL 000–004 revisado/aplicado por el
responsable, perfiles privados `.env.auth-admin` y `.env.auth-dev` en raíz backend.
No se lee `.env`, no hay fallback a servicios anteriores. URLs estrictamente
`127.0.0.1:55432/whatscommerceec_auth_dev`, admin `wc_migrator_dev`, runtime
`wc_identity`/`wc_tenant`; Redis `127.0.0.1:16379` DB 0.

El AppModule debe estar configurado por el responsable para ese perfil privado.
Se importa **dinámicamente después** de cargar el perfil en memoria. Se usa el
build para preservar metadatos de inyección Nest que `tsx` no emite. El runner
es CLI `tsx`; no necesita ni detiene una aplicación existente en puerto 3000.

```sh
npm run build
npm run test:auth:real
```

El comando `test:auth:real` ejecuta `tsx test/auth-real.ts`. Recompilar
tras cada cambio de producción antes de ejecutar (no usar un `dist` antiguo).

Cada ejecución inserta dos identidades sintéticas (misma contraseña aleatoria
solo en memoria), dos empresas y dos pertenencias iniciales exclusivamente con admin y
valores parametrizados. No crea PlatformAdmin. Confirma el fixture para que las
conexiones runtime lo vean. **Conserva las filas y sus estados finales**, incluidas
empresas suspendidas y rol degradado, según retención DEV; no realiza purga.
El UUID impreso identifica el fixture mediante su nombre comercial sintético.

La prueba de paginación agrega otras 21 empresas y pertenencias sintéticas nuevas.

21 casos: login indistinguible, identidad, parser/16 KiB, JWT ausente/inválido,
expiración/firma, selector, BASIC/FULL, ajeno/inexistente, permisos/estado vigentes,
logout, rotación/reutilización/carrera, logout histórico, roles SQL efectivos,
contaminación de pool Prisma real de máximo uno, cuotas Lua con Redis real y
fallo de conexión Redis local con revocación PostgreSQL pese al 503, paginación 20+2
con cursor ligado a sesión, cliente TypeScript móvil contra HTTP/DB reales y cuota HTTP
`429` con `Retry-After`.
Las cuotas usan claves HMAC efímeras separadas; no FLUSH ni borrado global.
Las cuotas se verifican por adaptador real y un caso HTTP de fallos de login/Retry-After.
El fallo Redis usa un cliente ioredis cerrado, sin mocks ni detener Redis; no
acredita una caída de red real ni una respuesta HTTP 503 del controlador.
El cliente móvil usa su `Session`/transporte reales bajo Node y solo un almacenamiento
seguro en memoria para esa prueba. No acredita SecureStore nativo, pantalla en Android/iOS
ni lectores de pantalla. Invitaciones y registro empresarial siguen en su entrega propia.

Solo imprime contador PASS y UUID; fallos con etiqueta de caso y código seguro,
nunca cuerpos HTTP, correos, passwords, URLs privadas, SQL, tokens ni stacks.
Timeout global 60 s; solicitudes 5 s y conexión PG 3 s. Cierra aplicación,
Prisma, pools y Redis al finalizar; no limpia infraestructura ni registros.

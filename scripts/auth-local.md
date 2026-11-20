# Autenticación DEV local aislada

Puesta en marcha autorizada por el propietario tras la entrega de código de Subfase 1.4.
No usar en producción ni contra el cluster/volumen original. No hay reset ni eliminación
de datos. El único responsable operativo es el coordinador o el propietario local.

```text
npm run auth:setup:local
npm run build
npm run test:auth:real
npm run auth:bootstrap:local
npm run dev
```

- `auth:setup:local` valida Docker local y Git, crea perfiles **solo si ambos faltan**,
  levanta el proyecto `whatscommerceec-auth-dev`, comprueba contenedores/puertos/volumen
  propios y aplica SQL000–004 en una transacción. No modifica `.env` ni el Compose original.
- PostgreSQL 17: `127.0.0.1:55432`, base `whatscommerceec_auth_dev`; Redis 7:
  `127.0.0.1:16379`. No se publican estos servicios en LAN.
- `.env.auth-admin` contiene la credencial administrativa exclusiva para herramientas.
  `.env.auth-dev` contiene **solo** pools runtime restringidos, claves independientes y
  configuración API. Ambos están ignorados y nunca se imprimen. Windows: revisar ACL
  locales; solicitar modo 0600 no sustituye las ACL del sistema.
- El bootstrap/API original no se mezcla con este perfil. Al existir `.env.auth-dev`,
  el arranque DEV carga ese archivo y **no** `.env` ni `.env.auth-admin`. Tests unitarios
  con `NODE_ENV=test` no cargan perfiles operativos.
- Setup conserva los perfiles existentes byte por byte. `wc_ops.receipt` registra SHA-256
  de los cinco SQL bajo ownership administrativo. Repetir setup comprueba ese recibo y no
  vuelve a crear las tablas. No editar archivos SQL ya aplicados ni actualizar el recibo
  para ocultar diferencias; un cambio posterior requiere un procedimiento revisado.
- `auth:bootstrap:local` debe ejecutarlo el propietario en una consola TTY privada.
  Muestra el correo mientras se introduce y enmascara contraseña/confirmación con
  **asteriscos**, según la preferencia del propietario; no admite credenciales por
  argumentos ni crea valores predeterminados. Contraseña: 15–128 puntos de código,
  mayúscula y símbolo, sin espacios/controles/invisibles. Crea solo identidad/plataforma.
  Los números están admitidos, pero no son obligatorios y no reemplazan los requisitos
  de longitud, mayúscula y símbolo. El comando no cambia la contraseña de una cuenta existente.
  Rechaza si ya existe administrador o el correo pertenece a otra identidad; no promueve
  ni sobrescribe cuentas. No crea empresas/pertenencias.
- `test:auth:real` usa cuentas aleatorias sintéticas solo en memoria. Conserva sus filas
  identificadas `SYNTHETIC`, no crea PlatformAdmin ni roba el puesto del administrador
  humano. Ver `test/auth-real.md`. Una ejecución exitosa no acredita UI nativa.
- Si falla setup, el mensaje está sanitizado. No imprimir perfiles, `docker inspect` crudo,
  `docker compose config` ni logs con valores privados. No borrar perfiles o volúmenes
  para recuperar autenticación. Si existe un par parcial o checksum distinto, detenerse
  y revisar, sin adoptar datos/roles ajenos.

La API escucha en puerto 3000. Para móvil físico, Metro debe usar la IP LAN actual mediante
`EXPO_PUBLIC_API_URL`; cambiar de red puede cambiar esa IP. La autenticación se ejecuta en
backend con roles efectivos, no mediante permisos concedidos por la interfaz.

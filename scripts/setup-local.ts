import { setupLocal } from './setup-local-core.js';
import { fileURLToPath } from 'node:url';

try {
  const result = setupLocal(fileURLToPath(new URL('../', import.meta.url)));
  console.log(result === 'created'
    ? '.env DEV creado e ignorado por Git. No se iniciaron servicios.'
    : '.env ya existe: conservado sin cambios. No se rotaron credenciales ni volúmenes.');
} catch {
  console.error('setup:local falló: use development, compruebe Git ignore y permisos locales. No se muestran secretos.');
  process.exitCode = 1;
}

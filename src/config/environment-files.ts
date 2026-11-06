import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bootstrapFile = fileURLToPath(new URL('../../.env', import.meta.url));
const authFile = fileURLToPath(new URL('../../.env.auth-dev', import.meta.url));

/** El perfil runtime no carga el archivo administrativo ni el bootstrap con superusuario. */
export function environmentFiles(nodeEnv = process.env.NODE_ENV, hasAuthProfile = existsSync(authFile)): string[] {
  if (nodeEnv === 'test') return [];
  if (nodeEnv !== 'production' && hasAuthProfile) return [authFile];
  return [bootstrapFile];
}

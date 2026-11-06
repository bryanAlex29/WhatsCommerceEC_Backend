import { resolve } from 'node:path';

// Las opciones explicitas tienen prioridad sobre overrides COMPOSE_* de la shell.
export function localComposeBaseArgs(directory: string): string[] {
  return ['compose', '--file', resolve(directory, 'compose.yaml'), '--project-name', 'whatscommerceec-local'];
}

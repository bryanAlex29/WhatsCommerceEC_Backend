import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { applySql, gate, loadProfiles, project, safeError, sqlBundle } from './auth-local-core.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function docker(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
}
export function localDockerEnvironment(): NodeJS.ProcessEnv {
  // Never permit shell/environment overrides to redirect the engine or Compose.
  gate(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT && !process.env.DOCKER_TLS_VERIFY && !process.env.DOCKER_CERT_PATH);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(COMPOSE_|POSTGRES_|AUTH_)/.test(key)) delete env[key];
  return env;
}
interface Inspection {
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: { Type: string; Name?: string; Destination: string }[];
  HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> };
}
export function validateContainer(container: Inspection, service: 'postgres' | 'redis'): void {
  gate(container.Config.Labels['com.docker.compose.project'] === project && container.Config.Labels['com.docker.compose.service'] === service);
  gate(container.Config.Image === (service === 'postgres' ? 'postgres:17-alpine' : 'redis:7-alpine'));
  const port = service === 'postgres' ? '5432/tcp' : '6379/tcp';
  const bindings = container.HostConfig.PortBindings;
  gate(Object.keys(bindings).length === 1 && bindings[port]?.length === 1);
  gate(bindings[port]![0]?.HostIp === '127.0.0.1' && bindings[port]![0]?.HostPort === (service === 'postgres' ? '55432' : '16379'));
  if (service === 'postgres') gate(container.Mounts.length === 1 && container.Mounts[0]?.Type === 'volume' &&
    container.Mounts[0]?.Name === `${project}_postgres_data` && container.Mounts[0]?.Destination === '/var/lib/postgresql/data');
}
export async function setup(): Promise<void> {
  const env = localDockerEnvironment();
  const context = JSON.parse(docker(['context', 'inspect'], env)) as { Endpoints?: { docker?: { Host?: string } } }[];
  const endpoint = context[0]?.Endpoints?.docker?.Host;
  gate(context.length === 1 && endpoint && /^(unix:\/\/\/|npipe:\/\/\/)/.test(endpoint));
  // Profiles must never be tracked, including on an unborn branch.
  const tracked = execFileSync('git', ['ls-files', '--', '.env.auth-admin', '.env.auth-dev'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gate(!tracked.trim());
  const ignored = execFileSync('git', ['check-ignore', '--', '.env.auth-admin', '.env.auth-dev'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gate(ignored.trim().split(/\r?\n/).length === 2);
  const profiles = loadProfiles(root, true);
  const bundle = sqlBundle(root);
  const volumes = JSON.parse(docker(['volume', 'ls', '--format', 'json'], env).trim().split(/\r?\n/).filter(Boolean).map(line => line).length
    ? `[${docker(['volume', 'ls', '--format', 'json'], env).trim().split(/\r?\n/).filter(Boolean).join(',')}]` : '[]') as { Name: string }[];
  if (volumes.some(volume => volume.Name === `${project}_postgres_data`)) {
    const inspected = JSON.parse(docker(['volume', 'inspect', `${project}_postgres_data`], env)) as { Labels?: Record<string, string> }[];
    gate(inspected[0]?.Labels?.['com.docker.compose.project'] === project && inspected[0]?.Labels?.['com.docker.compose.volume'] === 'auth_postgres_data');
  }
  const compose = ['compose', '--env-file', resolve(root, '.env.auth-admin'), '-f', resolve(root, 'compose.auth-dev.yaml'), '-p', project];
  // Existing containers bearing these names must already belong to this project.
  const containers = docker(['ps', '-a', '--format', '{{.Names}}'], env).trim().split(/\r?\n/);
  for (const service of ['postgres', 'redis'] as const) {
    const name = `${project}-${service}-1`;
    if (containers.includes(name)) validateContainer((JSON.parse(docker(['inspect', name], env)) as Inspection[])[0]!, service);
  }
  docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '90'], env);
  for (const service of ['postgres', 'redis'] as const) {
    const id = docker([...compose, 'ps', '-q', service], env).trim();
    gate(/^[a-f0-9]{12,64}$/.test(id));
    validateContainer((JSON.parse(docker(['inspect', id], env)) as Inspection[])[0]!, service);
  }
  const client = new Client({ connectionString: profiles.admin.AUTH_DEV_ADMIN_URL, connectionTimeoutMillis: 5000 });
  try { await client.connect(); await applySql(client, profiles, bundle); }
  finally { await client.end().catch(() => undefined); }
  console.log('AUTH_DEV_SETUP_OK (sin cuenta humana)');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== 'setup') { console.error('Uso: tsx scripts/auth-local.ts setup'); process.exitCode = 1; }
  else await setup().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}

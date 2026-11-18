import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bootstrapFile = fileURLToPath(new URL('../../.env', import.meta.url));
const authFile = fileURLToPath(new URL('../../.env.auth-dev', import.meta.url));
const recoveryFile = fileURLToPath(new URL('../../.env.recovery-dev', import.meta.url));
const gmailFile = fileURLToPath(new URL('../../.env.gmail-api-dev', import.meta.url));
const companiesFile = fileURLToPath(new URL('../../.env.companies-dev', import.meta.url));

/** El perfil runtime no carga el archivo administrativo ni el bootstrap con superusuario. */
export function environmentFiles(nodeEnv = process.env.NODE_ENV, hasAuthProfile = existsSync(authFile), hasRecoveryProfile = existsSync(recoveryFile), hasGmailProfile = existsSync(gmailFile), hasCompaniesProfile = existsSync(companiesFile)): string[] {
  if (nodeEnv === 'test') return [];
  if (nodeEnv !== 'production' && hasCompaniesProfile && !hasAuthProfile) throw new Error('Configuración inválida: COMPANIES_ENABLED');
  if (nodeEnv !== 'production' && hasAuthProfile) {
    if (hasGmailProfile && !hasRecoveryProfile) throw new Error('Configuración inválida: RECOVERY_ENABLED');
    const files = hasGmailProfile ? [gmailFile, recoveryFile, authFile] : hasRecoveryProfile ? [recoveryFile, authFile] : [authFile];
    return hasCompaniesProfile ? [companiesFile, ...files] : files;
  }
  return [bootstrapFile];
}

/** DEV launcher using explicit existing profiles, without copying them into this checkout. */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateSource } from './recovery-dev-preflight.js';
import { recoveryConfig } from './recovery-config.js';
import { platformProfile } from './companies-local.js';
import { validateEnvironment } from '../src/config/environment.js';
import { gate } from './auth-local-core.js';

async function launch(): Promise<void> {
  const [flag,source,port,...extra]=process.argv.slice(2);
  gate(source && !extra.length && ['--check','--serve'].includes(flag ?? '') && ['3000','3001'].includes(port ?? ''));
  const profileRoot=resolve(source); validateSource(profileRoot);
  const {config:recovery}=recoveryConfig(profileRoot,false);
  const config=validateEnvironment({...recovery,CORS_ORIGINS:recovery.CORS_ORIGINS.join(','),
    ...platformProfile(readFileSync(resolve(profileRoot,'.env.companies-dev'),'utf8')),INVITATIONS_ENABLED:'false',PORT:port});
  gate(config.NODE_ENV==='development' && config.AUTH_ENABLED && config.RECOVERY_ENABLED && config.COMPANIES_ENABLED && !config.INVITATIONS_ENABLED && config.RECOVERY_MAIL_TRANSPORT==='smtp');
  if(flag==='--check') {console.log('RECOVERY_API_CONFIG_OK explicitProfiles=true smtpPreserved=true invitationsDisabled=true');return;}
  const root=fileURLToPath(new URL('../dist/',import.meta.url));
  const compiled=(file:string)=>import(pathToFileURL(resolve(root,file)).href);
  const [{AuthModule},{CompaniesModule},{HealthModule},{configureApp}]=await Promise.all([
    compiled('modules/auth/auth.module.js'),compiled('modules/companies/companies.module.js'),compiled('modules/health/health.module.js'),compiled('configure-app.js')]);
  class DevModule {}
  Module({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,ignoreEnvVars:true,skipProcessEnv:true,load:[()=>config]}),HealthModule,AuthModule,CompaniesModule]})(DevModule);
  const app=await NestFactory.create(DevModule,{logger:false,bodyParser:false,abortOnError:false});
  try {configureApp(app);await app.listen(config.PORT,config.PORT===3001?'127.0.0.1':'0.0.0.0');}
  catch(error) {await app.close().catch(()=>undefined);throw error;}
  console.log(`RECOVERY_API_DEV_STARTED port=${config.PORT} invitations=false profilesNotCopied=true`);
}
await launch().catch(()=>{console.error('RECOVERY_API_DEV_FAILED; sin detalles privados.');process.exitCode=1;});

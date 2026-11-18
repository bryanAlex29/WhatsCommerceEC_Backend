import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Environment } from './config/environment.js';
import { configureApp } from './configure-app.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
  configureApp(app);
  const config = app.get(ConfigService<Environment, true>);
  await app.listen(config.get('PORT', { infer: true }));
  process.stdout.write('API iniciada\n');
}

void bootstrap().catch(() => {
  process.stderr.write('No se pudo iniciar la API. Revise la configuración y disponibilidad del puerto.\n');
  process.exitCode = 1;
});

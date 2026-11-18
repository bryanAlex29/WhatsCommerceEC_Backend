import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from './config/environment.js';
import { authJsonMiddleware } from './modules/auth/strict-json.js';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Environment, true>);
  app.setGlobalPrefix('api');
  app.use(authJsonMiddleware(config.get('AUTH_ENABLED', { infer: true }) === true));
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
  }));
  app.enableCors({ origin: config.get('CORS_ORIGINS', { infer: true }), credentials: false });
  app.enableShutdownHooks();
}

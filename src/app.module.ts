import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CompaniesModule } from './modules/companies/companies.module.js';
import { environmentFiles } from './config/environment-files.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment,
      envFilePath: environmentFiles(), ignoreEnvFile: process.env.NODE_ENV === 'test' }),
    HealthModule,
    AuthModule,
    CompaniesModule,
  ],
})
export class AppModule {}

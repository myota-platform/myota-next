import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { IdentityMaintenanceModule } from './identity-maintenance.module.js';

const app = await NestFactory.createApplicationContext(
  IdentityMaintenanceModule,
);
app.enableShutdownHooks();

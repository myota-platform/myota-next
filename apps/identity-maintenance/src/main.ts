import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ObserveInstrument } from '@app/platform';
import { IdentityMaintenanceModule } from './identity-maintenance.module.js';

const app = await NestFactory.createApplicationContext(
  IdentityMaintenanceModule,
  {
    instrument: ObserveInstrument,
  },
);
app.enableShutdownHooks();

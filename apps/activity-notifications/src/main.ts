import { NestFactory } from '@nestjs/core';
import { ObserveEventBridge, ObserveInstrument } from '@app/platform';
import { ActivityNotificationsModule } from './activity-notifications.module.js';

const transport = new ObserveEventBridge();
const app = await NestFactory.createMicroservice(
  ActivityNotificationsModule.withObserveTransport(transport),
  {
    logger: ['error', 'warn', 'log'],
    strategy: transport,
    instrument: ObserveInstrument,
  },
);

await app.listen();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}

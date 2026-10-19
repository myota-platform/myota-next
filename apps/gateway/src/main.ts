import { bootstrapHttpService } from '@app/platform';
import { GatewayModule } from './gateway.module.js';

await bootstrapHttpService(GatewayModule, 8080);

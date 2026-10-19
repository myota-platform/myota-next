import { bootstrapHttpService } from '@app/platform';
import { IdentityModule } from './identity.module.js';

await bootstrapHttpService(IdentityModule, 8001);

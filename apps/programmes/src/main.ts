import { bootstrapHttpService } from '@app/platform';
import { ProgrammesModule } from './programmes.module.js';

await bootstrapHttpService(ProgrammesModule, 8002);

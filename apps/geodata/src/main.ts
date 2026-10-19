import { bootstrapHttpService } from '@app/platform';
import { GeodataModule } from './geodata.module.js';

await bootstrapHttpService(GeodataModule, 8003);

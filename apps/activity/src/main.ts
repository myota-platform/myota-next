import { bootstrapHttpService } from '@app/platform';
import { ActivityModule } from './activity.module.js';

await bootstrapHttpService(ActivityModule, 8004);

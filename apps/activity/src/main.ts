import { bootstrapHttpService } from '@app/platform';
import { integerSetting } from '@app/platform/integer-setting.js';
import { ActivityModule } from './activity.module.js';

await bootstrapHttpService(
  ActivityModule,
  8004,
  integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 35 * 1024 * 1024),
  [],
  [],
  false,
  'activity-api',
);

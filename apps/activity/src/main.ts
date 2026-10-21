import { bootstrapHttpService } from '@app/platform';
import { integerSetting } from '@app/platform/integer-setting.js';
import { ActivityModule } from './activity.module.js';

await bootstrapHttpService(
  ActivityModule,
  8004,
  integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 3),
  [],
  [],
  true,
  'activity-api',
  [
    {
      method: 'POST',
      path: '/v1/awards/previews',
      maxBytes: 64 * 1024,
      detail: 'preview design exceeds 64 KiB',
    },
  ],
);

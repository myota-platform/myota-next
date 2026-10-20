import { createObserveModule } from '@nestjs/observe';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

export function observeRoot(serviceId: string) {
  return ObserveModule.forRoot({
    appKey: process.env.OBSERVE_APP_KEY ?? '',
    appSecret: process.env.OBSERVE_APP_SECRET ?? '',
    serviceId,
    serviceVersion:
      process.env.MYOTA_BUILD_VERSION ?? process.env.GIT_SHA ?? undefined,
  });
}

import { createObserveModule } from '@nestjs/observe';
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER, safeRequestId } from './http-problem.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule({
  traceIdGenerator(request: unknown) {
    if (!request || typeof request !== 'object' || !('headers' in request))
      return randomUUID();
    const headers = (request as { headers: Record<string, unknown> }).headers;
    const requestId = safeRequestId(headers[REQUEST_ID_HEADER]) ?? randomUUID();
    headers[REQUEST_ID_HEADER] = requestId;
    return requestId;
  },
});

export function observeRoot(serviceId: string) {
  return ObserveModule.forRoot({
    appKey: process.env.OBSERVE_APP_KEY ?? '',
    appSecret: process.env.OBSERVE_APP_SECRET ?? '',
    serviceId,
    serviceVersion:
      process.env.MYOTA_BUILD_VERSION ?? process.env.GIT_SHA ?? undefined,
  });
}

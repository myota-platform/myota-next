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

export function observeOptions(
  serviceId: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const appKey = environment.OBSERVE_APP_KEY ?? '';
  const appSecret = environment.OBSERVE_APP_SECRET ?? '';
  const endpoint = environment.OBSERVE_ENDPOINT?.trim();
  return {
    enabled: Boolean(appKey.trim() && appSecret.trim()),
    appKey,
    appSecret,
    serviceId,
    forwardLogs: true,
    redaction: { enabled: true },
    ...(endpoint ? { endpoint } : {}),
    serviceVersion:
      environment.MYOTA_BUILD_VERSION ?? environment.GIT_SHA ?? undefined,
  };
}

export function observeRoot(serviceId: string) {
  return ObserveModule.forRoot(observeOptions(serviceId));
}

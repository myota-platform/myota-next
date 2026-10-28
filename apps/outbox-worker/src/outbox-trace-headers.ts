import { headers as createNatsHeaders } from '@nats-io/nats-core';
import {
  REQUEST_ID_HEADER,
  safeRequestId,
} from '@app/platform/http-problem.js';

export function outboxTraceHeaders(correlationId: unknown) {
  const requestId = safeRequestId(correlationId);
  if (!requestId) return undefined;
  const result = createNatsHeaders();
  result.set(REQUEST_ID_HEADER, requestId);
  return result;
}

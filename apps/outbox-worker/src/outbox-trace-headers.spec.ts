import { outboxTraceHeaders } from './outbox-trace-headers.js';

describe('outbox trace headers', () => {
  it('propagates a safe correlation ID as an NATS request ID', () => {
    expect(outboxTraceHeaders('operation-123')?.get('x-request-id')).toBe(
      'operation-123',
    );
  });

  it('omits malformed correlation IDs from NATS headers', () => {
    expect(outboxTraceHeaders('contains spaces')).toBeUndefined();
    expect(outboxTraceHeaders(null)).toBeUndefined();
  });
});

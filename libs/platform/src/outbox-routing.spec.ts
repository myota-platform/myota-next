import { describe, expect, it } from 'vitest';
import {
  loadOutboxRegistry,
  routeOutboxEvent,
  type ClaimedOutboxEvent,
} from './outbox-routing.js';

const accountId = '11000000-0000-4000-8000-000000000001';

const identitySecurityEvents = [
  {
    eventType: 'identity.email-change.cancelled.v1',
    payload: { accountId },
  },
  {
    eventType: 'identity.email-change.completed.v1',
    payload: { accountId },
  },
  {
    eventType: 'identity.email-change.requested.v1',
    payload: { accountId },
  },
  {
    eventType: 'identity.email-change.resent.v1',
    payload: {
      accountId,
      changeId: '11000000-0000-4000-8000-000000000002',
      replacementChangeId: '11000000-0000-4000-8000-000000000003',
    },
  },
  {
    eventType: 'identity.profile-image.deleted.v1',
    payload: { accountId, actorId: accountId },
  },
  {
    eventType: 'identity.profile-image.updated.v1',
    payload: {
      accountId,
      actorId: accountId,
      profileImage: {
        id: '11000000-0000-4000-8000-000000000004',
        contentType: 'image/webp',
        width: 512,
        height: 512,
        updatedAt: '2026-10-28T12:00:00.000Z',
      },
    },
  },
] satisfies Array<Pick<ClaimedOutboxEvent, 'eventType' | 'payload'>>;

describe('Identity security event routing', () => {
  it('registers the Identity security events without consumer groups', async () => {
    const registry = await loadOutboxRegistry();

    expect(
      registry.events
        .filter((event) =>
          identitySecurityEvents.some(
            (expected) => expected.eventType === event.eventType,
          ),
        )
        .map((event) => [event.eventType, event.consumerGroups]),
    ).toEqual(identitySecurityEvents.map((event) => [event.eventType, []]));
  });

  it.each(identitySecurityEvents)(
    'routes $eventType to the registered event stream',
    async ({ eventType, payload }) => {
      const registry = await loadOutboxRegistry();
      const event: ClaimedOutboxEvent = {
        eventId: '22000000-0000-4000-8000-000000000001',
        eventType,
        producer: 'identity',
        aggregateType: 'account',
        aggregateId: accountId,
        payload,
        occurredAt: new Date('2026-10-28T12:00:00.000Z'),
        attempts: 1,
        correlationId: '33000000-0000-4000-8000-000000000001',
      };

      const routed = routeOutboxEvent(event, registry, 'core');

      expect(routed.subject).toBe(`myota.events.${eventType}`);
      expect(routed.stream).toBe('MYOTA_EVENTS');
      expect(routed.envelope).toMatchObject({
        eventType,
        producer: 'identity',
        payload,
      });
    },
  );
});

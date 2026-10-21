import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { connect } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  loadOutboxRegistry,
  type ClaimedOutboxEvent,
} from '../../../libs/platform/src/outbox-routing.js';

const enabled = Boolean(
  process.env.MYOTA_OUTBOX_RECOVERY_TEST === '1' &&
  process.env.OUTBOX_DATABASE_URL &&
  process.env.NATS_TEST_URL,
);

describe.skipIf(!enabled)('outbox broker recovery', () => {
  it('retries a broker failure and publishes the retained event once available', async () => {
    const databaseUrl = process.env.OUTBOX_DATABASE_URL;
    const natsUrl = process.env.NATS_TEST_URL;
    if (!databaseUrl || !natsUrl)
      throw new Error('outbox recovery settings are required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('outbox recovery requires local Postgres');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(natsUrl).hostname)
    )
      throw new Error('outbox recovery requires local JetStream');

    const owner = process.env.OUTBOX_OWNER;
    const eventOwners: Record<string, string[]> = {
      core: ['identity-service', 'programme-service'],
      activity: ['activity-service'],
      geodata: ['geodata-service'],
    };
    const registeredOwners = owner ? eventOwners[owner] : undefined;
    if (!owner || !registeredOwners)
      throw new Error('OUTBOX_OWNER must be core, activity, or geodata');
    const [{ Pool }, { OutboxWorkerService }, registry] = await Promise.all([
      import('pg'),
      import('./outbox-worker.service.js'),
      loadOutboxRegistry(),
    ]);
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const connection = await connect({
      servers: natsUrl,
      name: 'outbox-recovery-test',
    });
    const manager = await jetstreamManager(connection);
    const service = new OutboxWorkerService(pool as Pool);
    const serviceInternals = service as unknown as {
      relay: Pick<ReturnType<typeof jetstream>, 'publish'>;
      claim: () => Promise<ClaimedOutboxEvent | null>;
      publish: (
        event: ClaimedOutboxEvent,
        registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
      ) => Promise<void>;
    };
    const eventId = randomUUID();
    const aggregateId = randomUUID();
    const eventType = registry.events.find((event) =>
      registeredOwners.includes(event.owner),
    );
    const producer = eventType
      ? registry.producerNamesByOwner[eventType.owner]?.[0]
      : undefined;
    if (!eventType || !producer)
      throw new Error(`${owner} fact route is missing from the event registry`);

    let nextPublishError: string | null = 'injected temporary JetStream outage';
    const realRelay = jetstream(connection);
    serviceInternals.relay = {
      publish: async (subject, payload, options) => {
        if (nextPublishError) {
          const error = nextPublishError;
          nextPublishError = null;
          throw new Error(error);
        }
        return await realRelay.publish(subject, payload, options);
      },
    };
    let exhaustedEventId: string | undefined;

    try {
      try {
        await manager.streams.info('MYOTA_EVENTS');
      } catch {
        await manager.streams.add({
          name: 'MYOTA_EVENTS',
          subjects: ['myota.events.>'],
          retention: 'limits',
          storage: 'file',
          num_replicas: 1,
          max_age: 3_600_000_000_000,
          max_bytes: 16 * 1024 * 1024,
          max_msgs: 1000,
          max_msg_size: 1024 * 1024,
        });
      }
      await pool.query(
        `INSERT INTO public.outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at)
         VALUES ($1,$2,$3,'recovery_test',$4,$5::jsonb,now()-interval '100 years')`,
        [
          eventId,
          eventType.eventType,
          producer,
          aggregateId,
          '{"probe":"recovery"}',
        ],
      );

      const firstAttempt = await serviceInternals.claim();
      expect(firstAttempt).toMatchObject({ eventId, attempts: 1 });
      if (!firstAttempt)
        throw new Error('outbox relay did not claim the fixture');
      await serviceInternals.publish(firstAttempt, registry);

      const retryState = await pool.query(
        `SELECT attempts,published_at,last_error,available_at>now() AS delayed
         FROM public.outbox_event WHERE event_id=$1`,
        [eventId],
      );
      expect(retryState.rows[0]).toMatchObject({
        attempts: 1,
        published_at: null,
        last_error: 'injected temporary JetStream outage',
        delayed: true,
      });

      await pool.query(
        'UPDATE public.outbox_event SET available_at=now() WHERE event_id=$1',
        [eventId],
      );
      const retry = await serviceInternals.claim();
      expect(retry).toMatchObject({ eventId, attempts: 2 });
      if (!retry) throw new Error('outbox relay did not reclaim the fixture');
      await serviceInternals.publish(retry, registry);

      const published = await pool.query(
        `SELECT attempts,published_at,last_error
         FROM public.outbox_event WHERE event_id=$1`,
        [eventId],
      );
      expect(published.rows[0]).toMatchObject({
        attempts: 2,
        last_error: null,
      });
      expect(published.rows[0]?.published_at).toBeInstanceOf(Date);

      exhaustedEventId = randomUUID();
      await pool.query(
        `INSERT INTO public.outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,attempts)
         VALUES ($1,$2,$3,'recovery_test',$4,$5::jsonb,now()-interval '100 years',11)`,
        [
          exhaustedEventId,
          eventType.eventType,
          producer,
          randomUUID(),
          '{"probe":"dead-letter-redrive"}',
        ],
      );
      const finalAttempt = await serviceInternals.claim();
      expect(finalAttempt).toMatchObject({
        eventId: exhaustedEventId,
        attempts: 12,
      });
      if (!finalAttempt)
        throw new Error('outbox relay did not claim the exhausted fixture');
      nextPublishError = 'injected exhausted delivery failure';
      await serviceInternals.publish(finalAttempt, registry);

      const deadLetter = await pool.query(
        `SELECT e.attempts,e.published_at,e.last_error,d.error
         FROM public.outbox_event e JOIN public.dead_letter_event d USING (event_id)
         WHERE e.event_id=$1 AND d.resolved_at IS NULL`,
        [exhaustedEventId],
      );
      expect(deadLetter.rows[0]).toMatchObject({
        attempts: 12,
        error: 'injected exhausted delivery failure',
      });
      expect(deadLetter.rows[0]?.published_at).toBeInstanceOf(Date);
      expect(deadLetter.rows[0]?.last_error).toContain('dead-lettered:');

      const redrive = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'tools/outbox-admin.ts',
          'redrive',
          exhaustedEventId,
          '--actor',
          'ci-recovery-test',
          '--reason',
          'Verified owner-scoped event recovery after delivery exhaustion',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, OUTBOX_DATABASE_URL: databaseUrl },
        },
      );
      expect(redrive.error).toBeUndefined();
      expect(redrive.status, redrive.stderr).toBe(0);

      const redriven = await pool.query(
        `SELECT e.attempts,e.published_at,e.last_error,e.available_at<=now() AS ready,
           d.resolved_at,a.actor,a.reason,a.previous_attempts,a.previous_error
         FROM public.outbox_event e
         JOIN public.dead_letter_event d USING (event_id)
         JOIN public.outbox_redrive_audit a USING (event_id)
         WHERE e.event_id=$1`,
        [exhaustedEventId],
      );
      expect(redriven.rows[0]).toMatchObject({
        attempts: 0,
        published_at: null,
        last_error: null,
        ready: true,
        resolved_at: null,
        actor: 'ci-recovery-test',
        reason:
          'Verified owner-scoped event recovery after delivery exhaustion',
        previous_attempts: 12,
        previous_error: 'injected exhausted delivery failure',
      });

      const redriveRetry = await serviceInternals.claim();
      expect(redriveRetry).toMatchObject({
        eventId: exhaustedEventId,
        attempts: 1,
      });
      if (!redriveRetry)
        throw new Error('outbox relay did not reclaim the redriven event');
      await serviceInternals.publish(redriveRetry, registry);
      const resolved = await pool.query(
        `SELECT e.published_at,d.resolved_at,a.previous_attempts
         FROM public.outbox_event e
         JOIN public.dead_letter_event d USING (event_id)
         JOIN public.outbox_redrive_audit a USING (event_id)
         WHERE e.event_id=$1`,
        [exhaustedEventId],
      );
      expect(resolved.rows[0]?.published_at).toBeInstanceOf(Date);
      expect(resolved.rows[0]?.resolved_at).toBeInstanceOf(Date);
      expect(resolved.rows[0]?.previous_attempts).toBe(12);
    } finally {
      const eventIds = [eventId];
      if (exhaustedEventId) eventIds.push(exhaustedEventId);
      await pool.query(
        'DELETE FROM public.outbox_redrive_audit WHERE event_id=ANY($1::uuid[])',
        [eventIds],
      );
      await pool.query(
        'DELETE FROM public.dead_letter_event WHERE event_id=ANY($1::uuid[])',
        [eventIds],
      );
      await pool.query(
        'DELETE FROM public.outbox_event WHERE event_id=ANY($1::uuid[])',
        [eventIds],
      );
      await connection.drain();
      await pool.end();
    }
  }, 30_000);
});

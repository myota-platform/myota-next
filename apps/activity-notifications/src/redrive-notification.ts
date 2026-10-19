import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const STREAM = 'MYOTA_EVENTS';
const SUBJECTS = new Set([
  'myota.events.geodata.entity.reviewed.v1',
  'myota.events.geodata.entity.status-changed.v1',
  'myota.events.identity.account.admin-updated.v1',
  'myota.events.identity.account.created.v1',
  'myota.events.identity.account.deactivated.v1',
  'myota.events.identity.bootstrap-admin.created.v1',
  'myota.events.identity.callsign.added.v1',
  'myota.events.identity.callsign.evidence-submitted.v1',
  'myota.events.identity.callsign.primary-changed.v1',
  'myota.events.identity.callsign.retired.v1',
  'myota.events.identity.callsign.verified.v1',
  'myota.events.identity.login.failed.v1',
  'myota.events.identity.login.succeeded.v1',
  'myota.events.identity.oidc.mapping.updated.v1',
  'myota.events.identity.recovery.completed.v1',
  'myota.events.identity.recovery.requested.v1',
  'myota.events.identity.role-definition.created.v1',
  'myota.events.identity.role-definition.updated.v1',
  'myota.events.identity.role.assigned.v1',
  'myota.events.identity.roles.replaced.v1',
  'myota.events.identity.service-token.issued.v1',
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const args = parseArgs(process.argv.slice(2));
const eventId = args['event-id']?.toLowerCase();
const actor = args.actor?.trim();
const reason = args.reason?.trim();
const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
if (!eventId || !UUID.test(eventId))
  throw new Error('--event-id must be a UUID');
if (!actor || actor.length > 120)
  throw new Error('--actor must contain 1 to 120 characters');
if (!reason || reason.length > 500)
  throw new Error('--reason must contain 1 to 500 characters');
if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5000,
});
let connection: Awaited<ReturnType<typeof connect>> | undefined;
try {
  const client = await pool.connect();
  let redriveId: string;
  let subject: string;
  let payload: Record<string, unknown>;
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      event_type: string;
      subject: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, subject, payload FROM public.dead_letter_event
       WHERE event_id=$1 AND stream_name=$2 AND resolved_at IS NULL FOR UPDATE`,
      [eventId, STREAM],
    );
    const deadLetter = result.rows[0];
    if (!deadLetter)
      throw new Error('unresolved Activity notification dead letter not found');
    if (!SUBJECTS.has(deadLetter.subject))
      throw new Error(
        'dead-letter subject is not registered for this consumer',
      );
    if (!deadLetter.payload || deadLetter.payload.eventId !== eventId) {
      throw new Error(
        'dead-letter payload has no matching eventId; reconstruct from the owning source database',
      );
    }
    if (
      deadLetter.event_type !== deadLetter.subject.slice('myota.events.'.length)
    ) {
      throw new Error('dead-letter subject and event type do not match');
    }
    subject = deadLetter.subject;
    payload = deadLetter.payload;
    const pending = await client.query<{ id: string }>(
      `SELECT id FROM public.activity_notification_redrive
       WHERE event_id=$1 AND status='PENDING' ORDER BY requested_at DESC LIMIT 1`,
      [eventId],
    );
    redriveId = pending.rows[0]?.id ?? randomUUID();
    if (!pending.rowCount) {
      await client.query(
        `INSERT INTO public.activity_notification_redrive(id,event_id,actor,reason,status)
         VALUES ($1,$2,$3,$4,'PENDING')`,
        [redriveId, eventId, actor, reason],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  connection = await connect({
    servers: process.env.NATS_URL ?? 'nats://nats:4222',
    name: 'activity-notification-redrive',
    timeout: 5000,
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  const manager = await jetstreamManager(connection);
  const stream = await manager.streams.info(STREAM);
  if (!stream.config.subjects.includes('myota.events.>')) {
    throw new Error(
      `${STREAM} is not provisioned for the registered notification subjects`,
    );
  }
  const ack = await jetstream(connection).publish(
    subject,
    new TextEncoder().encode(JSON.stringify(payload)),
    { msgID: `activity-notification-redrive-${redriveId}` },
  );
  if (ack.stream !== STREAM)
    throw new Error(`JetStream acknowledged unexpected stream ${ack.stream}`);
  await pool.query(
    `UPDATE public.activity_notification_redrive SET status='PUBLISHED',published_at=now()
     WHERE id=$1 AND status='PENDING'`,
    [redriveId],
  );
  process.stdout.write(
    `published audited Activity notification redrive ${redriveId}\n`,
  );
} finally {
  await connection?.drain();
  await pool.end();
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (
      !value.startsWith('--') ||
      !values[index + 1] ||
      values[index + 1].startsWith('--')
    ) {
      throw new Error(
        'usage: redrive-notification --event-id UUID --actor ID --reason TEXT',
      );
    }
    parsed[value.slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}

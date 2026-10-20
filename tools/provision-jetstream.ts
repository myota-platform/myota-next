import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  jetstreamManager,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import type { ConsumerConfig, StreamConfig } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';

type WorkRoute = {
  owner: string;
  subject: string;
  stream: string;
  durable: string;
};

type EventRegistry = {
  factStream: string;
  factSubjectPrefix: string;
  activityWorkStream: string;
  activityWorkSubjectPrefix: string;
  geodataWorkStream: string;
  geodataWorkSubjectPrefix: string;
  emailWorkStream: string;
  emailWorkSubjectPrefix: string;
  work: WorkRoute[];
};

type StreamSpec = {
  name: string;
  subjects: string[];
  retention: (typeof RetentionPolicy)[keyof typeof RetentionPolicy];
  maxAgeSeconds: number;
  maxBytes: number;
  maxMessages: number;
  maxMessageBytes: number;
};

type ConsumerSpec = {
  stream: string;
  durable: string;
  filterSubject?: string;
  filterSubjects?: string[];
  ackWaitSeconds: number;
  maxDeliveries: number;
  maxAckPending: number;
  maxWaiting: number;
  backoffSeconds?: number[];
};

const ACTIVITY_POLICY: Record<string, [number, number, number]> = {
  'activity-qso-ingestion-v1': [120, 8, 4],
  'activity-adif-import-v1': [300, 8, 1],
  'activity-award-recalculate-v1': [120, 8, 2],
  'activity-award-evaluation-v1': [120, 8, 2],
  'activity-pdf-render-v1': [300, 8, 1],
  'activity-statistics-rebuild-v1': [300, 8, 1],
};

const GEODATA_POLICY: Record<string, [number, number, number]> = {
  'geodata-preprocessing-v1': [300, 100, 1],
  'geodata-import-promotion-v1': [300, 100, 1],
  'geodata-entity-deletion-v1': [120, 100, 1],
  'geodata-location-enrichment-v1': [120, 8, 4],
};

const EMAIL_POLICY: Record<string, [number, number, number]> = {
  'email-delivery-v1': [90, 8, 1],
};

const NOTIFICATION_SUBJECTS = [
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
];

function positiveSetting(name: string): number {
  const raw = process.env[name] ?? '';
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be set to a measured positive integer`);
  return value;
}

function registry(): EventRegistry {
  const path = resolve('contracts/event-registry.json');
  return JSON.parse(readFileSync(path, 'utf8')) as EventRegistry;
}

function streamConfig(spec: StreamSpec): StreamConfig {
  return {
    name: spec.name,
    subjects: spec.subjects,
    retention: spec.retention,
    storage: StorageType.File,
    num_replicas: 1,
    max_age: spec.maxAgeSeconds * 1_000_000_000,
    max_bytes: spec.maxBytes,
    max_msgs: spec.maxMessages,
    max_msg_size: spec.maxMessageBytes,
    discard: DiscardPolicy.New,
  } as StreamConfig;
}

function consumerConfig(spec: ConsumerSpec): ConsumerConfig {
  return {
    durable_name: spec.durable,
    filter_subject: spec.filterSubject,
    filter_subjects: spec.filterSubjects,
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: spec.ackWaitSeconds * 1_000_000_000,
    max_deliver: spec.maxDeliveries,
    max_ack_pending: spec.maxAckPending,
    max_waiting: spec.maxWaiting,
    backoff: spec.backoffSeconds?.map((seconds) => seconds * 1_000_000_000),
    replay_policy: ReplayPolicy.Instant,
    num_replicas: 0,
    mem_storage: false,
    headers_only: false,
  } as ConsumerConfig;
}

function streamSpecs(registry: EventRegistry, scope: string): StreamSpec[] {
  const event = {
    name: registry.factStream,
    subjects: [`${registry.factSubjectPrefix}>`],
    retention: RetentionPolicy.Limits,
    maxAgeSeconds: 30 * 86400,
    maxBytes: positiveSetting('NATS_EVENTS_MAX_BYTES'),
    maxMessages: positiveSetting('NATS_EVENTS_MAX_MESSAGES'),
    maxMessageBytes: positiveSetting('NATS_EVENTS_MAX_MESSAGE_BYTES'),
  };
  const activity = {
    name: registry.activityWorkStream,
    subjects: [`${registry.activityWorkSubjectPrefix}>`],
    retention: RetentionPolicy.Workqueue,
    maxAgeSeconds: positiveSetting('NATS_ACTIVITY_WORK_MAX_AGE_SECONDS'),
    maxBytes: positiveSetting('NATS_ACTIVITY_WORK_MAX_BYTES'),
    maxMessages: positiveSetting('NATS_ACTIVITY_WORK_MAX_MESSAGES'),
    maxMessageBytes: positiveSetting('NATS_ACTIVITY_WORK_MAX_MESSAGE_BYTES'),
  };
  const geodata = {
    name: registry.geodataWorkStream,
    subjects: [`${registry.geodataWorkSubjectPrefix}>`],
    retention: RetentionPolicy.Workqueue,
    maxAgeSeconds: positiveSetting('NATS_GEODATA_WORK_MAX_AGE_SECONDS'),
    maxBytes: positiveSetting('NATS_GEODATA_WORK_MAX_BYTES'),
    maxMessages: positiveSetting('NATS_GEODATA_WORK_MAX_MESSAGES'),
    maxMessageBytes: positiveSetting('NATS_GEODATA_WORK_MAX_MESSAGE_BYTES'),
  };
  const email = {
    name: registry.emailWorkStream,
    subjects: [`${registry.emailWorkSubjectPrefix}>`],
    retention: RetentionPolicy.Workqueue,
    maxAgeSeconds: positiveSetting('NATS_EMAIL_WORK_MAX_AGE_SECONDS'),
    maxBytes: positiveSetting('NATS_EMAIL_WORK_MAX_BYTES'),
    maxMessages: positiveSetting('NATS_EMAIL_WORK_MAX_MESSAGES'),
    maxMessageBytes: positiveSetting('NATS_EMAIL_WORK_MAX_MESSAGE_BYTES'),
  };

  if (scope === 'activity-work') return [activity];
  if (scope === 'geodata-work') return [geodata];
  if (scope === 'email-work') return [email];
  if (scope !== 'all') throw new Error(`Unsupported JetStream scope: ${scope}`);
  return [event, activity, geodata, email];
}

function consumerSpecs(registry: EventRegistry, scope: string): ConsumerSpec[] {
  if (scope !== 'all') return workConsumers(registry, scope);

  return [
    {
      stream: registry.factStream,
      durable: 'activity-notifications-v1',
      filterSubjects: NOTIFICATION_SUBJECTS,
      ackWaitSeconds: 60,
      maxDeliveries: 8,
      maxAckPending: 64,
      maxWaiting: 32,
      backoffSeconds: [60, 120, 300, 300, 300, 300, 300, 300],
    },
    ...workConsumers(registry, 'activity-work'),
    ...workConsumers(registry, 'geodata-work'),
    ...workConsumers(registry, 'email-work'),
  ];
}

function workConsumers(registry: EventRegistry, scope: string): ConsumerSpec[] {
  const expected =
    scope === 'activity-work'
      ? [registry.activityWorkStream, ACTIVITY_POLICY]
      : scope === 'geodata-work'
        ? [registry.geodataWorkStream, GEODATA_POLICY]
        : scope === 'email-work'
          ? [registry.emailWorkStream, EMAIL_POLICY]
          : undefined;
  if (!expected) throw new Error(`Unsupported work scope: ${scope}`);
  const [stream, policies] = expected as [
    string,
    Record<string, [number, number, number]>,
  ];
  return registry.work
    .filter((work) => work.stream === stream)
    .map((work) => {
      const policy = policies[work.durable];
      if (!policy || work.subject.startsWith('myota.work.') === false)
        throw new Error(`Missing reviewed policy for ${work.durable}`);
      return {
        stream,
        durable: work.durable,
        filterSubject: work.subject,
        ackWaitSeconds: policy[0],
        maxDeliveries: policy[1],
        maxAckPending: policy[2],
        maxWaiting: policy[2],
      };
    });
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    code?: unknown;
    status?: unknown;
    api_error?: { code?: unknown };
    apiError?: () => { code?: unknown };
  };
  return (
    value.status === 404 ||
    value.api_error?.code === 404 ||
    value.apiError?.().code === 404
  );
}

function normalized(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function validateStream(actual: StreamConfig, desired: StreamConfig): void {
  const checks: Array<[string, unknown, unknown]> = [
    [
      'subjects',
      [...(actual.subjects ?? [])].sort(),
      [...desired.subjects].sort(),
    ],
    ['retention', normalized(actual.retention), normalized(desired.retention)],
    ['storage', normalized(actual.storage), normalized(desired.storage)],
    ['replicas', actual.num_replicas, desired.num_replicas],
    ['max_age', actual.max_age, desired.max_age],
    ['max_bytes', actual.max_bytes, desired.max_bytes],
    ['max_msgs', actual.max_msgs, desired.max_msgs],
    ['max_msg_size', actual.max_msg_size, desired.max_msg_size],
    ['discard', normalized(actual.discard), normalized(desired.discard)],
  ];
  const drift = checks
    .filter(
      ([, current, wanted]) =>
        JSON.stringify(current) !== JSON.stringify(wanted),
    )
    .map(([field]) => field);
  if (drift.length)
    throw new Error(
      `Stream ${desired.name} configuration drift (${drift.join(', ')}); existing streams are never changed`,
    );
}

function validateConsumer(
  actual: ConsumerConfig,
  desired: ConsumerConfig,
): void {
  const checks: Array<[string, unknown, unknown]> = [
    [
      'filter_subject',
      actual.filter_subject ?? null,
      desired.filter_subject ?? null,
    ],
    [
      'filter_subjects',
      actual.filter_subjects ?? null,
      desired.filter_subjects ?? null,
    ],
    [
      'deliver_policy',
      normalized(actual.deliver_policy),
      normalized(desired.deliver_policy),
    ],
    [
      'ack_policy',
      normalized(actual.ack_policy),
      normalized(desired.ack_policy),
    ],
    ['ack_wait', actual.ack_wait, desired.ack_wait],
    ['max_deliver', actual.max_deliver, desired.max_deliver],
    ['max_ack_pending', actual.max_ack_pending, desired.max_ack_pending],
    ['max_waiting', actual.max_waiting, desired.max_waiting],
    [
      'replay_policy',
      normalized(actual.replay_policy),
      normalized(desired.replay_policy),
    ],
    ['num_replicas', actual.num_replicas, desired.num_replicas],
    ['mem_storage', Boolean(actual.mem_storage), Boolean(desired.mem_storage)],
    [
      'headers_only',
      Boolean(actual.headers_only),
      Boolean(desired.headers_only),
    ],
    [
      'deliver_subject',
      actual.deliver_subject ?? null,
      desired.deliver_subject ?? null,
    ],
    ['backoff', actual.backoff ?? null, desired.backoff ?? null],
  ];
  const drift = checks
    .filter(
      ([, current, wanted]) =>
        JSON.stringify(current) !== JSON.stringify(wanted),
    )
    .map(([field]) => field);
  if (drift.length)
    throw new Error(
      `Durable ${desired.durable_name} configuration drift (${drift.join(', ')}); create an explicitly reviewed successor durable`,
    );
}

async function main(): Promise<void> {
  if (process.env.NATS_TOPOLOGY_APPLY !== '1')
    throw new Error(
      'Set NATS_TOPOLOGY_APPLY=1 after topology and capacity review',
    );
  if (process.env.NATS_EVENTS_RETENTION_MIGRATION === '1')
    throw new Error(
      'The legacy MYOTA_EVENTS retention migration requires separate review and is not supported by this tool',
    );

  const topology = registry();
  const scope = process.env.NATS_TOPOLOGY_SCOPE ?? 'all';
  const streams = streamSpecs(topology, scope);
  const consumers = consumerSpecs(topology, scope);
  const connection = await connect({
    servers: process.env.NATS_URL ?? 'nats://nats:4222',
    name: 'myota-jetstream-provisioner',
    timeout: 5000,
    reconnect: false,
    maxReconnectAttempts: 3,
  });
  try {
    const manager = await jetstreamManager(connection);
    for (const spec of streams) {
      const desired = streamConfig(spec);
      let actual: { config: StreamConfig };
      try {
        actual = await manager.streams.info(spec.name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await manager.streams.add(desired);
        actual = await manager.streams.info(spec.name);
      }
      validateStream(actual.config, desired);
      console.log(`validated stream ${spec.name}`);
    }
    for (const spec of consumers) {
      const desired = consumerConfig(spec);
      let actual: { config: ConsumerConfig };
      try {
        actual = await manager.consumers.info(spec.stream, spec.durable);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await manager.consumers.add(spec.stream, desired);
        actual = await manager.consumers.info(spec.stream, spec.durable);
      }
      validateConsumer(actual.config, desired);
      console.log(`validated durable ${spec.stream}/${spec.durable}`);
    }
  } finally {
    await connection.drain();
  }
}

main().catch((error: unknown) => {
  console.error('JetStream provisioning failed:', error);
  process.exitCode = 1;
});

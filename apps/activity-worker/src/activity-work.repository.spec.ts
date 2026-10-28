import type { Pool, PoolClient } from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { ActivityWorkRepository } from './activity-work.repository.js';

describe('ActivityWorkRepository ADIF failure notifications', () => {
  async function finishFailedImport(reason: string) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('UPDATE activity_import')) {
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'imports/log.adi',
                bucket: 'activity-imports',
                sha256: 'hash',
                content_size: '1',
                malware_status: 'CLEAN',
                status: 'FAILED',
                records_seen: 0,
                records_accepted: 0,
                records_rejected: 1,
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      finishAdifImport: (
        db: PoolClient,
        record: Record<string, unknown>,
        seen: number,
        accepted: number,
        rejected: number,
        errors: string[],
        status: string,
      ) => Promise<unknown>;
    };

    await internal.finishAdifImport(
      client,
      { id: 'import-1', activation_id: 'activation-1' },
      0,
      0,
      1,
      [reason],
      'FAILED',
    );
    return queries;
  }

  it('addresses a missing-object notice to the activation ID with the Python reason', async () => {
    const queries = await finishFailedImport(
      'uploaded object is not available',
    );
    const notification = queries[1];

    expect(notification?.sql).toContain('ADIF_IMPORT_FAILED');
    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'object unavailable',
    });
  });

  it('preserves the parser error as the notification reason', async () => {
    const queries = await finishFailedImport('invalid ADIF record');
    const notification = queries[1];

    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'invalid ADIF record',
    });
  });

  it('maps an explicit missing object to the Python missing-object result', async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT i.*'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                status: 'QUEUED',
                operator_id: 'operator-1',
                activation_status: 'OPEN',
              },
            ],
          };
        if (sql.startsWith('UPDATE activity_import'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                sha256: 'hash',
                content_size: '10',
                malware_status: 'CLEAN',
                status: 'FAILED',
                records_seen: 0,
                records_accepted: 0,
                records_rejected: 1,
                errors: ['uploaded object is not available'],
                created_at: new Date('2026-01-01T00:00:00Z'),
                started_at: new Date('2026-01-01T00:00:01Z'),
                completed_at: new Date('2026-01-01T00:00:02Z'),
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const read = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      Object.assign(new Error('object does not exist'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAdifImport: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };

    try {
      await internal.processAdifImport(client, { importId: 'import-1' });
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }

    const finish = queries.find(({ sql }) =>
      sql.startsWith('UPDATE activity_import'),
    );
    expect(finish?.values.slice(1, 5)).toEqual(['FAILED', 0, 0, 1]);
    expect(JSON.parse(String(finish?.values[5]))).toEqual([
      'uploaded object is not available',
    ]);
    const notification = queries.find(({ sql }) =>
      sql.includes("'ADIF_IMPORT_FAILED'"),
    );
    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'object unavailable',
    });
  });

  it('rethrows a temporary object-store outage so the worker can retry', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT i.*'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                status: 'PROCESSING',
                operator_id: 'operator-1',
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const outage = Object.assign(new Error('object storage unavailable'), {
      $metadata: { httpStatusCode: 503 },
    });
    const read = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(outage);
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAdifImport: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };

    try {
      await expect(
        internal.processAdifImport(client, { importId: 'import-1' }),
      ).rejects.toBe(outage);
    } finally {
      read.mockRestore();
    }

    expect(
      queries.some((sql) => sql.startsWith('UPDATE activity_import')),
    ).toBe(false);
    expect(queries.some((sql) => sql.includes('ADIF_IMPORT_FAILED'))).toBe(
      false,
    );
  });
});

describe('ActivityWorkRepository award deletion', () => {
  function deletionFixture() {
    const statements: { sql: string; values: unknown[] }[] = [];
    const awardId = '10000000-0000-4000-8000-000000000001';
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('FROM activity_award_definition WHERE id=ANY'))
          return {
            rows: [
              {
                id: awardId,
                status: 'DELETING',
                definition_text: JSON.stringify({
                  id: awardId,
                }),
              },
            ],
          };
        if (
          sql.includes('SELECT definition::text') &&
          sql.includes('WHERE NOT')
        )
          return { rows: [] };
        if (sql.includes('FROM activity_award_issuance'))
          return {
            rows: [
              {
                id: '30000000-0000-4000-8000-000000000001',
                issuance_text: JSON.stringify({
                  artifact: {
                    downloadReady: true,
                    bucket: 'certificate-files',
                    objectKey: 'rendered/award-delete.pdf',
                  },
                }),
              },
            ],
          };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAwardDeletion(
        db: PoolClient,
        payload: Record<string, unknown>,
        jobId: string,
      ): Promise<void>;
    };
    const payload = {
      rootAwardId: awardId,
      awardIds: [awardId],
      actorId: 'global-admin-1',
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-10',
    };
    return { client, internal, payload, statements, awardId };
  }

  it('deletes object-store files before committing the audit and database cascade', async () => {
    const fixture = deletionFixture();
    const deleteObject = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);

    await fixture.internal.processAwardDeletion(
      fixture.client,
      fixture.payload,
      '30000000-0000-4000-8000-000000000001',
    );

    expect(deleteObject).toHaveBeenCalledOnce();
    expect((deleteObject.mock.calls[0][0] as any).input).toEqual({
      Bucket: 'certificate-files',
      Key: 'rendered/award-delete.pdf',
    });
    const auditIndex = fixture.statements.findIndex((item) =>
      item.sql.includes('INSERT INTO activity_award_deletion_audit'),
    );
    expect(auditIndex).toBeGreaterThan(-1);
    expect(
      fixture.statements.some((item) =>
        item.sql.includes('DELETE FROM activity_award_definition'),
      ),
    ).toBe(true);
    expect(
      fixture.statements.some((item) =>
        item.sql.includes('DELETE FROM activity_asset'),
      ),
    ).toBe(false);
  });

  it('keeps database rows and audit unchanged when object storage deletion fails', async () => {
    const fixture = deletionFixture();
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      new Error('object storage unavailable'),
    );

    await expect(
      fixture.internal.processAwardDeletion(
        fixture.client,
        fixture.payload,
        '30000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toThrow('object storage unavailable');
    expect(
      fixture.statements.some((item) =>
        item.sql.includes('INSERT INTO activity_award_deletion_audit'),
      ),
    ).toBe(false);
    expect(
      fixture.statements.some((item) => item.sql.includes('DELETE FROM')),
    ).toBe(false);
  });
});

describe('ActivityWorkRepository ADIF validity-window compatibility', () => {
  it('rejects an out-of-window later record before inserting the ADIF batch', async () => {
    const queries: string[] = [];
    const activationId = '11111111-1111-4111-8111-111111111111';
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT i.*'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: activationId,
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                status: 'PROCESSING',
                operator_id: 'operator-1',
                programme_slug: 'demo',
                operator_callsign: 'EA7TEST',
                activation_status: 'OPEN',
                activation_started_at_iso: '2026-01-01T00:00:00.000000Z',
                activation_validity_expires_at_iso:
                  '2026-01-02T00:00:00.000000Z',
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAdifImport: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };
    const originalScannerUrl = process.env.MYOTA_CLAMAV_URL;
    delete process.env.MYOTA_CLAMAV_URL;
    const content = Buffer.from(
      '<CALL:5>K1ABC<QSO_DATE:8>20260101<TIME_ON:4>1200<EOR>' +
        '<CALL:5>K1XYZ<QSO_DATE:8>20260103<TIME_ON:4>1200<EOR>',
    );
    const read = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(content) },
    } as never);

    try {
      await expect(
        internal.processAdifImport(client, { importId: 'import-1' }),
      ).rejects.toThrow('a QSO is outside the activation validity window');
    } finally {
      read.mockRestore();
      if (originalScannerUrl === undefined) delete process.env.MYOTA_CLAMAV_URL;
      else process.env.MYOTA_CLAMAV_URL = originalScannerUrl;
    }

    expect(
      queries.some((sql) => sql.startsWith('INSERT INTO activity_qso')),
    ).toBe(false);
    expect(queries.some((sql) => sql.startsWith('SAVEPOINT'))).toBe(false);
    expect(
      queries.some((sql) => sql.startsWith('UPDATE activity_import')),
    ).toBe(false);
  });

  it('fails the whole import when the bulk QSO insert fails', async () => {
    const queries: string[] = [];
    const activationId = '11111111-1111-4111-8111-111111111111';
    const insertFailure = new Error('QSO insert failed');
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT i.*'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: activationId,
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                status: 'PROCESSING',
                operator_id: 'operator-1',
                programme_slug: 'demo',
                operator_callsign: 'EA7TEST',
                activation_status: 'OPEN',
                activation_started_at_iso: '2026-01-01T00:00:00.000000Z',
                activation_validity_expires_at_iso: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('INSERT INTO activity_qso')) throw insertFailure;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAdifImport: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };
    const originalScannerUrl = process.env.MYOTA_CLAMAV_URL;
    delete process.env.MYOTA_CLAMAV_URL;
    const content = Buffer.from(
      '<CALL:5>K1ABC<QSO_DATE:8>20260101<TIME_ON:4>1200<EOR>',
    );
    const read = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(content) },
    } as never);

    try {
      await expect(
        internal.processAdifImport(client, { importId: 'import-1' }),
      ).rejects.toBe(insertFailure);
    } finally {
      read.mockRestore();
      if (originalScannerUrl === undefined) delete process.env.MYOTA_CLAMAV_URL;
      else process.env.MYOTA_CLAMAV_URL = originalScannerUrl;
    }

    expect(
      queries.filter((sql) => sql.startsWith('INSERT INTO activity_qso')),
    ).toHaveLength(1);
    expect(queries).toContain('ROLLBACK TO SAVEPOINT adif_batch_insert');
    expect(queries).toContain('RELEASE SAVEPOINT adif_batch_insert');
    expect(
      queries.some((sql) => sql.startsWith('UPDATE activity_import')),
    ).toBe(false);
  });

  it('fails the whole import when a QSO side effect fails', async () => {
    const queries: string[] = [];
    const activationId = '11111111-1111-4111-8111-111111111111';
    const effectFailure = new Error('QSO outbox insert failed');
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT i.*'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: activationId,
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                status: 'PROCESSING',
                operator_id: 'operator-1',
                programme_slug: 'demo',
                operator_callsign: 'EA7TEST',
                entity_id: null,
                entity_type: null,
                activation_status: 'OPEN',
                activation_started_at_iso: '2026-01-01T00:00:00.000000Z',
                activation_validity_expires_at_iso: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.startsWith('INSERT INTO activity_qso'))
          return {
            rows: [
              {
                id: 'qso-1',
                activation_id: activationId,
                programme_slug: 'demo',
                operator_id: 'operator-1',
                operator_callsign: 'EA7TEST',
                hunter_id: null,
                hunter_callsign: null,
                worked_callsign: 'K1ABC',
                worked_station_key: 'K1ABC|',
                worked_entity_id: null,
                occurred_at_iso: '2026-01-01T12:00:00.000000Z',
                band: null,
                mode: null,
                rst: null,
                source: 'adif',
                status: 'VALID',
                deduplication_key: 'dedupe-1',
                created_at: '2026-01-01T12:00:01.000Z',
              },
            ],
            rowCount: 1,
          };
        if (sql.includes("'activity.qso.recorded.v1'")) throw effectFailure;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAdifImport: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };
    const originalScannerUrl = process.env.MYOTA_CLAMAV_URL;
    delete process.env.MYOTA_CLAMAV_URL;
    const content = Buffer.from(
      '<CALL:5>K1ABC<QSO_DATE:8>20260101<TIME_ON:4>1200<EOR>',
    );
    const read = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(content) },
    } as never);

    try {
      await expect(
        internal.processAdifImport(client, { importId: 'import-1' }),
      ).rejects.toBe(effectFailure);
    } finally {
      read.mockRestore();
      if (originalScannerUrl === undefined) delete process.env.MYOTA_CLAMAV_URL;
      else process.env.MYOTA_CLAMAV_URL = originalScannerUrl;
    }

    expect(
      queries.some((sql) => sql.startsWith('DELETE FROM activity_qso')),
    ).toBe(false);
    expect(
      queries.some((sql) => sql.startsWith('UPDATE activity_import')),
    ).toBe(false);
  });
});

describe('ActivityWorkRepository transient connection errors', () => {
  it('preserves the pool connection error as the unavailable cause', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    const pool = {
      connect: async () => {
        throw cause;
      },
    };
    const repository = new ActivityWorkRepository(pool as unknown as Pool);

    await expect(
      repository.claimWorkJob(
        '0199c125-c321-7220-a123-456789abcdef',
        'STATISTICS_REBUILD',
      ),
    ).rejects.toMatchObject({
      message: 'Activity database is unavailable',
      cause,
    });
  });
});

describe('ActivityWorkRepository retry dispatch', () => {
  it('commits a fresh work outbox event with the queued retry state', async () => {
    const availableAt = new Date('2026-10-22T12:00:02.000Z');
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('UPDATE activity_job'))
          return { rowCount: 1, rows: [{ available_at: availableAt }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    };
    const repository = new ActivityWorkRepository(pool as unknown as Pool);

    await repository.retryWorkJob(
      {
        id: '0199c125-c321-7220-a123-456789abcdef',
        kind: 'STATISTICS_REBUILD',
        payload: { programmeSlug: 'retry-test' },
        attempts: 1,
        leaseToken: '0199c125-c321-7220-a123-456789abcdee',
      },
      new Error('temporary failure'),
      2,
    );

    const outbox = queries.find(({ sql }) =>
      sql.startsWith('INSERT INTO outbox_event'),
    );
    expect(outbox?.values[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(outbox?.values.slice(1)).toEqual([
      'activity.statistics-rebuild.v1',
      '0199c125-c321-7220-a123-456789abcdef',
      JSON.stringify({ jobId: '0199c125-c321-7220-a123-456789abcdef' }),
      availableAt,
    ]);
    expect(queries.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('ActivityWorkRepository terminal ADIF failures', () => {
  it('fails the import and records one failure notification when dead-lettering', async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('UPDATE activity_job'))
          return { rowCount: 1, rows: [{ id: 'job-1' }] };
        if (sql.startsWith('UPDATE activity_import'))
          return { rowCount: 1, rows: [{ activation_id: 'activation-1' }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repository = new ActivityWorkRepository(pool as unknown as Pool);

    await repository.failWorkJob(
      {
        id: 'job-1',
        kind: 'ADIF_IMPORT',
        payload: { importId: 'import-1' },
        attempts: 8,
        leaseToken: 'lease-8',
      },
      new Error('invalid ADIF record'),
      'myota.work.activity.adif-import.v1',
      'activity.adif-import.v1',
      1,
    );

    const failedImport = queries.find(({ sql }) =>
      sql.startsWith('UPDATE activity_import'),
    );
    expect(failedImport?.sql).toContain("status='FAILED'");
    expect(failedImport?.values).toEqual([
      'import-1',
      JSON.stringify(['ADIF import failed after exhausting retries']),
    ]);
    const notification = queries.find(({ sql }) =>
      sql.includes("'ADIF_IMPORT_FAILED'"),
    );
    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'ADIF import failed after exhausting retries',
    });
    expect(notification?.values[3]).toBe('adif:import-1:failed');
    expect(queries.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('ActivityWorkRepository QSO ingestion compatibility', () => {
  it('normalizes the full batch before checking activation state or writing QSOs', async () => {
    const queries: string[] = [];
    const activationId = '11111111-1111-4111-8111-111111111111';
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("status='RUNNING' AND lease_token=$2"))
          return { rows: [{ id: 'job-1' }], rowCount: 1 };
        if (sql === 'SELECT id FROM activity_activation WHERE id=$1')
          return { rows: [{ id: activationId }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository({
      connect: async () => client,
    } as unknown as Pool);

    await expect(
      repository.process({
        id: 'job-1',
        kind: 'QSO_INGESTION',
        payload: {
          activationId,
          records: [
            {
              workedCallsign: 'K1XYZ',
              timestamp: '2026-01-02T00:00:00Z',
            },
            {
              workedCallsign: '',
              timestamp: '2026-01-02T00:00:00Z',
            },
          ],
        },
        attempts: 1,
        leaseToken: 'lease-1',
      }),
    ).rejects.toThrow('callsign is invalid');

    expect(queries.some((sql) => sql.includes('FOR UPDATE'))).toBe(false);
    expect(
      queries.some((sql) => sql.startsWith('INSERT INTO activity_qso')),
    ).toBe(false);
    expect(queries).toContain('ROLLBACK');
  });

  it('rejects an out-of-window record before writing any QSO in the batch', async () => {
    const queries: string[] = [];
    const activationId = '11111111-1111-4111-8111-111111111111';
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("status='RUNNING' AND lease_token=$2"))
          return { rows: [{ id: 'job-1' }], rowCount: 1 };
        if (sql === 'SELECT id FROM activity_activation WHERE id=$1')
          return { rows: [{ id: activationId }], rowCount: 1 };
        if (sql.includes('FROM activity_activation WHERE id=$1 FOR UPDATE'))
          return {
            rows: [
              {
                id: activationId,
                status: 'OPEN',
                started_at_iso: '2026-01-01T00:00:00.000000Z',
                validity_expires_at_iso: '2026-01-02T00:00:00.000000Z',
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository({
      connect: async () => client,
    } as unknown as Pool);

    await expect(
      repository.process({
        id: 'job-1',
        kind: 'QSO_INGESTION',
        payload: {
          activationId,
          records: [
            {
              workedCallsign: 'K1ABC',
              timestamp: '2026-01-01T12:00:00Z',
            },
            {
              workedCallsign: 'K1XYZ',
              timestamp: '2026-01-03T12:00:00Z',
            },
          ],
        },
        attempts: 1,
        leaseToken: 'lease-1',
      }),
    ).rejects.toThrow('a QSO is outside the activation validity window');

    expect(
      queries.some((sql) => sql.startsWith('INSERT INTO activity_qso')),
    ).toBe(false);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });
});

describe('ActivityWorkRepository award recalculation compatibility', () => {
  it('uses the requested award version and recalculates every subject', async () => {
    const definitions = [
      {
        id: 'award-v1',
        programmeSlug: 'demo',
        status: 'PUBLISHED',
        version: 1,
        category: 'HUNTER',
        condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
        achievementMetric: 'QSO_COUNT',
        levels: [{ id: 'one', threshold: 1 }],
        code: 'ONE',
      },
      {
        id: 'award-v2',
        programmeSlug: 'demo',
        status: 'PUBLISHED',
        version: 2,
        category: 'HUNTER',
        condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
        achievementMetric: 'QSO_COUNT',
        levels: [{ id: 'one', threshold: 1 }],
        code: 'ONE',
      },
    ];
    const progressWrites: unknown[][] = [];
    const factSubjects: string[] = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes('SELECT definition::text AS definition_text'))
          return {
            rows: definitions.map((definition) => ({
              definition_text: JSON.stringify(definition),
            })),
            rowCount: definitions.length,
          };
        if (sql.includes('SELECT DISTINCT subject_id'))
          return {
            rows: [{ subject_id: 'hunter-1' }, { subject_id: 'hunter-2' }],
            rowCount: 2,
          };
        if (sql.includes('SELECT qso_count,activation_count')) {
          factSubjects.push(String(values[1]));
          return {
            rows: [
              {
                qso_count: '1',
                activation_count: '1',
                unique_callsign_count: '1',
                unique_entity_count: '1',
                last_entity_type: 'MUNICIPAL_PARK',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO activity_award_progress')) {
          progressWrites.push(values);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAwardRecalculation: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };

    await internal.processAwardRecalculation(client, {
      programmeSlug: 'demo',
      awardId: 'award-v1',
      ruleVersion: 1,
    });

    expect(factSubjects).toEqual(['hunter-1', 'hunter-2']);
    expect(progressWrites.map((values) => values.slice(0, 3))).toEqual([
      ['award-v1', 1, 'hunter-1'],
      ['award-v1', 1, 'hunter-2'],
    ]);
    expect(
      progressWrites.map((values) => JSON.parse(String(values[5])).ruleVersion),
    ).toEqual([1, 1]);
  });
});

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('submits and reviews participant location proposals through live services', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');
  test.skip(
    process.env.MYOTA_BROWSER_GEODATA_WORKERS !== '1',
    'requires the CI Geodata workers and JetStream topology',
  );
  test.setTimeout(120_000);

  const core = new Pool({
    connectionString: process.env.CORE_DATABASE_URL,
    max: 1,
  });
  const geo = new Pool({
    connectionString: process.env.GEO_DATABASE_URL,
    max: 1,
  });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-proposals-${fixtureId}`;
  const entityTypeCode = `BP_${fixtureId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const candidateId = randomUUID();
  const candidateName = `Existing community site ${fixtureId.slice(0, 8)}`;
  const pointProposalName = `Map-picked site ${fixtureId}`;
  const programmeKey = randomUUID();
  const proposalRequests: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
  const proposalRunIds: string[] = [];
  let proposerId: string | undefined;
  let programmeId: string | undefined;
  let candidateSeeded = false;

  page.on('request', (browserRequest) => {
    if (
      browserRequest.method() === 'POST' &&
      new URL(browserRequest.url()).pathname === '/v1/geodata/proposals'
    ) {
      proposalRequests.push({
        body: browserRequest.postDataJSON() as Record<string, unknown>,
        idempotencyKey: browserRequest.headers()['idempotency-key'] ?? '',
      });
    }
  });

  try {
    const email =
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
      'browser-e2e-admin@example.test';
    const password =
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
    const login = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/login',
      { data: { email, password } },
    );
    expect(login.ok()).toBeTruthy();
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    const identity = await request.get('http://127.0.0.1:8080/v1/identity/me', {
      headers,
    });
    expect(identity.ok()).toBeTruthy();
    proposerId = (await identity.json()).id as string;

    const programmeResponse = await request.post(
      'http://127.0.0.1:8080/v1/programmes',
      {
        headers: { ...headers, 'Idempotency-Key': programmeKey },
        data: {
          slug: programmeSlug,
          name: `Community proposals ${fixtureId.slice(0, 8)}`,
          description: 'Live Participant proposal browser fixture.',
          entityTypes: [
            {
              code: entityTypeCode,
              label: 'Community point',
              geometryTypes: ['POINT'],
            },
          ],
          rules: {
            activationValidityDays: 7,
            minimumQsos: { activation: 1, hunter: 1 },
            publicAccessRequired: false,
          },
        },
      },
    );
    expect(programmeResponse.status()).toBe(201);
    programmeId = (await programmeResponse.json()).id as string;

    const geoClient = await geo.connect();
    try {
      await geoClient.query('BEGIN');
      await geoClient.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await geoClient.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,programme_slug,entity_type_code)
         VALUES ($1,$2,'CANDIDATE',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,$3,$4)`,
        [candidateId, candidateName, programmeSlug, entityTypeCode],
      );
      await geoClient.query('COMMIT');
      candidateSeeded = true;
    } catch (error) {
      await geoClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      geoClient.release();
    }

    await page.goto(`http://127.0.0.1:8091/#${programmeSlug}`);
    await expect(page.locator('#programme-name')).toContainText(
      `Community proposals ${fixtureId.slice(0, 8)}`,
    );
    await expect(page.locator('#entities')).toContainText(candidateName);

    await page.locator('#award-email').fill(email);
    await page.locator('#award-password').fill(password);
    await page.locator('#award-login button[type="submit"]').click();
    await expect(page.locator('#profile-status')).toHaveText('Profile loaded.');

    const existingProposalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/geodata/proposals',
    );
    await page.locator(`.propose[data-id="${candidateId}"]`).click();
    const existingProposal = await existingProposalResponse;
    expect(existingProposal.status()).toBe(201);
    await expect(page.locator('#proposal-status')).toHaveText(
      'Proposal submitted for review.',
    );
    proposalRunIds.push((await existingProposal.json()).id as string);

    await page.getByRole('button', { name: 'Pick coordinates on map' }).click();
    await expect(
      page.getByRole('button', { name: 'Cancel map selection' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#map').scrollIntoViewIfNeeded();
    const mapBounds = await page.locator('#public-map-overlay').boundingBox();
    expect(mapBounds).not.toBeNull();
    await page.mouse.click(
      mapBounds!.x + mapBounds!.width / 2,
      mapBounds!.y + mapBounds!.height / 2,
    );
    await expect(page.locator('#proposal-status')).toContainText('Selected ');
    const latitude = Number(
      await page.locator('#proposal-latitude').inputValue(),
    );
    const longitude = Number(
      await page.locator('#proposal-longitude').inputValue(),
    );
    expect(latitude).toBeGreaterThanOrEqual(-90);
    expect(latitude).toBeLessThanOrEqual(90);
    expect(longitude).toBeGreaterThanOrEqual(-180);
    expect(longitude).toBeLessThanOrEqual(180);

    await page.locator('#proposal-name').fill(`Map-picked site ${fixtureId}`);
    const pointProposalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/geodata/proposals',
    );
    await page
      .getByRole('button', { name: 'Submit location proposal' })
      .click();
    const pointProposal = await pointProposalResponse;
    expect(pointProposal.status()).toBe(201);
    await expect(page.locator('#proposal-status')).toHaveText(
      'Proposal submitted for review.',
    );
    proposalRunIds.push((await pointProposal.json()).id as string);

    expect(proposalRequests).toHaveLength(2);
    expect(proposalRequests.map((item) => item.idempotencyKey)).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
    ]);
    expect(proposalRequests[0]?.body).toMatchObject({
      programmeSlug,
      entityTypes: [entityTypeCode],
      source: {
        name: 'Participant community proposal',
        license: 'programme-supplied',
      },
      feature: {
        type: 'Feature',
        properties: { name: candidateName },
        geometry: { type: 'Point', coordinates: [7, 46] },
      },
    });
    expect(proposalRequests[1]?.body).toMatchObject({
      programmeSlug,
      entityTypes: [entityTypeCode],
      feature: {
        type: 'Feature',
        properties: { name: pointProposalName },
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
      },
    });

    await expect
      .poll(
        async () => {
          const result = await geo.query<{ candidates: number }>(
            `SELECT count(*)::int AS candidates FROM geodata_import_candidate
             WHERE import_run_id=ANY($1::uuid[])`,
            [proposalRunIds],
          );
          return result.rows[0]?.candidates ?? 0;
        },
        { timeout: 60_000, intervals: [250] },
      )
      .toBe(2);

    const runs = await geo.query<{
      id: string;
      adapter_code: string;
      source_metadata: Record<string, unknown>;
    }>(
      `SELECT id::text,adapter_code,source_metadata FROM import_run
       WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)`,
      [proposalRunIds],
    );
    expect(runs.rows).toHaveLength(2);
    for (const run of runs.rows) {
      expect(run.adapter_code).toBe('MANUAL');
      expect(run.source_metadata).toMatchObject({
        programmeSlug,
        entityTypes: [entityTypeCode],
        featureCount: 1,
        communityProposal: { proposerId },
        source: {
          name: 'Participant community proposal',
          license: 'programme-supplied',
        },
      });
    }

    const candidates = await geo.query<{
      import_run_id: string;
      name: string;
      programme_slug: string;
      entity_type_codes: string[];
      candidate_source: Record<string, unknown>;
    }>(
      `SELECT import_run_id::text,name,programme_slug,entity_type_codes,
              entity_payload->'candidateSource' AS candidate_source
       FROM geodata_import_candidate
       WHERE import_run_id=ANY($1::uuid[])
       ORDER BY array_position($1::uuid[],import_run_id),ordinal`,
      [proposalRunIds],
    );
    expect(candidates.rows).toHaveLength(2);
    expect(candidates.rows.map((candidate) => candidate.name)).toEqual([
      candidateName,
      pointProposalName,
    ]);
    for (const [index, candidate] of candidates.rows.entries()) {
      const run = runs.rows[index];
      expect(run).toBeDefined();
      const proposal = run?.source_metadata.communityProposal as {
        proposalId: string;
        proposerId: string;
      };
      expect(candidate).toMatchObject({
        import_run_id: run?.id,
        name: index === 0 ? candidateName : pointProposalName,
        programme_slug: programmeSlug,
        entity_type_codes: [entityTypeCode],
        candidate_source: {
          type: 'COMMUNITY_PROPOSAL',
          proposalId: proposal.proposalId,
          proposerId: proposal.proposerId,
        },
      });
    }

    await expect
      .poll(
        async () => {
          const result = await geo.query<{ status: string }>(
            'SELECT status FROM import_run WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)',
            [proposalRunIds],
          );
          return result.rows.map((run) => run.status);
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toEqual(['COMPLETED', 'COMPLETED']);

    const promotedEntities = await geo.query<{
      name: string;
      validation_status: string;
      target_status: string;
      processed_entity_id: string;
      lifecycle_status: string;
      programme_slug: string;
      entity_type_code: string;
    }>(
      `SELECT c.name,c.validation_status,c.target_status,
              c.processed_entity_id::text,e.lifecycle_status,
              e.programme_slug,e.entity_type_code
       FROM geodata_import_candidate c
       JOIN geodata_entity e ON e.id=c.processed_entity_id
       WHERE c.import_run_id=ANY($1::uuid[])
       ORDER BY array_position($1::uuid[],c.import_run_id),c.ordinal`,
      [proposalRunIds],
    );
    expect(promotedEntities.rows).toHaveLength(2);
    expect(promotedEntities.rows.map((entity) => entity.name)).toEqual([
      candidateName,
      pointProposalName,
    ]);
    for (const entity of promotedEntities.rows) {
      expect(entity).toMatchObject({
        validation_status: 'PROCESSED',
        target_status: 'CANDIDATE',
        lifecycle_status: 'CANDIDATE',
        programme_slug: programmeSlug,
        entity_type_code: entityTypeCode,
      });
      expect(entity.processed_entity_id).toMatch(/^[0-9a-f-]{36}$/i);
    }

    await page.reload();
    await expect(page.locator('#entities')).toContainText(candidateName);
    await expect(page.locator('#entities')).toContainText(pointProposalName);
  } finally {
    if (proposalRunIds.length || candidateSeeded) {
      const geoClient = await geo.connect().catch(() => undefined);
      if (geoClient) {
        try {
          await geoClient.query('BEGIN');
          await geoClient.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          if (proposalRunIds.length) {
            const processedEntities = await geoClient.query<{ id: string }>(
              `SELECT processed_entity_id::text AS id
               FROM geodata_import_candidate
               WHERE import_run_id=ANY($1::uuid[])
                 AND processed_entity_id IS NOT NULL`,
              [proposalRunIds],
            );
            const processedEntityIds = processedEntities.rows.map(
              (row) => row.id,
            );
            if (processedEntityIds.length) {
              await geoClient.query(
                'DELETE FROM source_reference WHERE entity_id=ANY($1::uuid[])',
                [processedEntityIds],
              );
              await geoClient.query(
                `DELETE FROM geodata_audit_event
                 WHERE aggregate_type='entity' AND aggregate_id=ANY($1::text[])`,
                [processedEntityIds],
              );
              await geoClient.query(
                `DELETE FROM outbox_event
                 WHERE aggregate_type='entity' AND aggregate_id=ANY($1::text[])`,
                [processedEntityIds],
              );
              await geoClient.query(
                'DELETE FROM geodata_entity WHERE id=ANY($1::uuid[])',
                [processedEntityIds],
              );
            }
            const promotedRunId = proposalRunIds[1];
            if (promotedRunId) {
              await geoClient.query(
                `DELETE FROM idempotency_record
                 WHERE service='geodata-service' AND key LIKE $1`,
                [`http:%:/v1/geodata/imports/${promotedRunId}/process:%`],
              );
              await geoClient.query(
                `DELETE FROM outbox_event
                 WHERE producer='geodata-service'
                   AND aggregate_type='import_processing_queue'
                   AND aggregate_id IN (
                     SELECT id::text FROM geodata_import_processing_queue
                     WHERE import_run_id=$1::uuid
                   )`,
                [promotedRunId],
              );
            }
            await geoClient.query(
              'DELETE FROM source_snapshot_manifest WHERE import_run_id=ANY($1::uuid[])',
              [proposalRunIds],
            );
            await geoClient.query(
              `DELETE FROM outbox_event WHERE producer='geodata-service'
               AND aggregate_id=ANY($1::text[])`,
              [proposalRunIds],
            );
            await geoClient.query(
              `DELETE FROM idempotency_record WHERE service='geodata-service'
               AND key=ANY($1::text[])`,
              [
                proposalRequests.map(
                  (proposal) =>
                    `http:${proposerId}:/v1/geodata/proposals:${proposal.idempotencyKey}`,
                ),
              ],
            );
            await geoClient.query(
              'DELETE FROM import_run WHERE id=ANY($1::uuid[])',
              [proposalRunIds],
            );
          }
          if (candidateSeeded)
            await geoClient.query('DELETE FROM geodata_entity WHERE id=$1', [
              candidateId,
            ]);
          await geoClient.query('COMMIT');
        } catch {
          await geoClient.query('ROLLBACK').catch(() => undefined);
        } finally {
          geoClient.release();
        }
      }
    }

    if (process.env.CORE_DATABASE_URL) {
      const coreClient = await core.connect().catch(() => undefined);
      if (coreClient) {
        try {
          await coreClient.query('BEGIN');
          const savedProgramme = await coreClient.query<{ id: string }>(
            "SELECT payload->>'id' AS id FROM programme_record WHERE slug=$1",
            [programmeSlug],
          );
          const aggregateIds = [
            programmeId,
            ...savedProgramme.rows.map((row) => row.id),
            entityTypeCode,
          ].filter((id): id is string => Boolean(id));
          await coreClient.query(
            `DELETE FROM outbox_event WHERE producer='programmes'
             AND aggregate_id=ANY($1::text[])`,
            [aggregateIds],
          );
          await coreClient.query(
            "DELETE FROM idempotency_record WHERE service='programmes' AND key=$1",
            [programmeKey],
          );
          await coreClient.query('DELETE FROM programme_record WHERE slug=$1', [
            programmeSlug,
          ]);
          await coreClient.query(
            'DELETE FROM programme_entity_type WHERE code=$1',
            [entityTypeCode],
          );
          await coreClient.query('COMMIT');
        } catch {
          await coreClient.query('ROLLBACK').catch(() => undefined);
        } finally {
          coreClient.release();
        }
      }
    }
    await Promise.all([core.end(), geo.end()]);
  }
});

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import sharp from 'sharp';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('publishes, requests, and issues an award across both web apps', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const adminEmail =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const adminPassword =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const activityPool = new Pool({
    connectionString: process.env.ACTIVITY_DATABASE_URL,
    max: 1,
  });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-award-${fixtureId}`;
  const categoryCode = `E2E_${fixtureId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const awardCode = `LIVE_${fixtureId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const awardName = `Live browser award ${fixtureId.slice(0, 8)}`;
  const assetName = `Live background ${fixtureId.slice(0, 8)}`;
  const signatureName = `Live signature ${fixtureId.slice(0, 8)}`;
  const managerName = `Award manager ${fixtureId.slice(0, 8)}`;
  const accountEmail = `browser-award-${fixtureId}@example.test`;
  const accountDisplayName = `Award participant ${fixtureId.slice(0, 8)}`;
  const failedResponses: string[] = [];
  let awardId: string | undefined;
  let signatureAssetId: string | undefined;
  let accountId: string | undefined;
  let activationId: string | undefined;
  let adminAccessToken: string | undefined;

  try {
    const login = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/login',
      { data: { email: adminEmail, password: adminPassword } },
    );
    expect(login.ok()).toBeTruthy();
    const { accessToken } = await login.json();
    adminAccessToken = accessToken as string;
    const createdProgramme = await request.post(
      'http://127.0.0.1:8080/v1/programmes',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          slug: programmeSlug,
          name: `Live award programme ${fixtureId.slice(0, 8)}`,
          description: 'Created for the live Admin award workflow.',
          entityTypes: [
            {
              code: categoryCode,
              label: 'Award test point',
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
    expect(createdProgramme.status()).toBe(201);

    page.on('response', (response) => {
      if (response.url().includes('/v1/') && response.status() >= 400)
        failedResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.goto('http://127.0.0.1:8090/login');
    await page.getByLabel('Email').fill(adminEmail);
    await page.getByLabel('Password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('http://127.0.0.1:8090/awards');
    await page.locator('.programme-scope select').selectOption(programmeSlug);

    const background = await sharp({
      create: {
        width: 2240,
        height: 3167,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    await page.getByLabel('Asset type').selectOption('BACKGROUND');
    await page.getByLabel('Display name').fill(assetName);
    await page.getByLabel('Image file').setInputFiles({
      name: 'live-certificate-background.png',
      mimeType: 'image/png',
      buffer: background,
    });
    await page.getByRole('button', { name: 'Upload image asset' }).click();
    await expect(
      page.getByText('Image uploaded to the asset library.'),
    ).toBeVisible();

    const signature = await sharp({
      create: {
        width: 1200,
        height: 400,
        channels: 3,
        background: { r: 24, g: 64, b: 120 },
      },
    })
      .png()
      .toBuffer();
    await page.getByLabel('Asset type').selectOption('SIGNATURE');
    await page.getByLabel('Display name').fill(signatureName);
    await page.getByLabel('Image file').setInputFiles({
      name: 'live-award-signature.png',
      mimeType: 'image/png',
      buffer: signature,
    });
    await page.getByRole('button', { name: 'Upload image asset' }).click();
    await expect(
      page.getByText('Image uploaded to the asset library.'),
    ).toBeVisible();

    await page.getByLabel('Category').selectOption('ACTIVATOR');
    await page
      .getByLabel('Achievement metric')
      .selectOption('ACTIVATION_COUNT');
    await page.getByLabel('Condition JSON').fill(
      JSON.stringify({
        kind: 'AND',
        conditions: [{ kind: 'ACTIVATION_COUNT', operator: 'GTE', value: 1 }],
      }),
    );
    await page
      .getByLabel('Levels JSON')
      .fill(
        JSON.stringify([{ id: 'level-1', name: '1 activation', threshold: 1 }]),
      );
    await page.getByLabel('Code', { exact: true }).fill(awardCode);
    await page.getByLabel('Name', { exact: true }).fill(awardName);
    await page
      .getByLabel('Description', { exact: true })
      .fill('A live award workflow with a stored printable background.');
    await page.getByRole('button', { name: 'Save award draft' }).click();
    await expect(page.getByText('Award draft saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
    await page
      .getByLabel('Effective from (UTC)')
      .fill(new Date(Date.now() - 60_000).toISOString().slice(0, 16));
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Award published.')).toBeVisible();
    await expect(
      page.getByRole('button', { name: new RegExp(`${awardName}.*PUBLISHED`) }),
    ).toBeVisible();

    const createdAccount = await request.post(
      'http://127.0.0.1:8080/v1/identity/accounts',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          displayName: accountDisplayName,
          email: accountEmail,
          participationType: 'OPERATOR',
        },
      },
    );
    expect(createdAccount.status()).toBe(201);
    const account = await createdAccount.json();
    accountId = account.id as string;
    const activatedAccount = await request.patch(
      `http://127.0.0.1:8080/v1/identity/accounts/${accountId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { status: 'ACTIVE' },
      },
    );
    expect(activatedAccount.status()).toBe(200);

    const recovery = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/recovery/request',
      { data: { email: accountEmail } },
    );
    expect(recovery.ok()).toBeTruthy();
    const recoveryToken = (await recovery.json()).devResetToken as string;
    const participantPassword = `Browser-${randomUUID()}-Password!`;
    const reset = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/recovery/reset',
      { data: { token: recoveryToken, newPassword: participantPassword } },
    );
    expect(reset.status()).toBe(200);
    const participantLogin = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/login',
      { data: { email: accountEmail, password: participantPassword } },
    );
    expect(participantLogin.status()).toBe(200);
    const { accessToken: participantAccessToken } =
      await participantLogin.json();
    const participantHeaders = {
      Authorization: `Bearer ${participantAccessToken}`,
    };
    const callsignCreated = await request.post(
      `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          callsign: `DL${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`,
        },
      },
    );
    expect(callsignCreated.status()).toBe(201);
    const callsign = (await callsignCreated.json()).callsign as {
      id: string;
      value: string;
    };
    const evidence = await request.post(
      `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns/${callsign.id}/evidence`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { evidenceType: 'LICENSE', source: 'live award browser test' },
      },
    );
    expect(evidence.status()).toBe(201);
    const verification = await request.post(
      `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns/${callsign.id}/verify`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { source: 'live award browser test' },
      },
    );
    expect(verification.status()).toBe(200);

    const activation = await request.post(
      'http://127.0.0.1:8080/v1/activations',
      {
        headers: {
          ...participantHeaders,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          programmeSlug,
          entityId: `award-test-entity-${fixtureId}`,
          entityType: categoryCode,
          operatorId: accountId,
          operatorCallsign: callsign.value,
          callsignLifecycleStatus: 'VERIFIED',
          authorizedCallsigns: [callsign.value],
          programmeRules: {
            activationValidityDays: 7,
            minimumQsos: { activation: 1, hunter: 1 },
            publicAccessRequired: false,
          },
          location: {},
          startedAt: new Date().toISOString(),
        },
      },
    );
    expect(activation.status()).toBe(201);
    activationId = (await activation.json()).id as string;

    page.on('response', (response) => {
      if (response.url().includes('/v1/') && response.status() >= 400)
        failedResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`http://127.0.0.1:8091/#${programmeSlug}`);
    await page.locator('#award-email').fill(accountEmail);
    await page.locator('#award-password').fill(participantPassword);
    await page.getByRole('button', { name: /1 activation/ }).click();
    await expect(page.locator('#award-request-status')).toHaveText(
      'Award request submitted for programme review.',
    );

    const signatureAsset = await activityPool.query<{ id: string }>(
      `SELECT id::text FROM activity_asset
       WHERE kind='SIGNATURE' AND metadata->>'name'=$1
         AND metadata->>'contentStatus'='STORED'`,
      [signatureName],
    );
    expect(signatureAsset.rows).toHaveLength(1);
    signatureAssetId = signatureAsset.rows[0]?.id;

    await page.goto('http://127.0.0.1:8090/awards');
    await page.locator('.programme-scope select').selectOption(programmeSlug);
    await expect(page.getByText('Requests · 1')).toBeVisible();
    await page.getByLabel('Issuance manager name').fill(managerName);
    await page.getByLabel('Issuance signature').selectOption(signatureAssetId!);
    const issueAwardButton = page.getByRole('button', {
      name: `Issue award for ${callsign.value}`,
    });
    await expect(issueAwardButton).toBeEnabled();
    await issueAwardButton.click();
    await expect(page.getByRole('status')).toContainText(
      `Award issued to ${callsign.value}.`,
    );
    await expect(page.getByText('ISSUED', { exact: true })).toBeVisible();
    expect(failedResponses).toEqual([]);

    const award = await activityPool.query<{
      id: string;
      status: string;
      definition: { status: string; printReadiness: { printReady: boolean } };
    }>(
      `SELECT id::text,status,definition FROM activity_award_definition
       WHERE programme_slug=$1 AND code=$2`,
      [programmeSlug, awardCode],
    );
    expect(award.rows).toHaveLength(1);
    awardId = award.rows[0]?.id;
    expect(award.rows[0]).toMatchObject({
      status: 'PUBLISHED',
      definition: {
        programmeSlug,
        code: awardCode,
        name: awardName,
        category: 'ACTIVATOR',
        achievementMetric: 'ACTIVATION_COUNT',
        levels: [{ id: 'level-1', name: '1 activation', threshold: 1 }],
        status: 'PUBLISHED',
        printReadiness: { printReady: true },
      },
    });

    const asset = await activityPool.query<{
      id: string;
      content_status: string;
    }>(
      `SELECT id::text,content_status FROM activity_asset
       WHERE kind='BACKGROUND' AND metadata->>'name'=$1
         AND metadata->>'contentStatus'='STORED'
         AND object_key LIKE $2`,
      [assetName, `background/%/live-certificate-background.png`],
    );
    expect(asset.rows).toHaveLength(1);
    expect(asset.rows[0]?.content_status).toBe('STORED');

    const events = await activityPool.query<{
      event_type: string;
      status: string;
    }>(
      `SELECT event_type,payload->>'status' AS status FROM outbox_event
       WHERE aggregate_type='award' AND aggregate_id=$1
       ORDER BY occurred_at,event_id`,
      [awardId],
    );
    expect(events.rows).toMatchObject([
      { event_type: 'awards.definition.saved.v1', status: 'DRAFT' },
      { event_type: 'awards.definition.published.v1', status: 'PUBLISHED' },
    ]);

    const awardRequests = await activityPool.query<{
      id: string;
      level_id: string;
      subject_id: string;
      category: string;
      callsign: string;
      person_name: string;
      facts: { activationCount: number };
      status: string;
      issued_award_id: string;
    }>(
      `SELECT id::text,level_id,subject_id,category,callsign,person_name,facts,status,issued_award_id::text
       FROM activity_award_request WHERE award_id=$1`,
      [awardId],
    );
    expect(awardRequests.rows).toHaveLength(1);
    expect(awardRequests.rows[0]).toMatchObject({
      level_id: 'level-1',
      subject_id: accountId,
      category: 'ACTIVATOR',
      callsign: callsign.value,
      person_name: accountDisplayName,
      facts: { activationCount: 1 },
      status: 'ISSUED',
    });
    const issuance = await activityPool.query<{
      id: string;
      request_id: string;
      issuance: {
        managerName: string;
        signatureAssetId: string;
        artifact: { downloadReady: boolean };
      };
    }>(
      `SELECT id::text,request_id::text,issuance FROM activity_award_issuance
       WHERE award_id=$1`,
      [awardId],
    );
    expect(issuance.rows).toHaveLength(1);
    expect(issuance.rows[0]).toMatchObject({
      id: awardRequests.rows[0]?.issued_award_id,
      request_id: awardRequests.rows[0]?.id,
      issuance: {
        managerName,
        signatureAssetId,
        artifact: { downloadReady: false },
      },
    });
    const issuanceEvents = await activityPool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_event
       WHERE aggregate_type='award_issuance' AND aggregate_id=$1`,
      [issuance.rows[0]?.id],
    );
    expect(issuanceEvents.rows).toEqual([{ event_type: 'awards.issued.v1' }]);
  } finally {
    await activityPool.query('BEGIN');
    try {
      const fixtureAwards = await activityPool.query<{ id: string }>(
        `SELECT id::text FROM activity_award_definition
         WHERE programme_slug=$1 AND code=$2`,
        [programmeSlug, awardCode],
      );
      const fixtureAwardIds = fixtureAwards.rows.map((row) => row.id);
      if (fixtureAwardIds.length) {
        const fixtureRequests = await activityPool.query<{ id: string }>(
          'SELECT id::text FROM activity_award_request WHERE award_id=ANY($1::uuid[])',
          [fixtureAwardIds],
        );
        const fixtureRequestIds = fixtureRequests.rows.map((row) => row.id);
        if (fixtureRequestIds.length)
          await activityPool.query(
            "DELETE FROM outbox_event WHERE aggregate_type='award_request' AND aggregate_id=ANY($1::text[])",
            [fixtureRequestIds],
          );
        const fixtureIssuances = await activityPool.query<{ id: string }>(
          'SELECT id::text FROM activity_award_issuance WHERE award_id=ANY($1::uuid[])',
          [fixtureAwardIds],
        );
        const fixtureIssuanceIds = fixtureIssuances.rows.map((row) => row.id);
        if (fixtureIssuanceIds.length)
          await activityPool.query(
            "DELETE FROM outbox_event WHERE aggregate_type='award_issuance' AND aggregate_id=ANY($1::text[])",
            [fixtureIssuanceIds],
          );
        await activityPool.query(
          'DELETE FROM activity_award_issuance WHERE award_id=ANY($1::uuid[])',
          [fixtureAwardIds],
        );
      }
      if (fixtureAwardIds.length)
        await activityPool.query(
          'DELETE FROM activity_award_request WHERE award_id=ANY($1::uuid[])',
          [fixtureAwardIds],
        );
      if (fixtureAwardIds.length)
        await activityPool.query(
          'DELETE FROM activity_award_progress WHERE award_id=ANY($1::uuid[])',
          [fixtureAwardIds],
        );
      if (fixtureAwardIds.length)
        await activityPool.query(
          `DELETE FROM outbox_event
           WHERE aggregate_type='award' AND aggregate_id=ANY($1::text[])`,
          [fixtureAwardIds],
        );
      if (accountId) {
        await activityPool.query(
          'DELETE FROM activity_subject_callsign WHERE programme_slug=$1 AND subject_id=$2',
          [programmeSlug, accountId],
        );
        await activityPool.query(
          'DELETE FROM activity_subject_entity WHERE programme_slug=$1 AND subject_id=$2',
          [programmeSlug, accountId],
        );
        await activityPool.query(
          'DELETE FROM activity_subject_aggregate WHERE programme_slug=$1 AND subject_id=$2',
          [programmeSlug, accountId],
        );
      }
      if (activationId)
        await activityPool.query(
          "DELETE FROM outbox_event WHERE aggregate_type='activation' AND aggregate_id=$1",
          [activationId],
        );
      if (activationId)
        await activityPool.query(
          'DELETE FROM activity_activation WHERE id=$1',
          [activationId],
        );
      await activityPool.query(
        'DELETE FROM activity_award_definition WHERE programme_slug=$1 AND code=$2',
        [programmeSlug, awardCode],
      );
      await activityPool.query(
        "DELETE FROM activity_asset WHERE metadata->>'name'=ANY($1::text[])",
        [[assetName, signatureName]],
      );
      await activityPool.query('COMMIT');
    } catch (error) {
      await activityPool.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    if (accountId && adminAccessToken) {
      const anonymized = await request.patch(
        `http://127.0.0.1:8080/v1/identity/accounts/${accountId}`,
        {
          headers: { Authorization: `Bearer ${adminAccessToken}` },
          data: { status: 'DEACTIVATED', anonymize: true },
        },
      );
      expect(anonymized.status()).toBe(200);
    }
    await activityPool.end();
  }
});

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import sharp from 'sharp';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('creates, reviews, and publishes an award in Admin through Gateway', async ({
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
  const failedResponses: string[] = [];
  let awardId: string | undefined;

  try {
    const login = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/login',
      { data: { email: adminEmail, password: adminPassword } },
    );
    expect(login.ok()).toBeTruthy();
    const { accessToken } = await login.json();
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
  } finally {
    await activityPool.query('BEGIN');
    try {
      const fixtureAwards = await activityPool.query<{ id: string }>(
        `SELECT id::text FROM activity_award_definition
         WHERE programme_slug=$1 AND code=$2`,
        [programmeSlug, awardCode],
      );
      const fixtureAwardIds = fixtureAwards.rows.map((row) => row.id);
      if (fixtureAwardIds.length)
        await activityPool.query(
          `DELETE FROM outbox_event
           WHERE aggregate_type='award' AND aggregate_id=ANY($1::text[])`,
          [fixtureAwardIds],
        );
      await activityPool.query(
        'DELETE FROM activity_award_definition WHERE programme_slug=$1 AND code=$2',
        [programmeSlug, awardCode],
      );
      await activityPool.query(
        "DELETE FROM activity_asset WHERE metadata->>'name'=$1",
        [assetName],
      );
      await activityPool.query('COMMIT');
    } catch (error) {
      await activityPool.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await activityPool.end();
  }
});

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('creates and publishes programme content through the live Admin workflow', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const core = new Pool({
    connectionString: process.env.CORE_DATABASE_URL,
    max: 1,
  });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-content-${fixtureId}`;
  const categoryCode = `BC_${fixtureId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const programmeKey = randomUUID();
  const contentKey = `public.description.${fixtureId.slice(0, 8)}`;
  const contentValue = `Content published from Admin ${fixtureId}`;
  const contentMutationKeys: string[] = [];
  let programmeId: string | undefined;

  page.on('request', (browserRequest) => {
    const path = new URL(browserRequest.url()).pathname;
    if (
      path === `/v1/programmes/${programmeSlug}/content` ||
      new RegExp(`^/v1/programmes/${programmeSlug}/content/[^/]+$`).test(path)
    ) {
      const key = browserRequest.headers()['idempotency-key'];
      if (key) contentMutationKeys.push(key);
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
    const adminId = (await identity.json()).id as string;

    const programmeResponse = await request.post(
      'http://127.0.0.1:8080/v1/programmes',
      {
        headers: { ...headers, 'Idempotency-Key': programmeKey },
        data: {
          slug: programmeSlug,
          name: `Browser content ${fixtureId.slice(0, 8)}`,
          description: 'Live programme content browser fixture.',
          entityTypes: [
            {
              code: categoryCode,
              label: 'Content point',
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

    await page.goto('http://127.0.0.1:8090/content');
    await expect(page).toHaveURL(/\/login\?redirect=\/content$/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/content$/);
    await page.locator('.programme-scope select').selectOption(programmeSlug);
    await expect(page.getByText('No content drafts yet.')).toBeVisible();

    await page.getByRole('button', { name: 'New content draft' }).click();
    await page.getByLabel('Content key').fill(contentKey);
    await page.getByLabel('Locale', { exact: true }).fill('en');
    await page.getByLabel('Fallback locale').fill('');
    await page.getByLabel('Text or content value').fill(contentValue);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Content draft saved.')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Submit for review' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();

    const effectiveFrom = new Date(Date.now() - 60_000)
      .toISOString()
      .slice(0, 16);
    await page.getByLabel('Effective from (UTC)').fill(effectiveFrom);
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Content published.')).toBeVisible();
    await expect(page.locator('.status-pill.published')).toBeVisible();
    await expectResponsiveAccessible(
      page,
      'Live Admin published programme content',
    );

    expect(contentMutationKeys).toHaveLength(4);
    expect(
      contentMutationKeys.every((key) => /^[0-9a-f-]{36}$/i.test(key)),
    ).toBe(true);
    expect(new Set(contentMutationKeys).size).toBe(4);

    const savedContent = await core.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id,status,payload FROM programme_content
       WHERE programme_slug=$1 AND content_key=$2 AND locale='en'`,
      [programmeSlug, contentKey],
    );
    expect(savedContent.rows).toHaveLength(1);
    const content = savedContent.rows[0]!;
    expect(content.status).toBe('PUBLISHED');
    expect(content.payload).toMatchObject({
      id: content.id,
      programmeSlug,
      key: contentKey,
      locale: 'en',
      value: contentValue,
      status: 'PUBLISHED',
      publisherId: adminId,
      reviewHistory: [
        expect.objectContaining({ action: 'SUBMITTED' }),
        expect.objectContaining({ action: 'APPROVED', reviewerId: adminId }),
        expect.objectContaining({ action: 'PUBLISHED', publisherId: adminId }),
      ],
    });

    const published = await request.get(
      `http://127.0.0.1:8080/v1/public/programmes/${programmeSlug}/content?locale=en`,
    );
    expect(published.status()).toBe(200);
    expect(await published.json()).toMatchObject({
      programmeSlug,
      locale: 'en',
      items: [
        expect.objectContaining({
          key: contentKey,
          locale: 'en',
          value: contentValue,
        }),
      ],
    });

    const outbox = await core.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_event
       WHERE producer='programmes' AND aggregate_type='content' AND aggregate_id=$1
       ORDER BY occurred_at`,
      [content.id],
    );
    expect(outbox.rows.map((event) => event.event_type)).toEqual([
      'programme.content.saved.v1',
      'programme.content.submitted.v1',
      'programme.content.reviewed.v1',
      'programme.content.published.v1',
    ]);
  } finally {
    const cleanup = await core.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query('BEGIN');
        const content = await cleanup.query<{ id: string }>(
          'SELECT id FROM programme_content WHERE programme_slug=$1',
          [programmeSlug],
        );
        const contentIds = content.rows.map((row) => row.id);
        const savedProgramme = await cleanup.query<{ id: string }>(
          "SELECT payload->>'id' AS id FROM programme_record WHERE slug=$1",
          [programmeSlug],
        );
        const aggregateIds = [
          programmeId,
          ...savedProgramme.rows.map((row) => row.id),
          ...contentIds,
          categoryCode,
        ].filter((id): id is string => Boolean(id));
        await cleanup.query(
          `DELETE FROM outbox_event WHERE producer='programmes'
           AND aggregate_id=ANY($1::text[])`,
          [aggregateIds],
        );
        await cleanup.query(
          `DELETE FROM idempotency_record WHERE service='programmes'
           AND key=ANY($1::text[])`,
          [[programmeKey, ...contentMutationKeys]],
        );
        await cleanup.query(
          'DELETE FROM programme_content WHERE programme_slug=$1',
          [programmeSlug],
        );
        await cleanup.query('DELETE FROM programme_record WHERE slug=$1', [
          programmeSlug,
        ]);
        await cleanup.query('DELETE FROM programme_entity_type WHERE code=$1', [
          categoryCode,
        ]);
        await cleanup.query('COMMIT');
      } catch {
        await cleanup.query('ROLLBACK').catch(() => undefined);
      } finally {
        cleanup.release();
      }
    }
    await core.end();
  }
});

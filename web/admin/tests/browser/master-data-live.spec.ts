import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('creates shared categories and assigns them to a live programme', async ({
  page,
}) => {
  const databaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Core parity database');
  if (!databaseUrl) return;

  const fixtureId = randomUUID();
  const categoryCodeSuffix = fixtureId.replaceAll('-', '').toUpperCase();
  const categoryCodes = [
    `LIVE_${categoryCodeSuffix.slice(0, 8)}`,
    `LIVE_${categoryCodeSuffix.slice(8, 16)}`,
  ];
  const programmeSlug = `live-${fixtureId.slice(0, 8)}`;
  const categoryLabels = [
    `Live category ${fixtureId.slice(0, 8)}`,
    `Live category ${fixtureId.slice(8, 16)}`,
  ];
  const idempotencyKeys: string[] = [];
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let programmeId: string | undefined;

  page.on('request', (request) => {
    const key = request.headers()['idempotency-key'];
    if (key) idempotencyKeys.push(key);
  });

  try {
    await page.goto('/master-data');
    await expect(page).toHaveURL(/\/login\?redirect=\/master-data$/);
    await page
      .getByLabel('Email')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
          'browser-e2e-admin@example.test',
      );
    await page
      .getByLabel('Password')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ??
          'browser-e2e-password-7!Q',
      );
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/master-data$/);

    for (let index = 0; index < categoryCodes.length; index++) {
      if (index > 0)
        await page.getByRole('button', { name: 'New category' }).click();
      await page.getByLabel('Category code').fill(categoryCodes[index]!);
      await page.getByLabel('Display name').fill(categoryLabels[index]!);
      await page
        .getByRole('checkbox', {
          name: index === 0 ? 'Point' : 'LineString',
          exact: true,
        })
        .check();
      await page
        .getByLabel('Description')
        .fill('Live shared category fixture.');
      await page.getByRole('button', { name: 'Save category' }).click();
      await expect(page.getByText('Category saved.')).toBeVisible();
      await expect(
        page.getByRole('button', { name: new RegExp(categoryLabels[index]!) }),
      ).toContainText('Active');
    }

    await page.goto('/programmes');
    await page.getByRole('button', { name: 'New programme' }).click();
    await page.getByLabel('Programme identifier').fill(programmeSlug);
    await page
      .getByLabel('Programme name')
      .fill(`Live parity ${fixtureId.slice(0, 8)}`);
    await page.getByLabel('Description').fill('Live shared category workflow.');
    await page.getByLabel('Minimum activation QSOs').fill('0');
    await page.getByLabel('Minimum hunter QSOs').fill('0');
    const categorySelect = page.getByRole('combobox').nth(1);
    await expect(
      categorySelect.locator(`option[value="${categoryCodes[0]}"]`),
    ).toHaveCount(1);
    await categorySelect.selectOption(categoryCodes[0]!);
    await page.getByRole('button', { name: 'Save programme' }).click();
    await expect(page.getByText('Programme saved.')).toBeVisible();

    const assignmentPath = `/v1/programmes/${programmeSlug}/entity-types/${categoryCodes[1]}`;
    const [assignmentResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === assignmentPath &&
          response.request().method() === 'PUT',
      ),
      (async () => {
        await expect(
          categorySelect.locator(`option[value="${categoryCodes[1]}"]`),
        ).toHaveCount(1);
        await categorySelect.selectOption(categoryCodes[1]!);
      })(),
    ]);
    expect(assignmentResponse.status()).toBe(200);
    await expect(page.getByText('Category assigned.')).toBeVisible();

    const unassignmentPath = assignmentPath;
    const [unassignmentResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === unassignmentPath &&
          response.request().method() === 'DELETE',
      ),
      page.getByRole('button', { name: `Remove ${categoryCodes[1]}` }).click(),
    ]);
    expect(unassignmentResponse.status()).toBe(200);
    await expect(page.getByText('Category unassigned.')).toBeVisible();

    const programme = await pool.query<{
      id: string;
      entity_type_codes: string[];
    }>(
      `SELECT payload->>'id' AS id,
              payload->'entityTypeCodes' AS entity_type_codes
         FROM programme_record WHERE slug=$1`,
      [programmeSlug],
    );
    programmeId = programme.rows[0]?.id;
    expect(programme.rows[0]).toMatchObject({
      entity_type_codes: [categoryCodes[0]],
    });

    const catalogue = await pool.query<{
      code: string;
      label: string;
      active: boolean;
      geometry_types: string[];
    }>(
      `SELECT code,payload->>'label' AS label,
              (payload->>'active')::boolean AS active,
              ARRAY(SELECT jsonb_array_elements_text(payload->'geometryTypes')) AS geometry_types
         FROM programme_entity_type WHERE code=ANY($1::text[]) ORDER BY code`,
      [categoryCodes],
    );
    expect(catalogue.rows).toHaveLength(2);
    expect(catalogue.rows.map((row) => row.label).sort()).toEqual(
      [...categoryLabels].sort(),
    );
    expect(catalogue.rows.every((row) => row.active)).toBe(true);
    expect(catalogue.rows.every((row) => row.geometry_types.length > 0)).toBe(
      true,
    );

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_event
        WHERE producer='programmes' AND aggregate_id=ANY($1::text[])`,
      [[...categoryCodes, programmeId]],
    );
    const eventTypes = events.rows.map((row) => row.event_type);
    expect(
      eventTypes.filter(
        (eventType) => eventType === 'programme.entity-type.catalog-saved.v1',
      ),
    ).toHaveLength(2);
    expect(eventTypes).toContain('programme.created.v1');
    expect(eventTypes).toContain('programme.entity-type.assigned.v1');
    expect(eventTypes).toContain('programme.entity-type.unassigned.v1');

    await page.goto('/programmes');
    await page
      .locator('button.table-row')
      .filter({ hasText: programmeSlug })
      .click();
    await expect(
      page.getByRole('heading', { name: /Edit Live parity/ }),
    ).toBeVisible();
    const updatedProgrammeName = `Updated live parity ${fixtureId.slice(0, 8)}`;
    await page.getByLabel('Programme name').fill(updatedProgrammeName);
    await page
      .getByLabel('Description')
      .fill('Updated through the live Admin programme editor.');
    await page.getByRole('button', { name: 'Save programme' }).click();
    await expect(page.getByText('Programme saved.')).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Archive programme' }).click();
    await expect(page.getByText('Programme archived.')).toBeVisible();
    await expectResponsiveAccessible(
      page,
      'Live Admin programme archive result',
    );

    const archivedProgramme = await pool.query<{
      payload: {
        name: string;
        description: string;
        status: string;
      };
    }>('SELECT payload FROM programme_record WHERE slug=$1', [programmeSlug]);
    expect(archivedProgramme.rows[0]?.payload).toMatchObject({
      name: updatedProgrammeName,
      description: 'Updated through the live Admin programme editor.',
      status: 'ARCHIVED',
    });
    const lifecycleEvents = await pool.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type,payload FROM outbox_event
        WHERE producer='programmes' AND aggregate_id=$1`,
      [programmeId],
    );
    expect(lifecycleEvents.rows.map((row) => row.event_type)).toContain(
      'programme.updated.v1',
    );
    expect(lifecycleEvents.rows.map((row) => row.event_type)).toContain(
      'programme.archived.v1',
    );
    expect(
      lifecycleEvents.rows.find(
        (row) => row.event_type === 'programme.updated.v1',
      )?.payload,
    ).toMatchObject({ name: updatedProgrammeName });
    expect(
      lifecycleEvents.rows.find(
        (row) => row.event_type === 'programme.archived.v1',
      )?.payload,
    ).toEqual({ slug: programmeSlug });
    expect(idempotencyKeys).toHaveLength(7);
    expect(idempotencyKeys.every((key) => /^[0-9a-f-]{36}$/i.test(key))).toBe(
      true,
    );
  } finally {
    const cleanup = await pool.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query('BEGIN');
        const savedProgramme = await cleanup.query<{ id: string }>(
          "SELECT payload->>'id' AS id FROM programme_record WHERE slug=$1",
          [programmeSlug],
        );
        const aggregateIds = [
          ...categoryCodes,
          programmeId,
          ...savedProgramme.rows.map((row) => row.id),
        ].filter((id): id is string => Boolean(id));
        await cleanup.query(
          `DELETE FROM outbox_event WHERE producer='programmes'
            AND aggregate_id=ANY($1::text[])`,
          [aggregateIds],
        );
        await cleanup.query(
          "DELETE FROM idempotency_record WHERE service='programmes' AND key=ANY($1::text[])",
          [idempotencyKeys],
        );
        await cleanup.query('DELETE FROM programme_record WHERE slug=$1', [
          programmeSlug,
        ]);
        await cleanup.query(
          'DELETE FROM programme_entity_type WHERE code=ANY($1::text[])',
          [categoryCodes],
        );
        await cleanup.query('COMMIT');
      } catch {
        await cleanup.query('ROLLBACK').catch(() => undefined);
      } finally {
        cleanup.release();
      }
    }
    await pool.end();
  }
});

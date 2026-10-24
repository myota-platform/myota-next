import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('creates and manages an account through live Admin', async ({
  page,
  request,
}) => {
  const databaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(
    !databaseUrl,
    'requires the isolated Core parity database and live Identity services',
  );
  if (!databaseUrl) return;

  const fixtureId = randomUUID();
  const displayName = `Export account ${fixtureId.slice(0, 8)}`;
  const email = `export-${fixtureId}@example.test`;
  const password = `Export-account-${fixtureId}-password!`;
  const callsignSuffix = fixtureId
    .replaceAll('-', '')
    .slice(0, 7)
    .toUpperCase();
  const firstCallsign = `M${callsignSuffix}`;
  const replacementCallsign = `N${callsignSuffix}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const gateway = 'http://127.0.0.1:8080';
  let accountId: string | undefined;

  try {
    const adminEmail =
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
      'browser-e2e-admin@example.test';
    const adminPassword =
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
    const adminLogin = await request.post(`${gateway}/v1/identity/auth/login`, {
      data: { email: adminEmail, password: adminPassword },
    });
    const adminSession = (await adminLogin.json()) as {
      accessToken: string;
    };
    expect(adminLogin.status(), JSON.stringify(adminSession)).toBe(200);
    const authorization = {
      Authorization: `Bearer ${adminSession.accessToken}`,
    };

    await page.goto('/identity');
    await expect(page).toHaveURL(/\/login\?redirect=\/identity$/);
    await page.getByLabel('Email').fill(adminEmail);
    await page.getByLabel('Password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/identity$/);

    await page.getByRole('button', { name: 'Create account' }).first().click();
    await page.getByLabel('Display name').fill(displayName);
    await page.getByLabel('Email').last().fill(email);
    await page.getByLabel(/Activity administrator/).check();
    await expect(page.getByLabel(/Global administrator/)).toHaveCount(0);
    const createResponsePromise = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname === '/v1/identity/accounts' &&
        response.request().method() === 'POST'
      );
    });
    await page.getByRole('button', { name: 'Create account' }).last().click();
    const created = await createResponsePromise;
    const createdAccount = (await created.json()) as { id: string };
    expect(created.status(), JSON.stringify(createdAccount)).toBe(201);
    expect(created.request().headers()['idempotency-key']).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    accountId = createdAccount.id;
    await expect(
      page.getByText(
        'Account created with status PENDING_SETUP. No invitation was sent; invitation delivery is not available yet.',
      ),
    ).toBeVisible();
    const initialState = await pool.query<{
      display_name: string;
      email: string;
      status: string;
    }>('SELECT display_name,email,status FROM public.account WHERE id=$1', [
      accountId,
    ]);
    expect(initialState.rows).toEqual([
      { display_name: displayName, email, status: 'PENDING_SETUP' },
    ]);
    const initialRoles = await pool.query<{
      role_code: string;
      scopes: string[];
    }>(
      `SELECT role_code,scopes FROM public.account_role
        WHERE account_id=$1 AND valid_to IS NULL`,
      [accountId],
    );
    expect(initialRoles.rows).toEqual(
      expect.arrayContaining([
        { role_code: 'PARTICIPANT', scopes: [] },
        {
          role_code: 'ACTIVITY_ADMIN',
          scopes: ['activity.read', 'activity.admin'],
        },
      ]),
    );
    expect(initialRoles.rows).toHaveLength(2);

    const activated = await request.patch(
      `${gateway}/v1/identity/accounts/${accountId}`,
      {
        headers: authorization,
        data: { status: 'ACTIVE', password },
      },
    );
    expect(activated.status(), await activated.text()).toBe(200);

    await page.getByLabel('Search users').fill(displayName);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(displayName) }).click();

    const callsignRows = page.locator('.callsign-management .callsign-row');
    const addCallsignForm = page.locator('.callsign-management form').first();
    await addCallsignForm.getByLabel('Callsign').fill(firstCallsign);
    await addCallsignForm
      .getByLabel('Initial status')
      .selectOption('UNVERIFIED');
    await addCallsignForm.getByLabel('Source').fill('operator-asserted');
    await addCallsignForm.getByRole('button', { name: 'Add callsign' }).click();
    const firstRow = callsignRows.filter({ hasText: firstCallsign });
    await expect(firstRow).toBeVisible();

    const evidenceForm = page.locator('.callsign-management form').nth(1);
    await evidenceForm
      .getByLabel('Callsign')
      .selectOption({ label: firstCallsign });
    await evidenceForm.getByLabel('Evidence type').fill('LICENSE');
    await evidenceForm.getByLabel('Source').fill('regulator record');
    await evidenceForm
      .getByLabel('Metadata JSON (optional)')
      .fill('{"reference":"AB-123"}');
    await evidenceForm.getByRole('button', { name: 'Submit evidence' }).click();
    await expect(firstRow).toContainText('1 evidence record');

    await page.getByLabel('Verification source').fill('manual-review');
    await firstRow.getByRole('button', { name: 'Verify' }).click();
    await expect(firstRow).toContainText('Verified by manual-review');

    await addCallsignForm.getByLabel('Callsign').fill(replacementCallsign);
    await addCallsignForm.getByLabel('Initial status').selectOption('VERIFIED');
    await addCallsignForm.getByLabel('Source').fill('replacement-asserted');
    await addCallsignForm.getByRole('button', { name: 'Add callsign' }).click();
    const replacementRow = callsignRows.filter({
      hasText: replacementCallsign,
    });
    await expect(replacementRow).toContainText('VERIFIED');

    await replacementRow.getByRole('button', { name: 'Make primary' }).click();
    await expect(replacementRow).toContainText('Primary');
    await firstRow.getByRole('button', { name: 'Make primary' }).click();
    await expect(firstRow).toContainText('Primary');

    page.once('dialog', (dialog) => dialog.accept());
    await firstRow.getByRole('button', { name: 'Retire' }).click();
    await page
      .getByLabel('Replacement primary callsign')
      .selectOption({ label: replacementCallsign });
    await page.getByRole('button', { name: 'Retire callsign' }).click();
    await expect(firstRow).toContainText('RETIRED');
    await expect(replacementRow).toContainText('Primary');

    const callsignState = await pool.query<{
      value: string;
      lifecycle_status: string;
      verification_source: string | null;
      evidence_count: string;
      is_primary: boolean;
    }>(
      `SELECT c.value,c.lifecycle_status,c.verification_source,
              count(e.id)::text AS evidence_count,
              (primary_call.callsign_id=c.id) AS is_primary
         FROM public.callsign c
         LEFT JOIN public.callsign_evidence e ON e.callsign_id=c.id
         LEFT JOIN public.account_primary_callsign primary_call
           ON primary_call.account_id=c.account_id
        WHERE c.account_id=$1
        GROUP BY c.id,primary_call.callsign_id
        ORDER BY c.value`,
      [accountId],
    );
    expect(callsignState.rows).toEqual([
      {
        value: firstCallsign,
        lifecycle_status: 'RETIRED',
        verification_source: 'manual-review',
        evidence_count: '1',
        is_primary: false,
      },
      {
        value: replacementCallsign,
        lifecycle_status: 'VERIFIED',
        verification_source: 'replacement-asserted',
        evidence_count: '0',
        is_primary: true,
      },
    ]);
    const callsignEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM public.outbox_event
        WHERE producer='identity' AND (
          aggregate_id=$1::text OR aggregate_id IN (
            SELECT id::text FROM public.callsign WHERE account_id=$1::uuid
          )
        )`,
      [accountId],
    );
    expect(callsignEvents.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        'identity.callsign.added.v1',
        'identity.callsign.evidence-submitted.v1',
        'identity.callsign.verified.v1',
        'identity.callsign.primary-changed.v1',
        'identity.callsign.retired.v1',
      ]),
    );

    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export account', exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      `myota-account-${accountId}.json`,
    );
    const exportData = JSON.parse(
      await readFile((await download.path())!, 'utf8'),
    ) as { account: Record<string, unknown> };
    expect(exportData.account).toMatchObject({
      id: accountId,
      displayName,
      email,
      status: 'ACTIVE',
    });

    let confirmationText = '';
    page.once('dialog', async (dialog) => {
      confirmationText = dialog.message();
      await dialog.accept();
    });
    const deactivateResponse = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname ===
          `/v1/identity/accounts/${accountId}` &&
        response.request().method() === 'PATCH'
      );
    });
    await page
      .getByRole('button', { name: 'Deactivate and anonymize' })
      .click();
    const deactivated = await deactivateResponse;
    expect(deactivated.status(), await deactivated.text()).toBe(200);
    await expect(
      page.getByText('Account deactivated and anonymized.'),
    ).toBeVisible();
    await expect(page.getByText('No users match this search.')).toBeVisible();
    await expectResponsiveAccessible(
      page,
      'Live Admin account deactivation result',
    );
    expect(confirmationText).toBe(`Deactivate and anonymize ${displayName}?`);

    const persisted = await pool.query<{
      display_name: string;
      email: string | null;
      status: string;
      website_url: string | null;
      biography_markdown: string | null;
    }>(
      `SELECT a.display_name,a.email::text AS email,a.status,
              p.website_url,p.biography_markdown
         FROM public.account a
         LEFT JOIN public.identity_account_profile p ON p.account_id=a.id
        WHERE a.id=$1`,
      [accountId],
    );
    expect(persisted.rows).toEqual([
      {
        display_name: 'Deactivated account',
        email: null,
        status: 'DEACTIVATED',
        website_url: null,
        biography_markdown: null,
      },
    ]);
    const lifecycleEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM public.outbox_event
        WHERE producer='identity' AND aggregate_id=$1
        ORDER BY occurred_at,event_id`,
      [accountId],
    );
    expect(lifecycleEvents.rows.map((row) => row.event_type)).toContain(
      'identity.account.deactivated.v1',
    );
  } finally {
    await cleanupAccount(pool, accountId);
    await pool.end();
  }
});

async function cleanupAccount(pool: Pool, accountId: string | undefined) {
  if (!accountId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM public.outbox_event WHERE aggregate_id=$1',
      [accountId],
    );
    await client.query(
      `DELETE FROM public.security_event
        WHERE account_id=$1::uuid OR payload->>'accountId'=$1::text`,
      [accountId],
    );
    await client.query(
      "DELETE FROM public.idempotency_record WHERE response->>'id'=$1",
      [accountId],
    );
    await client.query(
      'DELETE FROM public.account_recovery_token WHERE account_id=$1',
      [accountId],
    );
    await client.query('DELETE FROM public.auth_session WHERE account_id=$1', [
      accountId,
    ]);
    await client.query(
      'DELETE FROM public.account_primary_callsign WHERE account_id=$1',
      [accountId],
    );
    await client.query(
      'DELETE FROM public.approver_scope WHERE account_id=$1',
      [accountId],
    );
    await client.query(
      `DELETE FROM public.callsign_evidence
        WHERE submitted_by=$1 OR callsign_id IN
          (SELECT id FROM public.callsign WHERE account_id=$1)`,
      [accountId],
    );
    await client.query('DELETE FROM public.callsign WHERE account_id=$1', [
      accountId,
    ]);
    await client.query('DELETE FROM public.account_role WHERE account_id=$1', [
      accountId,
    ]);
    await client.query(
      'DELETE FROM public.identity_account_profile WHERE account_id=$1',
      [accountId],
    );
    await client.query(
      'DELETE FROM public.account_credential WHERE account_id=$1',
      [accountId],
    );
    await client.query('DELETE FROM public.account WHERE id=$1', [accountId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

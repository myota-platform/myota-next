import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('exports and anonymizes an account through the live Admin workflow', async ({
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

    const created = await request.post(`${gateway}/v1/identity/accounts`, {
      headers: { ...authorization, 'Idempotency-Key': randomUUID() },
      data: { displayName, email, participationType: 'OPERATOR' },
    });
    const createdAccount = (await created.json()) as { id: string };
    expect(created.status(), JSON.stringify(createdAccount)).toBe(201);
    accountId = createdAccount.id;

    const activated = await request.patch(
      `${gateway}/v1/identity/accounts/${accountId}`,
      {
        headers: authorization,
        data: { status: 'ACTIVE', password },
      },
    );
    expect(activated.status(), await activated.text()).toBe(200);

    await page.goto('/identity');
    await expect(page).toHaveURL(/\/login\?redirect=\/identity$/);
    await page.getByLabel('Email').fill(adminEmail);
    await page.getByLabel('Password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/identity$/);
    await page.getByLabel('Search users').fill(displayName);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(displayName) }).click();

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

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('preserves scoped roles and refresh sessions across live account edits', async ({
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
  const targetName = `Scoped account ${fixtureId.slice(0, 8)}`;
  const blockerName = `Email blocker ${fixtureId.slice(0, 8)}`;
  const targetEmail = `scoped-${fixtureId}@example.test`;
  const blockerEmail = `blocker-${fixtureId}@example.test`;
  const updatedName = `Updated scoped account ${fixtureId.slice(0, 8)}`;
  const updatedEmail = `updated-${fixtureId}@example.test`;
  const participantPassword = `Scoped-account-${fixtureId}-password!`;
  const resetPassword = `Reset-${fixtureId}-password!`;
  const programmeSlug = `scope-${fixtureId.slice(0, 8)}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const gateway = 'http://127.0.0.1:8080';
  let targetAccountId: string | undefined;
  let blockerAccountId: string | undefined;
  const updates: Array<{
    status: number;
    body: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];

  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (
      url.pathname.startsWith('/v1/identity/accounts/') &&
      browserRequest.method() === 'PATCH'
    ) {
      updates.push({
        status: 0,
        body: browserRequest.postDataJSON() as Record<string, unknown>,
        idempotencyKey: browserRequest.headers()['idempotency-key'] ?? '',
      });
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.startsWith('/v1/identity/accounts/') &&
      response.request().method() === 'PATCH'
    ) {
      const update = updates.at(-1);
      if (update) update.status = response.status();
    }
  });

  try {
    const adminEmail =
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
      'browser-e2e-admin@example.test';
    const adminPassword =
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
    const login = await request.post(`${gateway}/v1/identity/auth/login`, {
      data: { email: adminEmail, password: adminPassword },
    });
    const loginBody = (await login.json()) as { accessToken: string };
    expect(login.status(), JSON.stringify(loginBody)).toBe(200);
    const { accessToken } = loginBody;
    const authorization = { Authorization: `Bearer ${accessToken}` };

    const createAccount = async (displayName: string, email: string) => {
      const response = await request.post(`${gateway}/v1/identity/accounts`, {
        headers: { ...authorization, 'Idempotency-Key': randomUUID() },
        data: { displayName, email, participationType: 'OPERATOR' },
      });
      const body = (await response.json()) as { id: string };
      expect(response.status(), JSON.stringify(body)).toBe(201);
      return body;
    };
    const target = await createAccount(targetName, targetEmail);
    targetAccountId = target.id;
    const blocker = await createAccount(blockerName, blockerEmail);
    blockerAccountId = blocker.id;

    const activate = await request.patch(
      `${gateway}/v1/identity/accounts/${targetAccountId}`,
      {
        headers: authorization,
        data: { status: 'ACTIVE', password: participantPassword },
      },
    );
    expect(activate.status(), await activate.text()).toBe(200);
    const roleAssignment = await request.put(
      `${gateway}/v1/identity/accounts/${targetAccountId}/role-assignments`,
      {
        headers: authorization,
        data: {
          roles: [
            {
              role: 'GEO_APPROVER',
              programmeSlug,
              jurisdiction: 'CH',
              entityType: 'SUMMIT',
            },
          ],
        },
      },
    );
    expect(roleAssignment.status(), await roleAssignment.text()).toBe(200);

    await page.goto('/identity');
    await expect(page).toHaveURL(/\/login\?redirect=\/identity$/);
    await page.getByLabel('Email').fill(adminEmail);
    await page.getByLabel('Password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/identity$/);
    await page.getByLabel('Search users').fill(targetName);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(targetName) }).click();
    await expect(
      page.getByText(`GEO_APPROVER · ${programmeSlug} · CH · SUMMIT`),
    ).toBeVisible();

    await page.getByLabel('Email').fill(blockerEmail);
    const duplicateEmailResponse = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname ===
          `/v1/identity/accounts/${targetAccountId}` &&
        response.request().method() === 'PATCH'
      );
    });
    await page.getByRole('button', { name: 'Save user' }).click();
    const duplicate = await duplicateEmailResponse;
    expect(duplicate.status()).toBe(400);
    await expect(page.getByText('email already exists')).toBeVisible();

    await page.getByLabel('Display name').fill(updatedName);
    await page.getByLabel('Email').fill(updatedEmail);
    const successfulUpdateResponse = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname ===
          `/v1/identity/accounts/${targetAccountId}` &&
        response.request().method() === 'PATCH'
      );
    });
    await page.getByRole('button', { name: 'Save user' }).click();
    const updated = await successfulUpdateResponse;
    expect(updated.status(), await updated.text()).toBe(200);
    await expect(
      page.getByText(
        'User saved. Existing scoped role assignments have been preserved.',
      ),
    ).toBeVisible();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      status: 400,
      body: {
        email: blockerEmail,
        status: 'ACTIVE',
      },
    });
    expect(updates[1]).toMatchObject({
      status: 200,
      body: {
        displayName: updatedName,
        email: updatedEmail,
        status: 'ACTIVE',
      },
    });
    expect(updates.every((update) => !('roles' in update.body))).toBe(true);
    expect(updates.every((update) => update.idempotencyKey.length > 0)).toBe(
      true,
    );

    const participantLogin = await request.post(
      `${gateway}/v1/identity/auth/login`,
      { data: { email: updatedEmail, password: participantPassword } },
    );
    const participantSession = (await participantLogin.json()) as {
      refreshToken: string;
    };
    expect(participantLogin.status(), JSON.stringify(participantSession)).toBe(
      200,
    );

    await page.getByLabel('Reset password').fill(resetPassword);
    const passwordUpdateResponse = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname ===
          `/v1/identity/accounts/${targetAccountId}` &&
        response.request().method() === 'PATCH'
      );
    });
    await page.getByRole('button', { name: 'Save user' }).click();
    const passwordUpdate = await passwordUpdateResponse;
    expect(passwordUpdate.status(), await passwordUpdate.text()).toBe(200);
    await expect(
      page.getByText(
        'User saved. Existing scoped role assignments have been preserved.',
      ),
    ).toBeVisible();
    expect(updates).toHaveLength(3);
    expect(updates[2]).toMatchObject({
      status: 200,
      body: { password: resetPassword, status: 'ACTIVE' },
    });
    expect(updates[2]?.idempotencyKey).not.toBe('');

    const oldPasswordLogin = await request.post(
      `${gateway}/v1/identity/auth/login`,
      { data: { email: updatedEmail, password: participantPassword } },
    );
    expect(oldPasswordLogin.status()).toBe(400);
    const resetPasswordLogin = await request.post(
      `${gateway}/v1/identity/auth/login`,
      { data: { email: updatedEmail, password: resetPassword } },
    );
    const resetPasswordSession = (await resetPasswordLogin.json()) as {
      refreshToken: string;
    };
    expect(
      resetPasswordLogin.status(),
      JSON.stringify(resetPasswordSession),
    ).toBe(200);

    const revokedSession = await request.post(
      `${gateway}/v1/identity/auth/refresh`,
      { data: { refreshToken: participantSession.refreshToken } },
    );
    expect(revokedSession.status()).toBe(401);

    const deactivate = await request.patch(
      `${gateway}/v1/identity/accounts/${targetAccountId}`,
      {
        headers: { ...authorization, 'Idempotency-Key': randomUUID() },
        data: { status: 'DEACTIVATED' },
      },
    );
    expect(deactivate.status(), await deactivate.text()).toBe(200);

    const rotatedSession = await request.post(
      `${gateway}/v1/identity/auth/refresh`,
      { data: { refreshToken: resetPasswordSession.refreshToken } },
    );
    const rotatedSessionBody = (await rotatedSession.json()) as {
      account: { status: string };
      refreshToken: string;
    };
    expect(rotatedSession.status(), JSON.stringify(rotatedSessionBody)).toBe(
      200,
    );
    expect(rotatedSessionBody.account.status).toBe('DEACTIVATED');
    expect(rotatedSessionBody.refreshToken).not.toBe(
      resetPasswordSession.refreshToken,
    );

    const persisted = await pool.query<{
      display_name: string;
      email: string;
      status: string;
      role_code: string;
      programme_slug: string;
      jurisdiction_code: string;
      entity_type_code: string;
    }>(
      `SELECT a.display_name,a.email::text AS email,a.status,
              r.role_code,r.programme_slug,r.jurisdiction_code,r.entity_type_code
         FROM public.account a
         JOIN public.account_role r ON r.account_id=a.id
        WHERE a.id=$1 AND r.valid_to IS NULL`,
      [targetAccountId],
    );
    expect(persisted.rows).toEqual([
      {
        display_name: updatedName,
        email: updatedEmail,
        status: 'DEACTIVATED',
        role_code: 'GEO_APPROVER',
        programme_slug: programmeSlug,
        jurisdiction_code: 'CH',
        entity_type_code: 'SUMMIT',
      },
    ]);
  } finally {
    await cleanupAccount(pool, blockerAccountId);
    await cleanupAccount(pool, targetAccountId);
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

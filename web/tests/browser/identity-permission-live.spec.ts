import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../a11y';

const scryptAsync = promisify(scrypt);

test('denies a least-privilege account access to Admin through live Identity and Gateway', async ({
  page,
}) => {
  const databaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Core parity database');
  if (!databaseUrl) return;

  const accountId = randomUUID();
  const email = `browser-permission-${accountId}@example.test`;
  const password = `browser-password-${randomUUID()}!`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, 64, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  const passwordHash = `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;

  try {
    await pool.query(
      `INSERT INTO public.account
         (id, display_name, email, identity_email_key, participation_type, status)
       VALUES ($1, $2, $3::public.citext, $3, 'OPERATOR', 'ACTIVE')`,
      [accountId, 'Browser Activity Reader', email],
    );
    await pool.query(
      `INSERT INTO public.account_credential (account_id, password_hash)
       VALUES ($1, $2)`,
      [accountId, passwordHash],
    );
    await pool.query(
      `INSERT INTO public.account_role (account_id, role_code, scopes)
       VALUES ($1, 'BROWSER_ACTIVITY_READER', $2::jsonb)`,
      [accountId, JSON.stringify(['activity.read'])],
    );

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    const currentAccount = await page.evaluate(async () => {
      const token = localStorage.getItem('myota_admin_access');
      if (!token) throw new Error('Admin access token was not saved');
      const response = await fetch('/v1/identity/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    });
    expect(currentAccount.status).toBe(200);
    expect(currentAccount.body.scopes).toEqual(['activity.read']);

    await page.goto('/identity');
    await expect(page).toHaveURL(/\/access-denied$/);
    await expect(
      page.getByRole('heading', { name: /access not available/i }),
    ).toBeVisible();

    const deniedAdminRequest = await page.evaluate(async () => {
      const token = localStorage.getItem('myota_admin_access');
      if (!token) throw new Error('Admin access token was not saved');
      const response = await fetch(
        '/v1/identity/admin/accounts?page=1&pageSize=20',
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      return { status: response.status, body: await response.json() };
    });
    expect(deniedAdminRequest.status).toBe(403);
    expect(
      deniedAdminRequest.body.detail ?? deniedAdminRequest.body.message,
    ).toBe('identity.admin scope is required');
    await expectResponsiveAccessible(page, 'Live Admin permission denial');
  } finally {
    await pool.query('DELETE FROM public.auth_session WHERE account_id=$1', [
      accountId,
    ]);
    await pool.query('DELETE FROM public.account_role WHERE account_id=$1', [
      accountId,
    ]);
    await pool.query(
      'DELETE FROM public.account_credential WHERE account_id=$1',
      [accountId],
    );
    await pool.query('DELETE FROM public.security_event WHERE account_id=$1', [
      accountId,
    ]);
    await pool.query('DELETE FROM public.account WHERE id=$1', [accountId]);
    await pool.end();
  }
});

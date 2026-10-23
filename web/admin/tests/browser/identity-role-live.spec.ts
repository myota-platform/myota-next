import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('creates and edits a custom Identity role through live Admin and Gateway', async ({
  page,
}) => {
  const databaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Core parity database');
  if (!databaseUrl) return;

  const roleCode = `LIVE_ROLE_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const roleName = `Live Content Reviewer ${roleCode.slice(-6)}`;
  const updatedRoleName = `${roleName} Updated`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const idempotencyKeys: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('/v1/identity/roles') &&
      ['POST', 'PATCH'].includes(request.method())
    ) {
      const key = request.headers()['idempotency-key'];
      if (key) idempotencyKeys.push(key);
    }
  });

  try {
    await page.goto('/identity?tab=roles');
    await expect(page).toHaveURL(/\/login\?redirect=\/identity\?tab=roles$/);
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
    await expect(page).toHaveURL(/\/identity\?tab=roles$/);

    await page.getByRole('button', { name: 'New custom role' }).click();
    await page.getByLabel('Role code').fill(roleCode.toLowerCase());
    await page.getByLabel('Display name').fill(roleName);
    await page
      .getByLabel('Description')
      .fill('Live role lifecycle parity fixture.');
    await page.getByLabel('programme.content.manage').check();
    const createResponse = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname === '/v1/identity/roles' &&
        response.request().method() === 'POST'
      );
    });
    await page.getByRole('button', { name: 'Save role' }).click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(201);
    await expect(page.getByText('Role saved.')).toBeVisible();
    await expect(page.getByRole('heading', { name: roleName })).toBeVisible();

    const roleRow = page.getByRole('button', { name: roleName });
    await expect(roleRow).toContainText(roleCode);
    await roleRow.click();
    await page.getByLabel('Display name').fill(updatedRoleName);
    await page.getByLabel('programme.content.manage').uncheck();
    await page.getByLabel('activity.admin').check();
    const updateResponse = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname === `/v1/identity/roles/${roleCode}` &&
        response.request().method() === 'PATCH'
      );
    });
    await page.getByRole('button', { name: 'Save role' }).click();
    const updated = await updateResponse;
    expect(updated.status(), await updated.text()).toBe(200);
    await expect(page.getByText('Role saved.')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: updatedRoleName }),
    ).toBeVisible();
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys.every(Boolean)).toBe(true);

    await page.reload();
    const updatedRoleRow = page.getByRole('button', {
      name: updatedRoleName,
    });
    await expect(updatedRoleRow).toContainText(roleCode);
    await updatedRoleRow.click();
    await expect(page.getByLabel('activity.admin')).toBeChecked();
    await expect(page.getByLabel('programme.content.manage')).not.toBeChecked();

    const persisted = await pool.query<{
      code: string;
      name: string;
      description: string;
      scopes: string[];
    }>(
      `SELECT role_code AS code,display_name AS name,description,scopes
       FROM public.identity_role_definition WHERE role_code=$1`,
      [roleCode],
    );
    expect(persisted.rows).toEqual([
      {
        code: roleCode,
        name: updatedRoleName,
        description: 'Live role lifecycle parity fixture.',
        scopes: ['activity.admin'],
      },
    ]);
    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM public.security_event
       WHERE payload->>'code'=$1 ORDER BY event_type`,
      [roleCode],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'identity.role-definition.created.v1',
      'identity.role-definition.updated.v1',
    ]);
    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM public.outbox_event
       WHERE producer='identity' AND payload->>'code'=$1 ORDER BY event_type`,
      [roleCode],
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual([
      'identity.role-definition.created.v1',
      'identity.role-definition.updated.v1',
    ]);
    await expectResponsiveAccessible(
      page,
      'Live Admin Identity role creation and update',
    );
  } finally {
    await pool
      .query(
        `DELETE FROM public.outbox_event
         WHERE producer='identity' AND payload->>'code'=$1`,
        [roleCode],
      )
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM public.security_event WHERE payload->>'code'=$1`, [
        roleCode,
      ])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM public.identity_role_definition WHERE role_code=$1', [
        roleCode,
      ])
      .catch(() => undefined);
    await pool.end();
  }
});

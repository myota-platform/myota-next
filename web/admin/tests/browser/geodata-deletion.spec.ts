import { expect, test } from '@playwright/test';

test('confirms a prepared entity deletion and waits for cascade completion', async ({
  page,
}) => {
  const creationRequests: Array<{
    body: unknown;
    idempotencyKey: string;
  }> = [];
  const confirmationRequests: Array<{
    body: unknown;
    idempotencyKey: string;
  }> = [];
  let failFirstPreparation = true;
  let failFirstConfirmation = true;
  let confirmationAccepted = false;
  let entityVisible = true;
  const entity = {
    id: 'entity-delete-1',
    version: 4,
    name: 'Delete test summit',
    status: 'APPROVED',
    entityType: 'SOTA',
    geometry: { type: 'Point', coordinates: [7.2, 46.1] },
    provenance: { adapter: 'community proposal' },
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-access-token',
          refreshToken: 'admin-geodata-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'global-admin-1',
          email: 'admin@example.test',
          displayName: 'Global Admin',
          role: 'GLOBAL_ADMIN',
          scopes: ['*'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      await route.fulfill({
        json: {
          items: entityVisible ? [entity] : [],
          total: Number(entityVisible),
        },
      });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({ json: { continents: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities/entity-delete-1/audit') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (
      url.pathname === '/v1/geodata/entity-deletion-jobs' &&
      method === 'POST'
    ) {
      creationRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      if (failFirstPreparation) {
        failFirstPreparation = false;
        await route.fulfill({
          status: 503,
          json: { detail: 'Temporary preparation failure.' },
        });
        return;
      }
      await route.fulfill({
        status: 201,
        json: {
          id: 'deletion-job-1',
          entityId: 'entity-delete-1',
          status: 'AWAITING_CONFIRMATION',
          impact: { qsoCount: 3, activationCount: 1, awardCount: 2 },
        },
      });
      return;
    }

    if (
      url.pathname ===
        '/v1/geodata/entity-deletion-jobs/deletion-job-1/confirm' &&
      method === 'POST'
    ) {
      confirmationRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      if (failFirstConfirmation) {
        failFirstConfirmation = false;
        await route.fulfill({
          status: 503,
          json: { detail: 'Temporary confirmation failure.' },
        });
        return;
      }
      confirmationAccepted = true;
      await route.fulfill({
        json: { id: 'deletion-job-1', status: 'QUEUED' },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/entity-deletion-jobs/deletion-job-1' &&
      method === 'GET'
    ) {
      if (confirmationAccepted) {
        entityVisible = false;
        await route.fulfill({
          json: { id: 'deletion-job-1', status: 'COMPLETED' },
        });
      } else {
        await route.fulfill({
          json: {
            id: 'deletion-job-1',
            status: 'AWAITING_CONFIRMATION',
            impact: { qsoCount: 3, activationCount: 1, awardCount: 2 },
          },
        });
      }
      return;
    }

    if (url.pathname === '/v1/geodata/entities/entity-delete-1') {
      await route.fulfill({ json: entity });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/entity-management');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-management$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/entity-management$/);

  await page
    .locator('button.entity-link')
    .filter({ hasText: 'Delete test summit' })
    .click();
  await page.getByRole('button', { name: 'Audit & deletion' }).click();
  await page.getByRole('button', { name: 'Permanently delete entity' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Temporary preparation failure.',
  );

  await page.reload();
  await page
    .locator('button.entity-link')
    .filter({ hasText: 'Delete test summit' })
    .click();
  await page.getByRole('button', { name: 'Audit & deletion' }).click();
  await page.getByRole('button', { name: 'Permanently delete entity' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('3');
  await expect(dialog).toContainText('1 activation(s) may become invalid.');
  await dialog
    .getByRole('button', { name: 'Permanently delete entity' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Temporary confirmation failure.',
  );

  await page.reload();
  await page
    .locator('button.entity-link')
    .filter({ hasText: 'Delete test summit' })
    .click();
  await page.getByRole('button', { name: 'Audit & deletion' }).click();
  await page.getByRole('button', { name: 'Permanently delete entity' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Permanently delete entity' })
    .click();

  await expect(
    page.getByText(
      'Entity permanently deleted; linked activity and award progress were reconciled.',
    ),
  ).toBeVisible();
  await expect(
    page
      .locator('button.entity-link')
      .filter({ hasText: 'Delete test summit' }),
  ).toHaveCount(0);
  expect(creationRequests).toHaveLength(3);
  expect(creationRequests[0]).toEqual({
    body: { entityId: 'entity-delete-1', requestedBy: 'global-admin-1' },
    idempotencyKey: expect.any(String),
  });
  expect(creationRequests[1]).toEqual(creationRequests[0]);
  expect(creationRequests[2]).toEqual(creationRequests[0]);
  expect(confirmationRequests).toHaveLength(2);
  expect(confirmationRequests[0]).toEqual({
    body: { confirmation: 'DELETE', deletedBy: 'global-admin-1' },
    idempotencyKey: expect.any(String),
  });
  expect(confirmationRequests[1]).toEqual(confirmationRequests[0]);
  expect(creationRequests[0].idempotencyKey).not.toBe('');
  expect(confirmationRequests[0].idempotencyKey).not.toBe('');
  expect(confirmationRequests[0].idempotencyKey).not.toBe(
    creationRequests[0].idempotencyKey,
  );
});

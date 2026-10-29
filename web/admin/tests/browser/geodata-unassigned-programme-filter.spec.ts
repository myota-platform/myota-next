import { expect, test } from '@playwright/test';

test('filters the Entity catalogue to unassigned entities for programme assignment', async ({
  page,
}) => {
  const programme = {
    slug: 'parks',
    name: 'Parks Programme',
    status: 'ACTIVE',
    entityTypes: [{ code: 'PARK' }],
    entityNumbering: {
      identifier: 'PARK',
      qualifierMode: 'NONE',
      serialWidth: 3,
      assignmentMode: 'PROGRAMME_SEQUENCE',
    },
  };
  const assignedEntity = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Assigned Park',
    status: 'APPROVED',
    programmeSlug: programme.slug,
    entityTypes: ['PARK'],
  };
  const unassignedEntity = {
    id: '10000000-0000-4000-8000-000000000002',
    name: 'Unassigned Park',
    status: 'APPROVED',
    programmeSlug: null,
    entityTypes: ['PARK'],
  };
  const listQueries: URL[] = [];

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
          scopes: ['*'],
        },
      });
      return;
    }
    if (url.pathname === '/v1/programmes' && method === 'GET') {
      await route.fulfill({ json: { items: [programme], nextPage: null } });
      return;
    }
    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({ json: { items: [{ code: 'PARK' }] } });
      return;
    }
    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({ json: { continents: [] } });
      return;
    }
    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      listQueries.push(url);
      const unassignedOnly =
        url.searchParams.get('programmeUnassigned') === 'true';
      const items = unassignedOnly
        ? [unassignedEntity]
        : [assignedEntity, unassignedEntity];
      await route.fulfill({
        json: {
          items,
          total: items.length,
          page: Number(url.searchParams.get('page') || 1),
          pageSize: 25,
          nextPage: null,
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [], total: 0, nextPage: null } });
  });

  await page.goto('/entity-management');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-management$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/entity-management$/);
  await expect(page.getByText('Assigned Park', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Unassigned Park', { exact: true }),
  ).toBeVisible();

  await page
    .getByRole('combobox', { name: 'Programme' })
    .selectOption('__unassigned_entities__');

  await expect(
    page.getByText('Unassigned Park', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Assigned Park', { exact: true })).toHaveCount(0);
  expect(listQueries.at(-1)?.searchParams.get('programmeUnassigned')).toBe(
    'true',
  );
  expect(listQueries.at(-1)?.searchParams.has('programme')).toBe(false);

  await page.getByRole('checkbox', { name: 'Select Unassigned Park' }).check();
  await page
    .getByRole('button', { name: 'Assign selected to programme (1)' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Assign entities and permanent IDs' }),
  ).toBeVisible();
  await expect(page.getByLabel('Target programme')).toBeVisible();
});

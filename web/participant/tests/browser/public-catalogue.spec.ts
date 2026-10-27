import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

const programmes = [
  {
    slug: 'alpine',
    name: 'Alpine Summits',
    description: 'Radio from the high country.',
    theme: { primary: '#2367a8', accent: '#e38a32' },
    rules: {
      minimumQsos: { activation: 4, hunter: 1 },
      publicAccessRequired: true,
    },
    entityTypes: [
      { code: 'SOTA', name: 'Summit', geometryTypes: ['POINT'] },
      { code: 'TRAIL', name: 'Trail', geometryTypes: ['LINESTRING'] },
    ],
  },
  {
    slug: 'coast',
    name: 'Coastal Parks',
    description: 'Radio from protected shorelines.',
    theme: { primary: '#176f72', accent: '#efb04d' },
    rules: {
      minimumQsos: { activation: 3, hunter: 1 },
      publicAccessRequired: false,
    },
    entityTypes: [
      { code: 'PARK', name: 'Coastal park', geometryTypes: ['POINT'] },
    ],
  },
];

test('selects a programme and renders its public content and entity catalogue', async ({
  page,
}) => {
  const entityRequests: string[] = [];
  const proposalRequests: Array<{
    body: unknown;
    idempotencyKey: string;
  }> = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: programmes, nextPage: null },
      });
      return;
    }

    if (url.pathname.endsWith('/content')) {
      const slug = url.pathname.split('/')[4];
      await route.fulfill({
        json: {
          items: [
            { key: 'eligibility', locale: 'en', value: `${slug} eligibility` },
            {
              key: 'eligibility',
              locale: 'fr',
              value: `${slug} admissibilite`,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      const slug = url.searchParams.get('programme') || '';
      entityRequests.push(slug);
      await route.fulfill({
        json: {
          items: [
            {
              id: `${slug}-entity-1`,
              name: `${slug} reference site`,
              entityType: slug === 'alpine' ? 'SOTA' : 'PARK',
              status: 'APPROVED',
              provenance: { adapter: 'programme catalogue' },
              geometry: { type: 'Point', coordinates: [7, 46] },
            },
            {
              id: `${slug}-entity-2`,
              name: `${slug} candidate site`,
              entityType: slug === 'alpine' ? 'SOTA' : 'PARK',
              status: 'CANDIDATE',
              provenance: { adapter: 'community proposal' },
              geometry: { type: 'Point', coordinates: [7.1, 46.1] },
            },
          ],
          page: 1,
          total: 2,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-proposal-access-token',
          refreshToken: 'participant-proposal-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          email: 'operator@example.test',
          displayName: 'Operator One',
          callsigns: [],
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/proposals' &&
      request.method() === 'POST'
    ) {
      proposalRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({ status: 201, json: { id: 'proposal-1' } });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await expect(page.locator('#programme-name')).toHaveText('Alpine Summits');
  await expect(page.locator('#entities')).toContainText(
    'alpine reference site',
  );
  await expect(page.locator('#entities')).toContainText(
    'alpine candidate site',
  );
  await expect(page.locator('#programme-content')).toContainText(
    'alpine eligibility',
  );
  await expect(page.locator('#programme-content')).not.toContainText(
    'alpine admissibilite',
  );

  await page.getByLabel('Programme').selectOption('coast');

  await expect(page.locator('#programme-name')).toHaveText('Coastal Parks');
  await expect(page.locator('#rules')).toContainText('Programme-defined');
  await expect(page.locator('#entities')).toContainText('coast reference site');
  await expect(page.locator('#programme-content')).toContainText(
    'coast eligibility',
  );

  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText('Profile loaded.');
  await page.locator('button.propose[data-id="coast-entity-2"]').click();
  await expect(page.locator('#proposal-status')).toHaveText(
    'Proposal submitted for review.',
  );

  await page.getByRole('button', { name: 'Pick coordinates on map' }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel map selection' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#map').scrollIntoViewIfNeeded();
  const mapBounds = await page.locator('#public-map-overlay').boundingBox();
  expect(mapBounds).not.toBeNull();
  await page.mouse.click(
    mapBounds!.x + mapBounds!.width / 2,
    mapBounds!.y + mapBounds!.height / 2,
  );
  await expect(page.locator('#proposal-status')).toContainText('Selected ');
  const latitude = Number(
    await page.locator('#proposal-latitude').inputValue(),
  );
  const longitude = Number(
    await page.locator('#proposal-longitude').inputValue(),
  );
  expect(latitude).toBeGreaterThanOrEqual(-90);
  expect(latitude).toBeLessThanOrEqual(90);
  expect(longitude).toBeGreaterThanOrEqual(-180);
  expect(longitude).toBeLessThanOrEqual(180);

  await page.locator('#proposal-name').fill('Map-picked shelter');
  await page.getByRole('button', { name: 'Submit location proposal' }).click();
  await expect(page.locator('#proposal-status')).toHaveText(
    'Proposal submitted for review.',
  );

  await page.getByRole('button', { name: 'Reset map view' }).click();
  expect(entityRequests).toEqual(['alpine', 'coast', 'coast', 'coast']);
  expect(proposalRequests).toHaveLength(2);
  expect(proposalRequests[0].idempotencyKey).not.toBe('');
  expect(proposalRequests[0].body).toMatchObject({
    programmeSlug: 'coast',
    entityTypes: ['PARK'],
    source: {
      name: 'Participant community proposal',
      license: 'programme-supplied',
    },
    feature: {
      type: 'Feature',
      properties: { name: 'coast candidate site' },
      geometry: { type: 'Point', coordinates: [7.1, 46.1] },
    },
  });
  expect(proposalRequests[1].idempotencyKey).not.toBe('');
  expect(proposalRequests[1].body).toMatchObject({
    programmeSlug: 'coast',
    entityTypes: ['PARK'],
    source: {
      name: 'Participant community proposal',
      license: 'programme-supplied',
    },
    feature: {
      type: 'Feature',
      properties: { name: 'Map-picked shelter' },
      geometry: {
        type: 'Point',
        coordinates: [longitude, latitude],
      },
    },
  });
  expect(pageErrors).toEqual([]);
  await expect(page).toHaveURL(/#coast$/);

  await expectResponsiveAccessible(page, 'Participant public catalogue');
});

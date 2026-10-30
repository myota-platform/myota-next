import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

const entityIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const entities = [
  {
    id: entityIds[0],
    programmeSlug: 'world-radio',
    entityIdentifier: 'WR-0001',
    name: 'North Ridge',
    entityType: 'AREA',
    status: 'APPROVED',
    centroid: { lon: -122.4, lat: 47.6 },
    location: {
      country: 'United States',
      region: 'Washington',
      county: 'King',
    },
    geometry: { type: 'Point', coordinates: [-122.4, 47.6] },
  },
  {
    id: entityIds[1],
    programmeSlug: 'world-radio',
    entityIdentifier: 'WR-0002',
    name: 'Coastal Plain',
    entityType: 'AREA',
    status: 'APPROVED',
    centroid: { lon: -123.1, lat: 49.2 },
    location: { country: 'Canada', region: 'British Columbia' },
    geometry: { type: 'Point', coordinates: [-123.1, 49.2] },
  },
  {
    id: entityIds[2],
    programmeSlug: 'world-radio',
    entityIdentifier: 'WR-0003',
    name: 'River Junction',
    entityType: 'AREA',
    status: 'CANDIDATE',
    centroid: { lon: 10.7, lat: 46.8 },
    location: { country: 'Austria', region: 'Tyrol' },
    geometry: { type: 'Point', coordinates: [10.7, 46.8] },
  },
];
const statistics = entities.map((entity, index) => ({
  entityId: entity.id,
  activationCount: index + 2,
  activationQsoCount: (index + 2) * 7,
  hunterQsoCount: (index + 1) * 3,
  qsoCount: (index + 2) * 7 + (index + 1) * 3,
  lastActivationAt: index === 2 ? null : '2026-06-15T10:30:00.000Z',
}));

test('programme map and entity catalogue support global discovery and entity activity', async ({
  page,
}) => {
  const entityRequests: URL[] = [];
  const tileRequests: URL[] = [];
  const pageErrors: string[] = [];
  let tooManyMapFeatures = false;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://tile.openstreetmap.org/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a0cAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'world-radio',
              name: 'World Radio Geography',
              description: 'Radio activity across geographic entities.',
              rules: {
                minimumQsos: { activation: 4, hunter: 1 },
                publicAccessRequired: false,
              },
              entityTypes: [{ code: 'AREA', name: 'Area' }],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === '/v1/geodata/map/extent') {
      await route.fulfill({
        json: {
          programme: 'world-radio',
          total: 3,
          bbox: [-160, -50, 170, 65],
        },
      });
      return;
    }
    if (url.pathname.startsWith('/v1/geodata/tiles/')) {
      tileRequests.push(url);
      const tileEntities = tooManyMapFeatures
        ? Array.from({ length: 501 }, (_, index) => ({
            ...entities[index % entities.length],
            id: `tile-entity-${index}`,
            name: `Tile entity ${index}`,
          }))
        : entities;
      await route.fulfill({
        json: {
          type: 'FeatureCollection',
          count: tileEntities.length,
          truncated: tooManyMapFeatures,
          features: tileEntities.map((entity) => ({
            type: 'Feature',
            id: entity.id,
            geometry: entity.geometry,
            properties: {
              name: entity.name,
              entityIdentifier: entity.entityIdentifier,
              programmeSlug: entity.programmeSlug,
              entityType: entity.entityType,
              status: entity.status,
              location: entity.location,
              centroid: entity.centroid,
            },
          })),
        },
      });
      return;
    }
    if (url.pathname === '/v1/geodata/entities') {
      entityRequests.push(url);
      const country = url.searchParams.get('country');
      const pageNumber = Number(url.searchParams.get('page') || 1);
      const matching = country
        ? entities.filter((entity) => entity.location.country === country)
        : entities;
      const items = pageNumber === 1 ? matching : [entities[2]];
      await route.fulfill({
        json: {
          items,
          page: pageNumber,
          pageSize: 50,
          total: country ? matching.length : 51,
          nextPage: !country && pageNumber === 1 ? 2 : null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/public/entity-statistics') {
      const requestedIds = url.searchParams
        .getAll('entityIds')
        .flatMap((value) => value.split(','));
      await route.fulfill({
        json: {
          programme: url.searchParams.get('programme'),
          items: statistics.filter((item) =>
            requestedIds.includes(item.entityId),
          ),
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await expect(page.locator('#programme-name')).toHaveText(
    'World Radio Geography',
  );
  await expect(
    page.locator('#public-map-overlay [data-map-entity]'),
  ).toHaveCount(3);
  await expect(page.locator('#entities tr')).toHaveCount(3);
  await expect(page.locator('#entities')).toContainText('WR-0001');
  await expect(page.locator('#entities')).toContainText(
    '2 valid activations · 17 QSOs',
  );
  await expect(page.locator('#entities')).toContainText(
    /Last: Jun 15, 2026|Last: 15 Jun 2026/,
  );
  await expect(page.locator('#entities')).toContainText(
    'No valid activation recorded',
  );
  await expect(page.locator('#entity-page-status')).toContainText(
    'Page 1 · 51',
  );
  const mapWidth = await page
    .locator('#map')
    .evaluate((element) => element.clientWidth);
  expect(mapWidth).toBeGreaterThan(1000);
  const controlsBeforeTable = await page.evaluate(
    () =>
      document.querySelector('#entity-list-controls')?.getBoundingClientRect()
        .top,
  );
  const tableTop = await page
    .locator('.entity-panel .table-wrap')
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(controlsBeforeTable).toBeLessThan(tableTop);
  await expect(page.locator('#entity-next')).toBeEnabled();
  expect(entityRequests[0].searchParams.get('pageSize')).toBe('50');
  expect(
    tileRequests.every(
      (url) =>
        url.searchParams.get('programme') === 'world-radio' &&
        Number(url.searchParams.get('limit')) >= 1 &&
        Number(url.searchParams.get('limit')) <= 500,
    ),
  ).toBeTruthy();

  await page.locator('#entity-next').click();
  await expect(page.locator('#entity-page-status')).toContainText('Page 2');
  await expect(page.locator('#entities')).toContainText('River Junction');
  await page.locator('#entity-filter-country').fill('Canada');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#entities tr')).toHaveCount(1);
  await expect(page.locator('#entities')).toContainText('Coastal Plain');
  expect(entityRequests.at(-1)?.searchParams.get('country')).toBe('Canada');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#entities tr')).toHaveCount(3);

  await page.locator(`[data-map-entity="${entityIds[1]}"]`).click();
  await expect(page.locator('#entity-map-popup')).toBeVisible();
  await expect(page.locator('#entity-map-popup')).toContainText('WR-0002');
  await page
    .getByRole('link', { name: 'View activation and hunter QSO statistics' })
    .click();
  await expect(page.locator('#entity-statistics')).toBeVisible();
  await expect(page.locator('#entity-statistics-heading')).toContainText(
    'Coastal Plain',
  );
  await expect(page.locator('#entity-statistics-hunter-qsos')).toHaveText('6');
  await page.getByRole('link', { name: 'Back to entities' }).click();

  await page.getByRole('button', { name: /WR-0001 North Ridge/ }).click();
  await expect(page.locator('#map-status')).toContainText(
    'Map centered on North Ridge',
  );
  await expect(
    page.locator(`[data-entity-row="${entityIds[0]}"] .entity-focus`),
  ).toHaveAttribute('aria-pressed', 'true');
  tooManyMapFeatures = true;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('#map-status')).toHaveText(
    'Showing up to 500 entities. Zoom in to see more.',
  );
  await expect(
    page.locator('#public-map-overlay [data-map-entity]'),
  ).toHaveCount(500);
  await expect(pageErrors).toEqual([]);
  await expectResponsiveAccessible(page, 'Phase 7 programme map and catalogue');
});

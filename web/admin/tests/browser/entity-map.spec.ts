import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('caps the entity map at 500 and asks users to zoom into dense views', async ({
  page,
}) => {
  const requestedZooms: number[] = [];
  const firstEntity = {
    id: 'summit-1',
    name: 'Summit Alpha',
    status: 'APPROVED',
    entityTypes: [{ code: 'SUMMIT' }],
    programmes: [{ slug: 'summits', name: 'Summits' }],
    location: {
      continent: 'Europe',
      country: 'Spain',
      region: 'Andalusia',
      city: 'Granada',
    },
    geometry: { type: 'Point', coordinates: [-3.6, 37.2] },
  };
  const secondEntity = {
    id: 'summit-2',
    name: 'Summit Beta',
    status: 'CANDIDATE',
    geometry: { type: 'Point', coordinates: [15, 60] },
  };

  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'entity-map-access-token',
          refreshToken: 'entity-map-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'gis-admin-1',
          email: 'gis-admin@example.test',
          displayName: 'GIS Admin',
          scopes: ['geodata.read'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/map/entities') {
      const zoom = Number(url.searchParams.get('zoom'));
      requestedZooms.push(zoom);
      if (zoom < 3) {
        await route.fulfill({
          json: {
            items: [
              firstEntity,
              secondEntity,
              ...Array.from({ length: 499 }, (_, index) => ({
                id: `entity-${index + 3}`,
                name: `Entity ${index + 3}`,
                status: 'APPROVED',
              })),
            ],
            total: 734,
            limit: 500,
            truncated: true,
            zoom,
            bbox: [-180, -85, 180, 85],
          },
        });
      } else if (zoom === 3) {
        await route.fulfill({
          json: {
            items: [
              firstEntity,
              secondEntity,
              ...Array.from({ length: 498 }, (_, index) => ({
                id: `entity-${index + 3}`,
                name: `Entity ${index + 3}`,
                status: 'APPROVED',
              })),
            ],
            total: 500,
            limit: 500,
            truncated: false,
            zoom,
            bbox: [-4, 36, -3, 38],
          },
        });
      } else {
        await route.fulfill({
          json: {
            items: [firstEntity, secondEntity],
            total: 2,
            limit: 500,
            truncated: false,
            zoom,
            bbox: [-4, 36, -3, 38],
          },
        });
      }
      return;
    }

    await route.fulfill({ json: { items: [], total: 0, nextPage: null } });
  });

  await page.goto('/entity-map');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-map$/);
  await page.getByLabel('Email').fill('gis-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/entity-map$/);
  await expect(
    page.getByText('500 of 734 entities in this view'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The 500-entity map limit is reached. Zoom in to see entities in a smaller area.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Browse loaded entities by name (500)'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(
    page.getByText('500 of 500 entities in this view'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The 500-entity map limit is reached. Zoom in to see entities in a smaller area.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByText('2 of 2 entities in this view')).toBeVisible();
  await expect(
    page.getByText(
      'The 500-entity map limit is reached. Zoom in to see entities in a smaller area.',
    ),
  ).toHaveCount(0);

  await page.locator('.leaflet-marker-icon[title="Summit Alpha"]').click();
  const popupContent = page
    .locator('.leaflet-popup-content > div:visible')
    .filter({ hasText: 'Summit Alpha' })
    .last();
  await expect(popupContent).toBeVisible();
  await expect(popupContent).toHaveCSS('color', 'rgb(20, 43, 45)');
  await expect(popupContent).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await expect(
    page.getByRole('heading', { name: 'Summit Alpha' }),
  ).toBeVisible();
  await expect(page.getByText('SUMMIT', { exact: true })).toBeVisible();
  await expect(page.getByText('Summits', { exact: true })).toBeVisible();
  await expect(page.getByText('Granada', { exact: true })).toBeVisible();

  expect(requestedZooms.some((zoom) => zoom < 4)).toBe(true);
  expect(requestedZooms.some((zoom) => zoom >= 4)).toBe(true);

  const directorySummary = page.locator('.entity-map-directory summary');
  await directorySummary.focus();
  await expect(directorySummary).toBeFocused();
  await page.keyboard.press('Enter');
  const betaSelection = page
    .locator('.entity-map-directory')
    .getByRole('button', { name: /Summit Beta/ });
  await betaSelection.focus();
  await expect(betaSelection).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Summit Beta' }),
  ).toBeVisible();
  await expect(betaSelection).toHaveAttribute('aria-pressed', 'true');
  await expectResponsiveAccessible(page, 'Admin entity map exploration');
});

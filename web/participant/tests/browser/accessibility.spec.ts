import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow } from '../../../a11y';

test('Participant page has accessible viewport layouts and a keyboard skip link', async ({
  page,
}) => {
  await page.route('**/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
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
              ],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    await route.fulfill({
      json: { items: [], nextPage: null, total: 0, page: 1 },
    });
  });

  await page.goto('http://127.0.0.1:8091/');
  await expect(page.locator('#participant-content')).toBeVisible();

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(
      page,
      `Participant public workspace at ${viewport.width}px`,
    );
    await expectAccessible(
      page,
      `Participant public workspace at ${viewport.width}px`,
    );
  }

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#participant-content')).toBeFocused();
});

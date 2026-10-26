import { expect, test } from '@playwright/test';

test('crops and uploads a profile picture as bounded WebP', async ({
  page,
}) => {
  const uploads: Array<{
    contentType: string;
    bytes: number;
    authorization: string;
  }> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/programmes') {
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
              entityTypes: [],
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

    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-profile-access-token',
          refreshToken: 'participant-profile-refresh-token',
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
          profileImage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me/profile-image' && method === 'PUT') {
      uploads.push({
        contentType: request.headers()['content-type'] || '',
        bytes: request.postDataBuffer()?.byteLength || 0,
        authorization: request.headers().authorization || '',
      });
      await route.fulfill({ json: {} });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#profile-image-editor')).toBeVisible();

  const imageDataUrl = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#1464a0';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f4a340';
    context.fillRect(12, 0, 8, canvas.height);
    return canvas.toDataURL('image/png');
  });
  const base64 = imageDataUrl.split(',')[1];
  await page.locator('#profile-image-file').setInputFiles({
    name: 'profile-source.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  });

  await expect(page.locator('#profile-crop-tools')).toBeVisible();
  await page.getByRole('button', { name: 'Save cropped picture' }).click();
  await expect(page.locator('#profile-status')).toHaveText(
    'Profile picture saved.',
  );
  await expect(page.locator('#profile-image-current')).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatchObject({
    contentType: 'image/webp',
    authorization: 'Bearer participant-profile-access-token',
  });
  expect(uploads[0]!.bytes).toBeGreaterThan(0);
  expect(uploads[0]!.bytes).toBeLessThanOrEqual(256 * 1024);
});

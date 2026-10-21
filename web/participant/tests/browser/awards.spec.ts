import { expect, test } from '@playwright/test';

test('submits an eligible award level with the signed-in account callsign', async ({
  page,
}) => {
  const loginPayloads: unknown[] = [];
  const awardRequestPayloads: unknown[] = [];
  const authorizedCalls: string[] = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (
      url.pathname === '/v1/identity/me' ||
      url.pathname.startsWith('/v1/awards/progress') ||
      url.pathname === '/v1/awards/requests'
    )
      authorizedCalls.push(
        request.headers().authorization || 'missing authorization',
      );

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
              entityTypes: [{ code: 'SOTA', name: 'Summit' }],
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

    if (url.pathname === '/v1/awards') {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'summit-award',
              name: 'Summit Explorer',
              description: 'Activate qualifying summits.',
              category: 'ACTIVATIONS',
              achievementMetric: 'UNIQUE_ENTITIES',
              levels: [{ id: 'bronze', name: 'Bronze', threshold: 1 }],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      loginPayloads.push(body);
      await route.fulfill({
        json: {
          accessToken: 'participant-award-access-token',
          refreshToken: 'participant-award-refresh-token',
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
          primaryCallsignId: 'callsign-1',
          callsigns: [
            { id: 'callsign-1', value: 'DL1ABC', status: 'VERIFIED' },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/awards/progress') {
      expect(url.searchParams.get('awardId')).toBe('summit-award');
      expect(url.searchParams.get('participantId')).toBe('participant-1');
      await route.fulfill({
        json: { progress: 1, levels: [{ id: 'bronze', eligible: true }] },
      });
      return;
    }

    if (url.pathname === '/v1/awards/requests' && method === 'POST') {
      awardRequestPayloads.push(body);
      await route.fulfill({ status: 201, json: { status: 'REQUESTED' } });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.getByRole('button', { name: /Bronze/ }).click();

  await expect(page.locator('#award-request-status')).toHaveText(
    'Award request submitted for programme review.',
  );
  expect(loginPayloads).toEqual([
    { email: 'operator@example.test', password: 'test-password' },
  ]);
  expect(awardRequestPayloads).toEqual([
    {
      awardId: 'summit-award',
      levelId: 'bronze',
      subjectId: 'participant-1',
      callsign: 'DL1ABC',
      personName: 'Operator One',
    },
  ]);
  expect(authorizedCalls.length).toBeGreaterThanOrEqual(2);
  expect(
    authorizedCalls.every(
      (header) => header === 'Bearer participant-award-access-token',
    ),
  ).toBe(true);
});

test('downloads an issued certificate only after the PDF is ready', async ({
  page,
}) => {
  const artifactRequests: string[] = [];
  const downloadUrl =
    'http://127.0.0.1:8091/certificates/signed-award.pdf?signature=browser-test';
  let artifactReady = false;

  await page.addInitScript(() => {
    localStorage.setItem(
      'myota_public_access',
      'participant-certificate-token',
    );
    localStorage.setItem(
      'myota_public_refresh',
      'participant-certificate-refresh',
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

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
              entityTypes: [{ code: 'SOTA', name: 'Summit' }],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-certificate-owner',
          email: 'operator@example.test',
          displayName: 'Operator One',
          websiteUrl: null,
          biographyMarkdown: '',
          primaryCallsignId: null,
          callsigns: [],
          profileImage: null,
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

    if (url.pathname === '/v1/awards') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/activations') {
      await route.fulfill({ json: { items: [], page: 1, total: 0 } });
      return;
    }

    if (url.pathname === '/v1/awards/requests') {
      await route.fulfill({
        json: {
          items: [
            {
              callsign: 'DL1ABC',
              personName: 'Operator One',
              programmeSlug: 'alpine',
              levelId: 'bronze',
              status: 'ISSUED',
              issuedAwardId: 'issued-certificate-1',
              artifactReady,
            },
          ],
          page: 1,
          pageSize: 50,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/awards/issuances/issued-certificate-1/artifact') {
      artifactRequests.push(request.headers().authorization || 'missing');
      await route.fulfill({ json: { downloadUrl } });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });
  await page.context().route(downloadUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.4 browser certificate fixture',
    }),
  );

  await page.goto('http://127.0.0.1:8091/#alpine');
  const requests = page.locator('#participant-award-request-items');
  await expect(requests).toContainText('ISSUED · CERTIFICATE PROCESSING');
  await expect(
    page.getByRole('button', { name: 'Download certificate' }),
  ).toHaveCount(0);

  artifactReady = true;
  await page.reload();
  await expect(requests).toContainText('ISSUED · PDF READY');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Download certificate' }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(downloadUrl);
  await expect
    .poll(() => artifactRequests)
    .toEqual(['Bearer participant-certificate-token']);
});

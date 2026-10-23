import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../a11y';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('serializes concurrent account creation for normalized duplicate emails', async ({
  request,
}) => {
  test.skip(!process.env.CORE_DATABASE_URL, 'requires the CI Core database');
  if (!process.env.CORE_DATABASE_URL) return;

  const adminEmail =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const adminPassword =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email: adminEmail, password: adminPassword } },
  );
  expect(login.status()).toBe(200);
  const { accessToken } = await login.json();
  const suffix = randomUUID();
  const normalizedEmail = `browser-email-race-${suffix}@example.test`;
  const pool = new Pool({
    connectionString: process.env.CORE_DATABASE_URL,
    max: 1,
  });
  let accountId: string | undefined;

  try {
    const responses = await Promise.all([
      request.post('http://127.0.0.1:8080/v1/identity/accounts', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          displayName: `Race winner A ${suffix}`,
          email: ` ${normalizedEmail.toUpperCase()} `,
          participationType: 'OPERATOR',
        },
      }),
      request.post('http://127.0.0.1:8080/v1/identity/accounts', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          displayName: `Race winner B ${suffix}`,
          email: normalizedEmail,
          participationType: 'OPERATOR',
        },
      }),
    ]);

    expect(
      responses
        .map((response) => response.status())
        .sort((left, right) => left - right),
    ).toEqual([201, 400]);
    const conflictResponse = responses.find(
      (response) => response.status() === 400,
    )!;
    expect((await conflictResponse.json()).detail).toBe('email already exists');
    const createdResponse = responses.find(
      (response) => response.status() === 201,
    )!;
    const createdAccount = await createdResponse.json();
    accountId = createdAccount.id as string;
    expect(createdAccount.email).toBe(normalizedEmail);

    const persisted = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM public.account
        WHERE identity_email_key=$1`,
      [normalizedEmail],
    );
    expect(persisted.rows[0]?.total).toBe('1');
  } finally {
    if (accountId)
      await request
        .patch(`http://127.0.0.1:8080/v1/identity/accounts/${accountId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          data: { status: 'DEACTIVATED', anonymize: true },
        })
        .catch(() => undefined);
    await pool.end();
  }
});

test('replays account creation before duplicate-email validation', async ({
  request,
}) => {
  test.skip(!process.env.CORE_DATABASE_URL, 'requires the CI Core database');
  if (!process.env.CORE_DATABASE_URL) return;

  const adminEmail =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const adminPassword =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email: adminEmail, password: adminPassword } },
  );
  expect(login.status()).toBe(200);
  const { accessToken } = await login.json();
  const suffix = randomUUID();
  const email = `browser-idempotency-${suffix}@example.test`;
  const idempotencyKey = randomUUID();
  const body = {
    displayName: `Idempotent participant ${suffix}`,
    email,
    participationType: 'SWL',
  };
  const pool = new Pool({
    connectionString: process.env.CORE_DATABASE_URL,
    max: 1,
  });
  let accountId: string | undefined;

  try {
    const first = await request.post(
      'http://127.0.0.1:8080/v1/identity/accounts',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': idempotencyKey,
        },
        data: body,
      },
    );
    expect(first.status()).toBe(201);
    const firstResponse = await first.json();
    accountId = firstResponse.id as string;

    const retry = await request.post(
      'http://127.0.0.1:8080/v1/identity/accounts',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': idempotencyKey,
        },
        data: body,
      },
    );
    expect(retry.status()).toBe(201);
    expect(await retry.json()).toEqual(firstResponse);

    const persisted = await pool.query<{
      accounts: string;
      securityEvents: string;
      outboxEvents: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM public.account WHERE identity_email_key=$1) AS accounts,
         (SELECT count(*)::text FROM public.security_event WHERE account_id=$2::uuid) AS "securityEvents",
         (SELECT count(*)::text FROM public.outbox_event
           WHERE aggregate_type='account' AND aggregate_id=$2::text) AS "outboxEvents"`,
      [email, accountId],
    );
    expect(persisted.rows[0]).toEqual({
      accounts: '1',
      securityEvents: '1',
      outboxEvents: '2',
    });
  } finally {
    if (accountId)
      await request
        .patch(`http://127.0.0.1:8080/v1/identity/accounts/${accountId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          data: { status: 'DEACTIVATED', anonymize: true },
        })
        .catch(() => undefined);
    await pool.end();
  }
});

test('loads a real programme catalogue through Gateway and Geodata', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email, password } },
  );
  expect(login.ok()).toBeTruthy();
  const { accessToken } = await login.json();
  const slug = `browser-${randomUUID()}`;
  const created = await request.post('http://127.0.0.1:8080/v1/programmes', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      slug,
      name: 'Browser integration programme',
      description: 'Served by the live NestJS APIs.',
      entityTypes: [
        {
          code: `E2E_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          label: 'Integration point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
    },
  });
  expect(created.status()).toBe(201);

  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  const contentResponse = page.waitForResponse((response) =>
    response.url().includes('/content'),
  );
  await page.goto(`http://127.0.0.1:8091/#${slug}`);
  expect((await contentResponse).ok()).toBeTruthy();

  await expect(page.locator('#programme-name')).toHaveText(
    'Browser integration programme',
  );
  await expect(page.locator('#entity-page-status')).toHaveText(
    'Page 1 · 0 entities',
  );
  expect(failedResponses).toEqual([]);
});

test('signs into Admin through Gateway and loads its live dashboard', async ({
  page,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('API connected')).toBeVisible();
  await expect(
    page.getByText('available programme configurations'),
  ).toBeVisible();
  expect(failedResponses).toEqual([]);
});

test('creates, reviews, and publishes a policy in Admin through Gateway', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const access = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email, password } },
  );
  expect(access.ok()).toBeTruthy();
  const { accessToken } = await access.json();
  const slug = `browser-policy-${randomUUID()}`;
  const programme = await request.post('http://127.0.0.1:8080/v1/programmes', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      slug,
      name: 'Browser policy lifecycle programme',
      description: 'Created for the live Admin policy workflow.',
      entityTypes: [
        {
          code: `E2E_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          label: 'Policy test point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
    },
  });
  expect(programme.status()).toBe(201);

  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('http://127.0.0.1:8090/policies');
  await page.locator('.programme-scope select').selectOption(slug);
  await page.getByRole('button', { name: 'New draft' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Live browser policy');
  await page
    .locator('textarea.code-editor')
    .fill('{"rules":{"minimumQsos":{"activation":3,"hunter":1}}}');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Policy draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await page
    .getByLabel('Effective from (UTC)')
    .fill(new Date(Date.now() + 60_000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Policy published.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Live browser policy.*PUBLISHED/ }),
  ).toBeVisible();
  expect(failedResponses).toEqual([]);
});

test('creates a participant account in Admin through the live Identity API', async ({
  page,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const accountName = `Browser participant ${randomUUID()}`;
  const accountEmail = `browser-participant-${randomUUID()}@example.test`;
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('http://127.0.0.1:8090/identity');
  await expect(page).toHaveURL(/\/identity$/);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(accountName);
  await page.getByLabel('Email').last().fill(accountEmail);
  await page.getByLabel(/Activity administrator/).check();
  const creationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/v1/identity/accounts',
  );
  await page.getByRole('button', { name: 'Create account' }).last().click();

  const response = await creationResponse;
  expect(response.status()).toBe(201);
  await expect(
    page.getByText(
      'Account created with status PENDING_SETUP. No invitation was sent; invitation delivery is not available yet.',
    ),
  ).toBeVisible();
  await expect(page.getByText(accountEmail)).toBeVisible();
  const createdAccount = await response.json();
  expect(createdAccount).toMatchObject({
    displayName: accountName,
    email: accountEmail,
    status: 'PENDING_SETUP',
    roles: [{ role: 'PARTICIPANT' }, { role: 'ACTIVITY_ADMIN' }],
  });

  await page.getByRole('button', { name: new RegExp(accountName) }).click();
  const callsignRows = page.locator('.callsign-management .callsign-row');
  const callsignValue = `DL${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const addCallsignForm = page.locator('.callsign-management form').first();
  await addCallsignForm.getByLabel('Callsign').fill(callsignValue);
  await addCallsignForm.getByLabel('Initial status').selectOption('UNVERIFIED');
  await addCallsignForm.getByLabel('Source').fill('operator-asserted');
  await addCallsignForm.getByRole('button', { name: 'Add callsign' }).click();
  await expect(callsignRows.filter({ hasText: callsignValue })).toBeVisible();

  const evidenceForm = page.locator('.callsign-management form').nth(1);
  await evidenceForm
    .getByLabel('Callsign')
    .selectOption({ label: callsignValue });
  await evidenceForm.getByLabel('Evidence type').fill('LICENSE');
  await evidenceForm.getByLabel('Source').fill('regulator record');
  await evidenceForm
    .getByLabel('Metadata JSON (optional)')
    .fill('{"reference":"browser-live"}');
  await evidenceForm.getByRole('button', { name: 'Submit evidence' }).click();
  await expect(
    callsignRows.filter({ hasText: '1 evidence record' }),
  ).toBeVisible();

  await page.getByLabel('Verification source').fill('manual-review');
  await callsignRows
    .filter({ hasText: callsignValue })
    .getByRole('button', { name: 'Verify' })
    .click();
  await expect(
    callsignRows.filter({ hasText: 'Verified by manual-review' }),
  ).toContainText(callsignValue);

  await page.getByLabel('Status').first().selectOption('ACTIVE');
  const activationResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'PATCH' &&
      new URL(candidate.url()).pathname ===
        `/v1/identity/accounts/${createdAccount.id}`,
  );
  await page.getByRole('button', { name: 'Save user' }).click();
  expect((await activationResponse).status()).toBe(200);
  await expect(
    page.getByText(
      'User saved. Existing scoped role assignments have been preserved.',
    ),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export account' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    `myota-account-${createdAccount.id}.json`,
  );
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.account).toMatchObject({
    id: createdAccount.id,
    displayName: accountName,
    status: 'ACTIVE',
  });
  expect(exported.callsignEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: 'regulator record' }),
    ]),
  );
  const exportedEventTypes = exported.securityEvents.map(
    (event: { eventType: string }) => event.eventType,
  );
  const rolesReplacedIndex = exportedEventTypes.indexOf(
    'identity.roles.replaced.v1',
  );
  const accountUpdatedIndex = exportedEventTypes.indexOf(
    'identity.account.admin-updated.v1',
  );
  expect(rolesReplacedIndex).toBeGreaterThanOrEqual(0);
  expect(accountUpdatedIndex).toBeGreaterThan(rolesReplacedIndex);

  const confirmations: string[] = [];
  page.once('dialog', async (dialog) => {
    confirmations.push(dialog.message());
    await dialog.accept();
  });
  const deactivationResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'PATCH' &&
      new URL(candidate.url()).pathname ===
        `/v1/identity/accounts/${createdAccount.id}`,
  );
  await page.getByRole('button', { name: 'Deactivate and anonymize' }).click();
  const deactivated = await deactivationResponse;
  expect(deactivated.status()).toBe(200);
  expect(await deactivated.json()).toMatchObject({
    id: createdAccount.id,
    displayName: 'Deactivated account',
    email: null,
    status: 'DEACTIVATED',
  });
  await expect(
    page.getByText('Account deactivated and anonymized.'),
  ).toBeVisible();
  expect(confirmations).toEqual([`Deactivate and anonymize ${accountName}?`]);
  expect(failedResponses).toEqual([]);
});

test('manages participant-owned callsigns through the live Identity API', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const adminEmail =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const adminPassword =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const adminLogin = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email: adminEmail, password: adminPassword } },
  );
  expect(adminLogin.ok()).toBeTruthy();
  const { accessToken: adminAccessToken } = await adminLogin.json();
  const accountEmail = `browser-callsign-${randomUUID()}@example.test`;
  const accountResponse = await request.post(
    'http://127.0.0.1:8080/v1/identity/accounts',
    {
      headers: {
        Authorization: `Bearer ${adminAccessToken}`,
        'Idempotency-Key': randomUUID(),
      },
      data: {
        displayName: `Browser callsign owner ${randomUUID()}`,
        email: accountEmail,
        participationType: 'OPERATOR',
      },
    },
  );
  expect(accountResponse.status()).toBe(201);
  const account = await accountResponse.json();
  const accountId = account.id as string;
  const activated = await request.patch(
    `http://127.0.0.1:8080/v1/identity/accounts/${accountId}`,
    {
      headers: { Authorization: `Bearer ${adminAccessToken}` },
      data: { status: 'ACTIVE' },
    },
  );
  expect(activated.status()).toBe(200);

  const recovery = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/recovery/request',
    { data: { email: accountEmail } },
  );
  expect(recovery.ok()).toBeTruthy();
  const recoveryToken = (await recovery.json()).devResetToken as string;
  const password = `Browser-${randomUUID()}-Password!`;
  const reset = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/recovery/reset',
    { data: { token: recoveryToken, newPassword: password } },
  );
  expect(reset.status()).toBe(200);
  const participantLogin = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email: accountEmail, password } },
  );
  expect(participantLogin.status()).toBe(200);
  const { accessToken } = await participantLogin.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const oldValue = `DL${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`;
  const seededCallsign = await request.post(
    `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns`,
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { callsign: oldValue },
    },
  );
  expect(seededCallsign.status()).toBe(201);
  const oldCallsignId = (await seededCallsign.json()).callsign.id as string;
  const newValue = `DL${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`;

  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill(accountEmail);
  await page.locator('#award-password').fill(password);
  await page.locator('#award-login button[type="submit"]').click();
  await expect(page.locator('#profile-callsigns')).toBeVisible();

  const websiteUrl = `https://radio-${randomUUID()}.example.test`;
  const biographyMarkdown =
    'Live participant profile details from the browser integration.';
  await page.locator('#profile-website').fill(websiteUrl);
  await page.locator('#profile-biography').fill(biographyMarkdown);
  await page.getByRole('button', { name: 'Save profile details' }).click();
  await expect(page.locator('#profile-status')).toHaveText('Profile saved.');

  const profilePicture = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 40, g: 100, b: 180 },
    },
  })
    .png()
    .toBuffer();
  await page.locator('#profile-image-file').setInputFiles({
    name: 'live-profile-picture.png',
    mimeType: 'image/png',
    buffer: profilePicture,
  });
  await expect(page.locator('#profile-crop-tools')).toBeVisible();
  await page.getByRole('button', { name: 'Save cropped picture' }).click();
  await expect(page.locator('#profile-status')).toHaveText(
    'Profile picture saved.',
  );
  await expect(page.locator('#profile-image-current')).toBeVisible();
  const imageMetadataResponse = await request.get(
    'http://127.0.0.1:8080/v1/identity/me',
    { headers },
  );
  const imageMetadata = await imageMetadataResponse.json();
  expect(imageMetadata.profileImage).toMatchObject({
    contentType: 'image/webp',
    width: 512,
    height: 512,
  });
  const storedImage = await request.get(
    'http://127.0.0.1:8080/v1/identity/me/profile-image',
    { headers },
  );
  expect(storedImage.status()).toBe(200);
  expect(storedImage.headers()['content-type']?.split(';', 1)[0]).toBe(
    'image/webp',
  );
  expect((await storedImage.body()).length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Remove profile picture' }).click();
  await expect(page.locator('#profile-status')).toHaveText(
    'Profile picture removed.',
  );
  await expect(page.locator('#profile-image-current')).toBeHidden();
  const removedImage = await request.get(
    'http://127.0.0.1:8080/v1/identity/me/profile-image',
    { headers },
  );
  expect(removedImage.status()).toBe(404);

  await page.locator('#profile-callsign-value').fill(newValue);
  await page.locator('#profile-callsign-add button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText('Callsign added.');
  const accountAfterAdd = await request.get(
    'http://127.0.0.1:8080/v1/identity/me',
    { headers },
  );
  expect(accountAfterAdd.status()).toBe(200);
  const newCallsignId = (
    (await accountAfterAdd.json()).callsigns as Array<{
      id: string;
      value: string;
    }>
  ).find((callsign) => callsign.value === newValue)?.id;
  expect(newCallsignId).toBeTruthy();

  await page.locator('#profile-evidence-callsign').selectOption(newCallsignId!);
  await page.locator('#profile-evidence-type').fill('LICENSE');
  await page.locator('#profile-evidence-source').fill('regulator record');
  await page.locator('#profile-evidence-checksum').fill('sha256:browser-live');
  await page
    .locator('#profile-evidence-metadata')
    .fill('{"reference":"browser-live"}');
  await page
    .locator('#profile-callsign-evidence button[type="submit"]')
    .click();
  await expect(page.locator('#profile-status')).toHaveText(
    'Callsign evidence submitted.',
  );

  const newCallsign = page
    .locator('.profile-callsign-row')
    .filter({ hasText: newValue });
  const oldCallsign = page
    .locator('.profile-callsign-row')
    .filter({ hasText: oldValue });
  await newCallsign.getByRole('button', { name: 'Make primary' }).click();
  await expect(newCallsign).toContainText('Primary');
  await oldCallsign.getByRole('button', { name: 'Make primary' }).click();
  await expect(oldCallsign).toContainText('Primary');
  await oldCallsign.getByRole('button', { name: 'Retire' }).click();
  await page
    .locator('#profile-retire-replacement')
    .selectOption(newCallsignId!);
  await page.locator('#profile-callsign-retire button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText('Callsign retired.');
  await expect(oldCallsign).toContainText('RETIRED');
  await expect(newCallsign).toContainText('Primary');

  const finalAccount = await request.get(
    'http://127.0.0.1:8080/v1/identity/me',
    { headers },
  );
  expect(finalAccount.status()).toBe(200);
  const finalAccountView = await finalAccount.json();
  expect(finalAccountView).toMatchObject({
    id: accountId,
    primaryCallsignId: newCallsignId,
    websiteUrl,
    biographyMarkdown,
    profileImage: null,
  });
  expect(finalAccountView.callsigns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: oldCallsignId,
        value: oldValue,
        status: 'RETIRED',
      }),
      expect.objectContaining({
        id: newCallsignId,
        value: newValue,
        status: 'UNVERIFIED',
        evidenceIds: expect.arrayContaining([expect.any(String)]),
      }),
    ]),
  );
  await expectResponsiveAccessible(
    page,
    'Live Participant profile, image, and callsign management',
  );
  expect(failedResponses).toEqual([]);
});

test('records and closes an activation in Participant through live Activity APIs', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const adminEmail =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const adminPassword =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email: adminEmail, password: adminPassword } },
  );
  expect(login.ok()).toBeTruthy();
  const { accessToken } = await login.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const accountId = (
    await request
      .get('http://127.0.0.1:8080/v1/identity/me', { headers })
      .then((response) => response.json())
  ).id as string;
  const programmeSlug = `browser-activation-${randomUUID()}`;
  const entityTypeCode = `E2E_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const programmeResponse = await request.post(
    'http://127.0.0.1:8080/v1/programmes',
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: {
        slug: programmeSlug,
        name: 'Live Participant activation programme',
        description: 'Created for the Participant live Activity workflow.',
        entityTypes: [
          {
            code: entityTypeCode,
            label: 'Integration point',
            geometryTypes: ['POINT'],
          },
        ],
        rules: {
          activationValidityDays: 7,
          minimumQsos: { activation: 1, hunter: 1 },
          publicAccessRequired: false,
          requireLocation: true,
        },
      },
    },
  );
  expect(programmeResponse.status()).toBe(201);

  const callsignResponse = await request.post(
    `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns`,
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { callsign: `DL${randomUUID().replaceAll('-', '').slice(0, 7)}` },
    },
  );
  expect(callsignResponse.status()).toBe(201);
  const callsign = (await callsignResponse.json()).callsign as {
    id: string;
    value: string;
  };
  const evidence = await request.post(
    `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns/${callsign.id}/evidence`,
    {
      headers,
      data: { evidenceType: 'LICENSE', source: 'browser integration fixture' },
    },
  );
  expect(evidence.status()).toBe(201);
  const verification = await request.post(
    `http://127.0.0.1:8080/v1/identity/accounts/${accountId}/callsigns/${callsign.id}/verify`,
    { headers, data: { source: 'browser integration fixture' } },
  );
  expect(verification.status()).toBe(200);

  const entityId = `browser-entity-${randomUUID()}`;
  await page.route('**/v1/geodata/entities**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          items: [
            {
              id: entityId,
              name: 'Live Activity integration point',
              entityType: entityTypeCode,
              status: 'APPROVED',
              centroid: { lat: 46.1, lon: 7.2 },
              geometry: { type: 'Point', coordinates: [7.2, 46.1] },
            },
          ],
          page: 1,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }
    await route.continue();
  });
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill(adminEmail);
  await page.locator('#award-password').fill(adminPassword);
  await page.locator('#award-login button[type="submit"]').click();
  await expect(page.locator('#activation-start-form')).toBeVisible();
  await page.locator('#programme-select').selectOption(programmeSlug);
  await page.locator('#activation-entity').selectOption(entityId);
  await page.locator('#activation-callsign').selectOption(callsign.id);

  const startResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/v1/activations',
  );
  await page.getByRole('button', { name: 'Start activation' }).click();
  const started = await startResponse;
  expect(started.status()).toBe(201);
  const activation = await started.json();
  await expect(page.locator('#activation-status')).toHaveText(
    'Activation started.',
  );
  await expect(page.locator('#qso-form')).toBeVisible();

  await page.getByLabel('Worked callsign').fill('F4LIVE');
  await page.getByLabel('Band').fill('20M');
  await page.getByLabel('Mode').fill('SSB');
  const qsoResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/activations/${activation.id}/qsos`,
  );
  await page.getByRole('button', { name: 'Record contact' }).click();
  expect((await qsoResponse).status()).toBe(201);
  await expect(page.locator('#activation-status')).toHaveText(
    'Contact recorded.',
  );

  const closeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/v1/activations/${activation.id}`,
  );
  await page.getByRole('button', { name: 'Close activation' }).click();
  expect((await closeResponse).status()).toBe(200);
  await expect(page.locator('#activation-status')).toHaveText(
    'Activation closed.',
  );

  const persisted = await request.get(
    `http://127.0.0.1:8080/v1/activations/${activation.id}`,
    { headers },
  );
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toMatchObject({
    id: activation.id,
    programmeSlug,
    entityId,
    operatorId: accountId,
    operatorCallsign: callsign.value.toUpperCase(),
    status: 'CLOSED',
    qsoCount: 1,
    qsos: [{ workedCallsign: 'F4LIVE', band: '20M', mode: 'SSB' }],
  });
  expect(failedResponses).toEqual([]);
});

test('reviews a live QSO correction in Admin and verifies the updated QSO', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email, password } },
  );
  expect(login.ok()).toBeTruthy();
  const { accessToken, account } = await login.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const suffix = randomUUID();
  const programmeSlug = `browser-correction-${suffix}`;
  const startedAt = new Date().toISOString();
  const programme = await request.post('http://127.0.0.1:8080/v1/programmes', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: {
      slug: programmeSlug,
      name: 'Browser correction review programme',
      description: 'Created for the live Admin correction review workflow.',
      entityTypes: [
        {
          code: `E2E_${suffix.replaceAll('-', '').slice(0, 12)}`,
          label: 'Correction test point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
    },
  });
  expect(programme.status()).toBe(201);

  const activationResponse = await request.post(
    'http://127.0.0.1:8080/v1/activations',
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: {
        programmeSlug,
        entityId: `entity-${suffix}`,
        operatorId: account.id,
        operatorCallsign: 'EA0BROWSER',
        startedAt,
        programmeRules: {
          minimumQsos: { activation: 1, hunter: 1 },
        },
      },
    },
  );
  expect(activationResponse.status()).toBe(201);
  const activation = await activationResponse.json();
  const qsoResponse = await request.post(
    `http://127.0.0.1:8080/v1/activations/${activation.id}/qsos`,
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: {
        workedCallsign: `F4${suffix.replaceAll('-', '').slice(0, 5).toUpperCase()}`,
        timestamp: startedAt,
        band: '20M',
        mode: 'SSB',
      },
    },
  );
  expect(qsoResponse.status()).toBe(201);
  const qso = (await qsoResponse.json()).qso;
  const originalCallsign = qso.workedCallsign as string;
  const correctedCallsign = `G4${suffix.replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const correctionResponse = await request.post(
    `http://127.0.0.1:8080/v1/qsos/${qso.id}/corrections`,
    {
      headers,
      data: {
        requestedBy: account.id,
        reason: 'Correct the worked callsign from the live browser test.',
        proposedValues: { workedCallsign: correctedCallsign },
      },
    },
  );
  expect(correctionResponse.status()).toBe(201);
  const correction = await correctionResponse.json();

  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('http://127.0.0.1:8090/activity');

  const correctionCard = page
    .locator('.correction-card')
    .filter({ hasText: originalCallsign });
  await expect(correctionCard).toContainText(
    'Correct the worked callsign from the live browser test.',
  );
  await expect(correctionCard).toContainText(correctedCallsign);
  await correctionCard
    .getByLabel('Review note (optional)')
    .fill('Confirmed in the live Admin browser workflow.');
  const reviewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/qsos/${qso.id}/corrections/${correction.id}/review`,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await correctionCard
    .getByRole('button', { name: 'Apply correction' })
    .click();
  expect((await reviewResponse).status()).toBe(200);
  await expect(page.getByText('QSO correction applied.')).toBeVisible();

  await page.getByLabel('Status').selectOption('APPLIED');
  await expect(
    page.locator('.correction-card').filter({ hasText: correctedCallsign }),
  ).toContainText('APPLIED');
  const activationRead = await request.get(
    `http://127.0.0.1:8080/v1/activations/${activation.id}`,
    { headers },
  );
  expect(activationRead.status()).toBe(200);
  expect((await activationRead.json()).qsos).toMatchObject([
    { id: qso.id, workedCallsign: correctedCallsign, status: 'CORRECTED' },
  ]);
  expect(failedResponses).toEqual([]);
});

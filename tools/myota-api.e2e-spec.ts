import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapHttpService } from '../libs/platform/src/bootstrap.js';
import { integerSetting } from '../libs/platform/src/integer-setting.js';
import { ActivityModule } from '../apps/activity/src/activity.module.js';
import { GeodataModule } from '../apps/geodata/src/geodata.module.js';
import { GatewayModule } from '../apps/gateway/src/gateway.module.js';
import { IdentityModule } from '../apps/identity/src/identity.module.js';
import { ProgrammesModule } from '../apps/programmes/src/programmes.module.js';

const describeWithDatabases = describe.skipIf(
  !process.env.CORE_DATABASE_URL ||
    !process.env.ACTIVITY_DATABASE_URL ||
    !process.env.GEO_DATABASE_URL,
);

describeWithDatabases(
  'Gateway to Identity and Activity HTTP integration',
  () => {
    it('routes a real operator session through activation, QSO, and close', async () => {
      const email = `platform-e2e-${randomUUID()}@example.test`;
      const password = `MyOTA-e2e-${randomUUID()}!`;
      const envNames = [
        'MYOTA_BOOTSTRAP_ADMIN_EMAIL',
        'MYOTA_BOOTSTRAP_ADMIN_PASSWORD',
        'MYOTA_IDENTITY_URL',
        'MYOTA_PROGRAMMES_URL',
        'MYOTA_ACTIVITY_URL',
        'MYOTA_GEODATA_URL',
        'MYOTA_ENV',
        'MYOTA_EMAIL_SERVICE_CLIENT_SECRET',
        'PORT',
      ] as const;
      const previous = Object.fromEntries(
        envNames.map((name) => [name, process.env[name]]),
      );
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL = email;
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD = password;
      const emailServiceSecret = `gateway-e2e-${randomUUID()}-email-service-client-secret`;
      process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET = emailServiceSecret;
      process.env.MYOTA_ENV = 'test';
      process.env.PORT = '0';

      let identityApp: INestApplication | undefined;
      let programmesApp: INestApplication | undefined;
      let activityApp: INestApplication | undefined;
      let geodataApp: INestApplication | undefined;
      let gatewayApp: INestApplication | undefined;
      let identityUrl = '';
      try {
        identityApp = await startIdentity();
        programmesApp = await startProgrammes();
        activityApp = await startActivity();
        geodataApp = await startGeodata();
        identityUrl = await listen(identityApp);
        process.env.MYOTA_IDENTITY_URL = identityUrl;
        process.env.MYOTA_PROGRAMMES_URL = await listen(programmesApp);
        process.env.MYOTA_ACTIVITY_URL = await listen(activityApp);
        process.env.MYOTA_GEODATA_URL = await listen(geodataApp);
        gatewayApp = await startGateway();
        const gatewayUrl = await listen(gatewayApp);

        const login = await request(gatewayUrl)
          .post('/v1/identity/auth/login')
          .send({ email, password })
          .expect(200);
        expect(login.body.account.email).toBe(email);

        const current = await request(gatewayUrl)
          .get('/v1/identity/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(200);
        expect(current.body.id).toBe(login.body.account.id);
        expect(current.body.scopes).toContain('*');

        const refreshed = await request(gatewayUrl)
          .post('/v1/identity/auth/refresh')
          .send({ refreshToken: login.body.refreshToken })
          .expect(200);
        expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
        await request(gatewayUrl)
          .post('/v1/identity/auth/refresh')
          .send({ refreshToken: login.body.refreshToken })
          .expect(403);

        const emailServiceToken = await request(gatewayUrl)
          .post('/v1/identity/auth/service-token')
          .send({ service: 'email-service', clientSecret: emailServiceSecret })
          .expect(200);
        expect(emailServiceToken.body).toMatchObject({
          tokenType: 'Bearer',
          expiresIn: 300,
        });
        const recipient = await request(identityUrl)
          .get(
            `/v1/identity/internal/email-recipients/${login.body.account.id}`,
          )
          .set('Authorization', `Bearer ${emailServiceToken.body.accessToken}`)
          .expect(200);
        expect(recipient.body).toEqual({ deliverableAddress: email });

        await request(identityUrl)
          .post('/v1/identity/auth/service-token')
          .send({
            service: 'another-service',
            scopes: ['activity.read'],
            clientSecret: emailServiceSecret,
          })
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .expect(400);
        const scopedServiceToken = await request(gatewayUrl)
          .post('/v1/identity/auth/service-token')
          .send({ service: 'activity-worker', scopes: ['activity.read'] })
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .expect(200);
        await request(identityUrl)
          .get(
            `/v1/identity/internal/email-recipients/${login.body.account.id}`,
          )
          .set('Authorization', `Bearer ${scopedServiceToken.body.accessToken}`)
          .expect(403);
        await request(gatewayUrl)
          .post('/v1/identity/auth/service-token')
          .send({
            service: 'activity-worker',
            scopes: ['activity.read', 'identity.email.resolve'],
          })
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .expect(403);

        await request(gatewayUrl)
          .post('/v1/identity/auth/logout')
          .set('Authorization', `Bearer ${emailServiceToken.body.accessToken}`)
          .expect(200)
          .expect(({ body }) => expect(body.status).toBe('logged_out'));
        await request(identityUrl)
          .get(
            `/v1/identity/internal/email-recipients/${login.body.account.id}`,
          )
          .set('Authorization', `Bearer ${emailServiceToken.body.accessToken}`)
          .expect(403);

        const accountCreationKey = randomUUID();
        const createdAccountRequest = {
          displayName: 'Gateway-created participant',
          email: `  Participant-${randomUUID()}@Example.Test  `,
          participationType: 'OPERATOR',
        };
        const createdAccount = await request(gatewayUrl)
          .post('/v1/identity/accounts')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', accountCreationKey)
          .send(createdAccountRequest);
        expect(createdAccount.status, JSON.stringify(createdAccount.body)).toBe(
          201,
        );
        expect(createdAccount.body).toMatchObject({
          displayName: 'Gateway-created participant',
          email: createdAccountRequest.email.trim().toLowerCase(),
          participationType: 'OPERATOR',
          status: 'PENDING_SETUP',
          roles: [{ role: 'PARTICIPANT' }],
        });
        expect(createdAccount.body.password).toBeUndefined();

        const createdAccountRoles = await request(gatewayUrl)
          .get(`/v1/identity/accounts/${createdAccount.body.id}/roles`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .expect(200);
        expect(createdAccountRoles.body).toMatchObject([
          { role: 'PARTICIPANT', accountId: createdAccount.body.id },
        ]);

        const retriedAccountCreation = await request(gatewayUrl)
          .post('/v1/identity/accounts')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', accountCreationKey)
          .send(createdAccountRequest)
          .expect(201);
        expect(retriedAccountCreation.body).toEqual(createdAccount.body);

        await request(gatewayUrl)
          .post('/v1/identity/accounts')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .send({
            displayName: 'Password must use setup flow',
            email: `password-${randomUUID()}@example.test`,
            participationType: 'SWL',
            password: 'must-use-invitation-setup',
          })
          .expect(400)
          .expect(({ body }) => {
            expect(body.detail).toBe(
              'passwords cannot be set during account creation; use the invitation setup flow',
            );
          });

        const activatedAccount = await request(gatewayUrl)
          .patch(`/v1/identity/accounts/${createdAccount.body.id}`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .send({ status: 'ACTIVE' })
          .expect(200);
        expect(activatedAccount.body.status).toBe('ACTIVE');

        const recovery = await request(gatewayUrl)
          .post('/v1/identity/auth/recovery/request')
          .send({ email: createdAccount.body.email })
          .expect(200);
        expect(recovery.body.status).toBe('accepted');
        expect(recovery.body.devResetToken).toEqual(expect.any(String));
        const newPassword = `Recovered-${randomUUID()}-Password!`;
        await request(gatewayUrl)
          .post('/v1/identity/auth/recovery/reset')
          .send({ token: recovery.body.devResetToken, newPassword })
          .expect(200)
          .expect(({ body }) => {
            expect(body.status).toBe('password_reset');
          });
        await request(gatewayUrl)
          .post('/v1/identity/auth/recovery/reset')
          .send({ token: recovery.body.devResetToken, newPassword })
          .expect(400);
        const recoveredLogin = await request(gatewayUrl)
          .post('/v1/identity/auth/login')
          .send({ email: createdAccount.body.email, password: newPassword })
          .expect(200);
        expect(recoveredLogin.body.account.id).toBe(createdAccount.body.id);

        const oidcKey = randomUUID();
        const oidcBody = {
          programmeSlug: 'gateway-oidc-e2e',
          issuer: 'https://issuer.example.test',
          clientId: 'gateway-e2e-client',
        };
        const oidcMapping = await request(gatewayUrl)
          .post('/v1/identity/oidc/providers')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', oidcKey)
          .send(oidcBody)
          .expect(201);
        expect(oidcMapping.body).toMatchObject({
          ...oidcBody,
          scopes: ['openid', 'profile', 'email'],
          enabled: true,
        });
        const repeatedOidcMapping = await request(gatewayUrl)
          .post('/v1/identity/oidc/providers')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', oidcKey)
          .send(oidcBody)
          .expect(201);
        expect(repeatedOidcMapping.body.id).not.toBe(oidcMapping.body.id);

        const nullableOidcMapping = await request(gatewayUrl)
          .post('/v1/identity/oidc/providers')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            programmeSlug: '  gateway-oidc-null-e2e  ',
            issuer: '  https://issuer.example.test/null  ',
            clientId: '  nullable-client  ',
            scopes: null,
            enabled: null,
          })
          .expect(201);
        expect(nullableOidcMapping.body).toMatchObject({
          programmeSlug: '  gateway-oidc-null-e2e  ',
          issuer: '  https://issuer.example.test/null  ',
          clientId: '  nullable-client  ',
          scopes: null,
          enabled: null,
        });

        const programmeSlug = `gateway-e2e-${randomUUID()}`;
        const programme = await request(gatewayUrl)
          .post('/v1/programmes')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            slug: programmeSlug,
            name: 'Gateway integration programme',
            entityTypes: [
              {
                code: 'E2E_PT',
                label: 'Integration point',
                geometryTypes: ['POINT'],
              },
            ],
            rules: { activationValidityDays: 7 },
          })
          .expect(201);
        const programmeRead = await request(gatewayUrl)
          .get(`/v1/programmes/${programmeSlug}`)
          .expect(200);
        expect(programmeRead.body.id).toBe(programme.body.id);

        const entities = await request(gatewayUrl)
          .get('/v1/geodata/entities')
          .query({ programme: programmeSlug, page: 1, pageSize: 10 })
          .expect(200);
        expect(entities.body).toMatchObject({
          items: [],
          page: 1,
          pageSize: 10,
          total: 0,
          nextPage: null,
        });

        const startedAt = new Date().toISOString();
        const activation = await request(gatewayUrl)
          .post('/v1/activations')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            programmeSlug,
            entityId: `entity-${randomUUID()}`,
            operatorId: login.body.account.id,
            operatorCallsign: 'EA0E2E',
            startedAt,
            programmeRules: {
              minimumQsos: { activation: 1, hunter: 1 },
            },
          })
          .expect(201);
        expect(activation.body.status).toBe('OPEN');

        const qsoResponse = await request(gatewayUrl)
          .post(`/v1/activations/${activation.body.id}/qsos`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            workedCallsign: 'F4E2E',
            timestamp: startedAt,
            band: '20M',
            mode: 'SSB',
          });
        expect(qsoResponse.status, JSON.stringify(qsoResponse.body)).toBe(201);
        const qso = qsoResponse.body.qso;
        expect(qso.workedCallsign).toBe('F4E2E');
        expect(qsoResponse.body.qsoCount).toBe(1);

        const correction = await request(gatewayUrl)
          .post(`/v1/qsos/${qso.id}/corrections`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .send({
            requestedBy: login.body.account.id,
            reason: 'Correct the worked callsign',
            proposedValues: { workedCallsign: 'F4E2X' },
          })
          .expect(201);
        expect(correction.body.status).toBe('PENDING');

        const correctionInbox = await request(gatewayUrl)
          .get('/v1/qso-corrections')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .query({
            programme: programmeSlug,
            status: 'PENDING',
            page: 1,
            pageSize: 10,
          })
          .expect(200);
        expect(correctionInbox.body).toMatchObject({
          page: 1,
          pageSize: 10,
          total: 1,
          items: [
            {
              id: correction.body.id,
              qso: { id: qso.id, workedCallsign: 'F4E2E' },
            },
          ],
        });

        const reviewedCorrection = await request(gatewayUrl)
          .post(`/v1/qsos/${qso.id}/corrections/${correction.body.id}/review`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .send({
            decision: 'APPLIED',
            reviewedBy: login.body.account.id,
            reviewNote: 'Verified against the station log',
          })
          .expect(200);
        expect(reviewedCorrection.body.status).toBe('APPLIED');

        const activationRead = await request(gatewayUrl)
          .get(`/v1/activations/${activation.body.id}`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .expect(200);
        expect(activationRead.body.qsos).toMatchObject([
          { id: qso.id, workedCallsign: 'F4E2X', status: 'CORRECTED' },
        ]);

        const closed = await request(gatewayUrl)
          .patch(`/v1/activations/${activation.body.id}`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .send({ status: 'CLOSED', endedAt: new Date().toISOString() })
          .expect(200);
        expect(closed.body.status).toBe('CLOSED');
      } finally {
        await Promise.all(
          [gatewayApp, geodataApp, activityApp, programmesApp, identityApp]
            .filter((app): app is INestApplication => app !== undefined)
            .map((app) => app.close()),
        );
        for (const name of envNames) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  },
);

async function startIdentity() {
  return bootstrapHttpService(
    IdentityModule,
    0,
    undefined,
    [],
    [],
    true,
    'identity-api',
  );
}

async function startActivity() {
  return bootstrapHttpService(
    ActivityModule,
    0,
    integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 2),
    [],
    [],
    true,
    'activity-api',
    [
      {
        method: 'POST',
        path: '/v1/awards/previews',
        maxBytes: 64 * 1024,
        detail: 'preview design exceeds 64 KiB',
      },
    ],
  );
}

async function startProgrammes() {
  return bootstrapHttpService(
    ProgrammesModule,
    0,
    undefined,
    [],
    [],
    true,
    'programmes-api',
  );
}

async function startGeodata() {
  return bootstrapHttpService(
    GeodataModule,
    0,
    integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 3),
    ['/v1/geodata/import-uploads/:uploadId/parts/:partNumber'],
    [],
    true,
    'geodata-api',
  );
}

async function startGateway() {
  return bootstrapHttpService(
    GatewayModule,
    0,
    integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 3),
    [],
    [{ path: '_internal/grafana/auth', method: RequestMethod.GET }],
    false,
    'gateway',
    [],
    false,
  );
}

async function listen(app: INestApplication) {
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

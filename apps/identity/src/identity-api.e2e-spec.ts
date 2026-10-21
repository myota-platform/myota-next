import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IdentityModule } from './identity.module.js';

const describeWithCoreDatabase = describe.skipIf(
  !process.env.CORE_DATABASE_URL,
);

describeWithCoreDatabase('Identity API with PostgreSQL', () => {
  it('bootstraps an operator and completes login, current-account, and refresh over HTTP', async () => {
    const email = `identity-e2e-${randomUUID()}@example.test`;
    const password = `MyOTA-e2e-${randomUUID()}!`;
    const previousEmail = process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL;
    const previousPassword = process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD;
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL = email;
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD = password;

    const module = await Test.createTestingModule({
      imports: [IdentityModule],
    }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/identity/auth/login')
        .send({ email, password })
        .expect(200);

      expect(login.body.account.email).toBe(email);
      expect(login.body.account.id).toEqual(expect.any(String));
      expect(login.body.accessToken).toEqual(expect.any(String));
      expect(login.body.refreshToken).toEqual(expect.any(String));

      const current = await request(server)
        .get('/identity/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
      expect(current.body.id).toBe(login.body.account.id);
      expect(current.body.scopes).toContain('*');

      const refreshed = await request(server)
        .post('/identity/auth/refresh')
        .send({ refreshToken: login.body.refreshToken })
        .expect(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
      expect(refreshed.body.refreshToken).toEqual(expect.any(String));
      expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);

      await request(server)
        .post('/identity/auth/refresh')
        .send({ refreshToken: login.body.refreshToken })
        .expect(401);
    } finally {
      await app.close();
      if (previousEmail === undefined) {
        delete process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL;
      } else {
        process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL = previousEmail;
      }
      if (previousPassword === undefined) {
        delete process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD;
      } else {
        process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
      }
    }
  });
});

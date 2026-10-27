import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { writeSecurityEvent } from '@app/platform/outbox.js';
import {
  pythonKeyErrorDetail,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityEmailChangeService } from './identity-email-change.service.js';

const SERVICE_TOKEN_SECONDS = 300;
const EMAIL_SERVICE = 'email-service';
const EMAIL_RESOLVE_SCOPE = 'identity.email.resolve';

@Injectable()
export class IdentityCredentialService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
    @Optional() private readonly emailChanges?: IdentityEmailChangeService,
  ) {}

  async issueServiceToken(
    body: Record<string, unknown>,
    authorization?: string,
  ): Promise<Record<string, unknown>> {
    if (!pythonTruthy(body.service))
      throw new BadRequestException('missing required fields: service');
    const service =
      typeof body.service === 'string' ? body.service : String(body.service);

    let scopes: string[];
    let claims: { sub: string; aud?: string };
    if (service === EMAIL_SERVICE) {
      if (!pythonTruthy(body.clientSecret))
        throw new BadRequestException('missing required fields: clientSecret');
      if (
        Object.keys(body).some(
          (key) => key !== 'service' && key !== 'clientSecret',
        )
      )
        throw new BadRequestException(
          'email service token requests accept no caller-selected scopes',
        );
      const expectedSecret =
        process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET ?? '';
      const expected = Buffer.from(expectedSecret, 'utf8');
      if (
        Array.from(expectedSecret).length < 32 ||
        typeof body.clientSecret !== 'string'
      ) {
        throw new ForbiddenException('service client authentication failed');
      }
      const supplied = Buffer.from(body.clientSecret, 'utf8');
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      ) {
        throw new ForbiddenException('service client authentication failed');
      }
      scopes = [EMAIL_RESOLVE_SCOPE];
      claims = { sub: `service:${EMAIL_SERVICE}`, aud: 'myota-identity' };
    } else {
      if (!pythonTruthy(body.scopes))
        throw new BadRequestException('missing required fields: scopes');
      if (Object.hasOwn(body, 'clientSecret'))
        throw new BadRequestException(
          'clientSecret is not accepted for this service',
        );
      if (!authorization) {
        throw new UnauthorizedException(
          'Bearer authentication is required for service token issuance',
        );
      }
      const actor = await this.auth.currentAccount(authorization);
      const actorScopes = new Set(actor.scopes as string[]);
      if (!actorScopes.has('*') && !actorScopes.has('identity.service.issue')) {
        throw new ForbiddenException(
          'identity.service.issue scope is required',
        );
      }
      if (
        !Array.isArray(body.scopes) ||
        !body.scopes.every((scope) => typeof scope === 'string')
      )
        throw new BadRequestException('scopes must be an array of strings');
      if (body.scopes.includes(EMAIL_RESOLVE_SCOPE)) {
        throw new ForbiddenException(
          'email recipient scope is reserved for email-service',
        );
      }
      scopes = body.scopes;
      claims = { sub: `service:${service}` };
    }

    const now = Math.floor(Date.now() / 1000);
    const accessToken = this.auth.signServiceToken({
      ...claims,
      jti: randomUUID(),
      scp: scopes,
      iat: now,
      exp: now + SERVICE_TOKEN_SECONDS,
    });

    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await writeSecurityEvent(client, 'identity.service-token.issued.v1', {
        service,
        scopes,
      });
      await client.query('COMMIT');
      return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: SERVICE_TOKEN_SECONDS,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveEmailRecipient(
    authorization: string,
    accountId: string,
    templateId?: string,
    contextId?: string,
  ): Promise<{
    deliverableAddress: string;
    templateData?: Record<string, string>;
  }> {
    const claims = this.auth.verifyServiceToken(authorization);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const revoked = await client.query(
        'SELECT 1 FROM public.auth_revocation WHERE jti = $1 AND expires_at > now()',
        [claims.jti],
      );
      if (revoked.rowCount)
        throw new UnauthorizedException('token has been revoked');
      if (
        !claims.scp.includes(EMAIL_RESOLVE_SCOPE) ||
        claims.sub !== `service:${EMAIL_SERVICE}` ||
        claims.aud !== 'myota-identity'
      ) {
        throw new ForbiddenException('email service identity is required');
      }
      const normalizedAccountId = normalizePythonUuid(accountId);
      if (!normalizedAccountId)
        throw new NotFoundException(
          pythonKeyErrorDetail('recipient is unavailable'),
        );
      if (templateId?.startsWith('participant-email-change-')) {
        if (!this.emailChanges || !contextId)
          throw new NotFoundException(
            pythonKeyErrorDetail('recipient is unavailable'),
          );
        await client.query('COMMIT');
        return this.emailChanges.resolveDelivery(
          normalizedAccountId,
          templateId,
          contextId,
        );
      }
      const result = await client.query<{
        email: string | null;
        display_name: string;
      }>(
        `SELECT email::text AS email, display_name
           FROM public.account
          WHERE id = $1
            AND (
              (status = 'ACTIVE' AND email_verified = true)
              OR (
                status = 'PENDING_SETUP'
                AND email_verified = false
                AND $2::text = 'participant-email-verification.v1'
              )
            )`,
        [normalizedAccountId, templateId ?? null],
      );
      const account = result.rows[0];
      const email = account?.email;
      if (!email || !trimPythonWhitespace(email)) {
        throw new NotFoundException(
          pythonKeyErrorDetail('recipient is unavailable'),
        );
      }
      let templateData: Record<string, string> | undefined;
      if (templateId === 'password-reset.v1') {
        if (!contextId || !isUuid(contextId))
          throw new NotFoundException(
            pythonKeyErrorDetail('recipient is unavailable'),
          );
        const recoveryRequest = await client.query(
          `SELECT 1 FROM public.identity_password_recovery_request
            WHERE id = $1 AND account_id = $2
              AND invalidated_at IS NULL AND expires_at > clock_timestamp()`,
          [contextId, normalizedAccountId],
        );
        if (!recoveryRequest.rowCount)
          throw new NotFoundException(
            pythonKeyErrorDetail('recipient is unavailable'),
          );
        const token = randomBytes(32).toString('base64url');
        await client.query(
          `INSERT INTO public.account_recovery_token
             (token_hash, account_id, expires_at, request_id)
           VALUES ($1, $2, clock_timestamp() + ($3 * interval '1 second'), $4)`,
          [
            createHash('sha256').update(token).digest('hex'),
            normalizedAccountId,
            integerSetting(process.env.MYOTA_RECOVERY_TOKEN_SECONDS, 1800),
            contextId,
          ],
        );
        const resetUrl = participantResetUrl(token);
        templateData = { resetUrl };
      }
      await client.query('COMMIT');
      return {
        deliverableAddress: email,
        ...(templateData ? { templateData } : {}),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Identity database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Identity database is unavailable');
    }
  }
}

function participantResetUrl(token: string) {
  let base: URL;
  try {
    base = new URL(process.env.MYOTA_PARTICIPANT_PUBLIC_URL ?? '');
  } catch {
    throw new ServiceUnavailableException(
      'Participant recovery email is not configured',
    );
  }
  if (
    base.username ||
    base.password ||
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      ))
  )
    throw new ServiceUnavailableException(
      'Participant recovery email is not configured',
    );
  const resetUrl = new URL('/', base);
  resetUrl.hash = new URLSearchParams({ resetToken: token }).toString();
  return resetUrl.toString();
}

function normalizePythonUuid(value: string): string | null {
  let hex = value;
  if (hex.startsWith('urn:uuid:')) hex = hex.slice('urn:uuid:'.length);
  if (hex.startsWith('{') && hex.endsWith('}')) {
    hex = hex.slice(1, -1);
  }
  hex = hex.replaceAll('-', '');
  if (!/^[\da-f]{32}$/i.test(hex)) return null;
  const normalized = hex.toLowerCase();
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

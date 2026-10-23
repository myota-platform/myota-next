import { ForbiddenException } from '@nestjs/common';
import type { IdentityAuthService } from './auth.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import type { IdentityRoleService } from './identity-role.service.js';
import type { IdentityProfileImageService } from './identity-profile-image.service.js';

describe('IdentityAccountService creation validation order', () => {
  function service(scopes: string[]) {
    const auth = {
      currentAccount: async () => ({ id: 'actor-1', scopes }),
    } as unknown as IdentityAuthService;
    return new IdentityAccountService(
      null,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );
  }

  it('checks account-creation permission before validating the body', async () => {
    await expect(service([]).create('Bearer test', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects permanent passwords before later account fields', async () => {
    await expect(
      service(['identity.accounts.create']).create('Bearer test', {
        displayName: 'New participant',
        email: 'new@example.test',
        participationType: 'INVALID',
        password: 'must-use-invitation-flow',
        roles: {},
      }),
    ).rejects.toThrow(
      'passwords cannot be set during account creation; use the invitation setup flow',
    );
  });

  it('checks the roles container before validating participation type', async () => {
    await expect(
      service(['identity.accounts.create']).create('Bearer test', {
        displayName: 'New participant',
        email: 'new@example.test',
        participationType: 'INVALID',
        roles: {},
      }),
    ).rejects.toThrow('roles must be an array');
  });

  it('checks participation type before validating role entries', async () => {
    await expect(
      service(['identity.accounts.create']).create('Bearer test', {
        displayName: 'New participant',
        email: 'new@example.test',
        participationType: 'INVALID',
        roles: [null],
      }),
    ).rejects.toThrow('participationType must be OPERATOR or SWL');
  });
});

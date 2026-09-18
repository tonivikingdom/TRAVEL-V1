import { describe, expect, it } from 'vitest';

import { authorize, type Actor } from '../src/index.js';

const admin: Actor = {
  userId: 'SYNTHETIC-admin-id',
  email: 'synthetic-admin@synthetic.example.test',
  role: 'ADMIN',
  status: 'ACTIVE',
};

describe('central authorization policy', () => {
  it('allows an active administrator to manage invitations', () => {
    expect(() =>
      authorize(admin, 'CREATE_INVITATION', {
        kind: 'ACCOUNT_ADMINISTRATION',
      }),
    ).not.toThrow();
  });

  it('does not turn administrator role into universal private-data access', () => {
    expect(() =>
      authorize(admin, 'READ_PRIVATE_RESOURCE', {
        kind: 'PRIVATE_RESOURCE',
        ownerUserId: 'SYNTHETIC-other-owner',
      }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('allows an owner to read their own private resource', () => {
    const user: Actor = { ...admin, role: 'USER' };
    expect(() =>
      authorize(user, 'READ_PRIVATE_RESOURCE', {
        kind: 'PRIVATE_RESOURCE',
        ownerUserId: user.userId,
      }),
    ).not.toThrow();
  });

  it('allows only the owner to mutate a private resource', () => {
    const user: Actor = {
      ...admin,
      userId: 'SYNTHETIC-user-id',
      role: 'USER',
    };
    expect(() =>
      authorize(user, 'WRITE_PRIVATE_RESOURCE', {
        kind: 'PRIVATE_RESOURCE',
        ownerUserId: user.userId,
      }),
    ).not.toThrow();
    expect(() =>
      authorize(admin, 'WRITE_PRIVATE_RESOURCE', {
        kind: 'PRIVATE_RESOURCE',
        ownerUserId: user.userId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('rejects account administration by a normal user', () => {
    const user: Actor = { ...admin, role: 'USER' };
    expect(() =>
      authorize(user, 'DISABLE_USER', { kind: 'ACCOUNT_ADMINISTRATION' }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});

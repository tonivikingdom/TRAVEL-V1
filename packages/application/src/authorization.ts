import type { UserRole, UserStatus } from '@travel/contracts';

import { ApplicationError } from './errors.js';

export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
}

export type AuthAction =
  | 'CREATE_INVITATION'
  | 'LIST_USERS'
  | 'DISABLE_USER'
  | 'ENABLE_USER'
  | 'REVOKE_USER_SESSIONS'
  | 'READ_PRIVATE_RESOURCE'
  | 'WRITE_PRIVATE_RESOURCE';

export type AuthorizationResource =
  | { readonly kind: 'ACCOUNT_ADMINISTRATION' }
  | { readonly kind: 'PRIVATE_RESOURCE'; readonly ownerUserId: string };

const accountAdministrationActions: ReadonlySet<AuthAction> = new Set([
  'CREATE_INVITATION',
  'LIST_USERS',
  'DISABLE_USER',
  'ENABLE_USER',
  'REVOKE_USER_SESSIONS',
]);

export function authorize(
  actor: Actor,
  action: AuthAction,
  resource: AuthorizationResource,
): void {
  const allowed =
    actor.status === 'ACTIVE' &&
    ((resource.kind === 'ACCOUNT_ADMINISTRATION' &&
      accountAdministrationActions.has(action) &&
      actor.role === 'ADMIN') ||
      (resource.kind === 'PRIVATE_RESOURCE' &&
        (action === 'READ_PRIVATE_RESOURCE' ||
          action === 'WRITE_PRIVATE_RESOURCE') &&
        resource.ownerUserId === actor.userId));

  if (!allowed) {
    throw new ApplicationError('FORBIDDEN', '没有执行此操作的权限。', 403);
  }
}

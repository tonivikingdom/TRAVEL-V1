export { AuthService, type AuthServiceConfig } from './auth-service.js';
export {
  authorize,
  type Actor,
  type AuthAction,
  type AuthorizationResource,
} from './authorization.js';
export { ApplicationError, isApplicationError } from './errors.js';
export {
  CapturedMailSender,
  UnconfiguredMailSender,
  type AuthRepository,
  type AuthenticatedSession,
  type BootstrapAdminView,
  type CapturedMail,
  type ConsumeMagicLinkResult,
  type CreatedInvitation,
  type MagicLinkMail,
  type MailSender,
  type PreparedMagicLink,
} from './ports.js';
export { createOpaqueToken, digestOpaqueToken } from './tokens.js';

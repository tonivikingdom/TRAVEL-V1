export { AuthService, type AuthServiceConfig } from './auth-service.js';
export {
  authorize,
  type Actor,
  type AuthAction,
  type AuthorizationResource,
} from './authorization.js';
export { ApplicationError, isApplicationError } from './errors.js';
export {
  MagicLinkEmailHandler,
  type MagicLinkEmailHandlerConfig,
  type MagicLinkEmailHandlerOptions,
} from './magic-link-email-handler.js';
export {
  CapturedMailSender,
  UnconfiguredMailSender,
  type AuthRepository,
  type AuthenticatedSession,
  type BootstrapAdminView,
  type CapturedMail,
  type ConsumeMagicLinkResult,
  type CreatedInvitation,
  type ClaimedJob,
  type JobRepository,
  type JobStatus,
  type JobType,
  type MagicLinkDeliveryRepository,
  type MagicLinkMail,
  type MailSender,
  type PreparedMagicLinkDelivery,
} from './ports.js';
export {
  createOpaqueToken,
  deriveMagicLinkToken,
  digestOpaqueToken,
} from './tokens.js';

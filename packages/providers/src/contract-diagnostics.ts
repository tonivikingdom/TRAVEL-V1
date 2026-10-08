/** Closed diagnostic vocabulary. Never serialize errors, payloads, locations or URLs. */
export const DIAGNOSTIC_STAGES = [
  'REQUEST_SCHEMA',
  'HTTP_STATUS',
  'PROVIDER_BUSINESS_STATUS',
  'RESPONSE_SHAPE',
  'COORDINATE_PARSE',
  'ENDPOINT_BINDING',
  'DOMAIN_VALIDATION',
] as const;
export const DIAGNOSTIC_FIELDS = [
  'request.locationBias.circle.center',
  'request.departureTime',
  'response',
  'response.routes',
  'response.routes[].legs',
  'response.routes[].duration',
  'response.routes[].legs.startLocation/endLocation',
  'response.results',
  'response.places',
  'response.place.location',
  'response.place.identity',
  'response.place.region',
  'response.status',
  'candidate',
] as const;
export const DIAGNOSTIC_CODES = [
  'PASSED',
  'INVALID_SHAPE',
  'INVALID_COORDINATES',
  'OUTSIDE_REGION',
  'INVALID_DURATION',
  'COORDINATE_EQUIVALENCE_REQUIRED',
  'OFFSET_LIMIT_EXCEEDED',
  'ENDPOINT_REVERSED_OR_COLLAPSED',
  'DOMAIN_VALIDATION_FAILED',
  'UNSUPPORTED_TIME',
  'REQUEST_REJECTED',
  'API_NOT_ENABLED',
  'KEY_PERMISSION_REQUIRED',
  'ADVANCED_PERMISSION_REQUIRED',
  'INVALID_REQUEST_OR_VERSION',
  'AUTH_REJECTED',
  'UNKNOWN_BUSINESS_STATUS',
  'NO_ROUTE',
  'NETWORK_BLOCKED',
] as const;
export interface ProviderDiagnostic {
  stage: (typeof DIAGNOSTIC_STAGES)[number];
  field: (typeof DIAGNOSTIC_FIELDS)[number];
  code: (typeof DIAGNOSTIC_CODES)[number];
}
export type DiagnosticObserver = (diagnostic: ProviderDiagnostic) => void;
export class ProviderContractError extends Error {
  constructor(
    readonly diagnostic: ProviderDiagnostic,
    message:
      | 'PROVIDER_CONTRACT_REJECTED'
      | 'INVALID_PROVIDER_ENDPOINTS' = 'PROVIDER_CONTRACT_REJECTED',
  ) {
    super(message);
  }
}
export function contractStep<T>(
  observer: DiagnosticObserver | undefined,
  stage: ProviderDiagnostic['stage'],
  field: ProviderDiagnostic['field'],
  fn: () => T,
  failure: ProviderDiagnostic['code'] = 'INVALID_SHAPE',
): T {
  try {
    const value = fn();
    observer?.({ stage, field, code: 'PASSED' });
    return value;
  } catch (error) {
    const diagnostic =
      error instanceof ProviderContractError
        ? error.diagnostic
        : { stage, field, code: failure };
    observer?.(diagnostic);
    throw new ProviderContractError(diagnostic);
  }
}
/** Runtime whitelist at the output boundary, including against unexpected callbacks. */
export function safeDiagnostic(
  value: ProviderDiagnostic,
): ProviderDiagnostic | null {
  if (
    !DIAGNOSTIC_STAGES.includes(value.stage) ||
    !DIAGNOSTIC_FIELDS.includes(value.field) ||
    !DIAGNOSTIC_CODES.includes(value.code)
  )
    return null;
  return { stage: value.stage, field: value.field, code: value.code };
}

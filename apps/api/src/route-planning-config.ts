export interface RoutePlanningRuntimeConfig {
  readonly candidateSnapshotTtlSeconds: number;
  readonly previewTtlSeconds: number;
}

export function readRoutePlanningConfig(
  environment: NodeJS.ProcessEnv,
): RoutePlanningRuntimeConfig {
  const deploymentEnvironment = readDeploymentEnvironment(environment.APP_ENV);
  const allowSyntheticDefault =
    deploymentEnvironment === 'development' || deploymentEnvironment === 'test';
  return {
    candidateSnapshotTtlSeconds: readTtl(
      environment.ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS,
      'ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS',
      allowSyntheticDefault ? 900 : undefined,
    ),
    previewTtlSeconds: readTtl(
      environment.ROUTE_PREVIEW_TTL_SECONDS,
      'ROUTE_PREVIEW_TTL_SECONDS',
      allowSyntheticDefault ? 600 : undefined,
    ),
  };
}

function readDeploymentEnvironment(
  value: string | undefined,
): 'development' | 'test' | 'staging' | 'production' {
  const normalized = value ?? 'development';
  if (
    normalized === 'development' ||
    normalized === 'test' ||
    normalized === 'staging' ||
    normalized === 'production'
  ) {
    return normalized;
  }
  throw new Error('APP_ENV must be development, test, staging, or production');
}

function readTtl(
  value: string | undefined,
  name: string,
  fallback: number | undefined,
): number {
  if (value === undefined || value.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} must be configured outside Development/Test`);
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be an integer from 1 to 604800`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 604_800) {
    throw new Error(`${name} must be an integer from 1 to 604800`);
  }
  return parsed;
}

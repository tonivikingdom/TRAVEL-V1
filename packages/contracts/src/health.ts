export type ServiceStatus = 'UP' | 'READY' | 'NOT_READY';

export type DependencyStatus = 'READY' | 'UNAVAILABLE' | 'MISCONFIGURED';

export interface DependencyHealth {
  readonly name: 'postgresql';
  readonly status: DependencyStatus;
}

export interface LivenessResponse {
  readonly service: 'api';
  readonly status: 'UP';
}

export interface ReadinessResponse {
  readonly service: 'api';
  readonly status: 'READY' | 'NOT_READY';
  readonly dependencies: readonly DependencyHealth[];
}

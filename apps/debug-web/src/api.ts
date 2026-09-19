import type { ApiErrorCode, ApiErrorResponse } from '@travel/contracts';

export type ApiFailureKind = 'API' | 'HTTP' | 'NETWORK';

export class DebugApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiFailureKind,
    readonly status: number | null,
    readonly code: ApiErrorCode | null,
    readonly requestId: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DebugApiError';
  }
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly credential: () => string | null;
  readonly fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly credential: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? '/api').replace(/\/$/u, '');
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const credential = this.credential();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined)
      headers.set('content-type', 'application/json');
    if (credential !== null)
      headers.set('authorization', `Bearer ${credential}`);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new DebugApiError(
        '无法连接 API。',
        'NETWORK',
        null,
        null,
        null,
        true,
      );
    }

    if (!response.ok) {
      throw await parseErrorResponse(response);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export async function parseErrorResponse(
  response: Pick<Response, 'status' | 'json'>,
): Promise<DebugApiError> {
  try {
    const candidate = (await response.json()) as unknown;
    if (isApiErrorResponse(candidate)) {
      return new DebugApiError(
        candidate.error.message,
        'API',
        response.status,
        candidate.error.code,
        candidate.error.requestId,
        candidate.error.retryable,
      );
    }
  } catch {
    // Fall through to an HTTP-level error without inventing an API code.
  }
  return new DebugApiError(
    `HTTP ${response.status}`,
    'HTTP',
    response.status,
    null,
    null,
    response.status >= 500,
  );
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = value.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string' &&
    'requestId' in error &&
    typeof error.requestId === 'string' &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  );
}

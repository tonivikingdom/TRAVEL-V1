import type { ApiErrorCode } from '@travel/contracts';
export class WebError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'NETWORK',
    message: string,
  ) {
    super(message);
  }
}
export function errorText(error: unknown): string {
  if (!(error instanceof WebError))
    return error instanceof Error ? error.message : '操作未完成，请重试。';
  if (error.status === 401)
    return '登录已失效，请重新登录。未保存的内容仍保留在当前窗口。';
  if (error.status === 403) return '没有访问这份旅行的权限。';
  if (error.status === 404) return '这份旅行或安排已不存在，请重新载入。';
  if (error.code === 'SERVICE_UNAVAILABLE')
    return '核心服务暂时不可用，无法读取或保存行程。请恢复后重新载入。';
  if (error.code === 'NETWORK')
    return '连接中断，无法显示或保存行程。请联网后重新载入。';
  if (['VERSION_CONFLICT', 'PREVIEW_STALE'].includes(error.code))
    return '行程或方案已变化，请重新载入并核对。当前编辑没有覆盖服务器数据。';
  if (error.code.startsWith('UNDO_'))
    return '相关状态已更新，当前无法直接撤销；请重新检查后再调整。';
  if (error.code === 'ROUTE_PROVIDER_UNCONFIGURED')
    return '路线服务尚未配置。可以在地图中查询，不会修改行程。';
  return error.message;
}
export class TravelApi {
  constructor(
    private readonly credential: () => string | null,
    private readonly fetcher: typeof fetch = fetch.bind(globalThis),
  ) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.credential();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(`/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new WebError(0, 'NETWORK', '无法连接服务。');
    }
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as {
        error?: { code: ApiErrorCode; message: string };
      } | null;
      throw new WebError(
        response.status,
        value?.error?.code ?? 'SERVICE_UNAVAILABLE',
        value?.error?.message ?? '服务暂时不可用。',
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

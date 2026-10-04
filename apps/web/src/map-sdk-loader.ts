/** No automatic load. Only approved, explicitly mounted maps call this loader. */
export class MapSdkLoader {
  private readonly pending = new Map<string, Promise<void>>();
  private counter = 0;
  constructor(
    private readonly document: Document,
    private readonly globals: Record<string, unknown>,
  ) {}
  load(
    provider: 'GOOGLE' | 'BAIDU',
    key: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted)
      return Promise.reject(new Error('Map request cancelled'));
    const identity = `${provider}:${key}`;
    let shared = this.pending.get(identity);
    if (!shared) {
      shared = new Promise<void>((resolve, reject) => {
        const script = this.document.createElement('script');
        const callback = `travelMapSdkReady${++this.counter}`;
        const url = new URL(
          provider === 'GOOGLE'
            ? 'https://maps.googleapis.com/maps/api/js'
            : 'https://api.map.baidu.com/api',
        );
        url.searchParams.set(provider === 'GOOGLE' ? 'key' : 'ak', key);
        url.searchParams.set('v', provider === 'GOOGLE' ? 'weekly' : '1.0');
        if (provider === 'GOOGLE') url.searchParams.set('loading', 'async');
        else url.searchParams.set('type', 'webgl');
        url.searchParams.set('callback', callback);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          script.onerror = null;
          // A cancelled/failed script may arrive late: its callback remains a harmless no-op.
          this.globals[callback] = () => undefined;
          if (ok) resolve();
          else {
            script.remove();
            reject(new Error('Map SDK unavailable'));
          }
        };
        this.globals[callback] = () => finish(true);
        script.onerror = () => finish(false);
        script.async = true;
        script.src = url.href;
        const timer = setTimeout(() => finish(false), 12000);
        this.document.head.append(script);
      });
      this.pending.set(identity, shared);
      void shared.catch(() => this.pending.delete(identity));
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('Map request cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      void shared!.then(
        () => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
          else resolve();
        },
        () => {
          signal.removeEventListener('abort', abort);
          reject(new Error('Map SDK unavailable'));
        },
      );
    });
  }
}

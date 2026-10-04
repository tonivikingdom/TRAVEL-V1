import { TransitError } from './contract.js';

// A revision prevents a response/DOM update between inspection and subscription
// from being lost. Waits are event-driven, bounded and disposed after each query.
export class VerificationUpdates {
  revision = 0;
  private readonly listeners = new Set<() => void>();
  notify(): void {
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }
  wait(
    revision: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (revision !== this.revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        this.listeners.delete(changed);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const changed = () => finish();
      const aborted = () =>
        finish(signal.reason ?? new TransitError('REQUEST_CANCELLED'));
      const timer = setTimeout(changed, Math.max(0, timeoutMs));
      this.listeners.add(changed);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}
export async function waitForVerification<T>(
  updates: VerificationUpdates,
  inspect: () => Promise<T | undefined>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: TransitError | undefined;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    const revision = updates.revision;
    try {
      const result = await inspect();
      if (result !== undefined) return result;
    } catch (error) {
      if (
        !(error instanceof TransitError) ||
        !['REQUEST_MISMATCH', 'SCHEMA_CHANGED'].includes(error.code)
      )
        throw error;
      lastError = error;
    }
    await updates.wait(revision, deadline - Date.now(), signal);
  }
  throw lastError ?? new TransitError('UPSTREAM_TIMEOUT');
}

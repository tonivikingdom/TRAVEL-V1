export interface BrowserMapSlot {
  readonly key: string | null;
  readonly approved: boolean;
  readonly coordinatesApproved: boolean;
}
export interface BrowserMapConfig {
  readonly google: BrowserMapSlot;
  readonly baidu: BrowserMapSlot;
}
/** Explicit browser-only allowlist. Server REST keys/gates are never forwarded. */
export function browserMapConfig(
  env: Record<string, unknown>,
): BrowserMapConfig {
  const key = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return {
    google: {
      key: key(env.VITE_GOOGLE_MAPS_BROWSER_KEY),
      approved:
        env.VITE_GOOGLE_MAPS_EMBED_ENABLED === 'true' &&
        env.VITE_GOOGLE_MAPS_ENTITLEMENT_APPROVED === 'true' &&
        env.VITE_GOOGLE_MAPS_STORAGE_APPROVED === 'true' &&
        env.VITE_GOOGLE_MAPS_ATTRIBUTION_APPROVED === 'true',
      coordinatesApproved: true,
    },
    baidu: {
      key: key(env.VITE_BAIDU_MAPS_BROWSER_KEY),
      approved:
        env.VITE_BAIDU_MAPS_EMBED_ENABLED === 'true' &&
        env.VITE_BAIDU_MAPS_ENTITLEMENT_APPROVED === 'true' &&
        env.VITE_BAIDU_MAPS_STORAGE_APPROVED === 'true' &&
        env.VITE_BAIDU_MAPS_ATTRIBUTION_APPROVED === 'true',
      coordinatesApproved: env.VITE_BAIDU_MAPS_COORDINATES_APPROVED === 'true',
    },
  };
}

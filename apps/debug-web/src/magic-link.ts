export interface MagicLinkTokenResult {
  readonly token: string | null;
  readonly cleanUrl: string;
}

export function extractMagicLinkToken(url: string): MagicLinkTokenResult {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.replace(/^#/u, '')).get(
    'token',
  );
  parsed.hash = '';
  return { token, cleanUrl: parsed.toString() };
}

export function consumeFragmentToken(
  locationUrl: string,
  replaceUrl: (url: string) => void,
): string | null {
  const result = extractMagicLinkToken(locationUrl);
  if (result.token !== null) replaceUrl(result.cleanUrl);
  return result.token;
}

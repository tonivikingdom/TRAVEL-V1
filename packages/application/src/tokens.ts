import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface TokenPair {
  readonly digest: string;
  readonly raw: string;
}

export function digestOpaqueToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function createOpaqueToken(): TokenPair {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: digestOpaqueToken(raw) };
}

const MAGIC_LINK_TOKEN_DOMAIN = 'travel-v1/magic-link/v1/';

export function deriveMagicLinkToken(
  key: string,
  deliveryRequestId: string,
): TokenPair {
  if (key.length < 32) {
    throw new Error('Magic Link token key must contain at least 32 characters');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(deliveryRequestId)) {
    throw new Error('Magic Link delivery request id must be a UUID');
  }
  const raw = createHmac('sha256', key)
    .update(`${MAGIC_LINK_TOKEN_DOMAIN}${deliveryRequestId}`, 'utf8')
    .digest('base64url');
  return { raw, digest: digestOpaqueToken(raw) };
}

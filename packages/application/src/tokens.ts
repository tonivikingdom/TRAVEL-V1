import { createHash, randomBytes } from 'node:crypto';

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

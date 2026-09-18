import type { FastifyRequest } from 'fastify';

export interface CredentialTransport {
  extract(request: FastifyRequest): string | undefined;
}

export class OpaqueBearerCredentialTransport implements CredentialTransport {
  extract(request: FastifyRequest): string | undefined {
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      return undefined;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/u.exec(authorization);
    return match?.[1];
  }
}

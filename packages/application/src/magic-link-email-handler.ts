import type { MagicLinkDeliveryRepository, MailSender } from './ports.js';
import { deriveMagicLinkToken } from './tokens.js';

export interface MagicLinkEmailHandlerConfig {
  readonly landingUrl: string;
  readonly tokenKey: string;
  readonly tokenTtlSeconds: number;
}

export interface MagicLinkEmailHandlerOptions {
  readonly now?: () => Date;
}

export class MagicLinkEmailHandler {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MagicLinkDeliveryRepository,
    private readonly mailSender: MailSender,
    private readonly config: MagicLinkEmailHandlerConfig,
    options: MagicLinkEmailHandlerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    deliveryRequestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const now = this.now();
    const prepared = await this.repository.prepareDelivery({
      deliveryRequestId,
      deriveTokenDigest: (generation) =>
        deriveMagicLinkToken(
          this.config.tokenKey,
          deliveryRequestId,
          generation,
        ).digest,
      proposedExpiresAt: new Date(
        now.getTime() + this.config.tokenTtlSeconds * 1_000,
      ),
      now,
    });
    if (prepared.status !== 'SEND') {
      return;
    }

    signal?.throwIfAborted();
    const token = deriveMagicLinkToken(
      this.config.tokenKey,
      deliveryRequestId,
      prepared.tokenGeneration,
    );
    const url = new URL(this.config.landingUrl);
    url.hash = `token=${encodeURIComponent(token.raw)}`;
    await this.mailSender.sendMagicLink({
      recipient: prepared.recipient,
      magicLink: url.toString(),
      expiresAt: prepared.expiresAt,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    await this.repository.markDelivered(deliveryRequestId, this.now());
  }
}

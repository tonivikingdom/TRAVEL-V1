import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MagicLinkMail, MailSender } from '@travel/application';

export class FileCapturedMailSender implements MailSender {
  constructor(private readonly captureFile: string) {}

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    mail.signal?.throwIfAborted();
    await mkdir(dirname(this.captureFile), { recursive: true });
    mail.signal?.throwIfAborted();
    await appendFile(
      this.captureFile,
      `${JSON.stringify({
        kind: 'SYNTHETIC_MAGIC_LINK',
        recipient: mail.recipient,
        magicLink: mail.magicLink,
        expiresAt: mail.expiresAt.toISOString(),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

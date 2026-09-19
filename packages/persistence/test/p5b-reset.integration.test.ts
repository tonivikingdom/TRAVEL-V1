import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countP5bSyntheticUsers,
  resetP5bSyntheticData,
} from '../../../scripts/p5b-reset.js';
import { evaluateResetGuard } from '../../../scripts/p5b-support.js';
import { createPrismaClient, type ManagedPrismaClient } from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('P5B synthetic reset', () => {
  let managed: ManagedPrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const p5bEmail = `synthetic-p5b-reset-${suffix}@synthetic.example.test`;
  const otherSynthetic = `synthetic-other-${suffix}@synthetic.example.test`;
  const ordinaryEmail = `ordinary-${suffix}@example.test`;

  beforeAll(async () => {
    managed = createPrismaClient(databaseUrl!);
    for (const email of [p5bEmail, otherSynthetic, ordinaryEmail]) {
      await managed.client.user.create({
        data: {
          email,
          normalizedEmail: email,
          role: 'USER',
          status: 'ACTIVE',
          preference: {
            create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
          },
          trips: {
            create: {
              name: `SYNTHETIC reset ${email}`,
              planningAnchorDate: new Date('2035-01-01T00:00:00.000Z'),
              defaultPeopleCount: 1,
            },
          },
          notifications: {
            create: {
              kind: 'SYNTHETIC_RESET',
              dedupeKey: `reset-${email}`,
              title: 'SYNTHETIC',
              body: 'SYNTHETIC P5B reset fixture',
              occurredAt: new Date(),
            },
          },
        },
      });
    }
  });

  afterAll(async () => {
    await managed.client.notificationEvent.deleteMany({
      where: {
        owner: { normalizedEmail: { in: [otherSynthetic, ordinaryEmail] } },
      },
    });
    await managed.client.trip.deleteMany({
      where: {
        owner: { normalizedEmail: { in: [otherSynthetic, ordinaryEmail] } },
      },
    });
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { in: [otherSynthetic, ordinaryEmail] } },
    });
    await managed.close();
  });

  it('deletes only the strict P5B namespace and preserves other users', async () => {
    expect(await countP5bSyntheticUsers(managed.client)).toBeGreaterThanOrEqual(
      1,
    );
    const result = await resetP5bSyntheticData(managed.client);
    expect(result.deletedUsers).toBeGreaterThanOrEqual(1);
    expect(
      await managed.client.user.findUnique({
        where: { normalizedEmail: p5bEmail },
      }),
    ).toBeNull();
    for (const email of [otherSynthetic, ordinaryEmail]) {
      const user = await managed.client.user.findUnique({
        where: { normalizedEmail: email },
        include: { trips: true, notifications: true },
      });
      expect(user).not.toBeNull();
      expect(user?.trips).toHaveLength(1);
      expect(user?.notifications).toHaveLength(1);
    }
  });

  it('keeps destructive execution behind environment and confirmation guards', () => {
    expect(
      evaluateResetGuard({
        appEnv: 'production',
        confirmed: true,
        allowStaging: true,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateResetGuard({
        appEnv: 'development',
        confirmed: false,
        allowStaging: false,
      }),
    ).toEqual({ allowed: true, dryRun: true });
    expect(
      evaluateResetGuard({
        appEnv: 'staging',
        confirmed: true,
        allowStaging: false,
      }),
    ).toEqual({ allowed: true, dryRun: true });
  });
});

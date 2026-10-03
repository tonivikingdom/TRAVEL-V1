/** SYNTHETIC only: real browser → HTTP → PostgreSQL, followed by core failure. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import {
  AuthService,
  digestOpaqueToken,
  InTripReadService,
  StaticBackupService,
  TripService,
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaFlightRepository,
  PrismaInTripReadRepository,
  PrismaStaticBackupRepository,
  PrismaTripRepository,
} from '../packages/persistence/src/index.js';
import { SyntheticFlightProvider } from '../packages/providers/src/index.js';
import { buildApi } from '../apps/api/src/app.js';
const databaseUrl = process.env.DATABASE_URL;
assert(
  databaseUrl && ['development', 'test'].includes(process.env.APP_ENV ?? ''),
);
const target = new URL(databaseUrl);
assert(
  ['127.0.0.1', 'localhost'].includes(target.hostname) &&
    /^\/travel_p6b2_browser_[a-z0-9_]+$/u.test(target.pathname),
  'Dedicated SYNTHETIC DB required',
);
const db = createPrismaClient(databaseUrl),
  service = new TripService(new PrismaTripRepository(db.client));
const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
const user = await db.client.user.create({
  data: {
    email: `SYNTHETIC-${randomUUID()}@synthetic.example.test`,
    normalizedEmail: `SYNTHETIC-${randomUUID()}@synthetic.example.test`,
    preference: { create: { baseCurrency: 'JPY', uiLanguage: 'zh-CN' } },
    sessions: {
      create: {
        tokenDigest: digestOpaqueToken(credential),
        expiresAt: new Date(Date.now() + 3600000),
      },
    },
  },
});
const actor = {
  userId: user.id,
  email: user.email,
  role: 'USER' as const,
  status: 'ACTIVE' as const,
};
let trip = await service.createTrip(actor, {
  name: 'SYNTHETIC 旅行备份验收',
  planningAnchorDate: '2032-10-01',
  defaultPeopleCount: 2,
});
for (const i of [0, 1])
  trip = await service.executeCommand(actor, trip.id, trip.version, {
    type: 'ADD_PLACE_VISIT',
    position: i,
    targetDay:
      i === 0
        ? { type: 'NEW', localDate: '2032-10-01', sequence: 0 }
        : { type: 'EXISTING', dayOccurrenceId: trip.days[0]!.dayOccurrenceId },
    place: {
      type: 'CUSTOM',
      name: `SYNTHETIC 机场 ${i}`,
      latitude: 35 + i,
      longitude: 139,
      address: i === 0 ? 'SYNTHETIC 可靠地址' : null,
    },
    note: 'SYNTHETIC 用户备注',
  });
const [from, to] = trip.days[0]!.nodes;
trip = await service.executeCommand(actor, trip.id, trip.version, {
  type: 'SET_MANUAL_TRANSPORT',
  fromNodeId: from!.id,
  toNodeId: to!.id,
  mode: 'FLIGHT',
  fixedService: true,
  serviceLabel: 'SYNTHETIC 航班',
});
const provider = new SyntheticFlightProvider({
  scheduledUtc: '2032-10-01T05:15:00Z',
  observedAt: '2032-10-01T04:00:00Z',
  refreshMode: 'delayed',
  failFirstRefresh: false,
});
const snapshot = (
  await provider.search({ flightNumber: 'SY123', date: '2032-10-01' })
)[0]!;
const adopted = await new PrismaFlightRepository(db.client).adopt({
  ownerUserId: user.id,
  tripId: trip.id,
  baseTripVersion: trip.version,
  transportEdgeId: trip.connections[0]!.transport!.id,
  flight: snapshot,
});
assert(adopted.status === 'SUCCESS');
trip = await service.getTrip(actor, trip.id);
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' as const };
    },
  },
  authService: new AuthService(new PrismaAuthRepository(db.client), {
    magicLinkLandingUrl: 'http://127.0.0.1:5178/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 3600,
    invitationTtlSeconds: 3600,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 50,
    defaultBaseCurrency: 'JPY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 5,
  }),
  tripService: service,
  inTripReadService: new InTripReadService(
    new PrismaInTripReadRepository(db.client),
  ),
  staticBackupService: new StaticBackupService(
    new PrismaStaticBackupRepository(db.client),
  ),
});
const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
const web = spawn(
  'pnpm',
  ['--filter', '@travel/web', 'dev', '--port', '5178'],
  {
    env: { ...process.env, WEB_API_ORIGIN: apiOrigin },
    stdio: 'ignore',
    detached: true,
  },
);
const browser = await chromium.launch({
  executablePath: process.env.WEB_TEST_CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      ready = (await fetch('http://127.0.0.1:5178')).ok;
      if (ready) break;
    } catch {
      /* Starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(ready);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(
    (value) => sessionStorage.setItem('travel.web.session', value),
    credential,
  );
  await page.goto('http://127.0.0.1:5178');
  await page.locator('[data-trip]').click();
  await page.locator('[data-action=essentials]').click();
  await expect(page.locator('.essentials')).toContainText('SYNTHETIC 用户备注');
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('.backup-label')).toHaveText('正在查看备份');
  const stored = await db.client.tripStaticBackup.findFirstOrThrow({
    where: { tripId: trip.id },
  });
  assert.equal(stored.tripVersion, trip.version);
  assert.deepEqual(await service.getTrip(actor, trip.id), trip);
  assert.equal(
    await db.client.executionEvent.count({ where: { tripId: trip.id } }),
    0,
  );
  assert.equal(
    await db.client.tripAuthoringReceipt.count({ where: { tripId: trip.id } }),
    0,
  );
  await page.getByText('选定航班快照', { exact: false }).click();
  await expect(page.locator('.essentials')).toContainText(
    snapshot.displayFlightNumber,
  );
  await page.locator('[data-action=close-materials]').click();
  const edited = await service.executeCommand(actor, trip.id, trip.version, {
    type: 'SET_NODE_NOTE',
    nodeId: from!.id,
    note: 'SYNTHETIC 后续修改',
  });
  await page.locator('[data-action=reload]').click();
  await page.locator('[data-action=essentials]').click();
  await page.locator('[data-action=view-backup]').click();
  await expect(page.locator('.backup-warning')).toContainText(
    `在线行程已修改为版本 ${edited.version}`,
  );
  assert.deepEqual(
    (
      await db.client.tripStaticBackup.findUniqueOrThrow({
        where: { id: stored.id },
      })
    ).artifact,
    stored.artifact,
  );
  await page.locator('[data-action=close-materials]').click();
  await app.close();
  await page.locator('[data-action=reload]').click();
  await page.locator('[data-local-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  await page.reload();
  await page.locator('[data-local-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  assert.deepEqual(await service.getTrip(actor, trip.id), edited);
  console.log(
    JSON.stringify({
      synthetic: true,
      postgresHttpBrowser: 'PASS',
      explicitBackup: true,
      tripVersion: stored.tripVersion,
      immutableAfterEdit: true,
      coreFailureAndReload: true,
      backupTripWrites: 0,
    }),
  );
} finally {
  await browser.close();
  if (web.pid) process.kill(-web.pid, 'SIGTERM');
  await app.close();
  await db.close();
}

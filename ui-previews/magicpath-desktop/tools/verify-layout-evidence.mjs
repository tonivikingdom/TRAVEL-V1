import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const preview = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(preview, '../../docs/status/assets/issue-67-desktop-layout');
const readJson = async name => JSON.parse(await readFile(path.join(evidence, name), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1, message);
const screenshots = await readJson('screenshots.json');
const overlay = (await readFile(path.join(preview, 'src/desktop-layout.css'), 'utf8')).replaceAll(
  '\r\n',
  '\n'
);
assert.equal(
  sha256(overlay),
  screenshots.overlaySha256,
  'CSS changed since the browser evidence was captured; recapture it.'
);

const cases = new Map([
  ['1920x1080', [1920, 1080, 440]],
  ['2560x1440', [2560, 1440, 512]],
  ['3840x2160', [3840, 2160, 560]],
  ['scale-125-1536x864', [1536, 864, 396.8]],
  ['scale-150-1707x960', [1707, 960, 416]],
  ['scale-150-1280x720', [1280, 720, 368]],
  ['short-desktop-1920x600', [1920, 600, 360]],
  ['scale-200-960x540', [960, 540, 360]],
]);
const before = await readJson('before/layouts.json');
const after = await readJson('after/layouts.json');
for (const rows of [before, after]) {
  assert.equal(rows.length, cases.size * 2);
  assert.equal(new Set(rows.map(row => `${row.case}/${row.state}`)).size, rows.length);
  for (const row of rows) {
    const [width, height] = cases.get(row.case);
    assert.equal(row.viewport.width, width);
    assert.equal(row.viewport.height, height);
    assert.equal(row.viewport.scrollY, 0);
    const screenshot = screenshots.screenshots.find(
      shot => shot.path === `${rows === before ? 'before' : 'after'}/${row.case}-${row.state}.jpg`
    );
    assert.ok(screenshot);
    assert.equal(screenshot.width, width);
    assert.equal(screenshot.height, height);
  }
}
for (const row of after) {
  const [, height, heroHeight] = cases.get(row.case);
  near(row.hero.height, heroHeight, `${row.case} hero`);
  assert.ok(row.hero.height >= 359.9 && row.hero.height <= 560.1);
  assert.ok(row.root.height >= height - 1, `${row.case}: background does not cover viewport`);
  near(
    Number.parseFloat(row.minHeight),
    height,
    `${row.case}: min-height must follow the viewport`
  );
  assert.ok(row.document.width <= row.viewport.width, `${row.case}: horizontal overflow`);
  assert.ok(row.content.width <= 1728.1);
  near(row.content.width, row.header.width, 'Header and main width disagree');
  const columns = row.gridColumns.split(' ').length;
  assert.equal(columns, row.viewport.width < 1280 ? 3 : 4);
  assert.ok(row.cardHeights.every(height => Math.abs(height - 268) < 0.1));
  assert.equal(row.tripCount, row.state === 'ended' ? 1 : 4);
  assert.ok(Object.values(row.backgrounds).every(color => color === 'rgb(248, 251, 254)'));
}
for (const shot of screenshots.screenshots) {
  const bytes = await readFile(path.join(evidence, shot.path));
  assert.equal(bytes.length, shot.bytes);
  assert.equal(sha256(bytes), shot.sha256, shot.path);
}
for (const id of ['2560x1440', '3840x2160']) {
  const oldShot = screenshots.screenshots.find(shot => shot.path === `before/${id}-ended.jpg`);
  const newShot = screenshots.screenshots.find(shot => shot.path === `after/${id}-ended.jpg`);
  assert.ok(oldShot.bottomSamples.every(pixel => pixel.every(channel => channel >= 253)));
  assert.ok(
    newShot.bottomSamples.every(pixel =>
      pixel.every((channel, index) => Math.abs(channel - [248, 251, 254][index]) <= 2)
    )
  );
}
const panels = await readJson('panels.json');
assert.equal(panels.length, 3);
for (const panel of panels) {
  near(panel.account.header.right, panel.account.panel.right, 'Avatar popup alignment');
  near(
    panel.notification.header.right - 61,
    panel.notification.panel.right,
    'Notification popup alignment'
  );
}
const interactions = await readJson('interactions.json');
assert.deepEqual(
  interactions.checks.filter(check => check.tripCount !== undefined).map(check => check.tripCount),
  [1, 2, 1, 4]
);
assert.equal(interactions.checks.find(check => check.action === '搜索瑞士').matches, 1);
assert.equal(interactions.logs.length, 0);
assert.ok(interactions.scrolling.scrollY > 0);
assert.ok(interactions.scrolling.footer.bottom <= interactions.scrolling.viewportHeight + 1);
const native = await readJson('native-system.json');
assert.equal(native.before.all.viewport.dpr, native.after.all.viewport.dpr);
assert.equal(native.before.all.viewport.width, native.after.all.viewport.width);
assert.equal(native.before.all.viewport.height, native.after.all.viewport.height);
assert.ok(native.after.ended.root.height >= native.after.ended.viewport.height);
console.log(
  `PASS: ${cases.size} CSS viewports × 2 states, ${screenshots.screenshots.length} screenshot hashes/dimensions, native DPR, background, four-column limit, 268px cards, popup alignment, interactions and vertical scrolling. Historical 5ad5fc9 browser evidence is tied to desktop-layout.css; current card review is verified separately; this does not rerun a browser in CI.`
);

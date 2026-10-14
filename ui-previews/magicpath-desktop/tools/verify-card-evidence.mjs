import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const preview = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(preview, '../../docs/status/assets/issue-67-card-review');
const readJson = async name => JSON.parse(await readFile(path.join(evidence, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = await readJson('manifest.json');
for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
  assert.equal(
    hash((await readFile(path.join(preview, file), 'utf8')).replaceAll('\r\n', '\n')),
    expected,
    file
  );
}
for (const [file, expected] of Object.entries(manifest.screenshotHashes)) {
  assert.equal(hash(await readFile(path.join(evidence, file))), expected, file);
}
const rows = await readJson('layouts.json');
assert.equal(rows.length, 10);
assert.equal(new Set(rows.map(row => row.viewport.join('x') + row.state)).size, 10);
for (const row of rows) {
  assert.ok(row.centerError < 1);
  assert.equal(row.overflow, false);
  assert.equal(row.columns, row.viewport[0] < 1280 ? 3 : 4);
  assert.equal(row.cards.length, row.state === 'all' ? 4 : 1);
  assert.ok(row.cardHeights.every(height => height === 268));
  assert.ok(row.rootHeight >= row.viewport[1] - 1);
  assert.equal(row.background, 'rgb(248, 251, 254)');
  for (const card of row.cards) {
    assert.ok(card.text.includes('总费用待填写') && card.text.includes('人数待填写'));
    assert.ok(card.summaryBottom < card.cardBottom);
  }
  const colors = {
    出行中: 'rgb(22, 139, 117)',
    待出行: 'rgb(42, 126, 215)',
    已结束: 'rgb(100, 117, 134)',
  };
  for (const tag of row.tags) {
    assert.equal(tag.size, '14px');
    assert.equal(tag.color, colors[tag.text]);
  }
  for (const filter of row.filters.slice(1)) {
    const status = filter.text.slice(0, 3);
    if (row.state === 'ended' && status === '已结束')
      assert.equal(filter.background, colors[status]);
    else assert.equal(filter.color, colors[status]);
  }
}
const { checks, logs } = await readJson('interactions.json');
assert.deepEqual(
  checks.slice(0, 4).map(check => check.count),
  [1, 2, 1, 4]
);
assert.equal(checks[4].searchMatches, 1);
assert.ok(checks.slice(5).every(check => Object.values(check).every(value => value === true)));
assert.deepEqual(logs, []);
console.log(
  'PASS: current recorded desktop review evidence: five viewports, centering, colors, 14px tags, six card fields, background, interactions, original narrow-screen view. Browser is not rerun in CI.'
);

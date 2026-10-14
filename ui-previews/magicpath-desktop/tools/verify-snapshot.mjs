import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const preview = fileURLToPath(new URL('../', import.meta.url));
const snapshot = path.resolve(preview, '../../design-snapshots/magicpath/2026-10-13-v13');
const manifest = JSON.parse(await readFile(path.join(snapshot, 'source-manifest.json'), 'utf8'));
const assets = JSON.parse(
  await readFile(path.join(snapshot, 'assets-manifest.json'), 'utf8')
).assets;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

assert.equal(
  sha256(await readFile(path.join(snapshot, 'magicpath-project.zip'))),
  manifest.archive.sha256
);
for (const asset of assets) {
  const bytes = await readFile(path.join(preview, asset.path));
  assert.equal(bytes.length, asset.bytes, asset.path);
  assert.equal(sha256(bytes), asset.sha256, asset.path);
}
for (const entry of manifest.files.filter(entry => entry.path.startsWith('src/'))) {
  let text = (await readFile(path.join(preview, entry.path), 'utf8')).replaceAll('\r\n', '\n');
  for (const asset of assets)
    text = text.replaceAll('/assets/' + path.basename(asset.path), asset.sourceUrl);
  if (entry.path === 'src/App.tsx') {
    text = text.replace("const theme: Theme = 'light';", "let theme: Theme = 'light';");
    text = text.replace(
      './components/desktop/DesktopPreview',
      './components/generated/GeneratedComponent'
    );
    text = text.replace("import './desktop-layout.css';\n", '');
  }
  assert.equal(
    sha256(text),
    entry.normalizedTextSha256,
    `Source differs beyond declared migration adaptations: ${entry.path}`
  );
}
console.log(
  `PASS: original ZIP, ${assets.length} cached resources, all ${manifest.files.filter(entry => entry.path.startsWith('src/')).length} exported source files; declared resource URLs, App theme let→const and separate desktop CSS import and desktop adapter import adapted; original generated source retained.`
);

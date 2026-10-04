import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
it('production HTML/JS contains only explicit browser configuration, never server REST keys or DEV map harness', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'SYNTHETIC-map-secret-boundary-'),
  );
  vi.stubEnv('NODE_ENV', 'production');
  try {
    await writeFile(
      join(directory, '.env'),
      'GOOGLE_SERVER_API_KEY=SYNTHETIC_REST_GOOGLE_SECRET\nBAIDU_SERVER_API_KEY=SYNTHETIC_REST_BAIDU_SECRET\nVITE_GOOGLE_MAPS_BROWSER_KEY=SYNTHETIC_PUBLIC_GOOGLE_BROWSER\nVITE_BAIDU_MAPS_BROWSER_KEY=SYNTHETIC_PUBLIC_BAIDU_BROWSER\n',
    );
    const out = join(directory, 'output');
    await build({
      configFile: false,
      root: fileURLToPath(new URL('../', import.meta.url)),
      envDir: directory,
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    });
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const assets = await readdir(join(out, 'assets'));
    const js = (
      await Promise.all(
        assets
          .filter((p) => p.endsWith('.js'))
          .map((p) => readFile(join(out, 'assets', p), 'utf8')),
      )
    ).join('\n');
    for (const secret of [
      'SYNTHETIC_REST_GOOGLE_SECRET',
      'SYNTHETIC_REST_BAIDU_SECRET',
    ])
      expect(html + js).not.toContain(secret);
    expect(js).toContain('SYNTHETIC_PUBLIC_GOOGLE_BROWSER');
    expect(js).toContain('SYNTHETIC_PUBLIC_BAIDU_BROWSER');
    for (const harness of [
      'synthetic-map.invalid',
      'SYNTHETIC_REGIONAL',
      'SYNTHETIC_BROWSER_SDK_KEY',
    ])
      expect(js.includes(harness)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

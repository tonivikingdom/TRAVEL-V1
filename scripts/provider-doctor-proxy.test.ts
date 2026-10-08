import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
it('SYNTHETIC Doctor startup honors HTTPS_PROXY, NO_PROXY and CA verification over local CONNECT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'travel-doctor-proxy-'));
  const tls = httpsServer();
  const proxy = httpServer();
  let connects = 0,
    requests = 0;
  const seen: { header: string | undefined; query: string | null }[] = [];
  try {
    // Ephemeral SYNTHETIC test CA only; never use/copy a real Network Secret.
    await execute('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=SYNTHETIC',
      '-addext',
      'subjectAltName=DNS:synthetic-provider.invalid,IP:127.0.0.1',
    ]);
    tls.setSecureContext({
      key: await readFile(join(root, 'key.pem')),
      cert: await readFile(join(root, 'cert.pem')),
    });
    tls.on('request', (req, res) => {
      requests++;
      seen.push({
        header:
          typeof req.headers['x-goog-api-key'] === 'string'
            ? req.headers['x-goog-api-key']
            : undefined,
        query: new URL(
          req.url!,
          'https://synthetic-provider.invalid',
        ).searchParams.get('ak'),
      });
      res.end('SYNTHETIC_PROXY_OK');
    });
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
    const targetPort = (tls.address() as AddressInfo).port;
    proxy.on('connect', (req, socket, head) => {
      // No outbound provider/DNS traffic: only this reserved host may tunnel,
      // and the tunnel ALWAYS terminates at our own loopback HTTPS server.
      if (req.url !== 'synthetic-provider.invalid:443') {
        socket.destroy();
        return;
      }
      connects++;
      const upstream = connect(targetPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const command = pkg.scripts['provider:doctor']!.split(' ');
    expect(command.shift()).toBe('node');
    expect(command.pop()).toBe('scripts/provider-doctor-cli.ts');
    expect(command).toContain('--use-env-proxy');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_USE_ENV_PROXY: '',
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
      NODE_EXTRA_CA_CERTS: join(root, 'cert.pem'),
    };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    const child = (url: string, childEnv = env) =>
      execute(
        process.execPath,
        [
          ...command,
          '--input-type=module',
          '-e',
          `try { const r = await fetch(${JSON.stringify(url)}, {headers: {'X-Goog-Api-Key': 'SYNTHETIC_NETWORK_SECRET_PLACEHOLDER'}, signal: AbortSignal.timeout(3000)}); process.stdout.write(await r.text()); } catch { process.stdout.write('TLS_OR_NETWORK_REJECTED'); }`,
        ],
        { env: childEnv, timeout: 10000 },
      );
    expect(
      (
        await child(
          'https://synthetic-provider.invalid/?ak=SYNTHETIC_NETWORK_SECRET_PLACEHOLDER',
        )
      ).stdout,
    ).toBe('SYNTHETIC_PROXY_OK');
    expect(connects).toBe(1);
    expect(seen).toEqual([
      {
        header: 'SYNTHETIC_NETWORK_SECRET_PLACEHOLDER',
        query: 'SYNTHETIC_NETWORK_SECRET_PLACEHOLDER',
      },
    ]);
    // Same proxy, untrusted CA: MUST fail rather than disable TLS verification.
    expect(
      (
        await child('https://synthetic-provider.invalid/', {
          ...env,
          NODE_EXTRA_CA_CERTS: '',
        })
      ).stdout,
    ).toBe('TLS_OR_NETWORK_REJECTED');
    expect(requests).toBe(1);
    const count = connects;
    expect(
      (
        await child(`https://127.0.0.1:${targetPort}/`, {
          ...env,
          NO_PROXY: '127.0.0.1',
          no_proxy: '127.0.0.1',
        })
      ).stdout,
    ).toBe('SYNTHETIC_PROXY_OK');
    expect(connects).toBe(count);
    expect(requests).toBe(2);
  } finally {
    proxy.closeAllConnections();
    tls.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => tls.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

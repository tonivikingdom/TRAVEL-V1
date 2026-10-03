import { readConfig } from './config.js';
import { buildServer } from './server.js';
const config = readConfig(process.env);
const app = buildServer(config);
await app.listen({ host: '127.0.0.1', port: config.port });
process.stdout.write(
  `Google Transit compatible service listening on loopback port ${config.port}; enabled=${config.enabled}\n`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });

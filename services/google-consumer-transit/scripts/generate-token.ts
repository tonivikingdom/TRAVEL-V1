import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const path = new URL('../.env', import.meta.url);
await writeFile(
  path,
  `APP_ENV=development\nENABLE_GOOGLE_CONSUMER_TRANSIT=false\nLOCAL_TRANSIT_API_TOKEN=${randomBytes(32).toString('hex')}\n`,
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(
  'Created service .env with a dedicated token and disabled provider; existing files are never overwritten.\n',
);

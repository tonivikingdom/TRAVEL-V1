// SYNTHETIC: every URL is intercepted. No request reaches Google.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { BrowserClient } from '../services/google-consumer-transit/src/browser.js';
import { readConfig } from '../services/google-consumer-transit/src/config.js';
import { wallClock } from '../services/google-consumer-transit/src/contract.js';
import {
  query,
  raw,
} from '../services/google-consumer-transit/test/fixtures.js';

let searches = 0;
let closed = 0;
const browser = await chromium.launch({
  ...(process.env.WEB_TEST_CHROMIUM_PATH
    ? { executablePath: process.env.WEB_TEST_CHROMIUM_PATH }
    : {}),
  args: ['--no-sandbox'],
});
const originalContext = browser.newContext.bind(browser);
browser.newContext = async (options) => {
  const context = await originalContext(options);
  context.once('close', () => {
    closed++;
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/maps/preview/directions') {
      searches++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: raw(),
      });
      return;
    }
    if (
      url.hostname !== 'www.google.com' ||
      !url.pathname.startsWith('/maps/dir/')
    ) {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
      <main aria-label="Directions">
        <button id="mode">Leave now</button>
        <button role="menuitemradio" id="depart" hidden>Depart at</button>
        <button role="menuitemradio" id="arrive" hidden>Arrive by</button>
        <button id="date">Mon, Oct 5</button>
        <button role="gridcell" id="day" hidden>5 Oct</button>
        <input value="10:00 AM">
        <p id="route"></p>
      </main>
      <script>
        let mode = 0;
        const button = document.getElementById('mode');
        button.onclick = () => { document.getElementById('depart').hidden=false; document.getElementById('arrive').hidden=false; };
        document.getElementById('depart').onclick = () => { mode=0; button.textContent='Depart at'; };
        document.getElementById('arrive').onclick = () => { mode=1; button.textContent='Arrive by'; };
        document.getElementById('date').onclick = () => { document.getElementById('day').hidden=false; };
        document.getElementById('day').onclick = async () => {
          // Already correct time. Enter deliberately produces no request.
          await fetch('/maps/preview/directions?pb='+encodeURIComponent('!19m3!1e0!2e2!3j1'));
          history.replaceState(null,'','/maps/dir/!6e'+mode+'!7e2!8j'+(mode===0?${wallClock(query)}:${wallClock({ ...query, time: '10:30' })})+'!3e3');
          document.querySelector('input').value=mode===0?'10:00 AM':'10:30 AM';
          await fetch('/maps/preview/directions?pb='+encodeURIComponent('!19m3!1e'+mode+'!2e2!3j'+(mode===0?${wallClock(query)}:${wallClock({ ...query, time: '10:30' })})));
          document.getElementById('route').textContent='10:00 AM 10:30 AM SYNTHETIC Line';
        };
      </script>`,
    });
  });
  return context;
};
const client = new BrowserClient(
  readConfig({
    APP_ENV: 'test',
    LOCAL_TRANSIT_API_TOKEN: 'SYNTHETIC_BROWSER_ACCEPTANCE_TOKEN_32',
  }),
  (async () => browser) as unknown as NonNullable<
    ConstructorParameters<typeof BrowserClient>[1]
  >,
);
try {
  for (const timeMode of ['DEPART_AT', 'ARRIVE_BY'] as const) {
    const result = await client.search(
      {
        ...query,
        timeMode,
        time: timeMode === 'DEPART_AT' ? '10:00' : '10:30',
      },
      new AbortController().signal,
    );
    assert.equal(result.queryVerified, true);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.evidence.responseCount, 1);
  }
  assert.equal(searches, 4);
  assert.equal(closed, 2);
  console.log(
    'SYNTHETIC browser acceptance PASS: both modes, unchanged time, retained response, exact evidence, fresh context cleanup; zero live requests.',
  );
} finally {
  await client.close();
}

import { expect, it } from 'vitest';
import type { ConnectionView, TransportMode } from '@travel/contracts';
import {
  explicitQueryMode,
  selectedQueryMode,
} from '../src/route-query-mode.js';
import { inTripFixture } from './in-trip-fixture.js';

function chain(...modes: TransportMode[]): ConnectionView[] {
  const connection = inTripFixture().trip.connections[0]!;
  return modes.map((mode) => ({
    ...connection,
    transport: { ...connection.transport!, mode },
  }));
}
it.each([
  ['DRIVING', 'DRIVING'],
  ['TAXI', 'DRIVING'],
  ['WALKING', 'WALKING'],
  ['CYCLING', 'CYCLING'],
  ['TRANSIT', 'TRANSIT'],
  ['BUS', 'TRANSIT'],
  ['RAIL', 'TRANSIT'],
  ['FERRY', 'TRANSIT'],
] as const)(
  'inherits saved %s intent as %s without changing evidence',
  (mode, expected) => {
    const connections = chain(mode);
    const before = JSON.stringify(connections);
    expect(selectedQueryMode(connections)).toBe(expected);
    expect(JSON.stringify(connections)).toBe(before);
  },
);
it('preserves public transit intent through explicit walking transfers, never defaults to walking', () => {
  expect(selectedQueryMode(chain('BUS', 'WALKING', 'RAIL'))).toBe('TRANSIT');
  expect(selectedQueryMode(chain('TAXI', 'DRIVING'))).toBe('DRIVING');
});
it('missing, invalidated, unsupported and ambiguous mixed choices have no inherited mode', () => {
  expect(selectedQueryMode([])).toBeNull();
  expect(
    selectedQueryMode([{ ...chain('DRIVING')[0]!, transport: null }]),
  ).toBeNull();
  expect(
    selectedQueryMode([{ ...chain('DRIVING')[0]!, state: 'NOT_APPLICABLE' }]),
  ).toBeNull();
  for (const modes of [
    ['OTHER'],
    ['FLIGHT'],
    ['DRIVING', 'WALKING'],
    ['DRIVING', 'RAIL'],
  ] as TransportMode[][])
    expect(selectedQueryMode(chain(...modes))).toBeNull();
  for (const value of ['', null, undefined, 'NOW', 'TAXI', 'FLIGHT', 'driving'])
    expect(explicitQueryMode(value)).toBeNull();
  for (const value of ['WALKING', 'DRIVING', 'CYCLING', 'TRANSIT'])
    expect(explicitQueryMode(value)).toBe(value);
});

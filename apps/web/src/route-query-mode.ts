import type { ConnectionView, RouteQueryRequest } from '@travel/contracts';

type QueryMode = NonNullable<RouteQueryRequest['travelMode']>;
export function explicitQueryMode(value: unknown): QueryMode | null {
  return value === 'DRIVING' ||
    value === 'WALKING' ||
    value === 'CYCLING' ||
    value === 'TRANSIT'
    ? value
    : null;
}

/** Inherit saved transport intent, not region policy or a guessed default. */
export function selectedQueryMode(
  connections: readonly ConnectionView[],
): QueryMode | null {
  if (
    !connections.length ||
    connections.some((c) => c.state !== 'ACTIVE' || !c.transport)
  )
    return null;
  const modes = connections.map((c) => c.transport!.mode);
  if (modes.every((m) => m === 'DRIVING' || m === 'TAXI')) return 'DRIVING';
  if (modes.every((m) => m === 'WALKING')) return 'WALKING';
  if (modes.every((m) => m === 'CYCLING')) return 'CYCLING';
  const publicModes = ['TRANSIT', 'BUS', 'RAIL', 'FERRY'];
  if (
    modes.some((m) => publicModes.includes(m)) &&
    modes.every((m) => publicModes.includes(m) || m === 'WALKING')
  )
    return 'TRANSIT';
  return null;
}

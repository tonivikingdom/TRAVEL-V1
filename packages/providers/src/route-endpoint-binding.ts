/** Google RouteLeg start/end locations can differ from supplied waypoints because
 * they bind to roads: https://developers.google.com/maps/documentation/routes/reference/rest/v2/Route#RouteLeg
 * 100 m is our conservative acceptance policy, not a Google accuracy guarantee.
 * Baidu inverse coordinates are approximate: use a separate 50 m error budget,
 * never claim an official round-trip. Live acceptance must measure these budgets. */
export function endpointWithinBinding(
  requested: { latitude: number; longitude: number },
  returned: { latitude: number; longitude: number },
  provider: 'GOOGLE' | 'BAIDU',
): boolean {
  for (const p of [requested, returned])
    if (
      !Number.isFinite(p.latitude) ||
      !Number.isFinite(p.longitude) ||
      Math.abs(p.latitude) > 90 ||
      Math.abs(p.longitude) > 180
    )
      return false;
  const rad = Math.PI / 180;
  const a =
    Math.sin(((returned.latitude - requested.latitude) * rad) / 2) ** 2 +
    Math.cos(requested.latitude * rad) *
      Math.cos(returned.latitude * rad) *
      Math.sin(((returned.longitude - requested.longitude) * rad) / 2) ** 2;
  const meters =
    6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return meters <= (provider === 'GOOGLE' ? 100 : 50);
}

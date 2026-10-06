export const credentials = [
  ['Google Server key', 'GOOGLE_SERVER_API_KEY'],
  ['Google Browser key', 'VITE_GOOGLE_MAPS_BROWSER_KEY'],
  ['Baidu Server key', 'BAIDU_SERVER_API_KEY'],
  ['Baidu Browser key', 'VITE_BAIDU_MAPS_BROWSER_KEY'],
] as const;
export const gates = [
  ...['GOOGLE', 'BAIDU'].flatMap((p) =>
    [
      'LIVE_API_ENABLED',
      'ENTITLEMENT_APPROVED',
      'STORAGE_APPROVED',
      'ATTRIBUTION_APPROVED',
    ].map((g) => `${p}_${g}`),
  ),
  'BAIDU_COORDINATES_APPROVED',
  ...['GOOGLE', 'BAIDU'].flatMap((p) =>
    [
      'EMBED_ENABLED',
      'ENTITLEMENT_APPROVED',
      'STORAGE_APPROVED',
      'ATTRIBUTION_APPROVED',
    ].map((g) => `VITE_${p}_MAPS_${g}`),
  ),
  'VITE_BAIDU_MAPS_COORDINATES_APPROVED',
];
export const hosts = [
  'places.googleapis.com',
  'routes.googleapis.com',
  'maps.googleapis.com',
  'maps.gstatic.com',
  'api.map.baidu.com',
  'maponline0.bdimg.com',
  'maponline1.bdimg.com',
  'maponline2.bdimg.com',
  'maponline3.bdimg.com',
];
export function configuration(env: NodeJS.ProcessEnv): string[] {
  return [
    ...credentials.map(
      ([label, name]) => `${label}: ${env[name]?.trim() ? 'SET' : 'UNSET'}`,
    ),
    ...gates.map(
      (name) => `${name}: ${env[name] === 'true' ? 'true' : 'false'}`,
    ),
    ...hosts.map(
      (host) =>
        `Network required host: ${host} (ALLOWLIST_REQUIRED; not probed)`,
    ),
    'Google Mini Map: WIRED; browser SDK acceptance required',
    'Baidu Mini Map: BLOCKED_COORDINATE_CAPABILITY_NOT_INJECTED',
    'Baidu Browser coordinates: BLOCKED_OFFICIAL_CONTRACT_VERIFICATION',
    'Baidu TRANSIT: BLOCKED_OFFICIAL_CONTRACT_VERIFICATION',
    'Baidu CYCLING: BLOCKED_OFFICIAL_CONTRACT_VERIFICATION',
    'Baidu FUTURE DRIVING: BLOCKED_OFFICIAL_CONTRACT_VERIFICATION',
    'Baidu ARRIVE_BY: UNSUPPORTED',
  ];
}

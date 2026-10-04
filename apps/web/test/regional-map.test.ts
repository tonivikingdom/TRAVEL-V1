import { describe, it, expect, vi } from 'vitest';
import {
  mapProviderProjection,
  boundaryCoordinate,
} from './regional-map-fixture.js';
import { fixtureTrip } from './fixture.js';
import {
  RegionalMapComposition,
  type LiveMapContext,
} from '../src/regional-map-composition.js';
import {
  GoogleMapAdapter,
  BaiduMapAdapter,
} from '../src/provider-map-adapters.js';
import { browserMapConfig } from '../src/map-browser-config.js';
import { MapSdkLoader } from '../src/map-sdk-loader.js';
import { unconfiguredMapAdapter, type MapPoint } from '../src/map-adapter.js';

const p = (latitude = 35.6812, longitude = 139.7671): MapPoint => ({
  name: 'SYNTHETIC Place',
  latitude,
  longitude,
});
const disabled = { key: null, approved: false, coordinatesApproved: false };
function fixture(a: MapPoint, b = a) {
  const trip = fixtureTrip();
  return {
    ...trip,
    days: trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n, i) => ({
        ...n,
        place: { ...n.place!, ...(i ? b : a) },
      })),
    })),
  };
}
function composition(a: MapPoint, b = a) {
  let context: LiveMapContext | null = {
    owner: 'SYNTHETIC_OWNER_A',
    trip: fixture(a, b),
  };
  const loader = { load: vi.fn() } as unknown as MapSdkLoader;
  const google = new GoogleMapAdapter(disabled, loader, {}),
    baidu = new BaiduMapAdapter(disabled, loader, {});
  const read = vi.fn(async (_trip: string, id: string) => {
    const place = context!.trip.days
      .flatMap((d) => d.nodes)
      .find((n) => n.id === id)!.place!;
    return mapProviderProjection(place);
  });
  const maps = new RegionalMapComposition(() => context, read, {
    GOOGLE: google,
    BAIDU: baidu,
  });
  return {
    maps,
    read,
    loader,
    set: (c: LiveMapContext | null) => {
      context = c;
      maps.sync();
    },
  };
}
describe('A/C SYNTHETIC regional map composition', () => {
  it('same-coordinate transport nodes are each owner-scoped and a missing endpoint fails closed', async () => {
    const { maps, read } = composition(p());
    const nodes = fixture(p()).days[0]!.nodes;
    read.mockImplementation(async (_trip, id) => {
      if (id === nodes[1]!.id) throw new Error('SYNTHETIC endpoint removed');
      return mapProviderProjection(p());
    });
    const request = {
      kind: 'transport' as const,
      points: nodes.map((n) => ({ ...p(), nodeId: n.id })),
    };
    const adapter = await maps.resolve(request, new AbortController().signal);
    expect(read.mock.calls.map((c) => c[1]).sort()).toEqual(
      nodes.map((n) => n.id).sort(),
    );
    expect(adapter.externalMapUrl(request)).toBeNull();
  });
  it('one unrelated same-coordinate node failure does not block a valid Place capability', async () => {
    const { maps, read } = composition(p()),
      nodeId = fixture(p()).days[0]!.nodes[0]!.id;
    read.mockImplementation(async (_trip, id) => {
      if (id !== nodeId)
        throw new Error('SYNTHETIC unrelated capability failure');
      return mapProviderProjection(p());
    });
    const adapter = await maps.resolve(
      { kind: 'place', points: [{ ...p(), nodeId }] },
      new AbortController().signal,
    );
    expect(adapter.provider).toBe('GOOGLE');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([
    [39.9042, 116.4074, 'BAIDU'],
    [35.6812, 139.7671, 'GOOGLE'],
    [48.8566, 2.3522, 'GOOGLE'],
    [22.3193, 114.1694, 'GOOGLE'],
    [22.1987, 113.5439, 'GOOGLE'],
    [25.033, 121.5654, 'GOOGLE'],
  ] as const)(
    'A projection %s,%s selects %s without Web classification',
    async (latitude, longitude, provider) => {
      const point = p(latitude, longitude),
        { maps, read } = composition(point);
      const adapter = await maps.resolve(
        { kind: 'place', points: [point] },
        new AbortController().signal,
      );
      expect(adapter.provider).toBe(provider);
      expect(read).toHaveBeenCalled();
      expect(adapter.embedded).toBe(false);
      expect(
        new URL(adapter.externalMapUrl({ kind: 'place', points: [point] })!)
          .hostname,
      ).toBe(provider === 'BAIDU' ? 'api.map.baidu.com' : 'www.google.com');
    },
  );
  it('boundary uncertainty is inherited from A and never switches/falls back', async () => {
    const xy = boundaryCoordinate;
    const point = p(xy[1], xy[0]);
    expect(mapProviderProjection(point).provider).toBeNull();
    const { maps } = composition(point);
    const adapter = await maps.resolve(
      { kind: 'place', points: [point] },
      new AbortController().signal,
    );
    expect(adapter.embedded).toBe(false);
    expect(
      adapter.externalMapUrl({ kind: 'place', points: [point] }),
    ).toBeNull();
  });
  it('same-region endpoints share one capability; Japan/global and cross-provider pairs fail closed', async () => {
    for (const b of [
      p(35.7138, 139.7773),
      p(48.8566, 2.3522),
      p(39.9042, 116.4074),
    ]) {
      const { maps } = composition(p(), b);
      const request = { kind: 'transport' as const, points: [p(), b] };
      const adapter = await maps.resolve(request, new AbortController().signal);
      expect(!!adapter.externalMapUrl(request)).toBe(b.latitude === 35.7138);
    }
  });
  it('capability coordinates must match the current saved Place exactly', async () => {
    const { maps, read } = composition(p());
    read.mockResolvedValue(mapProviderProjection(p(36, 140)));
    const adapter = await maps.resolve(
      { kind: 'place', points: [p()] },
      new AbortController().signal,
    );
    expect(adapter.externalNavigationUrl(p())).toBeNull();
  });
  it.each([401, 403, 404, 503])(
    'capability failure %s has no legacy URL/SDK fallback',
    async (status) => {
      const { maps, read } = composition(p());
      read.mockRejectedValue(new Error(`SYNTHETIC ${status}`));
      const adapter = await maps.resolve(
        { kind: 'place', points: [p()] },
        new AbortController().signal,
      );
      expect(adapter.embedded).toBe(false);
      expect(maps.externalNavigationUrl(p())).toBeNull();
    },
  );
  it('backup/no-live context makes zero capability reads and exposes no online action', async () => {
    const { maps, set, read } = composition(p());
    set(null);
    await maps.preload();
    expect(read).not.toHaveBeenCalled();
    expect(maps.externalMapUrl({ kind: 'place', points: [p()] })).toBeNull();
  });
  it('owner/Trip version change invalidates mounted capability and old URL immediately', async () => {
    const { maps, set } = composition(p());
    const adapter = await maps.resolve(
      { kind: 'place', points: [p()] },
      new AbortController().signal,
    );
    expect(adapter.externalNavigationUrl(p())).not.toBeNull();
    set({ owner: 'SYNTHETIC_OWNER_B', trip: { ...fixture(p()), version: 2 } });
    expect(adapter.invalidationSignal?.aborted).toBe(true);
    expect(adapter.externalNavigationUrl(p())).toBeNull();
  });
  it('late capability after logout cannot repopulate the new owner scope', async () => {
    const { maps, set, read } = composition(p());
    let release!: (cap: ReturnType<typeof mapProviderProjection>) => void;
    const held = new Promise<ReturnType<typeof mapProviderProjection>>(
      (resolve) => {
        release = resolve;
      },
    );
    read.mockImplementation(() => held);
    const pending = maps.resolve(
      { kind: 'place', points: [p()] },
      new AbortController().signal,
    );
    set(null);
    release(mapProviderProjection(p()));
    await pending;
    expect(maps.externalNavigationUrl(p())).toBeNull();
  });
  it('adapter consumes API decision rather than inferring it from coordinates', async () => {
    const { maps, read } = composition(p(39.9042, 116.4074));
    read.mockResolvedValue({
      ...mapProviderProjection(p(39.9042, 116.4074)),
      provider: 'GOOGLE',
    });
    const adapter = await maps.resolve(
      { kind: 'place', points: [p(39.9042, 116.4074)] },
      new AbortController().signal,
    );
    expect(adapter.provider).toBe('GOOGLE');
  });
});
describe('browser configuration and official external URLs', () => {
  it('server REST keys and server gates cannot configure either browser SDK', () => {
    const config = browserMapConfig({
      GOOGLE_SERVER_API_KEY: 'SYNTHETIC_SERVER_GOOGLE',
      BAIDU_SERVER_API_KEY: 'SYNTHETIC_SERVER_BAIDU',
      GOOGLE_LIVE_API_ENABLED: 'true',
      GOOGLE_ENTITLEMENT_APPROVED: 'true',
    });
    expect(config.google.key).toBeNull();
    expect(config.baidu.key).toBeNull();
    expect(config.google.approved).toBe(false);
    expect(JSON.stringify(config)).not.toContain('SYNTHETIC_SERVER');
  });
  it('browser key and approvals are independent; missing any gate disables its SDK', () => {
    const env = {
      VITE_GOOGLE_MAPS_BROWSER_KEY: 'SYNTHETIC_BROWSER_ONLY',
      VITE_GOOGLE_MAPS_EMBED_ENABLED: 'true',
      VITE_GOOGLE_MAPS_ENTITLEMENT_APPROVED: 'true',
      VITE_GOOGLE_MAPS_STORAGE_APPROVED: 'true',
      VITE_GOOGLE_MAPS_ATTRIBUTION_APPROVED: 'true',
    };
    const loader = { load: vi.fn() } as unknown as MapSdkLoader;
    expect(
      new GoogleMapAdapter(browserMapConfig(env).google, loader, {}).embedded,
    ).toBe(true);
    for (const key of Object.keys(env))
      expect(
        new GoogleMapAdapter(
          browserMapConfig({ ...env, [key]: '' }).google,
          loader,
          {},
        ).embedded,
      ).toBe(false);
  });
  it('Baidu external URI declares WGS84; unknown navigation origin is not invented', () => {
    const adapter = new BaiduMapAdapter(disabled, {} as MapSdkLoader, {});
    const url = new URL(
      adapter.externalMapUrl({
        kind: 'place',
        points: [p(39.9042, 116.4074)],
      })!,
    );
    expect(url.pathname).toBe('/marker');
    expect(url.searchParams.get('coord_type')).toBe('wgs84');
    expect(url.searchParams.get('src')).toBe('webapp.travelv1.travel');
    expect(url.searchParams.has('ak')).toBe(false);
    expect(adapter.externalNavigationUrl(p())).toBeNull();
    const nav = new URL(
      adapter.externalNavigationUrl(p(), {
        origin: p(35.7, 139.8),
        mode: 'walking',
      })!,
    );
    expect(nav.pathname).toBe('/direction');
    expect(nav.searchParams.get('origin')).toBe('35.7,139.8');
    expect(nav.searchParams.get('coord_type')).toBe('wgs84');
  });
  it('Google URLs use WGS84 and never contain browser/server credentials', () => {
    const adapter = new GoogleMapAdapter(disabled, {} as MapSdkLoader, {});
    const url = new URL(
      adapter.externalNavigationUrl(p(), { mode: 'walking' })!,
    );
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('destination')).toBe('35.6812,139.7671');
    expect(url.searchParams.get('dir_action')).toBe('navigate');
    expect(url.searchParams.has('key')).toBe(false);
  });
  it('Baidu key/gates cannot bypass missing approved reverse coordinate capability', async () => {
    const load = vi.fn();
    const adapter = new BaiduMapAdapter(
      { key: 'SYNTHETIC_BROWSER', approved: true, coordinatesApproved: true },
      { load } as unknown as MapSdkLoader,
      {},
    );
    expect(adapter.embedded).toBe(false);
    await expect(
      adapter.mount(
        {} as HTMLElement,
        { kind: 'place', points: [p()] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('capability unavailable');
    expect(load).not.toHaveBeenCalled();
  });
  it('unconfigured adapters reject mount without touching the SDK loader', async () => {
    const load = vi.fn();
    await expect(
      new GoogleMapAdapter(
        disabled,
        { load } as unknown as MapSdkLoader,
        {},
      ).mount(
        {} as HTMLElement,
        { kind: 'place', points: [p()] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('unconfigured');
    expect(load).not.toHaveBeenCalled();
    expect(unconfiguredMapAdapter.synthetic).toBe(false);
  });
});

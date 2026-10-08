import { it, expect, vi, afterEach } from 'vitest';
import { MapSdkLoader } from '../src/map-sdk-loader.js';
import {
  GoogleMapAdapter,
  BaiduMapAdapter,
} from '../src/provider-map-adapters.js';
import type { MapPoint } from '../src/map-adapter.js';
const point: MapPoint = {
  name: 'SYNTHETIC SDK point',
  latitude: 35.68,
  longitude: 139.76,
};
const enabled = {
  key: 'SYNTHETIC_BROWSER_ONLY',
  approved: true,
  coordinatesApproved: true,
};
afterEach(() => vi.useRealTimers());
function loaderFixture() {
  const scripts: {
    src: string;
    onerror: (() => void) | null;
    remove: ReturnType<typeof vi.fn>;
  }[] = [];
  const globals: Record<string, unknown> = {};
  const document = {
    createElement: () => ({ src: '', onerror: null, remove: vi.fn() }),
    head: {
      append: (script: (typeof scripts)[number]) => scripts.push(script),
    },
  } as unknown as Document;
  return {
    loader: new MapSdkLoader(document, globals),
    globals,
    scripts,
    ready: () => {
      const callback = new URL(scripts[0]!.src).searchParams.get('callback')!;
      (globals[callback] as () => void)();
    },
  };
}
it.each(['GOOGLE', 'BAIDU'] as const)(
  'SYNTHETIC %s loader uses one approved fixed SDK endpoint and browser key',
  async (provider) => {
    const { loader, scripts, ready } = loaderFixture(),
      signal = new AbortController().signal;
    const a = loader.load(provider, 'SYNTHETIC_BROWSER_ONLY', signal),
      b = loader.load(provider, 'SYNTHETIC_BROWSER_ONLY', signal);
    expect(scripts).toHaveLength(1);
    const url = new URL(scripts[0]!.src);
    expect(url.hostname).toBe(
      provider === 'GOOGLE' ? 'maps.googleapis.com' : 'api.map.baidu.com',
    );
    expect(url.searchParams.get(provider === 'GOOGLE' ? 'key' : 'ak')).toBe(
      'SYNTHETIC_BROWSER_ONLY',
    );
    if (provider === 'BAIDU') expect(url.searchParams.get('v')).toBe('4.0');
    if (provider === 'BAIDU') expect(url.searchParams.has('type')).toBe(false);
    ready();
    await Promise.all([a, b]);
  },
);
it('loader error is sanitized and a later explicit mount can retry', async () => {
  const { loader, scripts } = loaderFixture();
  const pending = loader.load(
    'GOOGLE',
    'SYNTHETIC_BROWSER_ONLY',
    new AbortController().signal,
  );
  const check = expect(pending).rejects.toThrow('Map SDK unavailable');
  scripts[0]!.onerror!();
  await check;
  expect(scripts[0]!.remove).toHaveBeenCalled();
  const next = loader.load(
    'GOOGLE',
    'SYNTHETIC_BROWSER_ONLY',
    new AbortController().signal,
  );
  expect(scripts).toHaveLength(2);
  const check2 = expect(next).rejects.toThrow('Map SDK unavailable');
  scripts[1]!.onerror!();
  await check2;
});
it('SDK timeout is bounded and late callback cannot revive a failed mount', async () => {
  vi.useFakeTimers();
  const { loader, scripts, globals } = loaderFixture();
  const pending = loader.load(
    'GOOGLE',
    'SYNTHETIC_BROWSER_ONLY',
    new AbortController().signal,
  );
  const check = expect(pending).rejects.toThrow('Map SDK unavailable');
  await vi.advanceTimersByTimeAsync(12001);
  await check;
  const callback = new URL(scripts[0]!.src).searchParams.get('callback')!;
  expect(() => (globals[callback] as () => void)()).not.toThrow();
  expect(scripts[0]!.remove).toHaveBeenCalled();
});
it('one cancelled caller cannot cancel another map waiting for the same SDK', async () => {
  const { loader, ready } = loaderFixture(),
    cancelled = new AbortController();
  const a = loader.load('GOOGLE', 'SYNTHETIC_BROWSER_ONLY', cancelled.signal);
  const b = loader.load(
    'GOOGLE',
    'SYNTHETIC_BROWSER_ONLY',
    new AbortController().signal,
  );
  const check = expect(a).rejects.toThrow('cancelled');
  cancelled.abort();
  await check;
  ready();
  await b;
});
it('Google mount receives exact WGS84 endpoints, no geometry or private notes, and disposes markers', async () => {
  const clear = vi.fn(),
    setMap = vi.fn(),
    zoom = vi.fn(),
    center = vi.fn(),
    fit = vi.fn();
  const options: Record<string, unknown>[] = [],
    positions: unknown[] = [];
  const globals = {
    google: {
      maps: {
        Map: class {
          constructor(_host: HTMLElement, o: Record<string, unknown>) {
            options.push(o);
          }
          fitBounds = fit;
          setCenter = center;
          setZoom = zoom;
          getZoom = () => 15;
        },
        Marker: class {
          constructor(o: Record<string, unknown>) {
            positions.push(o.position);
          }
          setMap = setMap;
        },
        LatLngBounds: class {
          extend = vi.fn();
        },
        event: { clearInstanceListeners: clear },
      },
    },
  };
  const load = vi.fn(async () => undefined),
    host = { replaceChildren: vi.fn() } as unknown as HTMLElement;
  const adapter = new GoogleMapAdapter(
    enabled,
    { load } as unknown as MapSdkLoader,
    globals,
  );
  const cancel = new AbortController(),
    session = await adapter.mount(
      host,
      { kind: 'transport', points: [point, { ...point, latitude: 35.7 }] },
      cancel.signal,
    );
  expect(load).toHaveBeenCalledWith(
    'GOOGLE',
    'SYNTHETIC_BROWSER_ONLY',
    cancel.signal,
  );
  expect(positions).toEqual([
    { lat: 35.68, lng: 139.76 },
    { lat: 35.7, lng: 139.76 },
  ]);
  expect(options[0]!.gestureHandling).toBe('greedy');
  expect(fit).toHaveBeenCalledTimes(1);
  session.zoom(1);
  expect(zoom).toHaveBeenCalledWith(16);
  session.reset();
  expect(fit).toHaveBeenCalledTimes(2);
  cancel.abort();
  session.destroy();
  expect(setMap).toHaveBeenCalledTimes(2);
  expect(host.replaceChildren).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(3);
});
it('Google SDK late readiness after cancel never constructs a map', async () => {
  let release!: () => void;
  const makeMap = vi.fn(),
    cancel = new AbortController();
  const adapter = new GoogleMapAdapter(
    enabled,
    {
      load: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    } as unknown as MapSdkLoader,
    { google: { maps: { Map: makeMap } } },
  );
  const pending = adapter.mount(
    {} as HTMLElement,
    { kind: 'place', points: [point] },
    cancel.signal,
  );
  const check = expect(pending).rejects.toThrow('cancelled');
  cancel.abort();
  release();
  await check;
  expect(makeMap).not.toHaveBeenCalled();
});
it('Baidu mount accepts only an explicitly supplied BD09LL coordinate capability', async () => {
  const load = vi.fn(async () => undefined),
    locations: number[][] = [],
    clear = vi.fn(),
    destroy = vi.fn();
  const globals = {
    BMap: {
      Map: class {
        centerAndZoom = vi.fn();
        setViewport = vi.fn();
        addOverlay = vi.fn();
        clearOverlays = clear;
        getZoom = () => 15;
        setZoom = vi.fn();
        enableDragging = vi.fn();
        enableScrollWheelZoom = vi.fn();
        destroy = destroy;
      },
      Point: class {
        constructor(lng: number, lat: number) {
          locations.push([lng, lat]);
        }
      },
      Marker: class {},
    },
  };
  const convert = vi.fn(async () => [
    { latitude: 39.91, longitude: 116.42, coordinateSystem: 'BD09LL' as const },
  ]);
  const adapter = new BaiduMapAdapter(
    enabled,
    { load } as unknown as MapSdkLoader,
    globals,
    { convert },
  );
  const signal = new AbortController().signal,
    session = await adapter.mount(
      { replaceChildren: vi.fn() } as unknown as HTMLElement,
      { kind: 'place', points: [point] },
      signal,
    );
  expect(convert).toHaveBeenCalledWith([point], signal);
  expect(locations).toEqual([[116.42, 39.91]]);
  expect(load).toHaveBeenCalledWith('BAIDU', 'SYNTHETIC_BROWSER_ONLY', signal);
  session.destroy();
  session.destroy();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
});
it('Baidu invalid conversion fails before requesting its SDK', async () => {
  const load = vi.fn(),
    adapter = new BaiduMapAdapter(
      enabled,
      { load } as unknown as MapSdkLoader,
      {},
      {
        convert: async () => [
          { latitude: NaN, longitude: 116.42, coordinateSystem: 'BD09LL' },
        ],
      },
    );
  await expect(
    adapter.mount(
      {} as HTMLElement,
      { kind: 'place', points: [point] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('coordinate capability');
  expect(load).not.toHaveBeenCalled();
});

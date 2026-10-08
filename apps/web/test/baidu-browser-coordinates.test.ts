import { expect, it, vi } from 'vitest';
import { BaiduBrowserCoordinates } from '../src/baidu-browser-coordinates.js';
import { providerMapAdapters } from '../src/provider-map-adapters.js';
import type { MapSdkLoader } from '../src/map-sdk-loader.js';
const enabled = {
  key: 'SYNTHETIC_BROWSER_ONLY',
  approved: true,
  coordinatesApproved: true,
};
const point = {
  name: 'SYNTHETIC canonical point',
  latitude: 39.90725,
  longitude: 116.39138,
};
function fixture() {
  let complete!: (result: unknown) => void;
  const translate = vi.fn(
    (
      _points: unknown[],
      _from: number,
      _to: number,
      callback: (result: unknown) => void,
    ) => {
      complete = callback;
    },
  );
  const load = vi.fn(async () => undefined);
  const globals = {
    COORDINATES_WGS84: 1,
    COORDINATES_BD09: 5,
    BMap: {
      Point: class {
        constructor(
          readonly lng: number,
          readonly lat: number,
        ) {}
      },
      Convertor: class {
        translate = translate;
      },
      Map: class {
        centerAndZoom = vi.fn();
        setViewport = vi.fn();
        addOverlay = vi.fn();
        clearOverlays = vi.fn();
        destroy = vi.fn();
        setZoom = vi.fn();
        getZoom = () => 15;
      },
      Marker: class {},
    },
  };
  const loader = { load } as unknown as MapSdkLoader;
  return {
    globals,
    loader,
    translate,
    load,
    complete: (result: unknown) => complete(result),
    capability: new BaiduBrowserCoordinates(enabled, loader, globals),
  };
}
it('official JSAPI 4 coordinate conversion uses WGS84 to BD09 constants and browser key only', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const pending = f.capability.convert([point], signal);
  await vi.waitFor(() => expect(f.translate).toHaveBeenCalledTimes(1));
  expect(f.translate.mock.calls[0]!.slice(1, 3)).toEqual([1, 5]);
  expect(f.load).toHaveBeenCalledWith(
    'BAIDU',
    'SYNTHETIC_BROWSER_ONLY',
    signal,
  );
  f.complete({ status: 0, points: [{ lat: 39.915, lng: 116.404 }] });
  expect(await pending).toEqual([
    { latitude: 39.915, longitude: 116.404, coordinateSystem: 'BD09LL' },
  ]);
});
it.each([
  undefined,
  { status: 1, points: [] },
  { status: 0, points: [] },
  { status: 0, points: [null] },
  { status: 0, points: ['malformed'] },
  { status: 0, points: [{ lat: NaN, lng: 116 }] },
  { status: 0, points: [{ lat: 31, lng: 121 }] },
])(
  'failed/malformed/remote coordinate callbacks cannot be mounted',
  async (result) => {
    const f = fixture(),
      pending = f.capability.convert([point], new AbortController().signal);
    const check = expect(pending).rejects.toThrow('coordinate capability');
    await vi.waitFor(() => expect(f.translate).toHaveBeenCalledTimes(1));
    f.complete(result);
    await check;
  },
);
it('cancelled conversion rejects promptly and ignores late callback without mounting', async () => {
  const f = fixture(),
    cancel = new AbortController(),
    pending = f.capability.convert([point], cancel.signal);
  const check = expect(pending).rejects.toThrow('coordinate capability');
  await vi.waitFor(() => expect(f.translate).toHaveBeenCalledTimes(1));
  cancel.abort();
  await check;
  expect(() =>
    f.complete({ status: 0, points: [{ lat: 39.915, lng: 116.404 }] }),
  ).not.toThrow();
});
it('conversion timeout is bounded without retry', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(),
      pending = f.capability.convert([point], new AbortController().signal);
    const check = expect(pending).rejects.toThrow('coordinate capability');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(12001);
    await check;
    expect(f.translate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it('production composition injects the real capability by default and constructs BMap only after official callback', async () => {
  const f = fixture(),
    registry = providerMapAdapters(
      { google: enabled, baidu: enabled },
      f.loader,
      f.globals,
    );
  expect(registry.BAIDU.embedded).toBe(true);
  const pending = registry.BAIDU.mount(
    { replaceChildren: vi.fn() } as unknown as HTMLElement,
    { kind: 'place', points: [point] },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.translate).toHaveBeenCalledTimes(1));
  f.complete({ status: 0, points: [{ lat: 39.915, lng: 116.404 }] });
  const session = await pending;
  session.zoom(1);
  session.reset();
  session.destroy();
  session.destroy();
});
it('missing gates/key/constants or pre-cancelled conversion is local and never creates a map', async () => {
  const f = fixture(),
    disabled = new BaiduBrowserCoordinates(
      { ...enabled, approved: false },
      f.loader,
      f.globals,
    );
  await expect(
    disabled.convert([point], new AbortController().signal),
  ).rejects.toThrow('coordinate capability');
  expect(f.load).not.toHaveBeenCalled();
  await expect(
    new BaiduBrowserCoordinates(enabled, f.loader, {
      BMap: f.globals.BMap,
    }).convert([point], new AbortController().signal),
  ).rejects.toThrow('coordinate capability');
  expect(f.translate).not.toHaveBeenCalled();
  const cancel = new AbortController();
  cancel.abort();
  await expect(f.capability.convert([point], cancel.signal)).rejects.toThrow(
    'cancelled',
  );
});

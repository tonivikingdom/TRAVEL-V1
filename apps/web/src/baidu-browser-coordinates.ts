import type { BrowserMapSlot } from './map-browser-config.js';
import { reliablePoint, type MapPoint } from './map-adapter.js';
import type { MapSdkLoader } from './map-sdk-loader.js';
import type { BaiduCoordinateCapability } from './provider-map-adapters.js';
interface ConvertorSdk {
  Point: new (longitude: number, latitude: number) => unknown;
  Convertor: new () => {
    translate(
      points: unknown[],
      from: number,
      to: number,
      callback: (result: unknown) => void,
    ): void;
  };
}
/** Official online JSAPI conversion. No local forward/inverse math in Web.
 * SDK has no cancellation API: cancellation rejects locally and ignores late callbacks. */
export class BaiduBrowserCoordinates implements BaiduCoordinateCapability {
  constructor(
    private readonly config: BrowserMapSlot,
    private readonly loader: MapSdkLoader,
    private readonly globals: Record<string, unknown>,
  ) {}
  async convert(points: readonly MapPoint[], signal: AbortSignal) {
    if (
      !this.config.approved ||
      !this.config.coordinatesApproved ||
      !this.config.key ||
      points.length < 1 ||
      points.length > 2 ||
      !points.every(reliablePoint)
    )
      throw new Error('Baidu coordinate capability unavailable');
    await this.loader.load('BAIDU', this.config.key, signal);
    if (signal.aborted) throw new Error('Map request cancelled');
    const sdk = this.globals.BMap as ConvertorSdk | undefined;
    const from = this.globals.COORDINATES_WGS84,
      to = this.globals.COORDINATES_BD09;
    if (!sdk?.Point || !sdk.Convertor || from !== 1 || to !== 5)
      throw new Error('Baidu coordinate capability unavailable');
    return new Promise<
      readonly {
        latitude: number;
        longitude: number;
        coordinateSystem: 'BD09LL';
      }[]
    >((resolve, reject) => {
      let active = true;
      const finish = (
        result?: readonly {
          latitude: number;
          longitude: number;
          coordinateSystem: 'BD09LL';
        }[],
      ) => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (result) resolve(result);
        else reject(new Error('Baidu coordinate capability unavailable'));
      };
      const abort = () => finish();
      const timer = setTimeout(() => finish(), 12000);
      signal.addEventListener('abort', abort, { once: true });
      try {
        new sdk.Convertor().translate(
          points.map((p) => new sdk.Point(p.longitude, p.latitude)),
          from,
          to,
          (value) => {
            if (!active || signal.aborted) return;
            const result = value as
              | { status?: unknown; points?: { lat: number; lng: number }[] }
              | undefined;
            if (
              !result ||
              result.status !== 0 ||
              !Array.isArray(result.points) ||
              result.points.length !== points.length ||
              !result.points.every((p) => p !== null && typeof p === 'object')
            ) {
              finish();
              return;
            }
            const converted = result.points.map((p) => ({
              latitude: p.lat,
              longitude: p.lng,
              coordinateSystem: 'BD09LL' as const,
            }));
            // Sanity bound only, not a claim of official geodetic accuracy.
            if (
              !converted.every(
                (p, i) =>
                  reliablePoint({ ...p, name: '' }) &&
                  Math.abs(p.latitude - points[i]!.latitude) < 0.03 &&
                  Math.abs(p.longitude - points[i]!.longitude) < 0.03,
              )
            ) {
              finish();
              return;
            }
            finish(converted);
          },
        );
      } catch {
        finish();
      }
    });
  }
}

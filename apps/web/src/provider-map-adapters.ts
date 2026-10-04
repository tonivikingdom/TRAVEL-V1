import type { BrowserMapConfig, BrowserMapSlot } from './map-browser-config.js';
import {
  reliablePoint,
  type MapAdapter,
  type MapPoint,
  type MapRequest,
  type MapSession,
  type MapNavigationOptions,
} from './map-adapter.js';
import type { MapSdkLoader } from './map-sdk-loader.js';
type GooglePosition = { lat: number; lng: number };
interface GoogleMap {
  fitBounds(bounds: unknown): void;
  setCenter(position: GooglePosition): void;
  setZoom(zoom: number): void;
  getZoom(): number | undefined;
  unbindAll?(): void;
}
interface GoogleSdk {
  Map: new (host: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Marker: new (options: Record<string, unknown>) => { setMap(map: null): void };
  LatLngBounds: new () => { extend(point: GooglePosition): void };
  event: { clearInstanceListeners(instance: unknown): void };
}
interface BaiduMap {
  centerAndZoom(point: unknown, zoom: number): void;
  setViewport(points: unknown[]): void;
  addOverlay(overlay: unknown): void;
  clearOverlays(): void;
  getZoom(): number;
  setZoom(zoom: number): void;
  enableScrollWheelZoom(): void;
  enableDragging(): void;
  destroy(): void;
}
interface BaiduSdk {
  Map: new (host: HTMLElement) => BaiduMap;
  Point: new (longitude: number, latitude: number) => unknown;
  Marker: new (point: unknown) => unknown;
}
/** Supplied only after A/coordinate acceptance; no reverse conversion mathematics in Web. */
export interface BaiduCoordinateCapability {
  convert(
    points: readonly MapPoint[],
    signal: AbortSignal,
  ): Promise<
    readonly {
      latitude: number;
      longitude: number;
      coordinateSystem: 'BD09LL';
    }[]
  >;
}
const position = (p: MapPoint): GooglePosition => ({
  lat: p.latitude,
  lng: p.longitude,
});
const coords = (p: MapPoint) => `${p.latitude},${p.longitude}`;
const valid = (r: MapRequest) =>
  r.points.length > 0 && r.points.every((p) => reliablePoint(p));
const mode = (value: string | null | undefined) =>
  ['walking', 'driving', 'transit'].includes(value ?? '') ? value! : null;
export class GoogleMapAdapter implements MapAdapter {
  readonly provider = 'GOOGLE';
  readonly synthetic = false;
  readonly embedded: boolean;
  readonly unavailableText = '地图尚未配置，仍可使用外部地图';
  constructor(
    private readonly config: BrowserMapSlot,
    private readonly loader: MapSdkLoader,
    private readonly globals: Record<string, unknown>,
  ) {
    this.embedded = config.approved && !!config.key;
  }
  externalMapUrl(request: MapRequest): string | null {
    if (!valid(request)) return null;
    if (request.kind === 'transport') {
      if (request.points.length !== 2) return null;
      const href = this.externalNavigationUrl(request.points[1]!, {
        origin: request.points[0]!,
        mode: null,
      });
      if (!href) return null;
      const url = new URL(href);
      url.searchParams.delete('dir_action');
      return url.href;
    }
    const url = new URL('https://www.google.com/maps/search/');
    url.searchParams.set('api', '1');
    url.searchParams.set('query', coords(request.points[0]!));
    return url.href;
  }
  externalNavigationUrl(
    target: MapPoint,
    options?: MapNavigationOptions,
  ): string | null {
    if (
      !reliablePoint(target) ||
      (options?.origin && !reliablePoint(options.origin))
    )
      return null;
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('destination', coords(target));
    if (options?.origin) url.searchParams.set('origin', coords(options.origin));
    const travelMode = mode(options?.mode ?? 'walking');
    if (options?.mode === null) {
      /* External lookup does not choose a mode. */
    } else if (travelMode) url.searchParams.set('travelmode', travelMode);
    url.searchParams.set('dir_action', 'navigate');
    return url.href;
  }
  async mount(
    host: HTMLElement,
    request: MapRequest,
    signal: AbortSignal,
  ): Promise<MapSession> {
    if (!this.embedded || !valid(request))
      throw new Error('Map SDK unconfigured');
    await this.loader.load('GOOGLE', this.config.key!, signal);
    if (signal.aborted) throw new Error('Map request cancelled');
    const sdk = (this.globals.google as { maps?: GoogleSdk } | undefined)?.maps;
    if (!sdk?.Map || !sdk.Marker || !sdk.LatLngBounds || !sdk.event)
      throw new Error('Map SDK unavailable');
    const map = new sdk.Map(host, {
      center: position(request.points[0]!),
      zoom: 15,
      gestureHandling: 'greedy',
      disableDefaultUI: true,
      clickableIcons: false,
      mapTypeId: 'roadmap',
    });
    const markers = request.points.map(
      (p) => new sdk.Marker({ map, position: position(p), title: p.name }),
    );
    const bounds = new sdk.LatLngBounds();
    request.points.forEach((p) => bounds.extend(position(p)));
    const reset = () => {
      if (request.points.length > 1) map.fitBounds(bounds);
      else {
        map.setCenter(position(request.points[0]!));
        map.setZoom(15);
      }
    };
    reset();
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      markers.forEach((m) => {
        m.setMap(null);
        sdk.event.clearInstanceListeners(m);
      });
      sdk.event.clearInstanceListeners(map);
      map.unbindAll?.();
      host.replaceChildren();
      signal.removeEventListener('abort', destroy);
    };
    signal.addEventListener('abort', destroy, { once: true });
    return {
      zoom: (delta) =>
        map.setZoom(Math.max(3, Math.min(20, (map.getZoom() ?? 15) + delta))),
      reset,
      destroy,
    };
  }
}
export class BaiduMapAdapter implements MapAdapter {
  readonly provider = 'BAIDU';
  readonly synthetic = false;
  readonly embedded: boolean;
  readonly unavailableText: string;
  constructor(
    private readonly config: BrowserMapSlot,
    private readonly loader: MapSdkLoader,
    private readonly globals: Record<string, unknown>,
    private readonly conversion?: BaiduCoordinateCapability,
  ) {
    this.embedded =
      config.approved &&
      !!config.key &&
      config.coordinatesApproved &&
      !!conversion;
    this.unavailableText =
      config.approved && config.key && !conversion
        ? '百度内嵌地图坐标能力尚未接入'
        : '地图尚未配置，仍可使用外部地图';
  }
  private url(service: 'marker' | 'direction') {
    const url = new URL(`https://api.map.baidu.com/${service}`);
    url.searchParams.set('output', 'html');
    url.searchParams.set('coord_type', 'wgs84');
    url.searchParams.set('src', 'webapp.travelv1.travel');
    return url;
  }
  externalMapUrl(request: MapRequest): string | null {
    if (!valid(request)) return null;
    if (request.kind === 'transport') {
      if (request.points.length !== 2) return null;
      return this.externalNavigationUrl(request.points[1]!, {
        origin: request.points[0]!,
        mode: 'walking',
      });
    }
    const p = request.points[0]!,
      url = this.url('marker');
    url.searchParams.set('location', coords(p));
    url.searchParams.set('title', p.name);
    url.searchParams.set('content', p.name);
    return url.href;
  }
  externalNavigationUrl(
    target: MapPoint,
    options?: MapNavigationOptions,
  ): string | null {
    // Official Web URI direction requires an origin. Never invent user location.
    if (
      !reliablePoint(target) ||
      !options?.origin ||
      !reliablePoint(options.origin) ||
      !mode(options.mode)
    )
      return null;
    const url = this.url('direction');
    url.searchParams.set('origin', coords(options.origin));
    url.searchParams.set('destination', coords(target));
    url.searchParams.set('mode', options.mode!);
    return url.href;
  }
  async mount(
    host: HTMLElement,
    request: MapRequest,
    signal: AbortSignal,
  ): Promise<MapSession> {
    if (!this.embedded || !valid(request))
      throw new Error('Baidu map coordinate/SDK capability unavailable');
    const converted = await this.conversion!.convert(request.points, signal);
    if (
      signal.aborted ||
      converted.length !== request.points.length ||
      !converted.every(
        (p) =>
          p.coordinateSystem === 'BD09LL' && reliablePoint({ ...p, name: '' }),
      )
    )
      throw new Error('Baidu coordinate capability unavailable');
    await this.loader.load('BAIDU', this.config.key!, signal);
    if (signal.aborted) throw new Error('Map request cancelled');
    const sdk = this.globals.BMapGL as BaiduSdk | undefined;
    if (!sdk?.Map || !sdk.Point || !sdk.Marker)
      throw new Error('Map SDK unavailable');
    const points = converted.map((p) => new sdk.Point(p.longitude, p.latitude));
    const map = new sdk.Map(host);
    map.enableDragging();
    map.enableScrollWheelZoom();
    const reset = () =>
      points.length > 1
        ? map.setViewport(points)
        : map.centerAndZoom(points[0], 15);
    reset();
    points.forEach((p) => map.addOverlay(new sdk.Marker(p)));
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      map.clearOverlays();
      map.destroy();
      host.replaceChildren();
      signal.removeEventListener('abort', destroy);
    };
    signal.addEventListener('abort', destroy, { once: true });
    return {
      zoom: (delta) =>
        map.setZoom(Math.max(3, Math.min(20, map.getZoom() + delta))),
      reset,
      destroy,
    };
  }
}
export function providerMapAdapters(
  config: BrowserMapConfig,
  loader: MapSdkLoader,
  globals: Record<string, unknown>,
  conversion?: BaiduCoordinateCapability,
): Record<'GOOGLE' | 'BAIDU', MapAdapter> {
  return {
    GOOGLE: new GoogleMapAdapter(config.google, loader, globals),
    BAIDU: new BaiduMapAdapter(config.baidu, loader, globals, conversion),
  };
}

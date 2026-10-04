import type { RegionalMapCapabilityView, TripView } from '@travel/contracts';
import {
  unconfiguredMapAdapter,
  reliablePoint,
  type MapAdapter,
  type MapNavigationOptions,
  type MapPoint,
  type MapRequest,
  type MapSession,
} from './map-adapter.js';
export interface LiveMapContext {
  readonly owner: string;
  readonly trip: TripView;
}
type ReadCapability = (
  tripId: string,
  nodeId: string,
  signal: AbortSignal,
) => Promise<RegionalMapCapabilityView>;
const coordinateKey = (p: MapPoint) => `${p.latitude},${p.longitude}`;
const unavailable = (text: string): MapAdapter => ({
  ...unconfiguredMapAdapter,
  unavailableText: text,
});
/** API projection is the sole authority. This class checks scope/equality, never geography. */
export class RegionalMapComposition implements MapAdapter {
  readonly embedded = true;
  readonly synthetic = false;
  private identity = '';
  private generation = new AbortController();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly capabilities = new Map<string, RegionalMapCapabilityView>();
  constructor(
    private readonly context: () => LiveMapContext | null,
    private readonly read: ReadCapability,
    private readonly slots: Record<'GOOGLE' | 'BAIDU', MapAdapter>,
  ) {}
  sync(): boolean {
    const c = this.context(),
      identity = c ? `${c.owner}:${c.trip.id}:${c.trip.version}` : '';
    if (identity === this.identity) return false;
    this.generation.abort();
    this.generation = new AbortController();
    this.identity = identity;
    this.reads.clear();
    this.capabilities.clear();
    return true;
  }
  async preload(points?: readonly MapPoint[]): Promise<void> {
    this.sync();
    const c = this.context();
    if (!c) return;
    const signal = this.generation.signal;
    const nodes = c.trip.days
      .flatMap((d) => d.nodes)
      .filter((node) => {
        const p = reliablePoint(node.place);
        return (
          p &&
          (!points ||
            points.some(
              (point) =>
                (!point.nodeId || point.nodeId === node.id) &&
                coordinateKey(point) === coordinateKey(p),
            ))
        );
      });
    const readNode = async (node: (typeof nodes)[number]) => {
      const p = reliablePoint(node.place);
      if (!p) return;
      const key = node.id;
      if (this.reads.has(key)) return this.reads.get(key);
      const pending = this.read(
        c.trip.id,
        node.id,
        AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      )
        .then((cap) => {
          this.sync();
          if (
            signal.aborted ||
            cap.coordinateSystem !== 'WGS84' ||
            cap.coordinates.latitude !== p.latitude ||
            cap.coordinates.longitude !== p.longitude ||
            !['GOOGLE', 'BAIDU', null].includes(cap.provider) ||
            !['MAINLAND_CHINA', 'JAPAN', 'GLOBAL_OTHER', null].includes(
              cap.region,
            )
          )
            return;
          this.capabilities.set(key, cap);
        })
        .catch(() => {
          /* Capability/auth/network failure is local and has no fallback. */
        });
      this.reads.set(key, pending);
      await pending;
    };
    let cursor = 0;
    // Bounded ordinary API reads, never a Provider billing/request policy.
    await Promise.all(
      Array.from({ length: Math.min(4, nodes.length) }, async () => {
        while (!signal.aborted && cursor < nodes.length)
          await readNode(nodes[cursor++]!);
      }),
    );
  }
  private selection(
    points: readonly MapPoint[],
  ): { adapter: MapAdapter; capability: RegionalMapCapabilityView } | null {
    this.sync();
    if (
      !this.identity ||
      !points.length ||
      !points.every((p) => reliablePoint(p))
    )
      return null;
    const nodes = this.context()!.trip.days.flatMap((d) => d.nodes);
    const caps = points.flatMap((p) => {
      const matching = nodes.filter(
        (n) =>
          (!p.nodeId || n.id === p.nodeId) &&
          n.place &&
          coordinateKey(n.place) === coordinateKey(p),
      );
      return matching.length
        ? matching.map((n) => this.capabilities.get(n.id))
        : [undefined];
    });
    const first = caps[0];
    if (
      !first?.provider ||
      !first.region ||
      caps.some(
        (cap) =>
          !cap ||
          cap.provider !== first.provider ||
          cap.region !== first.region ||
          cap.coordinateSystem !== first.coordinateSystem,
      )
    )
      return null;
    return { adapter: this.slots[first.provider], capability: first };
  }
  async resolve(request: MapRequest, signal: AbortSignal): Promise<MapAdapter> {
    await this.preload(request.points);
    if (signal.aborted) throw new Error('Map request cancelled');
    const selected = this.selection(request.points);
    if (!selected) return unavailable('地图区域能力暂不可用，保留文字地点信息');
    const { adapter, capability } = selected,
      scope = this.generation.signal;
    const active = () => {
      this.sync();
      return !scope.aborted && !signal.aborted;
    };
    return {
      provider: capability.provider!,
      embedded: adapter.embedded,
      synthetic: adapter.synthetic,
      unavailableText: adapter.unavailableText ?? '内嵌地图尚未接入',
      invalidationSignal: scope,
      mount: async (
        host: HTMLElement,
        r: MapRequest,
        cancel: AbortSignal,
      ): Promise<MapSession> => {
        if (!active()) throw new Error('Map scope changed');
        const mounted = await adapter.mount(
          host,
          r,
          AbortSignal.any([cancel, scope]),
        );
        if (!active()) {
          mounted.destroy();
          throw new Error('Map scope changed');
        }
        return mounted;
      },
      externalMapUrl: (r) => {
        const cap = this.selection(r.points)?.capability;
        return active() &&
          cap?.provider === capability.provider &&
          cap.region === capability.region
          ? adapter.externalMapUrl(r)
          : null;
      },
      externalNavigationUrl: (target, options) => {
        const selectedTarget = this.selection(
          options?.origin ? [options.origin, target] : [target],
        );
        return active() &&
          selectedTarget?.capability.provider === capability.provider &&
          selectedTarget.capability.region === capability.region
          ? adapter.externalNavigationUrl(target, options)
          : null;
      },
    };
  }
  async mount(): Promise<MapSession> {
    throw new Error('Resolve regional capability first');
  }
  externalMapUrl(request: MapRequest): string | null {
    return (
      this.selection(request.points)?.adapter.externalMapUrl(request) ?? null
    );
  }
  externalNavigationUrl(
    target: MapPoint,
    options?: MapNavigationOptions,
  ): string | null {
    return (
      this.selection(
        options?.origin ? [options.origin, target] : [target],
      )?.adapter.externalNavigationUrl(target, options) ?? null
    );
  }
}

import type {
  MapAdapter,
  MapNavigationOptions,
  MapPoint,
  MapRequest,
  MapSession,
} from './map-adapter.js';

/** DEV/TEST ONLY. No tiles, keys, geolocation or network requests. */
export class SyntheticMapAdapter implements MapAdapter {
  readonly embedded = true;
  readonly synthetic = true;
  constructor(
    private readonly state: 'ready' | 'failure' | 'slow' | 'hang' = 'ready',
  ) {}
  externalMapUrl(request: MapRequest): string {
    const url = new URL('https://synthetic-map.invalid/view');
    url.searchParams.set(
      'points',
      request.points.map((p) => `${p.latitude},${p.longitude}`).join(';'),
    );
    return url.href;
  }
  externalNavigationUrl(
    point: MapPoint,
    options?: MapNavigationOptions,
  ): string {
    const url = new URL('https://synthetic-map.invalid/navigation');
    url.searchParams.set('destination', `${point.latitude},${point.longitude}`);
    if (options?.origin)
      url.searchParams.set(
        'origin',
        `${options.origin.latitude},${options.origin.longitude}`,
      );
    if (options?.mode) url.searchParams.set('travelmode', options.mode);
    return url.href;
  }
  async mount(
    host: HTMLElement,
    request: MapRequest,
    signal: AbortSignal,
  ): Promise<MapSession> {
    if (this.state === 'hang')
      await new Promise<void>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('SYNTHETIC hung SDK aborted')),
          { once: true },
        );
      });
    if (this.state === 'slow')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 800);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    if (this.state === 'failure' || signal.aborted)
      throw new Error('SYNTHETIC SDK failure');
    const points = request.points;
    const midLat =
      points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
    const midLng =
      points.reduce((sum, p) => sum + p.longitude, 0) / points.length;
    const span = Math.max(
      0.006,
      ...points.map((p) => Math.abs(p.latitude - midLat) * 2),
      ...points.map((p) => Math.abs(p.longitude - midLng) * 2),
    );
    const project = (p: MapPoint) => ({
      x: 180 + ((p.longitude - midLng) / span) * 220,
      y: 110 - ((p.latitude - midLat) / span) * 140,
    });
    const markers = points
      .map((p, i) => {
        const { x, y } = project(p);
        return `<g transform="translate(${x} ${y})"><path d="M0 0 C-24 -28 -10 -40 0 -40 C10 -40 24 -28 0 0" fill="${i === 0 ? '#176cba' : '#d57534'}" stroke="white" stroke-width="2"/><text x="0" y="-19" text-anchor="middle" fill="white" font-size="15">${i + 1}</text></g>`;
      })
      .join('');
    host.tabIndex = 0;
    host.innerHTML = `<svg data-synthetic-map viewBox="0 0 360 220" aria-hidden="true"><defs><pattern id="synthetic-blocks" width="60" height="50" patternUnits="userSpaceOnUse"><rect width="60" height="50" fill="#e8f1fa"/><rect x="8" y="8" width="43" height="33" rx="3" fill="#d3e3d9"/><path d="M0 0 H60 M0 0 V50" stroke="white" stroke-width="10"/></pattern></defs><g data-map-layer><rect x="-2000" y="-2000" width="4360" height="4220" fill="url(#synthetic-blocks)"/>${
      request.geometry?.length
        ? `<polyline points="${request.geometry
            .map((p) => {
              const { x, y } = project(p);
              return `${x},${y}`;
            })
            .join(' ')}" fill="none" stroke="#176cba" stroke-width="3"/>`
        : ''
    }${markers}</g><text x="180" y="205" text-anchor="middle" fill="#52667a" font-size="12">SYNTHETIC · 非真实道路</text></svg>`;
    const layer = host.querySelector<SVGGElement>('[data-map-layer]')!;
    const pointers = new Map<number, { x: number; y: number }>();
    const events = new AbortController();
    let x = 0,
      y = 0,
      scale = 1;
    const draw = () => {
      layer.setAttribute(
        'transform',
        `translate(${x} ${y}) translate(180 110) scale(${scale}) translate(-180 -110)`,
      );
      host.dataset.mapScale = String(scale);
      host.dataset.mapPan = `${x},${y}`;
    };
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    host.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (event.isTrusted) host.setPointerCapture(event.pointerId);
      },
      { signal: events.signal },
    );
    host.addEventListener(
      'pointermove',
      (event) => {
        const prior = pointers.get(event.pointerId);
        if (!prior) return;
        const before = distance();
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size === 1) {
          const bounds = host.getBoundingClientRect();
          x += ((event.clientX - prior.x) * 360) / bounds.width;
          y += ((event.clientY - prior.y) * 220) / bounds.height;
        } else if (before > 0)
          scale = Math.min(4, Math.max(0.5, (scale * distance()) / before));
        draw();
      },
      { signal: events.signal },
    );
    const end = (event: PointerEvent) => pointers.delete(event.pointerId);
    for (const name of [
      'pointerup',
      'pointercancel',
      'lostpointercapture',
    ] as const)
      host.addEventListener(name, end, { signal: events.signal });
    const zoom = (delta: number) => {
      scale = Math.min(4, Math.max(0.5, scale * 1.3 ** delta));
      draw();
    };
    host.addEventListener(
      'keydown',
      (event) => {
        const step = 20;
        if (event.key === '+') zoom(1);
        else if (event.key === '-') zoom(-1);
        else if (event.key === 'ArrowDown') y -= step;
        else if (event.key === 'ArrowUp') y += step;
        else if (event.key === 'ArrowRight') x -= step;
        else if (event.key === 'ArrowLeft') x += step;
        else return;
        event.preventDefault();
        draw();
      },
      { signal: events.signal },
    );
    const destroy = () => {
      events.abort();
      for (const id of pointers.keys())
        if (host.hasPointerCapture(id)) host.releasePointerCapture(id);
      pointers.clear();
      host.replaceChildren();
    };
    signal.addEventListener('abort', destroy, { once: true });
    draw();
    return {
      zoom,
      reset: () => {
        x = 0;
        y = 0;
        scale = 1;
        draw();
      },
      destroy,
    };
  }
}

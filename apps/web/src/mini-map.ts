import { esc } from './model.js';
import {
  externalMapUrl,
  externalNavigationUrl,
  reliablePoint,
  type MapAdapter,
  type MapRequest,
  type MapSession,
} from './map-adapter.js';
import type { MapLocation } from './maps.js';

export function miniMapMarkup(kind: MapRequest['kind']): string {
  return `<section class="mini-map" data-mini-map="${kind}" aria-label="${kind === 'place' ? '地点位置' : '交通起终点位置'}"></section>`;
}
/** Local lifecycle: replacement, close and late SDK completion cannot revive an old map. */
export function mountMiniMap(
  host: HTMLElement,
  kind: MapRequest['kind'],
  locations: readonly (MapLocation | null | undefined)[],
  adapter: MapAdapter,
  navigationTarget?: { location: MapLocation; label: string },
): () => void {
  const points = locations.flatMap((location) => {
    const point = reliablePoint(location);
    return point ? [point] : [];
  });
  const complete = points.length === locations.length && points.length > 0;
  const request: MapRequest = { kind, points };
  const controller = new AbortController();
  let session: MapSession | undefined;
  let disposed = false;
  const timers: { load?: ReturnType<typeof setTimeout> } = {};
  const dialog = host.closest('dialog');
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timers.load);
    controller.abort();
    observer.disconnect();
    session?.destroy();
  };
  const observer = new MutationObserver(() => {
    if (!host.isConnected || (dialog && !dialog.open)) dispose();
  });
  observer.observe(dialog ?? host.parentElement ?? host, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  const view = complete ? externalMapUrl(adapter, request) : null;
  // Transport navigation requires the saved origin, never substitute the destination.
  const target = reliablePoint(navigationTarget?.location ?? locations[0]);
  const nav = target ? externalNavigationUrl(adapter, target) : null;
  host.innerHTML = `<h3>${kind === 'place' ? '地点地图' : '起终点地图'}</h3>${adapter.synthetic ? '<p class="mini-map-synthetic">SYNTHETIC · 交互测试地图，非真实道路</p>' : ''}<div class="mini-map-status" role="status">${!complete ? '地图位置暂不可用' : !adapter.embedded ? '内嵌地图尚未接入' : '正在加载地图…'}</div>${points.length ? `<dl class="mini-map-points">${locations.map((location, index) => `<div><dt>${kind === 'place' ? '地点' : index === 0 ? '起点' : '终点'}</dt><dd>${esc(location?.name ?? '地点未提供')}${reliablePoint(location) ? '' : ' · 坐标未提供'}</dd></div>`).join('')}</dl>` : ''}<div class="mini-map-viewport" role="region" aria-label="${kind === 'place' ? '地点交互地图' : '交通起终点交互地图'}" hidden></div><div class="mini-map-controls" hidden><button type="button" data-map-zoom="1" aria-label="放大地图">＋</button><button type="button" data-map-zoom="-1" aria-label="缩小地图">−</button><button type="button" data-map-reset>重置视图</button></div>${kind === 'transport' ? '<p class="mini-map-note">仅展示起终点位置；未保存可靠路线轨迹。</p>' : ''}<div class="map-links mini-map-actions">${view ? `<a href="${esc(view)}" target="_blank" rel="noopener noreferrer">${kind === 'place' ? '在地图中查看' : '查看起终点'}</a>` : ''}${nav ? `<a href="${esc(nav)}" target="_blank" rel="noopener noreferrer">${esc(navigationTarget?.label ?? (kind === 'place' ? '导航到这里' : '导航到起点'))}</a>` : ''}</div>`;
  if (!complete || !adapter.embedded) return dispose;
  const viewport = host.querySelector<HTMLElement>('.mini-map-viewport')!;
  const status = host.querySelector<HTMLElement>('.mini-map-status')!;
  const controls = host.querySelector<HTMLElement>('.mini-map-controls')!;
  viewport.hidden = false;
  // Pointer ownership belongs to the SDK viewport. Drawer only owns its 44px handle.
  viewport.addEventListener('pointerdown', (event) => event.stopPropagation(), {
    signal: controller.signal,
  });
  host.addEventListener(
    'click',
    (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        'button',
      );
      if (button?.dataset.mapZoom)
        session?.zoom(Number(button.dataset.mapZoom));
      if (button?.hasAttribute('data-map-reset')) session?.reset();
    },
    { signal: controller.signal },
  );
  timers.load = setTimeout(() => {
    controller.abort();
    viewport.replaceChildren();
    viewport.hidden = true;
    status.textContent = '地图暂时无法加载';
  }, 12000);
  void Promise.resolve()
    .then(() => adapter.mount(viewport, request, controller.signal))
    .then((mounted) => {
      clearTimeout(timers.load);
      if (
        disposed ||
        controller.signal.aborted ||
        !host.isConnected ||
        (dialog && !dialog.open)
      ) {
        mounted.destroy();
        dispose();
        return;
      }
      session = mounted;
      controls.hidden = false;
      status.textContent = '可拖动或缩放地图；下拉关闭请使用顶部抓手。';
    })
    .catch(() => {
      clearTimeout(timers.load);
      if (disposed) return;
      controller.abort();
      viewport.replaceChildren();
      viewport.hidden = true;
      status.textContent = '地图暂时无法加载';
    });
  return dispose;
}

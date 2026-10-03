import type {
  BackupFlight,
  InTripView,
  StaticBackupView,
  TripView,
} from '@travel/contracts';
import { duration, esc, formatTime, modeLabel } from './model.js';
import { placeMap } from './maps.js';

export type EssentialsContent = Pick<
  StaticBackupView,
  | 'name'
  | 'peopleCount'
  | 'effectiveStartDate'
  | 'effectiveEndDate'
  | 'days'
  | 'transports'
  | 'routes'
  | 'flights'
>;

const prefix = 'travel.static-backup.v1:';
const ownerBinding = 'travel.static-backup.owner';
export function bindBackupOwner(owner: string | null) {
  const previous = sessionStorage.getItem(ownerBinding);
  if (previous && previous !== owner) clearLocalBackups(previous);
  if (owner) sessionStorage.setItem(ownerBinding, owner);
  else sessionStorage.removeItem(ownerBinding);
}
export function backupOwner() {
  return sessionStorage.getItem(ownerBinding);
}
export function clearLocalBackups(owner: string) {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(`${prefix}${owner}:`)) localStorage.removeItem(key);
}
export function localBackups(owner: string | null): StaticBackupView[] {
  if (!owner) return [];
  const result: StaticBackupView[] = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(`${prefix}${owner}:`)) continue;
    try {
      const value = JSON.parse(
        localStorage.getItem(key) ?? 'null',
      ) as StaticBackupView;
      if (
        typeof value?.generatedAt === 'string' &&
        typeof value.name === 'string' &&
        Number.isSafeInteger(value.tripVersion) &&
        value.tripVersion > 0 &&
        Number.isSafeInteger(value.peopleCount) &&
        value.peopleCount > 0 &&
        typeof value.id === 'string' &&
        value?.schema === 'travel-static-backup-v1' &&
        key === `${prefix}${owner}:${value.tripId}` &&
        Array.isArray(value.days) &&
        Array.isArray(value.routes) &&
        Array.isArray(value.flights) &&
        Array.isArray(value.transports)
      ) {
        essentialsBody(value, true);
        result.push(value);
      }
    } catch {
      /* Unreadable artifacts are not offered as a backup. */
    }
  }
  return result.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
export function saveLocalBackup(owner: string, backup: StaticBackupView) {
  localStorage.setItem(
    `${prefix}${owner}:${backup.tripId}`,
    JSON.stringify(backup),
  );
}
export function backupTimestamp(instant: string) {
  const date = new Date(instant);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`
    : '时间未知';
}
function savedFlight(
  f: InTripView['flights'][number]['selectedSnapshot'],
): BackupFlight {
  return {
    flightNumber: f.displayFlightNumber,
    serviceDate: f.serviceDate,
    fetchedAt: f.fetchedAt,
    departure: f.departure,
    arrival: f.arrival,
  };
}
/** Ephemeral live presentation only; this value is never stored or exported. */
export function liveEssentials(
  trip: TripView,
  evidence: InTripView | null,
): EssentialsContent {
  const planned = (
    values: TripView['days'][number]['nodes'][number]['timeValues'],
  ) =>
    values
      .filter((v) => v.layer === 'PLANNED')
      .map((v) => ({
        instant: v.instant,
        timeZone: v.timeZone,
        pointKind: v.pointKind,
      }));
  return {
    name: trip.name,
    peopleCount: trip.defaultPeopleCount,
    effectiveStartDate: trip.effectiveStartDate,
    effectiveEndDate: trip.effectiveEndDate,
    days: trip.days.map((d) => ({
      dayOccurrenceId: d.dayOccurrenceId,
      sequence: d.sequence,
      localDate: d.localDate,
      transportProjections: d.transportProjections,
      nodes: d.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        position: n.position,
        place: n.place
          ? {
              name: n.place.name,
              address: n.place.address,
              latitude: n.place.latitude,
              longitude: n.place.longitude,
            }
          : null,
        note: n.note,
        requirements: n.timeIntents.map((i) => ({
          kind: i.kind,
          pointKind: i.pointKind,
          operator: i.operator,
          instant: i.instant,
          timeZone: i.timeZone,
          durationSeconds: i.durationSeconds,
          locked: i.locked,
        })),
        plannedTimes: planned(n.timeValues),
      })),
    })),
    transports: trip.connections.flatMap((c) =>
      c.transport
        ? [
            {
              id: c.transport.id,
              fromNodeId: c.fromNodeId,
              toNodeId: c.toNodeId,
              mode: c.transport.mode,
              serviceLabel: c.transport.serviceLabel,
              note: c.transport.note,
              plannedTimes: planned(c.transport.timeValues),
            },
          ]
        : [],
    ),
    routes: (trip.savedRoutes ?? []).map((r) => ({
      transportEdgeIds: r.transportEdgeIds,
      legs: r.legs.map((l) => ({
        mode: l.mode,
        from: {
          name: l.from.name,
          address: null,
          latitude: l.from.latitude,
          longitude: l.from.longitude,
        },
        to: {
          name: l.to.name,
          address: null,
          latitude: l.to.latitude,
          longitude: l.to.longitude,
        },
        departure: l.departure,
        arrival: l.arrival,
        durationSeconds: l.durationSeconds,
        serviceLabel: l.serviceLabel,
        fixedService: l.fixedService,
      })),
    })),
    flights: (evidence?.tripVersion === trip.version
      ? evidence.flights
      : []
    ).map((f) => ({
      transportEdgeId: f.transportEdgeId,
      selectedSnapshot: savedFlight(f.selectedSnapshot),
      savedSnapshot: savedFlight(f.latestSnapshot),
    })),
  };
}
export function essentialsBody(value: EssentialsContent, backup: boolean) {
  const clock = (p: { instant: string; timeZone: string } | null | undefined) =>
    esc(formatTime(p ?? null));
  const notes = (s: string | null) =>
    s ? `<p class="essential-note">${esc(s)}</p>` : '';
  const location = (
    p: StaticBackupView['routes'][number]['legs'][number]['from'],
  ) =>
    `<strong>${esc(p.name)}</strong><p>${esc(p.address ?? '地址未提供')}</p><p class="muted">${p.latitude === null || p.longitude === null ? '坐标未提供' : `${esc(p.latitude)}, ${esc(p.longitude)}`}</p>${!backup && placeMap(p) ? `<a href="${esc(placeMap(p))}" target="_blank" rel="noopener noreferrer">查看地图</a>` : ''}`;
  const flightCard = (f: BackupFlight, label: string) =>
    `<details><summary>${label} · ${esc(f.flightNumber)}</summary><p>资料保存于 ${esc(backupTimestamp(f.fetchedAt))}，不是重新查询的结果。</p>${(
      ['departure', 'arrival'] as const
    )
      .map((side) => {
        const m = f[side];
        return `<p>${side === 'departure' ? '出发' : '到达'} · ${esc(m.airportName ?? m.airportIata ?? '机场未知')}</p><p>原计划 ${clock(m.scheduledUtc && m.timeZone ? { instant: m.scheduledUtc, timeZone: m.timeZone } : null)}</p><p>保存时预计 ${clock((m.revisedUtc ?? m.predictedUtc) && m.timeZone ? { instant: (m.revisedUtc ?? m.predictedUtc)!, timeZone: m.timeZone } : null)}</p><p>保存的车辆跑道时间 ${clock(m.runwayUtc && m.timeZone ? { instant: m.runwayUtc, timeZone: m.timeZone } : null)}</p><p>航站楼 ${esc(m.terminal ?? '未知')} · 登机口 ${esc(m.gate ?? '未知')} · 行李 ${esc(m.baggageBelt ?? '未知')}</p>`;
      })
      .join('')}</details>`;
  return `<h2>${esc(value.name)}</h2><p>${value.peopleCount} 人 · ${esc(value.effectiveStartDate ?? '有效日期未确定')}${value.effectiveEndDate ? ` 至 ${esc(value.effectiveEndDate)}` : ''}</p><p class="muted">以下时间按事件所在地时区显示。未知资料保持未知。</p>${value.days.map((d, i) => `<section class="essential-day"><h3>第 ${i + 1} 天 · ${esc(d.localDate)}</h3>${d.nodes.map((n) => `<article class="essential-card">${n.place ? location(n.place) : `<strong>${esc(n.note ?? '自由行动')}</strong><p class="muted">未指定地点</p>`}${n.place ? notes(n.note) : ''}${n.requirements.map((r) => `<p>用户要求 · ${r.kind === 'MIN_DWELL' ? `至少停留 ${esc(duration(r.durationSeconds))}` : `${r.pointKind === 'ARRIVAL' ? '到达' : '出发'}${{ EXACT: '需在', NOT_BEFORE: '不早于', NOT_AFTER: '不晚于', MINIMUM: '' }[r.operator]} ${clock(r.instant && r.timeZone ? { instant: r.instant, timeZone: r.timeZone } : null)}`}${r.locked ? ' · 受保护' : ''}</p>`).join('')}${n.plannedTimes.map((t) => `<p>${t.pointKind === 'ARRIVAL' ? '原计划到达' : '原计划出发'} <b>${clock(t)}</b></p>`).join('')}</article>`).join('') || '<p>此日期没有单独地点安排。</p>'}</section>`).join('') || '<p>这趟旅行尚无行程安排。</p>'}<section><h3>保存的交通</h3>${
    value.transports
      .map(
        (t) =>
          `<article class="essential-card"><strong>${esc(t.serviceLabel ?? modeLabel[t.mode])}</strong>${t.plannedTimes.map((p) => `<p>${p.pointKind === 'DEPARTURE' ? '原计划出发' : '原计划到达'} <b>${clock(p)}</b></p>`).join('')}${notes(t.note)}${value.routes
            .filter(
              (r) =>
                r.transportEdgeIds.find((id) =>
                  value.transports.some((edge) => edge.id === id),
                ) === t.id,
            )
            .map(
              (r) =>
                `<details><summary>查看已采用路线与上下车资料</summary>${r.legs.map((l) => `<div class="essential-leg"><strong>${esc(modeLabel[l.mode])} · ${esc(l.serviceLabel ?? '已保存路段')}</strong><p>上车 / 起点 · ${esc(l.from.name)}</p><p>下车 / 终点 · ${esc(l.to.name)}</p><p>原计划 ${clock(l.departure)} → ${clock(l.arrival)}</p><p class="muted">起点坐标 ${esc(l.from.latitude ?? '未知')}, ${esc(l.from.longitude ?? '未知')}<br>终点坐标 ${esc(l.to.latitude ?? '未知')}, ${esc(l.to.longitude ?? '未知')}</p></div>`).join('')}</details>`,
            )
            .join('')}${value.flights
            .filter((f) => f.transportEdgeId === t.id)
            .map(
              (f) =>
                flightCard(f.selectedSnapshot, '选定航班快照') +
                flightCard(f.savedSnapshot, '保存的航班信息'),
            )
            .join('')}</article>`,
      )
      .join('') || '<p>暂无保存的交通。</p>'
  }</section>`;
}
export function downloadBackup(backup: StaticBackupView) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>静态旅行备份</title><style>body{font:18px/1.6 system-ui;color:#183552;background:#f6f9ff;margin:auto;padding:20px;max-width:760px;overflow-wrap:anywhere}article,section{margin:16px 0}article{background:white;padding:16px;border:1px solid #dce7f3;border-radius:14px}summary{cursor:pointer}b{font-size:1.1em}p{white-space:pre-wrap}details{margin:12px 0}</style><main><h1>正在查看备份</h1><p>备份生成于 ${esc(backupTimestamp(backup.generatedAt))}<br>Trip version ${backup.tripVersion}<br>此内容不会自动更新。不能用于判断现在的交通或航班状态。</p>${essentialsBody(backup, true)}<p>地点搜索：Powered by <a href="https://www.geoapify.com/">Geoapify</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a></p><p>Trip ID: ${esc(backup.tripId)}<br>备份 ID: ${esc(backup.id)} · travel-static-backup-v1</p></main></html>`;
  const url = URL.createObjectURL(
    new Blob([html], { type: 'text/html;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `travel-backup-v${backup.tripVersion}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

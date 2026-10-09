import {
  resolveExecutionFrontier,
  type NormalizedRouteCandidate,
} from '@travel/domain';
import { orderedTripNodes } from './schedule-evaluation.js';
import { formatLocalDate, localDateAt } from './route-preview-plan.js';
import type { TripAggregateRecord } from './trip-ports.js';

/** A rejection guard, never evidence that the user boarded a vehicle.
 * Calendar/history classification uses an explicit origin timezone, not the
 * server's timezone. Old days remain planning; an explicitly confirmed open
 * origin can carry execution forward across midnight within the Trip period.
 */
export function hasMissedFixedDeparture(
  trip: TripAggregateRecord,
  fromNodeId: string,
  candidate: NormalizedRouteCandidate,
  now: Date,
): boolean {
  const fixed = candidate.legs.filter((leg) => leg.fixedService);
  if (fixed.length === 0) return false; // Aggregate TRANSIT is not a timetable.
  if (!Number.isFinite(now.getTime())) return true;
  // Query/Adopt also edit plans. Calendar proximity alone is not confirmed
  // execution. Preserve planning-only/history while protecting actual progress.
  const events = (trip.routeExecutionEvents ?? []).filter(
    (event) =>
      event.undoneAt === null &&
      event.occurredAt <= now &&
      (event.source === 'MANUAL' || event.evidenceReliability === 'SUFFICIENT'),
  );
  if (
    events.length === 0 &&
    !trip.externalExecutionFacts?.some((instant) => instant <= now)
  )
    return false;
  const nodes = orderedTripNodes(trip);
  const origin = nodes.find((node) => node.id === fromNodeId);
  if (!origin) return true;
  const zone =
    ['ACTUAL', 'ESTIMATED', 'PLANNED'].flatMap((layer) =>
      origin.timeValues
        .filter(
          (value) =>
            value.layer === layer &&
            // Execution events store their linked ACTUAL instant in UTC. That
            // is serialization provenance, not the origin's local calendar.
            // Keep the event as execution evidence above, but obtain calendar
            // context from explicit node values/intents or candidate clocks.
            !value.sourceRef?.startsWith('execution-event:'),
        )
        .map((value) => value.timeZone),
    )[0] ??
    origin.timeIntents.find((intent) => intent.timeZone)?.timeZone ??
    candidate.departure.timeZone;
  let today: string;
  try {
    today = localDateAt({ instant: now, timeZone: zone });
  } catch {
    return true;
  } // Cannot classify an execution date reliably.
  if (!trip.effectiveStartDate || !trip.effectiveEndDate) return true;
  if (
    today < formatLocalDate(trip.effectiveStartDate) ||
    today > formatLocalDate(trip.effectiveEndDate)
  )
    return false;
  const day = trip.dayOccurrences.find(
    (day) => day.id === origin.dayOccurrenceId,
  );
  if (!day) return true;
  if (formatLocalDate(day.localDate) !== today) {
    // Only committed, non-undone user execution events can carry an open origin
    // across days. Raw GPS, provider vehicle ACTUAL and location cache do not.
    const frontier = resolveExecutionFrontier(
      nodes.map((node, position) => ({
        id: node.id,
        sequence: 0,
        position,
        latitude: null,
        longitude: null,
        targetKind: 'PLACE',
        hasActualArrival: events.some(
          (event) => event.nodeId === node.id && event.type === 'ARRIVAL',
        ),
        hasActualDeparture: events.some(
          (event) => event.nodeId === node.id && event.type === 'DEPARTURE',
        ),
        executionStatus: events.some(
          (event) =>
            event.nodeId === node.id && event.type === 'SKIP_CONFIRMED',
        )
          ? 'SKIPPED'
          : null,
      })),
    );
    if (frontier.state !== 'AT_NODE' || frontier.currentNode?.id !== fromNodeId)
      return false;
  }
  // A stale leading walk cannot be treated as already performed, even if the
  // later bus is in the future. Request a fresh candidate instead of shifting
  // clocks or inventing access duration. No global boarding buffer is added.
  return hasElapsedFixedDeparture(candidate, now);
}

/** External confirmed origins already supply live execution context. */
export function hasElapsedFixedDeparture(
  candidate: NormalizedRouteCandidate,
  now: Date,
): boolean {
  const fixed = candidate.legs.filter((leg) => leg.fixedService);
  return (
    fixed.length > 0 &&
    (!Number.isFinite(now.getTime()) ||
      candidate.departure.instant < now ||
      fixed.some(
        (leg) => leg.departure === null || leg.departure.instant < now,
      ))
  );
}

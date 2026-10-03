/** Endpoint dates for the existing 30-minute Dev/Test synthetic candidate. */
export function syntheticRouteEndpointDates(
  departure,
  timeZone = 'Asia/Tokyo',
) {
  const date = (instant) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const part = (type) => parts.find((entry) => entry.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  return {
    departureDate: date(departure),
    arrivalDate: date(new Date(departure.getTime() + 30 * 60_000)),
  };
}

/** Keep the immediate-replacement acceptance away from a midnight boundary. */
export function syntheticSameDayRouteTimeZone(now) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  return hour >= 2 && hour < 22 ? 'Asia/Tokyo' : 'UTC';
}

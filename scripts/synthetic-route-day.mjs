/** SYNTHETIC acceptance metadata only. Never selects a real Place/user timezone. */
export function fixtureLocalDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type).value)
    .join('-');
}

/** Keep past execution and upcoming 30-minute fixture routes on one explicit day.
 * Tokyo is preferred; UTC is an explicit SYNTHETIC context when Tokyo straddles
 * midnight. The two boundaries are nine hours apart, so this 75-minute window
 * always fits one. No production clock, duration, buffer or guard is changed.
 */
export function syntheticRouteDay(now) {
  const start = new Date(now.getTime() - 15 * 60_000);
  const end = new Date(now.getTime() + 60 * 60_000);
  for (const timeZone of ['Asia/Tokyo', 'UTC']) {
    const localDate = fixtureLocalDate(start, timeZone);
    if (localDate === fixtureLocalDate(end, timeZone))
      return { timeZone, localDate };
  }
  throw new Error('SYNTHETIC route window has no single-day context');
}

/** The external-hub resolver's trusted Tokyo context must remain Tokyo.
 * Bind both initial and replacement routes to one explicit arrival deadline;
 * the one-leg fixture intentionally spans two endpoint occurrences if needed.
 */
export function syntheticExternalWindow(now) {
  const departure = new Date(now.getTime() - 15 * 60_000);
  const arrival = new Date(now.getTime() + 45 * 60_000);
  const timeZone = 'Asia/Tokyo';
  return {
    departure,
    arrival,
    timeZone,
    fromDate: fixtureLocalDate(departure, timeZone),
    toDate: fixtureLocalDate(arrival, timeZone),
  };
}

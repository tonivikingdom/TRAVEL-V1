export function fixtureLocalDate(instant: Date, timeZone: string): string;
export function syntheticRouteDay(now: Date): {
  timeZone: string;
  localDate: string;
};
export function syntheticExternalWindow(now: Date): {
  departure: Date;
  arrival: Date;
  timeZone: string;
  fromDate: string;
  toDate: string;
};

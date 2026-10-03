import type { TemporalValueView } from '@travel/contracts';
import { formatTime } from './model.js';

type ClockValue = Pick<TemporalValueView, 'instant' | 'timeZone'>;
const zoneNames: Readonly<Record<string, string>> = {
  'Asia/Tokyo': '东京',
  'Asia/Shanghai': '上海',
  'Asia/Hong_Kong': '香港',
  'Asia/Taipei': '台北',
  'Europe/London': '伦敦',
  'Europe/Paris': '巴黎',
  'America/New_York': '纽约',
  'America/Los_Angeles': '洛杉矶',
  'Australia/Sydney': '悉尼',
  'Etc/UTC': 'UTC',
  UTC: 'UTC',
};
/** Display only: each date/clock is formatted in its supplied, trusted zone. */
export function transportClockParts(value: ClockValue | null) {
  if (!value) return null;
  const formatted = formatTime(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(formatted)) return null;
  const date = formatted.slice(0, 10);
  return {
    localDate: date,
    clock: formatTime(value, date),
    date: new Intl.DateTimeFormat('zh-CN', {
      timeZone: value.timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(value.instant)),
    zone: `${zoneNames[value.timeZone] ?? value.timeZone.replaceAll('_', ' ')}当地时间`,
    timeZone: value.timeZone,
  };
}
export function transportClockPair(
  departure: ClockValue | null,
  arrival: ClockValue | null,
) {
  const from = transportClockParts(departure);
  const to = transportClockParts(arrival);
  return {
    from,
    to,
    sharedContext:
      from &&
      to &&
      from.localDate === to.localDate &&
      from.timeZone === to.timeZone
        ? `${from.date} · ${from.zone}`
        : null,
    zoneChange: !!from && !!to && from.timeZone !== to.timeZone,
  };
}

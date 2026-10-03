import { describe, it, expect } from 'vitest';
import { editorDays, shiftedDate, arrangementName } from '../src/authoring.js';
import { fixtureTrip } from './fixture.js';
describe('authoring date cards retain occurrence identity', () => {
  it('does not coalesce repeated dates or sort a date-line crossing by calendar date', () => {
    const t = fixtureTrip();
    const days = t.days.map((d, i) => ({
      ...d,
      localDate: '2030-10-01',
      sequence: i,
    }));
    const result = editorDays({ ...t, days }, []);
    expect(result.map((d) => d.key)).toEqual(
      days.map((d) => d.dayOccurrenceId),
    );
    expect(result).toHaveLength(2);
    const reverse = editorDays(
      {
        ...t,
        days: days.map((d, i) => ({
          ...d,
          localDate: i === 0 ? '2030-10-02' : '2030-10-01',
        })),
      },
      [],
    );
    expect(reverse.map((d) => d.localDate)).toEqual([
      '2030-10-02',
      '2030-10-01',
    ]);
  });
  it('keeps UI-only edge dates separate from real days and empty Trip anchor', () => {
    const t = fixtureTrip();
    const days = editorDays(t, [
      { key: 'temp-before', localDate: '2030-09-30', side: 'before' },
      { key: 'temp-after', localDate: '2030-10-03', side: 'after' },
    ]);
    expect(days[0]!.target).toEqual({
      type: 'NEW',
      localDate: '2030-09-30',
      sequence: 0,
    });
    expect(days.at(-1)!.target).toEqual({
      type: 'NEW',
      localDate: '2030-10-03',
      sequence: 2,
    });
    expect(t.days).toHaveLength(2);
    expect(editorDays({ ...t, days: [] }, [])[0]!.target).toEqual({
      type: 'NEW',
      localDate: t.planningAnchorDate,
      sequence: 0,
    });
  });
  it('uses real activity title without inventing a location or time', () => {
    const n = fixtureTrip().days[0]!.nodes[0]!;
    expect(
      arrangementName({
        ...n,
        place: null,
        kind: 'FREE_ACTION',
        note: 'SYNTHETIC 散步\n可选备注',
      }),
    ).toBe('SYNTHETIC 散步');
    expect(shiftedDate('2032-02-28', 1)).toBe('2032-02-29');
  });
});

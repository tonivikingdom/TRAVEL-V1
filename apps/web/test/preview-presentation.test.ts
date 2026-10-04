import { describe, expect, it } from 'vitest';
import {
  previewMarkup,
  previewPresentation,
} from '../src/preview-presentation.js';
import { previewFixture, previewCases } from './preview-fixture.js';
import { fromId, dayId } from './fixture.js';
describe('Preview presentation (SYNTHETIC, existing contracts only)', () => {
  it.each(previewCases)(
    '%s is pure, escaped, and contains no source identifiers',
    (kind) => {
      const f = previewFixture(kind),
        before = JSON.stringify(f);
      const html = previewMarkup(previewPresentation(f.preview, f.trip));
      expect(JSON.stringify(f)).toBe(before);
      for (const id of [
        'private-preview-id',
        'private-hash',
        'secret-origin-id',
        'secret-hub-ref',
        'secret-source-route',
        'private-provider-ref',
        f.preview.tripId,
      ])
        expect(html).not.toContain(id);
      expect(html).toContain('尚未改变你的行程');
    },
  );
  it('full names its actual corridor endpoints', () => {
    const f = previewFixture();
    expect(previewPresentation(f.preview, f.trip).scope).toBe(
      '将重新规划这一段路线',
    );
    expect(previewPresentation(f.preview, f.trip).endpoints).toContain(
      '上野公园',
    );
  });
  it('suffix prominently preserves the prefix', () => {
    const f = previewFixture('suffix'),
      v = previewPresentation(f.preview, f.trip);
    expect(v.scope).toContain('之后调整');
    expect(v.preserved).toContain('前面的已确认部分保持不变。');
  });
  it('external uses confirmed materialized location, never a guessed position', () => {
    const f = previewFixture('external'),
      v = previewPresentation(f.preview, f.trip);
    expect(v.endpoints).toContain('你确认的品川站');
    expect(v.scope).toContain('确认');
  });
  it('protected reasons distinguish locked requirements and vehicle facts', () => {
    const f = previewFixture('protected'),
      v = previewPresentation(f.preview, f.trip);
    expect(v.blockers.join(' ')).toContain('锁定的时间要求');
    expect(v.blockers.join(' ')).toContain('不代表你本人已经出发或到达');
    expect(v.blockers.join(' ')).toContain('后续安排的时间冲突');
  });
  it('technical removals are summarized, manual removals conspicuous', () => {
    const f = previewFixture('removed');
    expect(previewPresentation(f.preview, f.trip).changes.join(' ')).toContain(
      '旧方案自动生成的换乘点',
    );
    const preview = {
      ...f.preview,
      changeSummary: {
        ...f.preview.changeSummary,
        nodesToRemove: [
          {
            nodeId: fromId,
            dayOccurrenceId: dayId,
            protected: true,
            protectionReasons: ['USER_MODIFIED'],
          },
        ],
      },
    };
    const v = previewPresentation(preview, f.trip);
    expect(v.important.join(' ')).toContain('你添加的安排');
    expect(v.preserved.join(' ')).not.toContain('不会被删除');
  });
  it('unknown labels and absent reason remain unknown', () => {
    const f = previewFixture('unknown'),
      v = previewPresentation(f.preview);
    expect(v.blockers.join(' ')).toContain('未提供可确认的具体原因');
    expect(v.segments[0]!.endpoints).toContain('待定');
    expect(v.times.join(' ')).toContain('未提供');
  });
  it('stale and foreign Trip labels cannot embellish Preview', () => {
    const f = previewFixture('long');
    const stale = previewPresentation(f.preview, { ...f.trip, version: 2 });
    const foreign = previewPresentation(f.preview, {
      ...f.trip,
      id: 'another-owner-trip',
    });
    expect(stale.endpoints).not.toContain('八重洲');
    expect(foreign).toEqual(stale);
  });
  it('minimal change does not invent a no-op', () => {
    const f = previewFixture('minimal'),
      v = previewPresentation(f.preview, f.trip);
    expect(v.changes).toEqual(['新增这一段交通。']);
    expect(v.replacements).toEqual([]);
    expect(v.preserved).toContain('不会删除地点。');
  });
  it('expiration is read from status rather than browser time', () => {
    const f = previewFixture('expired');
    expect(previewPresentation(f.preview).blockers).toEqual([
      '这个方案已过期，请重新查询。',
    ]);
  });
  it('consent reflects authoritative adjustment only; no feasibility recomputation', () => {
    const f = previewFixture();
    const preview = {
      ...f.preview,
      changeSummary: {
        ...f.preview.changeSummary,
        requiredUserAdjustments: [
          {
            intentId: 'private-intent',
            nodeId: fromId,
            fromDurationSeconds: 3600,
            toDurationSeconds: 1800,
          },
        ],
        downstreamImpact: {
          ...f.preview.changeSummary.downstreamImpact!,
          projectedDwellSeconds: 1800,
          status: 'USER_REQUIREMENT_VIOLATION' as const,
        },
      },
    };
    const html = previewMarkup(previewPresentation(preview, f.trip));
    expect(html).toContain('id="accept-adjustments"');
    expect(html).toContain('1 小时 → 30 分钟');
    expect(html).toContain('需要明确确认调整');
    expect(html).not.toContain('private-intent');
  });
  it('labels cannot inject markup', () => {
    const f = previewFixture();
    const trip = {
      ...f.trip,
      days: [
        {
          ...f.trip.days[0]!,
          nodes: [
            {
              ...f.trip.days[0]!.nodes[0]!,
              place: {
                ...f.trip.days[0]!.nodes[0]!.place!,
                name: '<img src=x onerror=alert(1)>',
              },
            },
          ],
        },
      ],
    };
    const html = previewMarkup(previewPresentation(f.preview, trip));
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});
it('internal walking retains explicit leg order, not station-name matching', () => {
  const f = previewFixture();
  const first = f.preview.changeSummary.proposedSegments[0]!;
  const preview = {
    ...f.preview,
    changeSummary: {
      ...f.preview.changeSummary,
      proposedSegments: [
        { ...first, legIndex: 0 },
        { ...first, legIndex: 2, serviceLabel: 'second service' },
      ],
      internalTransferDetails: [
        {
          legIndex: 1,
          mode: 'WALKING' as const,
          from: {
            name: 'same',
            latitude: null,
            longitude: null,
            providerPlaceRef: null,
          },
          to: {
            name: 'same',
            latitude: null,
            longitude: null,
            providerPlaceRef: null,
          },
          durationSeconds: 180,
          evidence: 'SYSTEM_STRUCTURED' as const,
        },
      ],
    },
  };
  expect(previewPresentation(preview).segments.map((s) => s.service)).toEqual([
    '新・山手線 · SYNTHETIC',
    '站内步行换乘',
    'second service',
  ]);
});
it('missing optional deletion evidence cannot claim no deletion', () => {
  const f = previewFixture();
  const { nodesToRemove, ...summary } = f.preview.changeSummary;
  void nodesToRemove;
  const v = previewPresentation({ ...f.preview, changeSummary: summary });
  expect(v.preserved.join(' ')).toContain('地点移除信息未提供');
  expect(v.preserved.join(' ')).not.toContain('不会删除地点');
});

it('legacy missing leg indexes uses original candidate order, never appends walking after the route', () => {
  const f = previewFixture();
  const leg = f.preview.candidate.legs[0]!;
  const { legIndex, ...segment } = f.preview.changeSummary.proposedSegments[0]!;
  void legIndex;
  const preview = {
    ...f.preview,
    candidate: {
      ...f.preview.candidate,
      legs: [
        { ...leg, serviceLabel: 'first service' },
        { ...leg, mode: 'WALKING' as const, serviceLabel: null },
        { ...leg, serviceLabel: 'second service' },
      ],
    },
    changeSummary: {
      ...f.preview.changeSummary,
      proposedSegments: [segment, segment],
      internalTransferDetails: [
        {
          legIndex: 1,
          mode: 'WALKING' as const,
          from: leg.from,
          to: leg.to,
          durationSeconds: 180,
          evidence: 'SYSTEM_STRUCTURED' as const,
        },
      ],
    },
  };
  const view = previewPresentation(preview);
  expect(view.segments.map((s) => s.service)).toEqual([
    'first service',
    '步行',
    'second service',
  ]);
  expect(view.important.join(' ')).toContain('候选原始顺序');
});

import { describe, expect, it } from 'vitest';

import { readRoutePlanningConfig } from '../src/route-planning-config.js';

describe('route planning snapshot/preview TTL configuration', () => {
  it('uses explicit SYNTHETIC defaults only in Development/Test', () => {
    expect(readRoutePlanningConfig({ APP_ENV: 'development' })).toEqual({
      candidateSnapshotTtlSeconds: 900,
      previewTtlSeconds: 600,
      undoWindowSeconds: 600,
    });
    expect(readRoutePlanningConfig({ APP_ENV: 'test' })).toEqual({
      candidateSnapshotTtlSeconds: 900,
      previewTtlSeconds: 600,
      undoWindowSeconds: 600,
    });
  });

  it.each(['staging', 'production'])(
    'requires explicit TTL values in %s',
    (environment) => {
      expect(() => readRoutePlanningConfig({ APP_ENV: environment })).toThrow(
        'ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS',
      );
    },
  );

  it('accepts bounded explicit staging values', () => {
    expect(
      readRoutePlanningConfig({
        APP_ENV: 'staging',
        ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS: '300',
        ROUTE_PREVIEW_TTL_SECONDS: '120',
        ROUTE_UNDO_WINDOW_SECONDS: '600',
      }),
    ).toEqual({
      candidateSnapshotTtlSeconds: 300,
      previewTtlSeconds: 120,
      undoWindowSeconds: 600,
    });
  });

  it('requires an explicit Undo window outside Development/Test', () => {
    expect(() =>
      readRoutePlanningConfig({
        APP_ENV: 'production',
        ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS: '900',
        ROUTE_PREVIEW_TTL_SECONDS: '600',
      }),
    ).toThrow('ROUTE_UNDO_WINDOW_SECONDS');
  });

  it.each(['0', '-1', '1.5', '604801'])('rejects invalid TTL %s', (value) => {
    expect(() =>
      readRoutePlanningConfig({
        APP_ENV: 'development',
        ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS: value,
      }),
    ).toThrow('ROUTE_CANDIDATE_SNAPSHOT_TTL_SECONDS');
  });
});

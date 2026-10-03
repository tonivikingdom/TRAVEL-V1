import { describe, expect, it } from 'vitest';
import { pageUrlType } from '../scripts/live-browser-observer.js';

describe('SYNTHETIC live diagnostic URL redaction', () => {
  it.each([
    [
      'https://www.google.com/maps/dir/SYNTHETIC_PRIVATE_STATE?pb=SYNTHETIC_SECRET',
      'GOOGLE_MAPS_DIRECTIONS',
    ],
    [
      'https://www.google.com/sorry/index?continue=SYNTHETIC_PRIVATE',
      'GOOGLE_VERIFICATION',
    ],
    [
      'https://accounts.google.com/SYNTHETIC_PRIVATE?token=SYNTHETIC_SECRET',
      'GOOGLE_ACCOUNT',
    ],
    ['https://consent.google.com/SYNTHETIC_PRIVATE', 'GOOGLE_CONSENT'],
    ['about:blank', 'ABOUT_BLANK'],
    ['https://synthetic.example.test/SYNTHETIC_PRIVATE', 'OTHER'],
  ])('returns only a category for %s', (url, category) => {
    expect(pageUrlType(url)).toBe(category);
    expect(pageUrlType(url)).not.toContain('SYNTHETIC');
  });
});

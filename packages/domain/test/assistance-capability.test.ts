import { describe, expect, it } from 'vitest';

import { decideAssistanceTransition } from '../src/assistance-capability.js';

describe('assistance capability lifecycle', () => {
  it('requires explicit lifecycle actions and never resumes paused or stopped state implicitly', () => {
    expect(decideAssistanceTransition('NOT_ENABLED', 'ENABLE')).toEqual({
      status: 'APPLY',
      state: 'ENABLED',
      stopReason: null,
    });
    expect(decideAssistanceTransition('PAUSED', 'ENABLE')).toEqual({
      status: 'CONFLICT',
    });
    expect(decideAssistanceTransition('PAUSED', 'RESUME')).toEqual({
      status: 'APPLY',
      state: 'ENABLED',
      stopReason: null,
    });
    expect(decideAssistanceTransition('STOPPED', 'RESUME')).toEqual({
      status: 'CONFLICT',
    });
    expect(decideAssistanceTransition('STOPPED', 'ENABLE')).toEqual({
      status: 'APPLY',
      state: 'ENABLED',
      stopReason: null,
    });
  });

  it('keeps same-state requests idempotent without a transition', () => {
    expect(decideAssistanceTransition('ENABLED', 'ENABLE')).toEqual({
      status: 'NO_CHANGE',
    });
    expect(decideAssistanceTransition('PAUSED', 'PAUSE')).toEqual({
      status: 'NO_CHANGE',
    });
    expect(decideAssistanceTransition('STOPPED', 'STOP')).toEqual({
      status: 'NO_CHANGE',
    });
  });

  it('distinguishes user stop from natural end', () => {
    expect(decideAssistanceTransition('ENABLED', 'STOP')).toEqual({
      status: 'APPLY',
      state: 'STOPPED',
      stopReason: 'USER',
    });
    expect(decideAssistanceTransition('PAUSED', 'NATURAL_END')).toEqual({
      status: 'APPLY',
      state: 'STOPPED',
      stopReason: 'NATURAL_END',
    });
    expect(decideAssistanceTransition('NOT_ENABLED', 'NATURAL_END')).toEqual({
      status: 'NO_CHANGE',
    });
  });
});

export type PersistedAssistanceState = 'ENABLED' | 'PAUSED' | 'STOPPED';
export type AssistanceTransitionAction =
  'ENABLE' | 'PAUSE' | 'RESUME' | 'STOP' | 'NATURAL_END';

export type AssistanceTransitionDecision =
  | {
      readonly status: 'APPLY';
      readonly state: PersistedAssistanceState;
      readonly stopReason: 'USER' | 'NATURAL_END' | null;
    }
  | { readonly status: 'NO_CHANGE' }
  | { readonly status: 'CONFLICT' };

export function decideAssistanceTransition(
  state: PersistedAssistanceState | 'NOT_ENABLED',
  action: AssistanceTransitionAction,
): AssistanceTransitionDecision {
  if (action === 'NATURAL_END') {
    return state === 'ENABLED' || state === 'PAUSED'
      ? { status: 'APPLY', state: 'STOPPED', stopReason: 'NATURAL_END' }
      : { status: 'NO_CHANGE' };
  }
  if (action === 'STOP') {
    return state === 'STOPPED'
      ? { status: 'NO_CHANGE' }
      : { status: 'APPLY', state: 'STOPPED', stopReason: 'USER' };
  }
  if (action === 'ENABLE') {
    if (state === 'ENABLED') return { status: 'NO_CHANGE' };
    if (state === 'PAUSED') return { status: 'CONFLICT' };
    return { status: 'APPLY', state: 'ENABLED', stopReason: null };
  }
  if (action === 'PAUSE') {
    if (state === 'PAUSED') return { status: 'NO_CHANGE' };
    return state === 'ENABLED'
      ? { status: 'APPLY', state: 'PAUSED', stopReason: null }
      : { status: 'CONFLICT' };
  }
  if (state === 'ENABLED') return { status: 'NO_CHANGE' };
  return state === 'PAUSED'
    ? { status: 'APPLY', state: 'ENABLED', stopReason: null }
    : { status: 'CONFLICT' };
}

import { describe, expect, it } from 'vitest';
import { createTeamState, reduceTeam } from '../../../packages/dsh-team/src';

describe('team state machine', () => {
  it('runs two members concurrently under one deterministic run', () => {
    let state = createTeamState({ id: 'team', leadMemberId: 'lead', memberIds: ['lead', 'worker'] });
    state = reduceTeam(state, { type: 'runStarted', runId: 'run-1' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'lead' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'worker' });

    expect(state.runStatus).toBe('running');
    expect(state.activeMemberIds).toEqual(['lead', 'worker']);
    expect(Object.values(state.members).map((member) => member.status)).toEqual(['busy', 'busy']);
  });

  it('rejects an event for an unknown member', () => {
    const state = createTeamState({ id: 'team', leadMemberId: 'lead', memberIds: ['lead'] });

    expect(() => reduceTeam(state, { type: 'memberFailed', memberId: 'missing', reason: 'boom' })).toThrow(
      'Unknown team member'
    );
  });
});

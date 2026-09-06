import { describe, expect, it } from 'vitest';
import { createTeamState, reduceTeam, type TeamTask } from '../../../packages/dsh-team/src';

const tasks: TeamTask[] = [
  { id: 'task-a', status: 'pending', blockedBy: [] },
  { id: 'task-b', status: 'pending', blockedBy: [] },
];

describe('team failure and recovery prototype', () => {
  it('isolates one failed member and returns its task to the queue', () => {
    let state = createTeamState({ id: 'team', leadMemberId: 'lead', memberIds: ['lead', 'worker'], tasks });
    state = reduceTeam(state, { type: 'runStarted', runId: 'run-1' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'lead', taskId: 'task-a' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'worker', taskId: 'task-b' });
    state = reduceTeam(state, { type: 'memberFailed', memberId: 'worker', reason: 'process exited' });

    expect(state.runStatus).toBe('running');
    expect(state.members.worker.status).toBe('failed');
    expect(state.tasks['task-b']).toMatchObject({ status: 'pending', ownerId: undefined });
  });

  it('recovers the failed member and completes after both turns settle', () => {
    let state = createTeamState({ id: 'team', leadMemberId: 'lead', memberIds: ['lead', 'worker'] });
    state = reduceTeam(state, { type: 'runStarted', runId: 'run-1' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'lead' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'worker' });
    state = reduceTeam(state, { type: 'memberFailed', memberId: 'worker', reason: 'process exited' });
    state = reduceTeam(state, { type: 'memberRecoveryStarted', memberId: 'worker' });
    state = reduceTeam(state, { type: 'memberRecovered', memberId: 'worker' });
    state = reduceTeam(state, { type: 'memberCompleted', memberId: 'lead' });
    state = reduceTeam(state, { type: 'runCompleted' });

    expect(state.runStatus).toBe('completed');
    expect(state.members.worker).toEqual({ id: 'worker', status: 'ready' });
  });

  it('refuses to complete while a member is still active', () => {
    let state = createTeamState({ id: 'team', leadMemberId: 'lead', memberIds: ['lead'] });
    state = reduceTeam(state, { type: 'runStarted', runId: 'run-1' });
    state = reduceTeam(state, { type: 'memberStarted', memberId: 'lead' });

    expect(() => reduceTeam(state, { type: 'runCompleted' })).toThrow('every member turn settles');
  });
});

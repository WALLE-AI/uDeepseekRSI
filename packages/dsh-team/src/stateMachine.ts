import type { TeamEvent, TeamMember, TeamState, TeamTask } from './types';

function member(state: TeamState, memberId: string): TeamMember {
  const value = state.members[memberId];
  if (!value) throw new Error(`Unknown team member: ${memberId}`);
  return value;
}

function task(state: TeamState, taskId: string): TeamTask {
  const value = state.tasks[taskId];
  if (!value) throw new Error(`Unknown team task: ${taskId}`);
  return value;
}

function replaceMember(state: TeamState, value: TeamMember): TeamState {
  return { ...state, members: { ...state.members, [value.id]: value } };
}

function replaceTask(state: TeamState, value: TeamTask): TeamState {
  return { ...state, tasks: { ...state.tasks, [value.id]: value } };
}

function without(values: string[], value: string): string[] {
  return values.filter((candidate) => candidate !== value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported team event: ${JSON.stringify(value)}`);
}

export function createTeamState(input: {
  id: string;
  leadMemberId: string;
  memberIds: string[];
  tasks?: TeamTask[];
}): TeamState {
  if (!input.memberIds.includes(input.leadMemberId)) throw new Error('The lead must be a team member.');
  if (new Set(input.memberIds).size !== input.memberIds.length) throw new Error('Team member ids must be unique.');
  const members = Object.fromEntries(input.memberIds.map((id) => [id, { id, status: 'ready' as const }]));
  const tasks = Object.fromEntries((input.tasks ?? []).map((value) => [value.id, value]));
  return {
    id: input.id,
    leadMemberId: input.leadMemberId,
    runStatus: 'idle',
    members,
    tasks,
    activeMemberIds: [],
  };
}

export function reduceTeam(state: TeamState, event: TeamEvent): TeamState {
  switch (event.type) {
    case 'runStarted': {
      if (!['idle', 'completed', 'failed'].includes(state.runStatus)) {
        throw new Error(`Cannot start a run from ${state.runStatus}.`);
      }
      return { ...state, runId: event.runId, runStatus: 'running', activeMemberIds: [] };
    }
    case 'memberStarted': {
      if (state.runStatus !== 'running') throw new Error('A member can start only while the run is running.');
      const current = member(state, event.memberId);
      if (current.status !== 'ready') throw new Error(`Member ${event.memberId} cannot start from ${current.status}.`);
      let next = replaceMember(state, { id: current.id, status: 'busy' });
      next = { ...next, activeMemberIds: [...new Set([...next.activeMemberIds, event.memberId])] };
      if (!event.taskId) return next;
      const assigned = task(next, event.taskId);
      if (assigned.status !== 'pending') throw new Error(`Task ${event.taskId} cannot start from ${assigned.status}.`);
      return replaceTask(next, { ...assigned, status: 'running', ownerId: event.memberId });
    }
    case 'memberCompleted': {
      const current = member(state, event.memberId);
      if (current.status !== 'busy') throw new Error(`Member ${event.memberId} is not busy.`);
      let next = replaceMember(state, { id: current.id, status: 'ready' });
      next = { ...next, activeMemberIds: without(next.activeMemberIds, event.memberId) };
      if (!event.taskId) return next;
      const completed = task(next, event.taskId);
      return replaceTask(next, { ...completed, status: 'completed' });
    }
    case 'memberFailed': {
      const failed = member(state, event.memberId);
      let next = replaceMember(state, { id: failed.id, status: 'failed', failure: event.reason });
      next = { ...next, activeMemberIds: without(next.activeMemberIds, event.memberId) };
      for (const value of Object.values(next.tasks)) {
        if (value.ownerId === event.memberId && value.status === 'running') {
          next = replaceTask(next, { ...value, status: 'pending', ownerId: undefined });
        }
      }
      const viableMembers = Object.values(next.members).some((value) => ['ready', 'busy'].includes(value.status));
      return viableMembers ? next : { ...next, runStatus: 'failed' };
    }
    case 'memberRecoveryStarted': {
      const failed = member(state, event.memberId);
      if (failed.status !== 'failed') throw new Error(`Member ${event.memberId} is not failed.`);
      return replaceMember(state, { ...failed, status: 'recovering' });
    }
    case 'memberRecovered': {
      const recovering = member(state, event.memberId);
      if (recovering.status !== 'recovering') throw new Error(`Member ${event.memberId} is not recovering.`);
      return replaceMember(state, { id: recovering.id, status: 'ready' });
    }
    case 'runPaused': {
      if (state.runStatus !== 'running' || state.activeMemberIds.length > 0) {
        throw new Error('A run can pause only at a quiescent running boundary.');
      }
      return { ...state, runStatus: 'paused' };
    }
    case 'runResumed': {
      if (state.runStatus !== 'paused') throw new Error('Only a paused run can resume.');
      return { ...state, runStatus: 'running' };
    }
    case 'runCancelRequested': {
      if (!['running', 'paused'].includes(state.runStatus)) throw new Error('Only an active run can be cancelled.');
      return { ...state, runStatus: 'cancelling' };
    }
    case 'runCancelled': {
      if (state.runStatus !== 'cancelling' || state.activeMemberIds.length > 0) {
        throw new Error('Cancellation settles only after every active member stops.');
      }
      return { ...state, runStatus: 'completed', activeMemberIds: [] };
    }
    case 'runCompleted': {
      if (state.runStatus !== 'running' || state.activeMemberIds.length > 0) {
        throw new Error('A run completes only after every member turn settles.');
      }
      return { ...state, runStatus: 'completed' };
    }
    default:
      return assertNever(event);
  }
}

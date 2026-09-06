export type TeamRunStatus = 'idle' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed';

export type TeamMemberStatus = 'detached' | 'attaching' | 'ready' | 'busy' | 'paused' | 'failed' | 'recovering';

export type TeamTaskStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'cancelled';

export type TeamMember = {
  id: string;
  status: TeamMemberStatus;
  failure?: string;
};

export type TeamTask = {
  id: string;
  status: TeamTaskStatus;
  ownerId?: string;
  blockedBy: string[];
};

export type TeamState = {
  id: string;
  leadMemberId: string;
  runId?: string;
  runStatus: TeamRunStatus;
  members: Record<string, TeamMember>;
  tasks: Record<string, TeamTask>;
  activeMemberIds: string[];
};

export type TeamEvent =
  | { type: 'runStarted'; runId: string }
  | { type: 'memberStarted'; memberId: string; taskId?: string }
  | { type: 'memberCompleted'; memberId: string; taskId?: string }
  | { type: 'memberFailed'; memberId: string; reason: string }
  | { type: 'memberRecoveryStarted'; memberId: string }
  | { type: 'memberRecovered'; memberId: string }
  | { type: 'runPaused' }
  | { type: 'runResumed' }
  | { type: 'runCancelRequested' }
  | { type: 'runCancelled' }
  | { type: 'runCompleted' };

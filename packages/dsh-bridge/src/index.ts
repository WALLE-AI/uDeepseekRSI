export { DshBridge } from './DshBridge';
export {
  assistantIdForWorkMode,
  DSH_CODING_ASSISTANT_ID,
  DSH_OFFICE_ASSISTANT_ID,
  DSH_RESEARCH_ASSISTANT_ID,
  DSH_WORK_MODES,
  DshRuntimePool,
  LEGACY_DSH_ASSISTANT_ID,
  modeRuntimeKey,
  normalizeDshWorkMode,
  personaForDshWorkMode,
  runtimeKeyId,
  workModeFromAssistantId,
} from './DshRuntimePool';
export type { DshRuntimeKey, DshWorkMode } from './DshRuntimePool';
export {
  EXPERT_DELEGATION_TOOL_PREFIX,
  EXPERT_PATCH_FILE,
  allowedDshTools,
  delegationToolName,
  disabledToolRows,
  expertPatchYaml,
  expertRuntimeHome,
  expertRuntimeProfile,
  expertSandboxMode,
  isDelegationToolName,
  memberIdFromDelegationTool,
  shellToolId,
} from './experts/runtime';
export type { ExpertRuntimeProfile } from './experts/runtime';
export { createDshConnection } from './createDshConnection';
export { DshApiServer } from './DshApiServer';
export type { DshApiServerOptions, ProviderCredentialStore } from './DshApiServer';
export { OfficePreviewError, OfficePreviewService } from './officePreviewService';
export type {
  OfficeDocumentType,
  OfficePreviewPort,
  OfficePreviewServiceOptions,
  OfficePreviewStatus,
} from './officePreviewService';
export type { DesktopShellPort, DshMcpServer } from './types';
export { mapStopReason, mapUpdateKind, parseToolCallEnvelope } from './updateMapper';
export type {
  BridgePermissionDecision,
  BridgePermissionRequest,
  BridgeStopReason,
  BridgeUpdate,
  BridgeUpdateKind,
  DshAgentPort,
  DshBridgeOptions,
  DshSession,
  DshSessionConfigOption,
  ToolCallEnvelope,
} from './types';

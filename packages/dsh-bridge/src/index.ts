export { DshBridge } from './DshBridge';
export {
  assistantIdForWorkMode,
  DSH_CODING_ASSISTANT_ID,
  DSH_OFFICE_ASSISTANT_ID,
  DSH_RESEARCH_ASSISTANT_ID,
  DSH_WORK_MODES,
  DshRuntimePool,
  LEGACY_DSH_ASSISTANT_ID,
  normalizeDshWorkMode,
  personaForDshWorkMode,
  workModeFromAssistantId,
} from './DshRuntimePool';
export type { DshWorkMode } from './DshRuntimePool';
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
export { mapStopReason, mapUpdateKind } from './updateMapper';
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
} from './types';

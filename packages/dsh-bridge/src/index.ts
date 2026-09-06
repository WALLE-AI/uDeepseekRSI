export { DshBridge } from './DshBridge';
export { createDshConnection } from './createDshConnection';
export { DshApiServer } from './DshApiServer';
export type { DshApiServerOptions } from './DshApiServer';
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

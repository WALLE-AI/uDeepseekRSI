export type BridgeStopReason = 'completed' | 'cancelled' | 'max-tokens' | 'refusal' | 'failed';

export type BridgeUpdateKind =
  | 'assistant-text'
  | 'reasoning'
  | 'tool-start'
  | 'tool-update'
  | 'usage'
  | 'plan'
  | 'unknown';

/** The subset of an ACP tool-call frame the bridge reasons about. */
export type ToolCallEnvelope = {
  toolCallId: string;
  /** Only present on `tool_call`; `tool_call_update` identifies the call by id alone. */
  toolName?: string;
  /** `pending` | `in_progress` | `completed` | `failed` as reported by dsh. */
  status?: string;
};

export type BridgeUpdate = {
  conversationId: string;
  sessionId: string;
  sequence: number;
  kind: BridgeUpdateKind;
  payload: unknown;
};

export type BridgePermissionRequest = {
  conversationId?: string;
  sessionId: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name?: string }>;
};

export type BridgePermissionDecision = { optionId: string } | { cancelled: true };

export type DshSessionConfigOption = {
  id: string;
  currentValue?: string;
  [key: string]: unknown;
};

export type DshMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }
  | {
      name: string;
      type: 'http';
      url: string;
      headers: Array<{ name: string; value: string }>;
    };

export type DesktopShellPort = {
  checkToolInstalled(tool: string): Promise<boolean>;
  openFolderWith(folderPath: string, tool: 'vscode' | 'terminal' | 'explorer'): Promise<void>;
  openFile(filePath: string): Promise<void>;
  showItemInFolder(filePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): void;
};

export type DshSession = {
  conversationId: string;
  sessionId: string;
  cwd: string;
  configOptions: DshSessionConfigOption[];
  activeTurnId?: string;
};

export type DshAgentPort = {
  initialize(): Promise<{ protocolVersion: number; capabilities: unknown }>;
  newSession(
    cwd: string,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<{ sessionId: string; configOptions?: DshSessionConfigOption[] }>;
  resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<{ configOptions?: DshSessionConfigOption[] }>;
  closeSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<DshSessionConfigOption[]>;
  bindSession(sessionId: string, conversationId: string): void;
  dispose(): Promise<void>;
};

export type DshBridgeOptions = {
  port: DshAgentPort;
};

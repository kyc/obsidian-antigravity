export interface AntigravityPluginSettings {
  cliPath: string;
  model: string;
  hubPort: number;
  autoStartHub: boolean;
  hubProfile: string;
  defaultAgent: string;
  enableVaultRules: boolean;
  customRulesPath: string;
  allowUnrestrictedTasks: boolean;
  unrestrictedConfirmed: boolean;
  /**
   * Tracked separately from `unrestrictedConfirmed`: the hub is an interactive
   * multi-turn session, so approving it is a larger commitment than approving a
   * single headless task. Confirming one must not silently authorise the other.
   */
  hubUnrestrictedConfirmed: boolean;
  language: 'auto' | 'en' | 'zh-cn' | 'zh-tw';
}

export const DEFAULT_SETTINGS: AntigravityPluginSettings = {
  cliPath: '',
  model: 'gemini-3.8-flash-high',
  hubPort: 0,
  autoStartHub: false,
  hubProfile: 'antigravity-obsidian',
  defaultAgent: 'omarchy-vault',
  enableVaultRules: true,
  customRulesPath: 'AGENTS.md',
  allowUnrestrictedTasks: false,
  unrestrictedConfirmed: false,
  hubUnrestrictedConfirmed: false,
  language: 'auto',
};

export function validateSettings(raw: unknown): AntigravityPluginSettings {
  const result: AntigravityPluginSettings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') {
    return result;
  }

  const data = raw as Record<string, unknown>;

  if (typeof data.cliPath === 'string') {
    result.cliPath = data.cliPath.trim();
  }

  if (typeof data.model === 'string' && data.model.trim().length > 0) {
    result.model = data.model.trim();
  }

  if (
    typeof data.hubPort === 'number' &&
    Number.isInteger(data.hubPort) &&
    data.hubPort >= 0 &&
    data.hubPort <= 65535
  ) {
    result.hubPort = data.hubPort;
  }

  if (typeof data.autoStartHub === 'boolean') {
    result.autoStartHub = data.autoStartHub;
  }

  if (typeof data.hubProfile === 'string' && /^[a-zA-Z0-9_-]+$/.test(data.hubProfile.trim())) {
    result.hubProfile = data.hubProfile.trim();
  }

  if (typeof data.defaultAgent === 'string') {
    result.defaultAgent = data.defaultAgent.trim();
  }

  if (typeof data.enableVaultRules === 'boolean') {
    result.enableVaultRules = data.enableVaultRules;
  }

  if (typeof data.customRulesPath === 'string') {
    result.customRulesPath = data.customRulesPath.trim();
  }

  if (typeof data.allowUnrestrictedTasks === 'boolean') {
    result.allowUnrestrictedTasks = data.allowUnrestrictedTasks;
  }

  if (typeof data.unrestrictedConfirmed === 'boolean') {
    result.unrestrictedConfirmed = data.unrestrictedConfirmed;
  }

  if (typeof data.hubUnrestrictedConfirmed === 'boolean') {
    result.hubUnrestrictedConfirmed = data.hubUnrestrictedConfirmed;
  }

  if (
    typeof data.language === 'string' &&
    ['auto', 'en', 'zh-cn', 'zh-tw'].includes(data.language.toLowerCase())
  ) {
    result.language = data.language.toLowerCase() as AntigravityPluginSettings['language'];
  }

  return result;
}

export type TaskScope = 'active-note' | 'selection' | 'folder' | 'vault';

export interface TaskContext {
  scope: TaskScope;
  filePath?: string;
  folderPath?: string;
  selectionText?: string;
}

export interface TaskExecutionOptions {
  prompt: string;
  context: TaskContext;
  model?: string;
}

export type ProcessState = 'idle' | 'running' | 'error';

export interface StreamStepUpdate {
  step_type?: string;
  text_delta?: string;
  step_index?: number | string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
  };
  state?: string;
  status?: string;
}

export interface StreamResult {
  status?: string;
  error?: string;
  message?: string;
  response?: string;
  denied_actions?: Array<{ action?: string; display_name?: string }>;
}

export interface StreamEvent {
  event?: string;
  step_update?: StreamStepUpdate;
  result?: StreamResult;
}


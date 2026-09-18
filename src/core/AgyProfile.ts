import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ensureDir(dirPath: string, mode: number = 0o700): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
}

function writeSecureFile(filePath: string, content: string, mode: number = 0o600): void {
  ensureDir(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (fs.existsSync(filePath)) {
      const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof raw === 'object' && raw !== null) {
        return raw as T;
      }
    }
  } catch {
    // Non-critical
  }
  return null;
}

export function sanitizeProfile(profile: string): string {
  if (!profile || typeof profile !== 'string') {
    return 'antigravity-obsidian';
  }
  const clean = profile.replace(/[^a-zA-Z0-9_-]/g, '');
  return clean || 'antigravity-obsidian';
}

export function ensureProfileAuth(profile: string, homeDir: string = os.homedir()): boolean {
  const safeProfile = sanitizeProfile(profile);
  if (!safeProfile || safeProfile === 'antigravity-cli') {
    return false;
  }

  const targetDir = path.join(homeDir, '.gemini', safeProfile);
  const targetToken = path.join(targetDir, 'antigravity-oauth-token');

  if (fs.existsSync(targetToken)) {
    return true;
  }

  const candidateSources = [
    path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(homeDir, '.gemini', 'antigravity', 'antigravity-oauth-token'),
    path.join(homeDir, '.gemini', 'antigravity-ide', 'antigravity-oauth-token'),
  ];

  for (const src of candidateSources) {
    if (fs.existsSync(src)) {
      try {
        ensureDir(targetDir);
        fs.copyFileSync(src, targetToken);
        fs.chmodSync(targetToken, 0o600);
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

export function ensureProfileOnboarding(profile: string, homeDir: string = os.homedir()): boolean {
  const safeProfile = sanitizeProfile(profile);
  if (!safeProfile) return false;

  const targetStateFile = path.join(homeDir, '.gemini', safeProfile, 'antigravity_state.pbtxt');

  try {
    let content = '';
    if (fs.existsSync(targetStateFile)) {
      content = fs.readFileSync(targetStateFile, 'utf8');
    }

    if (!content.includes('AGENT_ONBOARDING_STATE_COMPLETED')) {
      const defaultState = `post_onboarding:  {
  completed_steps:  POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME
  completed_steps:  POST_ONBOARDING_STEP_TYPE_USAGE_MODE
  completed_steps:  POST_ONBOARDING_STEP_TYPE_AGENT_CONFIGURATION
  completed_steps:  POST_ONBOARDING_STEP_TYPE_ADD_WORKSPACE
}
seen_nuxs:  {
  uids:  29
  uids:  24
  uids:  43
  uids:  38
  uids:  45
}
agent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED
migrate_convos_into_projects:  MIGRATION_STATUS_COMPLETED
migrate_retroactive_projects:  RETROACTIVE_MIGRATION_STATUS_COMPLETED_UNNECESSARY
migrations:  {
  key:  3
  value:  MIGRATION_STATUS_COMPLETED
}
migrations:  {
  key:  4
  value:  MIGRATION_STATUS_COMPLETED
}
migrations:  {
  key:  5
  value:  MIGRATION_STATUS_COMPLETED
}
`;
      writeSecureFile(targetStateFile, defaultState);
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

export function ensureVaultProject(vaultPath: string, homeDir: string = os.homedir()): string {
  const normalizedPath = path.resolve(vaultPath);
  const projectName = path.basename(normalizedPath) || 'obsidian';
  const cleanName = projectName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const hash = crypto.createHash('sha256').update(normalizedPath).digest('hex').slice(0, 8);
  const projectId = `obsidian-${cleanName}-${hash}`;

  const configProjectsDir = path.join(homeDir, '.gemini', 'config', 'projects');
  const projectFile = path.join(configProjectsDir, `${projectId}.json`);

  try {
    let existingSettings: Record<string, unknown> = {};
    let existingData: Record<string, unknown> = {};
    const raw = readJsonFile<Record<string, unknown>>(projectFile);
    if (raw) {
      existingData = raw;
      if (
        'settings' in raw &&
        typeof raw.settings === 'object' &&
        raw.settings !== null
      ) {
        existingSettings = raw.settings as Record<string, unknown>;
      }
    }

    const defaultSettings: Record<string, unknown> = {
      artifactReviewMode: 'ARTIFACT_REVIEW_MODE_TURBO',
      autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO',
    };

    const projectData = {
      ...existingData,
      id: projectId,
      name: projectName,
      projectResources: {
        resources: [
          {
            gitFolder: {
              folderUri: `file://${vaultPath}`,
            },
          },
        ],
      },
      settings: { ...defaultSettings, ...existingSettings },
      isWorkspaceOnly: false,
    };

    writeSecureFile(projectFile, JSON.stringify(projectData, null, 2), 0o644);
  } catch {
    // Non-critical, fallback to standard project discovery
  }

  return projectId;
}

export function ensureDefaultProjectId(profile: string, projectId: string, homeDir: string = os.homedir()): void {
  const safeProfile = sanitizeProfile(profile);
  if (!safeProfile || !projectId) return;
  const defaultProjectFile = path.join(homeDir, '.gemini', safeProfile, 'cache', 'default_project_id.txt');

  try {
    writeSecureFile(defaultProjectFile, projectId);
  } catch {
    // Non-critical
  }
}

export function ensureProfileSettings(
  profile: string,
  vaultPath?: string,
  homeDir: string = os.homedir(),
): boolean {
  const safeProfile = sanitizeProfile(profile);
  if (!safeProfile || safeProfile === 'antigravity-cli') {
    return false;
  }

  const targetSettingsFile = path.join(homeDir, '.gemini', safeProfile, 'settings.json');

  try {
    const settings = readJsonFile<Record<string, unknown>>(targetSettingsFile) ?? {};

    // Never inherit or retain CLI allowlist permissions in plugin profiles.
    // An inherited allowlist auto-approves arbitrary commands in restricted mode,
    // breaching the default permission gating.
    delete settings.permissions;

    if (vaultPath) {
      const normalizedVault = path.resolve(vaultPath);
      const trusted = Array.isArray(settings.trustedWorkspaces)
        ? (settings.trustedWorkspaces as string[])
        : [];
      if (!trusted.includes(normalizedVault)) {
        settings.trustedWorkspaces = [...trusted, normalizedVault];
      }
    }

    writeSecureFile(targetSettingsFile, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function ensureProfileInitialized(
  profile: string,
  vaultPath?: string,
  homeDir: string = os.homedir(),
): boolean {
  const safeProfile = sanitizeProfile(profile);
  const auth = ensureProfileAuth(safeProfile, homeDir);
  ensureProfileOnboarding(safeProfile, homeDir);
  ensureProfileSettings(safeProfile, vaultPath, homeDir);
  return auth;
}

export interface HubInstanceMetadata {
  pid: number;
  port: number;
  profile: string;
  vaultPath: string;
  dangerouslySkipPermissions: boolean;
  startedAt: number;
}

export function getHubInstanceFilePath(profile: string, homeDir: string = os.homedir()): string {
  const safeProfile = sanitizeProfile(profile);
  return path.join(homeDir, '.gemini', safeProfile, 'hub-instance.json');
}

export function loadHubInstanceMetadata(profile: string, homeDir: string = os.homedir()): HubInstanceMetadata | null {
  const raw = readJsonFile<HubInstanceMetadata>(getHubInstanceFilePath(profile, homeDir));
  if (
    raw &&
    typeof raw.pid === 'number' &&
    typeof raw.port === 'number'
  ) {
    return raw;
  }
  return null;
}

export function saveHubInstanceMetadata(
  profile: string,
  metadata: HubInstanceMetadata,
  homeDir: string = os.homedir(),
): void {
  try {
    writeSecureFile(
      getHubInstanceFilePath(profile, homeDir),
      JSON.stringify(metadata, null, 2),
    );
  } catch {
    // Non-critical
  }
}

export function removeHubInstanceMetadata(profile: string, homeDir: string = os.homedir()): void {
  const filePath = getHubInstanceFilePath(profile, homeDir);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Non-critical
  }
}

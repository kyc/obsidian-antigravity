import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Notice } from 'obsidian';
import { AgyProcess, KillEscalation } from './AgyProcess';
import { t } from '../i18n';

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
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        }
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

  const targetDir = path.join(homeDir, '.gemini', safeProfile);
  const targetStateFile = path.join(targetDir, 'antigravity_state.pbtxt');

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

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
      fs.writeFileSync(targetStateFile, defaultState, { encoding: 'utf8', mode: 0o600 });
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
    if (!fs.existsSync(configProjectsDir)) {
      fs.mkdirSync(configProjectsDir, { recursive: true, mode: 0o755 });
    }

    let existingSettings: Record<string, unknown> = {};
    let existingData: Record<string, unknown> = {};
    if (fs.existsSync(projectFile)) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
        if (typeof raw === 'object' && raw !== null) {
          existingData = raw as Record<string, unknown>;
          if (
            'settings' in raw &&
            typeof (raw as Record<string, unknown>).settings === 'object' &&
            (raw as Record<string, unknown>).settings !== null
          ) {
            existingSettings = (raw as { settings: Record<string, unknown> }).settings;
          }
        }
      } catch {
        // Fallback to empty settings
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

    fs.writeFileSync(projectFile, JSON.stringify(projectData, null, 2), {
      encoding: 'utf8',
      mode: 0o644,
    });
  } catch {
    // Non-critical, fallback to standard project discovery
  }

  return projectId;
}

export function ensureDefaultProjectId(profile: string, projectId: string, homeDir: string = os.homedir()): void {
  const safeProfile = sanitizeProfile(profile);
  if (!safeProfile || !projectId) return;
  const cacheDir = path.join(homeDir, '.gemini', safeProfile, 'cache');
  const defaultProjectFile = path.join(cacheDir, 'default_project_id.txt');

  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(defaultProjectFile, projectId, { encoding: 'utf8', mode: 0o600 });
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

  const targetDir = path.join(homeDir, '.gemini', safeProfile);
  const targetSettingsFile = path.join(targetDir, 'settings.json');

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    const candidateSources = [
      path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'),
      path.join(homeDir, '.gemini', 'antigravity', 'settings.json'),
      path.join(homeDir, '.gemini', 'antigravity-ide', 'settings.json'),
    ];

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(targetSettingsFile)) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(targetSettingsFile, 'utf8'));
        if (typeof raw === 'object' && raw !== null) {
          settings = raw as Record<string, unknown>;
        }
      } catch {
        settings = {};
      }
    } else {
      for (const src of candidateSources) {
        if (fs.existsSync(src)) {
          try {
            const raw: unknown = JSON.parse(fs.readFileSync(src, 'utf8'));
            if (typeof raw === 'object' && raw !== null) {
              settings = raw as Record<string, unknown>;
              break;
            }
          } catch {
            // Non-critical, try next candidate
          }
        }
      }
    }

    if (!settings.permissions) {
      for (const src of candidateSources) {
        if (fs.existsSync(src)) {
          try {
            const raw: unknown = JSON.parse(fs.readFileSync(src, 'utf8'));
            if (
              typeof raw === 'object' &&
              raw !== null &&
              'permissions' in raw &&
              typeof (raw as Record<string, unknown>).permissions === 'object'
            ) {
              settings.permissions = (raw as Record<string, unknown>).permissions;
              break;
            }
          } catch {
            // Non-critical, try next candidate
          }
        }
      }
    }

    if (vaultPath) {
      const normalizedVault = path.resolve(vaultPath);
      const trusted = Array.isArray(settings.trustedWorkspaces)
        ? (settings.trustedWorkspaces as string[])
        : [];
      if (!trusted.includes(normalizedVault)) {
        settings.trustedWorkspaces = [...trusted, normalizedVault];
      }
    }

    if (!settings.permissionMode) {
      settings.permissionMode = 'always-proceed';
    }
    if (settings.allowNonWorkspaceAccess === undefined) {
      settings.allowNonWorkspaceAccess = true;
    }

    fs.writeFileSync(targetSettingsFile, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
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
  const filePath = getHubInstanceFilePath(profile, homeDir);
  try {
    if (fs.existsSync(filePath)) {
      const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as Record<string, unknown>).pid === 'number' &&
        typeof (raw as Record<string, unknown>).port === 'number'
      ) {
        return raw as HubInstanceMetadata;
      }
    }
  } catch {
    // Non-critical
  }
  return null;
}

export function saveHubInstanceMetadata(
  profile: string,
  metadata: HubInstanceMetadata,
  homeDir: string = os.homedir(),
): void {
  const filePath = getHubInstanceFilePath(profile, homeDir);
  const targetDir = path.dirname(filePath);
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
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

interface InFlightHubStart {
  profile: string;
  vaultPath: string;
  dangerouslySkipPermissions: boolean;
  promise: Promise<string>;
}

/** How many trailing hub output chunks to retain for diagnostics. */
const HUB_OUTPUT_TAIL_LINES = 50;

export interface WaitForPortOptions {
  /** Port the hub is expected to start listening on. */
  port: number;
  /** Maximum time to wait before rejecting. Defaults to 15000ms. */
  timeoutMs?: number;
  /**
   * Process to monitor for early exit while waiting. Defaults to the manager's
   * current hub process; pass null to wait on the port alone.
   */
  child?: ChildProcess | null;
}

export class AgyHubManager {
  private hubProcess: ChildProcess | null = null;
  private port: number | null = null;
  private vaultPath: string | null = null;
  private currentProfile: string | null = null;
  private currentProjectId: string | null = null;
  private currentDangerouslySkipPermissions: boolean = false;
  private inFlightStart: InFlightHubStart | null = null;
  private startMutex: Promise<void> = Promise.resolve();
  private killEscalation: KillEscalation | null = null;
  private recentOutput: string[] = [];

  async startHub(
    agyExecutable: string,
    vaultPath: string,
    preferredPort: number = 0,
    profile: string = 'antigravity-obsidian',
    defaultAgent?: string,
    dangerouslySkipPermissions: boolean = false,
  ): Promise<string> {
    const safeProfile = sanitizeProfile(profile);

    // 1. Fast path: if hub is already running for the exact same profile, vault & permission mode
    if (
      this.isRunning() &&
      this.port &&
      this.currentProfile === safeProfile &&
      this.vaultPath === vaultPath &&
      this.currentDangerouslySkipPermissions === dangerouslySkipPermissions
    ) {
      return this.getHubUrl();
    }

    // 2. Coalescing in-flight start for the same profile, vault and permission mode
    if (
      this.inFlightStart &&
      this.inFlightStart.profile === safeProfile &&
      this.inFlightStart.vaultPath === vaultPath &&
      this.inFlightStart.dangerouslySkipPermissions === dangerouslySkipPermissions
    ) {
      return this.inFlightStart.promise;
    }

    // 3. Serialize starts across differing profiles, vaults or permission modes via mutex
    const runStart = async (): Promise<string> => {
      // Re-check running state after acquiring lock
      if (
        this.isRunning() &&
        this.port &&
        this.currentProfile === safeProfile &&
        this.vaultPath === vaultPath &&
        this.currentDangerouslySkipPermissions === dangerouslySkipPermissions
      ) {
        return this.getHubUrl();
      }

      // If a hub is running with a different profile, vault, or permission mode, stop it now
      if (
        this.hubProcess &&
        (this.currentProfile !== safeProfile ||
          this.vaultPath !== vaultPath ||
          this.currentDangerouslySkipPermissions !== dangerouslySkipPermissions)
      ) {
        this.stopHub();
      }

      // Terminate any stale/orphan hub processes for this profile from previous sessions or crashes
      await this.cleanupStaleHubs(safeProfile);

      const port = preferredPort > 0 ? preferredPort : await this.getFreePort();
      const projectId = ensureVaultProject(vaultPath);
      ensureDefaultProjectId(safeProfile, projectId);
      const isAuthed = ensureProfileInitialized(safeProfile, vaultPath);
      if (!isAuthed) {
        new Notice(t('errors.notAuthenticated'));
      }

      const args = [
        '--hub',
        `--hub-port=${port}`,
        `--app_data_dir=${safeProfile}`,
        `--project=${projectId}`,
        `--add-dir=${vaultPath}`,
      ];

      if (dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      if (defaultAgent) {
        args.push(`--agent=${defaultAgent}`);
      }

      const env: Record<string, string> = {
        AGY_ENABLE_HUB: '1',
      };

      const enrichedEnv = AgyProcess.getEnrichedEnv(env);

      const child = spawn(agyExecutable, args, {
        cwd: vaultPath,
        env: enrichedEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      if (child.pid) {
        saveHubInstanceMetadata(safeProfile, {
          pid: child.pid,
          port,
          profile: safeProfile,
          vaultPath,
          dangerouslySkipPermissions,
          startedAt: Date.now(),
        });
      }

      // The hub is a long-lived daemon that logs continuously. A 'pipe' stream
      // is not drained automatically, so once the child writes past the OS
      // pipe buffer (~64KB) it blocks inside write() and the hub stops
      // serving requests while still holding the port. Both streams must be
      // consumed; we keep a bounded tail for startup diagnostics.
      this.recentOutput = [];
      child.stdout?.on('data', this.captureOutput);
      child.stderr?.on('data', this.captureOutput);
      // If a stream is never given a 'data' listener it must at least be
      // resumed, otherwise the same deadlock occurs.
      child.stdout?.resume();
      child.stderr?.resume();

      child.on('exit', () => {
        if (this.hubProcess === child) {
          if (this.currentProfile) {
            removeHubInstanceMetadata(this.currentProfile);
          }
          this.hubProcess = null;
          this.port = null;
          this.currentProfile = null;
          this.currentProjectId = null;
          this.vaultPath = null;
          this.currentDangerouslySkipPermissions = false;
        }
      });

      // Wait until server starts accepting connections
      try {
        await this.waitForPort({ port, child, timeoutMs: 15000 });
      } catch (err) {
        const detail = this.getRecentOutput();
        removeHubInstanceMetadata(safeProfile);
        AgyProcess.killProcess(child, true);
        this.recentOutput = [];

        const message = (err as Error).message;
        throw new Error(detail ? `${message}\n${detail}` : message);
      }

      this.hubProcess = child;
      this.port = port;
      this.currentProfile = safeProfile;
      this.currentProjectId = projectId;
      this.vaultPath = vaultPath;
      this.currentDangerouslySkipPermissions = dangerouslySkipPermissions;

      return this.buildHubUrl(port, projectId);
    };

    const startPromise = (async () => {
      await this.startMutex;
      return runStart();
    })();

    this.startMutex = startPromise.then(
      () => {},
      () => {},
    );

    this.inFlightStart = {
      profile: safeProfile,
      vaultPath,
      dangerouslySkipPermissions,
      promise: startPromise,
    };

    try {
      return await startPromise;
    } finally {
      if (this.inFlightStart?.promise === startPromise) {
        this.inFlightStart = null;
      }
    }
  }

  getHubUrl(options?: { hostTheme?: 'dark' | 'light'; section?: string }): string {
    if (!this.port) return '';
    return this.buildHubUrl(this.port, options?.section || this.currentProjectId, options?.hostTheme);
  }

  private buildHubUrl(port: number, section?: string | null, hostTheme?: 'dark' | 'light'): string {
    const params = new URLSearchParams();
    if (section) {
      params.set('section', section);
    }
    if (hostTheme) {
      params.set('hostTheme', hostTheme);
    }
    params.set('useWebSocket', 'true');
    const query = params.toString();
    return `http://127.0.0.1:${port}/${query ? `?${query}` : ''}`;
  }

  isRunning(): boolean {
    return this.hubProcess !== null && !this.hubProcess.killed && this.port !== null;
  }

  getCurrentProfile(): string | null {
    return this.currentProfile;
  }

  getVaultPath(): string | null {
    return this.vaultPath;
  }

  getDangerouslySkipPermissions(): boolean {
    return this.currentDangerouslySkipPermissions;
  }

  /**
   * Discovers and cleans up stale/orphaned hub processes for this profile from previous sessions.
   */
  async cleanupStaleHubs(profile: string, homeDir: string = os.homedir()): Promise<void> {
    const safeProfile = sanitizeProfile(profile);
    const currentChildPid = this.hubProcess?.pid;

    // 1. Check tracked instance file
    const meta = loadHubInstanceMetadata(safeProfile, homeDir);
    if (meta && meta.pid && meta.pid !== currentChildPid) {
      await AgyProcess.terminatePid(meta.pid, true);
      removeHubInstanceMetadata(safeProfile, homeDir);
    }

    // 2. Scan for any orphaned agy --hub processes matching this profile
    const orphanPids = AgyProcess.findAgyHubProcesses(safeProfile);
    for (const pid of orphanPids) {
      if (pid !== currentChildPid) {
        await AgyProcess.terminatePid(pid, true);
      }
    }
  }

  stopHub(): void {
    this.clearKillEscalation();
    if (this.currentProfile) {
      removeHubInstanceMetadata(this.currentProfile);
    }
    if (this.hubProcess) {
      this.killEscalation = AgyProcess.killProcess(this.hubProcess, true);
      this.hubProcess = null;
      this.port = null;
      this.currentProfile = null;
      this.currentProjectId = null;
      this.vaultPath = null;
      this.currentDangerouslySkipPermissions = false;
    }
  }

  /** Cancels the pending SIGKILL escalation timer, if any. */
  private clearKillEscalation(): void {
    if (this.killEscalation) {
      this.killEscalation.cancel();
      this.killEscalation = null;
    }
  }

  /**
   * Drains a hub output stream, retaining a bounded tail so a failed startup
   * can report why. Bound as a listener so each chunk is consumed promptly.
   */
  private captureOutput = (chunk: Buffer): void => {
    const text = chunk.toString('utf8').trim();
    if (!text) return;

    this.recentOutput.push(text);
    if (this.recentOutput.length > HUB_OUTPUT_TAIL_LINES) {
      this.recentOutput.splice(0, this.recentOutput.length - HUB_OUTPUT_TAIL_LINES);
    }
  };

  /** Recent hub output, useful for diagnosing a failed start. */
  getRecentOutput(): string {
    return this.recentOutput.join('\n');
  }

  private getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address() as net.AddressInfo;
        const port = address.port;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
      srv.on('error', reject);
    });
  }

  protected async waitForPort(options: WaitForPortOptions): Promise<void> {
    const { port, timeoutMs = 15000, child = this.hubProcess } = options;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (child && (child.killed || child.exitCode !== null)) {
        throw new Error('Antigravity hub process exited unexpectedly during startup.');
      }

      const isListening = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          resolve(true);
          res.destroy();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => {
          req.destroy();
          resolve(false);
        });
      });

      if (isListening) return;
      await new Promise((r) => window.setTimeout(r, 250));
    }

    throw new Error(`Timed out waiting for Antigravity hub to listen on port ${port}`);
  }
}

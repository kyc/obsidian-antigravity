import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { AgyProcess } from './AgyProcess';

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

    const projectData = {
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
      settings: {},
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

export function ensureProfileInitialized(profile: string, homeDir: string = os.homedir()): boolean {
  const safeProfile = sanitizeProfile(profile);
  const auth = ensureProfileAuth(safeProfile, homeDir);
  ensureProfileOnboarding(safeProfile, homeDir);
  return auth;
}

interface InFlightHubStart {
  profile: string;
  vaultPath: string;
  promise: Promise<string>;
}

export class AgyHubManager {
  private hubProcess: ChildProcess | null = null;
  private port: number | null = null;
  private vaultPath: string | null = null;
  private currentProfile: string | null = null;
  private currentProjectId: string | null = null;
  private inFlightStart: InFlightHubStart | null = null;
  private startMutex: Promise<void> = Promise.resolve();

  async startHub(
    agyExecutable: string,
    vaultPath: string,
    preferredPort: number = 0,
    profile: string = 'antigravity-obsidian',
    defaultAgent?: string,
  ): Promise<string> {
    const safeProfile = sanitizeProfile(profile);

    // 1. Fast path: if hub is already running for the exact same profile & vault
    if (this.isRunning() && this.port && this.currentProfile === safeProfile && this.vaultPath === vaultPath) {
      return this.getHubUrl();
    }

    // 2. Coalescing in-flight start for the same profile and vault
    if (
      this.inFlightStart &&
      this.inFlightStart.profile === safeProfile &&
      this.inFlightStart.vaultPath === vaultPath
    ) {
      return this.inFlightStart.promise;
    }

    // 3. Serialize starts across differing profiles or vaults via mutex
    const runStart = async (): Promise<string> => {
      // Re-check running state after acquiring lock
      if (this.isRunning() && this.port && this.currentProfile === safeProfile && this.vaultPath === vaultPath) {
        return this.getHubUrl();
      }

      // If a hub is running with a different profile or vault, stop it now
      if (this.hubProcess && (this.currentProfile !== safeProfile || this.vaultPath !== vaultPath)) {
        this.stopHub();
      }

      const port = preferredPort > 0 ? preferredPort : await this.getFreePort();
      const projectId = ensureVaultProject(vaultPath);
      ensureDefaultProjectId(safeProfile, projectId);
      ensureProfileInitialized(safeProfile);

      const args = [
        '--hub',
        `--hub-port=${port}`,
        `--app_data_dir=${safeProfile}`,
        `--project=${projectId}`,
        `--add-dir=${vaultPath}`,
      ];

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
      });

      child.on('exit', () => {
        if (this.hubProcess === child) {
          this.hubProcess = null;
          this.port = null;
          this.currentProfile = null;
          this.currentProjectId = null;
          this.vaultPath = null;
        }
      });

      // Wait until server starts accepting connections
      try {
        await this.waitForPort(child, port, 15000);
      } catch (err) {
        AgyProcess.killProcess(child);
        throw err;
      }

      this.hubProcess = child;
      this.port = port;
      this.currentProfile = safeProfile;
      this.currentProjectId = projectId;
      this.vaultPath = vaultPath;

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
    const query = params.toString();
    return `http://127.0.0.1:${port}/${query ? `?${query}` : ''}`;
  }

  isRunning(): boolean {
    return this.hubProcess !== null && !this.hubProcess.killed && this.port !== null;
  }

  getPort(): number | null {
    return this.port;
  }

  stopHub(): void {
    if (this.hubProcess) {
      AgyProcess.killProcess(this.hubProcess);
      this.hubProcess = null;
      this.port = null;
      this.currentProfile = null;
      this.currentProjectId = null;
      this.vaultPath = null;
    }
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

  protected async waitForPort(target: ChildProcess | number, portOrTimeout?: number, maybeTimeout?: number): Promise<void> {
    let child: ChildProcess | null = null;
    let port: number;
    let timeoutMs: number;

    if (typeof target === 'number') {
      port = target;
      timeoutMs = portOrTimeout ?? 15000;
      child = this.hubProcess;
    } else {
      child = target;
      port = portOrTimeout ?? 0;
      timeoutMs = maybeTimeout ?? 15000;
    }

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

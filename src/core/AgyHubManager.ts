import { ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import { Notice } from 'obsidian';
import { AgyProcess, KillEscalation } from './AgyProcess';
import {
  ensureDefaultProjectId,
  ensureProfileInitialized,
  ensureVaultProject,
  loadHubDiscoveryMetadata,
  loadHubInstanceMetadata,
  removeHubInstanceMetadata,
  sanitizeProfile,
  saveHubInstanceMetadata,
} from './AgyProfile';
import { t } from '../i18n';

interface InFlightHubStart {
  executable: string;
  profile: string;
  vaultPath: string;
  dangerouslySkipPermissions: boolean;
  proxyUrl: string;
  defaultAgent: string;
  preferredPort: number;
  promise: Promise<string>;
}

export interface HubRunningConfig {
  executable?: string;
  profile: string;
  vaultPath: string;
  dangerouslySkipPermissions: boolean;
  proxyUrl?: string;
  defaultAgent?: string;
  preferredPort?: number;
}

/** How many trailing hub output chunks to retain for diagnostics. */
const HUB_OUTPUT_TAIL_LINES = 50;

/** Maximum time to wait for `agy --hub` to print its `#t=<token>` URL after listening. */
const BOOTSTRAP_TOKEN_WAIT_MS = 1000;

/**
 * Maximum time on Windows to wait for `agy.exe --hub` to write `daemon/hub_<port>.json`
 * and mint a `#t=<bootstrapToken>` via `POST /auth/mint` (`stdout` is silent on Windows).
 */
const WINDOWS_BOOTSTRAP_TOKEN_WAIT_MS = 3000;

/** Interval between `daemon/hub_<port>.json` discovery checks while waiting for bootstrap. */
const DISCOVERY_POLL_INTERVAL_MS = 100;

/** Maximum length of a trailing partial stdout line kept while scanning for `#t=`. */
const STDOUT_LINE_BUFFER_LIMIT = 4096;

const ANSI_CSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g');
const HUB_BOOTSTRAP_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/[^\s"'<>]*[#&]t=([^&#\s"'<>]+)/i;

/**
 * Extracts the UI bootstrap token (`#t=<token>`) from a local `agy --hub`
 * startup banner line, stripping any ANSI escape sequences first.
 */
export function extractHubBootstrapToken(text: string): string | null {
  if (!text) return null;
  const clean = text.replace(ANSI_CSI_PATTERN, '');
  const match = clean.match(HUB_BOOTSTRAP_URL_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  const rawToken = match[1];
  try {
    const decoded = decodeURIComponent(rawToken).trim();
    return decoded || null;
  } catch {
    const fallback = rawToken.trim();
    return fallback || null;
  }
}

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
  /** Optional predicate polled between probes to abort early when start is cancelled. */
  isCancelled?: () => boolean;
}

export class AgyHubManager {
  private hubProcess: ChildProcess | null = null;
  private port: number | null = null;
  private vaultPath: string | null = null;
  private currentExecutable: string = '';
  private currentProfile: string | null = null;
  private currentProjectId: string | null = null;
  private currentDangerouslySkipPermissions: boolean = false;
  private currentProxyUrl: string = '';
  private currentDefaultAgent: string = '';
  private currentPreferredPort: number = 0;
  private bootstrapToken: string | null = null;
  private spawningProcess: { child: ChildProcess; profile: string } | null = null;
  private inFlightStart: InFlightHubStart | null = null;
  private startMutex: Promise<void> = Promise.resolve();
  private killEscalation: KillEscalation | null = null;
  private recentOutput: string[] = [];
  /** Bumped by stopHub so an in-flight start knows it was cancelled. */
  private startGeneration = 0;

  constructor(private readonly homeDir: string = os.homedir()) {}

  async startHub(
    agyExecutable: string,
    vaultPath: string,
    preferredPort: number = 0,
    profile: string = 'antigravity-obsidian',
    defaultAgent?: string,
    dangerouslySkipPermissions: boolean = false,
    proxyUrl?: string,
  ): Promise<string> {
    const safeProfile = sanitizeProfile(profile);
    const safeProxyUrl = proxyUrl?.trim() || '';
    const safeAgent = defaultAgent?.trim() || '';
    const targetConfig: HubRunningConfig = {
      executable: agyExecutable,
      profile: safeProfile,
      vaultPath,
      dangerouslySkipPermissions,
      proxyUrl: safeProxyUrl,
      defaultAgent: safeAgent,
      preferredPort,
    };

    // 1. Fast path: if hub is already running for the exact same profile, vault & permission mode
    if (this.matchesRunningConfig(targetConfig)) {
      return this.getHubUrl();
    }

    // 2. Coalescing in-flight start for the same profile, vault and permission mode
    if (this.inFlightStart && this.matchesInFlightConfig(targetConfig)) {
      return this.inFlightStart.promise;
    }

    // 3. Serialize starts across differing profiles, vaults or permission modes via mutex
    const runStart = async (): Promise<string> => {
      // Re-check running state after acquiring lock
      if (this.matchesRunningConfig(targetConfig)) {
        return this.getHubUrl();
      }

      // If a hub is running with a different profile, vault, permission mode, proxy, agent, or port, stop it now
      if (this.hubProcess && !this.matchesRunningConfig(targetConfig)) {
        this.stopHub();
      }
      const generation = this.startGeneration;

      // Terminate any stale/orphan hub processes for this profile from previous sessions or crashes
      await this.performCleanupStaleHubs(safeProfile);

      if (generation !== this.startGeneration) {
        throw new Error('Antigravity hub start was cancelled.');
      }

      if (preferredPort > 0) {
        // Otherwise waitForPort would accept whatever server already owns the port.
        await this.assertPortAvailable(preferredPort);
      }
      const port = preferredPort > 0 ? preferredPort : await this.getFreePort();

      if (generation !== this.startGeneration) {
        throw new Error('Antigravity hub start was cancelled.');
      }

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

      if (safeAgent) {
        args.push(`--agent=${safeAgent}`);
      }

      const proxyEnv = AgyProcess.formatProxyEnv(safeProxyUrl);
      const env: Record<string, string> = {
        AGY_ENABLE_HUB: '1',
        ...proxyEnv,
      };

      const enrichedEnv = AgyProcess.getEnrichedEnv(env);

      const child = spawn(agyExecutable, args, {
        cwd: vaultPath,
        env: enrichedEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      this.spawningProcess = { child, profile: safeProfile };

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
      let capturedBootstrapToken: string | null = null;
      let stdoutLineBuffer = '';
      let bootstrapWaiter: (() => void) | null = null;

      const handleStdoutData = (chunk: Buffer): void => {
        this.captureOutput(chunk);
        if (capturedBootstrapToken) return;

        stdoutLineBuffer += chunk.toString('utf8');
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? '';
        if (stdoutLineBuffer.length > STDOUT_LINE_BUFFER_LIMIT) {
          stdoutLineBuffer = stdoutLineBuffer.slice(-STDOUT_LINE_BUFFER_LIMIT);
        }

        for (const line of lines) {
          const token = extractHubBootstrapToken(line);
          if (token) {
            capturedBootstrapToken = token;
            break;
          }
        }
        if (!capturedBootstrapToken && stdoutLineBuffer) {
          const token = extractHubBootstrapToken(stdoutLineBuffer);
          if (token) {
            capturedBootstrapToken = token;
          }
        }

        if (capturedBootstrapToken) {
          stdoutLineBuffer = '';
          if (this.hubProcess === child) {
            this.bootstrapToken = capturedBootstrapToken;
          }
          bootstrapWaiter?.();
        }
      };

      child.stdout?.on('data', handleStdoutData);
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
          this.currentExecutable = '';
          this.currentProfile = null;
          this.currentProjectId = null;
          this.vaultPath = null;
          this.currentDangerouslySkipPermissions = false;
          this.currentProxyUrl = '';
          this.currentDefaultAgent = '';
          this.currentPreferredPort = 0;
          this.bootstrapToken = null;
        }
      });

      try {
        // Wait until server starts accepting connections
        try {
          await this.waitForPort({
            port,
            child,
            timeoutMs: 15000,
            isCancelled: () => generation !== this.startGeneration,
          });
        } catch (err) {
          const detail = this.getRecentOutput();
          removeHubInstanceMetadata(safeProfile);
          AgyProcess.killProcess(child, true);
          this.recentOutput = [];

          if (generation !== this.startGeneration) {
            throw new Error('Antigravity hub start was cancelled.');
          }

          const message = (err as Error).message;
          throw new Error(detail ? `${message}\n${detail}` : message);
        }

        if (generation !== this.startGeneration) {
          // stopHub ran while we were waiting; don't resurrect an orphan daemon.
          removeHubInstanceMetadata(safeProfile);
          AgyProcess.killProcess(child, true);
          throw new Error('Antigravity hub start was cancelled.');
        }

        if (!capturedBootstrapToken && child.stdout) {
          const pid = child.pid;
          const tryDiscoveryMint =
            typeof pid === 'number'
              ? async (): Promise<boolean> => {
                  if (generation !== this.startGeneration || capturedBootstrapToken) {
                    return true;
                  }
                  const discovery = loadHubDiscoveryMetadata(safeProfile, port, pid, this.homeDir);
                  if (!discovery) {
                    return false;
                  }
                  const minted = await this.mintBootstrapToken(port, discovery.csrfToken);
                  if (generation !== this.startGeneration || capturedBootstrapToken) {
                    return true;
                  }
                  if (minted.token) {
                    capturedBootstrapToken = minted.token;
                    if (this.hubProcess === child) {
                      this.bootstrapToken = minted.token;
                    }
                    return true;
                  }
                  return Boolean(minted.unsupported);
                }
              : undefined;

          await this.waitForBootstrapToken(
            child,
            () => capturedBootstrapToken,
            (cb) => {
              bootstrapWaiter = cb;
            },
            process.platform === 'win32' ? WINDOWS_BOOTSTRAP_TOKEN_WAIT_MS : BOOTSTRAP_TOKEN_WAIT_MS,
            tryDiscoveryMint,
            () => generation !== this.startGeneration,
          );
        }

        if (generation !== this.startGeneration) {
          // stopHub ran while we were waiting for the bootstrap token; don't resurrect an orphan daemon.
          removeHubInstanceMetadata(safeProfile);
          AgyProcess.killProcess(child, true);
          throw new Error('Antigravity hub start was cancelled.');
        }

        this.hubProcess = child;
        this.port = port;
        this.currentExecutable = agyExecutable;
        this.currentProfile = safeProfile;
        this.currentProjectId = projectId;
        this.vaultPath = vaultPath;
        this.currentDangerouslySkipPermissions = dangerouslySkipPermissions;
        this.currentProxyUrl = safeProxyUrl;
        this.currentDefaultAgent = safeAgent;
        this.currentPreferredPort = preferredPort;
        this.bootstrapToken = capturedBootstrapToken;

        return this.buildHubUrl(port, projectId, undefined, this.bootstrapToken);
      } finally {
        if (this.spawningProcess?.child === child) {
          this.spawningProcess = null;
        }
      }
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
      executable: agyExecutable,
      profile: safeProfile,
      vaultPath,
      dangerouslySkipPermissions,
      proxyUrl: safeProxyUrl,
      defaultAgent: safeAgent,
      preferredPort,
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
    return this.buildHubUrl(
      this.port,
      options?.section || this.currentProjectId,
      options?.hostTheme,
      this.bootstrapToken,
    );
  }

  /**
   * Returns a Hub URL with a freshly minted single-use `#t=<bootstrapToken>`
   * from `daemon/hub_<port>.json` when available, falling back to `getHubUrl`.
   */
  async getAuthenticatedHubUrl(options?: {
    hostTheme?: 'dark' | 'light';
    section?: string;
  }): Promise<string> {
    if (!this.isRunning() || !this.port || !this.currentProfile) {
      return this.getHubUrl(options);
    }

    const activeChild = this.hubProcess;
    const activePort = this.port;
    const discovery =
      typeof activeChild?.pid === 'number'
        ? loadHubDiscoveryMetadata(this.currentProfile, activePort, activeChild.pid, this.homeDir)
        : null;

    if (discovery) {
      const minted = await this.mintBootstrapToken(activePort, discovery.csrfToken);
      if (this.hubProcess !== activeChild || this.port !== activePort || !this.isRunning()) {
        return this.getHubUrl(options);
      }
      if (minted.token) {
        return this.buildHubUrl(
          activePort,
          options?.section || this.currentProjectId,
          options?.hostTheme,
          minted.token,
        );
      }
    }

    return this.getHubUrl(options);
  }

  private buildHubUrl(
    port: number,
    section?: string | null,
    hostTheme?: 'dark' | 'light',
    bootstrapToken?: string | null,
  ): string {
    const params = new URLSearchParams();
    if (section) {
      params.set('section', section);
    }
    if (hostTheme) {
      params.set('hostTheme', hostTheme);
    }
    params.set('useWebSocket', 'true');
    const query = params.toString();
    const hash = bootstrapToken ? `#t=${encodeURIComponent(bootstrapToken)}` : '';
    return `http://127.0.0.1:${port}/${query ? `?${query}` : ''}${hash}`;
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

  getProxyUrl(): string {
    return this.currentProxyUrl;
  }

  getExecutable(): string {
    return this.currentExecutable;
  }

  getDefaultAgent(): string {
    return this.currentDefaultAgent;
  }

  getPreferredPort(): number {
    return this.currentPreferredPort;
  }

  matchesRunningConfig(config: HubRunningConfig): boolean {
    const safeProfile = sanitizeProfile(config.profile);
    const safeProxyUrl = config.proxyUrl?.trim() || '';
    const safeAgent = config.defaultAgent?.trim() || '';
    const preferredPort = config.preferredPort ?? 0;

    return (
      this.isRunning() &&
      this.port !== null &&
      (config.executable === undefined ||
        this.currentExecutable === '' ||
        this.currentExecutable === config.executable) &&
      this.currentProfile === safeProfile &&
      this.vaultPath === config.vaultPath &&
      this.currentDangerouslySkipPermissions === config.dangerouslySkipPermissions &&
      this.currentProxyUrl === safeProxyUrl &&
      this.currentDefaultAgent === safeAgent &&
      this.currentPreferredPort === preferredPort &&
      (preferredPort <= 0 || this.port === preferredPort)
    );
  }

  private matchesInFlightConfig(config: HubRunningConfig): boolean {
    if (!this.inFlightStart) return false;
    const safeProfile = sanitizeProfile(config.profile);
    const safeProxyUrl = config.proxyUrl?.trim() || '';
    const safeAgent = config.defaultAgent?.trim() || '';
    const preferredPort = config.preferredPort ?? 0;

    return (
      (config.executable === undefined || this.inFlightStart.executable === config.executable) &&
      this.inFlightStart.profile === safeProfile &&
      this.inFlightStart.vaultPath === config.vaultPath &&
      this.inFlightStart.dangerouslySkipPermissions === config.dangerouslySkipPermissions &&
      this.inFlightStart.proxyUrl === safeProxyUrl &&
      this.inFlightStart.defaultAgent === safeAgent &&
      this.inFlightStart.preferredPort === preferredPort
    );
  }

  hasConfigDrift(config: HubRunningConfig): boolean {
    if (this.isRunning()) {
      return !this.matchesRunningConfig(config);
    }
    if (this.inFlightStart) {
      return !this.matchesInFlightConfig(config);
    }
    return false;
  }

  private isManagedPid(pid: number): boolean {
    return pid === this.hubProcess?.pid || pid === this.spawningProcess?.child.pid;
  }

  /**
   * Discovers and cleans up stale/orphaned hub processes for this profile from previous sessions.
   * Serialized with startHub via startMutex so cleanup cannot race with and kill a newly spawned hub.
   */
  cleanupStaleHubs(profile: string, homeDir: string = os.homedir()): Promise<void> {
    const cleanupPromise = (async () => {
      await this.startMutex;
      await this.performCleanupStaleHubs(profile, homeDir);
    })();

    this.startMutex = cleanupPromise.then(
      () => {},
      () => {},
    );

    return cleanupPromise;
  }

  private async performCleanupStaleHubs(profile: string, homeDir: string = os.homedir()): Promise<void> {
    const safeProfile = sanitizeProfile(profile);
    const verifiedPids = AgyProcess.findAgyHubProcesses(safeProfile);
    const terminatedPids = new Set<number>();

    // 1. Check tracked instance file — on POSIX, verify PID identity before signalling
    // to avoid killing an unrelated process that recycled a stale PID after reboot/crash.
    const meta = loadHubInstanceMetadata(safeProfile, homeDir);
    if (meta && meta.pid && !this.isManagedPid(meta.pid)) {
      const isVerified = process.platform === 'win32' || verifiedPids.includes(meta.pid);
      if (isVerified) {
        await AgyProcess.terminatePid(meta.pid, true);
        terminatedPids.add(meta.pid);
      }
      removeHubInstanceMetadata(safeProfile, homeDir);
    }

    // 2. Scan for any remaining orphaned agy --hub processes matching this profile
    for (const pid of verifiedPids) {
      if (!terminatedPids.has(pid) && !this.isManagedPid(pid)) {
        await AgyProcess.terminatePid(pid, true);
        terminatedPids.add(pid);
      }
    }
  }

  stopHub(): void {
    this.startGeneration++;
    const currentProfile = this.currentProfile;
    if (currentProfile) {
      removeHubInstanceMetadata(currentProfile);
    }
    const spawning = this.spawningProcess;
    this.spawningProcess = null;
    if (spawning) {
      if (spawning.profile !== currentProfile) {
        removeHubInstanceMetadata(spawning.profile);
      }
      if (spawning.child !== this.hubProcess) {
        if (!this.hubProcess) {
          this.clearKillEscalation();
          this.killEscalation = AgyProcess.killProcess(spawning.child, true);
        } else {
          AgyProcess.killProcess(spawning.child, true);
        }
      }
    }
    if (this.hubProcess) {
      this.clearKillEscalation();
      this.killEscalation = AgyProcess.killProcess(this.hubProcess, true);
      this.hubProcess = null;
      this.port = null;
      this.currentExecutable = '';
      this.currentProfile = null;
      this.currentProjectId = null;
      this.vaultPath = null;
      this.currentDangerouslySkipPermissions = false;
      this.currentProxyUrl = '';
      this.currentDefaultAgent = '';
      this.currentPreferredPort = 0;
      this.bootstrapToken = null;
    } else {
      this.bootstrapToken = null;
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
    const text = chunk
      .toString('utf8')
      .replace(/([#&]t=)([^&#\s"'<>]+)/g, '$1[REDACTED]')
      .trim();
    if (!text) return;

    this.recentOutput.push(text);
    if (this.recentOutput.length > HUB_OUTPUT_TAIL_LINES) {
      this.recentOutput.splice(0, this.recentOutput.length - HUB_OUTPUT_TAIL_LINES);
    }
  };

  /**
   * Waits after the HTTP port is listening for `agy --hub` to either emit its
   * `#t=<token>` startup URL on stdout or expose its daemon discovery file
   * (`daemon/hub_<port>.json`) so a bootstrap token can be minted via `POST /auth/mint`,
   * falling back cleanly on older CLI builds.
   */
  protected waitForBootstrapToken(
    child: ChildProcess,
    getToken: () => string | null,
    registerWaiter: (cb: () => void) => void,
    timeoutMs: number = BOOTSTRAP_TOKEN_WAIT_MS,
    pollDiscovery?: () => Promise<boolean>,
    isCancelled?: () => boolean,
  ): Promise<void> {
    if (getToken() || isCancelled?.() || child.killed || child.exitCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: number | null = null;
      let pollTimer: number | null = null;
      let resolvePollWait: (() => void) | null = null;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        if (pollTimer !== null) {
          window.clearTimeout(pollTimer);
          pollTimer = null;
        }
        if (resolvePollWait) {
          const wake = resolvePollWait;
          resolvePollWait = null;
          wake();
        }
        if (typeof child.off === 'function') {
          child.off('exit', finish);
        } else if (typeof child.removeListener === 'function') {
          child.removeListener('exit', finish);
        }
        resolve();
      };

      registerWaiter(() => {
        if (getToken() || isCancelled?.()) {
          finish();
        }
      });

      child.on('exit', finish);
      timer = window.setTimeout(finish, timeoutMs);

      if (getToken() || isCancelled?.() || child.killed || child.exitCode !== null) {
        finish();
        return;
      }

      if (pollDiscovery) {
        void (async () => {
          while (!settled) {
            if (isCancelled?.()) {
              finish();
              return;
            }
            const stopPolling = await pollDiscovery();
            if (settled || getToken() || isCancelled?.()) {
              finish();
              return;
            }
            if (stopPolling) {
              if (process.platform === 'win32') {
                finish();
              }
              return;
            }
            await new Promise<void>((r) => {
              resolvePollWait = r;
              pollTimer = window.setTimeout(() => {
                pollTimer = null;
                resolvePollWait = null;
                r();
              }, DISCOVERY_POLL_INTERVAL_MS);
            });
          }
        })();
      }
    });
  }

  /**
   * Mints a single-use UI bootstrap token (`#t=<bootstrapToken>`) from the local
   * Hub daemon using the master `csrfToken` from `daemon/hub_<port>.json`.
   */
  protected mintBootstrapToken(
    port: number,
    csrfToken: string,
    timeoutMs: number = 1500,
  ): Promise<{ token: string | null; unsupported?: boolean }> {
    return new Promise((resolve) => {
      let req: http.ClientRequest;
      try {
        req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/auth/mint',
            method: 'POST',
            headers: {
              'x-codeium-csrf-token': csrfToken,
              'Content-Length': '0',
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status === 404 || status === 405) {
              res.resume();
              resolve({ token: null, unsupported: true });
              return;
            }
            if (status < 200 || status >= 300) {
              res.resume();
              resolve({ token: null });
              return;
            }
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            res.on('data', (chunk: Buffer) => {
              totalBytes += chunk.length;
              if (totalBytes <= 4096) {
                chunks.push(chunk);
              } else {
                res.destroy();
                resolve({ token: null });
              }
            });
            res.on('end', () => {
              if (totalBytes > 4096) {
                resolve({ token: null });
                return;
              }
              try {
                const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (
                  typeof raw === 'object' &&
                  raw !== null &&
                  'bootstrapToken' in raw &&
                  typeof raw.bootstrapToken === 'string'
                ) {
                  const token = raw.bootstrapToken.trim();
                  resolve({ token: token || null });
                  return;
                }
              } catch {
                // Ignore malformed JSON response
              }
              resolve({ token: null });
            });
            res.on('error', () => resolve({ token: null }));
          },
        );
      } catch {
        resolve({ token: null });
        return;
      }
      req.on('error', () => resolve({ token: null }));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve({ token: null });
      });
      req.end();
    });
  }

  /** Recent hub output, useful for diagnosing a failed start. */
  getRecentOutput(): string {
    return this.recentOutput.join('\n');
  }

  protected assertPortAvailable(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`Port ${port} is already in use by another process.`)
            : err,
        );
      });
      srv.listen(port, '127.0.0.1', () => {
        srv.close((err) => (err ? reject(err) : resolve()));
      });
    });
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
    const { port, timeoutMs = 15000, child = this.hubProcess, isCancelled } = options;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (isCancelled?.()) {
        throw new Error('Antigravity hub start was cancelled.');
      }
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

      if (isCancelled?.()) {
        throw new Error('Antigravity hub start was cancelled.');
      }
      if (isListening) return;
      await new Promise((r) => window.setTimeout(r, 250));
    }

    throw new Error(`Timed out waiting for Antigravity hub to listen on port ${port}`);
  }
}

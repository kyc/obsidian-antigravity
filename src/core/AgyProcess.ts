import { ChildProcess, execFileSync, spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * stdio configuration. Defaults to ['ignore', 'pipe', 'pipe'].
   *
   * stdin is 'ignore' rather than 'pipe' on purpose: a piped stdin that is
   * never written to nor closed stays open forever, so a child that reads it
   * (agy does, via --input-format) blocks indefinitely instead of failing.
   * 'ignore' gives the child an immediate EOF.
   */
  stdio?: SpawnOptions['stdio'];
}

/** Handle for cancelling a pending SIGKILL escalation timer. */
export interface KillEscalation {
  cancel(): void;
}

export interface ProcFsOperations {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, encoding: string): string;
}

export interface ExecOperations {
  execFileSync(cmd: string, args: string[], options: Record<string, unknown>): string | Buffer;
}

export class AgyProcess {
  /**
   * Formats proxy environment variables based on the given proxy URL.
   * Sets HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and their lowercase variants.
   * Always includes NO_PROXY/no_proxy to bypass local addresses (e.g. hub daemon).
   */
  static formatProxyEnv(proxyUrl?: string, baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const result: Record<string, string> = {};
    const trimmed = proxyUrl?.trim();
    if (trimmed) {
      const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
      result.HTTP_PROXY = normalized;
      result.HTTPS_PROXY = normalized;
      result.ALL_PROXY = normalized;
      result.http_proxy = normalized;
      result.https_proxy = normalized;
      result.all_proxy = normalized;

      const noProxyVal = baseEnv.NO_PROXY || baseEnv.no_proxy || '127.0.0.1,localhost';
      const noProxyParts = noProxyVal.split(',').map((s) => s.trim()).filter(Boolean);
      if (!noProxyParts.includes('127.0.0.1')) noProxyParts.push('127.0.0.1');
      if (!noProxyParts.includes('localhost')) noProxyParts.push('localhost');
      const finalNoProxy = noProxyParts.join(',');
      result.NO_PROXY = finalNoProxy;
      result.no_proxy = finalNoProxy;
    }
    return result;
  }

  static getEnrichedEnv(additionalEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env, ...additionalEnv };
    const home = os.homedir();
    const delimiter = process.platform === 'win32' ? ';' : ':';

    const extraPaths = [
      path.join(home, '.local', 'bin'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.asdf', 'shims'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
    ];

    // On Windows, environment variable keys are case-insensitive.
    // In Node.js, spreading process.env ({ ...process.env }) creates a plain object
    // where the key is typically 'Path' rather than 'PATH'. Reading only env.PATH
    // results in undefined, wiping out the system PATH and breaking child execution.
    const addPathKey = Object.keys(additionalEnv).find((k) => k.toLowerCase() === 'path');
    const envPathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const activeKey = addPathKey || envPathKey;
    const currentPath = (addPathKey ? additionalEnv[addPathKey] : env[envPathKey]) || '';

    const newPaths = extraPaths.filter((p) => !currentPath.split(delimiter).includes(p));
    const enrichedPath = [...newPaths, currentPath].filter(Boolean).join(delimiter);

    env[activeKey] = enrichedPath;
    if (process.platform === 'win32') {
      env.PATH = enrichedPath;
      env.Path = enrichedPath;
    }

    return env;
  }

  static spawnProcess(spec: SpawnSpec, options: SpawnOptions = {}): ChildProcess {
    const enrichedEnv = this.getEnrichedEnv(spec.env || {});

    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: enrichedEnv,
      stdio: spec.stdio || ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    return child;
  }

  /**
   * Checks whether a process with the given PID is currently alive and accessible.
   */
  static isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /**
   * Delivers a termination signal to a process, optionally targeting its process group.
   */
  static killPid(pid: number, killProcessGroup = false, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!pid || pid <= 0) return false;
    const useGroup = Boolean(killProcessGroup && process.platform !== 'win32');
    if (useGroup) {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        // Fall back to direct process signal
      }
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Terminate a PID gracefully with SIGTERM, escalating to SIGKILL if still alive after timeout.
   */
  static async terminatePid(pid: number, killProcessGroup = false, timeoutMs = 1500): Promise<boolean> {
    if (!this.isPidAlive(pid)) return true;
    this.killPid(pid, killProcessGroup, 'SIGTERM');

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.isPidAlive(pid)) return true;
      await new Promise((r) => window.setTimeout(r, 50));
    }

    if (this.isPidAlive(pid)) {
      this.killPid(pid, killProcessGroup, 'SIGKILL');
    }
    return !this.isPidAlive(pid);
  }

  /**
   * Finds running agy --hub daemon process PIDs targeting a specific profile directory.
   */
  static findAgyHubProcesses(
    safeProfile: string,
    fsOps?: ProcFsOperations,
    execOps?: ExecOperations,
  ): number[] {
    const pids: number[] = [];
    const currentPid = process.pid;
    const fsReader = fsOps || fs;
    const execRunner = execOps || {
      execFileSync: (cmd: string, args: string[], opts: Record<string, unknown>) =>
        execFileSync(cmd, args, opts),
    };

    if (process.platform === 'linux' && fsReader.existsSync('/proc')) {
      try {
        const entries = fsReader.readdirSync('/proc');
        for (const entry of entries) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = parseInt(entry, 10);
          if (pid === currentPid) continue;

          try {
            const cmdline = fsReader.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
            const args = cmdline.split('\0').filter(Boolean);
            if (args.length === 0) continue;

            const exe = args[0];
            const isAgy = exe === 'agy' || exe.endsWith('/agy') || exe.endsWith('\\agy.exe');
            if (!isAgy) continue;

            const hasHub = args.includes('--hub');
            const hasProfile = args.some(
              (arg) => arg === `--app_data_dir=${safeProfile}`,
            );

            if (hasHub && hasProfile) {
              pids.push(pid);
            }
          } catch {
            // Process may have exited between readdir and readFileSync
          }
        }
        return pids;
      } catch {
        // Fall back to ps inspection
      }
    }

    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        const rawOutput = execRunner.execFileSync('ps', ['-A', '-o', 'pid,args'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const output = typeof rawOutput === 'string' ? rawOutput : rawOutput.toString('utf8');
        const lines = output.split('\n');
        const escapedProfile = safeProfile.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const profileRegex = new RegExp(`(?:^|\\s)--app_data_dir=${escapedProfile}(?:\\s|$)`);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const pid = parseInt(match[1], 10);
          if (pid === currentPid) continue;
          const cmd = match[2];
          if (
            !cmd.includes('node ') &&
            (cmd.includes('/agy ') || cmd.startsWith('agy ')) &&
            cmd.includes('--hub') &&
            profileRegex.test(cmd)
          ) {
            if (!pids.includes(pid)) {
              pids.push(pid);
            }
          }
        }
      } catch {
        // Fallback execution failed, return discovered pids so far
      }
    }

    return pids;
  }

  /**
   * Sends SIGTERM, escalating to SIGKILL after a grace period when the process
   * has not exited. When killProcessGroup is true on non-Windows platforms, signals
   * are sent to the negative PID (-pid) to terminate the entire process group.
   * The returned handle cancels the escalation timer, so callers (and tests)
   * can release it instead of leaving a dangling timer behind.
   */
  static killProcess(child: ChildProcess | null, killProcessGroup = false): KillEscalation {
    const noop: KillEscalation = { cancel: () => {} };
    if (!child) return noop;
    const hasExited = (): boolean =>
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined);
    if (hasExited() || child.killed) return noop;

    const pid = child.pid;
    const useGroup = Boolean(killProcessGroup && pid && process.platform !== 'win32');

    const sendSignal = (signal: NodeJS.Signals) => {
      if (useGroup && pid) {
        try {
          process.kill(-pid, signal);
        } catch {
          // Process group may already have exited or failed, fallback to direct child.kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Ignore
      }
    };

    let exited = false;
    let timer: number | null = null;

    const detachExitListener = () => {
      if (typeof child.off === 'function') {
        child.off('exit', onExit);
      } else if (typeof child.removeListener === 'function') {
        child.removeListener('exit', onExit);
      }
    };

    const cancel = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      detachExitListener();
    };

    const onExit = () => {
      exited = true;
      cancel();
    };

    if (typeof child.once === 'function') {
      child.once('exit', onExit);
    }

    try {
      sendSignal('SIGTERM');
    } catch {
      detachExitListener();
      return noop;
    }

    if (exited || hasExited()) {
      detachExitListener();
      return noop;
    }

    timer = window.setTimeout(() => {
      timer = null;
      detachExitListener();
      if (!exited && !hasExited()) {
        sendSignal('SIGKILL');
      }
    }, 2000);

    // The escalation is a best-effort backstop, so it must never keep the host
    // process alive on its own account (relevant in Node/Jest runtimes where
    // setTimeout returns a Timeout object with unref()).
    const maybeNodeTimer: unknown = timer;
    if (typeof maybeNodeTimer === 'object' && maybeNodeTimer !== null && 'unref' in maybeNodeTimer) {
      (maybeNodeTimer as { unref: () => void }).unref();
    }

    return { cancel };
  }
}

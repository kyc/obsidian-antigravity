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

export class AgyProcess {
  static getEnrichedEnv(additionalEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env, ...additionalEnv };
    const home = os.homedir();
    const delimiter = process.platform === 'win32' ? ';' : ':';

    const extraPaths = [
      path.join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
    ];

    const currentPath = env.PATH || '';
    const newPaths = extraPaths.filter((p) => !currentPath.split(delimiter).includes(p));
    env.PATH = [...newPaths, currentPath].filter(Boolean).join(delimiter);

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
  static findAgyHubProcesses(safeProfile: string): number[] {
    const pids: number[] = [];
    const currentPid = process.pid;

    if (process.platform === 'linux' && fs.existsSync('/proc')) {
      try {
        const entries = fs.readdirSync('/proc');
        for (const entry of entries) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = parseInt(entry, 10);
          if (pid === currentPid) continue;

          try {
            const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
            const args = cmdline.split('\0').filter(Boolean);
            if (args.length === 0) continue;

            const exe = args[0];
            const isAgy = exe === 'agy' || exe.endsWith('/agy') || exe.endsWith('\\agy.exe');
            if (!isAgy) continue;

            const hasHub = args.includes('--hub');
            const hasProfile = args.some(
              (arg) => arg === `--app_data_dir=${safeProfile}` || arg.startsWith(`--app_data_dir=${safeProfile}`),
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
        const output = execFileSync('ps', ['-A', '-o', 'pid,args'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = output.split('\n');
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
            cmd.includes(`--app_data_dir=${safeProfile}`)
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
    if (!child || child.killed) return noop;

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

    try {
      sendSignal('SIGTERM');
    } catch {
      return noop;
    }

    const timer = window.setTimeout(() => {
      if (!child.killed) {
        sendSignal('SIGKILL');
      }
    }, 2000);

    // The escalation is a best-effort backstop, so it must never keep the host
    // process alive on its own account.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }

    return {
      cancel: () => {
        window.clearTimeout(timer);
      },
    };
  }
}

import { ChildProcess, spawn, SpawnOptions } from 'child_process';
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
          return;
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

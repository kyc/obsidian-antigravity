import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export interface SpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
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
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });

    return child;
  }

  static killProcess(child: ChildProcess | null): void {
    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
      window.setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
      }, 2000);
    } catch {
      // Ignore kill error
    }
  }
}

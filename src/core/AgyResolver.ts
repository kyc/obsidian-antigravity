import { execFile, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FsOperations {
  existsSync(p: string): boolean;
  statSync(p: string): { isFile(): boolean };
  accessSync(p: string, mode: number): void;
}

export class AgyResolver {
  private cachedPath: string | null = null;
  private fsOps: FsOperations;

  constructor(fsOps?: FsOperations) {
    this.fsOps = fsOps || {
      existsSync: (p) => fs.existsSync(p),
      statSync: (p) => fs.statSync(p),
      accessSync: (p, mode) => fs.accessSync(p, mode),
    };
  }

  resolve(configuredPath?: string): string | null {
    if (configuredPath && configuredPath.trim().length > 0) {
      const trimmed = configuredPath.trim();
      if (this.isExecutable(trimmed)) {
        this.cachedPath = trimmed;
        return trimmed;
      }
    }

    if (this.cachedPath && this.isExecutable(this.cachedPath)) {
      return this.cachedPath;
    }

    // Well-known binary paths
    const home = os.homedir();
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'agy.exe' : 'agy';

    const candidatePaths: string[] = [
      path.join(home, '.local', 'bin', binaryName),
      path.join('/usr', 'local', 'bin', binaryName),
      path.join('/usr', 'bin', binaryName),
      path.join('/opt', 'homebrew', 'bin', binaryName),
    ];

    if (isWindows) {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        candidatePaths.push(path.join(localAppData, 'Programs', 'antigravity', binaryName));
      }
    }

    for (const candidate of candidatePaths) {
      if (this.isExecutable(candidate)) {
        this.cachedPath = candidate;
        return candidate;
      }
    }

    // Fallback: which/where
    try {
      const cmd = isWindows ? 'where agy' : 'which agy';
      const output = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
      const firstLine = output.split('\n')[0]?.trim();
      if (firstLine && this.isExecutable(firstLine)) {
        this.cachedPath = firstLine;
        return firstLine;
      }
    } catch {
      // Ignore fallback lookup errors
    }

    return null;
  }

  async testExecutable(targetPath: string): Promise<{ success: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      execFile(targetPath, ['--version'], { timeout: 3000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: error.message || stderr || 'Failed to execute agy binary',
          });
          return;
        }
        const version = stdout.trim() || stderr.trim() || 'OK';
        resolve({
          success: true,
          version,
        });
      });
    });
  }

  clearCache(): void {
    this.cachedPath = null;
  }

  private isExecutable(filePath: string): boolean {
    try {
      if (!this.fsOps.existsSync(filePath)) return false;
      const stats = this.fsOps.statSync(filePath);
      if (!stats.isFile()) return false;
      // On POSIX, check execute permission
      if (process.platform !== 'win32') {
        this.fsOps.accessSync(filePath, fs.constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }
}

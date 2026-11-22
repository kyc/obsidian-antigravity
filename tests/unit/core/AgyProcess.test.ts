import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { AgyProcess } from '../../../src/core/AgyProcess';

describe('AgyProcess', () => {
  describe('getEnrichedEnv', () => {
    it('enriches PATH with well-known binary directories', () => {
      const originalPath = '/bin:/usr/bin';
      const home = os.homedir();
      const localBin = path.join(home, '.local', 'bin');

      const env = AgyProcess.getEnrichedEnv({ PATH: originalPath });

      expect(env.PATH).toContain(localBin);
      expect(env.PATH).toContain('/usr/local/bin');
    });

    it('merges additional environment variables', () => {
      const env = AgyProcess.getEnrichedEnv({
        CUSTOM_VAR: 'hello-antigravity',
      });

      expect(env.CUSTOM_VAR).toBe('hello-antigravity');
    });

    it('handles case-insensitive Path on Windows without wiping system directories', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const windowsSystemPath = 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
        const env = AgyProcess.getEnrichedEnv({ Path: windowsSystemPath });

        expect(env.Path).toContain('C:\\Windows\\system32');
        expect(env.Path).toContain('WindowsPowerShell');
        expect(env.PATH).toBe(env.Path);
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });

    it('populates both PATH and Path on Windows for child process compatibility', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const env = AgyProcess.getEnrichedEnv({ PATH: 'C:\\test\\bin' });

        expect(env.PATH).toBeDefined();
        expect(env.Path).toBeDefined();
        expect(env.PATH).toBe(env.Path);
        expect(env.PATH).toContain('C:\\test\\bin');
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });

    it('prefers an explicitly supplied path key over the inherited one', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        Object.defineProperty(process.env, 'Path', {
          value: 'C:\\Inherited',
          configurable: true,
          writable: true,
        });

        const env = AgyProcess.getEnrichedEnv({ PATH: 'C:\\Explicit' });

        expect(env.PATH).toContain('C:\\Explicit');
        expect(env.PATH).not.toContain('C:\\Inherited');
        expect(env.Path).toBe(env.PATH);
      } finally {
        delete process.env.Path;
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });
  });

  describe('formatProxyEnv', () => {
    it('returns empty object when proxyUrl is empty or whitespace', () => {
      expect(AgyProcess.formatProxyEnv('')).toEqual({});
      expect(AgyProcess.formatProxyEnv('   ')).toEqual({});
      expect(AgyProcess.formatProxyEnv(undefined)).toEqual({});
    });

    it('defaults protocol to http:// if missing', () => {
      const env = AgyProcess.formatProxyEnv('127.0.0.1:7897', {});
      expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
      expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
      expect(env.ALL_PROXY).toBe('http://127.0.0.1:7897');
      expect(env.http_proxy).toBe('http://127.0.0.1:7897');
      expect(env.https_proxy).toBe('http://127.0.0.1:7897');
      expect(env.all_proxy).toBe('http://127.0.0.1:7897');
      expect(env.NO_PROXY).toBe('127.0.0.1,localhost');
      expect(env.no_proxy).toBe('127.0.0.1,localhost');
    });

    it('preserves specified protocols like socks5 and https', () => {
      const env = AgyProcess.formatProxyEnv('socks5://127.0.0.1:1080', {});
      expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:1080');
      expect(env.HTTP_PROXY).toBe('socks5://127.0.0.1:1080');
    });

    it('preserves existing NO_PROXY domains while ensuring localhost and 127.0.0.1 are present', () => {
      const env = AgyProcess.formatProxyEnv('http://proxy.example.com:8080', {
        NO_PROXY: 'internal.corp,myvault.local',
      });
      expect(env.NO_PROXY).toBe('internal.corp,myvault.local,127.0.0.1,localhost');
      expect(env.no_proxy).toBe('internal.corp,myvault.local,127.0.0.1,localhost');
    });
  });
});

describe('AgyProcess.spawnProcess stdio defaults', () => {
  it('gives the child an ignored stdin so a prompt cannot hang it', () => {
    const cp = require('child_process');
    const spawnSpy = jest.spyOn(cp, 'spawn').mockReturnValue({} as any);

    AgyProcess.spawnProcess({ executable: '/bin/agy', args: ['--print', 'x'], cwd: '/tmp' });

    const opts = spawnSpy.mock.calls[0][2];
    // stdin must be 'ignore': a piped stdin that is never closed leaves a
    // child that reads it (agy does) blocked forever instead of seeing EOF.
    expect(opts.stdio[0]).toBe('ignore');
    expect(opts.stdio[1]).toBe('pipe');
    expect(opts.stdio[2]).toBe('pipe');

    spawnSpy.mockRestore();
  });

  it('honours an explicit stdio override', () => {
    const cp = require('child_process');
    const spawnSpy = jest.spyOn(cp, 'spawn').mockReturnValue({} as any);

    AgyProcess.spawnProcess({
      executable: '/bin/agy',
      args: [],
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(spawnSpy.mock.calls[0][2].stdio[0]).toBe('pipe');
    spawnSpy.mockRestore();
  });
});

describe('AgyProcess.killProcess', () => {
  it('returns noop when child is null or already killed', () => {
    const handle = AgyProcess.killProcess(null);
    expect(typeof handle.cancel).toBe('function');
    handle.cancel();

    const killedChild = { killed: true, kill: jest.fn() } as any;
    const handle2 = AgyProcess.killProcess(killedChild);
    expect(killedChild.kill).not.toHaveBeenCalled();
    handle2.cancel();

    const exitedChild = { killed: false, exitCode: 0, signalCode: null, kill: jest.fn() } as any;
    const handle3 = AgyProcess.killProcess(exitedChild);
    expect(exitedChild.kill).not.toHaveBeenCalled();
    handle3.cancel();

    const signaledChild = { killed: false, exitCode: null, signalCode: 'SIGTERM', kill: jest.fn() } as any;
    const handle4 = AgyProcess.killProcess(signaledChild);
    expect(signaledChild.kill).not.toHaveBeenCalled();
    handle4.cancel();
  });

  it('sends SIGTERM to child by default', () => {
    const child = { killed: false, exitCode: null, signalCode: null, pid: 1234, kill: jest.fn() } as any;
    const handle = AgyProcess.killProcess(child);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    handle.cancel();
  });

  it('escalates to SIGKILL after grace period even when SIGTERM sets child.killed = true', () => {
    jest.useFakeTimers();
    const origPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const processKillSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
      const child: any = new EventEmitter();
      child.pid = 4321;
      child.killed = false;
      child.exitCode = null;
      child.signalCode = null;
      // Mirror real Node.js ChildProcess.kill(): sets child.killed = true synchronously on delivery.
      child.kill = jest.fn(() => {
        child.killed = true;
        return true;
      });

      const handle = AgyProcess.killProcess(child, true);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(processKillSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(child.killed).toBe(true);

      jest.advanceTimersByTime(1999);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      jest.advanceTimersByTime(1);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(processKillSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');

      handle.cancel();
      processKillSpy.mockRestore();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      jest.useRealTimers();
    }
  });

  it('cancels SIGKILL escalation automatically when child emits exit before timeout', () => {
    jest.useFakeTimers();
    try {
      const child: any = new EventEmitter();
      child.pid = 4322;
      child.killed = false;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = jest.fn(() => {
        child.killed = true;
        return true;
      });

      AgyProcess.killProcess(child);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      child.exitCode = 0;
      child.emit('exit', 0, null);

      jest.advanceTimersByTime(2500);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends signals to process group when killProcessGroup is true on non-Windows', () => {
    const origPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
      const child = { killed: false, pid: 5678, kill: jest.fn() } as any;

      const handle = AgyProcess.killProcess(child, true);
      expect(killSpy).toHaveBeenCalledWith(-5678, 'SIGTERM');
      handle.cancel();
      killSpy.mockRestore();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });
});

describe('AgyProcess PID utilities', () => {
  describe('isPidAlive', () => {
    it('returns false for non-positive or falsy pid', () => {
      expect(AgyProcess.isPidAlive(0)).toBe(false);
      expect(AgyProcess.isPidAlive(-1)).toBe(false);
    });

    it('returns true when process.kill(pid, 0) succeeds', () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
      expect(AgyProcess.isPidAlive(9999)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(9999, 0);
      killSpy.mockRestore();
    });

    it('returns true when process.kill(pid, 0) throws EPERM', () => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw err;
      });
      expect(AgyProcess.isPidAlive(9999)).toBe(true);
      killSpy.mockRestore();
    });

    it('returns false when process.kill(pid, 0) throws ESRCH', () => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw err;
      });
      expect(AgyProcess.isPidAlive(9999)).toBe(false);
      killSpy.mockRestore();
    });
  });

  describe('killPid', () => {
    it('returns false for invalid pid', () => {
      expect(AgyProcess.killPid(0)).toBe(false);
    });

    it('sends direct signal when killProcessGroup is false', () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
      expect(AgyProcess.killPid(1234, false, 'SIGTERM')).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
      killSpy.mockRestore();
    });

    it('sends group signal when killProcessGroup is true on non-Windows', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
        expect(AgyProcess.killPid(1234, true, 'SIGKILL')).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
        killSpy.mockRestore();
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });
  });

  describe('terminatePid', () => {
    it('returns true immediately if pid is not alive', async () => {
      jest.spyOn(AgyProcess, 'isPidAlive').mockReturnValue(false);
      const result = await AgyProcess.terminatePid(1234);
      expect(result).toBe(true);
      (AgyProcess.isPidAlive as jest.Mock).mockRestore();
    });

    it('sends SIGTERM and waits until process exits', async () => {
      let calls = 0;
      jest.spyOn(AgyProcess, 'isPidAlive').mockImplementation(() => {
        calls++;
        return calls <= 2;
      });
      const killSpy = jest.spyOn(AgyProcess, 'killPid').mockReturnValue(true);

      const result = await AgyProcess.terminatePid(1234, false, 500);
      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(1234, false, 'SIGTERM');
      (AgyProcess.isPidAlive as jest.Mock).mockRestore();
      killSpy.mockRestore();
    });
  });

  describe('findAgyHubProcesses', () => {
    it('matches exact profile and avoids prefix-matching collision in /proc', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const mockFsOps = {
          existsSync: (p: string) => p === '/proc',
          readdirSync: (p: string) => (p === '/proc' ? ['81923', '81924', '81925', 'not-a-pid'] : []),
          readFileSync: (p: string) => {
            if (p === '/proc/81923/cmdline') {
              return 'agy\0--hub\0--app_data_dir=probe-pfx\0';
            }
            if (p === '/proc/81924/cmdline') {
              return 'agy\0--hub\0--app_data_dir=probe-pfx-2\0';
            }
            if (p === '/proc/81925/cmdline') {
              return 'agy\0--hub\0--app_data_dir=probe-pfx_work\0';
            }
            return '';
          },
        };

        const pids = AgyProcess.findAgyHubProcesses('probe-pfx', mockFsOps);
        expect(pids).toEqual([81923]);
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });

    it('matches exact profile and avoids prefix-matching collision in ps fallback', () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const mockFsOps = {
          existsSync: () => false,
          readdirSync: () => [],
          readFileSync: () => '',
        };
        const mockExecOps = {
          execFileSync: () =>
            '81923 /usr/bin/agy --hub --app_data_dir=probe-pfx --hub-port=4000\n' +
            '81924 /usr/bin/agy --hub --app_data_dir=probe-pfx-2 --hub-port=4001\n' +
            '81925 /usr/bin/agy --hub --app_data_dir=probe-pfx_work --hub-port=4002\n',
        };

        const pids = AgyProcess.findAgyHubProcesses('probe-pfx', mockFsOps, mockExecOps);
        expect(pids).toEqual([81923]);
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });
  });
});


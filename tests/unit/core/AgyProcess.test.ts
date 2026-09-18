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
  });

  it('sends SIGTERM to child by default', () => {
    const child = { killed: false, pid: 1234, kill: jest.fn() } as any;
    const handle = AgyProcess.killProcess(child);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    handle.cancel();
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


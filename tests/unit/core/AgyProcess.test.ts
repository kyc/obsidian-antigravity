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

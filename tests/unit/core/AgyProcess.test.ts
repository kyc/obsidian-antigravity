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

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

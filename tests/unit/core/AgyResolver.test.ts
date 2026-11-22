import { AgyResolver, FsOperations } from '../../../src/core/AgyResolver';

describe('AgyResolver', () => {
  let mockFsOps: jest.Mocked<FsOperations>;
  let resolver: AgyResolver;

  beforeEach(() => {
    mockFsOps = {
      existsSync: jest.fn(),
      statSync: jest.fn(),
      accessSync: jest.fn(),
    };
    resolver = new AgyResolver(mockFsOps);
  });

  it('returns configured path if file exists and is executable', () => {
    mockFsOps.existsSync.mockReturnValue(true);
    mockFsOps.statSync.mockReturnValue({ isFile: () => true });
    mockFsOps.accessSync.mockReturnValue(undefined);

    const resolved = resolver.resolve('/custom/path/to/agy');
    expect(resolved).toBe('/custom/path/to/agy');
  });

  it('caches the resolved path on subsequent calls', () => {
    mockFsOps.existsSync.mockReturnValue(true);
    mockFsOps.statSync.mockReturnValue({ isFile: () => true });
    mockFsOps.accessSync.mockReturnValue(undefined);

    const first = resolver.resolve('/custom/path/to/agy');
    const second = resolver.resolve();
    expect(second).toBe(first);
  });

  it('clears cache when clearCache is called', () => {
    mockFsOps.existsSync.mockReturnValue(true);
    mockFsOps.statSync.mockReturnValue({ isFile: () => true });
    mockFsOps.accessSync.mockReturnValue(undefined);

    resolver.resolve('/custom/path/to/agy');
    resolver.clearCache();

    mockFsOps.existsSync.mockReturnValue(false);
    const resolved = resolver.resolve('/nonexistent/path');
    expect(resolved).toBeNull();
  });

  it('does not silently fall back to cached path when an explicit configuredPath is invalid', () => {
    mockFsOps.existsSync.mockImplementation((p) => p === '/usr/local/bin/agy');
    mockFsOps.statSync.mockReturnValue({ isFile: () => true });
    mockFsOps.accessSync.mockReturnValue(undefined);

    // First auto-detect caches /usr/local/bin/agy
    expect(resolver.resolve('')).toBe('/usr/local/bin/agy');

    // User sets an invalid custom path: must return null instead of stale cached binary
    expect(resolver.resolve('/wrong/path/agy')).toBeNull();
  });

  it('returns to auto-detection after clearing cache when custom path is emptied', () => {
    mockFsOps.existsSync.mockImplementation(
      (p) => p === '/custom/old/agy' || p === '/usr/local/bin/agy',
    );
    mockFsOps.statSync.mockReturnValue({ isFile: () => true });
    mockFsOps.accessSync.mockReturnValue(undefined);

    expect(resolver.resolve('/custom/old/agy')).toBe('/custom/old/agy');

    resolver.clearCache();
    expect(resolver.resolve('')).toBe('/usr/local/bin/agy');
  });

  describe('failed lookup caching', () => {
    const failFs = () => {
      mockFsOps.existsSync.mockReturnValue(false);
      mockFsOps.statSync.mockReturnValue({ isFile: () => false });
      mockFsOps.accessSync.mockImplementation(() => {
        throw new Error('not executable');
      });
    };

    const stubExecSync = () => {
      const cp = require('child_process');
      const real = cp.execSync;
      const state = { count: 0 };
      cp.execSync = () => {
        state.count += 1;
        const err: any = new Error('not found');
        err.status = 1;
        throw err;
      };
      return { state, restore: () => { cp.execSync = real; } };
    };

    it('does not repeat the synchronous which fallback on every call', () => {
      failFs();
      const stub = stubExecSync();
      try {
        for (let i = 0; i < 5; i++) {
          expect(resolver.resolve()).toBeNull();
        }
      } finally {
        stub.restore();
      }

      // First call performs the lookup; the rest are served from the
      // not-found cache instead of blocking the UI thread again.
      expect(stub.state.count).toBe(1);
    });

    it('retries the lookup after clearCache', () => {
      failFs();
      const stub = stubExecSync();
      try {
        resolver.resolve();
        resolver.clearCache();
        resolver.resolve();
      } finally {
        stub.restore();
      }

      expect(stub.state.count).toBe(2);
    });

    it('lets a configured path short-circuit a cached miss', () => {
      failFs();
      const stub = stubExecSync();
      try {
        expect(resolver.resolve()).toBeNull();

        mockFsOps.existsSync.mockReturnValue(true);
        mockFsOps.statSync.mockReturnValue({ isFile: () => true });
        mockFsOps.accessSync.mockReturnValue(undefined);

        expect(resolver.resolve('/now/installed/agy')).toBe('/now/installed/agy');
      } finally {
        stub.restore();
      }
    });
  });
});

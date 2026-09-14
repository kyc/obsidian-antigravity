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
});

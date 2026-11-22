import { App, WorkspaceLeaf } from 'obsidian';
import { AgyHubManager } from '../../../src/core/AgyHubManager';
import { ANTIGRAVITY_HUB_VIEW_TYPE, HubView } from '../../../src/ui/HubView';

jest.mock('../../../src/core/AgyHubManager');

describe('HubView', () => {
  let mockHubManager: jest.Mocked<AgyHubManager>;
  let mockLeaf: any;
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockHubManager = new AgyHubManager() as jest.Mocked<AgyHubManager>;
    mockHubManager.isRunning = jest.fn().mockReturnValue(false);
    mockHubManager.getHubUrl = jest.fn().mockReturnValue('http://127.0.0.1:4096?section=test');
    mockHubManager.getExecutable = jest.fn().mockReturnValue('/usr/bin/agy');
    mockHubManager.getCurrentProfile = jest.fn().mockReturnValue('antigravity-obsidian');
    mockHubManager.getVaultPath = jest.fn().mockReturnValue('/mock/vault');
    mockHubManager.getDangerouslySkipPermissions = jest.fn().mockReturnValue(false);
    mockHubManager.getProxyUrl = jest.fn().mockReturnValue('');
    mockHubManager.getDefaultAgent = jest.fn().mockReturnValue('');
    mockHubManager.getPreferredPort = jest.fn().mockReturnValue(4096);
    mockHubManager.matchesRunningConfig = jest.fn().mockImplementation((cfg: any) => {
      const safeProfile = String(cfg.profile || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'antigravity-obsidian';
      const safeProxy = (cfg.proxyUrl || '').trim();
      const safeAgent = (cfg.defaultAgent || '').trim();
      const preferredPort = cfg.preferredPort ?? 0;
      const runningExec = mockHubManager.getExecutable();
      return (
        mockHubManager.isRunning() &&
        (cfg.executable === undefined || runningExec === '' || runningExec === cfg.executable) &&
        mockHubManager.getCurrentProfile() === safeProfile &&
        mockHubManager.getVaultPath() === cfg.vaultPath &&
        mockHubManager.getDangerouslySkipPermissions() === cfg.dangerouslySkipPermissions &&
        mockHubManager.getProxyUrl() === safeProxy &&
        mockHubManager.getDefaultAgent() === safeAgent &&
        mockHubManager.getPreferredPort() === preferredPort
      );
    });
    mockHubManager.startHub = jest.fn().mockResolvedValue('http://127.0.0.1:4096?section=test');

    mockApp = new App();
    mockLeaf = {
      app: mockApp,
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { activeDocument?: unknown }).activeDocument;
  });

  it('has the correct view type and display text', () => {
    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    expect(view.getViewType()).toBe(ANTIGRAVITY_HUB_VIEW_TYPE);
    expect(view.getIcon()).toBe('sparkles');
    expect(view.getDisplayText()).toBeDefined();
  });

  it('defers hub startup when workspace layout is not ready on boot', async () => {
    mockApp.workspace.layoutReady = false;
    let layoutReadyCallback: (() => void) | null = null;
    mockApp.workspace.onLayoutReady = jest.fn().mockImplementation((cb: () => void) => {
      layoutReadyCallback = cb;
    });

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();

    // Hub start must NOT be called before layoutReady
    expect(mockHubManager.startHub).not.toHaveBeenCalled();
    expect(mockApp.workspace.onLayoutReady).toHaveBeenCalled();

    // Trigger onLayoutReady callback and advance timers for micro-delay
    expect(layoutReadyCallback).not.toBeNull();
    if (layoutReadyCallback) {
      (layoutReadyCallback as () => void)();
    }
    jest.advanceTimersByTime(100);

    // Yield promises
    await Promise.resolve();

    expect(mockHubManager.startHub).toHaveBeenCalledWith(
      '/usr/bin/agy',
      '/mock/vault',
      4096,
      'antigravity-obsidian',
      undefined,
      false,
      '',
    );
  });

  it('starts hub immediately when workspace layout is already ready', async () => {
    mockApp.workspace.layoutReady = true;

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    await Promise.resolve();

    expect(mockHubManager.startHub).toHaveBeenCalledWith(
      '/usr/bin/agy',
      '/mock/vault',
      4096,
      'antigravity-obsidian',
      undefined,
      false,
      '',
    );
  });

  it('does not start hub if closed before layout ready triggers', async () => {
    mockApp.workspace.layoutReady = false;
    let layoutReadyCallback: (() => void) | null = null;
    mockApp.workspace.onLayoutReady = jest.fn().mockImplementation((cb: () => void) => {
      layoutReadyCallback = cb;
    });

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    await view.onClose();

    if (layoutReadyCallback) {
      (layoutReadyCallback as () => void)();
    }
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(mockHubManager.startHub).not.toHaveBeenCalled();
  });

  it('cancels startup timer when closed during the deferral delay', async () => {
    mockApp.workspace.layoutReady = false;
    let layoutReadyCallback: (() => void) | null = null;
    mockApp.workspace.onLayoutReady = jest.fn().mockImplementation((cb: () => void) => {
      layoutReadyCallback = cb;
    });

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();

    // Trigger onLayoutReady, which starts the 50ms startup timer
    if (layoutReadyCallback) {
      (layoutReadyCallback as () => void)();
    }

    // Advance 20ms (timer is active), then close the view
    jest.advanceTimersByTime(20);
    await view.onClose();

    // Advance beyond the remaining timer window
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(mockHubManager.startHub).not.toHaveBeenCalled();
  });

  it('can close cleanly without error when onOpen was never called', async () => {
    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await expect(view.onClose()).resolves.toBeUndefined();
  });

  it('reuses existing running hub without calling startHub again', async () => {
    mockApp.workspace.layoutReady = true;
    mockHubManager.isRunning = jest.fn().mockReturnValue(true);

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    await Promise.resolve();

    expect(mockHubManager.startHub).not.toHaveBeenCalled();
    expect(mockHubManager.getHubUrl).toHaveBeenCalled();
  });

  it('mounts Electron <webview> with sanitized partition, allowpopups, and bootstrap token URL', async () => {
    (globalThis as { activeDocument?: unknown }).activeDocument = {
      body: { classList: { contains: (cls: string) => cls === 'theme-dark' } },
    };
    mockApp.workspace.layoutReady = true;
    mockHubManager.getHubUrl = jest.fn().mockImplementation((opts?: { hostTheme?: 'dark' | 'light' }) => {
      const theme = opts?.hostTheme ?? 'light';
      return `http://127.0.0.1:4096/?section=test&hostTheme=${theme}&useWebSocket=true#t=boot-tok-123`;
    });

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => '../evil profile!',
    );

    await view.onOpen();
    await Promise.resolve();

    const webview = view.contentEl.children.find((el: any) => el.tagName === 'WEBVIEW');
    expect(webview).toBeDefined();
    expect(webview.className).toContain('antigravity-hub-webview');
    expect(webview.getAttribute('allowpopups')).toBe('');
    expect(webview.getAttribute('partition')).toBe('persist:antigravity-evilprofile');
    expect(webview.getAttribute('src')).toBe(
      'http://127.0.0.1:4096/?section=test&hostTheme=dark&useWebSocket=true#t=boot-tok-123',
    );
  });

  it('reloads <webview> via about:blank and respects isClosed when timer fires', async () => {
    mockApp.workspace.layoutReady = true;
    mockHubManager.isRunning = jest.fn().mockReturnValue(true);
    mockHubManager.getHubUrl = jest.fn().mockImplementation((opts?: { hostTheme?: 'dark' | 'light' }) => {
      const theme = opts?.hostTheme ?? 'light';
      return `http://127.0.0.1:4096/?section=test&hostTheme=${theme}&useWebSocket=true#t=tok-xyz`;
    });

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    view.onload();
    await view.onOpen();
    await Promise.resolve();

    const webview = view.contentEl.children.find((el: any) => el.tagName === 'WEBVIEW');
    expect(webview).toBeDefined();

    const reloadCall = (view.addAction as jest.Mock).mock.calls.find(
      (call) => call[0] === 'refresh-cw',
    );
    expect(reloadCall).toBeDefined();

    reloadCall[2]();
    expect(webview.getAttribute('src')).toBe('about:blank');

    jest.advanceTimersByTime(100);
    expect(webview.getAttribute('src')).toBe(
      'http://127.0.0.1:4096/?section=test&hostTheme=light&useWebSocket=true#t=tok-xyz',
    );

    // Trigger reload and close before timeout elapses: closed view should not restore src
    reloadCall[2]();
    expect(webview.getAttribute('src')).toBe('about:blank');
    await view.onClose();
    jest.advanceTimersByTime(100);
    expect(webview.getAttribute('src')).toBe('about:blank');
  });

  it('renders an error message with retry button when CLI executable is missing', async () => {
    mockApp.workspace.layoutReady = true;

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => null,
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    await Promise.resolve();

    const loadingBox = view.contentEl.children.find((el: any) =>
      el.className?.includes('antigravity-hub-loading'),
    );
    expect(loadingBox).toBeDefined();
    const errP = loadingBox.children.find((el: any) => el.tagName === 'P');
    expect(errP?.textContent).toContain('CLI');
    const retryBtn = loadingBox.children.find((el: any) => el.tagName === 'BUTTON');
    expect(retryBtn).toBeDefined();
    expect(retryBtn.type).toBe('button');
  });

  it('restarts hub via initHub when reloadWebview is triggered after config drift', async () => {
    mockApp.workspace.layoutReady = true;
    mockHubManager.isRunning = jest.fn().mockReturnValue(true);
    mockHubManager.getDangerouslySkipPermissions = jest.fn().mockReturnValue(true);
    mockHubManager.getDefaultAgent = jest.fn().mockReturnValue('');
    mockHubManager.getPreferredPort = jest.fn().mockReturnValue(4096);

    let allowUnrestricted = true;
    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
      () => '',
      () => allowUnrestricted,
      () => '',
    );

    view.onload();
    await view.onOpen();
    await Promise.resolve();
    expect(mockHubManager.startHub).not.toHaveBeenCalled();

    // User turns off unrestricted mode; reload action must restart hub instead of reusing unrestricted daemon
    allowUnrestricted = false;
    const reloadCall = (view.addAction as jest.Mock).mock.calls.find(
      (call) => call[0] === 'refresh-cw',
    );
    expect(reloadCall).toBeDefined();

    reloadCall[2]();
    await Promise.resolve();

    expect(mockHubManager.startHub).toHaveBeenCalledWith(
      '/usr/bin/agy',
      '/mock/vault',
      4096,
      'antigravity-obsidian',
      '',
      false,
      '',
    );
  });

  it('refreshHub re-initializes an open view and does nothing once closed', async () => {
    mockApp.workspace.layoutReady = true;
    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    await Promise.resolve();
    expect(mockHubManager.startHub).toHaveBeenCalledTimes(1);

    view.refreshHub();
    await Promise.resolve();
    expect(mockHubManager.startHub).toHaveBeenCalledTimes(2);

    await view.onClose();
    view.refreshHub();
    await Promise.resolve();
    expect(mockHubManager.startHub).toHaveBeenCalledTimes(2);
  });

  it('compares sanitized profile on fast path so unsanitized input does not needlessly restart hub', async () => {
    mockApp.workspace.layoutReady = true;
    mockHubManager.isRunning = jest.fn().mockReturnValue(true);
    mockHubManager.getCurrentProfile = jest.fn().mockReturnValue('evilprofile');
    mockHubManager.getDefaultAgent = jest.fn().mockReturnValue('');
    mockHubManager.getPreferredPort = jest.fn().mockReturnValue(4096);

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => '../evil profile!',
    );

    await view.onOpen();
    await Promise.resolve();

    expect(mockHubManager.startHub).not.toHaveBeenCalled();
  });

  it('cancels previous reload timer on repeated reload clicks and on close', async () => {
    mockApp.workspace.layoutReady = true;
    mockHubManager.isRunning = jest.fn().mockReturnValue(true);
    let urlCallCount = 0;
    mockHubManager.getHubUrl = jest.fn().mockImplementation(() => {
      urlCallCount += 1;
      return `http://127.0.0.1:4096/?call=${urlCallCount}`;
    });

    const clearTimeoutSpy = jest.spyOn(window, 'clearTimeout');
    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    view.onload();
    await view.onOpen();
    await Promise.resolve();

    const webview = view.contentEl.children.find((el: any) => el.tagName === 'WEBVIEW');
    const reloadCall = (view.addAction as jest.Mock).mock.calls.find(
      (call) => call[0] === 'refresh-cw',
    );

    // Trigger reload twice within 50ms: first timer must be cancelled
    reloadCall[2]();
    jest.advanceTimersByTime(50);
    reloadCall[2]();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // At 50ms after second click (100ms after first), src must still be about:blank
    jest.advanceTimersByTime(50);
    expect(webview.getAttribute('src')).toBe('about:blank');

    // At 100ms after second click, only the second reload's URL is applied
    jest.advanceTimersByTime(50);
    expect(webview.getAttribute('src')).toBe(`http://127.0.0.1:4096/?call=${urlCallCount}`);

    // Trigger reload and close before timeout: clearTimeout must cancel pending timer
    clearTimeoutSpy.mockClear();
    reloadCall[2]();
    await view.onClose();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockRestore();
  });

  it('does not accumulate registerDomEvent listeners across repeated error retries', async () => {
    mockApp.workspace.layoutReady = true;
    let shouldFail = true;
    mockHubManager.startHub = jest.fn().mockImplementation(async () => {
      if (shouldFail) {
        throw new Error('temporary failure');
      }
      return 'http://127.0.0.1:4096/?useWebSocket=true';
    });

    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    await Promise.resolve();
    await Promise.resolve();

    // Only a single delegated click listener should be registered on contentEl
    expect(view.registerDomEvent).toHaveBeenCalledTimes(1);
    const clickHandler = (view.registerDomEvent as jest.Mock).mock.calls[0][2];

    const getRetryBtn = () => {
      const box = view.contentEl.children.find((el: any) =>
        el.className?.includes('antigravity-hub-loading'),
      );
      return box?.children.find((el: any) => el.tagName === 'BUTTON');
    };

    // Click retry multiple times while failing
    for (let i = 0; i < 3; i += 1) {
      const btn = getRetryBtn();
      expect(btn).toBeDefined();
      clickHandler({ target: btn });
      await Promise.resolve();
      await Promise.resolve();
    }

    // Listener count must remain 1 (no leak across retries)
    expect(view.registerDomEvent).toHaveBeenCalledTimes(1);
    expect(mockHubManager.startHub).toHaveBeenCalledTimes(4);

    // Succeed on next retry
    shouldFail = false;
    clickHandler({ target: getRetryBtn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockHubManager.startHub).toHaveBeenCalledTimes(5);
    expect(view.contentEl.children.find((el: any) => el.tagName === 'WEBVIEW')).toBeDefined();
  });

  it('re-binds delegated retry click listener when reopened after onunload', async () => {
    mockApp.workspace.layoutReady = true;
    const view = new HubView(
      mockLeaf as WorkspaceLeaf,
      mockHubManager,
      () => '/usr/bin/agy',
      () => '/mock/vault',
      () => 4096,
      () => 'antigravity-obsidian',
    );

    await view.onOpen();
    expect(view.registerDomEvent).toHaveBeenCalledTimes(1);

    // Re-opening without unload reuses the existing delegated listener
    await view.onOpen();
    expect(view.registerDomEvent).toHaveBeenCalledTimes(1);

    // After onunload (which tears down Component DOM listeners), onOpen must re-bind it
    view.onunload();
    await view.onOpen();
    expect(view.registerDomEvent).toHaveBeenCalledTimes(2);
  });
});

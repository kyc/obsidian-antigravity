import { App, WorkspaceLeaf } from 'obsidian';
import AntigravityPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/types';
import { ANTIGRAVITY_HUB_VIEW_TYPE, HubView } from '../../src/ui/HubView';
import { VaultContext } from '../../src/core/VaultContext';
import { VaultTaskRunner } from '../../src/core/VaultTaskRunner';
import { ResultModal } from '../../src/ui/ResultModal';

describe('AntigravityPlugin lifecycle and settings synchronization', () => {
  let app: App;
  let plugin: AntigravityPlugin;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    app.vault.adapter.getBasePath = () => '/mock/vault/path';
    plugin = new AntigravityPlugin(app as any, { id: 'obsidian-antigravity' } as any);
    plugin.vaultContext = new VaultContext(app);
    plugin.settings = { ...DEFAULT_SETTINGS };
  });

  afterEach(() => {
    plugin.hubManager.stopHub();
    jest.restoreAllMocks();
  });

  describe('saveSettings hub drift handling', () => {
    function simulateRunningHub(overrides?: {
      executable?: string;
      profile?: string;
      vaultPath?: string;
      dangerouslySkipPermissions?: boolean;
      proxyUrl?: string;
      defaultAgent?: string;
      preferredPort?: number;
      port?: number;
    }): void {
      const mgr = plugin.hubManager as any;
      mgr.hubProcess = { pid: 9001, killed: false, exitCode: null, kill: jest.fn() };
      mgr.port = overrides?.port ?? 42000;
      mgr.currentExecutable = overrides?.executable ?? '/bin/agy';
      mgr.currentProfile = overrides?.profile ?? 'antigravity-obsidian';
      mgr.vaultPath = overrides?.vaultPath ?? '/mock/vault/path';
      mgr.currentDangerouslySkipPermissions = overrides?.dangerouslySkipPermissions ?? false;
      mgr.currentProxyUrl = overrides?.proxyUrl ?? '';
      mgr.currentDefaultAgent = overrides?.defaultAgent ?? DEFAULT_SETTINGS.defaultAgent;
      mgr.currentPreferredPort = overrides?.preferredPort ?? 0;
    }

    it('stops running unrestricted hub and refreshes open HubView when allowUnrestrictedTasks is turned off', async () => {
      plugin.settings = {
        ...DEFAULT_SETTINGS,
        allowUnrestrictedTasks: true,
        unrestrictedConfirmed: true,
        hubUnrestrictedConfirmed: true,
      };
      simulateRunningHub({ dangerouslySkipPermissions: true });

      const hubView = new HubView(
        { app } as unknown as WorkspaceLeaf,
        plugin.hubManager,
        () => '/bin/agy',
        () => '/mock/vault/path',
        () => plugin.settings.hubPort,
        () => plugin.settings.hubProfile,
      );
      const refreshSpy = jest.spyOn(hubView, 'refreshHub').mockImplementation(() => {});
      app.workspace.getLeavesOfType = jest.fn().mockImplementation((type: string) =>
        type === ANTIGRAVITY_HUB_VIEW_TYPE ? [{ view: hubView }] : [],
      );
      const stopSpy = jest.spyOn(plugin.hubManager, 'stopHub');

      // Turn off unrestricted tasks
      plugin.settings.allowUnrestrictedTasks = false;
      await plugin.saveSettings();

      expect(plugin.settings.unrestrictedConfirmed).toBe(false);
      expect(plugin.settings.hubUnrestrictedConfirmed).toBe(false);
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('stops and refreshes hub when hubProfile, proxyUrl, hubPort, or defaultAgent changes', async () => {
      simulateRunningHub({
        profile: 'antigravity-obsidian',
        proxyUrl: '',
        defaultAgent: DEFAULT_SETTINGS.defaultAgent,
        preferredPort: 0,
      });

      const hubView = new HubView(
        { app } as unknown as WorkspaceLeaf,
        plugin.hubManager,
        () => '/bin/agy',
        () => '/mock/vault/path',
        () => plugin.settings.hubPort,
        () => plugin.settings.hubProfile,
      );
      const refreshSpy = jest.spyOn(hubView, 'refreshHub').mockImplementation(() => {});
      app.workspace.getLeavesOfType = jest.fn().mockReturnValue([{ view: hubView }]);
      const stopSpy = jest.spyOn(plugin.hubManager, 'stopHub');

      plugin.settings.proxyUrl = 'http://127.0.0.1:7897';
      await plugin.saveSettings();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('does not stop hub when non-hub settings like model change', async () => {
      jest.spyOn(plugin.resolver, 'resolve').mockReturnValue('/bin/agy');
      simulateRunningHub({ executable: '/bin/agy' });

      const stopSpy = jest.spyOn(plugin.hubManager, 'stopHub');
      plugin.settings.model = 'claude-sonnet-4-6';
      await plugin.saveSettings();

      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('stops and refreshes running hub when cliPath resolves to a different executable', async () => {
      jest.spyOn(plugin.resolver, 'resolve').mockImplementation((configured) => configured || '/bin/agy');
      simulateRunningHub({ executable: '/bin/agy' });

      const hubView = new HubView(
        { app } as unknown as WorkspaceLeaf,
        plugin.hubManager,
        () => plugin.resolver.resolve(plugin.settings.cliPath),
        () => '/mock/vault/path',
        () => plugin.settings.hubPort,
        () => plugin.settings.hubProfile,
      );
      const refreshSpy = jest.spyOn(hubView, 'refreshHub').mockImplementation(() => {});
      app.workspace.getLeavesOfType = jest.fn().mockReturnValue([{ view: hubView }]);
      const stopSpy = jest.spyOn(plugin.hubManager, 'stopHub');

      plugin.settings.cliPath = '/opt/agy-v2/agy';
      await plugin.saveSettings();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('debounces hub restart when debounceHubRestart option is set and cancels pending timer on unload', async () => {
      jest.useFakeTimers();
      try {
        jest.spyOn(plugin.resolver, 'resolve').mockReturnValue('/bin/agy');
        simulateRunningHub({ executable: '/bin/agy', proxyUrl: '' });

        const hubView = new HubView(
          { app } as unknown as WorkspaceLeaf,
          plugin.hubManager,
          () => '/bin/agy',
          () => '/mock/vault/path',
          () => plugin.settings.hubPort,
          () => plugin.settings.hubProfile,
        );
        const refreshSpy = jest.spyOn(hubView, 'refreshHub').mockImplementation(() => {});
        app.workspace.getLeavesOfType = jest.fn().mockReturnValue([{ view: hubView }]);
        const stopSpy = jest.spyOn(plugin.hubManager, 'stopHub');

        plugin.settings.proxyUrl = 'http://127.0.0.1:789';
        await plugin.saveSettings({ debounceHubRestart: true });
        plugin.settings.proxyUrl = 'http://127.0.0.1:7897';
        await plugin.saveSettings({ debounceHubRestart: true });

        expect(stopSpy).not.toHaveBeenCalled();
        expect(refreshSpy).not.toHaveBeenCalled();

        jest.advanceTimersByTime(400);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        // Schedule another debounced restart, then unload before it fires
        simulateRunningHub({ executable: '/bin/agy', proxyUrl: 'http://127.0.0.1:7897' });
        stopSpy.mockClear();
        refreshSpy.mockClear();

        plugin.settings.proxyUrl = 'http://127.0.0.1:8080';
        await plugin.saveSettings({ debounceHubRestart: true });
        plugin.onunload();

        jest.advanceTimersByTime(500);
        expect(refreshSpy).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('normalizes invalid settings and clears resolver cache when cliPath changes in saveSettings', async () => {
      const clearSpy = jest.spyOn(plugin.resolver, 'clearCache');

      plugin.settings.hubPort = 99999;
      plugin.settings.hubProfile = 'bad profile!';
      plugin.settings.cliPath = '  /opt/custom/agy  ';
      await plugin.saveSettings();

      expect(plugin.settings.hubPort).toBe(DEFAULT_SETTINGS.hubPort);
      expect(plugin.settings.hubProfile).toBe(DEFAULT_SETTINGS.hubProfile);
      expect(plugin.settings.cliPath).toBe('/opt/custom/agy');
      expect(clearSpy).toHaveBeenCalledTimes(1);

      // Saving again without changing cliPath should not redundantly clear cache
      await plugin.saveSettings();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('onLayoutReady auto-start vs stale cleanup serialization', () => {
    it('does not invoke standalone cleanupStaleHubs concurrently when autoStartHub starts the hub', async () => {
      let layoutCb: (() => void) | null = null;
      app.workspace.onLayoutReady = jest.fn().mockImplementation((cb: () => void) => {
        layoutCb = cb;
      });
      plugin.loadData = jest.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        autoStartHub: true,
        hubProfile: 'auto-profile',
      });
      jest.spyOn(plugin.resolver, 'resolve').mockReturnValue('/bin/agy');
      const cleanupSpy = jest.spyOn(plugin.hubManager, 'cleanupStaleHubs').mockResolvedValue(undefined);
      const startSpy = jest.spyOn(plugin.hubManager, 'startHub').mockResolvedValue('http://127.0.0.1:42000');

      await plugin.onload();
      expect(layoutCb).not.toBeNull();
      layoutCb!();

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).not.toHaveBeenCalled();

      plugin.onunload();
    });

    it('runs cleanupStaleHubs when autoStartHub is disabled', async () => {
      let layoutCb: (() => void) | null = null;
      app.workspace.onLayoutReady = jest.fn().mockImplementation((cb: () => void) => {
        layoutCb = cb;
      });
      plugin.loadData = jest.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        autoStartHub: false,
        hubProfile: 'manual-profile',
      });
      const cleanupSpy = jest.spyOn(plugin.hubManager, 'cleanupStaleHubs').mockResolvedValue(undefined);
      const startSpy = jest.spyOn(plugin.hubManager, 'startHub').mockResolvedValue('http://127.0.0.1:42000');

      await plugin.onload();
      expect(layoutCb).not.toBeNull();
      layoutCb!();

      expect(cleanupSpy).toHaveBeenCalledWith('manual-profile');
      expect(startSpy).not.toHaveBeenCalled();

      plugin.onunload();
    });
  });

  describe('executeDirectTask unrestricted mode snapshot', () => {
    it('passes the unrestricted flag snapshotted at task start to ResultModal even if settings toggle mid-run', async () => {
      plugin.settings = {
        ...DEFAULT_SETTINGS,
        allowUnrestrictedTasks: true,
        unrestrictedConfirmed: true,
      };
      plugin.taskRunner = new VaultTaskRunner(plugin.vaultContext, () => plugin.settings);
      jest.spyOn(plugin.resolver, 'resolve').mockReturnValue('/bin/agy');

      let finishTask: (val: string) => void = () => {};
      const taskPromise = new Promise<string>((resolve) => {
        finishTask = resolve;
      });
      jest.spyOn(plugin.taskRunner, 'runTask').mockReturnValue(taskPromise);

      const openedModals: ResultModal[] = [];
      const openSpy = jest.spyOn(ResultModal.prototype, 'open').mockImplementation(function (this: ResultModal) {
        openedModals.push(this);
      });

      const runPromise = plugin.runDirectTask('Audit note', { scope: 'vault' }, 'Snapshot test');

      // Flip allowUnrestrictedTasks off while task is still in flight
      plugin.settings.allowUnrestrictedTasks = false;
      plugin.settings.unrestrictedConfirmed = false;

      finishTask('Completed output');
      await runPromise;

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect((openedModals[0] as unknown as { isUnrestricted: boolean }).isUnrestricted).toBe(true);

      openSpy.mockRestore();
      plugin.taskRunner.dispose();
    });
  });
});

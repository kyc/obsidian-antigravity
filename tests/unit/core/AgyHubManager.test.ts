import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgyHubManager,
  ensureDefaultProjectId,
  ensureProfileAuth,
  ensureProfileInitialized,
  ensureProfileOnboarding,
  ensureProfileSettings,
  ensureVaultProject,
} from '../../../src/core/AgyHubManager';

describe('AgyHubManager', () => {
  let hubManager: AgyHubManager;

  beforeEach(() => {
    hubManager = new AgyHubManager();
  });

  afterEach(() => {
    hubManager.stopHub();
  });

  describe('getHubUrl', () => {
    it('returns empty string when hub is not running / port is null', () => {
      expect(hubManager.getHubUrl()).toBe('');
    });

    it('returns base url with useWebSocket=true without extension bridge query params', () => {
      // Simulate active port via internal state or start
      (hubManager as unknown as { port: number }).port = 41891;

      const url = hubManager.getHubUrl();
      expect(url).toBe('http://127.0.0.1:41891/?useWebSocket=true');
      expect(url).toContain('useWebSocket=true');
      expect(url).not.toContain('extensionView');
      expect(url).not.toContain('extensionVariant');
    });

    it('appends hostTheme and useWebSocket=true when provided in options', () => {
      (hubManager as unknown as { port: number }).port = 41891;

      const darkUrl = hubManager.getHubUrl({ hostTheme: 'dark' });
      expect(darkUrl).toBe('http://127.0.0.1:41891/?hostTheme=dark&useWebSocket=true');

      const lightUrl = hubManager.getHubUrl({ hostTheme: 'light' });
      expect(lightUrl).toBe('http://127.0.0.1:41891/?hostTheme=light&useWebSocket=true');
    });
  });

  describe('startHub', () => {
    it('consumes hub stdout and stderr so a chatty daemon cannot deadlock', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      // resume() must be called even though listeners are attached, since a
      // stream with no consumer blocks the child once the OS pipe fills.
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile');

      expect(stdout.listenerCount('data')).toBeGreaterThan(0);
      expect(stderr.listenerCount('data')).toBeGreaterThan(0);
      expect((stdout as any).resume).toHaveBeenCalled();
      expect((stderr as any).resume).toHaveBeenCalled();

      spawnSpy.mockRestore();
    });

    it('retains recent hub output and surfaces it when startup fails', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);

      // Hold the port wait open so the child exists and can log, mirroring the
      // real 15s startup window in which agy writes its diagnostics.
      let releaseWait: (err: Error) => void = () => {};
      const waitGate = new Promise<never>((_, reject) => {
        releaseWait = reject;
      });
      jest.spyOn(hubManager as any, 'waitForPort').mockReturnValue(waitGate);

      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile');

      // Wait until spawn has happened and the listeners are attached.
      while (stdout.listenerCount('data') === 0) {
        await new Promise((r) => setImmediate(r));
      }
      stdout.emit('data', Buffer.from('auth required: visit the login URL\n'));

      releaseWait(new Error('Timed out waiting for hub'));

      const err = await startPromise.catch((e: Error) => e);
      expect((err as Error).message).toContain('Timed out waiting for hub');
      expect((err as Error).message).toContain('auth required: visit the login URL');

      spawnSpy.mockRestore();
    });

    it('bounds retained hub output instead of growing without limit', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile');

      for (let i = 0; i < 500; i++) {
        stdout.emit('data', Buffer.from(`log line ${i}\n`));
      }

      const retained = hubManager.getRecentOutput().split('\n');
      expect(retained.length).toBeLessThanOrEqual(50);
      // The most recent line is kept, the earliest is dropped.
      expect(hubManager.getRecentOutput()).toContain('log line 499');
      expect(hubManager.getRecentOutput()).not.toContain('log line 0\n');

      spawnSpy.mockRestore();
    });

    it('passes --agent flag when defaultAgent is specified', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const fakeChild = {
          on: jest.fn(),
          kill: jest.fn(),
        };
        return fakeChild;
      });
      jest.spyOn(hubManager as unknown as { waitForPort: () => Promise<boolean> }, 'waitForPort').mockResolvedValue(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile', 'omarchy-vault');

      expect(spawnSpy).toHaveBeenCalledWith(
        '/bin/agy',
        expect.arrayContaining(['--agent=omarchy-vault', '--hub-port=42500', '--add-dir=/test/vault']),
        expect.any(Object),
      );

      spawnSpy.mockRestore();
    });

    it('passes --dangerously-skip-permissions when dangerouslySkipPermissions is true', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const fakeChild = {
          on: jest.fn(),
          kill: jest.fn(),
        };
        return fakeChild;
      });
      jest.spyOn(hubManager as unknown as { waitForPort: () => Promise<boolean> }, 'waitForPort').mockResolvedValue(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile', undefined, true);

      expect(spawnSpy).toHaveBeenCalledWith(
        '/bin/agy',
        expect.arrayContaining(['--dangerously-skip-permissions', '--hub-port=42500', '--add-dir=/test/vault']),
        expect.any(Object),
      );
      expect(hubManager.getDangerouslySkipPermissions()).toBe(true);

      spawnSpy.mockRestore();
    });

    it('omits --dangerously-skip-permissions when dangerouslySkipPermissions is false', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const fakeChild = {
          on: jest.fn(),
          kill: jest.fn(),
        };
        return fakeChild;
      });
      jest.spyOn(hubManager as unknown as { waitForPort: () => Promise<boolean> }, 'waitForPort').mockResolvedValue(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile', undefined, false);

      const spawnArgs = spawnSpy.mock.calls[0][1];
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
      expect(hubManager.getDangerouslySkipPermissions()).toBe(false);

      spawnSpy.mockRestore();
    });

    it('coalesces concurrent startHub calls with the same profile into a single spawn', async () => {
      const childProcess = require('child_process');
      const fakeChild = {
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
      };
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fakeChild);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      const p1 = hubManager.startHub('/bin/agy', '/test/vault', 42500, 'profile-A');
      const p2 = hubManager.startHub('/bin/agy', '/test/vault', 42500, 'profile-A');

      const [url1, url2] = await Promise.all([p1, p2]);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(url1).toBe(url2);
      expect(url1).toContain('42500');

      spawnSpy.mockRestore();
    });

    it('safely serializes concurrent startHub calls with different profiles without killing in-flight process', async () => {
      const childProcess = require('child_process');
      const spawnedProfiles: string[] = [];
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation((_exe: any, args: any) => {
        const profileArg = (args as string[]).find((a) => a.startsWith('--app_data_dir='));
        if (profileArg) spawnedProfiles.push(profileArg);
        return {
          on: jest.fn(),
          kill: jest.fn(),
          killed: false,
          exitCode: null,
        } as any;
      });

      let releaseA: () => void;
      const waitPromiseA = new Promise<void>((r) => { releaseA = r; });

      jest.spyOn(hubManager as any, 'waitForPort').mockImplementation((opts: { port: number }) => {
        if (opts.port === 41001) {
          return waitPromiseA;
        }
        return Promise.resolve();
      });

      const pA = hubManager.startHub('/bin/agy', '/test/vault', 41001, 'profile-A');
      const pB = hubManager.startHub('/bin/agy', '/test/vault', 41002, 'profile-B');

      releaseA!();

      const [urlA, urlB] = await Promise.all([pA, pB]);

      expect(urlA).toContain('41001');
      expect(urlB).toContain('41002');
      expect(spawnedProfiles).toEqual(['--app_data_dir=profile-A', '--app_data_dir=profile-B']);

      spawnSpy.mockRestore();
    });
  });

  describe('ensureProfileAuth', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auth-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false when no source token exists', () => {
      const result = ensureProfileAuth('my-profile', tmpDir);
      expect(result).toBe(false);
    });

    it('copies token from antigravity-cli if target token is missing', () => {
      const cliDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, 'antigravity-oauth-token'), 'dummy-token-cli');

      const result = ensureProfileAuth('test-obsidian', tmpDir);
      expect(result).toBe(true);

      const targetTokenPath = path.join(tmpDir, '.gemini', 'test-obsidian', 'antigravity-oauth-token');
      expect(fs.existsSync(targetTokenPath)).toBe(true);
      expect(fs.readFileSync(targetTokenPath, 'utf8')).toBe('dummy-token-cli');
    });

    it('preserves existing target token without overwriting', () => {
      const cliDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, 'antigravity-oauth-token'), 'source-token');

      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetTokenPath = path.join(targetDir, 'antigravity-oauth-token');
      fs.writeFileSync(targetTokenPath, 'existing-token');

      const result = ensureProfileAuth('test-obsidian', tmpDir);
      expect(result).toBe(true);
      expect(fs.readFileSync(targetTokenPath, 'utf8')).toBe('existing-token');
    });

    it('sanitizes profile parameter preventing path traversal', () => {
      const cliDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, 'antigravity-oauth-token'), 'secret-token');

      // Attempt path traversal with ../
      const result = ensureProfileAuth('../../victim', tmpDir);
      expect(result).toBe(true);

      // Traversal was sanitized to 'victim', so token was written inside .gemini/victim, NOT outside
      expect(fs.existsSync(path.join(tmpDir, 'victim'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.gemini', 'victim', 'antigravity-oauth-token'))).toBe(true);
    });
  });

  describe('ensureProfileOnboarding', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-onboarding-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates antigravity_state.pbtxt with completed onboarding if missing', () => {
      const result = ensureProfileOnboarding('test-obsidian', tmpDir);
      expect(result).toBe(true);

      const stateFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'antigravity_state.pbtxt');
      expect(fs.existsSync(stateFile)).toBe(true);
      const content = fs.readFileSync(stateFile, 'utf8');
      expect(content).toContain('AGENT_ONBOARDING_STATE_COMPLETED');
      expect(content).toContain('POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME');
    });

    it('patches existing state file if onboarding was not completed', () => {
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      const stateFile = path.join(targetDir, 'antigravity_state.pbtxt');
      fs.writeFileSync(stateFile, 'migrate_convos_into_projects: MIGRATION_STATUS_STARTED\n');

      const result = ensureProfileOnboarding('test-obsidian', tmpDir);
      expect(result).toBe(true);

      const content = fs.readFileSync(stateFile, 'utf8');
      expect(content).toContain('AGENT_ONBOARDING_STATE_COMPLETED');
    });

    it('preserves state file if already completed', () => {
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      const stateFile = path.join(targetDir, 'antigravity_state.pbtxt');
      const customContent = 'agent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED\n# custom';
      fs.writeFileSync(stateFile, customContent);

      const result = ensureProfileOnboarding('test-obsidian', tmpDir);
      expect(result).toBe(true);

      const content = fs.readFileSync(stateFile, 'utf8');
      expect(content).toBe(customContent);
    });
  });

  describe('ensureVaultProject', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates project file matching vault name and folder uri with path hash', () => {
      const vaultPath = '/home/user/ObsidianVault';
      const projectId = ensureVaultProject(vaultPath, tmpDir);

      expect(projectId).toMatch(/^obsidian-obsidianvault-[a-f0-9]{8}$/);
      const projectFile = path.join(tmpDir, '.gemini', 'config', 'projects', `${projectId}.json`);
      expect(fs.existsSync(projectFile)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      expect(parsed.id).toBe(projectId);
      expect(parsed.name).toBe('ObsidianVault');
      expect(parsed.projectResources.resources[0].gitFolder.folderUri).toBe('file:///home/user/ObsidianVault');
    });

    it('generates distinct project IDs for different vault paths with the same folder name', () => {
      const path1 = '/home/user/workspace1/Vault';
      const path2 = '/home/user/workspace2/Vault';
      const id1 = ensureVaultProject(path1, tmpDir);
      const id2 = ensureVaultProject(path2, tmpDir);

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^obsidian-vault-[a-f0-9]{8}$/);
      expect(id2).toMatch(/^obsidian-vault-[a-f0-9]{8}$/);
    });
    it('preserves existing settings when project file already exists', () => {
      const vaultPath = '/home/user/ObsidianVault';
      const projectId = ensureVaultProject(vaultPath, tmpDir);
      const projectFile = path.join(tmpDir, '.gemini', 'config', 'projects', `${projectId}.json`);

      // Write custom settings
      const original = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      original.settings = { artifactReviewMode: 'ARTIFACT_REVIEW_MODE_TURBO', customKey: true };
      fs.writeFileSync(projectFile, JSON.stringify(original, null, 2), 'utf8');

      // Re-run ensureVaultProject
      ensureVaultProject(vaultPath, tmpDir);

      const updated = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      expect(updated.settings).toEqual({
        artifactReviewMode: 'ARTIFACT_REVIEW_MODE_TURBO',
        autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO',
        customKey: true,
      });
    });
  });

  describe('ensureDefaultProjectId', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-default-proj-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes default_project_id.txt in profile cache directory', () => {
      ensureDefaultProjectId('test-profile', 'obsidian-myvault', tmpDir);
      const targetFile = path.join(tmpDir, '.gemini', 'test-profile', 'cache', 'default_project_id.txt');
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.readFileSync(targetFile, 'utf8')).toBe('obsidian-myvault');
    });
  });

  describe('ensureProfileSettings', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false for antigravity-cli profile', () => {
      expect(ensureProfileSettings('antigravity-cli', undefined, tmpDir)).toBe(false);
    });

    it('seeds settings.json from antigravity-cli candidate when missing', () => {
      const cliDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(
        path.join(cliDir, 'settings.json'),
        JSON.stringify({ permissionMode: 'always-proceed', permissions: { allow: ['command(git)'] } }),
      );

      const result = ensureProfileSettings('test-obsidian', undefined, tmpDir);
      expect(result).toBe(true);

      const targetFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'settings.json');
      expect(fs.existsSync(targetFile)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(parsed.permissionMode).toBe('always-proceed');
      expect(parsed.permissions.allow).toEqual(['command(git)']);
    });

    it('adds normalized vaultPath to trustedWorkspaces', () => {
      const vaultPath = '/home/user/ObsidianVault';
      const result = ensureProfileSettings('test-obsidian', vaultPath, tmpDir);
      expect(result).toBe(true);

      const targetFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(parsed.trustedWorkspaces).toContain(path.resolve(vaultPath));
    });

    it('does not duplicate existing trustedWorkspaces', () => {
      const vaultPath = '/home/user/ObsidianVault';
      const normalized = path.resolve(vaultPath);
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'settings.json'),
        JSON.stringify({ trustedWorkspaces: [normalized] }),
      );

      ensureProfileSettings('test-obsidian', vaultPath, tmpDir);

      const targetFile = path.join(targetDir, 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(parsed.trustedWorkspaces).toEqual([normalized]);
    });

    // These two keys are privileged defaults: they are what let the hub run
    // tools without per-call review and reach outside the vault. They were
    // previously written with no test pinning them, so a careless edit could
    // silently change the security posture. Asserted explicitly on purpose.
    it('seeds permissionMode and allowNonWorkspaceAccess on a fresh profile', () => {
      expect(ensureProfileSettings('test-obsidian', undefined, tmpDir)).toBe(true);

      const targetFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(parsed.permissionMode).toBe('always-proceed');
      expect(parsed.allowNonWorkspaceAccess).toBe(true);
    });

    it('does not overwrite a user-supplied permissionMode or access flag', () => {
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'settings.json'),
        JSON.stringify({ permissionMode: 'request-review', allowNonWorkspaceAccess: false }),
      );

      ensureProfileSettings('test-obsidian', undefined, tmpDir);

      const parsed = JSON.parse(fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8'));
      expect(parsed.permissionMode).toBe('request-review');
      expect(parsed.allowNonWorkspaceAccess).toBe(false);
    });
  });
});


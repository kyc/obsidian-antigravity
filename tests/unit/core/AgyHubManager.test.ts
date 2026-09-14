import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgyHubManager,
  ensureDefaultProjectId,
  ensureProfileAuth,
  ensureProfileOnboarding,
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

    it('returns clean base url without extension bridge query params', () => {
      // Simulate active port via internal state or start
      (hubManager as unknown as { port: number }).port = 41891;

      const url = hubManager.getHubUrl();
      expect(url).toBe('http://127.0.0.1:41891/');
      expect(url).not.toContain('extensionView');
      expect(url).not.toContain('extensionVariant');
    });

    it('appends hostTheme when provided in options', () => {
      (hubManager as unknown as { port: number }).port = 41891;

      const darkUrl = hubManager.getHubUrl({ hostTheme: 'dark' });
      expect(darkUrl).toBe('http://127.0.0.1:41891/?hostTheme=dark');

      const lightUrl = hubManager.getHubUrl({ hostTheme: 'light' });
      expect(lightUrl).toBe('http://127.0.0.1:41891/?hostTheme=light');
    });
  });

  describe('startHub', () => {
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

      jest.spyOn(hubManager as any, 'waitForPort').mockImplementation((child: any, port: number) => {
        if (port === 41001) {
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
});


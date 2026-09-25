import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureDefaultProjectId,
  ensureProfileAuth,
  ensureProfileInitialized,
  ensureProfileOnboarding,
  ensureProfileSettings,
  ensureVaultProject,
  getHubInstanceFilePath,
  loadHubInstanceMetadata,
  removeHubInstanceMetadata,
  saveHubInstanceMetadata,
} from '../../../src/core/AgyProfile';

describe('AgyProfile', () => {
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

      const targetFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'antigravity_state.pbtxt');
      expect(fs.existsSync(targetFile)).toBe(true);
      const content = fs.readFileSync(targetFile, 'utf8');
      expect(content).toContain('agent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED');
    });

    it('patches existing state file if onboarding was not completed', () => {
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, 'antigravity_state.pbtxt');
      fs.writeFileSync(targetFile, 'some_other_field: 123\n');

      const result = ensureProfileOnboarding('test-obsidian', tmpDir);
      expect(result).toBe(true);

      const content = fs.readFileSync(targetFile, 'utf8');
      expect(content).toContain('agent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED');
    });

    it('preserves state file if already completed', () => {
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, 'antigravity_state.pbtxt');
      const existing = 'custom_field: abc\nagent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED\n';
      fs.writeFileSync(targetFile, existing);

      const result = ensureProfileOnboarding('test-obsidian', tmpDir);
      expect(result).toBe(true);

      const content = fs.readFileSync(targetFile, 'utf8');
      expect(content).toBe(existing);
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

      const data = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      expect(data.id).toBe(projectId);
      expect(data.name).toBe('ObsidianVault');
      expect(data.projectResources.resources[0].gitFolder.folderUri).toBe(`file://${vaultPath}`);
    });

    it('generates distinct project IDs for different vault paths with the same folder name', () => {
      const path1 = '/home/user/work/vault';
      const path2 = '/home/user/personal/vault';

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

    it('preserves existing top-level fields like permissionGrants', () => {
      const vaultPath = '/home/user/ObsidianVault';
      const projectId = ensureVaultProject(vaultPath, tmpDir);
      const projectFile = path.join(tmpDir, '.gemini', 'config', 'projects', `${projectId}.json`);

      // Pre-seed project file with permissionGrants (simulating hub or previous session)
      const existing = {
        id: projectId,
        name: 'ObsidianVault',
        permissionGrants: [
          { permission: 'command(python3 *)' },
          { permission: 'command(obsidian *)' },
        ],
        v2Migrated: true,
      };
      fs.writeFileSync(projectFile, JSON.stringify(existing, null, 2), 'utf8');

      ensureVaultProject(vaultPath, tmpDir);

      const updated = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      expect(updated.permissionGrants).toEqual([
        { permission: 'command(python3 *)' },
        { permission: 'command(obsidian *)' },
      ]);
      expect(updated.v2Migrated).toBe(true);
      expect(updated.projectResources.resources[0].gitFolder.folderUri).toBe(`file://${vaultPath}`);
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

    it('creates settings.json and adds normalized vaultPath to trustedWorkspaces', () => {
      const vaultPath = '/home/user/ObsidianVault';
      const result = ensureProfileSettings('test-obsidian', vaultPath, tmpDir);
      expect(result).toBe(true);

      const targetFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'settings.json');
      expect(fs.existsSync(targetFile)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(parsed.trustedWorkspaces).toContain(path.resolve(vaultPath));
      expect(parsed.permissions).toBeUndefined();
    });

    it('does not copy or backfill permissions from CLI candidate sources', () => {
      const cliDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(
        path.join(cliDir, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['command(git *)', 'command(python3 *)'] } }),
      );

      ensureProfileSettings('test-obsidian', undefined, tmpDir);

      const targetFile = path.join(tmpDir, '.gemini', 'test-obsidian', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(parsed.permissions).toBeUndefined();
    });

    it('strips existing permissions from profile settings to preserve restricted mode', () => {
      const targetDir = path.join(tmpDir, '.gemini', 'test-obsidian');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'settings.json'),
        JSON.stringify({
          permissions: { allow: ['command(node)', 'command(python3)'] },
          customSetting: true,
        }),
      );

      ensureProfileSettings('test-obsidian', undefined, tmpDir);

      const parsed = JSON.parse(fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8'));
      expect(parsed.permissions).toBeUndefined();
      expect(parsed.customSetting).toBe(true);
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
  });

  describe('Hub instance metadata persistence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-meta-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves, loads, and removes hub-instance.json correctly', () => {
      const metadata = {
        pid: 12345,
        port: 41920,
        profile: 'test-profile',
        vaultPath: '/home/user/vault',
        dangerouslySkipPermissions: true,
        startedAt: Date.now(),
      };

      saveHubInstanceMetadata('test-profile', metadata, tmpDir);

      const loaded = loadHubInstanceMetadata('test-profile', tmpDir);
      expect(loaded).toEqual(metadata);

      removeHubInstanceMetadata('test-profile', tmpDir);
      expect(loadHubInstanceMetadata('test-profile', tmpDir)).toBeNull();
    });

    it('returns null if hub-instance.json contains invalid format', () => {
      const filePath = getHubInstanceFilePath('test-profile', tmpDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ pid: 'not-a-number' }));

      expect(loadHubInstanceMetadata('test-profile', tmpDir)).toBeNull();
    });

    it('returns null if hub-instance.json is not valid JSON', () => {
      const filePath = getHubInstanceFilePath('test-profile', tmpDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'not json');

      expect(loadHubInstanceMetadata('test-profile', tmpDir)).toBeNull();
    });
  });
});

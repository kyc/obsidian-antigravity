import { VaultContext } from '../../../src/core/VaultContext';

describe('VaultContext', () => {
  let mockApp: any;
  let vaultContext: VaultContext;

  beforeEach(() => {
    mockApp = {
      vault: {
        adapter: {
          getBasePath: jest.fn().mockReturnValue('/home/user/vault'),
        },
      },
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(null),
      },
    };
    vaultContext = new VaultContext(mockApp);
  });

  describe('formatPromptWithContext', () => {
    it('formats active note prompt with target file', () => {
      const formatted = vaultContext.formatPromptWithContext('Fix links', {
        scope: 'active-note',
        filePath: 'Notes/Ideas.md',
      });

      expect(formatted).toContain('Target File: Notes/Ideas.md');
      expect(formatted).toContain('Task Instruction: Fix links');
    });

    it('formats selection prompt with code block', () => {
      const formatted = vaultContext.formatPromptWithContext('Summarize this', {
        scope: 'selection',
        filePath: 'Notes/Article.md',
        selectionText: 'Paragraph to summarize',
      });

      expect(formatted).toContain('Target File: Notes/Article.md');
      expect(formatted).toContain('Paragraph to summarize');
      expect(formatted).toContain('Task Instruction: Summarize this');
    });

    it('formats folder prompt with target folder', () => {
      const formatted = vaultContext.formatPromptWithContext('Build MOC', {
        scope: 'folder',
        folderPath: 'Projects/Alpha',
      });

      expect(formatted).toContain('Target Folder: Projects/Alpha');
      expect(formatted).toContain('Task Instruction: Build MOC');
    });

    it('formats vault-wide prompt', () => {
      const formatted = vaultContext.formatPromptWithContext('Audit all notes', {
        scope: 'vault',
      });

      expect(formatted).toContain('Vault-wide Task: Audit all notes');
    });

    it('sanitizes context file path preventing path traversal in prompt', () => {
      const formatted = vaultContext.formatPromptWithContext('Review file', {
        scope: 'active-note',
        filePath: '../../etc/passwd',
      });

      expect(formatted).not.toContain('../../etc/passwd');
      expect(formatted).toContain('Target File: passwd');
    });
  });

  describe('resolveSafeRulesPath', () => {
    it('resolves safe relative rules path inside vault', () => {
      const resolved = vaultContext.resolveSafeRulesPath('AGENTS.md');
      expect(resolved).toBe('/home/user/vault/AGENTS.md');
    });

    it('resolves safe nested rules path inside vault', () => {
      const resolved = vaultContext.resolveSafeRulesPath('.rules/AGENTS.md');
      expect(resolved).toBe('/home/user/vault/.rules/AGENTS.md');
    });

    it('detects path traversal and falls back to default AGENTS.md with notice', () => {
      const resolved = vaultContext.resolveSafeRulesPath('../../Documents/notes.md');
      expect(resolved).toBe('/home/user/vault/AGENTS.md');
    });

    it('returns null for empty rules path', () => {
      const resolved = vaultContext.resolveSafeRulesPath('   ');
      expect(resolved).toBeNull();
    });
  });
});

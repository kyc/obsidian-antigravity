import * as path from 'path';
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
        getMostRecentLeaf: jest.fn().mockReturnValue(null),
        getLeavesOfType: jest.fn().mockReturnValue([]),
      },
    };
    vaultContext = new VaultContext(mockApp);
  });

  describe('getActiveContext', () => {
    const markdownView = (file: any, editor?: any) => ({
      getViewType: () => 'markdown',
      file,
      editor,
    });

    it('falls back to the most recent leaf when the command palette holds focus', () => {
      // Opening the command palette moves focus away from the note, so
      // getActiveViewOfType returns null even though the user was editing.
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);
      mockApp.workspace.getMostRecentLeaf.mockReturnValue({
        view: markdownView({ path: 'Notes/Target.md' }, { getSelection: () => '', getValue: () => 'body' }),
      });

      expect(vaultContext.getActiveContext()).toEqual({
        scope: 'active-note',
        filePath: 'Notes/Target.md',
      });
    });

    it('preserves the selection scope through the fallback path', () => {
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);
      mockApp.workspace.getMostRecentLeaf.mockReturnValue({
        view: markdownView(
          { path: 'Notes/Target.md' },
          { getSelection: () => 'picked text', getValue: () => 'full body' },
        ),
      });

      expect(vaultContext.getActiveContext()).toEqual({
        scope: 'selection',
        filePath: 'Notes/Target.md',
        selectionText: 'picked text',
      });
    });

    it('scans open markdown leaves when no recent leaf is a note', () => {
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);
      mockApp.workspace.getMostRecentLeaf.mockReturnValue(null);
      mockApp.workspace.getLeavesOfType.mockReturnValue([
        { view: { getViewType: () => 'antigravity-hub-view' } },
        { view: markdownView({ path: 'Notes/Open.md' }, { getSelection: () => '', getValue: () => 'x' }) },
      ]);

      expect(vaultContext.getActiveContext()).toEqual({
        scope: 'active-note',
        filePath: 'Notes/Open.md',
      });
    });

    it('only reports a vault-wide task when no note is open at all', () => {
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);
      mockApp.workspace.getMostRecentLeaf.mockReturnValue({
        view: { getViewType: () => 'antigravity-hub-view' },
      });
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);

      expect(vaultContext.getActiveContext()).toEqual({ scope: 'vault' });
    });

    it('prefers the focused view over the most recent leaf', () => {
      mockApp.workspace.getActiveViewOfType.mockReturnValue(
        markdownView({ path: 'Notes/Focused.md' }, { getSelection: () => '', getValue: () => 'f' }),
      );
      mockApp.workspace.getMostRecentLeaf.mockReturnValue({
        view: markdownView({ path: 'Notes/Stale.md' }, { getSelection: () => '', getValue: () => 's' }),
      });

      expect(vaultContext.getActiveContext().filePath).toBe('Notes/Focused.md');
    });
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

    it('uses a markdown fence longer than any backtick run inside selection text', () => {
      const selectionWithCodeBlock = 'Before\n```ts\nconst x = 1;\n```\nAfter';
      const formatted = vaultContext.formatPromptWithContext('Explain this', {
        scope: 'selection',
        filePath: 'Notes/Code.md',
        selectionText: selectionWithCodeBlock,
      });

      expect(formatted).toContain(`Selected Text:\n\`\`\`\`markdown\n${selectionWithCodeBlock}\n\`\`\`\``);

      const selectionWithFourTicks = '````md\ncode\n````';
      const formatted5 = vaultContext.formatPromptWithContext('Explain', {
        scope: 'selection',
        filePath: 'Notes/Nested.md',
        selectionText: selectionWithFourTicks,
      });
      expect(formatted5).toContain(`Selected Text:\n\`\`\`\`\`markdown\n${selectionWithFourTicks}\n\`\`\`\`\``);
    });
  });

  describe('resolveSafeRulesPath', () => {
    it('resolves safe relative rules path inside vault', () => {
      const resolved = vaultContext.resolveSafeRulesPath('AGENTS.md');
      expect(resolved).toBe(path.resolve('/home/user/vault', 'AGENTS.md'));
    });

    it('resolves safe nested rules path inside vault', () => {
      const resolved = vaultContext.resolveSafeRulesPath('.rules/AGENTS.md');
      expect(resolved).toBe(path.resolve('/home/user/vault', '.rules/AGENTS.md'));
    });

    it('accepts paths when vault is located at filesystem root', () => {
      const rootPath = path.parse(process.cwd()).root;
      mockApp.vault.adapter.getBasePath.mockReturnValue(rootPath);

      expect(vaultContext.resolveSafeRulesPath('AGENTS.md')).toBe(path.resolve(rootPath, 'AGENTS.md'));
      expect(vaultContext.sanitizeContextPath('Notes/RootNote.md')).toBe('Notes/RootNote.md');
    });

    it('accepts legitimate filenames starting with two dots inside vault', () => {
      expect(vaultContext.resolveSafeRulesPath('..rules.md')).toBe(
        path.resolve('/home/user/vault', '..rules.md'),
      );
      expect(vaultContext.sanitizeContextPath('..notes.md')).toBe('..notes.md');
    });

    it('detects path traversal and falls back to default AGENTS.md with notice', () => {
      const resolved = vaultContext.resolveSafeRulesPath('../../Documents/notes.md');
      expect(resolved).toBe(path.resolve('/home/user/vault', 'AGENTS.md'));
    });

    it('returns null for empty rules path', () => {
      const resolved = vaultContext.resolveSafeRulesPath('   ');
      expect(resolved).toBeNull();
    });
  });
});

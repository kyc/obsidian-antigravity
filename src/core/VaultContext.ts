import * as fs from 'fs';
import * as path from 'path';
import { App, FileSystemAdapter, MarkdownView, Notice } from 'obsidian';
import { t } from '../i18n';
import { TaskContext } from '../types';

export class VaultContext {
  constructor(private app: App) {}

  getVaultBasePath(): string | null {
    const adapter = this.app.vault?.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    if (adapter && typeof (adapter as unknown as { getBasePath?: () => string }).getBasePath === 'function') {
      return (adapter as unknown as { getBasePath: () => string }).getBasePath();
    }
    return null;
  }

  /**
   * Resolves the note the user was working in.
   *
   * `getActiveViewOfType` reflects the view that currently holds focus, which
   * stops being the note as soon as the command palette opens. Falling back to
   * the most recent leaf keeps the context the user saw before invoking the
   * command, instead of silently degrading to a vault-wide task.
   */
  /**
   * Resolves the note the user is working on, tolerating the command palette
   * (and other transient focus grabs) having taken focus away from the editor.
   *
   * Public because command `checkCallback`s must gate on the same notion of
   * "current note" that execution uses — otherwise a command can be greyed out
   * in the very command-palette flow it exists for, while its callback would
   * have resolved a context perfectly well.
   */
  resolveMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      return active;
    }

    const candidates = [
      this.app.workspace.getMostRecentLeaf()?.view,
      ...this.app.workspace.getLeavesOfType('markdown').map((leaf) => leaf.view),
    ];

    for (const view of candidates) {
      // Duck-typed rather than `instanceof`: Obsidian ships one MarkdownView
      // class per app instance, so identity checks are unreliable.
      if (view?.getViewType?.() === 'markdown' && (view as MarkdownView).file) {
        return view as MarkdownView;
      }
    }

    return null;
  }

  getActiveContext(): TaskContext {
    const activeView = this.resolveMarkdownView();
    if (!activeView || !activeView.file) {
      return { scope: 'vault' };
    }

    const file = activeView.file;
    const editor = activeView.editor;
    const selection = editor ? editor.getSelection() : '';

    if (selection && selection.trim().length > 0) {
      return {
        scope: 'selection',
        filePath: file.path,
        selectionText: selection,
        fileContent: editor.getValue(),
      };
    }

    return {
      scope: 'active-note',
      filePath: file.path,
      fileContent: editor ? editor.getValue() : undefined,
    };
  }

  resolveSafeRulesPath(rulesRelPath: string): string | null {
    const vaultPath = this.getVaultBasePath();
    if (!vaultPath) return null;

    const trimmed = (rulesRelPath || '').trim();
    if (!trimmed) return null;

    const normalizedVault = path.resolve(vaultPath);
    const resolvedPath = path.resolve(normalizedVault, trimmed);

    // Verify resolved path is strictly within the vault directory
    if (resolvedPath !== normalizedVault && resolvedPath.startsWith(normalizedVault + path.sep)) {
      return resolvedPath;
    }

    new Notice(t('notices.rulesPathInvalid', { rulesRelPath }));
    return path.join(normalizedVault, 'AGENTS.md');
  }

  ensureVaultRules(rulesRelPath: string): void {
    const fullRulePath = this.resolveSafeRulesPath(rulesRelPath);
    if (!fullRulePath) return;

    const ruleDir = path.dirname(fullRulePath);

    try {
      if (!fs.existsSync(ruleDir)) {
        fs.mkdirSync(ruleDir, { recursive: true });
      }

      if (!fs.existsSync(fullRulePath)) {
        const defaultRules = `# Antigravity Vault Agent Rules

You are operating inside an Obsidian Vault.
Adhere to the following conventions:

1. **Wikilinks**: When linking between notes, always prefer Obsidian wikilinks: \`[[Note Name]]\` or \`[[Note Name|Custom Text]]\`.
2. **Metadata & Frontmatter**: Preserve existing YAML frontmatter at the top of markdown notes. Do not strip tags, aliases, or dates unless instructed.
3. **Safety**: Do not delete notes unless explicitly requested. Always make targeted, clean updates.
4. **Markdown Formatting**: Use standard GitHub-flavored markdown with clean heading hierarchies.
`;
        fs.writeFileSync(fullRulePath, defaultRules, 'utf8');
      }
    } catch {
      // Ignore rule creation errors
    }
  }

  sanitizeContextPath(targetPath: string): string {
    const trimmed = (targetPath || '').trim();
    if (!trimmed) return '';

    const vaultPath = this.getVaultBasePath();
    if (!vaultPath) {
      return path.basename(trimmed);
    }

    const normalizedVault = path.resolve(vaultPath);
    const resolved = path.resolve(normalizedVault, trimmed);

    if (resolved === normalizedVault || resolved.startsWith(normalizedVault + path.sep)) {
      return path.relative(normalizedVault, resolved);
    }

    return path.basename(trimmed);
  }

  formatPromptWithContext(prompt: string, context: TaskContext): string {
    const parts: string[] = [];

    if (context.scope === 'selection' && context.selectionText) {
      const safePath = context.filePath ? this.sanitizeContextPath(context.filePath) : 'Active Note';
      parts.push(`Target File: ${safePath}`);
      parts.push(`Selected Text:\n\`\`\`markdown\n${context.selectionText}\n\`\`\``);
      parts.push(`Task Instruction: ${prompt}`);
    } else if (context.scope === 'active-note' && context.filePath) {
      const safePath = this.sanitizeContextPath(context.filePath);
      parts.push(`Target File: ${safePath}`);
      parts.push(`Task Instruction: ${prompt}`);
    } else if (context.scope === 'folder' && context.folderPath) {
      const safePath = this.sanitizeContextPath(context.folderPath);
      parts.push(`Target Folder: ${safePath}`);
      parts.push(`Task Instruction: ${prompt}`);
    } else {
      parts.push(`Vault-wide Task: ${prompt}`);
    }

    return parts.join('\n\n');
  }
}

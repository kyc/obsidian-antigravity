import { App, Notice, Setting, TFile } from 'obsidian';
import { VaultContext } from '../../../src/core/VaultContext';
import { ResultModal } from '../../../src/ui/ResultModal';

describe('ResultModal', () => {
  let app: App;
  let vaultContext: VaultContext;

  beforeEach(() => {
    jest.clearAllMocks();
    Setting.instances = [];
    app = new App();
    vaultContext = new VaultContext(app);
  });

  function findButton(label: string) {
    for (const setting of Setting.instances) {
      const btn = setting.buttons.find((b) => b.text === label);
      if (btn) return btn;
    }
    return undefined;
  }

  it('appends to the note resolved by VaultContext.resolveMarkdownView using editor.replaceRange', async () => {
    // Simulate modal holding focus so getActiveViewOfType returns null,
    // while most recent leaf still points to the markdown note.
    app.workspace.getActiveViewOfType.mockReturnValue(null);
    const editor = {
      lineCount: jest.fn().mockReturnValue(3),
      getLine: jest.fn().mockReturnValue('last line text'),
      replaceRange: jest.fn(),
      setValue: jest.fn(),
    };
    app.workspace.getMostRecentLeaf.mockReturnValue({
      view: {
        getViewType: () => 'markdown',
        file: new TFile('Notes/Target.md'),
        editor,
      },
    });

    const modal = new ResultModal(app, 'Summary', 'Generated output', false, vaultContext);
    const closeSpy = jest.spyOn(modal, 'close');
    await modal.onOpen();

    const appendBtn = findButton('Append to active note');
    expect(appendBtn?.clickHandler).toBeDefined();
    await appendBtn!.clickHandler!();

    expect(editor.replaceRange).toHaveBeenCalledTimes(1);
    expect(editor.replaceRange).toHaveBeenCalledWith(
      '\n\n## Antigravity result\n\nGenerated output\n',
      { line: 2, ch: 'last line text'.length },
    );
    expect(editor.setValue).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to app.vault.append when resolved view has a file without an editor', async () => {
    const file = new TFile('Notes/ReadingMode.md');
    app.workspace.getActiveViewOfType.mockReturnValue(null);
    app.workspace.getMostRecentLeaf.mockReturnValue({
      view: {
        getViewType: () => 'markdown',
        file,
        editor: null,
      },
    });

    const modal = new ResultModal(app, 'Summary', 'Appended in reading mode', false, vaultContext);
    const closeSpy = jest.spyOn(modal, 'close');
    await modal.onOpen();

    const appendBtn = findButton('Append to active note');
    await appendBtn!.clickHandler!();

    expect(app.vault.append).toHaveBeenCalledWith(
      file,
      '\n\n## Antigravity result\n\nAppended in reading mode\n',
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('shows a failure notice instead of throwing when clipboard write fails', async () => {
    const origNavigator = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: jest.fn().mockRejectedValue(new Error('Clipboard blocked')),
        },
      },
    });

    try {
      const modal = new ResultModal(app, 'Summary', 'Copy me', false, vaultContext);
      await modal.onOpen();

      const copyBtn = findButton('Copy to clipboard');
      expect(copyBtn?.clickHandler).toBeDefined();
      await expect(copyBtn!.clickHandler!()).resolves.toBeUndefined();

      expect(Notice).toHaveBeenCalledWith('Failed to copy output to clipboard: Clipboard blocked');
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNavigator,
      });
    }
  });

  it('renders risk banner only when isUnrestricted is true', async () => {
    const safeModal = new ResultModal(app, 'Safe', 'Body', false, vaultContext);
    await safeModal.onOpen();
    expect(safeModal.contentEl.createDiv).not.toHaveBeenCalledWith({ cls: 'antigravity-risk-banner' });

    const riskyModal = new ResultModal(app, 'Risky', 'Body', true, vaultContext);
    await riskyModal.onOpen();
    expect(riskyModal.contentEl.createDiv).toHaveBeenCalledWith({ cls: 'antigravity-risk-banner' });
  });
});

import { App, Component, MarkdownRenderer, Modal, Notice, Setting, normalizePath, setIcon } from 'obsidian';
import { VaultContext } from '../core/VaultContext';
import { t } from '../i18n';

export class ResultModal extends Modal {
  private component: Component = new Component();
  private vaultContext: VaultContext;

  constructor(
    app: App,
    private title: string,
    private content: string,
    private isUnrestricted = false,
    vaultContext?: VaultContext,
  ) {
    super(app);
    this.vaultContext = vaultContext ?? new VaultContext(app);
  }

  async onOpen(): Promise<void> {
    this.component.load();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('antigravity-task-modal');

    contentEl.createEl('h2', { text: this.title });

    if (this.isUnrestricted) {
      const banner = contentEl.createDiv({ cls: 'antigravity-risk-banner' });
      setIcon(banner.createSpan({ cls: 'antigravity-risk-banner-icon' }), 'alert-triangle');
      banner.createSpan({ text: t('resultModal.riskBanner') });
    }

    const scrollContainer = contentEl.createDiv({
      cls: 'antigravity-result-modal-content',
    });

    await MarkdownRenderer.render(
      this.app,
      this.content || t('resultModal.noOutput'),
      scrollContainer,
      '',
      this.component,
    );

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText(t('resultModal.btnCopy')).onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.content);
            new Notice(t('resultModal.noticeCopied'));
          } catch (err) {
            new Notice(t('resultModal.noticeCopyFailed', { error: (err as Error).message }));
          }
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t('resultModal.btnAppend')).onClick(async () => {
          const view = this.vaultContext.resolveMarkdownView();
          const addition = `\n\n## ${t('resultModal.resultHeader')}\n\n${this.content}\n`;
          if (view?.editor) {
            try {
              const lastLine = Math.max(0, view.editor.lineCount() - 1);
              const lastLineText = view.editor.getLine(lastLine) ?? '';
              view.editor.replaceRange(addition, { line: lastLine, ch: lastLineText.length });
              new Notice(t('resultModal.noticeAppended'));
              this.close();
            } catch (err) {
              new Notice(t('resultModal.noticeAppendFailed', { error: (err as Error).message }));
            }
          } else if (view?.file) {
            try {
              await this.app.vault.append(view.file, addition);
              new Notice(t('resultModal.noticeAppended'));
              this.close();
            } catch (err) {
              new Notice(t('resultModal.noticeAppendFailed', { error: (err as Error).message }));
            }
          } else {
            new Notice(t('resultModal.noticeNoActiveNote'));
          }
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t('resultModal.btnCreate')).onClick(async () => {
          const fileName = this.buildUniqueFileName();
          try {
            await this.app.vault.create(fileName, `# ${this.title}\n\n${this.content}\n`);
            new Notice(t('resultModal.noticeCreatedNote', { fileName }));
            this.close();
          } catch (err) {
            new Notice(t('resultModal.noticeCreateFailed', { error: (err as Error).message }));
          }
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t('resultModal.btnClose')).onClick(() => {
          this.close();
        });
      });
  }

  /**
   * Builds a vault-unique note name. The timestamp is only second-precision,
   * so two clicks within the same second would otherwise collide; a numeric
   * suffix is appended until the path is free.
   */
  private buildUniqueFileName(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `Antigravity Result ${timestamp}`;

    let candidate = normalizePath(`${base}.md`);
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${base} ${counter}.md`);
      counter += 1;
    }

    return candidate;
  }

  onClose(): void {
    this.component.unload();
    const { contentEl } = this;
    contentEl.empty();
  }
}

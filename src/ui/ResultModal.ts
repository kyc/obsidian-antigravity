import { App, Component, MarkdownRenderer, MarkdownView, Modal, Notice, Setting, normalizePath, setIcon } from 'obsidian';
import { t } from '../i18n';

export class ResultModal extends Modal {
  private component: Component = new Component();

  constructor(
    app: App,
    private title: string,
    private content: string,
    private isUnrestricted = false,
  ) {
    super(app);
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
          await navigator.clipboard.writeText(this.content);
          new Notice(t('resultModal.noticeCopied'));
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t('resultModal.btnAppend')).onClick(async () => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view && view.editor) {
            const current = view.editor.getValue();
            view.editor.setValue(`${current}\n\n## ${t('resultModal.resultHeader')}\n\n${this.content}\n`);
            new Notice(t('resultModal.noticeAppended'));
            this.close();
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

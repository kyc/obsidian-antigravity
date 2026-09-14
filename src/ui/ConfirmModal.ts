import { App, Modal, Setting } from 'obsidian';
import { t } from '../i18n';

export class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmText: string,
    private onConfirm: () => void | Promise<void>,
    private onCancel?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('antigravity-confirm-modal');

    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.message });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText(this.confirmText)
          .setDestructive()
          .onClick(() => {
            this.confirmed = true;
            this.close();
            void this.onConfirm();
          });
      })
      .addButton((btn) => {
        btn.setButtonText(t('confirmModal.btnCancel')).onClick(() => {
          this.close();
        });
      });
  }

  onClose(): void {
    if (!this.confirmed && this.onCancel) {
      this.onCancel();
    }
    this.contentEl.empty();
  }
}

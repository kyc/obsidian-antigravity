import { App, Modal, Setting } from 'obsidian';
import { t } from '../i18n';
import { TaskContext } from '../types';

export interface TaskModalResult {
  prompt: string;
}

export class TaskModal extends Modal {
  private prompt = '';
  private onSubmit: (result: TaskModalResult) => void;

  constructor(
    app: App,
    private context: TaskContext,
    onSubmit: (result: TaskModalResult) => void,
  ) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('antigravity-task-modal');

    contentEl.createEl('h2', { text: t('taskModal.title') });

    // Target badge
    const badgeEl = contentEl.createDiv({ cls: 'antigravity-task-context-badge' });
    badgeEl.createSpan({ text: t('taskModal.scopeLabel') });
    if (this.context.scope === 'selection') {
      badgeEl.createEl('strong', { text: t('taskModal.scopeSelection') });
      badgeEl.createSpan({ text: t('taskModal.scopeIn') });
      badgeEl.createEl('code', { text: this.context.filePath || '' });
    } else if (this.context.scope === 'active-note') {
      badgeEl.createEl('strong', { text: t('taskModal.scopeActiveNote') });
      badgeEl.createSpan({ text: ' (' });
      badgeEl.createEl('code', { text: this.context.filePath || '' });
      badgeEl.createSpan({ text: ')' });
    } else if (this.context.scope === 'folder') {
      badgeEl.createEl('strong', { text: t('taskModal.scopeFolder') });
      badgeEl.createSpan({ text: ' (' });
      badgeEl.createEl('code', { text: this.context.folderPath || '' });
      badgeEl.createSpan({ text: ')' });
    } else {
      badgeEl.createEl('strong', { text: t('taskModal.scopeVault') });
    }

    // Presets
    const presetsContainer = contentEl.createDiv({ cls: 'antigravity-task-presets' });
    const presets = [
      {
        label: t('taskModal.presetFixLinksLabel'),
        text: t('taskModal.presetFixLinksText'),
      },
      {
        label: t('taskModal.presetAuditFrontmatterLabel'),
        text: t('taskModal.presetAuditFrontmatterText'),
      },
      {
        label: t('taskModal.presetExtractSummaryLabel'),
        text: t('taskModal.presetExtractSummaryText'),
      },
      {
        label: t('taskModal.presetBuildMocLabel'),
        text: t('taskModal.presetBuildMocText'),
      },
      {
        label: t('taskModal.presetRefactorStructureLabel'),
        text: t('taskModal.presetRefactorStructureText'),
      },
    ];

    const textarea = contentEl.createEl('textarea', {
      cls: 'antigravity-task-textarea',
      placeholder: t('taskModal.placeholder'),
    });

    for (const preset of presets) {
      const chip = presetsContainer.createEl('button', {
        cls: 'antigravity-preset-chip',
        text: preset.label,
      });
      chip.type = 'button';
      chip.addEventListener('click', () => {
        textarea.value = preset.text;
        this.prompt = preset.text;
        textarea.focus();
      });
    }

    textarea.addEventListener('input', () => {
      this.prompt = textarea.value;
    });

    textarea.addEventListener('keydown', (evt: KeyboardEvent) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
        evt.preventDefault();
        if (!this.prompt.trim()) return;
        this.close();
        this.onSubmit({ prompt: this.prompt.trim() });
      }
    });

    // Actions
    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText(t('taskModal.btnCancel'))
          .onClick(() => {
            this.close();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText(t('taskModal.btnRun'))
          .setCta()
          .onClick(() => {
            if (!this.prompt.trim()) return;
            this.close();
            this.onSubmit({ prompt: this.prompt.trim() });
          });
      });

    window.setTimeout(() => textarea.focus(), 50);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { AgyHubManager } from '../core/AgyHubManager';
import { t } from '../i18n';

export const ANTIGRAVITY_HUB_VIEW_TYPE = 'antigravity-hub-view';

export class HubView extends ItemView {
  private iframeEl: HTMLIFrameElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private container!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private hubManager: AgyHubManager,
    private getAgyExecutable: () => string | null,
    private getVaultPath: () => string | null,
    private getPreferredPort: () => number,
    private getProfile: () => string,
    private getDefaultAgent?: () => string,
  ) {
    super(leaf);
  }

  onload(): void {
    super.onload();

    this.addAction('refresh-cw', t('hubView.reloadAction'), () => {
      this.reloadIframe();
    });

    this.addAction('external-link', t('hubView.openBrowserAction'), () => {
      const url = this.getThemedHubUrl();
      if (url) {
        (typeof activeWindow !== 'undefined' ? activeWindow : window).open(url, '_blank');
      } else {
        new Notice(t('hubView.notRunningNotice'));
      }
    });
  }

  getViewType(): string {
    return ANTIGRAVITY_HUB_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t('hubView.displayText');
  }

  getIcon(): string {
    return 'sparkles';
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl;
    this.container.empty();
    this.container.addClass('antigravity-hub-view-container');

    await this.initHub();
  }

  async onClose(): Promise<void> {
    this.container.empty();
  }

  private getThemedHubUrl(): string {
    const isDark = typeof activeDocument !== 'undefined'
      ? activeDocument.body.classList.contains('theme-dark')
      : (typeof document !== 'undefined' && document.body.classList.contains('theme-dark'));
    return this.hubManager.getHubUrl({ hostTheme: isDark ? 'dark' : 'light' });
  }

  private async initHub(): Promise<void> {
    if (this.hubManager.isRunning()) {
      this.renderIframe(this.getThemedHubUrl());
      return;
    }

    this.renderLoading(t('hubView.starting'));

    const execPath = this.getAgyExecutable();
    const vaultPath = this.getVaultPath();

    if (!execPath) {
      this.renderError(t('hubView.errCliNotFound'));
      return;
    }

    if (!vaultPath) {
      this.renderError(t('hubView.errVaultPath'));
      return;
    }

    try {
      await this.hubManager.startHub(
        execPath,
        vaultPath,
        this.getPreferredPort(),
        this.getProfile(),
        this.getDefaultAgent ? this.getDefaultAgent() : undefined,
      );
      this.renderIframe(this.getThemedHubUrl());
    } catch (err) {
      this.renderError(t('hubView.errFailedStart', { error: (err as Error).message }));
    }
  }

  private renderLoading(message: string): void {
    if (this.iframeEl) {
      this.iframeEl.remove();
      this.iframeEl = null;
    }
    if (!this.loadingEl) {
      this.loadingEl = this.container.createDiv({ cls: 'antigravity-hub-loading' });
    } else {
      this.loadingEl.empty();
    }

    this.loadingEl.createDiv({ cls: 'antigravity-status-spinner' });
    this.loadingEl.createEl('p', { text: message });
  }

  private renderError(message: string): void {
    if (this.loadingEl) {
      this.loadingEl.empty();
      this.loadingEl.createEl('p', { text: `⚠️ ${message}`, cls: 'mod-warning' });
      const retryBtn = this.loadingEl.createEl('button', { text: t('hubView.retryButton') });
      retryBtn.type = 'button';
      this.registerDomEvent(retryBtn, 'click', () => {
        void this.initHub();
      });
    }
  }

  private renderIframe(url: string): void {
    if (this.loadingEl) {
      this.loadingEl.remove();
      this.loadingEl = null;
    }

    if (!this.iframeEl) {
      this.iframeEl = this.container.createEl('iframe', {
        cls: 'antigravity-hub-iframe',
      });
      this.iframeEl.setAttribute('allow', 'clipboard-read; clipboard-write; microphone');
    }

    this.iframeEl.src = url;
  }

  private reloadIframe(): void {
    if (this.iframeEl) {
      const targetUrl = this.getThemedHubUrl();
      this.iframeEl.src = 'about:blank';
      const win = typeof activeWindow !== 'undefined' ? activeWindow : window;
      win.setTimeout(() => {
        if (this.iframeEl) this.iframeEl.src = targetUrl;
      }, 100);
    } else {
      void this.initHub();
    }
  }
}

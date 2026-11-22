import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { AgyHubManager } from '../core/AgyHubManager';
import { sanitizeProfile } from '../core/AgyProfile';
import { t } from '../i18n';

export const ANTIGRAVITY_HUB_VIEW_TYPE = 'antigravity-hub-view';

interface ElectronWebviewElement extends HTMLElement {
  src: string;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebviewElement;
  }
}

export class HubView extends ItemView {
  private webviewEl: ElectronWebviewElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private retryBtnEl: HTMLButtonElement | null = null;
  private container!: HTMLElement;
  private isClosed: boolean = false;
  private startupTimer: number | null = null;
  private reloadTimer: number | null = null;
  private hasBoundContainerClick: boolean = false;

  constructor(
    leaf: WorkspaceLeaf,
    private hubManager: AgyHubManager,
    private getAgyExecutable: () => string | null,
    private getVaultPath: () => string | null,
    private getPreferredPort: () => number,
    private getProfile: () => string,
    private getDefaultAgent?: () => string,
    private getAllowUnrestricted?: () => boolean,
    private getProxyUrl?: () => string,
  ) {
    super(leaf);
  }

  onload(): void {
    super.onload();

    this.addAction('refresh-cw', t('hubView.reloadAction'), () => {
      this.reloadWebview();
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
    this.isClosed = false;
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.clearReloadTimer();
    this.container = this.contentEl;
    if (!this.hasBoundContainerClick) {
      this.hasBoundContainerClick = true;
      this.registerDomEvent(this.container, 'click', (evt: MouseEvent) => {
        const target = evt.target as Node | null;
        if (
          this.retryBtnEl &&
          target &&
          (target === this.retryBtnEl || (typeof this.retryBtnEl.contains === 'function' && this.retryBtnEl.contains(target)))
        ) {
          void this.initHub();
        }
      });
    }
    this.container.empty();
    this.container.addClass('antigravity-hub-view-container');

    // Immediate non-blocking feedback
    this.renderLoading(t('hubView.starting'));

    // If Obsidian workspace layout is still restoring tabs during startup,
    // defer daemon startup until other tabs, markdown files, and layout are ready.
    const app = this.app;
    if (app?.workspace && !app.workspace.layoutReady) {
      app.workspace.onLayoutReady(() => {
        this.startupTimer = window.setTimeout(() => {
          this.startupTimer = null;
          if (!this.isClosed) {
            void this.initHub();
          }
        }, 50);
      });
      return;
    }

    void this.initHub();
  }

  async onClose(): Promise<void> {
    this.isClosed = true;
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.clearReloadTimer();
    this.container?.empty();
    this.webviewEl = null;
    this.loadingEl = null;
    this.retryBtnEl = null;
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private getThemedHubUrl(): string {
    const isDark = typeof activeDocument !== 'undefined'
      ? activeDocument.body.classList.contains('theme-dark')
      : (typeof document !== 'undefined' && document.body.classList.contains('theme-dark'));
    return this.hubManager.getHubUrl({ hostTheme: isDark ? 'dark' : 'light' });
  }

  refreshHub(): void {
    if (!this.isClosed) {
      void this.initHub();
    }
  }

  private isHubConfigMatching(vaultPath: string): boolean {
    const allowUnrestricted = this.getAllowUnrestricted ? this.getAllowUnrestricted() : false;
    const profile = sanitizeProfile(this.getProfile());
    const proxyUrl = (this.getProxyUrl ? this.getProxyUrl() : '').trim();
    const defaultAgent = (this.getDefaultAgent ? this.getDefaultAgent() : '').trim();
    const preferredPort = this.getPreferredPort();

    const runningAgent =
      typeof this.hubManager.getDefaultAgent === 'function'
        ? this.hubManager.getDefaultAgent()
        : undefined;
    const runningPreferredPort =
      typeof this.hubManager.getPreferredPort === 'function'
        ? this.hubManager.getPreferredPort()
        : undefined;

    return (
      this.hubManager.isRunning() &&
      Boolean(this.hubManager.getHubUrl()) &&
      this.hubManager.getCurrentProfile() === profile &&
      this.hubManager.getVaultPath() === vaultPath &&
      this.hubManager.getDangerouslySkipPermissions() === allowUnrestricted &&
      this.hubManager.getProxyUrl() === proxyUrl &&
      (runningAgent === undefined || runningAgent === defaultAgent) &&
      (runningPreferredPort === undefined || runningPreferredPort === preferredPort)
    );
  }

  private async initHub(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    // Deliberately resolve the binary and vault *before* the already-running
    // fast path below. The alternative — checking `isRunning()` first — would
    // keep the happy path marginally cheaper but report an error for a live hub
    // whenever resolution transiently fails, hiding the fact that the daemon is
    // still up and serving. Failing loudly on a broken environment is the more
    // useful behaviour here, and resolution is cheap.
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

    const allowUnrestricted = this.getAllowUnrestricted ? this.getAllowUnrestricted() : false;
    const profile = this.getProfile();
    const proxyUrl = this.getProxyUrl ? this.getProxyUrl() : '';

    if (this.isHubConfigMatching(vaultPath)) {
      if (!this.isClosed) {
        this.renderWebview(this.getThemedHubUrl());
      }
      return;
    }

    this.renderLoading(t('hubView.starting'));

    try {
      await this.hubManager.startHub(
        execPath,
        vaultPath,
        this.getPreferredPort(),
        profile,
        this.getDefaultAgent ? this.getDefaultAgent() : undefined,
        allowUnrestricted,
        proxyUrl,
      );
      if (!this.isClosed) {
        this.renderWebview(this.getThemedHubUrl());
      }
    } catch (err) {
      if (!this.isClosed) {
        this.renderError(t('hubView.errFailedStart', { error: (err as Error).message }));
      }
    }
  }

  private renderLoading(message: string): void {
    if (this.isClosed) return;
    this.clearReloadTimer();
    this.retryBtnEl = null;
    if (this.webviewEl) {
      this.webviewEl.remove();
      this.webviewEl = null;
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
    if (this.isClosed) return;
    this.clearReloadTimer();
    if (this.webviewEl) {
      this.webviewEl.remove();
      this.webviewEl = null;
    }
    if (!this.loadingEl) {
      this.loadingEl = this.container.createDiv({ cls: 'antigravity-hub-loading' });
    } else {
      this.loadingEl.empty();
    }
    this.loadingEl.createEl('p', { text: `⚠️ ${message}`, cls: 'mod-warning' });
    const retryBtn = this.loadingEl.createEl('button', { text: t('hubView.retryButton') });
    retryBtn.type = 'button';
    this.retryBtnEl = retryBtn;
  }

  private renderWebview(url: string): void {
    if (this.isClosed) return;
    this.clearReloadTimer();
    this.retryBtnEl = null;
    if (this.loadingEl) {
      this.loadingEl.remove();
      this.loadingEl = null;
    }

    const partition = `persist:antigravity-${sanitizeProfile(this.getProfile())}`;
    if (this.webviewEl && this.webviewEl.getAttribute('partition') !== partition) {
      this.webviewEl.remove();
      this.webviewEl = null;
    }

    if (!this.webviewEl) {
      this.webviewEl = this.container.createEl('webview', {
        cls: 'antigravity-hub-webview',
        attr: {
          allowpopups: '',
          partition,
        },
      });
    }

    this.webviewEl.setAttribute('src', url);
  }

  private reloadWebview(): void {
    this.clearReloadTimer();
    const vaultPath = this.getVaultPath();
    if (this.webviewEl && vaultPath && this.isHubConfigMatching(vaultPath)) {
      const targetUrl = this.getThemedHubUrl();
      if (!targetUrl) {
        void this.initHub();
        return;
      }
      this.webviewEl.setAttribute('src', 'about:blank');
      this.reloadTimer = window.setTimeout(() => {
        this.reloadTimer = null;
        if (this.webviewEl && !this.isClosed) {
          this.webviewEl.setAttribute('src', targetUrl);
        }
      }, 100);
    } else {
      void this.initHub();
    }
  }
}

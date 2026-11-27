import * as crypto from 'crypto';
import { ItemView, normalizePath, Notice, OpenViewState, TFile, WorkspaceLeaf } from 'obsidian';
import { AgyHubManager } from '../core/AgyHubManager';
import { sanitizeProfile } from '../core/AgyProfile';
import {
  buildHubFileLinkBridgeScript,
  isTrustedHubWebviewUrl,
  normalizeVaultRoot,
  parseHubFileLinkBridgeMessage,
  ResolvedVaultFileLink,
  resolveVaultFileLink,
} from '../core/HubFileLink';
import { t } from '../i18n';

export const ANTIGRAVITY_HUB_VIEW_TYPE = 'antigravity-hub-view';

interface ElectronWebviewElement extends HTMLElement {
  src: string;
  getURL?: () => string;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebviewElement;
  }
}

export class HubView extends ItemView {
  private webviewEl: ElectronWebviewElement | null = null;
  private webviewDomReadyListener: (() => void) | null = null;
  private webviewConsoleMessageListener: ((evt: Event) => void) | null = null;
  private loadingEl: HTMLElement | null = null;
  private retryBtnEl: HTMLButtonElement | null = null;
  private container!: HTMLElement;
  private isClosed: boolean = false;
  private startupTimer: number | null = null;
  private reloadTimer: number | null = null;
  private clickBoundContainer: HTMLElement | null = null;
  private hasInjectedFileLinkBridge: boolean = false;
  private readonly fileLinkBridgePrefix: string = `__OBSIDIAN_AGY_OPEN_FILE__:${crypto.randomBytes(16).toString('hex')}:`;

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
    private getOpenFileLinksInObsidian?: () => boolean,
  ) {
    super(leaf);
  }

  onload(): void {
    super.onload();

    this.addAction('refresh-cw', t('hubView.reloadAction'), () => {
      this.reloadWebview();
    });

    this.addAction('external-link', t('hubView.openBrowserAction'), () => {
      void this.openInExternalBrowser();
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
    if (this.clickBoundContainer !== this.container) {
      this.clickBoundContainer = this.container;
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
    this.detachWebview();
    this.container?.empty();
    this.loadingEl = null;
    this.retryBtnEl = null;
  }

  onunload(): void {
    this.clickBoundContainer = null;
    super.onunload();
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private getHostTheme(): 'dark' | 'light' {
    const isDark = typeof activeDocument !== 'undefined'
      ? activeDocument.body.classList.contains('theme-dark')
      : (typeof document !== 'undefined' && document.body.classList.contains('theme-dark'));
    return isDark ? 'dark' : 'light';
  }

  private getThemedHubUrl(): string {
    return this.hubManager.getHubUrl({ hostTheme: this.getHostTheme() });
  }

  private async openInExternalBrowser(): Promise<void> {
    const url = await this.hubManager.getAuthenticatedHubUrl({ hostTheme: this.getHostTheme() });
    if (url) {
      (typeof activeWindow !== 'undefined' ? activeWindow : window).open(url, '_blank');
    } else {
      new Notice(t('hubView.notRunningNotice'));
    }
  }

  refreshHub(): void {
    if (!this.isClosed) {
      void this.initHub();
    }
  }

  syncFileLinkInterception(): void {
    if (
      this.isClosed ||
      !this.webviewEl ||
      typeof this.webviewEl.executeJavaScript !== 'function'
    ) {
      return;
    }

    const enabled = this.isOpenFileLinksInObsidianEnabled();
    if (!enabled && !this.hasInjectedFileLinkBridge) {
      return;
    }

    const currentUrl =
      typeof this.webviewEl.getURL === 'function'
        ? this.webviewEl.getURL()
        : (this.webviewEl.getAttribute('src') ?? '');
    if (!isTrustedHubWebviewUrl(currentUrl, this.hubManager.getHubUrl())) {
      return;
    }

    const vaultPath = this.getVaultPath() ?? this.hubManager.getVaultPath() ?? '';
    const script = buildHubFileLinkBridgeScript({
      enabled,
      vaultPath,
      messagePrefix: this.fileLinkBridgePrefix,
    });
    this.hasInjectedFileLinkBridge = true;
    void Promise.resolve(this.webviewEl.executeJavaScript(script)).catch(() => undefined);
  }

  private isOpenFileLinksInObsidianEnabled(): boolean {
    return this.getOpenFileLinksInObsidian ? this.getOpenFileLinksInObsidian() : false;
  }

  private detachWebview(): void {
    this.hasInjectedFileLinkBridge = false;
    if (!this.webviewEl) {
      return;
    }
    if (typeof this.webviewEl.removeEventListener === 'function') {
      if (this.webviewDomReadyListener) {
        this.webviewEl.removeEventListener('dom-ready', this.webviewDomReadyListener);
      }
      if (this.webviewConsoleMessageListener) {
        this.webviewEl.removeEventListener('console-message', this.webviewConsoleMessageListener);
      }
    }
    this.webviewDomReadyListener = null;
    this.webviewConsoleMessageListener = null;
    this.webviewEl.remove();
    this.webviewEl = null;
  }

  private handleWebviewConsoleMessage(evt: Event): void {
    if (!this.isOpenFileLinksInObsidianEnabled()) {
      return;
    }

    const message = (evt as Event & { message?: unknown }).message;
    if (typeof message !== 'string') {
      return;
    }

    const payload = parseHubFileLinkBridgeMessage(message, this.fileLinkBridgePrefix);
    if (!payload) {
      return;
    }

    const vaultPath = this.getVaultPath() ?? this.hubManager.getVaultPath();
    if (!vaultPath) {
      return;
    }

    const resolved = resolveVaultFileLink(payload.uri, vaultPath);
    if (!resolved) {
      return;
    }

    void this.openVaultFileInObsidian(resolved, { newTab: payload.newTab });
  }

  private findVaultFile(relativePath: string, caseInsensitive: boolean): TFile | null {
    const normalized = normalizePath(relativePath);
    const exact = this.app?.vault?.getAbstractFileByPath?.(normalized);
    if (exact instanceof TFile) {
      return exact;
    }

    if (caseInsensitive && typeof this.app?.vault?.getFiles === 'function') {
      const lower = normalized.toLowerCase();
      for (const candidate of this.app.vault.getFiles()) {
        if (candidate.path.toLowerCase() === lower) {
          return candidate;
        }
      }
    }

    return null;
  }

  private findOpenFileLeaf(filePath: string): WorkspaceLeaf | null {
    let matched: WorkspaceLeaf | null = null;
    const rootSplit = this.app?.workspace?.rootSplit;
    this.app?.workspace?.iterateAllLeaves?.((leaf) => {
      if (matched) return;
      if (rootSplit !== undefined && leaf.getRoot?.() !== rootSplit) {
        return;
      }
      const viewFile = (leaf.view as { file?: { path?: string } } | null)?.file;
      const deferredStateFile = (leaf.getViewState?.()?.state as { file?: unknown } | undefined)?.file;
      if (viewFile?.path === filePath || deferredStateFile === filePath) {
        matched = leaf;
      }
    });
    return matched;
  }

  private async openVaultFileInObsidian(
    resolved: ResolvedVaultFileLink,
    options: { newTab: boolean },
  ): Promise<void> {
    const vaultPath = this.getVaultPath() ?? this.hubManager.getVaultPath() ?? '';
    const caseInsensitive = normalizeVaultRoot(vaultPath)?.caseInsensitive ?? false;
    const file = this.findVaultFile(resolved.relativePath, caseInsensitive);
    if (!file) {
      new Notice(t('hubView.fileNotFoundNotice', { path: resolved.relativePath }));
      return;
    }

    const openState: OpenViewState = { active: true };
    if (resolved.line !== undefined) {
      openState.eState = { line: Math.max(0, resolved.line - 1) };
    } else if (resolved.subpath) {
      openState.eState = { subpath: `#${resolved.subpath}` };
    }

    const targetLeaf =
      (!options.newTab ? this.findOpenFileLeaf(file.path) : null) ??
      this.app?.workspace?.getLeaf?.('tab');
    if (!targetLeaf) {
      return;
    }

    try {
      await targetLeaf.openFile(file, openState);
      void this.app.workspace.revealLeaf(targetLeaf);
    } catch {
      new Notice(t('hubView.fileNotFoundNotice', { path: resolved.relativePath }));
    }
  }

  private isHubConfigMatching(vaultPath: string, executable?: string | null): boolean {
    const allowUnrestricted = this.getAllowUnrestricted ? this.getAllowUnrestricted() : false;
    const profile = this.getProfile();
    const proxyUrl = this.getProxyUrl ? this.getProxyUrl() : '';
    const defaultAgent = this.getDefaultAgent ? this.getDefaultAgent() : '';
    const preferredPort = this.getPreferredPort();

    return (
      Boolean(this.hubManager.getHubUrl()) &&
      this.hubManager.matchesRunningConfig({
        executable: executable ?? this.getAgyExecutable() ?? '',
        profile,
        vaultPath,
        dangerouslySkipPermissions: allowUnrestricted,
        proxyUrl,
        defaultAgent,
        preferredPort,
      })
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

    if (this.isHubConfigMatching(vaultPath, execPath)) {
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
    this.detachWebview();
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
    this.detachWebview();
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
      this.detachWebview();
    }

    if (!this.webviewEl) {
      const webview = this.container.createEl('webview', {
        cls: 'antigravity-hub-webview',
        attr: {
          allowpopups: '',
          partition,
        },
      });
      this.webviewEl = webview;
      this.webviewDomReadyListener = () => {
        if (webview === this.webviewEl && !this.isClosed) {
          this.hasInjectedFileLinkBridge = false;
          this.syncFileLinkInterception();
        }
      };
      this.webviewConsoleMessageListener = (evt: Event) => {
        if (webview === this.webviewEl && !this.isClosed) {
          this.handleWebviewConsoleMessage(evt);
        }
      };
      webview.addEventListener('dom-ready', this.webviewDomReadyListener);
      webview.addEventListener('console-message', this.webviewConsoleMessageListener);
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

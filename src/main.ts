import { Menu, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { AgyHubManager } from './core/AgyHubManager';
import { AgyResolver } from './core/AgyResolver';
import { VaultContext } from './core/VaultContext';
import { VaultTaskRunner } from './core/VaultTaskRunner';
import { AntigravitySettingTab } from './settings/AntigravitySettingTab';
import { AntigravityPluginSettings, DEFAULT_SETTINGS, TaskContext, validateSettings } from './types';
import { ANTIGRAVITY_HUB_VIEW_TYPE, HubView } from './ui/HubView';
import { ConfirmModal } from './ui/ConfirmModal';
import { ResultModal } from './ui/ResultModal';
import { setConfiguredLanguage, t } from './i18n';
import { StatusBarItem } from './ui/StatusBarItem';
import { TaskModal } from './ui/TaskModal';

export default class AntigravityPlugin extends Plugin {
  settings: AntigravityPluginSettings = DEFAULT_SETTINGS;
  resolver: AgyResolver = new AgyResolver();
  vaultContext!: VaultContext;
  hubManager: AgyHubManager = new AgyHubManager();
  taskRunner!: VaultTaskRunner;
  statusBar!: StatusBarItem;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.vaultContext = new VaultContext(this.app);

    // Initialize Status Bar
    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBarItem(
      this,
      statusBarEl,
      () => {
        this.taskRunner.abort();
      },
      () => {
        void this.activateHubView();
      },
    );

    // Initialize Task Runner for headless tasks
    this.taskRunner = new VaultTaskRunner(
      this.vaultContext,
      () => this.settings,
      (state, text) => {
        this.statusBar.update(state, text);
      },
    );

    // Register Hub View
    this.registerView(
      ANTIGRAVITY_HUB_VIEW_TYPE,
      (leaf: WorkspaceLeaf) =>
        new HubView(
          leaf,
          this.hubManager,
          () => this.resolver.resolve(this.settings.cliPath),
          () => this.vaultContext.getVaultBasePath(),
          () => this.settings.hubPort,
          () => this.settings.hubProfile || 'antigravity-obsidian',
          () => this.settings.defaultAgent,
          () => this.settings.allowUnrestrictedTasks,
        ),
    );

    // Ribbon Icon: click opens the Hub View
    this.addRibbonIcon('sparkles', t('ribbon.tooltip'), (evt: MouseEvent) => {
      if (evt.button === 2 || evt.altKey) {
        this.showRibbonMenu(evt);
      } else {
        void this.activateHubView();
      }
    });

    // Commands
    this.addCommand({
      id: 'open-hub',
      name: t('commands.openHub'),
      callback: () => {
        void this.activateHubView();
      },
    });

    this.addCommand({
      id: 'run-task',
      name: t('commands.runTask'),
      callback: () => {
        this.openTaskModal();
      },
    });

    this.addCommand({
      id: 'fix-links',
      name: t('commands.fixLinks'),
      checkCallback: (checking: boolean) => {
        const view = this.vaultContext.resolveMarkdownView();
        if (view && view.file) {
          if (!checking) {
            const ctx = this.vaultContext.getActiveContext();
            void this.runDirectTask(
              t('commands.fixLinksPrompt'),
              ctx,
              t('commands.titleFixLinks', { name: view.file.basename }),
            );
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: 'audit-frontmatter',
      name: t('commands.auditFrontmatter'),
      checkCallback: (checking: boolean) => {
        const view = this.vaultContext.resolveMarkdownView();
        if (view && view.file) {
          if (!checking) {
            const ctx = this.vaultContext.getActiveContext();
            void this.runDirectTask(
              t('commands.auditFrontmatterPrompt'),
              ctx,
              t('commands.titleAuditFrontmatter', { name: view.file.basename }),
            );
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: 'build-folder-moc',
      name: t('commands.buildFolderMoc'),
      checkCallback: (checking: boolean) => {
        const view = this.vaultContext.resolveMarkdownView();
        if (view && view.file && view.file.parent) {
          if (!checking) {
            const folderPath = view.file.parent.path;
            const folderName = view.file.parent.name || folderPath;
            const ctx: TaskContext = { scope: 'folder', folderPath };
            void this.runDirectTask(
              t('commands.buildFolderMocPrompt', { folderPath }),
              ctx,
              t('commands.titleBuildMoc', { name: folderName }),
            );
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: 'stop-task',
      name: t('commands.stopTask'),
      callback: () => {
        if (this.taskRunner.running) {
          this.taskRunner.abort();
          new Notice(t('notices.taskStopped'));
        } else {
          new Notice(t('notices.noActiveTask'));
        }
      },
    });

    // Settings Tab
    this.addSettingTab(new AntigravitySettingTab(this.app, this, this.resolver));

    // Auto-start Hub if enabled
    if (this.settings.autoStartHub) {
      const exec = this.resolver.resolve(this.settings.cliPath);
      const vaultPath = this.vaultContext.getVaultBasePath();
      if (exec && vaultPath) {
        this.hubManager
          .startHub(
            exec,
            vaultPath,
            this.settings.hubPort,
            this.settings.hubProfile || 'antigravity-obsidian',
            this.settings.defaultAgent,
            this.settings.allowUnrestrictedTasks,
          )
          .catch((err: unknown) => {
            // Auto-start runs in the background, but failing silently leaves
            // the user with a hub that never comes up and no explanation.
            new Notice(t('notices.hubAutoStartFailed', { error: (err as Error).message }));
            this.statusBar.update('error', t('statusBar.hubStartFailed'));
          });
      } else if (!exec) {
        new Notice(t('notices.cliNotFound'));
      } else {
        new Notice(t('notices.vaultPathUnavailable'));
      }
    }
  }

  onunload(): void {
    this.hubManager.stopHub();
    if (this.taskRunner) {
      this.taskRunner.abort();
      this.taskRunner.dispose();
    }
  }

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    this.settings = validateSettings(loaded);
    setConfiguredLanguage(this.settings.language);
  }

  async saveSettings(): Promise<void> {
    // Turning unrestricted mode off invalidates the earlier "I understand the
    // risk" acknowledgement. Without this, flipping the toggle off and back on
    // would run autonomously with no confirmation, which is not what the user
    // agreed to. Re-arm the prompt so consent is re-established each time.
    //
    // The confirmation flow sets unrestrictedConfirmed only while the toggle is
    // already on, so this cannot clear a fresh acknowledgement.
    if (!this.settings.allowUnrestrictedTasks) {
      this.settings.unrestrictedConfirmed = false;
    }

    await this.saveData(this.settings);
    setConfiguredLanguage(this.settings.language);
  }

  openTaskModal(contextOverride?: TaskContext): void {
    const ctx = contextOverride || this.vaultContext.getActiveContext();
    new TaskModal(this.app, ctx, (res) => {
      void this.runDirectTask(res.prompt, ctx, t('commands.titleDefault'));
    }).open();
  }

  async runDirectTask(prompt: string, context: TaskContext, title?: string): Promise<void> {
    const taskTitle = title ?? t('commands.titleResult');
    const exec = this.resolver.resolve(this.settings.cliPath);
    if (!exec) {
      new Notice(t('notices.cliNotFound'));
      return;
    }

    if (this.settings.allowUnrestrictedTasks && !this.settings.unrestrictedConfirmed) {
      new ConfirmModal(
        this.app,
        t('confirmModal.unrestrictedTitle'),
        t('confirmModal.unrestrictedMessage'),
        t('confirmModal.unrestrictedConfirm'),
        async () => {
          this.settings.unrestrictedConfirmed = true;
          await this.saveSettings();
          await this.executeDirectTask(exec, prompt, context, taskTitle);
        },
      ).open();
      return;
    }

    await this.executeDirectTask(exec, prompt, context, taskTitle);
  }

  private async executeDirectTask(
    exec: string,
    prompt: string,
    context: TaskContext,
    title: string,
  ): Promise<void> {
    try {
      new Notice(t('notices.taskStarting', { title }));
      const output = await this.taskRunner.runTask(exec, {
        prompt,
        context,
        model: this.settings.model,
      });

      new ResultModal(this.app, title, output, this.settings.allowUnrestrictedTasks).open();
    } catch (err) {
      new Notice(t('notices.taskFailed', { error: (err as Error).message }));
    }
  }

  async activateHubView(): Promise<void> {
    // The hub runs an interactive session where a single approval covers every
    // tool call for its whole lifetime, so it needs its own confirmation rather
    // than inheriting the one given for one-shot tasks.
    if (this.settings.allowUnrestrictedTasks && !this.settings.hubUnrestrictedConfirmed) {
      new ConfirmModal(
        this.app,
        t('confirmModal.hubUnrestrictedTitle'),
        t('confirmModal.hubUnrestrictedMessage'),
        t('confirmModal.hubUnrestrictedConfirm'),
        async () => {
          this.settings.hubUnrestrictedConfirmed = true;
          await this.saveSettings();
          await this.openHubLeaf();
        },
      ).open();
      return;
    }

    await this.openHubLeaf();
  }

  private async openHubLeaf(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(ANTIGRAVITY_HUB_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({
          type: ANTIGRAVITY_HUB_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      void workspace.revealLeaf(leaf);
    }
  }

  private showRibbonMenu(evt: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle(t('ribbon.openHub'))
        .setIcon('layout-grid')
        .onClick(() => {
          void this.activateHubView();
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle(t('ribbon.runTask'))
        .setIcon('play')
        .onClick(() => {
          this.openTaskModal();
        }),
    );

    if (this.taskRunner.running) {
      menu.addItem((item) =>
        item
          .setTitle(t('ribbon.stopTask'))
          .setIcon('cross')
          .onClick(() => {
            this.taskRunner.abort();
          }),
      );
    }

    menu.showAtMouseEvent(evt);
  }
}

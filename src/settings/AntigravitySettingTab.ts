import { App, Notice, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import { AgyResolver } from '../core/AgyResolver';
import { t } from '../i18n';
import { DEFAULT_SETTINGS, validateSettings } from '../types';
import type AntigravityPlugin from '../main';

const DEBOUNCED_HUB_SETTING_KEYS = new Set([
  'cliPath',
  'proxyUrl',
  'defaultAgent',
  'hubProfile',
  'hubPort',
]);

export class AntigravitySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AntigravityPlugin,
    private resolver: AgyResolver,
  ) {
    super(app, plugin);
  }

  override getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    this.plugin.settings = validateSettings({
      ...this.plugin.settings,
      [key]: value,
    });
    if (key === 'cliPath') {
      this.resolver.clearCache();
    }
    if (DEBOUNCED_HUB_SETTING_KEYS.has(key)) {
      await this.plugin.saveSettings({ debounceHubRestart: true });
    } else {
      await this.plugin.saveSettings();
    }
    if (key === 'language' && typeof this.update === 'function') {
      this.update();
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t('settings.languageName'),
        desc: t('settings.languageDesc'),
        control: {
          type: 'dropdown',
          key: 'language',
          options: {
            auto: t('settings.languageAuto'),
            en: t('settings.languageEn'),
            'zh-cn': t('settings.languageZhCn'),
            'zh-tw': t('settings.languageZhTw'),
          },
        },
      },
      {
        name: t('settings.cliPathName'),
        desc: t('settings.cliPathDesc'),
        control: {
          type: 'text',
          key: 'cliPath',
          placeholder: t('settings.cliPathPlaceholder'),
        },
      },
      {
        name: t('settings.verifyName'),
        desc: t('settings.verifyDesc'),
        action: () => {
          void (async () => {
            const target = this.resolver.resolve(this.plugin.settings.cliPath);
            if (!target) {
              new Notice(t('settings.verifyNotFoundNotice'));
              return;
            }
            const result = await this.resolver.testExecutable(target);
            if (result.success) {
              new Notice(t('settings.verifySuccessNotice', { version: result.version }));
            } else {
              new Notice(t('settings.verifyFailedNotice', { error: result.error }));
            }
          })();
        },
      },
      {
        name: t('settings.proxyUrlName'),
        desc: t('settings.proxyUrlDesc'),
        control: {
          type: 'text',
          key: 'proxyUrl',
          placeholder: t('settings.proxyUrlPlaceholder'),
        },
      },
      {
        name: t('settings.modelName'),
        desc: t('settings.modelDesc'),
        control: {
          type: 'dropdown',
          key: 'model',
          options: {
            'gemini-3.8-flash-high': t('settings.modelFlash38High'),
            'gemini-3.8-flash-medium': t('settings.modelFlash38Med'),
            'gemini-3.8-flash-low': t('settings.modelFlash38Low'),
            'claude-sonnet-4-6': t('settings.modelClaudeSonnet'),
            'claude-opus-4-6-thinking': t('settings.modelClaudeOpus'),
            'gpt-oss-120b-medium': t('settings.modelGptOss'),
          },
        },
      },
      {
        name: t('settings.agentName'),
        desc: t('settings.agentDesc'),
        control: {
          type: 'text',
          key: 'defaultAgent',
          placeholder: t('settings.agentPlaceholder'),
        },
      },
      {
        type: 'group',
        heading: t('settings.groupHub'),
        items: [
          {
            name: t('settings.hubProfileName'),
            desc: t('settings.hubProfileDesc'),
            control: {
              type: 'text',
              key: 'hubProfile',
              placeholder: 'antigravity-obsidian',
            },
          },
          {
            name: t('settings.hubPortName'),
            desc: t('settings.hubPortDesc'),
            control: {
              type: 'number',
              key: 'hubPort',
            },
          },
          {
            name: t('settings.autoStartName'),
            desc: t('settings.autoStartDesc'),
            control: {
              type: 'toggle',
              key: 'autoStartHub',
            },
          },
          {
            name: t('settings.openFileLinksInObsidianName'),
            desc: t('settings.openFileLinksInObsidianDesc'),
            control: {
              type: 'toggle',
              key: 'openFileLinksInObsidian',
            },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.groupRules'),
        items: [
          {
            name: t('settings.rulesEnableName'),
            desc: t('settings.rulesEnableDesc'),
            control: {
              type: 'toggle',
              key: 'enableVaultRules',
            },
          },
          {
            name: t('settings.rulesPathName'),
            desc: t('settings.rulesPathDesc'),
            control: {
              type: 'text',
              key: 'customRulesPath',
              placeholder: DEFAULT_SETTINGS.customRulesPath,
            },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.groupTasks'),
        items: [
          {
            name: t('settings.allowUnrestrictedName'),
            desc: t('settings.allowUnrestrictedDesc'),
            control: {
              type: 'toggle',
              key: 'allowUnrestrictedTasks',
            },
          },
        ],
      },
    ];
  }
}

import { App, Notice, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import { AgyResolver } from '../core/AgyResolver';
import { t } from '../i18n';
import { DEFAULT_SETTINGS } from '../types';
import type AntigravityPlugin from '../main';

export class AntigravitySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AntigravityPlugin,
    private resolver: AgyResolver,
  ) {
    super(app, plugin);
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
        name: t('settings.modelName'),
        desc: t('settings.modelDesc'),
        control: {
          type: 'dropdown',
          key: 'model',
          options: {
            'gemini-3.8-flash-high': t('settings.modelFlash38High'),
            'gemini-3.8-flash-medium': t('settings.modelFlash38Med'),
            'gemini-3.8-flash-low': t('settings.modelFlash38Low'),
            'gemini-3.7-flash-high': t('settings.modelFlash37High'),
            'gemini-3.7-flash-medium': t('settings.modelFlash37Med'),
            'gemini-3.7-flash-low': t('settings.modelFlash37Low'),
            'gemini-3.6-flash-high': t('settings.modelFlash36High'),
            'gemini-3.6-flash-medium': t('settings.modelFlash36Med'),
            'gemini-3.6-flash-low': t('settings.modelFlash36Low'),
            'gemini-3.1-pro-high': t('settings.modelPro31High'),
            'gemini-3.1-pro-low': t('settings.modelPro31Low'),
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
          placeholder: DEFAULT_SETTINGS.defaultAgent,
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

import { DEFAULT_SETTINGS, validateSettings } from '../../src/types';
import { AntigravitySettingTab } from '../../src/settings/AntigravitySettingTab';
import { AgyResolver } from '../../src/core/AgyResolver';

describe('validateSettings', () => {
  it('returns default settings when input is null or non-object', () => {
    expect(validateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings('not an object')).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings(12345)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns default settings when input is empty object', () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('validates hubPort and falls back to default on invalid types or ranges', () => {
    // String port
    expect(validateSettings({ hubPort: '8080' }).hubPort).toBe(DEFAULT_SETTINGS.hubPort);
    // Negative port
    expect(validateSettings({ hubPort: -1 }).hubPort).toBe(DEFAULT_SETTINGS.hubPort);
    // Out of range port
    expect(validateSettings({ hubPort: 70000 }).hubPort).toBe(DEFAULT_SETTINGS.hubPort);
    // Non-integer float
    expect(validateSettings({ hubPort: 8080.5 }).hubPort).toBe(DEFAULT_SETTINGS.hubPort);
    // Valid ports
    expect(validateSettings({ hubPort: 0 }).hubPort).toBe(0);
    expect(validateSettings({ hubPort: 8080 }).hubPort).toBe(8080);
    expect(validateSettings({ hubPort: 65535 }).hubPort).toBe(65535);
  });

  it('drops the legacy effort field from persisted settings', () => {
    // Reasoning level is baked into the model ID, and passing --effort
    // alongside a suffixed model makes the CLI reject the whole selection.
    const validated = validateSettings({ effort: 'high' });
    expect(Object.prototype.hasOwnProperty.call(validated, 'effort')).toBe(false);
  });

  it('validates autoStartHub boolean and falls back on non-boolean', () => {
    expect(validateSettings({ autoStartHub: 'yes' }).autoStartHub).toBe(false);
    expect(validateSettings({ autoStartHub: 1 }).autoStartHub).toBe(false);
    expect(validateSettings({ autoStartHub: true }).autoStartHub).toBe(true);
    expect(validateSettings({ autoStartHub: false }).autoStartHub).toBe(false);
  });

  it('validates hubProfile and sanitizes against traversal/invalid characters', () => {
    expect(validateSettings({ hubProfile: '../../escape' }).hubProfile).toBe(DEFAULT_SETTINGS.hubProfile);
    expect(validateSettings({ hubProfile: 'has spaces' }).hubProfile).toBe(DEFAULT_SETTINGS.hubProfile);
    expect(validateSettings({ hubProfile: 'bad/slash' }).hubProfile).toBe(DEFAULT_SETTINGS.hubProfile);
    expect(validateSettings({ hubProfile: 'valid-profile_2' }).hubProfile).toBe('valid-profile_2');
  });

  it('validates boolean security flags', () => {
    expect(validateSettings({ allowUnrestrictedTasks: 'true' }).allowUnrestrictedTasks).toBe(false);
    expect(validateSettings({ allowUnrestrictedTasks: true }).allowUnrestrictedTasks).toBe(true);

    expect(validateSettings({ unrestrictedConfirmed: 'yes' }).unrestrictedConfirmed).toBe(false);
    expect(validateSettings({ unrestrictedConfirmed: true }).unrestrictedConfirmed).toBe(true);
  });

  it('tracks hub and task unrestricted confirmations independently', () => {
    expect(validateSettings({ hubUnrestrictedConfirmed: 'yes' }).hubUnrestrictedConfirmed).toBe(false);
    expect(validateSettings({ hubUnrestrictedConfirmed: true }).hubUnrestrictedConfirmed).toBe(true);

    // Confirming one path must not authorise the other; a hub session is
    // interactive and its approval covers far more than a single task.
    const taskOnly = validateSettings({ unrestrictedConfirmed: true });
    expect(taskOnly.unrestrictedConfirmed).toBe(true);
    expect(taskOnly.hubUnrestrictedConfirmed).toBe(false);

    const hubOnly = validateSettings({ hubUnrestrictedConfirmed: true });
    expect(hubOnly.unrestrictedConfirmed).toBe(false);
    expect(hubOnly.hubUnrestrictedConfirmed).toBe(true);
  });

  it('preserves valid custom fields while falling back on invalid fields', () => {
    const raw = {
      model: 'gemini-3.1-pro-high',
      hubPort: 'not-a-number',
      cliPath: '  /usr/local/bin/agy  ',
      customRulesPath: 'rules/AGENTS.md',
    };

    const validated = validateSettings(raw);
    expect(validated.model).toBe('gemini-3.1-pro-high');
    expect(validated.hubPort).toBe(0);
    expect(validated.cliPath).toBe('/usr/local/bin/agy');
    expect(validated.customRulesPath).toBe('rules/AGENTS.md');
    expect(validated.enableVaultRules).toBe(true);
  });
});

describe('AntigravitySettingTab', () => {
  let mockPlugin: any;
  let tab: AntigravitySettingTab;

  beforeEach(() => {
    mockPlugin = {
      app: {},
      settings: {
        ...DEFAULT_SETTINGS,
        allowUnrestrictedTasks: true,
        unrestrictedConfirmed: true,
        hubUnrestrictedConfirmed: true,
      },
      saveData: jest.fn().mockResolvedValue(undefined),
      saveSettings: jest.fn().mockImplementation(async function () {
        if (!this.settings.allowUnrestrictedTasks) {
          this.settings.unrestrictedConfirmed = false;
          this.settings.hubUnrestrictedConfirmed = false;
        }
        await this.saveData(this.settings);
      }),
    };
    const resolver = new AgyResolver({
      existsSync: () => false,
      statSync: () => ({ isFile: () => false }),
      accessSync: () => {},
    });
    tab = new AntigravitySettingTab({} as any, mockPlugin, resolver);
  });

  it('reads setting value via getControlValue', () => {
    expect(tab.getControlValue('model')).toBe(DEFAULT_SETTINGS.model);
    expect(tab.getControlValue('allowUnrestrictedTasks')).toBe(true);
  });

  it('mutates settings and delegates to plugin.saveSettings via setControlValue', async () => {
    await tab.setControlValue('model', 'claude-sonnet-4-6');
    expect(mockPlugin.settings.model).toBe('claude-sonnet-4-6');
    expect(mockPlugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('re-arms consent when allowUnrestrictedTasks is toggled off via setControlValue', async () => {
    expect(mockPlugin.settings.unrestrictedConfirmed).toBe(true);
    expect(mockPlugin.settings.hubUnrestrictedConfirmed).toBe(true);

    await tab.setControlValue('allowUnrestrictedTasks', false);

    expect(mockPlugin.settings.allowUnrestrictedTasks).toBe(false);
    expect(mockPlugin.settings.unrestrictedConfirmed).toBe(false);
    expect(mockPlugin.settings.hubUnrestrictedConfirmed).toBe(false);
    expect(mockPlugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('triggers update() when language setting changes', async () => {
    const updateSpy = jest.spyOn(tab, 'update').mockImplementation(() => {});

    await tab.setControlValue('language', 'zh-cn');

    expect(mockPlugin.settings.language).toBe('zh-cn');
    expect(mockPlugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    updateSpy.mockRestore();
  });
});


import { getEffectiveLanguage, resolveLanguage, setConfiguredLanguage, setLocaleForTesting, t } from '../../src/i18n';
import en from '../../src/i18n/locales/en';
import zhCn from '../../src/i18n/locales/zh-cn';
import zhTw from '../../src/i18n/locales/zh-tw';
import { validateSettings } from '../../src/types';

describe('i18n subsystem', () => {
  afterEach(() => {
    setLocaleForTesting(null);
    setConfiguredLanguage('auto');
  });

  describe('resolveLanguage', () => {
    it('resolves standard English codes to en', () => {
      expect(resolveLanguage('en')).toBe('en');
      expect(resolveLanguage('en-US')).toBe('en');
      expect(resolveLanguage('en-GB')).toBe('en');
      expect(resolveLanguage('fr')).toBe('en');
    });

    it('resolves Simplified Chinese variants to zh-cn', () => {
      expect(resolveLanguage('zh')).toBe('zh-cn');
      expect(resolveLanguage('zh-cn')).toBe('zh-cn');
      expect(resolveLanguage('zh-CN')).toBe('zh-cn');
      expect(resolveLanguage('zh-Hans')).toBe('zh-cn');
      expect(resolveLanguage('zh-SG')).toBe('zh-cn');
    });

    it('resolves Traditional Chinese variants to zh-tw', () => {
      expect(resolveLanguage('zh-tw')).toBe('zh-tw');
      expect(resolveLanguage('zh-TW')).toBe('zh-tw');
      expect(resolveLanguage('zh-hk')).toBe('zh-tw');
      expect(resolveLanguage('zh-HK')).toBe('zh-tw');
      expect(resolveLanguage('zh-hant')).toBe('zh-tw');
      expect(resolveLanguage('zh-mo')).toBe('zh-tw');
    });
  });

  describe('t translation helper', () => {
    it('returns English translation by default', () => {
      setLocaleForTesting('en');
      expect(t('commands.openHub')).toBe('Open assistant web hub view');
      expect(t('statusBar.idle')).toBe('Idle');
    });

    it('returns Simplified Chinese translation when locale is zh-cn', () => {
      setLocaleForTesting('zh-cn');
      expect(t('commands.openHub')).toBe('打开 Assistant Web Hub 视图');
      expect(t('statusBar.idle')).toBe('空闲');
    });

    it('returns Traditional Chinese translation when locale is zh-tw', () => {
      setLocaleForTesting('zh-tw');
      expect(t('commands.openHub')).toBe('開啟 Assistant Web Hub 檢視');
      expect(t('statusBar.idle')).toBe('閒置');
    });

    it('interpolates template variables', () => {
      setLocaleForTesting('en');
      expect(t('commands.titleFixLinks', { name: 'MyNote' })).toBe('Fix wikilinks: MyNote');
      expect(t('commands.buildFolderMocPrompt', { folderPath: 'Notes/Tech' })).toContain('Notes/Tech');

      setLocaleForTesting('zh-cn');
      expect(t('commands.titleFixLinks', { name: 'MyNote' })).toBe('修复双链：MyNote');
      expect(t('commands.buildFolderMocPrompt', { folderPath: 'Notes/Tech' })).toContain('Notes/Tech');
    });

    it('handles undefined and null parameters without crashing', () => {
      setLocaleForTesting('en');
      expect(t('settings.verifySuccessNotice', { version: undefined })).toBe('Antigravity CLI verified: ');
      expect(t('notices.processExitError', { code: null })).toBe('Antigravity process exited with code ');
    });

    it('configured language setting overrides system locale', () => {
      setLocaleForTesting(null);
      expect(getEffectiveLanguage()).toBe('en');

      setConfiguredLanguage('zh-cn');
      expect(getEffectiveLanguage()).toBe('zh-cn');
      expect(t('commands.stopTask')).toBe('停止当前任务');

      setConfiguredLanguage('zh-tw');
      expect(getEffectiveLanguage()).toBe('zh-tw');
      expect(t('commands.stopTask')).toBe('停止目前任務');

      setConfiguredLanguage('auto');
      expect(getEffectiveLanguage()).toBe('en');
      expect(t('commands.stopTask')).toBe('Stop current task');
    });
  });

  describe('dictionary integrity', () => {
    it('has identical keys across en, zh-cn, and zh-tw', () => {
      const enKeys = Object.keys(en).sort();
      const zhCnKeys = Object.keys(zhCn).sort();
      const zhTwKeys = Object.keys(zhTw).sort();

      expect(zhCnKeys).toEqual(enKeys);
      expect(zhTwKeys).toEqual(enKeys);
    });

    it('contains non-empty translation strings for all keys', () => {
      for (const [k, v] of Object.entries(en)) {
        expect(typeof v).toBe('string');
        expect(v.trim().length).toBeGreaterThan(0);
      }
      for (const [k, v] of Object.entries(zhCn)) {
        expect(typeof v).toBe('string');
        expect(v.trim().length).toBeGreaterThan(0);
      }
      for (const [k, v] of Object.entries(zhTw)) {
        expect(typeof v).toBe('string');
        expect(v.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('settings schema validation for language', () => {
    it('defaults language to auto', () => {
      const settings = validateSettings({});
      expect(settings.language).toBe('auto');
    });

    it('accepts valid supported languages', () => {
      expect(validateSettings({ language: 'en' }).language).toBe('en');
      expect(validateSettings({ language: 'zh-cn' }).language).toBe('zh-cn');
      expect(validateSettings({ language: 'ZH-CN' }).language).toBe('zh-cn');
      expect(validateSettings({ language: 'zh-tw' }).language).toBe('zh-tw');
      expect(validateSettings({ language: 'auto' }).language).toBe('auto');
    });

    it('falls back to auto for invalid languages', () => {
      expect(validateSettings({ language: 'fr' }).language).toBe('auto');
      expect(validateSettings({ language: 123 }).language).toBe('auto');
      expect(validateSettings({ language: null }).language).toBe('auto');
    });
  });
});

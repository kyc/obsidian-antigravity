import { getLanguage } from 'obsidian';
import en from './locales/en';
import zhCn from './locales/zh-cn';
import zhTw from './locales/zh-tw';
import type { LocaleDictionary, SupportedLanguage, TranslationKey } from './types';

export type { SupportedLanguage, TranslationKey } from './types';

const locales: Record<'en' | 'zh-cn' | 'zh-tw', LocaleDictionary> = {
  en,
  'zh-cn': zhCn,
  'zh-tw': zhTw,
};

let configuredLanguage: SupportedLanguage = 'auto';
let testLocaleOverride: string | null = null;

export function setConfiguredLanguage(lang: SupportedLanguage | undefined): void {
  configuredLanguage = lang || 'auto';
}

export function setLocaleForTesting(locale: string | null): void {
  testLocaleOverride = locale;
}

export function resolveLanguage(raw: string): 'en' | 'zh-cn' | 'zh-tw' {
  const norm = (raw || '').toLowerCase().trim();
  if (
    norm.startsWith('zh-tw') ||
    norm.startsWith('zh-hk') ||
    norm.startsWith('zh-hant') ||
    norm.startsWith('zh-mo')
  ) {
    return 'zh-tw';
  }
  if (norm.startsWith('zh')) {
    return 'zh-cn';
  }
  return 'en';
}

export function getEffectiveLanguage(): 'en' | 'zh-cn' | 'zh-tw' {
  if (testLocaleOverride) {
    return resolveLanguage(testLocaleOverride);
  }

  if (configuredLanguage && configuredLanguage !== 'auto') {
    return resolveLanguage(configuredLanguage);
  }

  try {
    const obsidianLang = getLanguage();
    return resolveLanguage(obsidianLang || 'en');
  } catch {
    return 'en';
  }
}

export function t(
  key: TranslationKey,
  vars?: Record<string, string | number | boolean | undefined | null>,
): string {
  const lang = getEffectiveLanguage();
  let text: string = locales[lang]?.[key] ?? locales.en[key] ?? key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(v !== undefined && v !== null ? String(v) : '');
    }
  }

  return text;
}

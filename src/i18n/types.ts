import en from './locales/en';

export type TranslationKey = keyof typeof en;
export type LocaleDictionary = Record<TranslationKey, string>;
export type SupportedLanguage = 'auto' | 'en' | 'zh-cn' | 'zh-tw';

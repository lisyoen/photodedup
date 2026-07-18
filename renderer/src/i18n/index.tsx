import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { loadLanguage, saveLanguage, type Language } from "../lib/settings";
import en from "./en";
import ja from "./ja";
import ko from "./ko";

const dictionaries = { en, ko, ja };

export type TranslationKey = keyof typeof en;
type TranslationParams = Record<string, string | number>;

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => loadLanguage());

  const value = useMemo<I18nContextValue>(() => {
    function setLanguage(nextLanguage: Language) {
      saveLanguage(nextLanguage);
      setLanguageState(nextLanguage);
    }

    function t(key: TranslationKey, params: TranslationParams = {}) {
      const template = dictionaries[language][key] ?? en[key];
      return Object.entries(params).reduce(
        (message, [paramKey, paramValue]) => message.split(`{${paramKey}}`).join(String(paramValue)),
        template
      );
    }

    return { language, setLanguage, t };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useT must be used within I18nProvider");
  }
  return context;
}

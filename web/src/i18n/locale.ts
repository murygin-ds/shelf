/**
 * Which language the interface speaks.
 *
 * The choice is read once, when the module loads, rather than through a React context:
 * roughly a third of what the reader sees is written outside the tree — the sync line, the
 * store's error banner, the report an import leaves behind — and a context reaches none of
 * it. Switching is therefore a write plus a reload, which is honest about what it costs.
 */

export type Language = 'ru' | 'en';

const KEY = 'shelf.language';

export const DEFAULT: Language = 'ru';

/** BCP 47 tags, for the Intl constructors. */
export const TAG: Record<Language, string> = { ru: 'ru-RU', en: 'en-GB' };

/** The order a chooser lists them in, the default first. */
export const LANGUAGES: readonly Language[] = ['ru', 'en'];

/**
 * What each language calls itself, and the one row of labels that is never translated: the
 * reader who opens the chooser is the reader who wants out of the language it is written
 * in, and «Английский» is no help to somebody who has no Russian to find it with.
 */
// i18n-ignore — endonyms, not prose
export const NAME: Record<Language, string> = { ru: 'Русский', en: 'English' };

export function language(): Language {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : DEFAULT;
  } catch {
    // Private mode, storage switched off, or a test with no DOM.
    return DEFAULT;
  }
}

/** Takes effect on the next load: `m` is bound when its module is first imported. */
export function setLanguage(next: Language): void {
  try {
    if (next === DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Nothing to do — the current language simply stays.
  }
}

// index.html ships lang="ru" so the first paint is already right for the default. The
// attribute is not decoration: `:root:lang(ru)` in theme.css is what turns small-caps
// labels off, so a reader who switched to English and reloaded would otherwise get English
// words with the Russian typography. Guarded because half the callers of `m` are tests.
if (typeof document !== 'undefined') document.documentElement.lang = language();

/**
 * One way in: `import { m, format } from '@/i18n'`.
 *
 * `m` is the dictionary for the active language — a plain object, so a key is a property
 * access and a message that takes arguments is a function with a real signature. There is
 * no lookup by string, which is why a typo is a compile error rather than a blank label,
 * and no hook, which is why the store and the sync engine can say things too.
 */

export { m } from './messages';
export * as format from './format';
export { importPhaseLabel, permissionLabel, projectStatusLabel, roleLabel } from './labels';
export { DEFAULT, TAG, language, setLanguage } from './locale';
export type { Language } from './locale';
export { counted, countedEn, plural, pluralEn } from './plural';
export type { Forms } from './plural';
export type { Messages } from './shape';

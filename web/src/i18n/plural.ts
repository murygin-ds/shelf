/**
 * Plural forms, from the runtime's own rules rather than from `n === 1 ? '' : 's'`.
 *
 * Russian needs three: one note, two notes, five notes — and the boundaries are not where
 * intuition puts them (21 takes the first form, 111 the third). `Intl.PluralRules` knows
 * them, so nothing here counts modulo anything.
 *
 * Each dictionary imports the helper for its own language: a Russian file writes three
 * forms, an English one writes two, and neither carries the other's shape.
 */

import { TAG } from './locale';

/** одна заметка · две заметки · пять заметок */
export type Forms = readonly [one: string, few: string, many: string];

const RU = new Intl.PluralRules(TAG.ru);
const EN = new Intl.PluralRules(TAG.en);

export function plural(count: number, forms: Forms): string {
  switch (RU.select(count)) {
    case 'one':
      return forms[0];
    case 'few':
      return forms[1];
    // A fraction — «1,5 заметки» — selects 'other', which in Russian is the genitive
    // singular, the same word the 'few' branch already carries.
    case 'other':
      return forms[1];
    default:
      return forms[2];
  }
}

/** The number and its form together, which is what nearly every call site wants. */
export function counted(count: number, forms: Forms): string {
  return `${count} ${plural(count, forms)}`;
}

export function pluralEn(count: number, forms: readonly [one: string, other: string]): string {
  return EN.select(count) === 'one' ? forms[0] : forms[1];
}

export function countedEn(count: number, forms: readonly [one: string, other: string]): string {
  return `${count} ${pluralEn(count, forms)}`;
}

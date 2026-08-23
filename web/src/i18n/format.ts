/**
 * Dates, numbers and the order of a list, in the reader's language.
 *
 * Before this there were five relative-time ladders in five components, three of them
 * shouting in capitals, and five `toLocaleDateString()` calls with no locale at all — so
 * the same instant read differently depending on which panel showed it, and the format
 * followed the browser rather than the app. One ladder, one set of Intl formatters built
 * once, and the capitals moved to CSS where they belong.
 */

import { TAG, language } from './locale';
import { m } from './messages';

const tag = TAG[language()];

const DATE = new Intl.DateTimeFormat(tag, { day: '2-digit', month: '2-digit', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat(tag, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const MONTH = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric' });
const NUMBER = new Intl.NumberFormat(tag);
const RELATIVE = new Intl.RelativeTimeFormat(tag, { numeric: 'always', style: 'short' });
const LIST = new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' });
/** `numeric` so «Заметка 2» sorts before «Заметка 10», `base` so case and accents do not split the list. */
const COLLATOR = new Intl.Collator(tag, { sensitivity: 'base', numeric: true });

export type When = Date | number | string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "5 min ago" · «5 мин назад». Anything under a minute is «just now», not «in 0 minutes». */
export function relative(at: When, now: number = Date.now()): string {
  const at_ms = stamp(at);
  if (Number.isNaN(at_ms)) return m.common.unknown;

  const ms = Math.max(0, now - at_ms);

  if (ms < MINUTE) return m.common.justNow;
  if (ms < HOUR) return RELATIVE.format(-Math.floor(ms / MINUTE), 'minute');
  if (ms < DAY) return RELATIVE.format(-Math.floor(ms / HOUR), 'hour');

  return RELATIVE.format(-Math.floor(ms / DAY), 'day');
}

/** Relative while that still says something, an actual date once it stops. */
export function recent(at: When, now: number = Date.now()): string {
  const at_ms = stamp(at);

  return !Number.isNaN(at_ms) && now - at_ms < DAY ? relative(at, now) : date(at);
}

export function date(at: When): string {
  return format(DATE, at);
}

export function dateTime(at: When): string {
  return format(DATE_TIME, at);
}

/** A `YYYY-MM` heading as a month the reader can read. */
export function month(iso: string): string {
  const [year, part] = iso.split('-');
  const at = new Date(Number(year), Number(part) - 1, 1);

  return Number.isNaN(at.getTime()) ? iso : MONTH.format(at);
}

export function number(value: number): string {
  return NUMBER.format(value);
}

export function list(items: readonly string[]): string {
  return LIST.format(items);
}

/** Sorting that knows «ё» belongs between «е» and «ж», which a bare localeCompare does not. */
export function compare(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

/**
 * A date the app did not write is not always a date.
 *
 * `exported_at` comes out of an archive manifest, which is whatever file the reader
 * dropped on the page, and `Intl.DateTimeFormat.format(NaN)` throws a RangeError rather
 * than returning anything. Every entry point checks, because the one that does not is the
 * one that takes a bad archive down with it.
 */
function format(formatter: Intl.DateTimeFormat, at: When): string {
  const ms = stamp(at);

  return Number.isNaN(ms) ? m.common.unknown : formatter.format(ms);
}

function stamp(at: When): number {
  if (typeof at === 'number') return at;

  return (typeof at === 'string' ? new Date(at) : at).getTime();
}

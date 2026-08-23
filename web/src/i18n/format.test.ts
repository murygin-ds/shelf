import { compare, date, dateTime, month, recent, relative } from './format';

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);
const ago = (ms: number) => NOW - ms;

describe('relative', () => {
  it('says "just now" rather than "in 0 minutes"', () => {
    expect(relative(NOW, NOW)).toBe('только что');
    expect(relative(ago(59_000), NOW)).toBe('только что');
  });

  // The wording belongs to Intl and moves with the ICU version, so the assertions are
  // about which unit and which number the ladder chose, not about the exact phrase.
  it('steps from minutes to hours to days', () => {
    expect(relative(ago(60_000), NOW)).toMatch(/\b1\b/);
    expect(relative(ago(59 * 60_000), NOW)).toMatch(/\b59\b/);
    expect(relative(ago(60 * 60_000), NOW)).toMatch(/\b1\b/);
    expect(relative(ago(23 * 3_600_000), NOW)).toMatch(/\b23\b/);
    expect(relative(ago(8 * 86_400_000), NOW)).toMatch(/\b8\b/);
  });

  it('gives the three ladders three different words', () => {
    const words = new Set([
      relative(ago(5 * 60_000), NOW),
      relative(ago(5 * 3_600_000), NOW),
      relative(ago(5 * 86_400_000), NOW),
    ]);

    expect(words.size).toBe(3);
  });

  it('never looks into the future when a clock is skewed', () => {
    expect(relative(NOW + 60_000, NOW)).toBe('только что');
  });
});

describe('recent', () => {
  it('stays relative for a day and turns into a date after it', () => {
    expect(recent(ago(3_600_000), NOW)).toBe(relative(ago(3_600_000), NOW));
    expect(recent(ago(3 * 86_400_000), NOW)).toBe(date(ago(3 * 86_400_000)));
  });
});

describe('date', () => {
  it('is day.month.year, not whatever the browser prefers', () => {
    expect(date(Date.UTC(2026, 7, 23, 12))).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it('reads a YYYY-MM heading as a month, and leaves a broken one alone', () => {
    expect(month('2026-08')).toContain('2026');
    expect(month('2026-08')).not.toBe('2026-08');
    expect(month('not-a-month')).toBe('not-a-month');
  });
});

describe('a date that is not one', () => {
  // Intl throws on NaN rather than returning anything, and `exported_at` comes out of a
  // manifest in whatever file the reader dropped on the page.
  it('says so instead of throwing', () => {
    expect(() => date('not a date')).not.toThrow();
    expect(date('not a date')).toBe('неизвестно');
    expect(dateTime('')).toBe('неизвестно');
    expect(relative('nonsense', NOW)).toBe('неизвестно');
    expect(recent('nonsense', NOW)).toBe('неизвестно');
  });
});

describe('compare', () => {
  // ё and е are one letter here on purpose: nobody hunting for «ёж» in a list wants it
  // filed away from «еж», and the same folding is what makes search find either spelling.
  it('files ё as е rather than after я', () => {
    expect(['жаба', 'ёж', 'ель'].sort(compare)).toEqual(['ёж', 'ель', 'жаба']);
    expect(compare('ёж', 'еж')).toBe(0);
  });

  it('orders numbered names by their number', () => {
    expect(['Заметка 10', 'Заметка 2'].sort(compare)).toEqual(['Заметка 2', 'Заметка 10']);
  });
});

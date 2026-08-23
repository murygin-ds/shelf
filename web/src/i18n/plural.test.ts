import { counted, countedEn, plural, pluralEn } from './plural';

const FORMS = ['заметка', 'заметки', 'заметок'] as const;

describe('plural (ru)', () => {
  it('picks the singular where the rules do, not where the last digit suggests', () => {
    expect(plural(1, FORMS)).toBe('заметка');
    expect(plural(21, FORMS)).toBe('заметка');
    expect(plural(101, FORMS)).toBe('заметка');
  });

  it('picks the paucal for two through four, and for the same tails', () => {
    for (const n of [2, 3, 4, 22, 34, 102]) expect(plural(n, FORMS)).toBe('заметки');
  });

  it('picks the genitive plural for five and up, zero, and the teens', () => {
    for (const n of [0, 5, 11, 12, 14, 19, 20, 100, 111]) expect(plural(n, FORMS)).toBe('заметок');
  });

  // «1,5 заметки» — the fraction takes the paucal, which is where 'other' has to land.
  it('treats a fraction as the paucal', () => {
    expect(plural(1.5, FORMS)).toBe('заметки');
  });

  it('puts the number in front', () => {
    expect(counted(5, FORMS)).toBe('5 заметок');
  });
});

describe('plural (en)', () => {
  it('is singular only at one', () => {
    expect(pluralEn(1, ['note', 'notes'])).toBe('note');
    expect(pluralEn(0, ['note', 'notes'])).toBe('notes');
    expect(pluralEn(2, ['note', 'notes'])).toBe('notes');
    expect(countedEn(1, ['note', 'notes'])).toBe('1 note');
  });
});

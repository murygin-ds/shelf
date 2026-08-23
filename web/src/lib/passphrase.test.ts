import { MIN_PASSPHRASE_LENGTH, isAcceptable, strength } from './passphrase';

/**
 * The meter used to read latin ranges, which made every Cyrillic letter «punctuation» and
 * no Cyrillic letter a letter — so a Russian passphrase never reached two character classes
 * however it was written, and stopped a bar short of the English phrase beside it. Most of
 * what is asserted here is that parity, phrase for phrase.
 */
describe('passphrase strength', () => {
  it('scores a Russian phrase the same as a comparable English one', () => {
    // The first two are the ones the latin ranges got wrong: three bars against four.
    const pairs: Array<[string, string]> = [
      ['ПрохладныйВечерУНасСегодня', 'ChillyEveningForUsToday'],
      ['прохладный-вечер-у-нас', 'chilly-evening-for-us'],
      ['правильная лошадь батарейка скобка', 'correct horse battery staple'],
      ['горная тропа зимой', 'a mountain path'],
      ['Тихий Океан 2026 год', 'Quiet Ocean 2026 year'],
      ['Севернее', 'Northern'],
    ];

    for (const [ru, en] of pairs) {
      expect(strength(ru).score, ru).toBe(strength(en).score);
    }
  });

  it('lets a Cyrillic phrase reach the top bar', () => {
    expect(strength('ПрохладныйВечерУНасСегодня').score).toBe(4);
    expect(strength('правильная лошадь батарейка скобка').score).toBe(4);
  });

  it('counts case, digits and punctuation in Cyrillic as their own classes', () => {
    // Twenty characters and one word, so the score turns on the class count alone.
    expect(strength('прохладныйвечерунасс').score).toBe(3);
    expect(strength('ПрохладныйВечерУНасс').score).toBe(4);
    expect(strength('прохладныйвечерунас1').score).toBe(4);
    expect(strength('прохладный-вечер-у-нас').score).toBe(4);
  });

  it('catches a weak Russian word wherever it sits', () => {
    for (const weak of ['мойпарольнадёжный', 'йцукен-и-ещё-немного', 'СуперАдмин2026']) {
      const { score, hint } = strength(weak);

      expect(score, weak).toBe(1);
      expect(hint, weak).toBe('Содержит очень распространённое слово.');
    }
  });

  it('sees a common word through a decomposed «й»', () => {
    // «и» plus a combining breve, which is what a few keyboards and copied PDFs produce.
    const decomposed = '\u0438\u0306цукен вместе с остальным';

    expect(decomposed).not.toBe('йцукен вместе с остальным');
    expect(decomposed.normalize('NFC')).toBe('йцукен вместе с остальным');
    expect(strength(decomposed).score).toBe(1);
  });

  it('holds the length boundary', () => {
    const short = 'абвгдеёжзийклм'.slice(0, MIN_PASSPHRASE_LENGTH - 1);
    const just = 'абвгдеёжзийклм'.slice(0, MIN_PASSPHRASE_LENGTH);

    expect(strength(short).score).toBe(1);
    expect(strength(short).hint).toBe('Минимум 12 символов.');
    expect(strength(just).score).toBe(2);

    expect(strength('').score).toBe(0);
    expect(strength('').hint).toBe('');
  });

  it('accepts from two bars up', () => {
    expect(isAcceptable('')).toBe(false);
    expect(isAcceptable('пароль')).toBe(false);
    expect(isAcceptable('абвгдеёжзийк')).toBe(true);
    expect(isAcceptable('правильная лошадь батарейка скобка')).toBe(true);
  });
});

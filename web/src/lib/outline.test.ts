import { describe, expect, it } from 'vitest';

import { headingAt, outline } from './outline';

describe('outline', () => {
  it('reads level, text and line of every heading', () => {
    const found = outline('intro\n\n# Title\n\nbody\n\n## Section\n### Detail');

    expect(found).toEqual([
      { level: 1, depth: 0, text: 'Title', line: 3 },
      { level: 2, depth: 1, text: 'Section', line: 7 },
      { level: 3, depth: 2, text: 'Detail', line: 8 },
    ]);
  });

  it('indents by ancestry rather than by level', () => {
    // A note whose headings start at ### and skip a level still reads as siblings and a
    // child, which is what the panel has to draw.
    const found = outline('### One\n### Two\n##### Deep\n## Above');

    expect(found.map((heading) => heading.depth)).toEqual([0, 0, 1, 0]);
  });

  it('ignores hashes inside fenced code', () => {
    const found = outline('# Real\n\n```sh\n# not a heading\n```\n\n~~~\n## also not\n~~~\n\n## Real too');

    expect(found.map((heading) => heading.text)).toEqual(['Real', 'Real too']);
  });

  it('reads setext headings, and only where one can stand', () => {
    const found = outline('Title\n=====\n\nSection\n---\n\n- item\n---\n\n> quote\n===');

    expect(found).toEqual([
      { level: 1, depth: 0, text: 'Title', line: 1 },
      { level: 2, depth: 1, text: 'Section', line: 4 },
    ]);
  });

  it('drops markup from the text', () => {
    const found = outline(
      '# **Bold** and `code`\n## [Link](https://example.com) plus [[Note|alias]]\n### ~~gone~~ *maybe*',
    );

    expect(found.map((heading) => heading.text)).toEqual([
      'Bold and code',
      'Link plus alias',
      'gone maybe',
    ]);
  });

  it('skips headings with nothing in them', () => {
    expect(outline('#\n## \n### Kept')).toEqual([{ level: 3, depth: 0, text: 'Kept', line: 3 }]);
  });

  it('takes off the closing run of hashes', () => {
    expect(outline('## Section ##')[0]?.text).toBe('Section');
  });

  it('is empty for a note without headings', () => {
    expect(outline('just words\n#hashtag not a heading\n    # indented code')).toEqual([]);
  });

  // The parser is built out of punctuation and \s, so nothing in it should care which
  // alphabet the words are in — but this panel is read almost entirely in Russian, and a
  // silently empty map is the kind of failure nobody reports.
  it('reads Cyrillic headings the same way', () => {
    const found = outline('вступление\n\n# Планы\n\nтекст\n\n## Ёлки\n#### Приложение ####');

    expect(found).toEqual([
      { level: 1, depth: 0, text: 'Планы', line: 3 },
      { level: 2, depth: 1, text: 'Ёлки', line: 7 },
      { level: 4, depth: 2, text: 'Приложение', line: 8 },
    ]);
  });

  it('reads a Cyrillic setext heading and drops Cyrillic markup', () => {
    const found = outline('Планы на год\n===\n\n## **Итоги** и `код` с [[Заметка|подписью]]');

    expect(found).toEqual([
      { level: 1, depth: 0, text: 'Планы на год', line: 1 },
      { level: 2, depth: 1, text: 'Итоги и код с подписью', line: 4 },
    ]);
  });

  it('does not read a Cyrillic hashtag as a heading', () => {
    expect(outline('#тег в начале строки\n\n# Настоящий заголовок')).toEqual([
      { level: 1, depth: 0, text: 'Настоящий заголовок', line: 3 },
    ]);
  });
});

describe('headingAt', () => {
  const headings = outline('# One\ntext\n## Two\ntext\n# Three');

  it('finds the heading the line sits under', () => {
    expect(headingAt(headings, 2)).toBe(0);
    expect(headingAt(headings, 3)).toBe(1);
    expect(headingAt(headings, 4)).toBe(1);
    expect(headingAt(headings, 99)).toBe(2);
  });

  it('answers nothing above the first heading', () => {
    expect(headingAt(outline('preamble\n\n# One'), 1)).toBe(-1);
    expect(headingAt([], 5)).toBe(-1);
  });
});

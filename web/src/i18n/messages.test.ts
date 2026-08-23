import { en } from './en';
import { ru } from './ru';

/**
 * What the compiler cannot see.
 *
 * `satisfies Messages[...]` already holds every translation to the English shape, so a
 * missing key is a build error rather than a blank label. What is left is the other kind
 * of gap: a key that exists, is typed, compiles — and still says its English sentence
 * because somebody moved the string and forgot to translate it. The scanner at the bottom
 * is the check for that, and it is the reason «перевод полный» is a claim CI can make.
 */

type Tree = Record<string, unknown>;

/** Words that are names, not English: they stay as they are in every language. */
const KEPT = [
  'Shelf',
  // Before the bare 'Claude': the list is applied in order, and stripping the short name
  // first would leave 'Desktop' and 'Code' behind as findings.
  'Claude Desktop',
  'Claude Code',
  'Claude',
  'Anthropic',
  'CLAUDE.md',
  'SKILL.md',
  'MCP',
  'OAuth',
  'Markdown',
  'Yjs',
  'ZIP',
  'PDF',
  'Inter',
  'context',
  'projects',
  'skills',
  'memory',
  'inbox',
  'decisions',
  'YYYY-MM-DD',
  'YYYY-MM',
  'planning',
  'active',
  'paused',
  'done',
];

function paths(tree: Tree, at = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const here = at === '' ? key : `${at}.${key}`;

    if (typeof value === 'function') return [`${here}/${value.length}`];
    if (value !== null && typeof value === 'object') return paths(value as Tree, here);

    return [here];
  });
}

function leaves(tree: Tree, at = ''): Array<[string, unknown]> {
  return Object.entries(tree).flatMap(([key, value]): Array<[string, unknown]> => {
    const here = at === '' ? key : `${at}.${key}`;

    if (value !== null && typeof value === 'object' && typeof value !== 'function') {
      return leaves(value as Tree, here);
    }

    return [[here, value]];
  });
}

/** Enough of an argument list for any message in the dictionary: a count, then a name. */
const SAMPLES: unknown[] = [2, 'Проекты', 5];

function render(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'function') return null;

  try {
    const out: unknown = (value as (...args: unknown[]) => unknown)(
      ...SAMPLES.slice(0, value.length),
    );

    return typeof out === 'string' ? out : null;
  } catch {
    // A message that needs something a sample cannot stand in for — a React node, say.
    return null;
  }
}

describe('dictionaries', () => {
  it('carry the same keys, with the same arity, in both languages', () => {
    expect(paths(ru as unknown as Tree).sort()).toEqual(paths(en as unknown as Tree).sort());
  });

  it('have nothing blank in them', () => {
    for (const [path, value] of leaves(ru as unknown as Tree)) {
      if (typeof value === 'string') expect(value.trim(), path).not.toBe('');
    }
  });

  it('say nothing in English that is not a name', () => {
    const left: string[] = [];

    for (const [path, value] of leaves(ru as unknown as Tree)) {
      const text = render(value);
      if (text === null) continue;

      const stripped = KEPT.reduce(
        (rest, word) => rest.replaceAll(new RegExp(word, 'gi'), ' '),
        text,
      );

      if (/[A-Za-z]{3,}/.test(stripped)) left.push(`${path}: ${text}`);
    }

    expect(left).toEqual([]);
  });
});

/**
 * The names a Claude vault is built from and read back by.
 *
 * `claudeos.ts` writes the tree and `claudeview.ts` reads it, and until now each carried its
 * own copy of every marker — two `'CLAUDE.md'`, two lists of area folders, two spellings of
 * `Status`. Renaming a folder on one side and not the other does not break a build: the view
 * simply stops finding what the template just created, and everything lands in "elsewhere".
 *
 * None of this is translated, and none of it ever will be. These are paths a language model
 * walks — it is told to look in `projects/`, and it reads the `SKILL.md` it is pointed at —
 * and they are what `readElsewhere` matches a folder name against. A translated `проекты/`
 * would leave the model with instructions to a directory that does not exist and the view
 * with a vault it no longer recognises. What the reader sees is a label, and labels live in
 * the dictionary.
 */

export const AREAS = {
  context: 'context',
  projects: 'projects',
  skills: 'skills',
  memory: 'memory',
  inbox: 'inbox',
} as const;

/** The note the model reads first, at the root and again inside every project. */
export const ROOT_DOC = 'CLAUDE.md';
export const PROJECT_DOC = 'CLAUDE.md';
export const SKILL_DOC = 'SKILL.md';

/** A decisions log is matched by prefix: `decisions.md` and `decisions-2026.md` both count. */
export const DECISIONS_PREFIX = 'decisions';

/** `**Status:** active` in a project document. */
// i18n-ignore — a field name the parser matches on, not a label anyone reads.
export const STATUS_FIELD = 'Status';

/** The two keys a skill declares in its frontmatter. */
export const FRONTMATTER_FIELDS = ['name', 'description'] as const;
